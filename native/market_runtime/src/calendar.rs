//! Trading calendar for Rust A and Rust B (config/trading_sessions.json): which minutes of a WAL partition are trading
//! minutes, which business session each belongs to, and where a session tail after midnight continues.
//! Break minutes inside a session are non-trading (not missing data); two sessions are never bridged.

use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{OnceLock, RwLock};

pub const SESSIONS_JSON: &str = include_str!("../../../config/trading_sessions.json");

/// The US half days this process knows: the NYSE `half` days of the holidays file with OpenD's calendar laid over them
/// (rollover::FollowedUsCalendar). Rust A and Rust B each install theirs from the same files at start and when the
/// provider rewrites OpenD's calendar; until then the built-in holidays file's NYSE half days stand. Process-wide, so
/// every Calendar of the process (the engine's, a materialization's, the bar store's) splits a half day the same way.
static HALF_DAYS: RwLock<Option<BTreeSet<String>>> = RwLock::new(None);

fn built_in_half_days() -> &'static BTreeSet<String> {
    static BUILT_IN: OnceLock<BTreeSet<String>> = OnceLock::new();
    BUILT_IN.get_or_init(|| crate::rollover::TradingCalendar::load_nyse(None)
        .expect("the built-in holidays file validates").half_days().clone())
}

/// The US half days every Calendar of this process reads from now on.
pub fn install_half_days(dates: BTreeSet<String>) {
    *HALF_DAYS.write().unwrap_or_else(|p| p.into_inner()) = Some(dates);
}

/// Whether `date` (YYYY-MM-DD) is a US half day.
pub fn is_half_day(date: &str) -> bool {
    match &*HALF_DAYS.read().unwrap_or_else(|p| p.into_inner()) {
        Some(dates) => dates.contains(date),
        None => built_in_half_days().contains(date),
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SessionSpec {
    pub session: String,
    pub intervals: Vec<(i32, i32)>,
    #[serde(default)]
    pub continues_previous_day: bool,
    #[serde(default)]
    pub calendar_quality: Option<String>,
    /// Minutes outside `intervals` at whose first second the venue stamps a single match or publication (TW stocks'
    /// 14:30 盤後定價): no trading minute, but a span touching one is a trading outage (crate::evidence).
    #[serde(default)]
    pub print_instants: Vec<i32>,
    /// The session's trading intervals on a half day (`is_half_day`), when they differ from `intervals`.
    #[serde(default)]
    pub half_day_intervals: Option<Vec<(i32, i32)>>,
}

#[derive(Debug, Clone, Deserialize)]
struct File {
    version: String,
    markets: BTreeMap<String, Vec<SessionSpec>>,
    unknown_market: SessionSpec,
    late_allowance_seconds: i64,
}

#[derive(Debug, Clone)]
pub struct Calendar {
    pub version: String,
    pub late_allowance_ns: i64,
    /// Segments per source, then market, built once: is_trading/segment_of run for every print and every minute, so
    /// a lookup borrows the partition's own names (`CalKey`) and allocates nothing.
    markets: BTreeMap<String, BTreeMap<String, MarketSegments>>,
    unknown_segments: Vec<Segment>,
}

#[derive(Debug, Clone, Default)]
struct MarketSegments {
    all: Vec<Segment>,
    /// A market whose partitions each hold ONE business session (shioaji FUT DAY / NIGHT): that session's segments.
    by_session: BTreeMap<String, Vec<Segment>>,
    /// The same on a half day, for a market whose sessions name `half_day_intervals` (futu US): each segment spans its
    /// half-day intervals, so a minute after the early close belongs to the session it trades in.
    half: Option<(Vec<Segment>, BTreeMap<String, Vec<Segment>>)>,
}

/// Which calendar a partition reads, borrowed from its identity: source (lowercase), market (uppercase), for a
/// session-partitioned market its session (uppercase), and the partition's trading date (a half day has shorter
/// sessions; None reads a whole day).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CalKey<'a> {
    pub source: &'a str,
    pub market: &'a str,
    pub session: Option<&'a str>,
    pub date: Option<&'a str>,
}

/// One business session inside a partition.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub index: usize,
    pub name: String,
    pub start: i32,
    pub end: i32,
    pub intervals: Vec<(i32, i32)>,
    pub continues_previous_day: bool,
    pub known_market: bool,
    pub print_instants: Vec<i32>,
}

impl Segment {
    pub fn is_trading(&self, minute: i32) -> bool {
        self.intervals.iter().any(|(a, b)| minute >= *a && minute <= *b)
    }
    /// Trading minutes of this segment in [from, to], ascending.
    pub fn minutes_between(&self, from: i32, to: i32) -> Vec<i32> {
        let mut out = Vec::new();
        for (a, b) in &self.intervals {
            let lo = (*a).max(from);
            let hi = (*b).min(to);
            if lo <= hi {
                out.extend(lo..=hi);
            }
        }
        out
    }
}

impl Default for Calendar {
    fn default() -> Self {
        Self::from_json(SESSIONS_JSON).expect("bundled trading_sessions.json is valid")
    }
}

impl Calendar {
    pub fn from_json(text: &str) -> Result<Self, String> {
        let file: File = serde_json::from_str(text).map_err(|e| format!("trading sessions: {e}"))?;
        let mut markets: BTreeMap<String, BTreeMap<String, MarketSegments>> = BTreeMap::new();
        for (key, specs) in &file.markets {
            let (source, market) = key.split_once('|').ok_or_else(|| format!("trading sessions: market key {key:?} is not source|MARKET"))?;
            let (all, by_session) = Self::build_market(specs);
            let half = specs.iter().any(|s| s.half_day_intervals.is_some()).then(|| {
                let shortened: Vec<SessionSpec> = specs.iter().cloned().map(|mut s| {
                    if let Some(half) = s.half_day_intervals.take() {
                        s.intervals = half;
                    }
                    s
                }).collect();
                Self::build_market(&shortened)
            });
            markets.entry(source.to_lowercase()).or_default().insert(market.to_uppercase(), MarketSegments { all, by_session, half });
        }
        let unknown_segments = Self::build(vec![file.unknown_market.clone()], false);
        Ok(Self { version: file.version, late_allowance_ns: file.late_allowance_seconds * 1_000_000_000,
            markets, unknown_segments })
    }

    /// A market's segments, and per session for a market with several: a partition that holds ONE business session
    /// (shioaji FUT DAY / NIGHT) reads only that session's minutes. Without this a NIGHT partition's clock finalized the
    /// DAY session's minutes into it as no-trade.
    fn build_market(specs: &[SessionSpec]) -> (Vec<Segment>, BTreeMap<String, Vec<Segment>>) {
        let mut by_session = BTreeMap::new();
        let names: BTreeSet<&str> = specs.iter().map(|s| s.session.as_str()).collect();
        if names.len() > 1 {
            for name in names {
                let own: Vec<SessionSpec> = specs.iter().filter(|s| s.session == name).cloned().collect();
                by_session.insert(name.to_uppercase(), Self::build(own, true));
            }
        }
        (Self::build(specs.to_vec(), true), by_session)
    }

    fn build(specs: Vec<SessionSpec>, known: bool) -> Vec<Segment> {
        specs
            .into_iter()
            .enumerate()
            .map(|(index, s)| Segment {
                index,
                start: s.intervals.iter().map(|i| i.0).min().unwrap_or(0),
                end: s.intervals.iter().map(|i| i.1).max().unwrap_or(1439),
                name: s.session,
                intervals: s.intervals,
                continues_previous_day: s.continues_previous_day,
                known_market: known,
                print_instants: s.print_instants,
            })
            .collect()
    }

    /// The segments a partition reads: its market's, or for a session-partitioned market its own session's, on its
    /// date -- a half day's (`is_half_day`) where the market has shorter sessions then. A market (or session) the
    /// calendar does not name reads the unknown-market session. The key's names are in their canonical case
    /// (InstrumentId); nothing is allocated, and a market without half days never looks the date up.
    pub fn segments(&self, key: CalKey<'_>) -> &[Segment] {
        let half = key.date.is_some_and(|date| self.has_half_days(key) && is_half_day(date));
        self.segments_on(key, half)
    }

    /// The segments a partition reads on a whole day or, when `half_day`, on a half day (a caller that knows which
    /// day it serves without a partition date: the US session phase, us_session.rs).
    pub fn segments_on(&self, key: CalKey<'_>, half_day: bool) -> &[Segment] {
        let Some(market) = self.markets.get(key.source).and_then(|m| m.get(key.market)) else { return &self.unknown_segments };
        let (all, by_session) = match (&market.half, half_day) {
            (Some((all, by_session)), true) => (all, by_session),
            _ => (&market.all, &market.by_session),
        };
        match key.session {
            None => all,
            Some(session) => by_session.get(session).map_or(&self.unknown_segments, Vec::as_slice),
        }
    }

    fn has_half_days(&self, key: CalKey<'_>) -> bool {
        self.markets.get(key.source).and_then(|m| m.get(key.market)).is_some_and(|m| m.half.is_some())
    }

    /// The business session a minute belongs to (a break minute belongs to its session but is not trading).
    pub fn segment_of(&self, key: CalKey<'_>, minute: i32) -> Option<&Segment> {
        self.segments(key).iter().find(|s| minute >= s.start && minute <= s.end)
    }

    pub fn is_trading(&self, key: CalKey<'_>, minute: i32) -> bool {
        self.segment_of(key, minute).is_some_and(|s| s.is_trading(minute))
    }

    /// The minute bar a print or quote stamped `minute` belongs to: a trading minute is its own; a session's closing
    /// publication -- its first `print_instant` after its last trading minute (TW stocks' delayed closing match, TW
    /// indices' published closing index, both 13:33) -- closes the session's last trading minute; anything else has no
    /// bar (None). Later print instants (14:30 盤後定價) are matches of their own, never the session's close.
    pub fn bar_minute(&self, key: CalKey<'_>, minute: i32) -> Option<i32> {
        if self.is_trading(key, minute) {
            return Some(minute);
        }
        self.segments(key).iter().find(|s| s.print_instants.iter().filter(|p| **p > s.end).min() == Some(&minute)).map(|s| s.end)
    }

    /// The segment of the previous calendar partition that a `continues_previous_day` segment joins.
    pub fn previous_day_segment(&self, key: CalKey<'_>, segment: &Segment) -> Option<&Segment> {
        if !segment.continues_previous_day {
            return None;
        }
        self.segments(key).iter().rev().find(|s| s.name == segment.name && !s.continues_previous_day)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn us_overnight_session_trades_and_its_after_midnight_tail_continues_the_previous_date() {
        // Without OVERNIGHT, 20:00-03:59 New York are not trading minutes, so B keeps no minute and
        // 個股走勢 stays empty all night.
        let c = Calendar::default();
        let us = CalKey { source: "futu", market: "US", session: None, date: None };
        assert!(c.is_trading(us, 40), "00:40 overnight");
        assert!(c.is_trading(us, 1320), "22:00 overnight");
        assert!(c.is_trading(us, 300) && c.is_trading(us, 600) && c.is_trading(us, 1000));
        let tail = c.segment_of(us, 40).unwrap();
        let head = c.segment_of(us, 1320).unwrap();
        assert_eq!((tail.name.as_str(), head.name.as_str()), ("OVERNIGHT", "OVERNIGHT"));
        assert!(tail.continues_previous_day && !head.continues_previous_day);
        assert_eq!(c.previous_day_segment(us, tail).unwrap().start, 1200, "the tail joins the previous date's 20:00 session");
        assert_eq!(c.segment_of(us, 600).unwrap().name, "REGULAR");
    }

    #[test]
    fn taiwan_stocks_trade_0900_to_1330_and_futures_night_crosses_midnight() {
        let c = Calendar::default();
        let stk = CalKey { source: "shioaji", market: "STK", session: None, date: None };
        let night_key = CalKey { source: "shioaji", market: "FUT", session: Some("NIGHT"), date: None };
        let day_key = CalKey { session: Some("DAY"), ..night_key };
        assert!(c.is_trading(stk, 540));
        assert!(c.is_trading(stk, 810), "13:30 closing print is a trading minute");
        assert!(!c.is_trading(stk, 811));
        assert!(!c.is_trading(stk, 539));
        // FUT is partitioned per business session: a NIGHT partition's minutes run 900..1740 (00:00 = 1440).
        let night = c.segment_of(night_key, 1440 + 120).unwrap();
        assert_eq!((night.name.as_str(), night.start, night.end), ("NIGHT", 900, 1740));
        assert!(!night.continues_previous_day, "nothing is joined across partitions any more");
        assert!(c.segment_of(night_key, 400).is_none(), "05:01-08:44 is not a session");
        assert_eq!(c.segment_of(day_key, 600).unwrap().name, "DAY");
    }

    /// 2026-11-27 (a half day of the built-in holidays file): the regular session closes at 13:00 and the after-hours
    /// one runs 13:00-17:00, so a 13:20 print is after-hours and 17:00-19:59 is no session; the day before is whole.
    #[test]
    fn a_us_half_day_partition_reads_the_shortened_sessions() {
        let c = Calendar::default();
        let on = |date| CalKey { source: "futu", market: "US", session: None, date: Some(date) };
        let (half, whole) = (on("2026-11-27"), on("2026-11-26"));
        assert_eq!(c.segment_of(half, 800).unwrap().name, "POST", "13:20 of the half day is after-hours");
        assert_eq!(c.segment_of(whole, 800).unwrap().name, "REGULAR");
        assert_eq!((c.segment_of(half, 779).unwrap().name.as_str(), c.segment_of(half, 780).unwrap().start), ("REGULAR", 780));
        assert!(c.segment_of(half, 1100).is_none() && !c.is_trading(half, 1100), "18:20: no session after the 17:00 close");
        assert!(c.is_trading(whole, 1100));
        assert!(c.is_trading(half, 1250), "the overnight session is not shortened");
        assert_eq!(c.segments_on(on("2026-11-26"), true), c.segments(half), "segments_on names the day without a date");
        // A market without half-day sessions reads the same segments on that date.
        let stk = |date| CalKey { source: "shioaji", market: "STK", session: None, date };
        assert_eq!(c.segments(stk(Some("2026-11-27"))), c.segments(stk(None)));
    }

    #[test]
    fn a_lunch_break_is_inside_the_session_but_not_trading() {
        let c = Calendar::default();
        let s = c.segment_of(CalKey { source: "futu", market: "HK", session: None, date: None }, 750).unwrap();
        assert_eq!(s.name, "DAY");
        assert!(!s.is_trading(750));
        assert_eq!(s.minutes_between(715, 782), vec![715, 716, 717, 718, 719, 780, 781, 782]);
        assert!(!c.segments(CalKey { source: "nope", market: "XX", session: None, date: None })[0].known_market);
    }
}
