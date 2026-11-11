//! analysis_runtime (Rust B): an independent process managed by Health (docs/system-architecture/02, 05).
//!
//! * Consumes Market Runtime's committed durable stream with its own cursor (role `analysis_runtime`).
//! * Accumulates per-minute OHLCV, recent windows, full session, fixed K, large/small flow and rule events, and
//!   returns them to Market Runtime over the same connection (`projection.publish`), never through model_api.
//! * Folds online features and runs bounded model inference; its own signal authority (signals.rs) validates the
//!   results and publishes them to Market Runtime (`signals.publish`). Slow inference never stops accumulation.
//! * Talks to Health over stdio: JSON lines out (hello, metrics, stopped), commands in (shutdown, reload).
//!   It opens no listening port.

mod accum;
mod archive;
mod baseline;
mod baseline_publish;
pub mod cli;
mod contract;
mod cursor;
mod daily_summary;
mod day_context;
mod dataset;
mod engine;
mod events;
mod features;
mod history_gaps;
mod kbar_store;
mod materialize;
mod model;
mod outbox;
mod paper;
mod persist;
mod projection;
mod signals;
mod timing;
mod queue;
mod rules;
mod verify;
mod ws;
mod runtime;

pub use runtime::{run_daemon, run_job};
