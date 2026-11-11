//! Views over real WebSockets: product switch cut points, sessions, channels and their sequences, slow viewers.
//! (docs/system-architecture/08 section 1, the Rust A rows.)

mod support;

use support::*;

#[test]
fn switching_products_gets_a_complete_snapshot_and_contiguous_deltas_even_while_events_keep_arriving() {
    let d = Daemon::start("switch", &[]);
    let mut provider = d.client(SHIOAJI);
    for seq in 1..=20 {
        ingest(&mut provider, trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000 + seq as i64));
        ingest(&mut provider, trade("shioaji", "STK", "3481", "DAY", seq, 200_000 + seq as i64));
    }
    let mut viewer = d.client(VIEWER);
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "3481", "session": "DAY", "request_id": "r1"}}));
    let snap3481 = viewer.await_type("view.snapshot")["payload"].clone();
    assert_eq!(snap3481["trades"].as_array().unwrap().len(), 20);
    // A requested snapshot (a selection) carries Rust A's own share of the latency for the developer's selection trace.
    let timing = &snap3481["selection_timing"];
    for stage in ["lock_wait_ms", "build_ms", "rust_a_ms"] {
        assert!(timing[stage].as_f64().is_some_and(|ms| ms >= 0.0), "{stage}: {timing}");
    }
    let sub3481 = snap3481["subscription_id"].as_str().unwrap().to_string();
    // Events keep arriving on another thread while the switch happens.
    let port = d.port;
    let feeder = std::thread::spawn(move || {
        let mut p = Ws::connect(port, SHIOAJI).unwrap();
        for seq in 21..=120 {
            ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000 + seq as i64));
            ingest(&mut p, trade("shioaji", "STK", "3481", "DAY", seq, 200_000 + seq as i64));
        }
    });
    std::thread::sleep(Duration::from_millis(30));
    viewer.send(json!({"type": "view.unsubscribe", "payload": {"subscription_id": sub3481}}));
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY", "request_id": "r2"}}));
    feeder.join().unwrap();
    let msgs = viewer.drain(1500);
    let snap = msgs.iter().find(|m| m["type"] == "view.snapshot" && m["request_id"] == "r2").expect("2330 snapshot")["payload"].clone();
    let sub = snap["subscription_id"].as_str().unwrap().to_string();
    let base = snap["watermark"].as_u64().unwrap();
    let mine: Vec<Value> = deltas(&msgs).into_iter().filter(|d| d["subscription_id"] == sub.as_str()).collect();
    let after_unsubscribe: Vec<Value> = deltas(&msgs).into_iter()
        .skip_while(|d| d["subscription_id"] == sub3481.as_str()).filter(|d| d["subscription_id"] == sub3481.as_str()).collect();
    assert!(after_unsubscribe.is_empty(), "no old-product delta after its unsubscribe");
    let seqs: Vec<u64> = mine.iter().map(|d| d["sequence"].as_u64().unwrap()).collect();
    for (i, s) in seqs.iter().enumerate() {
        assert_eq!(*s, base + 1 + i as u64, "contiguous from the snapshot cut: {seqs:?}");
    }
    let snap_trades = snap["trades"].as_array().unwrap().len();
    let last_seq_in_snapshot = snap["trades"].as_array().unwrap().last().unwrap()["trade_id"].as_str().unwrap().parse::<u64>().unwrap();
    let first_delta_trade = mine.iter().find_map(|d| d["payload"]["trade"]["trade_id"].as_str()).map(|s| s.parse::<u64>().unwrap());
    if let Some(first) = first_delta_trade {
        assert_eq!(first, last_seq_in_snapshot + 1, "the first delta continues exactly after the snapshot");
    }
    assert!(snap_trades <= 100);
    assert!(mine.iter().all(|d| d["code"] == "2330"));
}

#[test]
fn two_sessions_of_one_symbol_never_cross() {
    let d = Daemon::start("sessions", &[]);
    let mut p = d.client(SHIOAJI);
    ingest(&mut p, trade("shioaji", "FUT", "TXFR1", "DAY", 1, 100));
    ingest(&mut p, trade("shioaji", "FUT", "TXFR1", "NIGHT", 1, 200));
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "FUT", "code": "TXFR1", "session": "DAY", "trading_date": "2026-09-29"}}));
    let day = v.await_type("view.snapshot")["payload"].clone();
    assert_eq!(day["summary"]["current"], 0.01);
    ingest(&mut p, trade("shioaji", "FUT", "TXFR1", "NIGHT", 2, 300));
    ingest(&mut p, trade("shioaji", "FUT", "TXFR1", "DAY", 2, 110));
    let got = deltas(&v.drain(600));
    assert_eq!(got.len(), 1, "only the DAY delta reaches the DAY view: {got:?}");
    assert_eq!(got[0]["session"], "DAY");
}

#[test]
fn the_event_tape_snapshot_holds_every_symbols_events_and_new_ones_follow_without_a_view() {
    // 事件列表 starts from A's projection cache, not FastAPI's read of B's event file.
    let d = Daemon::start("event-tape", &[]);
    let mut p = d.client(SHIOAJI);
    for (s, code) in [(1, "2330"), (2, "2317"), (3, "2330")] {
        ingest(&mut p, trade("shioaji", "STK", code, "DAY", s, 1_000_000));
    }
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let stream = b.await_type("durable.subscribed")["payload"]["durable_stream_id"].as_str().unwrap().to_string();
    std::thread::sleep(Duration::from_millis(200));
    let publish = |b: &mut Ws, code: &str, watermark: u64, events: Value| {
        let id = json!({"source": "shioaji", "market": "STK", "code": code, "trading_date": "2026-09-29", "session": "DAY"});
        b.send(json!({"type": "projection.publish", "payload": {"durable_stream_id": stream, "projection_epoch": 1, "items": [
            {"identity": id, "block": "events", "input_watermark": watermark, "revision": 1, "data": {"events": events}}]}}));
        b.await_type("projection.ack")["payload"].clone()
    };
    publish(&mut b, "2330", 1, json!([{"event_id": "a", "revision": 1, "trigger_minute": 540, "as_of_ns": "1"}]));
    publish(&mut b, "2317", 2, json!([{"event_id": "b", "revision": 1, "trigger_minute": 541, "as_of_ns": "2"}]));
    let mut v = d.client(VIEWER);
    // The session the screens show is pushed on connection: nothing to ask for.
    let current = v.await_type("session.current");
    assert!(current.get("request_id").is_none());
    assert!(current["payload"]["equity"]["trading_date"].as_str().is_some_and(|d| d.len() == 10));
    v.send(json!({"type": "events.subscribe", "request_id": "tape-1", "payload": {"market": "STK", "session": "DAY", "trading_date": "2026-09-29"}}));
    let snap = v.await_type("events.snapshot");
    assert_eq!(snap["request_id"], "tape-1");
    let ids: Vec<&str> = snap["payload"]["events"].as_array().unwrap().iter().map(|e| e["event_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["b", "a"], "every symbol's events, newest first, with no view open");
    assert!(snap["payload"].get("events_evicted").is_none(), "the eviction count is in the metrics, not on the tape");
    // A new event of a symbol this viewer has no view of still reaches the tape.
    publish(&mut b, "2330", 3, json!([{"event_id": "c", "revision": 1, "trigger_minute": 542, "as_of_ns": "3"}]));
    let tape = v.await_type("events.tape");
    assert_eq!(tape["payload"]["events"][0]["event_id"], "c");
    assert_eq!(tape["payload"]["events"][0]["code"], "2330", "the symbol identity is filled in");
    v.send(json!({"type": "events.unsubscribe"}));
    v.await_type("events.unsubscribed");
    publish(&mut b, "2330", 3, json!([{"event_id": "d", "revision": 1, "trigger_minute": 543, "as_of_ns": "4"}]));
    assert!(!v.drain(400).iter().any(|m| m["type"] == "events.tape"), "an unsubscribed tape gets nothing");
}

#[test]
fn a_slow_viewer_is_resynchronized_explicitly_instead_of_silently_starved() {
    let d = Daemon::start("slow", &["--client-queue", "16"]);
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY"}}));
    v.await_type("view.snapshot");
    let mut p = d.client(SHIOAJI);
    let events: Vec<Value> = (1..=400).map(|s| trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64)).collect();
    p.send(json!({"type": "event.ingest.batch", "payload": {"events": events}}));
    p.await_type("event.ack.batch");
    let msgs = v.drain(1500);
    assert!(msgs.iter().any(|m| m["type"] == "view.resync_required" && m["payload"]["reason"] == "SLOW_CONSUMER"), "explicit resync notice");
    // Notices the overflow may have dropped come again with their current state, ahead of the fresh snapshot's use.
    assert!(msgs.iter().any(|m| m["type"] == "session.rollover"), "the rollover state is sent again");
    assert!(msgs.iter().any(|m| m["type"] == "analysis.state"), "the analysis state is sent again");
    let at = msgs.iter().rposition(|m| m["type"] == "view.snapshot").expect("fresh snapshot");
    let snap = msgs[at]["payload"].clone();
    assert_eq!(snap["resync_reason"], "SLOW_CONSUMER");
    // The resync snapshot may be cut while the burst is still being applied; the snapshot plus the deltas after it
    // must reach the final state (nothing is lost across the resync).
    let last = msgs[at + 1..].iter().rev().find_map(|m| m["payload"]["payload"]["summary"]["current"].as_f64()
        .or_else(|| m["payload"]["items"].as_array().and_then(|i| i.iter().rev().find_map(|d| d["payload"]["summary"]["current"].as_f64()))))
        .or_else(|| snap["summary"]["current"].as_f64());
    assert_eq!(last, Some(100.04));
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "metrics"}));
    assert!(c.await_type("metrics")["payload"]["delivery"]["slow_resyncs"].as_u64().unwrap() >= 1);
}

#[test]
fn a_view_of_a_partition_that_does_not_exist_yet_streams_once_it_does() {
    // 夜盤 across midnight: the display subscribes the next calendar partition before 00:00, when Market
    // Runtime holds nothing for it yet. The first event of that partition must reach the view.
    let d = Daemon::start("future-partition", &[]);
    let mut p = d.client(SHIOAJI);
    ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000));
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY",
        "trading_date": "2026-09-30", "delta_batch": true}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    assert!(snap["trend"].as_array().is_none_or(|t| t.is_empty()), "nothing yet for 09-30");
    let mut next_day = trade("shioaji", "STK", "2330", "DAY", 2, 1_010_000);
    next_day["exchange_ts_ns"] = json!(TAIPEI_0930_NS + 86_400_000_000_000);
    assert_eq!(ingest(&mut p, next_day)["accepted"], true);
    let got = deltas(&v.drain(600));
    assert!(!got.is_empty(), "the new partition's first event reaches the view that was waiting for it");
    assert!(got.iter().all(|d| d["session_key"]["trading_date"] == "2026-09-30" || d["trading_date"] == "2026-09-30"
        || d.get("session_key").is_none()), "{got:?}");
}

/// Every view received every channel. A view now gets only the deltas of the channels it subscribed to,
/// numbered contiguously in its own sequence from its snapshot.
#[test]
fn a_view_receives_only_its_channels_in_its_own_contiguous_sequence() {
    let d = Daemon::start("channels", &[]);
    let mut v = d.client(VIEWER);
    let subscribe = |v: &mut Ws, channels: Value| {
        v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY",
            "trading_date": "2026-09-29", "channels": channels}}));
        v.await_type("view.snapshot")["payload"].clone()
    };
    let book_snapshot = subscribe(&mut v, json!(["orderbook"]));
    let full_snapshot = subscribe(&mut v, json!(["summary", "trend", "trades", "orderbook"]));
    let (book_id, full_id) = (book_snapshot["subscription_id"].clone(), full_snapshot["subscription_id"].clone());
    let mut p = d.client(SHIOAJI);
    for seq in 1..=6u64 {
        let event = if seq % 3 == 0 {
            let mut e = trade("shioaji", "STK", "2330", "DAY", seq, 0);
            e["event_type"] = json!("orderbook");
            e["data"] = json!({"bids": [{"price": 1_000_000, "volume": seq}], "asks": [{"price": 1_010_000, "volume": 7}]});
            e
        } else {
            trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000 + seq as i64)
        };
        assert_eq!(ingest(&mut p, event)["accepted"], true);
    }
    let got = deltas(&v.drain(800));
    let of = |id: &Value| got.iter().filter(|d| &d["subscription_id"] == id).cloned().collect::<Vec<_>>();
    let (book, full) = (of(&book_id), of(&full_id));
    assert!(!book.is_empty() && book.iter().all(|d| d["delta_type"] == "orderbook.latest"), "only order books: {book:?}");
    assert!(full.iter().any(|d| d["delta_type"] == "trade.frame") && full.iter().any(|d| d["delta_type"] == "orderbook.latest"));
    for (view, snapshot) in [(&book, &book_snapshot), (&full, &full_snapshot)] {
        let start = snapshot["watermark"].as_u64().or_else(|| snapshot["sequence"].as_u64()).unwrap_or(0);
        let sequences: Vec<u64> = view.iter().map(|d| d["sequence"].as_u64().unwrap()).collect();
        let expected: Vec<u64> = (start + 1..=start + sequences.len() as u64).collect();
        assert_eq!(sequences, expected, "contiguous from the snapshot");
    }
    d.shutdown();
}

#[test]
fn a_view_without_a_trading_date_shows_one_session_and_its_resync_is_never_older_than_its_deltas() {
    // Futu 成交明細 停住後補跳: a Futu view leaves the trading date open. If it received the deltas of
    // EVERY cached session of the symbol (B republishing earlier ones), numbered in the view's own sequence, while its
    // resync snapshot carried the newest session's instrument sequence, the snapshot would look older than the deltas
    // already applied, the renderer would refuse it, and the view would freeze until it re-subscribed.
    let d = Daemon::start("one-session-view", &[]);
    let mut p = d.client(FUTU);
    ingest(&mut p, futu_trade("2026-09-28", -1, 1, 100));
    ingest(&mut p, futu_trade("2026-09-29", 0, 2, 200));
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "request_id": "s1", "payload": {"source": "futu", "market": "US", "code": "US.NOK", "session": "FULL"}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    let sub = snap["subscription_id"].as_str().unwrap().to_string();
    assert_eq!(snap["trading_date"], "2026-09-29");
    let mut last = snap["watermark"].as_u64().unwrap();
    for seq in 3..=8 {
        // Older-session traffic interleaved with the shown session's.
        ingest(&mut p, futu_trade("2026-09-28", -1, seq * 2, 100 + seq as i64));
        ingest(&mut p, futu_trade("2026-09-29", 0, seq * 2 + 1, 200 + seq as i64));
    }
    let got: Vec<Value> = deltas(&v.drain(600)).into_iter().filter(|d| d["subscription_id"] == sub.as_str()).collect();
    assert_eq!(got.len(), 6, "only the shown session's deltas: {got:?}");
    for delta in &got {
        assert_eq!(delta["trading_date"], "2026-09-29");
        assert_eq!(delta["sequence"].as_u64().unwrap(), last + 1, "contiguous in the view's own sequence");
        last += 1;
    }
    v.send(json!({"type": "view.resync", "request_id": "r1", "payload": {"subscription_id": sub}}));
    let resync = v.await_type("view.snapshot")["payload"].clone();
    assert!(resync["watermark"].as_u64().unwrap() > last, "a resync snapshot is newer than every delta sent before it");
    ingest(&mut p, futu_trade("2026-09-29", 0, 40, 300));
    let after: Vec<Value> = deltas(&v.drain(600)).into_iter().filter(|d| d["subscription_id"] == sub.as_str()).collect();
    assert_eq!(after[0]["sequence"].as_u64().unwrap(), resync["watermark"].as_u64().unwrap() + 1);
}

#[test]
fn a_view_without_a_trading_date_is_re_cut_onto_a_new_session_by_one_snapshot() {
    let d = Daemon::start("rebind-view", &[]);
    let mut p = d.client(FUTU);
    ingest(&mut p, futu_trade("2026-09-29", 0, 1, 200));
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "futu", "market": "US", "code": "US.NOK", "session": "FULL"}}));
    let first = v.await_type("view.snapshot")["payload"].clone();
    let sub = first["subscription_id"].as_str().unwrap().to_string();
    ingest(&mut p, futu_trade("2026-09-30", 1, 2, 210));
    let rebound = v.await_type("view.snapshot")["payload"].clone();
    assert_eq!(rebound["subscription_id"], sub.as_str());
    assert_eq!(rebound["resync_reason"], "SESSION_CHANGED");
    assert_eq!(rebound["trading_date"], "2026-09-30");
    assert!(rebound["watermark"].as_u64().unwrap() > first["watermark"].as_u64().unwrap());
    ingest(&mut p, futu_trade("2026-09-30", 1, 3, 220));
    let got: Vec<Value> = deltas(&v.drain(600)).into_iter().filter(|d| d["subscription_id"] == sub.as_str()).collect();
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0]["trading_date"], "2026-09-30");
    assert_eq!(got[0]["sequence"].as_u64().unwrap(), rebound["watermark"].as_u64().unwrap() + 1);
}

#[test]
fn every_subscribe_is_its_own_view_and_closing_one_leaves_the_other_streaming() {
    let d = Daemon::start("own-view", &[]);
    let mut p = d.client(FUTU);
    ingest(&mut p, futu_trade("2026-09-29", 0, 1, 200));
    let mut v = d.client(VIEWER);
    let spec = json!({"source": "futu", "market": "US", "code": "US.NOK", "session": "FULL"});
    v.send(json!({"type": "view.subscribe", "request_id": "a", "payload": spec}));
    let a = v.await_type("view.snapshot")["payload"]["subscription_id"].as_str().unwrap().to_string();
    v.send(json!({"type": "view.subscribe", "request_id": "b", "payload": spec}));
    let b = v.await_type("view.snapshot")["payload"]["subscription_id"].as_str().unwrap().to_string();
    assert_ne!(a, b, "a late reply to an abandoned request can never name the view a newer request holds");
    v.send(json!({"type": "view.unsubscribe", "payload": {"subscription_id": a}}));
    v.await_type("view.unsubscribed");
    ingest(&mut p, futu_trade("2026-09-29", 0, 2, 210));
    let got = deltas(&v.drain(600));
    assert!(got.iter().any(|d| d["subscription_id"] == b.as_str()));
    assert!(got.iter().all(|d| d["subscription_id"] != a.as_str()));
}

#[test]
fn a_view_let_go_of_before_its_reply_is_closed_by_its_request() {
    // The client sends the cancel right behind the subscribe, before any reply: A reads them in order, so the view
    // the subscribe opened is the one the cancel closes, and nothing of it streams afterwards.
    let d = Daemon::start("cancel-by-request", &[]);
    let mut p = d.client(FUTU);
    ingest(&mut p, futu_trade("2026-09-29", 0, 1, 200));
    let mut v = d.client(VIEWER);
    let spec = json!({"source": "futu", "market": "US", "code": "US.NOK", "session": "FULL", "request_id": "r1"});
    v.send(json!({"type": "view.subscribe", "payload": spec}));
    v.send(json!({"type": "view.unsubscribe", "payload": {"request_id": "r1"}}));
    let accepted = v.await_type("view.subscription.accepted");
    let opened = accepted["payload"]["subscription_id"].as_str().unwrap().to_string();
    let closed = v.await_type("view.unsubscribed");
    assert_eq!(closed["payload"]["closed"], 1, "{closed}");
    assert_eq!(closed["payload"]["subscription_id"], opened.as_str());
    assert_eq!(closed["payload"]["request_id"], "r1");
    assert_eq!(closed["payload"]["remaining_views"], 0);
    ingest(&mut p, futu_trade("2026-09-29", 0, 2, 210));
    assert!(deltas(&v.drain(600)).is_empty(), "the cancelled view streams nothing");
    // A request that opened no view closes nothing.
    v.send(json!({"type": "view.unsubscribe", "payload": {"request_id": "never-sent"}}));
    assert_eq!(v.await_type("view.unsubscribed")["payload"]["closed"], 0);
}

#[test]
fn a_ui_latency_report_matches_the_send_it_answers_by_the_traces_version() {
    // The renderer must echo the trace version: A files the send under the instrument sequence. Echoing the VIEW
    // sequence matched 86% of reports to nothing and the rest to unrelated sends (資料套用延遲 p50 106 s).
    let d = Daemon::start("latency-key", &[]);
    let mut p = d.client(SHIOAJI);
    ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000));
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY"}}));
    v.await_type("view.snapshot");
    for s in 2..=4 {
        ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000 + s as i64));
    }
    let got = deltas(&v.drain(600));
    let traced: Vec<&Value> = got.iter().filter(|d| d["trace"]["version"].as_u64().is_some()).collect();
    assert!(!traced.is_empty(), "live deltas carry the latency key: {got:?}");
    let now_us = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros() as u64;
    let samples: Vec<Value> = traced.iter().map(|d| json!({"symbol": d["symbol"], "version": d["trace"]["version"],
        "applied_us": now_us, "painted_us": now_us + 1})).collect();
    v.send(json!({"type": "latency.report", "payload": {"samples": samples}}));
    std::thread::sleep(Duration::from_millis(300));
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "metrics"}));
    let latency = c.await_type("metrics")["payload"]["latency"].clone();
    assert_eq!(latency["ui_unmatched"], 0, "{latency}");
    assert_eq!(latency["a_to_ui_paint"]["samples"].as_u64().unwrap(), traced.len() as u64, "{latency}");
    assert!(latency["a_to_ui_paint"]["max"].as_f64().unwrap() < 60_000_000.0, "a real send, not an unrelated old one: {latency}");
}
