//! Session rollover (user rule). Rust A and Rust B hold a session as a cache from its open until that
//! session's next pre-open, across restarts; at the pre-open the previous session leaves both, on time, whether or
//! not the instrument has any 試撮. What was written to the WAL and the historical partitions is never touched here.
//!
//! Shioaji only (Futu has its own rules): stock / index / futures DAY roll at 08:30 of a trading day, the futures
//! NIGHT at 14:50. A futures NIGHT partition is dated by the day it opens, so on trading day T the 14:50 rollover
//! drops the night that opened on the previous trading day, and the 08:30 one drops the previous DAY: 日盤 keeps
//! today's day session until the next morning, 夜盤 keeps a night until the next afternoon.
//!
//! A rollover is a per-family cutoff date: a partition of that family dated before it is gone. Cutoffs only move
//! forward, are checkpointed with the engine, and are handed to Rust B so both drop the same partitions.
//!
//! A Shioaji session rolls in on its first print, not on the clock (user 10-23): from the pre-open on, the first
//! event whose exchange time is at or after that pre-open opens the session ([`Opened`]), and every family of its
//! group rolls then (stock, index and futures DAY together on any of their events; the futures NIGHT on a NIGHT
//! event). A calendar trading day that has no event by 09:00, the broker connected since before 08:30, is an observed closure (a
//! typhoon day): it is recorded in [`MarketSessions`] and from then on is not a trading day. Until the first print the
//! screens keep the previous session -- on a closure day, all day.
//!
//! Futu (user rule). A Futu stock market (US, HK, ...) is partitioned by its venue-local calendar date;
//! the US display window runs 20:00 -> 20:00 and so spans two partitions. Its cache -- and its stored partitions --
//! keep the current session and the previous one: at the venue's midnight, the partition before the previous trading
//! day leaves. Futu crypto (CC) is never stored at all; A and B clear it at New York 00:00 (`clears`).

use crate::event::{civil_from_days, days_from_civil, futures_partition, is_session_partitioned, market_local_minute, parse_calendar_date};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// 08:30, Taipei: the stock and futures day pre-open.
pub const DAY_PREOPEN_MINUTE: i32 = 8 * 60 + 30;
/// 14:50, Taipei: the futures night pre-open.
pub const NIGHT_PREOPEN_MINUTE: i32 = 14 * 60 + 50;

const EMBEDDED_HOLIDAYS: &str = include_str!("../../../config/market_holidays.json");
const HOLIDAYS_SCHEMA: &str = "market-holidays-v1";

/// The longest run of consecutive non-trading days a calendar may hold (a long holiday plus its weekends is about two
/// weeks). A file implying a longer run is refused when it is loaded, so the trading-day searches below always end.
pub const MAX_CLOSED_RUN_DAYS: i64 = 40;

/// config/market_holidays.json, the shape scripts/tooling/update_market_holidays.py writes and
/// config/market_holidays.py reads: per TWSE year, the closed weekdays and the extra trading days; per NYSE year, the
/// closed weekdays and the half days (closing early, 13:00 New York).
#[derive(Deserialize)]
struct HolidaysFile {
    schema: String,
    markets: HolidayMarkets,
}

#[derive(Deserialize)]
struct HolidayMarkets {
    #[serde(rename = "TWSE")]
    twse: HolidayMarket,
    #[serde(rename = "NYSE")]
    nyse: Option<HolidayMarket>,
}

#[derive(Deserialize)]
struct HolidayMarket {
    years: BTreeMap<String, HolidayYear>,
}

#[derive(Deserialize)]
struct HolidayYear {
    #[serde(default)]
    closed: Vec<HolidayDay>,
    #[serde(default)]
    trading: Vec<HolidayDay>,
    /// NYSE only: the days that close early.
    #[serde(default)]
    half: Vec<HolidayDay>,
}

#[derive(Deserialize)]
struct HolidayDay {
    date: String,
    /// The US calendar's `trade_date_type`: WHOLE, or MORNING for a day that closes early.
    #[serde(default)]
    kind: String,
}

/// A real `YYYY-MM-DD` calendar date as a day number (days since 1970-01-01), the one form the searches move.
pub(crate) fn day_number(date: &str) -> Option<i64> {
    let (y, m, d) = parse_calendar_date(date)?;
    Some(days_from_civil(y, m, d))
}

pub(crate) fn date_of(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// TWSE (or NYSE) trading days: weekdays not in config/market_holidays.json's `closed`, plus its `trading` days (the
/// rule config/market_holidays.py applies). A year the file does not cover yet falls back to weekdays only (the file
/// is refreshed by hand once a year).
#[derive(Debug, Clone, Default)]
pub struct TradingCalendar {
    closed: BTreeSet<i64>,
    trading: BTreeSet<i64>,
    /// `YYYY-MM-DD` of the days that close early (NYSE's half days; OpenD's MORNING days inside its window).
    half_days: BTreeSet<String>,
    /// The years the holidays file lists.
    years: BTreeSet<i64>,
}

impl TradingCalendar {
    /// The calendar a holidays file describes. Every listed date must be a real date of the year it is listed under,
    /// and the file must leave no run of non-trading days longer than [`MAX_CLOSED_RUN_DAYS`]; anything else is an
    /// error naming the entry, never a calendar with the bad rows left out.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let file = Self::holidays_file(text)?;
        let market = &file.markets.twse;
        if let Some((year, _)) = market.years.iter().find(|(_, entry)| !entry.half.is_empty()) {
            return Err(format!("TWSE.{year}.half: TWSE has no half days"));
        }
        Self::from_market("TWSE", market)
    }

    /// The NYSE trading days a holidays file describes: weekdays not in its `closed`, and its `half` days closing
    /// early. Every half day must be a trading weekday of its year.
    pub fn nyse_from_json(text: &str) -> Result<Self, String> {
        let file = Self::holidays_file(text)?;
        let market = file.markets.nyse.as_ref().ok_or("the file has no NYSE market")?;
        if let Some((year, _)) = market.years.iter().find(|(_, entry)| !entry.trading.is_empty()) {
            return Err(format!("NYSE.{year}.trading: NYSE lists no extra trading days"));
        }
        Self::from_market("NYSE", market)
    }

    fn holidays_file(text: &str) -> Result<HolidaysFile, String> {
        let file: HolidaysFile = serde_json::from_str(text).map_err(|e| format!("not a holidays file: {e}"))?;
        if file.schema != HOLIDAYS_SCHEMA {
            return Err(format!("schema {:?}, expected {HOLIDAYS_SCHEMA:?}", file.schema));
        }
        Ok(file)
    }

    fn from_market(name: &str, market: &HolidayMarket) -> Result<Self, String> {
        let mut calendar = Self::default();
        let mut half = BTreeSet::new();
        for (year, entry) in &market.years {
            let year_number: i64 = year.parse().ok().filter(|y| (1900..=9999).contains(y))
                .ok_or_else(|| format!("{name}: year key {year:?} is not a year"))?;
            calendar.years.insert(year_number);
            for (list, days, into) in [("closed", &entry.closed, &mut calendar.closed), ("trading", &entry.trading, &mut calendar.trading),
                                       ("half", &entry.half, &mut half)] {
                for day in days {
                    let parsed = parse_calendar_date(&day.date)
                        .ok_or_else(|| format!("{name}.{year}.{list}: {:?} is not a YYYY-MM-DD date", day.date))?;
                    if parsed.0 != year_number {
                        return Err(format!("{name}.{year}.{list}: {} is listed under the wrong year", day.date));
                    }
                    into.insert(days_from_civil(parsed.0, parsed.1, parsed.2));
                }
            }
        }
        if let Some(both) = calendar.closed.intersection(&calendar.trading).next() {
            return Err(format!("{name}: {} is listed both closed and trading", date_of(*both)));
        }
        if let Some(day) = half.iter().find(|day| !calendar.trades(**day)) {
            return Err(format!("{name}: half day {} is not a trading day", date_of(*day)));
        }
        calendar.half_days = half.into_iter().map(date_of).collect();
        calendar.check_closed_runs()?;
        Ok(calendar)
    }

    /// The file at `path` when one is named, else the copy built into the binary. A named file that cannot be read
    /// or does not validate is an error: the built-in copy may be a year behind it, so it never stands in silently.
    pub fn load(path: Option<&Path>) -> Result<Self, String> {
        Self::load_with(path, Self::from_json)
    }

    /// The NYSE calendar of the same file (`load`'s rules).
    pub fn load_nyse(path: Option<&Path>) -> Result<Self, String> {
        Self::load_with(path, Self::nyse_from_json)
    }

    fn load_with(path: Option<&Path>, parse: fn(&str) -> Result<Self, String>) -> Result<Self, String> {
        match path {
            Some(path) => std::fs::read_to_string(path)
                .map_err(|e| format!("{}: {e}", path.display()))
                .and_then(|text| parse(&text).map_err(|e| format!("{}: {e}", path.display()))),
            None => parse(EMBEDDED_HOLIDAYS).map_err(|e| format!("built-in market_holidays.json: {e}")),
        }
    }

    /// Whether the file listed `year` (a year it does not list falls back to weekdays only).
    pub fn covers_year(&self, year: i64) -> bool {
        self.years.contains(&year)
    }

    fn check_closed_runs(&self) -> Result<(), String> {
        for &closed in &self.closed {
            let mut day = closed;
            let mut run = 0;
            while !self.trades(day) {
                run += 1;
                if run > MAX_CLOSED_RUN_DAYS {
                    return Err(format!("{} starts more than {MAX_CLOSED_RUN_DAYS} non-trading days in a row", date_of(closed)));
                }
                day += 1;
            }
        }
        Ok(())
    }

    pub(crate) fn trades(&self, day: i64) -> bool {
        // 1970-01-01 was a Thursday.
        let weekday = (day + 3).rem_euclid(7); // 0 = Monday
        (weekday < 5 && !self.closed.contains(&day)) || self.trading.contains(&day)
    }

    /// Whether `date` is a trading day; a string that is not a real `YYYY-MM-DD` date is not one.
    pub fn is_trading_day(&self, date: &str) -> bool {
        day_number(date).is_some_and(|day| self.trades(day))
    }

    /// The trading day before `date`; None when `date` is not a real `YYYY-MM-DD` date.
    pub fn previous_trading_day(&self, date: &str) -> Option<String> {
        Some(date_of(self.trading_day_on_or_before(day_number(date)? - 1)))
    }

    /// The newest trading day on or before `day`. Ends within MAX_CLOSED_RUN_DAYS: `from_json` refuses a longer run,
    /// and weekdays alone leave runs of two.
    pub(crate) fn trading_day_on_or_before(&self, mut day: i64) -> i64 {
        while !self.trades(day) {
            day -= 1;
        }
        day
    }

    /// The oldest trading day on or after `day` (bounded like `trading_day_on_or_before`).
    fn trading_day_on_or_after(&self, mut day: i64) -> i64 {
        while !self.trades(day) {
            day += 1;
        }
        day
    }

    /// The trading day whose pre-open at `at_minute` is the newest one already reached at local (`day`, `minute`).
    fn last_preopen(&self, day: i64, minute: i32, at_minute: i32) -> String {
        if minute >= at_minute && self.trades(day) {
            date_of(day)
        } else {
            date_of(self.trading_day_on_or_before(day - 1))
        }
    }
}

/// Which opening an event can be evidence of: the day group (stock, index, futures DAY) or the futures NIGHT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpeningGroup {
    Day,
    Night,
}

impl OpeningGroup {
    /// The group of a Shioaji session event; None for anything else (Futu has its own rules, and the market clock
    /// scope is not a print).
    pub fn of(provider: &str, market: &str, session: &str, code: &str) -> Option<Self> {
        if !provider.eq_ignore_ascii_case("shioaji") || code == crate::event::CLOCK_CODE {
            return None;
        }
        match (market.to_uppercase().as_str(), session.to_uppercase().as_str()) {
            ("FUT", "NIGHT") => Some(Self::Night),
            ("STK" | "ODD" | "IDX" | "FUT", "DAY") => Some(Self::Day),
            _ => None,
        }
    }

    fn preopen_minute(self) -> i32 {
        match self {
            Self::Day => DAY_PREOPEN_MINUTE,
            Self::Night => NIGHT_PREOPEN_MINUTE,
        }
    }
}

/// The newest Shioaji sessions that have opened (seen their first print): `day` for stock / index / futures DAY,
/// `night` for the futures NIGHT (dated by the day it opens). Empty: none seen yet.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Opened {
    pub day: String,
    pub night: String,
}

impl Opened {
    pub fn get(&self, group: OpeningGroup) -> &str {
        match group {
            OpeningGroup::Day => &self.day,
            OpeningGroup::Night => &self.night,
        }
    }

    /// Takes `date` as opened for `group` when it is newer; returns whether it moved.
    pub fn advance(&mut self, group: OpeningGroup, date: &str) -> bool {
        let current = match group {
            OpeningGroup::Day => &mut self.day,
            OpeningGroup::Night => &mut self.night,
        };
        if date <= current.as_str() {
            return false;
        }
        *current = date.to_owned();
        true
    }

    /// The session (`group`, `trading_date`) opens on an event printed at exchange time `exchange_ns` and received at
    /// wall time `now_ns` when the clock has reached that session's pre-open and the print is from that pre-open on (a
    /// snapshot of the last session carries that session's time). Returns whether it moved.
    pub fn observe(&mut self, calendar: &TradingCalendar, group: OpeningGroup, trading_date: &str, exchange_ns: i64, now_ns: i64) -> bool {
        let (Some(preopen), Some(due)) = (taipei_minute_ns(trading_date, group.preopen_minute()), due(calendar, group, now_ns)) else {
            return false;
        };
        exchange_ns >= preopen && trading_date <= due.as_str() && self.advance(group, trading_date)
    }
}

/// The session of `group` whose pre-open the clock reached last at `now_ns`; it is held only once it has opened.
pub fn due(calendar: &TradingCalendar, group: OpeningGroup, now_ns: i64) -> Option<String> {
    let (today, minute) = local_day("STK", now_ns)?;
    Some(calendar.last_preopen(today, minute, group.preopen_minute()))
}

/// The session of `group` held at `now_ns`: the one due when it has opened, else the trading day before it.
fn held(calendar: &TradingCalendar, opened: &Opened, group: OpeningGroup, now_ns: i64) -> Option<String> {
    let due = due(calendar, group, now_ns)?;
    if due.as_str() <= opened.get(group) {
        return Some(due);
    }
    calendar.previous_trading_day(&due)
}

/// The holidays calendar with the closures in A's sessions file, read again whenever the file's modification time
/// changes (Rust B: A writes the file while both run). `revision` counts the reloads, so a cache keyed by it drops
/// what an earlier calendar decided.
pub struct FollowedCalendar {
    base: TradingCalendar,
    path: Option<std::path::PathBuf>,
    state: std::sync::Mutex<Followed>,
}

struct Followed {
    modified: Option<std::time::SystemTime>,
    calendar: TradingCalendar,
    revision: u64,
    error: String,
}

impl Default for FollowedCalendar {
    /// Weekdays alone, no sessions file.
    fn default() -> Self {
        Self::new(TradingCalendar::default(), None).expect("no sessions file to read")
    }
}

impl FollowedCalendar {
    /// `base` with the closures of the sessions file at `path` (None: `base` alone). A file that cannot be read or
    /// does not validate is an error at the start, like the holidays file.
    pub fn new(base: TradingCalendar, path: Option<std::path::PathBuf>) -> Result<Self, String> {
        let followed = Self { base: base.clone(), path, state: std::sync::Mutex::new(Followed { modified: None, calendar: base, revision: 0, error: String::new() }) };
        if let Some(path) = followed.path.as_deref() {
            let sessions = MarketSessions::load(path)?;
            let mut state = followed.state.lock().unwrap_or_else(|p| p.into_inner());
            state.modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
            state.calendar = followed.base.with_closures(&sessions.closures);
        }
        Ok(followed)
    }

    /// The current calendar and its revision. A file that changed and no longer validates keeps the last calendar
    /// and is logged once per distinct error (A writes it whole; a reader never sees half a file).
    pub fn get(&self) -> (u64, TradingCalendar) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(path) = self.path.as_deref() {
            let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
            if modified != state.modified {
                match MarketSessions::load(path) {
                    Ok(sessions) => {
                        state.calendar = self.base.with_closures(&sessions.closures);
                        state.revision += 1;
                        state.modified = modified;
                        state.error.clear();
                    }
                    Err(e) => {
                        if state.error != e {
                            eprintln!("[market sessions] reading {} failed, keeping the last calendar: {e}", path.display());
                            state.error = e;
                        }
                    }
                }
            }
        }
        (state.revision, state.calendar.clone())
    }
}

const US_CALENDAR_SCHEMA: &str = "us-trading-calendar-v1";

/// The US exchange calendar OpenD published, as the Futu provider writes it (service/market/futu/trading_calendar.py,
/// read by config/market_holidays.py too): a window and the days in it that trade.
#[derive(Deserialize)]
struct UsCalendarFile {
    schema: String,
    from: String,
    to: String,
    #[serde(default)]
    days: Vec<HolidayDay>,
}

impl TradingCalendar {
    pub fn half_days(&self) -> &BTreeSet<String> {
        &self.half_days
    }

    /// Whether `date` closes early.
    pub fn is_half_day(&self, date: &str) -> bool {
        self.half_days.contains(date)
    }

    /// US trading days: this calendar (the NYSE days of config/market_holidays.json) with OpenD's calendar laid over
    /// it: within the file's window a day trades exactly when it is listed and closes early when listed MORNING;
    /// outside it, this calendar stands. OpenD is the newer word inside its window (a closure announced after the
    /// holidays file was written).
    pub fn with_us_calendar(&self, text: &str) -> Result<Self, String> {
        let file: UsCalendarFile = serde_json::from_str(text).map_err(|e| format!("not a US calendar file: {e}"))?;
        if file.schema != US_CALENDAR_SCHEMA {
            return Err(format!("schema {:?}, expected {US_CALENDAR_SCHEMA:?}", file.schema));
        }
        let first = day_number(&file.from).ok_or_else(|| format!("from: {:?} is not a YYYY-MM-DD date", file.from))?;
        let last = day_number(&file.to).ok_or_else(|| format!("to: {:?} is not a YYYY-MM-DD date", file.to))?;
        if first > last {
            return Err(format!("the window {}..{} is empty", file.from, file.to));
        }
        let mut listed = BTreeSet::new();
        let mut half = BTreeSet::new();
        for day in &file.days {
            let number = day_number(&day.date).ok_or_else(|| format!("days: {:?} is not a YYYY-MM-DD date", day.date))?;
            if !(first..=last).contains(&number) {
                return Err(format!("days: {} is outside the window {}..{}", day.date, file.from, file.to));
            }
            listed.insert(number);
            if day.kind.eq_ignore_ascii_case("MORNING") {
                half.insert(date_of(number));
            }
        }
        let mut calendar = self.clone();
        let window = |day: &i64| (first..=last).contains(day);
        calendar.closed.retain(|day| !window(day));
        calendar.trading.retain(|day| !window(day));
        calendar.half_days.retain(|date| day_number(date).is_some_and(|day| !window(&day)));
        calendar.half_days.extend(half);
        for day in first..=last {
            let weekday = (day + 3).rem_euclid(7) < 5;
            match (weekday, listed.contains(&day)) {
                (true, false) => {
                    calendar.closed.insert(day);
                }
                (false, true) => {
                    calendar.trading.insert(day);
                }
                _ => {}
            }
        }
        calendar.check_closed_runs()?;
        Ok(calendar)
    }
}

/// The US trading calendar A judges by: the NYSE days of config/market_holidays.json (`base`), with the calendar OpenD
/// published laid over it (`with_us_calendar`), read again whenever that file's modification time changes (the Futu
/// provider rewrites it once per New York day). No file -- the provider has not read OpenD yet, or this run has no
/// Futu -- is the NYSE file alone; a file that does not validate keeps the last calendar and is logged once per
/// distinct error.
pub struct FollowedUsCalendar {
    base: TradingCalendar,
    path: Option<std::path::PathBuf>,
    state: std::sync::Mutex<(Option<std::time::SystemTime>, TradingCalendar, String)>,
}

impl FollowedUsCalendar {
    pub fn new(base: TradingCalendar, path: Option<std::path::PathBuf>) -> Self {
        Self { state: std::sync::Mutex::new((None, base.clone(), String::new())), base, path }
    }

    pub fn get(&self) -> TradingCalendar {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(path) = self.path.as_deref() {
            let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
            if modified != state.0 {
                let read = match modified {
                    None => Ok(self.base.clone()),
                    Some(_) => std::fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|text| self.base.with_us_calendar(&text)),
                };
                match read {
                    Ok(calendar) => *state = (modified, calendar, String::new()),
                    Err(e) => {
                        // Read again only once the provider replaces it.
                        state.0 = modified;
                        if state.2 != e {
                            eprintln!("[us trading calendar] reading {} failed, keeping the last calendar: {e}", path.display());
                            state.2 = e;
                        }
                    }
                }
            }
        }
        state.1.clone()
    }
}

/// The US calendar a process other than Rust A (Rust B's daemon and its materialization jobs) follows for the half
/// days its Calendars split by (crate::calendar::is_half_day): the same files A reads, so A and B shorten the same days.
static FOLLOWED_US_DAYS: std::sync::OnceLock<FollowedUsCalendar> = std::sync::OnceLock::new();

/// Follow `us` from now on and install its half days at once. A process follows one calendar; a second call keeps the
/// first and only installs.
pub fn follow_us_half_days(us: FollowedUsCalendar) {
    crate::calendar::install_half_days(us.get().half_days().clone());
    let _ = FOLLOWED_US_DAYS.set(us);
}

/// Install the followed calendar's half days again (its file may have been rewritten since): at each rollover.
pub fn refresh_us_half_days() {
    if let Some(us) = FOLLOWED_US_DAYS.get() {
        crate::calendar::install_half_days(us.get().half_days().clone());
    }
}

/// `ts_ns` as a Taipei-local `YYYY-MM-DDTHH:MM+08:00` (the sessions file's times).
pub fn taipei_stamp(ts_ns: i64) -> String {
    market_local_minute("STK", ts_ns)
        .map(|(date, minute)| format!("{date}T{:02}:{:02}+08:00", minute / 60, minute % 60))
        .unwrap_or_default()
}

/// UTC ns of Taipei-local `date` at `minute`; None when `date` is not a real `YYYY-MM-DD` date.
pub fn taipei_minute_ns(date: &str, minute: i32) -> Option<i64> {
    Some((day_number(date)? * 86_400 + minute as i64 * 60 - 8 * 3600) * 1_000_000_000)
}

const SESSIONS_SCHEMA: &str = "market-sessions-v1";

/// A day the calendar listed as trading on which no Shioaji event came by 09:00 while the broker was connected.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
pub struct ObservedClosure {
    pub date: String,
    pub observed_at: String,
    pub reason: String,
}

/// `<A data dir>/market_sessions.json`, written by Rust A only: the sessions that have opened and the closures it
/// observed. Rust B and Python (config/market_holidays.py) read it again whenever it changes: an observed closure is
/// a non-trading day for all of them, and the opened day is when the screens and the lanes move to the new day.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarketSessions {
    pub opened: Opened,
    pub closures: Vec<ObservedClosure>,
}

#[derive(serde::Serialize, Deserialize)]
struct SessionsFile {
    schema: String,
    opened: SessionsOpened,
    #[serde(default)]
    closures: Vec<ObservedClosure>,
}

#[derive(serde::Serialize, Deserialize)]
struct SessionsOpened {
    day: String,
    night: String,
}

impl MarketSessions {
    /// The file at `path`; an absent file is no sessions yet. A file that exists but cannot be read or does not
    /// validate is an error naming it.
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()), // not an error: a first start
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        Self::from_json(&text).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn from_json(text: &str) -> Result<Self, String> {
        let file: SessionsFile = serde_json::from_str(text).map_err(|e| format!("not a market sessions file: {e}"))?;
        if file.schema != SESSIONS_SCHEMA {
            return Err(format!("schema {:?}, expected {SESSIONS_SCHEMA:?}", file.schema));
        }
        let dates = [&file.opened.day, &file.opened.night].into_iter().filter(|d| !d.is_empty())
            .chain(file.closures.iter().map(|c| &c.date));
        for date in dates {
            if parse_calendar_date(date).is_none() {
                return Err(format!("{date:?} is not a YYYY-MM-DD date"));
            }
        }
        Ok(Self { opened: Opened { day: file.opened.day, night: file.opened.night }, closures: file.closures })
    }

    pub fn to_json(&self) -> String {
        let file = SessionsFile {
            schema: SESSIONS_SCHEMA.into(),
            opened: SessionsOpened { day: self.opened.day.clone(), night: self.opened.night.clone() },
            closures: self.closures.clone(),
        };
        serde_json::to_string_pretty(&file).expect("plain data serializes")
    }

    /// Writes the whole file (temp file renamed over it): a reader sees the old file or the new one.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        crate::fsutil::atomic_write(path, self.to_json().as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn is_closed(&self, date: &str) -> bool {
        self.closures.iter().any(|c| c.date == date)
    }
}

impl TradingCalendar {
    /// This calendar with the observed closures as closed days.
    pub fn with_closures(&self, closures: &[ObservedClosure]) -> Self {
        let mut calendar = self.clone();
        for day in closures.iter().filter_map(|c| day_number(&c.date)) {
            calendar.trading.remove(&day);
            calendar.closed.insert(day);
        }
        calendar
    }

    /// The date of today when `now_ns` is at or past 09:00 of a trading day whose day session has not opened: an
    /// observed closure when the broker has been connected since before the 08:30 pre-open (the caller's to know).
    pub fn unopened_at_open(&self, opened: &Opened, now_ns: i64) -> Option<String> {
        let (today, minute) = local_day("STK", now_ns)?;
        let date = date_of(today);
        (self.trades(today) && minute >= equity_span().0 && opened.day.as_str() < date.as_str()).then_some(date)
    }
}

/// The local civil day number and minute of `ts_ns` on `market`'s clock.
fn local_day(market: &str, ts_ns: i64) -> Option<(i64, i32)> {
    let (date, minute) = market_local_minute(market, ts_ns)?;
    Some((day_number(&date)?, minute))
}

/// The rollover family of a partition: `source|MARKET|SESSION`.
pub fn family(source: &str, market: &str, session: &str) -> String {
    format!("{}|{}|{}", source.trim().to_lowercase(), market.trim().to_uppercase(), session.trim().to_uppercase())
}

/// The Shioaji markets whose DAY session opens and rolls together: stocks, their 盤中零股 (ODD: the same stocks' odd-lot
/// book and prints, a market of its own), indices and the futures day session.
pub const SHIOAJI_DAY_MARKETS: [&str; 4] = ["STK", "ODD", "IDX", "FUT"];

/// Futu stock markets whose partitions roll (venue-local calendar date, WAL session FULL).
pub const FUTU_STOCK_MARKETS: [&str; 4] = ["US", "HK", "SH", "SZ"];

/// Every family's cutoff at `now_ns`: a partition of that family dated before its cutoff has been rolled over. A
/// Shioaji family moves to a session only once that session has opened.
pub fn cutoffs(calendar: &TradingCalendar, us: &TradingCalendar, opened: &Opened, now_ns: i64) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let (Some(day), Some(night)) = (held(calendar, opened, OpeningGroup::Day, now_ns), held(calendar, opened, OpeningGroup::Night, now_ns))
    else {
        return out;
    };
    for market in SHIOAJI_DAY_MARKETS {
        out.insert(family("shioaji", market, "DAY"), day.clone());
    }
    out.insert(family("shioaji", "FUT", "NIGHT"), night);
    let weekdays = TradingCalendar::default();
    for market in FUTU_STOCK_MARKETS {
        if let Some((local, _)) = local_day(market, now_ns) {
            // The US by A's US calendar (`us`: NYSE's days, OpenD's inside its window), the other markets by weekdays: the current session is the newest
            // trading day on or before today, and what is kept is it and the one before it. A US session runs
            // 20:00 -> 20:00, so it also needs the partition of the trading day before it: the previous session is
            // only whole with that one too.
            let days = if market == "US" { us } else { &weekdays };
            let current = days.trading_day_on_or_before(local);
            let mut cutoff = days.trading_day_on_or_before(current - 1);
            if market == "US" {
                cutoff = days.trading_day_on_or_before(cutoff - 1);
            }
            out.insert(family("futu", market, "FULL"), date_of(cutoff));
        }
    }
    out
}

/// The business session a subscription-coverage change at `now_ns` belongs to: the session in
/// progress, or else the next one -- never a date the market does not trade. `None`: the market is never stored.
///
/// Shioaji STK/IDX: today's DAY through its last trading minute (config/trading_sessions.json), then the next trading
/// day's. Shioaji FUT: the business
/// session (DAY / NIGHT dated by the day it opens) holding `now_ns` when that day trades, else the next trading
/// day's DAY. Futu stock markets: the venue-local trading day on or after today, FULL (the US by A's US calendar
/// `us`, the others by weekdays).
pub fn coverage_partition(calendar: &TradingCalendar, us: &TradingCalendar, source: &str, market: &str, now_ns: i64) -> Option<(String, String)> {
    let source = source.trim().to_lowercase();
    let market = market.trim().to_uppercase();
    if never_stored(&source, &market) {
        return None;
    }
    if is_session_partitioned(&source, &market) {
        let (date, session, _) = futures_partition(now_ns)?;
        let day = day_number(&date)?;
        if calendar.trades(day) {
            return Some((date, session.to_owned()));
        }
        return Some((date_of(calendar.trading_day_on_or_after(day)), "DAY".to_owned()));
    }
    let (day, minute) = local_day(&market, now_ns)?;
    if source == "shioaji" {
        if calendar.trades(day) && minute <= equity_span().1 {
            return Some((date_of(day), "DAY".to_owned()));
        }
        return Some((date_of(calendar.trading_day_on_or_after(day + 1)), "DAY".to_owned()));
    }
    let weekdays = TradingCalendar::default();
    let days = if market == "US" { us } else { &weekdays };
    Some((date_of(days.trading_day_on_or_after(day)), "FULL".to_owned()))
}

/// First and last trading minute of the Shioaji stock day session (config/trading_sessions.json `shioaji|STK`, inclusive
/// minute starts: [540, 810] is 09:00 through the 13:30 minute). Not hard-coded: a stock whose close is delayed still
/// prints after 13:30:00, and the minute the file names is the one the screens and the stored session share.
fn equity_span() -> (i32, i32) {
    let key = crate::calendar::CalKey { source: "shioaji", market: "STK", session: None, date: None };
    let segments = trading_sessions().segments(key);
    // The bundled file is parsed at build time and a market it does not name reads the unknown-market session, so
    // there is always a segment.
    let first = segments.iter().map(|s| s.start).min().expect("a calendar market always has a segment");
    (first, segments.iter().map(|s| s.end).max().expect("a calendar market always has a segment"))
}

/// The Shioaji stock session the screens show at `now_ns` (they read it from A, not from
/// FastAPI's display-session): the trading date is the stock DAY family's cutoff -- the newest session that has
/// opened, held until the next one opens -- and `live`/`phase` say where in that day `now_ns` is. `awaiting_open`:
/// today's pre-open has been reached and its first print has not come (all day on a closure day).
pub fn equity_session(calendar: &TradingCalendar, opened: &Opened, now_ns: i64) -> Option<Value> {
    let (day, minute) = local_day("STK", now_ns)?;
    let trading_date = held(calendar, opened, OpeningGroup::Day, now_ns)?;
    let awaiting_open = due(calendar, OpeningGroup::Day, now_ns)? == date_of(day) && trading_date != date_of(day);
    let today = trading_date == date_of(day);
    let (open, last) = equity_span();
    let phase = if !today || minute > last {
        "CLOSED"
    } else if minute >= open {
        "LIVE"
    } else {
        "PREOPEN"
    };
    Some(serde_json::json!({"trading_date": trading_date, "session": "DAY", "live": phase == "LIVE", "phase": phase,
                            "awaiting_open": awaiting_open}))
}

/// config/trading_sessions.json, parsed once: the session windows the screens' session identities name.
fn trading_sessions() -> &'static crate::calendar::Calendar {
    static SESSIONS: std::sync::OnceLock<crate::calendar::Calendar> = std::sync::OnceLock::new();
    SESSIONS.get_or_init(crate::calendar::Calendar::default)
}

/// First and last trading minute (inclusive minute starts) of a Shioaji FUT session's partition.
fn futures_span(session: &str) -> Option<(i32, i32)> {
    let key = crate::calendar::CalKey { source: "shioaji", market: "FUT", session: Some(session), date: None };
    let segments = trading_sessions().segments(key);
    Some((segments.iter().map(|s| s.start).min()?, segments.iter().map(|s| s.end).max()?))
}

/// Where Taipei-local (`day`, `minute`) is relative to a partition dated `date` spanning [first, last] partition
/// minutes (past 1440 = the next calendar day): PREOPEN before `first` on its own date, LIVE inside, CLOSED otherwise.
fn partition_phase(date: &str, first: i32, last: i32, day: i64, minute: i32) -> &'static str {
    let Some(start) = day_number(date) else { return "CLOSED" };
    let at = (day - start) * 1440 + minute as i64;
    if (first as i64..=last as i64).contains(&at) {
        "LIVE"
    } else if (0..first as i64).contains(&at) {
        "PREOPEN"
    } else {
        "CLOSED"
    }
}

fn futures_entry(session: &str, trading_date: &str, display_date: &str, phase: &str, window: (String, String), partitions: Value) -> Value {
    serde_json::json!({"trading_date": trading_date, "display_date": display_date, "session": session, "live": phase == "LIVE",
                       "phase": phase, "window_start": window.0, "window_end": window.1, "partitions": partitions})
}

/// The futures sessions the screens show at `now_ns` (日盤／夜盤／全日 tabs), the same rule as the stock session: each
/// tab holds the newest session of its family that has opened (the rollover cutoffs) until the next one opens.
/// 日盤 is the held DAY partition; 夜盤 the held NIGHT partition (dated by the day it opens); 全日 the TAIFEX trading
/// date T that the held night rolls into -- the night opened on the trading day before T and T's day -- and it moves to
/// the next T when a night opens. `partitions` are the WAL partitions each tab reads; windows are from
/// config/trading_sessions.json.
pub fn futures_sessions(calendar: &TradingCalendar, opened: &Opened, now_ns: i64) -> Option<Value> {
    let (today, minute) = local_day("FUT", now_ns)?;
    let day = held(calendar, opened, OpeningGroup::Day, now_ns)?;
    let night = held(calendar, opened, OpeningGroup::Night, now_ns)?;
    let (day_first, day_last) = futures_span("DAY")?;
    let (night_first, night_last) = futures_span("NIGHT")?;
    let window = |date: &str, first: i32, last: i32| -> Option<(String, String)> {
        Some((taipei_stamp(taipei_minute_ns(date, first)?), taipei_stamp(taipei_minute_ns(date, last)?)))
    };
    let day_phase = partition_phase(&day, day_first, day_last, today, minute);
    let night_phase = partition_phase(&night, night_first, night_last, today, minute);
    let after_night = date_of(calendar.trading_day_on_or_after(day_number(&night)? + 1));
    let full_date = if after_night > day { after_night.clone() } else { day.clone() };
    let full_night = calendar.previous_trading_day(&full_date)?;
    let full_night_phase = if full_night == night { night_phase } else { "CLOSED" };
    let full_day_phase = if full_date == day { day_phase } else { partition_phase(&full_date, day_first, day_last, today, minute) };
    let full_phase = if full_night_phase == "LIVE" || full_day_phase == "LIVE" {
        "LIVE"
    } else if full_night_phase == "PREOPEN" || full_day_phase == "PREOPEN" {
        "PREOPEN"
    } else {
        "CLOSED"
    };
    let part = |date: &str, session: &str| serde_json::json!({"trading_date": date, "session": session});
    Some(serde_json::json!({
        "DAY": futures_entry("DAY", &day, &day, day_phase, window(&day, day_first, day_last)?, serde_json::json!([part(&day, "DAY")])),
        "NIGHT": futures_entry("NIGHT", &after_night, &night, night_phase, window(&night, night_first, night_last)?,
                               serde_json::json!([part(&night, "NIGHT")])),
        "FULL": futures_entry("FULL", &full_date, &full_date, full_phase,
                              (window(&full_night, night_first, night_last)?.0, window(&full_date, day_first, day_last)?.1),
                              serde_json::json!([part(&full_night, "NIGHT"), part(&full_date, "DAY")])),
    }))
}

/// Families cleared whole at a moment rather than rolled by date, `source|MARKET` -> clear everything older than this
/// (ns): Futu crypto, never stored, emptied at the start of its day (New York 00:00, event.rs market_offset_seconds).
pub fn clears(now_ns: i64) -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    if let Some((_, minute)) = market_local_minute("CC", now_ns) {
        let since_midnight = (minute as i64) * 60 * 1_000_000_000 + now_ns.rem_euclid(60 * 1_000_000_000);
        out.insert(clear_family("futu", "CC"), now_ns - since_midnight);
    }
    out
}

/// The clear family of a market: `source|MARKET`.
pub fn clear_family(source: &str, market: &str) -> String {
    format!("{}|{}", source.trim().to_lowercase(), market.trim().to_uppercase())
}

/// Whether a source/market is never written to the WAL: Futu crypto (user rule).
pub fn never_stored(source: &str, market: &str) -> bool {
    source.eq_ignore_ascii_case("futu") && market.eq_ignore_ascii_case("CC")
}

/// A market of individual stocks, where whether an event is stored depends on the instrument (on the background
/// list or not), not on the market: Shioaji STK and Futu's stock markets.
pub fn stored_per_instrument(source: &str, market: &str) -> bool {
    (source.eq_ignore_ascii_case("shioaji") && market.eq_ignore_ascii_case("STK"))
        || (source.eq_ignore_ascii_case("futu") && !market.eq_ignore_ascii_case("CC"))
}

/// A market whose every event is written to the WAL while its session runs, on the background list or not, and
/// whose partitions are sorted out only when the session is materialized (user 11-13): Shioaji stocks and their
/// 盤中零股. A stock looked at during the day keeps its day in the WAL -- a restart resumes it and adding it to the
/// list later fetches nothing again -- and the materialization keeps only the listed stocks, never the odd lots
/// ([`kept_at_materialization`]).
pub fn stored_until_materialized(source: &str, market: &str) -> bool {
    source.eq_ignore_ascii_case("shioaji") && (market.eq_ignore_ascii_case("STK") || market.eq_ignore_ascii_case(ODD_MARKET))
}

/// A stock's 盤中零股: its own book and prints, a market of its own beside the stock's whole lots.
pub const ODD_MARKET: &str = "ODD";

/// A stock's 盤中零股 (the market ODD). Its broker keeps no history of it, so nothing of it is asked for after a
/// restart, an outage or a late join; and it is not the stock's market -- no analysis, feature or summary folds it,
/// only 模擬下單's odd-lot matching reads it (decisions.md 模擬零股的成交方式).
pub fn is_odd_lot(source: &str, market: &str) -> bool {
    source.eq_ignore_ascii_case("shioaji") && market.eq_ignore_ascii_case(ODD_MARKET)
}

/// The index futures' contract families (service/market/reference/futures_contracts.py INDEX_FUTURES): 台指期, 小台指.
pub const INDEX_FUTURES: [&str; 2] = ["TXF", "MXF"];

/// A Shioaji FUT code of an index future: the continuous near month (TXFR1) or a dated month of an index family
/// (`TXF202612`, `MXF202612`). Every other futures month is a stock future (個股期貨).
pub fn index_future(code: &str) -> bool {
    let code = code.to_uppercase();
    code == "TXFR1" || INDEX_FUTURES.iter().any(|family| code.strip_prefix(family)
        .is_some_and(|month| month.len() == 6 && month.bytes().all(|b| b.is_ascii_digit())))
}

/// Whether a Shioaji partition of a closed session goes into the historical store (user 11-13): a stock only when it
/// is kept at that moment (`kept`: on the background list, or traded by an account ledger), an index and the index
/// futures always, a stock future (個股期貨) and a 盤中零股 never. Another source's partitions are its retention's to
/// judge.
pub fn kept_at_materialization(source: &str, market: &str, code: &str, kept: impl Fn(&str) -> bool) -> bool {
    if !source.eq_ignore_ascii_case("shioaji") {
        return true;
    }
    match market.to_uppercase().as_str() {
        "STK" => kept(code),
        "FUT" => index_future(code),
        ODD_MARKET => false,
        _ => true,
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::*;

    #[test]
    fn a_closed_session_keeps_listed_stocks_indices_and_index_futures_only() {
        let listed = |code: &str| code == "2330";
        let kept = |market: &str, code: &str| kept_at_materialization("shioaji", market, code, listed);
        assert!(kept("STK", "2330") && !kept("STK", "2454"), "a stock only looked at goes");
        assert!(kept("IDX", "TAIEX") && kept("FUT", "TXFR1") && kept("FUT", "TXF202612") && kept("FUT", "MXF202612"));
        assert!(!kept("FUT", "CDF202612"), "a stock future never stays");
        assert!(!kept("ODD", "2330"), "an odd lot never stays, listed stock or not");
        assert!(kept_at_materialization("futu", "US", "US.TSLA", |_| false), "Futu is its retention's to judge");
    }

    fn ns(date: (i64, i64, i64), minute: i64) -> i64 {
        taipei_ns(date, minute)
    }

    #[test]
    fn coverage_is_dated_to_a_real_business_session_never_a_weekend() {
        let cal = TradingCalendar::default();
        // Saturday 2026-10-03, 10:00 Taipei.
        let sat = ns((2026, 10, 3), 600);
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "shioaji", "STK", sat), Some(("2026-10-05".into(), "DAY".into())));
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "shioaji", "FUT", sat), Some(("2026-10-05".into(), "DAY".into())));
        // Saturday 03:00 is still Friday's night session.
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "shioaji", "FUT", ns((2026, 10, 3), 180)), Some(("2026-10-02".into(), "NIGHT".into())));
        // Futu US goes by New York's date: Taipei Saturday 10:00 is still Friday 22:00 there (Friday's session)...
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "futu", "US", sat), Some(("2026-10-02".into(), "FULL".into())));
        // ...and Taipei Saturday 22:00 is New York Saturday 10:00 -> the next weekday.
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "futu", "US", ns((2026, 10, 3), 1320)), Some(("2026-10-05".into(), "FULL".into())));
        // A trading day: before the close it is today's; after, the next trading day's.
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "shioaji", "STK", ns((2026, 10, 6), 540)), Some(("2026-10-06".into(), "DAY".into())));
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "shioaji", "STK", ns((2026, 10, 6), 900)), Some(("2026-10-07".into(), "DAY".into())));
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "futu", "CC", sat), None, "crypto is never stored");
    }

    #[test]
    fn the_previous_trading_day_skips_weekends_and_closures() {
        let cal = TradingCalendar::from_json(r#"{"schema":"market-holidays-v1","markets":{"TWSE":{"years":{"2026":{"closed":[{"date":"2026-10-09"}]}}}}}"#).unwrap();
        assert_eq!(cal.previous_trading_day("2026-10-12").as_deref(), Some("2026-10-08"), "Monday after a closed Friday");
        assert_eq!(cal.previous_trading_day("2026-10-08").as_deref(), Some("2026-10-07"));
    }

    #[test]
    fn an_official_closure_is_skipped_like_a_weekend() {
        let cal = TradingCalendar::from_json(r#"{"schema":"market-holidays-v1","markets":{"TWSE":{"years":{"2026":{"closed":[{"date":"2026-10-09"}]}}}}}"#).unwrap();
        // Thursday 2026-10-08 after the close -> Friday is closed -> Monday 10-12.
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "shioaji", "STK", ns((2026, 10, 8), 900)), Some(("2026-10-12".into(), "DAY".into())));
        assert_eq!(coverage_partition(&cal, &TradingCalendar::default(), "shioaji", "FUT", ns((2026, 10, 9), 600)), Some(("2026-10-12".into(), "DAY".into())));
    }
}

/// Taipei-local nanoseconds for tests: (date, minute of day) -> UTC epoch ns.
#[cfg(test)]
pub fn taipei_ns(date: (i64, i64, i64), minute: i64) -> i64 {
    (days_from_civil(date.0, date.1, date.2) * 86_400 + minute * 60 - 8 * 3600) * 1_000_000_000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calendar() -> TradingCalendar {
        TradingCalendar::from_json(r#"{"schema":"market-holidays-v1","markets":{"TWSE":{"years":{"2026":{"closed":[{"date":"2026-10-09"},{"date":"2026-10-10"}]}}}}}"#).unwrap()
    }

    /// Every session opened on time (its first print at its pre-open): the clock alone decides.
    fn all_opened() -> Opened {
        Opened { day: "9999-12-31".into(), night: "9999-12-31".into() }
    }

    fn opened(day: &str, night: &str) -> Opened {
        Opened { day: day.into(), night: night.into() }
    }

    #[test]
    fn a_session_rolls_in_on_its_first_print_not_on_the_clock() {
        let cal = calendar();
        // Tuesday 2026-10-06 08:31: the pre-open is reached, nothing printed yet -> Monday is still held.
        let mut seen = opened("2026-10-05", "2026-10-05");
        let at = taipei_ns((2026, 10, 6), 8 * 60 + 31);
        let day = |seen: &Opened, at| cutoffs(&cal, &TradingCalendar::default(), seen, at)["shioaji|STK|DAY"].clone();
        assert_eq!(day(&seen, at), "2026-10-05");
        let session = equity_session(&cal, &seen, at).unwrap();
        assert_eq!((session["trading_date"].as_str(), session["phase"].as_str(), session["awaiting_open"].as_bool()),
                   (Some("2026-10-05"), Some("CLOSED"), Some(true)));
        // A snapshot of Monday's last print (its exchange time is Monday's) opens nothing.
        assert!(!seen.observe(&cal, OpeningGroup::Day, "2026-10-06", taipei_ns((2026, 10, 5), 13 * 60 + 30), at));
        // A print dated today before the clock reached the pre-open opens nothing either.
        assert!(!seen.observe(&cal, OpeningGroup::Day, "2026-10-06", taipei_ns((2026, 10, 6), 8 * 60 + 30), taipei_ns((2026, 10, 6), 8 * 60 + 29)));
        // The first 試撮 at 08:31 opens the day: every day family rolls, the night stays.
        assert!(seen.observe(&cal, OpeningGroup::Day, "2026-10-06", taipei_ns((2026, 10, 6), 8 * 60 + 31), at));
        let c = cutoffs(&cal, &TradingCalendar::default(), &seen, at);
        assert_eq!((c["shioaji|STK|DAY"].as_str(), c["shioaji|IDX|DAY"].as_str(), c["shioaji|FUT|DAY"].as_str(), c["shioaji|FUT|NIGHT"].as_str()),
                   ("2026-10-06", "2026-10-06", "2026-10-06", "2026-10-05"));
        assert_eq!(equity_session(&cal, &seen, at).unwrap()["phase"], "PREOPEN");
        assert!(!seen.observe(&cal, OpeningGroup::Day, "2026-10-06", taipei_ns((2026, 10, 6), 8 * 60 + 32), at), "opened once");
        // The night of 10-06 rolls in on its own first print after 14:50.
        let night = taipei_ns((2026, 10, 6), 15 * 60);
        assert_eq!(cutoffs(&cal, &TradingCalendar::default(), &seen, night)["shioaji|FUT|NIGHT"], "2026-10-05");
        assert!(seen.observe(&cal, OpeningGroup::Night, "2026-10-06", night, night));
        assert_eq!(cutoffs(&cal, &TradingCalendar::default(), &seen, night)["shioaji|FUT|NIGHT"], "2026-10-06");
    }

    #[test]
    fn an_observed_closure_keeps_the_last_session_and_is_no_trading_day() {
        let cal = calendar();
        // Wednesday 2026-10-07 is a typhoon day: nothing by 09:00.
        let seen = opened("2026-10-06", "2026-10-06");
        assert_eq!(cal.unopened_at_open(&seen, taipei_ns((2026, 10, 7), 8 * 60 + 59)), None, "before 09:00 nothing is decided");
        assert_eq!(cal.unopened_at_open(&seen, taipei_ns((2026, 10, 7), 9 * 60)).as_deref(), Some("2026-10-07"));
        assert_eq!(cal.unopened_at_open(&opened("2026-10-07", ""), taipei_ns((2026, 10, 7), 9 * 60)), None, "it opened");
        assert_eq!(cal.unopened_at_open(&seen, taipei_ns((2026, 10, 10), 9 * 60)), None, "a holiday is no closure");
        let closed = cal.with_closures(&[ObservedClosure { date: "2026-10-07".into(), observed_at: "x".into(), reason: "y".into() }]);
        assert!(!closed.is_trading_day("2026-10-07"));
        assert_eq!(closed.previous_trading_day("2026-10-08").as_deref(), Some("2026-10-06"));
        // All closure day the screens hold Tuesday; Thursday rolls in on its first print.
        let session = equity_session(&closed, &seen, taipei_ns((2026, 10, 7), 11 * 60)).unwrap();
        assert_eq!((session["trading_date"].as_str(), session["awaiting_open"].as_bool()), (Some("2026-10-06"), Some(false)));
        assert_eq!(cutoffs(&closed, &TradingCalendar::default(), &seen, taipei_ns((2026, 10, 8), 8 * 60 + 40))["shioaji|STK|DAY"], "2026-10-06");
    }

    #[test]
    fn the_sessions_file_round_trips_and_refuses_bad_dates() {
        let sessions = MarketSessions {
            opened: opened("2026-10-06", "2026-10-05"),
            closures: vec![ObservedClosure { date: "2026-10-07".into(), observed_at: "2026-10-07T09:00:00+08:00".into(), reason: "r".into() }],
        };
        assert_eq!(MarketSessions::from_json(&sessions.to_json()).unwrap(), sessions);
        assert!(sessions.is_closed("2026-10-07") && !sessions.is_closed("2026-10-06"));
        assert!(MarketSessions::from_json(r#"{"schema":"market-sessions-v1","opened":{"day":"2026-02-31","night":""}}"#).is_err());
        assert!(MarketSessions::from_json(r#"{"schema":"other","opened":{"day":"","night":""}}"#).unwrap_err().contains("schema"));
        let dir = std::env::temp_dir().join(format!("mr-sessions-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(MarketSessions::load(&dir.join("absent.json")).unwrap(), MarketSessions::default(), "a first start");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn cut(date: (i64, i64, i64), minute: i64) -> (String, String) {
        let c = cutoffs(&calendar(), &TradingCalendar::default(), &all_opened(), taipei_ns(date, minute));
        (c["shioaji|STK|DAY"].clone(), c["shioaji|FUT|NIGHT"].clone())
    }

    #[test]
    fn the_built_in_holidays_file_validates() {
        TradingCalendar::load(None).expect("config/market_holidays.json is built in and must validate");
    }

    #[test]
    fn a_named_holidays_file_that_fails_is_an_error_not_the_built_in_copy() {
        let dir = std::env::temp_dir().join(format!("mr-holidays-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(TradingCalendar::load(Some(&dir.join("absent.json"))).unwrap_err().contains("absent.json"));
        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{").unwrap();
        assert!(TradingCalendar::load(Some(&bad)).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bad_row_refuses_the_whole_file() {
        let file = |closed: &str| format!(r#"{{"schema":"market-holidays-v1","markets":{{"TWSE":{{"years":{{"2026":{{"closed":[{closed}]}}}}}}}}}}"#);
        assert!(TradingCalendar::from_json(&file(r#"{"date":"2026-10-09"}"#)).is_ok());
        assert!(TradingCalendar::from_json(&file(r#"{"date":"2026-02-31"}"#)).unwrap_err().contains("2026-02-31"), "an impossible date");
        assert!(TradingCalendar::from_json(&file(r#"{"date":"2025-10-09"}"#)).unwrap_err().contains("wrong year"));
        assert!(TradingCalendar::from_json(&file(r#"{"name":"no date"}"#)).is_err(), "a row without a date");
        assert!(TradingCalendar::from_json(&file(r#"{"date":20261009}"#)).is_err(), "a date that is not a string");
        assert!(TradingCalendar::from_json(r#"{"schema":"other","markets":{"TWSE":{"years":{}}}}"#).unwrap_err().contains("schema"));
        // October and November all closed: the trading-day searches would have no end.
        let all: Vec<String> = (1..=31).map(|d| format!(r#"{{"date":"2026-10-{d:02}"}}"#))
            .chain((1..=30).map(|d| format!(r#"{{"date":"2026-11-{d:02}"}}"#))).collect();
        assert!(TradingCalendar::from_json(&file(&all.join(","))).unwrap_err().contains("non-trading days in a row"));
    }

    #[test]
    fn trading_days_are_real_dates_and_listed_trading_days_count() {
        let c = TradingCalendar::from_json(r#"{"schema":"market-holidays-v1","markets":{"TWSE":{"years":{"2026":{"closed":[],"trading":[{"date":"2026-10-03"}]}}}}}"#).unwrap();
        assert!(c.is_trading_day("2026-10-03"), "a Saturday the file lists as trading (config/market_holidays.py agrees)");
        assert!(!c.is_trading_day("2026-02-30"), "not normalized to March 2nd");
        assert!(!c.is_trading_day("2026-1-5"));
        assert_eq!(c.previous_trading_day("2026-02-30"), None);
        assert_eq!(c.previous_trading_day("2026-10-05").as_deref(), Some("2026-10-03"));
    }

    #[test]
    fn weekdays_and_holidays() {
        let c = calendar();
        assert!(c.is_trading_day("2026-10-05"), "Monday");
        assert!(!c.is_trading_day("2026-10-03"), "Saturday");
        assert!(!c.is_trading_day("2026-10-04"), "Sunday");
        assert!(!c.is_trading_day("2026-10-09"), "holiday");
    }

    #[test]
    fn day_families_roll_at_0830_night_at_1450() {
        // Tuesday 2026-10-06.
        assert_eq!(cut((2026, 10, 6), 8 * 60 + 29), ("2026-10-05".into(), "2026-10-05".into()));
        assert_eq!(cut((2026, 10, 6), 8 * 60 + 30), ("2026-10-06".into(), "2026-10-05".into()));
        assert_eq!(cut((2026, 10, 6), 14 * 60 + 49), ("2026-10-06".into(), "2026-10-05".into()));
        assert_eq!(cut((2026, 10, 6), 14 * 60 + 50), ("2026-10-06".into(), "2026-10-06".into()));
        // After midnight the night that opened yesterday is still held (its cutoff is yesterday, not after it).
        assert_eq!(cut((2026, 10, 7), 3 * 60), ("2026-10-06".into(), "2026-10-06".into()));
    }

    #[test]
    fn futu_stock_markets_keep_the_current_and_the_previous_session() {
        // Tuesday 2026-10-06 10:00 New York (14:00 UTC): current 10-06, previous 10-05 -- whose 20:00 -> 20:00 window
        // starts on Friday 10-02.
        let tue = (days_from_civil(2026, 10, 6) * 86_400 + 14 * 3600) * 1_000_000_000;
        let c = cutoffs(&calendar(), &TradingCalendar::default(), &all_opened(), tue);
        assert_eq!(c["futu|US|FULL"], "2026-10-02");
        assert_eq!(c["futu|HK|FULL"], "2026-10-05", "a market without an overnight window keeps two partitions");
        // Sunday 10-04 and Monday 10-05 in New York: Friday's session is still the previous one on Monday.
        let sun = (days_from_civil(2026, 10, 4) * 86_400 + 14 * 3600) * 1_000_000_000;
        assert_eq!(cutoffs(&calendar(), &TradingCalendar::default(), &all_opened(), sun)["futu|US|FULL"], "2026-09-30", "current Friday, previous Thursday (from Wednesday 20:00)");
        let mon = (days_from_civil(2026, 10, 5) * 86_400 + 14 * 3600) * 1_000_000_000;
        assert_eq!(cutoffs(&calendar(), &TradingCalendar::default(), &all_opened(), mon)["futu|US|FULL"], "2026-10-01");
    }

    /// OpenD's US calendar for 11-16..11-30: every weekday but Thanksgiving (Thursday 11-26).
    fn thanksgiving() -> String {
        let days: Vec<String> = [16, 17, 18, 19, 20, 23, 24, 25, 27, 30].iter()
            .map(|d| format!(r#"{{"date":"2026-11-{d:02}","kind":"WHOLE"}}"#)).collect();
        format!(r#"{{"schema":"us-trading-calendar-v1","source":"futu_opend","from":"2026-11-16","to":"2026-11-30","days":[{}]}}"#, days.join(","))
    }

    /// 10:00 New York (15:00 UTC in November).
    fn new_york_ten(day: i64) -> i64 {
        (days_from_civil(2026, 11, day) * 86_400 + 15 * 3600) * 1_000_000_000
    }

    #[test]
    fn the_us_calendar_file_closes_the_weekdays_it_does_not_list_inside_its_window() {
        let us = TradingCalendar::default().with_us_calendar(&thanksgiving()).unwrap();
        assert!(!us.is_trading_day("2026-11-26") && us.is_trading_day("2026-11-25") && us.is_trading_day("2026-11-27"));
        assert!(!us.is_trading_day("2026-11-28"), "a weekend stays closed");
        assert!(us.is_trading_day("2026-12-03"), "outside the window: weekdays");
        for bad in [r#"{"schema":"other","from":"2026-11-16","to":"2026-11-30","days":[]}"#,
                    r#"{"schema":"us-trading-calendar-v1","from":"2026-11-30","to":"2026-11-16","days":[]}"#,
                    r#"{"schema":"us-trading-calendar-v1","from":"2026-11-16","to":"2026-11-30","days":[{"date":"2026-12-01"}]}"#] {
            assert!(TradingCalendar::default().with_us_calendar(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_us_holiday_moves_the_futu_us_cutoff_and_coverage_but_not_hk() {
        let us = TradingCalendar::default().with_us_calendar(&thanksgiving()).unwrap();
        // Friday 11-27: the previous session is Wednesday's (Thursday traded nothing), whose 20:00 -> 20:00 window
        // starts on Tuesday 11-24. The weekday rule called Thursday the previous session and dropped Tuesday.
        let friday = cutoffs(&calendar(), &us, &all_opened(), new_york_ten(27));
        assert_eq!(friday["futu|US|FULL"], "2026-11-24");
        assert_eq!(friday["futu|HK|FULL"], "2026-11-26", "no calendar is read for HK: weekdays");
        // Thanksgiving daytime: a subscription belongs to Friday's session, not to a day with none.
        assert_eq!(coverage_partition(&calendar(), &us, "futu", "US", new_york_ten(26)), Some(("2026-11-27".into(), "FULL".into())));
    }

    #[test]
    fn the_followed_us_calendar_is_its_base_without_a_file_and_keeps_the_last_good_one() {
        let dir = std::env::temp_dir().join(format!("us-calendar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("us_trading_calendar.json");
        let _ = std::fs::remove_file(&path);
        let followed = FollowedUsCalendar::new(TradingCalendar::default(), Some(path.clone()));
        assert!(followed.get().is_trading_day("2026-11-26"), "no file yet: the base (weekdays here)");
        std::fs::write(&path, thanksgiving()).unwrap();
        assert!(!followed.get().is_trading_day("2026-11-26"));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, "{not json").unwrap();
        assert!(!followed.get().is_trading_day("2026-11-26"), "a broken file keeps the last calendar");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_built_in_nyse_days_know_thanksgiving_and_its_half_day_without_opend() {
        let nyse = TradingCalendar::load_nyse(None).expect("config/market_holidays.json's NYSE days are built in and must validate");
        assert!(!nyse.is_trading_day("2026-11-26") && nyse.is_trading_day("2026-11-25") && nyse.is_trading_day("2026-11-27"));
        assert!(nyse.is_half_day("2026-11-27") && nyse.is_half_day("2026-12-24") && !nyse.is_half_day("2026-11-25"));
        assert!(!nyse.is_trading_day("2026-12-25") && !nyse.is_trading_day("2027-07-05"), "Christmas; Independence Day observed on Monday");
        assert!(nyse.covers_year(2026) && nyse.covers_year(2028) && !nyse.covers_year(2029));
        // With no OpenD file the rollover already skips Thanksgiving (it called it a trading day before).
        let friday = cutoffs(&calendar(), &nyse, &all_opened(), new_york_ten(27));
        assert_eq!(friday["futu|US|FULL"], "2026-11-24");
    }

    #[test]
    fn a_nyse_half_day_must_trade_and_twse_lists_none() {
        let nyse = |years: &str| format!(r#"{{"schema":"market-holidays-v1","markets":{{"TWSE":{{"years":{{}}}},"NYSE":{{"years":{{{years}}}}}}}}}"#);
        assert!(TradingCalendar::nyse_from_json(&nyse(r#""2026":{"closed":[{"date":"2026-11-26"}],"half":[{"date":"2026-11-27"}]}"#)).is_ok());
        assert!(TradingCalendar::nyse_from_json(&nyse(r#""2026":{"closed":[{"date":"2026-11-26"}],"half":[{"date":"2026-11-26"}]}"#))
            .unwrap_err().contains("not a trading day"));
        assert!(TradingCalendar::nyse_from_json(&nyse(r#""2026":{"half":[{"date":"2026-11-28"}]}"#)).unwrap_err().contains("not a trading day"), "a Saturday");
        assert!(TradingCalendar::nyse_from_json(r#"{"schema":"market-holidays-v1","markets":{"TWSE":{"years":{}}}}"#).unwrap_err().contains("NYSE"));
        assert!(TradingCalendar::from_json(r#"{"schema":"market-holidays-v1","markets":{"TWSE":{"years":{"2026":{"half":[{"date":"2026-11-27"}]}}}}}"#)
            .unwrap_err().contains("half"));
    }

    #[test]
    fn opend_overrides_the_nyse_days_only_inside_its_window() {
        let nyse = TradingCalendar::load_nyse(None).unwrap();
        // OpenD closes Monday 11-30 (an announced closure the file does not have) and lists 11-27 WHOLE.
        let days: Vec<String> = [16, 17, 18, 19, 20, 23, 24, 25, 27].iter()
            .map(|d| format!(r#"{{"date":"2026-11-{d:02}","kind":"WHOLE"}}"#)).collect();
        let file = format!(r#"{{"schema":"us-trading-calendar-v1","from":"2026-11-16","to":"2026-11-30","days":[{}]}}"#, days.join(","));
        let us = nyse.with_us_calendar(&file).unwrap();
        assert!(!us.is_trading_day("2026-11-30") && !us.is_half_day("2026-11-27"), "inside the window OpenD decides");
        assert!(us.is_half_day("2026-12-24") && !us.is_trading_day("2026-12-25"), "outside it the NYSE file stands");
    }

    #[test]
    fn futu_crypto_is_cleared_at_new_york_midnight_and_never_stored() {
        // 2026-10-06 09:15 Taipei = 10-05 21:15 New York (EDT): the CC day began at 10-05 00:00 New York = 12:00 Taipei.
        let at = taipei_ns((2026, 10, 6), 9 * 60 + 15) + 7_000_000_000;
        assert_eq!(clears(at)["futu|CC"], taipei_ns((2026, 10, 5), 12 * 60));
        assert!(never_stored("futu", "CC") && !never_stored("futu", "US") && !never_stored("shioaji", "STK"));
    }

    #[test]
    #[test]
    fn equity_session_follows_the_day_cutoff_and_the_clock() {
        let at = |date, minute| equity_session(&calendar(), &all_opened(), taipei_ns(date, minute)).unwrap();
        let pick = |v: Value| (v["trading_date"].as_str().unwrap().to_owned(), v["phase"].as_str().unwrap().to_owned(), v["live"].as_bool().unwrap());
        assert_eq!(pick(at((2026, 10, 6), 8 * 60)), ("2026-10-05".into(), "CLOSED".into(), false), "before the pre-open: yesterday");
        assert_eq!(pick(at((2026, 10, 6), 8 * 60 + 30)), ("2026-10-06".into(), "PREOPEN".into(), false));
        assert_eq!(pick(at((2026, 10, 6), 9 * 60)), ("2026-10-06".into(), "LIVE".into(), true));
        assert_eq!(pick(at((2026, 10, 6), 13 * 60 + 30)), ("2026-10-06".into(), "LIVE".into(), true), "13:30 is a trading minute");
        assert_eq!(pick(at((2026, 10, 6), 13 * 60 + 31)), ("2026-10-06".into(), "CLOSED".into(), false));
        assert_eq!(pick(at((2026, 10, 3), 10 * 60)), ("2026-10-02".into(), "CLOSED".into(), false), "Saturday shows Friday");
        assert_eq!(pick(at((2026, 10, 9), 10 * 60)), ("2026-10-08".into(), "CLOSED".into(), false), "holiday shows the last session");
    }

    #[test]
    fn futures_tabs_hold_their_opened_sessions() {
        let cal = calendar();
        let tab = |seen: &Opened, date, minute, name: &str| {
            let v = futures_sessions(&cal, seen, taipei_ns(date, minute)).unwrap()[name].clone();
            let parts: Vec<String> = v["partitions"].as_array().unwrap().iter()
                .map(|p| format!("{}:{}", p["trading_date"].as_str().unwrap(), p["session"].as_str().unwrap())).collect();
            (v["trading_date"].as_str().unwrap().to_owned(), v["phase"].as_str().unwrap().to_owned(), parts.join(","))
        };
        // Tuesday 10-06 08:40, the day opened on its 試撮, the night of Monday still held.
        let morning = opened("2026-10-06", "2026-10-05");
        assert_eq!(tab(&morning, (2026, 10, 6), 8 * 60 + 40, "DAY"), ("2026-10-06".into(), "PREOPEN".into(), "2026-10-06:DAY".into()));
        assert_eq!(tab(&morning, (2026, 10, 6), 8 * 60 + 40, "NIGHT"), ("2026-10-06".into(), "CLOSED".into(), "2026-10-05:NIGHT".into()));
        assert_eq!(tab(&morning, (2026, 10, 6), 8 * 60 + 40, "FULL"),
                   ("2026-10-06".into(), "PREOPEN".into(), "2026-10-05:NIGHT,2026-10-06:DAY".into()));
        assert_eq!(tab(&morning, (2026, 10, 6), 10 * 60, "FULL").1, "LIVE");
        // 14:55: the clock reached the night pre-open, no night print yet -> every tab keeps what it held.
        assert_eq!(tab(&morning, (2026, 10, 6), 14 * 60 + 55, "NIGHT").2, "2026-10-05:NIGHT");
        assert_eq!(tab(&morning, (2026, 10, 6), 14 * 60 + 55, "DAY"), ("2026-10-06".into(), "CLOSED".into(), "2026-10-06:DAY".into()));
        // The night of 10-06 opened: 夜盤 and 全日 move to Wednesday's trading date, 日盤 keeps Tuesday.
        let evening = opened("2026-10-06", "2026-10-06");
        assert_eq!(tab(&evening, (2026, 10, 6), 14 * 60 + 55, "NIGHT"), ("2026-10-07".into(), "PREOPEN".into(), "2026-10-06:NIGHT".into()));
        assert_eq!(tab(&evening, (2026, 10, 7), 2 * 60, "NIGHT").1, "LIVE");
        assert_eq!(tab(&evening, (2026, 10, 6), 16 * 60, "FULL"),
                   ("2026-10-07".into(), "LIVE".into(), "2026-10-06:NIGHT,2026-10-07:DAY".into()));
        // Thursday 10-08's night rolls into Monday 10-12 across the 10-09/10-10 holidays and the weekend.
        let thursday = opened("2026-10-08", "2026-10-08");
        assert_eq!(tab(&thursday, (2026, 10, 9), 12 * 60, "FULL").0, "2026-10-12");
        assert_eq!(tab(&thursday, (2026, 10, 9), 12 * 60, "NIGHT").1, "CLOSED");
    }

    #[test]
    fn weekends_and_holidays_keep_the_last_session() {
        // Friday 10-02 sessions are held through the weekend until Monday's pre-opens.
        assert_eq!(cut((2026, 10, 3), 12 * 60), ("2026-10-02".into(), "2026-10-02".into()));
        assert_eq!(cut((2026, 10, 5), 8 * 60), ("2026-10-02".into(), "2026-10-02".into()));
        assert_eq!(cut((2026, 10, 5), 9 * 60), ("2026-10-05".into(), "2026-10-02".into()));
        // Thursday 10-08 is the last trading day before the 10-09/10-10 holidays.
        assert_eq!(cut((2026, 10, 9), 9 * 60), ("2026-10-08".into(), "2026-10-08".into()));
    }
}
