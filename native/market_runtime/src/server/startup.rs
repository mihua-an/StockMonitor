//! Startup and supervision: the stream identity and epoch, recovery behind a listening port, the data-dir lock, the worker threads and the settings revisions applied while running.

use crate::breadth::{BreadthConfig, MarketBreadth};
use crate::checkpoint::{self};
use crate::contract::{self};
use crate::demand::{BackgroundList, DemandManager};
use crate::latency::Latency;
use crate::panic_message;
use crate::projection::ProjectionCache;
use crate::remediation::{self, utc_iso_ms};
use crate::rollover::{self, MarketSessions, Opened, OpeningGroup, TradingCalendar};
use crate::state::{ApplyResult, Engine};
use crate::wal::{self, WalWriter};
use crate::voided::Voided;
use crate::ws;
use crate::fsutil::atomic_write;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{self, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use super::{hub::*, ingest::*, durable::*, retention::*, session::*, replay_feed::*, commands::*};

pub struct Running {
    pub hub: Arc<Hub>,
    pub port: u16,
    /// Held until the durable shutdown in `wait` is done (see `lock_data_dir`).
    pub(crate) _data_dir_lock: File,
    pub(crate) workers: Workers,
}

impl Running {
    /// Block until the hub stops (shutdown command or fatal error), then finish the durable shutdown. A worker that
    /// panicked is recorded (stderr and remediation) and in the summary, which is then not clean.
    pub fn wait(mut self) -> Result<Value, String> {
        let panicked = self.workers.join_all();
        let mut summary = finish_shutdown(&self.hub)?;
        if !panicked.is_empty() {
            summary["worker_panics"] = json!(panicked);
            summary["clean"] = json!(false);
        }
        Ok(summary)
    }
}

/// The threads `start` spawns, joined together. Until `start` hands them to `Running`, an error on the way drops
/// this: it stops what already runs (`stop`) and joins it, so no loop outlives a failed start holding the hub.
pub(crate) struct Workers {
    pub(crate) stop: Box<dyn Fn() + Send>,
    pub(crate) handles: Vec<(&'static str, JoinHandle<()>)>,
}

impl Workers {
    pub(crate) fn new(stop: impl Fn() + Send + 'static) -> Self {
        Self { stop: Box::new(stop), handles: Vec::new() }
    }

    pub(crate) fn spawn(&mut self, name: &'static str, body: impl FnOnce() + Send + 'static) -> Result<(), String> {
        let handle = thread::Builder::new().name(name.into()).spawn(body).map_err(|e| format!("spawn {name}: {e}"))?;
        self.handles.push((name, handle));
        Ok(())
    }

    /// Join every worker, in spawn order. The ones that panicked, `name: message`, each also recorded.
    pub(crate) fn join_all(&mut self) -> Vec<String> {
        let mut panicked = Vec::new();
        for (name, handle) in self.handles.drain(..) {
            if let Err(payload) = handle.join() {
                let failure = format!("{name}: {}", panic_message(payload.as_ref()));
                eprintln!("[market_runtime] worker panicked: {failure}");
                remediation::emit(remediation::Emit { component: "supervisor", mechanism_id: "market.worker_failure",
                    trigger_reason: "worker_panicked", identity: remediation::Identity::default(), attempt: None,
                    outcome: "failed", detail: json!({"worker": name, "error": failure})});
                panicked.push(failure);
            }
        }
        panicked
    }
}

impl Drop for Workers {
    fn drop(&mut self) {
        if !self.handles.is_empty() {
            (self.stop)();
            self.join_all();
        }
    }
}

/// The recovery responder while `start` recovers. Dropped before `finish` (a recovery step failed), it ends the
/// responder and joins it, so the port is released with the error instead of answering "recovering" forever.
pub(crate) struct Responder {
    pub(crate) progress: Arc<RecoveryProgress>,
    pub(crate) handle: Option<JoinHandle<TcpListener>>,
}

impl Responder {
    /// Recovery is done: the responder closes its waiting connections and hands the listener back.
    pub(crate) fn finish(mut self) -> Result<TcpListener, String> {
        self.progress.done.store(true, Ordering::Release);
        let handle = self.handle.take().expect("the responder is finished once");
        handle.join().map_err(|payload| format!("recovery responder panicked: {}", panic_message(payload.as_ref())))
    }
}

impl Drop for Responder {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            self.progress.done.store(true, Ordering::Release);
            if let Err(payload) = handle.join() {
                eprintln!("[market_runtime] recovery responder panicked: {}", panic_message(payload.as_ref()));
            }
        }
    }
}

/// `Ok(None)` only when the file does not exist; a file that cannot be read or is not JSON is an error naming it.
pub(crate) fn read_json_file(path: &Path) -> Result<Option<Value>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    serde_json::from_str(&text).map(Some).map_err(|e| format!("{}: not JSON: {e}", path.display()))
}

pub(crate) use crate::config_store::{read_active_revision, RevisionRead};

/// Logs an unusable config store once per new reason (the config loop re-reads every 2 s).
/// The sessions the checkpointed cutoffs show opened: a Shioaji day family at a date means that day opened, the
/// futures NIGHT family the night.
pub(crate) fn opened_from_rolled(rolled: &BTreeMap<String, String>, opened: &mut Opened) {
    for (market, session, group) in [("STK", "DAY", OpeningGroup::Day), ("IDX", "DAY", OpeningGroup::Day),
                                     ("FUT", "DAY", OpeningGroup::Day), ("FUT", "NIGHT", OpeningGroup::Night)] {
        if let Some(date) = rolled.get(&rollover::family("shioaji", market, session)) {
            opened.advance(group, date);
        }
    }
}

pub(crate) fn report_unusable(domain: &str, reason: &str, consequence: &str) {
    static SEEN: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
    let mut seen = lock(&SEEN);
    if seen.get(domain).map(String::as_str) != Some(reason) {
        eprintln!("[market_runtime] config {domain} unusable ({reason}): {consequence}");
        seen.insert(domain.to_string(), reason.to_string());
    }
}

/// The active background list; `None` when the store is unusable (the caller keeps what it has).
pub(crate) fn load_background(config_root: Option<&Path>) -> Option<BackgroundList> {
    let doc = match config_root.map(|r| read_active_revision(r, "background")) {
        None | Some(RevisionRead::Absent) => return Some(BackgroundList::default()),
        Some(RevisionRead::Active(doc)) => doc,
        Some(RevisionRead::Unusable(reason)) => {
            report_unusable("background", &reason, "the background list in use is kept");
            return None;
        }
    };
    match serde_json::from_value(doc["values"]["items"].clone()) {
        Ok(items) => Some(BackgroundList { revision: doc["revision"].as_u64(), items }),
        Err(e) => {
            report_unusable("background", &format!("items do not parse: {e}"), "the background list in use is kept");
            None
        }
    }
}

/// The active breadth settings; `None` when the store is unusable (the caller keeps what it has).
pub(crate) fn load_breadth(config_root: Option<&Path>) -> Option<BreadthConfig> {
    let doc = match config_root.map(|r| read_active_revision(r, "breadth")) {
        None | Some(RevisionRead::Absent) => return Some(BreadthConfig::default()),
        Some(RevisionRead::Active(doc)) => doc,
        Some(RevisionRead::Unusable(reason)) => {
            report_unusable("breadth", &reason, "the breadth settings in use are kept");
            return None;
        }
    };
    match serde_json::from_value::<BreadthConfig>(doc["values"].clone()) {
        Ok(mut config) => {
            config.revision = doc["revision"].as_u64();
            Some(config)
        }
        Err(e) => {
            report_unusable("breadth", &format!("values do not parse: {e}"), "the breadth settings in use are kept");
            None
        }
    }
}

pub(crate) const STREAM_IDENTITY_FILE: &str = "durable_stream_id";

pub(crate) const EPOCH_FILE: &str = "runtime_epoch";


/// Failed writes of A's small state files: counted per file and logged once per distinct error.
pub(crate) static FILE_WRITE_FAILURES: crate::fsutil::WriteFailures = crate::fsutil::WriteFailures::new();

/// The stored stream identity: `{durable_stream_id, wal_anchor, wal_anchors}`. `Ok(None)` when none was ever
/// written; one that cannot be read or does not have that shape is an error -- read as absent, a damaged identity
/// was overwritten with a new id and every consumer saw a different stream.
pub(crate) struct StoredIdentity {
    pub(crate) id: String,
    pub(crate) anchor: Option<String>,
    pub(crate) anchors: Vec<String>,
}

pub(crate) fn read_stream_identity(data_dir: &Path) -> Result<Option<StoredIdentity>, String> {
    let path = data_dir.join(STREAM_IDENTITY_FILE);
    let Some(doc) = read_json_file(&path)? else { return Ok(None) };
    let damaged = |what: &str| format!("{}: {what}", path.display());
    let id = doc.get("durable_stream_id").and_then(Value::as_str).filter(|s| !s.is_empty())
        .ok_or_else(|| damaged("durable_stream_id missing or empty"))?.to_string();
    let anchor = match doc.get("wal_anchor") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => return Err(damaged(&format!("wal_anchor {other} is not a string"))),
    };
    let anchors = match doc.get("wal_anchors") {
        None => Vec::new(),
        Some(Value::Array(all)) => all.iter().map(|a| a.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>().ok_or_else(|| damaged("wal_anchors holds a non-string"))?,
        Some(other) => return Err(damaged(&format!("wal_anchors {other} is not a list"))),
    };
    Ok(Some(StoredIdentity { id, anchor, anchors }))
}

/// Stream identity bound to the WAL history (fingerprint of its first record), not to the directory.
pub(crate) fn stream_identity(data_dir: &Path, anchor: Option<String>) -> Result<(String, bool), String> {
    let stored = read_stream_identity(data_dir)?;
    if let (Some(actual), Some(stored)) = (anchor.as_deref(), stored.as_ref()) {
        // Retention moves the anchor to the first remaining record; every anchor a prune could leave behind is
        // registered before any file is removed, so a crash mid-prune keeps the same history.
        if stored.anchor.as_deref() == Some(actual) || stored.anchors.iter().any(|a| a == actual) {
            return Ok((stored.id.clone(), true));
        }
    }
    let id = format!("{:016x}-{:08x}", now_ns(), std::process::id());
    atomic_write(&data_dir.join(STREAM_IDENTITY_FILE), json!({"durable_stream_id": id, "wal_anchor": anchor}).to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    Ok((id, anchor.is_some()))
}

/// Only a missing epoch file starts at 1; an unreadable or non-numeric one stops the start (restarting at 1 would
/// reuse epochs consumers already saw).
pub(crate) fn next_epoch(data_dir: &Path) -> Result<u64, String> {
    let path = data_dir.join(EPOCH_FILE);
    let previous = match fs::read_to_string(&path) {
        Ok(text) => text.trim().parse::<u64>().map_err(|e| format!("{}: {:?} is not an epoch: {e}", path.display(), text.trim()))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => 0,
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let epoch = previous + 1;
    atomic_write(&path, epoch.to_string().as_bytes()).map_err(|e| e.to_string())?;
    Ok(epoch)
}

pub fn start(mut config: ServerConfig) -> Result<Running, String> {
    let started = Instant::now();
    contract::check()?;
    fs::create_dir_all(&config.data_dir).map_err(|e| format!("data dir: {e}"))?;
    let data_dir_lock = lock_data_dir(&config.data_dir)?;
    // Listen before recovering. Scanning and replaying the WAL can take minutes; silent for all of it, A could
    // not be told from a hang by Health, which killed it at its start timeout and started the
    // replay again from zero -- forever. While recovering, the port answers `health` with the progress and refuses
    // everything else, so a supervisor can wait while it advances and only give up when it stops.
    let listener = TcpListener::bind((config.host, config.port)).map_err(|e| format!("bind {}:{}: {e}", config.host, config.port))?;
    // Port 0 asks the system for a free port: the one bound is what `ready` and health report.
    let port = listener.local_addr().map_err(|e| format!("bound address: {e}"))?.port();
    // The endpoint actually bound, as health reports it (Health's applier requires it equal).
    config.port = port;
    // Announced now, before the recovery: `ready` follows only once it is done, and a run on port 0 must be
    // reachable while it recovers.
    println!("{}", json!({"type": "listening", "service_id": SERVICE_ID, "port": port, "pid": std::process::id()}));
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let instance_id = format!("mr-{}-{}", std::process::id(), now_ns());
    remediation::init(SERVICE_ID, &instance_id);
    let progress = Arc::new(RecoveryProgress::default());
    let responder = {
        let (config, instance_id, shared) = (config.clone(), instance_id.clone(), progress.clone());
        let handle = thread::Builder::new().name("recovering".into())
            .spawn(move || recovery_responder(listener, config, instance_id, shared)).map_err(|e| format!("spawn recovering: {e}"))?;
        Responder { progress: progress.clone(), handle: Some(handle) }
    };
    let clean_marker = config.data_dir.join("clean-shutdown");
    let previous_clean = clean_marker.exists();
    let _ = fs::remove_file(&clean_marker);
    // The void events (crate::voided): left out of everything built from the WAL below. A list that cannot be read stops
    // the start, like the holidays file: the state would otherwise hold the events the user decided to remove.
    let voided = Arc::new(Voided::load(config.voided_path.as_deref()).map_err(|why| {
        remediation::emit(remediation::Emit { component: "startup_recovery", mechanism_id: "market.voided_events_file",
            trigger_reason: "voided_events_invalid", identity: remediation::Identity::default(), attempt: None, outcome: "failed",
            detail: json!({"path": config.voided_path.as_ref().map(|p| p.display().to_string()), "error": why})});
        format!("void events: {why}")
    })?);
    *lock(&progress.phase) = "scanning".into();
    // The same pass indexes the trade tape (trade_pages.rs): the trade-detail pages are answered from it.
    let (index, integrity, trades) = wal::scan_indexing_trades(&config.data_dir, true, voided.clone()).map_err(|e| format!("WAL scan: {e}"))?;
    if let Some((segment, removed_bytes)) = integrity.repaired_tail {
        // The previous writer died mid-append; the newest segment was cut back to its last whole record.
        remediation::emit(remediation::Emit { component: "wal_scan", mechanism_id: "market.wal_tail_repair",
            trigger_reason: "unfinished_append", identity: remediation::Identity::default(), attempt: None, outcome: "succeeded",
            detail: json!({"segment": segment, "removed_bytes": removed_bytes, "previous_clean": previous_clean,
                "wal_dir": config.data_dir.display().to_string()}) });
    }
    // Damage inside the WAL is served around and declared as a gap, never a reason to stop recording: this is its
    // record, once per damaged span at every start that still holds the segment.
    for corruption in &integrity.corruption {
        remediation::emit(remediation::Emit { component: "wal_scan", mechanism_id: "market.wal_corruption",
            trigger_reason: "corrupt_record", identity: remediation::Identity::default(), attempt: None, outcome: "failed",
            detail: json!({"segment": corruption.segment, "offset": corruption.offset, "reason": corruption.reason,
                "last_valid_before": corruption.last_valid_before, "first_valid_after": corruption.first_valid_after,
                "wal_dir": config.data_dir.display().to_string()}) });
    }
    let (durable_stream_id, anchored) = stream_identity(&config.data_dir, index.anchor()).map_err(|e| format!("stream identity: {e}"))?;
    let runtime_epoch = next_epoch(&config.data_dir).map_err(|e| format!("epoch: {e}"))?;
    let loaded = checkpoint::load(&config.data_dir);
    let mut engine = Engine::default();
    let mut evidence_image = None;
    let mut from = 0u64;
    let mut checkpoint_source = loaded.source.clone();
    let mut problems = loaded.problems.clone();
    // A checkpoint folded under another void-event list: planned, not a failure (the list is the user's decision),
    // so it is logged and reported in the recovery record, not a remediation.
    let mut voided_changed = None;
    if let Some(body) = loaded.body {
        if body.voided_fingerprint != voided.fingerprint() {
            eprintln!("[market_runtime] checkpoint folded under void-event list {}, now {}: rebuilding from WAL",
                      body.voided_fingerprint, voided.fingerprint());
            voided_changed = Some(json!({"built_under": body.voided_fingerprint, "now": voided.fingerprint(), "checkpoint_sequence": body.durable_sequence}));
            checkpoint_source = "voided_changed".into();
        } else if body.durable_stream_id != durable_stream_id {
            problems.push(format!("checkpoint belongs to stream {} (WAL history is {}); rebuilding from WAL", body.durable_stream_id, durable_stream_id));
            checkpoint_source = "discarded".into();
        } else if body.durable_sequence > index.max_sequence {
            problems.push(format!("checkpoint position {} is beyond the WAL ({}); rebuilding from WAL", body.durable_sequence, index.max_sequence));
            checkpoint_source = "discarded".into();
        } else {
            match Engine::from_image(body.engine) {
                Ok(restored) => {
                    from = body.durable_sequence;
                    engine = restored;
                    evidence_image = Some(body.evidence);
                }
                Err(why) => {
                    problems.push(format!("{why}; rebuilding from WAL"));
                    checkpoint_source = "discarded".into();
                }
            }
        }
    }
    engine.set_capacity(config.hot_capacity);
    // Cutoffs before the replay: a checkpoint-less rebuild must not fill the cache with sessions that already rolled
    // over (they could push the current session's states out), only to drop them afterwards.
    // A named holidays file that fails stops the start (no readiness): the rollover and the trading-day checks of
    // ingest would otherwise run on a calendar nobody chose.
    let holidays_failed = |why: String| {
        remediation::emit(remediation::Emit { component: "startup_recovery", mechanism_id: "market.holidays_calendar",
            trigger_reason: "holidays_file_invalid", identity: remediation::Identity::default(), attempt: None, outcome: "failed",
            detail: json!({"path": config.holidays_path.as_ref().map(|p| p.display().to_string()), "error": why})});
        format!("market holidays: {why}")
    };
    let calendar = TradingCalendar::load(config.holidays_path.as_deref()).map_err(holidays_failed)?;
    let nyse = TradingCalendar::load_nyse(config.holidays_path.as_deref()).map_err(holidays_failed)?;
    let (year, _, _) = crate::event::civil_from_days((now_ns() as i64).div_euclid(86_400_000_000_000));
    for year in [year, year + 1] {
        if !nyse.covers_year(year) {
            // Not fatal: that year's US trading days are weekdays until the file is refreshed (once a year, by hand).
            eprintln!("[market holidays] config/market_holidays.json lists no NYSE days for {year}: US trading days that year are weekdays (OpenD's calendar still applies inside its window)");
        }
    }
    // The sessions file is A's own: one that exists but does not validate stops the start like the holidays file (a
    // closure it holds would otherwise be a trading day again).
    let mut sessions = match config.sessions_path.as_deref() {
        Some(path) => MarketSessions::load(path).map_err(|why| {
            remediation::emit(remediation::Emit { component: "startup_recovery", mechanism_id: "market.sessions_file",
                trigger_reason: "sessions_file_invalid", identity: remediation::Identity::default(), attempt: None, outcome: "failed",
                detail: json!({"path": path.display().to_string(), "error": why})});
            format!("market sessions: {why}")
        })?,
        None => MarketSessions::default(),
    };
    let calendar = calendar.with_closures(&sessions.closures);
    // The US trading days: the NYSE days of the holidays file, with the calendar OpenD published (the Futu provider
    // writes it) laid over them inside its window.
    let us_calendar = rollover::FollowedUsCalendar::new(nyse, config.us_calendar_path.clone());
    // What has opened is also in the checkpoint: a family rolls to a date only once it opened, and the file may have
    // missed the last write before a stop.
    let opened_before = sessions.opened.clone();
    opened_from_rolled(engine.rolled(), &mut sessions.opened);
    let sessions_dirty = sessions.opened != opened_before;
    if config.rollover {
        let now = now_ns() as i64;
        engine.rollover(&rollover::cutoffs(&calendar, &us_calendar.get(), &sessions.opened, now));
        engine.clear(&rollover::clears(now));
    }
    // The session evidence: each partition's file, its stored-event fields set back to the checkpoint's position and
    // the replay below folding what followed (crate::evidence::Ledger::restore).
    let (mut evidence, evidence_problems) = crate::evidence::Ledger::load(config.evidence_root.clone());
    if !evidence_problems.is_empty() {
        report_unusable("session evidence", &evidence_problems.join("; "), "those partitions' records are not read; a new record is made if they get events");
    }
    evidence.restore(evidence_image.as_ref());
    // Every Calendar of this process (session evidence, ingest, the engine) splits a US half day by these dates.
    crate::calendar::install_half_days(us_calendar.get().half_days().clone());
    let replay_started = Instant::now();
    let mut replayed = 0u64;
    let mut applied = 0u64;
    // WAL events naming no real trading date (written before ingest refused them): not applied, counted, recorded.
    let mut invalid_dates = 0u64;
    let mut first_invalid: Option<(u64, String)> = None;
    progress.total.store(index.max_sequence.saturating_sub(from), Ordering::Relaxed);
    *lock(&progress.phase) = "replaying".into();
    // Void events: neither state nor session evidence (crate::voided); counted and recorded once below.
    let mut voided_skipped = 0u64;
    wal::for_each(&config.data_dir, &index, from, |event| {
        replayed += 1;
        progress.replayed.store(replayed, Ordering::Relaxed);
        if !voided.is_empty() && voided.covers(&event) {
            voided_skipped += 1;
            return;
        }
        evidence.fold(&event, evidence.replay_creates);
        match engine.apply(&event).0 {
            ApplyResult::Applied => applied += 1,
            ApplyResult::RejectedInvalidDate => {
                invalid_dates += 1;
                first_invalid.get_or_insert_with(|| (event.durable_sequence, event.trading_date.clone()));
            }
            _ => {}
        }
    })
    .map_err(|e| format!("WAL replay: {e}"))?;
    if invalid_dates > 0 {
        remediation::emit(remediation::Emit { component: "startup_recovery", mechanism_id: "market.recovery_invalid_events",
            trigger_reason: "invalid_trading_date", identity: remediation::Identity::default(), attempt: None, outcome: "suppressed",
            detail: json!({"events": invalid_dates, "first_sequence": first_invalid.as_ref().map(|f| f.0),
                           "first_trading_date": first_invalid.as_ref().map(|f| f.1.clone()), "stream": durable_stream_id})});
    }
    let committed = index.max_sequence.max(from);
    let recovery = json!({
        "previous_shutdown_clean": previous_clean, "checkpoint": checkpoint_source, "checkpoint_problems": problems,
        "checkpoint_sequence": from, "replayed_events": replayed, "applied_events": applied, "invalid_date_events": invalid_dates,
        "replay_ms": replay_started.elapsed().as_millis() as u64, "wal_max_sequence": index.max_sequence,
        "wal_integrity": integrity.status, "startup_ms": started.elapsed().as_millis() as u64,
        "voided": {"list": voided.describe(), "replay_skipped": voided_skipped, "tape_skipped": trades.voided_skipped(),
                   "checkpoint_set_aside": voided_changed},
    });
    if !voided.is_empty() {
        // not an error: events the user decided are void, left out as decided (the record says how many this start met).
        eprintln!("[market_runtime] void events left out: {voided_skipped} of the replay, {} of the trade tape; list {}",
                  trades.voided_skipped(), voided.describe());
    }
    if !problems.is_empty() {
        // The newest checkpoint could not be used -- an older one (or none) was taken and the rest replayed
        // from the WAL. A first start without any checkpoint has no problems and is not a remediation.
        let fallback = matches!(checkpoint_source.as_str(), "previous" | "anchor");
        remediation::emit(remediation::Emit { component: "startup_recovery", mechanism_id: "market.checkpoint_fallback",
            trigger_reason: if fallback { "checkpoint_fallback" } else { "full_wal_replay" }, identity: remediation::Identity::default(),
            attempt: None, outcome: "succeeded",
            detail: json!({"selected": checkpoint_source, "problems": problems, "stream": durable_stream_id, "from_sequence": from,
                           "replayed_events": replayed, "wal_max_sequence": index.max_sequence})});
    }
    // An unusable store at startup has nothing earlier to keep: the defaults, with the reason logged.
    let background = load_background(config.config_root.as_deref()).unwrap_or_default();
    let breadth_config = load_breadth(config.config_root.as_deref()).unwrap_or_default();
    let mut demand = DemandManager::new();
    if let Err(e) = demand.replace_background(background) {
        report_unusable("background", &e, "no background list is applied; every instrument is stored until one is");
    }
    engine.set_pinned(demand.pinned());
    // The replay took time: roll over again to now before anything is served.
    if config.rollover {
        let now = now_ns() as i64;
        engine.rollover(&rollover::cutoffs(&calendar, &us_calendar.get(), &sessions.opened, now));
        engine.clear(&rollover::clears(now));
        write_cutoffs(&config, engine.rolled());
    }
    let mut breadth = MarketBreadth::new(breadth_config);
    for state in engine.iter() {
        breadth.observe(state);
    }
    if let Some(hold) = config.test_recovery_hold {
        thread::sleep(hold);
    }
    let listener = responder.finish()?;
    let hub = Arc::new(Hub {
        config: config.clone(), instance_id, runtime_epoch, durable_stream_id, stream_anchored: AtomicBool::new(anchored),
        core: Mutex::new(Core { engine, storage: demand.storage_policy(), projection: ProjectionCache::default(), breadth, view_seq: HashMap::new(),
            evidence, late_joins: Default::default(), outage_gaps: Default::default(), live_tapes: Default::default() }),
        demand: Mutex::new(demand), latency: Mutex::new(Latency::default()), wal: OnceLock::new(),
        clients: RwLock::new(Vec::new()), 
        counters: Counters::default(), next_client: AtomicU64::new(1), next_subscription: AtomicU64::new(1),
        clock_scopes: Mutex::new(HashMap::new()), 
        integrity: Mutex::new(integrity), recovery: Mutex::new(recovery),
        stalls: Mutex::new(BTreeMap::new()), prune: Mutex::new(()),
        queries: Mutex::new(LargeOrderQueries::default()),
        calendar: RwLock::new(calendar),
        us_calendar,
        sessions: Mutex::new(SessionsState { sessions, dirty: sessions_dirty }),
        broker_since: Mutex::new(HashMap::new()),
        evidence_connections: Mutex::new(BTreeMap::new()),
        lifecycle: Lifecycle { running: AtomicBool::new(true), draining: AtomicBool::new(false), shutdown_receipt: Mutex::new(None) },
        lane: IngestLane { sequencer: Mutex::new(committed + 1), waiting: AtomicU64::new(0), live_sequence: Mutex::new(0) },
        subscriptions: CoverageLedger { recorded: Mutex::new(HashMap::new()), desired: Mutex::new(HashMap::new()), pending: Mutex::new(Vec::new()),
                                        reconcile: Mutex::new(false), sequence: AtomicU64::new(0) },
        checkpointing: Checkpointing { stats: Mutex::new(CheckpointStats::default()), write: Mutex::new(()), events_since: AtomicU64::new(0),
                                       last: Mutex::new(Instant::now()) },
        replays: ReplaySlot { session: Mutex::new(None), next: AtomicU64::new(1), cache: Mutex::new(Default::default()) },
        materialized_trades: Default::default(),
        voided,
    });
    let weak: Weak<Hub> = Arc::downgrade(&hub);
    let writer = WalWriter::open(&config.data_dir, config.wal.clone(), index, committed, Box::new(move |events, last| {
        if let Some(hub) = weak.upgrade() {
            on_commit(&hub, events, last);
        }
    }))
    .map_err(|e| format!("WAL open: {e}"))?;
    // Handed over before anything is appended: the writer extends what the scan found.
    *writer.shared.trades.lock().unwrap() = trades;
    let _ = hub.wal.set(writer);
    // Every loop runs while `hub.running`; one that fails to spawn stops and joins those already started.
    let mut workers = {
        let hub = Arc::downgrade(&hub);
        Workers::new(move || if let Some(hub) = hub.upgrade() { hub.lifecycle.running.store(false, Ordering::Release) })
    };
    let spawn_loop = |workers: &mut Workers, name: &'static str, body: fn(Arc<Hub>)| {
        let hub = hub.clone();
        workers.spawn(name, move || body(hub))
    };
    spawn_loop(&mut workers, "clock", clock_loop)?;
    spawn_loop(&mut workers, "checkpoint", checkpoint_loop)?;
    spawn_loop(&mut workers, "replay", replay_loop)?;
    spawn_loop(&mut workers, "evidence", super::evidence::evidence_loop)?;
    if config.rollover {
        spawn_loop(&mut workers, "rollover", rollover_loop)?;
    }
    if config.config_root.is_some() {
        spawn_loop(&mut workers, "config", config_loop)?;
    }
    {
        let hub = hub.clone();
        workers.spawn("accept", move || accept_loop(hub, listener))?;
    }
    Ok(Running { hub, port, _data_dir_lock: data_dir_lock, workers })
}

pub const DATA_DIR_LOCK_FILE: &str = "market_runtime.lock";

pub(crate) const DATA_DIR_LOCK_WAIT: Duration = Duration::from_secs(5);

/// One Market Runtime per data dir. A second one on the same dir would repair the other's live tail,
/// remove its clean-shutdown marker and append interleaved frames with reused sequences. An OS lock, not a pid file:
/// a crashed owner releases it with its handles, so there is nothing stale to clean up. A previous owner closes its
/// port before its durable shutdown finishes, so a restart right behind it waits `DATA_DIR_LOCK_WAIT` for the handoff.
pub fn lock_data_dir(dir: &Path) -> Result<File, String> {
    let path = dir.join(DATA_DIR_LOCK_FILE);
    let mut file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&path)
        .map_err(|e| format!("data dir lock {}: {e}", path.display()))?;
    let deadline = Instant::now() + DATA_DIR_LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Err(fs::TryLockError::WouldBlock) => {
                return Err(format!("data dir {} is in use by another Market Runtime (lock {DATA_DIR_LOCK_FILE})", dir.display()));
            }
            Err(fs::TryLockError::Error(e)) => return Err(format!("data dir lock {}: {e}", path.display())),
        }
    }
    // Informational only (who holds it); the lock itself is the authority.
    let _ = file.set_len(0).and_then(|_| file.write_all(std::process::id().to_string().as_bytes()));
    Ok(file)
}

/// Where recovery is, for the `health` A answers before it serves (see `start`).
#[derive(Default)]
pub(crate) struct RecoveryProgress {
    pub(crate) phase: Mutex<String>,
    pub(crate) replayed: AtomicU64,
    pub(crate) total: AtomicU64,
    pub(crate) done: AtomicBool,
}

pub(crate) fn recovering_health(config: &ServerConfig, instance_id: &str, progress: &RecoveryProgress, started: Instant) -> Value {
    let (replayed, total) = (progress.replayed.load(Ordering::Relaxed), progress.total.load(Ordering::Relaxed));
    json!({"status": "recovering", "service_id": SERVICE_ID, "instance_id": instance_id, "pid": std::process::id(),
           "clock": config.clock, "protocol": PROTOCOL_VERSION, "config_revision": config.config_revision,
           "host": config.host.to_string(), "port": config.port,
           "recovery": {"phase": lock(&progress.phase).clone(), "replayed": replayed, "total": total,
                        "elapsed_ms": started.elapsed().as_millis() as u64}})
}

/// Serves the port while `start` recovers: `health` answers with the progress, any other command is refused with
/// RECOVERING and the connection closed (CLOSE_RECOVERING). Once recovered every waiting connection is closed with
/// CLOSE_RECOVERED: the client connects again at once, to the real server -- a known handoff, not a failure (an empty
/// close read as the server dropping it, and each start recorded a renderer.live_ws_reconnect). Hands the listener
/// back when done.
pub(crate) fn recovery_responder(listener: TcpListener, config: ServerConfig, instance_id: String, progress: Arc<RecoveryProgress>) -> TcpListener {
    let started = Instant::now();
    while !progress.done.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let (config, instance_id, progress) = (config.clone(), instance_id.clone(), progress.clone());
                let spawned = thread::Builder::new().name("recovering-client".into()).spawn(move || {
                    if let Err(e) = recovering_session(stream, &config, &instance_id, &progress, started) {
                        if e.kind() != io::ErrorKind::PermissionDenied {
                            eprintln!("[market_runtime] recovering session ended at={}: {e}", utc_iso_ms(now_ns()));
                        }
                    }
                });
                if let Err(e) = spawned {
                    eprintln!("[market_runtime] recovering connection dropped: spawn failed: {e}");
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                eprintln!("[market_runtime] accept failed while recovering: {e}");
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    listener
}

pub(crate) fn recovering_session(mut stream: TcpStream, config: &ServerConfig, instance_id: &str, progress: &RecoveryProgress,
                      started: Instant) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    ws::handshake(&mut stream, &config.credentials)?;
    let reader = ws::FrameReader::spawn(&stream, ws::CLIENT_FRAMES, "recovering-reader")?;
    loop {
        match reader.next(Duration::from_millis(500)) {
            Ok(None) => {
                if progress.done.load(Ordering::Acquire) {
                    return ws::write_close(&mut stream, ws::CLOSE_RECOVERED, "recovered");
                }
            }
            Ok(Some((8, _))) => return Ok(()),
            Ok(Some((9, p))) => ws::write_frame(&mut stream, 10, &p)?,
            Ok(Some((1, p))) | Ok(Some((2, p))) => {
                let command: Value = serde_json::from_slice(&p).unwrap_or(Value::Null);
                let health = recovering_health(config, instance_id, progress, started);
                if command.get("type").and_then(Value::as_str) == Some("health") {
                    write_json(&mut stream, &json!({"type": "health", "payload": health}))?;
                } else {
                    write_json(&mut stream, &json!({"type": "error", "error": "RECOVERING", "payload": health}))?;
                    return ws::write_close(&mut stream, ws::CLOSE_RECOVERING, "recovering");
                }
            }
            Ok(Some(_)) => {}
            Err(e) => {
                ws::answer_violation(&mut stream, &e);
                return Err(e);
            }
        }
    }
}

pub(crate) fn accept_loop(hub: Arc<Hub>, listener: TcpListener) {
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    while hub.lifecycle.running.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let hub = hub.clone();
                join_finished_clients(&mut workers, false);
                match thread::Builder::new().name("client".into()).spawn(move || {
                    if let Err(e) = client_session(stream, hub) {
                        if e.kind() != io::ErrorKind::PermissionDenied {
                            eprintln!("client session ended at={}: {e}", utc_iso_ms(now_ns()));
                        }
                    }
                }) {
                    Ok(handle) => workers.push(handle),
                    Err(e) => eprintln!("[market_runtime] connection dropped: spawn client failed: {e}"),
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                eprintln!("accept failed: {e}");
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    // Wake every client so its session ends promptly.
    for client in hub.clients.read().unwrap().iter() {
        if let Some(socket) = client.socket.as_ref() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
    join_finished_clients(&mut workers, true);
}

/// Join the client sessions that ended (`all`: every one, waiting), recording any that panicked.
pub(crate) fn join_finished_clients(workers: &mut Vec<JoinHandle<()>>, all: bool) {
    let mut running = Vec::with_capacity(workers.len());
    for handle in workers.drain(..) {
        if !all && !handle.is_finished() {
            running.push(handle);
        } else if let Err(payload) = handle.join() {
            eprintln!("[market_runtime] client session panicked: {}", panic_message(payload.as_ref()));
        }
    }
    *workers = running;
}

pub(crate) fn apply_breadth(hub: &Hub, config: BreadthConfig) -> Value {
    let mut core = lock(&hub.core);
    core.breadth.configure(config);
    let states: Vec<_> = core.engine.iter().cloned().collect();
    for s in &states {
        core.breadth.observe(s);
    }
    core.breadth.wire()
}

/// settings_api activates a background or breadth revision on save ("active on save; market_runtime loads it"):
/// this loop is that load. It reads the active revision pointers every 2 s and applies a revision it has not applied
/// yet. Before, both were read once at startup, so a saved background list -- the product pages, the holdings, the
/// market context -- waited for the next restart.
pub(crate) fn config_loop(hub: Arc<Hub>) {
    let Some(root) = hub.config.config_root.clone() else { return };
    while hub.lifecycle.running.load(Ordering::Acquire) {
        thread::sleep(Duration::from_secs(2));
        let Some(background) = load_background(Some(&root)) else { continue };
        if background.revision.is_some() && background.revision != lock(&hub.demand).background().revision {
            let revision = background.revision;
            match install_background(&hub, background) {
                Ok(()) => eprintln!("[market_runtime] background list revision {revision:?} applied"),
                Err(e) => report_unusable("background", &format!("revision {revision:?} refused: {e}"), "the background list in use is kept"),
            }
        }
        if let Some(breadth) = load_breadth(Some(&root)) {
            if breadth.revision.is_some() && breadth.revision != lock(&hub.core).breadth.revision() {
                apply_breadth(&hub, breadth);
            }
        }
    }
}
