//! Provider ingest: the envelope, durable acknowledgement, the live-only lanes, and the deltas and clocks each applied event causes.

use crate::contract::{self, Role};
use crate::demand::{BackgroundList, Storage, LIVE_NEVER_STORED};
use crate::event::{
    futures_partition, is_session_partitioned, market_local_minute, ClockScope, EventFlags, MarketEvent, Payload, StateKey, CLOCK_CODE, EVENT_SCHEMA_VERSION,
    INGEST_SCHEMA, LOSS_CONTROL, SOURCE_GAP,
};
use crate::projection::ProjectionEntry;
use crate::rollover::{self};
use crate::state::{ApplyResult, Changed, PrintRepeat, SymbolState};
use crate::wire::{self};
use crate::fsutil::atomic_write;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;
use std::sync::{Arc, MutexGuard};
use std::thread::{self};
use std::time::Instant;
use super::{hub::*, session::replan, startup::*};

/// Emit one delta for `key` to every viewer watching the instrument. Must be called with `core` held.
pub(crate) fn emit_delta(hub: &Hub, core: &mut Core, key: &StateKey, generation: u64, delta_type: &str, channels: &[&str], payload: Value,
              extra: Map<String, Value>, trace: Option<(u64, u64, u64)>) {
    let seq = {
        let s = core.view_seq.entry(key.clone()).or_insert(0);
        *s += 1;
        *s
    };
    let clients = hub.clients.read().unwrap();
    let watchers: Vec<&ClientHandle> = clients.iter()
        .filter(|c| c.role == Role::Viewer && c.watched.read().unwrap().contains(&key.instrument)).collect();
    if watchers.is_empty() {
        return;
    }
    let mut extra = extra;
    // `trace.version` is the key A files this delta's send time under (latency::on_sent) and the one the renderer must
    // echo in latency.report. The delta's own `sequence` is the VIEW's numbering, a different space: reporting it
    // matched 86% of samples to nothing and the rest to unrelated sends (資料套用延遲 p50 106 s).
    if let Some((backend_us, a_us, _)) = trace {
        extra.insert("trace".into(), json!({"version": seq, "backend_received_us": backend_us, "a_received_us": a_us}));
    }
    let body = wire::delta(&hub.identity(), key, generation, seq, delta_type, channels, payload, extra);
    let bytes = Arc::new(serde_json::to_vec(&json!({"type": "view.delta", "payload": body})).unwrap_or_default());
    for client in watchers {
        send_to(client, Outgoing {
            kind: OutKind::Delta { key: key.clone(), sequence: seq, replay: None },
            bytes: bytes.clone(),
            trace: trace.map(|(b, a, x)| (key.instrument.wire(), seq, b, a, x)),
        }, &hub.counters);
    }
}

/// New or revised events of one symbol to every viewer subscribed to that market/session's tape. Called with `core`
/// held, so a tape snapshot is never overtaken by a push of what it already holds.
pub(crate) fn emit_event_tape(hub: &Hub, key: &StateKey, data: &Value) {
    let clients = hub.clients.read().unwrap();
    let subscribers: Vec<&ClientHandle> = clients.iter().filter(|c| c.role == Role::Viewer && c.event_tape.read().unwrap().as_ref()
        .is_some_and(|(market, session, _)| market.eq_ignore_ascii_case(&key.instrument.market) && session.eq_ignore_ascii_case(&key.session.session)))
        .collect();
    if subscribers.is_empty() {
        return;
    }
    let events: Vec<Value> = data.get("events").and_then(Value::as_array).into_iter().flatten().map(|event| {
        let mut event = event.clone();
        if let Some(obj) = event.as_object_mut() {
            for (field, value) in [("source", &key.instrument.source), ("market", &key.instrument.market), ("code", &key.instrument.code),
                                   ("trading_date", &key.session.trading_date), ("session", &key.session.session)] {
                obj.entry(field).or_insert_with(|| json!(value));
            }
        }
        event
    }).collect();
    if events.is_empty() {
        return;
    }
    let bytes = Arc::new(serde_json::to_vec(&json!({"type": "events.tape", "payload": {
        "market": key.instrument.market, "session": key.session.session, "trading_date": key.session.trading_date, "events": events}}))
        .unwrap_or_default());
    for client in subscribers {
        send_to(client, Outgoing { kind: OutKind::Adapter, bytes: bytes.clone(), trace: None }, &hub.counters);
    }
}

/// The 事件列表 tape of one market/session, with what it is to show (so the renderer never searches dates and
/// guesses which day to display). `current_trading_date` is the session the screens show; `presentation` says where
/// its rows are:
///   CURRENT  -- `events` (this cache): the live session, a quiet one, and the pre-open -- which shows the new day,
///               empty until its first event (使用者 10-22: the previous day's events are not shown before the open);
///   ARCHIVE  -- the current day's event file (B's archive via /api/monitor/events), after a restart that dropped this
///               cache outside the live session.
/// Called with `core` held by the caller's order: snapshot and subscription are cut together.
pub(crate) fn event_tape_snapshot(hub: &Hub, core: &Core, market: &str, sess: &str, limit: usize, trading_date: Option<String>) -> Value {
    let current = session_current_with(hub, core);
    let equity = &current["equity"];
    let date = trading_date.unwrap_or_else(|| equity["trading_date"].as_str().unwrap_or_default().to_owned());
    let events = core.projection.event_tape(market, sess, &date, limit);
    let phase = equity["phase"].as_str().unwrap_or("");
    let presentation = tape_presentation(!events.is_empty(), phase);
    json!({"market": market, "session": sess, "trading_date": date, "current_trading_date": date, "phase": phase,
        "presentation": presentation, "presentation_trading_date": date, "events": events, "limit": limit})
}

/// Where the tape's rows come from: this cache when it holds the day's events, during the live session and from the
/// pre-open on (the new day, empty until its first event); the day's archive only when the cache has none outside them.
pub(crate) fn tape_presentation(has_events: bool, phase: &str) -> &'static str {
    if has_events || phase == "LIVE" || phase == "PREOPEN" { "CURRENT" } else { "ARCHIVE" }
}

pub(crate) fn session_current(hub: &Hub) -> Value {
    let core = lock(&hub.core);
    session_current_with(hub, &core)
}

/// `session_current` with `core` already held.
pub(crate) fn session_current_with(hub: &Hub, core: &Core) -> Value {
    let now = now_ns() as i64;
    let opened = hub.opened();
    let mut equity = rollover::equity_session(&hub.calendar(), &opened, now).unwrap_or(Value::Null);
    if hub.config.clock == MarketClock::Exchange {
        // The data is a recorded session that is not today: the session is the newest stock day it holds.
        let held = core.engine.iter()
            .filter(|s| s.key.session.session.eq_ignore_ascii_case("DAY") && s.key.instrument.market.eq_ignore_ascii_case("STK"))
            .map(|s| s.key.session.trading_date.clone()).max();
        if let Some(date) = held {
            equity = json!({"trading_date": date, "session": "DAY", "live": true, "phase": "LIVE"});
        }
    }
    let futures = rollover::futures_sessions(&hub.calendar(), &opened, now).unwrap_or(Value::Null);
    let us = hub.us_calendar.get();
    // The Futu US session (crate::us_session): A pushes this message again whenever it changes (retention.rs).
    json!({"equity": equity, "futures": futures, "us": crate::us_session::us_session(&us, now).unwrap_or(Value::Null),
           "cutoffs": rollover::cutoffs(&hub.calendar(), &us, &opened, now), "runtime_epoch": hub.runtime_epoch})
}

pub(crate) fn on_commit(hub: &Arc<Hub>, events: Vec<MarketEvent>, last: u64) {
    hub.checkpointing.events_since.fetch_add(events.len() as u64, Ordering::Relaxed);
    if !hub.stream_anchored.load(Ordering::Acquire) {
        let index = hub.wal().index_snapshot();
        if let Some(anchor) = index.anchor() {
            let body = json!({"durable_stream_id": hub.durable_stream_id, "wal_anchor": anchor}).to_string();
            let path = hub.config.data_dir.join(STREAM_IDENTITY_FILE);
            match atomic_write(&path, body.as_bytes()) {
                Ok(()) => hub.stream_anchored.store(true, Ordering::Release),
                // Not anchored yet: the next committed batch tries again.
                Err(e) => { FILE_WRITE_FAILURES.record("stream identity anchor", &path, &e); }
            }
        }
    }
    let from = events.first().map(|e| e.durable_sequence).unwrap_or(last);
    let bytes = serde_json::to_vec(&json!({"type": "durable.batch", "payload": {
        "from_sequence": from, "to_sequence": last, "durable_stream_id": hub.durable_stream_id, "events": events}}))
        .unwrap_or_default();
    // The watermark through `last` is published (the WAL raises it before calling here); pairs with the fence in
    // `replay_chunk`, so a consumer ending its replay either read `last` or is queued this batch.
    std::sync::atomic::fence(Ordering::SeqCst);
    broadcast_role(hub, |c| c.role == Role::AnalysisRuntime && c.wants_durable.load(Ordering::Acquire)
            && c.durable_live.load(Ordering::SeqCst),
        Outgoing { kind: OutKind::Durable { from, to: last }, bytes: Arc::new(bytes), trace: None });
}

/// What a provider sends: the event as the source stated it. It names no partition -- no trading date, session or
/// partition minute: Market Runtime names those from the exchange time ([`crate::event::wal_partition`]), and an
/// envelope that carries one is refused ([`PROVIDER_PARTITION_FIELDS`]).
#[derive(Deserialize)]
pub(crate) struct Envelope {
    /// Always INGEST_SCHEMA; anything else is refused.
    pub(crate) schema: String,
    #[serde(default)]
    pub(crate) event_id: String,
    pub(crate) source: String,
    pub(crate) market: String,
    pub(crate) code: String,
    /// The trading day a reference read from the broker (backend_clock) describes; see `partitions_of`.
    #[serde(default)]
    pub(crate) describes_trading_date: Option<String>,
    pub(crate) generation: u64,
    pub(crate) sequence: u64,
    pub(crate) event_type: String,
    pub(crate) exchange_ts_ns: i64,
    #[serde(default)]
    pub(crate) arrival_ns: u64,
    #[serde(default)]
    pub(crate) time_quality: String,
    #[serde(default)]
    pub(crate) trace_id: String,
    #[serde(default)]
    pub(crate) flags: EventFlags,
    #[serde(default)]
    pub(crate) versions: BTreeMap<String, String>,
    pub(crate) data: Value,
}

/// Partition fields only Market Runtime names: in the envelope (`trading_date`, `session`) and in its `data`
/// (`minute`). A provider that sends one is of the older protocol, where each provider computed them: refused.
pub(crate) const PROVIDER_PARTITION_FIELDS: [&str; 2] = ["trading_date", "session"];

/// Why an envelope is refused for naming a partition itself (None: it names none).
pub(crate) fn names_partition(raw: &Value) -> Option<String> {
    let envelope = PROVIDER_PARTITION_FIELDS.iter().find(|field| raw.get(**field).is_some()).map(|f| f.to_string());
    let data = raw.get("data").and_then(|d| d.get("minute")).map(|_| "data.minute".to_string());
    envelope.or(data).map(|field| format!("OLD_FORMAT: the envelope carries {field}; Market Runtime names every partition"))
}

#[derive(Deserialize)]
pub(crate) struct QuoteData {
    #[serde(default)] current: i64, #[serde(default)] open: i64,
    #[serde(default)] high: i64, #[serde(default)] low: i64, #[serde(default)] total_volume: f64,
    #[serde(default)] total_amount: f64, #[serde(default)] status: String,
    #[serde(default)] average: i64, #[serde(default)] volume: f64, #[serde(default)] amount: f64,
    #[serde(default)] advance_count: Option<i64>, #[serde(default)] decline_count: Option<i64>, #[serde(default)] flat_count: Option<i64>,
    #[serde(default)] limit_up_count: Option<i64>, #[serde(default)] limit_down_count: Option<i64>,
}

#[derive(Deserialize)]
pub(crate) struct TradeData {
    pub(crate) price: i64, volume: f64, #[serde(default)] total_volume: f64, #[serde(default)] side: i8,
    #[serde(default)] simtrade: bool, #[serde(default)] bid_side_total_vol: Option<f64>, #[serde(default)] ask_side_total_vol: Option<f64>,
    #[serde(default)] trade_id: String,
    #[serde(default)] open: i64, #[serde(default)] high: i64, #[serde(default)] low: i64, #[serde(default)] average: i64,
    #[serde(default)] total_amount: f64, #[serde(default)] amount: f64,
    #[serde(default)] condition: Option<String>,
}

/// A source bar always has its close and volume; its minute is its exchange time's. Open/high/low are absent when the
/// source has none (Futu RT_DATA is a 分時 point: price, average and volume per minute): 0 = not known, as for a
/// quote, never a refused bar.
#[derive(Deserialize)]
pub(crate) struct BarData {
    #[serde(default)] open: i64, #[serde(default)] high: i64, #[serde(default)] low: i64, close: i64, #[serde(default)] average: i64, volume: f64, #[serde(default)] amount: f64,
}

/// Volumes are decimal quantities (crate::volume). A non-finite one from a source is no quantity, never NaN in the WAL.
/// `minute` is the partition minute Market Runtime named from the exchange time (quotes, prints and bars carry it).
pub(crate) fn payload_from(kind: &str, data: Value, minute: i32) -> Result<Payload, String> {
    use crate::volume::sanitize;
    let bad = |e: serde_json::Error| e.to_string();
    Ok(match kind {
        "quote" => {
            let d: QuoteData = serde_json::from_value(data).map_err(bad)?;
            Payload::Quote { current: d.current, open: d.open, high: d.high, low: d.low,
                total_volume: sanitize(d.total_volume), total_amount: d.total_amount, status: d.status, minute, average: d.average,
                volume: sanitize(d.volume), amount: d.amount, advance_count: d.advance_count, decline_count: d.decline_count,
                flat_count: d.flat_count, limit_up_count: d.limit_up_count, limit_down_count: d.limit_down_count }
        }
        "trade" => {
            let d: TradeData = serde_json::from_value(data).map_err(bad)?;
            Payload::Trade { price: d.price, volume: sanitize(d.volume), total_volume: sanitize(d.total_volume), side: d.side, trade_id: d.trade_id,
                minute, open: d.open, high: d.high, low: d.low, average: d.average,
                total_amount: d.total_amount, amount: d.amount, simtrade: d.simtrade, bid_side_total_vol: d.bid_side_total_vol.map(sanitize),
                ask_side_total_vol: d.ask_side_total_vol.map(sanitize), auction: false, after_hours: false,
                condition: d.condition.filter(|c| !c.is_empty()), no_last_sale: false }
        }
        "orderbook" => {
            #[derive(Deserialize)]
            struct B { bids: Vec<crate::event::BookLevel>, asks: Vec<crate::event::BookLevel>, #[serde(default)] simtrade: bool }
            let mut d: B = serde_json::from_value(data).map_err(bad)?;
            for level in d.bids.iter_mut().chain(d.asks.iter_mut()) {
                level.volume = sanitize(level.volume);
            }
            Payload::OrderBook { bids: d.bids, asks: d.asks, simtrade: d.simtrade }
        }
        "minute_bar" => {
            let d: BarData = serde_json::from_value(data).map_err(bad)?;
            Payload::MinuteBar { minute, open: d.open, high: d.high, low: d.low, close: d.close, average: d.average, volume: sanitize(d.volume), amount: d.amount }
        }
        "reference" => {
            #[derive(Deserialize)]
            struct R { #[serde(default)] limit_up: Option<i64>, #[serde(default)] limit_down: Option<i64>, #[serde(default)] prev_close: Option<i64>,
                       #[serde(default)] prev_volume: Option<f64>, #[serde(default)] reference_price: Option<i64>, #[serde(default)] name: Option<String>,
                       #[serde(default)] reference_source: Option<String> }
            let d: R = serde_json::from_value(data).map_err(bad)?;
            Payload::Reference { limit_up: d.limit_up, limit_down: d.limit_down, prev_close: d.prev_close, prev_volume: d.prev_volume,
                reference_price: d.reference_price, name: d.name, reference_source: d.reference_source }
        }
        "source_status" => Payload::SourceStatus {
            state: data.get("state").and_then(Value::as_str).unwrap_or("unknown").to_string(),
            detail: data.get("detail").and_then(Value::as_str).unwrap_or_default().to_string(),
        },
        other => return Err(format!("unsupported event_type {other}")),
    })
}

/// `storage` says what an accepted event became: `wal` (it has a durable sequence; it is on disk once a pushed
/// `event.durable` watermark reaches that sequence) or `live_only` (盤前試撮, a never-stored market: applied and shown,
/// never written, so there is nothing to wait for).
pub(crate) fn ack(accepted: bool, reason: Option<&str>, env: (&str, u64, u64), durable_sequence: Option<u64>) -> Value {
    let storage = match (accepted, durable_sequence) {
        (true, Some(_)) => json!("wal"),
        (true, None) => json!("live_only"),
        (false, _) => Value::Null,
    };
    json!({"accepted": accepted, "reason": reason, "code": env.0, "generation": env.1, "sequence": env.2,
           "durable_sequence": durable_sequence, "storage": storage})
}

pub(crate) fn ingest_one(hub: &Arc<Hub>, role: &Role, raw: Value) -> Value {
    if let Some(reason) = names_partition(&raw) {
        hub.counters.rejected_old_format.fetch_add(1, Ordering::Relaxed);
        let text = |field: &str| raw.get(field).and_then(Value::as_str).unwrap_or_default().to_owned();
        let number = |field: &str| raw.get(field).and_then(Value::as_u64).unwrap_or_default();
        return ack(false, Some(&reason), (&text("code"), number("generation"), number("sequence")), None);
    }
    let env: Envelope = match serde_json::from_value(raw) {
        Ok(e) => e,
        Err(e) => {
            hub.counters.rejected_parse.fetch_add(1, Ordering::Relaxed);
            return json!({"accepted": false, "reason": format!("parse: {e}")});
        }
    };
    let id = (env.code.clone(), env.generation, env.sequence);
    let idr = (id.0.as_str(), id.1, id.2);
    if env.schema != INGEST_SCHEMA {
        hub.counters.rejected_old_format.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some(&format!("OLD_FORMAT: envelope schema {:?}; only {INGEST_SCHEMA} is read", env.schema)), idr, None);
    }
    let Role::Provider(own) = role else {
        hub.counters.rejected_forbidden.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some("FORBIDDEN_ROLE"), idr, None);
    };
    if !env.source.eq_ignore_ascii_case(own) {
        hub.counters.rejected_forbidden.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some("FORBIDDEN_SOURCE: a provider may only ingest its own source"), idr, None);
    }
    if !contract::may_ingest_kind(role, &env.event_type) {
        hub.counters.rejected_forbidden.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some("FORBIDDEN_KIND"), idr, None);
    }
    if hub.lifecycle.draining.load(Ordering::Acquire) || !hub.lifecycle.running.load(Ordering::Acquire) {
        hub.counters.rejected_draining.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some("draining"), idr, None);
    }
    // A market event without the exchange's own time is refused, never dated by a clock: its partition is named from
    // that time alone. Providers refuse it first and count it; this is the backstop. (Coverage is not ingested:
    // Market Runtime writes it.)
    if env.exchange_ts_ns <= 0 {
        hub.counters.rejected_missing_time.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some("MISSING_EXCHANGE_TIME"), idr, None);
    }
    let partitions = match partitions_of(hub, &env) {
        Ok(partitions) => partitions,
        Err((reason, counter)) => {
            counter(&hub.counters).fetch_add(1, Ordering::Relaxed);
            return ack(false, Some(&reason), idr, None);
        }
    };
    let a_received = now_ns();
    let time_quality = if env.time_quality.is_empty() { "exchange".to_owned() } else { env.time_quality.clone() };
    let mut answer: Option<Value> = None;
    let mut data = env.data.clone();
    let stated = stated_reference(&env.event_type, &mut data);
    for (trading_date, session, minute) in partitions {
        if let Some(reference) = &stated {
            let reference = MarketEvent {
                schema_version: EVENT_SCHEMA_VERSION, event_id: format!("{}:reference", env.event_id), durable_sequence: 0,
                symbol: format!("{}:{}:{}", env.source.to_lowercase(), env.market.to_uppercase(), env.code.to_uppercase()),
                provider: env.source.to_lowercase(), market: env.market.to_uppercase(), code: env.code.to_uppercase(),
                session: session.to_owned(), trading_date: trading_date.clone(), generation: env.generation, sequence: env.sequence,
                exchange_ts_ns: env.exchange_ts_ns, arrival_ns: env.arrival_ns, a_received_ns: a_received, runtime_epoch: hub.runtime_epoch,
                time_quality: time_quality.clone(), trace_id: env.trace_id.clone(),
                // A view-only print's 昨收 is shown as it is: never written either.
                flags: EventFlags { view_only: env.flags.view_only, ..EventFlags::default() }, versions: env.versions.clone(),
                payload: reference.clone(),
            };
            if !partition_holds(hub, &reference) {
                let one = ingest_event(hub, reference, idr, a_received);
                if one["accepted"] != true {
                    return one;
                }
            }
        }
        let payload = match payload_from(&env.event_type, data.clone(), minute) {
            Ok(p) => p,
            Err(e) => {
                hub.counters.rejected_parse.fetch_add(1, Ordering::Relaxed);
                return ack(false, Some(&e), idr, None);
            }
        };
        let event = MarketEvent {
            schema_version: EVENT_SCHEMA_VERSION, event_id: env.event_id.clone(), durable_sequence: 0,
            symbol: format!("{}:{}:{}", env.source.to_lowercase(), env.market.to_uppercase(), env.code.to_uppercase()),
            provider: env.source.to_lowercase(), market: env.market.to_uppercase(), code: env.code.to_uppercase(),
            session: session.to_owned(), trading_date, generation: env.generation, sequence: env.sequence,
            exchange_ts_ns: env.exchange_ts_ns, arrival_ns: env.arrival_ns, a_received_ns: a_received, runtime_epoch: hub.runtime_epoch,
            time_quality: time_quality.clone(), trace_id: env.trace_id.clone(), flags: env.flags.clone(), versions: env.versions.clone(), payload,
        };
        // A reference the partition already holds whole is accepted and not written (nothing to wait for).
        let one = if matches!(event.payload, Payload::Reference { .. }) && partition_holds(hub, &event) {
            hub.counters.reference_already_held.fetch_add(1, Ordering::Relaxed);
            ack(true, None, idr, None)
        } else {
            ingest_event(hub, event, idr, a_received)
        };
        if one["accepted"] != true {
            return one;
        }
        answer = Some(match answer {
            // Several partitions (a reference describing a FUT trading day): the provider waits for the last.
            Some(before) if one["durable_sequence"].is_null() => before,
            _ => one,
        });
    }
    answer.unwrap_or_else(|| ack(false, Some("NO_PARTITION"), idr, None))
}

/// The reference a print or a quote states, taken out of its data: a Shioaji print's 昨收 (close - price_chg) and an
/// index quote's `reference` (`stated_prev_close`), a TXF quote's session reference (close - price_chg,
/// `stated_reference_price` with its `reference_source`). The provider sends it with every event that states it and
/// keeps no memory of what it sent: whether the event's partition already holds it is Market Runtime's to judge
/// (`partition_holds`), since only Market Runtime knows the partition. A print or quote never carries a reference
/// into the WAL: it is written as its own Reference event (D01-02).
pub(crate) fn stated_reference(kind: &str, data: &mut Value) -> Option<Payload> {
    if kind != "trade" && kind != "quote" {
        return None;
    }
    let object = data.as_object_mut()?;
    let prev_close = object.remove("stated_prev_close").and_then(|v| v.as_i64()).filter(|v| *v > 0);
    let reference_price = object.remove("stated_reference_price").and_then(|v| v.as_i64()).filter(|v| *v > 0);
    let reference_source = object.remove("reference_source").and_then(|v| v.as_str().map(str::to_owned));
    (prev_close.is_some() || reference_price.is_some()).then(|| Payload::Reference { limit_up: None, limit_down: None, prev_close,
        prev_volume: None, reference_price, name: None, reference_source: reference_price.and(reference_source) })
}

/// Whether the event's partition already holds every value this reference states (a stated 昨收 / 參考價, or a
/// provider's reference event: limits, 昨收, 昨量, name): then it is not written again. A provider states its
/// references again whenever its process starts; only Market Runtime knows the partition already holds them.
fn partition_holds(hub: &Hub, reference: &MarketEvent) -> bool {
    let Payload::Reference { limit_up, limit_down, prev_close, prev_volume, reference_price, name, reference_source } = &reference.payload
        else { return false };
    let core = lock(&hub.core);
    let Some(state) = core.engine.state(&reference.state_key()) else { return false };
    let held = &state.reference;
    limit_up.is_none_or(|v| held.limit_up == Some(v))
        && limit_down.is_none_or(|v| held.limit_down == Some(v))
        && prev_close.is_none_or(|v| held.prev_close == Some(v))
        && reference_price.is_none_or(|v| held.reference_price == Some(v))
        && prev_volume.is_none_or(|v| held.prev_volume == Some(v))
        && name.as_ref().is_none_or(|v| held.name.as_ref() == Some(v))
        && reference_source.as_ref().is_none_or(|v| held.reference_source.as_ref() == Some(v))
}

/// A counter of a refusal reason, chosen where the refusal is decided.
type RefusalCounter = fn(&Counters) -> &std::sync::atomic::AtomicU64;

/// The partitions (trading date, session, partition minute) an ingested event is written to, named by Market Runtime.
///
/// An event with the exchange's time goes to the one partition that time names (event::wal_partition). A reference
/// read from the broker carries the time it was read (backend_clock), which names no partition: it states the
/// trading day it describes (`describes_trading_date`) and is written to every partition of that day by the session
/// contract -- a shioaji FUT day's NIGHT (opened on the previous trading day) and DAY, a stock or index day's DAY, a
/// Futu day's FULL. Only such a reference may name a day; any other event that does is refused.
fn partitions_of(hub: &Hub, env: &Envelope) -> Result<Vec<(String, &'static str, i32)>, (String, RefusalCounter)> {
    let read_time = env.time_quality == "backend_clock";
    match (&env.describes_trading_date, read_time && env.event_type == "reference") {
        (None, false) if env.time_quality.is_empty() || env.time_quality == "exchange" => {
            crate::event::wal_partition(&env.source, &env.market, env.exchange_ts_ns).map(|p| vec![p])
                .ok_or_else(|| ("MISSING_EXCHANGE_TIME".to_owned(), (|c: &Counters| &c.rejected_missing_time) as RefusalCounter))
        }
        (None, _) => Err(("NO_EXCHANGE_TIME: an event without the exchange's time names no partition; a reference read from \
            the broker states describes_trading_date".to_owned(), |c: &Counters| &c.rejected_missing_time)),
        (Some(_), false) => Err(("DESCRIBED_DATE_NOT_ALLOWED: only a reference read from the broker (backend_clock) names the \
            trading day it describes".to_owned(), |c: &Counters| &c.rejected_parse)),
        (Some(date), true) => {
            if crate::event::parse_calendar_date(date).is_none() {
                return Err(("INVALID_TRADING_DATE".to_owned(), |c: &Counters| &c.rejected_parse));
            }
            described_partitions(&hub.calendar(), &env.source, &env.market, date)
                .ok_or_else(|| ("NOT_A_BUSINESS_SESSION".to_owned(), (|c: &Counters| &c.rejected_no_session) as RefusalCounter))
        }
    }
}

/// The partitions of the trading day `date` of a market, by the session contract (see `partitions_of`); None when
/// a Shioaji market does not trade that day. A reference event carries no minute: each is 0.
pub(crate) fn described_partitions(calendar: &rollover::TradingCalendar, source: &str, market: &str, date: &str)
                                   -> Option<Vec<(String, &'static str, i32)>> {
    match crate::event::single_session(source, market) {
        None => {
            if !calendar.is_trading_day(date) {
                return None;
            }
            let opened = calendar.previous_trading_day(date)?;
            Some(vec![(opened, "NIGHT", 0), (date.to_owned(), "DAY", 0)])
        }
        Some(session) => {
            if source.eq_ignore_ascii_case("shioaji") && !calendar.is_trading_day(date) {
                return None;
            }
            Some(vec![(date.to_owned(), session, 0)])
        }
    }
}

/// One event, its partition named, through admission, the live state and the WAL.
fn ingest_event(hub: &Arc<Hub>, mut event: MarketEvent, idr: (&str, u64, u64), a_received: u64) -> Value {
    // An event of an older layout (a calendar-day FUT partition) is refused, never re-keyed.
    if let Some(refused) = event.refusal() {
        hub.counters.rejected_old_format.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some(&refused.to_string()), idr, None);
    }
    // A Shioaji day-session event dated to a day the exchange did not trade belongs to no session
    // (weekend reconnect snapshots were admitted as Saturday STK / IDX sessions nothing ever sealed). Providers
    // refuse it first; the WAL owner never writes one. A NIGHT session is dated by the day it opened.
    if event.provider == "shioaji" && event.session != "NIGHT" && !hub.calendar().is_trading_day(&event.trading_date) {
        hub.counters.rejected_no_session.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some("NOT_A_BUSINESS_SESSION"), idr, None);
    }
    // Before anything that may not store it: the 試撮 that open a day are never written.
    observe_opening(hub, &event);
    let scope_level = event.code == CLOCK_CODE;
    // A never-stored market and 盤前試撮 are never written whatever the list says: no WAL slot is taken for them.
    if !scope_level && (rollover::never_stored(&event.provider, &event.market) || event.is_preopen_indicative()) {
        let core = lock(&hub.core);
        let storage = core.storage.classify(&event);
        return ingest_live(hub, core, event, storage, idr, a_received);
    }
    // Fetched for a view of a closed session (restart_backfill.py closed_view): shown and folded by B over the live
    // lane, before the gate below, which keeps a sealed session's records final.
    if !scope_level && event.flags.view_only {
        return ingest_live(hub, lock(&hub.core), event, Storage::Unlisted, idr, a_received);
    }
    let mut next = lock(&hub.lane.sequencer);
    let wal = hub.wal();
    if !wal.reserve() {
        drop(next);
        if let Some(reason) = wal.failed() {
            hub.counters.rejected_wal_failed.fetch_add(1, Ordering::Relaxed);
            if !scope_level {
                lock(&hub.core).evidence.rejected(&event.clock_scope(), "WAL_FAILED");
            }
            return ack(false, Some(&format!("WAL_FAILED: {reason}")), idr, None);
        }
        hub.counters.rejected_wal_full.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some("WAL_QUEUE_FULL: retry"), idr, None);
    }
    event.durable_sequence = *next;
    let waited = Instant::now();
    hub.lane.waiting.fetch_add(1, Ordering::AcqRel);
    let mut core = lock(&hub.core);
    hub.lane.waiting.fetch_sub(1, Ordering::AcqRel);
    hub.counters.ingest_core_wait_max_us.fetch_max(waited.elapsed().as_micros() as u64, Ordering::Relaxed);
    // A session its owner sealed is final: an event of it is refused, never written to the WAL nor sent to B, and
    // makes no record (evidence::Ledger::is_closed) -- a broker re-sending its last print on a new subscription would
    // otherwise reopen a pruned session, which its owner then sealed and materialized again from a WAL cut since.
    if !scope_level && core.evidence.is_closed(&event.clock_scope()) {
        let first = core.evidence.note_refused(event.clock_scope());
        drop(core);
        wal.release();
        drop(next);
        hub.counters.rejected_closed_partition.fetch_add(1, Ordering::Relaxed);
        if first {
            // not an error: a late or re-sent event of a finished session; counted in metrics, said once per partition
            eprintln!("[market_runtime] events of the closed session {}|{}|{}|{} refused (PARTITION_CLOSED)", event.provider,
                event.market, event.trading_date, event.session);
        }
        return ack(false, Some("PARTITION_CLOSED"), idr, None);
    }
    // Whether it is stored is read under `core`, the lock the background list's storage policy is replaced under
    // (install_background): every event is classified by one applied revision, in the order events are applied and
    // sequenced -- never by a list half replaced.
    if !scope_level {
        let storage = core.storage.classify(&event);
        if storage != Storage::Durable {
            wal.release();
            drop(next);
            return ingest_live(hub, core, event, storage, idr, a_received);
        }
    }
    let repeat = if scope_level { PrintRepeat::New } else { core.engine.print_repeat(&event) };
    if repeat == PrintRepeat::Resent {
        event.durable_sequence = 0;   // never written: it takes no durable sequence
    } else if !scope_level {
        core.engine.classify_print(&mut event);
    }
    let had_print = scope_level || core.engine.holds_print(&event);
    let (verdict, changed) = if scope_level { (ApplyResult::Control, Changed::default()) } else { core.engine.apply(&event) };
    if matches!(verdict, ApplyResult::RejectedGeneration | ApplyResult::RejectedSequence) {
        core.evidence.rejected(&event.clock_scope(), &format!("{verdict:?}"));
        drop(core);
        wal.release();
        drop(next);
        hub.counters.rejected_validation.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some(&format!("{verdict:?}")), idr, None);
    }
    if repeat == PrintRepeat::Resent {
        count_resent(hub, &event);
        if changed.any() {
            publish_state_deltas(hub, &mut core, &event, changed);
        }
        // The copy is not written; the loss it states is, in its place (and in its WAL slot): B and the history
        // must see the gap as they would on a stored print.
        if event.flags.gap_before == 0 {
            wal.release();
            drop(next);
            return ack(true, Some("RESENT_PRINT"), idr, None);
        }
        let mut record = loss_record(&event);
        record.durable_sequence = *next;
        *next += 1;
        let sequence = record.durable_sequence;
        core.evidence.fold(&record, true);
        wal.submit(record);
        drop(next);
        hub.counters.loss_records.fetch_add(1, Ordering::Relaxed);
        drop(core);
        return ack(true, Some("RESENT_PRINT"), idr, Some(sequence));
    }
    if repeat == PrintRepeat::TotalNotAdvanced {
        hub.counters.total_not_advanced.fetch_add(1, Ordering::Relaxed);
    }
    *next += 1;
    let sequence = event.durable_sequence;
    if !scope_level {
        core.evidence.fold(&event, true);
        // After the fold: the partition's first event makes its record, where a late join is kept.
        note_first_print(&mut core, &event, had_print);
    }
    wal.submit(event.clone());
    drop(next);
    hub.counters.accepted.fetch_add(1, Ordering::Relaxed);
    lock(&hub.latency).on_accept(&event.symbol, event.latency_exchange_ns(), event.arrival_ns, a_received);
    if !scope_level && changed.any() {
        publish_state_deltas(hub, &mut core, &event, changed);
    }
    drop(core);
    touch_clock_scope(hub, &event);
    ack(true, None, idr, Some(sequence))
}

/// An event that is not written (its Storage, decided under `core`): applied to the live state and pushed to viewers,
/// with no durable sequence.
///
/// 盤前試撮 (試撮價, the flagged tape row, the auction book) is never written and never reaches B: history, the Data
/// Center and B never see it, and a restart forgets it. Intraday and closing auctions take the normal durable path.
///
/// A market that is never stored (Futu crypto, user rule) and a stock not on the background list (a searched stock,
/// a workspace instrument) go to B over the live lane (`live.batch`) instead of the durable stream, named as such:
/// B still computes their trend, flow and signals, and keeps them out of everything it writes. An unlisted stock's
/// events are applied as live-only (Engine::apply_live_only): A's checkpoint keeps only the partition's stored fold.
/// A Shioaji print of a session whose pre-open has come opens that session (rollover::Opened::observe); the rollover
/// loop rolls its families and writes the sessions file within a second.
fn observe_opening(hub: &Hub, event: &MarketEvent) {
    let Some(group) = rollover::OpeningGroup::of(&event.provider, &event.market, &event.session, &event.code) else { return };
    let Some(exchange_ns) = event.latency_exchange_ns() else { return };
    let mut state = lock(&hub.sessions);
    if event.trading_date.as_str() <= state.sessions.opened.get(group) {
        return;
    }
    if state.sessions.opened.observe(&hub.calendar(), group, &event.trading_date, exchange_ns, now_ns() as i64) {
        state.dirty = true;
    }
}

pub(crate) fn ingest_live(hub: &Arc<Hub>, mut core: MutexGuard<'_, Core>, mut event: MarketEvent, storage: Storage, idr: (&str, u64, u64),
                          a_received: u64) -> Value {
    event.durable_sequence = 0;
    let repeat = core.engine.print_repeat(&event);
    if repeat != PrintRepeat::Resent {
        core.engine.classify_print(&mut event);
    }
    let had_print = core.engine.holds_print(&event);
    let (verdict, changed) = if storage == Storage::Unlisted { core.engine.apply_live_only(&event) } else { core.engine.apply(&event) };
    if matches!(verdict, ApplyResult::RejectedGeneration | ApplyResult::RejectedSequence) {
        drop(core);
        hub.counters.rejected_validation.fetch_add(1, Ordering::Relaxed);
        return ack(false, Some(&format!("{verdict:?}")), idr, None);
    }
    note_first_print(&mut core, &event, had_print);
    // To B over the live lane: what it would have read from the WAL were it stored. 試撮 never reaches B, stored
    // instrument or not.
    let to_b = storage.live_lane().filter(|_| !event.is_preopen_indicative());
    if repeat == PrintRepeat::Resent {
        count_resent(hub, &event);
        if changed.any() {
            publish_state_deltas(hub, &mut core, &event, changed);
        }
        if let Some(lane) = to_b.filter(|_| event.flags.gap_before > 0) {
            send_live_to_b(hub, &loss_record(&event), lane, core.storage.revision);
            hub.counters.loss_records.fetch_add(1, Ordering::Relaxed);
        }
        return ack(true, Some("RESENT_PRINT"), idr, None);
    }
    if repeat == PrintRepeat::TotalNotAdvanced {
        hub.counters.total_not_advanced.fetch_add(1, Ordering::Relaxed);
    }
    hub.counters.accepted.fetch_add(1, Ordering::Relaxed);
    match storage {
        Storage::NeverStored => &hub.counters.unstored_live_only,
        Storage::Unlisted => &hub.counters.unlisted_live_only,
        Storage::Indicative | Storage::Durable => &hub.counters.indicative_live_only,
    }.fetch_add(1, Ordering::Relaxed);
    lock(&hub.latency).on_accept(&event.symbol, event.latency_exchange_ns(), event.arrival_ns, a_received);
    if changed.any() {
        publish_state_deltas(hub, &mut core, &event, changed);
    }
    // An unlisted instrument's prints are on no WAL: A holds its tape for the trade pages.
    if storage == Storage::Unlisted && verdict == ApplyResult::Applied {
        let key = crate::trade_pages::TradeKey::of(&event);
        core.live_tapes.note(&event, hub.committed(), || hub.wal().shared.trades.lock().unwrap().quote_trades(&key));
    }
    // Still under `core`: the live lane carries events in the order they were applied.
    if let Some(lane) = to_b.filter(|_| verdict == ApplyResult::Applied) {
        send_live_to_b(hub, &event, lane, core.storage.revision);
    }
    drop(core);
    touch_clock_scope(hub, &event);
    ack(true, None, idr, None)
}

/// The code's first print in its partition (it held none before `event`): judged for a late join, whose gap from the
/// open goes back to its provider with the batch's answer (late_join.rs). A stored code's and an unlisted one's alike.
/// Every print also ends the broker-outage gap of its code waiting for it (outage_gap.rs).
fn note_first_print(core: &mut Core, event: &MarketEvent, had_print: bool) {
    let watching = core.outage_gaps.watching();
    if (had_print && !watching) || !core.engine.holds_print(event) {
        return;
    }
    let Some(first) = crate::late_join::FirstPrint::of(event) else { return };
    if watching {
        core.outage_gaps.print(&event.instrument(), &first);
    }
    if had_print {
        return;
    }
    let Core { late_joins, evidence, .. } = core;
    late_joins.first_print(event.instrument(), first, evidence);
}

fn count_resent(hub: &Hub, event: &MarketEvent) {
    hub.counters.dropped_resent_print.fetch_add(1, Ordering::Relaxed);
    hub.counters.dropped_resent_print_gap_before.fetch_add(event.flags.gap_before, Ordering::Relaxed);
}

/// The loss a re-sent print states (`flags.gap_before`), as Market Runtime's own record in the copy's place: the copy
/// is never stored, the events the source dropped before it must still be seen as missing (event::LOSS_CONTROL).
pub(crate) fn loss_record(event: &MarketEvent) -> MarketEvent {
    let origin = if event.event_id.is_empty() { format!("{}:{}:{}", event.symbol, event.generation, event.sequence) } else { event.event_id.clone() };
    MarketEvent {
        event_id: format!("loss:{origin}"), durable_sequence: 0, time_quality: LOSS_CONTROL.into(),
        flags: EventFlags { gap_before: event.flags.gap_before, ..EventFlags::default() },
        payload: Payload::SourceStatus { state: SOURCE_GAP.into(), detail: "re-sent print, not stored".into() },
        ..event.clone()
    }
}

/// Apply a background list: validated whole by DemandManager, and its storage policy swapped in under `core` in the
/// same step -- the lock every ingest classifies under -- so no event is stored or dropped by a list half applied
/// (Codex 1020-R04-02). Lock order: `lane.sequencer`, `core`, then `demand`. The new plan goes out after all are released.
pub(crate) fn install_background(hub: &Hub, list: BackgroundList) -> Result<(), String> {
    {
        let mut next = lock(&hub.lane.sequencer);
        let mut core = lock(&hub.core);
        let mut demand = lock(&hub.demand);
        demand.replace_background(list)?;
        core.storage = demand.storage_policy();
        drop(demand);
        store_held_references(hub, &mut core, &mut next);
    }
    replan(hub);
    Ok(())
}

/// A stock just put on the background list has its day's reference (limits, 昨收, name) only in the live state: its
/// provider stated it once while it was unlisted and will not again, so Market Runtime, whose partition it is, writes
/// it. From the WAL it reaches B's paper desk and the partition's history. A partition already closed stays as it is.
fn store_held_references(hub: &Hub, core: &mut Core, next: &mut u64) {
    let now = now_ns();
    for held in core.engine.references_not_stored() {
        let instrument = &held.key.instrument;
        let reference = held.reference;
        let mut event = MarketEvent {
            schema_version: EVENT_SCHEMA_VERSION, event_id: format!("held-reference:{}:{}:{}:{}", instrument.wire(), held.key.session.trading_date,
                held.key.session.session, *next),
            durable_sequence: 0, symbol: instrument.wire(), provider: instrument.source.clone(), market: instrument.market.clone(),
            code: instrument.code.clone(), session: held.key.session.session.clone(), trading_date: held.key.session.trading_date.clone(),
            generation: held.generation, sequence: held.sequence, exchange_ts_ns: now as i64, arrival_ns: now, a_received_ns: now,
            runtime_epoch: hub.runtime_epoch, time_quality: "backend_clock".into(), trace_id: String::new(), flags: EventFlags::default(),
            versions: BTreeMap::new(),
            payload: Payload::Reference { limit_up: reference.limit_up, limit_down: reference.limit_down, prev_close: reference.prev_close,
                prev_volume: reference.prev_volume, reference_price: reference.reference_price, name: reference.name,
                reference_source: reference.reference_source },
        };
        if core.storage.classify(&event) != Storage::Durable || core.evidence.is_closed(&event.clock_scope()) {
            continue;
        }
        let wal = hub.wal();
        if !wal.reserve() {
            let reason = wal.failed().map_or_else(|| "WAL_QUEUE_FULL".to_owned(), |reason| format!("WAL_FAILED: {reason}"));
            eprintln!("[market_runtime] the reference of {} ({}) was not written on its listing: {reason}", event.symbol, event.trading_date);
            core.evidence.rejected(&event.clock_scope(), &reason);
            continue;
        }
        event.durable_sequence = *next;
        *next += 1;
        let changed = core.engine.apply_held_reference(&event);
        core.evidence.fold(&event, true);
        wal.submit(event.clone());
        if changed.any() {
            publish_state_deltas(hub, core, &event, changed);
        }
    }
}

/// The live lane to B: an event that is never stored, handed over as it is applied (no durable sequence, so B neither
/// moves its cursor nor can re-read it; a restart of either side starts it from their checkpoints). `storage` names
/// why it is not stored (Storage::live_lane: `unlisted` or `never_stored`), and `storage_revision` the background
/// revision that decided it: B keeps what it computes from an unlisted stock out of everything it writes.
///
/// Each message carries `live_sequence` (+ the runtime epoch): a message dropped on B's full queue cannot be re-read,
/// so B marks the affected instruments as having a gap instead of claiming them complete.
pub(crate) fn send_live_to_b(hub: &Hub, event: &MarketEvent, storage: &str, storage_revision: Option<u64>) {
    let mut sequence = lock(&hub.lane.live_sequence);
    *sequence += 1;
    let sequence_now = *sequence;
    let bytes = Arc::new(json!({"type": "live.batch", "payload": {"runtime_epoch": hub.runtime_epoch, "live_sequence": sequence_now,
        "storage": storage, "storage_revision": storage_revision, "events": [event]}}).to_string().into_bytes());
    broadcast_role(hub, |c| c.role == Role::AnalysisRuntime, Outgoing { kind: OutKind::Adapter, bytes, trace: None });
    drop(sequence);
}

pub(crate) type Frame = (u64, &'static str, &'static [&'static str], Value, Map<String, Value>, Option<(u64, u64, u64)>);

/// The one delta an applied event produces for its state (live and replay alike).
pub(crate) fn state_frame(state: &SymbolState, entry: Option<&ProjectionEntry>, breadth: Option<&Value>, event: &MarketEvent, changed: &Changed,
               trace: Option<(u64, u64, u64)>) -> Option<Frame> {
    let mut extra = Map::new();
    extra.insert("channel_arrival_us".into(), wire::arrivals(state));
    extra.insert("durable_sequence".into(), json!(event.durable_sequence));
    let summary = wire::summary(state, breadth);
    if changed.trade {
        let trade = wire::applied_trade(state);
        let point = wire::current_point(state, entry);
        Some((state.generation, "trade.frame", &["summary", "trend", "trades"][..],
            json!({"summary": summary, "trade": trade, "trend": {"point": point}}), extra, trace))
    } else if changed.quote {
        let point = wire::current_point(state, entry);
        Some((state.generation, "quote.frame", &["summary", "trend"][..], json!({"summary": summary, "trend": {"point": point}}), extra, trace))
    } else if changed.book {
        Some((state.generation, "orderbook.latest", &["orderbook"][..], wire::book(&state.book), extra, trace))
    } else if changed.reference {
        Some((state.generation, "summary.updated", &["summary"][..], summary, extra, trace))
    } else {
        None
    }
}

/// One delta per applied event. Runs on the ingest path under `core`, so it BORROWS the symbol state: cloning
/// the whole state (up to hot_capacity trades, each with owned strings) for every event made A spend
/// ~5 ms per event and cap ingest near 270 events/s in the 4-hour load test. The JSON is built only
/// when a viewer watches the instrument; the view sequence still advances either way (snapshot cut consistency).
pub(crate) fn publish_state_deltas(hub: &Hub, core: &mut Core, event: &MarketEvent, changed: Changed) {
    let key = event.state_key();
    let watched = has_watchers(hub, &key.instrument);
    let index = wire::breadth_index();
    let (frame, index_frame): (Option<Frame>, Option<(StateKey, u64, Value)>) = {
        let Core { engine, breadth, projection, .. } = &mut *core;
        let Some(state) = engine.state(&key) else { return };
        let breadth_changed = breadth.observe(state);
        let frame = if watched {
            let breadth_value = breadth.wire();
            // The exchange time rides along (only an event's own, never a quote's or bar's label) so A can measure
            // exchange -> screen per source.
            let exchange_us = event.latency_exchange_ns().map_or(0, |ns| ns as u64 / 1000);
            let trace = Some((event.arrival_ns / 1000, event.a_received_ns / 1000, exchange_us));
            state_frame(state, projection.entry(&key), Some(&breadth_value), event, &changed, trace)
        } else {
            None
        };
        // The index view carries the one combined breadth figure.
        let index_frame = if breadth_changed && has_watchers(hub, &index) {
            engine.current_session(&index).map(|s| StateKey { instrument: index.clone(), session: s.clone() })
                .filter(|index_key| *index_key != key)
                .and_then(|index_key| engine.state(&index_key).map(|index_state| {
                    let s = wire::summary(index_state, Some(&breadth.wire()));
                    (index_key.clone(), index_state.generation, s)
                }))
        } else {
            None
        };
        (frame, index_frame)
    };
    match frame {
        Some((generation, delta_type, channels, payload, extra, trace)) =>
            emit_delta(hub, core, &key, generation, delta_type, channels, payload, extra, trace),
        None if changed.any() => bump_view_seq(core, &key),
        None => {}
    }
    if let Some((index_key, generation, summary)) = index_frame {
        emit_delta(hub, core, &index_key, generation, "summary.updated", &["summary"], summary, Map::new(), None);
    }
}

pub(crate) fn bump_view_seq(core: &mut Core, key: &StateKey) {
    *core.view_seq.entry(key.clone()).or_insert(0) += 1;
}

pub(crate) fn touch_clock_scope(hub: &Hub, event: &MarketEvent) {
    if event.market.is_empty() || event.trading_date.is_empty() {
        return;
    }
    let scope = event.clock_scope();
    let mut scopes = lock(&hub.clock_scopes);
    // A newly seen scope gets its first Clock on the next tick (not only at the next minute boundary): after the
    // close, or for a scope that starts mid-minute, B must not wait up to a minute to finalize what is already past.
    // The clock itself is still lagged, so this never finalizes a minute that can still receive on-time prints.
    let entry = scopes.entry(scope).or_insert(ScopeClock { last_minute: i32::MIN, last_activity: Instant::now(), market_ns: 0, market_at: Instant::now() });
    entry.last_activity = Instant::now();
    // Only prints and quotes carry the exchange's own trade time; a book or status may be stamped on arrival, and
    // one such event would pull an exchange clock back to the wall clock.
    let traded = matches!(event.payload, Payload::Trade { .. } | Payload::Quote { .. } | Payload::MinuteBar { .. });
    if traded && event.time_quality == "exchange" && event.exchange_ts_ns > entry.market_ns {
        entry.market_ns = event.exchange_ts_ns;
        entry.market_at = Instant::now();
    }
}

/// Market clock: when the exchange-local wall-clock minute of an active scope advances, write a Clock event so
/// Rust B can close no-trade minutes identically live and on replay.
/// The clock minute of a calendar-date scope (one partition per local day) at the lagged time, or None while the
/// scope's day has not begun. A scope can exist before its own midnight: a print at 00:00:00 opens the 10-01 scope
/// while the lagged time is still 09-30 23:59, and Futu stamps a minute bar with the minute's end, so its "00:00"
/// bar opens the 10-16 scope at 23:59 on 10-15. Sent as `1439` for the new scope, that minute finalized the whole new
/// day as no-trade (a flat line to 23:59 on every US chart). Only that midnight straddle -- the lagged day is the
/// day right before the scope's -- is skipped: a recorded feed may carry a trading date unrelated to its
/// timestamps, and its clock must keep running.
pub(crate) fn calendar_scope_clock_minute(market: &str, trading_date: &str, lagged_ns: i64) -> Option<i32> {
    let (date, minute) = market_local_minute(market, lagged_ns)?;
    (crate::event::checked_shift_date(&date, 1).as_deref() != Some(trading_date)).then_some(minute)
}

pub(crate) fn clock_loop(hub: Arc<Hub>) {
    let mut sequences: HashMap<ClockScope, u64> = HashMap::new();
    while hub.lifecycle.running.load(Ordering::Acquire) {
        thread::sleep(hub.config.clock_interval);
        if hub.lifecycle.draining.load(Ordering::Acquire) {
            continue;
        }
        let market_clock = hub.config.clock;
        let lag = hub.config.clock_lag.as_nanos() as i64;
        let due: Vec<(ClockScope, i32, i64)> = {
            let mut scopes = lock(&hub.clock_scopes);
            scopes.retain(|_, s| s.last_activity.elapsed() < SCOPE_IDLE);
            scopes.iter_mut().filter_map(|(scope, clock)| {
                let now = clock.now_ns(market_clock);
                let minute = if is_session_partitioned(&scope.source, &scope.market) {
                    // A business-session partition (FUT DAY / NIGHT) is clocked only while the lagged time is inside
                    // it: the NIGHT continues past midnight (1440..), the DAY stops at the gap before the night.
                    let (date, session, minute) = futures_partition(now - lag)?;
                    if date != scope.trading_date || !session.eq_ignore_ascii_case(&scope.session) {
                        return None;
                    }
                    minute
                } else {
                    calendar_scope_clock_minute(&scope.market, &scope.trading_date, now - lag)?
                };
                if minute != clock.last_minute {
                    clock.last_minute = minute;
                    Some((scope.clone(), minute, now))
                } else {
                    None
                }
            }).collect()
        };
        for (scope, minute, now) in due {
            let seq = sequences.entry(scope.clone()).or_insert(0);
            *seq += 1;
            let event = MarketEvent {
                schema_version: EVENT_SCHEMA_VERSION, event_id: format!("clock:{}:{}:{}:{}:{}:{}", scope.source, scope.market, scope.trading_date, scope.session, hub.runtime_epoch, seq),
                durable_sequence: 0, symbol: format!("{}:{}:{}", scope.source, scope.market, CLOCK_CODE), provider: scope.source.clone(),
                market: scope.market.clone(), code: CLOCK_CODE.into(), session: scope.session.clone(), trading_date: scope.trading_date.clone(),
                generation: hub.runtime_epoch, sequence: *seq, exchange_ts_ns: now, arrival_ns: now as u64, a_received_ns: now as u64,
                runtime_epoch: hub.runtime_epoch, time_quality: "backend_clock".into(), trace_id: String::new(),
                flags: EventFlags::default(), versions: BTreeMap::new(), payload: Payload::Clock { minute },
            };
            if rollover::never_stored(&event.provider, &event.market) {
                send_live_to_b(&hub, &event, LIVE_NEVER_STORED, None);
                hub.counters.clock_events.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let mut next = lock(&hub.lane.sequencer);
            if !hub.wal().reserve() {
                continue;
            }
            let mut event = event;
            event.durable_sequence = *next;
            *next += 1;
            hub.wal().submit(event);
            hub.counters.clock_events.fetch_add(1, Ordering::Relaxed);
        }
    }
}
