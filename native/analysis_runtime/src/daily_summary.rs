//! The daily summary: training data kept after the raw history is pruned (user 10-22).
//!
//! One file per materialized Shioaji session, `<summary dir>/source=../market=../trading_date=../session=...json`.
//! It lives under the user's storage location (config/var_layout.json "storage" daily_summary) and is removed only by
//! the training data retention (config/training_data_settings.py). A stock session's summary has a verdict file beside
//! it (`session=DAY.verdict.json`, its `tick_complete` alone).
//!
//! The summaries have one publisher, `Publisher`: every write of a summary or a verdict file goes through it, under
//! one OS file lock on `<summary dir>/.publisher.lock`, whichever process runs it. The rest only make candidates:
//! - the close-of-day materialization (materialize.rs, `--daily-summary-dir`) makes the session's summary from the
//!   very events it stores, every code the session held; it creates the session's summary and always replaces it;
//! - `--summarize-history` (`summarize_history`) rebuilds summaries from the partitions already in the historical
//!   store (the same function over the same events), for a format or formula the build changed. The store does not
//!   keep every code of a session (past its retention only the codes an account traded; while a materialization
//!   runs, only the codes it has published so far), so a rebuild replaces a session's summary only when the store
//!   holds exactly the codes that summary holds, and never creates one. A sealed session's events do not change, so
//!   partitions of the same codes are the events the summary was made from;
//! - B's daemon at its start gives a stock summary written before verdict files existed its verdict
//!   (`Publisher::write_missing_verdicts`).
//!
//! A summary is the closing state of the FeatureStore folded over the session's events (features.rs `KeyState::stock_day`
//! / `index_day`): one fold for today's columns and for the history they compare against.
//!
//! Per stock (STK), the session's regular prints (no simtrade, no 盤後定價, no print that sets no last sale): open / high /
//! low / close, volume and amount, the call-auction part of them, prev_close and the limit prices, and per clock minute of
//! continuous trading (call auctions excluded) `[volume, amount, close, high, low, large_buy, large_sell, open]` -- what
//! the day features compare against (5 / 22 / 88-day averages, the same time of day on earlier days), what each stock's
//! behaviour columns are measured on (day_context.rs). large_buy / large_sell
//! are the outer / inner volume of single prints of at least 50 lots; open is the minute's first continuous print by
//! exchange time. Per index (IDX), open / high / low / close, prev_close and per minute the cumulative amount at its last
//! quote (the market's turnover at that time of day).

use std::collections::BTreeSet;
use std::fs::File;
use std::path::{Path, PathBuf};

use market_runtime::event::MarketEvent;
use market_runtime::fsutil::atomic_write;
use market_runtime::historical_store::PartitionKey;
use serde_json::{json, Map, Value};

use crate::features::{FeatureStore, KeyId, KeyState};

pub const SUMMARY_SCHEMA: &str = "daily-summary-v3";
pub const VERDICT_SCHEMA: &str = "daily-summary-verdict-v1";
/// The publisher's lock: whoever holds it is the only one writing summaries or verdict files.
pub const LOCK_FILE: &str = ".publisher.lock";
/// The summary path of one session.
pub fn summary_path(dir: &Path, source: &str, market: &str, trading_date: &str, session: &str) -> PathBuf {
    dir.join(format!("source={}", source.to_lowercase())).join(format!("market={}", market.to_uppercase()))
        .join(format!("trading_date={trading_date}")).join(format!("session={}.json", session.to_uppercase()))
}

/// Whether a market's sessions get a summary.
pub fn summarized(source: &str, market: &str) -> bool {
    source.eq_ignore_ascii_case("shioaji") && (market.eq_ignore_ascii_case("STK") || market.eq_ignore_ascii_case("IDX"))
}

/// One code's entry from its events (durable order, as materialized): the closing state of the one fold over them, its
/// partition's completeness and the volume gaps its fold found (prints the exchange's cumulative total proves were never
/// delivered; None = not known).
pub fn code_entry(market: &str, events: &[MarketEvent], completeness: &str, volume_gaps: Option<u64>) -> Value {
    let mut store = FeatureStore::default();
    for event in events {
        store.fold(event);
    }
    let empty = KeyState::default();
    let state = events.iter().find_map(KeyId::of).and_then(|key| store.closing_state(&key).cloned()).unwrap_or(empty);
    let mut entry = if market.eq_ignore_ascii_case("IDX") { state.index_day() } else { state.stock_day() };
    entry["completeness"] = json!(completeness);
    entry["volume_gaps"] = json!(volume_gaps);
    entry
}

/// The summary document of one session from its codes' entries. A stock (STK) session also carries the day's
/// `tick_complete` (資料中心's 完整, user 10-28): every stock's ticks reconcile with the exchange's cumulative volume
/// (no volume gap, the opening print checked against zero) and every stock's partition is `complete` -- a `repaired`
/// one had its prints filled from the broker's history but its book (BidAsk) of the gap is lost for good (user
/// 11-06). Only such a day is trained on; any other is test data only (service/analysis/online_training/job.py).
pub fn session_doc(source: &str, market: &str, trading_date: &str, session: &str, codes: Map<String, Value>) -> Value {
    let mut doc = json!({"schema": SUMMARY_SCHEMA, "source": source.to_lowercase(), "market": market.to_uppercase(),
                         "trading_date": trading_date, "session": session.to_uppercase()});
    if market.eq_ignore_ascii_case("STK") {
        doc["tick_complete"] = json!(!codes.is_empty()
            && codes.values().all(|c| c["volume_gaps"].as_u64() == Some(0) && c["completeness"] == "complete"));
    }
    doc["codes"] = Value::Object(codes);
    doc
}

#[cfg(test)]
fn summarize<'a>(source: &str, market: &str, trading_date: &str, session: &str,
                 codes: impl IntoIterator<Item = (String, &'a [MarketEvent], &'a str, Option<u64>)>) -> Value {
    let codes = codes.into_iter()
        .map(|(code, events, completeness, gaps)| (code.to_uppercase(), code_entry(market, events, completeness, gaps))).collect();
    session_doc(source, market, trading_date, session, codes)
}

/// A stock session's verdict file next to its summary, `session=...verdict.json`: the day's `tick_complete` alone, so
/// a reader that only needs whether the day is 完整 (the training window, the data center's 完整 column) reads a few
/// bytes instead of every stock's minutes (service/platform/model_storage_layout.py day_tick_complete).
pub fn verdict_path(summary_path: &Path) -> PathBuf {
    summary_path.with_extension("verdict.json")
}

fn verdict_doc(summary: &Value) -> Option<Value> {
    let verdict = summary.get("tick_complete")?.as_bool()?;
    Some(json!({"schema": VERDICT_SCHEMA, "trading_date": summary["trading_date"], "session": summary["session"],
                "tick_complete": verdict}))
}

fn write_verdict(path: &Path, summary: &Value) -> Result<(), String> {
    let Some(doc) = verdict_doc(summary) else { return Ok(()) };
    let verdict = verdict_path(path);
    atomic_write(&verdict, &serde_json::to_vec(&doc).map_err(|e| e.to_string())?).map_err(|e| format!("write {}: {e}", verdict.display()))
}

fn path_of(dir: &Path, summary: &Value) -> PathBuf {
    let text = |name: &str| summary[name].as_str().unwrap_or_default().to_string();
    summary_path(dir, &text("source"), &text("market"), &text("trading_date"), &text("session"))
}

/// The summary, then (a stock session) its verdict file, so the two never disagree. Only the publisher, under its
/// lock, calls it.
fn write(dir: &Path, summary: &Value) -> Result<PathBuf, String> {
    let path = path_of(dir, summary);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    atomic_write(&path, &serde_json::to_vec(summary).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    write_verdict(&path, summary)?;
    Ok(path)
}

fn code_set(summary: &Value) -> BTreeSet<String> {
    summary["codes"].as_object().map(|codes| codes.keys().cloned().collect()).unwrap_or_default()
}

/// At most the first ten of `codes`, then how many more.
fn listed(codes: &BTreeSet<String>) -> String {
    let shown: Vec<&str> = codes.iter().take(10).map(String::as_str).collect();
    match codes.len().saturating_sub(shown.len()) {
        0 => shown.join(", "),
        more => format!("{} and {more} more", shown.join(", ")),
    }
}

/// The daily summaries' one publisher (see the module documentation).
pub struct Publisher {
    dir: PathBuf,
}

/// The publisher's lock, held until dropped.
struct PublisherLock(#[allow(dead_code)] File);

impl Publisher {
    pub fn new(dir: &Path) -> Self {
        Self { dir: dir.to_path_buf() }
    }

    /// Takes the lock, waiting while another process holds it.
    fn lock(&self) -> Result<PublisherLock, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("mkdir {}: {e}", self.dir.display()))?;
        let path = self.dir.join(LOCK_FILE);
        let file = File::options().create(true).truncate(false).write(true).open(&path)
            .map_err(|e| format!("daily summary lock {}: {e}", path.display()))?;
        file.lock().map_err(|e| format!("daily summary lock {}: {e}", path.display()))?;
        Ok(PublisherLock(file))
    }

    /// A session's materialization: its summary, of every code the session held, is the session's summary.
    pub fn publish_materialized(&self, summary: &Value) -> Result<PathBuf, String> {
        let _lock = self.lock()?;
        write(&self.dir, summary)
    }

    /// A rebuild from the historical store: replaces the session's summary only when the store held exactly its codes.
    /// Err says why it did not (nothing changed).
    pub fn publish_rebuilt(&self, summary: &Value) -> Result<PathBuf, String> {
        let _lock = self.lock()?;
        let path = path_of(&self.dir, summary);
        let current: Value = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("{}: not JSON ({e}); only the session's materialization can replace it", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!("{}: the session has no summary; a session's summary is created by its materialization", path.display()));
            }
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let (held, rebuilt) = (code_set(&current), code_set(summary));
        let missing: BTreeSet<String> = held.difference(&rebuilt).cloned().collect();
        let unknown: BTreeSet<String> = rebuilt.difference(&held).cloned().collect();
        if !missing.is_empty() || !unknown.is_empty() {
            let mut why = Vec::new();
            if !missing.is_empty() {
                why.push(format!("the store has no partition of {} of its {} codes ({})", missing.len(), held.len(), listed(&missing)));
            }
            if !unknown.is_empty() {
                why.push(format!("the store has {} codes it does not hold ({})", unknown.len(), listed(&unknown)));
            }
            return Err(format!("{}: {}; only the session's materialization can replace it", path.display(), why.join("; ")));
        }
        write(&self.dir, summary)
    }

    /// Every stock session summary without its verdict file gets one (a summary written before the file existed).
    /// Returns how many were written.
    pub fn write_missing_verdicts(&self) -> usize {
        let _lock = match self.lock() {
            Ok(lock) => lock,
            Err(e) => {
                eprintln!("[analysis_runtime] daily summary verdicts: {e}");
                return 0;
            }
        };
        write_missing_verdicts(&self.dir)
    }
}

fn write_missing_verdicts(dir: &Path) -> usize {
    let mut written = 0;
    let Ok(sources) = std::fs::read_dir(dir) else { return 0 };
    for source in sources.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("source=")) {
        let Ok(dates) = std::fs::read_dir(source.path().join("market=STK")) else { continue };
        for date in dates.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("trading_date=")) {
            let Ok(files) = std::fs::read_dir(date.path()) else { continue };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                if !name.starts_with("session=") || !name.ends_with(".json") || name.ends_with(".verdict.json")
                    || verdict_path(&file.path()).exists() {
                    continue;
                }
                let summary = match std::fs::read(file.path()).map_err(|e| e.to_string())
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())) {
                    Ok(summary) => summary,
                    Err(e) => {
                        eprintln!("[analysis_runtime] daily summary verdict: reading {}: {e}", file.path().display());
                        continue;
                    }
                };
                match write_verdict(&file.path(), &summary) {
                    Ok(()) if verdict_doc(&summary).is_some() => written += 1,
                    Ok(()) => {}
                    Err(e) => eprintln!("[analysis_runtime] daily summary verdict: {e}"),
                }
            }
        }
    }
    written
}

/// One committed partition's entry, only from a partition that is still the content its manifest describes
/// (verify.rs): Err says why not.
fn partition_entry(market: &str, dir: &Path) -> Result<Value, String> {
    let verdict = crate::verify::partition(dir);
    match verdict["problem"].as_str() {
        Some("") => {}
        problem => return Err(problem.unwrap_or("the partition has no verdict").to_string()),
    }
    let manifest: Value = std::fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())
        .and_then(|raw| serde_json::from_slice(&raw).map_err(|e| e.to_string()))?;
    let text = std::fs::read_to_string(dir.join("events.jsonl")).map_err(|e| e.to_string())?;
    let events = text.lines().filter(|l| !l.trim().is_empty())
        .map(|l| MarketEvent::decode_slice(l.as_bytes()).map_err(|e| e.to_string())).collect::<Result<Vec<_>, _>>()?;
    Ok(code_entry(market, &events, manifest["completeness"].as_str().unwrap_or("unknown"), manifest["volume_gaps"].as_u64()))
}

/// `--summarize-history`: the summaries of sessions already in the historical store, rebuilt from their committed
/// partitions (events.jsonl as materialized) and handed to the publisher, which replaces a session's summary only
/// with one of the same codes. A session with any partition that fails verification is a problem and is not
/// published: an entry made from what could be read would replace a good summary.
pub fn summarize_history(historical_root: &Path, out_dir: &Path, source: &str, dates: &[String]) -> Value {
    let publisher = Publisher::new(out_dir);
    let mut written = Vec::new();
    let mut problems = Vec::new();
    for date in dates {
        for market in ["STK", "IDX"] {
            let day = PartitionKey::new(source, market, date, "", "").date_dir(historical_root);
            let Ok(sessions) = std::fs::read_dir(&day) else { continue };
            for session in sessions.flatten() {
                let name = session.file_name().to_string_lossy().into_owned();
                let Some(session_name) = name.strip_prefix("session=").map(str::to_owned) else { continue };
                let mut codes = Map::new();
                let Ok(dirs) = std::fs::read_dir(session.path()) else {
                    problems.push(json!({"session": day.join(&name).to_string_lossy(), "error": "cannot be listed"}));
                    continue;
                };
                let mut damaged = false;
                for dir in dirs.flatten().filter(|d| !market_runtime::historical_store::is_hidden(&d.path())) {
                    match partition_entry(market, &dir.path()) {
                        Ok(entry) => {
                            codes.insert(dir.file_name().to_string_lossy().to_uppercase(), entry);
                        }
                        Err(error) => {
                            damaged = true;
                            problems.push(json!({"partition": dir.path().to_string_lossy(), "error": error}));
                        }
                    }
                }
                if damaged || codes.is_empty() {
                    continue;
                }
                let summary = session_doc(source, market, date, &session_name, codes);
                match publisher.publish_rebuilt(&summary) {
                    Ok(path) => written.push(json!(path.to_string_lossy())),
                    Err(error) => problems.push(json!({"session": day.join(&name).to_string_lossy(), "error": error})),
                }
            }
        }
    }
    json!({"ok": problems.is_empty(), "written": written, "problems": problems})
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRICE_SCALE: f64 = 10_000.0;

    fn event(seq: u64, code: &str, market: &str, payload: Value) -> MarketEvent {
        serde_json::from_value(json!({
            "schema_version": 2, "durable_sequence": seq, "symbol": format!("shioaji:{market}:{code}"), "provider": "shioaji",
            "market": market, "code": code, "session": "DAY", "trading_date": "2026-10-27",
            "generation": 1, "sequence": seq, "exchange_ts_ns": seq as i64, "payload": payload
        })).unwrap()
    }

    fn trade(price: i64, volume: f64, minute: i32, extra: Value) -> Value {
        let mut t = json!({"kind": "trade", "price": price, "volume": volume, "total_volume": 0.0, "side": 1, "trade_id": "",
                           "minute": minute, "open": 0, "high": 0, "low": 0, "average": 0,
                           "total_amount": 0.0, "amount": price as f64 / PRICE_SCALE * volume * 1000.0});
        for (k, v) in extra.as_object().unwrap() {
            t[k] = v.clone();
        }
        t
    }

    #[test]
    fn a_stock_day_excludes_after_hours_and_simtrade_and_splits_the_auction() {
        let events = vec![
            event(1, "2330", "STK", json!({"kind": "reference", "limit_up": 1_100_000, "limit_down": 900_000, "prev_close": 1_000_000})),
            event(2, "2330", "STK", trade(1_000_000, 5.0, 540, json!({"auction": true}))),
            event(3, "2330", "STK", trade(1_010_000, 2.0, 540, json!({}))),
            event(4, "2330", "STK", trade(990_000, 1.0, 541, json!({}))),
            event(5, "2330", "STK", trade(1_050_000, 9.0, 541, json!({"simtrade": true}))),
            event(6, "2330", "STK", trade(1_000_000, 4.0, 810, json!({"auction": true}))),
            event(7, "2330", "STK", trade(1_000_000, 3.0, 870, json!({"after_hours": true}))),
        ];
        let s = summarize("shioaji", "STK", "2026-10-27", "DAY", [("2330".to_string(), events.as_slice(), "complete", Some(0))]);
        let day = &s["codes"]["2330"];
        assert_eq!((day["open"].as_f64(), day["high"].as_f64(), day["low"].as_f64(), day["close"].as_f64()),
                   (Some(100.0), Some(101.0), Some(99.0), Some(100.0)));
        assert_eq!(day["volume"], json!(12.0), "after-hours and simtrade are not the day's volume");
        assert_eq!(day["auction_volume"], json!(9.0));
        assert_eq!(day["minutes"]["540"][0], json!(2.0), "the opening auction is not continuous trading");
        assert_eq!(day["minutes"]["541"], json!([1.0, 99.0 * 1000.0, 99.0, 99.0, 99.0, 0.0, 0.0, 99.0]), "simtrade is no minute's print");
        assert_eq!(day["minutes"].as_object().unwrap().len(), 2);
        assert_eq!((day["limit_up"].as_f64(), day["prev_close"].as_f64()), (Some(110.0), Some(100.0)));
        assert_eq!(s["tick_complete"], json!(true));
    }

    /// The same rule as today's columns: otherwise a day's history would count volume today's figures never see.
    #[test]
    fn a_print_that_sets_no_last_sale_is_no_part_of_the_day() {
        let events = vec![
            event(1, "2330", "STK", trade(1_000_000, 2.0, 545, json!({}))),
            event(2, "2330", "STK", trade(1_500_000, 80.0, 545, json!({"no_last_sale": true, "condition": "AVERAGE_PRICE"}))),
            event(3, "2330", "STK", trade(500_000, 1.0, 546, json!({"no_last_sale": true}))),
        ];
        let s = summarize("shioaji", "STK", "2026-10-27", "DAY", [("2330".to_string(), events.as_slice(), "complete", Some(0))]);
        let day = &s["codes"]["2330"];
        assert_eq!((day["high"].as_f64(), day["low"].as_f64(), day["close"].as_f64()), (Some(100.0), Some(100.0), Some(100.0)));
        assert_eq!(day["volume"], json!(2.0));
        assert_eq!(day["minutes"]["545"][0], json!(2.0));
        assert!(day["minutes"].get("546").is_none(), "a minute of nothing else is no minute");
    }

    #[test]
    fn a_minute_keeps_its_bar_and_the_large_prints_by_side() {
        let side = |s: i64| json!({"side": s});
        let events = vec![
            event(1, "2330", "STK", trade(1_000_000, 60.0, 545, side(1))),
            event(2, "2330", "STK", trade(1_020_000, 49.0, 545, side(1))),
            event(3, "2330", "STK", trade(990_000, 50.0, 545, side(-1))),
            event(4, "2330", "STK", trade(1_010_000, 70.0, 545, side(0))),
        ];
        let s = summarize("shioaji", "STK", "2026-10-27", "DAY", [("2330".to_string(), events.as_slice(), "complete", Some(0))]);
        let minute = &s["codes"]["2330"]["minutes"]["545"];
        assert_eq!(minute[0], json!(229.0));
        assert_eq!((minute[2].as_f64(), minute[3].as_f64(), minute[4].as_f64()), (Some(101.0), Some(102.0), Some(99.0)), "close, high, low");
        assert_eq!((minute[5].as_f64(), minute[6].as_f64()), (Some(60.0), Some(50.0)), "49 lots is not large; a print of no side is neither");
        assert_eq!((minute[7].as_f64(), minute.as_array().unwrap().len()), (Some(100.0), 8), "the eighth value is the minute's first print");
    }

    /// A summary entry is the FeatureStore's closing state and nothing else.
    #[test]
    fn a_code_entry_is_the_closing_state_of_the_live_fold() {
        let events = vec![
            event(1, "2330", "STK", json!({"kind": "reference", "limit_up": 1_100_000, "limit_down": 900_000, "prev_close": 1_000_000})),
            event(2, "2330", "STK", trade(1_000_000, 5.0, 540, json!({"auction": true}))),
            event(3, "2330", "STK", trade(1_010_000, 60.0, 540, json!({}))),
            event(4, "2330", "STK", trade(990_000, 1.0, 541, json!({}))),
        ];
        let mut live = FeatureStore::default();
        for e in &events {
            live.fold(e);
        }
        let mut closing = live.closing_state(&KeyId::of(&events[0]).unwrap()).unwrap().stock_day();
        closing["completeness"] = json!("complete");
        closing["volume_gaps"] = json!(0);
        assert_eq!(code_entry("STK", &events, "complete", Some(0)), closing);
    }

    /// A reconnect (a higher generation) and the 13:40 reference keep the day, a gap's fill (generation 0) enters it by
    /// its exchange time.
    #[test]
    fn a_session_with_a_reconnect_a_fill_and_a_late_reference_is_summarized_whole() {
        let with = |mut e: MarketEvent, generation: u64, ts: i64| { e.generation = generation; e.exchange_ts_ns = ts; e };
        let events = vec![
            with(event(1, "2330", "STK", trade(1_000_000, 10.0, 540, json!({}))), 1, 540),
            with(event(2, "2330", "STK", trade(1_010_000, 20.0, 700, json!({}))), 2, 700),
            with(event(3, "2330", "STK", json!({"kind": "reference", "limit_up": 1_100_000, "limit_down": 900_000, "prev_close": 1_000_000})), 3, 820),
            with(event(4, "2330", "STK", trade(950_000, 5.0, 600, json!({"amount": 0.0}))), 0, 600),
        ];
        let s = summarize("shioaji", "STK", "2026-10-27", "DAY", [("2330".to_string(), events.as_slice(), "repaired", Some(0))]);
        let day = &s["codes"]["2330"];
        assert_eq!(day["volume"], json!(35.0), "{day}");
        assert_eq!([&day["open"], &day["high"], &day["low"], &day["close"]].map(|v| v.as_f64()), [Some(100.0), Some(101.0), Some(95.0), Some(101.0)],
                   "the fill's print is neither the day's last nor its first: {day}");
        assert_eq!(day["minutes"].as_object().unwrap().len(), 3, "{day}");
        assert_eq!(day["prev_close"].as_f64(), Some(100.0));
    }

    #[test]
    fn a_stock_day_is_tick_complete_only_when_every_stock_reconciles() {
        let events = vec![event(1, "2330", "STK", trade(1_000_000, 1.0, 545, json!({})))];
        let day = |gaps: [Option<u64>; 2]| summarize("shioaji", "STK", "2026-10-27", "DAY", [
            ("2330".to_string(), events.as_slice(), "complete", gaps[0]),
            ("2317".to_string(), events.as_slice(), "complete", gaps[1]),
        ])["tick_complete"].clone();
        assert_eq!(day([Some(0), Some(0)]), json!(true));
        assert_eq!(day([Some(0), Some(1)]), json!(false), "one stock with a volume gap makes the day incomplete");
        assert_eq!(day([Some(0), None]), json!(false), "a stock whose gaps are not known is not proven complete");
        assert_eq!(summarize("shioaji", "STK", "2026-10-27", "DAY", [])["tick_complete"], json!(false));
        let repaired = summarize("shioaji", "STK", "2026-10-27", "DAY", [
            ("2330".to_string(), events.as_slice(), "complete", Some(0)),
            ("2317".to_string(), events.as_slice(), "repaired", Some(0)),
        ])["tick_complete"].clone();
        assert_eq!(repaired, json!(false), "prints filled from the broker's history, but the gap's BidAsk is lost: not complete");
    }

    #[test]
    fn an_index_day_keeps_the_cumulative_amount_per_minute() {
        let quote = |seq: u64, current: i64, minute: i32, amount: f64| event(seq, "TAIEX", "IDX", json!({
            "kind": "quote", "current": current, "open": if amount > 0.0 { 1_010_000 } else { 0 },
            "high": if amount > 0.0 { current } else { 0 }, "low": if amount > 0.0 { 1_010_000 } else { 0 }, "total_volume": 0.0,
            "total_amount": amount, "status": "live", "minute": minute, "average": 0, "volume": 0.0, "amount": 0.0}));
        let reference = event(4, "TAIEX", "IDX", json!({"kind": "reference", "prev_close": 1_000_000}));
        let events = vec![quote(1, 1_000_000, 540, 0.0), quote(2, 1_010_000, 540, 5.0), reference, quote(3, 1_020_000, 541, 9.0)];
        let s = summarize("shioaji", "IDX", "2026-10-27", "DAY", [("TAIEX".to_string(), events.as_slice(), "complete", Some(0))]);
        assert!(s.get("tick_complete").is_none(), "only a stock session has the day's tick verdict");
        assert_eq!(s["codes"]["TAIEX"]["minutes"], json!({"540": 5.0, "541": 9.0}));
        assert_eq!(s["codes"]["TAIEX"]["close"].as_f64(), Some(102.0));
        assert_eq!(s["codes"]["TAIEX"]["open"].as_f64(), Some(101.0), "not the pre-open repeat of the previous close");
        assert_eq!(s["codes"]["TAIEX"]["prev_close"].as_f64(), Some(100.0), "the index's 昨收 is its Reference event's");
        let dir = std::env::temp_dir().join(format!("ar-summary-{}", std::process::id()));
        let path = Publisher::new(&dir).publish_materialized(&s).unwrap();
        assert!(path.ends_with("source=shioaji/market=IDX/trading_date=2026-10-27/session=DAY.json"));
        assert!(!verdict_path(&path).exists(), "an index session has no verdict");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn index_quote(seq: u64, minute: i32, current: i64, ohl: [i64; 3], amount: f64, backfill: bool) -> MarketEvent {
        let mut e = event(seq, "TAIEX", "IDX", json!({"kind": "quote", "current": current, "open": ohl[0], "high": ohl[1], "low": ohl[2],
            "total_volume": 0.0, "total_amount": amount, "status": "live", "minute": minute, "average": 0, "volume": 0.0, "amount": 0.0}));
        e.exchange_ts_ns = i64::from(minute) * 60_000_000_000 + seq as i64;
        e.flags.backfill = backfill;
        e
    }

    /// A whole day filled from the broker's history (decisions.md 指數整天沒有分區的日子): each quote carries the
    /// running open / high / low, the last one the day's; its 昨收 from the fill's Reference; no amount, so no minutes.
    #[test]
    fn an_index_day_filled_from_history_takes_its_prices_from_the_backfill_quotes() {
        let mut reference = event(1, "TAIEX", "IDX", json!({"kind": "reference", "prev_close": 1_000_000}));
        reference.flags.backfill = true;
        let events = vec![reference, index_quote(2, 540, 1_010_000, [1_010_000, 1_010_000, 1_010_000], 0.0, true),
                          index_quote(3, 540, 1_030_000, [1_010_000, 1_030_000, 1_010_000], 0.0, true),
                          index_quote(4, 541, 995_000, [1_010_000, 1_030_000, 990_000], 0.0, true)];
        let s = summarize("shioaji", "IDX", "2026-10-20", "DAY", [("TAIEX".to_string(), events.as_slice(), "repaired", Some(0))]);
        let day = &s["codes"]["TAIEX"];
        assert_eq!([&day["open"], &day["high"], &day["low"], &day["close"], &day["prev_close"]].map(|v| v.as_f64()),
                   [Some(101.0), Some(103.0), Some(99.0), Some(99.5), Some(100.0)], "{day}");
        assert_eq!(day["minutes"], json!({}), "the broker's history has no index amount");
    }

    /// A restart's gap filled with quotes stating no open / high / low, stored after the live quotes around it: the
    /// day's figures stay the exchange's own, the close the newest by exchange time.
    #[test]
    fn an_index_gap_filled_during_the_session_keeps_the_exchanges_figures() {
        let ohl = [1_010_000, 1_030_000, 990_000];
        let events = vec![index_quote(1, 600, 1_000_000, ohl, 5.0e9, false), index_quote(2, 610, 1_020_000, ohl, 6.0e9, false),
                          index_quote(3, 605, 1_040_000, [0, 0, 0], 0.0, true)];
        let s = summarize("shioaji", "IDX", "2026-11-06", "DAY", [("TAIEX".to_string(), events.as_slice(), "repaired", Some(0))]);
        let day = &s["codes"]["TAIEX"];
        assert_eq!([&day["open"], &day["high"], &day["low"], &day["close"]].map(|v| v.as_f64()),
                   [Some(101.0), Some(103.0), Some(99.0), Some(102.0)], "{day}");
        assert_eq!(day["minutes"], json!({"600": 5.0e9, "610": 6.0e9}));
    }

    #[test]
    fn a_stock_summary_is_written_with_its_verdict_file() {
        let dir = std::env::temp_dir().join(format!("ar-summary-verdict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let events = vec![event(1, "2330", "STK", trade(1_000_000, 1.0, 545, json!({})))];
        let s = summarize("shioaji", "STK", "2026-10-27", "DAY", [("2330".to_string(), events.as_slice(), "complete", Some(1))]);
        let publisher = Publisher::new(&dir);
        let path = publisher.publish_materialized(&s).unwrap();
        let verdict: Value = serde_json::from_slice(&std::fs::read(verdict_path(&path)).unwrap()).unwrap();
        assert!(verdict_path(&path).ends_with("trading_date=2026-10-27/session=DAY.verdict.json"));
        assert_eq!(verdict, json!({"schema": VERDICT_SCHEMA, "trading_date": "2026-10-27", "session": "DAY", "tick_complete": false}));
        let s = summarize("shioaji", "STK", "2026-10-27", "DAY", [("2330".to_string(), events.as_slice(), "complete", Some(0))]);
        publisher.publish_materialized(&s).unwrap();
        let verdict: Value = serde_json::from_slice(&std::fs::read(verdict_path(&path)).unwrap()).unwrap();
        assert_eq!(verdict["tick_complete"], json!(true), "a summary written again rewrites its verdict");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_stock_summaries_without_a_verdict_get_one() {
        let dir = std::env::temp_dir().join(format!("ar-summary-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let events = vec![event(1, "2330", "STK", trade(1_000_000, 1.0, 545, json!({})))];
        let s = summarize("shioaji", "STK", "2026-10-27", "DAY", [("2330".to_string(), events.as_slice(), "complete", Some(0))]);
        let publisher = Publisher::new(&dir);
        let path = publisher.publish_materialized(&s).unwrap();
        std::fs::remove_file(verdict_path(&path)).unwrap();
        assert_eq!(publisher.write_missing_verdicts(), 1);
        let verdict: Value = serde_json::from_slice(&std::fs::read(verdict_path(&path)).unwrap()).unwrap();
        assert_eq!(verdict["tick_complete"], json!(true));
        assert_eq!(publisher.write_missing_verdicts(), 0, "a summary with its verdict is not read again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rebuild_replaces_only_a_summary_of_the_same_codes() {
        let dir = std::env::temp_dir().join(format!("ar-summary-rebuild-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let publisher = Publisher::new(&dir);
        let events = vec![event(1, "2330", "STK", trade(1_000_000, 1.0, 545, json!({})))];
        let day = |codes: &[&str], gaps: u64| summarize("shioaji", "STK", "2026-10-27", "DAY",
            codes.iter().map(|c| (c.to_string(), events.as_slice(), "complete", Some(gaps))).collect::<Vec<_>>());
        let error = publisher.publish_rebuilt(&day(&["2330"], 0)).unwrap_err();
        assert!(error.contains("created by its materialization"), "{error}");
        let path = publisher.publish_materialized(&day(&["2330", "2317"], 1)).unwrap();
        let held = std::fs::read(&path).unwrap();
        let error = publisher.publish_rebuilt(&day(&["2330"], 0)).unwrap_err();
        assert!(error.contains("1 of its 2 codes (2317)"), "{error}");
        let error = publisher.publish_rebuilt(&day(&["2330", "2317", "2454"], 0)).unwrap_err();
        assert!(error.contains("does not hold (2454)"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), held, "a refused rebuild changes nothing");
        let verdict: Value = serde_json::from_slice(&std::fs::read(verdict_path(&path)).unwrap()).unwrap();
        assert_eq!(verdict["tick_complete"], json!(false), "nor the verdict");
        publisher.publish_rebuilt(&day(&["2317", "2330"], 0)).unwrap();
        let verdict: Value = serde_json::from_slice(&std::fs::read(verdict_path(&path)).unwrap()).unwrap();
        assert_eq!(verdict["tick_complete"], json!(true), "a rebuild of the same codes replaces the summary and its verdict");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_publish_waits_for_the_lock() {
        let dir = std::env::temp_dir().join(format!("ar-summary-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let publisher = Publisher::new(&dir);
        let events = vec![event(1, "2330", "STK", trade(1_000_000, 1.0, 545, json!({})))];
        let s = summarize("shioaji", "STK", "2026-10-27", "DAY", [("2330".to_string(), events.as_slice(), "complete", Some(0))]);
        let held = publisher.lock().unwrap();
        let (writer_dir, doc) = (dir.clone(), s.clone());
        let started = std::time::Instant::now();
        let writer = std::thread::spawn(move || Publisher::new(&writer_dir).publish_materialized(&doc).map(|_| started.elapsed()));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!summary_path(&dir, "shioaji", "STK", "2026-10-27", "DAY").exists(), "nothing is written while another holds the lock");
        drop(held);
        let waited = writer.join().unwrap().unwrap();
        assert!(waited >= std::time::Duration::from_millis(250), "the publish waited for the lock ({waited:?})");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
