//! The one-shot historical materialization job (`analysis_runtime --materialize ...`): sealed durable market data ->
//! the historical store (`<out-dir>/source=../market=../trading_date=../session=../<CODE>/{events.jsonl, state.json,
//! manifest.json}`), read by service/market/history/historical_store.py. The job never writes into the store itself:
//! each partition is written and verified in the job's staging folder, then handed to the store's manager
//! (market_runtime historical_store.rs), which under the store lock either renames it into place and updates the
//! date's `totals.json`, or drops it when retention (設定 → 資料儲存, against A's rollover cutoffs at that moment)
//! already removes it -- a date the rollover put past retention while the job ran is never written back.
//!
//! Not a long-running process. Health spawns it per sealed session identity (health/materializer_job_runner.js) as
//! the job's lifecycle owner; whether a session is sealed, and what its result means for materialization_status, stays
//! the per-source orchestrator's (SessionOrchestrator for Shioaji, FutuSessionLifecycleCoordinator for Futu).
//!
//! The job folds the partition with Rust B's canonical engine, not a third engine of its own (one that called
//! every sequence rejection a data gap and kept its own simtrade rule): the same minute bars, volume and gap
//! marking the live analysis projection holds -- and the completeness it reports rests only on explicit loss
//! evidence: a damaged WAL, events the producer said it dropped (flags.gap_before), volume the exchange's cumulative
//! total proves was never delivered, and the orchestrator's own claim: the session's, and per code the broker-connection
//! outages its session evidence holds during trading (`--gap-codes`). Duplicate and out-of-order events are counted
//! on their own; they are not loss.
//!
//! Deterministic: the same WAL and identity always give the same files (safe to re-run), and nothing live is touched.
//! `--code *` materializes every instrument of the (source, market, trading_date, session) found in the WAL -- Shioaji
//! seals the whole STK session as one unit, Futu seals per code.
//!
//! A closed session's gaps filled from the broker's history afterwards (`--input store`, scripts/fill_history_gaps.py):
//! the job reads the session's partitions from the historical store instead of the WAL (pruned by then), adds each
//! code's fill (`--fills-dir`: `<CODE>.jsonl`, backfill events numbered after the partition's own), and folds them
//! again. A `--code *` job also folds each fill whose code has no partition (a whole session the store never got,
//! history_gaps.rs session_windows) into a new one: filled, so `repaired`. Events the user decided are void (`--voided-events`, market_runtime voided.rs) are left out whichever
//! the input is: a removal the user decided, not a loss.
//!
//! `repaired` (user 11-06): its prints (an index: its minutes) are filled and nothing else proves a loss, but what the
//! broker's history cannot give back -- the book (BidAsk) of the gap -- is still missing, so it is NOT complete: a
//! validation set, never training data (daily_summary `tick_complete` counts only `complete` codes). A session's
//! claim of `repaired` (Market Runtime's evidence: a restart's gap filled live) makes a code with no other loss
//! `repaired`. A refold from the store never makes a code more complete than its partition was: a code that got a fill
//! and whose volume holes are closed is `repaired`, one that got none keeps what it was, and one whose fill could not
//! resolve its gaps (`--unresolved-codes`) is `gap_detected`.
//!
//! A whole session (`--code *`) of a scope with 量變 (Shioaji STK DAY, Futu US) also publishes its date's volume
//! baseline (`--volume-baseline-root`, baseline_publish.rs) from the same fold, after the daily summary; a failure
//! fails the job like the summary's. The result counts what it wrote apart: `market_event_count` (the events Market
//! Runtime accepted, plus what a fill added: `backfill_event_count`) and `control_event_count` (Market Runtime's own
//! coverage and loss records, which its session evidence never counts as accepted); `total_event_count` is both.
//!
//! Progress: a whole STK session is minutes of work, so the job reports where it is on stderr with the export's
//! progress lines (dataset.rs `Progress`, `date` = the trading date): `scan` (the WAL's segments indexed and checked),
//! `read` (WAL records streamed; total = every record the WAL holds), `write` (partitions folded, written and verified;
//! total = the events of the codes found, so its rate is events a second like read's) and, for a summarized market,
//! `summary` (the session's daily summary). Health turns them into the 收盤整理 progress the data center shows
//! (health/materializer_job_runner.js); its time left is estimated from these counts (closing_progress.py).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use market_runtime::event::{MarketEvent, Payload, COVERAGE_CONTROL, LOSS_CONTROL};
use market_runtime::wal_session::{belongs, clean, Ledger};
use market_runtime::replay::Partition;
use market_runtime::volume as vol;
use market_runtime::voided::Voided;
use market_runtime::wal;
use serde_json::{json, Map, Value};

use crate::accum::{InstrumentId, Instrument};
use crate::daily_summary;
use crate::dataset::Progress;
use market_runtime::calendar::Calendar;
use crate::engine::Engine;
use crate::kbar_store;
use crate::rules::RuleSet;
use market_runtime::cli::Flags;

const WILDCARD_CODE: &str = "*";
const KNOWN_MARKETS: &[&str] = &["STK", "IDX", "FUT", "US", "HK", "SH", "SZ", "CC"];
const STATE_SCHEMA: &str = "historical-state-v3";

/// Reject identities that can never match a real partition (never success, never retried).
fn validate_identity(source: &str, market: &str, trading_date: &str, session: &str) -> Result<(), String> {
    let date_ok = market_runtime::event::parse_calendar_date(trading_date).is_some();
    if source.trim().is_empty() || session.trim().is_empty() || !date_ok || !KNOWN_MARKETS.contains(&market.to_ascii_uppercase().as_str()) {
        return Err(format!("invalid identity source={source} market={market} trading_date={trading_date} session={session}"));
    }
    Ok(())
}


use market_runtime::fsutil::atomic_write;
use market_runtime::historical_store::{is_hidden, PartitionKey, Published, Staging, Store, StoreConfig};

/// Per-lane (quote / trade / orderbook / minute_bar) counts: diagnostics only, never a completeness signal.
fn lane_report(events: &[MarketEvent]) -> Value {
    let mut lanes: BTreeMap<&str, (u64, u64, u64)> = BTreeMap::new();
    for e in events {
        let entry = lanes.entry(e.payload.stream_key()).or_insert((0, e.sequence, e.sequence));
        entry.0 += 1;
        entry.2 = e.sequence;
    }
    Value::Object(lanes.into_iter().map(|(lane, (events, first, last))| {
        (lane.to_string(), json!({"events": events, "first_sequence": first, "last_sequence": last}))
    }).collect())
}

/// The historical state of one folded instrument: the summary, the minute bars B holds, and the last book.
fn state_of(inst: &Instrument, events: &[MarketEvent]) -> Value {
    let minutes: Vec<_> = inst.minutes.values().filter(|m| m.close.is_some()).collect();
    let mut trend = Map::new();
    for m in &minutes {
        trend.insert(m.minute.to_string(), json!({
            "minute": m.minute, "open": m.open, "high": m.high, "low": m.low, "close": m.close,
            "volume": m.volume.unwrap_or(0.0), "average": m.average.unwrap_or(0), "amount": m.amount.unwrap_or(0.0),
            "quality": m.quality.name(), "unattributed_volume": m.unattributed_volume,
        }));
    }
    let unattributed: f64 = inst.minutes.values().map(|m| m.unattributed_volume).sum();
    let seen: f64 = inst.minutes.values().filter_map(|m| m.volume).sum();
    let amount: f64 = minutes.iter().filter_map(|m| m.amount).sum();
    // Open / high / low are the K-bar file's daily bar (minutes that traded, a US day's regular session).
    let daily = kbar_store::daily_bar(inst, &Calendar::default());
    let open = daily.map_or(0, |d| d.open);
    let high = daily.map_or(0, |d| d.high);
    let low = daily.map_or(0, |d| d.low);
    let current = minutes.last().and_then(|m| m.close).unwrap_or(0);
    // The book a reader shows for the session is its newest by exchange time (max_by_key keeps the last of equal
    // times, durable order), as the source sent it: the rule the live book follows (features.rs, accum.rs).
    let book = events.iter().filter_map(|e| match &e.payload {
        Payload::OrderBook { bids, asks, simtrade } if !*simtrade => Some((e.exchange_ts_ns, bids, asks)),
        _ => None,
    }).max_by_key(|(ts, ..)| *ts).map(|(_, bids, asks)| (bids, asks));
    let levels = |side: Option<&Vec<market_runtime::event::BookLevel>>| -> Value {
        Value::Array(side.into_iter().flatten().map(|l| json!({"price": l.price, "volume": l.volume})).collect())
    };
    json!({
        "summary": {"open": open, "high": high, "low": low, "current": current,
                    // The price the day's move is measured from (Reference::comparison_price: the reference price, else
                    // 昨收); null when the provider published neither.
                    "reference_price": inst.price.reference.comparison_price(),
                    // The day's official 漲停 / 跌停 (null when the provider published none), for 歷史回放's list.
                    "limit_up": inst.price.reference.limit_up, "limit_down": inst.price.reference.limit_down,
                    // The day's volume: the seen prints' plus what the exchange's total proves traded unseen.
                    "total_volume": vol::wire(seen + unattributed), "unattributed_volume": vol::wire(unattributed),
                    "total_amount": inst.price.total_amount.unwrap_or(amount)},
        "minute_trend": trend,
        "bids": levels(book.map(|(b, _)| b)), "asks": levels(book.map(|(_, a)| a)),
    })
}

struct Outcome {
    code: String,
    /// This code's daily-summary entry (daily_summary.rs), for a summarized market.
    summary: Option<Value>,
    /// What this code adds to its K-bar file (kbar_store.rs).
    kbar_day: Option<kbar_store::SessionDay>,
    /// This code's 量變 baseline minutes (baseline_publish.rs), for a scope that has one.
    baseline: Option<Map<String, Value>>,
    /// Every event written to the partition: the market events Market Runtime accepted, the ones a fill added
    /// (`backfill_count`), and Market Runtime's own coverage and loss records (`control_count`), which its session
    /// evidence never counts as accepted.
    event_count: usize,
    control_count: usize,
    backfill_count: usize,
    completeness: &'static str,
    loss: Vec<String>,
    /// Where the partition is in the store; None when retention already removes it and it was dropped.
    store_dir: Option<PathBuf>,
}

impl Outcome {
    fn manifest_path(&self) -> Option<PathBuf> {
        self.store_dir.as_ref().map(|dir| dir.join("manifest.json"))
    }
}

/// One job's identity and inputs: what every partition of it shares.
struct Job {
    data_dir: PathBuf,
    source: String,
    market: String,
    code: String,
    logical_code: Option<String>,
    trading_date: String,
    session: String,
    /// The orchestrator's own claim (its session-finalization record): never trusted alone, never ignored.
    claimed: String,
    /// The codes the orchestrator's session evidence holds a broker-connection outage of during trading for
    /// (`--gap-codes`, comma separated): the exchange streamed them nothing for that span and never re-sends it.
    gap_codes: BTreeSet<String>,
    /// The codes whose every such outage was filled from the broker's history and verified (`--repaired-codes`): their
    /// prints are whole again, the book of those spans is not, so `repaired` at best.
    repaired_codes: BTreeSet<String>,
    /// Where a whole Shioaji STK / IDX session's daily summary goes (daily_summary.rs); None = not written.
    daily_summary_dir: Option<PathBuf>,
    /// Where a whole session's 量變 baseline goes (`<root>/<source>/volume_baseline`, baseline_publish.rs); None =
    /// not written.
    volume_baseline_root: Option<PathBuf>,
    /// The K-bar store (`--kbar-dir`, kbar_store.rs); None = not written.
    kbars: Option<kbar_store::Store>,
    rules: RuleSet,
    /// `--input store`: the session's partitions from the historical store (with fills), not the WAL.
    from_store: bool,
    fills_dir: Option<PathBuf>,
    /// The void events (`--voided-events`, market_runtime voided.rs): left out of the session, from the WAL or the store.
    voided: Voided,
    /// Codes whose fill could not resolve their gaps (`--unresolved-codes`).
    unresolved: BTreeSet<String>,
    /// The historical store (`--out-dir`) and its retention inputs: A's rollover cutoffs (`--rollover-cutoffs`), the
    /// storage_retention revision (`--retention-config-root`: the settings store, read for that domain only -- the fold's
    /// rules come from `--config-root`) and the ledgers' traded codes (`--traded-codes-dir`).
    store: Store,
}

impl Job {
    /// Err(refusal) is a terminal answer: a missing argument (invalid_request) or an invalid identity.
    fn parse(flags: &Flags, rules: RuleSet) -> Result<Self, Value> {
        let require = |name: &str| flags.required(name).map(str::to_owned)
            .map_err(|error| json!({"ok": false, "status": "invalid_request", "outcome": "invalid_request", "error": error}));
        let out_dir = PathBuf::from(require("--out-dir")?);
        let store = Store::new(StoreConfig { root: out_dir, cutoffs: flags.get("--rollover-cutoffs").map(PathBuf::from),
            config_root: flags.get("--retention-config-root").map(PathBuf::from), traded_codes_dir: flags.get("--traded-codes-dir").map(PathBuf::from) });
        let from_store = match flags.get("--input") {
            None | Some("wal") => false,
            Some("store") => true,
            Some(other) => return Err(json!({"ok": false, "status": "invalid_request", "outcome": "invalid_request",
                "error": format!("--input: expected wal or store, got {other}")})),
        };
        // A list that cannot be read or does not validate refuses the job: a session is never materialized with events
        // the user decided to remove.
        let voided = Voided::load(flags.get("--voided-events").map(Path::new)).map_err(|error| json!({"ok": false,
            "status": "invalid_request", "outcome": "invalid_request", "error": format!("--voided-events: {error}")}))?;
        let job = Job {
            data_dir: if from_store { PathBuf::new() } else { PathBuf::from(require("--data-dir")?) },
            from_store,
            fills_dir: flags.get("--fills-dir").map(PathBuf::from),
            voided,
            unresolved: flags.get("--unresolved-codes").unwrap_or("").split(',').map(|c| c.trim().to_uppercase())
                .filter(|c| !c.is_empty()).collect(),
            source: require("--source")?,
            market: require("--market")?,
            code: require("--code")?,
            logical_code: flags.get("--logical-code").map(str::to_owned),
            trading_date: require("--trading-date")?,
            session: require("--session")?,
            claimed: flags.get("--completeness").unwrap_or("gap_detected").to_owned(),
            gap_codes: flags.get("--gap-codes").unwrap_or("").split(',').map(|c| c.trim().to_uppercase())
                .filter(|c| !c.is_empty()).collect(),
            repaired_codes: flags.get("--repaired-codes").unwrap_or("").split(',').map(|c| c.trim().to_uppercase())
                .filter(|c| !c.is_empty()).collect(),
            daily_summary_dir: flags.get("--daily-summary-dir").map(PathBuf::from),
            volume_baseline_root: flags.get("--volume-baseline-root").map(PathBuf::from),
            kbars: flags.get("--kbar-dir").map(|dir| kbar_store::Store::new(PathBuf::from(dir), flags.get("--retention-config-root").map(PathBuf::from))),
            rules,
            store,
        };
        let refuse = |error: String| Err(json!({"ok": false, "status": "invalid_identity", "outcome": "invalid_identity", "error": error}));
        if let Err(error) = validate_identity(&job.source, &job.market, &job.trading_date, &job.session) {
            return refuse(error);
        }
        // A named code (and its logical code) becomes a directory name: a path component, never "..", a separator or
        // an absolute path. Refused terminally, before the WAL is read.
        if !job.wildcard() {
            for value in [Some(&job.code), job.logical_code.as_ref()].into_iter().flatten() {
                if let Err(error) = job.partition(value) {
                    return refuse(format!("invalid code {value:?}: {error}"));
                }
            }
        }
        Ok(job)
    }

    fn wildcard(&self) -> bool {
        self.code == WILDCARD_CODE
    }

    fn partition(&self, code: &str) -> Result<Partition, String> {
        Partition::new(&self.source, &self.market, code, &self.trading_date, &self.session).map_err(|e| e.to_string())
    }

    fn symbol_prefix(&self) -> String {
        format!("{}:{}:", self.source.to_lowercase(), self.market.to_uppercase())
    }

    fn key(&self, logical_code: &str) -> PartitionKey {
        PartitionKey::new(&self.source, &self.market, &self.trading_date, &self.session, logical_code)
    }

    fn stage(&self) -> Result<Staging, String> {
        self.store.stage().map_err(|e| format!("staging in {}: {e}", self.store.root().display()))
    }
}

/// What the WAL holds for the job: its events by symbol (each in durable order) and the WAL's integrity.
struct SessionInput {
    by_symbol: BTreeMap<String, Vec<MarketEvent>>,
    /// Why the WAL cannot vouch for this session: damaged records, or durable sequences missing next to or inside the
    /// session's own range (a lost segment between two readable ones). None = it can.
    wal_loss: Option<String>,
    wal_integrity: Value,
}

/// The session's partitions from the historical store, each with its fill and without the events left out. The
/// fill's events take durable sequences after the partition's own, in their order (as a live fill arrives after the
/// prints around it).
fn read_store(job: &Job) -> Result<SessionInput, String> {
    let session_dir = job.key("_").dir(job.store.root()).parent().map(Path::to_path_buf).ok_or("no session directory")?;
    let mut by_symbol: BTreeMap<String, Vec<MarketEvent>> = BTreeMap::new();
    let mut dirs: Vec<PathBuf> = match fs::read_dir(&session_dir) {
        Ok(entries) => entries.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !is_hidden(p)).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(), // not an error: the session has no partition yet; its fills are its codes
        Err(e) => return Err(format!("{}: {e}", session_dir.display())),
    };
    dirs.sort();
    let read_events = |path: &Path| -> Result<Vec<MarketEvent>, String> {
        let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        bytes.split(|b| *b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)).enumerate()
            .map(|(n, line)| MarketEvent::decode_slice(line).map_err(|e| format!("{} line {}: {}", path.display(), n + 1, e.reason())))
            .collect()
    };
    let mut excluded = 0usize;
    for dir in dirs {
        let code = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !job.wildcard() && !code.eq_ignore_ascii_case(job.logical_code.as_deref().unwrap_or(&job.code)) {
            continue;
        }
        let mut events = read_events(&dir.join("events.jsonl"))?;
        let before = events.len();
        events.retain(|e| !job.voided.covers(e));
        excluded += before - events.len();
        let Some(symbol) = events.first().map(|e| e.symbol.clone()) else { continue };
        if let Some(fill) = job.fills_dir.as_ref().map(|d| d.join(format!("{}.jsonl", code.to_uppercase()))).filter(|p| p.is_file()) {
            let mut next = events.iter().map(|e| e.durable_sequence).max().unwrap_or(0);
            for mut e in read_events(&fill)? {
                if e.symbol != symbol {
                    return Err(format!("{}: an event of {} in the fill of {symbol}", fill.display(), e.symbol));
                }
                next += 1;
                e.durable_sequence = next;
                events.push(e);
            }
        }
        by_symbol.insert(symbol, events);
    }
    // A code the session should have held and has no partition of (history_gaps.rs session_windows): its fill alone is
    // its partition. Each event takes the session's durable sequence at its exchange time (session_timeline), so a
    // fold of the whole date (the training export merges every partition by durable sequence) meets it where it
    // would have streamed: numbered from 1 it came before every other event of the day -- its close seen at the open.
    if let (true, Some(fills)) = (job.wildcard(), job.fills_dir.as_ref()) {
        let mut timeline: Option<Vec<(i64, u64)>> = None;
        let held: BTreeSet<String> = by_symbol.keys().map(|s| s.to_uppercase()).collect();
        let mut fill_paths: Vec<PathBuf> = match fs::read_dir(fills) {
            Ok(entries) => entries.flatten().map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "jsonl")).collect(),
            Err(e) => return Err(format!("{}: {e}", fills.display())),
        };
        fill_paths.sort();
        let prefix = job.symbol_prefix().to_uppercase();
        for path in fill_paths {
            let code = path.file_stem().map(|n| n.to_string_lossy().to_uppercase()).unwrap_or_default();
            if held.contains(&format!("{prefix}{code}")) {
                continue;
            }
            let mut events = read_events(&path)?;
            if events.is_empty() {
                continue;
            }
            if timeline.is_none() {
                timeline = Some(session_timeline(job, &by_symbol)?);
            }
            let timeline = timeline.as_ref().expect("set above");
            events.sort_by_key(|e| e.exchange_ts_ns);
            for e in events.iter_mut() {
                if !e.symbol.eq_ignore_ascii_case(&format!("{prefix}{code}")) {
                    return Err(format!("{}: an event of {} in the fill of {code}", path.display(), e.symbol));
                }
                e.durable_sequence = sequence_at(timeline, e.exchange_ts_ns);
            }
            if let Some(symbol) = events.first().map(|e| e.symbol.clone()) {
                by_symbol.insert(symbol, events);
            }
        }
    }
    Ok(SessionInput { by_symbol, wal_loss: None,
        wal_integrity: json!({"status": "FROM_STORE", "voided_events": excluded, "voided": job.voided.fingerprint()}) })
}

/// The session's events in exchange time, as (exchange ns, the largest durable sequence up to then): the other codes of
/// this session already read, or -- none, a market whose every code is a fill -- the partitions of the source's other
/// markets on the same date and session (an index day: its stocks). Only events that streamed in: a backfill event's
/// sequence is where it was written (after the prints around it, or after a refolded partition's own), not its time.
/// Empty when the date holds nothing else.
fn session_timeline(job: &Job, held: &BTreeMap<String, Vec<MarketEvent>>) -> Result<Vec<(i64, u64)>, String> {
    #[derive(serde::Deserialize, Default)]
    struct StampFlags {
        #[serde(default)]
        backfill: bool,
    }
    #[derive(serde::Deserialize)]
    struct Stamp {
        durable_sequence: u64,
        exchange_ts_ns: i64,
        #[serde(default)]
        flags: StampFlags,
    }
    let mut stamps: Vec<(i64, u64)> = held.values().flatten().filter(|e| !e.flags.backfill)
        .map(|e| (e.exchange_ts_ns, e.durable_sequence)).collect();
    if stamps.is_empty() {
        let source_dir = job.key("_").dir(job.store.root()).ancestors().nth(4).map(Path::to_path_buf).ok_or("no source directory")?;
        let own = format!("market={}", job.market.to_uppercase());
        let markets = match fs::read_dir(&source_dir) {
            Ok(entries) => entries.flatten().map(|e| e.path()).filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n != own.as_str())).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(), // not an error: nothing else is stored
            Err(e) => return Err(format!("{}: {e}", source_dir.display())),
        };
        for market in markets {
            let session_dir = market.join(format!("trading_date={}", job.trading_date)).join(format!("session={}", job.session.to_uppercase()));
            let Ok(codes) = fs::read_dir(&session_dir) else { continue }; // not an error: that market has no such session
            for code in codes.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !is_hidden(p)) {
                let path = code.join("events.jsonl");
                let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                for line in bytes.split(|b| *b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)) {
                    let stamp: Stamp = serde_json::from_slice(line).map_err(|e| format!("{}: {e}", path.display()))?;
                    if !stamp.flags.backfill {
                        stamps.push((stamp.exchange_ts_ns, stamp.durable_sequence));
                    }
                }
            }
        }
    }
    stamps.sort_unstable();
    let mut highest = 0u64;
    for stamp in stamps.iter_mut() {
        highest = highest.max(stamp.1);
        stamp.1 = highest;
    }
    Ok(stamps)
}

/// The durable sequence a filled event at `ts` takes: the largest of the session's events up to it, the session's
/// first before them all (1 when the timeline is empty).
fn sequence_at(timeline: &[(i64, u64)], ts: i64) -> u64 {
    match timeline.partition_point(|(t, _)| *t <= ts) {
        0 => timeline.first().map_or(1, |(_, s)| *s),
        n => timeline[n - 1].1,
    }
}

/// Integrity first: a session read across WAL damage is never complete. Records are
/// streamed and only this session's are kept; a single-code job keeps only its own symbol while the WAL streams by
/// (never every instrument of the date/session, picked from afterwards).
fn read_session(job: &Job, progress: &mut Progress) -> Result<SessionInput, String> {
    if !job.data_dir.exists() {
        return Err(format!("WAL data dir does not exist: {}", job.data_dir.display()));
    }
    let date = job.trading_date.as_str();
    progress.start(date, "scan", 0);
    let (index, integrity) = wal::scan(&job.data_dir, false).map_err(|e| format!("WAL scan failed: {e}"))?;
    progress.end(date, "scan", index.segments.len() as u64);
    let records: u64 = index.segments.iter().map(|s| s.records).sum();
    let mut read = 0u64;
    progress.start(date, "read", records);
    let prefix = job.symbol_prefix();
    let only_symbol = (!job.wildcard()).then(|| format!("{}{}", prefix, job.code.to_uppercase()));
    let mut by_symbol: BTreeMap<String, Vec<MarketEvent>> = BTreeMap::new();
    // The durable-sequence span of this trading date and session, every instrument: a sequence gap touching it may
    // have held this session's events.
    let mut span: Option<(u64, u64)> = None;
    // WAL records of an older format are refused by the reader (counted in wal::OLD_FORMAT_RECORDS, logged); how many
    // this job met is reported with the WAL integrity.
    let mut voided = 0u64;
    let refused_before = wal::OLD_FORMAT_RECORDS.load(std::sync::atomic::Ordering::Relaxed);
    wal::for_each_record(&job.data_dir, &index, |event| {
        read += 1;
        progress.tick(date, "read", read, records);
        if event.trading_date == job.trading_date && event.session.eq_ignore_ascii_case(&job.session) {
            let seq = event.durable_sequence;
            span = Some(span.map_or((seq, seq), |(lo, hi)| (lo.min(seq), hi.max(seq))));
        }
        // Which events are the session's history is the one rule the WAL session read shares (wal_session.rs).
        if belongs(&event, &job.trading_date, &job.session) && event.symbol.starts_with(&prefix)
            && only_symbol.as_ref().is_none_or(|only| &event.symbol == only) {
            if job.voided.covers(&event) {
                voided += 1;
            } else {
                by_symbol.entry(event.symbol.clone()).or_default().push(event);
            }
        }
    }).map_err(|e| format!("WAL read failed: {e}"))?;
    progress.end(date, "read", records);
    // A gap (p, n) misses p+1..n-1. One that touches the session's span (adjacent included: the session's first or
    // last events) cannot be proven unrelated to it; one wholly outside it lies between events of other sessions.
    let gaps: Vec<(u64, u64)> = match span {
        Some((lo, hi)) => integrity.sequence_gaps.iter().copied().filter(|(p, n)| *n >= lo && *p <= hi).collect(),
        None => Vec::new(),
    };
    // Damage is judged like a gap: an unknown end counts as touching, one wholly outside the span is another session's.
    let corrupt = span.map_or(0, |(lo, hi)| integrity.corruption.iter()
        .filter(|c| c.first_valid_after.is_none_or(|n| n >= lo) && c.last_valid_before.is_none_or(|p| p <= hi)).count());
    let wal_loss = if corrupt > 0 {
        Some(format!("WAL damaged ({corrupt} corrupt records across this session)"))
    } else if !gaps.is_empty() {
        Some(format!("{} durable-sequence gaps in the WAL across this session, first after {}", gaps.len(), gaps[0].0))
    } else {
        None
    };
    Ok(SessionInput { by_symbol, wal_loss,
        wal_integrity: json!({"status": integrity.status, "corruption": integrity.corruption.len(), "sequence_gaps": gaps,
            "old_format_refused": wal::OLD_FORMAT_RECORDS.load(std::sync::atomic::Ordering::Relaxed) - refused_before,
            "voided_events": voided, "voided": job.voided.fingerprint()}) })
}

/// Completeness rests on loss evidence only. Returns the evidence and whether this job
/// found any itself, apart from the orchestrator's claim.
fn loss_evidence(claimed: &str, outage: bool, wal_loss: Option<&str>, ledger: &Ledger, inst: Option<&Instrument>) -> (Vec<String>, bool) {
    let mut loss: Vec<String> = Vec::new();
    // `repaired` is a claim of a filled gap, not of a loss: the code's own fill says what it is (materialize_one).
    if claimed != "complete" && claimed != "repaired" {
        loss.push(format!("orchestrator claimed {claimed}"));
    }
    if outage {
        loss.push("broker connection outage during trading (session evidence)".to_string());
    }
    if let Some(wal) = wal_loss {
        loss.push(wal.to_string());
    }
    if ledger.producer_dropped > 0 {
        loss.push(format!("producer dropped {} events", ledger.producer_dropped));
    }
    let volume_gaps = inst.map_or(0, |i| i.quality.volume_gaps);
    if volume_gaps > 0 {
        loss.push(format!("{volume_gaps} volume gaps (prints the cumulative total proves were never delivered)"));
    }
    let detected = wal_loss.is_some() || ledger.producer_dropped > 0 || volume_gaps > 0;
    (loss, detected)
}

/// The completeness the code's partition in the store had before this refold (None: no such partition).
fn stored_completeness(job: &Job, logical_code: &str) -> Option<String> {
    let manifest = fs::read(job.key(logical_code).dir(job.store.root()).join("manifest.json")).ok()?;
    let manifest: Value = serde_json::from_slice(&manifest).ok()?;
    manifest["completeness"].as_str().map(str::to_owned)
}

/// Verify before the result counts: every file re-read, the event count round-trips.
fn verify_partition(events_path: &Path, manifest_path: &Path, symbol: &str, event_count: usize) -> Result<(), String> {
    let verify = fs::read(events_path).map_err(|e| format!("verify read events.jsonl: {e}"))?;
    if verify.iter().filter(|b| **b == b'\n').count() != event_count {
        return Err(format!("post-write verification failed for {symbol}: event lines differ"));
    }
    let readback: Value = serde_json::from_slice(&fs::read(manifest_path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("verify manifest.json: {e}"))?;
    if readback["event_count"].as_u64() != Some(event_count as u64) {
        return Err(format!("post-write verification failed for {symbol}: manifest event_count mismatch"));
    }
    Ok(())
}

/// Fold and durably write one partition into `staging`, verify it there, then publish it through the store's manager.
/// Never partial on success.
fn materialize_one(job: &Job, staging: &Staging, events: Vec<MarketEvent>, logical_code: &str, wal_loss: Option<&str>) -> Result<Outcome, String> {
    job.partition(logical_code).map_err(|e| format!("refusing to materialize {}:{}:{logical_code}: {e}", job.source, job.market))?;
    let (events, ledger) = clean(events);
    let mut engine = Engine::new(Calendar::default(), job.rules.clone());
    for e in &events {
        engine.apply(e);
    }
    let id = events.first().map(InstrumentId::of).ok_or("no events")?;
    let inst = engine.instruments.get(&id);
    let state = inst.map(|i| state_of(i, &events));
    let outage = job.gap_codes.contains(&logical_code.to_uppercase());
    let filled = events.iter().any(|e| e.flags.backfill);
    // Proven whole where the source can prove it (history_gaps.rs): a stock's prints by the exchange's cumulative
    // volume (no hole left, from zero), a futures contract's the same over its quotes, an index's minutes by a quote
    // in every trading minute.
    let proven = job.from_store && if job.market.eq_ignore_ascii_case("STK") {
        inst.is_some_and(|i| i.quality.volume_gaps == 0)
    } else {
        crate::history_gaps::windows(&events, &Calendar::default()).is_empty()
    };
    let (mut loss, detected) = if job.from_store && (proven || (filled && inst.is_some_and(|i| i.quality.volume_gaps == 0))) {
        // The prints are whole; events the producer said it dropped are then of the lanes the history cannot give
        // back (the book), which `repaired` already states.
        loss_evidence("complete", false, None, &Ledger { producer_dropped: 0, ..ledger.clone() }, inst)
    } else if job.from_store {
        loss_evidence("complete", false, None, &ledger, inst)
    } else {
        loss_evidence(&job.claimed, outage, wal_loss, &ledger, inst)
    };
    if job.unresolved.contains(&logical_code.to_uppercase()) {
        loss.push("the broker's history could not fill every gap".into());
    }
    // What the code was before: its stored partition's (a refold), or the session's claim (Market Runtime's evidence).
    let stored_as = if job.from_store { stored_completeness(job, logical_code) } else { Some(job.claimed.clone()) };
    let completeness = if !loss.is_empty() {
        "gap_detected"
    } else if filled || (!job.from_store && job.repaired_codes.contains(&logical_code.to_uppercase())) {
        "repaired"
    } else if proven && stored_as.as_deref() != Some("complete") {
        // Its prints are whole but the partition lost input (a restart, a dropped event): the book of that span is
        // gone for good.
        "repaired"
    } else {
        match stored_as.as_deref() {
            Some("complete") | None => "complete",
            Some("repaired") => "repaired",
            Some(_) => "gap_detected",
        }
    };

    let key = job.key(logical_code);
    let partition_dir = staging.partition_dir(&key);
    fs::create_dir_all(&partition_dir).map_err(|e| format!("mkdir {}: {e}", partition_dir.display()))?;

    let events_path = partition_dir.join("events.jsonl");
    let mut events_buf = Vec::new();
    for e in &events {
        serde_json::to_writer(&mut events_buf, e).map_err(|e| e.to_string())?;
        events_buf.push(b'\n');
    }
    atomic_write(&events_path, &events_buf).map_err(|e| format!("write events.jsonl: {e}"))?;

    let (source, session) = (job.source.to_lowercase(), job.session.to_uppercase());
    let symbol = events[0].symbol.clone();
    let durable_sequence = events.iter().map(|e| e.durable_sequence).max().unwrap_or(0);
    let state_doc = json!({"schema": STATE_SCHEMA, "fold": "analysis_runtime", "symbol": symbol, "provider": source,
        "trading_date": job.trading_date, "session": session, "durable_sequence": durable_sequence, "state": state});
    atomic_write(&partition_dir.join("state.json"), &serde_json::to_vec_pretty(&state_doc).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write state.json: {e}"))?;

    let generated_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let manifest = json!({
        "schema": "historical-materialization-v2", "fold": "analysis_runtime",
        "source": source, "market": job.market.to_uppercase(), "logical_code": logical_code.to_uppercase(), "symbol": symbol,
        "trading_date": job.trading_date, "session": session, "generated_at_epoch": generated_at,
        "event_count": events.len(), "duplicate_count": ledger.duplicates, "resent_print_count": ledger.resent_prints, "out_of_order_count": ledger.out_of_order,
        "producer_dropped_count": ledger.producer_dropped, "volume_gaps": inst.map_or(0, |i| i.quality.volume_gaps),
        "lane_report": lane_report(&events), "claimed_completeness": job.claimed,
        "rust_detected_gap": detected, "loss_evidence": loss, "completeness": completeness,
        "has_final_state": state.is_some(),
        "first_exchange_ts_ns": events.first().map(|e| e.exchange_ts_ns), "last_exchange_ts_ns": events.last().map(|e| e.exchange_ts_ns),
        "content_hash_fnv1a64": market_runtime::replay::fnv1a64(&events_buf), "events_bytes": events_buf.len(), "outcome": "succeeded_with_data",
    });
    let manifest_path = partition_dir.join("manifest.json");
    atomic_write(&manifest_path, &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write manifest.json: {e}"))?;
    verify_partition(&events_path, &manifest_path, &symbol, events.len())?;
    let store_dir = match job.store.publish(staging, &key)? {
        Published::Stored(dir) => Some(dir),
        Published::Expired => None,
    };
    // The session's daily summary is training context of its own, kept whatever the raw history's retention.
    let summary = daily_summary::summarized(&job.source, &job.market).then(|| daily_summary::code_entry(&job.market, &events, completeness,
        Some(inst.map_or(0, |i| i.quality.volume_gaps))));
    let baseline = crate::baseline_publish::scope(&job.source, &job.market, &job.session)
        .then(|| inst.map(crate::baseline_publish::code_minutes).unwrap_or_default());
    let control_count = events.iter().filter(|e| e.time_quality == COVERAGE_CONTROL || e.time_quality == LOSS_CONTROL).count();
    let backfill_count = events.iter().filter(|e| e.flags.backfill && e.time_quality != COVERAGE_CONTROL && e.time_quality != LOSS_CONTROL).count();
    // The session's K bars, like the summary, are kept whatever the raw history's retention.
    let kbar_day = job.kbars.as_ref().and(inst).map(|i| kbar_store::session_day(i, &Calendar::default()));
    Ok(Outcome { code: logical_code.to_uppercase(), summary, kbar_day, baseline, event_count: events.len(), control_count, backfill_count,
                 completeness, loss, store_dir })
}

/// The session's K bars into each code's file, after its partitions are written. A failure fails the job (retried), so a
/// session is never reported materialized without them.
fn publish_kbars(job: &Job, outcomes: &[&mut Outcome]) -> Result<usize, String> {
    let Some(store) = &job.kbars else { return Ok(0) };
    let days: Vec<(String, kbar_store::SessionDay)> = outcomes.iter().filter_map(|o| Some((o.code.clone(), o.kbar_day.clone()?))).collect();
    let id = kbar_store::SessionId { source: &job.source, market: &job.market, session: &job.session, trading_date: &job.trading_date };
    store.publish(&id, &days)
}

/// The close of a session also ages every K-bar file to the retention in force (a product no longer subscribed has to
/// age too). The session is already whole: a retention that cannot be read is reported in the result, not a failed job.
fn age_kbars(job: &Job) -> Value {
    match job.kbars.as_ref().map(kbar_store::Store::compact_all) {
        None => Value::Null,
        Some(Ok(changed)) => json!({"ok": true, "files_folded": changed}),
        Some(Err(error)) => {
            eprintln!("[materialize] aging the K-bar store: {error}");
            json!({"ok": false, "error": error})
        }
    }
}

/// One code's line in the result: where its partition is, or that retention dropped it.
fn code_result(o: &Outcome) -> Value {
    json!({"code": o.code, "event_count": o.event_count, "market_event_count": o.event_count - o.control_count,
        "control_event_count": o.control_count, "backfill_event_count": o.backfill_count, "completeness": o.completeness, "loss_evidence": o.loss,
        "published": o.store_dir.is_some(), "store_dir": o.store_dir.as_ref().map(|d| d.to_string_lossy().into_owned()),
        "manifest_path": o.manifest_path().map(|p| p.to_string_lossy().into_owned())})
}

/// `--code *`: every instrument of the session found in the WAL.
fn run_wildcard(job: &Job, input: SessionInput, progress: &mut Progress) -> Result<Value, String> {
    if input.by_symbol.is_empty() {
        return Ok(json!({"ok": false, "status": "no_matching_input", "outcome": "no_matching_input", "mode": "wildcard",
            "source": job.source, "market": job.market, "trading_date": job.trading_date, "session": job.session,
            "error": format!("no WAL events for {}:{} {} {}", job.source, job.market, job.trading_date, job.session)}));
    }
    let mut outcomes = Vec::new();
    let mut worst = "complete";
    let mut skipped_invalid_codes: Vec<String> = Vec::new();
    // Counted in events, not codes: codes differ in size by orders of magnitude, events are the work (as in `read`).
    let date = job.trading_date.as_str();
    let events_found: u64 = input.by_symbol.values().map(|events| events.len() as u64).sum();
    let mut written = 0u64;
    let staging = job.stage()?;
    progress.start(date, "write", events_found);
    for (symbol, events) in input.by_symbol {
        progress.tick(date, "write", written, events_found);
        written += events.len() as u64;
        let logical_code = symbol.splitn(3, ':').nth(2).unwrap_or(&symbol).to_owned();
        // A WAL code that is no valid path component is reported, not written (and not fatal for the rest).
        if job.partition(&logical_code).is_err() {
            skipped_invalid_codes.push(symbol);
            worst = "gap_detected";
            continue;
        }
        let outcome = materialize_one(job, &staging, events, &logical_code, input.wal_loss.as_deref())?;
        if outcome.completeness != "complete" {
            worst = "gap_detected";
        }
        outcomes.push(outcome);
    }
    progress.end(date, "write", events_found);
    let codes: Vec<Value> = outcomes.iter().map(code_result).collect();
    let expired = outcomes.iter().filter(|o| o.store_dir.is_none()).count();
    // The whole session's daily summary, after every partition is written and verified. A failure here fails the job
    // (retried), so a session is never reported materialized without its summary.
    let mut summary_path = Value::Null;
    if let (Some(dir), true) = (&job.daily_summary_dir, daily_summary::summarized(&job.source, &job.market)) {
        let entries: Map<String, Value> = outcomes.iter().filter_map(|o| Some((o.code.clone(), o.summary.clone()?))).collect();
        let doc = daily_summary::session_doc(&job.source, &job.market, &job.trading_date, &job.session, entries);
        progress.start(date, "summary", 1);
        summary_path = json!(daily_summary::Publisher::new(dir).publish_materialized(&doc)?.to_string_lossy());
        progress.end(date, "summary", 1);
    }
    // The session's 量變 baseline, from the same fold: a failure fails the job (retried) like the summary's.
    let mut baseline = Value::Null;
    if let (Some(root), true) = (&job.volume_baseline_root, crate::baseline_publish::scope(&job.source, &job.market, &job.session)) {
        let items = outcomes.iter().filter_map(|o| Some((o.code.clone(), o.baseline.clone()?))).collect();
        baseline = crate::baseline_publish::publish(&crate::baseline_publish::dir(root, &job.source), date, items)?;
    }
    let kbar_files = publish_kbars(job, &outcomes.iter_mut().collect::<Vec<_>>())?;
    let kbar_aging = age_kbars(job);
    let sum = |count: fn(&Outcome) -> usize| outcomes.iter().map(count).sum::<usize>();
    Ok(json!({"ok": true, "status": "materialized", "outcome": "succeeded_with_data", "mode": "wildcard", "daily_summary": summary_path,
        "kbar_files": kbar_files, "kbar_aging": kbar_aging, "volume_baseline": baseline, "codes_materialized": codes.len(), "codes_expired": expired, "total_event_count": sum(|o| o.event_count),
        // What the 收盤整理 card counts: the market events (Market Runtime's accepted, plus what a fill added).
        "market_event_count": sum(|o| o.event_count - o.control_count), "control_event_count": sum(|o| o.control_count),
        "backfill_event_count": sum(|o| o.backfill_count),
        "completeness": worst, "codes": codes, "skipped_invalid_codes": skipped_invalid_codes, "wal_integrity": input.wal_integrity}))
}

/// One named code.
fn run_single(job: &Job, mut input: SessionInput, progress: &mut Progress) -> Result<Value, String> {
    let logical_code = job.logical_code.clone().unwrap_or_else(|| job.code.clone());
    let symbol = format!("{}{}", job.symbol_prefix(), job.code.to_uppercase());
    let Some(events) = input.by_symbol.remove(&symbol) else {
        return Ok(json!({"ok": false, "status": "no_matching_input", "outcome": "no_matching_input", "mode": "single",
            "source": job.source, "market": job.market, "code": job.code, "trading_date": job.trading_date, "session": job.session,
            "error": format!("no WAL events for {symbol} {} {}", job.trading_date, job.session)}));
    };
    let events_found = events.len() as u64;
    progress.start(&job.trading_date, "write", events_found);
    let staging = job.stage()?;
    let mut outcome = materialize_one(job, &staging, events, &logical_code, input.wal_loss.as_deref())?;
    progress.end(&job.trading_date, "write", events_found);
    publish_kbars(job, &[&mut outcome])?;
    let mut result = code_result(&outcome);
    let line = result.as_object_mut().expect("a code result is an object");
    line.remove("code");
    for (key, value) in [("ok", json!(true)), ("status", json!("materialized")), ("outcome", json!("succeeded_with_data")),
                         ("mode", json!("single")), ("wal_integrity", input.wal_integrity)] {
        line.insert(key.to_owned(), value);
    }
    Ok(result)
}

/// The job. Ok = one JSON result line (a refusal included); Err = a transient failure the orchestrator retries.
/// `progress` gets the phase lines (see the module documentation).
pub fn run(flags: &Flags, rules: RuleSet, progress: &mut Progress) -> Result<Value, String> {
    let job = match Job::parse(flags, rules) {
        Ok(job) => job,
        Err(refusal) => return Ok(refusal),
    };
    let input = if job.from_store { read_store(&job)? } else { read_session(&job, progress)? };
    if job.wildcard() { run_wildcard(&job, input, progress) } else { run_single(&job, input, progress) }
}
