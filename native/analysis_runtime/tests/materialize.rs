//! The historical materialization job (`analysis_runtime --materialize`): synthetic WAL data written
//! with Market Runtime's own WAL writer, folded by B's canonical engine. Ported from the former
//! historical_materializer binary's smoke tests (Market Runtime's v1 LiveEngine), plus the loss-evidence rules.

use market_runtime::event::{EventFlags, MarketEvent, Payload};
use market_runtime::wal::{self, WalConfig, WalWriter};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
}

fn temp_dir(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("stk-b-materialize-{name}-{}", now_ns()));
    fs::create_dir_all(&p).unwrap();
    p
}

/// 09:00 + `second` seconds on `trading_date`, Taipei.
fn ts(trading_date: &str, minute: i64, second: i64) -> i64 {
    let y: i64 = trading_date[..4].parse().unwrap();
    let m: i64 = trading_date[5..7].parse().unwrap();
    let d: i64 = trading_date[8..10].parse().unwrap();
    (market_runtime::event::days_from_civil(y, m, d) * 86_400 + minute * 60 + second - 8 * 3600) * 1_000_000_000
}

fn trade_event(symbol: &str, session: &str, trading_date: &str, sequence: u64, price: i64) -> MarketEvent {
    let mut parts = symbol.split(':');
    let provider = parts.next().unwrap().to_string();
    let market = parts.next().unwrap().to_string();
    let code = parts.next().unwrap().to_string();
    MarketEvent {
        schema_version: 2, event_id: String::new(), durable_sequence: 0, symbol: symbol.into(), provider, market, code,
        session: session.into(), trading_date: trading_date.into(), generation: 1, sequence, exchange_ts_ns: ts(trading_date, 600, sequence as i64),
        arrival_ns: 1, a_received_ns: 1, runtime_epoch: 1, time_quality: "exchange".into(), trace_id: String::new(),
        flags: EventFlags::default(), versions: Default::default(),
        payload: Payload::Trade { price, volume: 1.0, total_volume: sequence as f64, side: 1, trade_id: sequence.to_string(), minute: 600,
            open: 0, high: 0, low: 0, average: 0, total_amount: 0.0, amount: 0.0, simtrade: false,
            bid_side_total_vol: None, ask_side_total_vol: None, auction: false, after_hours: false, condition: None, no_last_sale: false },
    }
}

/// Write `events` through Market Runtime's WAL writer, durable sequences 1.. in order.
fn write_wal(dir: &Path, segment_limit: u64, events: Vec<MarketEvent>) {
    let (index, _) = wal::scan(dir, true).unwrap();
    let committed = index.max_sequence;
    let writer = WalWriter::open(dir, WalConfig { segment_limit, ..Default::default() }, index, committed, Box::new(|_, _| {})).unwrap();
    let mut last = committed;
    for mut e in events {
        last += 1;
        e.durable_sequence = last;
        assert!(writer.reserve());
        writer.submit(e);
    }
    assert!(writer.wait_committed(last, Duration::from_secs(10)));
    writer.stop().unwrap();
}

fn job(args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_analysis_runtime")).arg("--materialize").args(args).output().unwrap();
    serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).expect("one JSON line")
}

fn run_job(wal: &Path, out: &Path, market: &str, code: &str, date: &str, session: &str) -> Value {
    job(&["--data-dir", wal.to_str().unwrap(), "--out-dir", out.to_str().unwrap(), "--source", "shioaji", "--market", market,
          "--code", code, "--trading-date", date, "--session", session, "--completeness", "complete"])
}

fn partition(out: &Path, market: &str, date: &str, session: &str, code: &str) -> PathBuf {
    out.join("source=shioaji").join(format!("market={market}")).join(format!("trading_date={date}")).join(format!("session={session}")).join(code)
}

fn read(path: PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn the_session_state_carries_the_official_limits_or_none() {
    let (wal_dir, out_dir) = (temp_dir("wal"), temp_dir("out"));
    let mut reference = trade_event("shioaji:STK:2344", "DAY", "2026-09-23", 1, 0);
    reference.payload = Payload::Reference { limit_up: Some(1_325_000), limit_down: Some(1_085_000), prev_close: Some(1_205_000), prev_volume: None,
        reference_price: None, name: None, reference_source: None };
    write_wal(&wal_dir, 1 << 20, vec![
        reference,
        trade_event("shioaji:STK:2344", "DAY", "2026-09-23", 2, 1_325_000),
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 3, 1_000_000),
    ]);
    run_job(&wal_dir, &out_dir, "STK", "2344", "2026-09-23", "DAY");
    run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    let summary = |code| read(partition(&out_dir, "STK", "2026-09-23", "DAY", code).join("state.json"))["state"]["summary"].clone();
    assert_eq!((summary("2344")["limit_up"].as_i64(), summary("2344")["limit_down"].as_i64()), (Some(1_325_000), Some(1_085_000)));
    assert!(summary("2330")["limit_up"].is_null() && summary("2330")["limit_down"].is_null(), "no Reference event, no limits");
    assert_eq!(summary("2344")["reference_price"].as_i64(), Some(1_205_000), "no reference price: 昨收");
    assert!(summary("2330")["reference_price"].is_null() && summary("2330").get("prev_close").is_none(), "unknown, never 0");
}

#[test]
fn materializes_matching_events_with_b_s_fold_and_ignores_other_sessions() {
    let (wal_dir, out_dir) = (temp_dir("wal"), temp_dir("out"));
    write_wal(&wal_dir, 1 << 20, vec![
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000),
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 2, 1_010_000),
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 3, 1_020_000),
        // Another symbol and another trading date are not this job's.
        trade_event("shioaji:STK:2317", "DAY", "2026-09-23", 4, 5_000_000),
        trade_event("shioaji:STK:2330", "DAY", "2026-09-22", 5, 9_990_000),
    ]);
    let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    assert_eq!((result["ok"].clone(), result["status"].clone(), result["event_count"].clone()), (Value::Bool(true), "materialized".into(), 3.into()), "{result}");
    assert_eq!(result["completeness"], "complete");
    let dir = partition(&out_dir, "STK", "2026-09-23", "DAY", "2330");
    assert_eq!(fs::read_to_string(dir.join("events.jsonl")).unwrap().lines().count(), 3);
    let manifest = read(dir.join("manifest.json"));
    assert_eq!((manifest["event_count"].clone(), manifest["rust_detected_gap"].clone(), manifest["fold"].clone()),
               (3.into(), false.into(), "analysis_runtime".into()));
    let state = read(dir.join("state.json"));
    assert_eq!(state["state"]["summary"]["current"], 1_020_000);
    assert_eq!(state["state"]["summary"]["open"], 1_000_000);
    assert_eq!(state["state"]["summary"]["total_volume"], 3.0);
    let bar = &state["state"]["minute_trend"]["600"];
    assert_eq!((bar["open"].clone(), bar["close"].clone(), bar["volume"].clone()), (1_000_000.into(), 1_020_000.into(), 3.0.into()), "{bar}");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn duplicates_and_out_of_order_are_counted_never_called_loss() {
    // Every sequence rejection of the old engine was a "gap". A repeated event and a provider sequence
    // going backwards are not lost data.
    let (wal_dir, out_dir) = (temp_dir("wal-order"), temp_dir("out-order"));
    let total = |mut e: MarketEvent, cumulative: f64| {
        if let Payload::Trade { total_volume, .. } = &mut e.payload {
            *total_volume = cumulative;
        }
        e
    };
    let mut repeat = total(trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 5, 1_000_000), 1.0);
    repeat.event_id = "e5".into();
    let again = repeat.clone();
    let behind = total(trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 3, 1_020_000), 2.0);
    write_wal(&wal_dir, 1 << 20, vec![repeat, again, behind]);
    let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    assert_eq!(result["completeness"], "complete", "{result}");
    let manifest = read(PathBuf::from(result["manifest_path"].as_str().unwrap()));
    assert_eq!((manifest["duplicate_count"].clone(), manifest["out_of_order_count"].clone(), manifest["event_count"].clone()),
               (1.into(), 1.into(), 2.into()), "{manifest}");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn loss_evidence_downgrades_a_claimed_complete_session() {
    // The producer said it dropped events before this one: real loss, whatever the orchestrator claims.
    let (wal_dir, out_dir) = (temp_dir("wal-loss"), temp_dir("out-loss"));
    let mut dropped = trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 2, 1_000_000);
    dropped.flags.gap_before = 4;
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000), dropped]);
    let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    assert_eq!(result["completeness"], "gap_detected", "{result}");
    assert!(result["loss_evidence"].to_string().contains("producer dropped 4"), "{result}");
    let manifest = read(PathBuf::from(result["manifest_path"].as_str().unwrap()));
    assert_eq!(manifest["rust_detected_gap"], true);
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn a_simtrade_print_never_sets_the_session_price() {
    // The v1 engine let a 試撮 print set summary.current; B's fold never does.
    let (wal_dir, out_dir) = (temp_dir("wal-sim"), temp_dir("out-sim"));
    let mut sim = trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 2, 9_990_000);
    if let Payload::Trade { simtrade, .. } = &mut sim.payload {
        *simtrade = true;
    }
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000), sim]);
    let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    let state = read(partition(&out_dir, "STK", "2026-09-23", "DAY", "2330").join("state.json"));
    assert_eq!(state["state"]["summary"]["current"], 1_000_000, "{result} {state}");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn is_idempotent_across_repeated_runs() {
    let (wal_dir, out_dir) = (temp_dir("wal-idem"), temp_dir("out-idem"));
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000)]);
    let mut hashes = Vec::new();
    for _ in 0..2 {
        let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
        assert_eq!(result["event_count"], 1);
        hashes.push(read(PathBuf::from(result["manifest_path"].as_str().unwrap()))["content_hash_fnv1a64"].clone());
    }
    assert_eq!(hashes[0], hashes[1]);
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn a_code_with_a_connection_outage_is_never_complete_and_the_others_stay_complete() {
    // The session evidence holds a broker-connection outage during trading for 2330 only: its partition is a gap,
    // 2317 (another connection) is complete, and so is the session's claim.
    let (wal_dir, out_dir) = (temp_dir("wal-outage"), temp_dir("out-outage"));
    write_wal(&wal_dir, 1 << 20, vec![
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000),
        trade_event("shioaji:STK:2317", "DAY", "2026-09-23", 1, 2_000_000),
    ]);
    let result = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji",
                       "--market", "STK", "--code", "*", "--trading-date", "2026-09-23", "--session", "DAY",
                       "--completeness", "complete", "--gap-codes", "2330"]);
    assert_eq!(result["completeness"], "gap_detected", "{result}");
    let manifest = |code: &str| read(partition(&out_dir, "STK", "2026-09-23", "DAY", code).join("manifest.json"));
    assert_eq!(manifest("2330")["completeness"], "gap_detected");
    assert!(manifest("2330")["loss_evidence"].to_string().contains("broker connection outage"), "{}", manifest("2330"));
    assert_eq!(manifest("2317")["completeness"], "complete");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn the_close_writes_each_codes_k_bars_and_ages_the_whole_store() {
    let (wal_dir, out_dir, kbar_dir) = (temp_dir("wal-kbar"), temp_dir("out-kbar"), temp_dir("kbars"));
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000)]);
    // A product this session does not hold still ages: its intraday bars are long past every tier.
    let other = kbar_dir.join("source=shioaji").join("market=STK").join("9999.json");
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    fs::write(&other, json!({"schema": "kbar-code-v1", "source": "shioaji", "market": "STK", "code": "9999", "sessions": {"DAY": {
        "daily": {"2020-01-02": [1.0, 1.0, 1.0, 1.0, 1.0]}, "intraday": {"2020-01-02": {"timeframe": 1, "bars": [[540, 1.0, 1.0, 1.0, 1.0, 1.0]]}}}}}).to_string()).unwrap();
    let result = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji", "--market", "STK",
                       "--code", "*", "--trading-date", "2026-09-23", "--session", "DAY", "--completeness", "complete", "--kbar-dir", kbar_dir.to_str().unwrap()]);
    assert_eq!(result["kbar_files"], 1, "{result}");
    assert_eq!((result["kbar_aging"]["ok"].clone(), result["kbar_aging"]["files_folded"].clone()), (json!(true), json!(1)), "{result}");
    let written = read(other.with_file_name("2330.json"));
    assert_eq!(written["sessions"]["DAY"]["daily"]["2026-09-23"][3], 100.0, "{written}");
    let aged = read(other);
    assert_eq!(aged["sessions"]["DAY"]["intraday"], json!({}), "{aged}");
    assert_eq!(aged["sessions"]["DAY"]["daily"]["2020-01-02"][0], 1.0, "the daily bar is kept forever");
    for dir in [wal_dir, out_dir, kbar_dir] {
        let _ = fs::remove_dir_all(dir);
    }
}

#[test]
fn wildcard_code_materializes_every_symbol_in_the_session() {
    // Shioaji seals the WHOLE STK session as one unit (logical_code "*"); Futu seals per code.
    let (wal_dir, out_dir) = (temp_dir("wal-wildcard"), temp_dir("out-wildcard"));
    write_wal(&wal_dir, 1 << 20, vec![
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000),
        trade_event("shioaji:STK:2317", "DAY", "2026-09-23", 1, 2_000_000),
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 2, 1_010_000),
        // Another market is not swept in.
        trade_event("shioaji:FUT:TXFR1", "DAY", "2026-09-23", 1, 99_999),
    ]);
    let result = run_job(&wal_dir, &out_dir, "STK", "*", "2026-09-23", "DAY");
    assert_eq!((result["mode"].clone(), result["codes_materialized"].clone(), result["total_event_count"].clone()),
               ("wildcard".into(), 2.into(), 3.into()), "{result}");
    assert_eq!(result["completeness"], "complete");
    let events = fs::read_to_string(partition(&out_dir, "STK", "2026-09-23", "DAY", "2330").join("events.jsonl")).unwrap();
    assert_eq!(events.lines().count(), 2);
    // The date's totals: what its committed partitions hold, for a reader that does not list them.
    let date_dir = partition(&out_dir, "STK", "2026-09-23", "DAY", "2330").parent().unwrap().parent().unwrap().to_path_buf();
    let totals: Value = serde_json::from_str(&fs::read_to_string(date_dir.join("totals.json")).unwrap()).unwrap();
    let partitions = totals["partitions"].as_array().unwrap();
    let sum = |list: &Vec<Value>, key: &str| list.iter().map(|p| p[key].as_u64().unwrap()).sum::<u64>();
    assert_eq!((partitions.len(), sum(partitions, "events")), (2, 3), "{totals}");
    let lane = |code: &str| partitions.iter().find(|p| p["code"] == code).unwrap()["lanes"]["trade"].clone();
    assert_eq!((lane("2330"), lane("2317")), (json!(2), json!(1)), "each partition's lanes, as its manifest reports them");
    let on_disk: u64 = ["2330", "2317"].iter().flat_map(|code| fs::read_dir(partition(&out_dir, "STK", "2026-09-23", "DAY", code)).unwrap())
        .map(|f| f.unwrap().metadata().unwrap().len()).sum();
    assert_eq!(sum(partitions, "bytes"), on_disk);
    // Run again: the rewritten partitions count once.
    run_job(&wal_dir, &out_dir, "STK", "*", "2026-09-23", "DAY");
    let again: Value = serde_json::from_str(&fs::read_to_string(date_dir.join("totals.json")).unwrap()).unwrap();
    assert_eq!(sum(again["partitions"].as_array().unwrap(), "events"), 3);
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn the_job_reports_its_phases_on_stderr_and_only_its_result_on_stdout() {
    // Health shows these lines as the 收盤整理 progress: scan -> read (every WAL record) -> write (every event of the
    // session's codes, so its rate is events a second like read's).
    let (wal_dir, out_dir) = (temp_dir("wal-progress"), temp_dir("out-progress"));
    write_wal(&wal_dir, 1 << 20, vec![
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000),
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 2, 1_000_001),
        trade_event("shioaji:STK:2317", "DAY", "2026-09-23", 1, 2_000_000),
        trade_event("shioaji:FUT:TXFR1", "DAY", "2026-09-23", 1, 99_999),
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_analysis_runtime")).arg("--materialize").args([
        "--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji", "--market", "STK",
        "--code", "*", "--trading-date", "2026-09-23", "--session", "DAY", "--completeness", "complete"]).output().unwrap();
    let result: Value = serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).expect("one JSON line");
    assert_eq!(result["status"], "materialized", "{result}");
    let lines: Vec<Value> = String::from_utf8_lossy(&output.stderr).lines().filter(|l| l.starts_with("{\"progress\""))
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["progress"].clone()).collect();
    let phases: Vec<&str> = lines.iter().map(|l| l["phase"].as_str().unwrap()).collect();
    let mut order = phases.clone();
    order.dedup();
    assert_eq!(order, ["scan", "read", "write"], "{phases:?}");
    let last = |phase: &str| lines.iter().rfind(|l| l["phase"] == phase).unwrap().clone();
    assert_eq!((last("read")["done"].clone(), last("read")["total"].clone()), (4.into(), 4.into()));
    assert_eq!((last("write")["done"].clone(), last("write")["total"].clone()), (3.into(), 3.into()));
    assert!(lines.iter().all(|l| l["date"] == "2026-09-23"));
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn zero_matching_input_is_never_a_success_and_promotes_nothing() {
    let (wal_dir, out_dir) = (temp_dir("wal-nomatch"), temp_dir("out-nomatch"));
    // A 09:00 print of the 09-23 DAY session, and a record of the older calendar-day FULL layout: that one is refused
    // (counted in the job's WAL integrity), never re-keyed into a session.
    let at_nine = |mut print: MarketEvent| {
        print.exchange_ts_ns = ts("2026-09-23", 540, 0);
        if let Payload::Trade { minute, .. } = &mut print.payload {
            *minute = 540;
        }
        print
    };
    let print = at_nine(trade_event("shioaji:FUT:TXFR1", "DAY", "2026-09-23", 1, 1_000_000));
    let older = at_nine(trade_event("shioaji:FUT:TXFR1", "FULL", "2026-09-23", 2, 1_000_000));
    write_wal(&wal_dir, 1 << 20, vec![print, older]);
    for (code, session) in [("*", "NIGHT"), ("TXFR1", "NIGHT"), ("*", "FULL")] {
        let result = run_job(&wal_dir, &out_dir, "FUT", code, "2026-09-23", session);
        assert_eq!((result["ok"].clone(), result["status"].clone()), (false.into(), "no_matching_input".into()), "{code} {session}: {result}");
    }
    assert!(!out_dir.join("source=shioaji").exists(), "nothing may be promoted for zero matching input");
    let good = run_job(&wal_dir, &out_dir, "FUT", "*", "2026-09-23", "DAY");
    assert_eq!((good["ok"].clone(), good["total_event_count"].clone()), (true.into(), 1.into()), "{good}");
    assert_eq!(good["wal_integrity"]["old_format_refused"], 1, "{good}");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn invalid_identity_is_rejected_terminally_before_touching_the_wal() {
    let (wal_dir, out_dir) = (temp_dir("wal-invalid"), temp_dir("out-invalid"));
    assert_eq!(run_job(&wal_dir, &out_dir, "STK", "*", "2026/09/23", "DAY")["status"], "invalid_identity");
    assert_eq!(run_job(&wal_dir, &out_dir, "STK", "*", "2026-02-30", "DAY")["status"], "invalid_identity", "no such day");
    let bad_market = run_job(&wal_dir, &out_dir, "MOON", "*", "2026-09-23", "DAY");
    assert_eq!((bad_market["status"].clone(), bad_market["ok"].clone()), ("invalid_identity".into(), false.into()));
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn a_code_that_is_not_a_path_component_cannot_leave_the_out_dir() {
    let (wal_dir, out_dir) = (temp_dir("wal-traversal"), temp_dir("out-traversal"));
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000)]);
    let outside = out_dir.parent().unwrap().join(format!("escaped-{}", now_ns()));
    for code in ["../escaped", "..", "a/b", "a\\b", outside.to_str().unwrap(), "C:\\Windows", ""] {
        let result = run_job(&wal_dir, &out_dir, "STK", code, "2026-09-23", "DAY");
        assert_eq!((result["status"].clone(), result["ok"].clone()), ("invalid_identity".into(), false.into()), "code {code:?}: {result}");
    }
    let result = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji",
        "--market", "STK", "--code", "2330", "--logical-code", "../../escaped", "--trading-date", "2026-09-23", "--session", "DAY",
        "--completeness", "complete"]);
    assert_eq!(result["status"], "invalid_identity", "{result}");
    assert!(!outside.exists());
    assert!(!out_dir.join("source=shioaji").exists(), "nothing may be written for a refused code");
    assert_eq!(run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY")["ok"], true);
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn manifest_carries_artifact_metadata_and_a_content_hash_that_changes_with_content() {
    let out_dir = temp_dir("out-meta");
    let mut hashes = Vec::new();
    for prices in [vec![1_000_000i64, 1_010_000], vec![1_000_000, 9_990_000]] {
        let wal_dir = temp_dir("wal-meta");
        write_wal(&wal_dir, 1 << 20, prices.iter().enumerate()
            .map(|(i, p)| trade_event("shioaji:STK:2330", "DAY", "2026-09-23", i as u64 + 1, *p)).collect());
        let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
        let manifest = read(PathBuf::from(result["manifest_path"].as_str().unwrap()));
        assert_eq!((manifest["event_count"].clone(), manifest["source"].clone(), manifest["market"].clone(), manifest["session"].clone()),
                   (2.into(), "shioaji".into(), "STK".into(), "DAY".into()));
        assert_eq!(manifest["outcome"], "succeeded_with_data");
        assert!(manifest["first_exchange_ts_ns"].is_number() && manifest["last_exchange_ts_ns"].is_number());
        hashes.push(manifest["content_hash_fnv1a64"].as_str().unwrap().to_owned());
        let _ = fs::remove_dir_all(&wal_dir);
    }
    assert_ne!(hashes[0], hashes[1], "different content must yield a different content hash");
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn a_damaged_wal_is_never_materialized_as_complete() {
    // A session read across WAL damage is never complete.
    let (wal_dir, out_dir) = (temp_dir("wal-damaged"), temp_dir("out-damaged"));
    write_wal(&wal_dir, 2048, (1..=40u64).map(|s| trade_event("shioaji:STK:2330", "DAY", "2026-09-23", s, 1_000_000 + s as i64 * 500)).collect());
    let mut ids: Vec<_> = fs::read_dir(&wal_dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "bin")).collect();
    ids.sort();
    assert!(ids.len() >= 3, "several segments: {ids:?}");
    let mut bytes = fs::read(&ids[1]).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xff;
    fs::write(&ids[1], bytes).unwrap();
    let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    assert_eq!((result["ok"].clone(), result["completeness"].clone()), (true.into(), "gap_detected".into()), "{result}");
    assert_eq!(result["wal_integrity"]["status"], "CORRUPT");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn a_missing_wal_segment_between_readable_ones_is_never_complete() {
    // The WAL scan recorded the durable-sequence gap, but only corruption counted as loss -- a whole segment
    // gone between two readable ones was materialized as complete.
    let (wal_dir, out_dir) = (temp_dir("wal-missing-segment"), temp_dir("out-missing-segment"));
    write_wal(&wal_dir, 2048, (1..=40u64).map(|s| trade_event("shioaji:STK:2330", "DAY", "2026-09-23", s, 1_000_000 + s as i64 * 500)).collect());
    let mut ids: Vec<_> = fs::read_dir(&wal_dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "bin")).collect();
    ids.sort();
    assert!(ids.len() >= 3, "several segments: {ids:?}");
    fs::remove_file(&ids[1]).unwrap();
    let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    assert_eq!((result["ok"].clone(), result["completeness"].clone()), (true.into(), "gap_detected".into()), "{result}");
    assert!(!result["wal_integrity"]["sequence_gaps"].as_array().unwrap().is_empty(), "{result}");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

#[test]
fn a_gated_job_does_nothing_until_it_reads_start() {
    use std::io::Write;
    use std::process::Stdio;
    let (wal_dir, out_dir) = (temp_dir("wal-gate"), temp_dir("out-gate"));
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000)]);
    let args = ["--materialize", "--start-gate", "stdin", "--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(),
                "--source", "shioaji", "--market", "STK", "--code", "2330", "--trading-date", "2026-09-23", "--session", "DAY"];
    let gated = |input: Option<&str>| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_analysis_runtime")).args(args).stdin(Stdio::piped()).stdout(Stdio::piped())
            .spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        if let Some(text) = input {
            stdin.write_all(text.as_bytes()).unwrap();
        }
        drop(stdin);
        let output = child.wait_with_output().unwrap();
        serde_json::from_str::<Value>(String::from_utf8_lossy(&output.stdout).trim()).expect("one JSON line")
    };
    // Health died before its owner record: stdin closes, nothing is written.
    let refused = gated(None);
    assert_eq!(refused["status"], "retryable", "{refused}");
    assert!(refused["error"].as_str().unwrap().contains("not started"));
    assert!(!partition(&out_dir, "STK", "2026-09-23", "DAY", "2330").exists());
    // Told to start: the job runs.
    let started = gated(Some("start\n"));
    assert_eq!(started["status"], "materialized", "{started}");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

/// A store whose 3 newest STK dates before the cutoff are 10-01..10-03 (Shioaji keeps 3 trading dates by default),
/// and the cutoffs file A wrote at the rollover to 10-06.
fn store_past_retention(out_dir: &Path) -> PathBuf {
    for date in ["2026-10-01", "2026-10-02", "2026-10-03"] {
        let dir = partition(out_dir, "STK", date, "DAY", "2330");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), json!({"event_count": 1}).to_string()).unwrap();
    }
    let cutoffs = out_dir.with_extension("cutoffs.json");
    let rolled = [("shioaji|STK|DAY".to_string(), "2026-10-06".to_string())].into_iter().collect();
    market_runtime::historical_store::write_cutoffs(&cutoffs, &rolled).unwrap();
    cutoffs
}

/// D05-01: a job for a date the rollover already put past retention. Before, the job wrote its partition straight into
/// the store after A's prune (and A deleted it again on its next one-minute re-prune); now the store's manager drops
/// it at publish and the store never holds it.
#[test]
fn a_job_for_a_date_already_past_retention_never_writes_it_into_the_store() {
    let (wal_dir, out_dir) = (temp_dir("wal-expired"), temp_dir("out-expired"));
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2317", "DAY", "2026-09-30", 1, 1_000_000)]);
    let cutoffs = store_past_retention(&out_dir);
    let result = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji",
        "--market", "STK", "--code", "*", "--trading-date", "2026-09-30", "--session", "DAY", "--completeness", "complete",
        "--rollover-cutoffs", cutoffs.to_str().unwrap()]);
    assert_eq!((result["status"].clone(), result["codes_expired"].clone()), ("materialized".into(), 1.into()), "{result}");
    assert_eq!(result["codes"][0]["published"], false);
    assert!(!out_dir.join("source=shioaji/market=STK/trading_date=2026-09-30").exists(), "the store never holds the expired date");
    assert!(partition(&out_dir, "STK", "2026-10-01", "DAY", "2330").is_dir(), "the kept dates stay");
    assert_eq!(fs::read_dir(out_dir.join(".staging")).unwrap().count(), 0, "the job's staging goes with it");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

/// A prune holding the store lock (B's daemon at a rollover): the job's partition is not in the store until it is
/// released, and the job then publishes it whole.
#[test]
fn a_job_publishes_only_once_the_store_lock_is_free() {
    use std::process::Stdio;
    let (wal_dir, out_dir) = (temp_dir("wal-lock"), temp_dir("out-lock"));
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000)]);
    let store = market_runtime::historical_store::Store::new(market_runtime::historical_store::StoreConfig {
        root: out_dir.clone(), cutoffs: None, config_root: None, traded_codes_dir: None });
    let held = store.lock().unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_analysis_runtime")).args(["--materialize", "--data-dir", wal_dir.to_str().unwrap(),
        "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji", "--market", "STK", "--code", "2330", "--trading-date", "2026-09-23",
        "--session", "DAY", "--completeness", "complete"]).stdout(Stdio::piped()).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    let dir = partition(&out_dir, "STK", "2026-09-23", "DAY", "2330");
    assert!(!dir.exists(), "nothing reaches the store while the lock is held");
    drop(held);
    let output = child.wait_with_output().unwrap();
    let result: Value = serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).expect("one JSON line");
    assert_eq!((result["status"].clone(), result["published"].clone()), ("materialized".into(), true.into()), "{result}");
    assert!(dir.join("manifest.json").is_file());
    let totals = read(out_dir.join("source=shioaji/market=STK/trading_date=2026-09-23/totals.json"));
    assert_eq!(totals["partitions"].as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

fn summarize_history(store: &Path, summaries: &Path, date: &str) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_analysis_runtime")).args(["--summarize-history", "--historical-root", store.to_str().unwrap(),
        "--out-dir", summaries.to_str().unwrap(), "--source", "shioaji", "--date", date]).output().unwrap();
    serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).expect("one JSON line")
}

/// A whole STK session with two codes, materialized with its daily summary.
fn session_with_summary(name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let (wal_dir, out_dir, summaries) = (temp_dir(&format!("wal-{name}")), temp_dir(&format!("out-{name}")), temp_dir(&format!("summary-{name}")));
    write_wal(&wal_dir, 1 << 20, vec![
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000),
        trade_event("shioaji:STK:2317", "DAY", "2026-09-23", 1, 2_000_000),
    ]);
    let result = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji",
        "--market", "STK", "--code", "*", "--trading-date", "2026-09-23", "--session", "DAY", "--completeness", "complete",
        "--daily-summary-dir", summaries.to_str().unwrap()]);
    assert_eq!(result["status"], "materialized", "{result}");
    let path = summaries.join("source=shioaji").join("market=STK").join("trading_date=2026-09-23").join("session=DAY.json");
    assert_eq!(result["daily_summary"], json!(path.to_string_lossy()), "{result}");
    (wal_dir, out_dir, summaries, path)
}

fn codes(summary: &Value) -> Vec<String> {
    summary["codes"].as_object().unwrap().keys().cloned().collect()
}

/// D05-05: a rebuild reads the historical store, which past its retention keeps only the codes an account traded
/// (and mid-materialization holds only the codes published so far). Before, the rebuild wrote the session's summary
/// from whatever partitions it found, replacing the whole session's summary with one of a few codes.
#[test]
fn a_rebuild_never_replaces_a_session_summary_with_a_part_of_its_codes() {
    let (wal_dir, out_dir, summaries, path) = session_with_summary("rebuild-pruned");
    let before = fs::read(&path).unwrap();
    assert_eq!(codes(&serde_json::from_slice(&before).unwrap()), ["2317", "2330"]);
    // The store's retention removed the untraded code's partition.
    fs::remove_dir_all(partition(&out_dir, "STK", "2026-09-23", "DAY", "2317")).unwrap();
    let result = summarize_history(&out_dir, &summaries, "2026-09-23");
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(result["written"], json!([]), "{result}");
    assert!(result["problems"][0]["error"].as_str().unwrap().contains("2317"), "{result}");
    assert_eq!(fs::read(&path).unwrap(), before, "the session's summary is untouched");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
    let _ = fs::remove_dir_all(&summaries);
}

/// A session's summary is created only by its materialization: a rebuild of a session that has none (a date
/// materialized before summaries existed, whose store now holds only traded codes) writes nothing.
#[test]
fn a_rebuild_does_not_create_a_session_summary() {
    let (wal_dir, out_dir, summaries, path) = session_with_summary("rebuild-new");
    fs::remove_dir_all(&summaries).unwrap();
    let result = summarize_history(&out_dir, &summaries, "2026-09-23");
    assert_eq!((result["ok"].clone(), result["written"].clone()), (false.into(), json!([])), "{result}");
    assert!(!path.exists(), "no summary is created by a rebuild");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
    let _ = fs::remove_dir_all(&summaries);
}

/// What a rebuild is for: the same session's summary from the same partitions, in the build's format.
#[test]
fn a_rebuild_replaces_the_summary_from_every_one_of_its_partitions() {
    let (wal_dir, out_dir, summaries, path) = session_with_summary("rebuild-same");
    let materialized: Value = read(path.clone());
    let mut old = materialized.clone();
    old["schema"] = json!("daily-summary-v1");
    fs::write(&path, old.to_string()).unwrap();
    let result = summarize_history(&out_dir, &summaries, "2026-09-23");
    assert_eq!((result["ok"].clone(), result["written"].clone()), (true.into(), json!([path.to_string_lossy()])), "{result}");
    assert_eq!(read(path.clone()), materialized, "the rebuild gives what the materialization wrote");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
    let _ = fs::remove_dir_all(&summaries);
}

/// A rebuild is run when a format changed: a partition whose lines no longer decode gave an empty entry that kept the
/// manifest's completeness, under the same codes, and replaced the good summary.
#[test]
fn a_rebuild_with_a_damaged_partition_is_a_problem_and_publishes_nothing() {
    let (wal_dir, out_dir, summaries, path) = session_with_summary("rebuild-damaged");
    let before = fs::read(&path).unwrap();
    let dir = partition(&out_dir, "STK", "2026-09-23", "DAY", "2317");
    let text = fs::read_to_string(dir.join("events.jsonl")).unwrap();
    fs::write(dir.join("events.jsonl"), text.replace("\"payload\"", "\"payload_of_another_format\"")).unwrap();
    let result = summarize_history(&out_dir, &summaries, "2026-09-23");
    assert_eq!((result["ok"].clone(), result["written"].clone()), (false.into(), json!([])), "{result}");
    assert!(result["problems"][0]["partition"].as_str().unwrap().ends_with("2317"), "{result}");
    assert!(result["problems"][0]["error"].as_str().unwrap().contains("undecodable"), "{result}");
    assert_eq!(fs::read(&path).unwrap(), before, "the good summary stays");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
    let _ = fs::remove_dir_all(&summaries);
}

/// The exchange's book times go backwards: the session's closing book is the newest by exchange time, not the last
/// one to arrive.
#[test]
fn the_sessions_book_is_the_newest_by_exchange_time() {
    let (wal_dir, out_dir) = (temp_dir("wal-book"), temp_dir("out-book"));
    let book = |sequence: u64, second: i64, bid: i64| {
        let mut e = trade_event("shioaji:STK:2330", "DAY", "2026-09-23", sequence, 1_000_000);
        e.exchange_ts_ns = ts("2026-09-23", 600, second);
        e.payload = Payload::OrderBook { bids: vec![market_runtime::event::BookLevel { price: bid, volume: 1.0 }], asks: Vec::new(), simtrade: false };
        e
    };
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000),
                                      book(2, 20, 1_000_000), book(3, 10, 990_000)]);
    let result = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    assert_eq!(result["status"], "materialized", "{result}");
    let state = read(partition(&out_dir, "STK", "2026-09-23", "DAY", "2330").join("state.json"));
    assert_eq!(state["state"]["bids"], json!([{"price": 1_000_000, "volume": 1.0}]), "{state}");
    let _ = fs::remove_dir_all(&wal_dir);
    let _ = fs::remove_dir_all(&out_dir);
}

fn gap_report(out: &Path, market: &str, date: &str, expected: &str) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_analysis_runtime"))
        .args(["--gap-report", "--historical-root", out.to_str().unwrap(), "--market", market, "--trading-date", date, "--session", "DAY",
               "--expected-codes", expected]).output().unwrap();
    serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).expect("one JSON line")
}

/// One fill's price-only minute bar of an index, as service/market/history/history_fill.py writes it.
fn index_bar(code: &str, date: &str, number: u64, minute: i64) -> String {
    json!({"schema_version": 2, "event_id": format!("history_fill:IDX:{code}:{date}:DAY:{number}"), "durable_sequence": 0,
        "symbol": format!("shioaji:IDX:{code}"), "provider": "shioaji", "market": "IDX", "code": code, "session": "DAY",
        "trading_date": date, "generation": 0, "sequence": number, "exchange_ts_ns": ts(date, minute, 30), "time_quality": "exchange",
        "flags": {"backfill": true, "backfill_cutoff_ns": ts(date, 814, 0), "partial": true},
        "payload": {"kind": "minute_bar", "minute": minute, "open": 230_000_000, "high": 231_000_000, "low": 229_000_000,
                    "close": 230_500_000, "volume": 0.0, "amount": 0.0, "average": 0}}).to_string()
}

/// decisions.md 指數整天沒有分區的日子: an index the session should hold and the store has no partition of gets the
/// whole session as its window, and a `--code *` refold from the store builds its partition from the fill alone,
/// `repaired`. A fill that brought nothing builds none.
#[test]
fn an_index_missing_all_day_gets_the_whole_session_and_its_fill_becomes_a_repaired_partition() {
    let out_dir = temp_dir("idx-whole-day");
    let date = "2026-10-20";
    let report = gap_report(&out_dir, "IDX", date, "taiex,IX0028");
    assert_eq!(report["ok"], json!(true), "a session with no partition is no error: {report}");
    let codes = report["codes"].as_array().unwrap();
    assert_eq!(codes.iter().map(|c| c["code"].as_str().unwrap()).collect::<Vec<_>>(), ["IX0028", "TAIEX"], "{report}");
    for code in codes {
        assert_eq!((code["partition"].clone(), code["completeness"].clone()), (json!(false), Value::Null), "{code}");
        let reference = &code["windows"][0];
        assert_eq!((reference["reference"].as_str(), reference["reference_date"].as_str()), (Some("prev_close"), Some("2026-10-19")),
                   "an index's 昨收 is the previous trading day's close: {reference}");
        assert_eq!((reference["after_ns"].as_i64(), reference["end_ns"].as_i64(), reference["reference_at_ns"].as_i64()),
                   (Some(ts("2026-10-19", 810, 0)), Some(ts("2026-10-19", 814, 0)), Some(ts(date, 540, 0))), "{reference}");
        let window = &code["windows"][1];
        assert_eq!((window["after_ns"].as_i64(), window["end_ns"].as_i64(), window["end_is_live"].as_bool()),
                   (Some(0), Some(ts(date, 814, 0)), Some(false)), "from the open through 13:33's closing print: {window}");
    }

    // The date's stocks: the timeline the filled index is placed on (only durable_sequence and exchange_ts_ns are read).
    let stock = partition(&out_dir, "STK", date, "DAY", "2330");
    fs::create_dir_all(&stock).unwrap();
    let stamp = |seq: u64, minute: i64| json!({"durable_sequence": seq, "exchange_ts_ns": ts(date, minute, 0)}).to_string();
    // A stock print filled after the day (its sequence after the partition's own) says nothing about when 09:00 was.
    let filled = json!({"durable_sequence": 900, "exchange_ts_ns": ts(date, 539, 30), "flags": {"backfill": true}}).to_string();
    fs::write(stock.join("events.jsonl"), [stamp(100, 539), stamp(300, 600), stamp(200, 542), filled].join("\n") + "\n").unwrap();

    let fills = out_dir.join("fills");
    fs::create_dir_all(&fills).unwrap();
    let bars: Vec<String> = (540..=545).enumerate().map(|(n, m)| index_bar("TAIEX", date, n as u64 + 1, m)).collect();
    fs::write(fills.join("TAIEX.jsonl"), bars.join("\n") + "\n").unwrap();
    fs::write(fills.join("IX0028.jsonl"), "").unwrap();
    let result = job(&["--input", "store", "--fills-dir", fills.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji",
                       "--market", "IDX", "--code", "*", "--trading-date", date, "--session", "DAY", "--unresolved-codes", "IX0028"]);
    assert_eq!(result["ok"], json!(true), "{result}");
    let built: Vec<_> = result["codes"].as_array().unwrap().iter().map(|c| (c["code"].clone(), c["completeness"].clone())).collect();
    assert_eq!(built, [(json!("TAIEX"), json!("repaired"))], "{result}");
    let manifest = read(partition(&out_dir, "IDX", date, "DAY", "TAIEX").join("manifest.json"));
    assert_eq!((manifest["completeness"].clone(), manifest["event_count"].clone()), (json!("repaired"), json!(6)), "{manifest}");
    assert!(!partition(&out_dir, "IDX", date, "DAY", "IX0028").exists(), "an empty fill builds no partition");
    let sequences: Vec<u64> = fs::read_to_string(partition(&out_dir, "IDX", date, "DAY", "TAIEX").join("events.jsonl")).unwrap().lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["durable_sequence"].as_u64().unwrap()).collect();
    assert_eq!(sequences, [100, 100, 200, 200, 200, 200],
               "each bar takes the date's durable sequence at its time, so a fold of the whole date meets it then, not before the open");

    let again = gap_report(&out_dir, "IDX", date, "TAIEX,IX0028");
    let taiex = again["codes"].as_array().unwrap().iter().find(|c| c["code"] == "TAIEX").unwrap().clone();
    assert_eq!(taiex["partition"], json!(true), "the new partition is held now: {again}");
    let _ = fs::remove_dir_all(&out_dir);
}

/// A whole STK session: the result counts the market events apart from Market Runtime's own coverage records (its
/// session evidence counts only the former as accepted), and publishes the session's 量變 baseline from the same fold.
#[test]
fn a_whole_stock_session_counts_its_market_events_and_publishes_its_volume_baseline() {
    let (wal_dir, out_dir, baselines) = (temp_dir("wal-baseline"), temp_dir("out-baseline"), temp_dir("baseline-root"));
    let mut coverage = trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 9, 0);
    coverage.time_quality = "coverage_control".into();
    coverage.payload = Payload::SourceStatus { state: "subscribed".into(), detail: String::new() };
    coverage.exchange_ts_ns = ts("2026-09-23", 500, 0);
    write_wal(&wal_dir, 1 << 20, vec![
        coverage,
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000),
        trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 2, 1_010_000),
        trade_event("shioaji:STK:2317", "DAY", "2026-09-23", 1, 2_000_000),
    ]);
    let result = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji",
        "--market", "STK", "--code", "*", "--trading-date", "2026-09-23", "--session", "DAY", "--completeness", "complete",
        "--volume-baseline-root", baselines.to_str().unwrap()]);
    assert_eq!(result["status"], "materialized", "{result}");
    assert_eq!((result["total_event_count"].clone(), result["market_event_count"].clone(), result["control_event_count"].clone(),
                result["backfill_event_count"].clone()), (4.into(), 3.into(), 1.into(), 0.into()), "{result}");
    assert_eq!((result["volume_baseline"]["published"].clone(), result["volume_baseline"]["codes"].clone()), (true.into(), 2.into()), "{result}");
    let dir = baselines.join("shioaji").join("volume_baseline");
    let manifest = read(dir.join("2026-09-23.manifest.json"));
    let twin = read(dir.join(manifest["json"].as_str().unwrap()));
    // 10:00 is minute 600 of the fold: the clock minute the live 量變 compares.
    assert_eq!(twin["items"], json!({"2317": {"10:00": 1}, "2330": {"10:00": 2}}), "{twin}");
    // Other markets have no baseline.
    let idx = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji",
        "--market", "IDX", "--code", "*", "--trading-date", "2026-09-23", "--session", "DAY", "--completeness", "complete",
        "--volume-baseline-root", baselines.to_str().unwrap()]);
    assert!(idx["volume_baseline"].is_null(), "{idx}");
    for d in [wal_dir, out_dir, baselines] {
        let _ = fs::remove_dir_all(d);
    }
}

#[test]
fn void_events_are_left_out_from_the_wal_and_from_the_store_and_a_bad_list_refuses_the_job() {
    let (wal_dir, out_dir, lists) = (temp_dir("wal-void"), temp_dir("out-void"), temp_dir("lists-void"));
    // The mistaken print carries another day's cumulative volume (the 11-06 case: 11-05's night prints written into
    // 11-06's): it is in no chain of this session's, so leaving it out leaves no hole.
    let mut mistaken = trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 2, 2_000_000);
    if let Payload::Trade { total_volume, .. } = &mut mistaken.payload {
        *total_volume = 500.0;
    }
    let mut third = trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 3, 1_020_000);
    if let Payload::Trade { total_volume, .. } = &mut third.payload {
        *total_volume = 2.0;
    }
    write_wal(&wal_dir, 1 << 20, vec![trade_event("shioaji:STK:2330", "DAY", "2026-09-23", 1, 1_000_000), mistaken, third]);
    let list = lists.join("voided_events.json");
    fs::write(&list, json!([{"source": "shioaji", "market": "STK", "trading_date": "2026-09-23", "session": "DAY",
        "durable": "2-2", "reason": "test print written by mistake"}]).to_string()).unwrap();
    let dir = partition(&out_dir, "STK", "2026-09-23", "DAY", "2330");
    let high = || read(dir.join("state.json"))["state"]["summary"]["high"].clone();
    // Without the list the mistaken print is history (the control).
    let plain = run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    assert_eq!((plain["event_count"].clone(), high()), (json!(3), json!(2_000_000)), "{plain}");
    let from_wal = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji", "--market", "STK",
        "--code", "2330", "--trading-date", "2026-09-23", "--session", "DAY", "--completeness", "complete", "--voided-events", list.to_str().unwrap()]);
    assert_eq!((from_wal["event_count"].clone(), high()), (json!(2), json!(1_020_000)), "{from_wal}");
    assert_eq!(from_wal["completeness"], "complete", "a removal the user decided is not a loss: {from_wal}");
    // Folded again from the store's copy that still held it (written before the list): left out there too.
    run_job(&wal_dir, &out_dir, "STK", "2330", "2026-09-23", "DAY");
    let from_store = job(&["--input", "store", "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji", "--market", "STK",
        "--code", "2330", "--trading-date", "2026-09-23", "--session", "DAY", "--completeness", "complete", "--voided-events", list.to_str().unwrap()]);
    assert_eq!(from_store["ok"], json!(true), "{from_store}");
    assert_eq!((read(dir.join("manifest.json"))["event_count"].clone(), high()), (json!(2), json!(1_020_000)), "{from_store}");
    fs::write(&list, "{not a list").unwrap();
    let refused = job(&["--data-dir", wal_dir.to_str().unwrap(), "--out-dir", out_dir.to_str().unwrap(), "--source", "shioaji", "--market", "STK",
        "--code", "2330", "--trading-date", "2026-09-23", "--session", "DAY", "--voided-events", list.to_str().unwrap()]);
    assert_eq!(refused["status"], "invalid_request", "{refused}");
    for d in [wal_dir, out_dir, lists] {
        let _ = fs::remove_dir_all(d);
    }
}
