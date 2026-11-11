//! Windows ending the session (shutdown, restart, logoff) -- docs/system-architecture/04 section 2.1.
//!
//! A is the one process of the App that Windows tells: Windows sends `CTRL_SHUTDOWN_EVENT` / `CTRL_LOGOFF_EVENT`
//! only to console processes that never loaded user32/gdi32. Health (Electron as Node), the Python services, B and
//! the resource sampler all load user32, so Windows ends them without a word; A (Health starts it with a
//! window-less console) loads neither. So A owns the session end, whatever else is still running: the main window,
//! or only Health and the market services after the window was closed.
//!
//! What A does is ask for the same orderly stop as the tray's 完整關閉: it tells Health on the pipe Health already
//! reads (its stdout, where `ready` and `stopped` go), and Health runs its full shutdown -- APIs, providers, B, then A's
//! own `shutdown` (WAL flush, checkpoint, clean marker, receipt) -- and exits, which ends the UI with it. A is placed
//! first in Windows' shutdown order so that everything else still runs while that happens; Windows' own deadline for
//! a console handler (`SPI_GETWAITTOKILLTIMEOUT`, 5 s by default) bounds it. Only when Health cannot be told (the
//! pipe is gone) does A run its durable stop itself.

use super::durable::finish_shutdown;
use super::hub::Hub;
use crate::remediation;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Which end of the session Windows announced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionEnd {
    Shutdown,
    Logoff,
}

impl SessionEnd {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionEnd::Shutdown => "shutdown",
            SessionEnd::Logoff => "logoff",
        }
    }
}

/// What `announce` did.
#[derive(Debug)]
pub enum Announced {
    /// Health was told; it runs the full shutdown, and A's own stop comes as its `shutdown` command.
    ToHealth,
    /// Health could not be told: A ran its durable stop itself (the receipt) and stopped serving.
    SelfStopped(Value),
}

/// The line Health reads from A's stdout (health/services/market_runtime_host.js).
pub fn notice(hub: &Hub, end: SessionEnd) -> Value {
    json!({"type": "session_ending", "payload": {"event": end.as_str(), "pid": std::process::id(), "instance_id": hub.instance_id}})
}

/// Tell Health that Windows is ending the session. A failed write means Health is gone: the stop that would have
/// come from it is run here, and the unannounced session end is recorded with the receipt.
pub fn announce(hub: &Arc<Hub>, end: SessionEnd, health: &mut dyn Write) -> Announced {
    let line = notice(hub, end).to_string();
    let written = writeln!(health, "{line}").and_then(|()| health.flush());
    let Err(error) = written else {
        return Announced::ToHealth;
    };
    eprintln!("[market_runtime] Windows {} announced; Health could not be told ({error}); running the durable stop here", end.as_str());
    let receipt = finish_shutdown(hub).unwrap_or_else(|e| json!({"clean": false, "error": e}));
    hub.lifecycle.running.store(false, Ordering::Release);
    remediation::emit(remediation::Emit { component: "session_end", mechanism_id: "market.session_end_unannounced",
        trigger_reason: "health_unreachable", identity: remediation::Identity::default(), attempt: None,
        outcome: if receipt["clean"] == true { "succeeded" } else { "failed" },
        detail: json!({"event": end.as_str(), "error": error.to_string(), "receipt": receipt})});
    Announced::SelfStopped(receipt)
}

#[cfg(windows)]
mod windows {
    use super::{announce, SessionEnd};
    use crate::server::hub::Hub;
    use std::sync::{Arc, OnceLock};

    const CTRL_LOGOFF_EVENT: u32 = 5;
    const CTRL_SHUTDOWN_EVENT: u32 = 6;
    /// The top of the range Windows reserves for applications to be shut down first (0x300-0x3FF).
    const FIRST_SHUTDOWN_LEVEL: u32 = 0x3FF;
    /// No "this app is preventing shutdown" retry: A ends when its handler is done or Windows' deadline passes.
    const SHUTDOWN_NORETRY: u32 = 0x1;

    type HandlerRoutine = unsafe extern "system" fn(u32) -> i32;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<HandlerRoutine>, add: i32) -> i32;
        fn SetProcessShutdownParameters(level: u32, flags: u32) -> i32;
    }

    static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

    pub(super) fn session_end_of(kind: u32) -> Option<SessionEnd> {
        match kind {
            CTRL_SHUTDOWN_EVENT => Some(SessionEnd::Shutdown),
            CTRL_LOGOFF_EVENT => Some(SessionEnd::Logoff),
            _ => None,
        }
    }

    /// Runs on a thread Windows creates. Ctrl+C, Ctrl+Break and closing the console keep their default handling.
    /// For a session end it does not return: returning would let Windows end A at once, before Health's shutdown
    /// reached A's own durable stop; A's main thread exits the process when that stop is done.
    unsafe extern "system" fn on_console_event(kind: u32) -> i32 {
        let (Some(end), Some(hub)) = (session_end_of(kind), HUB.get()) else {
            return 0;
        };
        announce(hub, end, &mut std::io::stdout().lock());
        loop {
            std::thread::park();
        }
    }

    pub(super) fn install(hub: &Arc<Hub>) -> Result<(), String> {
        if HUB.set(hub.clone()).is_err() {
            return Err("the session-end handler is installed once per process".into());
        }
        // SAFETY: plain Win32 calls with a 'static handler; nothing is borrowed across them.
        unsafe {
            if SetProcessShutdownParameters(FIRST_SHUTDOWN_LEVEL, SHUTDOWN_NORETRY) == 0 {
                return Err(format!("SetProcessShutdownParameters: {}", std::io::Error::last_os_error()));
            }
            if SetConsoleCtrlHandler(Some(on_console_event), 1) == 0 {
                return Err(format!("SetConsoleCtrlHandler: {}", std::io::Error::last_os_error()));
            }
        }
        Ok(())
    }
}

/// Register A for Windows' session end (shutdown order first, console handler); a no-op elsewhere.
pub fn install(hub: &Arc<Hub>) -> Result<(), String> {
    #[cfg(windows)]
    return windows::install(hub);
    #[cfg(not(windows))]
    {
        let _ = hub;
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::windows::*;
    use super::SessionEnd;

    #[test]
    fn only_shutdown_and_logoff_are_a_session_end() {
        assert_eq!(session_end_of(6), Some(SessionEnd::Shutdown));
        assert_eq!(session_end_of(5), Some(SessionEnd::Logoff));
        for other in [0, 1, 2] {
            assert_eq!(session_end_of(other), None, "Ctrl+C, Ctrl+Break and close keep their default handling");
        }
    }
}
