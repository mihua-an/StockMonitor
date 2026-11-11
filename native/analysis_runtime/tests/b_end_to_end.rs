//! Rust A + Rust B as real processes (docs/system-architecture/08 section 1, Rust B rows): accumulation results
//! reach a viewer through A, B restarts from its checkpoint with a higher projection epoch, B reads its inference
//! config file and publishes its own TEST_ONLY signals to A (`signals.publish`), and a flow-rule change rebuilds the
//! day under the new version.

use market_runtime::sha256;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const VIEWER: &str = "viewer-token-000000000000000000";
const SHIOAJI: &str = "provider-shioaji-token-00000000";
const ANALYSIS: &str = "analysis-token-0000000000000000";
const CONTROLLER: &str = "controller-token-00000000000000";
const SETTLE: Duration = Duration::from_secs(30);

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ab-e2e-{name}-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The sibling Market Runtime executable, built from this checkout's native/market_runtime: named the way the Python
/// and Node tests name it, STOCK_MONITOR_A_RELEASE (that build's release directory, <CARGO_TARGET_DIR>/release) or
/// STOCK_MONITOR_TEST_MARKET_RUNTIME (the executable itself). There is no default: native/market_runtime/target/release
/// holds the App's deployed A, whose protocol can be older than this source, and a run against it fails as if B broke.
/// A source file newer than the executable means it was not built from this source.
fn market_runtime_binary() -> PathBuf {
    let name = format!("market_runtime_daemon{}", std::env::consts::EXE_SUFFIX);
    let how = "build it from this checkout (CARGO_TARGET_DIR=<dir> cargo build --release in native/market_runtime) and set \
               STOCK_MONITOR_A_RELEASE to <dir>/release";
    let p = std::env::var("STOCK_MONITOR_TEST_MARKET_RUNTIME").map(PathBuf::from)
        .or_else(|_| std::env::var("STOCK_MONITOR_A_RELEASE").map(|dir| Path::new(&dir).join(&name)))
        .unwrap_or_else(|_| panic!("no Market Runtime named for the B end-to-end tests: {how}"));
    let built = std::fs::metadata(&p).and_then(|m| m.modified())
        .unwrap_or_else(|e| panic!("Market Runtime {}: {e}; {how}", p.display()));
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../market_runtime");
    let newer = newer_than(&[source.join("src"), source.join("Cargo.toml"), source.join("Cargo.lock")], built);
    assert!(newer.is_empty(), "Market Runtime {} is older than its source ({}): {how}", p.display(),
        newer.iter().map(|f| f.display().to_string()).collect::<Vec<_>>().join(", "));
    p
}

/// Files under `paths` modified after `than`.
fn newer_than(paths: &[PathBuf], than: std::time::SystemTime) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = paths.to_vec();
    while let Some(path) = pending.pop() {
        let meta = std::fs::metadata(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        if meta.is_dir() {
            pending.extend(std::fs::read_dir(&path).unwrap().map(|entry| entry.unwrap().path()));
        } else if meta.modified().unwrap() > than {
            found.push(path);
        }
    }
    found
}

fn write_revision(root: &Path, domain: &str, revision: u64, values: Value) {
    let dir = root.join(domain).join("revisions");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("r{revision:06}.json")), json!({"schema": "stock-monitor-config-revision-v1", "domain": domain,
        "revision": revision, "previous_revision": null, "created_at": "t", "source": "test", "summary": "", "values": values}).to_string()).unwrap();
    std::fs::write(root.join(domain).join("pointer.json"), json!({"schema": "stock-monitor-config-pointer-v1", "domain": domain,
        "latest": revision, "active": revision, "last_good": revision}).to_string()).unwrap();
}

fn flow_rules(threshold: f64) -> Value {
    json!({"rules": [{"rule_id": format!("tw-{threshold}"), "match": {"source": "shioaji", "market": "STK"}, "threshold_type": "volume",
        "threshold": threshold, "unit": "lot", "unit_size": 1000, "currency": "TWD"}], "side_inference": "quote_rule"})
}

struct Proc(Child);
impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Stack {
    root: PathBuf,
    port: u16,
    a: Proc,
    /// A's stdout and stderr, printed when a test fails.
    a_log: Arc<Mutex<String>>,
}

impl Drop for Stack {
    fn drop(&mut self) {
        let _ = self.a.0.kill();
        let _ = self.a.0.wait();
        if std::thread::panicking() {
            eprintln!("--- Market Runtime on port {} output ---
{}", self.port, self.a_log.lock().unwrap());
        }
    }
}

fn start_a(root: &Path) -> Stack {
    start_a_with(root, &[])
}

/// Market Runtime on a port it binds itself (port 0): no port is picked here and released before A binds it.
fn start_a_with(root: &Path, extra: &[&str]) -> Stack {
    start_a_on(root, 0, extra)
}

/// Market Runtime restarted in place: same data dir and the port B already knows, a new runtime epoch.
fn restart_a(stack: Stack) -> Stack {
    let (root, port) = (stack.root.clone(), stack.port);
    drop(stack);
    start_a_on(&root, port, &[])
}

fn start_a_on(root: &Path, port: u16, extra: &[&str]) -> Stack {
    let creds = root.join("creds.json");
    std::fs::write(&creds, json!({"schema": "market-runtime-credentials-v1", "roles": {
        "viewer": sha256::hex(VIEWER.as_bytes()), "provider:shioaji": sha256::hex(SHIOAJI.as_bytes()),
        "analysis_runtime": sha256::hex(ANALYSIS.as_bytes()), "controller": sha256::hex(CONTROLLER.as_bytes())}}).to_string()).unwrap();
    // Owned by a Proc from the moment it exists: a panic below (A never ready) drops it and stops A, no orphan.
    let mut a = Proc(Command::new(market_runtime_binary()).args(["--port", &port.to_string(), "--data-dir", root.join("a").to_str().unwrap(),
        "--credentials", creds.to_str().unwrap(), "--clock", "exchange", "--rollover", "off", "--config-root", root.join("config").to_str().unwrap()])
        .args(extra).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap());
    let a_log = Arc::new(Mutex::new(String::new()));
    let (tx, lines) = mpsc::channel::<Value>();
    let (stdout, stderr) = (a.0.stdout.take().unwrap(), a.0.stderr.take().unwrap());
    let log = a_log.clone();
    std::thread::spawn(move || for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        log.lock().unwrap().push_str(&format!("[stdout] {line}
"));
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            let _ = tx.send(v);
        }
    });
    let log = a_log.clone();
    std::thread::spawn(move || for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        log.lock().unwrap().push_str(&format!("[stderr] {line}
"));
    });
    // A names the port it bound on its `listening` line, before its recovery; `ready` follows the recovery.
    let deadline = Instant::now() + SETTLE;
    let (mut bound, mut ready) = (None, false);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match lines.recv_timeout(left) {
            Ok(v) if v["type"] == "listening" => bound = v["port"].as_u64(),
            Ok(v) if v["type"] == "ready" => {
                ready = true;
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let port = bound.filter(|_| ready).unwrap_or_else(|| panic!("A never became ready; its output:
{}", a_log.lock().unwrap())) as u16;
    Stack { root: root.to_path_buf(), port, a, a_log }
}

struct B {
    proc: Proc,
    stdin: ChildStdin,
    lines: mpsc::Receiver<Value>,
}

/// The inference config model_api writes for B (service/analysis/inference_files.py): TEST_ONLY, one 3m up slot.
fn write_inference_config(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("config.json"), json!({"type": "config", "config_version": 1, "horizon_authority_version": 1,
        "allowed_minutes": [3, 5, 10, 15, 30], "slots": [{"horizon_minutes": 3, "direction": "up"}], "test_only_predictor": true,
        "queue_capacity": 64, "workers": 1, "task_ttl_ms": 60000}).to_string()).unwrap();
}

/// Market Runtime's current model-signal rows (what /api/latest-signals serves).
fn signal_rows(port: u16) -> Vec<Value> {
    let mut viewer = Ws::connect(port, VIEWER);
    viewer.send(json!({"type": "signals.snapshot", "payload": {}}));
    let deadline = Instant::now() + Duration::from_secs(5);
    while let Some(msg) = viewer.read(deadline) {
        if msg["type"] == "signals.snapshot" {
            return msg["payload"]["signals"].as_array().cloned().unwrap_or_default();
        }
    }
    Vec::new()
}

fn start_b(stack: &Stack, inference_dir: Option<&Path>) -> B {
    start_b_with(stack, inference_dir, &[])
}

fn start_b_with(stack: &Stack, inference_dir: Option<&Path>, extra: &[String]) -> B {
    let token = stack.root.join("analysis.token");
    std::fs::write(&token, ANALYSIS).unwrap();
    let mut args = vec!["--runtime-url".to_string(), format!("ws://127.0.0.1:{}/live", stack.port), "--token-file".into(),
        token.to_string_lossy().into(), "--data-dir".into(), stack.root.join("b").to_string_lossy().into(),
        "--events-dir".into(), stack.root.join("storage").join("analysis-events").to_string_lossy().into(), "--config-root".into(),
        stack.root.join("config").to_string_lossy().into(), "--publish-interval-ms".into(), "100".into()];
    if let Some(p) = inference_dir {
        args.push("--inference-dir".into());
        args.push(p.to_string_lossy().into());
    }
    args.extend(extra.iter().cloned());
    let mut child = Command::new(env!("CARGO_BIN_EXE_analysis_runtime")).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped())
        .stderr(Stdio::null()).spawn().unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = tx.send(v);
            }
        }
    });
    B { proc: Proc(child), stdin, lines: rx }
}

impl B {
    fn wait_line(&self, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + SETTLE;
        while Instant::now() < deadline {
            if let Ok(v) = self.lines.recv_timeout(Duration::from_millis(200)) {
                if pred(&v) {
                    return v;
                }
            }
        }
        panic!("B never emitted the expected line");
    }
    fn stop(mut self) {
        let _ = writeln!(self.stdin, "{}", json!({"type": "shutdown"}));
        let deadline = Instant::now() + SETTLE;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.proc.0.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

struct Ws(TcpStream);
impl Ws {
    fn connect(port: u16, token: &str) -> Ws {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        write!(s, "GET /live HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
        let mut resp = Vec::new();
        let mut b = [0u8; 1];
        let deadline = Instant::now() + SETTLE;
        while !resp.windows(4).any(|w| w == b"\r\n\r\n") && Instant::now() < deadline {
            if let Ok(1) = s.read(&mut b) {
                resp.push(b[0]);
            }
        }
        assert!(String::from_utf8_lossy(&resp).starts_with("HTTP/1.1 101"));
        Ws(s)
    }
    fn send(&mut self, v: Value) {
        let p = serde_json::to_vec(&v).unwrap();
        let mut f = vec![0x81u8];
        if p.len() < 126 {
            f.push(0x80 | p.len() as u8);
        } else if p.len() <= 65535 {
            f.push(0x80 | 126);
            f.extend_from_slice(&(p.len() as u16).to_be_bytes());
        } else {
            f.push(0x80 | 127);
            f.extend_from_slice(&(p.len() as u64).to_be_bytes());
        }
        f.extend_from_slice(&[0, 0, 0, 0]);
        f.extend_from_slice(&p);
        self.0.write_all(&f).unwrap();
    }
    fn exact(&mut self, n: usize, deadline: Instant) -> Option<Vec<u8>> {
        let mut out = vec![0u8; n];
        let mut got = 0;
        while got < n {
            // A frame begun is read whole: giving up inside one would leave the rest to be read as the next frame.
            if Instant::now() > deadline && got == 0 {
                return None;
            }
            match self.0.read(&mut out[got..]) {
                Ok(0) => return None,
                Ok(k) => got += k,
                Err(_) => {}
            }
        }
        Some(out)
    }
    fn read(&mut self, deadline: Instant) -> Option<Value> {
        let h = self.exact(2, deadline)?;
        let rest = Instant::now() + SETTLE;
        let mut len = (h[1] & 127) as usize;
        if len == 126 {
            let b = self.exact(2, rest)?;
            len = u16::from_be_bytes([b[0], b[1]]) as usize;
        } else if len == 127 {
            let b = self.exact(8, rest)?;
            len = u64::from_be_bytes(b.try_into().unwrap()) as usize;
        }
        let p = self.exact(len, rest)?;
        serde_json::from_slice(&p).ok()
    }
    /// The view messages until the replay view held makes `pred` (the message, the view after it) true, or SETTLE
    /// passes: whether it did. `view` is held as a client holds it: a snapshot is the view whole, a seek's
    /// `view.replay_diff` moves the one held.
    fn until_view(&mut self, view: &mut Value, pred: impl Fn(&Value, &Value) -> bool) -> bool {
        let deadline = Instant::now() + SETTLE;
        while Instant::now() < deadline {
            let Some(m) = self.read(deadline) else { continue };
            if hold(view, &m) && pred(&m, view) {
                return true;
            }
        }
        false
    }

    fn deltas_until(&mut self, pred: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let deadline = Instant::now() + SETTLE;
        let mut out = Vec::new();
        while Instant::now() < deadline && !pred(&out) {
            if let Some(m) = self.read(deadline) {
                match m["type"].as_str() {
                    Some("view.delta") => out.push(m["payload"].clone()),
                    Some("view.delta.batch") => out.extend(m["payload"]["items"].as_array().cloned().unwrap_or_default()),
                    _ => {}
                }
            }
        }
        out
    }
}

fn tw_ts(minute: i64, second: i64) -> i64 {
    (market_runtime::event::days_from_civil(2026, 9, 29) * 86_400 + minute * 60 + second - 8 * 3600) * 1_000_000_000
}

fn trade(seq: u64, minute: i64, second: i64, price: i64, volume: i64, side: i8) -> Value {
    json!({"schema": "market-event-v2", "event_id": format!("t{seq}"), "source": "shioaji", "market": "STK", "code": "2330",
        "generation": 1, "sequence": seq, "event_type": "trade", "exchange_ts_ns": tw_ts(minute, second),
        "arrival_ns": tw_ts(minute, second) as u64 + 1000, "time_quality": "exchange",
        "data": {"price": price, "volume": volume, "total_volume": seq, "side": side, "trade_id": format!("t{seq}")}})
}

fn feed(port: u16, from: u64, to: u64) {
    let mut p = Ws::connect(port, SHIOAJI);
    let events: Vec<Value> = (from..=to).map(|s| {
        let minute = 600 + (s as i64 - 1) / 10;
        let second = ((s - 1) % 10) as i64 * 5;
        trade(s, minute, second, 1_000_000 + (s as i64 % 7) * 500, if s % 5 == 0 { 150 } else { 10 }, if s % 2 == 0 { 1 } else { -1 })
    }).collect();
    // The partition's 昨收 100 comes as its own Reference event, before the first print, at the exchange time of the
    // print that stated it (Market Runtime files it in that print's partition).
    let events: Vec<Value> = (from == 1).then(|| {
        let mut reference = trade(1, 600, 0, 0, 0, 0);
        reference["event_type"] = json!("reference");
        reference["event_id"] = json!("r1");
        reference["data"] = json!({"prev_close": 1_000_000});
        reference
    }).into_iter().chain(events).collect();
    p.send(json!({"type": "event.ingest.batch", "payload": {"events": events}}));
    let deadline = Instant::now() + SETTLE;
    loop {
        let m = p.read(deadline).expect("ack");
        if m["type"] == "event.ack.batch" {
            assert!(m["payload"]["results"].as_array().unwrap().iter().all(|r| r["accepted"] == true), "{m}");
            break;
        }
    }
}

#[test]
fn accumulation_reaches_the_viewer_through_market_runtime_and_survives_a_b_restart() {
    let root = temp("roundtrip");
    write_revision(&root.join("config"), "flow_rules", 1, flow_rules(100.0));
    write_revision(&root.join("config"), "event_rules", 1, json!({"rules": [{"rule_id": "win1_up", "type": "window_move", "window": 1, "direction": "up", "threshold_pct": 0.1, "label": "1分急拉", "priority": 400}]}));
    let stack = start_a(&root);
    feed(stack.port, 1, 60);
    let b = start_b(&stack, None);
    let hello = b.wait_line(|v| v["type"] == "hello");
    assert_eq!(hello["restored_cursor"], 0);
    let mut viewer = Ws::connect(stack.port, VIEWER);
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY", "trading_date": "2026-09-29"}}));
    let got = viewer.deltas_until(|d| d.iter().any(|x| x["delta_type"] == "day.updated") && d.iter().any(|x| x["delta_type"] == "minutes.upsert")
        && d.iter().any(|x| x["delta_type"] == "windows.updated") && d.iter().any(|x| x["delta_type"] == "tradeflow.updated"));
    let minutes: Vec<&Value> = got.iter().filter(|d| d["delta_type"] == "minutes.upsert").flat_map(|d| d["payload"]["points"].as_array().unwrap().iter()).collect();
    let m600 = minutes.iter().rev().find(|p| p["minute"] == 600).expect("minute 600");
    assert_eq!(m600["volume"], 10 * 8 + 150 * 2, "10 prints in 10:00 (2 large)");
    assert_eq!(m600["quality"], "TRADED");
    let day = got.iter().rev().find(|d| d["delta_type"] == "day.updated").unwrap();
    assert_eq!(day["payload"]["flow"]["large"]["count"], 12, "every 5th of 60 prints is large");
    assert_eq!(day["payload"]["reference_price"], 100.0);
    let windows = got.iter().rev().find(|d| d["delta_type"] == "windows.updated").unwrap();
    assert_eq!(windows["payload"]["windows"]["3"]["minutes"], 3);
    // restart B: it resumes from its checkpoint and publishes under a higher epoch that A accepts
    b.stop();
    feed(stack.port, 61, 80);
    let b2 = start_b(&stack, None);
    let hello2 = b2.wait_line(|v| v["type"] == "hello");
    assert!(hello2["restored_cursor"].as_u64().unwrap() >= 60, "{hello2}");
    assert_eq!(hello2["projection_epoch"].as_u64().unwrap(), hello["projection_epoch"].as_u64().unwrap() + 1);
    let got = viewer.deltas_until(|d| d.iter().any(|x| x["delta_type"] == "minutes.upsert"
        && x["payload"]["points"].as_array().unwrap().iter().any(|p| p["minute"] == 607)));
    let meta = got.iter().rev().find(|d| d["delta_type"] == "minutes.upsert").unwrap();
    assert_eq!(meta["block_meta"]["projection_epoch"], hello2["projection_epoch"]);
    let metrics = b2.wait_line(|v| v["type"] == "metrics" && v["stream"]["cursor"].as_u64().unwrap_or(0) >= 80);
    assert_eq!(metrics["publish"]["acks_rejected"], 0, "{metrics}");
    b2.stop();
}

/// A restarted Market Runtime holds none of B's projection, so B -- still running, same projection
/// epoch -- publishes all of it once, and the views are whole again without any new market data.
#[test]
fn a_restarted_market_runtime_gets_the_whole_projection_from_a_running_b() {
    let root = temp("a-restart");
    write_revision(&root.join("config"), "flow_rules", 1, flow_rules(100.0));
    let stack = start_a(&root);
    feed(stack.port, 1, 60);
    let b = start_b(&stack, None);
    b.wait_line(|v| v["type"] == "metrics" && v["stream"]["cursor"].as_u64().unwrap_or(0) >= 60 && v["publish"]["items"].as_u64().unwrap_or(0) > 0);
    let before = b.wait_line(|v| v["type"] == "metrics" && v["stream"]["runtime_epoch"].is_u64());
    let stack = restart_a(stack);
    let mut viewer = Ws::connect(stack.port, VIEWER);
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY", "trading_date": "2026-09-29"}}));
    // B's whole projection reaches the restarted A either before the viewer subscribes (it is then in the snapshot)
    // or after (deltas): waiting only for deltas failed whenever B was faster than the viewer.
    let deadline = Instant::now() + SETTLE;
    let (mut day, mut minute_600) = (false, false);
    while Instant::now() < deadline && !(day && minute_600) {
        let Some(m) = viewer.read(deadline) else { continue };
        let deltas: Vec<Value> = match m["type"].as_str() {
            Some("view.snapshot") => {
                day |= m["payload"]["day"].is_object();
                minute_600 |= m["payload"]["minutes"].as_array().is_some_and(|ms| ms.iter().any(|p| p["minute"] == 600));
                Vec::new()
            }
            Some("view.delta") => vec![m["payload"].clone()],
            Some("view.delta.batch") => m["payload"]["items"].as_array().cloned().unwrap_or_default(),
            _ => Vec::new(),
        };
        for x in deltas {
            day |= x["delta_type"] == "day.updated";
            minute_600 |= x["delta_type"] == "minutes.upsert" && x["payload"]["points"].as_array().is_some_and(|ps| ps.iter().any(|p| p["minute"] == 600));
        }
    }
    assert!(day && minute_600, "the whole projection reached the restarted A (day {day}, minute 600 {minute_600})");
    let after = b.wait_line(|v| v["type"] == "metrics" && v["stream"]["connected"] == true
        && v["stream"]["runtime_epoch"].is_u64() && v["stream"]["runtime_epoch"] != before["stream"]["runtime_epoch"]);
    assert_eq!(after["publish"]["dropped"], 0, "{after}");
    b.stop();
}

#[test]
fn b_reads_its_config_file_and_publishes_its_own_signals_and_a_rule_change_rebuilds_the_day() {
    // B is the model-signal authority. No producer, no FastAPI: B reads the config file, validates its own
    // TEST_ONLY results and publishes them to Market Runtime, which serves them back.
    let root = temp("producer");
    write_revision(&root.join("config"), "flow_rules", 1, flow_rules(100.0));
    let stack = start_a(&root);
    feed(stack.port, 1, 90); // 9 minutes of prints: enough to warm the online features
    let inference = root.join("inference");
    write_inference_config(&inference);
    let b = start_b(&stack, Some(&inference));
    let port = stack.port;
    let feeder = std::thread::spawn(move || feed(port, 91, 140));
    let deadline = Instant::now() + SETTLE;
    let mut row = Value::Null;
    while Instant::now() < deadline {
        if let Some(found) = signal_rows(stack.port).into_iter().find(|r| r["code"] == "2330" && r["model_predictions"]["3m_up"]["status"] == "OK") {
            row = found;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    feeder.join().unwrap();
    let peek: Value = std::fs::read_to_string(inference.join("status.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    assert_eq!(row["authority"], "analysis_signal_producer", "B published a TEST_ONLY signal into Market Runtime: {row}; status {}", peek["signals"]);
    assert_eq!(row["model_predictions"]["3m_up"]["test_only"], true);
    assert_eq!(row["trading_date"], "2026-09-29");
    // B reports its capability and its signal authority's counts in the status file model_api reads.
    let deadline = Instant::now() + SETTLE;
    let status = loop {
        let status: Value = std::fs::read_to_string(inference.join("status.json")).ok()
            .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        if status["signals"]["counts"]["accepted"].as_u64().unwrap_or(0) >= 1 || Instant::now() > deadline {
            break status;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    assert_eq!(status["capability"]["slots"][0]["key"], "3m_up", "{status}");
    assert!(status["signals"]["counts"]["accepted"].as_u64().unwrap_or(0) >= 1, "{status}");
    // Flow rule change -> the day is rebuilt from the WAL under the new version (one rebuild, new epoch).
    write_revision(&root.join("config"), "flow_rules", 2, flow_rules(5.0));
    // The rebuild counter moves the moment the rules change; the rules and the stream state in a metrics line are the
    // last status report's (every 2 s). Wait for the report that already carries revision 2.
    let m = b.wait_line(|v| v["type"] == "metrics" && v["rules"]["flow_revision"] == 2 && v["stream"]["state"] == "LIVE");
    assert_eq!(m["publish"]["rebuilds"], 1, "one rebuild for one rule change: {m}");
    let mut viewer = Ws::connect(stack.port, VIEWER);
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "session": "DAY", "trading_date": "2026-09-29"}}));
    let deadline = Instant::now() + SETTLE;
    let mut snapshot = Value::Null;
    while Instant::now() < deadline {
        if let Some(msg) = viewer.read(deadline) {
            if msg["type"] == "view.snapshot" {
                snapshot = msg["payload"].clone();
                if snapshot["day"]["flow"]["rule_id"] == "tw-5" {
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
                viewer.send(json!({"type": "view.resync", "payload": {"subscription_id": snapshot["subscription_id"]}}));
            }
        }
    }
    assert_eq!(snapshot["day"]["flow"]["rule_id"], "tw-5", "rebuilt under the new rule");
    // Every print is >= 5 lots under the new rule. The feed starts at 10:00: its first print is no opening match
    // (Market Runtime flags only a 09:00 first print, a print after 試撮 and the 13:30 close), so all are large.
    assert_eq!(snapshot["day"]["flow"]["large"]["count"], 140, "{}", snapshot["day"]["flow"]);
    assert_eq!(snapshot["day"]["diagnostics"]["auction_prints"], 0);
    b.stop();
}


// ------------------------------------------------------------------------------------------ 歷史回放

/// One recorded print as the historical materializer stores it (MarketEvent JSON).
fn recorded(seq: u64, minute: i64, second: i64, price: i64, volume: i64) -> Value {
    json!({"schema_version": 2, "durable_sequence": seq, "symbol": "shioaji:STK:2330", "provider": "shioaji", "market": "STK", "code": "2330",
        "session": "DAY", "trading_date": "2026-09-29", "generation": 1, "sequence": seq, "exchange_ts_ns": tw_ts(minute, second),
        "time_quality": "exchange", "payload": {"kind": "trade", "price": price, "volume": volume, "total_volume": seq * 10, "side": 1,
            "trade_id": format!("t{seq}"), "minute": minute, "open": 1_000_000, "high": price, "low": price,
            "average": price, "total_amount": 0.0, "amount": 0.0}})
}

/// A committed partition as the historical materializer leaves it: events.jsonl, then manifest.json with the line count
/// and FNV-1a 64 hash A verifies before it replays anything (no manifest = not committed).
fn write_partition(dir: &Path, events: &str) {
    std::fs::write(dir.join("events.jsonl"), events).unwrap();
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in events.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let count = events.lines().filter(|l| !l.trim().is_empty()).count();
    std::fs::write(dir.join("manifest.json"), json!({"event_count": count, "content_hash_fnv1a64": format!("{hash:016x}")}).to_string()).unwrap();
}

#[test]
fn a_replay_is_analysed_by_b_in_its_own_engine_and_reaches_only_the_replay_views() {
    let root = temp("replay");
    write_revision(&root.join("config"), "flow_rules", 1, flow_rules(100.0));
    let dir = root.join("historical").join("source=shioaji").join("market=STK").join("trading_date=2026-09-29").join("session=DAY").join("2330");
    std::fs::create_dir_all(&dir).unwrap();
    // 10:00 (3 prints), 10:01 (2 prints), 10:02 (1 print).
    let events = [recorded(1, 600, 1, 1_000_000, 10), recorded(2, 600, 20, 1_000_500, 150), recorded(3, 600, 40, 1_001_000, 10),
                  recorded(4, 601, 5, 1_001_500, 10), recorded(5, 601, 30, 1_002_000, 10), recorded(6, 602, 10, 1_002_500, 10)];
    write_partition(&dir, &events.iter().map(|e| format!("{e}\n")).collect::<String>());
    let historical = root.join("historical").to_string_lossy().into_owned();
    let stack = start_a_with(&root, &["--historical-dir", &historical]);
    let b = start_b(&stack, None);
    b.wait_line(|v| v["type"] == "hello");
    // B's reader must be subscribed before the replay opens (A feeds the replay to the connected B).
    b.wait_line(|v| v["type"] == "metrics" && v["stream"]["connected"] == true);

    let mut viewer = Ws::connect(stack.port, VIEWER);
    // Opened at 10:02: the 10:00 and 10:01 prints are played at once (fed to B), then 10:02 plays in time.
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY",
        "at_ns": tw_ts(602, 0).to_string()}}));
    let deadline = Instant::now() + SETTLE;
    let opened = loop {
        let m = viewer.read(deadline).expect("replay.opened");
        if m["type"] == "replay.opened" {
            break m["payload"].clone();
        }
    };
    assert_eq!(opened["ok"], true, "{opened}");
    let replay_id = opened["replay_id"].as_str().unwrap().to_string();
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29",
        "session": "DAY", "replay_id": replay_id}}));
    // B's timeline reaches A: the view gets B's analysis of the step the replay stands on (10:02, its first print not
    // yet due), minute 600 being what the three prints of 10:00 make.
    let minute = |v: &Value, n: i64| v["minutes"].as_array().and_then(|p| p.iter().find(|p| p["minute"] == n).cloned());
    let mut view = Value::Null;
    assert!(viewer.until_view(&mut view, |_, v| minute(v, 600).is_some_and(|p| p["quality"] == "TRADED")), "B's analysis reached the view: {view}");
    assert_eq!(minute(&view, 600).unwrap()["volume"], 10 + 150 + 10, "B's accumulation of the replayed prints");
    assert_eq!(view["replay_id"], replay_id.as_str(), "the replay's own view");
    assert_eq!(view["replay"]["analysis"]["at_position"], true);

    // Back to 10:00:30: the seek's own view carries the analysis of that step -- minute 600 of the first two prints.
    viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "seek", "at_ns": tw_ts(600, 30).to_string()}}));
    assert!(viewer.until_view(&mut view, |m, _| m["payload"]["resync_reason"] == "REPLAY_SEEK"), "the seek's view");
    assert_eq!(minute(&view, 600).map(|p| p["volume"].clone()), Some(json!(10 + 150)), "the step sought, at once");

    // Nothing of it in the live market: B's live engine holds no instrument, A's WAL nothing.
    let metrics = b.wait_line(|v| v["type"] == "metrics");
    assert_eq!(metrics["stream"]["cursor"], 0, "the replay is not in the durable stream");
    assert_eq!(metrics["engine"]["instruments"], 0, "B's live engine never saw the replay: {}", metrics["engine"]);
    let mut live = Ws::connect(stack.port, VIEWER);
    live.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    let deadline = Instant::now() + SETTLE;
    let snapshot = loop {
        let m = live.read(deadline).expect("live snapshot");
        if m["type"] == "view.snapshot" {
            break m["payload"].clone();
        }
    };
    assert_eq!(snapshot["trades"].as_array().map(Vec::len), Some(0), "the live view holds none of the replay's prints");
    assert_eq!(snapshot["minutes"].as_array().map(Vec::len), Some(0), "nor its minutes");
    b.stop();
}

#[test]
fn a_replay_is_inferred_in_its_own_feature_store_and_its_predictions_reach_its_view_only() {
    let root = temp("replay-infer");
    write_revision(&root.join("config"), "flow_rules", 1, flow_rules(100.0));
    let dir = root.join("historical").join("source=shioaji").join("market=STK").join("trading_date=2026-09-29").join("session=DAY").join("2330");
    std::fs::create_dir_all(&dir).unwrap();
    // 14 minutes of prints (the live test's shape): enough to warm the online features.
    let events: String = (1..=140u64).map(|s| {
        let minute = 600 + (s as i64 - 1) / 10;
        let second = ((s - 1) % 10) as i64 * 5;
        format!("{}\n", recorded(s, minute, second, 1_000_000 + (s as i64 % 7) * 500, if s % 5 == 0 { 150 } else { 10 }))
    }).collect();
    write_partition(&dir, &events);
    let historical = root.join("historical").to_string_lossy().into_owned();
    let stack = start_a_with(&root, &["--historical-dir", &historical]);

    let inference = root.join("inference");
    write_inference_config(&inference);
    let b = start_b(&stack, Some(&inference));
    b.wait_line(|v| v["type"] == "metrics" && v["stream"]["connected"] == true);

    let mut viewer = Ws::connect(stack.port, VIEWER);
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY",
        "at_ns": tw_ts(613, 50).to_string()}}));
    let deadline = Instant::now() + SETTLE;
    let replay_id = loop {
        let m = viewer.read(deadline).expect("replay.opened");
        if m["type"] == "replay.opened" {
            assert_eq!(m["payload"]["ok"], true, "{m}");
            break m["payload"]["replay_id"].as_str().unwrap().to_string();
        }
    };
    // The replay's predictions are its timeline's: its view gets them, never a live row.
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29",
        "session": "DAY", "channels": ["signals"], "replay_id": replay_id}}));
    let mut view = Value::Null;
    assert!(viewer.until_view(&mut view, |_, v| v["signals"]["model_predictions"].as_object().is_some_and(|p| !p.is_empty())), "predictions reached the view: {view}");
    let predictions = &view["signals"]["model_predictions"];
    assert!(predictions.as_object().is_some_and(|p| p.values().any(|e| e["status"] == "OK" && e["test_only"] == true)), "{predictions}");
    assert!(signal_rows(stack.port).iter().all(|r| r["code"] != "2330"), "the live signal rows never see the replay");
    let metrics = b.wait_line(|v| v["type"] == "metrics");
    assert_eq!(metrics["features"]["keys"], 0, "the live feature store never folded the replay");
    b.stop();
}

/// `m` applied to the replay view held, as a client applies it: a snapshot is the view whole, a seek's
/// `view.replay_diff` moves the one held. Whether `m` was a view message.
fn hold(view: &mut Value, m: &Value) -> bool {
    match m["type"].as_str() {
        Some("view.snapshot") => *view = m["payload"].clone(),
        Some("view.replay_diff") => market_runtime::view_diff::apply(view, m["payload"]["ops"].as_array().unwrap()).expect("the diff fits the view held"),
        _ => return false,
    }
    true
}

fn ingest(port: u16, events: Vec<Value>) {
    let mut p = Ws::connect(port, SHIOAJI);
    p.send(json!({"type": "event.ingest.batch", "payload": {"events": events}}));
    let deadline = Instant::now() + SETTLE;
    loop {
        let m = p.read(deadline).expect("ack");
        if m["type"] == "event.ack.batch" {
            assert!(m["payload"]["results"].as_array().unwrap().iter().all(|r| r["accepted"] == true), "{m}");
            break;
        }
    }
}

/// The paper test's day: a trading day after today, so the clock Rust A keeps on the wall time for today's coverage
/// controls never says this day has closed (an order of a closed day expires, as it should).
const PAPER_DAY: &str = "2099-09-29";

fn paper_ts(minute: i64, second: i64) -> i64 {
    (market_runtime::event::days_from_civil(2099, 9, 29) * 86_400 + minute * 60 + second - 8 * 3600) * 1_000_000_000
}

fn book_event(seq: u64, second: i64, bid: (i64, i64), ask: (i64, i64)) -> Value {
    json!({"schema": "market-event-v2", "event_id": format!("b{seq}"), "source": "shioaji", "market": "STK", "code": "2330",
        "generation": 1, "sequence": seq, "event_type": "orderbook", "exchange_ts_ns": paper_ts(600, second),
        "arrival_ns": paper_ts(600, second) as u64 + 1000, "time_quality": "exchange",
        "data": {"bids": [{"price": bid.0, "volume": bid.1}], "asks": [{"price": ask.0, "volume": ask.1}]}})
}

fn paper_trade(seq: u64, second: i64, price: i64, volume: i64, side: i8) -> Value {
    let mut event = trade(seq, 600, second, price, volume, side);
    event["exchange_ts_ns"] = json!(paper_ts(600, second));
    event["arrival_ns"] = json!(paper_ts(600, second) as u64 + 1000);
    event
}

fn results(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join("results.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// 模擬下單 end to end: an order in orders.jsonl waits behind the 五檔 volume at its price, the prints at its price
/// work the queue off and fill it (results.jsonl), and a restarted B -- checkpoint or not -- writes nothing twice.
#[test]
fn a_paper_order_queues_on_the_durable_stream_and_fills_once() {
    let root = temp("paper");
    write_revision(&root.join("config"), "flow_rules", 1, flow_rules(100.0));
    let paper = root.join("paper");
    std::fs::create_dir_all(&paper).unwrap();
    let stack = start_a(&root);
    let extra = vec!["--paper-dir".to_string(), paper.to_string_lossy().into()];
    let b = start_b_with(&stack, None, &extra);
    b.wait_line(|v| v["type"] == "hello");
    ingest(stack.port, vec![book_event(1, 0, (1_000_000, 5), (1_005_000, 3))]);
    std::fs::write(paper.join("orders.jsonl"), format!("{}\n", json!({"type": "new", "cmd_id": "PO-1", "order_id": "PO-1", "accepted_ns": 0,
        "trading_date": PAPER_DAY, "code": "2330", "side": "buy", "lot": "whole", "price_type": "limit", "price": 1_000_000,
        "qty": 2000.0, "tif": "ROD"}))).unwrap();
    let deadline = Instant::now() + SETTLE;
    while !results(&paper).iter().any(|r| r["type"] == "read") {
        assert!(Instant::now() < deadline, "B never read the order");
        std::thread::sleep(Duration::from_millis(50));
    }
    // It reaches the exchange before the next book, behind the 5 lots shown then (a later 6 grew behind it); then 6
    // lots trade at its price from the sell side.
    ingest(stack.port, vec![book_event(2, 5, (1_000_000, 6), (1_005_000, 3)), book_event(3, 6, (1_000_000, 6), (1_005_000, 3)),
                            paper_trade(4, 10, 1_000_000, 6, -1)]);
    let deadline = Instant::now() + SETTLE;
    while !results(&paper).iter().any(|r| r["type"] == "fill") {
        assert!(Instant::now() < deadline, "no fill: {:?}", results(&paper));
        std::thread::sleep(Duration::from_millis(50));
    }
    let fills: Vec<Value> = results(&paper).into_iter().filter(|r| r["type"] == "fill").collect();
    assert_eq!(fills.len(), 1, "{fills:?}");
    assert_eq!(fills[0]["qty"], 1000.0, "5 ahead, 6 traded: 1 lot of the 2");
    assert_eq!(fills[0]["reason"], "排隊輪到");
    assert!(!paper.join("queue.json").exists(), "the queue estimate is never written out");
    b.stop();
    let written = results(&paper).len();
    // A restart from the checkpoint, then one without any checkpoint (a full rebuild): the same records, none twice.
    let b2 = start_b_with(&stack, None, &extra);
    b2.wait_line(|v| v["type"] == "metrics" && v["stream"]["cursor"].as_u64().unwrap_or(0) >= 4);
    std::thread::sleep(Duration::from_millis(400));
    b2.stop();
    assert_eq!(results(&paper).len(), written);
    let _ = std::fs::remove_dir_all(stack.root.join("b"));
    let b3 = start_b_with(&stack, None, &extra);
    let metrics = b3.wait_line(|v| v["type"] == "metrics" && v["stream"]["cursor"].as_u64().unwrap_or(0) >= 4);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(results(&paper).len(), written, "the rebuild entered the order where the first pass did");
    assert_eq!(metrics["paper"]["working_orders"], 1, "{metrics}");
    b3.stop();
}

/// The time bar and the data agree, whichever way the user drags: every seek's view carries Rust B's analysis of the
/// very step it lands on (A holds B's timeline of the recording and reads it there), with A's market state of the same
/// step -- never a neighbour's while B catches up (the user 10-31: 價量 and 大單流向 lagged the bar, worst dragging back).
#[test]
fn every_seek_of_a_drag_shows_b_s_analysis_of_the_step_it_lands_on() {
    let root = temp("replay-drag");
    write_revision(&root.join("config"), "flow_rules", 1, flow_rules(100.0));
    let dir = root.join("historical").join("source=shioaji").join("market=STK").join("trading_date=2026-09-29").join("session=DAY").join("2330");
    std::fs::create_dir_all(&dir).unwrap();
    // 09:00 to 09:49, 20 prints a second: several spans.
    let events: String = (0..60_000u64).map(|i| format!("{}\n", recorded(i + 1, 540 + (i / 1200) as i64, ((i % 1200) / 20) as i64,
        1_000_000 + (i % 7) as i64 * 500, 2))).collect();
    write_partition(&dir, &events);
    let historical = root.join("historical").to_string_lossy().into_owned();
    let stack = start_a_with(&root, &["--historical-dir", &historical]);
    let b = start_b(&stack, None);
    b.wait_line(|v| v["type"] == "metrics" && v["stream"]["connected"] == true);
    let mut viewer = Ws::connect(stack.port, VIEWER);
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": "2330", "trading_date": "2026-09-29", "session": "DAY"}}));
    let deadline = Instant::now() + SETTLE;
    let replay_id = loop {
        let m = viewer.read(deadline).expect("replay.opened");
        if m["type"] == "replay.opened" {
            assert_eq!(m["payload"]["ok"], true, "{m}");
            break m["payload"]["replay_id"].as_str().unwrap().to_string();
        }
    };
    viewer.send(json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": "2330", "trading_date": "2026-09-29",
        "session": "DAY", "replay_id": replay_id}}));
    // The view as the viewer holds it: B's spans arriving re-send it (whole or as a diff) while the build runs.
    let mut view = Value::Null;
    // B builds the whole day (60,050 steps, 241 spans) before the drag: past SETTLE in a debug build, so the
    // wait is on B's progress, not on a guess of its speed. A's status names the steps held every 250 ms; the build
    // has stalled only when no new span reaches A for SETTLE.
    let mut held = Value::Null;
    let mut quiet = Instant::now() + SETTLE;
    let mut complete = false;
    while !complete && Instant::now() < quiet {
        let Some(m) = viewer.read(quiet) else { continue };
        hold(&mut view, &m);
        let buffered = &m["payload"]["analysis"]["buffered"];
        if m["type"] != "replay.status" {
            continue;
        }
        complete = buffered["complete"] == true;
        if buffered["ranges"] != held {
            held = buffered["ranges"].clone();
            quiet = Instant::now() + SETTLE;
        }
    }
    assert!(complete, "B's whole timeline reached A (no new span for {SETTLE:?}; held {held})");
    // The drag: 80 seeks back to back, 30 s of the day each, forward from 09:05 to 09:45, then back to 09:05.
    let mut targets: Vec<i64> = (1..=80).map(|k| 5 * 60 + k * 30).collect();
    targets.extend((0..80).rev().map(|k| 5 * 60 + k * 30));
    for second in &targets {
        viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "seek",
            "at_ns": tw_ts(540 + second / 60, second % 60).to_string()}}));
    }
    let mut views = Vec::new();
    let deadline = Instant::now() + SETTLE;
    while views.len() < targets.len() && Instant::now() < deadline {
        if let Some(m) = viewer.read(deadline) {
            if hold(&mut view, &m) && m["payload"]["resync_reason"] == "REPLAY_SEEK" {
                views.push(view.clone());
            }
        }
    }
    assert_eq!(views.len(), targets.len(), "a view for every seek");
    for (second, view) in targets.iter().zip(&views) {
        let minute = 540 + second / 60;
        let traded = view["minutes"].as_array().unwrap().iter().filter(|p| p["volume"].as_f64().is_some_and(|v| v > 0.0))
            .filter_map(|p| p["minute"].as_i64()).max();
        assert_eq!(view["replay"]["analysis"]["at_position"], true, "B's analysis held at {second} s");
        assert_eq!(traded, Some(minute), "B's minutes end at the bar's minute ({second} s of the day)");
        let last_trade = view["trades"].as_array().and_then(|t| t.last()).and_then(|t| t["exchange_ts_ns"].as_str().and_then(|s| s.parse::<i64>().ok())
            .or_else(|| t["exchange_ts_ns"].as_i64()));
        assert_eq!(last_trade, Some(tw_ts(minute, second % 60)), "A's trades end at the bar too ({second} s)");
    }
    b.stop();
}
