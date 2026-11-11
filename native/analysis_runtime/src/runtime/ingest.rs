//! The durable and live lanes' events into the engine, features and paper desk: decoding, format refusal and gaps.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use market_runtime::event::{MarketEvent, Refused, CLOCK_CODE, EVENT_SCHEMA_VERSION};
use market_runtime::remediation;
use serde_json::{json, Value};
use crate::accum::InstrumentId;
use crate::cursor::Decision;
use crate::features::{Folded, KeyId};
use serde::Deserialize;
use crate::engine::{self, Lane};
use super::{shared::*, inference_runtime::*, stream_runtime::*};

/// What one live.batch did to the lane, for the remediation record.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct LiveBatchOutcome {
    /// Market Runtime's epoch changed (it restarted): every held live family was marked.
    pub(crate) epoch_changed: Option<(u64, u64)>,
    /// live_sequence skipped (last, received): every held live family was marked -- which family the lost message
    /// carried is unknown.
    pub(crate) skipped: Option<(u64, u64)>,
    /// Events that did not decode (or are of a newer schema): their partition was marked, or every live family when
    /// even that was unreadable.
    pub(crate) undecodable: u64,
    /// Events of an older format: refused (counted and recorded), never applied.
    pub(crate) old_format: u64,
    /// The batch repeats one already applied: nothing of it was applied again.
    pub(crate) duplicate: bool,
    /// This run's first batch: (its live_sequence, the never-stored partitions marked for what B missed while down).
    /// A sequence past 1 means the lane carried messages before B joined (engine::Engine::join_live_lane).
    pub(crate) joined: Option<(u64, usize)>,
}

impl LiveBatchOutcome {
    /// The join that lost input to B: the lane carried messages before B's first one (a sequence past 1 -- Market
    /// Runtime was up and sending while B was not). A first sequence of 1 is a lane that started with this run of
    /// Market Runtime: what the never-stored partitions held from the checkpoint miss is the time the whole App was
    /// down, as for every stored partition, not input B failed to take. They are marked either way.
    pub(crate) fn late_join(&self) -> Option<(u64, usize)> {
        self.joined.filter(|(first, _)| *first > 1)
    }
}

/// Validate a whole live.batch (Futu crypto: never stored, so never re-readable) before anything of it is applied.
/// An event that does not decode is lost input of its partition, never dropped silently while the
/// sequence moved on. Returns the events to apply (none for a repeated batch).
///
/// A batch under another Market Runtime epoch than the last one: A restarted, what it sent before is
/// gone from its side and nothing says what was missed in between, so every live partition B holds is marked as a
/// gap. The first batch of this run marks what B missed while it was down, and a late join (`now_ns`, B's clock).
/// `storage`: the batch's `storage` (engine::Lane::live), which says where a lost event's partition is held.
pub(crate) fn receive_live_batch(engine: &mut engine::Engine, lane: &mut (u64, u64), epoch: u64, sequence: u64,
                                 storage: Option<&str>, raws: Vec<Value>, now_ns: i64) -> (Vec<MarketEvent>, LiveBatchOutcome) {
    let mut outcome = LiveBatchOutcome::default();
    let (known_epoch, last) = *lane;
    if known_epoch == epoch && last > 0 && sequence <= last {
        outcome.duplicate = true;
        return (Vec::new(), outcome);
    }
    if known_epoch == 0 && last == 0 {
        outcome.joined = Some((sequence, engine.join_live_lane(sequence > 1, now_ns)));
    }
    let mut events = Vec::with_capacity(raws.len());
    let mut lost: Vec<Option<InstrumentId>> = Vec::new();
    for raw in raws {
        match MarketEvent::decode_value(&raw) {
            Ok(event) => events.push(event),
            Err(Refused::OldFormat(_)) => outcome.old_format += 1,
            Err(Refused::Undecodable(_)) => lost.push(lost_instrument(&raw)),
        }
    }
    // A never-stored market (Futu crypto) is marked whole; in a stored market only the unlisted stocks came over
    // the lane, so only they are (their shown partitions, never the stored folds).
    let mark_all = |engine: &mut engine::Engine| {
        engine.mark_never_stored_gap();
        engine.mark_live_only_gap();
    };
    if known_epoch != 0 && known_epoch != epoch {
        mark_all(engine);
        outcome.epoch_changed = Some((known_epoch, epoch));
    } else if last > 0 && sequence > last + 1 {
        mark_all(engine);
        outcome.skipped = Some((last, sequence));
    }
    for id in &lost {
        match id {
            Some(id) => engine.mark_lost_input(id, Lane::live(storage, &id.source, &id.market)),
            None => mark_all(engine),
        }
    }
    outcome.undecodable = lost.len() as u64;
    *lane = (epoch, sequence);
    (events, outcome)
}

/// One message from Market Runtime on the reading connection.
/// A generic-path durable batch's container: `to_sequence`, the replay flag and the event list, or why it breaks the
/// stream contract. The events themselves are decoded one by one later; this only checks the envelope.
pub(crate) fn durable_batch_container(payload: &mut Value) -> Result<(u64, bool, Vec<Value>), String> {
    let to = payload["to_sequence"].as_u64().ok_or_else(|| "durable.batch without to_sequence".to_string())?;
    let replay = payload["replay"].as_bool().unwrap_or(false);
    match payload.get_mut("events").map(Value::take) {
        Some(Value::Array(events)) => Ok((to, replay, events)),
        Some(other) => Err(format!("durable.batch to {to}: events is {}", if other.is_object() { "an object" } else { "not a list" })),
        None => Err(format!("durable.batch to {to}: events missing")),
    }
}

#[derive(Deserialize)]
pub(crate) struct DurableBatchMessage {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) payload: DurableBatchPayload,
}

/// The typed fast path. `to_sequence` is required here exactly as in `durable_batch_container`: a batch without it
/// does not decode, takes the generic path and is refused there as the contract violation it is -- an optional field
/// let it through, applied, with the cursor moved.
#[derive(Deserialize)]
pub(crate) struct DurableBatchPayload {
    pub(crate) to_sequence: u64,
    #[serde(default)]
    pub(crate) replay: bool,
    pub(crate) events: Vec<MarketEvent>,
}

/// Apply one durable batch in order. Returns the cursor to resubscribe after when a gap was found.
pub(crate) const INCOMPATIBLE: &str = "incompatible";

/// Market Runtime writes events of a newer schema than this build reads (it was upgraded alone): Some(reason).
pub(crate) fn incompatible_schema(subscribed: &Value) -> Option<String> {
    let theirs = subscribed["event_schema_version"].as_u64()?;
    (theirs > EVENT_SCHEMA_VERSION as u64)
        .then(|| format!("{INCOMPATIBLE}: Market Runtime writes event schema {theirs}, this build reads up to {EVENT_SCHEMA_VERSION}"))
}

/// A durable event this build cannot apply. An undecodable one is counted and its instrument (when readable) marked
/// as having lost input -- the cursor still moves past it, but the state no longer reads as complete. One of an older
/// format belongs to no current partition: it is counted and logged as refused, nothing is marked.
pub(crate) struct Undecodable {
    pub(crate) sequence: Option<u64>,
    pub(crate) old_format: bool,
    pub(crate) error: String,
    pub(crate) instrument: Option<InstrumentId>,
}

/// The instrument partition a record that did not decode names, read from its identity fields alone. None when
/// they are not all there (or it is a clock).
pub(crate) fn lost_instrument(raw: &Value) -> Option<InstrumentId> {
    let text = |field: &str| raw.get(field).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let key = market_runtime::event::InstrumentKey::new(text("provider")?, text("market")?, text("code")?);
    if key.code == CLOCK_CODE {
        return None;
    }
    Some(InstrumentId { source: key.source, market: key.market, code: key.code, trading_date: text("trading_date")?.to_string(),
        session: text("session")?.to_uppercase() })
}

/// One refused older-format record: counted, and logged (the first, then every 10,000th: an old WAL holds millions).
pub(crate) fn refuse_old_format(shared: &Shared, sequence: Option<u64>, reason: &str) {
    let n = shared.counters.old_format_events.fetch_add(1, Ordering::Relaxed) + 1;
    if n == 1 || n % 10_000 == 0 {
        eprintln!("[analysis_runtime] refused older-format event {sequence:?}: {reason} ({n} refused by this process)");
    }
}

/// One event into the engine, the feature fold and the paper desk, by how Market Runtime keeps it (`lane`): an
/// unlisted stock's into the shown overlays only (engine::LiveOverlay), never into the paper desk or the capture.
pub(crate) fn apply_event(shared: &Shared, local: &mut Local, event: &MarketEvent, lane: Lane, touched: &mut Vec<KeyId>) {
    let rolled = local.engine.is_rolled_event(event);
    if lane == Lane::Unlisted {
        local.engine.apply_live_only(event);
    } else {
        local.engine.apply(event);
    }
    if lane == Lane::Durable {
        local.paper.apply(event, event.durable_sequence);
    }
    if !rolled && event.code != CLOCK_CODE {
        let (folded, retired) = if lane == Lane::Unlisted { (local.features.fold_live_only(event), Vec::new()) } else { local.features.fold(event) };
        if let Folded::Changed(key) = &folded {
            if lane != Lane::Unlisted {
                capture_sample(shared, &local.features, key, event.durable_sequence);
            }
        }
        if !retired.is_empty() {
            let gone: HashSet<KeyId> = retired.into_iter().collect();
            shared.queue.retain(|task| !gone.contains(&task.key));
            touched.retain(|k| !gone.contains(k));
        }
        if let Folded::Changed(key) = folded {
            if !touched.contains(&key) {
                touched.push(key);
            }
        }
    }
}

/// The live lane (a never-stored market, an unlisted stock): applied in arrival order, the durable cursor untouched,
/// each event by the lane its batch's `storage` names (engine::Lane::live). The events are receive_live_batch's:
/// decoded, normalized and of a schema this build reads.
pub(crate) fn apply_live_batch(shared: &Shared, local: &mut Local, storage: Option<&str>, events: impl Iterator<Item = MarketEvent>) {
    let mut touched: Vec<KeyId> = Vec::new();
    for event in events {
        let lane = Lane::live(storage, &event.provider, &event.market);
        apply_event(shared, local, &event, lane, &mut touched);
    }
    for key in &touched {
        schedule(shared, &local.features, key);
    }
}

pub(crate) fn apply_durable_batch(shared: &Shared, local: &mut Local, to: Option<u64>, replay: bool,
                       events: impl Iterator<Item = Result<MarketEvent, Undecodable>>) -> Option<u64> {
    local.cursor.saw_head(to);
    // 模擬下單: the commands before the batch, so a rebuild enters each at its recorded position inside the batch.
    local.paper.poll_commands(local.cursor.cursor);
    let mut touched: Vec<KeyId> = Vec::new();
    let mut resubscribe = None;
    for decoded in events {
        let decoded = decoded.and_then(|event| {
            // The typed fast path decoded without the checks decode_value applies: an older format, or a newer writer
            // whose fields this build does not know, is refused here.
            match event.refusal() {
                None => Ok(event),
                Some(refused) => Err(Undecodable { sequence: Some(event.durable_sequence), old_format: refused.is_old_format(),
                    instrument: Some(InstrumentId::of(&event)), error: refused.to_string() }),
            }
        });
        let (sequence, event, lost) = match decoded {
            Ok(event) => (Some(event.durable_sequence), Some(event), None),
            Err(u) if u.old_format => {
                refuse_old_format(shared, u.sequence, &u.error);
                (u.sequence, None, None)
            }
            Err(u) => {
                eprintln!("[analysis_runtime] undecodable event {:?}: {}", u.sequence, u.error);
                (u.sequence, None, Some(u.instrument))
            }
        };
        match local.cursor.classify(sequence, replay) {
            Decision::Duplicate => continue,
            Decision::Gap { after } => {
                // A live delivery hole: Market Runtime reads the range from its WAL or declares it.
                remediation::emit(remediation::Emit { component: "durable_cursor", mechanism_id: "analysis.durable_hole",
                    trigger_reason: "live_sequence_gap", identity: remediation::Identity::default(), attempt: None, outcome: "succeeded",
                    detail: json!({"expected": after + 1, "received": sequence, "action": "resubscribe", "after_sequence": after})});
                resubscribe = Some(after);
                break;
            }
            Decision::Undeclared { from, through } => {
                // A replay jump Market Runtime did not declare: whatever it held is lost input for every instrument.
                local.engine.mark_durable_gap();
                local.paper.on_durable_gap(through, now_ns());
                remediation::emit(remediation::Emit { component: "durable_cursor", mechanism_id: "analysis.durable_hole",
                    trigger_reason: "undeclared_replay_gap", identity: remediation::Identity::default(), attempt: None, outcome: "failed",
                    detail: json!({"from_sequence": from, "through_sequence": through, "events": through + 1 - from})});
            }
            Decision::Apply => {}
        }
        if let Some(instrument) = lost {
            shared.counters.undecodable_events.fetch_add(1, Ordering::Relaxed);
            match instrument {
                Some(id) => local.engine.mark_lost_input(&id, Lane::Durable),
                // Not even its partition is readable: every held instrument may have lost it.
                None => local.engine.mark_durable_gap(),
            }
        }
        if let Some(event) = event {
            if !local.voided.is_empty() && local.voided.covers(&event) {
                // not an error: an event the user decided is void (market_runtime voided.rs), stored as it came and
                // left out of the fold; the cursor passes it. Counted in the status and logged.
                shared.counters.voided_events.fetch_add(1, Ordering::Relaxed);
                eprintln!("[analysis_runtime] void event {} ({} {} {}) left out", event.durable_sequence, event.symbol,
                          event.trading_date, event.session);
            } else {
                apply_event(shared, local, &event, Lane::Durable, &mut touched);
            }
        }
        local.cursor.applied(sequence.unwrap_or(0));
    }
    flush_capture(shared);
    if !replay || local.cursor.lag() <= CATCH_UP_LAG {
        for key in &touched {
            schedule(shared, &local.features, key);
        }
    }
    if local.cursor.head <= local.cursor.cursor {
        local.replaying = false;
    }
    resubscribe
}
