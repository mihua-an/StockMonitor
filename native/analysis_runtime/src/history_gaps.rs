//! Where a materialized session is missing prints (`analysis_runtime --gap-report`): per code, the windows a fill from
//! the broker's history must cover, each bounded by prints the partition holds (decisions.md 盤中重啟的缺口只補空檔
//! 時段; the fill of a closed session, scripts/fill_history_gaps.py).
//!
//! - a stock: the holes in the cumulative volume its prints cover (accum::TradeChain, the same model Rust B folds):
//!   each from the print at the hole's low end (its exchange time, the volume stored at that instant, the cumulative
//!   volume) to the print at its high end (its time, its cumulative volume less its own). A hole from the session's
//!   start (the App started after the open) starts at the open.
//! - a futures contract: the same over its quotes that carry their own print volume; a hole from the start is not
//!   one (a DAY partition's first quote carries the night before it).
//! - an index: its quotes carry no print volume, so a window is a run of trading minutes without a quote, from the
//!   quote before it to the quote after it.
//!
//! - a code the session should hold (`--expected-codes`) and has no partition of: the whole session, and an index's
//!   昨收 from the previous trading day's close (session_windows).
//!
//! Each window's end is a stored print: the fill takes nothing at that instant (end_is_live, as a live fill does);
//! a whole session's end is past its last minute.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use market_runtime::calendar::{CalKey, Calendar};
use market_runtime::event::{is_session_partitioned, local_minute_ns, partition_local_minute, MarketEvent, Payload};
use market_runtime::historical_store::PartitionKey;
use market_runtime::rollover::TradingCalendar;
use market_runtime::volume as vol;
use serde_json::{json, Value};

use crate::accum::TradeChain;

fn key(total: f64) -> i64 {
    (total * 10_000.0).round() as i64
}

/// A print as the chain reads it: exchange time, its minute, cumulative volume and own volume.
struct Print {
    ts: i64,
    minute: i32,
    total: f64,
    volume: f64,
    filled: bool,
}

fn minute_of(e: &MarketEvent, stated: i32) -> Option<i32> {
    if stated >= 0 {
        return Some(stated);
    }
    partition_local_minute(&e.provider, &e.market, &e.session, e.exchange_ts_ns).map(|(_, m)| m)
}

/// The windows of one code's events (durable order).
pub fn windows(events: &[MarketEvent], cal: &Calendar) -> Vec<Value> {
    let Some(first) = events.first() else { return Vec::new() };
    let market = first.market.to_uppercase();
    let session = first.session.to_uppercase();
    let cal_key = CalKey { source: &first.provider, market: &market,
        session: is_session_partitioned(&first.provider, &market).then_some(session.as_str()), date: Some(&first.trading_date) };
    if market == "IDX" {
        return quiet_runs(events, cal, cal_key);
    }
    let mut prints = Vec::new();
    for e in events {
        let (total, volume, stated) = match &e.payload {
            Payload::Trade { total_volume, volume, minute, simtrade: false, .. } => (*total_volume, *volume, *minute),
            Payload::Quote { total_volume, volume, minute, status, .. } if market == "FUT" && status != "simulated" => (*total_volume, *volume, *minute),
            _ => continue,
        };
        let Some(minute) = minute_of(e, stated) else { continue };
        if vol::positive(total).is_none() || vol::positive(volume).is_none() || !cal.is_trading(cal_key, minute) {
            continue;
        }
        prints.push(Print { ts: e.exchange_ts_ns, minute, total, volume, filled: e.flags.backfill });
    }
    let mut chain = TradeChain::default();
    // Each span end's print: the newest one ending at a total (hi), the oldest one starting at a total (lo).
    let mut ending: HashMap<i64, i64> = HashMap::new();
    let mut starting: HashMap<i64, i64> = HashMap::new();
    let mut at_instant: BTreeMap<i64, f64> = BTreeMap::new();
    for p in &prints {
        chain.cover(p.total, p.volume, p.minute, p.filled);
        let end = ending.entry(key(p.total)).or_insert(p.ts);
        *end = (*end).max(p.ts);
        let start = starting.entry(key(p.total - p.volume)).or_insert(p.ts);
        *start = (*start).min(p.ts);
        *at_instant.entry(p.ts).or_insert(0.0) += p.volume;
    }
    let spans = &chain.spans;
    let mut out = Vec::new();
    for (i, right) in spans.iter().enumerate().skip(1) {
        let left = &spans[i - 1];
        let from_open = i == 1 && vol::positive(left.hi).is_none();
        if from_open && market == "FUT" {
            continue;
        }
        let Some(&end_ns) = starting.get(&key(right.lo)) else { continue };
        let (after_ns, volume_at_after) = if from_open {
            (0, 0.0)
        } else {
            let Some(&ts) = ending.get(&key(left.hi)) else { continue };
            (ts, at_instant.get(&ts).copied().unwrap_or(0.0))
        };
        out.push(json!({"after_ns": after_ns, "volume_at_after": vol::wire(volume_at_after), "total_before": vol::wire(left.hi),
            "end_ns": end_ns, "next_total_before": vol::wire(right.lo), "end_is_live": true,
            "unseen": vol::wire(right.lo - left.hi)}));
    }
    out
}

/// An index: runs of trading minutes with no quote, between its first and last quoted minute.
fn quiet_runs(events: &[MarketEvent], cal: &Calendar, cal_key: CalKey<'_>) -> Vec<Value> {
    let mut quoted: BTreeMap<i32, (i64, i64)> = BTreeMap::new();
    for e in events {
        let Payload::Quote { current, minute, status, .. } = &e.payload else { continue };
        if *current <= 0 || status == "simulated" {
            continue;
        }
        let Some(m) = minute_of(e, *minute) else { continue };
        let slot = quoted.entry(m).or_insert((e.exchange_ts_ns, e.exchange_ts_ns));
        slot.0 = slot.0.min(e.exchange_ts_ns);
        slot.1 = slot.1.max(e.exchange_ts_ns);
    }
    let (Some((&lo, _)), Some((&hi, _))) = (quoted.first_key_value(), quoted.last_key_value()) else { return Vec::new() };
    let mut out = Vec::new();
    let mut run_start: Option<i32> = None;
    for m in lo..=hi {
        let silent = cal.is_trading(cal_key, m) && !quoted.contains_key(&m);
        match (silent, run_start) {
            (true, None) => run_start = Some(m),
            (false, Some(start)) if quoted.contains_key(&m) => {
                let before = quoted.range(..start).next_back().map(|(_, (_, last))| *last);
                if let (Some(after_ns), Some((first, _))) = (before, quoted.get(&m)) {
                    out.push(json!({"after_ns": after_ns, "volume_at_after": 0, "total_before": Value::Null, "end_ns": first,
                        "next_total_before": Value::Null, "end_is_live": true, "silent_minutes": m - start}));
                }
                run_start = None;
            }
            _ => {}
        }
    }
    out
}

/// The windows of a code the session should hold and has no partition of (decisions.md 指數整天沒有分區的日子):
/// - the whole session, from the open (after_ns 0: the provider starts at the partition's open) through the minute
///   after its last trading or print minute, the end not a stored print (end_is_live false: the fill takes everything
///   up to it);
/// - an index's 昨收 (`reference: "prev_close"`, first): its live Reference carries it, the broker's history does not,
///   so the previous trading day's closing print -- from its last trading minute through its last print minute --,
///   stamped at the session's open (`reference_at_ns`).
pub fn session_windows(source: &str, market: &str, trading_date: &str, session: &str, cal: &Calendar) -> Option<Vec<Value>> {
    let (source, market, session) = (source.to_lowercase(), market.to_uppercase(), session.to_uppercase());
    let key = CalKey { source: &source, market: &market, session: is_session_partitioned(&source, &market).then_some(session.as_str()),
                       date: Some(trading_date) };
    let segments: Vec<_> = cal.segments(key).iter().filter(|s| s.known_market).collect();
    let open = segments.iter().flat_map(|s| s.intervals.iter().map(|(a, _)| *a)).min()?;
    let trading_end = segments.iter().flat_map(|s| s.intervals.iter().map(|(_, b)| *b)).max()?;
    let last = segments.iter().flat_map(|s| s.print_instants.iter().copied()).max().unwrap_or(trading_end).max(trading_end);
    let mut out = Vec::new();
    if market == "IDX" {
        let calendar = TradingCalendar::load(None).ok()?;
        let previous = calendar.previous_trading_day(trading_date)?;
        out.push(json!({"after_ns": local_minute_ns(&market, &previous, trading_end)?, "volume_at_after": 0, "total_before": Value::Null,
            "end_ns": local_minute_ns(&market, &previous, last + 1)?, "next_total_before": Value::Null, "end_is_live": false,
            "reference": "prev_close", "reference_date": previous, "reference_at_ns": local_minute_ns(&market, trading_date, open)?}));
    }
    out.push(json!({"after_ns": 0, "volume_at_after": 0, "total_before": Value::Null, "end_ns": local_minute_ns(&market, trading_date, last + 1)?,
        "next_total_before": Value::Null, "end_is_live": false, "whole_session": true}));
    Some(out)
}

/// Every code of one materialized session under `root`: its windows, and the partition's own completeness. Each of
/// `expected` (codes the session should hold) without a partition is listed with no completeness and the whole
/// session as its window; a session with no partition at all is one whose every expected code is missing.
pub fn report(root: &Path, source: &str, market: &str, trading_date: &str, session: &str, expected: &[String]) -> Value {
    let probe = PartitionKey::new(source, market, trading_date, session, "_");
    let session_dir = probe.dir(root).parent().map(Path::to_path_buf).unwrap_or_default();
    let cal = Calendar::default();
    let mut codes = Vec::new();
    let mut problems = Vec::new();
    let mut entries: Vec<_> = match std::fs::read_dir(&session_dir) {
        Ok(entries) => entries.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !market_runtime::historical_store::is_hidden(p)).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(), // not an error: nothing of this session was materialized
        Err(e) => return json!({"ok": false, "error": format!("{}: {e}", session_dir.display())}),
    };
    let held: std::collections::BTreeSet<String> = entries.iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_uppercase())).collect();
    for code in expected.iter().map(|c| c.to_uppercase()).collect::<std::collections::BTreeSet<_>>() {
        if held.contains(&code) {
            continue;
        }
        match session_windows(source, market, trading_date, session, &cal) {
            Some(windows) => codes.push(json!({"code": code, "completeness": Value::Null, "volume_gaps": Value::Null,
                "max_durable_sequence": Value::Null, "partition": false, "windows": windows})),
            None => problems.push(format!("{code}: no trading session for {market} {trading_date} {session}")),
        }
    }
    entries.sort();
    for dir in entries {
        let code = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let manifest: Value = std::fs::read(dir.join("manifest.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        let bytes = match std::fs::read(dir.join("events.jsonl")) {
            Ok(bytes) => bytes,
            Err(e) => {
                problems.push(format!("{code}: {e}"));
                continue;
            }
        };
        let mut events = Vec::new();
        for line in bytes.split(|b| *b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)) {
            match MarketEvent::decode_slice(line) {
                Ok(e) => events.push(e),
                Err(e) => {
                    problems.push(format!("{code}: {}", e.reason()));
                    break;
                }
            }
        }
        events.sort_by_key(|e| e.durable_sequence);
        let windows = windows(&events, &cal);
        codes.push(json!({"code": code, "completeness": manifest["completeness"], "volume_gaps": manifest["volume_gaps"],
            "max_durable_sequence": events.iter().map(|e| e.durable_sequence).max(), "partition": true, "windows": windows}));
    }
    json!({"ok": problems.is_empty(), "source": source, "market": market, "trading_date": trading_date, "session": session,
        "codes": codes, "problems": problems})
}

#[cfg(test)]
mod tests {
    use super::*;
    use market_runtime::event::days_from_civil;

    fn ts(minute: i64, second: i64) -> i64 {
        (days_from_civil(2026, 11, 6) * 86_400 + minute * 60 + second - 8 * 3600) * 1_000_000_000
    }

    fn print(seq: u64, minute: i32, second: i64, volume: f64, total: f64) -> MarketEvent {
        serde_json::from_value(json!({"schema_version": market_runtime::event::EVENT_SCHEMA_VERSION, "durable_sequence": seq,
            "symbol": "shioaji:STK:2330", "provider": "shioaji", "market": "STK", "code": "2330", "session": "DAY",
            "trading_date": "2026-11-06", "generation": 1, "sequence": seq, "exchange_ts_ns": ts(minute as i64, second), "time_quality": "exchange",
            "payload": {"kind": "trade", "price": 1_000_000, "volume": volume, "total_volume": total, "side": 1, "trade_id": "t",
                        "minute": minute, "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0}})).unwrap()
    }

    #[test]
    fn a_stocks_windows_are_its_cumulative_volume_holes_bounded_by_the_prints_around_them() {
        let events = vec![print(1, 541, 0, 20.0, 50.0), print(2, 600, 0, 3.0, 53.0), print(3, 600, 0, 2.0, 55.0),
                          print(4, 605, 9, 5.0, 85.0), print(5, 606, 0, 1.0, 86.0)];
        let w = windows(&events, &Calendar::default());
        assert_eq!(w.len(), 2, "{w:?}");
        assert_eq!((w[0]["after_ns"].as_i64(), w[0]["end_ns"].as_i64(), w[0]["unseen"].as_f64()), (Some(0), Some(ts(541, 0)), Some(30.0)),
                   "from the open: 30 lots before the first print seen");
        assert_eq!((w[1]["after_ns"].as_i64(), w[1]["volume_at_after"].as_f64(), w[1]["total_before"].as_f64()),
                   (Some(ts(600, 0)), Some(5.0), Some(55.0)), "both 10:00:00 prints are held at the start instant");
        assert_eq!((w[1]["end_ns"].as_i64(), w[1]["next_total_before"].as_f64()), (Some(ts(605, 9)), Some(80.0)));
    }

    fn index_event(seq: u64, minute: i32, second: i64, payload: Value, backfill: bool) -> MarketEvent {
        serde_json::from_value(json!({"schema_version": market_runtime::event::EVENT_SCHEMA_VERSION, "durable_sequence": seq,
            "symbol": "shioaji:IDX:TAIEX", "provider": "shioaji", "market": "IDX", "code": "TAIEX", "session": "DAY",
            "trading_date": "2026-11-06", "generation": 1, "sequence": seq, "exchange_ts_ns": ts(minute as i64, second), "time_quality": "exchange",
            "flags": if backfill { json!({"backfill": true, "backfill_cutoff_ns": ts(605, 0)}) } else { json!({}) },
            "payload": payload})).unwrap()
    }

    fn index_quote(minute: i32) -> Value {
        json!({"kind": "quote", "current": 230_000_000, "open": 0, "high": 0, "low": 0, "total_volume": 0.0, "total_amount": 0.0,
               "status": "live", "minute": minute, "average": 0, "volume": 0.0, "amount": 0.0})
    }

    /// An index's restart gap filled live (restart_backfill.py) is quotes, every minute of it quoted: no window is
    /// left to fill after the close. The minute bars the fill sent before were not quotes, and left the gap open.
    #[test]
    fn an_index_gap_filled_with_backfill_quotes_leaves_no_window() {
        let mut events = vec![index_event(1, 600, 0, index_quote(600), false), index_event(2, 605, 0, index_quote(605), false)];
        let open = windows(&events, &Calendar::default());
        assert_eq!(open.len(), 1, "10:01-10:04 unquoted: {open:?}");
        let mut bars = events.clone();
        for (n, minute) in (601..605).enumerate() {
            bars.push(index_event(10 + n as u64, minute, 59, json!({"kind": "minute_bar", "minute": minute, "open": 230_000_000,
                "high": 230_000_000, "low": 230_000_000, "close": 230_000_000, "average": 0, "volume": 0.0, "amount": 0.0}), true));
        }
        assert_eq!(windows(&bars, &Calendar::default()).len(), 1, "a minute bar is no quote");
        for (n, minute) in (601..605).enumerate() {
            events.push(index_event(10 + n as u64, minute, 5, index_quote(minute), true));
        }
        assert!(windows(&events, &Calendar::default()).is_empty());
    }
}
