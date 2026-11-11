//! The process's modes: the offline jobs, and the daemon's start (restore, threads, Health's channel, stop).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use market_runtime::remediation;
use serde_json::{json, Value};
use crate::contract::{SpecIdentity, PROTOCOL};
use crate::cursor::DurableCursor;
use crate::features::FeatureStore;
use crate::queue::TaskQueue;
use crate::{archive, baseline, cli, contract, daily_summary, dataset, engine, kbar_store, materialize, outbox, paper, persist, signals, timing, rules, verify};
use market_runtime::calendar;
use market_runtime::voided::Voided;
use super::{shared::*, control_stdio::*, inference_runtime::*, checkpoint_service::*, stream_runtime::*};

/// The offline modes: each answers on stdout (a JSON result line) and ends the process.
pub fn run_job(mode: cli::Mode) {
    match mode {
        // Offline: the historical materialization job (Health spawns it per sealed session; see materialize.rs).
        cli::Mode::Materialize { flags, stdin_gate, config_root } => {
            // Started by Health: nothing is read or written until Health, having made its owner record of this process
            // durable, says "start" on stdin. A Health that dies first closes stdin and the job ends untouched.
            if stdin_gate {
                let mut line = String::new();
                if !matches!(std::io::stdin().read_line(&mut line), Ok(_) if line.trim() == "start") {
                    println!("{}", json!({"ok": false, "status": "retryable", "error": "not started: stdin closed before \"start\" (no owner record)"}));
                    std::process::exit(1);
                }
            }
            // History is folded under the rules in force: with a damaged rule domain it would be written without them.
            let (rules_set, rule_problems) = rules::load(config_root.as_deref(), None);
            if !rule_problems.is_empty() {
                println!("{}", json!({"ok": false, "status": "retryable", "error": format!("rules unreadable: {}", rule_problems.join("; "))}));
                std::process::exit(1);
            }
            // A US half day's sessions are shorter: the job splits by the same calendar as Rust A (the built-in NYSE
            // days, with OpenD's calendar when Health names it).
            if let Some(path) = flags.get("--us-trading-calendar") {
                match market_runtime::rollover::TradingCalendar::load_nyse(None) {
                    Ok(nyse) => market_runtime::rollover::follow_us_half_days(
                        market_runtime::rollover::FollowedUsCalendar::new(nyse, Some(path.into()))),
                    Err(e) => {
                        println!("{}", json!({"ok": false, "status": "retryable", "error": format!("NYSE days unreadable: {e}")}));
                        std::process::exit(1);
                    }
                }
            }
            // Progress lines go to stderr (materialize.rs); stdout carries only the result line.
            let mut stderr = std::io::stderr();
            let mut progress = dataset::Progress::new(&mut stderr, dataset::PROGRESS_INTERVAL);
            match materialize::run(&flags, rules_set, &mut progress) {
                Ok(result) => println!("{result}"),
                Err(error) => {
                    // A job failure (I/O, an unreadable WAL) is transient: the orchestrator retries it, never reads it as
                    // a verdict about the session's data.
                    println!("{}", json!({"ok": false, "status": "retryable", "error": error}));
                    std::process::exit(1);
                }
            }
        }
        // Offline: whether materialized partitions are still what their manifests describe (historical_store.py asks).
        cli::Mode::VerifyPartitions(dirs) => {
            let dirs: Vec<&str> = dirs.iter().map(String::as_str).collect();
            println!("{}", verify::run(&dirs));
        }
        // The identity of the one FeatureSpec this build computes: the trainer and model_api ask the binary, not a copy.
        cli::Mode::FeatureSpec => {
            let spec = feature_spec();
            println!("{}", json!({"spec_id": spec.spec_id, "schema_digest": spec.schema_digest,
                                  "feature_version": spec.feature_version, "preprocessing_version": spec.preprocessing_version,
                                  "fold_version": crate::features::FOLD_VERSION}));
        }
        // Offline: the training feature dataset (the only feature implementation is this process's). No stream, no state.
        // Progress lines go to stderr (dataset.rs); stdout carries only the result line.
        cli::Mode::ExportFeatures(export) => {
            let mut stderr = std::io::stderr();
            let mut progress = dataset::Progress::new(&mut stderr, dataset::PROGRESS_INTERVAL);
            let result = dataset::export(&export, &feature_spec(), &mut progress);
            let progress_write_failures = progress.failures();
            match result {
                Ok(manifest) => {
                    println!("{}", json!({"ok": true, "samples": manifest["samples"], "degraded": manifest["degraded"],
                                          "feature_spec": manifest["feature_spec"], "progress_write_failures": progress_write_failures}));
                }
                Err(error) => {
                    println!("{}", json!({"ok": false, "error": error, "progress_write_failures": progress_write_failures}));
                    std::process::exit(1);
                }
            }
        }
        // Offline: the daily summaries of sessions already in the historical store (daily_summary.rs).
        cli::Mode::SummarizeHistory { historical_root, out_dir, source, dates } => {
            let result = daily_summary::summarize_history(&historical_root, &out_dir, &source, &dates);
            println!("{result}");
            if result["ok"] != json!(true) {
                std::process::exit(1);
            }
        }
        // One product's broker download into the K-bar store (the download job runs this after each segment).
        cli::Mode::ImportKbars { kbar_dir, input, retention_config_root } => {
            let result = std::fs::read(&input).map_err(|e| format!("reading {}: {e}", input.display()))
                .and_then(|bytes| serde_json::from_slice::<kbar_store::ImportFile>(&bytes).map_err(|e| format!("{}: {e}", input.display())))
                .and_then(|file| kbar_store::Store::new(kbar_dir, retention_config_root).import(&file));
            match result {
                Ok(answer) => println!("{answer}"),
                Err(error) => {
                    println!("{}", json!({"ok": false, "error": error}));
                    std::process::exit(1);
                }
            }
        }
        cli::Mode::GapReport { historical_root, source, market, trading_date, session, expected_codes } => {
            println!("{}", crate::history_gaps::report(&historical_root, &source, &market, &trading_date, &session, &expected_codes));
        }
        cli::Mode::FeatureContext { source, dates, context } => {
            let out: serde_json::Map<String, Value> = dates.iter().map(|d| (d.clone(), context.fingerprint(&source, d))).collect();
            println!("{}", json!({"ok": true, "dates": out}));
        }
        cli::Mode::Daemon(_) => unreachable!("the daemon is not a job"),
    }
}

/// The one FeatureSpec this build computes, checked against its own digest: a build whose embedded spec fails it
/// refuses to start.
pub(crate) fn feature_spec() -> SpecIdentity {
    let spec_value = contract::online_v3_feature_spec();
    let spec = SpecIdentity::of(&spec_value);
    if contract::schema_digest(&spec_value) != spec.schema_digest || spec_value.get("schema").and_then(Value::as_str) != Some(contract::FEATURE_SPEC_SCHEMA) {
        eprintln!("[analysis_runtime] embedded FeatureSpec fails its own digest; refusing to start");
        std::process::exit(2);
    }
    spec
}

/// Rust B as Health runs it: restore, connect to Market Runtime, serve Health's commands on stdin until told to stop.
pub fn run_daemon(options: cli::DaemonOptions) {
    let spec = feature_spec();
    let url = options.runtime_url.clone();
    let token = match std::fs::read_to_string(&options.token_file).map(|t| t.trim().to_string()) {
        Ok(t) if t.len() >= 16 => t,
        Ok(_) => {
            eprintln!("[analysis_runtime] --token-file {} holds no analysis_runtime credential", options.token_file.display());
            std::process::exit(2);
        }
        Err(e) => {
            eprintln!("[analysis_runtime] --token-file {}: {e}", options.token_file.display());
            std::process::exit(2);
        }
    };
    let data_dir = options.data_dir.clone();
    let config_root = options.config_root.clone();
    // model_api writes the inference config here; B writes its inference status next to it (no IPC, no FastAPI).
    let inference_dir = options.inference_dir.clone();
    let publish_ms = options.publish_interval.as_millis() as u64;
    let checkpoint_s = options.checkpoint_interval.as_secs();
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("[analysis_runtime] --data-dir {}: {e}", data_dir.display());
        std::process::exit(2);
    }
    // Stock summaries written before their verdict file existed get one, off the start (daily_summary.rs).
    if let Some(dir) = options.context.summary_dir.clone() {
        std::thread::spawn(move || {
            let written = crate::daily_summary::Publisher::new(&dir).write_missing_verdicts();
            if written > 0 {
                eprintln!("[analysis_runtime] daily summary verdicts written for {written} sessions that had none");
            }
        });
    }
    // 量變's baselines need the trading days: a named holidays file that cannot be read or does not validate stops the
    // start (the built-in copy may be a year behind it, and a baseline chosen by the wrong previous session is a wrong
    // 量變).
    let calendar = match market_runtime::rollover::TradingCalendar::load(options.market_holidays.as_deref()) {
        Ok(calendar) => calendar,
        Err(e) => {
            eprintln!("[analysis_runtime] --market-holidays unusable: {e}");
            std::process::exit(2);
        }
    };
    // Rust A's void-event list (market_runtime voided.rs): the durable events the fold leaves out. One that cannot be read
    // or does not validate stops the start, as it stops A's: the state would otherwise hold what the user removed.
    let voided = match Voided::load(options.voided_events.as_deref()) {
        Ok(voided) => Arc::new(voided),
        Err(e) => {
            eprintln!("[analysis_runtime] --voided-events unusable: {e}");
            std::process::exit(2);
        }
    };
    // The US half days, from the same files as Rust A (the NYSE days of the holidays file with OpenD's calendar laid
    // over them): every Calendar of this process splits a half day's sessions by them.
    match market_runtime::rollover::TradingCalendar::load_nyse(options.market_holidays.as_deref()) {
        Ok(nyse) => market_runtime::rollover::follow_us_half_days(
            market_runtime::rollover::FollowedUsCalendar::new(nyse, options.us_trading_calendar.clone())),
        Err(e) => {
            eprintln!("[analysis_runtime] --market-holidays unusable for the NYSE days: {e}");
            std::process::exit(2);
        }
    }
    let calendar = match market_runtime::rollover::FollowedCalendar::new(calendar, options.market_sessions.clone()) {
        Ok(calendar) => calendar,
        Err(e) => {
            eprintln!("[analysis_runtime] --market-sessions unusable: {e}");
            std::process::exit(2);
        }
    };
    let baselines = Arc::new(baseline::Store::with_calendar(options.volume_baseline_root.clone(), calendar));
    // B manages the historical store (market_runtime historical_store.rs): pruned now (every date's totals checked
    // against its partitions with it) and again at each rollover, on a thread of its own -- a prune waits for the store
    // lock while a materialization job publishes, and lists the whole store.
    let historical_prune = options.historical.clone().map(|config| {
        let (wake, woken) = std::sync::mpsc::channel();
        thread::Builder::new().name("historical-store".into())
            .spawn(move || historical_store_loop(market_runtime::historical_store::Store::new(config), woken)).expect("historical store thread");
        wake
    });

    let shared = Arc::new(Shared {
        instance: format!("ar-{}-{}", std::process::id(), now_ns()), spec: spec.clone(), stop: AtomicBool::new(false),
        config: RwLock::new(None), epoch: AtomicU64::new(0), stream_id: Mutex::new(String::new()), queue: TaskQueue::new(1),
        results: ResultOutbox::default(), signals_health: Mutex::new(json!({})), counters: Counters::default(), view: Mutex::new(StreamView::default()),
        reload: AtomicBool::new(false), reschedule: AtomicBool::new(false), ready_said: AtomicBool::new(false), capture: Mutex::new(None),
        startup_only: Mutex::new(None), restart_required: Mutex::new(Vec::new()), config_state: Mutex::new(json!({"state": "ABSENT"})), checkpoint_failed_by_stage: Mutex::new(Default::default()), checkpoint_retry: Mutex::new(None),
        incompatible: Mutex::new(None), stop_deadline: Mutex::new(None),
        archive: Mutex::new(archive::Archive::new(options.events_dir.clone())), baselines: baselines.clone(),
    });
    remediation::init(SERVICE_ID, &shared.instance);

    // Restore the checkpoint (bumping the projection epoch: results published after it by the previous
    // incarnation must be superseded, never mistaken for older ones).
    let (rules_set, rule_problems) = rules::load(config_root.as_deref(), None);
    let current_label = persist::label(&rules_set, &calendar::Calendar::default(), &voided);
    let (loaded, source, problems) = persist::load(&data_dir, &current_label);
    if !problems.is_empty() {
        // The newest checkpoint could not be used; B restores the previous one, or none and replays from the
        // WAL. Recorded when decided. A first start without any checkpoint has no problems.
        let cursor = loaded.as_ref().map(persist::Restored::cursor);
        eprintln!("[analysis_runtime] checkpoint not restored as-is: using {source} (cursor {cursor:?}); problems: {}", problems.join("; "));
        remediation::emit(remediation::Emit { component: "startup_restore", mechanism_id: "analysis.checkpoint_fallback",
            trigger_reason: if source == "previous" { "checkpoint_fallback" } else { "full_replay" },
            identity: remediation::Identity::default(), attempt: None, outcome: "succeeded",
            detail: json!({"selected": source, "problems": problems, "cursor": cursor})});
    }
    let mut local = Local {
        cursor: DurableCursor::default(), features: FeatureStore::with_context(options.context.clone()), engine: engine::Engine::new(calendar::Calendar::default(), rules_set.clone()),
        // Without a checkpoint B cannot know the epoch A last accepted. Starting at 1 made A reject the whole rebuilt
        // projection as a stale epoch ("1 < 9") and keep serving what the previous incarnation said.
        // Wall-clock seconds are above any epoch a checkpointed restart (+1 each) could have reached.
        projection_epoch: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(1).max(1), need_full_publish: true, last_publish: Instant::now(), last_status: Instant::now() - timing::STATUS_INTERVAL,
        last_checkpoint: Instant::now(), last_rules_check: Instant::now(), rules_stamp: rules_stamp(config_root.as_deref()),
        rule_problems, checkpoint_info: json!({"restored_from": source, "problems": problems}),
        checkpoints: CheckpointWriter::start(shared.clone()), replaying: true, timelines: Vec::new(), timeline_out: Default::default(), foreground: Default::default(), open_replays: HashMap::new(), live_lane: (0, 0), republish_signals: true,
        outbox: outbox::Outbox::default(), awaiting_full_publish: Vec::new(), signals_republish: None,
        republish_batches: RepublishBatches::default(),
        signal_acks: SignalAcks::default(),
        signals: signals::SignalBook::default(), signals_invalidated: Vec::new(), reconnect_pending: None, signal_config_version: 0, historical_prune,
        paper: paper::PaperDesk::default(), paper_dir: options.paper_dir.clone(), voided: voided.clone(),
    };
    let loaded = match loaded {
        // Rules, calendar or the state's layout changed while B was stopped (an edit or a new build): the state was
        // built under the old ones. Rebuild from the stream (as a live rule change does) instead of resuming a mix;
        // a newer projection epoch replaces what A holds. Planned, not a failure: logged and shown in the status's
        // checkpoint, not a remediation (docs/decisions.md 什麼算補救).
        Some(persist::Restored::Superseded(header)) => {
            eprintln!("[analysis_runtime] checkpoint built under {:?}, now {current_label}: rebuilding from the stream", header.config_label);
            local.projection_epoch = header.projection_epoch + 1;
            local.checkpoint_info["discarded"] = json!({"built_under": header.config_label, "now": current_label, "cursor": header.cursor});
            None
        }
        Some(persist::Restored::Resume(body)) => Some(body),
        None => None,
    };
    if let Some(body) = loaded {
        let mut engine = body.engine;
        engine.cal = calendar::Calendar::default();
        engine.rules = rules_set;
        local.engine = engine;
        local.features = FeatureStore::from_image(body.features, options.context.clone());
        local.paper = paper::PaperDesk::restore(body.paper);
        local.cursor.cursor = body.cursor;
        local.cursor.head = body.cursor;
        local.cursor.stream_id = Some(body.durable_stream_id.clone());
        local.projection_epoch = body.projection_epoch + 1;
        *shared.stream_id.lock().unwrap() = body.durable_stream_id;
    }
    // 模擬下單: the paper ledger's matching directory (orders in, results out); without it no order is matched.
    if local.paper_dir.is_none() {
        eprintln!("[analysis_runtime] no --paper-dir: paper orders are not matched");
    }
    local.paper.open(local.paper_dir.clone());
    // Startup comparison: what the checkpointed state holds and the event files lack is written now; events after
    // the checkpoint are recomputed from the durable stream (replay) and archived as they are published.
    let repaired = shared.archive.lock().unwrap().reconcile(&held_events(&local.engine), archive::Reconcile::Startup);
    local.checkpoint_info["event_archive_repaired"] = json!(repaired);
    local.engine.baselines = baselines;
    stdout_line(&json!({"type": "hello", "service_id": SERVICE_ID, "instance_id": shared.instance, "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL, "restored_cursor": local.cursor.cursor,
        "projection_epoch": local.projection_epoch, "checkpoint": local.checkpoint_info,
        "feature_specs": [{"spec_id": spec.spec_id, "schema_digest": spec.schema_digest}],
        "model_formats": {"builtin-test": "TEST_ONLY", "onnx": "CPU"}}));

    {
        let s = shared.clone();
        let dir = inference_dir.clone();
        thread::Builder::new().name("inference-config".into()).spawn(move || watch_inference_config(s, dir)).expect("config thread");
    }
    {
        let s = shared.clone();
        let dir = inference_dir.clone();
        thread::Builder::new().name("health".into()).spawn(move || {
            while !s.stop.load(Ordering::Acquire) {
                thread::sleep(timing::STATUS_INTERVAL);
                stdout_line(&metrics(&s));
                if let Some(dir) = &dir {
                    write_inference_status(&s, dir);
                }
            }
        }).expect("health thread");
    }
    let stream = {
        let s = shared.clone();
        let args = StreamArgs { url, token, data_dir: data_dir.clone(), config_root, publish_interval: Duration::from_millis(publish_ms),
            checkpoint_interval: Duration::from_secs(checkpoint_s) };
        thread::Builder::new().name("stream".into()).spawn(move || stream_loop(s, args, local)).expect("stream thread")
    };
    serve_health_commands(&shared);
    shared.stop.store(true, Ordering::Release);
    shared.queue.close();
    // The stream thread is waited for only until the deadline (plus the margin it already left): a turn stuck past it
    // is reported, not waited out until Health kills the process without a receipt.
    let deadline = stop_deadline(&shared) + Duration::from_millis(STOP_REPORT_MARGIN_MS / 2);
    while !stream.is_finished() && Instant::now() < deadline {
        thread::sleep(timing::STOP_JOIN_CHECK);
    }
    let joined = stream.is_finished() && stream.join().is_ok();
    // Clean = the stream thread finished and its final checkpoint did not fail (a never-connected B has nothing
    // to checkpoint, which is clean).
    let checkpoint = shared.view.lock().unwrap().last_checkpoint.clone();
    let clean = joined && checkpoint.get("error").is_none();
    stdout_line(&json!({"type": "stopped", "service_id": SERVICE_ID, "instance_id": shared.instance, "clean": clean,
        "checkpoint": checkpoint, "metrics": metrics(&shared)}));
    std::process::exit(0);
}

/// The historical store's prune (retention, then every date's totals checked against its partitions): once at the
/// start, then at every wake (a rollover that moved the cutoffs). Ends when the stream loop, holding the sender, is gone.
fn historical_store_loop(store: market_runtime::historical_store::Store, woken: std::sync::mpsc::Receiver<()>) {
    let prune = |when: &str| match store.prune() {
        Ok(done) => eprintln!("[analysis_runtime] historical store {} pruned {when}: {} stored partitions removed (storage retention), totals rebuilt for {} dates",
                              store.root().display(), done.removed, done.totals_rebuilt),
        Err(e) => eprintln!("[analysis_runtime] historical store {} prune {when}: {e}; tried again at the next rollover", store.root().display()),
    };
    prune("at start");
    while woken.recv().is_ok() {
        // Several rollovers queued while one prune ran need only one more.
        while woken.try_recv().is_ok() {}
        prune("at rollover");
    }
}
