//! A session's events of a few instruments, read straight from the WAL: what the historical materializer writes for
//! them, before it has run -- the replay of a day not materialized yet (replay::provisional_from_wal).
//!
//! Which events belong to a session, and how the kept ones are cleaned, is one rule shared with the materializer
//! (analysis_runtime materialize.rs): `belongs` selects, `dedupe` keeps each event once and counts what is not loss
//! apart from what is, and `Engine::classify_recorded` drops the broker's re-sent prints. The events read for an
//! instrument are therefore the events its partition will hold, in the same order.
//!
//! The segments are read in parallel; a record is decoded only when its bytes name one of the wanted symbols.
//! Segments last written before the day ahead of the trading date are skipped (one day's appends per segment; a night
//! session is dated by the day it opened).
//!
//! Output, tab separated, symbols in the order asked:
//! - `E <json>`: one event (a MarketEvent, as the partition's events.jsonl line)
//! - `S <segment> <end> <state>`: how a segment read ended -- `whole`, `appending` (the file ends inside a record
//!   still being written), `damaged <reason>` or `unreadable <reason>`; anything but whole/appending means events
//!   may be missing.

use crate::event::{days_from_civil, parse_calendar_date, MarketEvent, Payload, CLOCK_CODE};
use crate::state::Engine;
use crate::voided::Voided;
use crate::wal::{read_record_bytes, segment_ids, segment_path, taipei_day, RawRecord, WAL_MAGIC};
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::UNIX_EPOCH;

/// Whether `event` is history of the (trading_date, session) partition: 盤前試撮 is never history (Market Runtime does
/// not write it; older segments still hold some), and the clock is no instrument.
pub fn belongs(event: &MarketEvent, trading_date: &str, session: &str) -> bool {
    let preopen_auction = event.is_preopen() && (event.is_indicative() || matches!(event.payload, Payload::OrderBook { .. }));
    event.trading_date == trading_date && event.session.eq_ignore_ascii_case(session) && !preopen_auction
        && event.code != CLOCK_CODE
}

/// What a partition's events say about themselves, apart from the fold.
#[derive(Default, Debug, Clone)]
pub struct Ledger {
    /// The same event (event_id, else provider stream + sequence) more than once: kept once.
    pub duplicates: u64,
    /// Provider sequence going backwards within one stream: ordering noise, not loss.
    pub out_of_order: u64,
    /// Events the producer said it dropped before this one (sum of flags.gap_before): loss.
    pub producer_dropped: u64,
    /// Prints the broker re-sent (the 14:30 copy of the close) in a WAL written before the ingest dropped them.
    pub resent_prints: u64,
}

/// Keep each event once, in durable order, and count what is not loss separately from what is.
pub fn dedupe(events: Vec<MarketEvent>) -> (Vec<MarketEvent>, Ledger) {
    let mut ledger = Ledger::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut last_in_stream: BTreeMap<String, u64> = BTreeMap::new();
    let mut kept = Vec::with_capacity(events.len());
    for e in events {
        let stream = format!("{}|{}", e.generation, e.payload.stream_key());
        let identity = if e.event_id.is_empty() { format!("{stream}|{}", e.sequence) } else { e.event_id.clone() };
        if !seen.insert(identity) {
            ledger.duplicates += 1;
            continue;
        }
        if let Some(last) = last_in_stream.get(&stream) {
            if e.sequence > 0 && e.sequence < *last {
                ledger.out_of_order += 1;
            }
        }
        if e.sequence > 0 {
            let entry = last_in_stream.entry(stream).or_insert(0);
            *entry = (*entry).max(e.sequence);
        }
        ledger.producer_dropped += e.flags.gap_before;
        kept.push(e);
    }
    (kept, ledger)
}

/// A partition's events as the materializer keeps them: durable order, each once, re-sent prints dropped.
pub fn clean(mut events: Vec<MarketEvent>) -> (Vec<MarketEvent>, Ledger) {
    events.sort_by_key(|e| e.durable_sequence);
    let (events, mut ledger) = dedupe(events);
    let (events, resent) = Engine::classify_recorded(events);
    ledger.resent_prints = resent;
    (events, ledger)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|window| window == needle)
}

struct SegmentRead {
    events: Vec<MarketEvent>,
    end: u64,
    state: String,
}

fn read_segment(dir: &Path, segment: u64, patterns: &[Vec<u8>], symbols: &[String], trading_date: &str, session: &str, voided: &Voided) -> SegmentRead {
    let mut read = SegmentRead { events: Vec::new(), end: WAL_MAGIC.len() as u64, state: String::new() };
    let file = match File::open(segment_path(dir, segment)) {
        Ok(file) => file,
        Err(e) => {
            read.state = format!("unreadable open: {e}");
            return read;
        }
    };
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut magic = [0u8; 8];
    if reader.read_exact(&mut magic).is_err() || &magic != WAL_MAGIC {
        read.state = "damaged not a WAL segment (magic)".into();
        return read;
    }
    read.state = loop {
        let (bytes, size) = match read_record_bytes(&mut reader) {
            RawRecord::Bytes(bytes, size) => (bytes, size),
            RawRecord::End => break "whole".into(),
            RawRecord::Torn(_) => break "appending".into(),
            RawRecord::Bad(reason) => break format!("damaged {reason}"),
        };
        read.end += size;
        if !patterns.iter().any(|pattern| contains(&bytes, pattern)) {
            continue;
        }
        // An older-format record is never history here either (the materializer's reader skips it too).
        let Ok(event) = MarketEvent::decode_slice(&bytes) else { continue };
        if symbols.iter().any(|symbol| *symbol == event.symbol) && belongs(&event, trading_date, session) && !voided.covers(&event) {
            read.events.push(event);
        }
    };
    read
}

/// The WAL's segments that may hold `trading_date`: every one last written on or after the day before it.
fn candidate_segments(dir: &Path, trading_date: &str) -> std::io::Result<Vec<u64>> {
    let floor = match parse_calendar_date(trading_date) {
        Some((y, m, d)) => days_from_civil(y, m, d) - 1,
        None => i64::MIN,
    };
    let ids = segment_ids(dir)?;
    let newest = ids.last().copied();
    Ok(ids.into_iter().filter(|&id| {
        let written = std::fs::metadata(segment_path(dir, id)).and_then(|m| m.modified()).ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| taipei_day(d.as_secs() as i64));
        Some(id) == newest || written.is_none_or(|day| day >= floor)
    }).collect())
}

/// The cleaned events of each of `symbols` in (trading_date, session), the void ones left out (crate::voided), and how
/// each segment read ended.
pub fn session_events(dir: &Path, symbols: &[String], trading_date: &str, session: &str, voided: &Voided)
    -> std::io::Result<(BTreeMap<String, Vec<MarketEvent>>, Vec<(u64, u64, String)>)> {
    let segments = candidate_segments(dir, trading_date)?;
    let patterns: Vec<Vec<u8>> = symbols.iter().map(|symbol| format!("\"symbol\":\"{symbol}\"").into_bytes()).collect();
    let next = AtomicUsize::new(0);
    let workers = thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8).min(segments.len().max(1));
    let mut reads: Vec<Option<SegmentRead>> = (0..segments.len()).map(|_| None).collect();
    thread::scope(|scope| {
        let handles: Vec<_> = (0..workers).map(|_| scope.spawn(|| {
            let mut done = Vec::new();
            loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(&segment) = segments.get(i) else { break };
                done.push((i, read_segment(dir, segment, &patterns, symbols, trading_date, session, voided)));
            }
            done
        })).collect();
        for handle in handles {
            for (i, read) in handle.join().unwrap_or_default() {
                reads[i] = Some(read);
            }
        }
    });
    let mut by_symbol: BTreeMap<String, Vec<MarketEvent>> = BTreeMap::new();
    let mut states = Vec::with_capacity(segments.len());
    for (segment, read) in segments.iter().zip(reads) {
        let read = read.unwrap_or(SegmentRead { events: Vec::new(), end: 0, state: "unreadable the reader stopped".into() });
        states.push((*segment, read.end, read.state));
        for event in read.events {
            by_symbol.entry(event.symbol.clone()).or_default().push(event);
        }
    }
    let cleaned = by_symbol.into_iter().map(|(symbol, events)| (symbol, clean(events).0)).collect();
    Ok((cleaned, states))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::tests_support::trade_event;

    fn frame(event: &MarketEvent) -> Vec<u8> {
        let body = serde_json::to_vec(event).unwrap();
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&body);
        out.extend_from_slice(&crate::wal::crc32(&body).to_le_bytes());
        out
    }

    fn trade(code: &str, seq: u64, date: &str) -> MarketEvent {
        let mut event = trade_event(code, seq, 1_000_000 + seq as i64);
        event.event_id = format!("shioaji:STK:{code}:1:trade:{seq}");
        event.trading_date = date.into();
        event
    }

    #[test]
    fn reads_the_partition_the_materializer_would_write_for_each_symbol_asked() {
        let dir = std::env::temp_dir().join(format!("wal_session_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let date = "2026-11-02";
        // Segment 1: 4958's later trade, a duplicate of it, 2330's, a longer code sharing the prefix, another day's.
        let mut first = WAL_MAGIC.to_vec();
        for event in [trade("4958", 5, date), trade("4958", 5, date), trade("2330", 6, date), trade("49580", 7, date),
                      trade("4958", 8, "2026-10-30")] {
            first.extend(frame(&event));
        }
        // Segment 2: 4958's earlier trade (durable order is by sequence, not segment), then an append in progress.
        let mut second = WAL_MAGIC.to_vec();
        second.extend(frame(&trade("4958", 3, date)));
        let whole = second.len() as u64;
        second.extend_from_slice(&[9, 0, 0]);
        std::fs::write(segment_path(&dir, 1), &first).unwrap();
        std::fs::write(segment_path(&dir, 2), &second).unwrap();

        let symbols = vec!["shioaji:STK:4958".to_string(), "shioaji:STK:2330".to_string()];
        let (events, states) = session_events(&dir, &symbols, date, "DAY", &Voided::default()).unwrap();
        let sequences = |symbol: &str| events.get(symbol).map(|e| e.iter().map(|e| e.durable_sequence).collect::<Vec<_>>());
        assert_eq!(sequences("shioaji:STK:4958"), Some(vec![3, 5]), "the day's events, once each, in durable order");
        assert_eq!(sequences("shioaji:STK:2330"), Some(vec![6]));
        assert!(!events.contains_key("shioaji:STK:49580"), "a code that only shares the prefix is not read");
        assert_eq!(states, vec![(1, first.len() as u64, "whole".to_string()), (2, whole, "appending".to_string())]);
        let voided = Voided::parse(format!(r#"[{{"source": "shioaji", "market": "STK", "trading_date": "{date}", "session": "DAY",
            "durable": "5-6", "reason": "test"}}]"#).as_bytes()).unwrap();
        let (events, _) = session_events(&dir, &symbols, date, "DAY", &voided).unwrap();
        let sequences = |symbol: &str| events.get(symbol).map(|e| e.iter().map(|e| e.durable_sequence).collect::<Vec<_>>());
        assert_eq!((sequences("shioaji:STK:4958"), sequences("shioaji:STK:2330")), (Some(vec![3]), None), "void events are not the session's");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_is_the_materializers_rule_dedupe_in_durable_order() {
        let (events, ledger) = clean(vec![trade("4958", 9, "2026-11-02"), trade("4958", 4, "2026-11-02"), trade("4958", 9, "2026-11-02")]);
        assert_eq!(events.iter().map(|e| e.durable_sequence).collect::<Vec<_>>(), vec![4, 9]);
        assert_eq!(ledger.duplicates, 1);
        let mut other_session = trade("4958", 1, "2026-11-02");
        other_session.session = "NIGHT".into();
        assert!(!belongs(&other_session, "2026-11-02", "DAY"));
        assert!(belongs(&trade("4958", 1, "2026-11-02"), "2026-11-02", "day"));
    }
}
