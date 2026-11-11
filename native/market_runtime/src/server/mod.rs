//! market_runtime server: the one intraday renderer WebSocket entry and raw-market WAL writer
//! (docs/system-architecture/01, 03, 04).
//!
//! Lock order (never inverted): `lane.sequencer` (durable sequence assignment) -> `core` (latest state, projection cache,
//! breadth, per-state view sequence) -> `clients`. Every state change and the deltas it causes are produced under
//! one `core` critical section, so a snapshot (also taken under `core`) and the deltas after it can never overlap
//! or leave a hole: the renderer sees one contiguous sequence per view.
//!
//! An ingest is answered at once with each event's durable sequence; that it reached the disk is pushed separately
//! (`event.durable`, the WAL's committed watermark, to every provider connection that subscribed), and the producer
//! holds each event until the watermark passes it. Waiting in the reply for the sync turned every slow sync (a Windows
//! shadow copy holds writes for seconds) into an unconfirmed ack the producer had to ask about again.
//!
//! Modules: `startup` (start, recovery, supervision), `hub` (shared state, delivery, health), `ingest`, `durable`
//! (coverage, checkpoints, shutdown), `retention` (rollover), `session` and `commands` (client connections),
//! `projection_publish` and `replay_feed`, `session_end` (Windows shutdown/logoff), `evidence` (the session evidence
//! commands and its files).

mod hub;
mod startup;
mod ingest;
mod durable;
mod retention;
mod session;
mod projection_publish;
mod replay_feed;
mod commands;
mod position_push;
mod analysis_state;
mod evidence;
pub mod session_end;

#[cfg(test)]
mod tests;

pub use hub::{now_ns, Hub, MarketClock, ServerConfig, PROTOCOL_VERSION, SERVICE_ID};
pub use startup::{lock_data_dir, start, Running, DATA_DIR_LOCK_FILE};
