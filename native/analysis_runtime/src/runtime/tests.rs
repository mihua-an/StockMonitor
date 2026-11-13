use std::collections::{HashMap, HashSet};
use std::io::{self};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};
use market_runtime::event::{MarketEvent, Refused, EVENT_SCHEMA_VERSION};
use serde_json::{json, Value};
use crate::contract::SpecIdentity;
use crate::cursor::DurableCursor;
use crate::features::FeatureStore;
use crate::queue::TaskQueue;
use crate::{accum, archive, baseline, engine, features, outbox, paper, persist, signals};
use market_runtime::calendar;
use super::{shared::*, inference_runtime::*, checkpoint_service::*, replay_runtime::*, ingest::*, stream_runtime::*};

#[test]
fn a_broken_durable_batch_container_is_a_contract_violation() {
    // `events` that is not a list must not read as an empty batch that moves the head past the cursor.
    let ok = durable_batch_container(&mut json!({"to_sequence": 100, "events": [{"a": 1}], "replay": true}));
    assert_eq!(ok.map(|(to, replay, events)| (to, replay, events.len())), Ok((100, true, 1)));
    assert!(durable_batch_container(&mut json!({"to_sequence": 100, "events": {"a": 1}})).unwrap_err().contains("an object"));
    assert!(durable_batch_container(&mut json!({"to_sequence": 100, "events": "x"})).unwrap_err().contains("not a list"));
    assert!(durable_batch_container(&mut json!({"to_sequence": 100})).unwrap_err().contains("missing"));
    assert!(durable_batch_container(&mut json!({"events": []})).unwrap_err().contains("to_sequence"));
    assert!(durable_batch_container(&mut json!({"to_sequence": "100", "events": []})).is_err(), "a string sequence is not one");
    // The typed fast path holds the same rule: without to_sequence it does not decode (the generic path refuses it).
    assert!(serde_json::from_slice::<DurableBatchMessage>(br#"{"type":"durable.batch","payload":{"events":[]}}"#).is_err());
    assert!(serde_json::from_slice::<DurableBatchMessage>(br#"{"type":"durable.batch","payload":{"to_sequence":5,"events":[]}}"#).is_ok());
}

#[test]
fn a_config_version_that_could_not_be_read_is_read_again_until_it_can() {
    // A sharing violation on the first read is not a verdict: the same (mtime, size) is read again and applied.
    let mut watch = ConfigWatch::default();
    let locked = || Err(io::Error::new(io::ErrorKind::PermissionDenied, "sharing violation"));
    let first = watch.step(Ok((std::time::UNIX_EPOCH + Duration::from_secs(10), 42)), locked, |_| Ok(7)).unwrap();
    assert_eq!(first["state"], "UNREADABLE");
    assert!(watch.seen.is_none(), "an unread version is not seen");
    let second = watch.step(Ok((std::time::UNIX_EPOCH + Duration::from_secs(10), 42)), locked, |_| Ok(7)).unwrap();
    assert_eq!(second["state"], "UNREADABLE");
    assert_eq!(watch.unreadable.as_ref().map(|(_, n)| *n), Some(2), "one recorded operation, attempts counted");
    let third = watch.step(Ok((std::time::UNIX_EPOCH + Duration::from_secs(10), 42)), || Ok("{}".to_string()), |_| Ok(7)).unwrap();
    assert_eq!((third["state"].clone(), third["applied_version"].clone()), (json!("APPLIED"), json!(7)));
    assert!(watch.unreadable.is_none(), "ended by the read that succeeded");
    assert!(watch.step(Ok((std::time::UNIX_EPOCH + Duration::from_secs(10), 42)), || Ok(String::new()), |_| Ok(8)).is_none(),
            "a version read and judged is not read again");
}

#[test]
fn every_change_of_the_config_file_is_reported_including_its_disappearance() {
    // A config file that went away after it had been read kept its old state; each change is reported.
    let dir = std::env::temp_dir().join(format!("b-config-watch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let shared = test_shared();
    let watcher = { let s = shared.clone(); let d = dir.clone(); thread::spawn(move || watch_inference_config(s, Some(d))) };
    let state = |shared: &Arc<Shared>| shared.config_state.lock().unwrap()["state"].as_str().unwrap_or("").to_string();
    thread::sleep(Duration::from_millis(400));
    assert_eq!(state(&shared), "ABSENT");
    std::fs::write(dir.join(INFERENCE_CONFIG_FILE), b"{\"not\": \"a config\"}").unwrap();
    thread::sleep(Duration::from_millis(1500));
    assert_eq!(state(&shared), "REJECTED");
    std::fs::remove_file(dir.join(INFERENCE_CONFIG_FILE)).unwrap();
    thread::sleep(Duration::from_millis(1500));
    assert_eq!(state(&shared), "ABSENT", "the file going away is reported");
    shared.stop.store(true, Ordering::Release);
    watcher.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_signal_batch_counts_until_answered_and_a_reconnect_reports_the_unanswered() {
    // A batch sent (or half-sent) but never answered makes the reconnect resend; an answered one does not.
    let mut acks = SignalAcks::default();
    let first = acks.sent();
    let second = acks.sent();
    assert_ne!(first, second);
    acks.answered(&first);
    assert_eq!(acks.reconnected(), 1, "the second batch was never answered");
    assert_eq!(acks.reconnected(), 0, "a reconnect starts with nothing outstanding");
    let third = acks.sent();
    acks.answered(&third);
    acks.answered("signals-unknown");
    assert_eq!(acks.reconnected(), 0);
}

#[test]
fn inference_results_are_never_dropped_and_the_newest_of_a_slot_wins() {
    // A burst far past the old 4096-result channel loses nothing; a slot keeps only its newest result.
    let outbox = ResultOutbox::default();
    let result = |code: &str, watermark: u64| Outbound { value: json!({"type": "inference.result",
        "identity": {"source": "shioaji", "market": "STK", "trading_date": "2026-10-08", "session": "DAY", "code": code},
        "horizon_minutes": 3, "direction": "up", "input_watermark": watermark}), expires_at_ns: None };
    for i in 0..10_000 {
        assert!(!outbox.put(result(&format!("C{i}"), 1)));
    }
    assert!(outbox.put(result("C0", 2)), "a newer result of the same slot replaces the waiting one");
    let drained = outbox.drain();
    assert_eq!(drained.len(), 10_000);
    assert_eq!(drained.iter().find(|o| o.value["identity"]["code"] == "C0").unwrap().value["input_watermark"], 2);
    assert!(outbox.drain().is_empty());
}

fn test_shared() -> Arc<Shared> {
    Arc::new(Shared {
        instance: "test".into(), spec: SpecIdentity::of(&json!({})), stop: AtomicBool::new(false),
        config: RwLock::new(None), epoch: AtomicU64::new(0), stream_id: Mutex::new(String::new()), queue: TaskQueue::new(1),
        results: ResultOutbox::default(), signals_health: Mutex::new(json!({})), counters: Counters::default(), view: Mutex::new(StreamView::default()),
        reload: AtomicBool::new(false), reschedule: AtomicBool::new(false), ready_said: AtomicBool::new(false), capture: Mutex::new(None),
        startup_only: Mutex::new(None), restart_required: Mutex::new(Vec::new()), config_state: Mutex::new(json!({"state": "ABSENT"})), checkpoint_failed_by_stage: Mutex::new(Default::default()), checkpoint_retry: Mutex::new(None),
        incompatible: Mutex::new(None), stop_deadline: Mutex::new(None),
        archive: Mutex::new(archive::Archive::default()),
        baselines: Arc::new(baseline::Store::default()),
    })
}

#[test]
fn the_feature_capture_takes_effect_with_the_first_config_only() {
    // A capture first named by a later config was opened at once, while a changed path or max_rows of an open one
    // was only reported: the same startup-only setting behaved by what came before.
    let dir = std::env::temp_dir().join(format!("ar-capture-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = |version: u64, capture: Option<&Path>| {
        let mut c = json!({"config_version": version, "horizon_authority_version": 1, "allowed_minutes": [3], "slots": [],
                           "queue_capacity": 8, "workers": 1, "task_ttl_ms": 1000});
        if let Some(path) = capture {
            c["feature_capture"] = json!({"path": path.to_string_lossy(), "max_rows": 5});
        }
        c
    };
    let started = AtomicBool::new(true);
    let (a, b) = (dir.join("a.jsonl"), dir.join("b.jsonl"));

    let late = test_shared();
    apply_config(&late, config(1, None), &started).unwrap();
    apply_config(&late, config(2, Some(&a)), &started).unwrap();
    assert!(late.capture.lock().unwrap().is_none(), "a capture first named by a later config is not opened");
    assert!(late.restart_required.lock().unwrap().contains(&"feature_capture.path".to_string()));

    let first = test_shared();
    apply_config(&first, config(1, Some(&a)), &started).unwrap();
    apply_config(&first, config(2, Some(&b)), &started).unwrap();
    assert_eq!(first.capture.lock().unwrap().as_ref().map(|c| c.1.clone()), Some(a.to_string_lossy().into_owned()),
               "the open capture keeps the startup path");
    assert!(!b.exists());
    assert_eq!(*first.restart_required.lock().unwrap(), vec!["feature_capture.path".to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}

fn test_local(shared: &Arc<Shared>) -> Local {
    Local {
        cursor: DurableCursor::default(), features: FeatureStore::default(), engine: engine::Engine::default(),
        projection_epoch: 1, need_full_publish: false, last_publish: Instant::now(), last_status: Instant::now(),
        last_checkpoint: Instant::now(), last_rules_check: Instant::now(), rules_stamp: None, rule_problems: Vec::new(),
        checkpoint_info: json!({}), checkpoints: CheckpointWriter::start(shared.clone()), replaying: false,
        timelines: Vec::new(), timeline_out: Default::default(), foreground: Default::default(), open_replays: HashMap::new(), live_lane: (0, 0), republish_signals: false,
        outbox: outbox::Outbox::default(), awaiting_full_publish: Vec::new(), signals_republish: None,
        republish_batches: RepublishBatches::default(), signal_acks: SignalAcks::default(),
        signals: signals::SignalBook::default(), signals_invalidated: Vec::new(), reconnect_pending: None, signal_config_version: 0, historical_prune: None,
    paper: paper::PaperDesk::default(), paper_dir: None, voided: Default::default(),
    }
}

/// Recorded trades 0..n over several minutes, the price swinging about 1.2 % from one minute to the next (the 1 and 3
/// minute rules trigger and reset), written as the partition Market Runtime replays (events.jsonl and the manifest
/// committing its line count and content hash). Returns what `replay.prepare` names it by.
fn write_recording(dir: &std::path::Path, n: u64) -> Value {
    std::fs::create_dir_all(dir).unwrap();
    let price = |i: u64| 1_000_000 + [0, 12_000, 24_000, 12_000][(i / 60 % 4) as usize] + (i % 9) as i64 * 500;
    let text: String = (0..n).map(|i| serde_json::to_string(&crate::accum::tests::trade_at(i + 1, 540 + (i / 60) as i32, (i % 60) as i32,
        price(i), 1.0 + (i % 7) as f64 * 40.0, if i % 2 == 0 { 1 } else { -1 })).unwrap() + "\n").collect();
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let path = dir.join("events.jsonl");
    std::fs::write(&path, &text).unwrap();
    std::fs::write(dir.join("manifest.json"), json!({"event_count": n, "content_hash_fnv1a64": format!("{hash:016x}")}).to_string()).unwrap();
    json!({"events_path": path.to_string_lossy(), "content_hash": format!("{hash:016x}")})
}

/// A built timeline as Market Runtime holds it: every span B sent, read into market_runtime::timeline::Timeline.
fn built_timeline(shared: &Arc<Shared>, local: &mut Local, recording: &Value, steps: usize) -> market_runtime::timeline::Timeline {
    let build = build_timeline(shared, local, recording, Vec::new()).expect("the recording names a partition");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !build.ended() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut timeline = market_runtime::timeline::Timeline::new(steps);
    for text in drain_timeline_outbox(local) {
        let message: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(message["type"], "replay.timeline");
        assert_eq!(message["payload"]["recording"], *recording);
        assert!(timeline.insert(message["payload"]["version"].as_str().unwrap(), &message["payload"]["span"]).unwrap());
    }
    timeline
}

/// Every block's body as a timeline keeps it: the fields the 歷史回放 page reads (`replay_shown`), without the stamps of
/// when B last published it (`input_watermark`, `as_of`): a block keeps those of the step that last changed it, a full
/// collect restamps every block now. The page reads neither (an event's own `as_of_ns` is in its record).
fn bodies(items: Vec<Value>) -> HashMap<String, Value> {
    items.iter().map(|item| {
        let mut shown = item.clone();
        replay_shown(&mut shown);
        let mut body = market_runtime::timeline::body_of(shown);
        body.as_object_mut().unwrap().remove("input_watermark");
        body.as_object_mut().unwrap().remove("as_of");
        (market_runtime::timeline::target_of(&item["identity"], item["block"].as_str().unwrap()), body)
    }).collect()
}

fn without_watermarks(blocks: &HashMap<String, Value>) -> HashMap<String, Value> {
    blocks.iter().map(|(k, v)| {
        let mut v = v.clone();
        v.as_object_mut().unwrap().remove("input_watermark");
        v.as_object_mut().unwrap().remove("as_of");
        (k.clone(), v)
    }).collect()
}

/// The page shows the analysis of exactly the step the replay stands on, whichever way it got there. Market Runtime
/// reads it from the timeline B built span by span on its workers -- every position, a span's first and last steps
/// and the steps across two spans included, reads back as the day analysed step by step from its first event
/// (B collecting after every step, as the spans do), and moving forward through it gives the same. Under the App's own
/// flow and event rules: the rule events a span starts with are those the steps before it triggered, to the second.
#[test]
fn every_position_of_a_built_timeline_reads_back_as_the_day_analysed_step_by_step() {
    let shared = test_shared();
    let dir = std::env::temp_dir().join(format!("b-timeline-{}-{}", std::process::id(), line!()));
    let recording = write_recording(&dir, 1200);
    let loaded = market_runtime::replay::load(Path::new(recording["events_path"].as_str().unwrap())).unwrap();
    let steps = market_runtime::timeline::steps(&loaded.events, &loaded.due);
    let partition = market_runtime::replay::Partition::new("shioaji", "STK", &loaded.events[0].code, &loaded.events[0].trading_date, "DAY").unwrap();
    let mut local = test_local(&shared);
    let (rules, problems) = crate::rules::load(Some(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/replay_rules")), None);
    assert!(problems.is_empty() && !rules.events.is_empty(), "{problems:?}");
    local.engine = engine::Engine::new(calendar::Calendar::default(), rules);
    let timeline = built_timeline(&shared, &mut local, &recording, steps.len());
    let len = timeline.span_len;
    assert!(steps.len() > 2 * len, "several spans: {} steps of {len}", steps.len());
    assert_eq!(timeline.held(), vec![(0, steps.len())], "every span built and sent");
    let mut engine = engine::Engine::new(local.engine.cal.clone(), local.engine.rules.clone());
    let check: HashSet<usize> = [0, 1, len - 1, len, len + 1, 2 * len - 1, 2 * len, steps.len() / 2, steps.len() - 1, steps.len()].into_iter().collect();
    let mut checked = 0;
    for p in 0..=steps.len() {
        if check.contains(&p) {
            let want = bodies(engine.clone().collect(true, p as u64, None).into_iter().filter(|c| c.shown).flat_map(|c| c.items).collect());
            let got = timeline.state_at(p).unwrap().expect("held");
            let got = without_watermarks(&got.blocks);
            if got != want {
                for (k, w) in &want {
                    let mut out = Vec::new();
                    market_runtime::timeline::diff(got.get(k).unwrap_or(&Value::Null), w, false, &mut out);
                    for (path, v) in out.iter().take(6) { eprintln!("DIFF p={p} {k} {path:?} want={}", v.as_ref().map(|v| v.to_string()).unwrap_or_default().chars().take(120).collect::<String>()); }
                }
            }
            assert_eq!(got, want, "position {p}");
            checked += 1;
        }
        if p < steps.len() {
            let event = market_runtime::timeline::step_event(&partition, &loaded.events, &steps[p]);
            engine.apply(&event);
            engine.collect(false, p as u64 + 1, None);
        }
    }
    assert_eq!(checked, check.len());
    let end = timeline.state_at(steps.len()).unwrap().unwrap();
    let events = end.blocks.iter().find(|(k, _)| k.ends_with("|events")).map(|(_, v)| v["data"]["events"].as_object().map_or(0, |e| e.len()));
    assert!(events.unwrap_or(0) > 3, "the rules triggered events across the spans: {events:?}");
    // A step's flow names its large orders only when they changed: the list read back is the day's all the same.
    let large = end.blocks.iter().find(|(k, _)| k.ends_with("|flow"))
        .map(|(_, v)| market_runtime::timeline::flow_unkeyed(&v["data"])["largeOrders"].as_array().map_or(0, Vec::len));
    assert!(large.unwrap_or(0) > 1, "large orders were listed across the spans: {large:?}");
    let mut state = timeline.state_at(0).unwrap().unwrap();
    assert!(timeline.advance(&mut state, steps.len(), &mut Default::default()).unwrap());
    assert_eq!(without_watermarks(&state.blocks), without_watermarks(&timeline.state_at(steps.len()).unwrap().unwrap().blocks));
    // Played step by step from inside a span, across the next span's start: every step is the position's own.
    let mut state = timeline.state_at(len - 7).unwrap().unwrap();
    for p in len - 6..=len + 7 {
        assert!(timeline.advance(&mut state, p, &mut Default::default()).unwrap());
        assert_eq!(state.blocks, timeline.state_at(p).unwrap().unwrap().blocks, "played to {p}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Measurement, not a test of record (ignored unless run on purpose): the real timeline build of one recorded partition
/// under the App's rules and models, and what Market Runtime then holds and reads.
///
///   PROBE_EVENTS=D:/LM_STK/source=shioaji/market=STK/trading_date=2026-10-30/session=DAY/2303/events.jsonl \
///   PROBE_CONFIG=<repo>/var/config PROBE_INFERENCE=<repo>/var/data/analysis-runtime/inference/config.json \
///   cargo test --release --lib timeline_build_probe -- --ignored --nocapture
#[test]
#[ignore]
fn timeline_build_probe() {
    let path = std::env::var("PROBE_EVENTS").expect("PROBE_EVENTS names a recorded events.jsonl");
    let shared = Arc::new(Shared {
        instance: "probe".into(), spec: super::startup::feature_spec(), stop: AtomicBool::new(false),
        config: RwLock::new(None), epoch: AtomicU64::new(0), stream_id: Mutex::new(String::new()), queue: TaskQueue::new(1),
        results: ResultOutbox::default(), signals_health: Mutex::new(json!({})), counters: Counters::default(), view: Mutex::new(StreamView::default()),
        reload: AtomicBool::new(false), reschedule: AtomicBool::new(false), ready_said: AtomicBool::new(false), capture: Mutex::new(None),
        startup_only: Mutex::new(None), restart_required: Mutex::new(Vec::new()), config_state: Mutex::new(json!({"state": "ABSENT"})), checkpoint_failed_by_stage: Mutex::new(Default::default()), checkpoint_retry: Mutex::new(None),
        incompatible: Mutex::new(None), stop_deadline: Mutex::new(None),
        archive: Mutex::new(archive::Archive::default()),
        baselines: Arc::new(baseline::Store::default()),
    });
    if let Ok(config) = std::env::var("PROBE_INFERENCE") {
        let version = decide_config(&shared, std::fs::read_to_string(config).unwrap(), &AtomicBool::new(true)).expect("the inference config applies");
        let runnable = shared.config().unwrap().slots.iter().filter(|s| s.runnable()).count();
        println!("{{\"probe\": \"inference\", \"config_version\": {version}, \"runnable_slots\": {runnable}}}");
    }
    let mut local = test_local(&shared);
    let config = std::env::var("PROBE_CONFIG").ok().map(std::path::PathBuf::from);
    let (rules, problems) = crate::rules::load(config.as_deref(), None);
    assert!(problems.is_empty(), "{problems:?}");
    local.engine = engine::Engine::new(calendar::Calendar::default(), rules);
    let hash = market_runtime::replay::committed_hash(Path::new(&path)).unwrap();
    let recording = json!({"events_path": path, "content_hash": hash});
    let started = Instant::now();
    let build = build_timeline(&shared, &mut local, &recording, Vec::new()).unwrap();
    // As the replay opens at 13:00: Market Runtime names that position, the builder starts there.
    let loaded = market_runtime::replay::load(Path::new(&path)).unwrap();
    let steps = market_runtime::timeline::steps(&loaded.events, &loaded.due).len();
    build.set_focus(steps * 4 / 5);
    let mut timeline = market_runtime::timeline::Timeline::new(steps);
    let (mut first_ms, mut focus_ms, mut wire_bytes) = (None, None, 0usize);
    loop {
        let ended = build.ended();
        for text in drain_timeline_outbox(&local) {
            wire_bytes += text.len();
            let message: Value = serde_json::from_str(&text).unwrap();
            timeline.insert(message["payload"]["version"].as_str().unwrap(), &message["payload"]["span"]).unwrap();
            first_ms.get_or_insert(started.elapsed().as_millis());
            if focus_ms.is_none() && timeline.has(steps * 4 / 5) {
                focus_ms = Some(started.elapsed().as_millis());
            }
        }
        if ended {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let build_ms = started.elapsed().as_millis();
    let mut read_us = Vec::new();
    for k in 1..=40 {
        let t = Instant::now();
        timeline.state_at(steps * k / 41).unwrap().unwrap();
        read_us.push(t.elapsed().as_micros());
    }
    read_us.sort_unstable();
    let mut state = timeline.state_at(steps / 2).unwrap().unwrap();
    let t = Instant::now();
    let mut moved = market_runtime::timeline::Moved::default();
    for p in steps / 2 + 1..=steps / 2 + 2000 {
        timeline.advance(&mut state, p, &mut moved).unwrap();
    }
    let step_us = t.elapsed().as_micros() as f64 / 2000.0;
    println!("{{\"probe\": \"timeline build\", \"steps\": {steps}, \"build_ms\": {build_ms}, \"first_span_ms\": {first_ms:?}, \"focus_span_ms\": {focus_ms:?}, \
              \"held\": {:?}, \"wire_mb\": {:.1}, \"held_mb\": {:.1}, \"read_us_p50\": {}, \"read_us_p95\": {}, \"read_us_max\": {}, \"advance_step_us\": {step_us:.1}}}",
        timeline.held(), wire_bytes as f64 / 1e6, timeline.bytes() as f64 / 1e6, read_us[read_us.len() / 2], read_us[read_us.len() * 95 / 100], read_us.last().unwrap());
    println!("{{\"probe\": \"timeline held\", \"stats\": {}}}", timeline.stats());
    println!("{{\"probe\": \"timeline changes\", \"by_block\": {}}}", timeline.change_stats().unwrap());
    if std::env::var("PROBE_FIELDS").is_ok() {
        println!("{{\"probe\": \"timeline fields\", \"by_field\": {}}}", timeline.field_stats().unwrap());
    }
}

/// Three stocks opened in a row were built at once and shared the CPU (2303's timeline took 50 s instead of 28 s):
/// while the open replay's build is under way, another recording's build builds nothing, and finishes after it.
#[test]
fn a_build_waits_while_the_open_replay_s_build_is_under_way() {
    let shared = test_shared();
    let dir = std::env::temp_dir().join(format!("b-timeline-fg-{}-{}", std::process::id(), line!()));
    let open = write_recording(&dir.join("open"), 20_000);
    let other = write_recording(&dir.join("other"), 1_200);
    let mut local = test_local(&shared);
    let front = build_timeline(&shared, &mut local, &open, Vec::new()).unwrap();
    local.foreground.set(Some(front.clone()));
    let back = build_timeline(&shared, &mut local, &other, Vec::new()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut seen_waiting = false;
    while front.running() && Instant::now() < deadline {
        // Read the other build first: while the open one is still under way after it, the other has built nothing.
        let done = back.spans_done();
        if front.running() {
            assert_eq!(done, 0, "the other build built a span while the open replay's was under way");
            seen_waiting = true;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(seen_waiting, "the open replay's build was seen under way");
    while !back.ended() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(back.spans_done() > 0, "the other build finished after it");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_foreground_build_that_cannot_read_its_partition_lets_the_waiting_build_go_on() {
    let foreground: Arc<Foreground> = Default::default();
    let failing = unstarted_build("failing", json!({"events_path": "no-such-partition", "content_hash": "x"}), foreground.clone());
    let waiting = unstarted_build("waiting", json!({}), foreground.clone());
    foreground.set(Some(failing.clone()));
    let (done, finished) = std::sync::mpsc::channel();
    let waiter = waiting.clone();
    thread::spawn(move || {
        waiter.wait_turn_for_test();
        let _ = done.send(());
    });
    assert!(finished.recv_timeout(Duration::from_millis(300)).is_err(), "it waits while the foreground build is under way");
    failing.run_for_test();
    assert!(finished.recv_timeout(Duration::from_secs(5)).is_ok(), "the failed build woke it");
    waiting.abandon();
}

#[test]
fn durable_subscribed_lets_go_of_every_replay_but_the_one_market_runtime_has_open() {
    let shared = test_shared();
    let dir = std::env::temp_dir().join(format!("b-orphan-replay-{}-{}", std::process::id(), line!()));
    let recording = write_recording(&dir, 600);
    let mut local = test_local(&shared);
    let build = build_timeline(&shared, &mut local, &recording, Vec::new()).unwrap();
    for id in ["open", "orphan"] {
        replay_focus(&mut local, &json!({"replay_id": id, "recording": recording, "position": 10}));
    }
    release_replays_except(&mut local, Some("open"));
    assert_eq!(local.open_replays.keys().collect::<Vec<_>>(), vec!["open"], "a new replay A names is kept, the orphan goes");
    release_replays_except(&mut local, None);
    assert!(local.open_replays.is_empty(), "A has none open");
    build.abandon();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn durable_subscribed_must_say_which_replay_is_open() {
    let base = json!({"after_sequence": 0, "durable_sequence": 0, "durable_stream_id": "s", "runtime_epoch": 1});
    assert!(subscribed_fields(&base).unwrap_err().contains("replay_id"));
    let with = |id: Value| { let mut p = base.clone(); p["replay_id"] = id; p };
    assert_eq!(subscribed_fields(&with(Value::Null)).unwrap().open_replay, None);
    assert_eq!(subscribed_fields(&with(json!("r1"))).unwrap().open_replay, Some("r1"));
    assert!(subscribed_fields(&with(json!(1))).is_err());
}

#[test]
fn a_replay_jump_market_runtime_did_not_declare_is_said_on_the_working_paper_orders() {
    let shared = test_shared();
    let dir = std::env::temp_dir().join(format!("b-gap-paper-{}-{}", std::process::id(), line!()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("orders.jsonl"), json!({"type": "new", "cmd_id": "A", "order_id": "A", "accepted_ns": 0, "trading_date": "2026-09-29",
        "code": "2330", "side": "buy", "lot": "whole", "price_type": "limit", "price": 900_000, "qty": 1000.0, "tif": "ROD"}).to_string() + "\n").unwrap();
    let mut local = test_local(&shared);
    local.paper.open(Some(dir.clone()));
    let event = |seq: u64| {
        let mut e = accum::tests::trade_at(seq, 540, seq as i32, 1_000_000, 1.0, 1);
        e.schema_version = EVENT_SCHEMA_VERSION;
        e.a_received_ns = 60_000_000_000; // well past the order's accepted time and the simulated delay
        e
    };
    apply_durable_batch(&shared, &mut local, Some(4), true, [event(1), event(4)].into_iter().map(Ok));
    local.paper.flush();
    let text = std::fs::read_to_string(dir.join("results.jsonl")).unwrap();
    assert!(text.lines().any(|l| l.contains("\"A-G3\"") && l.contains("notice")), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

fn test_body(cursor: u64) -> persist::Body {
    persist::Body { schema: persist::SCHEMA.into(), durable_stream_id: "s".into(), projection_epoch: 1, cursor, written_at_ns: 0,
        engine: engine::Engine::default(), features: features::FeatureImage::default(), config_label: "test".into(), paper: Default::default() }
}

#[test]
fn a_checkpoint_is_written_off_the_stream_thread_and_the_final_one_waits_for_the_write_in_flight() {
    // A stream thread that encodes and fsyncs a 165 MB checkpoint itself (~6 s every 30 s) stops reading
    // Market Runtime, and is dropped by A's 5 s write timeout -- a reconnect and full republish about once a minute.
    let shared = test_shared();
    let dir = std::env::temp_dir().join(format!("b-ckpt-writer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut writer = CheckpointWriter::start(shared.clone());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !writer.submit(test_body(1), &dir, 0) {
        assert!(Instant::now() < deadline, "an idle writer takes a checkpoint");
        thread::sleep(Duration::from_millis(5));
    }
    let info = writer.finish(&shared, Some((test_body(2), 0)), &dir, Instant::now() + Duration::from_secs(30)).unwrap();
    assert_eq!(info["cursor"], 2, "{info}");
    // The submitted one was either already being written (it finishes first) or still waiting (the final one,
    // newer, replaced it): never a half-written file, never a second write after the final one.
    assert!((1..=2).contains(&shared.counters.checkpoints.load(Ordering::Relaxed)));
    assert_eq!(persist::load(&dir, "test").0.unwrap().cursor(), 2);
    assert!(!writer.submit(test_body(3), &dir, 0), "nothing is taken after stop");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_signals_republish_is_over_only_when_every_batch_was_answered_ok() {
    // The republish was recorded succeeded before its batches were even sent.
    let mut batches = RepublishBatches::default();
    batches.begin_attempt();
    batches.sent("signals-1");
    batches.sent("signals-2");
    batches.answered_ok("signals-1");
    assert_eq!(batches.complete(), None, "one batch still unanswered");
    assert!(batches.failed(), "refused / lost: the attempt fails");
    batches.begin_attempt();
    batches.sent("signals-3");
    batches.answered_ok("signals-3");
    assert_eq!(batches.complete(), Some(2), "succeeded on the second attempt");
    assert!(!batches.failed() && batches.complete().is_none(), "nothing open afterwards");
    let mut empty = RepublishBatches::default();
    empty.begin_attempt();
    assert_eq!(empty.complete(), Some(1), "nothing to send: over at once");
}

#[test]
fn the_final_checkpoint_replaces_a_waiting_one_and_answers_by_the_deadline() {
    // The stop joined a write in flight and then wrote a second full checkpoint, with no bound -- past Health's
    // 15 s it was killed without a receipt.
    let shared = test_shared();
    let dir = std::env::temp_dir().join(format!("b-ckpt-deadline-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut writer = CheckpointWriter::start(shared.clone());
    // A write is waiting (the worker has not taken it yet): the final one replaces it, one write in all.
    {
        let (lock, _) = &*writer.slot;
        lock.lock().unwrap().busy = true;          // hold the worker off the waiting job
    }
    {
        let (lock, _) = &*writer.slot;
        lock.lock().unwrap().pending = Some((test_body(5), dir.clone(), 0, false));
    }
    // Past the deadline with the writer still busy: a receipt that says so, at once.
    let late = writer.finish(&shared, Some((test_body(6), 0)), &dir, Instant::now()).unwrap();
    assert_eq!((late["ok"].as_bool(), late["stage"].as_str(), late["cursor"].as_u64()), (Some(false), Some("deadline"), Some(6)));
    {
        let (lock, cv) = &*writer.slot;
        let mut state = lock.lock().unwrap();
        assert_eq!(state.pending.as_ref().map(|job| job.0.cursor), Some(6), "the final checkpoint replaced the waiting one");
        state.busy = false;
        cv.notify_all();
    }
    let info = writer.finish(&shared, None, &dir, Instant::now() + Duration::from_secs(30));
    assert_eq!(persist::load(&dir, "test").0.unwrap().cursor(), 6, "{info:?}");
    assert_eq!(shared.counters.checkpoints.load(Ordering::Relaxed), 1, "one write, not two");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_checkpoint_retry_ends_only_when_a_write_reaches_the_cursor_it_missed() {
    // cursor 100 is being written; 200 falls due while the writer is busy; 100 then completes. The retry is about
    // 200, so it stays open until a checkpoint at or past 200 is on disk.
    let shared = test_shared();
    checkpoint_not_written(&shared, "checkpoint_writer_busy", 200, json!({"cursor": 200}));
    checkpoint_written(&shared, 100);
    assert_eq!(shared.checkpoint_retry.lock().unwrap().as_ref().map(|(_, n, t)| (*n, *t)), Some((1, 200)));
    checkpoint_not_written(&shared, "checkpoint_writer_busy", 150, json!({"cursor": 150}));
    assert_eq!(shared.checkpoint_retry.lock().unwrap().as_ref().map(|(_, n, t)| (*n, *t)), Some((2, 200)), "the newest stays the target");
    checkpoint_written(&shared, 250);
    assert!(shared.checkpoint_retry.lock().unwrap().is_none());
}

#[test]
fn a_checkpoint_is_hashed_as_written_and_every_older_layout_is_refused() {
    // The checksum is over the body bytes as written (one serialization per write). The older envelope (`sha256`
    // over a re-serialized tree) and a body without `config_label` are refused, never resumed.
    let dir = std::env::temp_dir().join(format!("b-ckpt-format-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let bytes = persist::encode(&test_body(4)).unwrap();
    persist::write_bytes(&dir, &bytes).unwrap();
    assert_eq!(persist::load(&dir, "test").0.unwrap().cursor(), 4);

    let tampered = String::from_utf8(bytes).unwrap().replacen("\"cursor\":4", "\"cursor\":5", 1);
    std::fs::write(dir.join("checkpoint.json"), tampered).unwrap();
    let (loaded, _, problems) = persist::load(&dir, "test");
    assert!(loaded.is_none() && problems.iter().any(|p| p.contains("checksum mismatch")), "{problems:?}");

    let tree = serde_json::to_value(test_body(6)).unwrap();
    let older = json!({"sha256": market_runtime::sha256::hex(&serde_json::to_vec(&tree).unwrap()), "body": tree});
    std::fs::write(dir.join("checkpoint.json"), serde_json::to_vec(&older).unwrap()).unwrap();
    let (loaded, _, problems) = persist::load(&dir, "test");
    assert!(loaded.is_none() && problems.iter().any(|p| p.contains("body_sha256")), "{problems:?}");

    let mut unlabelled = serde_json::to_value(test_body(7)).unwrap();
    unlabelled.as_object_mut().unwrap().remove("config_label");
    let body = serde_json::to_vec(&unlabelled).unwrap();
    let mut bytes = format!("{{\"body_sha256\":\"{}\",\"body\":", market_runtime::sha256::hex(&body)).into_bytes();
    bytes.extend_from_slice(&body);
    bytes.push(b'}');
    std::fs::write(dir.join("checkpoint.json"), bytes).unwrap();
    let (loaded, _, problems) = persist::load(&dir, "test");
    assert!(loaded.is_none() && problems.iter().any(|p| p.contains("config_label")), "{problems:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_checkpoint_of_another_layout_is_set_aside_by_its_header_not_failed_as_a_damaged_file() {
    // A new build changed a field's type (a reference price became a struct): B decoded the whole body first, the
    // older checkpoint failed as "body: invalid type", and B logged a read failure and replayed. The label says
    // which layout built it, so it is set aside before its state is read; a body that fails under the same label
    // is still a damaged file.
    let dir = std::env::temp_dir().join(format!("b-ckpt-layout-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let write = |label: &str| {
        let mut body = serde_json::to_value(test_body(8)).unwrap();
        body["config_label"] = json!(label);
        body["engine"] = json!(778893126);
        let body = serde_json::to_vec(&body).unwrap();
        let mut bytes = format!("{{\"body_sha256\":\"{}\",\"body\":", market_runtime::sha256::hex(&body)).into_bytes();
        bytes.extend_from_slice(&body);
        bytes.push(b'}');
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("checkpoint.json"), bytes).unwrap();
    };
    write("flow:r1/event:r1|cal:v1|state:an-older-layout");
    let (loaded, source, problems) = persist::load(&dir, "test");
    assert!(problems.is_empty(), "set aside by design, not a problem: {problems:?}");
    match loaded {
        Some(persist::Restored::Superseded(header)) => {
            assert_eq!((source.as_str(), header.cursor, header.config_label.as_str()), ("current", 8, "flow:r1/event:r1|cal:v1|state:an-older-layout"));
        }
        _ => panic!("an older layout is superseded"),
    }

    write("test");
    let (loaded, _, problems) = persist::load(&dir, "test");
    assert!(loaded.is_none() && problems.iter().any(|p| p.starts_with("current: body:")), "{problems:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Times a real checkpoint (STOCK_MONITOR_CHECKPOINT_DIR) through load, encode and write; run by hand with --ignored.
#[test]
#[ignore]
fn time_a_real_checkpoint() {
    let Ok(dir) = std::env::var("STOCK_MONITOR_CHECKPOINT_DIR") else { return };
    let started = Instant::now();
    let label = persist::label(&crate::rules::load(None, None).0, &calendar::Calendar::default(), &Default::default());
    let (body, source, problems) = persist::load(std::path::Path::new(&dir), &label);
    let Some(persist::Restored::Resume(body)) = body else { panic!("{source} {problems:?}: not resumable under {label}") };
    let loaded = started.elapsed();
    let started = Instant::now();
    let bytes = persist::encode(&body).unwrap();
    let encoded = started.elapsed();
    let out = std::env::temp_dir().join(format!("b-ckpt-time-{}", std::process::id()));
    let started = Instant::now();
    persist::write_bytes(&out, &bytes).unwrap();
    persist::write_bytes(&out, &bytes).unwrap();
    let written = started.elapsed() / 2;
    eprintln!("load {loaded:?} encode {encoded:?} write {written:?} bytes {}", bytes.len());
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn an_undecodable_record_still_names_its_instrument() {
    // A record this build could not type was skipped with nothing but a stderr line.
    let mut raw = serde_json::to_value(accum::tests::trade_at(7, 600, 1, 1_000_000, 2, 1)).unwrap();
    raw["payload"] = json!({"kind": "auction_v9", "anything": [1, 2]});
    assert!(matches!(MarketEvent::decode_value(&raw), Err(Refused::Undecodable(_))), "the fixture must be undecodable");
    let id = lost_instrument(&raw).expect("identity is readable without the payload");
    assert_eq!((id.code.as_str(), id.trading_date.as_str(), id.session.as_str()), ("2330", "2026-09-29", "DAY"));

    let broken = json!({"durable_sequence": 8, "payload": {"kind": "trade"}});
    assert!(lost_instrument(&broken).is_none());
}

const NEVER: Option<&str> = Some(market_runtime::demand::LIVE_NEVER_STORED);

#[test]
fn a_live_lane_epoch_change_marks_every_held_live_family_as_a_gap() {
    // The epoch changed only (epoch, sequence); the old accumulations went on as if complete.
    let crypto = |seq| {
        let mut e = accum::tests::trade_at(seq, 600, 5, 1_000_000, 1, 1);
        e.provider = "futu".into();
        e.market = "CC".into();
        e.code = "CC.BTCUSD".into();
        e.symbol = "futu:CC:CC.BTCUSD".into();
        e
    };
    let mut engine = engine::Engine::new(calendar::Calendar::default(), accum::tests::rules());
    let mut lane = (0, 0);
    let raw = |seq| serde_json::to_value(crypto(seq)).unwrap();
    let gaps = |engine: &engine::Engine| engine.instruments.values().next().unwrap().quality.durable_gaps;
    let (events, outcome) = receive_live_batch(&mut engine, &mut lane, 7, 1, NEVER, vec![raw(1)], 0);
    assert_eq!(outcome, LiveBatchOutcome { joined: Some((1, 0)), ..Default::default() }, "the lane's first message: nothing missed");
    engine.apply(&events[0]);
    let (_, outcome) = receive_live_batch(&mut engine, &mut lane, 7, 2, NEVER, vec![raw(2)], 0);
    assert_eq!(outcome, LiveBatchOutcome::default());
    assert_eq!(gaps(&engine), 0);
    let (_, outcome) = receive_live_batch(&mut engine, &mut lane, 8, 1, NEVER, vec![raw(3)], 0);
    assert_eq!(outcome.epoch_changed, Some((7, 8)), "Market Runtime restarted");
    assert_eq!(gaps(&engine), 1, "the held state carries the gap");

    // An undecodable event is lost input of its partition, never a silent drop.
    let mut bad = raw(4);
    bad["payload"] = json!({"kind": "trade", "price": "not a number"});
    let (events, outcome) = receive_live_batch(&mut engine, &mut lane, 8, 2, NEVER, vec![raw(5), bad], 0);
    assert_eq!((events.len(), outcome.undecodable), (1, 1), "the readable event still applies");
    assert_eq!(gaps(&engine), 2, "its partition is marked");

    // A skipped live_sequence marks every held live family (the lost message's family is unknown).
    let (_, outcome) = receive_live_batch(&mut engine, &mut lane, 8, 5, NEVER, vec![raw(6)], 0);
    assert_eq!(outcome.skipped, Some((2, 5)));
    assert_eq!(gaps(&engine), 3);

    // A repeated batch is not applied twice.
    let (events, outcome) = receive_live_batch(&mut engine, &mut lane, 8, 5, NEVER, vec![raw(6)], 0);
    assert!(outcome.duplicate && events.is_empty());

    // An event of an older format is refused and counted: not applied, and no partition is marked for it.
    let mut older = raw(7);
    older.as_object_mut().unwrap().remove("schema_version");
    let (events, outcome) = receive_live_batch(&mut engine, &mut lane, 8, 6, NEVER, vec![older, raw(8)], 0);
    assert_eq!((events.len(), outcome.old_format, outcome.undecodable), (1, 1, 0));
    assert_eq!(gaps(&engine), 3, "nothing marked for a refused older-format event");
}

#[test]
fn a_searched_stock_is_analysed_from_the_live_lane_but_never_checkpointed_and_its_gap_stays_its_own() {
    // User 10-19: a stock off the background list reaches B over the live lane; B analyses it like any other but
    // writes nothing of it, and a lost live message marks it -- never the stored stocks of the same market.
    let stock = |code: &str, seq| {
        let mut e = accum::tests::trade_at(seq, 600, 5, 1_000_000, 1, 1);
        e.code = code.into();
        e.symbol = format!("shioaji:STK:{code}");
        e
    };
    let unlisted = Some(market_runtime::demand::LIVE_UNLISTED);
    let mut engine = engine::Engine::new(calendar::Calendar::default(), accum::tests::rules());
    let mut lane = (0, 0);
    engine.apply(&stock("2330", 1));
    let (events, _) = receive_live_batch(&mut engine, &mut lane, 7, 1, unlisted, vec![serde_json::to_value(stock("2454", 0)).unwrap()], 0);
    for e in &events {
        engine.apply_live_only(e);
    }
    let codes: Vec<String> = engine.checkpoint_view().instruments.keys().map(|id| id.code.clone()).collect();
    assert_eq!(codes, vec!["2330"], "the searched stock is not in the checkpoint");
    let gaps = |engine: &engine::Engine, code: &str| engine.shown_partitions().find(|(id, _)| id.code == code).unwrap().1.quality.durable_gaps;
    let (_, outcome) = receive_live_batch(&mut engine, &mut lane, 7, 3, unlisted, vec![serde_json::to_value(stock("2454", 0)).unwrap()], 0);
    assert_eq!(outcome.skipped, Some((1, 3)));
    assert_eq!((gaps(&engine, "2454"), gaps(&engine, "2330")), (1, 0), "only the unlisted stock carries the gap");
    // An undecodable event of an unlisted stock is its shown partition's loss, never a stored fold created for it.
    let mut bad = serde_json::to_value(stock("3008", 0)).unwrap();
    bad["payload"] = json!({"kind": "trade", "price": "not a number"});
    let (_, outcome) = receive_live_batch(&mut engine, &mut lane, 7, 4, unlisted, vec![bad], 0);
    assert_eq!(outcome.undecodable, 1);
    assert!(engine.live.instruments.keys().any(|id| id.code == "3008") && !engine.instruments.keys().any(|id| id.code == "3008"));
}

fn live_stock(code: &str, minute: i32) -> MarketEvent {
    let mut e = accum::tests::trade_at(0, minute, 5, 1_000_000, 1, 1);
    e.code = code.into();
    e.symbol = format!("shioaji:STK:{code}");
    e
}

fn live_crypto(minute: i32) -> MarketEvent {
    let mut e = accum::tests::trade_at(0, minute, 5, 1_000_000, 1, 1);
    e.provider = "futu".into();
    e.market = "CC".into();
    e.code = "CC.BTCUSD".into();
    e.symbol = "futu:CC:CC.BTCUSD".into();
    // The partition the crypto market's own calendar puts this moment in.
    e.trading_date = market_runtime::event::partition_local_minute("futu", "CC", "DAY", e.exchange_ts_ns).unwrap().0;
    e
}

#[test]
fn b_joining_the_live_lane_late_marks_a_partition_open_before_it_from_its_open() {
    // B's first live.batch after a restart was taken as the lane's first, so an unlisted stock first seen at 10:01
    // started complete mid-session -- a subscribed one read "no trade" from the open instead of "missing".
    let unlisted = Some(market_runtime::demand::LIVE_UNLISTED);
    let mut engine = engine::Engine::new(calendar::Calendar::default(), accum::tests::rules());
    let mut lane = (0, 0);
    // B joined at 10:00 of the stock's day; Market Runtime had sent 41 live messages before.
    let (events, outcome) = receive_live_batch(&mut engine, &mut lane, 7, 42, unlisted,
                                               vec![serde_json::to_value(live_stock("2454", 601)).unwrap()], accum::tests::ts(600, 0));
    assert_eq!(outcome.joined, Some((42, 0)));
    assert_eq!(outcome.skipped, None, "the lane's first message for this run is not a skip");
    for e in &events {
        engine.apply_live_only(e);
    }
    let inst = engine.live.instruments.values().find(|i| i.id.code == "2454").unwrap();
    assert_eq!(inst.quality.durable_gaps, 1);
    assert!((540..=601).all(|m| inst.minutes.get(&m).is_some_and(|x| x.source_gap)),
            "missing from the 09:00 open through the minute of its first event");
}

#[test]
fn a_partition_that_opened_after_the_late_join_is_complete() {
    // B joined at 05:00: the stock's 09:00 session had not started, so nothing of it was missed.
    let unlisted = Some(market_runtime::demand::LIVE_UNLISTED);
    let mut engine = engine::Engine::new(calendar::Calendar::default(), accum::tests::rules());
    let mut lane = (0, 0);
    let (events, outcome) = receive_live_batch(&mut engine, &mut lane, 7, 42, unlisted,
                                               vec![serde_json::to_value(live_stock("2454", 541)).unwrap()], accum::tests::ts(300, 0));
    assert_eq!(outcome.joined, Some((42, 0)));
    for e in &events {
        engine.apply_live_only(e);
    }
    let inst = engine.live.instruments.values().find(|i| i.id.code == "2454").unwrap();
    assert_eq!(inst.quality.durable_gaps, 0);
    assert!(!inst.minutes.values().any(|m| m.source_gap));
}

#[test]
fn never_stored_partitions_lose_what_came_while_b_was_down_and_after_a_late_join() {
    let never = Some(market_runtime::demand::LIVE_NEVER_STORED);
    let mut engine = engine::Engine::new(calendar::Calendar::default(), accum::tests::rules());
    // A crypto partition held from the checkpoint (applied before this run's first batch).
    engine.apply(&live_crypto(600));
    let mut lane = (0, 0);
    // Market Runtime restarted too (its lane starts at 1): what came between B's checkpoint and now is still gone.
    let (_, outcome) = receive_live_batch(&mut engine, &mut lane, 7, 1, never, vec![serde_json::to_value(live_crypto(610)).unwrap()],
                                          accum::tests::ts(610, 0));
    assert_eq!(outcome.joined, Some((1, 1)), "the checkpoint's crypto partition is marked");
    assert_eq!(engine.instruments.values().next().unwrap().quality.durable_gaps, 1);
    // ...but that is the whole App's downtime, not input B failed to take: no analysis.live_lane_gap joined_late.
    assert_eq!(outcome.late_join(), None);

    // A late join: a crypto partition first seen afterwards (another day's, open around the clock) is marked from
    // its open.
    let mut engine = engine::Engine::new(calendar::Calendar::default(), accum::tests::rules());
    let mut lane = (0, 0);
    let first = live_crypto(700);
    let (events, outcome) = receive_live_batch(&mut engine, &mut lane, 7, 9, never, vec![serde_json::to_value(first.clone()).unwrap()],
                                               first.exchange_ts_ns);
    assert_eq!(outcome.joined, Some((9, 0)));
    assert_eq!(outcome.late_join(), Some((9, 0)), "Market Runtime sent 8 messages before B joined: recorded");
    for e in &events {
        engine.apply(e);
    }
    let inst = engine.instruments.values().next().unwrap();
    assert_eq!(inst.quality.durable_gaps, 1);
    let (_, minute) = market_runtime::event::partition_local_minute("futu", "CC", "DAY", first.exchange_ts_ns).unwrap();
    assert!((0..=minute).all(|m| inst.minutes.get(&m).is_some_and(|x| x.source_gap)), "missing from its open");
}

/// Market Runtime's two lanes as B sees them (`apply_durable_batch`, `apply_live_batch`) against a replay of the
/// durable stream alone (Codex 1020-R04-03, -04, -05, -08): the checkpoint -- engine, features and paper desk -- is
/// exactly the replay's, whatever an unlisted stock did and whichever way it moved on the background list; the
/// screens are shown every event.
#[test]
fn a_checkpoint_is_the_durable_streams_replay_whatever_the_live_lane_carried() {
    let at = |code: &str, seq: u64, minute: i32, price: i64| {
        let mut e = accum::tests::trade_at(seq, minute, 5, price, 1, 1);
        e.code = code.into();
        e.symbol = format!("shioaji:STK:{code}");
        e.sequence = seq.max(minute as u64);
        e
    };
    let control = |code: &str, seq: u64, minute: i32, state: &str, quality: &str, gap: u64| {
        let mut e = at(code, seq, minute, 0);
        e.time_quality = quality.into();
        e.flags.gap_before = gap;
        e.payload = market_runtime::event::Payload::SourceStatus { state: state.into(), detail: String::new() };
        e
    };
    let book = |code: &str, minute: i32, bid: i64| {
        let mut e = at(code, 0, minute, 0);
        e.payload = market_runtime::event::Payload::OrderBook { simtrade: false,
            bids: vec![market_runtime::event::BookLevel { price: bid, volume: 5.0 }],
            asks: vec![market_runtime::event::BookLevel { price: bid + 10_000, volume: 5.0 }] };
        e
    };
    let clock = |seq: u64, minute: i32| {
        let mut e = at(market_runtime::event::CLOCK_CODE, seq, minute, 0);
        e.symbol = "shioaji:STK:*".into();
        e.time_quality = "backend_clock".into();
        e.payload = market_runtime::event::Payload::Clock { minute };
        e
    };
    use market_runtime::event::{COVERAGE_CONTROL, COVERAGE_SUBSCRIBED, LOSS_CONTROL, SOURCE_GAP};
    // (durable?, event): 2330 is listed throughout; 2454 is searched, then listed (a product page), then dropped.
    let stream: Vec<(bool, MarketEvent)> = vec![
        (true, at("2330", 1, 600, 1_000_000)),
        (true, control("2330", 2, 600, COVERAGE_SUBSCRIBED, COVERAGE_CONTROL, 0)),
        // Coverage of a searched stock is durable (R04-04): it must not make the stock stored.
        (true, control("2454", 3, 600, COVERAGE_SUBSCRIBED, COVERAGE_CONTROL, 0)),
        (false, at("2454", 0, 600, 500_000)),
        (false, book("2454", 600, 480_000)),
        // An unlisted print two minutes on must not finalize a stored minute (the stored scope is the WAL's).
        (false, at("2454", 0, 603, 505_000)),
        (true, at("2454", 4, 601, 502_000)),
        (true, book("2454", 601, 490_000)),
        // A re-sent print's stated gap, written in its place (R04-08): a gap, never an unsubscription.
        (true, control("2330", 5, 601, SOURCE_GAP, LOSS_CONTROL, 2)),
        (false, at("2454", 0, 604, 506_000)),
        // Live-only books: no paper book for them (R04-05), whether the stock was ever listed or never.
        (false, book("2454", 604, 470_000)),
        (false, book("3008", 604, 1_200_000)),
        (true, clock(6, 602)),
    ];
    let run = |durable_only: bool| {
        let shared = test_shared();
        *shared.stream_id.lock().unwrap() = "s".into();
        let mut local = test_local(&shared);
        local.engine.rules = accum::tests::rules();
        for (durable, e) in &stream {
            if *durable {
                let mut e = e.clone();
                e.durable_sequence = local.cursor.cursor + 1;
                apply_durable_batch(&shared, &mut local, Some(e.durable_sequence), false, std::iter::once(Ok(e)));
            } else if !durable_only {
                apply_live_batch(&shared, &mut local, Some(market_runtime::demand::LIVE_UNLISTED), std::iter::once(e.clone()));
            }
        }
        let (body, _) = capture_checkpoint(&shared, &local).unwrap();
        // The feature image lists its hash maps as pairs: compared in a fixed order.
        let mut features = serde_json::to_value(body.features).unwrap();
        for list in features.as_object_mut().unwrap().values_mut().filter_map(Value::as_array_mut) {
            list.sort_by_key(|pair| pair.to_string());
        }
        (local, serde_json::to_value(body.engine).unwrap(), features, serde_json::to_value(body.paper).unwrap())
    };
    let (live, engine, features, paper) = run(false);
    let (_, replay_engine, replay_features, replay_paper) = run(true);
    assert_eq!(engine, replay_engine, "the engine checkpoint is the durable stream's replay");
    assert_eq!(features, replay_features, "the feature checkpoint is the durable stream's replay");
    assert_eq!(paper, replay_paper, "the paper desk took the durable stream only");

    // Shown: every event of 2454, its gap-free stored minutes, and 2330's stated loss.
    let shown = live.engine.shown_partitions().find(|(id, _)| id.code == "2454").unwrap().1;
    assert_eq!(shown.minutes.keys().copied().filter(|m| [600, 601, 603, 604].contains(m)).count(), 4, "{:?}", shown.minutes.keys());
    let stored = live.engine.instruments.iter().find(|(id, _)| id.code == "2454").unwrap().1;
    assert!([600, 603, 604].iter().all(|m| stored.minutes.get(m).is_none_or(|m| m.quality.name() != "TRADED")),
            "the stored fold holds the WAL's prints only");
    let listed = live.engine.instruments.iter().find(|(id, _)| id.code == "2330").unwrap().1;
    assert_eq!(listed.quality.source_gaps, 2, "the loss record is a stated gap");
    assert!(listed.minutes[&601].source_gap);
    assert!(live.engine.subscribed.contains_key("shioaji|STK|2330"), "a loss record is no unsubscription");
    let key = features::KeyId { source: "shioaji".into(), market: "STK".into(), trading_date: "2026-09-29".into(), session: "DAY".into(), code: "2454".into() };
    assert_ne!(live.features.snapshot(&key).unwrap().values, live.features.stored_snapshot(&key).unwrap().values,
               "inference sees the unlisted prints, the capture never does");

    // The overlay leaves with its partition.
    let mut engine = live.engine;
    engine.rollover(&std::collections::BTreeMap::from([("shioaji|STK|DAY".to_string(), "2026-09-30".to_string())]));
    assert!(engine.live.instruments.is_empty() && engine.live.scopes.is_empty() && engine.instruments.is_empty());
}

#[test]
fn a_newer_event_schema_stops_consumption_instead_of_skipping_it() {
    assert!(incompatible_schema(&json!({"event_schema_version": EVENT_SCHEMA_VERSION + 1})).is_some_and(|r| r.starts_with(INCOMPATIBLE)));
    assert!(incompatible_schema(&json!({"event_schema_version": EVENT_SCHEMA_VERSION})).is_none());
    assert!(incompatible_schema(&json!({"durable_sequence": 1})).is_none(), "an older Market Runtime does not state it");
}

#[test]
fn a_bucket_query_takes_the_session_minutes_its_bucket_is_on() {
    // flow.large_orders.query names B's bucket minutes: past 1440 on a futures night, before 0 for the previous
    // partition's part of a Futu overnight session. Each row carries the minute it was placed by.
    let mut engine = engine::Engine::new(calendar::Calendar::default(), accum::tests::rules_with_fut());
    for (seq, minute) in [(1, 910), (2, 1470)] {
        let mut e = accum::tests::trade_at(seq, minute, 5, 200_000_000, 3.0, 1);
        (e.market, e.code, e.symbol, e.session) = ("FUT".into(), "TXFR1".into(), "shioaji:FUT:TXFR1".into(), "NIGHT".into());
        engine.apply(&e);
    }
    engine.apply(&accum::tests::as_futu(accum::tests::trade_at(3, 1300, 0, 108_550, 5.0, 1)));
    let mut e = accum::tests::as_futu(accum::tests::trade_at(4, 30, 0, 108_560, 7.0, -1));
    e.trading_date = "2026-09-30".into();
    engine.apply(&e);
    for inst in engine.instruments.values_mut().filter(|i| i.id.source == "futu") {
        let minute = *inst.minutes.iter().find(|(_, m)| !m.ticks.is_empty()).unwrap().0;
        accum::tests::mark_large(inst, minute);
    }
    let ask =|source: &str, market: &str, code: &str, from: i64, to: i64| large_orders_reply(&engine, &json!({"query_id": "q",
        "identity": {"source": source, "market": market, "code": code}, "from_minute": from, "to_minute": to, "limit": 100}));
    let rows = |reply: &Value| reply["rows"].as_array().unwrap().iter()
        .map(|x| (x["durable_sequence"].as_u64().unwrap(), x["minute"].as_i64().unwrap())).collect::<Vec<_>>();
    let night = ask("shioaji", "FUT", "TXFR1", 1440, 1499);
    assert_eq!((night["ok"].as_bool(), rows(&night)), (Some(true), vec![(2, 1470)]), "the night's 00:00 bucket: {night}");
    assert_eq!(rows(&ask("shioaji", "FUT", "TXFR1", 900, 1740)), vec![(2, 1470), (1, 910)]);
    let overnight = ask("futu", "US", "US.NOK", -180, -121);
    assert_eq!(overnight["identity"]["trading_date"], "2026-09-30", "the newest partition answers");
    assert_eq!(rows(&overnight), vec![(3, -140)], "its previous partition's part: {overnight}");
    assert_eq!(rows(&ask("futu", "US", "US.NOK", -240, 239)), vec![(4, 30), (3, -140)]);
}

#[test]
fn a_void_durable_event_is_passed_by_the_cursor_left_out_of_the_fold_and_names_the_checkpoint_label() {
    let list = market_runtime::voided::Voided::parse(br#"[{"source": "shioaji", "market": "STK", "trading_date": "2026-09-29",
        "session": "DAY", "durable": "2-2", "reason": "test print written by mistake"}]"#).unwrap();
    let run = |voided: market_runtime::voided::Voided| {
        let shared = test_shared();
        *shared.stream_id.lock().unwrap() = "s".into();
        let mut local = test_local(&shared);
        local.engine.rules = accum::tests::rules();
        local.voided = Arc::new(voided);
        for (seq, price) in [(1u64, 1_000_000i64), (2, 2_000_000), (3, 1_010_000)] {
            let e = accum::tests::trade_at(seq, 600, seq as i32, price, 1, 1);
            apply_durable_batch(&shared, &mut local, Some(seq), false, std::iter::once(Ok(e)));
        }
        let minute = local.engine.instruments.iter().find(|(id, _)| id.code == "2330").unwrap().1.minutes[&600].clone();
        let label = capture_checkpoint(&shared, &local).unwrap().0.config_label;
        (local.cursor.cursor, minute.high, minute.trades, shared.counters.voided_events.load(Ordering::Relaxed), label)
    };
    let (cursor, high, trades, skipped, label) = run(list);
    assert_eq!((cursor, high, trades, skipped), (3, Some(1_010_000), 2, 1), "the cursor passes the void print, the fold never sees it");
    let (cursor, high, trades, skipped, plain) = run(Default::default());
    assert_eq!((cursor, high, trades, skipped), (3, Some(2_000_000), 3, 0), "the control: without the list the print is folded");
    assert_ne!(label, plain, "a checkpoint names the list it was folded under (a start under another one rebuilds)");
}

#[test]
fn an_odd_lot_event_is_read_by_the_paper_desk_alone_and_passes_the_cursor() {
    // decisions.md 模擬零股的成交方式 (user 11-13): 盤中零股 (the market ODD) is no stock's prints -- never analysed,
    // never a feature -- and the paper desk's odd-lot matching reads it.
    let shared = test_shared();
    let mut local = test_local(&shared);
    let mut odd = accum::tests::trade_at(7, 600, 5, 1_000_000, 37, 1);
    odd.market = "ODD".into();
    odd.symbol = "shioaji:ODD:2330".into();
    let mut touched = Vec::new();
    apply_event(&shared, &mut local, &odd, engine::Lane::Durable, &mut touched);
    assert!(touched.is_empty() && local.engine.instruments.is_empty(), "nothing analysed");
    assert_eq!(local.paper.applied, 7, "the paper desk read it");
    assert_eq!(local.engine.cursor, 7, "and the durable position moved past it");
}
