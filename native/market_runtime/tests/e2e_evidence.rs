//! Session evidence kept by Market Runtime (src/evidence.rs, src/server/evidence.rs): the files it writes, a provider's
//! loss reports and restarts, the owners' commands, and a restart of Market Runtime itself.

mod support;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use support::*;

fn evidence_file(root: &Path, market: &str, date: &str, session: &str) -> PathBuf {
    root.join("shioaji").join(market).join(format!("{date}_{session}.json"))
}

/// The file once it says what `ready` wants (it is written within a second of a change).
fn read_until(path: &Path, ready: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + SETTLE;
    loop {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                if ready(&value) {
                    return value;
                }
            }
        }
        assert!(Instant::now() < deadline, "{} never got there", path.display());
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn command(p: &mut Ws, kind: &str, payload: Value) -> Value {
    p.send(json!({"type": kind, "payload": payload}));
    p.await_type(&format!("{kind}.ack"))["payload"].clone()
}

fn start(name: &str) -> (Daemon, PathBuf) {
    let root = temp_dir(name);
    let evidence = root.join("session_evidence");
    let daemon = Daemon::start_in(root.clone(), root.join("data"), &["--evidence-root", evidence.to_str().unwrap()]);
    (daemon, evidence)
}

#[test]
fn market_runtime_writes_each_partitions_evidence_and_a_loss_report_becomes_a_gap_in_the_wal_and_the_record() {
    let (d, root) = start("evidence-loss");
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut p = d.client(SHIOAJI);
    assert_eq!(command(&mut p, "ingest.hello", json!({"instance": "p1"}))["restarted"], json!([]));
    for seq in 1..=3 {
        assert_eq!(ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000))["accepted"], true);
    }
    let path = evidence_file(&root, "STK", "2026-09-29", "DAY");
    let file = read_until(&path, |f| f["accepted"] == 3);
    assert_eq!((file["schema"].as_str(), file["completeness"].as_str(), file["instance"].as_str()),
        (Some("market-runtime-session-evidence-v1"), Some("complete"), Some("p1")), "{file}");
    assert_eq!(file["first_ts_ns"], TAIPEI_0930_NS + 1);

    // The provider dropped 4 prints of 2317 at 09:31: written as a SOURCE_GAP of that partition, and a loss.
    p.send(json!({"type": "ingest.loss", "payload": {"reports": [{"market": "STK", "code": "2317", "from_ns": TAIPEI_0930_NS + 60_000_000_000,
        "to_ns": TAIPEI_0930_NS + 61_000_000_000, "count": 4, "reason": "dropped", "connection": "ingest"}]}}));
    let ack = p.await_type("ingest.loss.ack")["payload"].clone();
    assert!(ack["results"][0]["durable_sequence"].as_u64().is_some(), "{ack}");
    let msgs = b.until(|seen| seen.iter().filter(|m| m["type"] == "durable.batch")
        .flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default()).any(|e| e["payload"]["kind"] == "source_status"));
    let gap = msgs.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
        .find(|e| e["payload"]["kind"] == "source_status").unwrap();
    assert_eq!((gap["code"].as_str(), gap["trading_date"].as_str(), gap["session"].as_str(), gap["flags"]["gap_before"].as_u64()),
        (Some("2317"), Some("2026-09-29"), Some("DAY"), Some(4)), "{gap}");
    let file = read_until(&path, |f| f["dropped"] == 4);
    assert_eq!(file["completeness"], "gap_detected", "{file}");

    // A broker outage during trading is a hole in its codes only.
    p.send(json!({"type": "ingest.loss", "payload": {"reports": [{"market": "STK", "code": "2454", "from_ns": TAIPEI_0930_NS + 120_000_000_000,
        "to_ns": TAIPEI_0930_NS + 180_000_000_000, "reason": "broker_outage", "connection": "conn-2"}]}}));
    p.await_type("ingest.loss.ack");
    let file = read_until(&path, |f| f["gap_codes"] == json!(["2454"]));
    assert_eq!(file["outages"][0]["connection"], "conn-2", "{file}");
    d.shutdown();
}

#[test]
fn a_new_provider_process_is_a_restart_the_owner_seals_and_prunes_and_a_market_runtime_restart_counts_nothing_twice() {
    let (d, root) = start("evidence-restart");
    let mut p = d.client(SHIOAJI);
    command(&mut p, "ingest.hello", json!({"instance": "p1"}));
    for seq in 1..=5 {
        ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000));
    }
    let path = evidence_file(&root, "STK", "2026-09-29", "DAY");
    read_until(&path, |f| f["accepted"] == 5);
    drop(p);
    let (root_dir, data) = d.shutdown();

    // Market Runtime restarts: the record comes back from its checkpoint, the same process reconnecting restarts nothing.
    let d = Daemon::start_in(root_dir.clone(), data.clone(), &["--evidence-root", root.to_str().unwrap()]);
    let mut p = d.client(SHIOAJI);
    assert_eq!(command(&mut p, "ingest.hello", json!({"instance": "p1"}))["restarted"], json!([]));
    ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 6, 1_000_000));
    let file = read_until(&path, |f| f["accepted"] == 6);
    assert_eq!(file["restarts"], json!([]), "{file}");

    // Another process: a restart of the open partition.
    let mut q = d.client(SHIOAJI);
    let hello = command(&mut q, "ingest.hello", json!({"instance": "p2"}));
    assert_eq!(hello["restarted"].as_array().map(Vec::len), Some(1), "{hello}");
    let file = read_until(&path, |f| f["restarts"].as_array().is_some_and(|r| r.len() == 1));
    assert_eq!(file["instance"], "p2", "{file}");

    // The owner seals it (answered once written), and prunes it once closed.
    let partition = json!({"market": "STK", "trading_date": "2026-09-29", "session": "DAY"});
    let unsealed = command(&mut q, "evidence.prune", json!({"sessions": [partition.clone()]}));
    assert_eq!(unsealed["removed"], json!([]), "an open partition is never pruned");
    assert_eq!(command(&mut q, "evidence.seal", partition.clone())["ok"], true);
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap()["sealed"], true);
    let missing = json!({"market": "STK", "trading_date": "2026-09-30", "session": "DAY"});
    assert_eq!(command(&mut q, "evidence.seal", missing)["ok"], false, "sealing invents no record");
    let pruned = command(&mut q, "evidence.prune", json!({"sessions": [partition]}));
    assert_eq!(pruned["removed"].as_array().map(Vec::len), Some(1), "{pruned}");
    assert!(!path.exists());
    d.shutdown();
}

#[test]
fn a_closed_session_takes_no_event_after_its_record_is_pruned_and_market_runtime_restarts() {
    let (d, root) = start("evidence-closed");
    let path = root.join("futu").join("US").join("2026-09-29_FULL.json");
    let mut p = d.client(FUTU);
    command(&mut p, "ingest.hello", json!({"instance": "f1"}));
    for seq in 1..=3 {
        assert_eq!(ingest(&mut p, futu_trade("2026-09-29", 0, seq, 1_000_000))["accepted"], true);
    }
    read_until(&path, |f| f["accepted"] == 3);
    let partition = json!({"market": "US", "trading_date": "2026-09-29", "session": "FULL"});
    assert_eq!(command(&mut p, "evidence.seal", partition.clone())["ok"], true);
    let pruned = command(&mut p, "evidence.prune", json!({"sessions": [partition]}));
    assert_eq!(pruned["removed"].as_array().map(Vec::len), Some(1), "{pruned}");
    assert!(!path.exists());

    // The broker re-sends its last print on a new subscription: refused, never stored, no record made for it.
    let late = ingest(&mut p, futu_trade("2026-09-29", 0, 4, 1_000_000));
    assert_eq!((late["accepted"].as_bool(), late["reason"].as_str()), (Some(false), Some("PARTITION_CLOSED")), "{late}");
    assert_eq!(ingest(&mut p, futu_trade("2026-09-30", 1, 5, 1_000_000))["accepted"], true, "the next session opens as usual");
    read_until(&root.join("futu").join("US").join("2026-09-30_FULL.json"), |f| f["accepted"] == 1);
    assert!(!path.exists(), "the closed session's record is not made again");
    drop(p);
    let (root_dir, data) = d.shutdown();

    let d = Daemon::start_in(root_dir, data, &["--evidence-root", root.to_str().unwrap()]);
    let mut p = d.client(FUTU);
    command(&mut p, "ingest.hello", json!({"instance": "f2"}));
    let late = ingest(&mut p, futu_trade("2026-09-29", 0, 6, 1_000_000));
    assert_eq!(late["reason"], "PARTITION_CLOSED", "closed across a Market Runtime restart too: {late}");
    assert!(!path.exists());
    d.shutdown();
}

#[test]
fn only_a_provider_may_decide_on_evidence_and_only_for_its_own_source() {
    let (d, root) = start("evidence-roles");
    let mut viewer = d.client(VIEWER);
    viewer.send(json!({"type": "evidence.seal", "payload": {"market": "STK", "trading_date": "2026-09-29", "session": "DAY"}}));
    assert_eq!(viewer.await_type("error")["error"], "FORBIDDEN");
    let mut shioaji = d.client(SHIOAJI);
    command(&mut shioaji, "ingest.hello", json!({"instance": "s"}));
    ingest(&mut shioaji, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000));
    read_until(&evidence_file(&root, "STK", "2026-09-29", "DAY"), |f| f["accepted"] == 1);
    let mut futu = d.client(FUTU);
    let other = command(&mut futu, "evidence.seal", json!({"market": "STK", "trading_date": "2026-09-29", "session": "DAY"}));
    assert_eq!(other["ok"], false, "futu's seal names a futu partition, never shioaji's: {other}");
    d.shutdown();
}

/// A late join (src/late_join.rs): the provider states when each instrument's print stream was subscribed; a stock,
/// an index and a futures contract subscribed once their session was trading come back, at their first print, in the
/// answer to the batch that carried it -- from the open, with the first print's time and cumulative volume. One
/// subscribed before the open does not; neither does a provider that fills no gaps.
#[test]
fn a_code_subscribed_once_its_session_traded_comes_back_at_its_first_print_as_a_gap_from_the_open() {
    let (d, root) = start("evidence-late-join");
    let mut c = d.client(SHIOAJI);
    c.send(json!({"type": "adapter.register", "payload": {"source": "shioaji", "max_subscriptions": 50, "kinds": ["quote", "trade", "orderbook"]}}));
    c.await_type("adapter.registered");
    let mut v = d.client(VIEWER);
    for (market, code) in [("STK", "3481"), ("STK", "2317"), ("IDX", "IX0028"), ("FUT", "TXFR1")] {
        v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": market, "code": code, "session": "DAY"}}));
        v.await_type("view.snapshot");
    }
    let generation = loop {
        let plan = c.await_type("adapter.subscription.replace")["payload"].clone();
        if plan["codes"].as_array().unwrap().len() == 4 {
            break plan["generation"].clone();
        }
    };
    let minute = 60_000_000_000i64;
    let late = TAIPEI_0930_NS - 10 * minute;
    let early = TAIPEI_0930_NS - 60 * minute;
    c.send(json!({"type": "adapter.subscription.status", "payload": {"generation": generation, "subscribed": [
        {"market": "STK", "code": "3481", "since_ns": late}, {"market": "STK", "code": "2317", "since_ns": early},
        {"market": "IDX", "code": "IX0028", "since_ns": late}, {"market": "FUT", "code": "TXFR1", "since_ns": late}]}}));
    assert_eq!(c.await_type("adapter.subscription.status.ack")["payload"]["ok"], true);

    let mut p = d.client(SHIOAJI);
    command(&mut p, "ingest.hello", json!({"instance": "p1", "fills_gaps": true}));
    let mut stock = trade("shioaji", "STK", "3481", "DAY", 1, 1_000_000);
    stock["data"]["total_volume"] = json!(900);
    stock["data"]["volume"] = json!(5);
    let mut early_stock = trade("shioaji", "STK", "2317", "DAY", 1, 1_000_000);
    early_stock["data"]["total_volume"] = json!(5);
    early_stock["data"]["volume"] = json!(5);
    let quote = |code: &str, market: &str, seq: u64, data: Value| json!({"schema": "market-event-v2", "source": "shioaji", "market": market,
        "code": code, "generation": 1, "sequence": seq, "event_type": "quote", "exchange_ts_ns": TAIPEI_0930_NS + 2,
        "arrival_ns": TAIPEI_0930_NS as u64 + 500, "data": data});
    let index = quote("IX0028", "IDX", 1, json!({"current": 5_000_000, "total_volume": 1000}));
    let future = quote("TXFR1", "FUT", 1, json!({"current": 230_000_000, "total_volume": 40_000, "volume": 3}));
    p.send(json!({"type": "event.ingest.batch", "payload": {"events": [stock, early_stock, index, future]}}));
    let ack = p.await_type("event.ack.batch")["payload"].clone();
    assert!(ack["results"].as_array().unwrap().iter().all(|r| r["accepted"] == true), "{ack}");
    let gaps = ack["gaps"].as_array().unwrap();
    let by_code = |code: &str| gaps.iter().find(|g| g["code"] == code).cloned();
    assert_eq!(gaps.len(), 3, "2317 was subscribed before the open: {ack}");
    let s = by_code("3481").unwrap();
    assert_eq!((s["cause"].as_str(), s["after_ns"].as_i64(), s["total_before"].as_f64()), (Some("late_join"), Some(0), Some(0.0)));
    assert_eq!((s["next_ns"].as_i64(), s["next_total_before"].as_f64(), s["since_ns"].as_i64()), (Some(TAIPEI_0930_NS + 1), Some(895.0), Some(late)));
    let i = by_code("IX0028").unwrap();
    assert!(i["total_before"].is_null() && i["next_total_before"].is_null(), "{i}");
    let f = by_code("TXFR1").unwrap();
    assert_eq!((f["session"].as_str(), f["next_total_before"].as_f64()), (Some("DAY"), Some(39_997.0)));

    // A second print of the same code is no first print: nothing more comes back.
    let mut again = trade("shioaji", "STK", "3481", "DAY", 2, 1_000_000);
    again["data"]["total_volume"] = json!(901);
    p.send(json!({"type": "event.ingest.batch", "payload": {"events": [again]}}));
    assert_eq!(p.await_type("event.ack.batch")["payload"]["gaps"], json!([]));

    // The record holds the late join; the fill reported meets the first print's volume.
    let path = evidence_file(&root, "STK", "2026-09-29", "DAY");
    read_until(&path, |f| f["late_joins"]["3481"]["fill"]["state"] == "requested");
    let reply = command(&mut p, "ingest.backfill", json!({"reports": [{"market": "STK", "code": "3481", "trading_date": "2026-09-29",
        "session": "DAY", "cause": "late_join", "outcome": "stored", "end": "first_live_print", "prints": 12, "volume": 895.0,
        "total_before": 0.0, "next_total_before": 895.0}]}));
    assert_eq!(reply["known"], json!([true]));
    let file = read_until(&path, |f| f["late_joins"]["3481"]["fill"]["state"] == "filled");
    assert_eq!(file["completeness"], "complete", "a late join is no loss of the partition: {file}");
    d.shutdown();
}
