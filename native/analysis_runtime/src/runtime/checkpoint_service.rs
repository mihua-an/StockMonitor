//! The checkpoint: captured on the stream thread, written by its own writer thread, retried and reported by stage.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Instant;
use market_runtime::remediation;
use serde_json::{json, Value};
use crate::{persist, timing};
use super::{shared::*, stream_runtime::*};

/// Encodes and writes checkpoints on its own thread. The stream thread is the only reader of Market Runtime's durable
/// socket: while it encoded, hashed and fsynced a 165 MB checkpoint (about 6 s, every 30 s) it read nothing, Market
/// Runtime's 5 s write timeout dropped the connection, and B reconnected and republished its whole projection --
/// about once a minute, each time re-snapshotting the viewers it touched (Futu 成交明細 stalled). The
/// stream thread therefore only captures the state (the part that must match the cursor) and hands it over.
pub(crate) struct CheckpointWriter {
    pub(crate) slot: Arc<(Mutex<WriterSlot>, Condvar)>,
    pub(crate) worker: Option<thread::JoinHandle<()>>,
    /// Outcome of the last write, shown as the status's `checkpoint`.
    pub(crate) outcome: Arc<Mutex<Option<Value>>>,
}

/// The one write the writer thread owns: at most one waiting and one being written. The stop's final
/// checkpoint replaces a write still waiting (it is newer) instead of being written after it, and the stop waits for it
/// only until Health's deadline.
#[derive(Default)]
pub(crate) struct WriterSlot {
    pub(crate) pending: Option<(persist::Body, PathBuf, u64, bool)>,
    pub(crate) busy: bool,
    pub(crate) closed: bool,
    pub(crate) final_info: Option<Value>,
}

impl CheckpointWriter {
    pub(crate) fn start(shared: Arc<Shared>) -> Self {
        let slot = Arc::new((Mutex::new(WriterSlot::default()), Condvar::new()));
        let outcome = Arc::new(Mutex::new(None));
        let (out, s) = (outcome.clone(), slot.clone());
        let worker = thread::Builder::new().name("checkpoint".into()).spawn(move || loop {
            let (lock, cv) = &*s;
            let job = {
                let mut state = lock.lock().unwrap();
                // `busy` is the one write the slot allows at a time: a waiting job is taken only when none is being
                // written, and a closed writer still writes the job it was left with.
                while !((state.pending.is_some() && !state.busy) || (state.closed && state.pending.is_none())) {
                    state = cv.wait(state).unwrap();
                }
                let Some(job) = state.pending.take() else { return };
                state.busy = true;
                job
            };
            let (body, dir, capture_us, last) = job;
            let info = write_body(&shared, &body, &dir, capture_us);
            *out.lock().unwrap() = Some(info.clone());
            let mut state = lock.lock().unwrap();
            state.busy = false;
            if last {
                state.final_info = Some(info);
            }
            cv.notify_all();
        }).expect("checkpoint thread");
        Self { slot, worker: Some(worker), outcome }
    }

    /// Hand a captured state to the writer; false when the previous one is still being written (that round is
    /// skipped, the next interval takes a newer state) or the writer has stopped.
    pub(crate) fn submit(&self, body: persist::Body, dir: &Path, capture_us: u64) -> bool {
        let (lock, cv) = &*self.slot;
        let mut state = lock.lock().unwrap();
        if state.closed || state.busy || state.pending.is_some() {
            return false;
        }
        state.pending = Some((body, dir.to_path_buf(), capture_us, false));
        cv.notify_all();
        true
    }

    /// The final checkpoint on stop, written once: it replaces a write still waiting, follows a write in flight (the
    /// process must not exit halfway through replacing checkpoint.json), and is waited for until `deadline`. Past it the
    /// answer is a receipt that says so -- B reports before Health's own limit instead of being killed mid-write.
    pub(crate) fn finish(&mut self, shared: &Shared, captured: Option<(persist::Body, u64)>, dir: &Path, deadline: Instant) -> Option<Value> {
        let _ = shared;
        let (lock, cv) = &*self.slot;
        let mut state = lock.lock().unwrap();
        state.closed = true;
        let cursor = captured.as_ref().map(|(body, _)| body.cursor);
        let wants_final = captured.is_some();
        if let Some((body, capture_us)) = captured {
            state.pending = Some((body, dir.to_path_buf(), capture_us, true));
        }
        cv.notify_all();
        loop {
            let done = if wants_final { state.final_info.is_some() } else { !state.busy && state.pending.is_none() };
            if done {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                let info = json!({"ok": false, "stage": "deadline", "error": "the final checkpoint did not finish before the stop deadline",
                                  "cursor": cursor, "in_flight": state.busy, "at_ns": now_ns()});
                *self.outcome.lock().unwrap() = Some(info.clone());
                return Some(info);
            }
            state = cv.wait_timeout(state, deadline - now).unwrap().0;
        }
        let info = state.final_info.clone();
        drop(state);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        info.or_else(|| self.outcome())
    }

    pub(crate) fn outcome(&self) -> Option<Value> {
        self.outcome.lock().unwrap().clone()
    }
}

/// One checkpoint write; its outcome is the status's `checkpoint`. A failure is counted at its stage (encode / write /
/// fsync / rotate) and logged.
pub(crate) fn write_body(shared: &Shared, body: &persist::Body, dir: &Path, capture_us: u64) -> Value {
    let started = Instant::now();
    let written = persist::encode(body).map_err(|e| ("encode", e))
        .and_then(|bytes| persist::write_bytes(dir, &bytes).map(|_| bytes.len()));
    match written {
        Ok(len) => {
            shared.counters.checkpoints.fetch_add(1, Ordering::Relaxed);
            checkpoint_written(shared, body.cursor);
            json!({"ok": true, "cursor": body.cursor, "bytes": len, "capture_us": capture_us, "write_ms": started.elapsed().as_millis() as u64,
                   "at_ns": now_ns()})
        }
        Err((stage, e)) => {
            shared.counters.checkpoint_errors.fetch_add(1, Ordering::Relaxed);
            *shared.checkpoint_failed_by_stage.lock().unwrap().entry(stage).or_insert(0) += 1;
            eprintln!("[analysis_runtime] checkpoint write failed at {stage}: {e}");
            checkpoint_not_written(shared, "checkpoint_write_failed", body.cursor, json!({"stage": stage, "error": e.to_string(), "cursor": body.cursor}));
            json!({"ok": false, "stage": stage, "error": e.to_string(), "cursor": body.cursor, "at_ns": now_ns()})
        }
    }
}

/// A due checkpoint that was not written -- its write failed, or the writer was still busy with the previous one -- is
/// one recorded `analysis.checkpoint_write_retry`, like Market Runtime's: opened by the first, each later one an
/// attempt. It remembers the newest cursor that was due and not written, and ends only when a checkpoint at or past
/// that cursor is written (or at shutdown): an older write still in flight finishing proves nothing about it.
pub(crate) fn checkpoint_not_written(shared: &Shared, trigger: &str, cursor: u64, detail: Value) {
    let mut open = shared.checkpoint_retry.lock().unwrap();
    match open.as_mut() {
        Some((_, attempts, target)) => {
            *attempts += 1;
            *target = (*target).max(cursor);
        }
        None => *open = Some((remediation::begin("checkpoint", "analysis.checkpoint_write_retry", trigger,
            remediation::Identity::default(), detail), 1, cursor)),
    }
}

/// A checkpoint at `cursor` is on disk: an open retry whose target it covers is over.
pub(crate) fn checkpoint_written(shared: &Shared, cursor: u64) {
    let mut open = shared.checkpoint_retry.lock().unwrap();
    if open.as_ref().is_some_and(|(_, _, target)| cursor >= *target) {
        if let Some((mut operation, attempts, target)) = open.take() {
            operation.finish("succeeded", Some(attempts), json!({"cursor": cursor, "target_cursor": target}));
        }
    }
}

pub(crate) fn checkpoint_retry_ended(shared: &Shared, outcome: &str, detail: Value) {
    if let Some((mut operation, attempts, target)) = shared.checkpoint_retry.lock().unwrap().take() {
        let mut detail = detail;
        detail["target_cursor"] = json!(target);
        operation.finish(outcome, Some(attempts), detail);
    }
}

/// The state a checkpoint holds, captured at the current cursor. None before the stream identity is known.
pub(crate) fn capture_checkpoint(shared: &Shared, local: &Local) -> Option<(persist::Body, u64)> {
    let started = Instant::now();
    let stream_id = shared.stream_id.lock().unwrap().clone();
    if stream_id.is_empty() {
        return None;
    }
    let body = persist::Body {
        schema: persist::SCHEMA.into(), durable_stream_id: stream_id, projection_epoch: local.projection_epoch,
        cursor: local.cursor.cursor, written_at_ns: now_ns(), engine: local.engine.checkpoint_view(),
        features: local.features.image(),
        config_label: persist::config_label(&local.engine, &local.voided), paper: local.paper.checkpoint(),
    };
    Some((body, started.elapsed().as_micros() as u64))
}

pub(crate) fn write_checkpoint(shared: &Shared, local: &mut Local, dir: &Path) {
    local.last_checkpoint = Instant::now();
    // The matching's records reach results.jsonl before the state that produced them is checkpointed; what a failed
    // write kept travels in the checkpoint (PaperDesk.unwritten) and is written after a restore.
    local.paper.flush();
    let Some((body, capture_us)) = capture_checkpoint(shared, local) else { return };
    shared.counters.checkpoints_captured.fetch_add(1, Ordering::Relaxed);
    let cursor = body.cursor;
    if !local.checkpoints.submit(body, dir, capture_us) {
        shared.counters.checkpoints_skipped_busy.fetch_add(1, Ordering::Relaxed);
        checkpoint_not_written(shared, "checkpoint_writer_busy", cursor, json!({"cursor": cursor}));
    }
}

pub(crate) fn final_checkpoint(shared: &Shared, local: &mut Local, dir: &Path) {
    // What the matching produced reaches results.jsonl before the state that produced it is checkpointed.
    local.paper.flush();
    let captured = capture_checkpoint(shared, local);
    let deadline = stop_deadline(shared);
    local.checkpoint_info = local.checkpoints.finish(shared, captured, dir, deadline).unwrap_or_else(|| local.checkpoint_info.clone());
}

/// When the stop must be answered: Health's deadline (its shutdown command), less the time the report needs; without
/// one (stdin closed: Health is gone) a bound of its own so B never hangs on exit.
pub(crate) fn stop_deadline(shared: &Shared) -> Instant {
    shared.stop_deadline.lock().unwrap().unwrap_or_else(|| Instant::now() + timing::DEFAULT_STOP_WITHIN)
}
