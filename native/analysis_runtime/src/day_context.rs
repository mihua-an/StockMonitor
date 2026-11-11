//! What online-v3's day features know besides the day itself: the previous sessions' daily summaries
//! (daily_summary.rs), each stock's industry index and its industry group (the category column).
//!
//! The same loader serves the live fold and the training export (dataset.rs), so a feature sees the same history in
//! both. A trading date's context is the summaries of the sessions BEFORE it (never its own), newest first, at most
//! MAX_SESSIONS; a column needing more sessions than there are is NaN, never computed from fewer. The 1-session
//! columns (the previous day's return, the same-time comparisons) need the newest summary to be the previous trading
//! day of the built-in TWSE calendar: an unrecorded day is missing, never stood in for by an older one.
//!
//! The industry index of a stock is its market (上市 tse / 上櫃 otc) and industry_code in the Shioaji security master,
//! looked up in config/tw_industry_indexes.json; its industry group is that market and industry_code itself
//! (`tse:24`), whether or not the industry has an index.
//!
//! A stock's behaviour (個股性格, user 10-29) is measured on its earlier sessions only, once per trading date: the
//! BEHAVIOUR_COLUMNS over the newest BEHAVIOUR_SESSIONS sessions, NaN with fewer than BEHAVIOUR_MIN_SESSIONS of
//! them; the gap-up fade over the newest GAP_SESSIONS, NaN with fewer than GAP_MIN_DAYS gap-up days. Each session's
//! minutes are reduced to a few sums as it is read (DayBehaviour), so the context never holds 22 sessions of minutes.
//! A summary of another schema is a problem of the date, never read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use market_runtime::rollover::TradingCalendar;
use serde_json::{json, Value};

use crate::daily_summary::SUMMARY_SCHEMA;

/// The most sessions any column reads (88-day averages).
pub const MAX_SESSIONS: usize = 88;
/// Sessions whose per-minute figures are kept (the 5-day same-time comparison).
const MINUTE_SESSIONS: usize = 5;
/// The behaviour window and the sessions it needs.
pub const BEHAVIOUR_SESSIONS: usize = 22;
pub const BEHAVIOUR_MIN_SESSIONS: usize = 10;
/// The gap-up fade's window and the gap-up days it needs; a gap-up opens at least GAP_UP above prev_close.
const GAP_SESSIONS: usize = 60;
const GAP_MIN_DAYS: usize = 5;
const GAP_UP: f64 = 0.01;
/// Continuous trading: 09:00 (540) to the last minute before the 13:25 closing book (804).
const FIRST_MINUTE: i32 = 540;
const LAST_MINUTE: i32 = 804;
const SESSION_MINUTES: f64 = (LAST_MINUTE - FIRST_MINUTE + 1) as f64;
/// A burst minute traded at least this many times the day's average minute volume.
const BURST: f64 = 3.0;
/// How far after a burst or a large net buying minute its return is measured.
const AFTER_MINUTES: i32 = 5;
/// The tail return runs from the price at 12:55 (the close of 12:54) to 13:25; the morning return from the open to
/// 09:30 (the close of 09:29).
const TAIL_FROM: i32 = 774;
const MORNING_TO: i32 = 569;

/// The behaviour columns, in spec order (features.rs NUMERIC_COLUMNS ends with them).
pub const BEHAVIOUR_COLUMNS: [&str; 11] = [
    "stock_log_amount_22d", "stock_ret_std_22d", "stock_no_trade_ratio_22d", "stock_limit_up_days_22d",
    "stock_gap_up_fade_60d", "stock_up_burst_ret_5m_22d", "stock_down_burst_ret_5m_22d", "stock_tail_ret_22d",
    "stock_morning_ret_22d", "stock_ret_5m_autocorr_22d", "stock_large_buy_ret_5m_22d",
];

/// A sum and its count; the mean is missing with nothing counted.
#[derive(Debug, Clone, Copy, Default)]
pub struct Mean {
    sum: f64,
    n: f64,
}

impl Mean {
    fn add(&mut self, value: Option<f64>) {
        if let Some(v) = value.filter(|v| v.is_finite()) {
            self.sum += v;
            self.n += 1.0;
        }
    }

    fn merge(&mut self, other: Mean) {
        self.sum += other.sum;
        self.n += other.n;
    }

    fn mean(self) -> f64 {
        if self.n > 0.0 { self.sum / self.n } else { f64::NAN }
    }
}

/// Sums of (x, y) pairs for their correlation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Pairs {
    n: f64,
    x: f64,
    y: f64,
    xx: f64,
    yy: f64,
    xy: f64,
}

impl Pairs {
    fn add(&mut self, x: f64, y: f64) {
        if x.is_finite() && y.is_finite() {
            self.n += 1.0;
            self.x += x;
            self.y += y;
            self.xx += x * x;
            self.yy += y * y;
            self.xy += x * y;
        }
    }

    fn merge(&mut self, o: Pairs) {
        self.n += o.n;
        self.x += o.x;
        self.y += o.y;
        self.xx += o.xx;
        self.yy += o.yy;
        self.xy += o.xy;
    }

    fn correlation(self) -> f64 {
        if self.n < 3.0 {
            return f64::NAN;
        }
        let cov = self.xy - self.x * self.y / self.n;
        let (vx, vy) = (self.xx - self.x * self.x / self.n, self.yy - self.y * self.y / self.n);
        if vx > 0.0 && vy > 0.0 { cov / (vx * vy).sqrt() } else { f64::NAN }
    }
}

/// One session's minutes reduced to what the behaviour columns read.
#[derive(Debug, Clone, Default)]
pub struct DayBehaviour {
    /// Minutes of continuous trading with a print.
    pub traded_minutes: f64,
    /// The return AFTER_MINUTES after each up / down burst minute, and after each large net buying minute.
    pub up_burst: Mean,
    pub down_burst: Mean,
    pub large_buy: Mean,
    pub tail: Option<f64>,
    pub morning: Option<f64>,
    /// Adjacent 5-minute returns.
    pub adjacent: Pairs,
}

/// One summary minute (daily_summary.rs: [volume, amount, close, high, low, large_buy, large_sell, open]).
struct SummaryMinute {
    minute: i32,
    volume: f64,
    close: f64,
    large_buy: f64,
    large_sell: f64,
}

impl DayBehaviour {
    /// From a stock's continuous minutes (ascending), its open and its day's continuous volume.
    fn of(minutes: &[SummaryMinute], open: Option<f64>, volume: Option<f64>) -> Self {
        // The price at the end of `minute`: the last traded close at or before it.
        let close_at = |minute: i32| -> Option<f64> {
            let at = minutes.partition_point(|m| m.minute <= minute);
            (at > 0).then(|| minutes[at - 1].close)
        };
        let ret = |to: Option<f64>, from: Option<f64>| match (to, from) {
            (Some(t), Some(f)) if f > 0.0 => Some(t / f - 1.0),
            _ => None,
        };
        let mut day = DayBehaviour::default();
        let average = volume.map(|v| v / SESSION_MINUTES).filter(|a| *a > 0.0);
        for m in minutes.iter().filter(|m| (FIRST_MINUTE..=LAST_MINUTE).contains(&m.minute)) {
            day.traded_minutes += 1.0;
            let after = if m.minute + AFTER_MINUTES <= LAST_MINUTE { ret(close_at(m.minute + AFTER_MINUTES), Some(m.close)) } else { None };
            if average.is_some_and(|a| m.volume >= BURST * a) {
                // Up or down against the price before it: the previous traded minute's close, else the open.
                match close_at(m.minute - 1).or(open).map(|before| m.close.total_cmp(&before)) {
                    Some(std::cmp::Ordering::Greater) => day.up_burst.add(after),
                    Some(std::cmp::Ordering::Less) => day.down_burst.add(after),
                    _ => {}
                }
            }
            if m.large_buy > m.large_sell {
                day.large_buy.add(after);
            }
        }
        day.tail = ret(close_at(LAST_MINUTE), close_at(TAIL_FROM));
        day.morning = ret(close_at(MORNING_TO), open);
        // 5-minute returns 09:00-09:04, 09:05-09:09, ... (the first from the open); each next to the one before.
        let mut previous: Option<f64> = None;
        let mut from = open;
        for end in (FIRST_MINUTE + 4..=LAST_MINUTE).step_by(5) {
            let close = close_at(end);
            let r = ret(close, from).unwrap_or(f64::NAN);
            if let Some(p) = previous {
                day.adjacent.add(p, r);
            }
            previous = Some(r);
            from = close;
        }
        day
    }
}

/// One earlier session of one code.
#[derive(Debug, Clone, Default)]
pub struct PastDay {
    pub date: String,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub close: Option<f64>,
    pub prev_close: Option<f64>,
    /// Continuous trading (call auctions excluded) volume / amount; an index has neither.
    pub volume: Option<f64>,
    pub amount: Option<f64>,
    /// Per clock minute, ascending: a stock's cumulative continuous volume, an index's cumulative amount.
    pub cumulative: Vec<(i32, f64)>,
    pub open: Option<f64>,
    pub limit_up: Option<f64>,
    /// A stock's minutes reduced, for the newest BEHAVIOUR_SESSIONS sessions.
    pub behaviour: Option<DayBehaviour>,
}

impl PastDay {
    /// The cumulative figure through `minute`: a stock's volume is 0 before its first traded minute; an index has
    /// none before its first quote.
    pub fn cumulative_at(&self, minute: i32, zero_before: bool) -> Option<f64> {
        let at = self.cumulative.partition_point(|(m, _)| *m <= minute);
        if at == 0 {
            return (zero_before && !self.cumulative.is_empty()).then_some(0.0);
        }
        Some(self.cumulative[at - 1].1)
    }
}

/// A code's earlier sessions, newest first, and whether the newest is the previous trading day.
#[derive(Debug, Clone)]
pub struct History {
    pub days: Vec<PastDay>,
    pub previous_is_last_session: bool,
    /// The BEHAVIOUR_COLUMNS of a stock (all NaN for an index).
    pub behaviour: [f64; BEHAVIOUR_COLUMNS.len()],
}

impl Default for History {
    fn default() -> Self {
        Self { days: Vec::new(), previous_is_last_session: false, behaviour: [f64::NAN; BEHAVIOUR_COLUMNS.len()] }
    }
}

fn sample_std(values: &[f64]) -> f64 {
    let n = values.len() as f64;
    if n < 3.0 {
        return f64::NAN;
    }
    let mean = values.iter().sum::<f64>() / n;
    (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
}

/// The behaviour columns from a stock's earlier sessions, newest first.
fn behaviour(days: &[PastDay]) -> [f64; BEHAVIOUR_COLUMNS.len()] {
    let mut out = [f64::NAN; BEHAVIOUR_COLUMNS.len()];
    // Each gap-up day: did it close below its open.
    let gap: Vec<bool> = days.iter().take(GAP_SESSIONS).filter_map(|d| {
        let (open, prev_close, close) = (d.open?, d.prev_close?, d.close?);
        (prev_close > 0.0 && open >= prev_close * (1.0 + GAP_UP)).then_some(close < open)
    }).collect();
    if gap.len() >= GAP_MIN_DAYS {
        out[4] = gap.iter().filter(|faded| **faded).count() as f64 / gap.len() as f64;
    }
    let window = &days[..days.len().min(BEHAVIOUR_SESSIONS)];
    if window.len() < BEHAVIOUR_MIN_SESSIONS {
        return out;
    }
    let returns: Vec<f64> = window.iter().filter_map(|d| Some(d.close? / d.prev_close.filter(|p| *p > 0.0)? - 1.0)).collect();
    let (mut amount, mut no_trade, mut up, mut down, mut tail, mut morning, mut large) = Default::default();
    let mut adjacent = Pairs::default();
    let mut limit_up_days = 0.0;
    for day in window {
        Mean::add(&mut amount, day.amount);
        if let (Some(high), Some(limit)) = (day.high, day.limit_up) {
            if high >= limit {
                limit_up_days += 1.0;
            }
        }
        let Some(b) = &day.behaviour else { continue };
        Mean::add(&mut no_trade, Some(1.0 - b.traded_minutes / SESSION_MINUTES));
        Mean::merge(&mut up, b.up_burst);
        Mean::merge(&mut down, b.down_burst);
        Mean::merge(&mut large, b.large_buy);
        Mean::add(&mut tail, b.tail);
        Mean::add(&mut morning, b.morning);
        adjacent.merge(b.adjacent);
    }
    out[0] = amount.mean().ln_1p();
    out[1] = sample_std(&returns);
    out[2] = no_trade.mean();
    out[3] = limit_up_days;
    out[5] = up.mean();
    out[6] = down.mean();
    out[7] = tail.mean();
    out[8] = morning.mean();
    out[9] = adjacent.correlation();
    out[10] = large.mean();
    out
}

impl History {
    /// The previous session, only when it is the previous trading day.
    pub fn previous(&self) -> Option<&PastDay> {
        self.days.first().filter(|_| self.previous_is_last_session)
    }

    /// Mean of `value` over the newest `n` sessions; None with fewer sessions or any of them without the value.
    pub fn mean(&self, n: usize, value: impl Fn(&PastDay) -> Option<f64>) -> Option<f64> {
        if self.days.len() < n {
            return None;
        }
        let mut total = 0.0;
        for day in &self.days[..n] {
            total += value(day)?;
        }
        Some(total / n as f64)
    }
}

/// One trading date's context.
#[derive(Debug, Default)]
pub struct DayContext {
    pub stocks: HashMap<String, History>,
    pub indexes: HashMap<String, History>,
    pub industry: Arc<HashMap<String, String>>,
    pub industry_group: Arc<HashMap<String, String>>,
    /// Summary files that could not be read (reported by the export and the daemon's metrics).
    pub problems: Vec<String>,
}

impl DayContext {
    pub fn stock(&self, code: &str) -> Option<&History> {
        self.stocks.get(code)
    }

    pub fn index(&self, code: &str) -> Option<&History> {
        self.indexes.get(code)
    }
}

/// Where contexts come from. `Default` = nothing: every day column is NaN.
#[derive(Debug, Default, Clone)]
pub struct ContextSource {
    pub summary_dir: Option<PathBuf>,
    /// stock code -> its industry index code; stock code -> its industry group (`tse:24`).
    pub industry: Arc<HashMap<String, String>>,
    pub industry_group: Arc<HashMap<String, String>>,
}

fn f(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}

impl ContextSource {
    /// `industry_indexes` (config/tw_industry_indexes.json) and `security_master` (the Shioaji one) come together or
    /// not at all. A table that cannot be read (a fresh install has no security master until the catalog step built
    /// one) is reported on stderr and leaves every industry column NaN; it never stops the process.
    pub fn new(summary_dir: Option<PathBuf>, industry_indexes: Option<&Path>, security_master: Option<&Path>) -> Result<Self, String> {
        let (industry, industry_group) = match (industry_indexes, security_master) {
            (None, None) => (HashMap::new(), HashMap::new()),
            (Some(indexes), Some(master)) => industry_map(indexes, master).unwrap_or_else(|error| {
                eprintln!("[analysis_runtime] industry indexes unavailable ({error}): every industry column is missing");
                (HashMap::new(), HashMap::new())
            }),
            _ => return Err("--industry-indexes and --security-master are given together".into()),
        };
        Ok(Self { summary_dir, industry: Arc::new(industry), industry_group: Arc::new(industry_group) })
    }

    /// The summaries of the sessions before `trading_date`, newest first: (date, path).
    fn sessions(&self, source: &str, market: &str, trading_date: &str) -> Vec<(String, PathBuf)> {
        let Some(dir) = &self.summary_dir else { return Vec::new() };
        let root = dir.join(format!("source={source}")).join(format!("market={market}"));
        let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
        let mut found: Vec<(String, PathBuf)> = entries.flatten().filter_map(|e| {
            let date = e.file_name().to_string_lossy().strip_prefix("trading_date=")?.to_string();
            let path = e.path().join("session=DAY.json");
            (date.as_str() < trading_date && path.is_file()).then_some((date, path))
        }).collect();
        found.sort_by(|a, b| b.0.cmp(&a.0));
        found.truncate(MAX_SESSIONS);
        found
    }

    /// What a trading date's context is made of: each summary file it reads (name and size) and the industry map.
    /// A training shard is computed again when this changes.
    pub fn fingerprint(&self, source: &str, trading_date: &str) -> Value {
        let files: Vec<Value> = ["STK", "IDX"].iter().flat_map(|market| self.sessions(source, market, trading_date).into_iter()
            .map(move |(date, path)| json!([market, date, std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)]))).collect();
        let mut industry: Vec<(&String, &String)> = self.industry.iter().collect();
        industry.sort();
        let mut groups: Vec<(&String, &String)> = self.industry_group.iter().collect();
        groups.sort();
        json!({"summaries": files, "industry_sha256": market_runtime::sha256::hex(json!([industry, groups]).to_string().as_bytes())})
    }

    pub fn load(&self, source: &str, trading_date: &str) -> DayContext {
        let calendar = TradingCalendar::load(None).expect("the built-in holidays file validates");
        let previous = calendar.previous_trading_day(trading_date);
        let mut context = DayContext { industry: self.industry.clone(), industry_group: self.industry_group.clone(), ..DayContext::default() };
        for market in ["STK", "IDX"] {
            let mut histories: HashMap<String, History> = HashMap::new();
            for (index, (date, path)) in self.sessions(source, market, trading_date).into_iter().enumerate() {
                let doc: Value = match std::fs::read_to_string(&path).map_err(|e| e.to_string())
                    .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
                    Ok(doc) => doc,
                    Err(error) => {
                        context.problems.push(format!("{}: {error}", path.display()));
                        continue;
                    }
                };
                if doc["schema"].as_str() != Some(SUMMARY_SCHEMA) {
                    context.problems.push(format!("{}: schema {} is not {SUMMARY_SCHEMA}; rebuild it with --summarize-history",
                                                  path.display(), doc["schema"]));
                    continue;
                }
                let Some(codes) = doc["codes"].as_object() else {
                    context.problems.push(format!("{}: no codes", path.display()));
                    continue;
                };
                for (code, day) in codes {
                    // A day with a known hole holds part of its prints; `repaired` has them all (only its book is
                    // lost, which no day column reads). Left out, the day counts as missing for this stock: the
                    // previous-session columns go NaN instead of reading an older day.
                    if matches!(day["completeness"].as_str(), Some("gap_detected" | "unknown")) {
                        continue;
                    }
                    let history = histories.entry(code.clone()).or_default();
                    if history.days.is_empty() {
                        history.previous_is_last_session = previous.as_deref() == Some(date.as_str());
                    }
                    let continuous = |total: &str, auction: &str| Some(f(&day[total])? - f(&day[auction]).unwrap_or(0.0));
                    let mut cumulative = Vec::new();
                    let behaviour = (market == "STK" && index < BEHAVIOUR_SESSIONS).then(|| {
                        let mut minutes: Vec<SummaryMinute> = day["minutes"].as_object().into_iter().flatten().filter_map(|(m, v)| {
                            Some(SummaryMinute { minute: m.parse().ok()?, volume: f(&v[0])?, close: f(&v[2])?,
                                                 large_buy: f(&v[5]).unwrap_or(0.0), large_sell: f(&v[6]).unwrap_or(0.0) })
                        }).collect();
                        minutes.sort_by_key(|m| m.minute);
                        DayBehaviour::of(&minutes, f(&day["open"]), continuous("volume", "auction_volume"))
                    });
                    if index < MINUTE_SESSIONS {
                        let mut minutes: Vec<(i32, f64)> = day["minutes"].as_object().into_iter().flatten().filter_map(|(m, v)| {
                            let value = if market == "IDX" { f(v)? } else { f(&v[0])? };
                            Some((m.parse().ok()?, value))
                        }).collect();
                        minutes.sort_by_key(|(m, _)| *m);
                        let mut total = 0.0;
                        for (m, v) in minutes {
                            if market == "IDX" {
                                cumulative.push((m, v));
                            } else {
                                total += v;
                                cumulative.push((m, total));
                            }
                        }
                    }
                    history.days.push(PastDay {
                        date: date.clone(), high: f(&day["high"]), low: f(&day["low"]), close: f(&day["close"]),
                        prev_close: f(&day["prev_close"]),
                        volume: if market == "IDX" { None } else { continuous("volume", "auction_volume") },
                        amount: if market == "IDX" { None } else { continuous("amount", "auction_amount") },
                        cumulative, open: f(&day["open"]), limit_up: f(&day["limit_up"]), behaviour,
                    });
                }
            }
            if market == "STK" {
                for history in histories.values_mut() {
                    history.behaviour = behaviour(&history.days);
                }
            }
            if market == "STK" { context.stocks = histories } else { context.indexes = histories }
        }
        context
    }
}

/// stock code -> industry index code, and stock code -> industry group (`<market>:<industry_code>`).
type IndustryMaps = (HashMap<String, String>, HashMap<String, String>);

fn industry_map(indexes: &Path, master: &Path) -> Result<IndustryMaps, String> {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(indexes).map_err(|e| format!("{}: {e}", indexes.display()))?)
        .map_err(|e| format!("{}: {e}", indexes.display()))?;
    let mut by_industry: HashMap<(String, String), String> = HashMap::new();
    for industry in doc["industries"].as_array().ok_or(format!("{}: no industries", indexes.display()))? {
        let code = industry["code"].as_str().unwrap_or_default().to_string();
        for market in ["tse", "otc"] {
            if let Some(index) = industry[market]["index"].as_str() {
                by_industry.insert((market.to_string(), code.clone()), index.to_string());
            }
        }
    }
    let text = std::fs::read_to_string(master).map_err(|e| format!("{}: {e}", master.display()))?;
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    let header: Vec<&str> = lines.next().unwrap_or_default().split(',').collect();
    let column = |name: &str| header.iter().position(|h| h.trim() == name).ok_or(format!("{}: no {name} column", master.display()));
    let (code_at, market_at, industry_at) = (column("code")?, column("market")?, column("industry_code")?);
    let (mut map, mut groups) = (HashMap::new(), HashMap::new());
    for line in lines {
        let cells: Vec<&str> = line.split(',').collect();
        let cell = |at: usize| cells.get(at).map(|c| c.trim()).unwrap_or_default();
        let (code, market, industry) = (cell(code_at).to_uppercase(), cell(market_at).to_lowercase(), cell(industry_at).to_string());
        if code.is_empty() {
            continue;
        }
        if let Some(index) = by_industry.get(&(market.clone(), industry.clone())) {
            map.insert(code.clone(), index.clone());
        }
        if !market.is_empty() && !industry.is_empty() {
            groups.insert(code, format!("{market}:{industry}"));
        }
    }
    Ok((map, groups))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, market: &str, date: &str, codes: Value) {
        let path = dir.join("source=shioaji").join(format!("market={market}")).join(format!("trading_date={date}"));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("session=DAY.json"), json!({"schema": SUMMARY_SCHEMA, "codes": codes}).to_string()).unwrap();
    }

    #[test]
    fn a_date_reads_only_the_sessions_before_it_and_needs_the_previous_trading_day() {
        let dir = std::env::temp_dir().join(format!("ar-day-context-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let day = |close: f64| json!({"2330": {"close": close, "high": close + 1.0, "low": close - 1.0, "prev_close": close - 0.5,
            "volume": 100.0, "auction_volume": 10.0, "amount": 1000.0, "auction_amount": 100.0, "minutes": {"540": [5.0, 50.0], "541": [7.0, 70.0]}}});
        write(&dir, "STK", "2026-10-20", day(10.0));
        write(&dir, "STK", "2026-10-21", day(11.0));
        write(&dir, "STK", "2026-10-22", day(12.0));
        write(&dir, "IDX", "2026-10-21", json!({"TAIEX": {"close": 100.0, "minutes": {"540": 9.0, "545": 20.0}}}));
        let source = ContextSource { summary_dir: Some(dir.clone()), ..ContextSource::default() };
        let context = source.load("shioaji", "2026-10-22");
        let history = context.stock("2330").unwrap();
        assert_eq!(history.days.iter().map(|d| d.date.as_str()).collect::<Vec<_>>(), ["2026-10-21", "2026-10-20"], "never its own day");
        assert!(history.previous_is_last_session);
        assert_eq!(history.days[0].volume, Some(90.0), "continuous trading only");
        assert_eq!(history.days[0].cumulative_at(541, true), Some(12.0));
        assert_eq!(history.days[0].cumulative_at(539, true), Some(0.0));
        assert_eq!(history.mean(2, |d| d.close), Some(10.5));
        assert_eq!(history.mean(3, |d| d.close), None, "fewer sessions than asked: missing");
        assert_eq!(context.index("TAIEX").unwrap().days[0].cumulative_at(544, false), Some(9.0));
        // 10-23 and 10-26 are market holidays: 10-22 is 10-27's previous trading day. An unrecorded day is missing.
        assert!(source.load("shioaji", "2026-10-27").stock("2330").unwrap().previous().is_some());
        assert!(source.load("shioaji", "2026-10-28").stock("2330").unwrap().previous().is_none(), "10-27 was not recorded");
        // A summary of another schema is not read: it is a problem of the date.
        let old = dir.join("source=shioaji/market=STK/trading_date=2026-10-22/session=DAY.json");
        std::fs::write(&old, json!({"schema": "daily-summary-v1", "codes": {"2330": {"close": 1.0}}}).to_string()).unwrap();
        let context = source.load("shioaji", "2026-10-27");
        assert_eq!(context.stock("2330").unwrap().days.len(), 2);
        assert!(context.problems[0].contains("--summarize-history"), "{:?}", context.problems);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_day_with_a_known_hole_is_left_out_and_a_repaired_day_is_kept() {
        let dir = std::env::temp_dir().join(format!("ar-day-completeness-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let day = |completeness: &str| json!({"close": 10.0, "volume": 100.0, "completeness": completeness, "minutes": {"540": [5.0, 50.0]}});
        write(&dir, "STK", "2026-10-20", json!({"2330": day("repaired"), "2317": day("repaired"), "1101": day("complete")}));
        write(&dir, "STK", "2026-10-21", json!({"2330": day("unknown"), "2317": day("complete"), "1101": day("complete")}));
        write(&dir, "STK", "2026-10-22", json!({"2330": day("gap_detected"), "2317": day("repaired"), "1101": day("complete")}));
        let source = ContextSource { summary_dir: Some(dir.clone()), ..ContextSource::default() };
        let context = source.load("shioaji", "2026-10-27");
        let dates = |code: &str| context.stock(code).unwrap().days.iter().map(|d| d.date.clone()).collect::<Vec<_>>();
        assert_eq!(dates("2330"), ["2026-10-20"], "only the day whose prints are all there");
        assert!(context.stock("2330").unwrap().previous().is_none(), "the previous session is missing, never an older one in its place");
        assert_eq!(dates("2317"), ["2026-10-22", "2026-10-21", "2026-10-20"], "repaired has every print");
        assert!(context.stock("2317").unwrap().previous().is_some());
        assert_eq!(dates("1101").len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A summary minute [volume, amount, close, high, low, large_buy, large_sell].
    fn minute(volume: f64, close: f64, large_buy: f64, large_sell: f64) -> Value {
        json!([volume, volume * close, close, close, close, large_buy, large_sell])
    }

    #[test]
    fn behaviour_needs_ten_sessions_and_reads_only_earlier_ones() {
        let dir = std::env::temp_dir().join(format!("ar-behaviour-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let calendar = TradingCalendar::load(None).unwrap();
        let mut dates = Vec::new();
        let mut date = "2026-10-29".to_string();
        for _ in 0..12 {
            date = calendar.previous_trading_day(&date).unwrap();
            dates.push(date.clone());
        }
        // Every session: open 100 over prev_close 98 (a gap-up that held: close 105), traded at 09:00, a burst up at
        // 09:10 (100 lots, average 1325 / 265 = 5) to 101 and 103 by 09:15, large net buying at 10:00 (102, 104 five
        // minutes later), 104 at 12:54 and 105 at 13:24.
        let day = json!({"2330": {"open": 100.0, "close": 105.0, "high": 110.0, "low": 99.0, "prev_close": 98.0,
            "limit_up": 107.8, "volume": 1325.0, "auction_volume": 0.0, "amount": 1000.0, "auction_amount": 0.0,
            "minutes": {"540": minute(5.0, 100.0, 0.0, 0.0), "550": minute(100.0, 101.0, 0.0, 0.0),
                        "555": minute(5.0, 103.0, 0.0, 0.0), "600": minute(5.0, 102.0, 60.0, 0.0),
                        "605": minute(5.0, 104.0, 0.0, 0.0), "774": minute(5.0, 104.0, 0.0, 0.0),
                        "804": minute(5.0, 105.0, 0.0, 0.0)}}});
        for d in &dates[..9] {
            write(&dir, "STK", d, day.clone());
        }
        let source = ContextSource { summary_dir: Some(dir.clone()), ..ContextSource::default() };
        let b = source.load("shioaji", "2026-10-29").stock("2330").unwrap().behaviour;
        assert!(b.iter().enumerate().all(|(i, v)| if i == 4 { *v == 0.0 } else { v.is_nan() }),
                "9 sessions: only the gap-up fade (9 gap-up days, none faded): {b:?}");
        for d in &dates[9..] {
            write(&dir, "STK", d, day.clone());
        }
        let b = source.load("shioaji", "2026-10-29").stock("2330").unwrap().behaviour;
        let col = |name: &str| b[BEHAVIOUR_COLUMNS.iter().position(|c| *c == name).unwrap()];
        let close = |a: f64, b: f64| (a - b).abs() < 1e-12;
        assert!(close(col("stock_log_amount_22d"), 1001f64.ln()));
        assert!(close(col("stock_ret_std_22d"), 0.0), "every day returned the same");
        assert!(close(col("stock_no_trade_ratio_22d"), 1.0 - 7.0 / 265.0));
        assert_eq!(col("stock_limit_up_days_22d"), 12.0, "high 110 reached the 107.8 limit every day");
        assert!(close(col("stock_up_burst_ret_5m_22d"), 103.0 / 101.0 - 1.0));
        assert!(col("stock_down_burst_ret_5m_22d").is_nan(), "no burst down");
        assert!(close(col("stock_large_buy_ret_5m_22d"), 104.0 / 102.0 - 1.0));
        assert!(close(col("stock_tail_ret_22d"), 105.0 / 104.0 - 1.0));
        assert!(close(col("stock_morning_ret_22d"), 103.0 / 100.0 - 1.0), "09:30's price is 09:15's, carried");
        assert!(col("stock_ret_5m_autocorr_22d").is_finite());
        // The trading date's own session never enters.
        write(&dir, "STK", "2026-10-29", json!({"2330": {"close": 1.0, "prev_close": 1000.0}}));
        assert!(close(source.load("shioaji", "2026-10-29").stock("2330").unwrap().behaviour[1], 0.0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_industry_group_is_market_and_code_with_or_without_an_index() {
        let dir = std::env::temp_dir().join(format!("ar-industry-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let indexes = dir.join("indexes.json");
        std::fs::write(&indexes, json!({"industries": [{"code": "24", "tse": {"index": "IX0010"}}]}).to_string()).unwrap();
        let master = dir.join("master.csv");
        std::fs::write(&master, "\u{feff}code,name,market,type,industry_code\n2330,a,tse,stk,24\n6488,b,otc,stk,24\n1101,c,tse,stk,01\n").unwrap();
        let source = ContextSource::new(None, Some(&indexes), Some(&master)).unwrap();
        assert_eq!(source.industry.get("2330").map(String::as_str), Some("IX0010"));
        assert!(source.industry.get("6488").is_none(), "otc 24 has no index here");
        assert_eq!(source.industry_group.get("6488").map(String::as_str), Some("otc:24"));
        assert_eq!(source.industry_group.get("1101").map(String::as_str), Some("tse:01"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
