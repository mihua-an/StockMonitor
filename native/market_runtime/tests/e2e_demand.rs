//! The subscription plan: the background list, provider capacity, what is stored and what is only shown.
//! (docs/system-architecture/08 section 1, the Rust A rows.)

mod support;

use support::*;

#[test]
fn background_list_drives_the_provider_plan_and_status_shows_desired_planned_and_actual() {
    let d = Daemon::start("demand", &[]);
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "background.replace", "payload": {"revision": 3, "items": [
        {"source": "shioaji", "market": "STK", "code": "2330"}, {"source": "shioaji", "market": "STK", "code": "2317"}]}}));
    assert_eq!(c.await_type("background.replace.ack")["payload"]["applied_revision"], 3);
    // A list that does not parse (or has no items) replaces nothing: it is refused, never read as an empty list.
    for payload in [json!({"revision": 4, "items": [{"source": "shioaji", "market": 5}]}), json!({"revision": 4}),
                    json!({"revision": "four", "items": []})] {
        c.send(json!({"type": "background.replace", "payload": payload}));
        let ack = c.await_type("background.replace.ack");
        assert_eq!(ack["payload"]["ok"], false, "{ack}");
        assert_eq!(ack["payload"]["applied_revision"], 3, "{ack}");
    }
    let mut p = d.client(SHIOAJI);
    // A malformed command payload is refused with the reason, never ACKed as an empty batch or a default registration.
    for bad in [json!({"type": "event.ingest.batch", "payload": {"events": {"not": "a list"}}}),
                json!({"type": "event.ingest.batch", "payload": [1, 2]}),
                json!({"type": "adapter.register", "payload": {"source": "shioaji", "kinds": ["quote"]}})] {
        p.send(bad.clone());
        let error = p.await_type("error");
        assert_eq!(error["error"], "INVALID_PAYLOAD", "{bad} -> {error}");
    }
    p.send(json!({"type": "adapter.register", "payload": {"source": "shioaji", "max_subscriptions": 50, "kinds": ["quote", "trade", "orderbook"]}}));
    p.await_type("adapter.registered");
    let plan = p.await_type("adapter.subscription.replace")["payload"].clone();
    let mut codes: Vec<String> = plan["codes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    codes.sort();
    assert_eq!(codes, vec!["2317", "2330"]);
    // A viewer opening and closing another product never removes a background one.
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "3481", "session": "DAY"}}));
    let sub = v.await_type("view.snapshot")["payload"]["subscription_id"].as_str().unwrap().to_string();
    assert!(p.await_type("adapter.subscription.replace")["payload"]["codes"].as_array().unwrap().iter().any(|c| c == "3481"));
    v.send(json!({"type": "view.unsubscribe", "payload": {"subscription_id": sub}}));
    let after = p.await_type("adapter.subscription.replace")["payload"].clone();
    assert_eq!(after["codes"].as_array().unwrap().len(), 2);
    p.send(json!({"type": "adapter.subscription.status", "payload": {"generation": after["generation"],
        "subscribed": [{"market": "STK", "code": "2330"}], "failed": [{"market": "STK", "code": "2317", "reason": "NO_CONTRACT"}]}}));
    p.await_type("adapter.subscription.status.ack");
    c.send(json!({"type": "demand.status"}));
    let status = c.await_type("demand.status")["payload"].clone();
    let state = |code: &str| status["instruments"].as_array().unwrap().iter().find(|r| r["code"] == code).unwrap()["state"].clone();
    assert_eq!(state("2330"), "SUBSCRIBED");
    assert_eq!(state("2317"), "FAILED:NO_CONTRACT");

    // What the broker confirmed becomes a durable coverage CONTROL record written by Market Runtime,
    // dated to a real business session by its calendar -- and a provider cannot write coverage itself.
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    let msgs = b.until(|seen| seen.iter().any(|m| m["type"] == "durable.batch"));
    let records: Vec<Value> = msgs.iter().filter(|m| m["type"] == "durable.batch")
        .flat_map(|m| m["payload"]["events"].as_array().cloned().unwrap_or_default())
        .filter(|e| e["time_quality"] == "coverage_control").collect();
    assert_eq!(records.len(), 1, "one confirmed instrument, one record: {records:?}");
    assert_eq!(records[0]["code"], "2330");
    assert_eq!(records[0]["payload"]["state"], "subscribed");
    let date = records[0]["trading_date"].as_str().unwrap();
    let (y, m, dd) = (date[0..4].parse::<i64>().unwrap(), date[5..7].parse::<i64>().unwrap(), date[8..10].parse::<i64>().unwrap());
    let weekday = (market_runtime::event::days_from_civil(y, m, dd) + 3).rem_euclid(7);
    assert!(weekday < 5, "coverage is never dated to a weekend: {date}");
    let mut status_event = trade("shioaji", "STK", "2330", "DAY", 9, 1_000_000);
    status_event["event_type"] = json!("source_status");
    status_event["data"] = json!({"state": "subscribed"});
    p.send(json!({"type": "event.ingest", "payload": status_event}));
    let refused = p.await_type("event.ack")["payload"].clone();
    assert_eq!(refused["accepted"], false, "{refused}");
    assert_eq!(refused["reason"], "FORBIDDEN_KIND");
}

#[test]
fn a_provider_registering_again_on_its_connection_changes_its_capacity_and_gets_a_fresh_plan() {
    // 設定 → 永豐行情連線: the provider's capacity changes while it stays connected.
    let d = Daemon::start("capacity", &[]);
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "background.replace", "payload": {"revision": 3, "items": [
        {"source": "shioaji", "market": "STK", "code": "2330"}, {"source": "shioaji", "market": "STK", "code": "2317"},
        {"source": "shioaji", "market": "STK", "code": "2454"}]}}));
    assert_eq!(c.await_type("background.replace.ack")["payload"]["applied_revision"], 3);
    let mut p = d.client(SHIOAJI);
    let register = |p: &mut Ws, max: u64| {
        p.send(json!({"type": "adapter.register", "payload": {"source": "shioaji", "max_subscriptions": max, "kinds": ["quote", "trade", "orderbook"]}}));
        p.await_type("adapter.registered");
        p.await_type("adapter.subscription.replace")["payload"]["codes"].as_array().unwrap().len()
    };
    assert_eq!(register(&mut p, 2), 2);
    assert_eq!(register(&mut p, 3), 3, "more room: the whole list is planned");
    c.send(json!({"type": "metrics"}));
    let metrics = c.await_type("metrics")["payload"].clone();
    let adapter = &metrics["demand"]["adapters"]["shioaji"];
    assert_eq!(adapter["connections"], 1, "one adapter connection, not a second one: {metrics}");
    assert_eq!(adapter["limit"], 3, "the second registration's capacity is the one in force: {metrics}");
    c.send(json!({"type": "health"}));
    let health = c.await_type("health")["payload"].clone();
    assert_eq!(health["clients"]["provider"], 1, "the provider kept its one connection (no reconnect): {health}");
    // Still the same, live connection: it is answered on it.
    assert_eq!(register(&mut p, 3), 3);
    // A broker that counts streams (service/market/shared/adapter_control.py stream_budget): billed in streams, not cut
    // at the conservative instrument count beside it; a malformed budget refuses the registration.
    p.send(json!({"type": "adapter.register", "payload": {"source": "shioaji", "max_subscriptions": 1, "kinds": ["quote", "trade", "orderbook"],
        "stream_budget": {"streams": 6, "kinds_by_market": {"FUT": {"quote": 1}, "IDX": {"quote": 1}, "STK": {"trade": 1, "orderbook": 1}}}}}));
    p.await_type("adapter.registered");
    assert_eq!(p.await_type("adapter.subscription.replace")["payload"]["codes"].as_array().unwrap().len(), 3, "3 stocks in 6 streams");
    p.send(json!({"type": "adapter.register", "payload": {"source": "shioaji", "max_subscriptions": 1, "kinds": ["quote"],
        "stream_budget": {"streams": 0, "kinds_by_market": {}}}}));
    assert_eq!(p.await_type("error")["error"], "INVALID_PAYLOAD");
}

#[test]
fn a_plan_goes_only_to_the_adapter_connection_never_to_the_providers_ingest_connection() {
    // The provider's ingest connection reads acks and watermark pushes only (service/market/shared/rust_live.py); a
    // plan arriving there is a protocol error that drops it.
    let d = Daemon::start("plan_route", &[]);
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "background.replace", "payload": {"revision": 3, "items": [{"source": "shioaji", "market": "STK", "code": "2330"}]}}));
    c.await_type("background.replace.ack");
    let mut ingest = d.client(SHIOAJI);
    ingest.send(json!({"type": "event.durable.subscribe"}));
    ingest.await_type("event.durable");
    let mut p = d.client(SHIOAJI);
    p.send(json!({"type": "adapter.register", "payload": {"source": "shioaji", "max_subscriptions": 50, "kinds": ["quote", "trade", "orderbook"]}}));
    p.await_type("adapter.registered");
    p.await_type("adapter.subscription.replace");
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "3481", "session": "DAY"}}));
    v.await_type("view.snapshot");
    p.await_type("adapter.subscription.replace");
    let stray: Vec<Value> = ingest.drain(300).into_iter().filter(|m| m["type"] != "event.durable").collect();
    assert!(stray.is_empty(), "the ingest connection got {stray:?}");
}

#[test]
fn a_saved_background_revision_is_applied_without_a_restart() {
    // settings_api activates a background revision on save (the product pages, holdings and market context);
    // Market Runtime must apply it without a restart.
    let d = Daemon::start("bgreload", &[]);
    let mut p = d.client(SHIOAJI);
    p.send(json!({"type": "adapter.register", "payload": {"source": "shioaji", "max_subscriptions": 50, "kinds": ["quote", "trade", "orderbook"]}}));
    p.await_type("adapter.registered");
    let domain = d.root.join("config").join("background");
    std::fs::create_dir_all(domain.join("revisions")).unwrap();
    std::fs::write(domain.join("revisions").join("r000001.json"), json!({"schema": "stock-monitor-config-revision-v1", "domain": "background",
        "revision": 1, "values": {"items": [{"source": "shioaji", "market": "STK", "code": "2330", "owners": ["watchlist"]},
            {"source": "shioaji", "market": "IDX", "code": "TAIEX", "kinds": ["quote"], "owners": ["market_context"]}]}}).to_string()).unwrap();
    std::fs::write(domain.join("pointer.json"), json!({"latest": 1, "active": 1}).to_string()).unwrap();
    let plan = p.until(|seen| seen.iter().any(|m| m["type"] == "adapter.subscription.replace"
        && m["payload"]["items"].as_array().is_some_and(|i| i.len() == 2)));
    let plan = plan.iter().rev().find(|m| m["type"] == "adapter.subscription.replace").unwrap()["payload"].clone();
    let items: Vec<(String, String)> = plan["items"].as_array().unwrap().iter()
        .map(|i| (i["market"].as_str().unwrap().to_string(), i["code"].as_str().unwrap().to_string())).collect();
    assert!(items.contains(&("IDX".into(), "TAIEX".into())) && items.contains(&("STK".into(), "2330".into())), "{items:?}");
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "demand.status"}));
    let status = c.await_type("demand.status")["payload"].clone();
    assert_eq!(status["background_revision"], 1);
    let row = status["instruments"].as_array().unwrap().iter().find(|r| r["code"] == "TAIEX").unwrap().clone();
    assert_eq!(row["background_owners"], json!(["market_context"]));
}

#[test]
fn futu_crypto_is_shown_and_analysed_but_never_written_to_the_wal() {
    // User rule: Futu crypto is never stored. It is live state, and B gets it over the live lane.
    let d = Daemon::start("unstored", &[]);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut p = d.client(FUTU);
    let ack = ingest(&mut p, trade("futu", "CC", "CC.BTCUSD", "FULL", 1, 650_000_000));
    assert_eq!(ack["accepted"], true, "{ack}");
    assert!(ack["durable_sequence"].is_null(), "no durable sequence: {ack}");
    assert_eq!(ack["storage"], "live_only", "{ack}");
    let ack = ingest(&mut p, trade("futu", "US", "US.AAPL", "FULL", 1, 2_300_000));
    assert!(ack["durable_sequence"].as_u64().is_some(), "a US print is stored: {ack}");
    assert_eq!(ack["storage"], "wal", "{ack}");
    // One batch of both: the WAL confirmation covers the stored print only.
    p.send(json!({"type": "event.ingest.batch", "payload": {"events": [
        trade("futu", "CC", "CC.BTCUSD", "FULL", 2, 650_000_000), trade("futu", "US", "US.AAPL", "FULL", 2, 2_300_000)]}}));
    let results = p.await_type("event.ack.batch")["payload"]["results"].as_array().cloned().unwrap();
    assert!(results[0]["storage"] == "live_only", "{results:?}");
    assert!(results[1]["storage"] == "wal", "{results:?}");
    let seen = b.until(|seen| seen.iter().any(|m| m["type"] == "durable.batch") && seen.iter().any(|m| m["type"] == "live.batch"));
    let live: Vec<&Value> = seen.iter().filter(|m| m["type"] == "live.batch").flat_map(|m| m["payload"]["events"].as_array().unwrap()).collect();
    assert!(live.iter().any(|e| e["code"] == "CC.BTCUSD"), "B gets the crypto print live: {seen:?}");
    let stored: Vec<&Value> = seen.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().unwrap()).collect();
    assert!(stored.iter().all(|e| e["code"] != "CC.BTCUSD") && stored.iter().any(|e| e["code"] == "US.AAPL"), "{stored:?}");
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "futu", "market": "CC", "code": "CC.BTCUSD", "session": "FULL"}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    assert!(snap["summary"]["current"].as_f64().is_some(), "shown live: {snap}");
}

#[test]
fn a_stock_off_the_background_list_is_shown_and_analysed_but_never_written_to_the_wal() {
    // User 10-19: a searched stock (or a workspace one) is never stored; one on the list -- product pages, holdings,
    // the paper ledger -- is. Indices and futures stay stored whatever the list says.
    let d = Daemon::start("unlisted", &[]);
    let mut c = d.client(CONTROLLER);
    c.send(json!({"type": "background.replace", "payload": {"revision": 4, "items": [
        {"source": "shioaji", "market": "STK", "code": "2330", "owners": ["watchlist"]},
        {"source": "futu", "market": "US", "code": "US.AAPL", "owners": ["watchlist"]}]}}));
    assert_eq!(c.await_type("background.replace.ack")["payload"]["applied_revision"], 4);
    let mut b = d.client(ANALYSIS);
    b.send(json!({"type": "durable.subscribe", "payload": {"after_sequence": 0}}));
    b.await_type("durable.subscribed");
    let mut p = d.client(SHIOAJI);
    let listed = ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", 1, 1_000_000));
    assert!(listed["storage"] == "wal", "a listed stock is stored: {listed}");
    let searched = ingest(&mut p, trade("shioaji", "STK", "2454", "DAY", 1, 1_500_000));
    assert!(searched["accepted"] == true && searched["storage"] == "live_only", "{searched}");
    assert!(searched["durable_sequence"].is_null(), "{searched}");
    let index = ingest(&mut p, trade("shioaji", "IDX", "IX0028", "DAY", 1, 5_000_000));
    assert_eq!(index["storage"], "wal", "an index is stored though it is not on the list: {index}");
    let mut f = d.client(FUTU);
    let us = ingest(&mut f, trade("futu", "US", "US.TSLA", "FULL", 1, 4_000_000));
    assert_eq!(us["storage"], "live_only", "a searched Futu stock is not stored either: {us}");
    let seen = b.until(|seen| seen.iter().any(|m| m["type"] == "live.batch" && m["payload"]["events"][0]["code"] == "US.TSLA")
        && seen.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().unwrap().clone()).any(|e| e["code"] == "IX0028"));
    let live: Vec<&Value> = seen.iter().filter(|m| m["type"] == "live.batch").flat_map(|m| m["payload"]["events"].as_array().unwrap()).collect();
    assert!(live.iter().any(|e| e["code"] == "2454"), "B analyses the searched stock live: {seen:?}");
    // The live lane names why it is not stored and by which background revision (B keeps it out of what it writes).
    let searched_batch = seen.iter().find(|m| m["type"] == "live.batch" && m["payload"]["events"][0]["code"] == "2454").unwrap();
    assert_eq!(searched_batch["payload"]["storage"], "unlisted", "{searched_batch}");
    assert_eq!(searched_batch["payload"]["storage_revision"], 4, "{searched_batch}");
    let stored: Vec<&Value> = seen.iter().filter(|m| m["type"] == "durable.batch").flat_map(|m| m["payload"]["events"].as_array().unwrap()).collect();
    assert!(stored.iter().all(|e| e["code"] != "2454" && e["code"] != "US.TSLA") && stored.iter().any(|e| e["code"] == "2330"), "{stored:?}");
    // Shown live.
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2454", "session": "DAY"}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    assert!(snap["summary"]["current"].as_f64().is_some(), "shown live: {snap}");
    // Added to the product page: stored from then on.
    c.send(json!({"type": "background.replace", "payload": {"revision": 5, "items": [
        {"source": "shioaji", "market": "STK", "code": "2330", "owners": ["watchlist"]},
        {"source": "shioaji", "market": "STK", "code": "2454", "owners": ["watchlist"]}]}}));
    assert_eq!(c.await_type("background.replace.ack")["payload"]["applied_revision"], 5);
    let added = ingest(&mut p, trade("shioaji", "STK", "2454", "DAY", 2, 1_510_000));
    assert_eq!(added["storage"], "wal", "{added}");
    c.send(json!({"type": "metrics"}));
    let metrics = c.await_type("metrics")["payload"].clone();
    assert_eq!(metrics["ingest"]["unlisted_live_only"], 2, "{metrics}");
    assert_eq!(metrics["hot_states"]["storage_revision"], 5, "{metrics}");
    assert_eq!(metrics["hot_states"]["live_only_partitions"], 2, "2454 and US.TSLA keep their stored fold apart: {metrics}");
    // Shown: both prints of 2454, the one from before it was listed too.
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2454", "session": "DAY"}}));
    let shown = v.await_type("view.snapshot")["payload"]["trades"].as_array().unwrap().len();
    assert_eq!(shown, 2);
    drop(v);
    // Codex 1020-R04-03: the checkpoint held the live-only print as well, which the WAL never had -- a restart from
    // the checkpoint and a replay of the WAL disagreed. It keeps the stored fold: what the WAL rebuilds.
    drop((c, b, p, f));
    let (root, data) = d.shutdown();
    let d = Daemon::start_in(root, data, &[]);
    let mut v = d.client(VIEWER);
    v.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2454", "session": "DAY"}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    let prices: Vec<Value> = snap["trades"].as_array().unwrap().iter().map(|t| t["price"].clone()).collect();
    assert_eq!(prices.len(), 1, "only the stored print comes back: {snap}");
    v.send(json!({"type": "view.subscribe", "payload": {"source": "futu", "market": "US", "code": "US.TSLA", "session": "FULL"}}));
    let snap = v.await_type("view.snapshot")["payload"].clone();
    assert!(snap["trades"].as_array().is_none_or(|t| t.is_empty()), "a never-listed stock comes back with nothing: {snap}");
}

#[test]
fn a_writes_its_cutoffs_and_the_manager_keeps_only_the_current_and_previous_futu_session_and_crypto_none() {
    let root = temp_dir("futu-prune");
    let historical = root.join("historical");
    let partition = |source: &str, market: &str, date: &str| {
        let dir = historical.join(format!("source={source}")).join(format!("market={market}")).join(format!("trading_date={date}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("part.jsonl"), "{}").unwrap();
        dir
    };
    let old_us = partition("futu", "US", "2020-01-02");
    let new_us = partition("futu", "US", "2099-01-02");
    let crypto = partition("futu", "CC", "2099-01-02");
    let shioaji = partition("shioaji", "STK", "2020-01-02");
    let cutoffs = root.join("rollover_cutoffs.json");
    let d = Daemon::start_in(root.clone(), root.join("data"), &["--rollover", "on", "--historical-dir", historical.to_str().unwrap(),
                                                                "--rollover-cutoffs", cutoffs.to_str().unwrap()]);
    // A writes its cutoffs at the start and removes nothing itself: the store is the manager's (run by B).
    assert!(old_us.exists() && crypto.exists(), "A never removes stored history");
    let rolled = market_runtime::historical_store::read_cutoffs(&cutoffs).unwrap();
    assert!(rolled.contains_key("futu|US|FULL"), "{rolled:?}");
    let store = market_runtime::historical_store::Store::new(market_runtime::historical_store::StoreConfig {
        root: historical.clone(), cutoffs: Some(cutoffs), config_root: None, traded_codes_dir: None });
    store.prune().unwrap();
    assert!(!old_us.exists(), "a US session before the previous one is removed");
    assert!(new_us.exists(), "the current / previous session stays");
    assert!(!crypto.exists(), "crypto is never kept");
    assert!(shioaji.exists(), "Shioaji history is not touched");
    drop(d);
}
