//! 歷史回放 inside Market Runtime: one recorded partition played back through the same state engine
//! and the same view protocol as the live market, so the replay page shows exactly what the live page showed.
//!
//! Isolation from the live market is structural, not a flag checked here and there:
//! * a replay has its own `Engine` and `ProjectionCache` -- the live `Core` is never touched;
//! * nothing is written: no WAL record, no checkpoint, no durable sequence, no clock event in the live stream;
//! * its views are bound to its replay id, and a live delta can never match them (nor a replay delta a live view).
//!
//! Timing: events are applied in their recorded (arrival) order -- the order the live engine saw them, so its
//! sequence fences accept them exactly as they did live -- and each is due at the later of its own exchange time and
//! the previous event's due time. A print is therefore shown at its own exchange microsecond (times `speed`), not a
//! second's worth at once.

use crate::event::{parse_calendar_date, partition_local_minute, EventFlags, MarketEvent, Payload, Refused, StateKey, CLOCK_CODE, EVENT_SCHEMA_VERSION};
use crate::historical_store::PartitionKey;
use crate::projection::ProjectionCache;
use crate::state::{ApplyResult, Changed, Engine};
use crate::voided::Voided;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

/// Speeds the player accepts (user decision: 1, 2, 5, 10; never faster -- B replays the same events).
pub const SPEEDS: [u32; 4] = [1, 2, 5, 10];
/// Events one partition may hold in memory (a busy stock's day is ~100k).
pub const MAX_EVENTS: usize = 2_000_000;
/// At most this many events are applied per scheduling step, so one step never holds the replay for long.
pub const STEP_EVENTS: usize = 5_000;
/// Checkpoints of one recording at most, and the fewest events between two. They are built over the whole day in the
/// background when the recording is loaded, so a seek anywhere re-applies at most one interval. Rust B's timeline
/// spans are cut by the same rule over the recording's steps (timeline::span_len).
pub const CHECKPOINTS_MAX: usize = 400;
pub const CHECKPOINT_MIN_EVENTS: usize = 250;

/// The events between two checkpoints of a partition of `total` lines (its manifest's verified `event_count`); the
/// steps of a timeline span by the same rule (timeline::span_len).
pub fn checkpoint_interval(total: usize) -> usize {
    total.div_ceil(CHECKPOINTS_MAX).max(CHECKPOINT_MIN_EVENTS)
}

/// Recordings kept loaded, with their checkpoints, after their replay closed: reopening one (the page reopened, another
/// stock and back) neither reads the partition again nor rebuilds a checkpoint. A closed one goes after
/// `CACHE_IDLE`; past `CACHE_RECORDINGS` the one closed longest ago goes first. Rust B keeps its checkpoints by the
/// same rule.
pub const CACHE_RECORDINGS: usize = 3;
pub const CACHE_IDLE: Duration = Duration::from_secs(30 * 60);

/// The replay engine as it stood with events `..index` applied (the recording never changes, so neither does it).
pub struct Checkpoint {
    pub index: usize,
    engine: Engine,
    tally: ApplyTally,
}

/// The identity of the recorded partition being replayed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Partition {
    pub source: String,
    pub market: String,
    pub code: String,
    pub trading_date: String,
    pub session: String,
}

fn component_ok(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !value.contains("..")
}

impl Partition {
    /// Validated identity (path components only: letters, digits, '-', '_', '.', never "..").
    pub fn new(source: &str, market: &str, code: &str, trading_date: &str, session: &str) -> Result<Self, String> {
        let p = Self { source: source.trim().to_lowercase(), market: market.trim().to_uppercase(), code: code.trim().to_uppercase(),
                       trading_date: trading_date.trim().to_string(), session: session.trim().to_uppercase() };
        for (name, value) in [("source", &p.source), ("market", &p.market), ("code", &p.code), ("trading_date", &p.trading_date), ("session", &p.session)] {
            if !component_ok(value) {
                return Err(format!("invalid {name}"));
            }
        }
        if parse_calendar_date(&p.trading_date).is_none() {
            return Err("invalid trading_date".into());
        }
        Ok(p)
    }

    /// Where the historical materializer wrote this partition.
    pub fn events_path(&self, historical_dir: &Path) -> PathBuf {
        PartitionKey::new(&self.source, &self.market, &self.trading_date, &self.session, &self.code).dir(historical_dir).join("events.jsonl")
    }
}

/// FNV-1a 64, the content hash of materialized partitions, datasets and volume baselines (and of the Python
/// publishers that write them), fed piece by piece so a large partition need not be in memory at once. It identifies
/// content; it is not a security digest. Market Runtime and Rust B both hash with this one implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fnv1a64(u64);

impl Default for Fnv1a64 {
    fn default() -> Self {
        Self(0xcbf29ce484222325)
    }
}

impl Fnv1a64 {
    pub fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= *byte as u64;
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    /// 16 lowercase hex digits, as every manifest writes it.
    pub fn hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

/// The hash of `bytes` as 16 hex digits.
pub fn fnv1a64(bytes: &[u8]) -> String {
    let mut hash = Fnv1a64::default();
    hash.update(bytes);
    hash.hex()
}

/// What a verified partition's manifest committed: its content hash and its line count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    pub content_hash: String,
    pub lines: u64,
}

/// Committed means manifest-first: the materializer writes events -> state -> manifest, so a partition
/// without `manifest.json` is still being written (or was abandoned) and is not replayed. One whose bytes or line count
/// differ from what its manifest committed is refused as CORRUPT, never played with lines silently skipped.
pub fn verify_committed(path: &Path, bytes: &[u8]) -> Result<Committed, String> {
    let lines = bytes.split(|b| *b == b'\n').filter(|l| l.iter().any(|b| !b.is_ascii_whitespace())).count() as u64;
    check_committed(path, lines, fnv1a64(bytes))
}

/// `verify_committed` for a partition read as a stream: its non-blank line count and content hash as measured.
pub fn check_committed(path: &Path, lines: u64, hash: String) -> Result<Committed, String> {
    let manifest = read_manifest(path)?;
    let count = manifest["event_count"].as_u64();
    if count != Some(lines) {
        return Err(format!("CORRUPT: {lines} lines, manifest event_count {count:?}"));
    }
    match manifest["content_hash_fnv1a64"].as_str() {
        Some(expected) if expected == hash => Ok(Committed { content_hash: hash, lines }),
        other => Err(format!("CORRUPT: content hash {hash}, manifest {other:?}")),
    }
}

fn read_manifest(path: &Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path.with_file_name("manifest.json"))
        .map_err(|_| "NOT_COMMITTED: the partition has no manifest yet (materialization pending)".to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("CORRUPT: manifest unreadable: {e}"))
}

/// The content a partition's manifest commits to (its FNV-1a 64 hash), read without the events: whether a cached
/// recording of it is still the partition on disk.
pub fn committed_hash(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err(format!("NOT_AVAILABLE: {}: no recorded events", path.display()));
    }
    read_manifest(path)?["content_hash_fnv1a64"].as_str().map(str::to_string)
        .ok_or_else(|| "CORRUPT: the manifest names no content hash".to_string())
}

/// Where Market Runtime keeps the partitions it wrote from its own WAL for a replay (under its data directory). They
/// outlive a restart (a partition written through the live state's newest event is read again as it is) and go once
/// the historical store holds the materialized partition (prune_provisional).
pub const PROVISIONAL_DIR: &str = "replay-provisional";

/// Removes every partition written from the WAL (under `out_dir`) whose partition the historical store now holds
/// committed, then the directories left empty; the number removed. A partition not materialized yet stays.
pub fn prune_provisional(out_dir: &Path, historical_dir: &Path) -> usize {
    fn children(dir: &Path) -> Vec<PathBuf> {
        match std::fs::read_dir(dir) {
            Ok(entries) => entries.filter_map(|entry| entry.ok()).map(|entry| entry.path()).filter(|path| path.is_dir()).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(), // not an error: nothing written from the WAL yet
            Err(e) => {
                eprintln!("[market_runtime] listing the WAL replay partitions under {} failed: {e}", dir.display());
                Vec::new()
            }
        }
    }
    let mut removed = 0;
    // source= / market= / trading_date= / session= / CODE
    let mut level = vec![out_dir.to_path_buf()];
    for _ in 0..5 {
        level = level.iter().flat_map(|dir| children(dir)).collect();
    }
    for partition in level {
        let Ok(relative) = partition.strip_prefix(out_dir) else { continue };
        if committed_hash(&historical_dir.join(relative).join("events.jsonl")).is_err() {
            continue;
        }
        match std::fs::remove_dir_all(&partition) {
            Ok(()) => removed += 1,
            Err(e) => eprintln!("[market_runtime] removing the WAL replay partition {} failed (tried again next pass): {e}", partition.display()),
        }
        // The directories above it, while empty (remove_dir refuses a directory that still holds something).
        let mut parent = partition.parent();
        while let Some(dir) = parent.filter(|dir| *dir != out_dir) {
            if std::fs::remove_dir(dir).is_err() {
                break; // not an error: the directory still holds another partition
            }
            parent = dir.parent();
        }
    }
    removed
}

/// A partition the materializer has not written yet (台股 seals at 14:40), from Market Runtime's own WAL: its events
/// selected and cleaned as the materializer will select and clean them (wal_session::session_events), written in the
/// historical store's format -- one JSON event per line, a manifest naming their count and content hash -- under
/// `out_dir`. A replay then reads it exactly as it reads a committed partition (Market Runtime and Rust B alike), and
/// the materialized partition replaces it once it exists. The same content already written is not written again.
///
/// `live_through` is the partition's newest durable sequence in Market Runtime's state, given only when the WAL holds
/// it on disk: the partition written then holds every event up to it. When the partition already written was written
/// at that same sequence, nothing has come since and it is read again without scanning the WAL (a day's WAL is
/// several GB); any other value scans it again. The void events (crate::voided) are left out; the manifest names the
/// list it was written under, and one written under another list is written again.
pub fn provisional_from_wal(wal_dir: &Path, partition: &Partition, out_dir: &Path, live_through: Option<u64>, voided: &Voided) -> Result<PathBuf, String> {
    let path = partition.events_path(out_dir);
    let fingerprint = voided.fingerprint();
    let same_list = |manifest: &Option<serde_json::Value>| manifest.as_ref().and_then(|m| m["voided"].as_str()) == Some(fingerprint.as_str());
    if let Some(through) = live_through {
        let written = read_manifest(&path).ok();
        if same_list(&written) && written.as_ref().and_then(|manifest| manifest["live_through"].as_u64()) == Some(through) && committed_hash(&path).is_ok() {
            return Ok(path);
        }
    }
    let symbol = format!("{}:{}:{}", partition.source, partition.market, partition.code);
    let (mut by_symbol, _segments) = crate::wal_session::session_events(wal_dir, std::slice::from_ref(&symbol), &partition.trading_date, &partition.session, voided)
        .map_err(|e| format!("NOT_AVAILABLE: reading the WAL for {symbol} {} {}: {e}", partition.trading_date, partition.session))?;
    let events = by_symbol.remove(&symbol).unwrap_or_default();
    if events.is_empty() {
        return Err(format!("NOT_AVAILABLE: neither the historical store nor the WAL holds {symbol} {} {}", partition.trading_date, partition.session));
    }
    let mut bytes = Vec::new();
    for event in &events {
        serde_json::to_writer(&mut bytes, event).map_err(|e| format!("CORRUPT: an event of the WAL does not encode: {e}"))?;
        bytes.push(b'\n');
    }
    let hash = fnv1a64(&bytes);
    let written = read_manifest(&path).ok();
    if written.as_ref().and_then(|manifest| manifest["content_hash_fnv1a64"].as_str()) == Some(hash.as_str())
        && written.as_ref().and_then(|manifest| manifest["live_through"].as_u64()) == live_through && same_list(&written) {
        return Ok(path);
    }
    let dir = path.parent().ok_or("CORRUPT: the provisional partition has no directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("NOT_AVAILABLE: {}: {e}", dir.display()))?;
    // The old manifest goes first, then the events, then the manifest that commits to them: a reader never takes events
    // under a manifest of other content (the day grew since it was written).
    match std::fs::remove_file(path.with_file_name("manifest.json")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // not an error: nothing was written for this partition yet
        Err(e) => return Err(format!("NOT_AVAILABLE: {}: the earlier manifest stays: {e}", path.display())),
    }
    crate::fsutil::atomic_write(&path, &bytes).map_err(|e| format!("NOT_AVAILABLE: {}: {e}", path.display()))?;
    let manifest = serde_json::json!({"event_count": events.len(), "content_hash_fnv1a64": hash, "provisional": true,
        "source": "wal", "trading_date": partition.trading_date, "session": partition.session, "live_through": live_through,
        "voided": fingerprint});
    crate::fsutil::atomic_write(&path.with_file_name("manifest.json"), manifest.to_string().as_bytes())
        .map_err(|e| format!("NOT_AVAILABLE: {}: {e}", path.display()))?;
    Ok(path)
}

/// A committed partition as read: its events in recorded order, each one's due time, and what its manifest committed.
#[derive(Debug)]
pub struct Loaded {
    pub events: Vec<MarketEvent>,
    pub due: Vec<i64>,
    pub unreadable: u64,
    pub committed: Committed,
}

/// A committed partition's bytes, verified against its manifest.
pub fn read_committed(path: &Path) -> Result<(Vec<u8>, Committed), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("NOT_AVAILABLE: {}: {e}", path.display()))?;
    let committed = verify_committed(path, &bytes)?;
    Ok((bytes, committed))
}

/// Decode a verified partition's lines in file order, handing each recorded event (a clock is not one) to `each` with
/// the byte offset of its line; `each` answering false stops the reading. An unreadable line in a partition whose hash
/// matched is a format the engine cannot read: the whole partition is refused (after the lines before it were handed
/// over).
pub fn decode_events(path: &Path, bytes: &[u8], mut each: impl FnMut(MarketEvent, u64) -> bool) -> Result<usize, String> {
    let mut count = 0usize;
    let mut unreadable = 0u64;
    let mut offset = 0u64;
    for raw in bytes.split(|b| *b == b'\n') {
        let at = offset;
        offset += raw.len() as u64 + 1;
        let line = std::str::from_utf8(raw).map_err(|e| format!("CORRUPT: line at byte {at} is not UTF-8: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        match MarketEvent::decode_slice(line.trim_end_matches('\r').as_bytes()) {
            Ok(event) => {
                if event.code == CLOCK_CODE || matches!(event.payload, Payload::Clock { .. }) {
                    continue;
                }
                count += 1;
                if count > MAX_EVENTS {
                    return Err(format!("TOO_LARGE: more than {MAX_EVENTS} events"));
                }
                if !each(event, at) {
                    return Ok(count);
                }
            }
            // A partition of an older format is refused whole, with the reason; never converted.
            Err(refused @ Refused::OldFormat(_)) => return Err(format!("OLD_FORMAT: {}: {}", path.display(), refused.reason())),
            Err(Refused::Undecodable(_)) => unreadable += 1,
        }
    }
    if unreadable > 0 {
        return Err(format!("CORRUPT: {unreadable} unreadable lines"));
    }
    if count == 0 {
        return Err("NOT_AVAILABLE: the partition holds no events".into());
    }
    Ok(count)
}

/// Read a committed, verified partition: its events in recorded order (by durable sequence), with each one's due time.
pub fn load(path: &Path) -> Result<Loaded, String> {
    let (bytes, committed) = read_committed(path)?;
    let mut read = Vec::new();
    decode_events(path, &bytes, |event, offset| {
        read.push((event, offset));
        true
    })?;
    drop(bytes);
    read.sort_by_key(|(e, _)| e.durable_sequence);
    let events: Vec<MarketEvent> = within_session(read).into_iter().map(|(event, _)| event).collect();
    let due = due_times(&events);
    Ok(Loaded { events, due, unreadable: 0, committed })
}

/// The events of the partition's session: those after its last trading minute (config/trading_sessions.json) are
/// left out -- a TW stock's partition also holds the 14:00-14:30 after-hours fixed-price prints, and a replay of the day
/// ends at 13:30 (the user 11-01). A market the calendar does not name keeps every event.
pub fn within_session(read: Vec<(MarketEvent, u64)>) -> Vec<(MarketEvent, u64)> {
    let Some(first) = read.first().map(|(e, _)| e.clone()) else { return read };
    let calendar = crate::calendar::Calendar::default();
    let key = crate::calendar::CalKey { source: &first.provider, market: &first.market,
        session: crate::event::is_session_partitioned(&first.provider, &first.market).then_some(first.session.as_str()),
        date: Some(&first.trading_date) };
    let segments = calendar.segments(key);
    let Some(end) = segments.iter().filter(|s| s.known_market).map(|s| s.end).max() else { return read };
    read.into_iter().filter(|(e, _)| {
        e.exchange_ts_ns <= 0 || partition_local_minute(&e.provider, &e.market, &e.session, e.exchange_ts_ns).is_none_or(|(_, m)| m <= end)
    }).collect()
}

/// The replay clock at `ts_ns` (the minute B finalizes the previous one on; live, clock_loop writes these): the clock
/// a replay sends B, and the one Rust B's checkpoint builder applies where playback would have.
pub fn clock_event(partition: &Partition, tag: &str, runtime_epoch: u64, ts_ns: i64) -> Option<MarketEvent> {
    let p = partition;
    let (_, minute) = partition_local_minute(&p.source, &p.market, &p.session, ts_ns)?;
    Some(MarketEvent {
        schema_version: EVENT_SCHEMA_VERSION, event_id: format!("replay-clock:{tag}:{minute}"), durable_sequence: 0,
        symbol: format!("{}:{}:{}", p.source, p.market, CLOCK_CODE), provider: p.source.clone(), market: p.market.clone(), code: CLOCK_CODE.into(),
        session: p.session.clone(), trading_date: p.trading_date.clone(), generation: runtime_epoch, sequence: minute.max(0) as u64,
        exchange_ts_ns: ts_ns, arrival_ns: 0, a_received_ns: 0, runtime_epoch, time_quality: "replay_clock".into(),
        trace_id: String::new(), flags: EventFlags::default(), versions: BTreeMap::new(), payload: Payload::Clock { minute },
    })
}

/// A recorded partition loaded for replay: its events and the engine checkpoints built from them in the background
/// (`build_checkpoints`). Shared by the replay playing it and the replay cache; it never changes once loaded.
pub struct Recording {
    pub partition: Partition,
    pub events_path: PathBuf,
    pub content_hash: String,
    pub events: Vec<MarketEvent>,
    pub due: Vec<i64>,
    pub unreadable: u64,
    /// The market's span in the recording (its first and last print, book or quote), for the page's time bar.
    pub span: serde_json::Value,
    pub checkpoint_every: usize,
    /// The recording's steps (its events and the market clock of every minute: timeline::steps), and the step of each
    /// event.
    pub steps: Vec<crate::timeline::Step>,
    pub event_steps: Vec<usize>,
    /// Rust B's analysis at every step, as far as B has sent it (`replay.timeline`).
    pub timeline: RwLock<crate::timeline::Timeline>,
    /// Contiguous from the first interval: checkpoint k holds events `..(k + 1) * checkpoint_every`.
    checkpoints: RwLock<Vec<Arc<Checkpoint>>>,
    /// Events the builder has gone through (all of them once it is done).
    built: AtomicUsize,
    /// Set when the cache lets the recording go: its builder stops.
    abandoned: AtomicBool,
}

impl Recording {
    pub fn new(partition: Partition, events_path: PathBuf, loaded: Loaded) -> Self {
        let Loaded { events, due, unreadable, committed } = loaded;
        // The market's own span (prints, books, quotes): a partition also holds the source's coverage controls, which
        // may be stamped long before the session (the evening before), and the page's time bar is the market's.
        let market = |e: &MarketEvent| matches!(e.payload, Payload::Trade { .. } | Payload::OrderBook { .. } | Payload::Quote { .. });
        let market_first = events.iter().position(market).map(|i| due[i]);
        let market_last = events.iter().rposition(market).map(|i| due[i]);
        let span = serde_json::json!({"market_first_ns": market_first.map(|ns| ns.to_string()), "market_last_ns": market_last.map(|ns| ns.to_string())});
        let steps = crate::timeline::steps(&events, &due);
        let mut event_steps = vec![0; events.len()];
        for (i, step) in steps.iter().enumerate() {
            if let Some(e) = step.event {
                event_steps[e] = i;
            }
        }
        let timeline = RwLock::new(crate::timeline::Timeline::new(steps.len()));
        Self { partition, events_path, content_hash: committed.content_hash, checkpoint_every: checkpoint_interval(committed.lines as usize),
               events, due, unreadable, span, steps, event_steps, timeline,
               checkpoints: RwLock::new(Vec::new()), built: AtomicUsize::new(0), abandoned: AtomicBool::new(false) }
    }

    /// Apply the whole day once, keeping a checkpoint every interval: each is usable the moment it is kept, so the
    /// part of the day already built can be sought while the rest is being built. Run on its own thread.
    pub fn build_checkpoints(&self) {
        let mut engine = Engine::default();
        let mut tally = ApplyTally::default();
        for (index, event) in self.events.iter().enumerate() {
            if self.abandoned.load(Ordering::Relaxed) {
                return;
            }
            let (verdict, _) = engine.apply(event);
            tally.record(index, event, verdict);
            if (index + 1) % self.checkpoint_every == 0 {
                let checkpoint = Arc::new(Checkpoint { index: index + 1, engine: engine.clone(), tally: tally.clone() });
                self.checkpoints.write().unwrap_or_else(|e| e.into_inner()).push(checkpoint);
            }
            self.built.store(index + 1, Ordering::Release);
        }
    }

    /// The checkpoint nearest before `end` (at most `end` events applied), as far as the builder has come.
    pub fn checkpoint_at_or_before(&self, end: usize) -> Option<Arc<Checkpoint>> {
        let checkpoints = self.checkpoints.read().unwrap_or_else(|e| e.into_inner());
        let n = checkpoints.partition_point(|c| c.index <= end);
        n.checked_sub(1).map(|i| checkpoints[i].clone())
    }

    /// Events the checkpoint builder has gone through.
    pub fn built(&self) -> usize {
        self.built.load(Ordering::Acquire)
    }

    pub fn abandon(&self) {
        self.abandoned.store(true, Ordering::Relaxed);
    }

    /// What Rust B builds the recording's timeline from (`wire_for_b`).
    pub fn wire_for_b(&self) -> serde_json::Value {
        wire_for_b(&self.events_path, &self.content_hash)
    }

    /// The recording `wire` names (`replay.timeline`'s): the same partition file and content.
    pub fn is(&self, wire: &serde_json::Value) -> bool {
        wire["events_path"].as_str() == Some(self.events_path.to_string_lossy().as_ref()) && wire["content_hash"].as_str() == Some(self.content_hash.as_str())
    }

    /// The steps whose analysis is held, as replay times: the page's time bar draws them (YouTube-like).
    pub fn buffered(&self) -> serde_json::Value {
        let timeline = self.timeline.read().unwrap_or_else(|e| e.into_inner());
        let at = |p: usize| self.steps.get(p.min(self.steps.len().saturating_sub(1))).map_or(0, |s| s.due_ns).to_string();
        serde_json::json!({"ranges": timeline.held().iter().map(|(a, b)| serde_json::json!([at(*a), at(b.saturating_sub(1))])).collect::<Vec<_>>(),
                           "complete": timeline.complete(), "version": timeline.version})
    }
}

/// The partition Rust B reads to build its timeline of a replay, and the content it must find there (B reads it with
/// the same `load`, so its steps are Market Runtime's).
pub fn wire_for_b(events_path: &Path, content_hash: &str) -> serde_json::Value {
    serde_json::json!({"events_path": events_path.to_string_lossy(), "content_hash": content_hash})
}

struct Cached {
    recording: Arc<Recording>,
    /// When its replay last closed (or opened): a closed recording is let go `CACHE_IDLE` after it.
    released: Instant,
}

/// The recordings kept loaded across replays (see `CACHE_RECORDINGS`).
#[derive(Default)]
pub struct ReplayCache {
    entries: Vec<Cached>,
}

impl ReplayCache {
    /// The cached recording of `partition` when the partition on disk is still the content it was read from.
    pub fn get(&mut self, partition: &Partition, content_hash: &str, now: Instant) -> Option<Arc<Recording>> {
        let i = self.entries.iter().position(|c| &c.recording.partition == partition)?;
        if self.entries[i].recording.content_hash != content_hash {
            // Materialized again since: the old content goes.
            self.entries.remove(i).recording.abandon();
            return None;
        }
        self.entries[i].released = now;
        Some(self.entries[i].recording.clone())
    }

    /// Keep `recording` (it replaces another of the same partition); past `CACHE_RECORDINGS` the one released longest
    /// ago that is not `open` goes. Returns the recording kept: an equal one already cached wins over a second read.
    pub fn insert(&mut self, recording: Arc<Recording>, open: Option<&Partition>, now: Instant) -> Arc<Recording> {
        if let Some(c) = self.entries.iter_mut().find(|c| c.recording.partition == recording.partition) {
            if c.recording.content_hash == recording.content_hash {
                recording.abandon();
                c.released = now;
                return c.recording.clone();
            }
            c.recording.abandon();
            c.recording = recording.clone();
            c.released = now;
            return recording;
        }
        self.entries.push(Cached { recording: recording.clone(), released: now });
        while self.entries.len() > CACHE_RECORDINGS {
            let oldest = self.entries.iter().enumerate().filter(|(_, c)| Some(&c.recording.partition) != open)
                .min_by_key(|(_, c)| c.released).map(|(i, _)| i);
            match oldest {
                Some(i) => self.entries.remove(i).recording.abandon(),
                None => break,
            }
        }
        recording
    }

    /// The cached recording `wire` names (`Recording::is`).
    pub fn find(&self, wire: &serde_json::Value) -> Option<Arc<Recording>> {
        self.entries.iter().find(|c| c.recording.is(wire)).map(|c| c.recording.clone())
    }

    /// Its replay closed: the idle time starts now.
    pub fn released(&mut self, partition: &Partition, now: Instant) {
        if let Some(c) = self.entries.iter_mut().find(|c| &c.recording.partition == partition) {
            c.released = now;
        }
    }

    /// Let go of every recording idle past `CACHE_IDLE` (never the `open` one). Returns how many went.
    pub fn evict_idle(&mut self, open: Option<&Partition>, now: Instant) -> usize {
        let before = self.entries.len();
        self.entries.retain(|c| {
            let keep = Some(&c.recording.partition) == open || now.saturating_duration_since(c.released) < CACHE_IDLE;
            if !keep {
                c.recording.abandon();
            }
            keep
        });
        before - self.entries.len()
    }

    /// What is cached, for the status: each recording's identity, events, how far its checkpoints are built and what its
    /// timeline holds.
    pub fn status(&self) -> serde_json::Value {
        serde_json::Value::Array(self.entries.iter().map(|c| serde_json::json!({"code": c.recording.partition.code,
            "trading_date": c.recording.partition.trading_date, "session": c.recording.partition.session, "events": c.recording.events.len(),
            "built": c.recording.built(), "timeline": c.recording.timeline.read().unwrap_or_else(|e| e.into_inner()).stats()})).collect())
    }
}

/// Each event is due at the later of its exchange time and the previous event's due time (an event without an
/// exchange time is due with its predecessor).
pub fn due_times(events: &[MarketEvent]) -> Vec<i64> {
    let mut due = Vec::with_capacity(events.len());
    let mut last = events.iter().map(|e| e.exchange_ts_ns).find(|t| *t > 0).unwrap_or(0);
    for event in events {
        if event.exchange_ts_ns > last {
            last = event.exchange_ts_ns;
        }
        due.push(last);
    }
    due
}

/// What the replay's engine made of the events applied since its last rebuild. Attempted, applied, control and
/// rejected are counted apart, and the first rejection is named: a replay whose engine refused a recorded event
/// is not what the live page showed, and its status says so (`complete: false`) instead of hiding it in a total.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyTally {
    pub attempted: u64,
    pub applied: u64,
    pub control: u64,
    pub rejected: u64,
    /// (event index, durable sequence, the engine's verdict) of the first refused event.
    pub first_rejected: Option<(usize, u64, String)>,
}

impl ApplyTally {
    fn record(&mut self, index: usize, event: &MarketEvent, verdict: ApplyResult) {
        self.attempted += 1;
        match verdict {
            ApplyResult::Applied => self.applied += 1,
            ApplyResult::Control => self.control += 1,
            refused => {
                self.rejected += 1;
                if self.first_rejected.is_none() {
                    eprintln!("[market_runtime] replay engine refused recorded event {index} (durable sequence {}): {refused:?}",
                              event.durable_sequence);
                    self.first_rejected = Some((index, event.durable_sequence, format!("{refused:?}")));
                }
            }
        }
    }

    pub fn wire(&self) -> serde_json::Value {
        serde_json::json!({"attempted": self.attempted, "applied": self.applied, "control": self.control, "rejected": self.rejected,
            "first_rejected": self.first_rejected.as_ref().map(|(index, sequence, verdict)|
                serde_json::json!({"index": index, "durable_sequence": sequence, "verdict": verdict}))})
    }
}

/// The replay's own market state (the live `Core`'s counterpart, never shared with it).
#[derive(Default)]
pub struct ReplayCore {
    pub engine: Engine,
    pub projection: ProjectionCache,
    pub view_seq: HashMap<StateKey, u64>,
}

pub struct ReplaySession {
    pub id: String,
    pub partition: Partition,
    pub owner: u64,
    /// The recorded partition and its checkpoints (shared with the replay cache and the checkpoint builder).
    pub rec: Arc<Recording>,
    /// Next event to apply.
    pub cursor: usize,
    pub playing: bool,
    pub speed: u32,
    /// Replay time at `anchor` (ns since the epoch, the recorded exchange clock).
    pub position_ns: i64,
    pub anchor: Instant,
    pub core: ReplayCore,
    /// Bumped by every seek: the engine was rebuilt, so every view needs a fresh snapshot.
    pub generation: u64,
    pub last_status_at: Instant,
    /// Rust B's analysis at the step the replay stands on (`position`), from the recording's timeline; None while
    /// the timeline does not hold it yet (the page shows 計算中, never another step's analysis).
    pub analysis: Option<crate::timeline::State>,
    /// The timeline step the replay stands on: its events applied and its clock reached (`position_now`).
    pub position: usize,
    /// The engine's verdicts since the last rebuild (a seek starts it over with the engine).
    pub tally: ApplyTally,
}

impl ReplaySession {
    /// Paused just before the market's first event (a coverage control stamped earlier, the evening before, is due
    /// before it and plays at once), nothing applied yet.
    pub fn new(id: String, rec: Arc<Recording>, owner: u64) -> Self {
        let start = rec.span["market_first_ns"].as_str().and_then(|ns| ns.parse::<i64>().ok()).map(|ns| ns - 1)
            .or_else(|| rec.due.first().copied()).unwrap_or(0);
        Self { id, partition: rec.partition.clone(), owner, rec, cursor: 0, playing: false, speed: 1, position_ns: start,
               anchor: Instant::now(), core: ReplayCore::default(), generation: 0, last_status_at: Instant::now(), analysis: None, position: 0,
               tally: ApplyTally::default() }
    }

    /// The timeline step the replay stands on now: every event applied (never one past the cursor) and the market
    /// clock of every minute its clock has reached.
    pub fn position_now(&self) -> usize {
        let limit = self.rec.event_steps.get(self.cursor).copied().unwrap_or(self.rec.steps.len());
        crate::timeline::position_at(&self.rec.steps, self.clock_ns()).min(limit)
    }

    pub fn first_ns(&self) -> i64 {
        self.rec.due.first().copied().unwrap_or(0)
    }

    pub fn last_ns(&self) -> i64 {
        self.rec.due.last().copied().unwrap_or(0)
    }

    /// Replay time now.
    pub fn now_ns(&self) -> i64 {
        if self.playing {
            self.position_ns.saturating_add((self.anchor.elapsed().as_nanos() as i64).saturating_mul(self.speed as i64))
        } else {
            self.position_ns
        }
    }

    /// Freeze the clock where it is (pause, speed change, seek).
    fn rebase(&mut self) {
        self.position_ns = self.now_ns();
        self.anchor = Instant::now();
    }

    pub fn play(&mut self) {
        if self.cursor >= self.rec.events.len() {
            return;
        }
        self.rebase();
        self.playing = true;
    }

    pub fn pause(&mut self) {
        self.rebase();
        self.playing = false;
    }

    pub fn set_speed(&mut self, speed: u32) -> Result<(), String> {
        if !SPEEDS.contains(&speed) {
            return Err(format!("speed must be one of {SPEEDS:?}"));
        }
        self.rebase();
        self.speed = speed;
        Ok(())
    }

    /// Apply recorded event `index` to the replay's engine, its verdict counted.
    pub fn apply_at(&mut self, index: usize) -> (ApplyResult, Changed) {
        let (verdict, changed) = self.core.engine.apply(&self.rec.events[index]);
        self.tally.record(index, &self.rec.events[index], verdict);
        (verdict, changed)
    }

    /// Rebuild the state up to `at_ns` without pacing (nothing is emitted for the skipped events), from where the
    /// engine stands when that is on the way, else from the nearest checkpoint before the target. What the engine
    /// refused is in `tally`. Rust B's analysis at the new step is the caller's to take from the timeline
    /// (server::replay_feed). Returns how many events it applied.
    pub fn seek(&mut self, at_ns: i64) -> usize {
        let at = at_ns.clamp(self.first_ns(), self.last_ns());
        let end = self.rec.due.partition_point(|d| *d <= at);
        let checkpoint = self.rec.checkpoint_at_or_before(end);
        let from = if self.cursor <= end && checkpoint.as_ref().is_none_or(|c| c.index <= self.cursor) {
            self.cursor
        } else if let Some(c) = checkpoint {
            self.core.engine = c.engine.clone();
            self.tally = c.tally.clone();
            c.index
        } else {
            self.core.engine = Engine::default();
            self.tally = ApplyTally::default();
            0
        };
        for index in from..end {
            self.apply_at(index);
        }
        self.cursor = end;
        self.position_ns = at;
        self.anchor = Instant::now();
        self.generation += 1;
        if self.cursor >= self.rec.events.len() {
            self.playing = false;
        }
        end - from
    }

    /// Indices of the events due by now (at most STEP_EVENTS), advancing the cursor past them.
    pub fn due_now(&mut self) -> std::ops::Range<usize> {
        if !self.playing {
            return self.cursor..self.cursor;
        }
        let now = self.now_ns();
        let start = self.cursor;
        let mut end = start;
        while end < self.rec.events.len() && end - start < STEP_EVENTS && self.rec.due[end] <= now {
            end += 1;
        }
        self.cursor = end;
        if self.cursor >= self.rec.events.len() {
            // The recorded day is over: stop the clock at its last event.
            self.position_ns = self.last_ns();
            self.anchor = Instant::now();
            self.playing = false;
        }
        start..end
    }

    /// How long until the next event is due, in wall time (None when paused or finished).
    pub fn wait_ns(&self) -> Option<i64> {
        if !self.playing || self.cursor >= self.rec.events.len() {
            return None;
        }
        Some(((self.rec.due[self.cursor] - self.now_ns()).max(0)) / self.speed.max(1) as i64)
    }

    /// Where the replay's market clock stands: never past an event that is due but not yet applied -- a backlog
    /// longer than one step must not finalize a minute before its prints -- and one minute past the last event once the
    /// recorded day is over, so its last minute is finalized too.
    pub fn clock_ns(&self) -> i64 {
        if self.cursor >= self.rec.events.len() {
            return self.last_ns() + 60_000_000_000;
        }
        let now = self.now_ns();
        let next_due = self.rec.due[self.cursor];
        if next_due <= now { next_due - 1 } else { now }
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "replay_id": self.id, "source": self.partition.source, "market": self.partition.market, "code": self.partition.code,
            "trading_date": self.partition.trading_date, "session": self.partition.session,
            "playing": self.playing, "speed": self.speed, "speeds": SPEEDS,
            "position_ns": self.now_ns().to_string(), "first_ns": self.first_ns().to_string(), "last_ns": self.last_ns().to_string(),
            "cursor": self.cursor, "total": self.rec.events.len(), "unreadable": self.rec.unreadable,
            "finished": self.cursor >= self.rec.events.len(), "generation": self.generation,
            "applied": self.tally.wire(), "complete": self.tally.rejected == 0 && self.rec.unreadable == 0,
            "recording": self.rec.span,
            // How far the background checkpoint builder has come (events): a seek past it applies more than one interval.
            "checkpoints": {"every": self.rec.checkpoint_every, "built": self.rec.built()},
            // Rust B's analysis: whether the step shown has it (else 計算中), and the steps held (the time bar's buffer).
            "analysis": {"at_position": self.analysis.is_some(), "position": self.position, "buffered": self.rec.buffered()},
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::BookLevel;
    use crate::state::tests_support::trade_event;

    fn trade(code: &str, seq: u64, price: i64, _simtrade: bool) -> MarketEvent {
        trade_event(code, seq, price)
    }

    /// A TW stock's day ends at 13:30: the after-hours fixed-price prints after it are not part of its replay.
    #[test]
    fn a_replay_holds_the_session_s_events_only() {
        // 2026-09-29 Taipei: 13:29:50, 13:30:10 (the closing print's minute) and 14:05 (after hours).
        let taipei = |h: i64, m: i64, s: i64| (crate::event::days_from_civil(2026, 9, 29) * 86_400 + h * 3600 + m * 60 + s - 8 * 3600) * 1_000_000_000;
        let read = vec![(at(trade("2330", 1, 100, false), 1, taipei(13, 29, 50)), 0), (at(trade("2330", 2, 100, false), 2, taipei(13, 30, 10)), 10),
                        (at(trade("2330", 3, 100, false), 3, taipei(14, 5, 0)), 20)];
        let kept: Vec<u64> = within_session(read).into_iter().map(|(_, offset)| offset).collect();
        assert_eq!(kept, vec![0, 10], "13:30 kept, 14:05 left out");
        let mut us = at(trade("AAPL", 1, 100, false), 1, taipei(14, 5, 0));
        us.provider = "nowhere".into();
        assert_eq!(within_session(vec![(us, 0)]).len(), 1, "a market the calendar does not name keeps its events");
    }

    fn at(mut e: MarketEvent, seq: u64, ts: i64) -> MarketEvent {
        e.durable_sequence = seq;
        e.exchange_ts_ns = ts;
        e
    }

    /// No manifest = not committed; bytes or count that differ from the manifest = CORRUPT; a line the
    /// engine cannot read in a hash-verified partition refuses the partition instead of being skipped.
    #[test]
    fn only_a_committed_partition_matching_its_manifest_is_replayed() {
        let dir = std::env::temp_dir().join(format!("stk-replay-q23-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let events = dir.join("events.jsonl");
        let line = serde_json::to_string(&at(trade("2330", 1, 100, false), 1, 1_000)).unwrap();
        let text = format!("{line}\n");
        std::fs::write(&events, &text).unwrap();
        let manifest = |count: usize, body: &str| {
            std::fs::write(dir.join("manifest.json"),
                serde_json::json!({"event_count": count, "content_hash_fnv1a64": fnv1a64(body.as_bytes())}).to_string()).unwrap();
        };
        assert!(load(&events).unwrap_err().starts_with("NOT_COMMITTED"));
        manifest(1, &text);
        assert_eq!(load(&events).unwrap().events.len(), 1);
        manifest(2, &text);
        assert!(load(&events).unwrap_err().starts_with("CORRUPT"), "count differs");
        std::fs::write(&events, format!("{line}\n{line}\n")).unwrap();
        manifest(2, &text);
        assert!(load(&events).unwrap_err().contains("content hash"), "bytes differ");
        let garbled = format!("{line}\nnot json\n");
        std::fs::write(&events, &garbled).unwrap();
        manifest(2, &garbled);
        assert_eq!(load(&events).unwrap_err(), "CORRUPT: 1 unreadable lines");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fnv1a64_known_vectors_and_streaming_agree() {
        assert_eq!(fnv1a64(b""), "cbf29ce484222325");
        assert_eq!(fnv1a64(b"a"), "af63dc4c8601ec8c");
        assert_eq!(fnv1a64(b"foobar"), "85944171f73967e8");
        let mut streamed = Fnv1a64::default();
        streamed.update(b"foo");
        streamed.update(b"bar");
        assert_eq!(streamed.hex(), fnv1a64(b"foobar"));
    }

    #[test]
    fn identity_components_cannot_escape_the_historical_dir() {
        assert!(Partition::new("shioaji", "STK", "2330", "2026-02-31", "DAY").is_err(), "not a calendar date");
        assert!(Partition::new("shioaji", "STK", "../x", "2026-09-29", "DAY").is_err());
        assert!(Partition::new("shioaji", "STK", "2330", "2026-09-29/..", "DAY").is_err());
        assert!(Partition::new("shio/aji", "STK", "2330", "2026-09-29", "DAY").is_err());
        let p = Partition::new("Shioaji", "stk", "2330", "2026-09-29", "day").unwrap();
        let path = p.events_path(Path::new("H"));
        assert!(path.ends_with("source=shioaji/market=STK/trading_date=2026-09-29/session=DAY/2330/events.jsonl"));
    }

    #[test]
    fn a_print_is_due_at_its_own_exchange_time_and_never_before_its_predecessor() {
        // Arrival order is kept (the engine's fences need it); a late arrival with an older time is due with the
        // event before it, not earlier.
        let events = vec![at(trade("2330", 1, 100, false), 1, 1_000), at(trade("2330", 2, 101, false), 2, 1_250),
                          at(trade("2330", 3, 102, false), 3, 1_100), at(trade("2330", 4, 103, false), 4, 0)];
        assert_eq!(due_times(&events), vec![1_000, 1_250, 1_250, 1_250]);
    }

    #[test]
    fn playback_releases_each_event_when_due_and_stops_at_the_end() {
        let events = vec![at(trade("2330", 1, 100, false), 1, 1_000_000_000), at(trade("2330", 2, 101, false), 2, 1_000_400_000),
                          at(trade("2330", 3, 102, false), 3, 1_030_000_000)];
        let due = due_times(&events);
        let partition = Partition::new("shioaji", "STK", "2330", "2026-09-29", "DAY").unwrap();
        let mut s = session(partition, events, due);
        assert_eq!(s.due_now(), 0..0, "paused: nothing is released");
        assert_eq!(s.position_ns, 1_000_000_000 - 1, "opened just before the market's first event");
        s.play();
        assert!(s.wait_ns().unwrap() <= 1, "the first event is due a nanosecond after the start");
        let first = loop {
            let released = s.due_now();
            if !released.is_empty() {
                break released;
            }
        };
        assert_eq!(first, 0..1, "the first event alone");
        let wait = s.wait_ns().unwrap();
        assert!(wait > 300_000 && wait <= 400_000, "the second print waits its 0.4 ms, not a second: {wait}");
        s.set_speed(10).unwrap();
        assert!(s.set_speed(3).is_err(), "only the offered speeds");
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(s.due_now(), 1..3, "at 10x, 5 ms of wall time covers the next 30 ms of market time");
        assert!(!s.playing, "the day is over");
    }

    #[test]
    fn the_clock_never_passes_an_event_that_is_due_but_not_yet_sent() {
        let events: Vec<MarketEvent> = (1..=3).map(|i| at(trade("2330", i, 100, false), i, i as i64 * 60_000_000_000)).collect();
        let due = due_times(&events);
        let partition = Partition::new("shioaji", "STK", "2330", "2026-09-29", "DAY").unwrap();
        let mut s = session(partition, events, due);
        s.seek(60_000_000_000);
        s.position_ns = 300_000_000_000; // far ahead: events 2 and 3 are overdue, none sent yet
        assert_eq!(s.clock_ns(), 120_000_000_000 - 1, "held just before the next unsent event");
        s.cursor = 3;
        assert_eq!(s.clock_ns(), 180_000_000_000 + 60_000_000_000, "the day is over: one minute past the last event");
    }

    #[test]
    fn seek_rebuilds_the_state_at_the_target_without_touching_anything_else() {
        let mut book = trade("2330", 3, 0, false);
        book.payload = Payload::OrderBook { bids: vec![BookLevel { price: 99, volume: 1.0 }], asks: vec![], simtrade: false };
        let events = vec![at(trade("2330", 1, 100, false), 1, 1_000), at(trade("2330", 2, 105, false), 2, 2_000), at(book, 3, 3_000)];
        let due = due_times(&events);
        let partition = Partition::new("shioaji", "STK", "2330", "2026-09-29", "DAY").unwrap();
        let mut s = session(partition, events, due);
        assert_eq!(s.seek(2_500), 2);
        let key = s.rec.events[0].state_key();
        assert_eq!(s.core.engine.state(&key).unwrap().quote.current, Some(105));
        assert_eq!(s.cursor, 2);
        assert_eq!(s.generation, 1);
        s.seek(1_000);
        assert_eq!(s.core.engine.state(&key).unwrap().quote.current, Some(100), "seeking back rebuilds from the start");
        assert_eq!((s.tally.attempted, s.tally.applied, s.tally.rejected), (1, 1, 0), "the tally starts over with the engine");
    }

    fn session(partition: Partition, events: Vec<MarketEvent>, due: Vec<i64>) -> ReplaySession {
        let lines = events.len() as u64;
        let loaded = Loaded { events, due, unreadable: 0, committed: Committed { content_hash: String::new(), lines } };
        ReplaySession::new("r1".into(), Arc::new(Recording::new(partition, PathBuf::new(), loaded)), 7)
    }

    fn day(n: u64) -> ReplaySession {
        let events: Vec<MarketEvent> = (1..=n).map(|i| at(trade("2330", i, 100 + (i % 7) as i64, false), i, i as i64 * 1_000_000)).collect();
        let due = due_times(&events);
        session(Partition::new("shioaji", "STK", "2330", "2026-09-29", "DAY").unwrap(), events, due)
    }

    /// The day's checkpoints are built without playing it: a seek anywhere -- forward past everything played too --
    /// applies at most one interval, and lands on exactly the state a rebuild from the first event does.
    #[test]
    fn once_the_day_is_built_a_seek_anywhere_applies_at_most_one_interval_and_matches_a_rebuild_from_the_start() {
        let mut s = day(10_000);
        s.rec.build_checkpoints();
        let every = s.rec.checkpoint_every;
        assert_eq!(every, CHECKPOINT_MIN_EVENTS);
        assert_eq!(s.rec.built(), 10_000);
        let key = s.rec.events[0].state_key();
        for (target, most) in [(9_620, every), (9_499, every), (4_321, every), (4_400, 79), (8_000, every), (1, 1), (9_999, every)] {
            let applied = s.seek(target as i64 * 1_000_000);
            assert!(applied <= most, "seek to {target} applied {applied} events (at most {most})");
            let mut fresh = day(10_000);
            assert_eq!(fresh.seek(target as i64 * 1_000_000), target, "no checkpoint: from the first event");
            assert_eq!(s.cursor, fresh.cursor);
            assert_eq!(s.core.engine.state(&key).unwrap().quote, fresh.core.engine.state(&key).unwrap().quote, "seek to {target}");
            assert_eq!(s.tally, fresh.tally, "seek to {target}: the tally of the same events");
        }
        let checkpoints = s.rec.checkpoints.read().unwrap();
        assert_eq!(checkpoints.len(), 10_000 / every);
        assert!(checkpoints.windows(2).all(|w| w[1].index == w[0].index + every), "contiguous, one per interval");
        assert_eq!(checkpoint_interval(2_000_000), 5_000, "a large day keeps at most CHECKPOINTS_MAX");
    }

    /// A seek used to start the replay's projection over: until B published the new time, every view the seek re-sent
    /// had no 價量, 大單 or 技術分析 and the page showed 「回放尚未播到成交」 (on every frame of a drag).
    #[test]
    fn a_seek_keeps_b_s_analysis_until_b_publishes_the_new_time_s() {
        let mut s = day(3_000);
        s.seek(2_000_000_000);
        let key = s.rec.events[0].state_key();
        let item = serde_json::json!({"block": "day", "input_watermark": 1, "revision": 1, "data": {"price_volume": {"buckets": [{"price": 100}]}}});
        let request = crate::projection::PublishRequest::from_item(key.clone(), 1, &item).unwrap();
        assert!(matches!(s.core.projection.publish(request, u64::MAX, 1), crate::projection::Verdict::Accepted(_)));
        s.seek(500_000_000);
        assert_eq!(s.core.projection.entry(&key).map(|e| e.day["price_volume"]["buckets"][0]["price"].clone()), Some(serde_json::json!(100)),
                   "the last 價量 B published is still served after the seek");
        let item = serde_json::json!({"block": "day", "input_watermark": 1, "revision": 1, "data": {"price_volume": {"buckets": [{"price": 101}]}}});
        let request = crate::projection::PublishRequest::from_item(key.clone(), 2, &item).unwrap();
        assert!(matches!(s.core.projection.publish(request, u64::MAX, 2), crate::projection::Verdict::Accepted(_)),
                "B's analysis of the new time (its next feed's epoch) replaces it");
        assert_eq!(s.core.projection.entry(&key).map(|e| e.day["price_volume"]["buckets"][0]["price"].clone()), Some(serde_json::json!(101)));
    }

    fn cached(code: &str, hash: &str) -> Arc<Recording> {
        let events = vec![at(trade(code, 1, 100, false), 1, 1_000)];
        let due = due_times(&events);
        let partition = Partition::new("shioaji", "STK", code, "2026-09-29", "DAY").unwrap();
        Arc::new(Recording::new(partition, PathBuf::new(), Loaded { events, due, unreadable: 0, committed: Committed { content_hash: hash.into(), lines: 1 } }))
    }

    /// Reopening a day finds it loaded with its checkpoints; one materialized again since is read anew; past the cap the
    /// one closed longest ago goes (never the open one), and a closed one goes after CACHE_IDLE.
    #[test]
    fn the_replay_cache_keeps_recordings_across_replays_by_content_count_and_idle_time() {
        let t0 = Instant::now();
        let mut cache = ReplayCache::default();
        let a = cache.insert(cached("2330", "h1"), None, t0);
        assert!(Arc::ptr_eq(&cache.get(&a.partition, "h1", t0).unwrap(), &a), "reopened: the same recording, not read again");
        assert!(cache.get(&a.partition, "h2", t0).is_none(), "materialized again: the old content is let go");
        assert!(a.abandoned.load(Ordering::Relaxed), "its builder stops");
        let a = cache.insert(cached("2330", "h2"), None, t0);
        let again = cache.insert(cached("2330", "h2"), None, t0);
        assert!(Arc::ptr_eq(&again, &a), "a second read of the same content keeps the cached one (and its checkpoints)");
        for (i, code) in ["2303", "2317", "2454"].iter().enumerate() {
            cache.insert(cached(code, "h"), Some(&a.partition), t0 + Duration::from_secs(i as u64 + 1));
        }
        let codes: Vec<String> = cache.entries.iter().map(|c| c.recording.partition.code.clone()).collect();
        assert_eq!(codes, ["2330", "2317", "2454"], "the open recording stays; the one released longest ago goes");
        cache.released(&a.partition, t0 + Duration::from_secs(10));
        assert_eq!(cache.evict_idle(None, t0 + CACHE_IDLE + Duration::from_secs(5)), 2, "idle past CACHE_IDLE");
        assert_eq!(cache.evict_idle(Some(&a.partition), t0 + CACHE_IDLE + Duration::from_secs(60)), 0, "the open one never goes");
        assert_eq!(cache.evict_idle(None, t0 + CACHE_IDLE + Duration::from_secs(60)), 1);
    }

    #[test]
    fn a_recorded_event_the_engine_refuses_is_counted_and_named_and_the_replay_is_not_complete() {
        // seek dropped the engine's verdict and the step loop counted every attempt as applied: a refused event
        // vanished while the status said nothing.
        let events = vec![at(trade("2330", 1, 100, false), 1, 1_000), at(trade("2330", 1, 105, false), 2, 2_000),
                          at(trade("2330", 2, 106, false), 3, 3_000)];
        let due = due_times(&events);
        let partition = Partition::new("shioaji", "STK", "2330", "2026-09-29", "DAY").unwrap();
        let mut s = session(partition, events, due);
        s.seek(3_000);
        assert_eq!((s.tally.attempted, s.tally.applied, s.tally.rejected), (3, 2, 1));
        let (index, sequence, verdict) = s.tally.first_rejected.clone().unwrap();
        assert_eq!((index, sequence), (1, 2));
        assert_eq!(verdict, "RejectedSequence");
        let status = s.status();
        assert_eq!(status["complete"], false);
        assert_eq!(status["applied"]["rejected"], 1);
        assert_eq!(status["applied"]["first_rejected"]["durable_sequence"], 2);
    }

    /// A partition written from the WAL goes once the historical store holds that partition committed, and the
    /// directories it leaves empty with it; one the materializer has not committed (no partition, or no manifest yet)
    /// stays, and so do the directories above it.
    #[test]
    fn a_wal_partition_goes_once_the_historical_store_commits_its_partition() {
        let root = std::env::temp_dir().join(format!("stk-replay-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (out, historical) = (root.join(PROVISIONAL_DIR), root.join("historical"));
        let partition = |date: &str, code: &str| Partition { source: "shioaji".into(), market: "STK".into(), code: code.into(),
                                                             trading_date: date.into(), session: "DAY".into() };
        let write = |dir: &Path, partition: &Partition, manifest: bool| {
            let path = partition.events_path(dir);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"{}\n").unwrap();
            if manifest {
                let body = serde_json::json!({"event_count": 1, "content_hash_fnv1a64": fnv1a64(b"{}\n")});
                std::fs::write(path.with_file_name("manifest.json"), body.to_string()).unwrap();
            }
        };
        let (sealed, sealed_other, open, pending) =
            (partition("2026-09-28", "2330"), partition("2026-09-29", "2330"), partition("2026-09-29", "2317"), partition("2026-09-30", "2330"));
        for p in [&sealed, &sealed_other, &open, &pending] {
            write(&out, p, true);
        }
        write(&historical, &sealed, true);
        write(&historical, &sealed_other, true);
        write(&historical, &pending, false); // the materializer is still writing it

        assert_eq!(prune_provisional(&out, &historical), 2);
        let day = |date: &str| out.join("source=shioaji").join("market=STK").join(format!("trading_date={date}"));
        assert!(!day("2026-09-28").exists(), "the day's only partition went, and its directories with it");
        assert!(!sealed_other.events_path(&out).parent().unwrap().exists());
        assert!(open.events_path(&out).is_file(), "not materialized: stays");
        assert!(pending.events_path(&out).is_file(), "no manifest in the historical store yet: stays");
        assert!(historical.join("source=shioaji").exists(), "the historical store is not touched");
        assert_eq!(prune_provisional(&out, &historical), 0, "nothing more to remove");

        write(&historical, &open, true);
        write(&historical, &pending, true);
        assert_eq!(prune_provisional(&out, &historical), 2);
        assert!(out.is_dir() && std::fs::read_dir(&out).unwrap().next().is_none(), "every directory under it went; it stays");
        assert_eq!(prune_provisional(&root.join("missing"), &historical), 0, "nothing written from the WAL yet");
        let _ = std::fs::remove_dir_all(&root);
    }
}
