//! 歷史回放: the analysis timeline of every recorded partition Market Runtime opens.
//!
//! The timeline (market_runtime::timeline) is this analysis at every step of the recorded day -- projection blocks
//! and model predictions -- built once from the partition itself and sent to Market Runtime span by span, which then
//! shows the analysis of exactly the step the replay stands on, at a seek or a played step alike, without asking B
//! anything. The day is folded once in order, keeping the engine at every span's start; each span is then built from
//! there on worker threads at the lowest priority Windows schedules (they take only CPU nothing else wants: the live
//! market and every other program go first), the span nearest the replay's position first.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;
use market_runtime::event::{MarketEvent, CLOCK_CODE};
use market_runtime::replay::{Partition, CACHE_IDLE, CACHE_RECORDINGS};
use market_runtime::timeline::{self, SpanBuilder, Step};
use market_runtime::remediation;
use serde_json::{json, Map, Value};
use crate::contract::ModelState;
use crate::day_context::ContextSource;
use crate::features::{FeatureImage, FeatureSnapshot, FeatureStore, Folded, KeyId};
use crate::{engine, persist, signals};
use super::{shared::*, inference_runtime::*, stream_runtime::*};

/// The engine at a span's first step (taken by the worker that builds the span).
struct Checkpoint {
    engine: engine::Engine,
    features: FeatureImage,
}

/// The spans' checkpoints as the fold keeps them, and which the workers took.
#[derive(Default)]
struct Work {
    checkpoints: Vec<Option<Checkpoint>>,
    taken: Vec<bool>,
    /// Every span's checkpoint is kept (the fold is done).
    folded: bool,
}

/// The build of the recording the open replay plays: every other build waits while it is under way, so the CPU they
/// would share goes to the timeline the user is looking at (three stocks opened in a row built at once took 2303's
/// timeline from 28 s to 50 s). A build that is not the foreground's carries on once it is done, let go, or another
/// recording becomes the foreground.
#[derive(Default)]
pub(crate) struct Foreground {
    build: Mutex<Option<Arc<TimelineBuild>>>,
    changed: Condvar,
}

impl Foreground {
    pub(crate) fn set(&self, build: Option<Arc<TimelineBuild>>) {
        *self.build.lock().unwrap_or_else(|e| e.into_inner()) = build;
        self.changed.notify_all();
    }

    /// Wait while another build under way is the foreground (or until `me` is let go).
    fn wait_turn(&self, me: &TimelineBuild) {
        let mut held = self.build.lock().unwrap_or_else(|e| e.into_inner());
        while held.as_ref().is_some_and(|b| b.key != me.key && b.running()) && !me.abandoned.load(Ordering::Relaxed) {
            held = self.changed.wait(held).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// A build ended or was let go: the builds waiting on it look again.
    fn wake(&self) {
        let _held = self.build.lock().unwrap_or_else(|e| e.into_inner());
        self.changed.notify_all();
    }
}

/// One recorded partition's timeline being built: its spans go out through `outbox` as they are done.
pub(crate) struct TimelineBuild {
    /// The partition, its content and the analysis it is built under (rules, calendar, models).
    pub(crate) key: String,
    /// The recording as Market Runtime named it (`events_path`, `content_hash`).
    pub(crate) recording: Value,
    pub(crate) version: String,
    /// The step the replay stands on: the span holding it is built first, then the nearest.
    focus: AtomicUsize,
    spans: AtomicUsize,
    done: AtomicUsize,
    ended: AtomicBool,
    abandoned: AtomicBool,
    work: Mutex<Work>,
    ready: Condvar,
    /// Step ranges Market Runtime already holds of this analysis: their spans are not built again.
    held: Vec<(usize, usize)>,
    foreground: Arc<Foreground>,
}

impl TimelineBuild {
    pub(crate) fn ended(&self) -> bool {
        self.ended.load(Ordering::Acquire)
    }

    pub(crate) fn running(&self) -> bool {
        !self.ended() && !self.abandoned.load(Ordering::Relaxed)
    }

    pub(crate) fn abandon(&self) {
        self.abandoned.store(true, Ordering::Relaxed);
        self.ready.notify_all();
        self.foreground.wake();
    }

    /// The build is over, however it ended: the builds waiting on it look again.
    fn end(&self) {
        self.ended.store(true, Ordering::Release);
        self.foreground.wake();
    }

    /// Spans built and sent so far.
    #[cfg(test)]
    pub(crate) fn spans_done(&self) -> usize {
        self.done.load(Ordering::Relaxed)
    }

    pub(crate) fn set_focus(&self, step: usize) {
        self.focus.store(step, Ordering::Relaxed);
    }

    pub(crate) fn wire(&self) -> Value {
        json!({"key": self.key, "spans": self.spans.load(Ordering::Relaxed), "done": self.done.load(Ordering::Relaxed), "ended": self.ended()})
    }

    /// Read the partition, fold the day keeping every span's checkpoint, and build the spans on `workers` threads, the
    /// model's predictions by `models` (the inference config as the build started: `version` names it).
    fn run(&self, models: Option<Arc<ActiveConfig>>, template: engine::Engine, context: ContextSource, workers: usize, outbox: &Mutex<VecDeque<String>>) {
        // The fold too takes only CPU nothing else wants (the live market and every other program go first).
        lowest_priority();
        let started = Instant::now();
        let path = PathBuf::from(self.recording["events_path"].as_str().unwrap_or_default());
        let loaded = market_runtime::replay::load(&path).and_then(|loaded| {
            let wanted = self.recording["content_hash"].as_str().unwrap_or_default();
            if loaded.committed.content_hash != wanted {
                return Err(format!("the partition's content is {}, Market Runtime replays {wanted}", loaded.committed.content_hash));
            }
            let first = loaded.events.first().ok_or("the partition holds no events")?;
            let partition = Partition::new(&first.provider, &first.market, &first.code, &first.trading_date, &first.session)?;
            Ok((loaded, partition))
        });
        let (loaded, partition) = match loaded {
            Ok(read) => read,
            Err(reason) => {
                // Recorded: the replay then shows no analysis (its views say so), never a guess.
                eprintln!("[analysis_runtime] replay timeline of {}: not built: {reason}", path.display());
                self.end();
                return;
            }
        };
        let steps = timeline::steps(&loaded.events, &loaded.due);
        let len = timeline::span_len(steps.len()).max(1);
        let spans = steps.len().div_ceil(len);
        self.spans.store(spans, Ordering::Release);
        {
            let mut work = self.work.lock().unwrap_or_else(|e| e.into_inner());
            work.checkpoints = (0..spans).map(|_| None).collect();
            work.taken = (0..spans).map(|k| {
                let (a, b) = (k * len, ((k + 1) * len).min(steps.len()));
                self.held.iter().any(|(from, to)| *from <= a && b <= *to)
            }).collect();
        }
        let events = &loaded.events;
        let (steps, partition, context, models) = (&steps, &partition, &context, &models);
        std::thread::scope(|scope| {
            for n in 0..workers {
                let spawned = std::thread::Builder::new().name(format!("replay-timeline-{n}")).spawn_scoped(scope, move || {
                    lowest_priority();
                    while let Some((k, checkpoint)) = self.next_span(len) {
                        if let Some(span) = self.build_span(models, k * len, len, checkpoint, events, steps, partition, context) {
                            let message = json!({"type": "replay.timeline", "payload": {"recording": self.recording, "version": self.version, "span": span}});
                            outbox.lock().unwrap_or_else(|e| e.into_inner()).push_back(message.to_string());
                            self.done.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                });
                if let Err(e) = spawned {
                    eprintln!("[analysis_runtime] replay timeline of {}: worker {n} not started: {e}", path.display());
                }
            }
            // The fold: the engine at every span's first step, each usable by a worker the moment it is kept.
            let mut engine = template;
            let mut features = FeatureStore::with_context(context.clone());
            for (i, step) in steps.iter().enumerate() {
                if self.abandoned.load(Ordering::Relaxed) {
                    break;
                }
                if i % len == 0 {
                    self.foreground.wait_turn(self);
                    let mut work = self.work.lock().unwrap_or_else(|e| e.into_inner());
                    work.checkpoints[i / len] = Some(Checkpoint { engine: engine.clone(), features: features.image() });
                    drop(work);
                    self.ready.notify_all();
                }
                let event = timeline::step_event(partition, events, step);
                // The rule events are evaluated as the data applies (Engine::apply), the same in this fold as in a
                // span that collects after every step: a checkpoint starts its span with the events the step before
                // it ended with.
                engine.apply(&event);
                if event.code != CLOCK_CODE {
                    features.fold(&event);
                }
            }
            self.work.lock().unwrap_or_else(|e| e.into_inner()).folded = true;
            self.ready.notify_all();
        });
        self.end();
        eprintln!("[analysis_runtime] replay timeline of {}: {} steps, {} of {spans} spans in {} ms ({})", path.display(), steps.len(),
                  self.done.load(Ordering::Relaxed), started.elapsed().as_millis(),
                  if self.abandoned.load(Ordering::Relaxed) { "let go" } else { "done" });
    }

    /// The span to build next -- the kept one nearest the focus -- or None once none is left (or the build was let go).
    fn next_span(&self, len: usize) -> Option<(usize, Checkpoint)> {
        self.foreground.wait_turn(self);
        let mut work = self.work.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if self.abandoned.load(Ordering::Relaxed) {
                return None;
            }
            let focus = self.focus.load(Ordering::Relaxed) / len;
            let best = (0..work.checkpoints.len()).filter(|k| !work.taken[*k] && work.checkpoints[*k].is_some())
                .min_by_key(|k| k.abs_diff(focus));
            if let Some(k) = best {
                work.taken[k] = true;
                return work.checkpoints[k].take().map(|c| (k, c));
            }
            if work.folded {
                return None;
            }
            work = self.ready.wait(work).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// One span, step by step from its checkpoint: the analysis at its first step and what every step changed, with
    /// the model's predictions (every key at the span's start, then a key whose features changed at most once a
    /// market second). None when the build was let go meanwhile.
    #[allow(clippy::too_many_arguments)]
    fn build_span(&self, models: &Option<Arc<ActiveConfig>>, first: usize, len: usize, checkpoint: Checkpoint, events: &[MarketEvent],
                  steps: &[Step], partition: &Partition, context: &ContextSource) -> Option<Value> {
        let end = (first + len).min(steps.len());
        let Checkpoint { mut engine, features } = checkpoint;
        let mut features = FeatureStore::from_image(features, context.clone());
        let models = Models { active: models.clone() };
        let mut items = shown(engine.collect(true, first as u64, None));
        let mut known: HashSet<Value> = items.iter().map(|item| item["identity"].clone()).collect();
        let mut predicted: HashMap<KeyId, i64> = HashMap::new();
        let second = |step: usize| steps[step.min(steps.len() - 1)].due_ns.div_euclid(1_000_000_000);
        for key in features.key_ids() {
            if let Some(item) = models.item(&features, &key, first as u64) {
                items.push(item);
                predicted.insert(key, second(first));
            }
        }
        items.iter_mut().for_each(replay_shown);
        let mut span = SpanBuilder::new(first, items);
        let mut pending: HashSet<KeyId> = HashSet::new();
        for (step, at) in steps.iter().enumerate().take(end).skip(first) {
            if self.abandoned.load(Ordering::Relaxed) {
                return None;
            }
            let event = timeline::step_event(partition, events, at);
            engine.apply(&event);
            let mut out = shown(engine.collect_step(step as u64 + 1));
            // An instrument's first step publishes all its blocks, as a full publish holds them (an events block with no
            // event yet included): the timeline at any position is what a full publish there says.
            if out.iter().any(|item| !known.contains(&item["identity"])) {
                out = shown(engine.collect(true, step as u64 + 1, None));
                known.extend(out.iter().map(|item| item["identity"].clone()));
            }
            if event.code != CLOCK_CODE {
                if let (Folded::Changed(key), _) = features.fold(&event) {
                    pending.insert(key);
                }
            }
            let now = second(step);
            let due: Vec<KeyId> = pending.iter().filter(|k| predicted.get(*k).is_none_or(|s| *s < now)).cloned().collect();
            for key in due {
                pending.remove(&key);
                if let Some(item) = models.item(&features, &key, step as u64 + 1) {
                    out.push(item);
                    predicted.insert(key, now);
                }
            }
            out.iter_mut().for_each(replay_shown);
            span.step(step, out);
        }
        Some(span.wire(end - first))
    }
}

/// What a replay timeline keeps of a published item: the fields the 歷史回放 page shows (engine_replay.js view models,
/// the trade-flow, price-ladder and technical-analysis components it mounts). The rest -- the step's time and
/// watermark repeated in every block (`day.as_of_ns` stays: the step's one time), the rolling windows' prices and
/// volumes, the flow ratios and counts nothing draws, the day's flow and diagnostics, the minutes' flow and
/// bookkeeping, the predictions' input time -- changes at nearly every step and was 3/4 of a day's timeline.
pub(super) fn replay_shown(item: &mut Value) {
    fn remove(v: &mut Value, keys: &[&str]) {
        if let Some(o) = v.as_object_mut() {
            for k in keys {
                o.remove(*k);
            }
        }
    }
    remove(item, &["as_of", "input_watermark"]);
    let block = item["block"].as_str().unwrap_or("").to_string();
    let Some(data) = item.get_mut("data") else { return };
    match block.as_str() {
        "windows" => {
            remove(data, &["as_of_ns", "k", "volume_compare"]);
            for window in data.get_mut("windows").and_then(Value::as_object_mut).into_iter().flat_map(|w| w.values_mut()) {
                // The 買賣比 tab's 近N分 column: each size's buy and sell, and their ratios.
                let flow = window.get("flow").map(|flow| {
                    let side = |size: &str| -> Value {
                        let s = &flow[size];
                        json!({"buy": s["buy"], "sell": s["sell"], "buy_ratio": s["buy_ratio"], "sell_ratio": s["sell_ratio"]})
                    };
                    json!({"large": side("large"), "small": side("small")})
                });
                *window = match flow {
                    Some(flow) => json!({"flow": flow}),
                    None => json!({}),
                };
            }
        }
        "flow" => {
            for row in data.get_mut("largeOrders").and_then(Value::as_array_mut).into_iter().flatten() {
                remove(row, &["exchange_ts_ns", "large_reason", "episode_id"]);
            }
            if let Some(totals) = data.get_mut("totals") {
                remove(totals, &["total", "unclassified"]);
                for size in ["large", "small"] {
                    if let Some(s) = totals.get_mut(size) {
                        remove(s, &["count", "net", "net_ratio", "unknown", "unknown_ratio"]);
                    }
                }
                if let Some(s) = totals.get_mut("small") {
                    remove(s, &["class_ratio"]);
                }
            }
        }
        "day" => remove(data, &["flow", "diagnostics", "open", "high", "low", "close", "volume", "volume_complete", "reference_price",
                              "close_change", "close_change_pct", "open_to_close"]),
        "minutes" => {
            for record in data.get_mut("minutes").and_then(Value::as_array_mut).into_iter().flatten() {
                remove(record, &["flow", "input_sequence", "revision", "revised_after_final", "unattributed_volume", "total_volume_complete",
                               "authority", "trades"]);
            }
        }
        "signals" => {
            for p in data.get_mut("model_predictions").and_then(Value::as_object_mut).into_iter().flat_map(|p| p.values_mut()) {
                remove(p, &["asof", "input_watermark"]);
            }
        }
        _ => {}
    }
}

/// The analysis shown (a stored fold the live overlay shows in its place is not), as the live publish sends it.
fn shown(collected: Vec<engine::Collected>) -> Vec<Value> {
    collected.into_iter().filter(|c| c.shown).flat_map(|c| c.items).collect()
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThread() -> isize;
    fn SetThreadPriority(thread: isize, priority: i32) -> i32;
}

/// This thread at the lowest priority Windows schedules (THREAD_PRIORITY_IDLE): it runs only on a core nothing else
/// wants, so building a timeline never slows the live market or another program (measured: the live stand-in's
/// slowest run 0.2 ms beside a build at this priority, 5.7 ms at normal).
fn lowest_priority() {
    #[cfg(windows)]
    unsafe {
        if SetThreadPriority(GetCurrentThread(), -15) == 0 {
            eprintln!("[analysis_runtime] replay timeline: the worker's priority could not be lowered: {}", std::io::Error::last_os_error());
        }
    }
}

/// A build not started, over `foreground`, for a test to run and wait on itself.
#[cfg(test)]
pub(crate) fn unstarted_build(key: &str, recording: Value, foreground: Arc<Foreground>) -> Arc<TimelineBuild> {
    Arc::new(TimelineBuild { key: key.into(), recording, version: String::new(), focus: AtomicUsize::new(0), spans: AtomicUsize::new(0),
        done: AtomicUsize::new(0), ended: AtomicBool::new(false), abandoned: AtomicBool::new(false),
        work: Mutex::new(Work::default()), ready: Condvar::new(), held: Vec::new(), foreground })
}

#[cfg(test)]
impl TimelineBuild {
    pub(crate) fn run_for_test(&self) {
        self.run(None, engine::Engine::default(), ContextSource::default(), 1, &Mutex::new(VecDeque::new()));
    }

    pub(crate) fn wait_turn_for_test(&self) {
        self.foreground.wait_turn(self);
    }
}

/// The models a span predicts with: the active inference config's runnable slots, as the live workers run them.
struct Models {
    active: Option<Arc<ActiveConfig>>,
}

impl Models {
    /// The `signals` item of `key` at `position`: every runnable slot's prediction on the features now, in the
    /// signal authority's entry shape. None when the features are not warm or no slot covers the key.
    fn item(&self, features: &FeatureStore, key: &KeyId, position: u64) -> Option<Value> {
        let active = self.active.as_ref()?;
        let snapshot = features.snapshot(key).filter(|s| s.warm)?;
        let mut predictions = Map::new();
        for slot in active.slots.iter().filter(|s| s.runnable() && s.covers(key)) {
            let outcome = predict(active, slot, key, &snapshot);
            let (status, probability, reason) = match outcome {
                Ok(p) if p.is_finite() && (0.0..=1.0).contains(&p) => ("OK", json!(p), Value::Null),
                Ok(p) => ("FAILED", Value::Null, json!(format!("predictor returned {p}"))),
                Err(reason) => ("FAILED", Value::Null, json!(reason)),
            };
            predictions.insert(signals::prediction_key(slot.horizon_minutes as u64, slot.direction.as_str()), json!({
                "probability": probability, "status": status, "reason": reason, "model_id": slot.check.model_id,
                "model_version": slot.check.model_version, "test_only": slot.check.test_only, "input_watermark": position,
                "asof": snapshot.cutoff_ns.to_string(), "horizon_minutes": slot.horizon_minutes, "direction": slot.direction.as_str(),
            }));
        }
        if predictions.is_empty() {
            return None;
        }
        Some(json!({"identity": {"source": key.source, "market": key.market, "code": key.code, "trading_date": key.trading_date, "session": key.session},
                    "block": "signals", "input_watermark": position,
                    "data": {"authority": signals::AUTHORITY, "model_predictions": predictions}}))
    }
}

/// One slot's prediction on `snapshot`, as the live inference worker computes it (the TEST_ONLY predictor without the
/// live workers' injected faults: delays and crashes are their tests, never a timeline's).
fn predict(active: &ActiveConfig, slot: &ActiveSlot, key: &KeyId, snapshot: &FeatureSnapshot) -> Result<f64, String> {
    match slot.check.state {
        ModelState::TestOnly => {
            let task = crate::queue::Task {
                task_id: 0, key: key.clone(), horizon_minutes: slot.horizon_minutes, direction: slot.direction,
                features: snapshot.values.clone(), categories: snapshot.categories.clone(), input_watermark: snapshot.watermark,
                generation: snapshot.generation, market_cutoff_ns: snapshot.cutoff_ns, stream_id: String::new(), epoch: 0,
                config_version: active.config.config_version, enqueued_at_ns: 0, expires_at_ns: 0,
            };
            let mut quiet = active.config.clone();
            quiet.test_faults = Default::default();
            test_only_predict(&quiet, &task, 1)
        }
        ModelState::Executable => match &slot.model {
            Some(loaded) => loaded.predict(&snapshot.values, &snapshot.categories),
            None => Err("model not loaded".into()),
        },
        _ => Err("slot has no executable model".into()),
    }
}

/// A build kept across replays, and when its last replay let it go.
pub(crate) struct CachedTimeline {
    pub(crate) build: Arc<TimelineBuild>,
    pub(crate) released: Instant,
}

/// The analysis a timeline built now would be: the rules, the calendar and the inference config.
pub(crate) fn analysis_version(shared: &Shared, local: &Local) -> String {
    format!("{}|inference:{}", persist::config_label(&local.engine, &local.voided), shared.config().map_or(0, |a| a.config.config_version))
}

fn recording_matches(build: &TimelineBuild, recording: &Value) -> bool {
    build.recording["events_path"] == recording["events_path"] && build.recording["content_hash"] == recording["content_hash"]
}

/// Market Runtime needs this recording's timeline (`replay.prepare`: a replay opening on it, or a B that (re)subscribed
/// while one is open), naming the spans it holds and of which analysis. A build of it under the current analysis still
/// under way carries on (its spans go out as they are done); otherwise one starts that builds what Market Runtime
/// does not hold -- after B restarted or spans were lost on the way, a recorded remediation.
pub(crate) fn prepare_timeline(shared: &Shared, local: &mut Local, p: &Value) {
    let recording = &p["recording"];
    let version = analysis_version(shared, local);
    if timeline_of(local, recording).is_some_and(|b| b.version == version && b.running()) {
        return;
    }
    let held: Vec<(usize, usize)> = if p["version"].as_str() == Some(version.as_str()) {
        p["held"].as_array().into_iter().flatten()
            .filter_map(|r| Some((r.get(0)?.as_u64()? as usize, r.get(1)?.as_u64()? as usize))).collect()
    } else {
        Vec::new()
    };
    if !held.is_empty() {
        remediation::emit(remediation::Emit { component: "replay_runtime", mechanism_id: "analysis.replay_timeline_resume",
            trigger_reason: "missing_spans", identity: remediation::Identity::default(), attempt: None, outcome: "succeeded",
            detail: json!({"recording": recording, "held": held, "version": version})});
    }
    build_timeline(shared, local, recording, held);
}

/// A new build of this recording's timeline (the spans of `held` left out), replacing any earlier one.
pub(crate) fn build_timeline(shared: &Shared, local: &mut Local, recording: &Value, held: Vec<(usize, usize)>) -> Option<Arc<TimelineBuild>> {
    let path = recording["events_path"].as_str()?;
    let hash = recording["content_hash"].as_str()?;
    let version = analysis_version(shared, local);
    for kept in local.timelines.iter().filter(|c| recording_matches(&c.build, recording)) {
        kept.build.abandon();
    }
    local.timelines.retain(|c| !recording_matches(&c.build, recording));
    let build = Arc::new(TimelineBuild { key: format!("{path}|{hash}|{version}"), recording: recording.clone(), version,
        focus: AtomicUsize::new(0), spans: AtomicUsize::new(0), done: AtomicUsize::new(0), ended: AtomicBool::new(false),
        abandoned: AtomicBool::new(false), work: Mutex::new(Work::default()), ready: Condvar::new(), held,
        foreground: local.foreground.clone() });
    let mut template = engine::Engine::new(local.engine.cal.clone(), local.engine.rules.clone());
    template.baselines = local.engine.baselines.clone();
    let context = local.features.context().clone();
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(2).max(1));
    let (worker, models, outbox) = (build.clone(), shared.config(), local.timeline_out.clone());
    let spawned = std::thread::Builder::new().name("replay-timeline".into())
        .spawn(move || worker.run(models, template, context, workers, &outbox));
    if let Err(e) = spawned {
        eprintln!("[analysis_runtime] replay timeline of {path}: builder thread not started: {e}");
        build.end();
    }
    local.timelines.push(CachedTimeline { build: build.clone(), released: Instant::now() });
    evict_timelines(local, Instant::now());
    Some(build)
}

/// The build of this recording, if any (the newest).
pub(crate) fn timeline_of(local: &Local, recording: &Value) -> Option<Arc<TimelineBuild>> {
    local.timelines.iter().rev().find(|c| recording_matches(&c.build, recording)).map(|c| c.build.clone())
}

/// Builds no open replay plays, released longer than CACHE_IDLE ago, are let go; past CACHE_RECORDINGS the one
/// released longest ago (the rule Market Runtime keeps its recordings by).
pub(crate) fn evict_timelines(local: &mut Local, now: Instant) {
    let open: Vec<Value> = local.open_replays.values().cloned().collect();
    let free = |c: &CachedTimeline| !open.iter().any(|r| recording_matches(&c.build, r));
    local.timelines.retain(|c| {
        let keep = !free(c) || now.saturating_duration_since(c.released) < CACHE_IDLE;
        if !keep {
            c.build.abandon();
        }
        keep
    });
    while local.timelines.len() > CACHE_RECORDINGS {
        let oldest = local.timelines.iter().enumerate().filter(|(_, c)| free(c)).min_by_key(|(_, c)| c.released).map(|(i, _)| i);
        match oldest {
            Some(i) => local.timelines.remove(i).build.abandon(),
            None => break,
        }
    }
}

/// The analysis changed under an open replay (rules reloaded, another inference config): its recording's timeline is
/// built again under the new analysis (Market Runtime replaces the old one span by span).
pub(crate) fn rebuild_stale_timelines(shared: &Shared, local: &mut Local) {
    let version = analysis_version(shared, local);
    let stale: Vec<Value> = local.open_replays.values().cloned()
        .filter(|r| timeline_of(local, r).is_some_and(|b| b.version != version)).collect();
    for recording in stale {
        eprintln!("[analysis_runtime] replay timeline of {}: the analysis changed; building it again", recording["events_path"]);
        build_timeline(shared, local, &recording, Vec::new());
    }
}

/// Spans built since the last turn, to Market Runtime.
pub(crate) fn drain_timeline_outbox(local: &Local) -> Vec<String> {
    local.timeline_out.lock().unwrap_or_else(|e| e.into_inner()).drain(..).collect()
}

/// Where the open replay stands (an open, a seek, as it plays): it is open from here on, the span holding the step is
/// built next, and the other builds wait for this one.
pub(crate) fn replay_focus(local: &mut Local, p: &Value) {
    if let Some(id) = p["replay_id"].as_str() {
        local.open_replays.insert(id.to_string(), p["recording"].clone());
    }
    if let (Some(build), Some(step)) = (timeline_of(local, &p["recording"]), p["position"].as_u64()) {
        build.set_focus(step as usize);
        local.foreground.set(Some(build));
    }
}

/// Market Runtime's `durable.subscribed` names the replay open there: any other B holds will get no `replay.close` (A
/// restarted, or the close was lost with the connection), and is released as if it had. A recorded remediation.
pub(crate) fn release_replays_except(local: &mut Local, open: Option<&str>) {
    let orphans: Vec<String> = local.open_replays.keys().filter(|id| Some(id.as_str()) != open).cloned().collect();
    for id in orphans {
        remediation::emit(remediation::Emit { component: "replay_runtime", mechanism_id: "analysis.replay_orphan_release",
            trigger_reason: "not_open_at_market_runtime", identity: remediation::Identity::default(), attempt: None, outcome: "succeeded",
            detail: json!({"replay_id": id, "open_replay": open})});
        release_replay(local, &id);
    }
}

/// A replay closed: its build's idle time started.
pub(crate) fn release_replay(local: &mut Local, id: &str) {
    if let Some(recording) = local.open_replays.remove(id) {
        // Closed: the builds that waited for its timeline carry on.
        if timeline_of(local, &recording).is_some() {
            local.foreground.set(None);
        }
        if let Some(kept) = local.timelines.iter_mut().find(|c| recording_matches(&c.build, &recording)) {
            kept.released = Instant::now();
        }
    }
}
