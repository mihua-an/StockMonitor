//! The training feature dataset: the ONE place model features are computed is this process.
//!
//! `analysis_runtime --export-features --historical-root <root> --date <d> [--date ...] --out <dir>` streams every
//! committed partition of each date in durable order through the very `FeatureStore::fold` the live stream uses, and
//! writes the samples a model is trained on. Python only adds labels and trains; it never recomputes a feature, so
//! there is no second implementation to keep in step. The dataset manifest carries the FeatureSpec digest of this
//! build; the model inherits it, and the live worker refuses a model bound to any other (FEATURE_SPEC mismatch).
//!
//! Committed means manifest-first: a partition without `manifest.json` is not read, and one whose bytes or
//! line count differ from its manifest is refused and listed, never silently used. Partitions are already in durable
//! order on disk, so they are merged lazily (one open reader per file) instead of loaded whole -- one STK day is
//! gigabytes. Because the fold reads the file a second time, it hashes what it folds and compares it at the end with
//! what was verified; a read error, an undecodable line, a directory that cannot be listed or bytes that changed
//! between the two reads are problems of the date (the dataset is `degraded`), never an early end of the data.
//!
//! Every durable event is folded exactly as the live stream folds it -- including prints the history replay filters
//! as broker re-sends: live B folds them, so a feature computed without them would not be the live feature.
//!
//! Sampling (sampling-online-v2): the LAST warm sample of each key in each 15 exchange seconds (cutoff_ns // 15 s), so
//! training sees the minute in progress at four points, as inference does at every event (user 10-29). The last of
//! a key's minute is its 45-60 s sample: the trainer takes that one per minute to train as sampling-online-v1 did.
//! Choosing a sample uses nothing after its 15 seconds, and every sample's features are causal by construction.
//!
//! The day columns read the previous sessions' daily summaries and the industry map (day_context.rs, the same loader
//! the live fold uses); the manifest records, per date, what that context was made of.
//!
//! Labels need the price path AFTER each sample. That path comes from the same pass (future-path-v2), per sample and
//! horizon, for t = the sample's cutoff and p0 = its last_price:
//! * the path is the key's own continuous-trading prints (trade.price with no simtrade, call auction or 盤後定價;
//!   quote.current > 0) with exchange time in (t, t+h] -- a sample before the close is never labelled by the 14:30
//!   after-hours price or the closing auction;
//! * `max` / `min` = max(path) / p0 - 1 and min(path) / p0 - 1, state OK;
//! * otherwise a state and no numbers: NO_PRICE (no usable p0), TAIL_INSUFFICIENT (the scope's data, any event, does
//!   not reach t+h), NO_FUTURE_PRICE (nothing printed in the window).
//! The barriers that turn these into labels are the trainer's policy (Python), applied to these numbers only.
//!
//! Progress: one date is minutes of work, so the export reports where it is on stderr, one JSON line
//! `{"progress": {"date", "phase", "done", "total", "elapsed_ms"}}` at the start and end of every phase and at most
//! every half second in between. The phases of a date, in order: `verify` (partition files checked against their
//! manifests), `replay` (events folded; total = the lines verified), `labels` (samples given their future path) and
//! `write` (samples written). `elapsed_ms` is the time spent in that phase so far.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use market_runtime::event::{MarketEvent, Payload, Refused, CLOCK_CODE};
use serde_json::{json, Value};

use market_runtime::historical_store::PartitionKey;
use market_runtime::replay::{check_committed, Committed, Fnv1a64};
use crate::contract::SpecIdentity;
use crate::day_context::ContextSource;
use crate::features::{FeatureSnapshot, FeatureStore, Folded, KeyId, CATEGORY_COLUMNS, FOLD_VERSION, NUMERIC_COLUMNS};

pub const DATASET_SCHEMA: &str = "feature-dataset-v1";
pub const SAMPLING_POLICY: &str = "sampling-online-v2";
pub const FUTURE_PATH_POLICY: &str = "future-path-v2";
const MINUTE_NS: i64 = 60_000_000_000;
/// One sample per key in each SAMPLE_NS of exchange time.
const SAMPLE_NS: i64 = 15_000_000_000;
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

/// The progress lines of an export (see the module documentation), written to `sink`. The materialization job
/// (materialize.rs) reports its phases with the same lines, `date` being the session's trading date.
pub struct Progress<'a> {
    sink: &'a mut dyn Write,
    interval: Duration,
    phase_started: Instant,
    last_line: Instant,
    failures: u64,
}

impl<'a> Progress<'a> {
    pub fn new(sink: &'a mut dyn Write, interval: Duration) -> Self {
        let now = Instant::now();
        Progress { sink, interval, phase_started: now, last_line: now, failures: 0 }
    }

    /// Progress lines that could not be written. The export does not depend on them, so a failed line does not stop
    /// it; the count goes into the export's result line.
    pub fn failures(&self) -> u64 {
        self.failures
    }

    fn line(&mut self, date: &str, phase: &str, done: u64, total: u64) {
        let now = Instant::now();
        self.last_line = now;
        let elapsed_ms = now.duration_since(self.phase_started).as_millis() as u64;
        let line = json!({"progress": {"date": date, "phase": phase, "done": done, "total": total, "elapsed_ms": elapsed_ms}});
        if writeln!(self.sink, "{line}").and_then(|_| self.sink.flush()).is_err() {
            self.failures += 1;
        }
    }

    pub fn start(&mut self, date: &str, phase: &str, total: u64) {
        self.phase_started = Instant::now();
        self.line(date, phase, 0, total);
    }

    pub fn tick(&mut self, date: &str, phase: &str, done: u64, total: u64) {
        if self.last_line.elapsed() >= self.interval {
            self.line(date, phase, done, total);
        }
    }

    /// The phase is over: its last line has done = total.
    pub fn end(&mut self, date: &str, phase: &str, total: u64) {
        self.line(date, phase, total, total);
    }
}

#[derive(Debug)]
pub struct ExportArgs {
    pub historical_root: PathBuf,
    pub dates: Vec<String>,
    pub out: PathBuf,
    pub source: String,
    /// Markets whose events are folded (the reference index must be among them for index_ret_5m).
    pub markets: Vec<String>,
    /// Markets whose keys become samples.
    pub sample_markets: Vec<String>,
    /// Horizons whose future path each sample carries.
    pub horizons_minutes: Vec<u32>,
    /// The day context (daily summaries, industry indexes) of every date.
    pub context: ContextSource,
}

/// The partition's bytes and line count match what its manifest committed (the same check replay makes). Checked
/// before anything is folded, so a refused partition contributes nothing.
fn verify(events: &Path) -> Result<Committed, String> {
    let file = File::open(events).map_err(|e| format!("open: {e}"))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let (mut hash, mut lines, mut buf) = (Fnv1a64::default(), 0u64, Vec::new());
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("read: {e}")),
        }
        hash.update(&buf);
        if buf.iter().any(|b| !b.is_ascii_whitespace()) {
            lines += 1;
        }
    }
    check_committed(events, lines, hash.hex())
}

/// One verified partition, read lazily line by line.
struct Partition {
    path: String,
    reader: BufReader<File>,
    unreadable: u64,
    /// Lines of an older event format: refused (reported), never converted.
    old_format: u64,
    buf: Vec<u8>,
    /// What `verify` counted and hashed, and the same over the bytes this reader folds.
    verified_lines: u64,
    verified_hash: String,
    lines: u64,
    hash: Fnv1a64,
}

impl Partition {
    /// The next event; `Ok(None)` only at the end of the very bytes that were verified.
    fn next_event(&mut self) -> Result<Option<MarketEvent>, String> {
        loop {
            self.buf.clear();
            match self.reader.read_until(b'\n', &mut self.buf) {
                Ok(0) => {
                    let hash = self.hash.hex();
                    if self.lines != self.verified_lines || hash != self.verified_hash {
                        return Err(format!("{}: changed after verification ({} lines, hash {hash}; verified {} lines, hash {})",
                            self.path, self.lines, self.verified_lines, self.verified_hash));
                    }
                    return Ok(None);
                }
                Ok(_) => {}
                Err(e) => return Err(format!("{}: read after {} lines: {e}", self.path, self.lines)),
            }
            self.hash.update(&self.buf);
            let line = String::from_utf8_lossy(&self.buf);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            self.lines += 1;
            match MarketEvent::decode_slice(line.as_bytes()) {
                Ok(event) => return Ok(Some(event)),
                Err(Refused::OldFormat(_)) => self.old_format += 1,
                Err(Refused::Undecodable(_)) => self.unreadable += 1,
            }
        }
    }
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// The entries of `dir`: `Ok(None)` when it does not exist, an error when it (or one of its entries) cannot be listed.
fn list(dir: &Path) -> Result<Option<Vec<PathBuf>>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("list: {e}")),
    };
    entries.map(|entry| entry.map(|e| e.path()).map_err(|e| format!("list: {e}"))).collect::<Result<Vec<_>, _>>().map(Some)
}

/// Whether `path` is a file: `false` only when nothing is there.
fn is_file(path: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(meta.is_file()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{}: {e}", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())),
    }
}

/// Every partition directory of one date (all sessions and codes of the folded markets) that has a manifest. A
/// market with no folder for the date has no data; a folder or file that cannot be listed or examined is a problem.
fn partitions(args: &ExportArgs, date: &str, problems: &mut Vec<Value>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut refuse = |dir: &Path, reason: String| problems.push(json!({"partition": relative(&args.historical_root, dir), "refused": reason}));
    for market in &args.markets {
        let day = PartitionKey::new(&args.source, market, date, "", "").date_dir(&args.historical_root);
        let sessions = match list(&day) {
            Ok(Some(sessions)) => sessions,
            Ok(None) => continue,
            Err(reason) => {
                refuse(&day, reason);
                continue;
            }
        };
        for session in sessions {
            let codes = match list(&session) {
                Ok(codes) => codes.unwrap_or_default(),
                Err(reason) => {
                    refuse(&session, reason);
                    continue;
                }
            };
            for dir in codes.into_iter().filter(|d| !market_runtime::historical_store::is_hidden(d)) {
                match (is_file(&dir.join("events.jsonl")), is_file(&dir.join("manifest.json"))) {
                    (Ok(false), _) => {}
                    (Ok(true), Ok(true)) => dirs.push(dir),
                    (Ok(true), Ok(false)) => refuse(&dir, "no manifest: not committed".into()),
                    (Err(reason), _) | (_, Err(reason)) => refuse(&dir, reason),
                }
            }
        }
    }
    dirs.sort();
    dirs
}

fn sample_row(key: &KeyId, snapshot: &FeatureSnapshot, durable_sequence: u64) -> Value {
    json!({
        "source": key.source, "market": key.market, "trading_date": key.trading_date, "session": key.session,
        "code": key.code, "durable_sequence": durable_sequence, "cutoff_ns": snapshot.cutoff_ns,
        "generation": snapshot.generation,
        "values": snapshot.values.iter().map(|v| if v.is_finite() { json!(v) } else { Value::Null }).collect::<Vec<_>>(),
        "categories": snapshot.categories,
    })
}

struct DateResult {
    report: Value,
    samples: Vec<(u64, Value)>,
}

struct Chosen {
    sequence: u64,
    key: KeyId,
    cutoff_ns: i64,
    p0: f64,
    row: Value,
}

/// Each sampled key's prints (exchange time, price) and each scope's data extent, from the same ordered pass.
#[derive(Default)]
struct FuturePaths {
    prints: HashMap<KeyId, Vec<(i64, f64)>>,
    scope_end: HashMap<(String, String, String, String), i64>,
}

impl FuturePaths {
    fn observe(&mut self, key: &KeyId, event: &MarketEvent, sampled: bool) {
        let scope = (key.source.clone(), key.market.clone(), key.trading_date.clone(), key.session.clone());
        let end = self.scope_end.entry(scope).or_insert(i64::MIN);
        *end = (*end).max(event.exchange_ts_ns);
        if !sampled {
            return;
        }
        let units = match &event.payload {
            Payload::Trade { price, simtrade, auction, after_hours, no_last_sale, .. } if !*simtrade && !*auction && !*after_hours && !*no_last_sale => *price,
            Payload::Quote { current, .. } => *current,
            _ => 0,
        };
        if units > 0 {
            self.prints.entry(key.clone()).or_default().push((event.exchange_ts_ns, market_runtime::wire::money(units)));
        }
    }

    /// Exchange time, not arrival order: a late print belongs where it happened (stable for equal times).
    fn seal(&mut self) {
        for path in self.prints.values_mut() {
            path.sort_by_key(|(ts, _)| *ts);
        }
    }

    fn future(&self, key: &KeyId, t: i64, p0: f64, minutes: u32) -> Value {
        if !(p0.is_finite() && p0 > 0.0) {
            return json!({"state": "NO_PRICE"});
        }
        let end = t + minutes as i64 * MINUTE_NS;
        let scope = (key.source.clone(), key.market.clone(), key.trading_date.clone(), key.session.clone());
        if self.scope_end.get(&scope).copied().unwrap_or(i64::MIN) < end {
            return json!({"state": "TAIL_INSUFFICIENT"});
        }
        let path = self.prints.get(key).map(Vec::as_slice).unwrap_or(&[]);
        let lo = path.partition_point(|(ts, _)| *ts <= t);
        let hi = path.partition_point(|(ts, _)| *ts <= end);
        if hi <= lo {
            return json!({"state": "NO_FUTURE_PRICE"});
        }
        let (mut high, mut low) = (f64::NEG_INFINITY, f64::INFINITY);
        for (_, price) in &path[lo..hi] {
            high = high.max(*price);
            low = low.min(*price);
        }
        json!({"state": "OK", "max": high / p0 - 1.0, "min": low / p0 - 1.0})
    }
}

fn export_date(args: &ExportArgs, date: &str, progress: &mut Progress) -> DateResult {
    let mut problems = Vec::new();
    let mut files = Vec::new();
    let mut parts: Vec<Partition> = Vec::new();
    let dirs = partitions(args, date, &mut problems);
    let partition_count = dirs.len() as u64;
    progress.start(date, "verify", partition_count);
    for (checked, dir) in dirs.into_iter().enumerate() {
        progress.tick(date, "verify", checked as u64, partition_count);
        let path = relative(&args.historical_root, &dir);
        let manifest = std::fs::read_to_string(dir.join("manifest.json")).ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let Some(manifest) = manifest else {
            problems.push(json!({"partition": path, "refused": "manifest unreadable"}));
            continue;
        };
        let events = dir.join("events.jsonl");
        match verify(&events).and_then(|committed| File::open(&events).map(|f| (committed, f)).map_err(|e| e.to_string())) {
            Ok((committed, file)) => {
                files.push(json!({"partition": path, "event_count": committed.lines, "content_hash_fnv1a64": committed.content_hash,
                                  "completeness": manifest["completeness"]}));
                parts.push(Partition { path, reader: BufReader::with_capacity(1 << 20, file), unreadable: 0, old_format: 0, buf: Vec::new(),
                    verified_lines: committed.lines, verified_hash: committed.content_hash, lines: 0, hash: Fnv1a64::default() });
            }
            Err(reason) => problems.push(json!({"partition": path, "refused": reason})),
        }
    }
    progress.end(date, "verify", partition_count);
    let verified_lines: u64 = parts.iter().map(|p| p.verified_lines).sum();
    progress.start(date, "replay", verified_lines);
    // A read that fails ends that partition and is a problem of the date (never its end of data).
    let mut read_problems: Vec<String> = Vec::new();
    let mut advance = |part: &mut Partition| part.next_event().unwrap_or_else(|reason| {
        read_problems.push(reason);
        None
    });
    // Lazy k-way merge by durable_sequence: each partition is already in durable order on disk.
    let mut heads: Vec<Option<MarketEvent>> = parts.iter_mut().map(&mut advance).collect();
    let mut heap: BinaryHeap<Reverse<(u64, usize)>> = heads.iter().enumerate()
        .filter_map(|(i, e)| e.as_ref().map(|e| Reverse((e.durable_sequence, i)))).collect();
    let mut store = FeatureStore::with_context(args.context.clone());
    let mut chosen: HashMap<(KeyId, i64), Chosen> = HashMap::new();
    let mut paths = FuturePaths::default();
    let (mut applied, mut out_of_order, mut last_sequence, mut replayed) = (0u64, 0u64, 0u64, 0u64);
    while let Some(Reverse((_, index))) = heap.pop() {
        let Some(event) = heads[index].take() else { continue };
        replayed += 1;
        progress.tick(date, "replay", replayed, verified_lines);
        heads[index] = advance(&mut parts[index]);
        if let Some(next) = &heads[index] {
            heap.push(Reverse((next.durable_sequence, index)));
        }
        if event.durable_sequence < last_sequence {
            out_of_order += 1;
        }
        last_sequence = last_sequence.max(event.durable_sequence);
        if event.code == CLOCK_CODE {
            continue;
        }
        applied += 1;
        if let Some(key) = KeyId::of(&event) {
            paths.observe(&key, &event, args.sample_markets.contains(&key.market));
        }
        let (folded, _) = store.fold(&event);
        let Folded::Changed(key) = folded else { continue };
        // A gap's fill enters the fold, but it is no moment of the tape to sample: it arrives after the prints around it.
        if event.flags.backfill || !args.sample_markets.contains(&key.market) {
            continue;
        }
        if let Some(snapshot) = store.snapshot(&key).filter(|s| s.warm) {
            let bucket = snapshot.cutoff_ns.div_euclid(SAMPLE_NS);
            // A later sample of the same key and 15 seconds replaces the earlier: their last.
            chosen.insert((key.clone(), bucket), Chosen {
                sequence: event.durable_sequence, key: key.clone(), cutoff_ns: snapshot.cutoff_ns,
                p0: snapshot.values[0], row: sample_row(&key, &snapshot, event.durable_sequence),
            });
        }
    }
    let unreadable: u64 = parts.iter().map(|p| p.unreadable).sum();
    let old_format: u64 = parts.iter().map(|p| p.old_format).sum();
    problems.extend(read_problems.into_iter().map(|reason| json!({"read": reason})));
    for part in parts.iter().filter(|p| p.unreadable > 0) {
        problems.push(json!({"partition": part.path, "unreadable_lines": part.unreadable}));
    }
    progress.end(date, "replay", verified_lines);
    let sample_count = chosen.len() as u64;
    progress.start(date, "labels", sample_count);
    paths.seal();
    let mut samples: Vec<(u64, Value)> = chosen.into_values().enumerate().map(|(labelled, mut c)| {
        progress.tick(date, "labels", labelled as u64, sample_count);
        let future: serde_json::Map<String, Value> = args.horizons_minutes.iter()
            .map(|m| (m.to_string(), paths.future(&c.key, c.cutoff_ns, c.p0, *m))).collect();
        c.row["future"] = Value::Object(future);
        (c.sequence, c.row)
    }).collect();
    samples.sort_by_key(|(sequence, _)| *sequence);
    let report = json!({"trading_date": date, "partitions": files, "problems": problems, "events_applied": applied,
                        "day_context": args.context.fingerprint(&args.source, date),
                        "unreadable_lines": unreadable, "old_format_lines": old_format, "out_of_order": out_of_order,
                        "samples": samples.len(), "keys": store.key_count()});
    progress.end(date, "labels", sample_count);
    DateResult { report, samples }
}

/// Writes `<out>/samples.jsonl` and `<out>/manifest.json`; returns the manifest. A date whose partitions are not all
/// committed and intact makes the dataset `degraded` (listed per partition), so the trainer can refuse it.
pub fn export(args: &ExportArgs, spec: &SpecIdentity, progress: &mut Progress) -> Result<Value, String> {
    if args.dates.is_empty() {
        return Err("at least one --date is required".into());
    }
    std::fs::create_dir_all(&args.out).map_err(|e| format!("mkdir {}: {e}", args.out.display()))?;
    let samples_path = args.out.join("samples.jsonl");
    let tmp = args.out.join("samples.jsonl.tmp");
    let mut writer = BufWriter::new(File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?);
    let mut dates = Vec::new();
    let mut total = 0usize;
    let mut degraded = false;
    let mut dates_sorted = args.dates.clone();
    dates_sorted.sort();
    dates_sorted.dedup();
    for date in &dates_sorted {
        let result = export_date(args, date, progress);
        degraded |= !result.report["problems"].as_array().is_none_or(Vec::is_empty);
        let sample_count = result.samples.len() as u64;
        progress.start(date, "write", sample_count);
        for (written, (_, row)) in result.samples.iter().enumerate() {
            progress.tick(date, "write", written as u64, sample_count);
            serde_json::to_writer(&mut writer, row).map_err(|e| e.to_string())?;
            writer.write_all(b"\n").map_err(|e| e.to_string())?;
        }
        progress.end(date, "write", sample_count);
        total += result.samples.len();
        dates.push(result.report);
    }
    writer.flush().map_err(|e| e.to_string())?;
    drop(writer);
    std::fs::rename(&tmp, &samples_path).map_err(|e| format!("rename samples: {e}"))?;
    let bytes = std::fs::read(&samples_path).map_err(|e| e.to_string())?;
    let manifest = json!({
        "schema": DATASET_SCHEMA,
        "builder": {"name": "analysis_runtime", "version": env!("CARGO_PKG_VERSION")},
        "feature_spec": {"spec_id": spec.spec_id, "schema_digest": spec.schema_digest,
                          "feature_version": spec.feature_version, "preprocessing_version": spec.preprocessing_version,
                          "fold_version": FOLD_VERSION},
        "numeric_columns": NUMERIC_COLUMNS.as_slice(),
        "category_columns": CATEGORY_COLUMNS.as_slice(),
        "sampling_policy": SAMPLING_POLICY,
        "future_path_policy": FUTURE_PATH_POLICY, "horizons_minutes": args.horizons_minutes,
        "source": args.source, "markets": args.markets, "sample_markets": args.sample_markets,
        "trading_dates": dates_sorted, "samples": total, "degraded": degraded,
        "samples_sha256": market_runtime::sha256::hex(&bytes),
        "dates": dates,
    });
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    market_runtime::fsutil::atomic_write(&args.out.join("manifest.json"), text.as_bytes()).map_err(|e| format!("write manifest.json: {e}"))?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accum::tests::trade_at;
    use crate::contract::online_v3_feature_spec;

    fn write_partition(root: &Path, market: &str, code: &str, events: &[MarketEvent], manifest_count: Option<usize>) -> PathBuf {
        let dir = root.join("source=shioaji").join(format!("market={market}")).join("trading_date=2026-09-29")
            .join("session=DAY").join(code);
        std::fs::create_dir_all(&dir).unwrap();
        let mut buf = Vec::new();
        for e in events {
            serde_json::to_writer(&mut buf, e).unwrap();
            buf.push(b'\n');
        }
        std::fs::write(dir.join("events.jsonl"), &buf).unwrap();
        if let Some(count) = manifest_count {
            std::fs::write(dir.join("manifest.json"), json!({"event_count": count, "content_hash_fnv1a64": market_runtime::replay::fnv1a64(&buf),
                                                             "completeness": "complete"}).to_string()).unwrap();
        }
        dir
    }

    fn with_code(mut e: MarketEvent, code: &str) -> MarketEvent {
        e.code = code.into();
        e.symbol = format!("shioaji:STK:{code}");
        e
    }

    #[test]
    fn bytes_that_differ_from_the_verified_ones_or_cannot_be_decoded_degrade_the_date() {
        let root = std::env::temp_dir().join(format!("ar-dataset-changed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let events = [with_code(trade_at(1, 540, 1, 1_000_000, 1, 1), "A"), with_code(trade_at(2, 541, 1, 1_000_100, 1, 1), "A")];
        let dir = write_partition(&root, "STK", "A", &events, Some(events.len()));
        let path = dir.join("events.jsonl");
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        let lines = verify(&path).unwrap().lines;
        // The file the fold reads is not the one that was verified (appended to in between).
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"late\": 1}\n").unwrap();
        let mut part = Partition { path: "A".into(), reader: BufReader::new(File::open(&path).unwrap()), unreadable: 0, old_format: 0,
            buf: Vec::new(), verified_lines: lines, verified_hash: manifest["content_hash_fnv1a64"].as_str().unwrap().into(), lines: 0,
            hash: Fnv1a64::default() };
        let mut read = 0;
        let error = loop {
            match part.next_event() {
                Ok(Some(_)) => read += 1,
                Ok(None) => panic!("a changed file must not end as complete"),
                Err(error) => break error,
            }
        };
        assert_eq!(read, 2);
        assert!(error.contains("changed after verification"), "{error}");
        // A committed partition holding an undecodable line is a problem, not a quietly shorter day.
        let mut buf = Vec::new();
        serde_json::to_writer(&mut buf, &events[0]).unwrap();
        buf.extend_from_slice(b"\nnot an event\n");
        std::fs::write(&path, &buf).unwrap();
        std::fs::write(dir.join("manifest.json"), json!({"event_count": 2, "content_hash_fnv1a64": market_runtime::replay::fnv1a64(&buf)}).to_string()).unwrap();
        let spec = SpecIdentity::of(&online_v3_feature_spec());
        let args = ExportArgs { historical_root: root.clone(), dates: vec!["2026-09-29".into()], out: root.join("out"),
                                source: "shioaji".into(), markets: vec!["STK".into()], sample_markets: vec!["STK".into()],
                                horizons_minutes: vec![3], context: ContextSource::default() };
        let manifest = export(&args, &spec, &mut Progress::new(&mut std::io::sink(), PROGRESS_INTERVAL)).unwrap();
        assert_eq!(manifest["degraded"], json!(true), "{manifest}");
        assert!(manifest["dates"][0]["problems"].to_string().contains("unreadable_lines"), "{manifest}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_dataset_is_the_live_fold_sampled_once_per_key_and_15_seconds_and_refuses_uncommitted_partitions() {
        let root = std::env::temp_dir().join(format!("ar-dataset-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        // Two codes interleaved by durable_sequence across two files; minutes 540..=548, two prints a minute for A.
        let (mut a, mut b) = (Vec::new(), Vec::new());
        let mut seq = 0;
        for minute in 540..=548 {
            for _ in 0..2 {
                seq += 1;
                a.push(with_code(trade_at(seq, minute, 1, 1_000_000 + seq as i64 * 100, 1, 1), "A"));
            }
            seq += 1;
            b.push(with_code(trade_at(seq, minute, 1, 500_000, 1, -1), "B"));
        }
        write_partition(&root, "STK", "A", &a, Some(a.len()));
        write_partition(&root, "STK", "B", &b, Some(b.len()));
        // Not committed (no manifest) and a manifest that disagrees: neither is used silently.
        write_partition(&root, "STK", "C", &[with_code(trade_at(999, 540, 1, 1_000_000, 1, 1), "C")], None);
        let out = root.join("out");
        let spec = SpecIdentity::of(&online_v3_feature_spec());
        let args = ExportArgs { historical_root: root.clone(), dates: vec!["2026-09-29".into()], out: out.clone(),
                                source: "shioaji".into(), markets: vec!["STK".into()], sample_markets: vec!["STK".into()],
                                horizons_minutes: vec![3], context: ContextSource::default() };
        let manifest = export(&args, &spec, &mut Progress::new(&mut std::io::sink(), PROGRESS_INTERVAL)).unwrap();
        assert_eq!(manifest["feature_spec"]["schema_digest"], json!(spec.schema_digest));
        assert_eq!(manifest["feature_spec"]["fold_version"], json!(FOLD_VERSION));
        assert_eq!(manifest["degraded"], json!(true), "C has no manifest");
        assert!(manifest["dates"][0]["problems"].to_string().contains("not committed"));

        // The same events folded live, sample by sample, give the same rows.
        let mut live = FeatureStore::default();
        let mut events: Vec<MarketEvent> = a.iter().chain(b.iter()).cloned().collect();
        events.sort_by_key(|e| e.durable_sequence);
        let mut expected: HashMap<(String, i64), (Vec<Option<f64>>, Vec<String>)> = HashMap::new();
        for e in &events {
            if let (Folded::Changed(key), _) = live.fold(e) {
                let snap = live.snapshot(&key).unwrap();
                if snap.warm {
                    expected.insert((key.code.clone(), snap.cutoff_ns.div_euclid(SAMPLE_NS)),
                                    (snap.values.iter().map(|v| v.is_finite().then_some(*v)).collect(), snap.categories.clone()));
                }
            }
        }
        let rows: Vec<Value> = std::fs::read_to_string(out.join("samples.jsonl")).unwrap().lines()
            .map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(rows.len(), expected.len(), "one sample per warm key and 15 seconds");
        for row in &rows {
            let bucket = row["cutoff_ns"].as_i64().unwrap().div_euclid(SAMPLE_NS);
            let values: Vec<Option<f64>> = row["values"].as_array().unwrap().iter().map(Value::as_f64).collect();
            let categories: Vec<String> = serde_json::from_value(row["categories"].clone()).unwrap();
            assert_eq!((values, categories), expected[&(row["code"].as_str().unwrap().to_string(), bucket)]);
        }
        assert!(rows.iter().any(|r| r["categories"] == json!(["__MISSING__", "A"])), "no security master: industry missing");
        assert_eq!(manifest["category_columns"], json!(["industry", "stock"]));
        // future-path-v1, recomputed by brute force from the raw prints.
        let scope_end = events.iter().map(|e| e.exchange_ts_ns).max().unwrap();
        for row in &rows {
            let (t, p0) = (row["cutoff_ns"].as_i64().unwrap(), row["values"][0].as_f64().unwrap());
            let own: Vec<f64> = events.iter().filter(|e| e.code == row["code"].as_str().unwrap())
                .filter(|e| e.exchange_ts_ns > t && e.exchange_ts_ns <= t + 3 * MINUTE_NS)
                .filter_map(|e| match e.payload { Payload::Trade { price, auction: false, .. } => Some(market_runtime::wire::money(price)), _ => None }).collect();
            let future = &row["future"]["3"];
            if scope_end < t + 3 * MINUTE_NS {
                assert_eq!(future, &json!({"state": "TAIL_INSUFFICIENT"}));
            } else {
                let high = own.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let low = own.iter().cloned().fold(f64::INFINITY, f64::min);
                assert_eq!(future, &json!({"state": "OK", "max": high / p0 - 1.0, "min": low / p0 - 1.0}), "{row}");
            }
        }
        assert!(rows.iter().any(|r| r["future"]["3"]["state"] == "OK") && rows.iter().any(|r| r["future"]["3"]["state"] == "TAIL_INSUFFICIENT"));
        let sequences: Vec<u64> = rows.iter().map(|r| r["durable_sequence"].as_u64().unwrap()).collect();
        assert!(sequences.windows(2).all(|w| w[0] < w[1]), "rows in durable order");

        // A partition whose bytes no longer match its manifest is refused and named.
        write_partition(&root, "STK", "B", &b[..b.len() - 1], Some(b.len()));
        let manifest = export(&args, &spec, &mut Progress::new(&mut std::io::sink(), PROGRESS_INTERVAL)).unwrap();
        assert!(manifest["dates"][0]["problems"].to_string().contains("manifest event_count"));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn progress_lines(sink: &[u8]) -> Vec<Value> {
        std::str::from_utf8(sink).unwrap().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["progress"].clone()).collect()
    }

    #[test]
    fn every_phase_of_every_date_reports_its_start_and_its_end_in_order() {
        let root = std::env::temp_dir().join(format!("ar-dataset-progress-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (mut a, mut b) = (Vec::new(), Vec::new());
        let mut seq = 0;
        for minute in 540..=548 {
            seq += 1;
            a.push(with_code(trade_at(seq, minute, 1, 1_000_000 + seq as i64 * 100, 1, 1), "A"));
            seq += 1;
            b.push(with_code(trade_at(seq, minute, 1, 500_000, 1, -1), "B"));
        }
        write_partition(&root, "STK", "A", &a, Some(a.len()));
        write_partition(&root, "STK", "B", &b, Some(b.len()));
        let spec = SpecIdentity::of(&online_v3_feature_spec());
        // A date with no data still walks every phase, with totals of 0.
        let args = ExportArgs { historical_root: root.clone(), dates: vec!["2026-09-29".into(), "2026-09-30".into()], out: root.join("out"),
                                source: "shioaji".into(), markets: vec!["STK".into()], sample_markets: vec!["STK".into()],
                                horizons_minutes: vec![3], context: ContextSource::default() };

        // No line between a phase's start and end when the interval never passes.
        let mut sink = Vec::new();
        let manifest = export(&args, &spec, &mut Progress::new(&mut sink, Duration::from_secs(3600))).unwrap();
        let lines = progress_lines(&sink);
        let samples = manifest["dates"][0]["samples"].as_u64().unwrap();
        assert!(samples > 0);
        let expected = [
            ("2026-09-29", "verify", 0, 2), ("2026-09-29", "verify", 2, 2),
            ("2026-09-29", "replay", 0, 18), ("2026-09-29", "replay", 18, 18),
            ("2026-09-29", "labels", 0, samples), ("2026-09-29", "labels", samples, samples),
            ("2026-09-29", "write", 0, samples), ("2026-09-29", "write", samples, samples),
            ("2026-09-30", "verify", 0, 0), ("2026-09-30", "verify", 0, 0),
            ("2026-09-30", "replay", 0, 0), ("2026-09-30", "replay", 0, 0),
            ("2026-09-30", "labels", 0, 0), ("2026-09-30", "labels", 0, 0),
            ("2026-09-30", "write", 0, 0), ("2026-09-30", "write", 0, 0),
        ];
        let got: Vec<(String, String, u64, u64)> = lines.iter().map(|l| (l["date"].as_str().unwrap().into(), l["phase"].as_str().unwrap().into(),
                                                                      l["done"].as_u64().unwrap(), l["total"].as_u64().unwrap())).collect();
        let want: Vec<(String, String, u64, u64)> = expected.iter().map(|(d, p, done, total)| (d.to_string(), p.to_string(), *done, *total)).collect();
        assert_eq!(got, want);
        assert!(lines.iter().all(|l| l["elapsed_ms"].is_u64()));

        // With every step past the interval, the lines between never go back or past the total, and the last is done = total.
        let mut sink = Vec::new();
        export(&args, &spec, &mut Progress::new(&mut sink, Duration::ZERO)).unwrap();
        let lines = progress_lines(&sink);
        assert!(lines.len() > want.len(), "intermediate lines are written");
        for pair in lines.windows(2) {
            if pair[0]["date"] == pair[1]["date"] && pair[0]["phase"] == pair[1]["phase"] {
                assert!(pair[0]["done"].as_u64() <= pair[1]["done"].as_u64(), "{pair:?}");
            }
        }
        assert!(lines.iter().all(|l| l["done"].as_u64() <= l["total"].as_u64()));
        let last = lines.last().unwrap();
        assert_eq!((last["phase"].as_str(), last["done"].as_u64()), (Some("write"), last["total"].as_u64()));
        let _ = std::fs::remove_dir_all(&root);
    }
}
