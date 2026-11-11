//! The projection outbox: what B has sent to Market Runtime and not yet seen acknowledged.
//!
//! `Engine::collect` clears a block's dirty marks when it builds the item, so an item that was sent and then lost (the
//! connection dropped before the ack) or refused for a reason that passes (input beyond what A has committed) would
//! be gone for good. Each `projection.publish` therefore carries a
//! request id and the outbox keeps, per request, which (instrument, block, records) it carried:
//!
//! - an ack result `ok` (accepted or duplicate) commits the item;
//! - a refusal marked `retry`, or no result at all, marks the block dirty again so the next publish sends it;
//! - a refusal is otherwise acted on by its `code`: `STALE` / `ROLLED_OVER` are obsolete there and dropped;
//!   `EPOCH_BEHIND` moves B's epoch above A's (`held_epoch`); every other code -- or none -- is a contract refusal:
//!   the item stays dirty (it is not dropped as if it were obsolete) and B is incompatible with this Market Runtime;
//! - a lost connection marks everything still in flight dirty again, and the next connection carries on from there
//!   instead of republishing the whole projection.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::accum::InstrumentId;
use crate::engine::Engine;

/// One sent item: enough to mark exactly its records dirty again.
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub id: InstrumentId,
    pub block: String,
    pub minutes: Vec<i32>,
    pub events: Vec<String>,
    pub replace: bool,
}

impl Pending {
    pub fn of(id: &InstrumentId, item: &Value) -> Self {
        let data = &item["data"];
        Self {
            id: id.clone(),
            block: item["block"].as_str().unwrap_or("").to_string(),
            minutes: data["minutes"].as_array().into_iter().flatten().filter_map(|m| m["minute"].as_i64()).map(|m| m as i32).collect(),
            events: data["events"].as_array().into_iter().flatten().filter_map(|e| e["event_id"].as_str()).map(str::to_string).collect(),
            replace: data["replace"] == true,
        }
    }

    /// Mark this item's block (only its own records) dirty again. False when the instrument is no longer held.
    fn redirty(&self, engine: &mut Engine) -> bool {
        let Some(inst) = engine.shown_mut(&self.id) else { return false };
        match self.block.as_str() {
            "minutes" => inst.projection.dirty.minutes.extend(self.minutes.iter().copied().filter(|m| inst.minutes.contains_key(m))),
            "windows" => inst.projection.dirty.windows = true,
            // An increment's base is unknown once it was not taken: the block goes again whole.
            "day" => {
                inst.projection.dirty.day = true;
                inst.projection.dirty.day_whole = true;
            }
            "flow" => {
                inst.projection.dirty.flow = true;
                inst.projection.dirty.flow_whole = true;
            }
            "events" if self.replace => {
                inst.projection.dirty.events.insert("*".into());
            }
            "events" => inst.projection.dirty.events.extend(self.events.iter().cloned()),
            _ => return false,
        }
        true
    }
}

/// What one ack did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AckOutcome {
    pub committed: u64,
    pub requeued: u64,
    /// Items Market Runtime will never take because they are obsolete there: the session rolled over, or it already
    /// holds a newer watermark/revision of the block. Dropping them loses nothing.
    pub dropped: u64,
    /// Items refused for a contract reason (no identity, an unknown block, a code B does not know): B and Market
    /// Runtime disagree, which never happens in a consistent build. Each is named; the caller makes B incompatible.
    /// The items stay dirty: nothing is dropped as if it were obsolete.
    pub refused: Vec<String>,
    /// Market Runtime holds a newer projection epoch than the one these items carry: nothing of this epoch will be
    /// taken; B has to publish under an epoch above it.
    pub epoch_behind: Option<u64>,
}

/// Market Runtime's refusal codes that say the item is obsolete there: dropping it loses nothing.
const OBSOLETE: &[&str] = &["STALE", "ROLLED_OVER"];

#[derive(Debug, Default)]
pub struct Outbox {
    next: u64,
    inflight: BTreeMap<u64, Vec<Pending>>,
    pub committed: u64,
    pub requeued: u64,
    pub dropped: u64,
    pub last_dropped: Option<String>,
}

impl Outbox {
    /// Register one publish; its request id.
    pub fn register(&mut self, items: Vec<Pending>) -> u64 {
        self.next += 1;
        self.inflight.insert(self.next, items);
        self.next
    }

    pub fn in_flight(&self) -> usize {
        self.inflight.values().map(Vec::len).sum()
    }

    /// Apply one `projection.ack`. An ack without a request id of ours (a replay publish) changes nothing.
    pub fn ack(&mut self, request_id: Option<u64>, results: &[Value], engine: &mut Engine) -> AckOutcome {
        let mut outcome = AckOutcome::default();
        let Some(items) = request_id.and_then(|id| self.inflight.remove(&id)) else { return outcome };
        for (index, pending) in items.iter().enumerate() {
            match results.get(index) {
                Some(r) if r["ok"] == true => outcome.committed += 1,
                Some(r) if r["retry"] != true => {
                    let code = r["code"].as_str().unwrap_or("");
                    let described = format!("{} {}: {} ({})", pending.id.identity(), pending.block,
                                            r["reason"].as_str().unwrap_or("refused"), if code.is_empty() { "no code" } else { code });
                    if OBSOLETE.contains(&code) {
                        outcome.dropped += 1;
                        self.last_dropped = Some(described);
                    } else if let (true, Some(epoch)) = (code == "EPOCH_BEHIND", r["held_epoch"].as_u64()) {
                        outcome.epoch_behind = Some(outcome.epoch_behind.map_or(epoch, |e| e.max(epoch)));
                        self.last_dropped = Some(described);
                    } else {
                        pending.redirty(engine);
                        outcome.refused.push(described);
                    }
                }
                // Refused for now, or never answered (the batch was cut short): send it again.
                _ => {
                    if pending.redirty(engine) {
                        outcome.requeued += 1;
                    }
                }
            }
        }
        self.committed += outcome.committed;
        self.requeued += outcome.requeued;
        self.dropped += outcome.dropped;
        outcome
    }

    /// The connection was lost: everything not acknowledged goes out again on the next one.
    pub fn requeue_all(&mut self, engine: &mut Engine) -> u64 {
        let mut n = 0;
        for (_, items) in std::mem::take(&mut self.inflight) {
            n += items.iter().filter(|p| p.redirty(engine)).count() as u64;
        }
        self.requeued += n;
        n
    }

    /// The projection started over (a reset, a new epoch): nothing in flight is wanted any more.
    pub fn clear(&mut self) {
        self.inflight.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id() -> InstrumentId {
        InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-10-08".into(), session: "DAY".into() }
    }

    fn engine_with_minutes(minutes: &[i32]) -> Engine {
        let mut engine = Engine::new(market_runtime::calendar::Calendar::default(), crate::rules::RuleSet::default());
        let inst = engine.instruments.entry(id()).or_insert_with(|| crate::accum::Instrument::new(id()));
        for m in minutes {
            inst.minutes.entry(*m).or_insert_with(|| std::sync::Arc::new(crate::accum::Minute::new(*m)));
        }
        engine
    }

    fn minutes_item(minutes: &[i32]) -> Value {
        json!({"block": "minutes", "data": {"minutes": minutes.iter().map(|m| json!({"minute": m})).collect::<Vec<_>>(), "replace": false}})
    }

    #[test]
    fn accepted_and_duplicate_items_commit_and_leave_nothing_dirty() {
        let mut engine = engine_with_minutes(&[570, 571]);
        let mut outbox = Outbox::default();
        let rid = outbox.register(vec![Pending::of(&id(), &minutes_item(&[570, 571])), Pending::of(&id(), &json!({"block": "day", "data": {}}))]);
        let out = outbox.ack(Some(rid), &[json!({"ok": true}), json!({"ok": true, "duplicate": true})], &mut engine);
        assert_eq!(out, AckOutcome { committed: 2, ..Default::default() });
        assert!(!engine.instruments[&id()].projection.dirty.any());
        assert_eq!(outbox.in_flight(), 0);
    }

    #[test]
    fn a_retryable_refusal_or_a_missing_result_marks_exactly_its_records_dirty_again() {
        let mut engine = engine_with_minutes(&[570, 571, 572]);
        let mut outbox = Outbox::default();
        let rid = outbox.register(vec![
            Pending::of(&id(), &minutes_item(&[570, 571])),
            Pending::of(&id(), &json!({"block": "events", "data": {"events": [{"event_id": "e1"}], "replace": false}})),
            Pending::of(&id(), &json!({"block": "flow", "data": {}})),
        ]);
        // The flow item got no result (the batch was cut short).
        let out = outbox.ack(Some(rid), &[json!({"ok": false, "reason": "beyond committed", "retry": true}), json!({"ok": false, "retry": true})], &mut engine);
        assert_eq!(out.requeued, 3);
        let dirty = &engine.instruments[&id()].projection.dirty;
        assert_eq!(dirty.minutes.iter().copied().collect::<Vec<_>>(), vec![570, 571]);
        assert!(dirty.events.contains("e1") && dirty.flow && !dirty.day && !dirty.windows);
    }

    #[test]
    fn a_terminal_refusal_is_dropped_and_counted_never_resent() {
        let mut engine = engine_with_minutes(&[570]);
        let mut outbox = Outbox::default();
        let rid = outbox.register(vec![Pending::of(&id(), &minutes_item(&[570]))]);
        let out = outbox.ack(Some(rid), &[json!({"ok": false, "code": "ROLLED_OVER", "reason": "ROLLED_OVER"})], &mut engine);
        assert_eq!(out, AckOutcome { dropped: 1, ..Default::default() });
        assert!(!engine.instruments[&id()].projection.dirty.any());
        assert!(outbox.last_dropped.as_deref().unwrap().contains("ROLLED_OVER"));
    }

    #[test]
    fn a_contract_refusal_is_named_and_a_newer_epoch_is_reported() {
        // Every terminal refusal was dropped alike; a contract error and an epoch behind Market Runtime's were
        // lost with only a counter.
        let mut engine = engine_with_minutes(&[570, 571]);
        let mut outbox = Outbox::default();
        let rid = outbox.register(vec![Pending::of(&id(), &minutes_item(&[570])), Pending::of(&id(), &minutes_item(&[571]))]);
        let out = outbox.ack(Some(rid), &[json!({"ok": false, "code": "UNKNOWN_BLOCK", "reason": "unknown block minutez"}),
            json!({"ok": false, "code": "EPOCH_BEHIND", "reason": "projection epoch 4 is older than 9", "held_epoch": 9})], &mut engine);
        assert_eq!(out.dropped, 0);
        assert_eq!(out.refused.len(), 1);
        assert!(out.refused[0].contains("unknown block minutez"), "{:?}", out.refused);
        assert_eq!(out.epoch_behind, Some(9));
    }

    #[test]
    fn a_contract_refusal_is_never_dropped_as_obsolete_and_the_code_not_the_prose_decides() {
        // A contract refusal left the outbox and was counted as dropped, as if it were obsolete; and the
        // obsolete/epoch cases were told apart by matching A's wording.
        let mut engine = engine_with_minutes(&[570, 571, 572]);
        let mut outbox = Outbox::default();
        let rid = outbox.register(vec![Pending::of(&id(), &minutes_item(&[570])), Pending::of(&id(), &minutes_item(&[571])),
                                       Pending::of(&id(), &minutes_item(&[572]))]);
        let out = outbox.ack(Some(rid), &[json!({"ok": false, "code": "IDENTITY_REQUIRED", "reason": "identity required"}),
            json!({"ok": false, "reason": "ROLLED_OVER"}),
            json!({"ok": false, "code": "STALE", "reason": "anything at all"})], &mut engine);
        assert_eq!(out.dropped, 1, "only the coded obsolete one");
        assert_eq!(out.refused.len(), 2, "no code is a contract refusal too, whatever the prose says: {:?}", out.refused);
        assert_eq!(outbox.dropped, 1);
        let dirty: Vec<i32> = engine.instruments[&id()].projection.dirty.minutes.iter().copied().collect();
        assert_eq!(dirty, vec![570, 571], "a refused item stays dirty");
    }

    #[test]
    fn a_lost_connection_requeues_what_was_in_flight_and_an_unknown_ack_changes_nothing() {
        let mut engine = engine_with_minutes(&[570]);
        let mut outbox = Outbox::default();
        outbox.register(vec![Pending::of(&id(), &json!({"block": "events", "data": {"events": [], "replace": true}}))]);
        outbox.register(vec![Pending::of(&id(), &minutes_item(&[570]))]);
        assert_eq!(outbox.ack(None, &[json!({"ok": true})], &mut engine), AckOutcome::default());
        assert_eq!(outbox.requeue_all(&mut engine), 2);
        let dirty = &engine.instruments[&id()].projection.dirty;
        assert!(dirty.events.contains("*") && dirty.minutes.contains(&570));
        assert_eq!(outbox.in_flight(), 0);
    }

    #[test]
    fn records_of_an_instrument_no_longer_held_are_not_requeued() {
        let mut engine = engine_with_minutes(&[]);
        let mut outbox = Outbox::default();
        let mut gone = id();
        gone.trading_date = "2026-10-07".into();
        outbox.register(vec![Pending::of(&gone, &minutes_item(&[570]))]);
        assert_eq!(outbox.requeue_all(&mut engine), 0);
    }
}
