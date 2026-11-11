//! `trades.page`: Market Runtime answers the trade-detail pages from its own WAL (an index the start's scan builds and
//! each append extends) and, once a session is materialized, from the historical store.

mod support;

use serde_json::{json, Value};
use support::*;

fn page(daemon: &Daemon, payload: Value) -> Value {
    let mut viewer = daemon.client(VIEWER);
    viewer.send(json!({"type": "trades.page", "request_id": "p", "payload": payload}));
    viewer.await_type("trades.page")["payload"].clone()
}

fn sequences(answer: &Value) -> Vec<u64> {
    answer["rows"].as_array().unwrap().iter().map(|r| r["durable_sequence"].as_u64().unwrap()).collect()
}

#[test]
fn pages_come_from_the_wal_index_across_a_restart_and_from_the_store_once_materialized() {
    let root = temp_dir("trade-pages");
    let historical = root.join("historical").to_string_lossy().into_owned();
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--historical-dir", &historical]);
    let mut p = daemon.client(SHIOAJI);
    let mut last = 0;
    for seq in 1..=5 {
        last = ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000 + seq as i64))["durable_sequence"].as_u64().unwrap();
    }
    // A 試撮 print is not a trade of the tape.
    let mut simtrade = trade("shioaji", "STK", "2330", "DAY", 6, 1_000_100);
    simtrade["data"]["simtrade"] = json!(true);
    last = last.max(ingest(&mut p, simtrade)["durable_sequence"].as_u64().unwrap());
    await_synced(&mut p, last);

    let request = json!({"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY", "page": 1, "page_size": 2});
    let first = page(&daemon, request.clone());
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!((first["total_rows"].as_u64(), first["total_pages"].as_u64()), (Some(5), Some(3)), "{first}");
    let newest = sequences(&first);
    assert_eq!(newest.len(), 2);
    assert!(newest[0] > newest[1], "newest first: {newest:?}");
    assert_eq!(first["rows"][0]["price"], json!(100.0005));
    assert_eq!(first["rows"][0]["side"], "BUY");
    // 2026-09-29 is long over and not materialized: served from the WAL, labelled as such.
    assert_eq!((first["coverage"].as_str(), first["wal_coverage"].as_str()), (Some("PENDING"), Some("WAL")), "{first}");
    let third = page(&daemon, json!({"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY", "page": 3, "page_size": 2}));
    assert_eq!(sequences(&third).len(), 1);
    let frozen = page(&daemon, json!({"market": "STK", "code": "2330", "trading_date": "2026-09-29", "page": 1, "page_size": 10,
                                      "snapshot_watermark": newest[1]}));
    assert_eq!(frozen["session"], "DAY", "STK's one WAL session when none is named");
    assert_eq!(frozen["total_rows"], 4, "nothing past the watermark the pager froze: {frozen}");
    let missing = page(&daemon, json!({"market": "STK", "code": "9999", "trading_date": "2026-09-29", "session": "DAY"}));
    assert_eq!((missing["coverage"].as_str(), missing["total_rows"].as_u64()), (Some("MISSING"), Some(0)));

    // A new process rebuilds the index in its start's WAL scan: the same pages.
    drop(p);
    let (root, data) = daemon.shutdown();
    let daemon = Daemon::start_in(root.clone(), data, &["--historical-dir", &historical]);
    let again = page(&daemon, request.clone());
    assert_eq!(sequences(&again), newest, "{again}");
    assert_eq!(again["total_rows"], 5);

    // Materialized: the historical store's copy is read instead.
    write_partition(&root, &[recorded_trade(101, 1_790_000_000_000_000_001, 1_000_000), recorded_trade(102, 1_790_000_000_000_000_002, 1_010_000),
                             recorded_trade(103, 1_790_000_000_000_000_003, 1_020_000)]);
    let stored = page(&daemon, request);
    assert_eq!(stored["coverage"], "MATERIALIZED", "{stored}");
    assert_eq!(sequences(&stored), vec![103, 102]);
    assert_eq!(stored["total_rows"], 3);
    daemon.shutdown();
}

/// A searched stock (off the background list) is shown and never stored, so no WAL holds its prints: A keeps its tape
/// and answers its pages, a gap filled from the broker afterwards (a late join) included. The trade frame carries the
/// print just applied, wherever it sits in exchange-time order, so page 1 shows a filled print too.
#[test]
fn an_unlisted_stocks_pages_hold_its_prints_and_a_late_filled_print_in_exchange_time_order() {
    let daemon = Daemon::start("trade-pages-unlisted", &[]);
    let mut c = daemon.client(CONTROLLER);
    c.send(json!({"type": "background.replace", "payload": {"revision": 1, "items": [
        {"source": "shioaji", "market": "STK", "code": "2330", "owners": ["watchlist"]}]}}));
    c.await_type("background.replace.ack");
    let mut p = daemon.client(SHIOAJI);
    for seq in 10..=12 {
        assert_eq!(ingest(&mut p, trade("shioaji", "STK", "2454", "DAY", seq, 1_500_000 + seq as i64))["storage"], "live_only");
    }
    let mut v = daemon.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2454", "session": "DAY"}}));
    v.await_type("view.snapshot");
    // The late join's fill: a print older than every one shown, sent after them (the source numbering goes on).
    let mut filled = trade("shioaji", "STK", "2454", "DAY", 13, 1_400_000);
    let filled_ts = exchange_ns_for("STK", "DAY", 5);
    filled["exchange_ts_ns"] = json!(filled_ts);
    filled["data"]["total_volume"] = json!(5);
    assert_eq!(ingest(&mut p, filled)["storage"], "live_only");
    let frames = deltas(&v.drain(800));
    let carried: Vec<String> = frames.iter().filter(|d| d["delta_type"] == "trade.frame")
        .map(|d| d["payload"]["trade"]["exchange_ts_ns"].as_str().unwrap_or("").to_string()).collect();
    assert_eq!(carried, vec![filled_ts.to_string()], "the frame carries the filled print, not the newest again: {frames:?}");

    let request = json!({"market": "STK", "code": "2454", "trading_date": "2026-09-29", "session": "DAY", "page": 1, "page_size": 10});
    let first = page(&daemon, request.clone());
    assert_eq!(first["total_rows"], 4, "{first}");
    let times: Vec<String> = first["rows"].as_array().unwrap().iter().map(|r| r["exchange_ts_ns"].as_str().unwrap().to_string()).collect();
    assert_eq!(times.last(), Some(&filled_ts.to_string()), "the filled print sits at its exchange time, oldest: {first}");
    assert!(first["rows"].as_array().unwrap().iter().all(|r| r["durable_sequence"] == 0), "never stored: {first}");
    assert_eq!(first["rows"][0]["price"], json!(150.0012));

    // A page read names the committed sequence as its watermark; a searched print is stamped with the committed
    // sequence of its moment, so one after the next commit is past a page frozen before it.
    let stored = ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000))["durable_sequence"].as_u64().unwrap();
    await_synced(&mut p, stored);
    let frozen_at = page(&daemon, request.clone())["snapshot_watermark"].as_u64().unwrap();
    assert_eq!(frozen_at, stored, "the committed sequence");
    let stored = ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 2, 1_000_100))["durable_sequence"].as_u64().unwrap();
    await_synced(&mut p, stored);
    assert_eq!(ingest(&mut p, trade("shioaji", "STK", "2454", "DAY", 14, 1_500_014))["storage"], "live_only");
    let latest = page(&daemon, request.clone());
    assert_eq!(latest["total_rows"], 5, "{latest}");
    let frozen = page(&daemon, json!({"market": "STK", "code": "2454", "trading_date": "2026-09-29", "session": "DAY", "page": 1,
                                      "page_size": 10, "snapshot_watermark": frozen_at}));
    assert_eq!(frozen["total_rows"], 4, "a page frozen before the later print does not shift: {frozen}");
    daemon.shutdown();
}
