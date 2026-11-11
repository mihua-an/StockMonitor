//! Windows ending the session (native/market_runtime/src/server/session_end.rs): A tells Health on its stdout and its
//! durable stop then comes as Health's `shutdown`, or -- Health gone -- A runs that stop itself. The console event
//! itself cannot be raised in a test (Windows sends it only at a real shutdown or logoff); what A does with it, the
//! shutdown order it registers and the module set that lets Windows send it at all are tested here.

mod support;

use market_runtime::contract::Credentials;
use market_runtime::server::session_end::{announce, install, Announced, SessionEnd};
use market_runtime::server::{self, MarketClock, ServerConfig};
use support::*;

/// A in this process, on a port of its own, serving.
fn serve(name: &str) -> (server::Running, PathBuf) {
    let root = temp_dir(name);
    let data = root.join("data");
    let credentials = Credentials::from_json(&std::fs::read_to_string(write_credentials(&root)).unwrap()).unwrap();
    let mut config = ServerConfig::new([127, 0, 0, 1].into(), 0, data.clone(), credentials);
    config.clock = MarketClock::Exchange;
    config.rollover = false;
    (server::start(config).unwrap(), data)
}

fn ingest_one(port: u16, seq: u64) {
    let mut p = Ws::connect(port, SHIOAJI).unwrap();
    ingest(&mut p, trade("shioaji", "STK", "2330", "DAY", seq, 1_000_000));
}

/// A write to Health's pipe that fails, as it does once Health has exited.
struct GonePipe;

impl Write for GonePipe {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "the pipe is being closed"))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn a_session_end_is_announced_to_health_and_a_stops_durably_on_its_shutdown() {
    let (running, data) = serve("session-end-health");
    let port = running.port;
    ingest_one(port, 1);
    let mut pipe = Vec::new();
    assert!(matches!(announce(&running.hub, SessionEnd::Shutdown, &mut pipe), Announced::ToHealth));
    let text = String::from_utf8(pipe).unwrap();
    assert!(text.ends_with('\n') && text.lines().count() == 1, "one line Health's reader splits on: {text:?}");
    let notice: Value = serde_json::from_str(text.trim_end()).unwrap();
    let mut controller = Ws::connect(port, CONTROLLER).unwrap();
    controller.send(json!({"type": "health"}));
    let health = controller.await_type("health");
    assert_eq!(notice["type"], "session_ending");
    assert_eq!(notice["payload"]["event"], "shutdown");
    assert_eq!(notice["payload"]["pid"], std::process::id());
    assert_eq!(notice["payload"]["instance_id"], health["payload"]["instance_id"]);
    // Announcing stops nothing: Health stops the providers and B first, while A still takes their last events.
    assert!(!data_clean_marker(&data).exists());
    assert!(Ws::connect(port, SHIOAJI).is_ok(), "A still serves after the announcement");
    ingest_one(port, 2);
    // Health's full shutdown reaches A last: the same `shutdown` as the tray's 完整關閉.
    let mut controller = Ws::connect(port, CONTROLLER).unwrap();
    controller.send(json!({"type": "shutdown"}));
    let ack = controller.await_type("shutdown.ack");
    assert_eq!(ack["payload"]["clean"], true, "{ack}");
    let summary = running.wait().unwrap();
    assert_eq!(summary["clean"], true);
    assert_eq!(summary["committed"], ack["payload"]["committed"]);
    assert!(summary["committed"].as_u64().unwrap() >= 2, "both events are in the WAL: {summary}");
    assert!(data_clean_marker(&data).exists());
}

#[test]
fn a_session_end_health_cannot_hear_runs_the_durable_stop_in_a() {
    let (running, data) = serve("session-end-alone");
    ingest_one(running.port, 1);
    let Announced::SelfStopped(receipt) = announce(&running.hub, SessionEnd::Logoff, &mut GonePipe) else {
        panic!("a failed notice must not leave A waiting for a shutdown nobody sends");
    };
    assert_eq!(receipt["clean"], true, "{receipt}");
    assert!(data_clean_marker(&data).exists());
    // A stopped serving: its main thread finishes and the process exits on its own, with the same receipt.
    let summary = running.wait().unwrap();
    assert_eq!(summary["clean"], true);
    assert_eq!(summary["committed"], receipt["committed"]);
}

#[cfg(windows)]
mod windows {
    use super::*;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetProcessShutdownParameters(level: *mut u32, flags: *mut u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn K32EnumProcessModules(process: isize, modules: *mut isize, bytes: u32, needed: *mut u32) -> i32;
        fn K32GetModuleBaseNameW(process: isize, module: isize, name: *mut u16, size: u32) -> u32;
    }

    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;

    #[test]
    fn install_puts_a_first_in_the_shutdown_order_without_a_retry_prompt() {
        let (running, _data) = serve("session-end-install");
        let (mut level, mut flags) = (0u32, 0u32);
        // SAFETY: two out-pointers to locals.
        assert_ne!(unsafe { GetProcessShutdownParameters(&mut level, &mut flags) }, 0);
        assert!(level < 0x300, "a test process starts in the normal range ({level:#x})");
        install(&running.hub).unwrap();
        // SAFETY: as above.
        assert_ne!(unsafe { GetProcessShutdownParameters(&mut level, &mut flags) }, 0);
        assert_eq!((level, flags), (0x3FF, 1), "first of the application range, SHUTDOWN_NORETRY");
        assert!(install(&running.hub).is_err(), "one handler per process");
    }

    fn module_names(pid: u32) -> Vec<String> {
        // SAFETY: a handle opened here and closed below; the buffers outlive the calls that fill them.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            assert_ne!(process, 0, "open the daemon process");
            let mut modules = vec![0isize; 1024];
            let mut needed = 0u32;
            let bytes = (modules.len() * std::mem::size_of::<isize>()) as u32;
            assert_ne!(K32EnumProcessModules(process, modules.as_mut_ptr(), bytes, &mut needed), 0);
            modules.truncate(needed as usize / std::mem::size_of::<isize>());
            let names = modules.iter().map(|&module| {
                let mut name = [0u16; 260];
                let len = K32GetModuleBaseNameW(process, module, name.as_mut_ptr(), name.len() as u32);
                String::from_utf16_lossy(&name[..len as usize]).to_ascii_lowercase()
            }).collect();
            CloseHandle(process);
            names
        }
    }

    /// Windows does not send a console process that loaded user32 or gdi32 its shutdown/logoff event (it is then
    /// treated as a GUI program and just ended): a dependency that pulls either in silently undoes the session end.
    #[test]
    fn the_daemon_never_loads_user32_or_gdi32() {
        let d = Daemon::start("session-end-modules", &[]);
        let names = module_names(d.child.id());
        assert!(names.iter().any(|n| n == "kernel32.dll"), "the module list was read: {names:?}");
        for gui in ["user32.dll", "gdi32.dll"] {
            assert!(!names.iter().any(|n| n == gui), "{gui} is loaded: {names:?}");
        }
        d.shutdown();
    }
}
