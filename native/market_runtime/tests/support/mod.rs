//! Shared harness of the market_runtime end-to-end tests: a daemon on a port it binds itself (port 0, read back
//! from its `listening` line -- no port is picked here and released before the daemon binds it), its stdout and
//! stderr kept and printed when a test fails, and a minimal WebSocket client.
#![allow(dead_code)]

pub use market_runtime::sha256;
pub use serde_json::{json, Value};
pub use std::io::{self, BufRead, BufReader, Read, Write};
pub use std::net::TcpStream;
pub use std::path::{Path, PathBuf};
pub use std::process::{Child, Command, Stdio};
pub use std::sync::{mpsc, Arc, Mutex};
pub use std::time::{Duration, Instant};

pub const VIEWER: &str = "viewer-token-000000000000000000";
pub const SHIOAJI: &str = "provider-shioaji-token-00000000";
pub const FUTU: &str = "provider-futu-token-000000000000";
pub const ANALYSIS: &str = "analysis-token-0000000000000000";
pub const PRODUCER: &str = "producer-token-0000000000000000";
pub const CONTROLLER: &str = "controller-token-00000000000000";
pub const SETTLE: Duration = Duration::from_secs(20);

pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mr-e2e-{name}-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn write_credentials(dir: &Path) -> PathBuf {
    let path = dir.join("credentials.json");
    let roles = json!({
        "viewer": sha256::hex(VIEWER.as_bytes()), "provider:shioaji": sha256::hex(SHIOAJI.as_bytes()),
        "provider:futu": sha256::hex(FUTU.as_bytes()), "analysis_runtime": sha256::hex(ANALYSIS.as_bytes()),
        "signal_producer": sha256::hex(PRODUCER.as_bytes()), "controller": sha256::hex(CONTROLLER.as_bytes()),
    });
    std::fs::write(&path, json!({"schema": "market-runtime-credentials-v1", "roles": roles}).to_string()).unwrap();
    path
}

pub fn data_clean_marker(data: &Path) -> PathBuf {
    data.join("clean-shutdown")
}

/// A daemon's output: every stdout and stderr line, and its stdout JSON lines as they come.
pub struct Output {
    log: Arc<Mutex<String>>,
    lines: mpsc::Receiver<Value>,
    readers: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

/// Every line of `pipe` into `log` (bytes that are not UTF-8 kept lossily: a reader that stopped at one would leave
/// the rest unread and the daemon blocked writing), each stdout one parsed onto `tx` too.
fn read_lines(pipe: impl Read + Send + 'static, tag: &'static str, log: Arc<Mutex<String>>, tx: Option<mpsc::Sender<Value>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut raw = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => {
                    log.lock().unwrap().push_str(&format!("[{tag} read failed: {e}]\n"));
                    break;
                }
            }
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\r', '\n']);
            log.lock().unwrap().push_str(&format!("[{tag}] {line}\n"));
            if let (Some(tx), Ok(value)) = (tx.as_ref(), serde_json::from_str::<Value>(line)) {
                let _ = tx.send(value);
            }
        }
    })
}

impl Output {
    pub fn capture(child: &mut Child) -> Self {
        let log = Arc::new(Mutex::new(String::new()));
        let (tx, lines) = mpsc::channel();
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let readers = vec![read_lines(stdout, "stdout", log.clone(), Some(tx)), read_lines(stderr, "stderr", log.clone(), None)];
        Self { log, lines, readers: Mutex::new(readers) }
    }

    pub fn text(&self) -> String {
        self.log.lock().unwrap().clone()
    }

    /// The whole output of a process that has exited: both pipes read to their end. A daemon that writes its reason
    /// to stderr and exits closes stdout, which ends `await_line` before the stderr reader may have appended
    /// anything: a failed start reports this, not `text`.
    pub fn finish(&self) -> String {
        for reader in self.readers.lock().unwrap().drain(..) {
            let _ = reader.join();
        }
        self.text()
    }

    /// The first stdout line of `kind` (`listening`, `ready`), or None by the deadline / when stdout closed.
    pub fn await_line(&self, kind: &str, deadline: Instant) -> Option<Value> {
        loop {
            let left = deadline.checked_duration_since(Instant::now())?;
            match self.lines.recv_timeout(left) {
                Ok(v) if v["type"] == kind => return Some(v),
                Ok(_) => {}
                Err(_) => return None,
            }
        }
    }
}

pub fn daemon_command(args: &[String]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_market_runtime_daemon"));
    // The fault flags (--test-wal-fail-after-bytes, ...) are refused without it.
    command.args(args).env("STOCK_MONITOR_TEST_FAULTS", "1").stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

pub struct Daemon {
    pub child: Child,
    pub port: u16,
    pub data: PathBuf,
    pub root: PathBuf,
    pub output: Output,
}

impl Daemon {
    pub fn start(name: &str, extra: &[&str]) -> Self {
        let root = temp_dir(name);
        let data = root.join("data");
        Self::start_in(root, data, extra)
    }

    /// Started and serving: its health no longer says "recovering".
    pub fn start_in(root: PathBuf, data: PathBuf, extra: &[&str]) -> Self {
        let daemon = Self::spawn(root, data, extra);
        let deadline = Instant::now() + SETTLE;
        while Instant::now() < deadline {
            if let Ok(mut c) = Ws::connect(daemon.port, CONTROLLER) {
                c.send(json!({"type": "health"}));
                let health = c.until(|seen| seen.iter().any(|m| m["type"] == "health"));
                if health.iter().any(|m| m["type"] == "health" && m["payload"]["status"] != "recovering") {
                    return daemon;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        daemon.fail_start("never served")
    }

    /// Started and listening (it may still be recovering): the port it bound, from its `listening` line.
    pub fn spawn(root: PathBuf, data: PathBuf, extra: &[&str]) -> Self {
        let creds = write_credentials(&root);
        let mut args = vec!["--port".to_string(), "0".into(), "--data-dir".into(), data.to_string_lossy().into_owned(),
            "--credentials".into(), creds.to_string_lossy().into_owned(), "--clock".into(), "exchange".into(),
            "--config-root".into(), root.join("config").to_string_lossy().into_owned()];
        // The fixtures are fixed dates the wall-clock rollover would drop; a test of the rollover turns it on.
        if !extra.contains(&"--rollover") {
            args.extend(["--rollover".to_string(), "off".to_string()]);
        }
        args.extend(extra.iter().map(|s| s.to_string()));
        let spawned = Instant::now();
        let mut child = daemon_command(&args).spawn().expect("spawn daemon");
        let output = Output::capture(&mut child);
        let mut daemon = Daemon { child, port: 0, data, root, output };
        match daemon.output.await_line("listening", spawned + SETTLE).and_then(|l| l["port"].as_u64()) {
            Some(port) => daemon.port = port as u16,
            None => daemon.fail_start(&format!("never listened ({:?} after spawn)", spawned.elapsed())),
        }
        daemon
    }

    #[track_caller]
    pub fn fail(&self, what: &str) -> ! {
        panic!("daemon {what}; its output:\n{}", self.output.text())
    }

    /// A start that failed: whether the daemon had exited (and how) or was still running, then its whole output.
    #[track_caller]
    fn fail_start(mut self, what: &str) -> ! {
        let state = match self.child.try_wait() {
            Ok(Some(status)) => format!("it exited: {status}"),
            Ok(None) => "it was still running; killed".to_string(),
            Err(e) => format!("its state is unknown ({e})"),
        };
        let _ = self.child.kill();
        let _ = self.child.wait();
        let text = self.output.finish();
        panic!("daemon {what}; {state}; its output:\n{text}")
    }

    #[track_caller]
    pub fn client(&self, token: &str) -> Ws {
        Ws::connect(self.port, token).unwrap_or_else(|e| self.fail(&format!("refused a connection ({e})")))
    }

    pub fn shutdown(mut self) -> (PathBuf, PathBuf) {
        let mut c = self.client(CONTROLLER);
        c.send(json!({"type": "shutdown"}));
        let asked = Instant::now();
        let seen = c.until(|seen| seen.iter().any(|m| m["type"] == "shutdown.ack"));
        // The ack waits for the WAL flush, the checkpoint and the writer's last sync: a missing one is the daemon's
        // stop to explain, so the failure carries its output and how long it was given.
        let Some(ack) = seen.iter().find(|m| m["type"] == "shutdown.ack").cloned() else {
            self.fail(&format!("did not acknowledge shutdown in {:?} (it sent {seen:?}; the read ended: {:?})", asked.elapsed(), c.ended))
        };
        // The ack follows the WAL flush and the checkpoint and says whether the stop was clean; the clean marker
        // exists exactly when it says so (a daemon whose WAL failed answers clean=false and writes none).
        let clean = ack["payload"]["clean"].as_bool().unwrap_or_else(|| panic!("no clean flag: {ack}"));
        assert!(ack["payload"]["checkpoint"].is_object(), "{ack}");
        assert_eq!(data_clean_marker(&self.data).exists(), clean, "{ack}");
        if ack["payload"]["wal_failed"].is_null() && ack["payload"]["wal_flushed"] == true {
            assert!(clean, "a healthy WAL and checkpoint is a clean stop: {ack}");
        }
        let deadline = Instant::now() + SETTLE;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.stop()
    }

    pub fn kill(mut self) -> (PathBuf, PathBuf) {
        self.stop()
    }

    fn stop(&mut self) -> (PathBuf, PathBuf) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        (self.root.clone(), self.data.clone())
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if std::thread::panicking() {
            eprintln!("--- daemon on port {} output ---\n{}", self.port, self.output.text());
        }
    }
}

pub struct Ws {
    pub stream: TcpStream,
    /// Why the last read gave nothing: the end of the stream, a socket error, or a frame that was no JSON.
    pub ended: Option<String>,
}

impl Ws {
    pub fn connect(port: u16, token: &str) -> io::Result<Self> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        stream.set_read_timeout(Some(Duration::from_millis(100)))?;
        write!(stream, "GET /live HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")?;
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        let deadline = Instant::now() + SETTLE;
        while !response.windows(4).any(|w| w == b"\r\n\r\n") {
            if Instant::now() > deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "handshake"));
            }
            match stream.read(&mut byte) {
                Ok(0) => break,
                Ok(_) => response.extend_from_slice(&byte),
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
                Err(e) => return Err(e),
            }
        }
        let text = String::from_utf8_lossy(&response).into_owned();
        if !text.starts_with("HTTP/1.1 101") {
            return Err(io::Error::other(text.lines().next().unwrap_or("").to_owned()));
        }
        Ok(Self { stream, ended: None })
    }

    pub fn send(&mut self, value: Value) {
        let payload = serde_json::to_vec(&value).unwrap();
        let mask = [1u8, 2, 3, 4];
        let mut frame = vec![0x81u8];
        if payload.len() < 126 {
            frame.push(0x80 | payload.len() as u8);
        } else if payload.len() <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream.write_all(&frame).unwrap();
    }

    fn read_exactly(&mut self, n: usize, deadline: Instant) -> Option<Vec<u8>> {
        let mut out = vec![0u8; n];
        let mut filled = 0;
        while filled < n {
            if Instant::now() > deadline {
                return None;
            }
            match self.stream.read(&mut out[filled..]) {
                Ok(0) => {
                    self.ended = Some(format!("end of stream after {filled} of {n} bytes"));
                    return None;
                }
                Ok(k) => filled += k,
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
                Err(e) => {
                    self.ended = Some(format!("read failed after {filled} of {n} bytes: kind={:?} os_error={:?}: {e}", e.kind(), e.raw_os_error()));
                    return None;
                }
            }
        }
        Some(out)
    }

    pub fn read(&mut self, deadline: Instant) -> Option<Value> {
        let h = self.read_exactly(2, deadline)?;
        let opcode = h[0] & 15;
        let mut len = (h[1] & 127) as usize;
        if len == 126 {
            let b = self.read_exactly(2, deadline)?;
            len = u16::from_be_bytes([b[0], b[1]]) as usize;
        } else if len == 127 {
            let b = self.read_exactly(8, deadline)?;
            len = u64::from_be_bytes(b.try_into().unwrap()) as usize;
        }
        let payload = if len > 0 { self.read_exactly(len, deadline)? } else { Vec::new() };
        if opcode == 8 {
            return Some(json!({"type": "__close__", "code": payload.get(..2).map(|b| u16::from_be_bytes([b[0], b[1]]))}));
        }
        match serde_json::from_slice(&payload) {
            Ok(value) => Some(value),
            Err(e) => {
                self.ended = Some(format!("frame opcode {opcode} of {len} bytes is no JSON: {e}"));
                None
            }
        }
    }

    pub fn until<F: Fn(&[Value]) -> bool>(&mut self, enough: F) -> Vec<Value> {
        let deadline = Instant::now() + SETTLE;
        let mut out = Vec::new();
        while Instant::now() < deadline && !enough(&out) {
            match self.read(deadline) {
                Some(v) => out.push(v),
                None => break,
            }
        }
        out
    }

    pub fn await_type(&mut self, wanted: &str) -> Value {
        let msgs = self.until(|seen| seen.iter().any(|m| m["type"] == wanted));
        msgs.into_iter().find(|m| m["type"] == wanted).unwrap_or_else(|| panic!("no {wanted}"))
    }

    pub fn drain(&mut self, for_ms: u64) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_millis(for_ms);
        let mut out = Vec::new();
        while Instant::now() < deadline {
            if let Some(v) = self.read(deadline) {
                out.push(v);
            }
        }
        out
    }
}

/// 2026-09-29 09:30 Taipei (epoch ns): the minute every test print of a Taipei-clock market is stamped in.
pub const TAIPEI_0930_NS: i64 = 1_790_645_400_000_000_000;
/// 2026-09-29 21:30 Taipei: inside the FUT NIGHT that opens on 2026-09-29.
pub const TAIPEI_2130_NS: i64 = TAIPEI_0930_NS + 12 * 3_600_000_000_000;
/// 2026-09-29 09:30 New York (EDT).
pub const NEW_YORK_0930_NS: i64 = 1_790_688_600_000_000_000;

/// The exchange time of a test print `seq` that Market Runtime files in `session` of 2026-09-29: the envelope names no
/// partition, so the time chooses it (a FUT NIGHT at 21:30, every other session at 09:30 of its venue).
pub fn exchange_ns_for(market: &str, session: &str, seq: u64) -> i64 {
    let base = match (market, session) {
        ("US", _) => NEW_YORK_0930_NS,
        ("FUT", "NIGHT") => TAIPEI_2130_NS,
        _ => TAIPEI_0930_NS,
    };
    base + seq as i64
}

/// A provider's print of the partition `session` of 2026-09-29 (see `exchange_ns_for`).
pub fn trade(source: &str, market: &str, code: &str, session: &str, seq: u64, price: i64) -> Value {
    let ts = exchange_ns_for(market, session, seq);
    json!({"schema": "market-event-v2", "source": source, "market": market, "code": code,
        "generation": 1, "sequence": seq, "event_type": "trade",
        "exchange_ts_ns": ts, "arrival_ns": ts as u64 + 500,
        "data": {"price": price, "volume": 1, "total_volume": seq, "side": 1, "trade_id": seq.to_string()}})
}

/// A Futu US print of the New York date `day_offset` days from 2026-09-29 (`trading_date` names that date for the
/// reader of the test; the exchange time decides it).
pub fn futu_trade(trading_date: &str, day_offset: i64, seq: u64, price: i64) -> Value {
    let mut event = trade("futu", "US", "US.NOK", "FULL", seq, price);
    let ts = NEW_YORK_0930_NS + day_offset * 86_400_000_000_000 + seq as i64;
    assert_eq!(market_runtime::event::wal_partition("futu", "US", ts).map(|p| p.0).as_deref(), Some(trading_date));
    event["exchange_ts_ns"] = json!(ts);
    event
}

pub fn ingest(p: &mut Ws, event: Value) -> Value {
    p.send(json!({"type": "event.ingest", "payload": event}));
    p.await_type("event.ack")["payload"].clone()
}

/// Wait until the WAL is on disk through `through`, as a provider learns it: the pushed `event.durable` watermark (an
/// ack says only where an event went, not that it was synced).
pub fn await_synced(p: &mut Ws, through: u64) {
    p.send(json!({"type": "event.durable.subscribe"}));
    while p.await_type("event.durable")["payload"]["committed"].as_u64().unwrap_or(0) < through {}
}

pub fn deltas(msgs: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in msgs {
        match m["type"].as_str() {
            Some("view.delta") => out.push(m["payload"].clone()),
            Some("view.delta.batch") => out.extend(m["payload"]["items"].as_array().cloned().unwrap_or_default()),
            _ => {}
        }
    }
    out
}

/// A recorded print of shioaji:STK:2330 on 2026-09-29, as the historical materializer writes it.
pub fn recorded_trade(seq: u64, ts_ns: i64, price: i64) -> Value {
    json!({"schema_version": 2, "durable_sequence": seq, "symbol": "shioaji:STK:2330", "provider": "shioaji", "market": "STK", "code": "2330",
        "session": "DAY", "trading_date": "2026-09-29", "generation": 1, "sequence": seq, "exchange_ts_ns": ts_ns, "time_quality": "exchange",
        "payload": {"kind": "trade", "price": price, "volume": 1, "total_volume": seq, "side": 1, "trade_id": seq.to_string(), "minute": 570,
            "open": 1_000_000, "high": price, "low": 1_000_000, "average": price, "total_amount": 0.0, "amount": 0.0}})
}

pub fn write_partition(root: &Path, events: &[Value]) {
    let dir = root.join("historical").join("source=shioaji").join("market=STK").join("trading_date=2026-09-29").join("session=DAY").join("2330");
    std::fs::create_dir_all(&dir).unwrap();
    let text: String = events.iter().map(|e| format!("{e}\n")).collect();
    std::fs::write(dir.join("events.jsonl"), &text).unwrap();
    // Committed: a manifest with the count and FNV-1a hash, as the materializer writes it last.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    std::fs::write(dir.join("manifest.json"), json!({"event_count": events.len(), "content_hash_fnv1a64": format!("{hash:016x}")}).to_string()).unwrap();
}

/// A replay view as its client holds it after `msgs`: a snapshot is the view whole, a seek's `view.replay_diff` moves
/// the one held. Returns the seek answers among them (either kind).
pub fn hold(view: &mut Value, msgs: &[Value]) -> Vec<Value> {
    let mut answers = Vec::new();
    for m in msgs {
        match m["type"].as_str() {
            Some("view.snapshot") => *view = m["payload"].clone(),
            Some("view.replay_diff") => market_runtime::view_diff::apply(view, m["payload"]["ops"].as_array().unwrap()).expect("the diff fits the view held"),
            _ => continue,
        }
        if m["payload"]["resync_reason"] == "REPLAY_SEEK" {
            answers.push(m.clone());
        }
    }
    answers
}

/// A seek's answer arrived among `seen`: the view re-sent whole or moved by a diff.
pub fn seek_answered(seen: &[Value]) -> bool {
    seen.iter().any(|m| (m["type"] == "view.snapshot" || m["type"] == "view.replay_diff") && m["payload"]["resync_reason"] == "REPLAY_SEEK")
}
