//! Ingest over real WebSockets: roles and credentials, the event format, durable acks, resent and pre-open prints, load.
//! (docs/system-architecture/08 section 1, the Rust A rows.)

mod support;

use support::*;

#[test]
fn roles_are_enforced_by_credential() {
    let d = Daemon::start("roles", &[]);
    assert!(Ws::connect(d.port, "not-a-real-token-at-all-000").is_err(), "unknown credential gets 401");
    let mut viewer = d.client(VIEWER);
    viewer.send(json!({"type": "event.ingest", "payload": trade("shioaji", "STK", "2330", "DAY", 1, 1)}));
    assert_eq!(viewer.await_type("error")["error"], "FORBIDDEN");
    viewer.send(json!({"type": "shutdown"}));
    assert_eq!(viewer.await_type("error")["error"], "FORBIDDEN");
    let mut shioaji = d.client(SHIOAJI);
    let refused = ingest(&mut shioaji, trade("futu", "US", "AAPL", "FULL", 1, 1));
    assert_eq!(refused["accepted"], false);
    assert!(refused["reason"].as_str().unwrap().starts_with("FORBIDDEN_SOURCE"));
    let mut analysis_signals = trade("shioaji", "STK", "2330", "DAY", 1, 1);
    analysis_signals["event_type"] = json!("analysis_signals");
    assert_eq!(ingest(&mut shioaji, analysis_signals)["reason"], "FORBIDDEN_KIND");
    shioaji.send(json!({"type": "signals.publish", "payload": {"items": []}}));
    assert_eq!(shioaji.await_type("error")["error"], "FORBIDDEN");
    let ok = ingest(&mut shioaji, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000));
    assert_eq!(ok["accepted"], true);
    assert_eq!(ok["storage"], "wal", "{ok}");
}

#[test]
fn an_older_ingest_format_is_refused_with_its_reason_never_converted() {
    let d = Daemon::start("old-format", &[]);
    let mut shioaji = d.client(SHIOAJI);
    let mut v1 = trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000);
    v1["schema"] = json!("rust-live-event-v1");
    let refused = ingest(&mut shioaji, v1);
    assert_eq!(refused["accepted"], false);
    assert!(refused["reason"].as_str().unwrap().starts_with("OLD_FORMAT: envelope schema"), "{refused}");
    let mut unnamed = trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000);
    unnamed.as_object_mut().unwrap().remove("schema");
    let refused = ingest(&mut shioaji, unnamed);
    assert_eq!(refused["accepted"], false);
    assert!(refused["reason"].as_str().unwrap().contains("schema"), "{refused}");
    // Market Runtime names every partition: an envelope that names one itself (the older protocol, where each
    // provider computed it) is refused, never taken as given or re-keyed.
    for (field, value) in [("trading_date", json!("2026-09-29")), ("session", json!("DAY"))] {
        let mut named = trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000);
        named[field] = value;
        let refused = ingest(&mut shioaji, named);
        assert_eq!(refused["accepted"], false);
        assert!(refused["reason"].as_str().unwrap().starts_with(&format!("OLD_FORMAT: the envelope carries {field}")), "{refused}");
    }
    let mut minute = trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000);
    minute["data"]["minute"] = json!(570);
    let refused = ingest(&mut shioaji, minute);
    assert!(refused["reason"].as_str().unwrap().contains("data.minute"), "{refused}");
    let ok = ingest(&mut shioaji, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000));
    assert_eq!(ok["accepted"], true, "the current format still goes through");
}

#[test]
fn an_event_dated_to_a_day_without_a_session_is_refused() {
    // A Shioaji day-session event of a Saturday belongs to no business session; the WAL owner refuses
    // it. A NIGHT session (dated by the day it opened) and a trading day are taken.
    let d = Daemon::start("nosession", &[]);
    let mut p = d.client(SHIOAJI);
    let mut saturday = trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000);
    saturday["exchange_ts_ns"] = json!(TAIPEI_0930_NS + 4 * 86_400_000_000_000);   // 2026-10-03 09:30
    let refused = ingest(&mut p, saturday);
    assert_eq!((refused["accepted"].clone(), refused["reason"].clone()), (json!(false), json!("NOT_A_BUSINESS_SESSION")), "{refused}");
    let monday = trade("shioaji", "STK", "2330", "DAY", 2, 1_000_000);
    assert_eq!(ingest(&mut p, monday)["accepted"], true);
}

#[test]
fn health_queries_and_new_connections_never_stall_ingest_under_load() {
    // Under load A once stopped accepting after ~1 minute. `health` held clients(read) while waiting for core;
    // ingest held core while waiting for clients(read), queued behind a connecting client's clients(write). Here a
    // viewer makes every ingest take clients(read) under core, while other threads poll `health` and keep connecting.
    let d = Daemon::start("lockorder", &[]);
    let mut viewer = d.client(VIEWER);
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY"}}));
    viewer.await_type("view.snapshot");
    let port = d.port;
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut noise = Vec::new();
    for _ in 0..3 {
        let stop_health = stop.clone();
        noise.push(std::thread::spawn(move || {
            let mut c = Ws::connect(port, CONTROLLER).unwrap();
            while !stop_health.load(std::sync::atomic::Ordering::Relaxed) {
                c.send(json!({"type": "health"}));
                c.await_type("health");
            }
        }));
        let stop_connect = stop.clone();
        noise.push(std::thread::spawn(move || {
            while !stop_connect.load(std::sync::atomic::Ordering::Relaxed) {
                drop(Ws::connect(port, VIEWER));
            }
        }));
    }
    let started = Instant::now();
    let mut provider = d.client(SHIOAJI);
    for seq in 1..=3000u64 {
        assert_eq!(ingest(&mut provider, trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000 + seq as i64))["accepted"], true);
        assert!(started.elapsed() < Duration::from_secs(60), "ingest stalled at event {seq}");
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    for t in noise {
        let _ = t.join();
    }
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "health"}));
    assert_eq!(c.await_type("health")["payload"]["accepted"], 3000);
}

#[test]
fn a_large_frame_arriving_in_pieces_is_read_whole() {
    // The serve loop polls with a ~15 ms socket timeout. A 256-event batch arriving in pieces must not be cut at
    // that timeout: the bytes read so far would be dropped, the stream desynchronized and the provider would have to
    // reconnect and resend (under load ~2 batches per 10 s reached A).
    let d = Daemon::start("pieces", &[]);
    let mut provider = d.client(SHIOAJI);
    let events: Vec<Value> = (1..=256u64).map(|seq| trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000 + seq as i64)).collect();
    let payload = serde_json::to_vec(&json!({"type": "event.ingest.batch", "payload": {"events": events}})).unwrap();
    let mask = [9u8, 8, 7, 6];
    let mut frame = vec![0x81u8, 0x80 | 127];
    frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    frame.extend_from_slice(&mask);
    frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    let cut = frame.len() / 3;
    provider.stream.write_all(&frame[..cut]).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    provider.stream.write_all(&frame[cut..]).unwrap();
    let ack = provider.await_type("event.ack.batch");
    let results = ack["payload"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 256);
    assert!(results.iter().all(|r| r["accepted"] == true), "every event of the split frame is accepted");
    // And the connection is still in sync afterwards.
    assert_eq!(ingest(&mut provider, trade("shioaji", "STK", "2330", "DAY", 257, 1_000_257))["accepted"], true);
}

#[test]
fn the_exchange_market_clock_follows_the_recorded_exchange_time() {
    // A recorded feed is a session that is not today. On the wall clock that session is long over, so every print
    // would reach Rust B as a revision of a finalized minute. The `exchange` clock follows the feed's own exchange
    // time instead.
    let d = Daemon::start("exchange_clock", &["--clock-lag-ms", "0"]);
    let mut provider = d.client(SHIOAJI);
    assert_eq!(ingest(&mut provider, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000))["accepted"], true);
    let feed_minute = ((TAIPEI_0930_NS / 1_000_000_000 + 8 * 3600) / 60).rem_euclid(1440) as i64;
    std::thread::sleep(Duration::from_millis(1200));
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let msgs = b.until(|seen| seen.iter().any(|m| m["type"] == "durable.batch"
        && m["payload"]["events"].as_array().is_some_and(|e| e.iter().any(|x| x["payload"]["kind"] == "clock"))));
    let clock = msgs.iter().filter(|m| m["type"] == "durable.batch")
        .flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
        .find(|e| e["payload"]["kind"] == "clock").expect("a clock event");
    let minute = clock["payload"]["minute"].as_i64().unwrap();
    assert!((minute - feed_minute).abs() <= 1, "clock minute {minute} follows the feed ({feed_minute}), not the wall clock");
}

#[test]
fn only_preopen_call_auction_data_is_kept_out_of_the_wal() {
    const PREOPEN: i64 = 1_790_642_700_000_000_000; // 2026-09-29 08:45 Taipei
    const INTRADAY: i64 = 1_790_647_200_000_000_000; // 10:00 -- a 緩漲緩跌 auction
    const CLOSING: i64 = 1_790_659_560_000_000_000; // 13:26 -- the closing auction
    let at = |mut event: Value, ts: i64| {
        event["exchange_ts_ns"] = json!(ts);
        event
    };
    let simtrade = |seq: u64, ts: i64| {
        let mut e = at(trade("shioaji", "STK", "2330", "DAY", seq, 1_010_000), ts);
        e["data"]["simtrade"] = json!(true);
        e
    };
    let book = |seq: u64, ts: i64| {
        let mut e = at(trade("shioaji", "STK", "2330", "DAY", seq, 0), ts);
        e["event_type"] = json!("orderbook");
        e["data"] = json!({"bids": [{"price": 1_000_000, "volume": 5}], "asks": [{"price": 1_010_000, "volume": 7}], "simtrade": true});
        e
    };
    let d = Daemon::start("indicative", &[]);
    let mut p = d.client(SHIOAJI);
    for event in [simtrade(1, PREOPEN), book(2, PREOPEN)] {
        let ack = ingest(&mut p, event);
        assert_eq!(ack["accepted"], true, "{ack}");
        assert!(ack["durable_sequence"].is_null(), "盤前試撮 takes no durable sequence: {ack}");
        // Nothing to wait for on disk: the ack says live-only, so the producer never holds it for a watermark.
        assert_eq!(ack["storage"], "live_only", "{ack}");
    }
    for event in [at(trade("shioaji", "STK", "2330", "DAY", 3, 1_000_000), INTRADAY + 1), simtrade(4, INTRADAY + 2),
                  book(5, INTRADAY + 3), simtrade(6, CLOSING)] {
        let ack = ingest(&mut p, event);
        assert!(ack["durable_sequence"].as_u64().is_some(), "an intraday or closing auction is stored: {ack}");
        assert_eq!(ack["storage"], "wal", "{ack}");
    }

    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let mut stored = Vec::new();
    // Everything before the last event is committed by the time it is: stop once it arrives.
    let deadline = Instant::now() + SETTLE;
    while Instant::now() < deadline && !stored.iter().any(|(seq, _)| *seq == 6) {
        if let Some(m) = b.read(deadline) {
            if m["type"] == "durable.batch" {
                for e in m["payload"]["events"].as_array().unwrap() {
                    if e["code"] == "2330" {
                        stored.push((e["sequence"].as_u64().unwrap(), e["payload"]["kind"].as_str().unwrap().to_owned()));
                    }
                }
            }
        }
    }
    let kinds: Vec<(u64, &str)> = stored.iter().map(|(s, k)| (*s, k.as_str())).collect();
    assert_eq!(kinds, vec![(3, "trade"), (4, "trade"), (5, "order_book"), (6, "trade")]);
}

/// The credential never travels in the URL. A query token is refused; the Authorization header (used
/// above by every other test) and the browser's subprotocol pair are accepted, and the subprotocol is echoed.
#[test]
fn credentials_come_from_the_authorization_header_only() {
    let daemon = Daemon::start("auth_transport", &[]);
    let raw = |request: String| -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", daemon.port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        while !response.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) => response.push(byte[0]),
            }
        }
        String::from_utf8_lossy(&response).into_owned()
    };
    let upgrade = "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
    let by_query = raw(format!("GET /live?token={VIEWER} HTTP/1.1\r\nHost: x\r\n{upgrade}\r\n"));
    assert!(by_query.starts_with("HTTP/1.1 401"), "a token in the URL is not accepted: {by_query}");
    let by_protocol = raw(format!("GET /live HTTP/1.1\r\nHost: x\r\nSec-WebSocket-Protocol: stockmonitor.auth, {VIEWER}\r\n{upgrade}\r\n"));
    assert!(by_protocol.starts_with("HTTP/1.1 401"), "a token offered as a subprotocol is not accepted either: {by_protocol}");
    let by_header = raw(format!("GET /live HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {VIEWER}\r\n{upgrade}\r\n"));
    assert!(by_header.starts_with("HTTP/1.1 101") && !by_header.contains(VIEWER), "{by_header}");
    let wrong = raw(format!("GET /live HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer not-a-token\r\n{upgrade}\r\n"));
    assert!(wrong.starts_with("HTTP/1.1 401"), "{wrong}");
    daemon.shutdown();
}

/// An ingest is answered at once with each event's durable sequence; that it is on disk is the WAL watermark pushed
/// to a provider connection that subscribed: told at once, then as it moves. An ack that waited for the sync turned
/// every slow sync (a Windows shadow copy holds writes for seconds) into an unconfirmed event asked about again.
#[test]
fn an_ingest_is_answered_at_once_and_the_pushed_watermark_says_when_it_is_on_disk() {
    let d = Daemon::start("durable_ack", &[]);
    let mut p = d.client(SHIOAJI);
    p.send(json!({"type": "event.durable.subscribe"}));
    let first = p.await_type("event.durable")["payload"].clone();
    assert!(first["instance_id"].as_str().is_some_and(|s| s.starts_with("mr-")), "{first}");
    assert!(first["wal_failed"].is_null(), "{first}");
    let events: Vec<Value> = (1..=50).map(|s| trade("shioaji", "STK", "2330", "DAY", s, 1_000_000)).collect();
    p.send(json!({"type": "event.ingest.batch", "payload": {"events": events}}));
    let results = p.await_type("event.ack.batch")["payload"]["results"].as_array().cloned().unwrap();
    assert!(results.iter().all(|r| r["accepted"] == true && r["storage"] == "wal" && r.get("durable").is_none()), "{results:?}");
    let highest = results.iter().filter_map(|r| r["durable_sequence"].as_u64()).max().unwrap();
    let mut seen = 0;
    while seen < highest {
        let watermark = p.await_type("event.durable")["payload"].clone();
        let committed = watermark["committed"].as_u64().unwrap();
        assert!(committed >= seen, "a watermark never goes back: {committed} after {seen}");
        assert_eq!(watermark["instance_id"], first["instance_id"]);
        seen = committed;
    }
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "health"}));
    assert!(c.await_type("health")["payload"]["committed"].as_u64().unwrap() >= highest);
    // A second connection (a reconnect) learns at once where the WAL stands: what it held across the loss is released.
    let mut again = d.client(SHIOAJI);
    again.send(json!({"type": "event.durable.subscribe"}));
    assert!(again.await_type("event.durable")["payload"]["committed"].as_u64().unwrap() >= highest);

    let failing = Daemon::start("durable_ack_fail", &["--test-wal-fail-after-bytes", "3000"]);
    let mut q = failing.client(SHIOAJI);
    q.send(json!({"type": "event.durable.subscribe"}));
    q.await_type("event.durable");
    // An ack does not wait for the writer, so how many events are accepted before it fails depends on when it runs;
    // 200 of them are far past the 3000 bytes it may write, so it fails once it has taken them.
    let mut stored = None;
    let mut refused = None;
    for s in 1..=200 {
        let a = ingest(&mut q, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000));
        if a["accepted"] == false {
            refused = Some(a);
            break;
        }
        stored = a["durable_sequence"].as_u64();
    }
    // A provider subscribing now (a reconnect) is told that the WAL failed -- at once, or by the push when it fails --
    // and the watermark never passes what the failed WAL could not write: the producer keeps those events for another
    // Market Runtime process.
    let mut r = failing.client(SHIOAJI);
    r.send(json!({"type": "event.durable.subscribe"}));
    let failed = loop {
        let watermark = r.await_type("event.durable")["payload"].clone();
        if !watermark["wal_failed"].is_null() {
            break watermark;
        }
    };
    assert!(failed["wal_failed"].is_string(), "{failed}");
    if let Some(stored) = stored {
        assert!(failed["committed"].as_u64().unwrap() < stored, "{failed}");
    }
    // Once failed, every ingest is refused with the reason.
    let refused = refused.unwrap_or_else(|| ingest(&mut q, trade("shioaji", "STK", "2330", "DAY", 201, 1_000_000)));
    assert_eq!(refused["accepted"], false, "{refused}");
    assert!(refused["reason"].as_str().unwrap_or("").starts_with("WAL_FAILED"), "{refused}");
    failing.shutdown();
    d.shutdown();
}

/// A market event without an exchange time is refused (never dated by a clock); source_status is not.
#[test]
fn a_market_event_without_exchange_time_is_refused_and_counted() {
    let d = Daemon::start("missing_time", &[]);
    let mut p = d.client(SHIOAJI);
    let mut c = d.client(CONTROLLER);
    let mut untimed = trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000);
    untimed["exchange_ts_ns"] = json!(0);
    let a = ingest(&mut p, untimed);
    assert_eq!(a["accepted"], false, "{a}");
    assert_eq!(a["reason"], "MISSING_EXCHANGE_TIME", "{a}");
    let ok = ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000));
    assert_eq!(ok["accepted"], true, "the next timed event is unaffected: {ok}");
    c.send(json!({"type": "metrics"}));
    let metrics = c.await_type("metrics")["payload"].clone();
    assert_eq!(metrics["ingest"]["rejected_missing_time"], 1, "{metrics}");
    d.shutdown();
}

#[test]
fn a_futu_minute_bar_without_open_high_low_is_accepted() {
    // Futu RT_DATA is a 分時 point: minute, close, average and volume, no open/high/low.
    let d = Daemon::start("bar_without_ohlc", &[]);
    let mut p = d.client(FUTU);
    let mut bar = trade("futu", "US", "US.NOK", "FULL", 1, 0);
    bar["event_type"] = json!("minute_bar");
    bar["data"] = json!({"close": 71_200, "average": 71_150, "volume": 1200, "amount": 85_000.0});
    let ack = ingest(&mut p, bar);
    assert_eq!(ack["accepted"], true, "{ack}");
    let mut broken = trade("futu", "US", "US.NOK", "FULL", 2, 0);
    broken["event_type"] = json!("minute_bar");
    broken["data"] = json!({"volume": 10});
    assert_eq!(ingest(&mut p, broken)["accepted"], false, "a bar without its close is still refused");
    d.shutdown();
}

#[test]
fn a_print_the_broker_resends_is_never_written_to_the_wal() {
    // 14:30: Shioaji re-sends the 13:30 closing print (same volume, cumulative volume unchanged) before the
    // after-hours print. It is not a trade: accepted (nothing for the producer to retry) but never durable (user 10-20).
    let d = Daemon::start("resent-print", &[]);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut p = d.client(SHIOAJI);
    let print = |seq: u64, minute: i64, volume: u64, total: u64| {
        let mut e = trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000);
        e["data"]["volume"] = json!(volume);
        e["data"]["total_volume"] = json!(total);
        // 2026-09-29 at `minute` (Taipei): the exchange time names the partition minute.
        e["exchange_ts_ns"] = json!(TAIPEI_0930_NS + (minute - 570) * 60_000_000_000 + seq as i64);
        e
    };
    let first = ingest(&mut p, print(1, 810, 4040, 23_597));
    assert_eq!((first["accepted"].as_bool(), first["storage"].as_str()), (Some(true), Some("wal")), "{first}");
    let resent = ingest(&mut p, print(2, 870, 4040, 23_597));
    assert_eq!(resent["accepted"], true, "{resent}");
    assert_eq!(resent["reason"], "RESENT_PRINT", "{resent}");
    assert!(resent["durable_sequence"].is_null(), "{resent}");
    let after_hours = ingest(&mut p, print(3, 870, 46, 23_643));
    assert_eq!(after_hours["storage"], "wal", "{after_hours}");
    // The WAL between the two prints holds no copy of the resend. Market Runtime's own clock records may fall in
    // between (the exchange clock follows the prints' exchange time on its own thread), so the prints' durable
    // sequences need not be adjacent: what B reads through the after-hours print is what counts.
    let through = after_hours["durable_sequence"].as_u64().unwrap();
    let stored = |msgs: &[Value]| -> Vec<Value> {
        msgs.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().unwrap().clone())
            .filter(|e| e["durable_sequence"].as_u64().is_some_and(|s| s <= through)).collect()
    };
    let read = stored(&b.until(|seen| stored(seen).iter().any(|e| e["durable_sequence"] == through)));
    let trades: Vec<_> = read.iter().filter(|e| e["payload"]["kind"] == "trade").map(|e| e["sequence"].as_u64()).collect();
    assert_eq!(trades, vec![Some(1), Some(3)], "the dropped resend took no durable sequence: {read:?}");
    assert!(read.iter().all(|e| e["payload"]["kind"] == "trade" || e["payload"]["kind"] == "clock"), "{read:?}");

    // Codex 1020-R04-07: a total that did not move is no proof of a copy. A print that is not the newest one again
    // (another price here) is stored as the print it says it is, and counted.
    let mut odd = print(4, 870, 46, 23_643);
    odd["data"]["price"] = json!(1_005_000);
    let kept = ingest(&mut p, odd.clone());
    assert!(kept["reason"].is_null() && kept["storage"] == "wal", "kept and stored: {kept}");

    // Codex 1020-R04-08: a copy that states events lost before it is still not stored, but the loss is -- Market
    // Runtime's loss record in its place, with the count, read by B like any stored event.
    let mut copy = odd;
    copy["sequence"] = json!(5);
    copy["flags"] = json!({"gap_before": 3});
    let copy = ingest(&mut p, copy);
    assert_eq!(copy["reason"], "RESENT_PRINT", "{copy}");
    assert_eq!(copy["storage"], "wal", "the loss record is stored: {copy}");
    let loss_sequence = copy["durable_sequence"].as_u64().unwrap();
    let seen = b.until(|seen| seen.iter().filter(|m| m["type"] == "durable.batch")
        .flat_map(|m| m["payload"]["events"].as_array().unwrap().clone()).any(|e| e["durable_sequence"] == loss_sequence));
    let record = seen.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().unwrap().clone())
        .find(|e| e["durable_sequence"] == loss_sequence).unwrap();
    assert_eq!(record["time_quality"], "loss_control", "{record}");
    assert_eq!(record["payload"]["kind"], "source_status", "{record}");
    assert_eq!(record["payload"]["state"], "source_gap", "{record}");
    assert_eq!(record["flags"]["gap_before"], 3, "{record}");
    assert_eq!((record["code"].as_str(), record["session"].as_str()), (Some("2330"), Some("DAY")), "{record}");
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "metrics"}));
    let metrics = c.await_type("metrics")["payload"]["ingest"].clone();
    assert_eq!((metrics["dropped_resent_print"].as_u64(), metrics["loss_records"].as_u64(), metrics["total_not_advanced"].as_u64()),
        (Some(2), Some(1), Some(1)), "{metrics}");
}

#[test]
fn an_unlisted_stocks_resent_print_reaches_b_only_as_its_loss() {
    // The same over the live lane: B gets the loss record of an unlisted stock's copy, never the copy.
    let d = Daemon::start("resent-unlisted", &[]);
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "background.replace", "payload": {"revision": 1, "items": [{"source": "shioaji", "market": "STK", "code": "2330"}]}}));
    assert_eq!(c.await_type("background.replace.ack")["payload"]["applied_revision"], 1);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut p = d.client(SHIOAJI);
    let first = trade("shioaji", "STK", "2454", "DAY", 1, 1_500_000);
    assert_eq!(ingest(&mut p, first.clone())["storage"], "live_only");
    let mut copy = first;
    copy["generation"] = json!(2);   // a reconnect re-sends the last print
    copy["flags"] = json!({"gap_before": 2});
    let ack = ingest(&mut p, copy);
    assert_eq!(ack["reason"], "RESENT_PRINT", "{ack}");
    let live = |seen: &[Value]| -> Vec<Value> { seen.iter().filter(|m| m["type"] == "live.batch")
        .flat_map(|m| m["payload"]["events"].as_array().unwrap().clone()).filter(|e| e["code"] == "2454").collect() };
    let seen = b.until(|seen| live(seen).len() >= 2);
    let events = live(&seen);
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0]["payload"]["kind"], "trade");
    assert_eq!((events[1]["time_quality"].as_str(), events[1]["flags"]["gap_before"].as_u64()), (Some("loss_control"), Some(2)), "{events:?}");
}

#[test]
fn a_reference_read_from_the_broker_is_written_to_every_partition_of_the_day_it_describes() {
    // Its time is when it was read, which names no partition: it states the trading day, and Market Runtime writes it
    // to that day's partitions by the session contract. 2026-09-29's FUT night opened on 09-24 (09-25 and 09-28 closed).
    let d = Daemon::start("described-day", &[]);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut p = d.client(SHIOAJI);
    let reference = |market: &str, code: &str, seq: u64, day: &str| {
        json!({"schema": "market-event-v2", "source": "shioaji", "market": market, "code": code, "generation": 1, "sequence": seq,
            "event_type": "reference", "exchange_ts_ns": TAIPEI_0930_NS, "arrival_ns": TAIPEI_0930_NS as u64,
            "time_quality": "backend_clock", "describes_trading_date": day, "data": {"limit_up": 110, "limit_down": 90}})
    };
    let fut = ingest(&mut p, reference("FUT", "TXFR1", 1, "2026-09-29"));
    assert_eq!(fut["accepted"], true, "{fut}");
    let stk = ingest(&mut p, reference("STK", "2330", 1, "2026-09-29"));
    assert_eq!(stk["accepted"], true, "{stk}");
    let holiday = ingest(&mut p, reference("STK", "2330", 2, "2026-09-28"));
    assert_eq!(holiday["reason"], "NOT_A_BUSINESS_SESSION", "{holiday}");
    let mut undated = reference("STK", "2330", 3, "2026-09-29");
    undated.as_object_mut().unwrap().remove("describes_trading_date");
    assert!(ingest(&mut p, undated)["reason"].as_str().unwrap().starts_with("NO_EXCHANGE_TIME"));
    let mut print = trade("shioaji", "STK", "2330", "DAY", 4, 1_000_000);
    print["describes_trading_date"] = json!("2026-09-29");
    assert!(ingest(&mut p, print)["reason"].as_str().unwrap().starts_with("DESCRIBED_DATE_NOT_ALLOWED"), "only a read-time reference names a day");

    let msgs = b.until(|seen| seen.iter().filter(|m| m["type"] == "durable.batch")
        .flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
        .filter(|e| e["payload"]["kind"] == "reference").count() >= 3);
    let mut written: Vec<(String, String, String)> = msgs.iter().filter(|m| m["type"] == "durable.batch")
        .flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
        .filter(|e| e["payload"]["kind"] == "reference")
        .map(|e| (e["market"].as_str().unwrap().to_owned(), e["trading_date"].as_str().unwrap().to_owned(), e["session"].as_str().unwrap().to_owned()))
        .collect();
    written.sort();
    assert_eq!(written, vec![
        ("FUT".to_owned(), "2026-09-24".to_owned(), "NIGHT".to_owned()),
        ("FUT".to_owned(), "2026-09-29".to_owned(), "DAY".to_owned()),
        ("STK".to_owned(), "2026-09-29".to_owned(), "DAY".to_owned()),
    ]);
    d.shutdown();
}

#[test]
fn a_reference_a_print_states_is_written_once_per_partition_by_market_runtime() {
    // The provider sends the 昨收 a print states (close - price_chg) with every print and remembers nothing; Market
    // Runtime writes it as a Reference of the print's partition when that partition does not hold it yet. An illiquid
    // stock closing unchanged states the same 昨收 the next day: that day's partition still gets it.
    let d = Daemon::start("stated-reference", &[]);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut p = d.client(SHIOAJI);
    let print = |seq: u64, day: i64| {
        let mut e = trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000);
        e["exchange_ts_ns"] = json!(TAIPEI_0930_NS + day * 86_400_000_000_000 + seq as i64);
        e["data"]["stated_prev_close"] = json!(990_000);
        e
    };
    for (seq, day) in [(1, 0), (2, 0), (3, 1)] {
        assert_eq!(ingest(&mut p, print(seq, day))["accepted"], true);
    }
    let references = |msgs: &[Value]| -> Vec<(String, Value)> {
        msgs.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
            .filter(|e| e["payload"]["kind"] == "reference")
            .map(|e| (e["trading_date"].as_str().unwrap().to_owned(), e["payload"]["prev_close"].clone())).collect()
    };
    let msgs = b.until(|seen| references(seen).len() >= 2 && seen.iter().filter(|m| m["type"] == "durable.batch")
        .flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default()).filter(|e| e["payload"]["kind"] == "trade").count() >= 3);
    assert_eq!(references(&msgs), vec![("2026-09-29".to_owned(), json!(990_000)), ("2026-09-30".to_owned(), json!(990_000))]);
    let stored_trade = msgs.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
        .find(|e| e["payload"]["kind"] == "trade").unwrap();
    assert!(stored_trade["payload"].get("stated_prev_close").is_none(), "a print never carries its reference into the WAL");
    d.shutdown();
}

#[test]
fn a_reference_event_the_partition_already_holds_is_not_written_again() {
    // A provider publishes each stock's limits once per process: every restart stated them again and the partition got
    // the same Reference once per restart (11-06: three copies per stock). A changed value is still written.
    let d = Daemon::start("held-reference", &[]);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut p = d.client(SHIOAJI);
    let limits = |seq: u64, up: i64| json!({"schema": "market-event-v2", "source": "shioaji", "market": "STK", "code": "2330",
        "generation": 1, "sequence": seq, "event_type": "reference", "exchange_ts_ns": TAIPEI_0930_NS, "arrival_ns": TAIPEI_0930_NS as u64,
        "time_quality": "backend_clock", "describes_trading_date": "2026-09-29", "data": {"limit_up": up, "limit_down": 90}});
    for (seq, up) in [(1, 110), (2, 110), (3, 110), (4, 111)] {
        let answer = ingest(&mut p, limits(seq, up));
        assert_eq!(answer["accepted"], true, "{answer}");
        if seq == 2 || seq == 3 {
            assert!(answer["durable_sequence"].is_null(), "held: accepted, nothing written: {answer}");
        }
    }
    let written = |msgs: &[Value]| -> Vec<Value> {
        msgs.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
            .filter(|e| e["payload"]["kind"] == "reference").map(|e| e["payload"]["limit_up"].clone()).collect()
    };
    let msgs = b.until(|seen| written(seen).len() >= 2);
    assert_eq!(written(&msgs), vec![json!(110), json!(111)], "the first statement and the change, not the repeats");
    d.shutdown();
}

#[test]
fn a_stock_put_on_the_list_has_the_reference_it_was_told_while_unlisted_written_once() {
    // Its provider states the limits once a day, possibly while the stock is only being looked at (shown, never stored):
    // once the stock is listed Market Runtime writes what it holds, so B's paper desk and the history have it.
    let d = Daemon::start("listed-reference", &[]);
    let mut c = d.client(CONTROLLER);
    let list = |codes: &[&str], revision: u64| json!({"type": "background.replace", "payload": {"revision": revision,
        "items": codes.iter().map(|code| json!({"source": "shioaji", "market": "STK", "code": code})).collect::<Vec<_>>()}});
    c.send(list(&["2330"], 1));
    assert_eq!(c.await_type("background.replace.ack")["payload"]["applied_revision"], 1);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let subscribed = b.await_type("durable.subscribed");
    assert_eq!(subscribed["payload"].get("replay_id"), Some(&Value::Null), "no replay open: {subscribed}");
    let mut p = d.client(SHIOAJI);
    let limits = json!({"schema": "market-event-v2", "source": "shioaji", "market": "STK", "code": "2454",
        "generation": 1, "sequence": 1, "event_type": "reference", "exchange_ts_ns": TAIPEI_0930_NS, "arrival_ns": TAIPEI_0930_NS as u64,
        "time_quality": "backend_clock", "describes_trading_date": "2026-09-29", "data": {"limit_up": 110, "limit_down": 90}});
    assert_eq!(ingest(&mut p, limits)["accepted"], true);
    for (codes, revision) in [(&["2330", "2454"], 2), (&["2330", "2454"], 3)] {
        c.send(list(codes, revision));
        assert_eq!(c.await_type("background.replace.ack")["payload"]["applied_revision"], revision);
    }
    assert_eq!(ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000))["accepted"], true);
    let events = |seen: &[Value]| -> Vec<Value> { seen.iter().filter(|m| m["type"] == "durable.batch")
        .flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default()).collect() };
    let seen = b.until(|seen| events(seen).iter().any(|e| e["payload"]["kind"] == "trade"));
    let references: Vec<Value> = events(&seen).into_iter().filter(|e| e["code"] == "2454" && e["payload"]["kind"] == "reference").collect();
    assert_eq!(references.len(), 1, "written on the listing, not again by the next list: {references:?}");
    assert_eq!((references[0]["payload"]["limit_up"].as_i64(), references[0]["payload"]["limit_down"].as_i64()), (Some(110), Some(90)));
    assert_eq!((references[0]["trading_date"].as_str(), references[0]["session"].as_str()), (Some("2026-09-29"), Some("DAY")));
    d.shutdown();
}
