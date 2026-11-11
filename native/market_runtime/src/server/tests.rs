//! Unit tests of the server modules (each module below names what it uses).

use super::{startup::*, ingest::*, retention::*, session::*, replay_feed::*};
use crate::event::{
    InstrumentKey,
    SessionKey, StateKey,
};
use crate::remediation::utc_iso_ms;
use crate::replay::{Partition, ReplaySession};
use serde_json::json;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self};
use std::path::PathBuf;

#[cfg(test)]
mod durable_state_tests {
    use super::{next_epoch, stream_identity, EPOCH_FILE, STREAM_IDENTITY_FILE};
    use std::fs;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mr-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_damaged_identity_or_epoch_stops_the_start_and_is_left_as_it_is() {
        let d = dir("damaged");
        // Absent: a first start.
        let (id, _) = stream_identity(&d, Some("1:0000abcd:10".into())).unwrap();
        assert_eq!(next_epoch(&d).unwrap(), 1);
        assert_eq!(stream_identity(&d, Some("1:0000abcd:10".into())).unwrap(), (id.clone(), true));
        assert_eq!(next_epoch(&d).unwrap(), 2);
        for damaged in ["{\"durable_stream_id\": ", "{\"wal_anchor\": \"1:0000abcd:10\"}", "{\"durable_stream_id\": \"x\", \"wal_anchors\": [1]}"] {
            fs::write(d.join(STREAM_IDENTITY_FILE), damaged).unwrap();
            assert!(stream_identity(&d, Some("1:0000abcd:10".into())).is_err(), "{damaged}");
            assert_eq!(fs::read_to_string(d.join(STREAM_IDENTITY_FILE)).unwrap(), damaged, "never overwritten with a new id");
        }
        fs::write(d.join(EPOCH_FILE), "seven").unwrap();
        assert!(next_epoch(&d).is_err());
        assert_eq!(fs::read_to_string(d.join(EPOCH_FILE)).unwrap(), "seven");
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod tape_presentation_tests {
    use super::tape_presentation;

    #[test]
    fn the_pre_open_shows_the_new_day_and_only_a_cache_without_events_outside_the_session_reads_the_archive() {
        assert_eq!(tape_presentation(false, "PREOPEN"), "CURRENT", "the pre-open: today, empty -- never the previous day");
        assert_eq!(tape_presentation(false, "LIVE"), "CURRENT");
        assert_eq!(tape_presentation(true, "CLOSED"), "CURRENT");
        assert_eq!(tape_presentation(false, "CLOSED"), "ARCHIVE", "a restart after the close: the day's archive");
        assert_eq!(tape_presentation(false, ""), "ARCHIVE");
    }
}

#[cfg(test)]
mod diag_tests {
    use super::utc_iso_ms;

    #[test]
    fn close_log_time_is_utc_with_milliseconds() {
        // 2026-10-08T04:44:14.150Z, the renderer close of the 12:44 Taipei incident.
        assert_eq!(utc_iso_ms(1_791_434_654_150_000_000), "2026-10-08T04:44:14.150Z");
        assert_eq!(utc_iso_ms(0), "1970-01-01T00:00:00.000Z");
    }
}

#[cfg(test)]
mod clock_scope_tests {
    use super::calendar_scope_clock_minute;

    // 2026-10-16 03:59:30 UTC = 2026-10-15 23:59:30 New York (EDT).
    const NY_1015_2359: i64 = 1_792_123_170_000_000_000;

    #[test]
    fn a_scope_whose_day_has_not_begun_gets_no_clock() {
        // Futu's "00:00" bar opened the 10-16 scope at 23:59 on 10-15: no `1439` may be sent for it.
        assert_eq!(calendar_scope_clock_minute("US", "2026-10-16", NY_1015_2359), None);
        assert_eq!(calendar_scope_clock_minute("US", "2026-10-15", NY_1015_2359), Some(1439));
        // Once its day has begun the new scope is clocked from 00:00.
        assert_eq!(calendar_scope_clock_minute("US", "2026-10-16", NY_1015_2359 + 30_000_000_000), Some(0));
    }

    #[test]
    fn a_scope_dated_away_from_its_timestamps_keeps_running() {
        // A recorded feed may stamp a trading date unrelated to its timestamps, earlier or later.
        assert_eq!(calendar_scope_clock_minute("US", "2026-09-30", NY_1015_2359), Some(1439));
        assert_eq!(calendar_scope_clock_minute("US", "2026-10-22", NY_1015_2359), Some(1439));
    }
}

#[cfg(test)]
mod replay_timeline_tests {
    use super::*;
    use crate::timeline::SpanBuilder;

    /// A replay shows Rust B's analysis of exactly the step it stands on: a seek anywhere takes that step's analysis
    /// from the timeline (the step's own, never a neighbour's), and a step whose span B has not sent yet shows none.
    #[test]
    fn a_seek_shows_the_analysis_of_the_step_it_lands_on_and_none_before_it_is_built() {
        let partition = Partition::new("shioaji", "STK", "2330", "2026-09-29", "DAY").unwrap();
        let events: Vec<crate::event::MarketEvent> = (0..600u64).map(|i| {
            let mut e = crate::state::tests_support::trade_event("2330", i + 1, 1_000_000);
            e.exchange_ts_ns = 1_790_643_600_000_000_000 + i as i64 * 1_000_000_000;
            e
        }).collect();
        let due = crate::replay::due_times(&events);
        let committed = crate::replay::Committed { content_hash: "h".into(), lines: events.len() as u64 };
        let loaded = crate::replay::Loaded { events, due, unreadable: 0, committed };
        let recording = std::sync::Arc::new(crate::replay::Recording::new(partition, std::path::PathBuf::from("p"), loaded));
        let steps = recording.steps.len();
        let len = recording.timeline.read().unwrap().span_len;
        // B's analysis at step p: the day block's close says p.
        let identity = json!({"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"});
        let item = |p: usize| json!({"identity": identity, "block": "day", "input_watermark": p, "as_of": p.to_string(), "data": {"close": p}});
        let span = |first: usize| {
            let end = (first + len).min(steps);
            let mut b = SpanBuilder::new(first, vec![item(first)]);
            for step in first..end {
                b.step(step, vec![item(step + 1)]);
            }
            b.wire(end - first)
        };
        recording.timeline.write().unwrap().insert("v1", &span(0)).unwrap();
        let mut replay = ReplaySession::new("r1".into(), recording.clone(), 7);
        let key = StateKey { instrument: InstrumentKey { source: "shioaji".into(), market: "STK".into(), code: "2330".into() },
                             session: SessionKey { trading_date: "2026-09-29".into(), session: "DAY".into() } };
        let close = |replay: &ReplaySession| replay.core.projection.entry(&key).map(|e| e.day["close"].clone()).filter(|v| !v.is_null());
        for second in [0i64, 1, 37, (len / 2) as i64] {
            replay.seek(1_790_643_600_000_000_000 + second * 1_000_000_000);
            refresh_analysis(&mut replay);
            assert!(replay.position <= recording.event_steps.get(replay.cursor).copied().unwrap_or(steps), "never past the events applied");
            assert_eq!(close(&replay), Some(json!(replay.position)), "the analysis of the step the seek landed on ({second} s)");
        }
        // Past the span B sent: none, until B sends it.
        replay.seek(1_790_643_600_000_000_000 + (len as i64 + 20) * 1_000_000_000);
        refresh_analysis(&mut replay);
        assert!(replay.analysis.is_none() && close(&replay).is_none(), "not built: no analysis, never another step's");
        recording.timeline.write().unwrap().insert("v1", &span(len)).unwrap();
        refresh_analysis(&mut replay);
        assert_eq!(close(&replay), Some(json!(replay.position)));
    }
}

#[cfg(test)]
mod rollover_view_tests {
    use super::*;

    fn key(date: &str) -> StateKey {
        StateKey { instrument: InstrumentKey::new("shioaji", "STK", "2330"), session: SessionKey { trading_date: date.into(), session: "DAY".into() } }
    }

    fn view(bound: Option<StateKey>) -> View {
        View { id: "v".into(), request_id: String::new(), instrument: InstrumentKey::new("shioaji", "STK", "2330"), trading_date: None, session: Some("DAY".into()),
            channels: Vec::new(), bound, baseline: 0, sent_sequence: 3, replay: None, shown: None }
    }

    #[test]
    fn a_rollover_touches_only_the_markets_that_moved() {
        // Futu crypto's midnight clear must not re-snapshot an STK view (bound or not).
        let rolled: BTreeMap<String, String> = [("shioaji|STK|DAY", "2026-10-08"), ("shioaji|FUT|NIGHT", "2026-10-08")]
            .into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let mut rolled_after = rolled.clone();
        rolled_after.insert("shioaji|FUT|NIGHT".into(), "2026-10-09".into());
        let cleared: BTreeMap<String, i64> = [("futu|CC".to_string(), 1)].into_iter().collect();
        let cleared_after: BTreeMap<String, i64> = [("futu|CC".to_string(), 2)].into_iter().collect();
        let moved = moved_markets(&rolled, &rolled_after, &cleared, &cleared_after);
        assert_eq!(moved, ["shioaji|FUT".to_string(), "futu|CC".to_string()].into_iter().collect::<HashSet<_>>());
        assert!(moved_markets(&rolled, &rolled, &cleared, &cleared).is_empty());
    }

    #[test]
    fn a_rollover_rebinds_only_a_view_whose_partition_moved() {
        // A view of a market that did not roll keeps its stream; one whose session rolled is rebound.
        assert!(!rolled_under(&view(Some(key("2026-10-08"))), || Some(key("2026-10-08"))), "same partition: untouched");
        assert!(rolled_under(&view(Some(key("2026-10-08"))), || Some(key("2026-10-09"))), "its session rolled");
        assert!(rolled_under(&view(Some(key("2026-10-08"))), || None), "its partition left and the new one is empty");
        assert!(rolled_under(&view(None), || None), "never bound");
    }
}

#[cfg(test)]
mod revision_read_tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mr-revision-read-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("background")).unwrap();
        dir
    }

    #[test]
    fn missing_pointer_is_absent_only_when_revisions_are_provably_missing_or_empty() {
        let r = root("absent");
        assert!(matches!(read_active_revision(&r, "background"), RevisionRead::Absent));
        fs::create_dir_all(r.join("background").join("revisions")).unwrap();
        assert!(matches!(read_active_revision(&r, "background"), RevisionRead::Absent));
        // A leftover tmp from an interrupted save is not a revision (config_revisions.py counts the same way).
        fs::write(r.join("background").join("revisions").join("r000001.json.tmp"), "{}").unwrap();
        assert!(matches!(read_active_revision(&r, "background"), RevisionRead::Absent));
        fs::write(r.join("background").join("revisions").join("r000001.json"), "{}").unwrap();
        assert!(matches!(read_active_revision(&r, "background"), RevisionRead::Unusable(_)));
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn unreadable_revisions_folder_is_unusable_not_absent() {
        // A `revisions` that cannot be listed (here: a file where the folder belongs) is not "no settings".
        let r = root("unreadable");
        fs::write(r.join("background").join("revisions"), "not a folder").unwrap();
        assert!(matches!(read_active_revision(&r, "background"), RevisionRead::Unusable(_)));
        let _ = fs::remove_dir_all(&r);
    }
}

#[cfg(test)]
mod supervisor_tests {
    use super::Workers;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn a_start_that_fails_stops_and_joins_the_loops_it_started() {
        let running = Arc::new(AtomicBool::new(true));
        let ended = Arc::new(AtomicBool::new(false));
        {
            let stop = running.clone();
            let mut workers = Workers::new(move || stop.store(false, Ordering::Release));
            let (running, ended) = (running.clone(), ended.clone());
            workers.spawn("loop", move || {
                while running.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                ended.store(true, Ordering::Release);
            }).unwrap();
            // A later spawn failed: `start` returns its error and drops the workers.
        }
        assert!(!running.load(Ordering::Acquire), "the stop flag was set");
        assert!(ended.load(Ordering::Acquire), "the loop was joined before the drop returned");
    }

    #[test]
    fn a_worker_that_panicked_is_reported_by_name() {
        let mut workers = Workers::new(|| {});
        workers.spawn("fine", || {}).unwrap();
        workers.spawn("broken", || panic!("lost the plot")).unwrap();
        assert_eq!(workers.join_all(), vec!["broken: lost the plot".to_owned()]);
    }
}


#[cfg(test)]
mod replay_diff_tests {
    use super::*;
    use serde_json::Value;

    fn key() -> StateKey {
        StateKey { instrument: InstrumentKey::new("shioaji", "STK", "2330"), session: SessionKey { trading_date: "2026-09-29".into(), session: "DAY".into() } }
    }

    /// A seek a few seconds on is told as what changed; one across most of the day, where the operations would be no
    /// smaller than the view, goes whole.
    #[test]
    fn a_seek_is_sent_as_what_changed_unless_that_is_no_smaller_than_the_view() {
        let trades = |from: u64, to: u64| Value::Array((from..to).map(|n| json!({"durable_sequence": n, "price": 100.5, "volume": 1})).collect());
        let held = Shown { sequence: 4, key: key(), view: json!({"generation": 2, "trades": trades(0, 100), "summary": {"price": 100.5}}) };
        let near = json!({"generation": 3, "trades": trades(2, 102), "summary": {"price": 101.0}});
        let whole = serde_json::to_vec(&near).unwrap().len();
        let frame: Value = serde_json::from_slice(&replay_diff_frame(&held, "v1", "r1", 5, "REPLAY_SEEK", &near, whole).expect("a near seek is a diff")).unwrap();
        assert_eq!(frame["type"], "view.replay_diff");
        let p = &frame["payload"];
        assert_eq!((p["base_sequence"].as_u64(), p["sequence"].as_u64(), p["base_generation"].as_u64(), p["generation"].as_u64()),
                   (Some(4), Some(5), Some(2), Some(3)), "names the view it moves and the one it makes");
        let mut moved = held.view.clone();
        crate::view_diff::apply(&mut moved, p["ops"].as_array().unwrap()).unwrap();
        assert_eq!(moved, near);
        // Every field different: the operations and their paths outweigh the view itself.
        let far = json!({"generation": 9, "trades": [{"durable_sequence": 900}], "summary": {"price": 7}});
        let held = Shown { sequence: 4, key: key(), view: json!({"generation": 2, "trades": [{"durable_sequence": 1}], "summary": {"price": 1}}) };
        assert!(replay_diff_frame(&held, "v1", "r1", 5, "REPLAY_SEEK", &far, serde_json::to_vec(&far).unwrap().len()).is_none(), "whole");
    }
}
