//! The durable stream: replay, restart and crash recovery, WAL failure, retention, the data-dir lock, the recovering port.
//! (docs/system-architecture/08 section 1, the Rust A rows.)

mod support;

use support::*;

#[test]
fn durable_stream_replays_in_chunks_then_continues_live_without_gaps_or_duplicates() {
    let d = Daemon::start("durable", &[]);
    let mut p = d.client(SHIOAJI);
    let batch: Vec<Value> = (1..=5000).map(|s| trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64)).collect();
    for chunk in batch.chunks(1000) {
        p.send(json!({"type": "event.ingest.batch", "payload": {"events": chunk}}));
        let acks = p.await_type("event.ack.batch");
        assert!(acks["payload"]["results"].as_array().unwrap().iter().all(|a| a["accepted"] == true));
    }
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let subscribed = b.await_type("durable.subscribed");
    let stream_id = subscribed["payload"]["durable_stream_id"].as_str().unwrap().to_string();
    let feeder = std::thread::spawn({
        let port = d.port;
        move || {
            let mut p = Ws::connect(port, SHIOAJI).unwrap();
            for s in 5001..=5600 {
                ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1));
            }
        }
    });
    let mut seen: Vec<u64> = Vec::new();
    let mut trades = 0u64;
    let deadline = Instant::now() + SETTLE;
    let mut batches = 0;
    while Instant::now() < deadline && trades < 5600 {
        if let Some(m) = b.read(deadline) {
            if m["type"] == "durable.batch" {
                batches += 1;
                assert_eq!(m["payload"]["durable_stream_id"], stream_id.as_str());
                for e in m["payload"]["events"].as_array().unwrap() {
                    seen.push(e["durable_sequence"].as_u64().unwrap());
                    // Market clock events are legitimate durable records (a minute boundary may pass mid-test).
                    if e["payload"]["kind"] == "trade" {
                        trades += 1;
                    }
                }
            }
        }
    }
    feeder.join().unwrap();
    assert!(batches >= 3, "replay is chunked");
    let expected: Vec<u64> = (1..=seen.len() as u64).collect();
    assert_eq!(seen, expected, "every committed event exactly once, in order");
    assert_eq!(trades, 5600);
}

/// B catching up a long replay reads its socket only between long stretches of work. A neither drops the connection
/// nor skips a sequence while B is not reading, however long that is: what it cannot write yet waits, the replay goes
/// on from the WAL cursor and the live batches committed meanwhile follow without a hole (decisions.md A 補送給 B 的方式).
#[test]
fn a_b_that_stops_reading_keeps_its_connection_and_receives_every_sequence_once_it_reads_again() {
    const STORED: u64 = 60_000;
    const LIVE: u64 = 2_000;
    let d = Daemon::start("durable-slow-b", &[]);
    let mut p = d.client(SHIOAJI);
    let batch: Vec<Value> = (1..=STORED).map(|s| trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64)).collect();
    for chunk in batch.chunks(1000) {
        p.send(json!({"type": "event.ingest.batch", "payload": {"events": chunk}}));
        let acks = p.await_type("event.ack.batch");
        assert!(acks["payload"]["results"].as_array().unwrap().iter().all(|a| a["accepted"] == true));
    }
    await_synced(&mut p, STORED);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    // B reads nothing for longer than any write wait while the replay fills the socket and live events keep committing.
    let feeder = std::thread::spawn({
        let port = d.port;
        move || {
            let mut p = Ws::connect(port, SHIOAJI).unwrap();
            let live: Vec<Value> = (STORED + 1..=STORED + LIVE).map(|s| trade("shioaji", "STK", "2330", "DAY", s, 1)).collect();
            for chunk in live.chunks(100) {
                p.send(json!({"type": "event.ingest.batch", "payload": {"events": chunk}}));
                p.await_type("event.ack.batch");
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    });
    std::thread::sleep(Duration::from_secs(8));
    feeder.join().unwrap();
    let mut seen: Vec<u64> = Vec::new();
    let mut trades = 0u64;
    let mut other: Vec<Value> = Vec::new();
    let deadline = Instant::now() + SETTLE * 3;
    while Instant::now() < deadline && trades < STORED + LIVE {
        match b.read(deadline) {
            Some(m) if m["type"] == "durable.batch" => {
                for e in m["payload"]["events"].as_array().unwrap() {
                    seen.push(e["durable_sequence"].as_u64().unwrap());
                    if e["payload"]["kind"] == "trade" {
                        trades += 1;
                    }
                }
            }
            Some(m) => other.push(m),
            None => break,
        }
    }
    assert!(other.iter().all(|m| m["type"] != "__close__" && m["type"] != "durable.gap"), "no close, no gap: {other:?}");
    assert_eq!(trades, STORED + LIVE, "every trade arrives after B reads again; others: {other:?}");
    let expected: Vec<u64> = (1..=seen.len() as u64).collect();
    assert!(seen == expected, "every committed event exactly once, in order ({} received)", seen.len());
}

#[test]
fn a_restart_recovers_the_committed_state_and_keeps_the_stream_identity() {
    let d = Daemon::start("restart", &[]);
    let mut p = d.client(SHIOAJI);
    for s in 1..=300 {
        ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64));
    }
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "health"}));
    let before = c.await_type("health")["payload"].clone();
    drop(c);
    drop(p);
    let (root, data) = d.shutdown();
    let d2 = Daemon::start_in(root, data, &[]);
    let mut c = d2.client(CONTROLLER);
    c.send(json!({"type": "metrics"}));
    let metrics = c.await_type("metrics")["payload"].clone();
    assert_eq!(metrics["health"]["durable_stream_id"], before["durable_stream_id"]);
    assert_eq!(metrics["health"]["runtime_epoch"].as_u64().unwrap(), before["runtime_epoch"].as_u64().unwrap() + 1);
    assert_eq!(metrics["recovery"]["previous_shutdown_clean"], true);
    assert_eq!(metrics["recovery"]["checkpoint"], "current");
    assert_eq!(metrics["recovery"]["replayed_events"], 0, "a clean checkpoint needs no replay");
    let mut v = d2.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY"}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    assert_eq!(snap["summary"]["current"], 100.03);
    assert_eq!(snap["trades"].as_array().unwrap().len(), 100);
    // A resend of an old event is refused by the recovered fence.
    let mut p = d2.client(SHIOAJI);
    assert_eq!(ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 300, 1))["reason"], "RejectedSequence");
}

#[test]
fn a_crash_recovers_to_the_committed_prefix_by_replaying_after_the_checkpoint() {
    let d = Daemon::start("crash", &["--checkpoint-interval-s", "3600"]);
    let mut p = d.client(SHIOAJI);
    for s in 1..=100 {
        ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64));
    }
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "checkpoint.now"}));
    let ck = c.await_type("checkpoint.ack")["payload"].clone();
    // The WAL also carries the scope's Clock events (a new scope gets one on the next tick), so the prefix is not a
    // literal 100: it covers all 100 trades and is exactly what was committed when the checkpoint was cut.
    let ck_seq = ck["durable_sequence"].as_u64().unwrap();
    assert!((100..=102).contains(&ck_seq), "a checkpoint names the committed prefix, got {ck_seq}");
    for s in 101..=150 {
        ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64));
    }
    c.send(json!({"type": "health"}));
    let committed = loop {
        let h = c.await_type("health")["payload"].clone();
        if h["committed"].as_u64().unwrap() >= ck_seq + 50 {
            break h["committed"].as_u64().unwrap();
        }
        std::thread::sleep(Duration::from_millis(20));
        c.send(json!({"type": "health"}));
    };
    let (root, data) = d.kill();
    let d2 = Daemon::start_in(root, data, &[]);
    let mut c = d2.client(CONTROLLER);
    c.send(json!({"type": "metrics"}));
    let m = c.await_type("metrics")["payload"].clone();
    assert_eq!(m["recovery"]["previous_shutdown_clean"], false);
    assert_eq!(m["recovery"]["checkpoint_sequence"].as_u64().unwrap(), ck_seq);
    // A's own Clock events can still commit between the health read and the kill, so `committed` is a floor:
    // nothing it named is lost, and everything on disk after the checkpoint is replayed.
    let on_disk = m["recovery"]["wal_max_sequence"].as_u64().unwrap();
    assert!(on_disk >= committed, "every committed event survived the crash: {on_disk} < {committed}");
    assert_eq!(m["recovery"]["replayed_events"].as_u64().unwrap(), on_disk - ck_seq);
    let mut v = d2.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY"}}));
    assert_eq!(v.await_type("view.snapshot")["payload"]["summary"]["current"], 100.015);
}

#[test]
fn a_fractional_share_print_survives_ingest_the_wal_a_crash_and_the_view() {
    // A 0.25-share US print must not be truncated to 0 before it reaches Market Runtime (成交明細 showing 0).
    // Volumes are decimals end to end; this crash test also proves the WAL replay keeps them exactly.
    let d = Daemon::start("fractional", &["--checkpoint-interval-s", "3600"]);
    let mut p = d.client(FUTU);
    let sizes = [0.25, 100.0, 0.1, 0.2, 1.5];
    let mut total = 0.0;
    for (i, size) in sizes.iter().enumerate() {
        let s = i as u64 + 1;
        total += size;
        let mut e = trade("futu", "US", "US.NOK", "FULL", s, 108_550);
        e["data"]["volume"] = json!(size);
        e["data"]["total_volume"] = json!(0);
        let ack = ingest(&mut p, e);
        assert_eq!(ack["accepted"], true, "{ack}");
    }
    let mut quote = trade("futu", "US", "US.NOK", "FULL", 6, 0);
    quote["event_type"] = json!("quote");
    quote["data"] = json!({"current": 108_550, "total_volume": 48_971_788.25, "status": "live"});
    assert_eq!(ingest(&mut p, quote)["accepted"], true);
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "health"}));
    loop {
        let h = c.await_type("health")["payload"].clone();
        if h["committed"].as_u64().unwrap() >= 6 {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
        c.send(json!({"type": "health"}));
    }
    drop(c);
    drop(p);
    let (root, data) = d.kill();
    let d2 = Daemon::start_in(root, data, &[]);
    let mut v = d2.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "futu", "market": "US", "code": "US.NOK", "session": "FULL"}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    let got: Vec<Value> = snap["trades"].as_array().unwrap().iter().map(|t| t["volume"].clone()).collect();
    assert_eq!(got, vec![json!(0.25), json!(100), json!(0.1), json!(0.2), json!(1.5)], "every size exactly, none 0");
    assert!((total - 102.05f64).abs() < 1e-9);
    assert_eq!(snap["summary"]["total_volume"], json!(48_971_788.25));
    assert_eq!(snap["summary"]["volume_unit"], "share");
    assert_eq!(snap["volume_unit"], "share");
}

#[test]
fn a_wal_disk_failure_refuses_further_accepts_and_never_claims_durability() {
    let d = Daemon::start("walfail", &["--test-wal-fail-after-bytes", "3000"]);
    let mut p = d.client(SHIOAJI);
    let mut refused = None;
    for s in 1..=200 {
        let a = ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000));
        if a["accepted"] == false {
            refused = Some(a);
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let refused = refused.expect("the WAL failure must surface as refusals");
    assert!(refused["reason"].as_str().unwrap().starts_with("WAL_FAILED"), "{refused}");
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "health"}));
    let h = c.await_type("health")["payload"].clone();
    assert_eq!(h["status"], "degraded");
    // Never a durable claim for what was not written: the refusal carries no durable sequence and the failure is
    // reported. (Which write hits the fault -- a trade or the scope's Clock event -- is timing, not contract.)
    assert!(refused.get("durable_sequence").is_none_or(|v| v.is_null()), "{refused}");
    assert!(h["wal_failed"].is_string(), "{h}");
}

#[test]
fn retention_removes_old_segments_keeps_the_stream_identity_and_tells_a_replay_what_was_pruned() {
    // B14: the WAL had no retention (2.5 GB, ~1.3 GB a day). The durable stream id is bound to the WAL's first record,
    // so removing the oldest segment must not look like a new history to A (restart) or to B (cursor).
    let d = Daemon::start("retention", &["--wal-segment-bytes", "4096"]);
    let mut p = d.client(SHIOAJI);
    const DAY: i64 = 86_400_000_000_000;
    for s in 1..=300u64 {
        let mut event = trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64);
        if s > 200 {
            event["exchange_ts_ns"] = json!(TAIPEI_0930_NS + DAY + s as i64);
        }
        assert_eq!(ingest(&mut p, event)["accepted"], true);
    }
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "wal.prune", "payload": {}}));
    assert_eq!(c.await_type("wal.prune.ack")["payload"]["ok"], false, "a cutoff is required");
    c.send(json!({"type": "wal.prune", "payload": {"before_ns": TAIPEI_0930_NS + DAY}}));
    let pruned = c.await_type("wal.prune.ack")["payload"].clone();
    assert_eq!(pruned["ok"], true, "{pruned}");
    let through = pruned["pruned_through"].as_u64().unwrap();
    assert!(pruned["removed_segments"].as_u64().unwrap() > 0 && through > 0, "{pruned}");
    assert!(through <= 200, "only segments whose every event is older than the cutoff go: {pruned}");
    c.send(json!({"type": "wal.prune", "payload": {"before_ns": i64::MAX}}));
    let all = c.await_type("wal.prune.ack")["payload"].clone();
    assert!(all["remaining_segments"].as_u64().unwrap() >= 1, "the segment being written is never removed: {all}");
    eprintln!("B14 retention: first {pruned}, second {all}");
    let through = all["pruned_through"].as_u64().unwrap().max(through);
    c.send(json!({"type": "health"}));
    let stream = c.await_type("health")["payload"]["durable_stream_id"].clone();

    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let msgs = b.until(|seen| seen.iter().any(|m| m["type"] == "durable.batch"));
    let gap = msgs.iter().find(|m| m["type"] == "durable.gap").expect("a replay from 0 is told the prefix was pruned");
    assert_eq!(gap["payload"]["reason"], "PRUNED");
    assert_eq!(gap["payload"]["through_sequence"].as_u64().unwrap(), through);
    let batch = msgs.iter().find(|m| m["type"] == "durable.batch").unwrap();
    assert_eq!(batch["payload"]["from_sequence"].as_u64().unwrap(), through + 1, "the replay resumes right after the pruned prefix");
    drop(b);
    // A consumer that holds nothing (after 0) is told the prefix was pruned and A logs it as retention, not as a
    // delivery hole; one that holds state up to a pruned sequence is the hole (recorded as a remediation).
    let retention_line = format!("holds nothing: retention starts after {through}");
    let deadline = Instant::now() + SETTLE;
    while !d.output.text().contains(&retention_line) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(d.output.text().contains(&retention_line), "{}", d.output.text());
    let mut held = d.client(ANALYSIS);
    held.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 1}}));
    let msgs = held.until(|seen| seen.iter().any(|m| m["type"] == "durable.batch"));
    let gap = msgs.iter().find(|m| m["type"] == "durable.gap").expect("state held past the pruned prefix is a declared gap");
    assert_eq!((gap["payload"]["reason"].as_str(), gap["payload"]["after_sequence"].as_u64()), (Some("PRUNED"), Some(1)));
    assert_eq!(d.output.text().matches("holds nothing").count(), 1, "only the empty consumer is retention: {}", d.output.text());
    drop(held);
    drop(c);
    drop(p);

    let (root, data) = d.shutdown();
    let d2 = Daemon::start_in(root, data, &[]);
    let mut c = d2.client(CONTROLLER);
    c.send(json!({"type": "health"}));
    assert_eq!(c.await_type("health")["payload"]["durable_stream_id"], stream, "retention keeps the durable history's identity");
}

#[test]
fn a_replay_declares_a_range_it_cannot_read_and_never_jumps_over_it() {
    // A segment that is gone under the reader (pruned between the index snapshot and
    // the open, or lost) must not be skipped silently with the replay jumping. Every undeliverable range is a declared
    // `durable.gap` with its reason before the next record.
    let d = Daemon::start("unreadable", &["--wal-segment-bytes", "4096"]);
    let mut p = d.client(SHIOAJI);
    let mut last = 0;
    for s in 1..=200u64 {
        let ack = ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64));
        assert_eq!(ack["accepted"], true);
        last = ack["durable_sequence"].as_u64().unwrap();
    }
    await_synced(&mut p, last);
    let mut segments: Vec<PathBuf> = std::fs::read_dir(&d.data).unwrap().map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("wal-")).collect();
    segments.sort();
    assert!(segments.len() > 3, "{segments:?}");
    std::fs::remove_file(&segments[1]).unwrap();
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let msgs = b.until(|seen| seen.iter().filter(|m| m["type"] == "durable.batch").count() >= 2);
    let first = msgs.iter().find(|m| m["type"] == "durable.batch").unwrap();
    let first_to = first["payload"]["to_sequence"].as_u64().unwrap();
    let gap = msgs.iter().find(|m| m["type"] == "durable.gap").expect("the missing segment is declared");
    assert_eq!(gap["payload"]["reason"], "UNREADABLE", "{gap}");
    assert_eq!(gap["payload"]["after_sequence"].as_u64().unwrap(), first_to, "the gap starts right after what was delivered: {gap}");
    let through = gap["payload"]["through_sequence"].as_u64().unwrap();
    assert!(through > first_to, "{gap}");
    let second = msgs.iter().filter(|m| m["type"] == "durable.batch").nth(1).unwrap();
    assert_eq!(second["payload"]["from_sequence"].as_u64().unwrap(), through + 1, "delivery resumes right after the declared range");
    let gap_at = msgs.iter().position(|m| m["type"] == "durable.gap").unwrap();
    let second_at = msgs.iter().position(|m| std::ptr::eq(m, second)).unwrap();
    assert!(gap_at < second_at, "the gap is declared before the records after it");
}

#[test]
fn a_second_runtime_on_the_same_data_dir_refuses_to_start() {
    // Nothing stopped two writers from interleaving frames in one WAL.
    let first = Daemon::start("dir_lock", &[]);
    let creds = write_credentials(&first.root);
    let args: Vec<String> = ["--port", "0", "--data-dir", first.data.to_str().unwrap(), "--credentials", creds.to_str().unwrap(),
        "--clock", "exchange", "--rollover", "off", "--config-root", first.root.join("config").to_str().unwrap()].iter().map(|s| s.to_string()).collect();
    let mut second = daemon_command(&args).spawn().expect("spawn second daemon");
    let output = Output::capture(&mut second);
    let deadline = Instant::now() + SETTLE;
    let status = loop {
        if let Some(status) = second.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = second.kill();
            let _ = second.wait();
            panic!("the second runtime started on a data dir another one owns");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    assert!(!status.success());
    let deadline = Instant::now() + SETTLE;
    while !output.text().contains("in use by another Market Runtime") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(output.text().contains("in use by another Market Runtime"), "{}", output.text());
    // The owner is unaffected, and the dir is free again once it stops.
    let mut c = first.client(VIEWER);
    c.send(json!({"type": "health"}));
    c.await_type("health");
    let (root, data) = first.shutdown();
    Daemon::start_in(root, data, &[]).shutdown();
}

#[test]
fn a_rolled_over_session_is_stored_but_never_cached_again_even_after_a_restart() {
    // Session rollover: with the wall clock past 2026-09-29's next pre-open, that session has left the
    // cache. Its late events still reach the WAL and B; a view of the instrument gets the session that is current now.
    let d = Daemon::start("rollover", &["--rollover", "on"]);
    let mut p = d.client(SHIOAJI);
    assert_eq!(ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000))["accepted"], true, "stored");
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let subscribed = b.await_type("durable.subscribed");
    let cutoff = subscribed["payload"]["rolled"]["shioaji|STK|DAY"].as_str().unwrap().to_string();
    assert!(cutoff.as_str() > "2026-09-29", "{cutoff}");
    let durable = b.until(|seen| seen.iter().any(|m| m["type"] == "durable.batch"));
    assert!(durable.iter().any(|m| m["type"] == "durable.batch"), "B still gets the stored event");
    let view = |d: &Daemon| {
        let mut v = d.client(VIEWER);
        v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY"}}));
        v.await_type("view.snapshot")["payload"].clone()
    };
    let snap = view(&d);
    assert_eq!(snap["trading_date"], json!(cutoff), "the current session, not the rolled one");
    assert!(snap["summary"]["current"].is_null() && snap["trades"].as_array().is_none_or(|t| t.is_empty()), "{snap}");
    let (root, data) = d.shutdown();
    let d = Daemon::start_in(root, data, &["--rollover", "on"]);
    let snap = view(&d);
    assert!(snap["summary"]["current"].is_null(), "a restart replaying the WAL does not bring it back: {snap}");
}

/// While A recovers its WAL, a viewer that sends anything but `health` is refused and closed with CLOSE_RECOVERING
/// (4006); one that only asks `health` is answered "recovering" and, when recovery ends, closed with CLOSE_RECOVERED
/// (4005) -- connect again now. The empty close it used to get read as the server dropping the window, and every
/// start recorded a renderer.live_ws_reconnect.
#[test]
fn a_recovering_port_closes_with_codes_a_client_can_tell_from_a_failure() {
    let root = temp_dir("recovering_close");
    // Listening (its `listening` line came) while the recovery is held.
    let d = Daemon::spawn(root.clone(), root.join("data"), &["--test-recovery-hold-ms", "3000"]);
    // Only health while recovering: answered with the progress, then the handoff close.
    let mut waiting = d.client(VIEWER);
    waiting.send(json!({"type": "health"}));
    let first = waiting.await_type("health");
    assert_eq!(first["payload"]["status"], "recovering", "{first}");
    // Anything else is refused and closed as "still recovering".
    let mut eager = d.client(VIEWER);
    eager.send(json!({"type": "view.subscribe", "payload": {}}));
    let refused = eager.until(|seen| seen.iter().any(|m| m["type"] == "__close__"));
    assert!(refused.iter().any(|m| m["type"] == "error" && m["error"] == "RECOVERING"), "{refused:?}");
    assert!(refused.iter().any(|m| m["type"] == "__close__" && m["code"] == 4006), "{refused:?}");
    let handoff = waiting.until(|seen| seen.iter().any(|m| m["type"] == "__close__"));
    assert!(handoff.iter().any(|m| m["type"] == "__close__" && m["code"] == 4005), "recovered: connect again now {handoff:?}");
    let mut served = d.client(VIEWER);
    served.send(json!({"type": "health"}));
    let health = served.await_type("health");
    assert_ne!(health["payload"]["status"], "recovering", "{health}");
    d.shutdown();
}

/// 1104-C02-02: a provider frozen with its socket open: only its connection ending makes A withdraw what it covered.
#[test]
fn a_silent_provider_connection_is_closed_and_a_silent_viewer_is_not() {
    let d = Daemon::start("provider_silent", &["--test-provider-silence-ms", "500"]);
    let mut v = d.client(VIEWER);
    let mut p = d.client(SHIOAJI);
    p.send(json!({"type": "health"}));
    p.await_type("health");
    let closed = p.until(|seen| seen.iter().any(|m| m["type"] == "__close__"));
    assert!(closed.iter().any(|m| m["type"] == "__close__" && m["code"] == 4007), "{closed:?}");
    assert!(!v.drain(800).iter().any(|m| m["type"] == "__close__"), "a viewer may be quiet");
    d.shutdown();
}
