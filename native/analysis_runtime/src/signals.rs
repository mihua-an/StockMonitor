//! The one model-signal authority, inside Rust B: B validates its own
//! inference results and publishes them to Market Runtime itself (`signals.publish`), so closing FastAPI never
//! stops an AI signal: the signal flow -- like
//! the market data flow -- never passes through FastAPI.
//!
//! Validation per result, as the Python producer did it: shape; config version is the active one; the slot is
//! enabled and runnable; model identity, feature-spec digest and TEST_ONLY match the active slot; TEST_ONLY only when
//! the config allows it; the durable stream is Market Runtime's current one; the input watermark moves forward per
//! (instrument, slot); the result has not expired. Only the prediction entry it names is merged -- other horizons stay
//! untouched. A config change disables what was published. A replay's predictions are its timeline's
//! (runtime/replay_runtime.rs), never results of this book.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The `authority` every published row names (the renderer and Market Runtime read rows by it).
pub const AUTHORITY: &str = "analysis_signal_producer";
pub const MAX_INSTRUMENTS: usize = 50_000;

/// (source, market, trading_date, session, code), normalised as the Python ProjectionKey was.
pub type Key = (String, String, String, String, String);

/// What the active config says about one slot (`"3m_up"` ...).
#[derive(Debug, Clone, PartialEq)]
pub struct SlotModel {
    pub model_id: Value,
    pub model_version: Value,
    pub test_only: bool,
    pub schema_digest: String,
    /// Why the slot cannot run (`BELOW_BASELINE`, `NO_MODEL`, `INCOMPATIBLE`, `LOAD_FAILED` ...); None when it runs.
    pub refusal: Option<String>,
}

/// The active inference config as validation needs it.
#[derive(Debug, Clone, Default)]
pub struct ConfigView {
    pub config_version: u64,
    pub test_only_allowed: bool,
    pub slots: HashMap<String, SlotModel>,
}

pub fn prediction_key(horizon_minutes: u64, direction: &str) -> String {
    format!("{horizon_minutes}m_{direction}")
}

/// The result's identity, or which field of it is missing, empty or not a string.
fn key_of(message: &Value) -> Result<Key, String> {
    let identity = message.get("identity").filter(|v| v.is_object()).ok_or("identity must be an object")?;
    let field = |name: &str| identity.get(name).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
        .ok_or_else(|| format!("identity.{name} must be a non-empty string"));
    Ok((field("source")?.to_lowercase(), field("market")?.to_uppercase(), field("trading_date")?.chars().take(10).collect(),
        field("session")?.to_uppercase(), field("code")?.to_uppercase()))
}

/// A result message's identity when its shape is whole, else why it is malformed (contract.result_shape_problem's
/// checks): one pass, so a message cannot pass the shape check and then lack the identity it is filed under.
pub fn checked_shape(message: &Value) -> Result<Key, String> {
    for name in ["identity", "status", "config_version", "input_watermark", "horizon_minutes", "direction", "test_only",
                 "worker_epoch", "generation", "durable_stream_id"] {
        if message.get(name).is_none() {
            return Err(format!("missing field {name}"));
        }
    }
    let key = key_of(message)?;
    let status = message["status"].as_str().unwrap_or("");
    if !matches!(status, "OK" | "FAILED" | "EXPIRED") {
        return Err(format!("status {status:?}"));
    }
    if status == "OK" {
        match message["probability"].as_f64() {
            Some(p) if p.is_finite() && (0.0..=1.0).contains(&p) => {}
            other => return Err(format!("OK result with probability {other:?}")),
        }
    }
    for name in ["generation", "input_watermark", "config_version", "worker_epoch", "horizon_minutes"] {
        if message[name].as_u64().is_none() {
            return Err(format!("{name} must be a non-negative integer"));
        }
    }
    if !matches!(message["direction"].as_str(), Some("up" | "down")) {
        return Err("direction".into());
    }
    if !message["test_only"].is_boolean() {
        return Err("test_only must be a boolean".into());
    }
    Ok(key)
}

#[derive(Debug, Default)]
pub struct SignalBook {
    entries: BTreeMap<Key, BTreeMap<String, Value>>,
    watermarks: HashMap<(Key, String), u64>,
    newest_date: HashMap<(String, String), String>,
    /// The oldest worker epoch whose live results are still current: a session rollover or reset moves it.
    min_worker_epoch: u64,
    pub counts: BTreeMap<&'static str, u64>,
    pub rejections: BTreeMap<String, u64>,
    /// Why the newest MALFORMED result was refused (the count is in `rejections`).
    pub last_malformed: Option<String>,
}

fn item(key: &Key, predictions: Map<String, Value>) -> Value {
    let (source, market, trading_date, session, code) = key;
    let identity = json!({"source": source, "market": market, "code": code, "trading_date": trading_date, "session": session});
    json!({"identity": identity, "row": {"authority": AUTHORITY, "model_predictions": predictions}})
}

fn entry(message: &Value, watermark: u64) -> Value {
    let failed = message["status"] != "OK";
    json!({
        "probability": if failed { Value::Null } else { message["probability"].clone() },
        "status": message["status"], "reason": if failed { message["reason"].clone() } else { Value::Null },
        "model_id": message["model_id"], "model_version": message["model_version"], "test_only": message["test_only"],
        "input_watermark": watermark,
        "asof": message.get("market_cutoff_ns").map(|v| match v { Value::Null => String::new(), other => other.to_string() }).unwrap_or_default(),
        "horizon_minutes": message["horizon_minutes"], "direction": message["direction"],
    })
}

impl SignalBook {
    fn count(&mut self, name: &'static str) {
        *self.counts.entry(name).or_insert(0) += 1;
    }

    fn reject(&mut self, reason: &str) -> Option<Value> {
        *self.rejections.entry(reason.to_owned()).or_insert(0) += 1;
        None
    }

    /// The worker epoch moved (session rollover, reset): live results computed under an older one are refused.
    pub fn advance_epoch(&mut self, epoch: u64) {
        self.min_worker_epoch = self.min_worker_epoch.max(epoch);
    }

    /// Validates one result; returns the `signals.publish` item it produces, if accepted.
    pub fn accept(&mut self, message: &Value, config: Option<&ConfigView>, stream_id: &str, now_ns: i64) -> Option<Value> {
        self.count("received");
        let key = match checked_shape(message) {
            Ok(key) => key,
            Err(why) => {
                self.last_malformed = Some(why);
                return self.reject("MALFORMED");
            }
        };
        let Some(config) = config else { return self.reject("NO_CONFIG") };
        if message["config_version"].as_u64() != Some(config.config_version) {
            return self.reject("STALE_CONFIG");
        }
        let slot = prediction_key(message["horizon_minutes"].as_u64().unwrap_or(0), message["direction"].as_str().unwrap_or(""));
        let Some(model) = config.slots.get(&slot) else { return self.reject("SLOT_NOT_ENABLED") };
        if model.refusal.is_some() {
            return self.reject("SLOT_NOT_RUNNABLE");
        }
        if (&message["model_id"], &message["model_version"]) != (&model.model_id, &model.model_version) {
            return self.reject("MODEL_MISMATCH");
        }
        if message["feature_spec_digest"].as_str() != Some(model.schema_digest.as_str()) {
            return self.reject("FEATURE_SPEC_MISMATCH");
        }
        let test_only = message["test_only"].as_bool().unwrap_or(false);
        if test_only != model.test_only {
            return self.reject("TEST_ONLY_MISMATCH");
        }
        if test_only && !config.test_only_allowed {
            return self.reject("TEST_ONLY_NOT_ALLOWED");
        }
        if stream_id.is_empty() {
            return self.reject("STREAM_UNKNOWN");
        }
        if message["durable_stream_id"].as_str() != Some(stream_id) {
            return self.reject("STREAM_MISMATCH");
        }
        let watermark = message["input_watermark"].as_u64().unwrap_or(0);
        if message["status"] == "EXPIRED" {
            return self.reject("WORKER_EXPIRED");
        }
        let expires = message["expires_at_ns"].as_i64().unwrap_or(0);
        if expires > 0 && now_ns > expires {
            return self.reject("EXPIRED");
        }
        if message["worker_epoch"].as_u64().unwrap_or(0) < self.min_worker_epoch {
            // Computed before a session rollover: its session may be retired, and `forget` already dropped the
            // watermark that would have refused it.
            return self.reject("STALE_WORKER_EPOCH");
        }
        if watermark <= self.watermarks.get(&(key.clone(), slot.clone())).copied().unwrap_or(0) {
            return self.reject("STALE_OR_DUPLICATE");
        }
        let value = entry(message, watermark);
        self.watermarks.insert((key.clone(), slot.clone()), watermark);
        self.entries.entry(key.clone()).or_default().insert(slot.clone(), value.clone());
        self.retire(&key);
        self.count("accepted");
        if message["status"] != "OK" {
            self.count("failed_results");
        }
        let mut predictions = Map::new();
        predictions.insert(slot, value);
        Some(item(&key, predictions))
    }

    /// What the model says about one live instrument right now, for a rule event triggering at this moment
    /// (events.rs writes it into the event): every slot whose newest result is OK, by its wire key ("3m_up" ...).
    /// None when no slot has a usable prediction.
    pub fn at_trigger(&self, source: &str, market: &str, trading_date: &str, session: &str, code: &str) -> Option<Value> {
        let key: Key = (source.to_lowercase(), market.to_uppercase(), trading_date.chars().take(10).collect(), session.to_uppercase(),
                        code.to_uppercase());
        let ok: Map<String, Value> = self.entries.get(&key)?.iter()
            .filter(|(_, e)| e["status"] == "OK" && e["probability"].is_number())
            .map(|(slot, e)| (slot.clone(), json!({"probability": e["probability"], "model_id": e["model_id"], "model_version": e["model_version"],
                "test_only": e["test_only"], "input_watermark": e["input_watermark"], "asof": e["asof"]})))
            .collect();
        (!ok.is_empty()).then(|| Value::Object(ok))
    }

    /// Past trading dates leave (two days behind the newest of a source/market), and the map stays bounded.
    fn retire(&mut self, key: &Key) {
        let family = (key.0.clone(), key.1.clone());
        let newest = self.newest_date.entry(family).or_default();
        if key.2 > *newest {
            newest.clone_from(&key.2);
        } else if self.entries.len() <= MAX_INSTRUMENTS {
            return;
        }
        let shift = |day: &str| market_runtime::event::shift_date(day, -2);
        let cutoffs: HashMap<(String, String), String> = self.newest_date.iter().map(|(f, d)| (f.clone(), shift(d))).collect();
        // A set, so membership below is O(log n) rather than a scan per entry.
        let mut stale: BTreeSet<Key> = self.entries.keys()
            .filter(|k| cutoffs.get(&(k.0.clone(), k.1.clone())).is_some_and(|c| k.2 < *c)).cloned().collect();
        let overflow = self.entries.len().saturating_sub(stale.len()).saturating_sub(MAX_INSTRUMENTS);
        if overflow > 0 {
            let mut keep: Vec<Key> = self.entries.keys().filter(|k| !stale.contains(*k)).cloned().collect();
            keep.sort_by(|a, b| a.2.cmp(&b.2));
            stale.extend(keep.into_iter().take(overflow));
        }
        self.forget(|k| stale.contains(k));
    }

    /// Drops entries `gone` names (Market Runtime's session rollover, retention).
    pub fn forget(&mut self, gone: impl Fn(&Key) -> bool) -> usize {
        let keys: Vec<Key> = self.entries.keys().filter(|k| gone(k)).cloned().collect();
        for key in &keys {
            *self.counts.entry("retired_entries").or_insert(0) += self.entries.remove(key).map(|e| e.len() as u64).unwrap_or(0);
        }
        self.watermarks.retain(|(k, _), _| !gone(k));
        keys.len()
    }

    /// The state the predictions were computed from was dropped (a projection reset): every one is disabled for
    /// `reason`, keeping the model that computed it; one already disabled keeps why it was.
    pub fn invalidate(&mut self, reason: &str, status: &str) -> Vec<Value> {
        self.disable_all(|_slot, value| (value["status"] != status)
            .then(|| (json!(status), json!(reason), value["model_id"].clone(), value["model_version"].clone())))
    }

    /// A config change: everything published so far is no longer what the active config computes. A slot that still
    /// runs a model is disabled as `CONFIG_CHANGED` until its next result; a slot that no longer runs one says why
    /// the new config gives (the registry's `BELOW_BASELINE`, `NO_MODEL`, `INCOMPATIBLE` ...) with the model the
    /// config names for it -- none for a slot without a model --, never the one it had before.
    pub fn follow_config(&mut self, config: Option<&ConfigView>) -> Vec<Value> {
        self.disable_all(|slot, value| {
            let (reason, model) = match config.map(|c| c.slots.get(slot)) {
                None => ("NO_CONFIG".to_string(), None),
                Some(None) => ("SLOT_NOT_ENABLED".to_string(), None),
                Some(Some(model)) => match &model.refusal {
                    None => ("CONFIG_CHANGED".to_string(), Some((value["model_id"].clone(), value["model_version"].clone()))),
                    Some(refusal) => (refusal.clone(), Some((model.model_id.clone(), model.model_version.clone()))),
                },
            };
            let (model_id, model_version) = model.unwrap_or((Value::Null, Value::Null));
            Some((json!("DISABLED"), json!(reason), model_id, model_version))
        })
    }

    /// Rewrites each entry `disabled(slot, entry)` names to that (status, reason, model_id, model_version) with no
    /// probability, and returns the items for the entries that changed.
    fn disable_all(&mut self, disabled: impl Fn(&str, &Value) -> Option<(Value, Value, Value, Value)>) -> Vec<Value> {
        let mut items = Vec::new();
        for (key, entries) in self.entries.iter_mut() {
            let mut changed = Map::new();
            for (slot, value) in entries.iter_mut() {
                let Some((status, reason, model_id, model_version)) = disabled(slot, value) else { continue };
                if (&value["status"], &value["reason"], &value["model_id"], &value["model_version"])
                    != (&status, &reason, &model_id, &model_version) || !value["probability"].is_null() {
                    value["probability"] = Value::Null;
                    value["status"] = status;
                    value["reason"] = reason;
                    value["model_id"] = model_id;
                    value["model_version"] = model_version;
                    changed.insert(slot.clone(), value.clone());
                }
            }
            if !changed.is_empty() {
                *self.counts.entry("invalidated_entries").or_insert(0) += changed.len() as u64;
                items.push(item(key, changed));
            }
        }
        self.watermarks.clear();
        items
    }

    /// Every live row, for a Market Runtime that restarted (its signal cache is empty).
    pub fn all_items(&self) -> Vec<Value> {
        self.entries.iter().map(|(key, entries)| item(key, entries.clone().into_iter().collect())).collect()
    }

    pub fn health(&self) -> Value {
        json!({"authority": AUTHORITY, "instruments": self.entries.len(), "counts": self.counts, "rejections": self.rejections})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(test_only_allowed: bool) -> ConfigView {
        let model = SlotModel { model_id: json!("builtin-test"), model_version: json!("1"), test_only: true,
                                schema_digest: "d1".into(), refusal: None };
        ConfigView { config_version: 7, test_only_allowed, slots: HashMap::from([("3m_up".to_string(), model)]) }
    }

    fn result(watermark: u64) -> Value {
        json!({"identity": {"source": "shioaji", "market": "STK", "trading_date": "2026-10-05", "session": "DAY", "code": "2330"},
               "status": "OK", "probability": 0.6, "config_version": 7, "input_watermark": watermark, "horizon_minutes": 3,
               "direction": "up", "test_only": true, "worker_epoch": 1, "generation": 1, "durable_stream_id": "s1",
               "model_id": "builtin-test", "model_version": "1", "feature_spec_digest": "d1", "expires_at_ns": 0,
               "market_cutoff_ns": 5})
    }

    #[test]
    fn a_result_without_a_whole_identity_is_refused_as_malformed() {
        let mut book = SignalBook::default();
        let cases: [(&str, Value); 4] = [
            ("code", json!({"source": "shioaji", "market": "STK", "trading_date": "2026-10-05", "session": "DAY"})),
            ("code", json!({"source": "shioaji", "market": "STK", "trading_date": "2026-10-05", "session": "DAY", "code": "  "})),
            ("market", json!({"source": "shioaji", "market": 7, "trading_date": "2026-10-05", "session": "DAY", "code": "2330"})),
            ("identity", json!("2330")),
        ];
        for (n, (field, identity)) in cases.into_iter().enumerate() {
            let mut message = result(10);
            message["identity"] = identity;
            assert!(book.accept(&message, Some(&config(true)), "s1", 0).is_none());
            assert_eq!(book.rejections["MALFORMED"], n as u64 + 1, "counted, not a silent end");
            assert!(book.last_malformed.as_deref().unwrap().contains(field), "{:?}", book.last_malformed);
        }
    }

    #[test]
    fn an_accepted_result_is_one_prediction_entry_and_the_watermark_only_moves_forward() {
        let mut book = SignalBook::default();
        let published = book.accept(&result(10), Some(&config(true)), "s1", 0).unwrap();
        assert_eq!(published["row"]["authority"], AUTHORITY);
        assert_eq!(published["row"]["model_predictions"]["3m_up"]["probability"], 0.6);
        assert_eq!(published["identity"]["code"], "2330");
        assert!(book.accept(&result(10), Some(&config(true)), "s1", 0).is_none(), "a duplicate");
        assert_eq!(book.rejections["STALE_OR_DUPLICATE"], 1);
        assert!(book.accept(&result(11), Some(&config(true)), "s1", 0).is_some());
    }

    #[test]
    fn a_trigger_sees_only_the_ok_predictions_of_its_own_instrument() {
        let mut book = SignalBook::default();
        assert!(book.at_trigger("shioaji", "STK", "2026-10-05", "DAY", "2330").is_none(), "nothing yet");
        book.accept(&result(10), Some(&config(true)), "s1", 0).unwrap();
        let model = book.at_trigger("Shioaji", "stk", "2026-10-05", "day", "2330").unwrap();
        assert_eq!(model["3m_up"]["probability"], 0.6);
        assert_eq!(model["3m_up"]["input_watermark"], 10);
        assert!(book.at_trigger("shioaji", "STK", "2026-10-05", "DAY", "2317").is_none(), "another instrument");
        let mut failed = result(11);
        failed["status"] = json!("FAILED");
        failed["reason"] = json!("predictor error");
        book.accept(&failed, Some(&config(true)), "s1", 0).unwrap();
        assert!(book.at_trigger("shioaji", "STK", "2026-10-05", "DAY", "2330").is_none(), "a failed newest result is no prediction");
    }

    #[test]
    fn every_mismatch_is_refused_and_counted() {
        let mut book = SignalBook::default();
        let refuse = |book: &mut SignalBook, message: Value, config: Option<&ConfigView>, stream: &str, now: i64, why: &str| {
            assert!(book.accept(&message, config, stream, now).is_none(), "{why}");
            assert!(book.rejections.contains_key(why), "{why}: {:?}", book.rejections);
        };
        refuse(&mut book, json!({"status": "OK"}), Some(&config(true)), "s1", 0, "MALFORMED");
        refuse(&mut book, result(1), None, "s1", 0, "NO_CONFIG");
        let mut stale = result(1);
        stale["config_version"] = json!(6);
        refuse(&mut book, stale, Some(&config(true)), "s1", 0, "STALE_CONFIG");
        let mut other = result(1);
        other["horizon_minutes"] = json!(5);
        refuse(&mut book, other, Some(&config(true)), "s1", 0, "SLOT_NOT_ENABLED");
        let mut model = result(1);
        model["model_version"] = json!("2");
        refuse(&mut book, model, Some(&config(true)), "s1", 0, "MODEL_MISMATCH");
        let mut digest = result(1);
        digest["feature_spec_digest"] = json!("d2");
        refuse(&mut book, digest, Some(&config(true)), "s1", 0, "FEATURE_SPEC_MISMATCH");
        refuse(&mut book, result(1), Some(&config(false)), "s1", 0, "TEST_ONLY_NOT_ALLOWED");
        refuse(&mut book, result(1), Some(&config(true)), "", 0, "STREAM_UNKNOWN");
        refuse(&mut book, result(1), Some(&config(true)), "s2", 0, "STREAM_MISMATCH");
        let mut late = result(1);
        late["expires_at_ns"] = json!(100);
        refuse(&mut book, late, Some(&config(true)), "s1", 101, "EXPIRED");
    }

    #[test]
    fn a_config_change_disables_what_was_published_and_a_restart_gets_every_row_again() {
        let mut book = SignalBook::default();
        book.accept(&result(10), Some(&config(true)), "s1", 0);
        assert_eq!(book.all_items().len(), 1);
        let mut next = config(true);
        next.config_version = 8;
        let items = book.follow_config(Some(&next));
        let entry = &items[0]["row"]["model_predictions"]["3m_up"];
        assert_eq!((&entry["status"], &entry["reason"], &entry["model_id"]), (&json!("DISABLED"), &json!("CONFIG_CHANGED"), &json!("builtin-test")));
        assert!(entry["probability"].is_null());
        assert!(book.follow_config(Some(&next)).is_empty(), "already disabled");
        assert_eq!(book.all_items().len(), 1);
    }

    #[test]
    fn a_slot_the_new_config_leaves_without_a_model_says_why_and_names_no_old_model() {
        let mut book = SignalBook::default();
        book.accept(&result(10), Some(&config(true)), "s1", 0);
        let mut next = config(true);
        next.config_version = 8;
        next.slots.insert("3m_up".into(), SlotModel { model_id: Value::Null, model_version: Value::Null, test_only: false,
                                                      schema_digest: "d1".into(), refusal: Some("BELOW_BASELINE".into()) });
        let items = book.follow_config(Some(&next));
        let entry = &items[0]["row"]["model_predictions"]["3m_up"];
        assert_eq!((&entry["status"], &entry["reason"]), (&json!("DISABLED"), &json!("BELOW_BASELINE")));
        assert!(entry["model_id"].is_null() && entry["model_version"].is_null() && entry["probability"].is_null(), "{entry}");
        // A slot first disabled for a config change, then left without a model, is rewritten to the new reason.
        let mut book = SignalBook::default();
        book.accept(&result(10), Some(&config(true)), "s1", 0);
        book.follow_config(Some(&config(true)));
        assert_eq!(book.follow_config(Some(&next))[0]["row"]["model_predictions"]["3m_up"]["reason"], "BELOW_BASELINE");
        next.slots.clear();
        assert_eq!(book.follow_config(Some(&next))[0]["row"]["model_predictions"]["3m_up"]["reason"], "SLOT_NOT_ENABLED");
        assert_eq!(book.follow_config(None)[0]["row"]["model_predictions"]["3m_up"]["reason"], "NO_CONFIG");
    }

    #[test]
    fn a_projection_reset_keeps_why_an_already_disabled_prediction_was_disabled() {
        let mut book = SignalBook::default();
        book.accept(&result(10), Some(&config(true)), "s1", 0);
        assert_eq!(book.invalidate("PROJECTION_RESET", "DISABLED")[0]["row"]["model_predictions"]["3m_up"]["reason"], "PROJECTION_RESET");
        assert!(book.invalidate("PROJECTION_RESET", "DISABLED").is_empty(), "already disabled");
    }

    #[test]
    fn a_result_computed_before_a_rollover_cannot_put_a_retired_signal_back() {
        // Rollover forgets the session's rows and watermarks; an inference still in flight then came
        // back and was accepted, because accept only compared config/model/stream.
        let mut book = SignalBook::default();
        assert!(book.accept(&result(10), Some(&config(true)), "s1", 0).is_some());
        book.forget(|k| k.2 == "2026-10-05");
        book.advance_epoch(2);
        assert!(book.accept(&result(11), Some(&config(true)), "s1", 0).is_none(), "worker_epoch 1 < 2");
        assert_eq!(book.rejections["STALE_WORKER_EPOCH"], 1);
        assert!(book.all_items().is_empty(), "the retired row stays retired");
        let mut current = result(12);
        current["worker_epoch"] = json!(2);
        assert!(book.accept(&current, Some(&config(true)), "s1", 0).is_some(), "the new epoch is accepted");
    }
}
