//! The analysis_runtime process, by subsystem. `startup` decides the mode; the daemon is `shared` state, the
//! stream thread (`stream_runtime`, `ingest`, `replay_runtime`), the inference workers (`inference_runtime`), the
//! checkpoint writer (`checkpoint_service`) and Health's stdio channel (`control_stdio`).

mod shared;
mod control_stdio;
mod inference_runtime;
mod checkpoint_service;
mod replay_runtime;
mod ingest;
mod startup;
mod stream_runtime;

#[cfg(test)]
mod tests;

pub use startup::{run_daemon, run_job};
