//! 量變's baseline: the previous closed session's volume per clock minute, per code.
//!
//! One directory per source, `<market data root>/<source>/volume_baseline` (the Python rule
//! `volume_baseline_service.volume_baseline_dir`). The session owner publishes a date there once a session is
//! materialized (`VolumeBaselineService.build_for_codes`; Shioaji's rollover, Futu's lifecycle): a
//! JSON twin `{"date", "items": {code: {"HH:MM": volume}}}` and, written last, `<YYYY-MM-DD>.manifest.json` naming it
//! with its codes, row count and FNV-1a 64. The manifest is the only way in: a file no manifest names is an
//! interrupted build, never a baseline, and a twin that does not match its manifest is CORRUPT. A trading date
//! compares against the newest date published before it -- the previous closed session, across weekends and holidays.
//! Read-only here. A lookup says which of three things it is: READY (the day), NOT_YET (no earlier
//! file -- the owner has not written it), CORRUPT (the newest earlier file cannot be read; why). Each is shown as is
//! in 量變 and counted in B's metrics -- never all folded into "no baseline". Every answer is asked again when the
//! directory changed (a file written or replaced there), not on a timer -- a READY one too: the previous session's
//! file written after the first lookup replaces an older one.
//!
//! Shioaji (TWSE) knows its previous session from the trading calendar: until that day's file exists the answer is
//! NOT_YET, never an older day standing in for it. Futu has no venue calendar here, so it takes the newest earlier
//! file (each US session's file is written by its own lifecycle before the next session).
//!
//! 量比 (a rule event's volume against usual) reads further back: `month_for_date` is up to MONTH_DAYS published
//! sessions before a date, each with the span of minutes it actually recorded -- a session whose recording stopped
//! (the 10-13 login expiry) says nothing about the minutes after it, rather than "nothing traded".

use market_runtime::event::parse_calendar_date;
use market_runtime::remediation;
use market_runtime::rollover::FollowedCalendar;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

#[derive(Debug, Default)]
pub struct Day {
    pub date: String,
    /// Volume per clock minute: a decimal quantity (market_runtime::volume), never rounded.
    pub items: HashMap<String, HashMap<i32, f64>>,
    /// The first and last minute any code recorded: inside it a code's missing minute traded nothing, outside it
    /// the session was not recorded.
    pub span: Option<(i32, i32)>,
}

/// How many published sessions 量比 averages (user 10-14: about a month of trading days).
pub const MONTH_DAYS: usize = 22;

/// 量比's baseline: the published sessions before a trading date, newest first, at most MONTH_DAYS.
#[derive(Debug, Default)]
pub struct Month {
    pub days: Vec<Arc<Day>>,
}

impl Month {
    /// The usual volume of `code` over clock minutes `from..=to`: per minute, the mean over the days whose span
    /// covers it; `last_fraction` (0..=1) scales the last minute, one still in progress. None unless every minute is
    /// covered by at least one day. Also returns the most days any minute was averaged over.
    pub fn usual(&self, code: &str, from: i32, to: i32, last_fraction: f64) -> Option<(f64, usize)> {
        if from > to {
            return None;
        }
        let code = code.trim().to_uppercase();
        let mut total = 0.0;
        let mut most = 0;
        for minute in from..=to {
            let covering: Vec<f64> = self.days.iter()
                .filter(|d| d.span.is_some_and(|(a, b)| a <= minute && minute <= b))
                .map(|d| d.items.get(&code).and_then(|per| per.get(&minute)).copied().unwrap_or(0.0))
                .collect();
            if covering.is_empty() {
                return None;
            }
            let mean = covering.iter().sum::<f64>() / covering.len() as f64;
            total += if minute == to { mean * last_fraction.clamp(0.0, 1.0) } else { mean };
            most = most.max(covering.len());
        }
        Some((total, most))
    }
}

#[derive(Debug, Clone)]
pub enum Lookup {
    Ready(Arc<Day>),
    NotYet,
    Corrupt(String),
    /// The process has no baseline root (tests, offline replays).
    NoRoot,
}

impl Lookup {
    pub fn day(&self) -> Option<&Day> {
        match self {
            Lookup::Ready(day) => Some(day),
            _ => None,
        }
    }

    pub fn state(&self) -> &'static str {
        match self {
            Lookup::Ready(_) => "READY",
            Lookup::NotYet => "NOT_YET",
            Lookup::Corrupt(_) => "CORRUPT",
            Lookup::NoRoot => "NO_ROOT",
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Lookup::Corrupt(why) => Some(why),
            _ => None,
        }
    }
}

#[derive(Default)]
pub struct Store {
    /// The market data root; a source's baselines are in `<root>/<source>/volume_baseline`.
    root: Option<PathBuf>,
    /// Per (source, trading date): the directory's modification time when it was looked up, and the answer.
    /// Keyed answers with what they were decided on: the directory's modification time and the calendar revision.
    cache: Mutex<HashMap<(String, String), ((Option<SystemTime>, u64), Lookup)>>,
    /// 量比: per (source, trading date), the directory's modification time and the sessions before it.
    months: Mutex<HashMap<(String, String), ((Option<SystemTime>, u64), Arc<Month>)>>,
    /// The baselines unreadable now, each one recorded operation (`analysis.volume_baseline_corrupt`): opened
    /// when it is found unreadable, an attempt each time it is read again and still is, ended when it reads. Why, and
    /// how many reads, survive B's restart in the ledger -- the in-memory map did not, and kept a repaired file.
    corrupt: Mutex<BTreeMap<String, (String, u64, Option<remediation::Operation>)>>,
    /// TWSE trading days with A's observed closures: Shioaji's previous session.
    calendar: FollowedCalendar,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").field("root", &self.root).finish()
    }
}

impl Store {
    #[cfg(test)]
    pub fn new(root: Option<PathBuf>) -> Self {
        let calendar = market_runtime::rollover::TradingCalendar::load(None).expect("the built-in holidays file validates");
        Self::with_calendar(root, FollowedCalendar::new(calendar, None).expect("no sessions file to read"))
    }

    pub fn with_calendar(root: Option<PathBuf>, calendar: FollowedCalendar) -> Self {
        Self { root, cache: Mutex::new(HashMap::new()), months: Mutex::new(HashMap::new()), corrupt: Mutex::new(BTreeMap::new()), calendar }
    }

    /// The baseline of `source` for `trading_date`: the newest file dated strictly before it.
    pub fn for_date(&self, source: &str, trading_date: &str) -> Lookup {
        let Some(root) = self.root.as_ref() else { return Lookup::NoRoot };
        let dir = root.join(source.to_lowercase()).join("volume_baseline");
        let key = (source.to_lowercase(), trading_date.to_string());
        let (revision, calendar) = self.calendar.get();
        let modified = (std::fs::metadata(&dir).and_then(|m| m.modified()).ok(), revision);
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((seen, answer)) = cache.get(&key) {
            if *seen == modified {
                return answer.clone();
            }
        }
        let expected = match source.eq_ignore_ascii_case("shioaji") {
            true => calendar.previous_trading_day(trading_date).map(Some)
                .ok_or_else(|| format!("trading date {trading_date:?} is not a YYYY-MM-DD date")),
            false => Ok(None),
        };
        let answer = match expected.and_then(|expected| published_dates(&dir).map(|dates| (expected, dates))) {
            Err(why) => Lookup::Corrupt(why),
            Ok((expected, dates)) => {
                let earlier: Vec<&String> = dates.iter().filter(|d| d.as_str() < trading_date).collect();
                let chosen = match expected.as_deref() {
                    // Shioaji: exactly the previous TWSE session. Until it is published the answer is NOT_YET
                    // -- an older day never stands in -- and a date after it but before this one (a non-trading day)
                    // is a baseline that should not exist: CORRUPT, said and recorded, never used.
                    Some(want) => match earlier.iter().find(|d| d.as_str() > want) {
                        Some(stray) => Err(format!("{}: baseline for {stray}, which is not a TWSE session (the previous one is {want})", dir.display())),
                        None => Ok(earlier.iter().find(|d| d.as_str() == want).map(|d| (*d).clone())),
                    },
                    None => Ok(earlier.last().map(|d| (*d).clone())),
                };
                match chosen {
                    Err(why) => Lookup::Corrupt(why),
                    Ok(None) => Lookup::NotYet,
                    Ok(Some(date)) => match load_published(&dir, &date) {
                        Ok(day) => Lookup::Ready(Arc::new(day)),
                        Err(why) => Lookup::Corrupt(why),
                    },
                }
            }
        };
        self.track_corruption(source, trading_date, &answer);
        cache.insert(key, (modified, answer.clone()));
        answer
    }

    /// 量比's baseline for `trading_date`: the newest MONTH_DAYS published sessions before it (Shioaji: TWSE sessions
    /// only). A session that cannot be read is left out and recorded as unreadable, like `for_date`'s.
    pub fn month_for_date(&self, source: &str, trading_date: &str) -> Option<Arc<Month>> {
        let root = self.root.as_ref()?;
        let dir = root.join(source.to_lowercase()).join("volume_baseline");
        let key = (source.to_lowercase(), trading_date.to_string());
        let (revision, calendar) = self.calendar.get();
        let modified = (std::fs::metadata(&dir).and_then(|m| m.modified()).ok(), revision);
        let mut months = self.months.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((seen, month)) = months.get(&key) {
            if *seen == modified {
                return Some(month.clone());
            }
        }
        let shioaji = source.eq_ignore_ascii_case("shioaji");
        let dates = match published_dates(&dir) {
            Ok(dates) => dates,
            Err(why) => {
                self.track_corruption(source, &format!("{trading_date} 量比"), &Lookup::Corrupt(why));
                return None;
            }
        };
        let wanted: Vec<String> = dates.into_iter().rev().filter(|d| d.as_str() < trading_date)
            .filter(|d| !shioaji || calendar.is_trading_day(d)).take(MONTH_DAYS).collect();
        let mut days = Vec::new();
        for date in wanted {
            let answer = match load_published(&dir, &date) {
                Ok(day) => Lookup::Ready(Arc::new(day)),
                Err(why) => Lookup::Corrupt(why),
            };
            self.track_corruption(source, &format!("{date} 量比"), &answer);
            if let Lookup::Ready(day) = answer {
                days.push(day);
            }
        }
        let month = Arc::new(Month { days });
        months.insert(key, (modified, month.clone()));
        Some(month)
    }

    fn track_corruption(&self, source: &str, trading_date: &str, answer: &Lookup) {
        let key = format!("{source}/{trading_date}");
        let mut corrupt = self.corrupt.lock().unwrap_or_else(|e| e.into_inner());
        match answer {
            Lookup::Corrupt(why) => match corrupt.get_mut(&key) {
                Some((current, reads, _)) => { *current = why.clone(); *reads += 1; }
                None => {
                    eprintln!("[analysis_runtime] volume baseline for {source} {trading_date} unreadable: {why}");
                    let operation = remediation::begin("volume_baseline", "analysis.volume_baseline_corrupt", "baseline_unreadable",
                        remediation::Identity::default(), json!({"source": source, "trading_date": trading_date, "why": why}));
                    corrupt.insert(key, (why.clone(), 1, Some(operation)));
                }
            },
            _ => {
                if let Some((why, reads, Some(mut operation))) = corrupt.remove(&key) {
                    operation.finish("succeeded", Some(reads), json!({"source": source, "trading_date": trading_date,
                        "was": why, "now": answer.state()}));
                }
            }
        }
    }

    /// For B's metrics: how many lookups are in each state, and every baseline unreadable now with why.
    pub fn status(&self) -> Value {
        let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut states: BTreeMap<&'static str, u64> = BTreeMap::new();
        for (_, answer) in cache.values() {
            *states.entry(answer.state()).or_insert(0) += 1;
        }
        let corrupt: BTreeMap<String, Value> = self.corrupt.lock().unwrap_or_else(|e| e.into_inner()).iter()
            .map(|(key, (why, _, _))| (key.clone(), json!(why))).collect();
        json!({"states": states, "corrupt": corrupt})
    }
}

/// The dates with a manifest, oldest first. Err: the directory exists but cannot be listed.
fn published_dates(dir: &Path) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    let mut dates: Vec<String> = entries.filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let date = name.strip_suffix(".manifest.json")?.to_string();
            parse_calendar_date(&date).is_some().then_some(date)
        })
        .collect();
    dates.sort();
    Ok(dates)
}

/// The one manifest layout read (service/market/projection/volume_baseline_service.py MANIFEST_SCHEMA). It names the
/// twin's content hash, codes and rows; a manifest of another schema is refused as CORRUPT, with the reason.
const MANIFEST_SCHEMA: &str = "volume-baseline-manifest-v2";

// FNV-1a 64 as 16 hex digits (the Python publisher's `fnv1a64`).
use market_runtime::replay::fnv1a64;

/// The date's baseline through its manifest: the twin it names, checked against it (schema, date, content hash,
/// codes, rows). Err: why it cannot be used.
fn load_published(dir: &Path, date: &str) -> Result<Day, String> {
    let manifest_path = dir.join(format!("{date}.manifest.json"));
    let manifest: Value = std::fs::read(&manifest_path).map_err(|e| format!("{}: {e}", manifest_path.display()))
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", manifest_path.display())))?;
    let schema = manifest.get("schema").and_then(Value::as_str).unwrap_or("");
    if schema != MANIFEST_SCHEMA {
        return Err(format!("{}: manifest schema {schema:?}; only {MANIFEST_SCHEMA} is read", manifest_path.display()));
    }
    if manifest.get("date").and_then(Value::as_str) != Some(date) {
        return Err(format!("{}: not a baseline manifest of {date}", manifest_path.display()));
    }
    let missing = |field: &str| format!("{}: no {field}", manifest_path.display());
    let want_hash = manifest.get("json_fnv1a64").and_then(Value::as_str).ok_or_else(|| missing("json_fnv1a64"))?;
    let want_codes = manifest.get("codes").and_then(Value::as_array).ok_or_else(|| missing("codes"))?;
    let want_rows = manifest.get("rows").and_then(Value::as_u64).ok_or_else(|| missing("rows"))?;
    let name = manifest.get("json").and_then(Value::as_str).filter(|n| !n.contains(['/', '\\']))
        .ok_or_else(|| format!("{}: names no JSON twin", manifest_path.display()))?;
    let path = dir.join(name);
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let got = fnv1a64(&bytes);
    if got != want_hash {
        return Err(format!("{}: content hash {got}, its manifest says {want_hash}", path.display()));
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    if body.get("date").and_then(Value::as_str) != Some(date) {
        return Err(format!("{}: not the baseline of {date}", path.display()));
    }
    let Some(object) = body.get("items").and_then(Value::as_object) else {
        return Err(format!("{}: no items", path.display()));
    };
    let mut items = HashMap::new();
    let mut rows = 0u64;
    for (code, minutes) in object {
        let per: HashMap<i32, f64> = minutes.as_object().into_iter().flatten()
            .filter_map(|(hhmm, v)| Some((clock_minute(hhmm)?, v.as_f64().filter(|f| f.is_finite())?)))
            .collect();
        rows += per.len() as u64;
        items.insert(code.trim().to_uppercase(), per);
    }
    let mut want: Vec<String> = want_codes.iter().filter_map(Value::as_str).map(|c| c.trim().to_uppercase()).collect();
    let mut got: Vec<String> = items.keys().cloned().collect();
    want.sort();
    got.sort();
    if want != got {
        return Err(format!("{}: codes {:?} differ from its manifest's {:?}", path.display(), got, want));
    }
    if want_rows != rows {
        return Err(format!("{}: {rows} rows, its manifest says {want_rows}", path.display()));
    }
    let span = items.values().flat_map(|per| per.keys().copied())
        .fold(None, |span: Option<(i32, i32)>, m| Some(span.map_or((m, m), |(a, b)| (a.min(m), b.max(m)))));
    Ok(Day { date: date.to_string(), items, span })
}

/// "HH:MM" -> minute of the day.
pub fn clock_minute(text: &str) -> Option<i32> {
    let (h, m) = text.split_once(':')?;
    let (h, m) = (h.trim().parse::<i32>().ok()?, m.trim().get(..2).unwrap_or(m.trim()).parse::<i32>().ok()?);
    ((0..24).contains(&h) && (0..60).contains(&m)).then_some(h * 60 + m)
}

/// The wall-clock "HH:MM" of a session minute. A futures night counts on past its opening day's midnight (01:38 the
/// next morning is minute 1538), so the clock wraps at 24 hours: "01:38", never "25:38".
pub fn clock_text(minute: i32) -> String {
    format!("{:02}:{:02}", minute.rem_euclid(1440) / 60, minute.rem_euclid(60))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Publishes a date the way VolumeBaselineService does: the twin, then its manifest.
    fn publish(dir: &Path, date: &str, items: &str) {
        let body = format!(r#"{{"schema":"volume-baseline-v1","date":"{date}","items":{items}}}"#);
        let value: Value = serde_json::from_str(&body).unwrap();
        let codes: Vec<String> = value["items"].as_object().unwrap().keys().cloned().collect();
        let rows: usize = value["items"].as_object().unwrap().values().map(|m| m.as_object().unwrap().len()).sum();
        let name = format!("{date}.g1.json");
        std::fs::write(dir.join(&name), &body).unwrap();
        std::fs::write(dir.join(format!("{date}.manifest.json")), json!({"schema": "volume-baseline-manifest-v2", "date": date,
            "json": name, "parquet": format!("{date}.g1.parquet"), "json_fnv1a64": fnv1a64(body.as_bytes()),
            "codes": codes, "rows": rows}).to_string()).unwrap();
    }

    fn touch(dir: &Path) {
        // a republish creates and renames files: the directory itself changes (overwriting one file would not)
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = std::fs::remove_file(dir.join("touch.tmp"));
        let _ = std::fs::write(dir.join("touch.tmp"), "x");
    }

    #[test]
    fn a_date_compares_against_the_previous_published_session_of_its_own_source() {
        let root = std::env::temp_dir().join(format!("b-baseline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("shioaji").join("volume_baseline");
        let futu = root.join("futu").join("volume_baseline");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&futu).unwrap();
        publish(&dir, "2026-09-30", r#"{"2330":{"09:01":10}}"#);
        publish(&dir, "2026-10-02", r#"{"2330":{"09:01":40,"13:30":900}}"#);
        publish(&dir, "2026-10-05", r#"{"2330":{"09:01":1}}"#);
        publish(&futu, "2026-10-07", r#"{"US.TSM":{"00:40":3,"22:00":7}}"#);
        let store = Store::new(Some(root.clone()));
        // Monday 10-05 compares with Friday 10-02, never with itself or later.
        let lookup = store.for_date("shioaji", "2026-10-05");
        let day = lookup.day().expect("baseline");
        assert_eq!(day.date, "2026-10-02");
        assert_eq!(day.items["2330"][&541], 40.0);
        assert_eq!(day.items["2330"][&810], 900.0);
        assert_eq!(store.for_date("shioaji", "2026-09-30").state(), "NOT_YET", "nothing before the first date");
        // Futu US: its own directory, overnight minutes included.
        let us = store.for_date("futu", "2026-10-08");
        let us = us.day().expect("futu baseline");
        assert_eq!((us.date.as_str(), us.items["US.TSM"][&40], us.items["US.TSM"][&1320]), ("2026-10-07", 3.0, 7.0));
        assert_eq!(store.for_date("futu", "2026-10-07").state(), "NOT_YET", "a source never reads another source's files");
        // An unreadable twin is CORRUPT (with why), not "no baseline"; a republished date is read again.
        publish(&dir, "2026-10-06", r#"{"2330":{"09:01":5}}"#);
        std::fs::write(dir.join("2026-10-06.g1.json"), "{not json").unwrap();
        touch(&dir);
        let broken = store.for_date("shioaji", "2026-10-07");
        assert_eq!(broken.state(), "CORRUPT");
        assert!(broken.reason().unwrap().contains("2026-10-06.g1.json"));
        assert!(store.status()["corrupt"]["shioaji/2026-10-07"].is_string());
        publish(&dir, "2026-10-06", r#"{"2330":{"09:01":5}}"#);
        touch(&dir);
        assert_eq!(store.for_date("shioaji", "2026-10-07").state(), "READY", "the directory changed: asked again");
        assert!(store.status()["corrupt"].as_object().is_some_and(|c| c.is_empty()), "repaired: no longer listed (CX-85)");
        // 10-08's previous session is 10-07. Until it is published 10-06 does not stand in; once it is the
        // READY answer is replaced (the directory changed).
        assert_eq!(store.for_date("shioaji", "2026-10-08").state(), "NOT_YET");
        publish(&dir, "2026-10-07", r#"{"2330":{"09:01":8}}"#);
        touch(&dir);
        assert_eq!(store.for_date("shioaji", "2026-10-08").day().map(|d| d.date.clone()).as_deref(), Some("2026-10-07"));
        // A READY answer is looked at again when a newer previous session is published (Futu: newest earlier date).
        assert_eq!(store.for_date("futu", "2026-10-09").day().map(|d| d.date.clone()).as_deref(), Some("2026-10-07"));
        publish(&futu, "2026-10-08", r#"{"US.TSM":{"00:40":9}}"#);
        touch(&futu);
        assert_eq!(store.for_date("futu", "2026-10-09").day().map(|d| d.date.clone()).as_deref(), Some("2026-10-08"));
        assert_eq!(clock_minute("09:05"), Some(545));
        assert_eq!(clock_text(545), "09:05");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_month_averages_each_minute_over_the_sessions_that_recorded_it() {
        let root = std::env::temp_dir().join(format!("b-baseline-month-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("shioaji").join("volume_baseline");
        std::fs::create_dir_all(&dir).unwrap();
        // 10-07: a full session (09:01 .. 13:30); 2330 traded nothing at 09:02.
        publish(&dir, "2026-10-07", r#"{"2330":{"09:01":10,"09:03":30},"2317":{"13:30":5}}"#);
        // 10-08: recording stopped after 09:02 (a login expiry): 09:03 is not "nothing traded" that day.
        publish(&dir, "2026-10-08", r#"{"2330":{"09:01":20,"09:02":40}}"#);
        // a twin with no manifest is never a session; a Saturday file is not a TWSE session
        std::fs::write(dir.join("2026-10-06.json"), r#"{"date":"2026-10-06","items":{"2330":{"09:01":999}}}"#).unwrap();
        publish(&dir, "2026-10-10", r#"{"2330":{"09:01":999}}"#);
        let store = Store::new(Some(root.clone()));
        let month = store.month_for_date("shioaji", "2026-10-12").unwrap();
        assert_eq!(month.days.iter().map(|d| d.date.as_str()).collect::<Vec<_>>(), ["2026-10-08", "2026-10-07"], "newest first");
        // 09:01 = (10 + 20) / 2; 09:02 = (0 + 40) / 2; 09:03 = 30 (10-08 did not record it)
        assert_eq!(month.usual("2330", 541, 541, 1.0), Some((15.0, 2)));
        assert_eq!(month.usual("2330", 541, 543, 1.0), Some((15.0 + 20.0 + 30.0, 2)));
        // the last minute still in progress counts its elapsed share
        assert_eq!(month.usual("2330", 543, 543, 0.5), Some((15.0, 1)));
        // a minute no session recorded: no usual volume at all
        assert_eq!(month.usual("2330", 530, 541, 1.0), None);
        // a code with no row in a covering session traded nothing there
        assert_eq!(month.usual("2454", 541, 541, 1.0), Some((0.0, 2)));
        assert!(store.month_for_date("shioaji", "2026-10-07").unwrap().days.is_empty(), "only sessions before the date");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_a_manifest_publishes_and_a_shioaji_baseline_must_be_the_previous_session() {
        let root = std::env::temp_dir().join(format!("b-baseline-strict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("shioaji").join("volume_baseline");
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::new(Some(root.clone()));
        // a twin with no manifest (a build interrupted before it) is no baseline
        std::fs::write(dir.join("2026-10-02.json"), r#"{"date":"2026-10-02","items":{"2330":{"09:01":40}}}"#).unwrap();
        assert_eq!(store.for_date("shioaji", "2026-10-05").state(), "NOT_YET");
        // a twin that is not what its manifest says is CORRUPT
        publish(&dir, "2026-10-02", r#"{"2330":{"09:01":40}}"#);
        std::fs::write(dir.join("2026-10-02.g1.json"), r#"{"schema":"volume-baseline-v1","date":"2026-10-02","items":{"2330":{"09:01":41}}}"#).unwrap();
        touch(&dir);
        assert!(store.for_date("shioaji", "2026-10-05").reason().unwrap().contains("content hash"));
        publish(&dir, "2026-10-02", r#"{"2330":{"09:01":40}}"#);
        touch(&dir);
        assert_eq!(store.for_date("shioaji", "2026-10-05").state(), "READY");
        // a Saturday baseline (not a TWSE session) between Friday and Monday is CORRUPT, never Monday's baseline
        publish(&dir, "2026-10-03", r#"{"2330":{"09:01":1}}"#);
        touch(&dir);
        let stray = store.for_date("shioaji", "2026-10-05");
        assert_eq!(stray.state(), "CORRUPT");
        assert!(stray.reason().unwrap().contains("2026-10-03"));
        std::fs::remove_file(dir.join("2026-10-03.manifest.json")).unwrap();
        // A manifest of the older v1 layout (no content hash, codes or rows) is refused as CORRUPT, with the reason.
        let body = r#"{"schema":"volume-baseline-v1","date":"2026-10-02","items":{"2330":{"09:01":40}}}"#;
        std::fs::write(dir.join("2026-10-02.v1.json"), body).unwrap();
        std::fs::write(dir.join("2026-10-02.manifest.json"), json!({"schema": "volume-baseline-manifest-v1", "date": "2026-10-02",
            "json": "2026-10-02.v1.json", "parquet": "2026-10-02.v1.parquet"}).to_string()).unwrap();
        touch(&dir);
        let older = store.for_date("shioaji", "2026-10-05");
        assert_eq!(older.state(), "CORRUPT");
        assert!(older.reason().unwrap().contains("volume-baseline-manifest-v1"), "{:?}", older.reason());
        let _ = std::fs::remove_dir_all(&root);
    }
}
