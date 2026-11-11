//! The Futu US session the screens show (user 11-10, decisions.md 美股假日): which New York session trades now, and
//! the partitions and minutes each 個股走勢 tab (日盤 / 夜盤 / 全日) reads. A is the one judge of US trading days: the
//! calendar is A's US calendar (rollover::FollowedUsCalendar: the NYSE days of config/market_holidays.json with
//! OpenD's calendar laid over them), the minutes are config/trading_sessions.json's `futu|US`, half days included.
//! The renderer reads this from `session.current` and works out no weekday, holiday or clock of its own.
//!
//! A US partition is a New York calendar date. The overnight session that opens at 20:00 serves the next trading day
//! and runs only on an evening whose next day trades (no Friday or Saturday evening, no holiday eve); its tail after
//! midnight continues it in the next date's partition. The tabs:
//!   日盤 -- the day sessions (04:00 -> 20:00) of the newest trading day whose 04:00 has come: on a holiday, the
//!          trading day before it (user 11-10: the previous trading day, its note 休市);
//!   夜盤 -- the newest overnight session that has opened, 20:00 -> 04:00;
//!   全日 -- 20:00 the evening before -> 20:00, dated by its close: the newest trading day whose evening before has
//!          reached 20:00.

use crate::calendar::{CalKey, Calendar, Segment};
use crate::event::market_local_minute;
use crate::rollover::{date_of, day_number, TradingCalendar};
use serde_json::{json, Value};
use std::sync::OnceLock;

const US: CalKey<'static> = CalKey { source: "futu", market: "US", session: None, date: None };
const MINUTES_PER_DAY: i32 = 24 * 60;

fn sessions() -> &'static Calendar {
    static SESSIONS: OnceLock<Calendar> = OnceLock::new();
    SESSIONS.get_or_init(Calendar::default)
}

/// A segment that opens on the evening before the trading day it serves: the one a later date's
/// `continues_previous_day` segment joins (the overnight session from 20:00).
fn serves_next_day(segments: &[Segment], segment: &Segment) -> bool {
    !segment.continues_previous_day && segments.iter().any(|s| s.continues_previous_day && s.name == segment.name)
}

/// The renderer's name of a session: pre / regular / after / overnight.
fn phase_name(session: &str) -> String {
    match session {
        "POST" => "after".to_owned(),
        other => other.to_lowercase(),
    }
}

fn part(day: i64, from: i32, to: i32) -> Value {
    json!({"trading_date": date_of(day), "from": from, "to": to})
}

/// The US session at `now_ns` by the calendar `us`:
/// `{trading_date, phase, market_day, day_regular_close, windows: {day, overnight, full}}`. `trading_date` is the session 全日 shows;
/// `phase` is pre / regular / after / overnight, or closed when nothing trades; `market_day` is New York's date
/// itself: whole, half (closes early) or closed (a weekend or a holiday); `day_regular_close` is the minute the 日盤
/// tab's day closed its regular session (exclusive: 960, or 780 on a half day). Each window is its parts
/// `{trading_date, from, to}` (minutes of that partition, `to` exclusive) in time order.
pub fn us_session(us: &TradingCalendar, now_ns: i64) -> Option<Value> {
    let (date, minute) = market_local_minute("US", now_ns)?;
    let today = day_number(&date)?;
    let segments = sessions().segments(US);
    let evening_open = segments.iter().find(|s| serves_next_day(segments, s))?.start;
    let tail_end = segments.iter().find(|s| s.continues_previous_day)?.end + 1;
    let day_open = segments.iter().filter(|s| !s.continues_previous_day && !serves_next_day(segments, s)).map(|s| s.start).min()?;

    let mut phase = "closed".to_owned();
    for (index, segment) in segments.iter().enumerate() {
        let serves = if serves_next_day(segments, segment) { today + 1 } else { today };
        if !us.trades(serves) {
            continue;
        }
        // The same session on the day it serves: a half day's is shorter (the two lists hold the same sessions in order).
        let on_day = &sessions().segments_on(US, us.is_half_day(&date_of(serves)))[index];
        if on_day.is_trading(minute) {
            phase = phase_name(&on_day.name);
            break;
        }
    }
    let market_day = if !us.trades(today) {
        "closed"
    } else if us.is_half_day(&date) {
        "half"
    } else {
        "whole"
    };

    let day = us.trading_day_on_or_before(if minute >= day_open { today } else { today - 1 });
    let mut evening = if minute >= evening_open { today } else { today - 1 };
    while !us.trades(evening + 1) {
        evening -= 1;
    }
    let close = us.trading_day_on_or_before(if minute >= evening_open { today + 1 } else { today });
    let day_regular_close = sessions().segments_on(US, us.is_half_day(&date_of(day))).iter().find(|s| s.name == "REGULAR")?.end + 1;
    Some(json!({
        "trading_date": date_of(close),
        "phase": phase,
        "market_day": market_day,
        "day_regular_close": day_regular_close,
        "windows": {
            "day": [part(day, day_open, evening_open)],
            "overnight": [part(evening, evening_open, MINUTES_PER_DAY), part(evening + 1, 0, tail_end)],
            "full": [part(close - 1, evening_open, MINUTES_PER_DAY), part(close, 0, evening_open)],
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::days_from_civil;

    /// `minute` past midnight New York on a November / early December 2026 day (UTC-5).
    fn new_york(month: i64, day: i64, minute: i64) -> i64 {
        (days_from_civil(2026, month, day) * 86_400 + minute * 60 + 5 * 3600) * 1_000_000_000
    }

    fn at(month: i64, day: i64, minute: i64) -> Value {
        let nyse = TradingCalendar::load_nyse(None).unwrap();
        us_session(&nyse, new_york(month, day, minute)).unwrap()
    }

    fn window(v: &Value, tab: &str) -> Vec<(String, i64, i64)> {
        v["windows"][tab].as_array().unwrap().iter()
            .map(|p| (p["trading_date"].as_str().unwrap().to_owned(), p["from"].as_i64().unwrap(), p["to"].as_i64().unwrap())).collect()
    }

    fn head(v: &Value) -> (&str, &str, &str) {
        (v["trading_date"].as_str().unwrap(), v["phase"].as_str().unwrap(), v["market_day"].as_str().unwrap())
    }

    fn p(date: &str, from: i64, to: i64) -> (String, i64, i64) {
        (date.to_owned(), from, to)
    }

    #[test]
    fn a_whole_day_runs_pre_regular_after_and_the_overnight_for_the_next_day() {
        assert_eq!(head(&at(11, 24, 300)), ("2026-11-24", "pre", "whole"));
        assert_eq!(head(&at(11, 24, 600)), ("2026-11-24", "regular", "whole"));
        assert_eq!(head(&at(11, 24, 1000)), ("2026-11-24", "after", "whole"));
        let evening = at(11, 24, 1230);
        assert_eq!(head(&evening), ("2026-11-25", "overnight", "whole"), "全日 moves to the next date at 20:00");
        assert_eq!(window(&evening, "day"), vec![p("2026-11-24", 240, 1200)]);
        assert_eq!(window(&evening, "overnight"), vec![p("2026-11-24", 1200, 1440), p("2026-11-25", 0, 240)]);
        assert_eq!(window(&evening, "full"), vec![p("2026-11-24", 1200, 1440), p("2026-11-25", 0, 1200)]);
        assert_eq!(head(&at(11, 25, 100)), ("2026-11-25", "overnight", "whole"), "the tail after midnight");
    }

    #[test]
    fn thanksgiving_shows_the_previous_trading_day_and_no_overnight_on_its_eve() {
        // Wednesday 11-25 20:30: Thursday does not trade, so no overnight session opens.
        let eve = at(11, 25, 1230);
        assert_eq!(head(&eve), ("2026-11-25", "closed", "whole"));
        assert_eq!(window(&eve, "overnight"), vec![p("2026-11-24", 1200, 1440), p("2026-11-25", 0, 240)], "the last overnight that opened");
        // Thursday 11-26 10:00: the market is closed all day; every tab keeps Wednesday's session.
        let holiday = at(11, 26, 600);
        assert_eq!(head(&holiday), ("2026-11-25", "closed", "closed"));
        assert_eq!(window(&holiday, "day"), vec![p("2026-11-25", 240, 1200)]);
        assert_eq!(window(&holiday, "full"), vec![p("2026-11-24", 1200, 1440), p("2026-11-25", 0, 1200)]);
        // Thursday 20:30: Friday's overnight session opens; 全日 is Friday's from here, 日盤 still Wednesday's.
        let evening = at(11, 26, 1230);
        assert_eq!(head(&evening), ("2026-11-27", "overnight", "closed"));
        assert_eq!(window(&evening, "day"), vec![p("2026-11-25", 240, 1200)]);
        assert_eq!(window(&evening, "overnight"), vec![p("2026-11-26", 1200, 1440), p("2026-11-27", 0, 240)]);
        assert_eq!(window(&evening, "full"), vec![p("2026-11-26", 1200, 1440), p("2026-11-27", 0, 1200)]);
    }

    #[test]
    fn the_half_day_closes_regular_at_13_and_after_hours_at_17() {
        assert_eq!(head(&at(11, 27, 300)), ("2026-11-27", "pre", "half"));
        assert_eq!(head(&at(11, 27, 779)), ("2026-11-27", "regular", "half"), "12:59");
        assert_eq!(head(&at(11, 27, 780)), ("2026-11-27", "after", "half"), "13:00");
        assert_eq!(head(&at(11, 27, 1019)), ("2026-11-27", "after", "half"), "16:59");
        assert_eq!(head(&at(11, 27, 1020)), ("2026-11-27", "closed", "half"), "17:00");
        assert_eq!(window(&at(11, 27, 1100), "day"), vec![p("2026-11-27", 240, 1200)]);
        // Friday evening: no overnight session until Sunday 20:00, which serves Monday.
        assert_eq!(head(&at(11, 27, 1230)), ("2026-11-27", "closed", "half"));
        assert_eq!(head(&at(11, 28, 600)), ("2026-11-27", "closed", "closed"), "Saturday");
        let sunday = at(11, 29, 1230);
        assert_eq!(head(&sunday), ("2026-11-30", "overnight", "closed"));
        assert_eq!(window(&sunday, "day"), vec![p("2026-11-27", 240, 1200)]);
        assert_eq!(window(&sunday, "full"), vec![p("2026-11-29", 1200, 1440), p("2026-11-30", 0, 1200)]);
    }

    #[test]
    fn the_regular_close_is_the_one_of_the_day_the_day_tab_shows() {
        assert_eq!(at(11, 24, 1000)["day_regular_close"], 960);
        assert_eq!(at(11, 27, 1000)["day_regular_close"], 780, "the half day itself");
        assert_eq!(at(11, 28, 600)["day_regular_close"], 780, "Saturday still shows the half day");
        assert_eq!(at(11, 27, 100)["day_regular_close"], 960, "the half day's early hours still show Wednesday");
    }

    #[test]
    fn before_04_00_the_day_tab_keeps_the_previous_trading_day() {
        let v = at(11, 30, 120);
        assert_eq!(head(&v), ("2026-11-30", "overnight", "whole"));
        assert_eq!(window(&v, "day"), vec![p("2026-11-27", 240, 1200)]);
        assert_eq!(window(&v, "overnight"), vec![p("2026-11-29", 1200, 1440), p("2026-11-30", 0, 240)]);
    }
}
