//! The connection to Market Runtime: subscribe, receive, publish projections and signals, acknowledgements, resets, rules and the stream loop.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use market_runtime::event::MarketEvent;
use market_runtime::remediation;
use serde_json::{json, Value};
use crate::cursor::{DurableCursor, GapAction};
use crate::features::{FeatureStore, KeyId};
use crate::ws::{Incoming, WsClient};
use crate::{accum, archive, cursor, engine, events, outbox, paper, signals, timing, rules};
use super::{shared::*, control_stdio::*, inference_runtime::*, checkpoint_service::*, replay_runtime::*, ingest::*};

/// The signal authority's turn in the stream loop: validate every waiting result, follow a config change, and send
/// what was accepted to Market Runtime.
pub(crate) fn pump_signals(publisher: &mut WsClient, shared: &Shared, local: &mut Local, republish: bool) -> io::Result<()> {
    let view = config_view(shared);
    let version = view.as_ref().map(|v| v.config_version).unwrap_or(0);
    let mut items: Vec<Value> = std::mem::take(&mut local.signals_invalidated);
    if local.signal_config_version != 0 && version != local.signal_config_version {
        items.extend(local.signals.follow_config(view.as_ref()));
    }
    local.signal_config_version = version;
    if republish {
        items.extend(local.signals.all_items());
    }
    let stream_id = shared.stream_id.lock().unwrap().clone();
    for out in shared.results.drain() {
        if out.value["type"] != "inference.result" {
            continue;
        }
        // The result's own expires_at_ns decides expiry (SignalBook::accept), so one waiting behind a stalled
        // connection is refused exactly like one that ran late.
        let _ = out.expires_at_ns;
        let now = now_ns();
        if let Some(item) = local.signals.accept(&out.value, view.as_ref(), &stream_id, now) {
            items.push(item);
        }
    }
    *shared.signals_health.lock().unwrap() = local.signals.health();
    // The batch names its stream and projection epoch, like a projection publish: Market Runtime fences it.
    // Each batch is unacknowledged until Market Runtime answers its request id: recorded before it is sent, so
    // a send that fails half-way, or a connection lost before the answer, leaves it there for the reconnect to see.
    // A full republish is over only when Market Runtime has taken every batch that carried it: its batches are
    // kept, and the operation ends at the last ok answer -- or, with nothing to send, at once.
    if republish && local.signals_republish.is_some() {
        local.republish_batches.begin_attempt();
    }
    for chunk in items.chunks(SIGNALS_BATCH_MAX) {
        let request_id = local.signal_acks.sent();
        if republish {
            local.republish_batches.sent(&request_id);
        }
        publisher.send_text(&json!({"type": "signals.publish", "request_id": request_id, "payload": {"items": chunk,
            "durable_stream_id": stream_id, "projection_epoch": local.projection_epoch}}).to_string())?;
    }
    if republish {
        signals_republish_settled(local, items.len());
    }
    Ok(())
}

/// Ends the signals full republish once every batch that carried it was answered ok.
pub(crate) fn signals_republish_settled(local: &mut Local, items: usize) {
    let Some(attempts) = local.republish_batches.complete() else { return };
    if let Some(mut operation) = local.signals_republish.take() {
        operation.finish("succeeded", Some(attempts), json!({"items": items, "projection_epoch": local.projection_epoch}));
    }
}

pub(crate) struct StreamArgs {
    pub(crate) url: String,
    pub(crate) token: String,
    pub(crate) data_dir: PathBuf,
    pub(crate) config_root: Option<PathBuf>,
    pub(crate) publish_interval: Duration,
    pub(crate) checkpoint_interval: Duration,
}

/// How often the stream loop reads new 模擬下單 commands and writes what the matching produced.

pub(crate) struct Local {
    /// 模擬下單's shadow matching (paper.rs), fed the same durable events as the engine; in the checkpoint.
    pub(crate) paper: paper::PaperDesk,
    /// The paper matching directory (`--paper-dir`).
    pub(crate) paper_dir: Option<PathBuf>,
    /// Rust A's void-event list (market_runtime voided.rs), read at start: the durable events the fold (engine, features,
    /// paper desk) leaves out. A forwards them as stored; the cursor still passes them.
    pub(crate) voided: Arc<market_runtime::voided::Voided>,
    pub(crate) cursor: DurableCursor,
    pub(crate) features: FeatureStore,
    pub(crate) engine: engine::Engine,
    pub(crate) projection_epoch: u64,
    pub(crate) need_full_publish: bool,
    pub(crate) last_publish: Instant,
    pub(crate) last_status: Instant,
    pub(crate) last_checkpoint: Instant,
    pub(crate) last_rules_check: Instant,
    pub(crate) rules_stamp: Option<(Option<u64>, Option<u64>)>,
    pub(crate) rule_problems: Vec<String>,
    pub(crate) checkpoint_info: Value,
    pub(crate) checkpoints: CheckpointWriter,
    pub(crate) replaying: bool,
    /// 歷史回放 timelines being built or kept, per recorded partition (replay_runtime::TimelineBuild). Memory only --
    /// never in the checkpoint, the event archive or the durable cursor.
    pub(crate) timelines: Vec<CachedTimeline>,
    /// Timeline spans built and not yet sent to Market Runtime (the builders' workers fill it).
    pub(crate) timeline_out: Arc<Mutex<std::collections::VecDeque<String>>>,
    /// The build of the open replay's recording, which the others wait for (replay_runtime::Foreground).
    pub(crate) foreground: Arc<Foreground>,
    /// 模擬下單 on each open replay, following its position.
    pub(crate) open_replays: HashMap<String, Value>,
    /// The live lane's (runtime epoch, last live_sequence): a skipped number is a message lost on A's side.
    pub(crate) live_lane: (u64, u64),
    pub(crate) republish_signals: bool,
    /// What was published to Market Runtime and not acknowledged yet.
    pub(crate) outbox: outbox::Outbox,
    /// Remediations that end when the next full projection has gone out: a republish to a restarted Market Runtime
    /// or a rebuild after a reset. Abandoned if B stops first.
    pub(crate) awaiting_full_publish: Vec<remediation::Operation>,
    /// The signals republish to a restarted Market Runtime, ended by the turn that sends them.
    pub(crate) signals_republish: Option<remediation::Operation>,
    /// The batches the current full republish sent, not yet answered ok.
    pub(crate) republish_batches: RepublishBatches,
    /// `signals.publish` batches Market Runtime has not answered yet.
    pub(crate) signal_acks: SignalAcks,
    /// The one model-signal authority (signals.rs) and the config version it last validated against.
    pub(crate) signals: signals::SignalBook,
    /// Signal rows a reset invalidated, sent with the next signals turn.
    pub(crate) signals_invalidated: Vec<Value>,
    /// The `analysis.a_reconnect` remediation whose fresh connections are open but not yet verified, and its attempt
    /// count: closed as succeeded by the `durable.subscribed` that passes verification, handed back to the
    /// stream loop if the connection goes first.
    pub(crate) reconnect_pending: Option<(remediation::Operation, u64)>,
    pub(crate) signal_config_version: u64,
    /// Wakes the historical store's prune (startup.rs `historical_store_loop`) when a rollover moves the cutoffs;
    /// None without `--historical-dir`.
    pub(crate) historical_prune: Option<std::sync::mpsc::Sender<()>>,
}

/// `durable.subscribe`.
pub(crate) fn durable_subscribe_text(_local: &Local, after: u64) -> String {
    json!({"type": "durable.subscribe", "payload": {"after_sequence": after}}).to_string()
}

/// Send `durable.subscribe` from `after`; the cursor remembers it until A acknowledges exactly that request.
pub(crate) fn send_durable_subscribe(client: &mut WsClient, local: &mut Local, after: u64) -> bool {
    let sent = client.send_text(&durable_subscribe_text(local, after)).is_ok();
    if sent {
        local.cursor.subscribe_sent(after);
    }
    sent
}

pub(crate) fn rules_stamp(root: Option<&Path>) -> Option<(Option<u64>, Option<u64>)> {
    let root = root?;
    let read = |d: &str| -> Option<u64> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(root.join(d).join("pointer.json")).ok()?).ok()?;
        v["active"].as_u64()
    };
    Some((read("flow_rules"), read("event_rules")))
}

/// Archive the event records of an `events` projection item: every revision the file does not hold yet (a revoke is
/// a new revision); readers keep the newest revision per event_id. Never allowed to stop live publication.
pub(crate) fn archive_events(shared: &Shared, item: &Value) {
    let Some(events) = item["data"]["events"].as_array() else { return };
    shared.archive.lock().unwrap().append(events.iter());
}

/// Every event record B holds (each instrument keeps its newest EVENT_CAPACITY), as the archive writes it.
pub(crate) fn held_events(engine: &engine::Engine) -> Vec<Value> {
    engine.instruments.values().flat_map(|inst| inst.events.records.values()).map(events::EventRecord::wire).collect()
}

/// Retry and fsync the archive; when a write had to be dropped, write back everything B still holds.
pub(crate) fn archive_tick(shared: &Shared, local: &Local) {
    let mut archive = shared.archive.lock().unwrap();
    archive.tick();
    if archive.resync_wanted {
        let repaired = archive.reconcile(&held_events(&local.engine), archive::Reconcile::AfterDrop);
        eprintln!("[analysis_runtime] event archive reconciled after a dropped write: {repaired} records handed back to the file");
    }
}

/// Market Runtime rolled sessions over (at a pre-open, or it says so when B connects): drop the same partitions and
/// checkpoint at once, so a restart of B does not rebuild what A no longer holds.
pub(crate) fn apply_rollover(shared: &Shared, local: &mut Local, payload: &Value, checkpoint_dir: &Path) {
    // The new day may be a US half day OpenD's calendar named since the start.
    market_runtime::rollover::refresh_us_half_days();
    let rolled: std::collections::BTreeMap<String, String> = serde_json::from_value(payload["rolled"].clone()).unwrap_or_default();
    let cleared: std::collections::BTreeMap<String, i64> = serde_json::from_value(payload["cleared"].clone()).unwrap_or_default();
    let new_roll = rolled.iter().any(|(k, v)| local.engine.rolled.get(k).is_none_or(|known| known < v));
    let new_clear = cleared.iter().any(|(k, v)| local.engine.cleared.get(k).is_none_or(|known| known < v));
    if !new_roll && !new_clear {
        return;
    }
    let newly_cleared: HashSet<String> = cleared.iter()
        .filter(|(k, v)| local.engine.cleared.get(*k).is_none_or(|known| known < *v)).map(|(k, _)| k.clone()).collect();
    let dropped = local.engine.rollover(&rolled) + local.engine.clear_families(&cleared);
    // The historical store follows the same cutoffs: A wrote them before telling B (market_runtime retention.rs).
    if new_roll {
        if let Some(prune) = &local.historical_prune {
            if prune.send(()).is_err() {
                eprintln!("[analysis_runtime] historical store prune thread is gone: stored history is not pruned for this rollover");
            }
        }
    }
    // An inference still running for a retired session would come back after `forget` below and be
    // accepted (accept checked config/model/stream only), putting the retired signal back. The worker epoch moves on
    // and the book refuses every result of an older one; queued tasks of the old epoch are dropped by the workers and
    // the remaining keys are scheduled again.
    let epoch = shared.epoch.fetch_add(1, Ordering::AcqRel) + 1;
    local.signals.advance_epoch(epoch);
    shared.reschedule.store(true, Ordering::Release);
    // Features and queued inference follow the same cutoffs: a gone session must not be checkpointed again or emit
    // signals for a partition nobody shows any more.
    let engine = &local.engine;
    let forgotten: HashSet<KeyId> = local.features.forget(|k| {
        engine.is_rolled(&accum::ScopeId { source: k.source.clone(), market: k.market.clone(), trading_date: k.trading_date.clone(),
                                           session: k.session.clone() })
            || newly_cleared.contains(&market_runtime::rollover::clear_family(&k.source, &k.market))
    }).into_iter().collect();
    local.signals.forget(|k| forgotten.iter().any(|f| (&f.source, &f.market, &f.trading_date, &f.session, &f.code) == (&k.0, &k.1, &k.2, &k.3, &k.4))
        || local.engine.is_rolled(&accum::ScopeId { source: k.0.clone(), market: k.1.clone(), trading_date: k.2.clone(), session: k.3.clone() }));
    if !forgotten.is_empty() {
        shared.queue.retain(|task| !forgotten.contains(&task.key));
    }
    eprintln!("[analysis_runtime] session rollover {rolled:?} {cleared:?}: {dropped} partitions, {} feature keys dropped", forgotten.len());
    write_checkpoint(shared, local, checkpoint_dir);
}

/// Send the dirty blocks (every block when `full`). Each message carries a request id; what it carried stays in the
/// outbox until Market Runtime's ack commits or returns it. Returns the number of items sent. `caught_up`: B is at
/// the live edge, so the model's predictions are those of the moment a rule event triggers now -- while it replays
/// or catches up, an event re-triggering at an earlier market time would be stamped with today's predictions.
pub(crate) fn publish(client: &mut WsClient, shared: &Shared, local: &mut Local, full: bool, caught_up: bool) -> io::Result<u64> {
    let started = Instant::now();
    let watermark = local.cursor.cursor;
    let stream_id = shared.stream_id.lock().unwrap().clone();
    if stream_id.is_empty() {
        return Ok(0);
    }
    // What the WAL rebuilds is archived; an unlisted stock's rule events are published, never archived
    // (engine::LiveOverlay). A stored fold the overlay shows in its place is archived, never published.
    let mut batches = Vec::new();
    for collected in local.engine.collect(full, watermark, caught_up.then_some(&local.signals)) {
        if collected.stored {
            for item in collected.items.iter().filter(|item| item["block"] == "events") {
                archive_events(shared, item);
            }
        }
        if collected.shown {
            batches.push((collected.id, collected.items));
        }
    }
    let mut items: Vec<Value> = Vec::new();
    let mut pending: Vec<outbox::Pending> = Vec::new();
    let mut bytes = 0usize;
    let mut sent = 0u64;
    let mut batches = batches.into_iter().flat_map(|(id, list)| list.into_iter().map(move |item| (id.clone(), item))).peekable();
    while let Some((id, item)) = batches.next() {
        bytes += item.to_string().len();
        pending.push(outbox::Pending::of(&id, &item));
        items.push(item);
        if bytes < PUBLISH_BYTES && batches.peek().is_some() {
            continue;
        }
        let n = items.len() as u64;
        let request_id = local.outbox.register(std::mem::take(&mut pending));
        let text = json!({"type": "projection.publish", "request_id": request_id, "payload": {"durable_stream_id": stream_id,
            "projection_epoch": local.projection_epoch, "items": std::mem::take(&mut items)}}).to_string();
        shared.counters.publish_bytes.fetch_add(text.len() as u64, Ordering::Relaxed);
        shared.counters.publish_messages.fetch_add(1, Ordering::Relaxed);
        shared.counters.publish_items.fetch_add(n, Ordering::Relaxed);
        bytes = 0;
        sent += n;
        client.send_text(&text)?;
        // A full projection after a long replay is hundreds of messages. Read the acks that have arrived after
        // each one: unread, they fill this socket until A's ack write times out and drops the connection (B13).
        drain_publisher(client, shared, local).map_err(|lost| io::Error::other(lost.reason))?;
    }
    local.last_publish = Instant::now();
    {
        let mut v = shared.view.lock().unwrap();
        v.last_publish_us = started.elapsed().as_micros() as u64;
        v.publish_in_flight = local.outbox.in_flight();
    }
    Ok(sent)
}

/// Start the projection over. `mechanism_id`/`trigger` name the registered remediation (stream reset, retention
/// rebuild or rules rebuild); it ends when the rebuilt projection has been published.
pub(crate) fn reset(shared: &Shared, local: &mut Local, mechanism_id: &str, trigger: &str, reason: &str, rebuild_after: Option<u64>) {
    eprintln!("[analysis_runtime] reset: {reason}");
    let old_stream = shared.stream_id.lock().unwrap().clone();
    local.awaiting_full_publish.push(remediation::begin("stream_loop", mechanism_id, trigger, remediation::Identity::default(),
        json!({"reason": reason, "old_stream": old_stream, "old_epoch": local.projection_epoch, "new_epoch": local.projection_epoch + 1,
               "cursor": local.cursor.cursor, "rebuild_after": rebuild_after, "instruments_dropped": local.engine.instruments.len(),
               "tasks_queued": shared.queue.counts().depth})));
    local.outbox.clear();
    local.features.clear();
    local.engine.clear();
    local.projection_epoch += 1;
    local.need_full_publish = true;
    let epoch = shared.epoch.fetch_add(1, Ordering::AcqRel) + 1;
    local.signals.advance_epoch(epoch);
    // The model signals were computed from the state just dropped: Market Runtime keeps signal rows across a
    // projection reset, so they are disabled here and that is published, or an old stream's predictions stay on the
    // screens until a new inference happens to replace them.
    let invalidated = local.signals.invalidate("PROJECTION_RESET", "DISABLED");
    local.signals_invalidated.extend(invalidated);
    shared.queue.retain(|_| false);
    match rebuild_after {
        // The paper desk keeps its state: it skips the events it already applied.
        Some(after) => {
            local.cursor.cursor = after;
            local.cursor.awaiting_after = Some(after);
        }
        None => {
            // Another stream (its sequences start over): the matching is rebuilt from it like the engine.
            local.paper.restart();
            local.cursor.reset(reason.to_string());
        }
    }
}

pub(crate) fn status_message(local: &Local, shared: &Shared) -> Value {
    let lag = local.cursor.lag();
    let state = if shared.incompatible.lock().unwrap().is_some() {
        "INCOMPATIBLE"
    } else if local.replaying || lag > CATCH_UP_LAG {
        "CATCHING_UP"
    } else {
        "LIVE"
    };
    // catch_up_from: where this catching-up span started -- Market Runtime measures the screens' rebuild progress from
    // it to its own durable head.
    json!({"type": "analysis.status", "payload": {"state": state, "cursor": local.cursor.cursor, "head": local.cursor.head, "lag": lag,
        "catch_up_from": local.cursor.catch_up_from,
        "projection_epoch": local.projection_epoch, "rules": local.engine.rules.version_label(), "calendar": local.engine.cal.version,
        "instance": shared.instance, "at_ns": now_ns().to_string()}})
}

pub(crate) fn record_ack(shared: &Shared, local: &mut Local, message: &Value) -> Result<(), String> {
    let payload = &message["payload"];
    let results = payload["results"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let outcome = local.outbox.ack(message["request_id"].as_u64(), results, &mut local.engine);
    shared.counters.publish_requeued.fetch_add(outcome.requeued, Ordering::Relaxed);
    shared.counters.publish_dropped.fetch_add(outcome.dropped, Ordering::Relaxed);
    // A contract refusal is recorded, never only counted: it is in this process's log with what was refused.
    shared.counters.publish_contract_refused.fetch_add(outcome.refused.len() as u64, Ordering::Relaxed);
    for refused in &outcome.refused {
        eprintln!("[analysis_runtime] Market Runtime refused a projection item for a contract reason: {refused}");
    }
    if let Some(first) = outcome.refused.first() {
        let mut incompatible = shared.incompatible.lock().unwrap();
        if incompatible.is_none() {
            *incompatible = Some(format!("Market Runtime refused a projection item for a contract reason: {first}"));
        }
    }
    // Market Runtime holds a newer epoch than B's (another incarnation published after this one restored): nothing
    // of B's epoch will be taken, so B continues above it with its whole projection, one recorded republish.
    if let Some(theirs) = outcome.epoch_behind.filter(|e| *e >= local.projection_epoch) {
        let detail = json!({"old_epoch": local.projection_epoch, "market_runtime_epoch": theirs, "new_epoch": theirs + 1});
        local.projection_epoch = theirs + 1;
        local.need_full_publish = true;
        local.outbox.clear();
        local.awaiting_full_publish.push(remediation::begin("stream_loop", "analysis.projection_full_republish", "epoch_behind",
            remediation::Identity::default(), detail));
    }
    for r in results {
        if r["ok"] == true {
            if r["duplicate"] == true {
                shared.counters.publish_duplicate.fetch_add(1, Ordering::Relaxed);
            } else {
                shared.counters.publish_acks_ok.fetch_add(1, Ordering::Relaxed);
            }
        } else {
            shared.counters.publish_acks_rejected.fetch_add(1, Ordering::Relaxed);
        }
    }
    if payload["reason"] == "STREAM_MISMATCH" {
        shared.counters.publish_acks_rejected.fetch_add(1, Ordering::Relaxed);
        return Err("Market Runtime serves a different durable stream".into());
    }
    Ok(())
}

pub(crate) const LARGE_ORDERS_QUERY_MAX: u64 = 5000;

/// One window's large prints of one instrument partition (the newest partition when no trading date is named).
pub(crate) fn large_orders_reply(engine: &engine::Engine, p: &Value) -> Value {
    let id = &p["identity"];
    let text = |key: &str| id.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let (source, market, code) = (text("source").to_lowercase(), text("market").to_uppercase(), text("code").to_uppercase());
    let (date, session) = (text("trading_date"), text("session").to_uppercase());
    let found = engine.shown_partitions()
        .filter(|(k, _)| k.source == source && k.market == market && k.code == code
            && (session.is_empty() || k.session == session) && (date.is_empty() || k.trading_date == date))
        .max_by(|(a, _), (b, _)| a.trading_date.cmp(&b.trading_date));
    // Minutes on the session's axis, as B's buckets name them: a futures night runs past 1440, and a session continuing
    // from the previous partition starts before 0 (projection.rs session_large_orders). No bound: every minute B holds of the partition and the segment it continues.
    let from = p["from_minute"].as_i64().unwrap_or(-1440).clamp(-1440, 2880) as i32;
    let to = p["to_minute"].as_i64().unwrap_or(2880).clamp(-1440, 2880) as i32;
    let limit = p["limit"].as_u64().unwrap_or(1000).clamp(1, LARGE_ORDERS_QUERY_MAX) as usize;
    let side = match p["side"].as_str().map(str::to_uppercase).as_deref() {
        None | Some("") | Some("ALL") => None,
        Some("BUY") => Some(1),
        Some("SELL") => Some(-1),
        Some(other) => return json!({"query_id": p["query_id"], "ok": false, "reason": format!("UNKNOWN_SIDE:{other}"), "rows": [], "truncated": false}),
    };
    match found {
        Some((k, inst)) => {
            let (rows, truncated) = inst.session_large_orders(&engine.cal, engine.shown_previous_partition(k), from, to, limit, side);
            json!({"query_id": p["query_id"], "ok": true, "from_minute": from, "to_minute": to, "side": p["side"], "rows": rows, "truncated": truncated,
                   "identity": {"source": k.source, "market": k.market, "code": k.code, "trading_date": k.trading_date, "session": k.session},
                   "ticks_folded_capacity": inst.quality.ticks_dropped})
        }
        None => json!({"query_id": p["query_id"], "ok": false, "reason": "UNKNOWN_INSTRUMENT", "rows": [], "truncated": false}),
    }
}

/// Read every reply already waiting on the publisher connection (acks, errors), never blocking for more.
pub(crate) fn drain_publisher(publisher: &mut WsClient, shared: &Shared, local: &mut Local) -> Result<(), Lost> {
    loop {
        match publisher.recv(Duration::from_millis(0)) {
            Ok(Incoming::Idle) => return Ok(()),
            Ok(Incoming::Message(bytes)) => {
                let Ok(message) = serde_json::from_slice::<Value>(&bytes) else { continue };
                if message["type"] == "projection.ack" {
                    record_ack(shared, local, &message).map_err(|reason| Lost::new("durable_stream_changed", reason))?;
                } else if message["type"] == "signals.ack" {
                    let id = message["request_id"].as_str().unwrap_or("").to_string();
                    local.signal_acks.answered(&id);
                    record_signals_ack(local, &id, &message["payload"]).map_err(|reason| Lost::new("durable_stream_changed", reason))?;
                }
            }
            Err(e) => return Err(Lost::new("publisher_closed", format!("publisher recv: {e}"))),
        }
    }
}

/// Market Runtime's answer to a `signals.publish`: unread, a refused batch would be lost.
/// A refusal resends every signal B holds on the next turn -- one recorded `analysis.signals_full_republish` -- and a
/// batch of another durable stream means B's stream is not Market Runtime's any more: the connection is renewed.
pub(crate) fn record_signals_ack(local: &mut Local, request_id: &str, payload: &Value) -> Result<(), String> {
    if payload["ok"] != false {
        local.republish_batches.answered_ok(request_id);
        signals_republish_settled(local, 0);
        return Ok(());
    }
    let reason = payload["reason"].as_str().unwrap_or("refused").to_string();
    local.republish_signals = true;
    // A batch of the republish refused: that attempt failed; the next turn sends everything again (one more attempt).
    local.republish_batches.failed();
    if local.signals_republish.is_none() {
        local.signals_republish = Some(remediation::begin("stream_loop", "analysis.signals_full_republish", "signals_rejected",
            remediation::Identity::default(), json!({"reason": reason, "projection_epoch": local.projection_epoch})));
    }
    if reason == "STREAM_MISMATCH" {
        return Err(format!("Market Runtime refused signals of this durable stream: {reason}"));
    }
    Ok(())
}

/// Why the connections to Market Runtime were given up: the registered trigger reason of `analysis.a_reconnect`
/// (config/remediation_registry.json) and what happened.
pub(crate) struct Lost {
    pub(crate) trigger: &'static str,
    pub(crate) reason: String,
}

impl Lost {
    pub(crate) fn new(trigger: &'static str, reason: impl Into<String>) -> Self {
        Lost { trigger, reason: reason.into() }
    }
}

/// The two connections of one attempt, the durable subscription already sent on the reading one. Results go out on
/// their own connection: on one socket, Market Runtime's durable pushes and B's projection publishes blocked each
/// other (each side stuck writing while the other was writing too); A's write timeout then dropped the connection, B
/// resubscribed and replayed, and never left CATCHING_UP under load (a load test saw 48 drops in 3 minutes).
/// So reading and publishing never share a socket.
pub(crate) fn open_connections(args: &StreamArgs, local: &mut Local) -> Result<(WsClient, WsClient, u64), Lost> {
    let mut client = WsClient::connect(&args.url, &args.token).map_err(|e| Lost::new("connect_failed", format!("connect: {e}")))?;
    let publisher = match WsClient::connect(&args.url, &args.token) {
        Ok(c) => c,
        Err(e) => {
            client.close();
            return Err(Lost::new("connect_failed", format!("connect publisher: {e}")));
        }
    };
    let after = local.cursor.opening();
    if !send_durable_subscribe(&mut client, local, after) {
        client.close();
        publisher.close();
        return Err(Lost::new("subscribe_send_failed", "durable.subscribe could not be sent"));
    }
    Ok((client, publisher, after))
}

/// Tell A the projection was reset. A reset A did not receive leaves it holding the old projection, so a failed send
/// ends this connection (a recorded reconnect) instead of subscribing on as if A knew.
pub(crate) fn send_projection_reset(client: &mut WsClient, local: &Local, reason: &str) -> Result<(), Lost> {
    client.send_text(&json!({"type": "projection.reset", "payload": {"projection_epoch": local.projection_epoch, "reason": reason}}).to_string())
        .map_err(|e| Lost::new("resubscribe_failed", format!("projection.reset could not be sent: {e}")))
}

/// Tell A the projection was reset and re-read the durable stream from `after`.
pub(crate) fn resubscribe_after_reset(client: &mut WsClient, local: &mut Local, reason: &str, after: u64, lost: &'static str) -> Result<(), Lost> {
    send_projection_reset(client, local, reason)?;
    if !send_durable_subscribe(client, local, after) {
        return Err(Lost::new("resubscribe_failed", lost));
    }
    local.replaying = true;
    Ok(())
}

/// Rules can change at any time; a flow-rule change rebuilds the day at one replayable cut-over. Ok(true) = the day
/// is being rebuilt (the turn ends here).
pub(crate) fn check_rules(shared: &Shared, local: &mut Local, args: &StreamArgs, client: &mut WsClient) -> Result<bool, Lost> {
    if local.last_rules_check.elapsed() < timing::RULES_CHECK_INTERVAL && !shared.reload.swap(false, Ordering::AcqRel) {
        return Ok(false);
    }
    local.last_rules_check = Instant::now();
    let stamp = rules_stamp(args.config_root.as_deref());
    if stamp == local.rules_stamp {
        return Ok(false);
    }
    local.rules_stamp = stamp;
    let (set, problems) = rules::load(args.config_root.as_deref(), Some(&local.engine.rules));
    local.rule_problems = problems;
    let from = local.engine.rebuild_from();
    let old_rules = local.engine.rules.version_label();
    if !local.engine.set_rules(set.clone()) {
        return Ok(false);
    }
    shared.counters.rebuilds.fetch_add(1, Ordering::Relaxed);
    let reason = format!("flow rules changed ({old_rules} -> {}): rebuilding the day under the new version", set.version_label());
    reset(shared, local, "analysis.rules_rebuild", "flow_rules_changed", &reason, Some(from));
    local.engine.set_rules(set);
    resubscribe_after_reset(client, local, "flow rules changed", from, "resubscribe after rule change")?;
    Ok(true)
}

/// One turn's publishing on the publisher connection: the projection (whole once after A restarted, else what
/// changed), open replays, and model signals.
pub(crate) fn publish_turn(publisher: &mut WsClient, shared: &Shared, local: &mut Local, args: &StreamArgs, caught_up: bool) -> Result<(), Lost> {
    let interval = if caught_up { args.publish_interval } else { timing::CATCH_UP_PUBLISH_INTERVAL };
    if local.last_publish.elapsed() >= interval {
        let full = local.need_full_publish && caught_up;
        if caught_up || !local.need_full_publish {
            let sent = publish(publisher, shared, local, full, caught_up).map_err(|e| Lost::new("publish_failed", format!("publish: {e}")))?;
            if full {
                local.need_full_publish = false;
                for mut operation in local.awaiting_full_publish.drain(..) {
                    operation.finish("succeeded", Some(1), json!({"items": sent, "projection_epoch": local.projection_epoch,
                        "cursor": local.cursor.cursor, "partitions": local.engine.instruments.len()}));
                }
            }
        } else {
            local.last_publish = Instant::now();
        }
    }
    // Model signals: after a (re)connect Market Runtime holds none of B's rows, so the first turn resends them.
    let republish = std::mem::take(&mut local.republish_signals);
    pump_signals(publisher, shared, local, republish).map_err(|e| Lost::new("signals_publish_failed", format!("signals publish: {e}")))
}

/// Every 2 s: B's status to A and the local status view /metrics serves.
pub(crate) fn report_status(client: &mut WsClient, shared: &Shared, local: &mut Local, caught_up: bool) -> Result<(), Lost> {
    if local.last_status.elapsed() < timing::STATUS_INTERVAL {
        return Ok(());
    }
    local.last_status = Instant::now();
    local.cursor.track_catch_up(caught_up);
    evict_timelines(local, Instant::now());
    rebuild_stale_timelines(shared, local);
    archive_tick(shared, local);
    if client.send_text(&status_message(local, shared).to_string()).is_err() {
        return Err(Lost::new("status_send_failed", "status send"));
    }
    let mut v = shared.view.lock().unwrap();
    v.cursor = local.cursor.cursor;
    v.head = local.cursor.head;
    v.lag = local.cursor.lag();
    v.stream_id = local.cursor.stream_id.clone();
    v.resets = local.cursor.resets;
    v.gaps = local.cursor.gaps;
    v.permanent_holes = local.cursor.permanent_holes;
    v.undeclared_gaps = local.cursor.undeclared_gaps;
    v.pruned_skipped = local.cursor.pruned_skipped;
    v.duplicates = local.cursor.duplicates;
    v.state = if caught_up { "LIVE".into() } else { "CATCHING_UP".into() };
    v.engine = local.engine.summary();
    v.feature_keys = local.features.key_count();
    v.feature_warm_keys = local.features.warm_count();
    v.last_checkpoint = local.checkpoints.outcome().unwrap_or_else(|| local.checkpoint_info.clone());
    v.paper = json!({"working_orders": local.paper.working_count(), "delay_ms": local.paper.delay_ms(),
                     "io_errors": local.paper.io_errors.wire()});
    v.replay_timelines = Value::Array(local.timelines.iter().map(|c| c.build.wire()).collect());
    v.rules = json!({"flow_revision": local.engine.rules.flow_revision, "event_revision": local.engine.rules.event_revision,
        "problems": local.rule_problems, "label": local.engine.rules.version_label()});
    Ok(())
}

/// Apply one durable batch; a batch that left the cursor behind asks for the rest again.
pub(crate) fn on_durable_batch<I: Iterator<Item = Result<MarketEvent, Undecodable>>>(client: &mut WsClient, shared: &Shared, local: &mut Local,
                                                                           to: Option<u64>, replay: bool, events: I) -> Result<(), Lost> {
    if let Some(after) = apply_durable_batch(shared, local, to, replay, events) {
        if !send_durable_subscribe(client, local, after) {
            return Err(Lost::new("resubscribe_failed", "resubscribe"));
        }
    }
    Ok(())
}

/// The fields of `durable.subscribed` B acts on. Each one is required: a reply without them cannot say where the
/// batches after it start.
#[derive(Debug)]
pub(crate) struct Subscribed<'a> {
    pub(crate) after: u64,
    pub(crate) head: u64,
    pub(crate) stream_id: &'a str,
    pub(crate) runtime_epoch: u64,
    /// The replay open at Market Runtime; null when none is.
    pub(crate) open_replay: Option<&'a str>,
}

pub(crate) fn subscribed_fields(payload: &Value) -> Result<Subscribed<'_>, String> {
    let number = |field: &str| payload[field].as_u64().ok_or_else(|| format!("durable.subscribed without a valid {field}: {payload}"));
    let stream_id = payload["durable_stream_id"].as_str().filter(|id| !id.is_empty())
        .ok_or_else(|| format!("durable.subscribed without a durable_stream_id: {payload}"))?;
    let open_replay = match payload.get("replay_id") {
        Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.as_str()),
        _ => return Err(format!("durable.subscribed without a valid replay_id: {payload}")),
    };
    Ok(Subscribed { after: number("after_sequence")?, head: number("durable_sequence")?, stream_id, runtime_epoch: number("runtime_epoch")?, open_replay })
}

/// A's answer to durable.subscribe: the stream identity, whether A restarted, and the session the cut is in.
pub(crate) fn on_subscribed(client: &mut WsClient, shared: &Shared, local: &mut Local, payload: &Value, checkpoint_dir: &Path) -> Result<(), Lost> {
    if let Some(reason) = incompatible_schema(payload) {
        // Consuming would skip every event this build cannot read: stop here, cursor untouched.
        return Err(Lost::new("incompatible_writer", reason));
    }
    let violation = |detail: String| {
        shared.counters.contract_violations.fetch_add(1, Ordering::Relaxed);
        Lost::new("contract_violation", detail)
    };
    let fields = subscribed_fields(payload).map_err(violation)?;
    let head = fields.head;
    let acknowledged = fields.after;
    let changed = local.cursor.on_subscribed(acknowledged, head, fields.stream_id).map_err(violation)?;
    let stream_id = Some(fields.stream_id.to_string());
    let runtime_epoch = Some(fields.runtime_epoch);
    if let Some(changed) = changed {
        let trigger = match changed {
            cursor::StreamReset::StreamChanged(_) => "stream_changed",
            cursor::StreamReset::HeadBelowCursor(_) => "head_below_cursor",
        };
        let reason = changed.reason().to_string();
        reset(shared, local, "analysis.stream_reset", trigger, &reason, None);
        send_projection_reset(client, local, &reason)?;
        if !send_durable_subscribe(client, local, 0) {
            return Err(Lost::new("resubscribe_failed", "resubscribe"));
        }
    }
    if let Some(id) = stream_id {
        *shared.stream_id.lock().unwrap() = id;
    }
    {
        let mut v = shared.view.lock().unwrap();
        if v.runtime_epoch != runtime_epoch {
            // Market Runtime restarted (or this is B's first connection): its cache holds nothing of this projection,
            // so it gets the whole projection and every signal once. Only then -- a plain reconnect resumes from the
            // outbox.
            local.need_full_publish = true;
            local.republish_signals = true;
            local.outbox.clear();
            if let Some(previous) = v.runtime_epoch {
                let detail = json!({"old_runtime_epoch": previous, "new_runtime_epoch": runtime_epoch,
                    "stream": shared.stream_id.lock().unwrap().clone(), "projection_epoch": local.projection_epoch});
                local.awaiting_full_publish.push(remediation::begin("stream_loop", "analysis.projection_full_republish",
                    "market_runtime_restarted", remediation::Identity::default(), detail.clone()));
                if let Some(mut stale) = local.signals_republish.replace(remediation::begin("stream_loop",
                    "analysis.signals_full_republish", "market_runtime_restarted", remediation::Identity::default(), detail)) {
                    stale.finish("abandoned", None, json!({"reason": "Market Runtime restarted again"}));
                }
            }
        }
        // Answers to the previous connection's batches can no longer arrive: what was not answered is resent.
        let unanswered = local.signal_acks.reconnected();
        // A republish whose batches were not all answered ok on the lost connection is sent again, as one more attempt.
        if local.republish_batches.failed() {
            local.republish_signals = true;
        }
        if v.runtime_epoch == runtime_epoch && unanswered > 0 && !local.republish_signals {
            // The same Market Runtime, but signal batches it never answered (a send that failed half-way, a connection
            // lost before the ack): what it holds is unknown, so every signal B holds is sent once more.
            local.republish_signals = true;
            if local.signals_republish.is_none() {
                local.signals_republish = Some(remediation::begin("stream_loop", "analysis.signals_full_republish",
                    "signals_unacknowledged", remediation::Identity::default(),
                    json!({"unacknowledged_batches": unanswered, "runtime_epoch": runtime_epoch,
                           "projection_epoch": local.projection_epoch})));
            }
        }
        v.runtime_epoch = runtime_epoch;
    }
    if head <= local.cursor.cursor {
        local.replaying = false;
    }
    apply_rollover(shared, local, payload, checkpoint_dir);
    release_replays_except(local, fields.open_replay);
    // The fresh connections are confirmed only now: the reply was complete, acknowledged what B asked for, and the
    // cursor (with any reset and resubscription it needed) is settled.
    if let Some((mut operation, attempts)) = local.reconnect_pending.take() {
        operation.finish("succeeded", Some(attempts), json!({"after_sequence": acknowledged, "head": head,
            "durable_stream_id": fields.stream_id, "cursor": local.cursor.cursor}));
    }
    // B serves from here: Market Runtime confirmed its durable subscription. Health's start waits for this line, not
    // for `hello` (only the process identity, said before any connection to A).
    if !shared.ready_said.swap(true, Ordering::AcqRel) {
        stdout_line(&json!({"type": "ready", "service_id": SERVICE_ID, "instance_id": shared.instance,
            "durable_stream_id": fields.stream_id, "head": head, "cursor": local.cursor.cursor}));
    }
    Ok(())
}

/// Events of a market that is never stored (Futu crypto): applied as they come, no cursor. They cannot be re-read,
/// so whatever the lane loses is marked on what it held.
pub(crate) fn on_live_batch(shared: &Shared, local: &mut Local, payload: &mut Value) {
    let epoch = payload["runtime_epoch"].as_u64().unwrap_or(0);
    let sequence = payload["live_sequence"].as_u64().unwrap_or(0);
    // Why Market Runtime does not store these events (demand::Storage::live_lane), decided by its background revision.
    let storage = payload["storage"].as_str().map(str::to_string);
    let raws = match payload.get_mut("events").map(Value::take) {
        Some(Value::Array(events)) => events,
        _ => Vec::new(),
    };
    let (events, outcome) = receive_live_batch(&mut local.engine, &mut local.live_lane, epoch, sequence, storage.as_deref(), raws,
                                               now_ns());
    shared.counters.undecodable_events.fetch_add(outcome.undecodable, Ordering::Relaxed);
    let record = |trigger: &str, detail: Value| {
        eprintln!("[analysis_runtime] live lane {trigger}: {detail}");
        remediation::emit(remediation::Emit { component: "live_lane", mechanism_id: "analysis.live_lane_gap", trigger_reason: trigger,
            identity: remediation::Identity::default(), attempt: None, outcome: "failed", detail });
    };
    if let Some((first, marked)) = outcome.late_join() {
        record("joined_late", json!({"first_sequence": first, "partitions_marked": marked}));
    }
    if let Some((old, new)) = outcome.epoch_changed {
        record("epoch_changed", json!({"old_epoch": old, "new_epoch": new}));
    }
    if let Some((last, received)) = outcome.skipped {
        record("sequence_skipped", json!({"last_sequence": last, "received_sequence": received}));
    }
    if outcome.undecodable > 0 {
        record("undecodable_event", json!({"live_sequence": sequence, "events": outcome.undecodable}));
    }
    if outcome.old_format > 0 {
        shared.counters.old_format_events.fetch_add(outcome.old_format, Ordering::Relaxed);
        eprintln!("[analysis_runtime] live lane refused {} older-format events (live_sequence {sequence})", outcome.old_format);
    }
    apply_live_batch(shared, local, storage.as_deref(), events.into_iter());
}

/// Market Runtime declares (after, through] undeliverable, with its reason: retention removed it (PRUNED) or the WAL
/// cannot read it (UNREADABLE). Either way the state must not carry on as if it were complete. The range
/// is A's statement; nothing here is inferred.
pub(crate) fn on_durable_gap(client: &mut WsClient, shared: &Shared, local: &mut Local, payload: &Value) -> Result<(), Lost> {
    let pruned = payload["reason"].as_str() == Some("PRUNED");
    let Some(through) = payload["through_sequence"].as_u64() else {
        eprintln!("[analysis_runtime] durable.gap without a range ignored: {payload}");
        return Ok(());
    };
    let holding = !local.engine.instruments.is_empty();
    let before = local.cursor.cursor;
    match local.cursor.on_gap(through, pruned, holding) {
        GapAction::Skip => {}
        GapAction::Hole => {
            local.engine.mark_durable_gap();
            local.paper.on_durable_gap(through, now_ns());
            remediation::emit(remediation::Emit { component: "durable_cursor", mechanism_id: "analysis.durable_hole",
                trigger_reason: "declared_unreadable", identity: remediation::Identity::default(), attempt: None,
                outcome: "failed", detail: json!({"after_sequence": before, "through_sequence": through,
                    "events": through.saturating_sub(before), "instruments_marked": local.engine.instruments.len()})});
        }
        GapAction::Rebuild { after } => {
            reset(shared, local, "analysis.retention_rebuild", "wal_pruned_after_state",
                  &format!("WAL retention removed events through {through} after the held state: rebuilding from {after}"), Some(after));
            resubscribe_after_reset(client, local, "durable gap (pruned)", after, "resubscribe after pruned gap")?;
        }
    }
    Ok(())
}

pub(crate) fn on_message(client: &mut WsClient, shared: &Shared, local: &mut Local, checkpoint_dir: &Path, bytes: &[u8]) -> Result<(), Lost> {
    // Fast path: a durable batch decodes straight into typed events, never through a Value tree (B's hot path under
    // load). Anything else -- or a batch with an event this build cannot type -- takes the generic path below, which
    // decodes event by event and reports the undecodable ones.
    if let Ok(batch) = serde_json::from_slice::<DurableBatchMessage>(bytes) {
        if batch.kind == "durable.batch" {
            if !local.cursor.accepting_batches() {
                return Ok(());
            }
            let events = batch.payload.events.into_iter().map(Ok);
            return on_durable_batch(client, shared, local, Some(batch.payload.to_sequence), batch.payload.replay, events);
        }
    }
    // A message that is not JSON, or a durable batch whose container is broken, is a contract violation: nothing of
    // it is applied (the cursor and head stay where they were), it is counted, and the connection is re-subscribed
    // from the cursor -- a Lost is recorded as analysis.a_reconnect. Read as "nothing" instead, a batch whose
    // events were not a list would move the head while the cursor stayed, leaving B CATCHING_UP for good.
    let violation = |detail: String| {
        shared.counters.contract_violations.fetch_add(1, Ordering::Relaxed);
        Lost::new("contract_violation", detail)
    };
    let mut message = serde_json::from_slice::<Value>(bytes)
        .map_err(|e| violation(format!("undecodable message ({} bytes): {e}", bytes.len())))?;
    // Taken, not cloned: a durable batch carries thousands of events, and copying the tree twice per batch (payload,
    // then events) was a large part of B's per-event cost under load.
    let mut payload = message.get_mut("payload").map(Value::take).unwrap_or(Value::Null);
    match message.get("type").and_then(Value::as_str) {
        Some("durable.subscribed") => on_subscribed(client, shared, local, &payload, checkpoint_dir)?,
        Some("session.rollover") => apply_rollover(shared, local, &payload, checkpoint_dir),
        Some("live.batch") => on_live_batch(shared, local, &mut payload),
        Some("flow.large_orders.query") => {
            // A viewer asked Market Runtime for one window's large orders (the 價量 tab's session bucket); A forwarded
            // it here and routes the answer back by query_id.
            let mut reply = large_orders_reply(&local.engine, &payload);
            reply["catching_up"] = json!(local.replaying || local.cursor.lag() > CATCH_UP_LAG);
            if client.send_text(&json!({"type": "flow.large_orders.result", "payload": reply}).to_string()).is_err() {
                return Err(Lost::new("reply_send_failed", "large orders reply"));
            }
        }
        Some("durable.gap") => on_durable_gap(client, shared, local, &payload)?,
        Some("durable.batch") => {
            if !local.cursor.accepting_batches() {
                return Ok(());
            }
            let (to, replay, events) = durable_batch_container(&mut payload).map_err(violation)?;
            let to = Some(to);
            let decoded = events.into_iter().map(|raw| {
                MarketEvent::decode_value(&raw).map_err(|refused| Undecodable {
                    sequence: raw["durable_sequence"].as_u64(), old_format: refused.is_old_format(), error: refused.to_string(),
                    instrument: lost_instrument(&raw),
                })
            });
            on_durable_batch(client, shared, local, to, replay, decoded)?;
        }
        Some("projection.ack") => {
            if let Err(reason) = record_ack(shared, local, &json!({"request_id": message.get("request_id"), "payload": payload})) {
                return Err(Lost::new("durable_stream_changed", reason));
            }
        }
        Some("replay.prepare") => {
            // Market Runtime needs this recording's timeline (built now, while it loads; or what it is missing).
            prepare_timeline(shared, local, &payload);
        }
        Some("replay.focus") => replay_focus(local, &payload),
        Some("replay.close") => {
            if let Some(id) = payload["replay_id"].as_str() {
                release_replay(local, id);
            }
        }
        _ => {}
    }
    Ok(())
}

/// One connection's life: turns until stop (None) or the connection is lost (Some).
pub(crate) fn run_connection(shared: &Shared, local: &mut Local, args: &StreamArgs, client: &mut WsClient, publisher: &mut WsClient) -> Option<Lost> {
    let checkpoint_dir = args.data_dir.clone();
    let mut last_drain = Instant::now();
    let mut last_paper = Instant::now();
    loop {
        if shared.stop.load(Ordering::Acquire) {
            return None;
        }
        match check_rules(shared, local, args, client) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(lost) => return Some(lost),
        }
        let caught_up = !local.replaying && local.cursor.lag() <= CATCH_UP_LAG;
        if caught_up && shared.reschedule.swap(false, Ordering::AcqRel) {
            for key in local.features.key_ids() {
                schedule(shared, &local.features, &key);
            }
        }
        if let Err(lost) = publish_turn(publisher, shared, local, args, caught_up) {
            return Some(lost);
        }
        for span in drain_timeline_outbox(local) {
            // A span Market Runtime never got is built again: it asks for the recording again when it finds its
            // timeline short (replay.prepare); the connection is treated as lost (recorded, reconnected).
            if let Err(e) = client.send_text(&span) {
                return Some(Lost::new("timeline_send_failed", format!("replay.timeline could not be sent: {e}")));
            }
        }
        // Acks come back on the publisher connection; read what has arrived, at most every 200 ms (each read polls
        // with a short socket timeout, which must not be paid once per durable message).
        if last_drain.elapsed() >= timing::PUBLISHER_DRAIN_INTERVAL {
            last_drain = Instant::now();
            if let Err(lost) = drain_publisher(publisher, shared, local) {
                return Some(lost);
            }
        }
        if let Err(lost) = report_status(client, shared, local, caught_up) {
            return Some(lost);
        }
        if local.last_checkpoint.elapsed() >= args.checkpoint_interval && caught_up {
            write_checkpoint(shared, local, &checkpoint_dir);
        }
        if last_paper.elapsed() >= timing::PAPER_TURN {
            last_paper = Instant::now();
            paper_turn(local);
        }
        let bytes = match client.recv(timing::STREAM_RECV_WAIT) {
            Ok(Incoming::Idle) => continue,
            Ok(Incoming::Message(bytes)) => bytes,
            Err(e) => return Some(Lost::new("recv_failed", format!("recv: {e}"))),
        };
        if let Err(lost) = on_message(client, shared, local, &checkpoint_dir, &bytes) {
            return Some(lost);
        }
    }
}

/// 模擬下單: the commands appended since the last turn (each enters after what B has applied by now), and the records
/// the matching produced. Done while B catches up too: a command only enters at an event received
/// after it was accepted, so reading it early changes nothing.
pub(crate) fn paper_turn(local: &mut Local) {
    local.paper.poll_commands(local.cursor.cursor);
    local.paper.flush();
}

pub(crate) fn stream_loop(shared: Arc<Shared>, args: StreamArgs, mut local: Local) {
    let checkpoint_dir = args.data_dir.clone();
    // Losing (or failing to open) the connections to Market Runtime is one remediation -- started at the
    // failure, succeeded once fresh connections got a verified `durable.subscribed` (on_subscribed), abandoned if B
    // stops first.
    // `attempts` counts the connection attempts made for it.
    let mut reconnect: Option<remediation::Operation> = None;
    let mut attempts: u64 = 0;
    let begin_reconnect = |reconnect: &mut Option<remediation::Operation>, lost: &Lost, local: &Local| {
        if reconnect.is_none() {
            *reconnect = Some(remediation::begin("stream_loop", "analysis.a_reconnect", lost.trigger, remediation::Identity::default(),
                json!({"error": lost.reason, "endpoint": args.url, "cursor": local.cursor.cursor, "lag": local.cursor.lag()})));
        }
    };
    while !shared.stop.load(Ordering::Acquire) {
        if reconnect.is_some() {
            attempts += 1;
        }
        let (mut client, mut publisher, _after) = match open_connections(&args, &mut local) {
            Ok(opened) => opened,
            Err(lost) => {
                begin_reconnect(&mut reconnect, &lost, &local);
                shared.view.lock().unwrap().last_error = Some(lost.reason);
                timing::wait_unless_stopping(&shared.stop, timing::Reconnect::OpenFailed.delay());
                continue;
            }
        };
        if let Some(operation) = reconnect.take() {
            // Open and subscribing, not yet confirmed: on_subscribed closes it.
            local.reconnect_pending = Some((operation, attempts));
            attempts = 0;
        }
        // A new connection is not a new Market Runtime: what it already holds stays, what was in flight was marked
        // dirty again when the old connection went, and `durable.subscribed` says whether A restarted.
        local.replaying = true;
        {
            let mut v = shared.view.lock().unwrap();
            v.connected = true;
            v.last_error = None;
        }
        let failure = run_connection(&shared, &mut local, &args, &mut client, &mut publisher);
        // Lost before durable.subscribed confirmed it: the same remediation goes on, with its attempts so far.
        if let Some((operation, made)) = local.reconnect_pending.take() {
            reconnect = Some(operation);
            attempts = made;
        }
        let incompatible = failure.as_ref().is_some_and(|lost| lost.trigger == "incompatible_writer");
        {
            let mut v = shared.view.lock().unwrap();
            v.connected = false;
            if incompatible {
                v.state = "INCOMPATIBLE".into();
            }
            if let Some(lost) = failure {
                // A reconnect costs a durable re-read and a resend of what was in flight: never a silent event.
                shared.counters.reconnects.fetch_add(1, Ordering::Relaxed);
                eprintln!("[analysis_runtime] connection to Market Runtime lost, reconnecting: {}", lost.reason);
                begin_reconnect(&mut reconnect, &lost, &local);
                v.last_error = Some(lost.reason);
            }
        }
        client.close();
        publisher.close();
        // What the lost connection carried and A never acknowledged goes out again on the next one.
        let requeued = local.outbox.requeue_all(&mut local.engine);
        shared.counters.publish_requeued.fetch_add(requeued, Ordering::Relaxed);
        let cause = if incompatible { timing::Reconnect::IncompatibleWriter } else { timing::Reconnect::Lost };
        timing::wait_unless_stopping(&shared.stop, cause.delay());
    }
    if let Some(mut operation) = reconnect.take() {
        operation.finish("abandoned", Some(attempts), json!({"reason": "analysis_runtime stopping"}));
    }
    for mut operation in local.awaiting_full_publish.drain(..).chain(local.signals_republish.take()) {
        operation.finish("abandoned", None, json!({"reason": "analysis_runtime stopping"}));
    }
    final_checkpoint(&shared, &mut local, &checkpoint_dir);
    // A retry still open after the last checkpoint (it failed too) ends with the process.
    checkpoint_retry_ended(&shared, "abandoned", json!({"reason": "analysis_runtime stopped"}));
    // The final checkpoint's outcome is what the `stopped` report tells Health.
    shared.view.lock().unwrap().last_checkpoint = local.checkpoint_info.clone();
}
