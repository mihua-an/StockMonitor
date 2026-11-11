//! Void events (crate::voided): what the user decided to remove is left out of Market Runtime's state, its session
//! view and its trade tape, and a checkpoint folded under another list is rebuilt from the WAL.

mod support;

use support::*;

fn view(daemon: &Daemon) -> Value {
    let mut v = daemon.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY"}}));
    v.await_type("view.snapshot")["payload"].clone()
}

fn tape(daemon: &Daemon) -> Value {
    let mut v = daemon.client(VIEWER);
    v.send(json!({"type": "trades.page", "request_id": "p", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29",
        "session": "DAY", "page": 1, "page_size": 100}}));
    v.await_type("trades.page")["payload"].clone()
}

fn recovery(daemon: &Daemon) -> Value {
    let mut c = daemon.client(CONTROLLER);
    c.send(json!({"type": "metrics"}));
    c.await_type("metrics")["payload"]["recovery"].clone()
}

fn tape_sequences(answer: &Value) -> Vec<u64> {
    let mut out: Vec<u64> = answer["rows"].as_array().unwrap().iter().map(|r| r["durable_sequence"].as_u64().unwrap()).collect();
    out.sort();
    out
}

#[test]
fn a_void_print_leaves_the_state_and_the_tape_at_the_next_start_and_comes_back_when_the_list_drops_it() {
    let root = temp_dir("voided");
    let list = root.join("voided_events.json");
    let list_arg = list.to_string_lossy().into_owned();
    let args = ["--voided-events", list_arg.as_str(), "--checkpoint-interval-s", "3600"];
    let d = Daemon::start_in(root.clone(), root.join("data"), &args);
    let mut p = d.client(SHIOAJI);
    let mut sequences = Vec::new();
    for s in 1..=10u64 {
        // The 5th print is the mistake: a price far from the others.
        let price = if s == 5 { 2_000_000 } else { 1_000_000 + s as i64 * 100 };
        sequences.push(ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", s, price))["durable_sequence"].as_u64().unwrap());
    }
    await_synced(&mut p, *sequences.iter().max().unwrap());
    drop(p);
    let spike = sequences[4];
    let before = view(&d);
    assert_eq!(before["summary"]["high"], 200.0, "the mistaken print is in the state while nothing is void: {}", before["summary"]);
    assert_eq!(tape(&d)["total_rows"], 10);
    let (root, data) = d.shutdown();

    // The user decides the print is void: the clean checkpoint was folded with it, so it is set aside and the WAL replayed.
    std::fs::write(&list, json!([{"source": "shioaji", "market": "STK", "trading_date": "2026-09-29", "session": "DAY",
        "durable": format!("{spike}-{spike}"), "reason": "test print written by mistake"}]).to_string()).unwrap();
    let d = Daemon::start_in(root, data, &args);
    let r = recovery(&d);
    assert_eq!(r["checkpoint"], "voided_changed", "{r}");
    assert_eq!(r["checkpoint_problems"], json!([]), "a changed list is planned, not a failed checkpoint: {r}");
    assert_eq!((r["voided"]["replay_skipped"].as_u64(), r["voided"]["tape_skipped"].as_u64()), (Some(1), Some(1)), "{r}");
    let after = view(&d);
    assert_eq!(after["summary"]["high"], 100.1, "{}", after["summary"]);
    assert!(after["trades"].as_array().unwrap().iter().all(|t| t["price"] != 200.0), "{}", after["trades"]);
    let answer = tape(&d);
    assert_eq!(tape_sequences(&answer), sequences.iter().copied().filter(|s| *s != spike).collect::<Vec<_>>(), "{answer}");
    let (root, data) = d.shutdown();

    // The same list again: the checkpoint written under it is resumed as-is.
    let d = Daemon::start_in(root, data, &args);
    let r = recovery(&d);
    assert_eq!((r["checkpoint"].as_str(), r["replayed_events"].as_u64()), (Some("current"), Some(0)), "{r}");
    assert_eq!(view(&d)["summary"]["high"], 100.1);
    let (root, data) = d.shutdown();

    // Dropped from the list (an empty list): the print counts again.
    std::fs::write(&list, "[]").unwrap();
    let d = Daemon::start_in(root, data, &args);
    assert_eq!(recovery(&d)["checkpoint"], "voided_changed");
    assert_eq!(view(&d)["summary"]["high"], 200.0);
    assert_eq!(tape(&d)["total_rows"], 10);
    let (root, data) = d.shutdown();

    // A list that does not validate stops the start instead of showing what the user removed.
    std::fs::write(&list, r#"[{"durable": "x"}]"#).unwrap();
    let mut daemon = Daemon::spawn(root, data, &args);
    let status = daemon.child.wait().unwrap();
    assert!(!status.success(), "a bad list refuses the start");
    assert!(daemon.output.finish().contains("void events:"));
}
