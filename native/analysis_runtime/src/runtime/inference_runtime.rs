//! Inference: the inference config file and its startup-only settings, the worker threads, scheduling, the feature capture and the inference status file.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use market_runtime::remediation;
use serde_json::{json, Value};
use crate::contract::{check_slot, slot_key, Direction, ModelState, SpecIdentity, WorkerConfig, PROTOCOL};
use crate::features::{FeatureStore, KeyId};
use crate::queue::{Pushed, Task};
use crate::{contract, features, model, signals, timing};
use super::shared::*;

pub(crate) fn sigmoid(z: f64) -> f64 {
    1.0 / (1.0 + (-z).exp())
}

/// The builtin TEST_ONLY predictor: exercises the real process, the worker queue, the signal authority's validation
/// and the publication to Market Runtime (`signals.publish`) before a formal model exists. It has no predictive meaning.
pub(crate) fn test_only_predict(config: &WorkerConfig, task: &Task, run_index: u64) -> Result<f64, String> {
    let faults = &config.test_faults;
    if faults.delay_ms > 0 {
        thread::sleep(Duration::from_millis(faults.delay_ms));
    }
    if faults.delay_jitter_ms > 0 {
        let mixed = task.task_id.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) >> 33;
        thread::sleep(Duration::from_millis(mixed % (faults.delay_jitter_ms + 1)));
    }
    if faults.crash_after_tasks > 0 && run_index >= faults.crash_after_tasks {
        eprintln!("[analysis_runtime] TEST fault: crashing after {run_index} inferences");
        let _ = io::stderr().flush();
        std::process::exit(3);
    }
    if faults.fail_every > 0 && run_index % faults.fail_every == 0 {
        return Err("TEST fault: injected predictor failure".into());
    }
    let ret = task.features.get(features::RET_1M).copied().unwrap_or(f64::NAN);
    if !ret.is_finite() {
        return Err("feature ret_1m is missing".into());
    }
    let z = ret * 2000.0 * (task.horizon_minutes as f64 / 3.0).sqrt();
    Ok(match task.direction {
        Direction::Up => sigmoid(z),
        Direction::Down => sigmoid(-z - 0.05),
    })
}

/// Load an Executable slot's verified ONNX artifact and warm it up on an all-missing row (the model must answer one).
pub(crate) fn load_onnx(check: &contract::ModelCheck) -> Result<model::OnnxModel, String> {
    let artifact = check.artifact.as_ref().ok_or("an Executable check carries its verified artifact")?;
    let loaded = model::OnnxModel::load(artifact)?;
    let missing = vec![features::MISSING_TOKEN.to_string(); features::CATEGORY_COLUMNS.len()];
    match loaded.predict(&[f64::NAN; features::NUMERIC_COLUMNS.len()], &missing) {
        Ok(p) if p.is_finite() && (0.0..=1.0).contains(&p) => Ok(loaded),
        Ok(p) => Err(format!("warm-up produced {p}")),
        Err(e) => Err(format!("warm-up failed: {e}")),
    }
}

pub(crate) fn build_active(config: WorkerConfig, spec: &SpecIdentity) -> ActiveConfig {
    let mut slots = Vec::new();
    for slot in &config.slots {
        let check = check_slot(slot, &config, spec);
        let key = slot_key(slot.horizon_minutes, slot.direction);
        let (load, load_reason) = match check.state {
            ModelState::TestOnly => {
                if config.test_faults.fail_load.contains(&key) {
                    (LoadState::LoadFailed, Some("TEST fault: injected load failure".to_string()))
                } else {
                    let probe = Task {
                        task_id: 0,
                        key: KeyId { source: "warmup".into(), market: "-".into(), trading_date: "-".into(), session: "-".into(), code: "-".into() },
                        horizon_minutes: slot.horizon_minutes, direction: slot.direction,
                        features: { let mut p = vec![0.0; features::NUMERIC_COLUMNS.len()]; p[features::RET_1M] = 0.001; p },
                        categories: vec![features::MISSING_TOKEN.to_string(); features::CATEGORY_COLUMNS.len()],
                        input_watermark: 0, generation: 0, market_cutoff_ns: 0, stream_id: String::new(), epoch: 0,
                        config_version: config.config_version, enqueued_at_ns: 0, expires_at_ns: 0,
                    };
                    let mut quiet = config.clone();
                    quiet.test_faults = Default::default();
                    match test_only_predict(&quiet, &probe, 1) {
                        Ok(p) if p.is_finite() => (LoadState::Warmed, None),
                        Ok(_) => (LoadState::LoadFailed, Some("warm-up produced a non-finite value".into())),
                        Err(e) => (LoadState::LoadFailed, Some(format!("warm-up failed: {e}"))),
                    }
                }
            }
            ModelState::Executable => match load_onnx(&check) {
                Ok(loaded) => {
                    slots.push(ActiveSlot { horizon_minutes: slot.horizon_minutes, direction: slot.direction, check, load: LoadState::Warmed,
                                            load_reason: None, model: Some(loaded) });
                    continue;
                }
                Err(reason) => (LoadState::LoadFailed, Some(reason)),
            },
            _ => (LoadState::NotLoaded, check.reason.clone()),
        };
        slots.push(ActiveSlot { horizon_minutes: slot.horizon_minutes, direction: slot.direction, check, load, load_reason, model: None });
    }
    ActiveConfig { config, slots }
}

pub(crate) fn capability_message(shared: &Shared) -> Value {
    let view = shared.view.lock().unwrap().clone();
    let Some(active) = shared.config() else {
        return json!({"type": "inference.capability", "protocol": PROTOCOL, "worker_instance": shared.instance, "config_version": null, "slots": []});
    };
    let features_state = if view.feature_warm_keys > 0 { "READY" } else if view.feature_keys > 0 { "WARMING" } else { "NO_DATA" };
    let slots: Vec<Value> = active.slots.iter().map(|slot| {
        json!({
            "key": slot_key(slot.horizon_minutes, slot.direction), "horizon_minutes": slot.horizon_minutes,
            "direction": slot.direction.as_str(), "enabled": true,
            "training_data": {"state": "NOT_EVALUATED", "reason": "judged by the training side, not the inference runtime"},
            "model": {"state": slot.check.state, "reason": slot.check.reason, "model_id": slot.check.model_id,
                      "model_version": slot.check.model_version, "label_version": slot.check.label_version, "test_only": slot.check.test_only,
                      "no_model": slot.check.no_model},
            "worker": {"state": slot.load.as_str(), "reason": slot.load_reason},
            "online_features": {"state": features_state, "spec_id": shared.spec.spec_id, "schema_digest": shared.spec.schema_digest,
                                "keys": view.feature_keys, "warm_keys": view.feature_warm_keys},
            "inference_available": slot.runnable() && view.feature_warm_keys > 0 && view.connected,
        })
    }).collect();
    json!({"type": "inference.capability", "protocol": PROTOCOL, "worker_instance": shared.instance,
           "config_version": active.config.config_version, "horizon_authority_version": active.config.horizon_authority_version, "slots": slots})
}

pub(crate) fn result_message(shared: &Shared, active: &ActiveConfig, slot: &ActiveSlot, task: &Task, status: &str, reason: Option<String>, probability: Option<f64>, timings: Value) -> Value {
    json!({
        "type": "inference.result", "protocol": PROTOCOL, "worker_instance": shared.instance, "worker_epoch": task.epoch,
        "task_id": format!("{}-{}", shared.instance, task.task_id),
        "identity": {"source": task.key.source, "market": task.key.market, "trading_date": task.key.trading_date, "session": task.key.session, "code": task.key.code},
        "durable_stream_id": task.stream_id, "generation": task.generation, "input_watermark": task.input_watermark,
        "market_cutoff_ns": task.market_cutoff_ns, "feature_spec_digest": shared.spec.schema_digest,
        "feature_version": shared.spec.feature_version, "preprocessing_version": shared.spec.preprocessing_version,
        "model_id": slot.check.model_id, "model_version": slot.check.model_version, "label_version": slot.check.label_version,
        "horizon_minutes": task.horizon_minutes, "direction": task.direction.as_str(), "config_version": active.config.config_version,
        "enqueued_at_ns": task.enqueued_at_ns, "expires_at_ns": task.expires_at_ns, "produced_at_ns": now_ns(), "timings_us": timings,
        "status": status, "reason": reason, "probability": probability, "test_only": slot.check.test_only,
    })
}

pub(crate) fn inference_loop(shared: Arc<Shared>) {
    while !shared.stop.load(Ordering::Acquire) {
        let Some(task) = shared.queue.pop(timing::WORKER_TASK_WAIT) else { continue };
        let current = |shared: &Shared, task: &Task| -> Option<Arc<ActiveConfig>> {
            let active = shared.config()?;
            (active.config.config_version == task.config_version && shared.epoch.load(Ordering::Acquire) == task.epoch).then_some(active)
        };
        let Some(active) = current(&shared, &task) else {
            continue;
        };
        let Some(slot) = active.slot(task.horizon_minutes, task.direction).filter(|s| s.runnable()) else {
            continue;
        };
        let started_ns = now_ns();
        let queue_us = ((started_ns - task.enqueued_at_ns).max(0) / 1_000) as u64;
        if started_ns > task.expires_at_ns {
            let message = result_message(&shared, &active, slot, &task, "EXPIRED", Some("task TTL passed before it ran".into()), None, json!({"queue": queue_us, "infer": 0}));
            shared.send_result(message, Some(task.expires_at_ns));
            continue;
        }
        let run_index = shared.counters.tasks_run.fetch_add(1, Ordering::Relaxed) + 1;
        let clock = Instant::now();
        let outcome = match slot.check.state {
            ModelState::TestOnly => test_only_predict(&active.config, &task, run_index),
            ModelState::Executable => match &slot.model {
                Some(loaded) => loaded.predict(&task.features, &task.categories),
                None => Err("model not loaded".into()),
            },
            _ => Err("slot has no executable model".into()),
        };
        let infer_us = clock.elapsed().as_micros() as u64;
        if current(&shared, &task).is_none() {
            continue;
        }
        let timings = json!({"queue": queue_us, "infer": infer_us});
        let message = match outcome {
            Ok(p) if p.is_finite() && (0.0..=1.0).contains(&p) => result_message(&shared, &active, slot, &task, "OK", None, Some(p), timings),
            Ok(p) => {
                result_message(&shared, &active, slot, &task, "FAILED", Some(format!("predictor returned {p}")), None, timings)
            }
            Err(reason) => {
                result_message(&shared, &active, slot, &task, "FAILED", Some(reason), None, timings)
            }
        };
        shared.send_result(message, Some(task.expires_at_ns));
    }
}

/// Inference for one live key's newest features (a replay's are its timeline's: replay_runtime).
pub(crate) fn schedule(shared: &Shared, features: &FeatureStore, key: &KeyId) {
    let Some(active) = shared.config() else { return };
    let Some(snapshot) = features.snapshot(key) else { return };
    let runnable: Vec<&ActiveSlot> = active.slots.iter().filter(|s| s.runnable() && s.covers(key)).collect();
    if runnable.is_empty() {
        return;
    }
    if !snapshot.warm {
        return;
    }
    let stream_id = shared.stream_id.lock().unwrap().clone();
    let epoch = shared.epoch.load(Ordering::Acquire);
    let now = now_ns();
    let ttl_ns = (active.config.task_ttl_ms as i64).saturating_mul(1_000_000);
    for slot in runnable {
        let task = Task {
            task_id: shared.counters.task_ids.fetch_add(1, Ordering::Relaxed) + 1, key: key.clone(),
            horizon_minutes: slot.horizon_minutes, direction: slot.direction, features: snapshot.values.clone(),
            categories: snapshot.categories.clone(),
            input_watermark: snapshot.watermark, generation: snapshot.generation, market_cutoff_ns: snapshot.cutoff_ns,
            stream_id: stream_id.clone(), epoch, config_version: active.config.config_version, enqueued_at_ns: now,
            expires_at_ns: now.saturating_add(ttl_ns),
        };
        // The queue holds one task per slot; a slot it cannot take is not left to "the next event": its result
        // says UNAVAILABLE now, through the same signal book as any other.
        let refused = task.clone();
        match shared.queue.push(task) {
            Pushed::Queued | Pushed::Coalesced => {}
            Pushed::RejectedFull => {
                let message = result_message(shared, &active, slot, &refused, "UNAVAILABLE",
                    Some("inference queue full; computed again with the next input".into()), None, json!({"queue": 0, "infer": 0}));
                shared.send_result(message, Some(refused.expires_at_ns));
            }
            Pushed::Closed => return,
        }
    }
}

/// A failed write ends the capture (recorded on stderr, rows kept so far stay in the file): retrying every sample on
/// the same broken writer would fail once per event. Like the capture itself, it comes back only with a restart.
pub(crate) fn capture_sample(shared: &Shared, features: &FeatureStore, key: &KeyId, durable_sequence: u64) {
    let mut guard = shared.capture.lock().unwrap();
    let Some((writer, path, rows, max_rows)) = guard.as_mut() else { return };
    if *rows >= *max_rows {
        return;
    }
    // Training data is the stored fold's, as a replay of the WAL rebuilds it (never an unlisted stock's fork).
    if let Some(snapshot) = features.stored_snapshot(key) {
        let line = snapshot.to_json(key, durable_sequence).to_string();
        match writer.write_all(line.as_bytes()).and_then(|_| writer.write_all(b"\n")) {
            Ok(()) => *rows += 1,
            Err(error) => {
                eprintln!("[analysis_runtime] feature capture to {path} failed after {rows} rows: {error}; capture stopped");
                *guard = None;
            }
        }
    }
}

/// Flush the capture's buffered rows; a failure ends the capture like a failed write.
pub(crate) fn flush_capture(shared: &Shared) {
    let mut guard = shared.capture.lock().unwrap();
    if let Some((writer, path, rows, _)) = guard.as_mut() {
        if let Err(error) = writer.flush() {
            eprintln!("[analysis_runtime] feature capture to {path} failed to flush after {rows} rows: {error}; capture stopped");
            *guard = None;
        }
    }
}

/// Applies one inference config; its version, or why it was refused (the running config stays).
pub(crate) fn apply_config(shared: &Arc<Shared>, message: Value, workers_started: &AtomicBool) -> Result<u64, String> {
    let config = serde_json::from_value::<WorkerConfig>(message.clone()).map_err(|e| format!("not a config: {e}"))?;
    config.validate()?;
    let startup = json!({"workers": config.workers,
        "feature_capture.max_rows": config.feature_capture.as_ref().map(|c| c.max_rows),
        "feature_capture.path": config.feature_capture.as_ref().map(|c| c.path.clone())});
    let is_first = {
        let mut first = shared.startup_only.lock().unwrap();
        let is_first = first.is_none();
        let first = first.get_or_insert_with(|| startup.clone());
        let changed: Vec<String> = startup.as_object().into_iter().flatten()
            .filter(|(key, value)| first.get(key.as_str()) != Some(value)).map(|(key, _)| key.clone()).collect();
        if !changed.is_empty() {
            eprintln!("[analysis_runtime] {} changed; startup-only, takes effect after a restart", changed.join(", "));
        }
        *shared.restart_required.lock().unwrap() = changed;
        is_first
    };
    if let (true, Some(spec)) = (is_first, &config.feature_capture) {
        match std::fs::OpenOptions::new().create(true).append(true).open(&spec.path) {
            Ok(file) => *shared.capture.lock().unwrap() = Some((std::io::BufWriter::new(file), spec.path.clone(), 0, spec.max_rows)),
            Err(error) => eprintln!("[analysis_runtime] opening the feature capture {} failed: {error}; nothing is captured", spec.path),
        }
    }
    let version = config.config_version;
    let workers = config.workers;
    shared.queue.set_capacity(config.queue_capacity);
    *shared.config.write().unwrap() = Some(Arc::new(build_active(config, &shared.spec)));
    shared.queue.retain(|task| task.config_version == version);
    shared.reschedule.store(true, Ordering::Release);
    if !workers_started.swap(true, Ordering::AcqRel) {
        for index in 0..workers {
            let s = shared.clone();
            thread::Builder::new().name(format!("infer-{index}")).spawn(move || inference_loop(s)).expect("inference thread");
        }
    }
    Ok(version)
}

/// The active config as the signal authority validates against it.
pub(crate) fn config_view(shared: &Shared) -> Option<signals::ConfigView> {
    let active = shared.config()?;
    let slots = active.slots.iter().map(|slot| (signals::prediction_key(slot.horizon_minutes as u64, slot.direction.as_str()),
        signals::SlotModel { model_id: json!(slot.check.model_id), model_version: json!(slot.check.model_version),
                             test_only: slot.check.test_only, schema_digest: shared.spec.schema_digest.clone(), refusal: slot.refusal() }))
        .collect();
    Some(signals::ConfigView { config_version: active.config.config_version, test_only_allowed: active.config.test_only_predictor, slots })
}

/// The inference config is a file model_api writes atomically (`<inference dir>/config.json`): B reads it on its own,
/// so a stopped FastAPI leaves the last config running. B looks at the file's metadata each second and reads it only
/// when it changed; every outcome -- applied (its version), refused (why; the running version stays), unreadable or
/// absent -- is B's reported config state at once, never a silent retry.
pub(crate) fn watch_inference_config(shared: Arc<Shared>, dir: Option<PathBuf>) {
    let workers_started = AtomicBool::new(false);
    let Some(dir) = dir else { return };
    let path = dir.join(INFERENCE_CONFIG_FILE);
    let mut watch = ConfigWatch::default();
    while !shared.stop.load(Ordering::Acquire) {
        let metadata = std::fs::metadata(&path).map(|meta| (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len()));
        let read = |path: &Path| std::fs::read_to_string(path);
        if let Some(state) = watch.step(metadata, || read(&path), |text| decide_config(&shared, text, &workers_started)) {
            *shared.config_state.lock().unwrap() = state;
            write_inference_status(&shared, &dir);
        }
        thread::sleep(timing::CONFIG_WATCH_INTERVAL);
    }
    watch.end();
}

/// One config file's content, judged: applied (its version) or refused for what it says.
pub(crate) fn decide_config(shared: &Arc<Shared>, text: String, workers_started: &AtomicBool) -> Result<u64, String> {
    serde_json::from_str::<Value>(&text).map_err(|e| format!("config file is not JSON: {e}"))
        .and_then(|config| if config["type"] == "config" || config.get("config_version").is_some() { Ok(config) }
                           else { Err("config file is not an inference config".to_string()) })
        .and_then(|config| apply_config(shared, config, workers_started))
}

/// What the watcher knows of the config file. A version (mtime, size) counts as seen only once its content was read
/// and judged -- applied or refused for what it says. A read that fails (a sharing violation, an antivirus or ACL lock)
/// is not a verdict: the same version is read again every second, as one recorded `analysis.inference_config_reread`,
/// until a read succeeds.
#[derive(Default)]
pub(crate) struct ConfigWatch {
    pub(crate) seen: Option<(std::time::SystemTime, u64)>,
    pub(crate) applied: Option<u64>,
    // Whether the file is gone, reported on every change of it. The artifact's state and the version still running are
    // two facts: ABSENT with an applied_version is "the file is gone; that last good version runs".
    pub(crate) artifact_absent: bool,
    pub(crate) unreadable: Option<(remediation::Operation, u64)>,
}

impl ConfigWatch {
    pub(crate) fn step(&mut self, metadata: io::Result<(std::time::SystemTime, u64)>, read: impl FnOnce() -> io::Result<String>,
            decide: impl FnOnce(String) -> Result<u64, String>) -> Option<Value> {
        match metadata {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.end_unreadable("succeeded", "the config file is gone");
                if self.artifact_absent {
                    return None;
                }
                self.artifact_absent = true;
                self.seen = None;
                Some(json!({"state": "ABSENT", "artifact": "ABSENT", "applied_version": self.applied,
                            "effective": if self.applied.is_some() { "LAST_GOOD" } else { "NONE" }, "at_ns": now_ns()}))
            }
            Err(e) => Some(self.unreadable(format!("config file metadata unreadable: {e}"))),
            Ok(signature) => {
                self.artifact_absent = false;
                if self.seen == Some(signature) {
                    return None;
                }
                let text = match read() {
                    Ok(text) => text,
                    Err(e) => return Some(self.unreadable(format!("config file unreadable: {e}"))),
                };
                self.seen = Some(signature);
                self.end_unreadable("succeeded", "read");
                Some(match decide(text) {
                    Ok(version) => {
                        self.applied = Some(version);
                        json!({"state": "APPLIED", "applied_version": version, "at_ns": now_ns()})
                    }
                    Err(reason) => {
                        eprintln!("[analysis_runtime] inference config refused: {reason}");
                        json!({"state": "REJECTED", "reason": reason, "applied_version": self.applied, "at_ns": now_ns()})
                    }
                })
            }
        }
    }

    /// The file is there but cannot be read now: the running version stays, the read is tried again next turn.
    pub(crate) fn unreadable(&mut self, reason: String) -> Value {
        eprintln!("[analysis_runtime] inference config {reason}; read again in 1 s");
        match &mut self.unreadable {
            Some((_, attempts)) => *attempts += 1,
            None => {
                let operation = remediation::begin("config_watch", "analysis.inference_config_reread", "config_unreadable",
                    remediation::Identity::default(), json!({"reason": reason, "applied_version": self.applied}));
                self.unreadable = Some((operation, 1));
            }
        }
        json!({"state": "UNREADABLE", "reason": reason, "applied_version": self.applied, "at_ns": now_ns()})
    }

    pub(crate) fn end_unreadable(&mut self, outcome: &str, how: &str) {
        if let Some((mut operation, attempts)) = self.unreadable.take() {
            operation.finish(outcome, Some(attempts), json!({"ended_by": how, "applied_version": self.applied}));
        }
    }

    /// B is stopping: a read still failing ends unrecovered.
    pub(crate) fn end(&mut self) {
        self.end_unreadable("abandoned", "analysis_runtime stopped");
    }
}

pub(crate) const INFERENCE_CONFIG_FILE: &str = "config.json";

pub(crate) const INFERENCE_STATUS_FILE: &str = "status.json";

/// What model_api's status routes read: the capability (per slot) and the signal authority's health.
pub(crate) fn write_inference_status(shared: &Shared, dir: &Path) {
    let body = json!({"schema": "analysis-inference-status-v1", "written_at_ns": now_ns(), "worker_instance": shared.instance,
                      "feature_spec": {"spec_id": shared.spec.spec_id, "schema_digest": shared.spec.schema_digest,
                                       "feature_version": shared.spec.feature_version, "preprocessing_version": shared.spec.preprocessing_version},
                      "capability": capability_message(shared), "signals": shared.signals_health.lock().unwrap().clone(),
                      "config": shared.config_state.lock().unwrap().clone(),
                      "restart_required": shared.restart_required.lock().unwrap().clone()});
    let path = dir.join(INFERENCE_STATUS_FILE);
    let written = std::fs::create_dir_all(dir).and_then(|_| market_runtime::fsutil::atomic_write(&path, body.to_string().as_bytes()));
    if let Err(e) = written {
        STATUS_WRITE_FAILURES.record("inference status", &path, &e);
    }
}

/// Failed writes of the inference status file: counted and logged, shown in metrics.
pub(crate) static STATUS_WRITE_FAILURES: market_runtime::fsutil::WriteFailures = market_runtime::fsutil::WriteFailures::new();
