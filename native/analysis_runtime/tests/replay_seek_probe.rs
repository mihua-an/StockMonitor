//! 歷史回放 on a real recorded partition, Rust A and Rust B as real processes (a measurement tool, not a test of record:
//! ignored unless run on purpose). It opens the replay as the 歷史回放 page does at 13:00 and measures how long until
//! B's analysis of that step is shown and until B's whole timeline is held; then drags the bar as a hand does (a seek
//! every 16 ms, 20 s of the day each), forward and back, and checks every seek's view: B's analysis held for the step
//! it lands on and of that step -- never before the newest print the view shows, never past the bar -- and how soon
//! the view came.
//!
//!   STOCK_MONITOR_A_RELEASE=<A release dir> PROBE_HISTORICAL=D:/LM_STK PROBE_CODE=2303 PROBE_DATE=2026-10-30 \
//!     [PROBE_B_CONFIG=<the App's var/config>] [PROBE_INFERENCE_DIR=<its inference dir>] \
//!     cargo test --release --test replay_seek_probe -- --ignored --nocapture
//! PROBE_B_EXE names another B executable; by default the one built with this test. PROBE_B_LOG and PROBE_A_LOG name the
//! files B's and Market Runtime's stderr go to (Market Runtime logs each seek's time there). PROBE_DUMP names a file every
//! message the viewer reads goes to, as the render bench replays it (scripts/qa/ui_render_bench/history_run.cjs).
//! PROBE_VIEW_OUT names a file a view subscribed at the end is written to (to compare what two builds show at the same
//! step).

use market_runtime::sha256;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const VIEWER: &str = "viewer-token-000000000000000000";
const ANALYSIS: &str = "analysis-token-0000000000000000";
const CONTROLLER: &str = "controller-token-00000000000000";
const SHIOAJI: &str = "provider-shioaji-token-00000000";

struct Proc(Child);
impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Ws(TcpStream);
impl Ws {
    fn connect(port: u16, token: &str) -> Ws {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        write!(s, "GET /live HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
        let mut resp = Vec::new();
        let mut b = [0u8; 1];
        while !resp.windows(4).any(|w| w == b"\r\n\r\n") {
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
        } else {
            f.push(0x80 | 126);
            f.extend_from_slice(&(p.len() as u16).to_be_bytes());
        }
        f.extend_from_slice(&[0, 0, 0, 0]);
        f.extend_from_slice(&p);
        self.0.write_all(&f).unwrap();
    }
    fn exact(&mut self, n: usize, deadline: Instant) -> Option<Vec<u8>> {
        let mut out = vec![0u8; n];
        let mut got = 0;
        while got < n {
            if Instant::now() > deadline {
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
    /// The next message, or None when none arrived by `deadline`. A frame started is always read whole.
    fn read(&mut self, deadline: Instant) -> Option<Value> {
        self.read_raw(deadline).map(|(m, _)| m)
    }
    /// The next message and its text as it came.
    fn read_raw(&mut self, deadline: Instant) -> Option<(Value, String)> {
        let h = self.exact(2, deadline)?;
        let far = Instant::now() + Duration::from_secs(30);
        let mut len = (h[1] & 127) as usize;
        if len == 126 {
            let b = self.exact(2, far)?;
            len = u16::from_be_bytes([b[0], b[1]]) as usize;
        } else if len == 127 {
            let b = self.exact(8, far)?;
            len = u64::from_be_bytes(b.try_into().unwrap()) as usize;
        }
        let p = self.exact(len, far)?;
        let text = String::from_utf8(p).ok()?;
        Some((serde_json::from_str(&text).ok()?, text))
    }
}

fn taipei_ns(date: &str, second_of_day: i64) -> i64 {
    let p: Vec<i64> = date.split('-').map(|x| x.parse().unwrap()).collect();
    (market_runtime::event::days_from_civil(p[0], p[1], p[2]) * 86_400 + second_of_day - 8 * 3600) * 1_000_000_000
}

fn ns_of(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// A view a seek re-sent, judged: B's analysis held, and of the step shown -- its time (the day block's) at or after
/// the newest print the view holds and at or before the bar.
fn consistent(view: &Value, bar_ns: i64) -> (bool, bool) {
    let held = view["replay"]["analysis"]["at_position"] == true;
    let b = ns_of(&view["day"]["as_of_ns"]);
    let newest_print = view["trades"].as_array().and_then(|t| t.iter().filter_map(|t| ns_of(&t["exchange_ts_ns"])).max());
    let same = match (b, newest_print) {
        (Some(b), Some(a)) => b >= a && b <= bar_ns + 999_999_999,
        (Some(b), None) => b <= bar_ns + 999_999_999,
        _ => false,
    };
    (held, same)
}

/// Every message the viewer reads, as the render bench replays it (scripts/qa/ui_render_bench): one line
/// `{"t": ms since the replay opened, "raw": the message}` per message, to PROBE_DUMP when set.
struct Dump(Option<(std::io::BufWriter<std::fs::File>, Instant)>);
impl Dump {
    fn read(&mut self, viewer: &mut Ws, deadline: Instant) -> Option<(Value, usize)> {
        let (m, raw) = viewer.read_raw(deadline)?;
        if let Some((file, start)) = self.0.as_mut() {
            writeln!(file, "{}", json!({"t": start.elapsed().as_secs_f64() * 1000.0, "raw": raw})).unwrap();
        }
        Some((m, raw.len()))
    }
}

/// The view as the viewer holds it: a snapshot is the whole view, a seek's diff (`view.replay_diff`) moves the one held.
fn hold(view: &mut Value, m: &Value) {
    match m["type"].as_str() {
        Some("view.snapshot") => *view = m["payload"].clone(),
        Some("view.replay_diff") => market_runtime::view_diff::apply(view, m["payload"]["ops"].as_array().unwrap()).expect("the diff fits the view held"),
        _ => {}
    }
}

/// A seek's answer: the view re-sent whole or moved by a diff.
fn seek_answer(m: &Value) -> bool {
    (m["type"] == "view.snapshot" && m["payload"]["resync_reason"] == "REPLAY_SEEK") || m["type"] == "view.replay_diff"
}

/// A drag at a hand's pace: a seek every 16 ms from `from` to `to`, `step` seconds of the day each; every view re-sent
/// judged (`consistent`) and timed from its seek, and the size of each answer.
#[allow(clippy::too_many_arguments)]
fn drag(viewer: &mut Ws, dump: &mut Dump, view: &mut Value, replay_id: &str, date: &str, name: &str, from: i64, to: i64, step: i64) {
    let started = Instant::now();
    let mut bar = from;
    let mut sent: Vec<(i64, Instant)> = Vec::new();
    let (mut views, mut held, mut same, mut bytes, mut whole) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut sizes = Vec::new();
    let mut latency = Vec::new();
    let mut last = Instant::now() - Duration::from_millis(16);
    let deadline = |sent: &Vec<(i64, Instant)>| sent.last().map_or(Instant::now() + Duration::from_secs(5), |(_, t)| *t + Duration::from_secs(10));
    while views < sent.len() || bar != to {
        if bar != to && last.elapsed() >= Duration::from_millis(16) {
            last = Instant::now();
            bar = if step > 0 { (bar + step).min(to) } else { (bar + step).max(to) };
            viewer.send(json!({"type": "replay.control", "payload": {"replay_id": replay_id, "action": "seek", "at_ns": taipei_ns(date, bar).to_string()}}));
            sent.push((bar, Instant::now()));
        }
        if Instant::now() > deadline(&sent) {
            break;
        }
        let Some((m, size)) = dump.read(viewer, Instant::now() + Duration::from_millis(2)) else { continue };
        bytes += size;
        hold(view, &m);
        if seek_answer(&m) {
            let (second, at) = sent[views.min(sent.len() - 1)];
            latency.push(at.elapsed().as_secs_f64() * 1000.0);
            sizes.push(size);
            whole += usize::from(m["type"] == "view.snapshot");
            let (h, s) = consistent(view, taipei_ns(date, second));
            held += h as usize;
            same += (h && s) as usize;
            views += 1;
        }
    }
    latency.sort_by(f64::total_cmp);
    let pct = |p: usize| latency.get(latency.len().saturating_sub(1) * p / 100).copied().unwrap_or(f64::NAN);
    sizes.sort_unstable();
    let size = |p: usize| sizes.get(sizes.len().saturating_sub(1) * p / 100).copied().unwrap_or(0);
    println!("{{\"probe\": \"{name}\", \"seeks\": {}, \"views\": {views}, \"whole\": {whole}, \"analysis_held\": {held}, \"same_step\": {same}, \
              \"view_ms_p50\": {:.1}, \"view_ms_p90\": {:.1}, \"view_ms_max\": {:.1}, \"answer_bytes_p50\": {}, \"answer_bytes_p90\": {}, \
              \"answer_bytes_max\": {}, \"view_kb\": {}, \"drag_ms\": {}}}",
        sent.len(), pct(50), pct(90), pct(100), size(50), size(90), size(100), bytes / 1024, started.elapsed().as_millis());
}

/// The fields a view holds that say when or by which message it was sent, not what it shows.
fn shown(view: &Value) -> Value {
    let mut v = view.clone();
    if let Some(o) = v.as_object_mut() {
        for k in ["subscription_id", "request_id", "sequence", "watermark", "resync_reason", "replay", "channel_arrival_us"] {
            o.remove(k);
        }
    }
    v
}

#[test]
#[ignore]
fn replay_seek_probe() {
    let historical = std::env::var("PROBE_HISTORICAL").expect("PROBE_HISTORICAL");
    let code = std::env::var("PROBE_CODE").unwrap_or_else(|_| "2303".into());
    let date = std::env::var("PROBE_DATE").unwrap_or_else(|_| "2026-10-29".into());
    let a_exe = Path::new(&std::env::var("STOCK_MONITOR_A_RELEASE").expect("STOCK_MONITOR_A_RELEASE"))
        .join(format!("market_runtime_daemon{}", std::env::consts::EXE_SUFFIX));
    let b_exe = std::env::var("PROBE_B_EXE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_BIN_EXE_analysis_runtime")));
    let root = std::env::temp_dir().join(format!("replay-seek-probe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let creds = root.join("creds.json");
    std::fs::write(&creds, json!({"schema": "market-runtime-credentials-v1", "roles": {
        "viewer": sha256::hex(VIEWER.as_bytes()), "provider:shioaji": sha256::hex(SHIOAJI.as_bytes()),
        "analysis_runtime": sha256::hex(ANALYSIS.as_bytes()), "controller": sha256::hex(CONTROLLER.as_bytes())}}).to_string()).unwrap();
    let mut a = Proc(Command::new(&a_exe).args(["--port", "0", "--data-dir", root.join("a").to_str().unwrap(), "--credentials", creds.to_str().unwrap(),
        "--clock", "exchange", "--rollover", "off", "--config-root", root.join("config").to_str().unwrap(), "--historical-dir", &historical])
        .stdout(Stdio::piped())
        .stderr(std::env::var("PROBE_A_LOG").map_or_else(|_| Stdio::null(), |log| std::fs::File::create(log).unwrap().into())).spawn().unwrap());
    let (tx, lines) = mpsc::channel::<Value>();
    let stdout = a.0.stdout.take().unwrap();
    std::thread::spawn(move || for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            let _ = tx.send(v);
        }
    });
    let mut port = 0u16;
    while let Ok(v) = lines.recv_timeout(Duration::from_secs(30)) {
        if v["type"] == "listening" {
            port = v["port"].as_u64().unwrap() as u16;
        }
        if v["type"] == "ready" {
            break;
        }
    }
    let token = root.join("analysis.token");
    std::fs::write(&token, ANALYSIS).unwrap();
    let mut b = Command::new(&b_exe).args(["--runtime-url", &format!("ws://127.0.0.1:{port}/live"), "--token-file", token.to_str().unwrap(),
        "--data-dir", root.join("b").to_str().unwrap(), "--events-dir", root.join("events").to_str().unwrap(),
        "--config-root", &std::env::var("PROBE_B_CONFIG").unwrap_or_else(|_| root.join("config").to_string_lossy().into_owned())])
        .args(std::env::var("PROBE_INFERENCE_DIR").map(|d| vec!["--inference-dir".to_string(), d]).unwrap_or_default())
        .stdin(Stdio::piped()).stdout(Stdio::piped())
        .stderr(std::env::var("PROBE_B_LOG").map_or_else(|_| Stdio::null(), |log| std::fs::File::create(log).unwrap().into())).spawn().unwrap();
    let b_out = b.stdout.take().unwrap();
    let (btx, b_lines) = mpsc::channel::<Value>();
    std::thread::spawn(move || for line in BufReader::new(b_out).lines().map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            let _ = btx.send(v);
        }
    });
    let _b = Proc(b);
    while let Ok(v) = b_lines.recv_timeout(Duration::from_secs(30)) {
        if v["type"] == "metrics" && v["stream"]["connected"] == true {
            break;
        }
    }

    let mut viewer = Ws::connect(port, VIEWER);
    let mut dump = Dump(std::env::var("PROBE_DUMP").ok().map(|p| (std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(p).unwrap()), Instant::now())));
    let mut view = Value::Null;
    // Opened at 13:00, as the page opens a replay on its time.
    let started = Instant::now();
    viewer.send(json!({"type": "replay.open", "payload": {"market": "STK", "code": code, "trading_date": date, "session": "DAY",
        "at_ns": taipei_ns(&date, 13 * 3600).to_string()}}));
    let deadline = Instant::now() + Duration::from_secs(60);
    let opened = loop {
        let (m, _) = dump.read(&mut viewer, deadline).expect("replay.opened");
        if m["type"] == "replay.opened" {
            break m["payload"].clone();
        }
    };
    assert_eq!(opened["ok"], true, "{opened}");
    let id = opened["replay_id"].as_str().unwrap().to_string();
    let open_ms = started.elapsed().as_millis();
    let subscribe = json!({"type": "view.subscribe", "payload": {"source": "shioaji", "market": "STK", "code": code, "trading_date": date,
        "session": "DAY", "replay_id": id, "channels": ["summary", "trend", "trades", "orderbook", "tradeflow", "price_volume", "events", "signals"]}});
    viewer.send(subscribe.clone());
    let (mut analysis_ms, mut built_ms) = (None, None);
    let deadline = Instant::now() + Duration::from_secs(300);
    while built_ms.is_none() && Instant::now() < deadline {
        let Some((m, _)) = dump.read(&mut viewer, deadline) else { continue };
        hold(&mut view, &m);
        let analysis = if m["type"] == "replay.status" { &m["payload"]["analysis"] } else { &m["payload"]["replay"]["analysis"] };
        if analysis_ms.is_none() && analysis["at_position"] == true {
            analysis_ms = Some(started.elapsed().as_millis());
        }
        if analysis["buffered"]["complete"] == true {
            built_ms = Some(started.elapsed().as_millis());
        }
    }
    println!("{{\"probe\": \"open at 13:00\", \"open_ms\": {open_ms}, \"analysis_at_13_00_ms\": {analysis_ms:?}, \"timeline_built_ms\": {built_ms:?}}}");
    // Market Runtime's working set with the day's timeline held (Windows: tasklist's memory column, KB).
    let memory = Command::new("tasklist").args(["/FI", &format!("PID eq {}", a.0.id()), "/FO", "CSV", "/NH"]).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    println!("{{\"probe\": \"market runtime memory\", \"tasklist\": {}}}", json!(memory));
    drain(&mut viewer, &mut dump, &mut view, 500);
    drag(&mut viewer, &mut dump, &mut view, &id, &date, "drag forward 11:00-12:00", 11 * 3600, 12 * 3600, 20);
    drain(&mut viewer, &mut dump, &mut view, 500);
    drag(&mut viewer, &mut dump, &mut view, &id, &date, "drag back 12:00-11:00", 12 * 3600, 11 * 3600, -20);
    drain(&mut viewer, &mut dump, &mut view, 500);
    drag(&mut viewer, &mut dump, &mut view, &id, &date, "drag back fine 10:30-10:20", 10 * 3600 + 30 * 60, 10 * 3600 + 20 * 60, -1);
    drain(&mut viewer, &mut dump, &mut view, 500);
    drag(&mut viewer, &mut dump, &mut view, &id, &date, "jumps 09:10-13:20 every 2h05", 9 * 3600 + 600, 13 * 3600 + 1200, 7500);
    drain(&mut viewer, &mut dump, &mut view, 500);
    // A slow machine answers seeks seconds late: the view compared below is the last seek's (13:20), once it arrived.
    let last = taipei_ns(&date, 13 * 3600 + 1200).to_string();
    let deadline = Instant::now() + Duration::from_secs(60);
    while view["replay"]["position_ns"].as_str() != Some(last.as_str()) && Instant::now() < deadline {
        if let Some((m, _)) = dump.read(&mut viewer, deadline) {
            hold(&mut view, &m);
        }
    }
    drain(&mut viewer, &mut dump, &mut view, 500);
    // What the viewer holds after the seeks is what a view subscribed now is sent whole.
    let mut fresh = Ws::connect(port, VIEWER);
    fresh.send(subscribe);
    let deadline = Instant::now() + Duration::from_secs(10);
    let whole = loop {
        let m = fresh.read(deadline).expect("a fresh view's snapshot");
        if m["type"] == "view.snapshot" {
            break m["payload"].clone();
        }
    };
    if let Ok(out) = std::env::var("PROBE_VIEW_OUT") {
        std::fs::write(out, shown(&whole).to_string()).unwrap();
    }
    assert_eq!(shown(&view), shown(&whole), "the view moved by the seeks is the view sent whole");
    println!("{{\"probe\": \"held view equals a fresh snapshot\", \"bytes\": {}}}", whole.to_string().len());
    let _ = std::fs::remove_dir_all(&root);
}

/// Read everything already waiting so the next measurement starts clean.
fn drain(viewer: &mut Ws, dump: &mut Dump, view: &mut Value, for_ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(for_ms);
    while Instant::now() < deadline {
        if let Some((m, _)) = dump.read(viewer, deadline) {
            hold(view, &m);
        }
    }
}
