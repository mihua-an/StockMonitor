//! What must reach disk: subscription coverage records, checkpoints, WAL retention requests and the durable shutdown.

use crate::checkpoint::{self, CheckpointBody, CHECKPOINT_SCHEMA};
use crate::contract::Role;
use crate::demand::LIVE_NEVER_STORED;
use crate::event::{
    EventFlags, InstrumentKey, MarketEvent, Payload, COVERAGE_CONTROL, COVERAGE_SUBSCRIBED, COVERAGE_UNSUBSCRIBED, EVENT_SCHEMA_VERSION,
};
use crate::remediation::{self};
use crate::rollover::{self};
use crate::wal::{self};
use crate::fsutil::atomic_write;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self};
use std::time::{Duration, Instant};
use super::{hub::*, startup::*, ingest::*};

/// Subscription coverage: what a provider's broker confirmed, as durable control records Rust B
/// reads to tell a no-trade minute from an unobserved one. Written here, by the demand/calendar owner, from the
/// adapter's report of the current plan -- never by a provider, never dated by the wall clock: each record is dated
/// to the calendar's current-or-next business session (rollover::coverage_partition) and creates no state.
pub(crate) fn write_coverage(hub: &Hub, source: &str, confirmed: BTreeSet<InstrumentKey>) {
    lock(&hub.subscriptions.desired).insert(source.to_owned(), confirmed);
    reconcile_coverage(hub);
}

pub(crate) struct PendingCoverage {
    pub(crate) source: String,
    pub(crate) instrument: InstrumentKey,
    pub(crate) state: &'static str,
    pub(crate) durable_sequence: u64,
}

/// What became of one coverage record.
pub(crate) enum CoverageWrite {
    /// handed to an attached B over the live lane (a never-stored market): written
    Delivered,
    /// queued in the WAL under this durable sequence: written once fsynced
    Queued(u64),
    /// the WAL refused it (full or failed)
    Refused,
    /// a never-stored market with no B attached to take it: tried again on the next pass
    NoReceiver,
}

pub(crate) fn apply_coverage_transition(hub: &Hub, source: &str, instrument: InstrumentKey, state: &str) {
    let mut coverage = lock(&hub.subscriptions.recorded);
    let set = coverage.entry(source.to_owned()).or_default();
    if state == COVERAGE_SUBSCRIBED { set.insert(instrument); } else { set.remove(&instrument); }
}

/// Writes every difference between what the providers confirmed and what B can read. A transition counts as written
/// only once it is durable (the WAL's committed watermark reached it) or, for a never-stored market, handed to an
/// attached B; until then it stays a difference -- a WAL that failed before the fsync drops the pending record, a
/// market with no B attached is not sent -- so the next pass (the next report, or the rollover loop each second)
/// writes it. A refusal streak is one remediation event, and its end another (`market.coverage_write_retry`).
pub(crate) fn reconcile_coverage(hub: &Hub) {
    let mut failing = lock(&hub.subscriptions.reconcile);
    // pending WAL records: durable ones become written, ones a failed WAL will never commit become differences again
    let committed = hub.wal().committed();
    let wal_failed = hub.wal().failed().is_some();
    let resolved: Vec<PendingCoverage> = {
        let mut pending = lock(&hub.subscriptions.pending);
        let (done, open): (Vec<_>, Vec<_>) = pending.drain(..).partition(|p| p.durable_sequence <= committed || wal_failed);
        *pending = open;
        done
    };
    let mut refused = 0u64;
    for p in resolved {
        if p.durable_sequence <= committed { apply_coverage_transition(hub, &p.source, p.instrument, p.state); } else { refused += 1; }
    }
    let in_flight: BTreeSet<InstrumentKey> = lock(&hub.subscriptions.pending).iter().map(|p| p.instrument.clone()).collect();
    let desired = lock(&hub.subscriptions.desired).clone();
    for (source, confirmed) in desired {
        let written = lock(&hub.subscriptions.recorded).get(&source).cloned().unwrap_or_default();
        let changes: Vec<(InstrumentKey, &'static str)> = confirmed.difference(&written).cloned().map(|k| (k, COVERAGE_SUBSCRIBED))
            .chain(written.difference(&confirmed).cloned().map(|k| (k, COVERAGE_UNSUBSCRIBED)))
            .filter(|(k, _)| !in_flight.contains(k)).collect();
        for (instrument, state) in changes {
            match write_coverage_record(hub, &instrument, state) {
                CoverageWrite::Delivered => apply_coverage_transition(hub, &source, instrument, state),
                CoverageWrite::Queued(durable_sequence) => lock(&hub.subscriptions.pending).push(PendingCoverage {
                    source: source.clone(), instrument, state, durable_sequence }),
                CoverageWrite::Refused => refused += 1,
                CoverageWrite::NoReceiver => {}
            }
        }
    }
    if refused > 0 {
        hub.counters.coverage_unwritten.fetch_add(refused, Ordering::Relaxed);
        if !*failing {
            *failing = true;
            remediation::emit(remediation::Emit { component: "subscription_coverage", mechanism_id: "market.coverage_write_retry",
                trigger_reason: "wal_refused", identity: remediation::Identity::default(), attempt: None, outcome: "failed",
                detail: json!({"refused_records": refused})});
        }
    } else if *failing {
        *failing = false;
        remediation::emit(remediation::Emit { component: "subscription_coverage", mechanism_id: "market.coverage_write_retry",
            trigger_reason: "wal_refused", identity: remediation::Identity::default(), attempt: None, outcome: "succeeded",
            detail: json!({"refused_records": 0})});
    }
}

/// One coverage control record into the WAL (or, for a never-stored market, to B over the live lane).
pub(crate) fn write_coverage_record(hub: &Hub, instrument: &InstrumentKey, state: &str) -> CoverageWrite {
    let now = now_ns() as i64;
    let partition = rollover::coverage_partition(&hub.calendar(), &hub.us_calendar.get(), &instrument.source, &instrument.market, now);
    let (trading_date, session) = partition.clone().unwrap_or_default();
    let seq = hub.subscriptions.sequence.fetch_add(1, Ordering::Relaxed) + 1;
    let event = MarketEvent {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: format!("coverage:{}:{}:{}:{}:{}", instrument.source, instrument.market, instrument.code, hub.runtime_epoch, seq),
        durable_sequence: 0, symbol: instrument.wire(), provider: instrument.source.clone(), market: instrument.market.clone(),
        code: instrument.code.clone(), session, trading_date, generation: hub.runtime_epoch, sequence: seq,
        exchange_ts_ns: now, arrival_ns: now as u64, a_received_ns: now as u64, runtime_epoch: hub.runtime_epoch,
        time_quality: COVERAGE_CONTROL.into(), trace_id: String::new(), flags: EventFlags::default(), versions: BTreeMap::new(),
        payload: Payload::SourceStatus { state: state.into(), detail: String::new() },
    };
    if partition.is_none() {
        // A never-stored market (Futu crypto) reaches B over the live lane, like its market data -- only when a B is
        // attached to take it: a broadcast to nobody is not a delivery. A B that attaches later is re-sent
        // the whole current set (forget_live_coverage at its durable.subscribe).
        if !analysis_runtime_attached(hub) {
            return CoverageWrite::NoReceiver;
        }
        send_live_to_b(hub, &event, LIVE_NEVER_STORED, None);
        hub.counters.coverage_records.fetch_add(1, Ordering::Relaxed);
        return CoverageWrite::Delivered;
    }
    let mut next = lock(&hub.lane.sequencer);
    if !hub.wal().reserve() {
        return CoverageWrite::Refused;
    }
    let mut event = event;
    let sequence = *next;
    event.durable_sequence = sequence;
    *next += 1;
    hub.wal().submit(event);
    hub.counters.coverage_records.fetch_add(1, Ordering::Relaxed);
    CoverageWrite::Queued(sequence)
}

pub(crate) fn analysis_runtime_attached(hub: &Hub) -> bool {
    hub.clients.read().unwrap().iter().any(|c| c.role == Role::AnalysisRuntime && c.wants_durable.load(Ordering::Acquire))
}

/// A B that (re)attaches holds no live-lane coverage: what was handed to an earlier B is forgotten here, so the next
/// reconcile pass sends the current never-stored coverage to this one.
pub(crate) fn forget_live_coverage(hub: &Hub) {
    let now = now_ns() as i64;
    let mut coverage = lock(&hub.subscriptions.recorded);
    for set in coverage.values_mut() {
        let us = hub.us_calendar.get();
        set.retain(|k| rollover::coverage_partition(&hub.calendar(), &us, &k.source, &k.market, now).is_some());
    }
}

pub(crate) fn capture_checkpoint(hub: &Hub) -> Result<CheckpointBody, String> {
    let started = Instant::now();
    // The image is cut under the sequencer (nothing is sequenced past `target` meanwhile) and the lock is let go at
    // once: waiting for the WAL under it stopped every ingest for as long as the disk was slow.
    let next = lock(&hub.lane.sequencer);
    let target = next.saturating_sub(1);
    // The background revision is the one the image's events were classified by: read with it, under `core`.
    let (image, evidence, background_revision, breadth_revision) = {
        let mut core = lock(&hub.core);
        core.engine.retire_stale();
        (core.engine.image(), core.evidence.image(), core.storage.revision, core.breadth.config.revision)
    };
    drop(next);
    lock(&hub.checkpointing.stats).last_capture_us = started.elapsed().as_micros() as u64;
    // A checkpoint must name a committed prefix: it waits for the WAL to commit through `target` however long the
    // disk takes (a slow sync is not a failed one); only a failed WAL or a stopping runtime ends it unwritten.
    if !hub.wal().wait_committed_while(target, || hub.lifecycle.running.load(Ordering::Acquire)) {
        let why = hub.wal().failed().map_or_else(|| "market_runtime is stopping".to_string(), |reason| format!("the WAL failed: {reason}"));
        return Err(format!("WAL did not commit through {target} ({why}); checkpoint skipped (it must match a committed prefix)"));
    }
    Ok(CheckpointBody {
        schema: CHECKPOINT_SCHEMA.into(), durable_stream_id: hub.durable_stream_id.clone(), runtime_epoch: hub.runtime_epoch,
        durable_sequence: target, background_revision, breadth_revision, written_at_ns: now_ns(), engine: image, evidence,
        voided_fingerprint: hub.voided.fingerprint(),
    })
}

pub(crate) fn write_checkpoint(hub: &Hub) -> Result<Value, String> {
    // Capture AND write under one lock: sequential captures are monotonic, so a newer image is never replaced.
    let _one = lock(&hub.checkpointing.write);
    let body = capture_checkpoint(hub).inspect_err(|e| {
        let mut s = lock(&hub.checkpointing.stats);
        s.capture_failed += 1;
        s.last_error = Some(e.clone());
        s.last = Some(json!({"ok": false, "stage": "capture", "error": e, "at_ns": now_ns().to_string()}));
    })?;
    let started = Instant::now();
    let bytes = checkpoint::write(&hub.config.data_dir, &body).map_err(|e| {
        let message = format!("checkpoint write failed at {e}");
        let mut s = lock(&hub.checkpointing.stats);
        *s.failed_by_stage.entry(e.stage).or_insert(0) += 1;
        s.last_error = Some(message.clone());
        s.last = Some(json!({"ok": false, "stage": e.stage, "error": e.error.to_string(), "at_ns": now_ns().to_string(),
                             "durable_sequence": body.durable_sequence}));
        message
    })?;
    let mut s = lock(&hub.checkpointing.stats);
    s.last_write_us = started.elapsed().as_micros() as u64;
    s.last_bytes = bytes;
    s.last_durable_sequence = body.durable_sequence;
    s.last_at_ns = now_ns();
    s.written += 1;
    s.last_error = None;
    s.last = Some(json!({"ok": true, "durable_sequence": body.durable_sequence, "bytes": bytes, "at_ns": now_ns().to_string()}));
    hub.checkpointing.events_since.store(0, Ordering::Relaxed);
    *lock(&hub.checkpointing.last) = Instant::now();
    Ok(json!({"durable_sequence": body.durable_sequence, "capture_us": s.last_capture_us, "write_us": s.last_write_us, "bytes": bytes}))
}

/// Old trading dates leave the projection cache, and their view sequences go with them once the engine holds no live
/// state for the key either (a later subscribe starts from a fresh snapshot, so nothing depends on the old sequence).
pub(crate) fn checkpoint_loop(hub: Arc<Hub>) {
    // A due checkpoint that failed is written again on the next pass; that retry is one remediation, started
    // at the first failure and finished by the write that succeeds (or abandoned at stop).
    let mut retrying: Option<(remediation::Operation, u64)> = None;
    while hub.lifecycle.running.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(500));
        let due_time = lock(&hub.checkpointing.last).elapsed() >= hub.config.checkpoint_interval;
        let due_events = hub.checkpointing.events_since.load(Ordering::Relaxed) >= hub.config.checkpoint_events;
        if (due_time && hub.checkpointing.events_since.load(Ordering::Relaxed) > 0) || due_events {
            match write_checkpoint(&hub) {
                Ok(_) => {
                    if let Some((mut operation, attempts)) = retrying.take() {
                        operation.finish("succeeded", Some(attempts + 1), json!({"committed": hub.committed()}));
                    }
                }
                Err(e) => {
                    eprintln!("checkpoint: {e}");
                    match retrying.as_mut() {
                        Some((_, attempts)) => *attempts += 1,
                        None => retrying = Some((remediation::begin("checkpoint", "market.checkpoint_write_retry", "checkpoint_write_failed",
                            remediation::Identity::default(), json!({"error": e.to_string(), "committed": hub.committed(),
                                "events_since": hub.checkpointing.events_since.load(Ordering::Relaxed)})), 1)),
                    }
                }
            }
        }
    }
    if let Some((mut operation, attempts)) = retrying.take() {
        operation.finish("abandoned", Some(attempts), json!({"reason": "market_runtime stopping"}));
    }
}

/// The durable part of a stop: flush the WAL, write the checkpoint, and mark the stop clean only when both held.
/// Runs once; the `shutdown` command runs it before acknowledging, so "acknowledged" means a clean stop (an
/// ack sent before the checkpoint would say nothing about it).
pub(crate) fn finish_shutdown(hub: &Arc<Hub>) -> Result<Value, String> {
    let mut receipt = lock(&hub.lifecycle.shutdown_receipt);
    if let Some(done) = receipt.as_ref() {
        return Ok(done.clone());
    }
    hub.lifecycle.draining.store(true, Ordering::Release);
    let flushed = hub.wal().flush(Duration::from_secs(5));
    let checkpoint = write_checkpoint(hub);
    // The session evidence files, as of the last event: a reader that runs while Market Runtime is stopped reads them.
    let evidence_written = super::evidence::flush(hub);
    // Then the writer is stopped and joined: its own last flush/fsync is part of a clean stop. Ingest is refused
    // while draining; anything submitted after this fails the WAL instead of being taken.
    let stopped = hub.wal().stop();
    let committed = match (&stopped, &flushed) {
        (Ok(at), _) | (Err(_), Ok(at)) => *at,
        (Err(_), Err(_)) => hub.committed(),
    };
    let wal_error = flushed.as_ref().err().or(stopped.as_ref().err()).map(ToString::to_string);
    let wal_failed = hub.wal().failed();
    let clean = wal_error.is_none() && checkpoint.is_ok() && wal_failed.is_none();
    // The marker is what lets the next start skip the unclean-stop recovery: one that could not be written makes
    // this stop unclean in the receipt too (the next start recovers, which is safe).
    let marker = if clean {
        let path = hub.config.data_dir.join("clean-shutdown");
        atomic_write(&path, committed.to_string().as_bytes()).map_err(|e| {
            FILE_WRITE_FAILURES.record("clean-shutdown marker", &path, &e);
            e.to_string()
        })
    } else {
        Ok(())
    };
    let done = json!({"committed": committed, "wal_flushed": flushed.is_ok(), "wal_stopped": stopped.is_ok(),
        "wal_error": wal_error, "wal_failed": wal_failed, "evidence_written": evidence_written,
        "checkpoint": checkpoint.unwrap_or_else(|e| json!({"error": e})), "clean": clean && marker.is_ok(),
        "clean_marker_error": marker.err()});
    if done["clean"] != true {
        remediation::emit(remediation::Emit { component: "shutdown", mechanism_id: "market.shutdown_incomplete",
            trigger_reason: "durable_shutdown_incomplete", identity: remediation::Identity::default(), attempt: None,
            outcome: "failed", detail: done.clone()});
    }
    *receipt = Some(done.clone());
    Ok(done)
}

/// Retention: remove the leading WAL segments whose every event is older than `before_ns`. The caller (the session
/// owner, through Health) decides the cutoff from what is materialized; A only guarantees it never removes what it
/// would itself need: a fresh checkpoint is written first and nothing after it is touched, and the segment being
/// written is never a candidate. The durable stream keeps its id: every anchor the prune can leave is registered first.
pub(crate) fn prune_wal(hub: &Hub, p: &Value) -> Value {
    let Some(before_ns) = p.get("before_ns").and_then(Value::as_i64).filter(|ns| *ns > 0) else {
        return json!({"ok": false, "reason": "before_ns required"});
    };
    let _one = lock(&hub.prune);
    if let Err(e) = write_checkpoint(hub) {
        return json!({"ok": false, "reason": format!("checkpoint first: {e}")});
    }
    // Never past the OLDEST checkpoint recovery could fall back to (a corrupt newest one falls back to the previous).
    let Some(through) = checkpoint::recoverable_sequences(&hub.config.data_dir).into_iter().min() else {
        return json!({"ok": false, "reason": "no readable checkpoint on disk"});
    };
    let wal = hub.wal();
    let candidates = wal.prune_candidates(before_ns, through);
    let before = wal.index_snapshot();
    if candidates.is_empty() {
        return json!({"ok": true, "removed_segments": 0, "removed_bytes": 0, "pruned_through": before.pruned_through,
            "checkpoint_sequence": through, "remaining_segments": before.segments.len(), "error": null});
    }
    let dir = &hub.config.data_dir;
    let identity_path = dir.join(STREAM_IDENTITY_FILE);
    // Nothing is removed unless the stored identity and every anchor the prune can leave behind were read: a skipped
    // one would make the next start see an unknown history and mint a new stream id.
    let mut anchors: Vec<Value> = match read_stream_identity(dir) {
        Ok(stored) => stored.map(|s| s.anchors.into_iter().map(Value::from).collect()).unwrap_or_default(),
        Err(e) => return json!({"ok": false, "reason": format!("stream identity unreadable: {e}")}),
    };
    let next_kept = before.segments.iter().map(|s| s.id).find(|id| !candidates.contains(id));
    for id in candidates.iter().copied().chain(next_kept) {
        match wal::segment_anchor(dir, id) {
            Ok(Some(anchor)) => {
                if !anchors.iter().any(|a| a.as_str() == Some(anchor.as_str())) {
                    anchors.push(json!(anchor));
                }
            }
            Ok(None) => {}
            Err(e) => return json!({"ok": false, "reason": format!("anchor of segment {id} unreadable: {e}")}),
        }
    }
    let keep_from = anchors.len().saturating_sub(256);
    anchors.drain(..keep_from);
    let identity = |anchor: Option<String>, anchors: &Vec<Value>| json!({"durable_stream_id": hub.durable_stream_id,
        "wal_anchor": anchor, "wal_anchors": anchors}).to_string();
    if let Err(e) = atomic_write(&identity_path, identity(before.anchor(), &anchors).as_bytes()) {
        return json!({"ok": false, "reason": format!("stream identity: {e}")});
    }
    let mut removed = Vec::new();
    let mut bytes = 0u64;
    let mut failure = None;
    for id in &candidates {
        let path = wal::segment_path(dir, *id);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        match fs::remove_file(&path) {
            Ok(()) => {
                removed.push(*id);
                bytes += size;
            }
            Err(e) => {
                failure = Some(format!("segment {id}: {e}"));
                break;
            }
        }
    }
    if let Err(e) = wal.forget_segments(&removed) {
        failure.get_or_insert(format!("index: {e}"));
    }
    let after = wal.index_snapshot();
    if let Err(e) = atomic_write(&identity_path, identity(after.anchor(), &anchors).as_bytes()) {
        // The identity written before the prune still names every anchor kept; only the new head anchor is missing.
        FILE_WRITE_FAILURES.record("stream identity after prune", &identity_path, &e);
        failure.get_or_insert(format!("stream identity after prune: {e}"));
    }
    json!({"ok": failure.is_none(), "removed_segments": removed.len(), "removed_bytes": bytes, "pruned_through": after.pruned_through,
        "checkpoint_sequence": through, "remaining_segments": after.segments.len(), "error": failure})
}
