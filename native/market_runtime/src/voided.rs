//! Durable events the user decided are void (作廢): stored by mistake and removed by decision, never by a reader's
//! own judgement.
//!
//! One list, one rule. The list is `<A data dir>/voided_events.json` (system_contract `data_children.voided_events`,
//! named to every reader by its launcher): `[{source, market, trading_date, session, durable: "LO-HI", reason}]`. An
//! event is void when its partition (source, market, trading_date, session) is an entry's and its durable sequence lies
//! in that entry's range. Every reader of stored events applies `Voided::covers` and nothing else:
//! - Market Runtime's start (the WAL replay into its state and session evidence, the trade-tape index) and the
//!   provisional replay of a session read from the WAL (wal_session.rs);
//! - Rust B's durable fold: Market Runtime forwards the durable stream as stored, so the sequence stays contiguous, and B
//!   skips the void events itself (its cursor still passes them);
//! - the historical materializer (B `--materialize`), from the WAL or from the store.
//!
//! A checkpoint (A's and B's) records the fingerprint of the list it was built under: built under another list, its
//! state may hold an event now void (or lack one no longer void) and is rebuilt from the stream, never resumed.
//! A missing file is an empty list; a file that cannot be read or does not validate stops the reader (a start, a job)
//! instead of showing the events the user decided to remove.

use crate::event::MarketEvent;
use crate::sha256;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// One entry: a durable-sequence range of one partition.
#[derive(Debug, Clone, PartialEq)]
pub struct Range {
    pub source: String,
    pub market: String,
    pub trading_date: String,
    pub session: String,
    pub first: u64,
    pub last: u64,
    pub reason: String,
}

impl Range {
    fn covers(&self, source: &str, market: &str, trading_date: &str, session: &str, sequence: u64) -> bool {
        (self.first..=self.last).contains(&sequence) && self.trading_date == trading_date
            && self.source.eq_ignore_ascii_case(source) && self.market.eq_ignore_ascii_case(market)
            && self.session.eq_ignore_ascii_case(session)
    }
}

/// The void events, as read from the list.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Voided {
    ranges: Vec<Range>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    source: String,
    market: String,
    trading_date: String,
    session: String,
    durable: String,
    reason: String,
}

impl Voided {
    /// The list at `path`; no path or no file is an empty list (not an error: nothing is void).
    pub fn load(path: Option<&Path>) -> Result<Self, String> {
        let Some(path) = path else { return Ok(Self::default()) };
        match fs::read(path) {
            Ok(bytes) => Self::parse(&bytes).map_err(|why| format!("{}: {why}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()), // not an error: nothing is void
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let entries: Vec<Entry> = serde_json::from_slice(bytes).map_err(|e| format!("not a list of void ranges: {e}"))?;
        let mut ranges = Vec::with_capacity(entries.len());
        for (i, entry) in entries.into_iter().enumerate() {
            let at = |why: String| format!("entry {i}: {why}");
            let (first, last) = entry.durable.split_once('-')
                .and_then(|(lo, hi)| Some((lo.trim().parse::<u64>().ok()?, hi.trim().parse::<u64>().ok()?)))
                .ok_or_else(|| at(format!("durable: expected LO-HI, got {:?}", entry.durable)))?;
            if first == 0 || first > last {
                return Err(at(format!("durable: {first}-{last} is not a range of durable sequences")));
            }
            for (name, value) in [("source", &entry.source), ("market", &entry.market), ("session", &entry.session), ("reason", &entry.reason)] {
                if value.trim().is_empty() {
                    return Err(at(format!("{name} is empty")));
                }
            }
            if crate::event::parse_calendar_date(&entry.trading_date).is_none() {
                return Err(at(format!("trading_date: not a date: {:?}", entry.trading_date)));
            }
            ranges.push(Range { source: entry.source.trim().to_lowercase(), market: entry.market.trim().to_uppercase(),
                trading_date: entry.trading_date, session: entry.session.trim().to_uppercase(), first, last, reason: entry.reason });
        }
        Ok(Self { ranges })
    }

    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }

    pub fn ranges(&self) -> &[Range] {
        &self.ranges
    }

    /// Whether this stored event is void.
    pub fn covers(&self, event: &MarketEvent) -> bool {
        self.covers_at(&event.provider, &event.market, &event.trading_date, &event.session, event.durable_sequence)
    }

    /// `covers` by the partition's names and the durable sequence (a reader that has not decoded the whole event).
    pub fn covers_at(&self, source: &str, market: &str, trading_date: &str, session: &str, sequence: u64) -> bool {
        self.ranges.iter().any(|r| r.covers(source, market, trading_date, session, sequence))
    }

    /// What a checkpoint records the list by: the ranges, not their reasons (rewording a reason voids nothing more).
    /// `none` for the empty list.
    pub fn fingerprint(&self) -> String {
        if self.ranges.is_empty() {
            return "none".into();
        }
        let mut lines: Vec<String> = self.ranges.iter()
            .map(|r| format!("{}|{}|{}|{}|{}-{}", r.source, r.market, r.trading_date, r.session, r.first, r.last)).collect();
        lines.sort();
        lines.dedup();
        sha256::hex(lines.join("\n").as_bytes())
    }

    /// The list as a reader's log record names it.
    pub fn describe(&self) -> Value {
        json!({"fingerprint": self.fingerprint(), "ranges": self.ranges.iter().map(|r| json!({
            "source": r.source, "market": r.market, "trading_date": r.trading_date, "session": r.session,
            "durable": format!("{}-{}", r.first, r.last), "reason": r.reason})).collect::<Vec<_>>()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::tests_support::trade_event;

    const LIST: &str = r#"[{"source": "shioaji", "market": "FUT", "trading_date": "2026-11-06", "session": "NIGHT",
        "durable": "156516703-156516720", "reason": "test backfill written by mistake"}]"#;

    fn night(seq: u64) -> MarketEvent {
        let mut event = trade_event("TXFR1", seq, 1);
        event.provider = "shioaji".into();
        event.market = "FUT".into();
        event.trading_date = "2026-11-06".into();
        event.session = "NIGHT".into();
        event
    }

    #[test]
    fn an_event_is_void_only_in_its_partition_and_range() {
        let voided = Voided::parse(LIST.as_bytes()).unwrap();
        assert!(voided.covers(&night(156516703)) && voided.covers(&night(156516720)));
        assert!(!voided.covers(&night(156516702)) && !voided.covers(&night(156516721)), "the range's ends are its own");
        let mut day = night(156516710);
        day.session = "DAY".into();
        assert!(!voided.covers(&day), "the same sequence in another partition (another stream) is not void");
        let mut other_date = night(156516710);
        other_date.trading_date = "2026-11-05".into();
        assert!(!voided.covers(&other_date));
        assert!(voided.covers_at("SHIOAJI", "fut", "2026-11-06", "night", 156516710), "names compare as the WAL spells them");
    }

    #[test]
    fn the_fingerprint_follows_the_ranges_not_the_reasons_and_an_empty_list_is_none() {
        let voided = Voided::parse(LIST.as_bytes()).unwrap();
        let reworded = Voided::parse(LIST.replace("test backfill", "a backfill").as_bytes()).unwrap();
        assert_eq!(voided.fingerprint(), reworded.fingerprint());
        let widened = Voided::parse(LIST.replace("156516720", "156516721").as_bytes()).unwrap();
        assert_ne!(voided.fingerprint(), widened.fingerprint());
        assert_eq!(Voided::default().fingerprint(), "none");
        assert_eq!(Voided::parse(b"[]").unwrap().fingerprint(), "none");
    }

    #[test]
    fn a_missing_file_is_an_empty_list_and_a_bad_one_is_refused() {
        let dir = std::env::temp_dir().join(format!("voided-{}-{}", std::process::id(), line!()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(Voided::load(Some(&dir.join("absent.json"))).unwrap().is_empty());
        assert!(Voided::load(None).unwrap().is_empty());
        for bad in [r#"{"durable": "1-2"}"#, r#"[{"source": "shioaji", "market": "FUT", "trading_date": "2026-11-06", "session": "NIGHT", "durable": "9-3", "reason": "x"}]"#,
                    r#"[{"source": "shioaji", "market": "FUT", "trading_date": "2026-11-06", "session": "NIGHT", "durable": "3-9", "reason": ""}]"#,
                    r#"[{"source": "shioaji", "market": "FUT", "trading_date": "11/06", "session": "NIGHT", "durable": "3-9", "reason": "x"}]"#,
                    r#"[{"source": "shioaji", "market": "FUT", "trading_date": "2026-11-06", "session": "NIGHT", "durable": "3-9", "reason": "x", "extra": 1}]"#] {
            let path = dir.join("bad.json");
            fs::write(&path, bad).unwrap();
            assert!(Voided::load(Some(&path)).is_err(), "refused: {bad}");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
