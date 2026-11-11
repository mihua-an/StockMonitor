//! Rust A/B's remediation events reach Health's ledger (health/remediation/ledger.js) over the
//! local pipe, in the shape the writer admits. Runs the real Node writer: Node is part of the App (Electron, Health),
//! so a missing `node` fails this test -- a contract that could not run is never reported as passed.

use market_runtime::remediation::{self, Emit, Identity};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const LEDGER_SCRIPT: &str = r#"
const path = require("path");
const { RemediationLedger } = require(process.argv[2]);
const root = process.argv[3];
const ledger = new RemediationLedger({ logsRoot: path.join(root, "logs"), sessionDir: path.join(root, "logs", "s"),
  summaryDir: path.join(root, "summaries"), mode: "live", pipePath: process.argv[4], logger: { log() {}, warn() {}, error() {} },
  writer: { service_id: "service_controller", instance_id: "health-test", pid: process.pid } });
ledger.start().then(() => {
  process.stdout.write(`READY ${ledger.stats.listening}\n`);
  process.stdin.on("data", (chunk) => {
    if (String(chunk).startsWith("stats")) { process.stdout.write(JSON.stringify(ledger.stats) + "\n"); return; }
    ledger.close("test").then(() => { process.stdout.write(JSON.stringify(ledger.recent) + "\n"); process.exit(0); });
  });
});
"#;

#[test]
fn rust_events_reach_the_health_ledger() {
    let version = Command::new("node").arg("--version").output()
        .expect("node is required on PATH: this test runs Health's real ledger writer");
    assert!(version.status.success(), "node --version failed: {}", String::from_utf8_lossy(&version.stderr));
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let dir = std::env::temp_dir().join(format!("remediation-pipe-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("ledger.cjs");
    std::fs::write(&script, LEDGER_SCRIPT).unwrap();
    let pipe = if cfg!(windows) {
        format!(r"\\.\pipe\stock-monitor-remediation-cargo-{}", std::process::id())
    } else {
        dir.join("ledger.sock").display().to_string()
    };
    let mut node = Command::new("node").arg(&script).arg(repo.join("health").join("remediation").join("ledger.js")).arg(&dir).arg(&pipe)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut out = BufReader::new(node.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "READY true");

    std::env::set_var(remediation::PIPE_ENV, &pipe);
    remediation::init("analysis_runtime", "ar-test-1");
    let mut op = remediation::begin("stream_loop", "analysis.a_reconnect", "recv_failed",
        Identity { connection_id: Some("ws-1".into()), ..Identity::default() }, json!({"cursor": 7, "token": "never"}));
    op.finish("succeeded", Some(2), json!({"after_sequence": 7}));
    remediation::emit(Emit { component: "wal_scan", mechanism_id: "market.wal_tail_repair", trigger_reason: "unfinished_append",
        identity: Identity::default(), attempt: None, outcome: "succeeded", detail: json!({"removed_bytes": 12}) });

    let mut stdin = node.stdin.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let stats: Value = loop {
        stdin.write_all(b"stats\n").unwrap();
        stdin.flush().unwrap();
        line.clear();
        out.read_line(&mut line).unwrap();
        let stats: Value = serde_json::from_str(&line).unwrap();
        if stats["accepted"].as_u64() == Some(3) || Instant::now() > deadline {
            break stats;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(stats["accepted"], 3, "{stats}");
    assert_eq!(stats["rejected"], 0, "{stats}");
    assert_eq!(remediation::status()["delivered"], 3);
    stdin.write_all(b"close\n").unwrap();
    stdin.flush().unwrap();
    line.clear();
    out.read_line(&mut line).unwrap();
    let recent: Vec<Value> = serde_json::from_str(&line).unwrap();
    assert_eq!(recent[0]["outcome"], "started");
    assert_eq!(recent[0]["process"]["runtime"], "rust");
    assert_eq!(recent[0]["identity"]["connection_id"], "ws-1");
    assert!(recent[0]["detail"].get("token").is_none());
    assert_eq!(recent[1]["related_upstream_event_id"], recent[0]["event_id"]);
    assert_eq!(recent[1]["attempt"], 2);
    assert_eq!(recent[2]["mechanism_id"], "market.wal_tail_repair");
    assert!(node.wait().unwrap().success(), "the ledger writer exited with an error");
    std::fs::remove_dir_all(&dir).unwrap();
}
