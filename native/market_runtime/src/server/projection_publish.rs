//! Rust B's projection items: validated, then merged into the cache and delivered as deltas.

use crate::contract::Role;
use crate::event::{
    SessionKey, StateKey,
};
use crate::projection::{BlockKind, ProjectionEntry, PublishRequest, Refusal, Verdict};
use crate::state::SymbolState;
use crate::wire::{self};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self};
use std::time::{Duration, Instant};
use super::{hub::*, ingest::*, session::*};

/// The delta one accepted projection block produces (live and replay alike).
pub(crate) fn projection_delta(block: BlockKind, data: &Value, key: &StateKey, state: Option<&SymbolState>, entry: Option<&ProjectionEntry>)
                    -> (&'static str, &'static [&'static str], Value) {
    match block {
        BlockKind::Minutes => {
            let points: Vec<Value> = data.get("minutes").and_then(Value::as_array).into_iter().flatten()
                .map(|r| wire::trend_point(r, &key.instrument, &key.session.trading_date)).collect();
            let current = state.map(|st| wire::current_point(st, entry)).unwrap_or(Value::Null);
            ("minutes.upsert", &["trend", "minutes"], json!({"points": points, "replace": data.get("replace"), "current": current}))
        }
        BlockKind::Windows => ("windows.updated", &["windows"], data.clone()),
        BlockKind::Day => ("day.updated", &["day", "price_volume"], data.clone()),
        BlockKind::Flow => ("tradeflow.updated", &["tradeflow"], data.clone()),
        BlockKind::Events => ("events.upsert", &["events"], json!({"events": data.get("events"), "replace": data.get("replace")})),
    }
}

/// One `projection.publish` item as a validated request: its identity, its publish's epoch and its block, each
/// refused by name when missing or malformed (never defaulted to an identity, epoch or watermark of 0).
pub(crate) fn publish_request(item: &Value, epoch: Option<u64>) -> Result<PublishRequest, Refusal> {
    let identity = &item["identity"];
    let (Some(instrument), Some(d), Some(s)) = (instrument_from(identity), identity_field(identity, "trading_date"), identity_field(identity, "session")) else {
        return Err(Refusal::new("IDENTITY_REQUIRED", "identity required".into()));
    };
    let epoch = epoch.ok_or_else(|| Refusal::new("MALFORMED_RECORD", "projection_epoch must be an unsigned integer".into()))?;
    PublishRequest::from_item(StateKey { instrument, session: SessionKey { trading_date: d, session: s } }, epoch, item)
}

pub(crate) fn publish_projection(hub: &Arc<Hub>, p: &Value) -> Value {
    if p.get("durable_stream_id").and_then(Value::as_str) != Some(hub.durable_stream_id.as_str()) {
        hub.counters.projection_rejected.fetch_add(1, Ordering::Relaxed);
        return json!({"ok": false, "reason": "STREAM_MISMATCH", "durable_stream_id": hub.durable_stream_id});
    }
    let epoch = p.get("projection_epoch").and_then(Value::as_u64);
    let committed = hub.committed();
    let now = now_ns();
    let started = Instant::now();
    let mut results = Vec::new();
    let mut core = lock(&hub.core);
    let mut held = Instant::now();
    for (index, item) in p.get("items").and_then(Value::as_array).into_iter().flatten().take(8192).enumerate() {
        // Release `core` between item groups: a full projection after a long replay is hundreds of messages, and
        // provider ingest waits on `core` while its connection cannot answer pings. Each item's publish and its
        // deltas still happen inside one critical section, so snapshot/delta contiguity is unchanged.
        if index > 0 && index % PROJECTION_ITEMS_PER_HOLD == 0 {
            hub.counters.projection_core_hold_max_us.fetch_max(held.elapsed().as_micros() as u64, Ordering::Relaxed);
            drop(core);
            // One yield hands `core` to a waiting ingest; past that it sleeps, never spins (a 20 ms
            // `yield_now` loop kept a core busy while ingest held the lock).
            let paused = Instant::now();
            thread::yield_now();
            while hub.lane.waiting.load(Ordering::Acquire) > 0 && paused.elapsed() < Duration::from_millis(20) {
                thread::sleep(Duration::from_millis(1));
            }
            core = lock(&hub.core);
            held = Instant::now();
        }
        let request = match publish_request(item, epoch) {
            // A session that rolled over is no longer cached: B rebuilding it from the WAL must not put it back.
            Ok(request) if core.engine.is_gone(&request.key) => Err(Refusal::new("ROLLED_OVER", "ROLLED_OVER".into())),
            other => other,
        };
        let request = match request {
            Ok(request) => request,
            Err(refusal) => {
                core.projection.refuse(refusal.clone());
                hub.counters.projection_rejected.fetch_add(1, Ordering::Relaxed);
                results.push(refusal.wire());
                continue;
            }
        };
        let (key, block, epoch, watermark, revision) = (request.key.clone(), request.block, request.epoch, request.watermark, request.revision);
        let verdict = core.projection.publish(request, committed, now);
        match &verdict {
            Verdict::Accepted(delivered) => {
                let generation = core.engine.state(&key).map(|st| st.generation).unwrap_or(0);
                let meta = json!({"input_watermark": watermark, "revision": revision, "projection_epoch": epoch,
                    "completeness": item.get("completeness"), "as_of": item.get("as_of")});
                let mut extra = Map::new();
                extra.insert("block_meta".into(), meta);
                let (delta_type, channels, payload) = projection_delta(block, delivered, &key, core.engine.state(&key), core.projection.entry(&key));
                emit_delta(hub, &mut core, &key, generation, delta_type, channels, payload, extra, None);
                if block == BlockKind::Events {
                    emit_event_tape(hub, &key, delivered);
                }
                results.push(json!({"ok": true}));
            }
            Verdict::Duplicate => results.push(json!({"ok": true, "duplicate": true})),
            Verdict::Rejected(refusal) => {
                hub.counters.projection_rejected.fetch_add(1, Ordering::Relaxed);
                results.push(refusal.wire());
            }
            Verdict::NotYet(reason) => {
                hub.counters.projection_rejected.fetch_add(1, Ordering::Relaxed);
                results.push(json!({"ok": false, "code": "NOT_COMMITTED", "reason": reason, "retry": true}));
            }
            Verdict::BaseRequired(reason) => {
                // B sends the block again whole (its outbox marks a refused day / flow item whole).
                hub.counters.projection_rejected.fetch_add(1, Ordering::Relaxed);
                eprintln!("[market_runtime] projection {}:{}:{} {reason}: asked for the whole block",
                          key.instrument.source, key.instrument.market, key.instrument.code);
                results.push(json!({"ok": false, "code": "BASE_REQUIRED", "reason": reason, "retry": true}));
            }
        }
    }
    hub.counters.projection_core_hold_max_us.fetch_max(held.elapsed().as_micros() as u64, Ordering::Relaxed);
    let invalidated = core.projection.take_unreplaced();
    drop(core);
    // A newer epoch invalidated older blocks this message did not replace: their views re-snapshot, as after a
    // projection.reset.
    if !invalidated.is_empty() {
        let keys: Arc<HashSet<StateKey>> = Arc::new(invalidated.into_iter().collect());
        broadcast_role(hub, |c| c.role == Role::Viewer, Outgoing { kind: OutKind::KeysResync(keys), bytes: Arc::new(Vec::new()), trace: None });
    }
    hub.counters.projection_publish_max_us.fetch_max(started.elapsed().as_micros() as u64, Ordering::Relaxed);
    json!({"ok": true, "results": results, "committed": committed})
}
