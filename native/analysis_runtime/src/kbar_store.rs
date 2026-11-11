//! The K-bar store: 技術分析's history, one JSON file per product (`<kbars>/source=../market=../<CODE>.json`).
//!
//! A date holds its intraday bars at ONE timeframe. It is written at 1 minute by the close-of-day materialization, from
//! the same fold as the day's live bars (call auctions included), and as it ages it is folded in place to the next
//! coarser timeframe of the chain in config/system_contract.json (`kbar_retention_months`: 1 -> 5 -> 15 -> 30 -> 60); past
//! the last one its intraday bars are gone. The aging runs in the close-of-day materialization, over every file. Every timeframe is a multiple of the one before, so a fold loses nothing a
//! coarser bar can show. 3 minutes is no tier: it is not a multiple of 5, so it is read from the 1-minute rows and lasts
//! as long as they do. The readers make the other timeframes from what a date holds (features/realtime/technical_series.js).
//!
//! The daily bar is kept apart from the intraday bars and never removed: it is the session's own OHLCV, which also counts
//! the volume the exchange's total proves traded at an unknown minute, so it cannot be summed back from minutes.
//!
//! One writer at a time, whichever process: every write and compaction holds the OS lock on `<kbars>/.store.lock`.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};

use market_runtime::calendar::{CalKey, Calendar};
use market_runtime::config_store::{read_active_revision, RevisionRead};
use market_runtime::contract::kbar_retention_months;
use market_runtime::event::{civil_from_days, days_from_civil, is_session_partitioned, parse_calendar_date};
use market_runtime::fsutil::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::accum::{money, Instrument, Minute};

const SCHEMA: &str = "kbar-code-v1";
const LOCK_FILE: &str = ".store.lock";
const RETENTION_DOMAIN: &str = "kbar_retention";

/// `[start minute, open, high, low, close, volume]`. No price: only odd lots traded, the volume still belongs to its bar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row(pub i32, pub Option<f64>, pub Option<f64>, pub Option<f64>, pub Option<f64>, pub f64);

/// The bars one date holds: at one timeframe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayBars {
    pub timeframe: i32,
    pub bars: Vec<Row>,
}

/// One session of a product: its daily bars and intraday bars.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionDoc {
    /// date -> `[open, high, low, close, volume]`.
    pub daily: BTreeMap<String, [f64; 5]>,
    pub intraday: BTreeMap<String, DayBars>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeDoc {
    pub schema: String,
    pub source: String,
    pub market: String,
    pub code: String,
    pub sessions: BTreeMap<String, SessionDoc>,
}

/// What one session of one product adds to its file.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionDay {
    pub daily: Option<[f64; 5]>,
    pub minutes: Vec<Row>,
}

/// One date a broker download brings: its 1-minute rows (its daily bar is folded from them here, by `fold`'s rule).
/// Serialized as the import file's `days`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportedDay {
    pub date: String,
    pub minutes: Vec<Row>,
}

/// The import file (`--import-kbars --input`): one product's downloaded dates.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ImportFile {
    pub source: String,
    pub market: String,
    pub session: String,
    pub code: String,
    pub days: Vec<ImportedDay>,
}

/// The session that identifies a publish.
pub struct SessionId<'a> {
    pub source: &'a str,
    pub market: &'a str,
    pub session: &'a str,
    pub trading_date: &'a str,
}

/// One session's daily bar in price units: the open, high and low of the minutes that traded (`Minute::traded`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DailyBar {
    pub open: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
    pub volume: f64,
}

/// The daily bar of the session's business part. The one rule for a day's open/high/low: the K-bar file and the
/// historical summary read it. A US day (a partition with a regular session) is the day's last complete quote: the
/// official open and close settle minutes after 16:00 and the prints do not cover every exchange, so no minute fold can
/// reach them. Every other partition, and a US day that never got a complete quote, folds its one business session.
pub fn daily_bar(inst: &Instrument, cal: &Calendar) -> Option<DailyBar> {
    let segments = cal.segments(inst.id.cal_key());
    let regular = segments.iter().find(|s| s.name == "REGULAR");
    if let (Some(_), Some(q)) = (regular, inst.price.day_quote) {
        return Some(DailyBar { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
    }
    let segment = regular.or_else(|| segments.first())?;
    let records: Vec<&Minute> = inst.minutes.range(segment.start..=segment.end).map(|(_, r)| &**r).collect();
    let bars: Vec<&&Minute> = records.iter().filter(|r| r.traded()).collect();
    let open = bars.first().and_then(|r| r.open)?;
    let high = bars.iter().filter_map(|r| r.high).max()?;
    let low = bars.iter().filter_map(|r| r.low).min()?;
    let close = inst.price.last_price.filter(|(_, _, minute)| *minute >= segment.start && *minute <= segment.end).map(|(price, _, _)| price)
        .or_else(|| bars.last().and_then(|r| r.close))?;
    let volume = records.iter().filter_map(|r| r.volume).sum::<f64>() + records.iter().map(|r| r.unattributed_volume).sum::<f64>();
    Some(DailyBar { open, high, low, close, volume })
}

/// The session's minutes and daily bar from the closing state of the fold that makes the live bars.
pub fn session_day(inst: &Instrument, cal: &Calendar) -> SessionDay {
    let segments = cal.segments(inst.id.cal_key());
    let mut minutes = Vec::new();
    for segment in segments {
        for minute in segment.minutes_between(segment.start, segment.end) {
            let Some(record) = inst.minutes.get(&minute) else { continue };
            let volume = record.volume.unwrap_or(0.0);
            if record.traded() {
                minutes.push(Row(minute, record.open.map(money), record.high.map(money), record.low.map(money), record.close.map(money), volume));
            } else if volume > 0.0 {
                minutes.push(Row(minute, None, None, None, None, volume));
            }
        }
    }
    let daily = daily_bar(inst, cal).map(|d| [money(d.open), money(d.high), money(d.low), money(d.close), d.volume]);
    SessionDay { daily, minutes }
}

/// `date` minus `months` calendar months; a day the earlier month lacks becomes its last.
fn months_before(date: &str, months: i64) -> Option<String> {
    let (year, month, day) = parse_calendar_date(date)?;
    let index = year * 12 + (month - 1) - months;
    let (y, m) = (index.div_euclid(12), index.rem_euclid(12) + 1);
    let (next_y, next_m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let length = days_from_civil(next_y, next_m, 1) - days_from_civil(y, m, 1);
    Some(format!("{y:04}-{m:02}-{:02}", day.min(length)))
}

/// The local (Taipei) calendar date, the clock retention ages against.
fn today() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (y, m, d) = civil_from_days((now + 8 * 3600).div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// The timeframe a date of this age is kept at, None when past every tier. `tiers` go finest first.
fn tier_of(date: &str, today: &str, tiers: &[(i32, i64)]) -> Option<i32> {
    tiers.iter().find(|(_, months)| months_before(today, *months).is_some_and(|cutoff| date >= cutoff.as_str())).map(|(timeframe, _)| *timeframe)
}

/// One trading-minute timeline per segment of the session on `date`, ascending (a US half day's sessions are shorter).
fn timelines(cal: &Calendar, source: &str, market: &str, session: &str, date: &str) -> Vec<Vec<i32>> {
    let key = CalKey { source, market, session: is_session_partitioned(source, market).then_some(session), date: Some(date) };
    cal.segments(key).iter().map(|segment| segment.minutes_between(segment.start, segment.end)).collect()
}

/// The first minute of the `k`-minute bar holding `minute`: bars are counted in trading minutes from the segment's first.
fn bucket_start(minute: i32, k: i32, lines: &[Vec<i32>]) -> i32 {
    lines.iter().find_map(|line| line.binary_search(&minute).ok().map(|at| line[at / k as usize * k as usize])).unwrap_or(minute)
}

/// One row added to the bar it falls in: first open, highest high, lowest low, last close of the rows with a price,
/// every row's volume. Rows come in minute order.
fn merge(bar: &mut Row, row: &Row) {
    bar.5 += row.5;
    if row.4.is_some() {
        bar.1 = bar.1.or(row.1);
        bar.2 = [bar.2, row.2].into_iter().flatten().reduce(f64::max);
        bar.3 = [bar.3, row.3].into_iter().flatten().reduce(f64::min);
        bar.4 = row.4;
    }
}

/// Rows folded to `k` minutes (`merge`).
fn fold(rows: &[Row], k: i32, lines: &[Vec<i32>]) -> Vec<Row> {
    let mut bars: BTreeMap<i32, Row> = BTreeMap::new();
    for row in rows {
        let start = bucket_start(row.0, k, lines);
        merge(bars.entry(start).or_insert(Row(start, None, None, None, None, 0.0)), row);
    }
    bars.into_values().collect()
}

/// A day's daily bar `[open, high, low, close, volume]` from its minute rows (`merge`); None when no row has a price.
fn daily_of(rows: &[Row]) -> Option<[f64; 5]> {
    let mut sorted: Vec<&Row> = rows.iter().collect();
    sorted.sort_by_key(|row| row.0);
    let mut bar = Row(0, None, None, None, None, 0.0);
    for row in sorted {
        merge(&mut bar, row);
    }
    Some([bar.1?, bar.2?, bar.3?, bar.4?, bar.5])
}

/// Every date at the timeframe its age calls for, folded on that date's own timelines (`lines_on`). True when
/// something changed.
fn compact(session: &mut SessionDoc, lines_on: impl Fn(&str) -> Vec<Vec<i32>>, tiers: &[(i32, i64)], today: &str) -> bool {
    let before = session.intraday.len();
    let mut folded = false;
    session.intraday.retain(|date, day| {
        let Some(target) = tier_of(date, today, tiers) else { return false };
        if target > day.timeframe && target % day.timeframe == 0 {
            day.bars = fold(&day.bars, target, &lines_on(date));
            day.timeframe = target;
            folded = true;
        }
        true
    });
    folded || session.intraday.len() != before
}

/// The active retention, finest timeframe first. A revision that does not match the contract's tiers is unusable.
fn parse_retention(values: &Value) -> Result<Vec<(i32, i64)>, String> {
    let months = values.get("months").and_then(Value::as_object).ok_or("months is missing")?;
    let tiers: Vec<(i32, i64)> = kbar_retention_months().iter().map(|(timeframe, _)| {
        months.get(&timeframe.to_string()).and_then(Value::as_i64).filter(|n| (1..=120).contains(n))
            .map(|n| (*timeframe, n)).ok_or_else(|| format!("months[{timeframe}] is not 1..120"))
    }).collect::<Result<_, _>>()?;
    if months.len() != tiers.len() {
        return Err("months holds a timeframe that is no tier".into());
    }
    if tiers.windows(2).any(|pair| pair[0].1 > pair[1].1) {
        return Err("a coarser timeframe is kept for less time than a finer one".into());
    }
    Ok(tiers)
}

pub struct Store {
    root: PathBuf,
    config_root: Option<PathBuf>,
}

impl Store {
    pub fn new(root: PathBuf, config_root: Option<PathBuf>) -> Self {
        Self { root, config_root }
    }

    fn path(&self, source: &str, market: &str, code: &str) -> PathBuf {
        self.root.join(format!("source={source}")).join(format!("market={market}")).join(format!("{code}.json"))
    }

    fn lock(&self) -> Result<File, String> {
        fs::create_dir_all(&self.root).map_err(|e| format!("mkdir {}: {e}", self.root.display()))?;
        let file = File::options().create(true).truncate(false).write(true).open(self.root.join(LOCK_FILE))
            .map_err(|e| format!("K-bar store lock: {e}"))?;
        file.lock().map_err(|e| format!("K-bar store lock: {e}"))?;
        Ok(file)
    }

    fn retention(&self) -> Result<Vec<(i32, i64)>, String> {
        match self.config_root.as_deref().map(|root| read_active_revision(root, RETENTION_DOMAIN)) {
            None | Some(RevisionRead::Absent) => Ok(kbar_retention_months().to_vec()),
            Some(RevisionRead::Active(doc)) => parse_retention(doc.get("values").unwrap_or(&Value::Null)),
            Some(RevisionRead::Unusable(reason)) => Err(reason),
        }
    }

    /// An existing file that cannot be read is an error, never a fresh start: writing over it would erase the permanent
    /// daily bars.
    fn read(path: &Path) -> Result<Option<CodeDoc>, String> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("reading {}: {e}", path.display())),
        };
        let doc: CodeDoc = serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        if doc.schema != SCHEMA {
            return Err(format!("{}: schema {}", path.display(), doc.schema));
        }
        Ok(Some(doc))
    }

    fn write(path: &Path, doc: &CodeDoc) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        atomic_write(path, &serde_json::to_vec(doc).map_err(|e| e.to_string())?).map_err(|e| format!("write {}: {e}", path.display()))
    }

    /// One session's products into their files, at 1 minute. A date already held is replaced (a refold). Err: the job
    /// fails and is retried.
    pub fn publish(&self, id: &SessionId<'_>, days: &[(String, SessionDay)]) -> Result<usize, String> {
        let _lock = self.lock()?;
        let (source, market, session_name) = (id.source.to_lowercase(), id.market.to_uppercase(), id.session.to_uppercase());
        let mut written = 0;
        for (code, day) in days {
            if day.daily.is_none() && day.minutes.is_empty() {
                continue;
            }
            let path = self.path(&source, &market, code);
            let mut doc = Self::read(&path)?.unwrap_or_else(|| CodeDoc { schema: SCHEMA.into(), source: source.clone(), market: market.clone(), code: code.clone(), sessions: BTreeMap::new() });
            let session = doc.sessions.entry(session_name.clone()).or_default();
            if let Some(daily) = day.daily {
                session.daily.insert(id.trading_date.to_owned(), daily);
            }
            if day.minutes.is_empty() {
                session.intraday.remove(id.trading_date);
            } else {
                session.intraday.insert(id.trading_date.to_owned(), DayBars { timeframe: 1, bars: day.minutes.clone() });
            }
            Self::write(&path, &doc)?;
            written += 1;
        }
        Ok(written)
    }

    /// A broker download into the product's file: each date at the finest timeframe the active retention still keeps at
    /// its age (`tier_of`, folded by `fold`: what the aging would have left), its daily bar always; past every tier only
    /// the daily bar. A date this store holds stays as it is: it is built from the exchange's own prints.
    pub fn import(&self, file: &ImportFile) -> Result<Value, String> {
        self.import_at(file, &today())
    }

    fn import_at(&self, file: &ImportFile, today: &str) -> Result<Value, String> {
        let _lock = self.lock()?;
        let tiers = self.retention().map_err(|reason| format!("{RETENTION_DOMAIN}: {reason}"))?;
        let (source, market, session_name) = (file.source.to_lowercase(), file.market.to_uppercase(), file.session.to_uppercase());
        let cal = Calendar::default();
        let path = self.path(&source, &market, &file.code);
        let mut doc = Self::read(&path)?.unwrap_or_else(|| CodeDoc { schema: SCHEMA.into(), source: source.clone(), market: market.clone(), code: file.code.clone(), sessions: BTreeMap::new() });
        let session = doc.sessions.entry(session_name.clone()).or_default();
        let (mut imported, mut held) = (0, 0);
        for day in &file.days {
            if session.daily.contains_key(&day.date) || session.intraday.contains_key(&day.date) {
                held += 1;
                continue;
            }
            if let Some(daily) = daily_of(&day.minutes) {
                session.daily.insert(day.date.clone(), daily);
            }
            if let Some(timeframe) = tier_of(&day.date, today, &tiers) {
                let lines = timelines(&cal, &source, &market, &session_name, &day.date);
                session.intraday.insert(day.date.clone(), DayBars { timeframe, bars: fold(&day.minutes, timeframe, &lines) });
            }
            imported += 1;
        }
        if imported > 0 {
            Self::write(&path, &doc)?;
        }
        Ok(json!({"ok": true, "imported": imported, "held": held}))
    }

    /// Every file aged to the active retention: the close-of-day materialization runs it. Err: the retention cannot be
    /// read, nothing is touched. A file that cannot be read is reported and the rest are still aged.
    pub fn compact_all(&self) -> Result<usize, String> {
        self.compact_all_at(&today())
    }

    fn compact_all_at(&self, today: &str) -> Result<usize, String> {
        let _lock = self.lock()?;
        let tiers = self.retention().map_err(|reason| format!("{RETENTION_DOMAIN}: {reason}"))?;
        let cal = Calendar::default();
        let mut files = Vec::new();
        for source in children(&self.root).into_iter().filter(|p| name_of(p).starts_with("source=")) {
            for market in children(&source).into_iter().filter(|p| name_of(p).starts_with("market=")) {
                files.extend(children(&market).into_iter().filter(|p| name_of(p).ends_with(".json")));
            }
        }
        let mut changed = 0;
        for path in files {
            match Self::read(&path) {
                Ok(Some(mut doc)) => {
                    let mut any = false;
                    for (name, session) in &mut doc.sessions {
                        any |= compact(session, |date| timelines(&cal, &doc.source, &doc.market, name, date), &tiers, today);
                    }
                    if any {
                        Self::write(&path, &doc)?;
                        changed += 1;
                    }
                }
                Ok(None) => {} // not an error: the file was listed a moment ago and nothing else removes one under this lock
                Err(reason) => eprintln!("[kbar_store] {reason}; this file is left as it is"),
            }
        }
        Ok(changed)
    }
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

fn children(dir: &Path) -> Vec<PathBuf> {
    match fs::read_dir(dir) {
        Ok(entries) => entries.flatten().map(|entry| entry.path()).collect(),
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[kbar_store] listing {}: {e}", dir.display());
            }
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accum::InstrumentId;
    use crate::engine::Engine;
    use crate::rules::RuleSet;
    use market_runtime::event::MarketEvent;

    const TIERS: [(i32, i64); 5] = [(1, 3), (5, 5), (15, 7), (30, 9), (60, 11)];

    fn us_quote(seq: u64, ts: i64, minute: i32, [open, high, low, current]: [i64; 4], total_volume: f64) -> MarketEvent {
        serde_json::from_value(json!({
            "schema_version": 2, "durable_sequence": seq, "symbol": "futu:US:US.MU", "provider": "futu",
            "market": "US", "code": "US.MU", "session": "FULL", "trading_date": "2026-11-09",
            "generation": 1, "sequence": seq, "exchange_ts_ns": ts,
            "payload": {"kind": "quote", "current": current, "open": open, "high": high, "low": low, "total_volume": total_volume,
                        "total_amount": 0.0, "status": "live", "minute": minute, "average": 0, "volume": 0.0, "amount": 0.0}
        })).unwrap()
    }

    fn us_trade(seq: u64, ts: i64, minute: i32, price: i64, volume: f64) -> MarketEvent {
        serde_json::from_value(json!({
            "schema_version": 2, "durable_sequence": seq, "symbol": "futu:US:US.MU", "provider": "futu",
            "market": "US", "code": "US.MU", "session": "FULL", "trading_date": "2026-11-09",
            "generation": 1, "sequence": seq, "exchange_ts_ns": ts,
            "payload": {"kind": "trade", "price": price, "volume": volume, "total_volume": 0.0, "side": 1, "trade_id": format!("t{seq}"), "minute": minute,
                        "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0, "auction": false}
        })).unwrap()
    }

    /// MU 2026-11-09: the prints stop at 733.69 and 17.8M shares, the last quote says 733.15 and 32.2M. A US day's bar is
    /// that last quote, and among quotes stamped with one time (they all stop at 16:00) the one that came last.
    #[test]
    fn a_us_days_bar_is_its_last_complete_quote() {
        let events = [
            us_quote(1, 100, 570, [7_035_900, 0, 0, 7_036_650], 1_885_603.0),
            us_trade(2, 200, 959, 7_336_900, 17_821_080.0),
            us_quote(3, 300, 959, [7_030_000, 7_447_400, 6_896_500, 7_336_900], 27_044_825.0),
            us_quote(4, 400, 960, [7_030_000, 7_447_400, 6_896_500, 7_337_000], 30_000_000.0),
            us_quote(5, 400, 960, [7_031_800, 7_447_400, 6_896_500, 7_331_500], 32_172_103.0),
            us_quote(6, 350, 960, [1, 1, 1, 1], 1.0), // arrives late with an older exchange time
        ];
        let day = day_of(&folded(&events), &events);
        assert_eq!(day.daily, Some([money(7_031_800), money(7_447_400), money(6_896_500), money(7_331_500), 32_172_103.0]));
    }

    /// The first quotes of a session report no high or low yet: they are not a day's figures, the prints stay its bar.
    #[test]
    fn a_us_day_without_a_complete_quote_folds_its_regular_minutes() {
        let events = [us_quote(1, 100, 570, [7_035_900, 0, 0, 7_036_650], 1_885_603.0), us_trade(2, 200, 600, 7_100_000, 10.0)];
        let day = day_of(&folded(&events), &events);
        assert_eq!(day.daily.map(|d| (d[3], d[4])), Some((money(7_100_000), 10.0)));
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("b-kbar-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn event(seq: u64, price: i64, volume: f64, minute: i32, auction: bool) -> MarketEvent {
        serde_json::from_value(json!({
            "schema_version": 2, "durable_sequence": seq, "symbol": "shioaji:STK:2330", "provider": "shioaji",
            "market": "STK", "code": "2330", "session": "DAY", "trading_date": "2026-10-27",
            "generation": 1, "sequence": seq, "exchange_ts_ns": seq as i64,
            "payload": {"kind": "trade", "price": price, "volume": volume, "total_volume": 0.0, "side": 1, "trade_id": "", "minute": minute,
                        "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0, "auction": auction}
        })).unwrap()
    }

    fn folded(events: &[MarketEvent]) -> Engine {
        let mut engine = Engine::new(Calendar::default(), RuleSet::default());
        for e in events {
            engine.apply(e);
        }
        engine
    }

    fn day_of(engine: &Engine, events: &[MarketEvent]) -> SessionDay {
        session_day(engine.instruments.get(&InstrumentId::of(&events[0])).unwrap(), &Calendar::default())
    }

    /// A US partition is split by its own date: on the 2026-11-27 half day the regular session's timeline ends at 12:59
    /// and the after-hours one starts at 13:00, so a K bar never joins after-hours minutes onto the regular session.
    #[test]
    fn a_us_half_days_timelines_are_its_shortened_sessions() {
        let cal = Calendar::default();
        let half = timelines(&cal, "futu", "US", "FULL", "2026-11-27");
        let whole = timelines(&cal, "futu", "US", "FULL", "2026-11-26");
        let regular = |lines: &[Vec<i32>]| lines.iter().find(|line| line.first() == Some(&570)).cloned().unwrap();
        assert_eq!(regular(&half).last(), Some(&779));
        assert_eq!(regular(&whole).last(), Some(&959));
        assert!(half.iter().any(|line| line.first() == Some(&780) && line.last() == Some(&1019)), "13:00-16:59 after-hours");
        assert_eq!(bucket_start(785, 60, &half), 780, "13:05 is in the after-hours hour that opens at 13:00");
        assert_eq!(bucket_start(785, 60, &whole), 750, "on a whole day it is in the regular session's 12:30 hour");
        // The minutes as B keeps them: a 13:20 print's partition key reads the half day's after-hours session.
        let id = crate::accum::InstrumentId { source: "futu".into(), market: "US".into(), code: "US.MU".into(),
                                              trading_date: "2026-11-27".into(), session: "FULL".into() };
        assert_eq!(cal.segment_of(id.cal_key(), 800).unwrap().name, "POST");
    }

    fn stock_lines() -> Vec<Vec<i32>> {
        timelines(&Calendar::default(), "shioaji", "STK", "DAY", "2026-10-16")
    }

    fn row(minute: i32, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Row {
        Row(minute, Some(open), Some(high), Some(low), Some(close), volume)
    }

    fn session(days: &[(&str, i32, Vec<Row>)]) -> SessionDoc {
        SessionDoc { daily: BTreeMap::new(),
                     intraday: days.iter().map(|(date, timeframe, bars)| ((*date).to_owned(), DayBars { timeframe: *timeframe, bars: bars.clone() })).collect() }
    }

    fn stock_id(date: &str) -> SessionId<'_> {
        SessionId { source: "shioaji", market: "STK", session: "DAY", trading_date: date }
    }

    #[test]
    fn the_stored_minutes_hold_the_auctions_and_fold_to_the_bars_the_day_showed_live() {
        let mut events = vec![event(1, 1_000_000, 500.0, 540, true)];
        for (i, minute) in (541..552).enumerate() {
            events.push(event(2 + i as u64, 1_000_000 + (i as i64 % 4) * 10_000, 3.0, minute, false));
        }
        events.push(event(50, 1_020_000, 700.0, 810, true));
        let engine = folded(&events);
        let day = day_of(&engine, &events);
        assert_eq!(day.minutes[0].0, 540);
        assert_eq!(day.minutes[0].5, 500.0, "the opening auction is 09:00's");
        assert_eq!(day.minutes.last().unwrap().0, 810, "the closing auction is the 13:30 bar");
        assert_eq!(day.minutes.last().unwrap().5, 700.0);

        let inst = engine.instruments.get(&InstrumentId::of(&events[0])).unwrap();
        let after_close = (days_from_civil(2026, 10, 27) * 86_400 + (15 * 60 - 8 * 60) * 60) * 1_000_000_000;
        let (live, _) = inst.day_wire(&Calendar::default(), &RuleSet::default(), after_close, None, None);
        let bars = fold(&day.minutes, 5, &stock_lines());
        let live_bars: Vec<Row> = live["fixed_k"]["k5"].as_array().unwrap().iter().filter(|bar| bar["close"].is_f64())
            .map(|bar| row(bar["start_minute"].as_i64().unwrap() as i32, bar["open"].as_f64().unwrap(), bar["high"].as_f64().unwrap(),
                           bar["low"].as_f64().unwrap(), bar["close"].as_f64().unwrap(), bar["volume"].as_f64().unwrap())).collect();
        assert_eq!(bars, live_bars, "a fold of the stored minutes is the fixed K the day showed");
        let daily = day.daily.unwrap();
        assert_eq!((daily[0], daily[1], daily[2], daily[3]), (live["open"].as_f64().unwrap(), live["high"].as_f64().unwrap(), live["low"].as_f64().unwrap(), live["close"].as_f64().unwrap()));
        assert_eq!(daily[4], live["volume"].as_f64().unwrap());
    }

    #[test]
    fn a_coarser_timeframe_is_the_same_whichever_finer_one_it_came_from() {
        let minutes: Vec<Row> = (540..620).map(|m| row(m, f64::from(m), f64::from(m) + 1.0, f64::from(m) - 1.0, f64::from(m) + 0.5, 2.0)).collect();
        let lines = stock_lines();
        assert_eq!(fold(&fold(&minutes, 5, &lines), 15, &lines), fold(&minutes, 15, &lines));
        assert_eq!(fold(&fold(&fold(&minutes, 5, &lines), 15, &lines), 30, &lines), fold(&minutes, 30, &lines));
    }

    #[test]
    fn a_bar_counts_trading_minutes_so_a_lunch_break_does_not_shift_it() {
        let lines = timelines(&Calendar::default(), "futu", "HK", "DAY", "2026-10-16");
        assert_eq!(bucket_start(719, 60, &lines), 690);
        assert_eq!(bucket_start(780, 60, &lines), 690, "the bar that opened before the break takes the 30 minutes after it");
        assert_eq!(bucket_start(810, 60, &lines), 810);
    }

    #[test]
    fn a_minute_of_odd_lots_only_adds_its_volume() {
        let rows = vec![Row(540, None, None, None, None, 2.0), row(541, 10.0, 12.0, 9.0, 11.0, 3.0)];
        assert_eq!(fold(&rows, 5, &stock_lines()), vec![row(540, 10.0, 12.0, 9.0, 11.0, 5.0)]);
    }

    #[test]
    fn each_date_is_held_at_the_timeframe_its_age_calls_for_and_never_twice() {
        let minutes: Vec<Row> = (540..600).map(|m| row(m, 1.0, 1.0, 1.0, 1.0, 1.0)).collect();
        let today = "2026-11-08";
        let mut doc = session(&[("2026-11-06", 1, minutes.clone()), ("2026-08-08", 1, minutes.clone()), ("2026-08-07", 1, minutes.clone()),
                                ("2026-05-01", 1, minutes.clone()), ("2026-03-01", 1, minutes.clone()), ("2026-01-05", 1, minutes.clone()),
                                ("2025-12-20", 1, minutes.clone()), ("2025-12-07", 1, minutes)]);
        doc.daily.insert("2025-12-07".into(), [1.0; 5]);
        assert!(compact(&mut doc, |_| stock_lines(), &TIERS, today));
        let held: Vec<(&str, i32, usize)> = doc.intraday.iter().map(|(date, day)| (date.as_str(), day.timeframe, day.bars.len())).collect();
        assert_eq!(held, [("2025-12-20", 60, 1), ("2026-01-05", 60, 1), ("2026-03-01", 30, 2), ("2026-05-01", 15, 4),
                          ("2026-08-07", 5, 12), ("2026-08-08", 1, 60), ("2026-11-06", 1, 60)]);
        assert!(doc.daily.contains_key("2025-12-07"), "past every tier the daily bar stays");
        assert!(!compact(&mut doc, |_| stock_lines(), &TIERS, today), "nothing left to do: the file is not written again");
    }

    #[test]
    fn a_month_shorter_than_the_day_ends_at_its_last_day() {
        assert_eq!(months_before("2026-05-31", 3).unwrap(), "2026-02-28");
        assert_eq!(months_before("2026-02-15", 3).unwrap(), "2025-11-15");
    }

    #[test]
    fn a_session_goes_in_a_file_of_its_own_product_and_replaces_the_date() {
        let root = temp("publish");
        let store = Store::new(root.clone(), None);
        let minutes = vec![row(540, 1.0, 2.0, 1.0, 2.0, 3.0)];
        let first = SessionDay { daily: Some([1.0, 2.0, 1.0, 2.0, 3.0]), minutes: minutes.clone() };
        assert_eq!(store.publish(&stock_id("2026-11-05"), &[("2330".into(), first)]).unwrap(), 1);
        let second = SessionDay { daily: Some([9.0, 9.0, 9.0, 9.0, 9.0]), minutes };
        store.publish(&stock_id("2026-11-05"), &[("2330".into(), second)]).unwrap();
        let doc = Store::read(&store.path("shioaji", "STK", "2330")).unwrap().unwrap();
        assert_eq!(doc.sessions["DAY"].daily["2026-11-05"][0], 9.0, "a refold replaces the date");
        assert_eq!(doc.sessions["DAY"].intraday["2026-11-05"].timeframe, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_aging_folds_every_file_to_its_age() {
        let root = temp("old-date");
        let store = Store::new(root.clone(), None);
        let day = SessionDay { daily: Some([1.0; 5]), minutes: (540..545).map(|m| row(m, 1.0, 1.0, 1.0, 1.0, 1.0)).collect() };
        store.publish(&stock_id("2026-07-01"), &[("2330".into(), day)]).unwrap();
        assert_eq!(store.compact_all_at("2026-11-08").unwrap(), 1);
        assert_eq!(store.compact_all_at("2026-11-08").unwrap(), 0, "aged already: not written again");
        let doc = Store::read(&store.path("shioaji", "STK", "2330")).unwrap().unwrap();
        assert_eq!(doc.sessions["DAY"].intraday["2026-07-01"].timeframe, 5);
        let _ = fs::remove_dir_all(root);
    }

    fn imported(date: &str, minutes: Vec<Row>) -> ImportedDay {
        ImportedDay { date: date.to_owned(), minutes }
    }

    fn import_file(days: Vec<ImportedDay>) -> ImportFile {
        ImportFile { source: "shioaji".into(), market: "STK".into(), session: "DAY".into(), code: "2330".into(), days }
    }

    #[test]
    fn a_download_is_kept_at_the_finest_timeframe_its_date_may_still_hold() {
        let root = temp("import-tier");
        let store = Store::new(root.clone(), None);
        let minutes: Vec<Row> = (540..600).map(|m| row(m, 1.0, 2.0, 0.5, 1.5, 1.0)).collect();
        // The default retention, on 2026-11-08: 1m to 08-08, 5m to 06-08, 15m to 04-08, 30m to 02-08, 60m to 2025-12-08.
        let file = import_file(vec![imported("2026-09-01", minutes.clone()), imported("2026-07-01", minutes.clone()), imported("2026-03-02", minutes.clone()), imported("2025-01-02", minutes)]);
        assert_eq!(store.import_at(&file, "2026-11-08").unwrap()["imported"], 4);
        let doc = Store::read(&store.path("shioaji", "STK", "2330")).unwrap().unwrap();
        let session = &doc.sessions["DAY"];
        let held: Vec<(&str, i32, usize)> = session.intraday.iter().map(|(date, day)| (date.as_str(), day.timeframe, day.bars.len())).collect();
        assert_eq!(held, [("2026-03-02", 30, 2), ("2026-07-01", 5, 12), ("2026-09-01", 1, 60)]);
        assert!(session.daily.contains_key("2025-01-02") && !session.intraday.contains_key("2025-01-02"), "past every tier only the daily bar");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_imported_date_is_what_the_aging_would_have_left() {
        let lines = stock_lines();
        let minutes: Vec<Row> = (540..600).map(|m| row(m, f64::from(m), f64::from(m) + 1.0, f64::from(m) - 1.0, f64::from(m) + 0.5, 2.0)).collect();
        let today = "2026-11-08";
        let mut aged = session(&[("2026-07-01", 1, minutes.clone())]);
        compact(&mut aged, |_| lines.clone(), &TIERS, today);
        let root = temp("import-aged");
        let store = Store::new(root.clone(), None);
        store.import_at(&import_file(vec![imported("2026-07-01", minutes)]), today).unwrap();
        let doc = Store::read(&store.path("shioaji", "STK", "2330")).unwrap().unwrap();
        assert_eq!(doc.sessions["DAY"].intraday["2026-07-01"], aged.intraday["2026-07-01"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_download_never_replaces_a_date_the_store_holds() {
        let root = temp("import-held");
        let store = Store::new(root.clone(), None);
        let own = SessionDay { daily: Some([7.0; 5]), minutes: vec![row(540, 7.0, 7.0, 7.0, 7.0, 7.0)] };
        store.publish(&stock_id("2026-11-05"), &[("2330".into(), own)]).unwrap();
        let answer = store.import_at(&import_file(vec![imported("2026-11-05", vec![row(540, 1.0, 1.0, 1.0, 1.0, 1.0)])]), "2026-11-08").unwrap();
        assert_eq!((answer["imported"].as_i64(), answer["held"].as_i64()), (Some(0), Some(1)));
        let doc = Store::read(&store.path("shioaji", "STK", "2330")).unwrap().unwrap();
        assert_eq!(doc.sessions["DAY"].daily["2026-11-05"][0], 7.0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_import_file_reads_as_python_writes_it() {
        let text = r#"{"source":"shioaji","market":"STK","session":"DAY","code":"2330","days":[{"date":"2026-11-05","minutes":[[540,1.0,2.0,0.5,1.5,9.0]]}]}"#;
        let file: ImportFile = serde_json::from_str(text).unwrap();
        assert_eq!(file.days[0].minutes, vec![row(540, 1.0, 2.0, 0.5, 1.5, 9.0)]);
        let with_daily = text.replace(r#""minutes""#, r#""daily":[1.0,2.0,0.5,1.5,9.0],"minutes""#);
        assert!(serde_json::from_str::<ImportFile>(&with_daily).is_err(), "the daily bar is folded here, never sent");
    }

    #[test]
    fn an_imported_daily_bar_is_folded_from_its_minutes() {
        let root = temp("import-daily");
        let store = Store::new(root.clone(), None);
        let minutes = vec![row(541, 11.0, 13.0, 10.5, 12.0, 5.0), row(540, 10.0, 11.0, 9.0, 11.0, 3.0), Row(542, None, None, None, None, 2.0)];
        store.import_at(&import_file(vec![imported("2026-11-05", minutes)]), "2026-11-08").unwrap();
        let doc = Store::read(&store.path("shioaji", "STK", "2330")).unwrap().unwrap();
        assert_eq!(doc.sessions["DAY"].daily["2026-11-05"], [10.0, 13.0, 9.0, 12.0, 10.0], "minute order; an odd lot's volume counts");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_unreadable_file_is_never_overwritten_and_fails_the_publish() {
        let root = temp("broken");
        let store = Store::new(root.clone(), None);
        let path = store.path("shioaji", "STK", "2330");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{broken").unwrap();
        let day = SessionDay { daily: Some([1.0; 5]), minutes: Vec::new() };
        assert!(store.publish(&stock_id("2026-11-05"), &[("2330".into(), day)]).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
        assert_eq!(store.compact_all_at("2026-11-08").unwrap(), 0, "the rest of the store is still aged");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_retention_has_to_name_every_tier_coarser_ones_no_shorter() {
        assert_eq!(parse_retention(&json!({"months": {"1": 2, "5": 2, "15": 3, "30": 4, "60": 5}})).unwrap(), [(1, 2), (5, 2), (15, 3), (30, 4), (60, 5)]);
        assert!(parse_retention(&json!({"months": {"1": 2, "5": 2, "15": 3, "30": 4}})).is_err());
        assert!(parse_retention(&json!({"months": {"1": 9, "5": 2, "15": 3, "30": 4, "60": 5}})).is_err());
        assert!(parse_retention(&json!({"months": {"1": 2, "3": 2, "5": 2, "15": 3, "30": 4, "60": 5}})).is_err(), "3 minutes is no tier");
        assert!(parse_retention(&json!({"months": {"1": 0, "5": 2, "15": 3, "30": 4, "60": 5}})).is_err());
    }
}
