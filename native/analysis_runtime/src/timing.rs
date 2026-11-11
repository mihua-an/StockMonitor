//! Every fixed interval and timeout of Rust B, in one place, each named for what it bounds. None of them is a
//! setting: what is configurable comes from the validated command line (the publish and checkpoint intervals, cli.rs)
//! or from Health's shutdown deadline. Each is marked as a protocol bound (others depend on it) or a cadence of B's
//! own (changing it changes only how often B does something).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

// ------------------------------------------------------------------ connection to Market Runtime (ws.rs)

/// Protocol bound: TCP connect, and each blocking write/read of the WebSocket handshake.
pub const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);
/// Cadence: how long one stream-loop turn waits for A's next frame before doing its own work.
pub const STREAM_RECV_WAIT: Duration = Duration::from_millis(100);
/// Cadence: how often the publisher connection's acknowledgements are drained while the stream is busy.
pub const PUBLISHER_DRAIN_INTERVAL: Duration = Duration::from_millis(200);

// ------------------------------------------------------------------ reconnecting

/// Why B is about to connect again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reconnect {
    /// The connection could not be opened (A not listening yet, a refused handshake).
    OpenFailed,
    /// An open connection was lost.
    Lost,
    /// A has a writer this B cannot read: it does not fix itself between two attempts, so retry slowly (A may be
    /// replaced by a compatible one).
    IncompatibleWriter,
}

impl Reconnect {
    /// How long B waits before the next attempt.
    pub fn delay(self) -> Duration {
        match self {
            Reconnect::OpenFailed => Duration::from_secs(1),
            Reconnect::Lost => Duration::from_millis(500),
            Reconnect::IncompatibleWriter => Duration::from_secs(10),
        }
    }
}

/// Cadence: how often a wait checks whether B is stopping.
const STOP_CHECK: Duration = Duration::from_millis(100);

/// Wait `delay`, returning early once `stop` is set. True when the whole delay passed.
pub fn wait_unless_stopping(stop: &AtomicBool, delay: Duration) -> bool {
    let until = Instant::now() + delay;
    while !stop.load(Ordering::Acquire) {
        let Some(left) = until.checked_duration_since(Instant::now()) else { return true };
        std::thread::sleep(left.min(STOP_CHECK));
    }
    false
}

// ------------------------------------------------------------------ B's own cadences

/// The metrics line to Health and the inference status file.
pub const STATUS_INTERVAL: Duration = Duration::from_secs(2);
/// How often the rule revisions are looked at (a Health `reload` looks at once).
pub const RULES_CHECK_INTERVAL: Duration = Duration::from_secs(2);
/// The projection publish interval while B is still catching up (caught up, the command line's interval applies).
pub const CATCH_UP_PUBLISH_INTERVAL: Duration = Duration::from_secs(2);
/// How often the inference config file is looked at.
pub const CONFIG_WATCH_INTERVAL: Duration = Duration::from_secs(1);
/// How long an idle inference worker waits for a task before checking whether B is stopping.
pub const WORKER_TASK_WAIT: Duration = Duration::from_millis(200);
/// 模擬下單: how often the order journal is read and results are written.
pub const PAPER_TURN: Duration = Duration::from_millis(100);

// ------------------------------------------------------------------ stopping

/// Protocol bound: how long B gives itself to stop when Health's shutdown named no deadline, or stdin closed.
pub const DEFAULT_STOP_WITHIN: Duration = Duration::from_secs(10);
/// How often the main thread looks whether the stream thread finished while it waits for the stop.
pub const STOP_JOIN_CHECK: Duration = Duration::from_millis(20);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnects_wait_by_cause_and_a_stop_ends_the_wait() {
        assert!(Reconnect::Lost.delay() < Reconnect::OpenFailed.delay());
        assert!(Reconnect::OpenFailed.delay() < Reconnect::IncompatibleWriter.delay());
        let stop = AtomicBool::new(false);
        assert!(wait_unless_stopping(&stop, Duration::from_millis(30)));
        stop.store(true, Ordering::Release);
        let started = Instant::now();
        assert!(!wait_unless_stopping(&stop, Reconnect::IncompatibleWriter.delay()));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
