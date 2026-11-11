//! Intraday rule events (docs/system-architecture/02 section 5). Each event keeps rule_id/version, identity,
//! trigger time/watermark, state and reason. Ids are deterministic (rule, version, instrument, session, trigger
//! minute), so a replay reproduces the same events instead of adding copies; an event can be updated while its
//! trigger minute is current and revoked when a correction removes its condition. Model availability never
//! affects these rules.

use crate::accum::{Instrument, Quality};
use crate::baseline::Month;
use market_runtime::calendar::Calendar;
use crate::rules::{EventRule, RuleSet};
use market_runtime::event::partition_local_minute;
use market_runtime::wire::money;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};

pub const EVENT_CAPACITY: usize = 200;

/// What an evaluation knows beyond the instrument: the model's predictions at this moment (written into an event
/// triggered live) and the instrument's usual volume (量比, written into every price event's detail).
#[derive(Debug, Default, Clone, Copy)]
pub struct Context<'a> {
    pub model: Option<&'a Value>,
    pub usual: Option<&'a Month>,
}

/// 量比 of a price event: the volume of its minutes `from..=to` against the usual volume of the same clock minutes
/// (baseline.rs Month), the last minute counted for its elapsed share `last_fraction`. None without a usual volume.
fn volume_against_usual(inst: &Instrument, usual: Option<&Month>, from: i32, to: i32, last_fraction: f64) -> Option<Value> {
    let (base, days) = usual?.usual(&inst.id.code, from, to, last_fraction)?;
    market_runtime::volume::positive(base)?;
    let current: f64 = inst.minutes.range(from..=to).filter_map(|(_, m)| m.volume).sum();
    Some(json!({"volume_ratio": current / base, "window_volume": market_runtime::volume::wire(current),
                "usual_volume": market_runtime::volume::clean(base), "usual_days": days, "usual_from": from, "usual_to": to}))
}

/// Where an event stands. A revision moves it ACTIVE -> UPDATED (a stronger value in its trigger minute) or to
/// REVOKED (a correction removed its condition); a revoked event never changes again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventStateKind {
    Active,
    Updated,
    Revoked,
}

/// An event's revision: 1 when it triggers, one more at each change. Readers keep the newest revision per event_id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EventRevision(std::num::NonZeroU64);

impl EventRevision {
    pub const FIRST: Self = Self(std::num::NonZeroU64::MIN);

    pub fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

/// A nanosecond time written as a decimal string (JSON numbers lose precision past 2^53).
mod ns_text {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(ns: &i64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&ns.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }

    pub mod option {
        use serde::{Deserialize, Deserializer, Serializer};

        pub fn serialize<S: Serializer>(ns: &Option<i64>, s: S) -> Result<S::Ok, S::Error> {
            match ns {
                Some(ns) => s.serialize_str(&ns.to_string()),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
            Option::<String>::deserialize(d)?.map(|t| t.parse().map_err(serde::de::Error::custom)).transpose()
        }
    }
}

/// One rule event, as B holds it, checkpoints it and (through `wire`) publishes and archives it. The checkpoint reads
/// the same shape back; a record that does not have it refuses the checkpoint (the day is rebuilt from the stream).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventRecord {
    pub event_id: String,
    pub rule_id: String,
    pub rule_version: Option<u64>,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    pub direction: Option<String>,
    /// The rule's rank (rules.rs `EventRule::priority`).
    pub priority: i32,
    pub source: String,
    pub market: String,
    pub code: String,
    pub trading_date: String,
    pub session: String,
    pub trigger_minute: i32,
    /// The trigger minute as HH:MM.
    pub time: String,
    /// When the record's values were last evaluated.
    #[serde(with = "ns_text")]
    pub as_of_ns: i64,
    pub input_watermark: u64,
    pub value: f64,
    pub threshold: f64,
    pub unit: String,
    /// The rule's own figures (window, base price, 量比 ...), shown as they are.
    pub detail: Value,
    pub state: EventStateKind,
    pub revision: EventRevision,
    pub reason: String,
    pub event_origin: String,
    /// When the condition was really seen; none for a minute evaluated by a catch-up (see `evaluate_at`).
    #[serde(default, skip_serializing_if = "Option::is_none", with = "ns_text::option")]
    pub triggered_at_ns: Option<i64>,
    /// The model's predictions at the trigger moment (live triggers only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_predictions: Option<Value>,
}

impl EventRecord {
    /// The record as Market Runtime and the event archive receive it.
    pub fn wire(&self) -> Value {
        serde_json::to_value(self).expect("an event record is plain data")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventState {
    pub records: BTreeMap<String, EventRecord>,
    pub order: VecDeque<String>,
    /// Hysteresis per rule: false after a trigger until the value falls back below the reset level.
    pub disarmed: BTreeMap<String, bool>,
    /// Last market minute the rules were evaluated at (see catch_up).
    pub evaluated_minute: Option<i32>,
    /// The market second of the partition's newest data not evaluated yet (evaluate_pending).
    pub pending_second: Option<i64>,
    /// Events evaluate_pending created that still lack the model's predictions: the live publish adds them
    /// (engine.rs `Projecting::layer`); a replay has none to add.
    #[serde(skip)]
    pub awaiting_model: Vec<String>,
}

impl EventState {
    fn upsert(&mut self, id: &str, record: EventRecord) -> bool {
        let changed = self.records.get(id) != Some(&record);
        if !self.records.contains_key(id) {
            self.order.push_back(id.to_string());
            while self.order.len() > EVENT_CAPACITY {
                if let Some(old) = self.order.pop_front() {
                    self.records.remove(&old);
                }
            }
        }
        if changed {
            self.records.insert(id.to_string(), record);
        }
        changed
    }

    pub fn wire(&self) -> Vec<Value> {
        self.order.iter().filter_map(|id| self.records.get(id)).map(EventRecord::wire).collect()
    }
}

fn excluded(rule: &EventRule, minute: i32) -> bool {
    if let Some((a, b)) = rule.active_minutes {
        if minute < a || minute > b {
            return true;
        }
    }
    rule.exclude_minutes.iter().any(|(a, b)| minute >= *a && minute <= *b)
}

struct Candidate {
    value: f64,
    threshold: f64,
    reset: f64,
    unit: &'static str,
    detail: Value,
}

/// `usual`: the usual volume and the share of `minute` elapsed, for 量比 (None: no 量比, e.g. a recheck).
fn evaluate_rule(inst: &Instrument, rule: &EventRule, windows: &Value, minute: i32, usual: Option<(&Month, f64)>) -> Option<Candidate> {
    let up = rule.direction.as_deref() != Some("down");
    let sign = if up { 1.0 } else { -1.0 };
    let volume = |from: i32| usual.and_then(|(month, fraction)| volume_against_usual(inst, Some(month), from, minute, fraction));
    let with_volume = |mut detail: Value, from: i32| {
        if let (Some(obj), Some(Value::Object(v))) = (detail.as_object_mut(), volume(from)) {
            obj.extend(v);
        }
        detail
    };
    match rule.kind.as_str() {
        "window_move" => {
            let n = rule.window?;
            let w = &windows["windows"][n.to_string()];
            if matches!(w["base_source"].as_str(), Some("GAP") | Some("none") | None) {
                return None;
            }
            let pct = w["change_pct"].as_f64()?;
            let threshold = rule.threshold_pct?;
            Some(Candidate { value: pct * sign, threshold, reset: threshold * rule.reset_ratio.unwrap_or(0.6), unit: "percent",
                detail: with_volume(json!({"window": n, "change_pct": pct, "base_price": w["base_price"], "base_minute": w["base_minute"], "close": w["close"]}),
                    minute - n + 1) })
        }
        "opening_move" => {
            let (open_minute, open) = inst.minutes.iter().find(|(_, m)| m.quality == Quality::Traded).and_then(|(k, m)| Some((*k, m.open?)))?;
            // The price as of the evaluated minute (live: the current minute's close is the latest print).
            let last = inst.minutes.range(..=minute).rev().find_map(|(_, m)| m.close)?;
            let pct = (last - open) as f64 / open as f64 * 100.0;
            let threshold = rule.threshold_pct?;
            Some(Candidate { value: pct * sign, threshold, reset: threshold * rule.reset_ratio.unwrap_or(0.6), unit: "percent",
                detail: with_volume(json!({"open": money(open), "last": money(last), "change_from_open_pct": pct}), open_minute) })
        }
        _ => None,
    }
}

/// Evaluate every applicable rule at market time `t_ns` as an exact moment; returns the ids that changed. `ctx.model`
/// is written into an event it creates; `ctx.usual` its usual volume for 量比. The tests' direct entry: B itself
/// evaluates only through evaluate_pending.
#[cfg(test)]
pub fn evaluate(inst: &mut Instrument, cal: &Calendar, rules: &RuleSet, windows: &Value, t_ns: i64, watermark: u64, ctx: Context) -> Vec<String> {
    evaluate_at(inst, cal, rules, windows, t_ns, watermark, true, ctx)
}

/// `exact`: `t_ns` is when the condition was really seen (live, every publish), so a new event records it as
/// `triggered_at_ns` -- the time the UI shows to the second and sorts by. A catch-up evaluates a skipped minute as of
/// its last second, which is not when it triggered: those events carry no `triggered_at_ns` and show the minute.
/// For the same reason only an exact event records `model_predictions` (what the model said when it triggered).
#[allow(clippy::too_many_arguments)]
fn evaluate_at(inst: &mut Instrument, cal: &Calendar, rules: &RuleSet, windows: &Value, t_ns: i64, watermark: u64, exact: bool,
               ctx: Context) -> Vec<String> {
    let Some(minute) = partition_local_minute(&inst.id.source, &inst.id.market, &inst.id.session, t_ns).map(|(_, m)| m) else { return Vec::new() };
    inst.events.evaluated_minute = Some(inst.events.evaluated_minute.map_or(minute, |e| e.max(minute)));
    if !cal.is_trading(inst.id.cal_key(), minute) {
        return Vec::new();
    }
    let rule_version = rules.event_revision;
    let applicable: Vec<EventRule> = rules.event_rules(&inst.id.source, &inst.id.market, &inst.id.code).cloned().collect();
    let mut changed = Vec::new();
    for rule in applicable {
        let arm_key = format!("{}:{}", rule.rule_id, rule_version.unwrap_or(0));
        // 量比 counts the current minute for the share of it elapsed at t_ns (a catch-up is as of its last second).
        let elapsed = ((t_ns / 1_000_000_000).rem_euclid(60) + 1) as f64 / 60.0;
        let usual = ctx.usual.map(|month| (month, elapsed));
        let candidate = if excluded(&rule, minute) { None } else { evaluate_rule(inst, &rule, windows, minute, usual) };
        let Some(c) = candidate else { continue };
        let disarmed = inst.events.disarmed.get(&arm_key).copied().unwrap_or(false);
        if disarmed && c.value < c.reset {
            inst.events.disarmed.insert(arm_key.clone(), false);
        }
        let id = format!("{}:{}:{}:{}:{}:{}", rule.rule_id, rule_version.unwrap_or(0), inst.id.code, inst.id.trading_date, inst.id.session, minute);
        let existing = inst.events.records.get(&id).cloned();
        let triggered = c.value >= c.threshold;
        if let Some(prev) = existing {
            // Same trigger minute: a stronger value updates the one event instead of adding another.
            if triggered && prev.state != EventStateKind::Revoked && c.value > prev.value {
                let next = EventRecord { value: c.value, detail: c.detail, revision: prev.revision.next(), state: EventStateKind::Updated,
                                         as_of_ns: t_ns, input_watermark: watermark, ..prev };
                if inst.events.upsert(&id, next) {
                    changed.push(id);
                }
            }
            continue;
        }
        if !triggered || inst.events.disarmed.get(&arm_key).copied().unwrap_or(false) {
            continue;
        }
        inst.events.disarmed.insert(arm_key, true);
        let record = EventRecord {
            event_id: id.clone(), rule_id: rule.rule_id.clone(), rule_version, kind: rule.kind.clone(), label: rule.label.clone(),
            direction: rule.direction.clone(), priority: rule.priority, source: inst.id.source.clone(), market: inst.id.market.clone(), code: inst.id.code.clone(),
            trading_date: inst.id.trading_date.clone(), session: inst.id.session.clone(), trigger_minute: minute,
            time: crate::baseline::clock_text(minute), as_of_ns: t_ns, input_watermark: watermark,
            value: c.value, threshold: c.threshold, unit: c.unit.to_owned(), detail: c.detail,
            state: EventStateKind::Active, revision: EventRevision::FIRST, reason: format!("{} >= {}", c.value, c.threshold),
            event_origin: "analysis_runtime".into(),
            // Written once, by an exact evaluation: an UPDATED revision moves as_of_ns, never this, and keeps the
            // predictions of the trigger.
            triggered_at_ns: exact.then_some(t_ns),
            model_predictions: if exact { ctx.model.cloned() } else { None },
        };
        if inst.events.upsert(&id, record) {
            changed.push(id);
        }
    }
    changed
}

/// The rules are evaluated by the market data, never by when B publishes (user 11-11): a partition's data marks its
/// market second pending, and once market time in its scope has passed that second (engine.rs `evaluate_passed`) --
/// before the partition's next data applies -- the second is evaluated as of its last nanosecond: the skipped minutes
/// first (catch_up), then the rules at that moment. Live and a replay of the same stream therefore evaluate the same
/// states at the same moments and hold the same events; evaluating at publish time made them differ (a restart's
/// replay lost every event a spike within a minute had triggered live). Returns the ids that changed.
pub fn evaluate_pending(inst: &mut Instrument, cal: &Calendar, rules: &RuleSet, previous: Option<&Instrument>, watermark: u64,
                        usual: Option<&Month>) -> Vec<String> {
    let Some(second) = inst.events.pending_second.take() else { return Vec::new() };
    let t = second * 1_000_000_000 + 999_999_999;
    let mut changed = catch_up(inst, cal, rules, previous, t, watermark, usual);
    let windows = inst.rule_windows(cal, t, previous);
    if windows.get("windows").is_some() {
        let now = evaluate_at(inst, cal, rules, &windows, t, watermark, true, Context { model: None, usual });
        for id in &now {
            if inst.events.records.get(id).is_some_and(|r| r.revision == EventRevision::FIRST && r.model_predictions.is_none()) {
                inst.events.awaiting_model.push(id.clone());
            }
        }
        changed.extend(now);
    }
    changed
}

/// Rules are evaluated at each passed second a partition has data in. A replay or a restart's catch-up
/// publishes once over many minutes, so the minutes in between were never evaluated and their events never
/// existed (a checkpoint reset rebuilt 14 of 1427 events). Evaluate each skipped trading minute first, in
/// order, as of its last second; `evaluate` at `t_ns` itself follows.
pub fn catch_up(inst: &mut Instrument, cal: &Calendar, rules: &RuleSet, previous: Option<&Instrument>, t_ns: i64, watermark: u64,
                usual: Option<&Month>) -> Vec<String> {
    let Some(now) = partition_local_minute(&inst.id.source, &inst.id.market, &inst.id.session, t_ns).map(|(_, m)| m) else { return Vec::new() };
    if rules.event_rules(&inst.id.source, &inst.id.market, &inst.id.code).next().is_none() {
        return Vec::new();
    }
    let from = match inst.events.evaluated_minute {
        Some(e) => e + 1,
        // Restored from a checkpoint written before this field: it was evaluated live all along.
        None if !inst.events.records.is_empty() => now,
        None => match inst.minutes.keys().next() { Some(first) => *first, None => return Vec::new() },
    };
    // Market offsets are whole minutes, so the UTC second is the market second.
    let second = (t_ns / 1_000_000_000).rem_euclid(60);
    let mut changed = Vec::new();
    for minute in from..now {
        if !cal.is_trading(inst.id.cal_key(), minute) {
            continue;
        }
        let t = t_ns - ((now - minute) as i64 * 60 + second - 59) * 1_000_000_000;
        let windows = inst.rule_windows(cal, t, previous);
        if windows.get("windows").is_some() {
            changed.extend(evaluate_at(inst, cal, rules, &windows, t, watermark, false, Context { model: None, usual }));
        }
    }
    changed
}

/// After a minute is revised, re-check events triggered in it; a condition that no longer holds revokes the event.
/// Every held event is of the rule set in force: a change of the event rules starts the events over
/// (engine.rs `set_rules`), so a record whose rule is missing is a broken invariant -- logged, and left as it is.
pub fn recheck(inst: &mut Instrument, cal: &Calendar, rules: &RuleSet, revised_minute: i32, watermark: u64) -> Vec<String> {
    let candidates: Vec<EventRecord> = inst.events.records.values()
        .filter(|r| r.trigger_minute == revised_minute && r.state != EventStateKind::Revoked).cloned().collect();
    let mut changed = Vec::new();
    for record in candidates {
        let Some(rule) = rules.events.iter().find(|r| r.rule_id == record.rule_id).cloned() else {
            eprintln!("[analysis_runtime] event {} names rule {:?}, which the rules in force do not hold: not rechecked",
                      record.event_id, record.rule_id);
            continue;
        };
        let windows = inst.windows_wire(cal, rules, record.as_of_ns, None);
        let still = evaluate_rule(inst, &rule, &windows, revised_minute, None).is_some_and(|c| c.value >= c.threshold);
        if !still {
            let id = record.event_id.clone();
            let next = EventRecord { state: EventStateKind::Revoked, revision: record.revision.next(),
                                     reason: "a revision of the trigger minute removed the condition".into(), input_watermark: watermark, ..record };
            if inst.events.upsert(&id, next) {
                changed.push(id);
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accum::tests::{reference_at, rules as flow_rules, trade_at, ts};
    use crate::accum::{InstrumentId, Instrument};
    use crate::rules::{EventRule, Match};

    fn rule(id: &str, kind: &str, window: Option<i32>, pct: Option<f64>, direction: &str) -> EventRule {
        EventRule { rule_id: id.into(), kind: kind.into(), matcher: Match::default(), label: id.into(), direction: Some(direction.into()),
            priority: 300, window, threshold_pct: pct, reset_ratio: None, active_minutes: None,
            exclude_minutes: vec![(805, 810)], enabled: true }
    }

    #[test]
    fn a_window_move_triggers_once_updates_in_its_minute_and_rearms_after_falling_back() {
        let cal = Calendar::default();
        let mut rules = flow_rules();
        rules.event_revision = Some(2);
        rules.events = vec![rule("win1_up", "window_move", Some(1), Some(0.8), "up")];
        let mut inst = Instrument::new(InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into() });
        inst.apply(&cal, &rules, &reference_at(0, 1_000_000));
        inst.apply(&cal, &rules, &trade_at(1, 600, 5, 1_000_000, 1, 1));
        inst.apply(&cal, &rules, &trade_at(2, 601, 5, 1_000_000, 1, 1));
        inst.apply(&cal, &rules, &trade_at(3, 602, 10, 1_010_000, 1, 1)); // +1.0% vs 10:01 close
        let w = inst.windows_wire(&cal, &rules, ts(602, 10), None);
        let changed = evaluate(&mut inst, &cal, &rules, &w, ts(602, 10), 3, Context::default());
        assert_eq!(changed.len(), 1);
        inst.apply(&cal, &rules, &trade_at(4, 602, 20, 1_015_000, 1, 1));
        let w = inst.windows_wire(&cal, &rules, ts(602, 20), None);
        let changed = evaluate(&mut inst, &cal, &rules, &w, ts(602, 20), 4, Context::default());
        assert_eq!(changed.len(), 1, "same minute: updated, not a second event");
        assert_eq!(inst.events.records.len(), 1);
        assert_eq!(inst.events.wire()[0]["state"], "UPDATED");
        // the trigger time is the first sighting; the update moved only as_of_ns
        assert_eq!(inst.events.wire()[0]["triggered_at_ns"], ts(602, 10).to_string());
        assert_eq!(inst.events.wire()[0]["as_of_ns"], ts(602, 20).to_string());
        // still high in the next minute: disarmed, no new event
        inst.apply(&cal, &rules, &trade_at(5, 603, 5, 1_030_000, 1, 1));
        let w = inst.windows_wire(&cal, &rules, ts(603, 5), None);
        assert!(evaluate(&mut inst, &cal, &rules, &w, ts(603, 5), 5, Context::default()).is_empty());
        // replaying the same inputs yields the same id (deterministic), not a copy
        let first_id = inst.events.order[0].clone();
        assert!(first_id.starts_with("win1_up:2:2330:2026-09-29:DAY:602"));
    }

    #[test]
    fn a_live_event_keeps_the_model_predictions_of_its_trigger_and_a_caught_up_one_has_none() {
        let cal = Calendar::default();
        let mut rules = flow_rules();
        rules.events = vec![rule("win1_up", "window_move", Some(1), Some(0.8), "up")];
        let id = || InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into() };
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &rules, &reference_at(0, 1_000_000));
        inst.apply(&cal, &rules, &trade_at(1, 601, 5, 1_000_000, 1, 1));
        inst.apply(&cal, &rules, &trade_at(2, 602, 10, 1_010_000, 1, 1));
        let at_trigger = json!({"3m_up": {"probability": 0.7}, "5m_down": {"probability": 0.2}});
        let w = inst.windows_wire(&cal, &rules, ts(602, 10), None);
        evaluate(&mut inst, &cal, &rules, &w, ts(602, 10), 2, Context { model: Some(&at_trigger), usual: None });
        assert_eq!(inst.events.wire()[0]["model_predictions"], at_trigger);
        // A stronger value in the same minute updates the event; the predictions stay those of the trigger.
        inst.apply(&cal, &rules, &trade_at(3, 602, 20, 1_015_000, 1, 1));
        let w = inst.windows_wire(&cal, &rules, ts(602, 20), None);
        evaluate(&mut inst, &cal, &rules, &w, ts(602, 20), 3, Context { model: Some(&json!({"3m_up": {"probability": 0.1}})), usual: None });
        assert_eq!(inst.events.wire()[0]["state"], "UPDATED");
        assert_eq!(inst.events.wire()[0]["model_predictions"], at_trigger);
        // The same minute caught up later was not seen live: no trigger moment, so no predictions are claimed.
        let mut late = Instrument::new(id());
        late.apply(&cal, &rules, &reference_at(0, 1_000_000));
        late.apply(&cal, &rules, &trade_at(1, 601, 5, 1_000_000, 1, 1));
        late.apply(&cal, &rules, &trade_at(2, 602, 10, 1_010_000, 1, 1));
        catch_up(&mut late, &cal, &rules, None, ts(604, 10), 9, None);
        assert!(!late.events.records.is_empty(), "the minute was caught up");
        assert!(late.events.wire().iter().all(|r| r.get("model_predictions").is_none()));
    }

    #[test]
    fn a_revision_that_removes_the_condition_revokes_the_event() {
        let cal = Calendar::default();
        let mut rules = flow_rules();
        rules.events = vec![rule("win1_up", "window_move", Some(1), Some(0.8), "up")];
        let mut inst = Instrument::new(InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into() });
        inst.apply(&cal, &rules, &reference_at(0, 1_000_000));
        inst.apply(&cal, &rules, &trade_at(1, 601, 5, 1_000_000, 1, 1));
        inst.apply(&cal, &rules, &trade_at(2, 602, 10, 1_010_000, 1, 1));
        let w = inst.windows_wire(&cal, &rules, ts(602, 10), None);
        evaluate(&mut inst, &cal, &rules, &w, ts(602, 10), 2, Context::default());
        // A later print in the trigger minute brings it back to where it started.
        inst.apply(&cal, &rules, &trade_at(4, 602, 12, 1_000_000, 1, 1));
        let revoked = recheck(&mut inst, &cal, &rules, 602, 4);
        assert_eq!(revoked.len(), 1);
        assert_eq!(inst.events.wire()[0]["state"], "REVOKED");
    }

    #[test]
    fn a_replay_published_once_catches_up_the_events_of_every_skipped_minute() {
        // Live publishes every minute; a replay/restart publishes once after the whole tape. Both must end with the
        // same events (a checkpoint reset once rebuilt only 14 of 1427).
        let cal = Calendar::default();
        let mut rules = flow_rules();
        rules.events = vec![rule("win1_up", "window_move", Some(1), Some(0.8), "up"), rule("open_up", "opening_move", None, Some(2.0), "up")];
        let id = || InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into() };
        let tape: Vec<(i32, i64, i64)> = vec![(600, 1_000_000, 10), (601, 1_000_000, 10), (602, 1_000_000, 10), (603, 1_012_000, 50),
            (604, 1_012_000, 10), (605, 1_025_000, 10), (606, 1_025_000, 10), (607, 1_025_000, 10)];
        let (mut live, mut replay) = (Instrument::new(id()), Instrument::new(id()));
        for (i, (minute, price, volume)) in tape.iter().enumerate() {
            let e = trade_at(i as u64 + 1, *minute, 30, *price, *volume as f64, 1);
            live.apply(&cal, &rules, &e);
            replay.apply(&cal, &rules, &e);
            let t = ts(*minute, 59);
            let w = live.windows_wire(&cal, &rules, t, None);
            evaluate(&mut live, &cal, &rules, &w, t, i as u64 + 1, Context::default());
        }
        let t = ts(608, 10);
        catch_up(&mut replay, &cal, &rules, None, t, 99, None);
        let w = replay.windows_wire(&cal, &rules, t, None);
        evaluate(&mut replay, &cal, &rules, &w, t, 99, Context::default());
        let ids = |inst: &Instrument| inst.events.order.iter().cloned().collect::<Vec<_>>();
        assert!(ids(&live).len() >= 2, "the tape triggers a window move and an opening move: {:?}", ids(&live));
        assert_eq!(ids(&replay), ids(&live));
        assert_eq!(replay.events.evaluated_minute, Some(608));
        // caught-up minutes were not seen live: no trigger second is claimed for them
        assert!(replay.events.wire().iter().filter(|r| r["trigger_minute"].as_i64() < Some(608)).all(|r| r.get("triggered_at_ns").is_none()));
        assert!(live.events.wire().iter().all(|r| r["triggered_at_ns"].is_string()));
        // Nothing left to catch up: a second publish in the same minute evaluates only that minute.
        assert!(catch_up(&mut replay, &cal, &rules, None, ts(608, 20), 100, None).is_empty());
    }

    #[test]
    fn a_record_keeps_its_wire_shape_and_a_malformed_one_is_refused() {
        let cal = Calendar::default();
        let mut rules = flow_rules();
        rules.events = vec![rule("win1_up", "window_move", Some(1), Some(0.8), "up")];
        let mut inst = Instrument::new(InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into() });
        inst.apply(&cal, &rules, &reference_at(0, 1_000_000));
        inst.apply(&cal, &rules, &trade_at(1, 601, 5, 1_000_000, 1, 1));
        inst.apply(&cal, &rules, &trade_at(2, 602, 10, 1_010_000, 1, 1));
        let w = inst.windows_wire(&cal, &rules, ts(602, 10), None);
        evaluate(&mut inst, &cal, &rules, &w, ts(602, 10), 2, Context::default());
        let wire = inst.events.wire()[0].clone();
        assert_eq!((wire["state"].as_str(), wire["revision"].as_u64(), wire["type"].as_str()), (Some("ACTIVE"), Some(1), Some("window_move")));
        assert_eq!(wire["as_of_ns"], ts(602, 10).to_string(), "times stay decimal strings");
        assert!(wire.get("model_predictions").is_none(), "no predictions: no field");
        assert_eq!((wire["direction"].as_str(), wire["priority"].as_i64()), (Some("up"), Some(300)), "the rule's direction and rank travel on the record");
        // The checkpoint reads the same shape back.
        let back: EventRecord = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(back.wire(), wire);
        for broken in [json!({"revision": 0}), json!({"state": "DONE"}), json!({"as_of_ns": "soon"}), json!({"extra": 1})] {
            let mut bad = wire.clone();
            bad.as_object_mut().unwrap().extend(broken.as_object().unwrap().clone());
            assert!(serde_json::from_value::<EventRecord>(bad).is_err(), "{broken}");
        }
        let mut missing = wire;
        missing.as_object_mut().unwrap().remove("revision");
        assert!(serde_json::from_value::<EventRecord>(missing).is_err(), "a missing revision is not read as 1");
    }

    #[test]
    fn the_closing_auction_is_excluded() {
        let cal = Calendar::default();
        let mut rules = flow_rules();
        rules.events = vec![rule("win1_up", "window_move", Some(1), Some(0.1), "up")];
        let mut inst = Instrument::new(InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into() });
        inst.apply(&cal, &rules, &reference_at(0, 1_000_000));
        inst.apply(&cal, &rules, &trade_at(1, 804, 5, 1_000_000, 10, 1));
        inst.apply(&cal, &rules, &trade_at(2, 806, 5, 1_050_000, 10, 1));
        let w = inst.windows_wire(&cal, &rules, ts(806, 5), None);
        assert!(evaluate(&mut inst, &cal, &rules, &w, ts(806, 5), 2, Context::default()).iter().all(|id| !id.starts_with("win1_up")), "13:26 is in the closing auction");
    }

    #[test]
    fn a_price_event_carries_its_volume_against_the_usual_volume_of_its_minutes() {
        use crate::baseline::{Day, Month};
        use std::collections::HashMap;
        use std::sync::Arc;
        let cal = Calendar::default();
        let mut rules = flow_rules();
        rules.events = vec![rule("win3_up", "window_move", Some(3), Some(0.8), "up")];
        let mut inst = Instrument::new(InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into() });
        inst.apply(&cal, &rules, &reference_at(0, 1_000_000));
        inst.apply(&cal, &rules, &trade_at(1, 599, 5, 1_000_000, 10, 1));
        inst.apply(&cal, &rules, &trade_at(2, 600, 5, 1_000_000, 10, 1));
        inst.apply(&cal, &rules, &trade_at(3, 601, 5, 1_005_000, 20, 1));
        inst.apply(&cal, &rules, &trade_at(4, 602, 5, 1_012_000, 30, 1));
        // Usually 10 lots a minute at 10:00-10:02 (two sessions: 5 and 15).
        let day = |date: &str, lots: f64| Arc::new(Day { date: date.into(), span: Some((540, 810)),
            items: HashMap::from([("2330".to_string(), HashMap::from([(600, lots), (601, lots), (602, lots)]))]) });
        let month = Month { days: vec![day("2026-09-26", 5.0), day("2026-09-25", 15.0)] };
        let w = inst.windows_wire(&cal, &rules, ts(602, 59), None);
        evaluate(&mut inst, &cal, &rules, &w, ts(602, 59), 4, Context { model: None, usual: Some(&month) });
        let detail = &inst.events.wire()[0]["detail"];
        // 10 + 20 + 30 lots against 3 x 10: 2.0 times the usual volume
        assert_eq!(detail["volume_ratio"], 2.0);
        assert_eq!((detail["usual_days"].as_u64(), detail["usual_from"].as_i64(), detail["usual_to"].as_i64()), (Some(2), Some(600), Some(602)));
        // Without a usual volume (no baseline yet) the event is the same, with no 量比.
        let mut bare = Instrument::new(inst.id.clone());
        bare.apply(&cal, &rules, &reference_at(0, 1_000_000));
        for (i, (m, p, v)) in [(599, 1_000_000, 10.0), (600, 1_000_000, 10.0), (601, 1_005_000, 20.0), (602, 1_012_000, 30.0)].into_iter().enumerate() {
            bare.apply(&cal, &rules, &trade_at(i as u64 + 1, m, 5, p, v, 1));
        }
        let w = bare.windows_wire(&cal, &rules, ts(602, 59), None);
        evaluate(&mut bare, &cal, &rules, &w, ts(602, 59), 4, Context::default());
        assert!(bare.events.wire()[0]["detail"].get("volume_ratio").is_none());
    }
}
