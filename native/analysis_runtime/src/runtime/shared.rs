//! What every thread of Rust B shares: the active inference config, counters, the stream view, results on their way to the signal authority, the event archive and the baselines.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use market_runtime::remediation;
use serde_json::Value;
use crate::contract::{Direction, ModelState, SpecIdentity, WorkerConfig};
use crate::features::KeyId;
use crate::queue::TaskQueue;
use crate::{archive, baseline, contract, model};

pub(crate) const SERVICE_ID: &str = "analysis_runtime";

pub(crate) const PUBLISH_BYTES: usize = 1024 * 1024;

pub(crate) const CATCH_UP_LAG: u64 = 20_000;

pub(crate) fn now_ns() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i64).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LoadState {
    NotLoaded,
    Warmed,
    LoadFailed,
}

impl LoadState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            LoadState::NotLoaded => "NOT_LOADED",
            LoadState::Warmed => "WARMED",
            LoadState::LoadFailed => "LOAD_FAILED",
        }
    }
}

pub(crate) struct ActiveSlot {
    pub(crate) horizon_minutes: u32,
    pub(crate) direction: Direction,
    pub(crate) check: contract::ModelCheck,
    pub(crate) load: LoadState,
    pub(crate) load_reason: Option<String>,
    /// The loaded ONNX model of an Executable slot.
    pub(crate) model: Option<model::OnnxModel>,
}

impl ActiveSlot {
    /// Whether this slot's model applies to the instrument (TEST_ONLY applies everywhere; a real model only to the
    /// sources/markets it was trained on).
    pub(crate) fn covers(&self, key: &KeyId) -> bool {
        self.model.as_ref().is_none_or(|m| m.covers(&key.source, &key.market))
    }

    pub(crate) fn runnable(&self) -> bool {
        matches!(self.check.state, ModelState::Executable | ModelState::TestOnly) && self.load == LoadState::Warmed
    }

    /// Why this slot cannot run, as the code its published predictions are disabled under; None when it runs.
    pub(crate) fn refusal(&self) -> Option<String> {
        match self.check.state {
            _ if self.runnable() => None,
            ModelState::Executable | ModelState::TestOnly => Some(self.load.as_str().to_string()),
            _ => Some(self.check.refusal_code()),
        }
    }
}

pub(crate) struct ActiveConfig {
    pub(crate) config: WorkerConfig,
    pub(crate) slots: Vec<ActiveSlot>,
}

impl ActiveConfig {
    pub(crate) fn slot(&self, horizon: u32, direction: Direction) -> Option<&ActiveSlot> {
        self.slots.iter().find(|s| s.horizon_minutes == horizon && s.direction == direction)
    }
}

#[derive(Default)]
pub(crate) struct Counters {

    pub(crate) tasks_run: AtomicU64,

    pub(crate) task_ids: AtomicU64,
    pub(crate) publish_messages: AtomicU64,
    pub(crate) publish_items: AtomicU64,
    pub(crate) publish_bytes: AtomicU64,
    pub(crate) publish_acks_ok: AtomicU64,
    pub(crate) publish_acks_rejected: AtomicU64,
    pub(crate) publish_duplicate: AtomicU64,
    /// Items marked dirty again: refused for now, unanswered, or in flight on a lost connection.
    pub(crate) publish_requeued: AtomicU64,
    /// Items refused for good (an older epoch, behind what A holds, rolled over): dropped, never resent.
    pub(crate) publish_dropped: AtomicU64,
    /// Projection items Market Runtime refused for a contract reason; each is also in the log.
    pub(crate) publish_contract_refused: AtomicU64,
    pub(crate) checkpoints: AtomicU64,
    pub(crate) checkpoint_errors: AtomicU64,
    /// Interval checkpoints not taken because the previous one was still being written.
    pub(crate) checkpoints_skipped_busy: AtomicU64,
    pub(crate) checkpoints_captured: AtomicU64,
    /// Market Runtime connections lost after they were established (each one republishes the whole projection).
    pub(crate) reconnects: AtomicU64,
    pub(crate) rebuilds: AtomicU64,
    pub(crate) undecodable_events: AtomicU64,
    /// Durable events left out as void (market_runtime voided.rs).
    pub(crate) voided_events: AtomicU64,
    /// Records of an older event format (MarketEvent::refusal): refused, never applied, converted or marked as a gap.
    pub(crate) old_format_events: AtomicU64,
    /// Messages from Market Runtime that broke the stream contract (not JSON, a durable batch without `to_sequence`
    /// or with `events` that is not a list): the connection is dropped and re-subscribed from the cursor.
    pub(crate) contract_violations: AtomicU64,
}

#[derive(Default, Clone)]
pub(crate) struct StreamView {
    pub(crate) connected: bool,
    pub(crate) cursor: u64,
    pub(crate) head: u64,
    pub(crate) lag: u64,
    pub(crate) stream_id: Option<String>,
    pub(crate) runtime_epoch: Option<u64>,
    /// Projection items sent and not acknowledged yet (the outbox).
    pub(crate) publish_in_flight: usize,
    pub(crate) resets: u64,
    pub(crate) gaps: u64,
    pub(crate) permanent_holes: u64,
    pub(crate) undeclared_gaps: u64,
    pub(crate) pruned_skipped: u64,
    pub(crate) duplicates: u64,
    pub(crate) last_error: Option<String>,
    pub(crate) state: String,
    pub(crate) engine: Value,
    pub(crate) feature_keys: usize,
    pub(crate) feature_warm_keys: usize,
    pub(crate) last_checkpoint: Value,
    pub(crate) rules: Value,
    /// 模擬下單 matching: working orders, the simulated delay, write failures.
    pub(crate) paper: Value,
    /// 歷史回放 checkpoint builds kept: each recording's events gone through and whether its builder ended.
    pub(crate) replay_timelines: Value,
    pub(crate) last_publish_us: u64,
}

pub(crate) struct Shared {
    pub(crate) instance: String,
    pub(crate) spec: SpecIdentity,
    pub(crate) stop: AtomicBool,
    pub(crate) config: RwLock<Option<Arc<ActiveConfig>>>,
    pub(crate) epoch: AtomicU64,
    pub(crate) stream_id: Mutex<String>,
    pub(crate) queue: TaskQueue,
    pub(crate) results: ResultOutbox,
    /// The signal authority's health (SignalBook, owned by the stream thread) and the newest capability, for the
    /// inference status file and metrics.
    pub(crate) signals_health: Mutex<Value>,
    pub(crate) counters: Counters,
    pub(crate) view: Mutex<StreamView>,
    pub(crate) reload: AtomicBool,
    /// A new inference config arrived: schedule every warm key once instead of waiting for its next event.
    pub(crate) reschedule: AtomicBool,
    /// `ready` was told to Health: once, at the first durable subscription Market Runtime confirmed.
    pub(crate) ready_said: AtomicBool,
    pub(crate) capture: Mutex<Option<(std::io::BufWriter<std::fs::File>, String, u64, u64)>>,
    /// Startup-only settings: `workers` and `feature_capture` (path, max_rows) take effect with the first config B
    /// applies, and only then; a later config that changes them is reported here (restart required), never applied
    /// in part -- a capture first named by a later config is not opened, one already open keeps its path and limit.
    pub(crate) startup_only: Mutex<Option<Value>>,
    pub(crate) restart_required: Mutex<Vec<String>>,
    /// Whether the inference config on disk is the one running: ABSENT, APPLIED (its version) or
    /// REJECTED (why, and which version still runs). Reported in the status file, never silent.
    pub(crate) config_state: Mutex<Value>,
    /// Checkpoint write failures by stage.
    /// The open checkpoint retry, its attempts, and the newest cursor that was due and not written.
    pub(crate) checkpoint_retry: Mutex<Option<(remediation::Operation, u64, u64)>>,
    /// Market Runtime refused a projection item for a contract reason: this build and that Market Runtime
    /// disagree, which no retry fixes. Kept for the life of this instance; B reports INCOMPATIBLE and Health shows it
    /// as not serviceable instead of a RUNNING B serving a partial projection.
    pub(crate) incompatible: Mutex<Option<String>>,
    /// When the stop must be answered (Health's `shutdown` names its deadline).
    pub(crate) stop_deadline: Mutex<Option<Instant>>,
    pub(crate) checkpoint_failed_by_stage: Mutex<std::collections::BTreeMap<&'static str, u64>>,
    /// Where rule events are archived: <data-dir>/events/<trading_date>.jsonl (read back by quote_api's
    /// AnalysisEventArchive for the event feed after a restart). See archive.rs for the reliability rules (no duplicate
    /// revisions, failed writes retried, gaps reconciled against what B holds, periodic fsync).
    pub(crate) archive: Mutex<archive::Archive>,
    /// 量變's baseline files (written by the Python rollover): the reader every engine of this process shares.
    pub(crate) baselines: Arc<baseline::Store>,
}

impl Shared {
    pub(crate) fn config(&self) -> Option<Arc<ActiveConfig>> {
        self.config.read().unwrap().clone()
    }

    pub(crate) fn send_result(&self, value: Value, expires_at_ns: Option<i64>) {
        self.results.put(Outbound { value, expires_at_ns });
    }
}

/// One inference result on its way from a worker thread to the signal authority (the stream thread).
pub(crate) struct Outbound {
    pub(crate) value: Value,
    pub(crate) expires_at_ns: Option<i64>,
}

/// Completed results waiting for the signal authority: never dropped. One per slot (instrument,
/// replay, horizon, direction) -- a newer result of a slot replaces the one still waiting, which the signal book
/// would refuse as stale anyway -- so the outbox stays bounded by the slots that exist, whatever the burst.
#[derive(Default)]
pub(crate) struct ResultOutbox {
    pub(crate) pending: Mutex<HashMap<String, Outbound>>,
}

impl ResultOutbox {
    pub(crate) fn slot_of(value: &Value) -> String {
        let identity = &value["identity"];
        format!("{}|{}|{}|{}|{}|{}|{}|{}", identity["source"], identity["market"], identity["trading_date"], identity["session"],
                identity["code"], value["replay_id"], value["horizon_minutes"], value["direction"])
    }

    /// True when it replaced a waiting result of the same slot.
    pub(crate) fn put(&self, out: Outbound) -> bool {
        let slot = Self::slot_of(&out.value);
        self.pending.lock().unwrap().insert(slot, out).is_some()
    }

    pub(crate) fn drain(&self) -> Vec<Outbound> {
        let mut pending = self.pending.lock().unwrap();
        pending.drain().map(|(_, out)| out).collect()
    }
}

/// The `signals.publish` batches Market Runtime has not answered. A batch is recorded before it is sent, so a
/// send that fails half-way, or a connection lost before the answer, is still counted at the reconnect.
#[derive(Default)]
pub(crate) struct SignalAcks {
    pub(crate) unanswered: HashSet<String>,
    pub(crate) sequence: u64,
}

impl SignalAcks {
    /// The request id of the next batch, now unanswered.
    pub(crate) fn sent(&mut self) -> String {
        self.sequence += 1;
        let id = format!("signals-{}", self.sequence);
        self.unanswered.insert(id.clone());
        id
    }

    pub(crate) fn answered(&mut self, id: &str) {
        self.unanswered.remove(id);
    }

    /// A new connection: how many batches the old one left unanswered (none of them can be answered now).
    pub(crate) fn reconnected(&mut self) -> usize {
        std::mem::take(&mut self.unanswered).len()
    }
}

/// The batches of the current signals full republish: it is over only when Market Runtime answered every one
/// ok. A refusal or a lost connection ends that attempt; the next turn sends everything again as the next one.
#[derive(Default, Debug)]
pub(crate) struct RepublishBatches {
    pub(crate) open: Option<HashSet<String>>,
    pub(crate) attempts: u64,
}

impl RepublishBatches {
    pub(crate) fn begin_attempt(&mut self) {
        self.attempts += 1;
        self.open = Some(HashSet::new());
    }

    pub(crate) fn sent(&mut self, request_id: &str) {
        if let Some(open) = self.open.as_mut() {
            open.insert(request_id.to_string());
        }
    }

    pub(crate) fn answered_ok(&mut self, request_id: &str) {
        if let Some(open) = self.open.as_mut() {
            open.remove(request_id);
        }
    }

    /// The attempt failed (a batch refused, or the connection lost with batches unanswered): true when one was open.
    pub(crate) fn failed(&mut self) -> bool {
        self.open.take().is_some_and(|open| !open.is_empty())
    }

    /// Every batch of the open attempt answered ok: the attempts it took, and the record is reset.
    pub(crate) fn complete(&mut self) -> Option<u64> {
        if !self.open.as_ref().is_some_and(HashSet::is_empty) {
            return None;
        }
        self.open = None;
        Some(std::mem::take(&mut self.attempts))
    }
}

/// Batch size of one `signals.publish`.
pub(crate) const SIGNALS_BATCH_MAX: usize = 512;
