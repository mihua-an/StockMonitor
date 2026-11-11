//! Inference contract v1. The FeatureSpec lives only here (spec/feature_spec_online_v3.json, embedded); the training
//! side (service/analysis/inference/contract.py, online_training/) learns its identity from this binary and copies
//! it into the dataset and model manifests. Shared fixtures: tests/fixtures/inference_contract/.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use market_runtime::sha256;

pub const PROTOCOL: &str = "analysis-worker-v1";
pub const FEATURE_SPEC_SCHEMA: &str = "feature-spec-v1";
pub const MODEL_MANIFEST_SCHEMA: &str = "model-manifest-v1";

/// sha256 over the canonical form: sorted keys, no whitespace, UTF-8. serde_json's default Map
/// is a BTreeMap, so `to_string` IS the sorted canonical form -- the fixture test pins that.
pub fn schema_digest(spec: &Value) -> String {
    let mut body = spec.clone();
    if let Some(map) = body.as_object_mut() {
        map.remove("schema_digest");
    }
    sha256::hex(serde_json::to_string(&body).unwrap_or_default().as_bytes())
}

/// The online-v3 FeatureSpec. Its `schema_digest` field must equal the digest of its content (checked at startup
/// and by the test below, which prints the right value), so an edit that forgets the digest cannot ship.
pub fn online_v3_feature_spec() -> Value {
    serde_json::from_str(include_str!("../spec/feature_spec_online_v3.json")).expect("embedded online-v3 spec")
}

/// The identity of the one FeatureSpec this build can compute online.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecIdentity {
    pub spec_id: String,
    pub schema_digest: String,
    pub feature_version: String,
    pub preprocessing_version: String,
}

impl SpecIdentity {
    pub fn of(spec: &Value) -> Self {
        let text = |name: &str| spec.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
        Self {
            spec_id: text("spec_id"),
            schema_digest: text("schema_digest"),
            feature_version: text("feature_version"),
            preprocessing_version: text("preprocessing_version"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Up => "up",
            Direction::Down => "down",
        }
    }
}

pub fn slot_key(horizon_minutes: u32, direction: Direction) -> String {
    format!("{horizon_minutes}m_{}", direction.as_str())
}

// ------------------------------------------------------------------------------ supervisor input

/// Fault injection for TEST_ONLY runs. Honoured only when `test_only_predictor` is set, so a
/// production config can never carry a fault into a real model.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TestFaults {
    #[serde(default)]
    pub delay_ms: u64,
    /// Every n-th inference fails (0 = never).
    #[serde(default)]
    pub fail_every: u64,
    /// The process exits with code 3 after this many inferences (0 = never).
    #[serde(default)]
    pub crash_after_tasks: u64,
    /// Slot keys ("3m_up") whose load/warm-up fails.
    #[serde(default)]
    pub fail_load: Vec<String>,
    /// 1-based ordinals of durable events, counted as the worker RECEIVES them, that are dropped
    /// before the cursor sees them -- a transport loss. The stream itself is untouched: the cursor
    /// must detect the gap and the base protocol's replay must fill it.
    #[serde(default)]
    pub drop_events: Vec<u64>,
    /// Extra random delay per inference, 0..=this many ms, so several workers finish out of order.
    #[serde(default)]
    pub delay_jitter_ms: u64,
}

impl TestFaults {
    pub fn is_empty(&self) -> bool {
        self.delay_ms == 0 && self.fail_every == 0 && self.crash_after_tasks == 0 && self.fail_load.is_empty()
            && self.drop_events.is_empty() && self.delay_jitter_ms == 0
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SlotConfig {
    pub horizon_minutes: u32,
    pub direction: Direction,
    /// The model manifest for this slot, or none. The manifest's own directory resolves its
    /// relative artifact path.
    #[serde(default)]
    pub manifest: Option<Value>,
    #[serde(default)]
    pub manifest_dir: Option<String>,
    /// Why a slot without a manifest has no model, as the model registry decided it (e.g. `BELOW_BASELINE`): B
    /// reports it as given and never infers one.
    #[serde(default)]
    pub no_model: Option<NoModel>,
}

/// The model registry's statement that a slot has no model: its state code and a readable reason.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct NoModel {
    pub state: String,
    pub reason: String,
}

/// Diagnostic capture of every online feature sample, for offline/online parity. Bounded; written
/// only when configured. Not a TEST fault: formal-data parity uses it too.
#[derive(Debug, Clone, Deserialize)]
pub struct FeatureCapture {
    pub path: String,
    #[serde(default = "default_capture_rows")]
    pub max_rows: u64,
}

fn default_capture_rows() -> u64 {
    1_000_000
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerConfig {
    pub config_version: u64,
    pub horizon_authority_version: u64,
    pub allowed_minutes: Vec<u32>,
    pub slots: Vec<SlotConfig>,
    #[serde(default)]
    pub test_only_predictor: bool,
    #[serde(default)]
    pub test_faults: TestFaults,
    pub queue_capacity: usize,
    pub workers: usize,
    pub task_ttl_ms: u64,
    #[serde(default)]
    pub feature_capture: Option<FeatureCapture>,
}

impl WorkerConfig {
    /// Refuses a config the worker must not run, rather than repairing it.
    pub fn validate(&self) -> Result<(), String> {
        if self.config_version == 0 {
            return Err("config_version must be positive".into());
        }
        if self.allowed_minutes.iter().any(|m| *m <= 1) {
            return Err("1-minute prediction is not an allowed horizon".into());
        }
        let mut seen = std::collections::HashSet::new();
        for slot in &self.slots {
            if !self.allowed_minutes.contains(&slot.horizon_minutes) {
                return Err(format!("slot {} is not an allowed horizon", slot_key(slot.horizon_minutes, slot.direction)));
            }
            // Two entries for one (horizon, direction) left which model runs to lookup order. The whole
            // config is refused instead of picking one.
            if !seen.insert((slot.horizon_minutes, slot.direction)) {
                return Err(format!("slot {} appears more than once", slot_key(slot.horizon_minutes, slot.direction)));
            }
        }
        if !(1..=65_536).contains(&self.queue_capacity) {
            return Err("queue_capacity must be 1..=65536".into());
        }
        if !(1..=8).contains(&self.workers) {
            return Err("workers must be 1..=8".into());
        }
        if self.task_ttl_ms == 0 {
            return Err("task_ttl_ms must be positive".into());
        }
        if !self.test_only_predictor && !self.test_faults.is_empty() {
            return Err("test faults are only allowed with the TEST_ONLY predictor".into());
        }
        Ok(())
    }
}

// ----------------------------------------------------------------------------- model manifests

/// Why one slot can or cannot run a model. Kept separate from worker load state and from
/// online-feature readiness: each advances on its own, so none waits for an overall READY.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModelState {
    /// A real (ONNX) model this build can execute.
    Executable,
    /// The builtin TEST_ONLY predictor. Never a formal model.
    TestOnly,
    NoModel,
    Incompatible,
    UnsupportedFormat,
    ArtifactMissing,
}

#[derive(Debug, Clone)]
pub struct ModelCheck {
    pub state: ModelState,
    pub reason: Option<String>,
    pub model_id: Option<String>,
    pub model_version: Option<String>,
    pub label_version: Option<String>,
    pub test_only: bool,
    /// An Executable ONNX slot's artifact as it was verified: what the runtime loads.
    pub artifact: Option<crate::model::ValidatedArtifact>,
    /// A NoModel slot's reason as the config's owner stated it; None when it stated none.
    pub no_model: Option<NoModel>,
}

impl ModelCheck {
    /// The code a slot that cannot run is reported under: the registry's own state for a slot it left without a
    /// model, else this check's state.
    pub fn refusal_code(&self) -> String {
        match (&self.state, &self.no_model) {
            (ModelState::NoModel, Some(no_model)) => no_model.state.clone(),
            (state, _) => serde_json::to_value(state).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
        }
    }
}

pub const BUILTIN_TEST_MODEL_ID: &str = "builtin-test-only";
pub const BUILTIN_TEST_MODEL_VERSION: &str = "test-2";

fn text(value: &Value, path: &[&str]) -> Option<String> {
    let mut cur = value;
    for part in path {
        cur = cur.get(*part)?;
    }
    cur.as_str().map(str::to_string)
}

/// Judge one slot's manifest against this build: the allowed horizons, the slot it is bound to,
/// the one FeatureSpec this build computes, and the artifact formats it can execute.
pub fn check_slot(slot: &SlotConfig, config: &WorkerConfig, spec: &SpecIdentity) -> ModelCheck {
    let refuse = |state: ModelState, reason: String, manifest: Option<&Value>| ModelCheck {
        state,
        reason: Some(reason),
        model_id: manifest.and_then(|m| text(m, &["model_id"])),
        model_version: manifest.and_then(|m| text(m, &["model_version"])),
        label_version: manifest.and_then(|m| text(m, &["label_version"])),
        test_only: false,
        artifact: None,
        no_model: None,
    };
    let Some(manifest) = slot.manifest.as_ref() else {
        if config.test_only_predictor {
            return ModelCheck {
                state: ModelState::TestOnly,
                reason: Some("builtin TEST_ONLY predictor; not a formal model".into()),
                model_id: Some(BUILTIN_TEST_MODEL_ID.into()),
                model_version: Some(BUILTIN_TEST_MODEL_VERSION.into()),
                label_version: Some("none".into()),
                test_only: true,
                artifact: None,
                no_model: None,
            };
        }
        let reason = slot.no_model.as_ref().map(|n| n.reason.clone())
            .unwrap_or_else(|| "no model manifest registered for this horizon/direction".into());
        return ModelCheck { no_model: slot.no_model.clone(), ..refuse(ModelState::NoModel, reason, None) };
    };
    let m = Some(manifest);
    if text(manifest, &["schema"]).as_deref() != Some(MODEL_MANIFEST_SCHEMA) {
        return refuse(ModelState::Incompatible, format!("manifest schema is not {MODEL_MANIFEST_SCHEMA}"), m);
    }
    let horizon = manifest.get("horizon_minutes").and_then(Value::as_u64).map(|h| h as u32);
    let direction = text(manifest, &["direction"]);
    if horizon != Some(slot.horizon_minutes) || direction.as_deref() != Some(slot.direction.as_str()) {
        return refuse(
            ModelState::Incompatible,
            format!("manifest is for {:?}/{:?}, slot is {}", horizon, direction, slot_key(slot.horizon_minutes, slot.direction)),
            m,
        );
    }
    if manifest.get("horizon_authority_version").and_then(Value::as_u64) != Some(config.horizon_authority_version) {
        return refuse(ModelState::Incompatible, "manifest horizon_authority_version differs from the active authority".into(), m);
    }
    let digest = text(manifest, &["feature_spec", "schema_digest"]).unwrap_or_default();
    if digest != spec.schema_digest {
        return refuse(
            ModelState::Incompatible,
            format!("feature spec digest {digest} is not one this worker build computes ({})", spec.schema_digest),
            m,
        );
    }
    let test_only = manifest.get("test_only").and_then(Value::as_bool).unwrap_or(false);
    match text(manifest, &["artifact", "format"]).as_deref() {
        Some("builtin-test") => {
            if !(test_only && config.test_only_predictor) {
                return refuse(ModelState::Incompatible, "builtin-test artifact requires test_only on both manifest and config".into(), m);
            }
            ModelCheck {
                state: ModelState::TestOnly,
                reason: Some("builtin TEST_ONLY predictor; not a formal model".into()),
                model_id: text(manifest, &["model_id"]),
                model_version: text(manifest, &["model_version"]),
                label_version: text(manifest, &["label_version"]),
                test_only: true,
                artifact: None,
                no_model: None,
            }
        }
        Some("onnx") => {
            let Some(artifact) = text(manifest, &["artifact", "path"]).filter(|p| !p.is_empty()) else {
                return refuse(ModelState::ArtifactMissing, "manifest names no artifact path".into(), m);
            };
            let path = std::path::Path::new(slot.manifest_dir.as_deref().unwrap_or(".")).join(&artifact);
            let validated = match crate::model::ValidatedArtifact::read(&path, manifest) {
                Ok(validated) => validated,
                Err(crate::model::ArtifactRefusal::Missing(reason)) => return refuse(ModelState::ArtifactMissing, reason, m),
                Err(crate::model::ArtifactRefusal::Incompatible(reason)) => return refuse(ModelState::Incompatible, reason, m),
            };
            ModelCheck {
                state: ModelState::Executable,
                reason: None,
                model_id: text(manifest, &["model_id"]),
                model_version: text(manifest, &["model_version"]),
                label_version: text(manifest, &["label_version"]),
                test_only: false,
                artifact: Some(validated),
                no_model: None,
            }
        }
        other => refuse(ModelState::UnsupportedFormat, format!("artifact format {other:?} is not supported"), m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/inference_contract").join(name)
    }

    #[test]
    fn the_embedded_spec_hashes_to_its_own_digest() {
        let spec = online_v3_feature_spec();
        assert_eq!(spec["schema_digest"].as_str().unwrap(), schema_digest(&spec), "update schema_digest in the spec file");
        let numeric: Vec<String> = spec["columns"].as_array().unwrap().iter()
            .filter(|c| c["dtype"] == "f64").map(|c| c["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(numeric, crate::features::NUMERIC_COLUMNS.to_vec(), "features.rs column order differs from the spec");
        let categories: Vec<&str> = spec["category_columns"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(categories, crate::features::CATEGORY_COLUMNS.to_vec(), "features.rs category columns differ from the spec");
    }

    #[test]
    fn a_reordered_column_list_is_a_different_spec() {
        let spec = online_v3_feature_spec();
        let mut swapped = spec.clone();
        swapped["columns"].as_array_mut().unwrap().swap(0, 1);
        assert_ne!(schema_digest(&spec), schema_digest(&swapped));
    }

    fn config(test_only: bool) -> WorkerConfig {
        serde_json::from_value(json!({
            "config_version": 1, "horizon_authority_version": 1, "allowed_minutes": [3,5,10,15,30],
            "slots": [], "test_only_predictor": test_only, "queue_capacity": 8, "workers": 1,
            "task_ttl_ms": 1000
        })).unwrap()
    }

    #[test]
    fn manifest_checks_are_specific() {
        let spec = SpecIdentity::of(&online_v3_feature_spec());
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(fixture("model_manifest_onnx_example.json")).unwrap()).unwrap();
        let slot = |h: u32, d: Direction, m: Option<Value>| SlotConfig { horizon_minutes: h, direction: d, manifest: m, manifest_dir: Some(fixture("").display().to_string()), no_model: None };

        assert_eq!(check_slot(&slot(3, Direction::Up, None), &config(false), &spec).state, ModelState::NoModel);
        assert_eq!(check_slot(&slot(3, Direction::Up, None), &config(true), &spec).state, ModelState::TestOnly);
        // Bound to 3m_up: refused on any other slot, never silently re-used.
        assert_eq!(check_slot(&slot(5, Direction::Up, Some(manifest.clone())), &config(false), &spec).state, ModelState::Incompatible);
        assert_eq!(check_slot(&slot(3, Direction::Down, Some(manifest.clone())), &config(false), &spec).state, ModelState::Incompatible);
        // The fixture names an artifact that does not exist.
        assert_eq!(check_slot(&slot(3, Direction::Up, Some(manifest.clone())), &config(false), &spec).state, ModelState::ArtifactMissing);
        let mut other_spec = manifest.clone();
        other_spec["feature_spec"]["schema_digest"] = json!("f".repeat(64));
        assert_eq!(check_slot(&slot(3, Direction::Up, Some(other_spec)), &config(false), &spec).state, ModelState::Incompatible);
    }

    #[test]
    fn a_slot_the_registry_left_without_a_model_carries_its_reason() {
        let spec = SpecIdentity::of(&online_v3_feature_spec());
        let slot: SlotConfig = serde_json::from_value(json!({"horizon_minutes": 5, "direction": "up",
            "no_model": {"state": "BELOW_BASELINE", "reason": "not below the constant baseline"}})).unwrap();
        let check = check_slot(&slot, &config(false), &spec);
        assert_eq!((check.state.clone(), check.refusal_code()), (ModelState::NoModel, "BELOW_BASELINE".to_string()));
        assert_eq!((check.reason.as_deref(), check.model_id), (Some("not below the constant baseline"), None));
        let bare = SlotConfig { no_model: None, ..slot };
        assert_eq!(check_slot(&bare, &config(false), &spec).refusal_code(), "NO_MODEL");
    }

    #[test]
    fn one_minute_prediction_is_refused() {
        let mut c = config(true);
        c.allowed_minutes = vec![1, 3];
        assert!(c.validate().is_err());
        let mut c = config(true);
        c.slots = vec![SlotConfig { horizon_minutes: 10, direction: Direction::Up, manifest: None, manifest_dir: None, no_model: None }];
        c.allowed_minutes = vec![3, 5];
        assert!(c.validate().is_err());
    }

    #[test]
    fn a_slot_listed_twice_refuses_the_whole_config() {
        let mut c = config(true);
        c.allowed_minutes = vec![3, 5];
        let slot = |m, d| SlotConfig { horizon_minutes: m, direction: d, manifest: None, manifest_dir: None, no_model: None };
        c.slots = vec![slot(3, Direction::Up), slot(3, Direction::Down), slot(5, Direction::Up)];
        assert!(c.validate().is_ok());
        c.slots.push(slot(3, Direction::Up));
        assert!(c.validate().unwrap_err().contains("3m_up appears more than once"));
    }
}
