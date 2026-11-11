//! Rust B over real WebSockets: projection validation and delivery, large-order queries, coverage records.
//! (docs/system-architecture/08 section 1, the Rust A rows.)

mod support;

use support::*;

#[test]
fn projection_results_are_validated_and_delivered_but_stale_foreign_or_future_ones_are_refused() {
    let d = Daemon::start("projection", &[]);
    let mut p = d.client(SHIOAJI);
    for s in 1..=10 {
        ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000));
    }
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let stream = b.await_type("durable.subscribed")["payload"]["durable_stream_id"].as_str().unwrap().to_string();
    std::thread::sleep(Duration::from_millis(200));
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY"}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    assert_eq!(snap["meta"]["projection"]["minutes"]["completeness"], "RECOVERING");
    let id = json!({"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"});
    let publish = |b: &mut Ws, stream: &str, epoch: u64, watermark: u64, close: f64| {
        b.send(json!({"type": "projection.publish", "payload": {"durable_stream_id": stream, "projection_epoch": epoch, "items": [
            {"identity": id, "block": "minutes", "input_watermark": watermark, "revision": 1, "completeness": "COMPLETE",
             "data": {"minutes": [{"minute": 570, "open": 100.0, "high": 100.0, "low": 100.0, "close": close, "volume": 10, "state": "FINALIZED", "revision": 1}]}}]}}));
        b.await_type("projection.ack")["payload"].clone()
    };
    let ok = publish(&mut b, &stream, 2, 10, 100.0);
    assert_eq!(ok["results"][0]["ok"], true);
    assert_eq!(publish(&mut b, "someone-else", 2, 10, 1.0)["reason"], "STREAM_MISMATCH");
    assert_eq!(publish(&mut b, &stream, 1, 10, 1.0)["results"][0]["ok"], false, "stale epoch");
    assert_eq!(publish(&mut b, &stream, 2, 999, 1.0)["results"][0]["ok"], false, "beyond the committed stream");
    let got = deltas(&v.drain(500));
    let minutes: Vec<&Value> = got.iter().filter(|d| d["delta_type"] == "minutes.upsert").collect();
    assert_eq!(minutes.len(), 1, "only the valid publish reaches the view");
    assert_eq!(minutes[0]["payload"]["points"][0]["close"], 100.0);
    let mut producer = d.client(PRODUCER);
    let row = json!({"model_predictions": {"3m_up": {"probability": 0.61, "status": "OK", "test_only": true}}});
    // A signal batch is fenced like a projection publish -- its stream and an epoch no older than the cache's.
    producer.send(json!({"type": "signals.publish", "payload": {"items": [{"identity": id, "row": row}], "durable_stream_id": "another-stream", "projection_epoch": 2}}));
    assert_eq!(producer.await_type("signals.ack")["payload"]["reason"], "STREAM_MISMATCH");
    producer.send(json!({"type": "signals.publish", "payload": {"items": [{"identity": id, "row": row}], "durable_stream_id": stream, "projection_epoch": 1}}));
    assert_eq!(producer.await_type("signals.ack")["payload"]["ok"], false, "an older epoch");
    producer.send(json!({"type": "signals.publish", "payload": {"items": [{"identity": id, "row": row}], "durable_stream_id": stream, "projection_epoch": 2}}));
    assert_eq!(producer.await_type("signals.ack")["payload"]["merged"], 1);
    let got = deltas(&v.drain(400));
    assert!(got.iter().any(|d| d["delta_type"] == "signals.frame" && d["payload"]["signals"]["model_predictions"]["3m_up"]["probability"] == 0.61));
    // B sends one row per model slot: a batch of several rows for one instrument reaches its view as ONE frame holding
    // all of them, not a whole signals set per row.
    let rows: Vec<Value> = ["5m_up", "10m_up", "3m_down"].iter().map(|slot| json!({"identity": id,
        "row": {"model_predictions": {*slot: {"probability": 0.5, "status": "OK", "test_only": true}}}})).collect();
    producer.send(json!({"type": "signals.publish", "payload": {"items": rows, "durable_stream_id": stream, "projection_epoch": 2}}));
    assert_eq!(producer.await_type("signals.ack")["payload"]["merged"], 3);
    let frames: Vec<Value> = deltas(&v.drain(400)).into_iter().filter(|d| d["delta_type"] == "signals.frame").collect();
    assert_eq!(frames.len(), 1, "one frame per instrument per batch: {frames:?}");
    let predictions = &frames[0]["payload"]["signals"]["model_predictions"];
    for slot in ["3m_up", "5m_up", "10m_up", "3m_down"] {
        assert!(predictions[slot].is_object(), "{slot} in the merged frame");
    }
}

#[test]
fn viewers_are_told_b_rebuild_progress_against_the_committed_head_until_b_is_live() {
    // 分析資料重建中: B's catching-up span is measured against A's committed durable head and pushed to every viewer
    // -- on connect, at each report while B catches up, once when it is LIVE, and OFFLINE when B's session ends.
    // The committed head holds A's own records too: the 2330 scope's first market Clock follows its prints on the
    // next clock tick. With no clock lag that Clock is minute 09:30 and the next one is a whole minute of wall time
    // away, so the head is the 10 prints and that one Clock for the rest of the test.
    let d = Daemon::start("analysis-state", &["--clock-lag-ms", "0"]);
    let mut p = d.client(SHIOAJI);
    for s in 1..=10 {
        ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, 1_000_000));
    }
    let head = 11;
    await_synced(&mut p, head);
    let mut v = d.client(VIEWER);
    let first = v.await_type("analysis.state")["payload"].clone();
    assert_eq!(first["state"], "OFFLINE", "no B has reported yet: {first}");
    let mut b = d.client(ANALYSIS);
    let status = |b: &mut Ws, state: &str, cursor: u64, from: Option<u64>| {
        b.send(json!({"type": "analysis.status", "payload": {"state": state, "cursor": cursor, "head": cursor, "lag": 0,
            "catch_up_from": from, "projection_epoch": 1}}));
    };
    status(&mut b, "CATCHING_UP", 4, Some(0));
    let catching = v.await_type("analysis.state")["payload"].clone();
    assert_eq!(catching["state"], "CATCHING_UP");
    assert_eq!(catching["head"], head, "A's own committed head, not B's view of it");
    assert!((catching["progress"].as_f64().unwrap() - 4.0 / head as f64).abs() < 1e-9, "{catching}");
    status(&mut b, "CATCHING_UP", 8, Some(0));
    assert!((v.await_type("analysis.state")["payload"]["progress"].as_f64().unwrap() - 8.0 / head as f64).abs() < 1e-9);
    status(&mut b, "LIVE", 10, None);
    let live = v.await_type("analysis.state")["payload"].clone();
    assert_eq!(live["state"], "LIVE");
    assert!(live["progress"].is_null());
    status(&mut b, "LIVE", 10, None);
    assert!(v.drain(400).iter().all(|m| m["type"] != "analysis.state"), "an unchanged LIVE is not pushed again");
    // A viewer that connects now hears the current state at once.
    let mut late = d.client(VIEWER);
    assert_eq!(late.await_type("analysis.state")["payload"]["state"], "LIVE");
    drop(b);
    assert_eq!(v.await_type("analysis.state")["payload"]["state"], "OFFLINE", "B's session ended");
}

#[test]
fn a_flood_of_large_projections_never_holds_off_provider_ingest() {
    // B13: after an 83 s replay, B's first full projection kept A busy until both providers' WebSocket
    // keepalives timed out (20 s without a pong). A provider connection answers pings only between commands, and
    // its ingest waits for `core`, which publish_projection held for a whole message of up to 8192 items.
    let d = Daemon::start("projection-flood", &[]);
    let mut p = d.client(SHIOAJI);
    let codes: Vec<String> = (0..400).map(|i| format!("{}", 1000 + i)).collect();
    let mut seq = 0u64;
    for code in &codes {
        seq += 1;
        assert_eq!(ingest(&mut p, trade("shioaji", "STK", code, "DAY", 1, 1_000_000))["accepted"], true);
    }
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let stream = b.await_type("durable.subscribed")["payload"]["durable_stream_id"].as_str().unwrap().to_string();
    let mut viewers = Vec::new();
    for code in codes.iter().take(40) {
        let mut v = d.client(VIEWER);
        v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": code, "session": "DAY"}}));
        v.await_type("view.snapshot");
        viewers.push(v);
    }
    let minutes: Vec<Value> = (540..545).map(|m| json!({"minute": m, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5,
        "volume": 10, "state": "FINALIZED", "revision": 1})).collect();
    let committed = seq;
    let port = d.port;
    let flood = std::thread::spawn(move || {
        let mut b = b;
        for round in 0..30u64 {
            let items: Vec<Value> = codes.iter().flat_map(|code| {
                let id = json!({"source": "shioaji", "market": "STK", "code": code, "trading_date": "2026-09-29", "session": "DAY"});
                (0..8).map(move |k| (id.clone(), k))
            }).take(3200).map(|(id, k)| json!({"identity": id, "block": "minutes", "input_watermark": committed,
                "revision": round * 8 + k + 1, "completeness": "COMPLETE", "data": {"minutes": minutes.clone(), "replace": true}})).collect();
            b.send(json!({"type": "projection.publish", "payload": {"durable_stream_id": stream, "projection_epoch": 1, "items": items}}));
            b.await_type("projection.ack");
        }
        let _ = port;
    });
    let mut worst = Duration::ZERO;
    let mut n = 1u64;
    while !flood.is_finished() {
        n += 1;
        let started = Instant::now();
        let ack = ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", n, 1_000_000));
        assert_eq!(ack["accepted"], true, "{ack}");
        worst = worst.max(started.elapsed());
    }
    flood.join().unwrap();
    drop(viewers);
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "metrics"}));
    let metrics = c.await_type("metrics")["payload"].clone();
    let hold = metrics["projection_timing"]["core_hold_max_us"].as_u64().expect("projection core hold is measured");
    let whole = metrics["projection_timing"]["publish_max_us"].as_u64().unwrap();
    let wait = metrics["ingest"]["core_wait_max_us"].as_u64().expect("ingest core wait is measured");
    eprintln!("B13 flood: {n} ingests, worst round trip {worst:?}, core hold max {hold} us, message max {whole} us, ingest core wait max {wait} us");
    assert!(n > 2, "the provider ingested while the projections were applied");
    assert!(hold * 4 < whole, "core is released between item groups of one message (hold {hold} us, message {whole} us)");
    // Releasing alone is not enough: the mutex is unfair and the publisher took it straight back (wait == message).
    assert!(wait * 4 < whole, "a waiting ingest gets core between item groups (wait {wait} us, message {whole} us)");
    let stall = &metrics["connections"]["provider"];
    assert!(stall["max_command_us"].as_u64().is_some(), "a provider connection's longest unserviced stretch is measured: {stall}");
}

#[test]
fn a_large_order_window_query_goes_to_b_and_its_answer_only_to_the_viewer_that_asked() {
    // B9: the 價量 tab asks for one session bucket's large orders; B holds them, A only routes.
    let d = Daemon::start("large-orders-query", &[]);
    let mut p = d.client(SHIOAJI);
    ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000));
    let mut v = d.client(VIEWER);
    let ask = json!({"type": "flow.large_orders", "payload": {"request_id": "r1", "source": "shioaji", "market": "STK", "code": "2330",
        "session": "DAY", "from_minute": 540, "to_minute": 630}});
    v.send(ask.clone());
    let refused = v.await_type("flow.large_orders.result");
    assert_eq!(refused["payload"]["reason"], "ANALYSIS_RUNTIME_UNAVAILABLE", "no B connected: refused at once, never left hanging");
    assert_eq!(refused["payload"]["request_id"], "r1");

    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut other = d.client(VIEWER);
    v.send(ask);
    let query = b.await_type("flow.large_orders.query")["payload"].clone();
    assert_eq!(query["identity"]["code"], "2330");
    assert_eq!(query["identity"]["session"], "DAY");
    assert_eq!((query["from_minute"].as_i64(), query["to_minute"].as_i64()), (Some(540), Some(630)));
    let query_id = query["query_id"].as_str().unwrap().to_string();
    b.send(json!({"type": "flow.large_orders.result", "payload": {"query_id": query_id, "ok": true, "truncated": false,
        "rows": [{"durable_sequence": 1, "volume": 499, "side": "BUY"}]}}));
    let answer = v.await_type("flow.large_orders.result")["payload"].clone();
    assert_eq!(answer["request_id"], "r1");
    assert_eq!(answer["rows"][0]["volume"], 499);
    assert!(answer.get("query_id").is_none(), "A's routing id stays inside A");
    assert!(deltas(&other.drain(300)).is_empty() && !other.drain(100).iter().any(|m| m["type"] == "flow.large_orders.result"),
        "another viewer never receives it");
    // A late or repeated answer for a finished query reaches no one, and is counted and named.
    b.send(json!({"type": "flow.large_orders.result", "payload": {"query_id": query_id, "rows": []}}));
    assert!(!v.drain(300).iter().any(|m| m["type"] == "flow.large_orders.result"));
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "metrics"}));
    let queries = c.await_type("metrics")["payload"]["large_order_queries"].clone();
    assert_eq!((queries["pending"].as_u64(), queries["unrouted"].as_u64()), (Some(0), Some(1)), "{queries}");
    assert!(queries["last_unrouted"].as_str().unwrap().contains(&query_id), "{queries}");
    // A viewer may not answer queries, and B may not ask them.
    v.send(json!({"type": "flow.large_orders.result", "payload": {"query_id": "x"}}));
    assert_eq!(v.await_type("error")["error"], "FORBIDDEN");
    b.send(json!({"type": "flow.large_orders", "payload": {"code": "2330"}}));
    assert_eq!(b.await_type("error")["error"], "FORBIDDEN");
}

#[test]
fn never_stored_coverage_reaches_a_b_that_attaches_later_and_again_after_it_reconnects() {
    // A crypto subscription confirmed before B is attached was broadcast to nobody and never sent again.
    let d = Daemon::start("livecoverage", &[]);
    let mut p = d.client(FUTU);
    p.send(json!({"type": "adapter.register", "payload": {"source": "futu", "max_subscriptions": 50, "kinds": ["quote", "trade"]}}));
    p.await_type("adapter.registered");
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "futu", "market": "CC", "code": "CC.BTCUSD", "session": "FULL"}}));
    v.await_type("view.snapshot");
    let plan = loop {
        let plan = p.await_type("adapter.subscription.replace")["payload"].clone();
        if plan["codes"].as_array().unwrap().iter().any(|c| c == "CC.BTCUSD") { break plan; }
    };
    p.send(json!({"type": "adapter.subscription.status", "payload": {"generation": plan["generation"],
        "subscribed": [{"market": "CC", "code": "CC.BTCUSD"}], "failed": []}}));
    let status = p.await_type("adapter.subscription.status.ack")["payload"].clone();
    assert_eq!(status["ok"], true, "{status}");
    let coverage_of = |seen: &[Value]| seen.iter().filter(|m| m["type"] == "live.batch")
        .flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
        .any(|e| e["time_quality"] == "coverage_control" && e["code"] == "CC.BTCUSD" && e["payload"]["state"] == "subscribed");
    for attach in 0..2 {
        let mut b = d.client(ANALYSIS);
        b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
        let seen = b.until(|seen| coverage_of(seen));
        assert!(coverage_of(&seen), "attach {attach}: B gets the live coverage: {seen:?}");
    }
}
