//! market_runtime process entry. Health starts it with the RESOLVED effective configuration (00 section 4): the
//! listener address, the config revision it came from, the role credential file, and the data/config roots.
//! This binary never reads network settings on its own.

use market_runtime::cli::Flags;
use market_runtime::contract::Credentials;
use market_runtime::server::{self, MarketClock, ServerConfig};
use serde_json::json;
use std::env;
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

const FLAGS: &[&str] = &[
    "--host", "--port", "--data-dir", "--credentials", "--clock", "--config-revision", "--config-root", "--historical-dir", "--rollover-cutoffs",
    "--market-holidays", "--market-sessions", "--us-trading-calendar", "--evidence-root", "--voided-events", "--rollover", "--hot-capacity", "--checkpoint-interval-s", "--wal-queue", "--clock-lag-ms",
    "--wal-segment-bytes", "--client-queue", "--test-wal-fail-after-bytes", "--test-recovery-hold-ms", "--test-provider-silence-ms",
];

/// Smallest per-client send queue: a view's first frames (snapshot, projection, breadth) must fit.
const MIN_CLIENT_QUEUE: usize = 16;

// Counts what the heap holds (metrics `heap`).
#[global_allocator]
static HEAP: market_runtime::heap::Counting = market_runtime::heap::Counting;

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let flags = Flags::parse(&args, FLAGS, &[], false)?;
    let host: IpAddr = flags.parsed("--host")?.unwrap_or(IpAddr::from([127, 0, 0, 1]));
    if !host.is_loopback() {
        return Err("market_runtime listens on loopback only".into());
    }
    // `--clock exchange` is for tests that feed a recorded session (hub.rs MarketClock); the App never passes it.
    let clock: MarketClock = flags.parsed("--clock")?.unwrap_or(MarketClock::Wall);
    // 0 (any free port, announced in the ready line) is for tests; the App passes the resolved port.
    let port: u16 = flags.parsed("--port")?.ok_or("--port is required (from the resolved network config)")?;
    let data_dir = PathBuf::from(flags.required("--data-dir")?);
    let credentials_path = flags.required("--credentials")?;
    let credentials = Credentials::from_json(&std::fs::read_to_string(credentials_path).map_err(|e| format!("credentials {credentials_path}: {e}"))?)?;
    let mut config = ServerConfig::new(host, port, data_dir, credentials);
    config.clock = clock;
    config.config_revision = flags.parsed("--config-revision")?;
    config.config_root = flags.get("--config-root").map(PathBuf::from);
    config.historical_dir = flags.get("--historical-dir").map(PathBuf::from);
    config.rollover_cutoffs = flags.get("--rollover-cutoffs").map(PathBuf::from);
    config.holidays_path = flags.get("--market-holidays").map(PathBuf::from);
    config.sessions_path = flags.get("--market-sessions").map(PathBuf::from);
    config.us_calendar_path = flags.get("--us-trading-calendar").map(PathBuf::from);
    config.evidence_root = flags.get("--evidence-root").map(PathBuf::from);
    config.voided_path = flags.get("--voided-events").map(PathBuf::from);
    config.rollover = match flags.get("--rollover") {
        Some("on") => true,
        Some("off") => false,
        Some(other) => return Err(format!("--rollover: expected on|off, got {other}")),
        None => true,
    };
    if let Some(v) = flags.at_least("--hot-capacity", 1)? {
        config.hot_capacity = v;
    }
    if let Some(v) = flags.at_least("--checkpoint-interval-s", 1)? {
        config.checkpoint_interval = Duration::from_secs(v);
    }
    if let Some(v) = flags.at_least("--wal-queue", 1)? {
        config.wal.queue_capacity = v;
    }
    if let Some(v) = flags.parsed("--clock-lag-ms")? {
        config.clock_lag = Duration::from_millis(v);
    }
    if let Some(v) = flags.at_least("--wal-segment-bytes", 1)? {
        config.wal.segment_limit = v;
    }
    if let Some(v) = flags.at_least("--client-queue", MIN_CLIENT_QUEUE)? {
        config.client_queue = v;
    }
    let test_faults = env::var("STOCK_MONITOR_TEST_FAULTS").ok().as_deref() == Some("1");
    for fault in ["--test-wal-fail-after-bytes", "--test-recovery-hold-ms", "--test-provider-silence-ms"] {
        if flags.get(fault).is_some() && !test_faults {
            return Err(format!("{fault}: test faults are refused without STOCK_MONITOR_TEST_FAULTS=1"));
        }
    }
    config.wal.fail_after_bytes = flags.parsed("--test-wal-fail-after-bytes")?;
    config.test_recovery_hold = flags.parsed("--test-recovery-hold-ms")?.map(Duration::from_millis);
    if let Some(ms) = flags.parsed("--test-provider-silence-ms")? {
        config.provider_silence = Duration::from_millis(ms);
    }
    let running = server::start(config)?;
    // Windows' shutdown/logoff reaches A alone of the App's processes; A has Health run the full shutdown.
    if let Err(e) = server::session_end::install(&running.hub) {
        eprintln!("market_runtime: Windows session end not handled ({e}); a shutdown or logoff ends A without its durable stop");
    }
    println!("{}", json!({"type": "ready", "service_id": server::SERVICE_ID, "port": running.port, "pid": std::process::id()}));
    eprintln!("market_runtime listening ws://{host}:{}/live", running.port);
    let summary = running.wait()?;
    println!("{}", json!({"type": "stopped", "summary": summary}));
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("market_runtime: {e}");
            ExitCode::from(2)
        }
    }
}
