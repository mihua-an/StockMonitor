//! 歷史回放: recorded partitions played back in their own views, never into the live cache.
//! (docs/system-architecture/08 section 1, the Rust A rows.)

mod support;

use support::*;

#[test]
fn a_replay_plays_recorded_prints_at_their_own_times_in_its_own_views_and_writes_nothing() {
    let root = temp_dir("replay");
    // 1.000 s, 1.002 s, 1.004 s, then 0.5 s later: prints in the same second must not arrive together.
    let base = 1_790_647_200_000_000_000i64; // 2026-09-29 10:00 Taipei, inside the day session
    let events: Vec<Value> = vec![recorded_trade(11, base, 1_000_500), recorded_trade(12, base + 2_000_000, 1_001_000),
        recorded_trade(13, base + 4_000_000, 1_001_500), recorded_trade(14, base + 500_000_000, 1_002_000)];
    write_partition(&root, &events);
    let historical = root.join("historical").to_string_lossy().into_owned();
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--historical-dir", &historical]);

    let mut live = daemon.client(VIEWER);
    live.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    live.await_type("view.snapshot");

    let mut viewer = daemon.client(VIEWER);
    viewer.send(json!({"type": "replay.open", "request_id": "o1", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    let opened = viewer.await_type("replay.opened")["payload"].clone();
    assert_eq!(opened["ok"], true, "{opened}");
    let replay_id = opened["replay_id"].as_str().unwrap().to_string();
    assert_eq!(opened["status"]["total"], 4);
    assert_eq!(opened["status"]["playing"], false, "opens paused at the first event");

    viewer.send(json!({"type": "view.subscribe", "request_id": "s1", "payload": {"source": "shioaji", "market": "STK", "code": "2330",
        "trading_date": "2026-09-29", "session": "DAY", "replay_id": replay_id}}));
    let snapshot = viewer.await_type("view.snapshot")["payload"].clone();
    assert_eq!(snapshot["replay_id"], replay_id.as_str());
    assert_eq!(snapshot["trades"].as_array().map(Vec::len), Some(0), "nothing played yet");

    viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "play"}}));
    let started = Instant::now();
    let mut arrivals: Vec<Duration> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while arrivals.len() < 4 && Instant::now() < deadline {
        if let Some(message) = viewer.read(deadline) {
            for d in deltas(&[message]) {
                if d["delta_type"] == "trade.frame" {
                    assert_eq!(d["replay_id"], replay_id.as_str());
                    arrivals.push(started.elapsed());
                }
            }
        }
    }
    assert_eq!(arrivals.len(), 4, "every recorded print is played: {arrivals:?}");
    assert!(arrivals[3] - arrivals[2] >= Duration::from_millis(400), "the print 0.5 s later waits for it: {arrivals:?}");
    assert!(arrivals[2] - arrivals[0] < Duration::from_millis(200), "prints 2 ms apart are not held for a second: {arrivals:?}");

    let leaked = deltas(&live.drain(300));
    assert!(leaked.is_empty(), "the live view of the same stock never sees replay deltas: {leaked:?}");

    // Seek back to the start: the replay's views are re-snapshotted from the rebuilt state.
    viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "seek", "at_ns": base.to_string()}}));
    let resync = viewer.until(|seen| seen.iter().any(|m| m["type"] == "view.snapshot" && m["payload"]["resync_reason"] == "REPLAY_SEEK"));
    let rebuilt = resync.iter().find(|m| m["type"] == "view.snapshot").unwrap();
    assert_eq!(rebuilt["payload"]["trades"].as_array().map(Vec::len), Some(1), "state rebuilt at the first print");
    viewer.send(json!({"type": "replay.control", "request_id": "c9", "payload": {"replay_id": replay_id, "action": "speed", "speed": 3}}));
    assert_eq!(viewer.await_type("replay.control.ack")["payload"]["ok"], false, "only 1/2/5/10x");

    // Another viewer neither drives, closes nor replaces the replay: it is its owner's.
    live.send(json!({"type": "replay.control", "request_id": "x1", "payload": {"replay_id": replay_id, "action": "pause"}}));
    assert_eq!(live.await_type("replay.control.ack")["payload"]["error"], "NOT_OWNER");
    live.send(json!({"type": "replay.close", "request_id": "x2", "payload": {"replay_id": replay_id}}));
    let refused = live.await_type("replay.closed")["payload"].clone();
    assert_eq!((refused["ok"].as_bool(), refused["closed"].as_bool(), refused["error"].as_str()), (Some(false), Some(false), Some("NOT_OWNER")));
    live.send(json!({"type": "replay.open", "request_id": "x3", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    assert_eq!(live.await_type("replay.opened")["payload"]["error"], "REPLAY_BUSY");

    let mut controller = daemon.client(CONTROLLER);
    controller.send(json!({"type": "metrics"}));
    let metrics = controller.await_type("metrics")["payload"].clone();
    assert_eq!(metrics["wal"]["committed"], 0, "a replay writes no WAL record");
    assert_eq!(metrics["ingest"]["accepted"], 0);
    assert!(metrics["replay"]["deltas_sent"].as_u64().unwrap_or(0) >= 4);
    assert_eq!(metrics["replay"]["opened"], 1, "the refused REPLAY_BUSY open is not counted as opened");

    // Its owner closes it: the reply says ok, as every replay reply does when the request was done.
    viewer.send(json!({"type": "replay.close", "request_id": "c10", "payload": {"replay_id": replay_id}}));
    let closed = viewer.await_type("replay.closed")["payload"].clone();
    assert_eq!((closed["ok"].as_bool(), closed["closed"].as_bool(), closed["error"].is_null()), (Some(true), Some(true), true), "{closed}");
    controller.send(json!({"type": "metrics"}));
    assert!(controller.await_type("metrics")["payload"]["replay"]["active"].is_null(), "a closed replay is gone");

    viewer.send(json!({"type": "replay.open", "request_id": "o2", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    assert_eq!(viewer.await_type("replay.opened")["payload"]["ok"], true);
    drop(viewer);
    std::thread::sleep(Duration::from_millis(300));
    controller.send(json!({"type": "metrics"}));
    assert!(controller.await_type("metrics")["payload"]["replay"]["active"].is_null(), "the replay ends with the connection that opened it");
}

#[test]
fn a_replay_views_generation_only_rises_when_a_seek_goes_back_across_a_recorded_reconnect() {
    // A recorded day spans more than one provider connection (a reconnect, the after-hours session). The replay's
    // views carried the generation of the last event applied, so a seek back across the reconnect sent an older one
    // and the renderer, which refuses an older generation, froze every panel until the replay was reopened.
    let root = temp_dir("replay-generation");
    let base = 1_790_647_200_000_000_000i64; // 2026-09-29 10:00 Taipei, inside the day session
    let mut events: Vec<Value> = vec![recorded_trade(11, base, 1_000_500), recorded_trade(12, base + 1_000_000, 1_001_000),
        recorded_trade(13, base + 2_000_000, 1_001_500), recorded_trade(14, base + 3_000_000, 1_002_000)];
    for event in &mut events[2..] {
        event["generation"] = json!(9);
    }
    write_partition(&root, &events);
    let historical = root.join("historical").to_string_lossy().into_owned();
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--historical-dir", &historical]);
    let mut viewer = daemon.client(VIEWER);
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    let replay_id = viewer.await_type("replay.opened")["payload"]["replay_id"].as_str().unwrap().to_string();
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330",
        "trading_date": "2026-09-29", "session": "DAY", "replay_id": replay_id}}));
    let mut view = viewer.await_type("view.snapshot")["payload"].clone();
    let mut generations = vec![view["generation"].as_u64().unwrap()];
    let mut seek = |at: i64, trades: usize| {
        viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "seek", "at_ns": at.to_string()}}));
        let seen = viewer.until(seek_answered);
        let answers = hold(&mut view, &seen);
        assert_eq!(view["trades"].as_array().map(Vec::len), Some(trades), "rebuilt at the seek target");
        let mut out: Vec<u64> = deltas(&seen).iter().filter_map(|d| d["generation"].as_u64()).collect();
        out.extend(answers.iter().filter_map(|m| m["payload"]["generation"].as_u64()));
        out
    };
    generations.extend(seek(base + 3_000_000, 4));
    generations.extend(seek(base, 1));
    assert!(generations.windows(2).all(|w| w[0] <= w[1]), "a replay view's generation never falls: {generations:?}");
    assert!(generations.last() > generations.first(), "every seek is a new generation of the replay: {generations:?}");
}

#[test]
fn a_replay_of_a_partition_that_was_never_recorded_is_refused() {
    let root = temp_dir("replay-missing");
    let historical = root.join("historical").to_string_lossy().into_owned();
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--historical-dir", &historical]);
    let mut viewer = daemon.client(VIEWER);
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    let reply = viewer.await_type("replay.opened")["payload"].clone();
    assert_eq!((reply["ok"].as_bool(), reply["error"].as_str()), (Some(false), Some("NOT_AVAILABLE")));
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "../../x", "trading_date": "2026-09-29", "session": "DAY"}}));
    assert_eq!(viewer.await_type("replay.opened")["payload"]["error"], "INVALID_IDENTITY");
    let mut provider = daemon.client(SHIOAJI);
    provider.send(json!({"type": "replay.open", "payload": {}}));
    assert_eq!(provider.await_type("error")["error"], "FORBIDDEN", "only a viewer opens a replay");
}

/// A day traded but not materialized yet (台股 seals at 14:40) is replayed from Market Runtime's own WAL: the same
/// replay as a materialized day's, opened as soon as the prints are durable, and opened again it holds the prints
/// that came since.
#[test]
fn a_day_not_materialized_yet_is_replayed_from_the_wal() {
    let root = temp_dir("replay-wal");
    let historical = root.join("historical").to_string_lossy().into_owned();
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--historical-dir", &historical]);
    let mut provider = daemon.client(SHIOAJI);
    let base = 1_790_647_200_000_000_000i64; // 2026-09-29 10:00 Taipei, inside the day session
    let print = |seq: u64| {
        let mut event = trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000 + seq as i64);
        event["exchange_ts_ns"] = json!(base + seq as i64 * 1_000_000_000);
        event
    };
    for seq in 1..=3 {
        ingest(&mut provider, print(seq));
    }
    await_synced(&mut provider, 3);
    let open = |viewer: &mut Ws| {
        viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
        viewer.await_type("replay.opened")["payload"].clone()
    };
    let mut viewer = daemon.client(VIEWER);
    let opened = open(&mut viewer);
    assert_eq!(opened["ok"], true, "a day only the WAL holds is replayed: {opened}");
    assert_eq!(opened["status"]["total"], 3, "{opened}");
    let close = |viewer: &mut Ws, opened: &Value| {
        viewer.send(json!({"type": "replay.close", "payload": {"replay_id": opened["replay_id"]}}));
        viewer.await_type("replay.closed");
    };
    close(&mut viewer, &opened);
    // The partition written from the WAL names the live state's newest durable event it holds: opened again with
    // nothing new, it is read as it is (the day's WAL is not scanned again).
    let manifest_path = root.join("data").join("replay-provisional").join("source=shioaji").join("market=STK")
        .join("trading_date=2026-09-29").join("session=DAY").join("2330").join("manifest.json");
    let manifest = || serde_json::from_str::<Value>(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    assert_eq!(manifest()["live_through"], 3, "{}", manifest());
    let written = std::fs::metadata(&manifest_path).unwrap().modified().unwrap();
    let reopened = open(&mut viewer);
    assert_eq!(reopened["status"]["total"], 3);
    assert_eq!(std::fs::metadata(&manifest_path).unwrap().modified().unwrap(), written, "nothing new: the partition is not written again");
    close(&mut viewer, &reopened);

    ingest(&mut provider, print(4));
    await_synced(&mut provider, 4);
    let again = open(&mut viewer);
    assert_eq!(again["status"]["total"], 4, "opened again, the replay holds the print that came since: {again}");
    assert_eq!(manifest()["live_through"], 4, "written again through the new print");
    // Nothing is written into the historical store: the WAL's copy is Market Runtime's own.
    assert!(!root.join("historical").join("source=shioaji").exists(), "the historical store is the materializer's alone");
    daemon.shutdown();
}

/// The partition written from the WAL outlives a restart: Market Runtime started again over the same data, its live
/// state recovered through the same print, reads it as it is instead of scanning the day's WAL again.
#[test]
fn a_wal_partition_is_read_again_as_it_is_after_a_restart() {
    let root = temp_dir("replay-wal-restart");
    let historical = root.join("historical").to_string_lossy().into_owned();
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--historical-dir", &historical]);
    let mut provider = daemon.client(SHIOAJI);
    let base = 1_790_647_200_000_000_000i64; // 2026-09-29 10:00 Taipei, inside the day session
    for seq in 1..=3u64 {
        let mut event = trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000 + seq as i64);
        event["exchange_ts_ns"] = json!(base + seq as i64 * 1_000_000_000);
        ingest(&mut provider, event);
    }
    await_synced(&mut provider, 3);
    let open = |viewer: &mut Ws| {
        viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
        let opened = viewer.await_type("replay.opened")["payload"].clone();
        assert_eq!(opened["status"]["total"], 3, "{opened}");
        viewer.send(json!({"type": "replay.close", "payload": {"replay_id": opened["replay_id"]}}));
        viewer.await_type("replay.closed");
    };
    open(&mut daemon.client(VIEWER));
    let manifest_path = root.join("data").join("replay-provisional").join("source=shioaji").join("market=STK")
        .join("trading_date=2026-09-29").join("session=DAY").join("2330").join("manifest.json");
    let written = std::fs::metadata(&manifest_path).unwrap().modified().unwrap();
    drop(provider);
    let (root, data) = daemon.shutdown();

    let daemon = Daemon::start_in(root.clone(), data, &["--historical-dir", &historical]);
    assert!(manifest_path.is_file(), "the partition written from the WAL is kept over the restart");
    open(&mut daemon.client(VIEWER));
    assert_eq!(std::fs::metadata(&manifest_path).unwrap().modified().unwrap(), written, "read as it is: not written again");
    daemon.shutdown();
}

#[test]
fn a_replay_shows_its_timeline_s_analysis_of_the_step_it_stands_on_in_its_own_views_only() {
    let root = temp_dir("replay-timeline");
    let base = 1_790_647_200_000_000_000i64; // 2026-09-29 10:00 Taipei, inside the day session
    write_partition(&root, &[recorded_trade(11, base, 1_000_500), recorded_trade(12, base + 1_000_000_000, 1_001_000)]);
    let historical = root.join("historical");
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--historical-dir", &historical.to_string_lossy()]);
    let mut live = daemon.client(VIEWER);
    live.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29",
        "session": "DAY", "channels": ["signals"]}}));
    live.await_type("view.snapshot");
    let mut viewer = daemon.client(VIEWER);
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    let replay_id = viewer.await_type("replay.opened")["payload"]["replay_id"].as_str().unwrap().to_string();
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29",
        "session": "DAY", "channels": ["signals"], "replay_id": replay_id}}));
    let mut view = viewer.await_type("view.snapshot")["payload"].clone();
    assert!(view["signals"].is_null(), "no analysis before B sent its timeline");

    // B's timeline of the recording: at step p the model says p / 10.
    let dir = historical.join("source=shioaji").join("market=STK").join("trading_date=2026-09-29").join("session=DAY").join("2330");
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let recording = json!({"events_path": dir.join("events.jsonl").to_string_lossy(), "content_hash": manifest["content_hash_fnv1a64"]});
    let identity = json!({"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"});
    let item = |p: usize| json!({"identity": identity, "block": "signals", "input_watermark": p,
        "data": {"authority": "analysis_signal_producer", "model_predictions": {"3m_up": {"probability": p as f64 / 10.0, "status": "OK"}}}});
    let steps = 3; // the minute's clock and the two prints
    let mut span = market_runtime::timeline::SpanBuilder::new(0, vec![item(0)]);
    for step in 0..steps {
        span.step(step, vec![item(step + 1)]);
    }
    let mut b = daemon.client(ANALYSIS);
    b.send(json!({"type": "replay.timeline", "payload": {"recording": recording, "version": "v1", "span": span.wire(steps)}}));
    let probability = |view: &Value| view["signals"]["model_predictions"]["3m_up"]["probability"].as_f64();
    let seen = viewer.until(seek_answered);
    hold(&mut view, &seen);
    let position = view["replay"]["analysis"]["position"].as_u64().unwrap();
    assert_eq!(probability(&view), Some(position as f64 / 10.0), "the analysis of the step the replay stands on");
    // Sought past the last print: that step's analysis, with the market state of the same step.
    viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "seek", "at_ns": (base + 2_000_000_000).to_string()}}));
    let seen = viewer.until(seek_answered);
    hold(&mut view, &seen);
    assert_eq!(view["replay"]["analysis"]["position"], json!(steps));
    assert_eq!(probability(&view), Some(steps as f64 / 10.0));
    assert!(deltas(&live.drain(300)).is_empty(), "the live view of the stock gets nothing");
    let mut fresh = daemon.client(VIEWER);
    fresh.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29",
        "session": "DAY", "channels": ["signals"]}}));
    assert!(fresh.await_type("view.snapshot")["payload"]["signals"].is_null(), "and nothing landed in the live cache");
}

/// A seek moves the replay's view by what changed while its client holds exactly the view sent last; the view is sent
/// whole when anything else reached it in between (played prints), when the client asks for it, and to a new
/// subscriber -- and the view moved by the diffs is that whole view.
#[test]
fn a_seek_sends_what_changed_from_the_view_held_and_the_view_whole_when_another_message_reached_it() {
    let root = temp_dir("replay-diff");
    let base = 1_790_647_200_000_000_000i64; // 2026-09-29 10:00 Taipei, inside the day session
    let events: Vec<Value> = (0..40u64).map(|i| recorded_trade(11 + i, base + i as i64 * 1_000_000_000, 1_000_500 + i as i64 * 500)).collect();
    write_partition(&root, &events);
    let historical = root.join("historical").to_string_lossy().into_owned();
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--historical-dir", &historical]);
    let mut viewer = daemon.client(VIEWER);
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    let replay_id = viewer.await_type("replay.opened")["payload"]["replay_id"].as_str().unwrap().to_string();
    let subscribe = json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29",
        "session": "DAY", "replay_id": replay_id}});
    viewer.send(subscribe.clone());
    let mut view = viewer.await_type("view.snapshot")["payload"].clone();
    let seek = |viewer: &mut Ws, view: &mut Value, second: i64| -> Value {
        viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "seek", "at_ns": (base + second * 1_000_000_000).to_string()}}));
        let seen = viewer.until(seek_answered);
        let answers = hold(view, &seen);
        assert_eq!(answers.len(), 1, "one answer per seek: {seen:?}");
        answers[0].clone()
    };
    // From nothing played to the first prints nearly every field is new: whichever is smaller.
    let first = seek(&mut viewer, &mut view, 4);
    // Second by second forward and back: each told as what changed, its sequence the one after the view held.
    let mut sequence = first["payload"]["sequence"].as_u64().unwrap();
    for second in [5, 6, 7, 30, 29, 3] {
        let answer = seek(&mut viewer, &mut view, second);
        assert_eq!(answer["type"], "view.replay_diff", "a seek from the view held is a diff ({second} s)");
        assert_eq!(answer["payload"]["base_sequence"].as_u64(), Some(sequence));
        sequence += 1;
        assert_eq!(answer["payload"]["sequence"].as_u64(), Some(sequence));
        assert!(answer["payload"]["generation"].as_u64() > answer["payload"]["base_generation"].as_u64(), "every seek a newer generation");
        assert_eq!(view["trades"].as_array().map(Vec::len), Some(second as usize + 1), "the prints up to {second} s");
    }
    // Played prints reached the view after the last seek: the next seek's answer is the view whole.
    viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "play"}}));
    let played = viewer.until(|seen| !deltas(seen).is_empty());
    assert!(!deltas(&played).is_empty());
    viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "pause"}}));
    assert_eq!(seek(&mut viewer, &mut view, 10)["type"], "view.snapshot", "deltas reached the view: whole");
    assert_eq!(seek(&mut viewer, &mut view, 12)["type"], "view.replay_diff", "and from that view on, diffs again");
    // The client's own resync gets it whole; the next seek moves that one.
    viewer.send(json!({"type": "view.resync", "payload": {"subscription_id": view["subscription_id"], "reason": "replay_diff_unfit"}}));
    let resent = viewer.await_type("view.snapshot");
    assert_eq!(resent["payload"]["resync_reason"], "CLIENT_REQUESTED");
    hold(&mut view, &[resent]);
    assert_eq!(seek(&mut viewer, &mut view, 13)["type"], "view.replay_diff");
    // The view the diffs moved is what a new subscriber is sent whole.
    let mut fresh = daemon.client(VIEWER);
    fresh.send(subscribe);
    let whole = fresh.await_type("view.snapshot")["payload"].clone();
    let shown = |v: &Value| {
        let mut v = v.clone();
        for k in ["subscription_id", "request_id", "sequence", "watermark", "resync_reason", "replay", "channel_arrival_us"] {
            v.as_object_mut().unwrap().remove(k);
        }
        v
    };
    assert_eq!(shown(&view), shown(&whole));
    let mut controller = daemon.client(CONTROLLER);
    controller.send(json!({"type": "metrics"}));
    assert_eq!(controller.await_type("metrics")["payload"]["replay"]["diffs_sent"], 8, "the eight seeks from a view held");
}
