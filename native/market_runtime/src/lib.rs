//! market_runtime (Rust A): the one intraday renderer WebSocket entry and raw-market WAL writer.
//! Spec: docs/system-architecture/01_rust_a.md, 03_protocol_and_storage.md, 04_latency_and_recovery.md.

pub mod breadth;
pub mod calendar;
pub mod checkpoint;
pub mod config_store;
pub mod cli;
pub mod contract;
pub mod demand;
pub mod event;
pub mod evidence;
pub mod fsutil;
pub mod heap;
pub mod historical_store;
pub mod historical_totals;
pub mod late_join;
pub mod latency;
pub mod outage_gap;
pub mod projection;
pub mod replay;
pub mod remediation;
pub mod rollover;
pub mod server;
pub mod sha256;
pub mod state;
pub mod storage;
pub mod timeline;
pub mod trade_pages;
pub mod us_session;
pub mod view_diff;
pub mod voided;
pub mod volume;
pub mod wal;
pub mod wal_session;
pub mod wire;
pub mod ws;

/// What a panicking thread said (its `join` error payload).
pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload.downcast_ref::<&str>().map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-text panic payload".into())
}

