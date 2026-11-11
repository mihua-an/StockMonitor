//! The Hub every thread shares, its configuration and counters, and how messages reach clients; health and metrics.

use crate::breadth::MarketBreadth;
use crate::contract::{Credentials, Role};
use crate::demand::{DemandManager, StoragePolicy};
use crate::event::{
    ClockScope, InstrumentKey, StateKey,
};
use crate::latency::Latency;
use crate::projection::ProjectionCache;
use crate::replay::{ReplayCache, ReplaySession};
use crate::trade_pages::MaterializedCache;
use crate::rollover::{self, TradingCalendar};
use crate::state::Engine;
use crate::wal::{self, Integrity, WalConfig, WalWriter};
use crate::wire::Identity;
use crate::ws;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{self};
use std::net::{IpAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use super::{durable::*, commands::*};

pub const PROTOCOL_VERSION: u32 = 2;

pub const SERVICE_ID: &str = "market_runtime";

pub(crate) const DELTA_BATCH_MAX: usize = 512;

pub(crate) const REPLAY_CHUNK_EVENTS: usize = 2000;

pub(crate) const REPLAY_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// What a connection's writer may hold before its delivery loop stops producing more: one replay chunk.
pub(crate) const OUTBOUND_HIGH_WATER: usize = REPLAY_CHUNK_BYTES;

pub(crate) const SCOPE_IDLE: Duration = Duration::from_secs(3 * 3600);

pub(crate) const PROJECTION_ITEMS_PER_HOLD: usize = 64;
/// Projection entries kept per trading date behind the newest one (B itself keeps two).

pub fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().min(u64::MAX as u128) as u64
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// What the market clock and the current session follow. `wall`: the computer's clock (the App). `exchange`: the
/// newest exchange time in each scope's data, and the newest stock day held as the session -- for tests that feed a
/// recorded session that is not today, where a wall clock would declare that whole session over and turn every print
/// into a late revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketClock {
    Wall,
    Exchange,
}

impl std::str::FromStr for MarketClock {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "wall" => Ok(Self::Wall),
            "exchange" => Ok(Self::Exchange),
            other => Err(format!("expected wall|exchange, got {other}")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub host: IpAddr,
    pub port: u16,
    pub data_dir: PathBuf,
    pub credentials: Credentials,
    pub clock: MarketClock,
    pub config_revision: Option<u64>,
    /// var layout `config` root: the active background/breadth revisions are read from here at start.
    pub config_root: Option<PathBuf>,
    pub hot_capacity: usize,
    pub wal: WalConfig,
    pub checkpoint_interval: Duration,
    pub checkpoint_events: u64,
    pub client_queue: usize,
    pub clock_interval: Duration,
    /// Clock{M} is written once the wall clock passes the start of M by this much, so Rust B can finalize M-1
    /// on it without revising for prints that were still in flight at the boundary (trading_sessions.json).
    pub clock_lag: Duration,
    /// The historical materializer's output (`<data root>/historical`): what 歷史回放 plays back (see replay.rs).
    pub historical_dir: Option<PathBuf>,
    /// Where A writes its rollover cutoffs for the historical store's manager (historical_store.rs, run in B).
    pub rollover_cutoffs: Option<PathBuf>,
    /// Session rollover on the wall clock (rollover.rs). Off only in tests that feed other dates (`--rollover off`).
    pub rollover: bool,
    /// config/market_holidays.json; the copy built into the binary when absent or unreadable.
    pub holidays_path: Option<PathBuf>,
    /// The sessions that have opened and the observed closures (rollover::MarketSessions), written by A only:
    /// `<A data dir>/market_sessions.json`, named by the launcher. None: kept in memory only (tests).
    pub sessions_path: Option<PathBuf>,
    /// The US exchange calendar OpenD published, written by the Futu provider (`<DATA_ROOT>/futu/us_trading_calendar.json`,
    /// named by the launcher). None or no file yet: US trading days are weekdays.
    pub us_calendar_path: Option<PathBuf>,
    /// Where A writes each partition's session evidence (crate::evidence), named by the launcher
    /// (`<OUTPUT_ROOT>/session_evidence`). None: kept in memory only (tests).
    pub evidence_root: Option<PathBuf>,
    /// The void-event list (crate::voided, `<A data dir>/voided_events.json`), named by the launcher. None: nothing is void.
    pub voided_path: Option<PathBuf>,
    /// Tests only (`--test-recovery-hold-ms`, refused without STOCK_MONITOR_TEST_FAULTS=1): recovery ends this much later, so a
    /// test can talk to the recovering port.
    pub test_recovery_hold: Option<Duration>,
    /// A provider connection silent this long is closed (`PROVIDER_SILENCE`; shorter only in tests,
    /// `--test-provider-silence-ms`).
    pub provider_silence: Duration,
}

/// Providers use the websockets client's default keepalive, a ping every 20 s (rust_live.py, adapter_control.py), with
/// or without data. Three missed periods: a provider stalled for a few seconds (a broker login, a long GC) is left alone.
pub const PROVIDER_SILENCE: Duration = Duration::from_secs(60);

impl ServerConfig {
    pub fn new(host: IpAddr, port: u16, data_dir: PathBuf, credentials: Credentials) -> Self {
        Self {
            host, port, data_dir, credentials, clock: MarketClock::Wall, config_revision: None, config_root: None,
            hot_capacity: 4000, wal: WalConfig::default(), checkpoint_interval: Duration::from_secs(30),
            checkpoint_events: 200_000, client_queue: 16_384, clock_interval: Duration::from_millis(250),
            clock_lag: Duration::from_secs(5), historical_dir: None, rollover_cutoffs: None, rollover: true, holidays_path: None,
            sessions_path: None, us_calendar_path: None, evidence_root: None, voided_path: None, test_recovery_hold: None,
            provider_silence: PROVIDER_SILENCE,
        }
    }
}

pub(crate) struct SessionsState {
    pub(crate) sessions: rollover::MarketSessions,
    pub(crate) dirty: bool,
}

impl Hub {
    /// The sessions that have opened, read alone (never while `sessions` is held by the caller).
    pub(crate) fn opened(&self) -> rollover::Opened {
        lock(&self.sessions).sessions.opened.clone()
    }

    pub(crate) fn calendar(&self) -> std::sync::RwLockReadGuard<'_, TradingCalendar> {
        self.calendar.read().unwrap_or_else(|p| p.into_inner())
    }
}

pub(crate) struct Core {
    pub(crate) engine: Engine,
    /// The applied background list's storage half: how each ingested event is kept (ingest::install_background).
    pub(crate) storage: StoragePolicy,
    pub(crate) projection: ProjectionCache,
    pub(crate) breadth: MarketBreadth,
    pub(crate) view_seq: HashMap<StateKey, u64>,
    /// Each partition's session evidence, folded in the order events are sequenced (so the checkpoint cuts it at the
    /// image's WAL position); its files are written outside this lock (server::evidence).
    pub(crate) evidence: crate::evidence::Ledger,
    /// Codes subscribed once their session was trading, judged at their first print (late_join.rs).
    pub(crate) late_joins: crate::late_join::LateJoins,
    /// Codes of a broker connection that went down, their gaps judged from its start to their first print after it
    /// (outage_gap.rs).
    pub(crate) outage_gaps: crate::outage_gap::OutageGaps,
    /// The prints of partitions shown and never stored, which no WAL holds: their trade pages (trade_pages::LiveTapes).
    pub(crate) live_tapes: crate::trade_pages::LiveTapes,
}

#[derive(Clone)]
pub(crate) enum OutKind {
    /// `replay`: the replay this delta belongs to (None = the live market). A view only ever takes deltas of its own.
    Delta { key: StateKey, sequence: u64, replay: Option<Arc<str>> },
    Durable { from: u64, to: u64 },
    Adapter,
    /// A replay was rebuilt (seek): every view of it is re-snapshotted by its own session.
    ReplayResync(Arc<str>),
    /// A session rollover: the notice, then a new snapshot for each live view of a market that rolled (its `source|MARKET`
    /// clear family is in the set) whose partition moved under it; a view of a market that did
    /// not roll keeps its stream untouched, bound or not.
    LiveResync(Arc<HashSet<String>>),
    /// Live views bound to one of these partitions are re-snapshotted (a projection reset invalidated their blocks).
    KeysResync(Arc<HashSet<StateKey>>),
}

#[derive(Clone)]
pub(crate) struct Outgoing {
    pub(crate) kind: OutKind,
    pub(crate) bytes: Arc<Vec<u8>>,
    /// (symbol, version, backend_received_us, a_received_us) for UI latency correlation.
    /// (symbol, version, backend_received_us, a_received_us, exchange_us -- 0 when the event has no exchange time)
    pub(crate) trace: Option<(String, u64, u64, u64, u64)>,
}

pub(crate) struct ClientHandle {
    pub(crate) id: u64,
    pub(crate) role: Role,
    pub(crate) tx: SyncSender<Outgoing>,
    pub(crate) socket: Option<TcpStream>,
    pub(crate) watched: Arc<RwLock<HashSet<InstrumentKey>>>,
    /// Replay ids this client has views of (replay deltas go only to these).
    pub(crate) replays: Arc<RwLock<HashSet<String>>>,
    pub(crate) wants_durable: Arc<AtomicBool>,
    /// The session's `durable_live`: committed batches are queued only while it delivers them live.
    pub(crate) durable_live: Arc<AtomicBool>,
    /// Set by `adapter.register`: the provider's control connection, the only one its subscription plans go to (its
    /// ingest connection reads only acks and watermarks).
    pub(crate) adapter: Arc<AtomicBool>,
    pub(crate) overflowed: Arc<AtomicBool>,
    /// The cross-symbol event tape this viewer subscribed to (`events.subscribe`): (market, session).
    pub(crate) event_tape: Arc<RwLock<Option<(String, String, usize)>>>,
}

#[derive(Default)]
pub(crate) struct Counters {
    pub(crate) accepted: AtomicU64,
    /// Accepted 盤前試撮 events applied live without a WAL record (see `ingest_indicative`).
    pub(crate) indicative_live_only: AtomicU64,
    /// Accepted events of a market that is never stored (Futu crypto): applied and handed to B, no WAL record.
    pub(crate) unstored_live_only: AtomicU64,
    /// Reference events whose every stated value the partition already held: accepted, not written again.
    pub(crate) reference_already_held: AtomicU64,
    /// Accepted events of an instrument not on the background list (a searched stock, a workspace instrument):
    /// applied, shown and handed to B like the never-stored market, no WAL record (user 10-19).
    pub(crate) unlisted_live_only: AtomicU64,
    pub(crate) rejected_validation: AtomicU64,
    pub(crate) rejected_wal_full: AtomicU64,
    pub(crate) rejected_wal_failed: AtomicU64,
    pub(crate) rejected_forbidden: AtomicU64,
    pub(crate) rejected_draining: AtomicU64,
    pub(crate) rejected_parse: AtomicU64,
    pub(crate) rejected_missing_time: AtomicU64,
    pub(crate) rejected_no_session: AtomicU64,
    /// Events of a session its owner sealed (PARTITION_CLOSED): a late or re-sent event, never stored.
    pub(crate) rejected_closed_partition: AtomicU64,
    /// Prints the broker re-sent (state::PrintRepeat::Resent: the 14:30 copy of the closing print, a reconnect's copy
    /// of the last print), applied to the live state for their sequence and gap evidence but never written to the
    /// WAL (user 10-20).
    pub(crate) dropped_resent_print: AtomicU64,
    /// flags.gap_before carried by those dropped prints: each such loss is written in the copy's place as a loss
    /// record (`loss_records`), so B and the history still see it.
    pub(crate) dropped_resent_print_gap_before: AtomicU64,
    /// Loss records written (or handed to B over the live lane) for dropped copies that stated a gap.
    pub(crate) loss_records: AtomicU64,
    /// Shioaji prints whose cumulative total did not move although they are not a copy of the newest print: kept and
    /// stored as the prints they say they are; a quality problem of the source, counted (PrintRepeat::TotalNotAdvanced).
    pub(crate) total_not_advanced: AtomicU64,
    /// Envelopes or events of an older format (schema, calendar-day FUT partition): refused, never converted.
    pub(crate) rejected_old_format: AtomicU64,
    pub(crate) clock_events: AtomicU64,
    pub(crate) coverage_records: AtomicU64,
    pub(crate) rollover_rebinds: AtomicU64,
    pub(crate) coverage_unwritten: AtomicU64,
    pub(crate) slow_resyncs: AtomicU64,
    pub(crate) durable_overflow_replays: AtomicU64,
    /// Durable ranges declared undeliverable (`durable.gap`), each with its reason.
    pub(crate) durable_gaps_declared: AtomicU64,
    pub(crate) deltas_sent: AtomicU64,
    /// Deltas no subscribed view of a watching client wanted (channel filtering).
    pub(crate) deltas_filtered: AtomicU64,
    pub(crate) snapshots_sent: AtomicU64,
    /// Views re-cut onto the partition their identity now resolves to (a new session of the instrument began).
    pub(crate) view_rebinds: AtomicU64,
    pub(crate) projection_rejected: AtomicU64,
    pub(crate) commands_forbidden: AtomicU64,
    /// Longest wait for `core` on the provider ingest path (us). A provider connection answers WebSocket pings only
    /// between commands, so a wait near 20 s is what the providers' keepalive timeout reports.
    pub(crate) ingest_core_wait_max_us: AtomicU64,
    /// Longest single `core` hold while applying one B projection message, and the longest whole message (us).
    pub(crate) projection_core_hold_max_us: AtomicU64,
    pub(crate) projection_publish_max_us: AtomicU64,
    pub(crate) replays_opened: AtomicU64,
    /// Replay steps' engine verdicts, counted apart (a seek's rebuild is in the replay's own status tally).
    pub(crate) replay_events_attempted: AtomicU64,
    pub(crate) replay_events_applied: AtomicU64,
    pub(crate) replay_events_rejected: AtomicU64,
    pub(crate) replay_deltas_sent: AtomicU64,
    /// Seeks answered with what changed (`view.replay_diff`) instead of the whole view.
    pub(crate) replay_diffs_sent: AtomicU64,
    /// Timeline spans from B taken; a span of a recording no longer held; a span refused (another step layout).
    pub(crate) replay_timeline_spans: AtomicU64,
    pub(crate) replay_timeline_spans_dropped: AtomicU64,
    pub(crate) replay_timeline_spans_refused: AtomicU64,
}

#[derive(Default, Clone)]
/// Checkpoint outcomes, each counted on its own: a capture that could not match a committed WAL
/// prefix, a write that failed at a named stage (encode / write / fsync / rotate / anchor), a write that succeeded.
/// `last` is the newest actual outcome, whatever it was.
pub(crate) struct CheckpointStats {
    pub(crate) last_durable_sequence: u64,
    pub(crate) last_capture_us: u64,
    pub(crate) last_write_us: u64,
    pub(crate) last_bytes: u64,
    pub(crate) last_at_ns: u64,
    pub(crate) written: u64,
    pub(crate) capture_failed: u64,
    pub(crate) failed_by_stage: BTreeMap<&'static str, u64>,
    pub(crate) last_error: Option<String>,
    pub(crate) last: Option<Value>,
}

pub(crate) struct ScopeClock {
    pub(crate) last_minute: i32,
    pub(crate) last_activity: Instant,
    /// Newest exchange timestamp seen in the scope and when it was seen: the `exchange` market clock follows it
    /// (plus real time elapsed since).
    pub(crate) market_ns: i64,
    pub(crate) market_at: Instant,
}

impl ScopeClock {
    pub(crate) fn now_ns(&self, clock: MarketClock) -> i64 {
        if clock == MarketClock::Exchange && self.market_ns > 0 {
            self.market_ns + self.market_at.elapsed().as_nanos() as i64
        } else {
            now_ns() as i64
        }
    }
}

/// Whether the runtime serves, drains or stopped, and the durable shutdown's receipt.
pub(crate) struct Lifecycle {
    pub(crate) running: AtomicBool,
    pub(crate) draining: AtomicBool,
    /// The durable shutdown's receipt once it ran (the `shutdown` command runs it before its ack; `wait` reuses it).
    pub(crate) shutdown_receipt: Mutex<Option<Value>>,
}

/// Durable sequence assignment and the live lane: what every provider ingest goes through.
pub(crate) struct IngestLane {
    pub(crate) sequencer: Mutex<u64>,
    /// Provider ingests currently waiting for `core`. The mutex is not fair: a projection publisher that releases and
    /// re-takes `core` wins it again at once, so it steps aside explicitly while an ingest is waiting.
    pub(crate) waiting: AtomicU64,
    /// Numbers the live lane (`live.batch`) per runtime epoch, so B can tell when it lost a message. Held while the
    /// message is queued: numbering and queueing are one step, or two ingest threads could queue N+1 before N.
    pub(crate) live_sequence: Mutex<u64>,
}

/// Subscription coverage records: what is durable, what the brokers confirmed, what is in flight.
pub(crate) struct CoverageLedger {
    /// What each provider's broker last confirmed subscribed (the adapter's report for the current plan): the base
    /// the next report is diffed against to write coverage records.
    /// Per source, the instruments whose SUBSCRIBED record is durable in the WAL -- or, for a never-stored market,
    /// was handed to an attached B -- (what B reads as covered) ...
    pub(crate) recorded: Mutex<HashMap<String, BTreeSet<InstrumentKey>>>,
    /// ... and the broker-confirmed set the provider last reported. The two differ until every transition is written;
    /// a refused write stays a difference and is retried.
    pub(crate) desired: Mutex<HashMap<String, BTreeSet<InstrumentKey>>>,
    /// Transitions submitted to the WAL and not yet fsynced: one counts as written only once the WAL's
    /// committed watermark reaches its durable sequence; a WAL that failed first drops it, so it is written again.
    pub(crate) pending: Mutex<Vec<PendingCoverage>>,
    pub(crate) reconcile: Mutex<bool>,
    pub(crate) sequence: AtomicU64,
}

/// The checkpoint schedule and its outcomes.
pub(crate) struct Checkpointing {
    pub(crate) stats: Mutex<CheckpointStats>,
    /// One checkpoint write at a time: the scheduled one and wal.prune's shared a temp path and could land out of
    /// order (an older image replacing the one a prune had just relied on).
    pub(crate) write: Mutex<()>,
    pub(crate) events_since: AtomicU64,
    pub(crate) last: Mutex<Instant>,
}

/// 歷史回放: the one replay session and the id of the next.
pub(crate) struct ReplaySlot {
    /// 歷史回放: at most one at a time (user decision), never part of the live state (see replay.rs).
    /// Lock order: never taken while holding `core`, and `clients` may be taken inside it.
    pub(crate) session: Mutex<Option<ReplaySession>>,
    pub(crate) next: AtomicU64,
    /// Recordings kept with their checkpoints across replays (replay::ReplayCache). Taken after `session` when both are.
    pub(crate) cache: Mutex<ReplayCache>,
}

pub struct Hub {
    pub(crate) config: ServerConfig,
    pub(crate) instance_id: String,
    pub(crate) runtime_epoch: u64,
    pub(crate) durable_stream_id: String,
    pub(crate) stream_anchored: AtomicBool,
    pub(crate) core: Mutex<Core>,
    pub(crate) demand: Mutex<DemandManager>,
    pub(crate) latency: Mutex<Latency>,
    pub(crate) wal: OnceLock<WalWriter>,
    pub(crate) clients: RwLock<Vec<ClientHandle>>,
    pub(crate) counters: Counters,
    pub(crate) next_client: AtomicU64,
    pub(crate) next_subscription: AtomicU64,
    pub(crate) clock_scopes: Mutex<HashMap<ClockScope, ScopeClock>>,
    pub(crate) integrity: Mutex<Integrity>,
    pub(crate) recovery: Mutex<Value>,
    /// Per role: the longest stretch one connection went without reading its socket (so without answering a ping),
    /// and the command that caused it. Providers' keepalive gives up after 20 s (B13).
    pub(crate) stalls: Mutex<BTreeMap<&'static str, (u64, String)>>,
    /// One retention pass at a time.
    pub(crate) prune: Mutex<()>,
    /// Large-order window queries forwarded to B.
    pub(crate) queries: Mutex<LargeOrderQueries>,
    /// The holidays file with the observed closures; a closure observed while running is added here.
    pub(crate) calendar: RwLock<TradingCalendar>,
    /// The US exchange calendar for the Futu US rollover and coverage (`us_calendar_path`).
    pub(crate) us_calendar: rollover::FollowedUsCalendar,
    /// The sessions that have opened and the observed closures; `dirty` until written to `sessions_path` (the
    /// rollover loop writes it, never the ingest path).
    pub(crate) sessions: Mutex<SessionsState>,
    /// Per provider source: since when (ns) it has had an adapter connection to A, while it has one. A provider
    /// attaches once its broker session is logged in.
    pub(crate) broker_since: Mutex<HashMap<String, i64>>,
    /// Provider ingest connections that said who they are (`ingest.hello`), per source: while one is up its open
    /// partitions are stamped as being recorded (server::evidence).
    pub(crate) evidence_connections: Mutex<BTreeMap<String, u32>>,
    pub(crate) lifecycle: Lifecycle,
    pub(crate) lane: IngestLane,
    pub(crate) subscriptions: CoverageLedger,
    pub(crate) checkpointing: Checkpointing,
    pub(crate) replays: ReplaySlot,
    /// Materialized sessions' trade-detail rows, parsed once per content (trade_pages.rs).
    pub(crate) materialized_trades: MaterializedCache,
    /// The void events (crate::voided), read once at start: what the state, the trade tape and a WAL replay leave out.
    pub(crate) voided: Arc<crate::voided::Voided>,
}

impl Hub {
    pub(crate) fn wal(&self) -> &WalWriter {
        self.wal.get().expect("wal opened before serving")
    }
    pub(crate) fn identity(&self) -> Identity<'_> {
        Identity { stream_id: &self.instance_id, durable_stream_id: &self.durable_stream_id, runtime_epoch: self.runtime_epoch }
    }
    pub(crate) fn committed(&self) -> u64 {
        self.wal().committed()
    }
}

pub(crate) fn send_to(client: &ClientHandle, msg: Outgoing, counters: &Counters) {
    if client.overflowed.load(Ordering::Acquire) {
        return;
    }
    match client.tx.try_send(msg) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            // Never a silent stop: the session notices and resynchronizes (views) or replays from the WAL (B).
            client.overflowed.store(true, Ordering::Release);
            counters.slow_resyncs.fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

pub(crate) fn broadcast_role(hub: &Hub, role_filter: impl Fn(&ClientHandle) -> bool, msg: Outgoing) {
    for client in hub.clients.read().unwrap().iter().filter(|c| role_filter(c)) {
        send_to(client, msg.clone(), &hub.counters);
    }
}

pub(crate) fn has_watchers(hub: &Hub, instrument: &InstrumentKey) -> bool {
    hub.clients.read().unwrap().iter().any(|c| c.role == Role::Viewer && c.watched.read().unwrap().contains(instrument))
}

pub(crate) fn write_json(stream: &mut impl std::io::Write, value: &Value) -> io::Result<()> {
    ws::write_frame(stream, 1, &serde_json::to_vec(value).unwrap_or_default())
}

pub(crate) fn health(hub: &Hub) -> Value {
    // LOCK ORDER: `core` may be taken first and `clients` inside it (ingest -> emit_delta), never the reverse. The
    // `clients` guard is dropped before `core` is locked below. Holding it across `lock(&hub.core)` deadlocked A under
    // load: health held clients(read) waiting for core; ingest held core waiting for clients(read), which a
    // queued clients(write) from a connecting client blocks on Windows SRW locks -- ingest, WAL and every command stopped.
    let by_role = {
        let clients = hub.clients.read().unwrap();
        let mut by_role: BTreeMap<String, usize> = BTreeMap::new();
        for c in clients.iter() {
            *by_role.entry(c.role.table_name().to_string()).or_default() += 1;
        }
        by_role
    };
    let wal = hub.wal();
    json!({
        "status": if wal.failed().is_some() { "degraded" } else if hub.lifecycle.draining.load(Ordering::Acquire) { "draining" } else { "healthy" },
        "service_id": SERVICE_ID, "instance_id": hub.instance_id, "pid": std::process::id(), "clock": hub.config.clock,
        "protocol": PROTOCOL_VERSION, "runtime_epoch": hub.runtime_epoch, "durable_stream_id": hub.durable_stream_id,
        "config_revision": hub.config.config_revision, "host": hub.config.host.to_string(), "port": hub.config.port,
        "accepted": hub.counters.accepted.load(Ordering::Relaxed), "committed": wal.committed(),
        "wal_queue": wal.queued(), "wal_capacity": wal.capacity(), "wal_failed": wal.failed(),
        "wal_integrity": lock(&hub.integrity).status, "clients": by_role, "draining": hub.lifecycle.draining.load(Ordering::Acquire),
    })
}

pub(crate) fn metrics(hub: &Hub) -> Value {
    let c = &hub.counters;
    let load = |a: &AtomicU64| a.load(Ordering::Relaxed);
    let wal = hub.wal();
    let ws = &wal.shared.stats;
    let clients = hub.clients.read().unwrap();
    let queues: Vec<Value> = clients.iter().map(|client| json!({"id": client.id, "role": client.role.label(),
        "overflowed": client.overflowed.load(Ordering::Relaxed), "watched": client.watched.read().unwrap().len()})).collect();
    drop(clients);
    let core = lock(&hub.core);
    let projection = core.projection.stats();
    let breadth = core.breadth.wire();
    // Families held that no rollover cutoff or clear governs: nothing would ever retire them (the cutoffs
    // are the one retention authority). Expected empty; a name here is a family rollover.rs must learn.
    let ungoverned: BTreeSet<String> = core.engine.iter()
        .map(|s| rollover::family(&s.key.instrument.source, &s.key.instrument.market, &s.key.session.session))
        .filter(|f| !core.engine.rolled().contains_key(f)
            && !core.engine.cleared().contains_key(&f.rsplitn(2, '|').nth(1).unwrap_or_default().to_string()))
        .collect();
    let hot = json!({"states": core.engine.states_len(), "capacity": hub.config.hot_capacity, "over_capacity": core.engine.over_capacity(),
                     "live_only_partitions": core.engine.live_only_partitions(), "storage_revision": core.storage.revision});
    drop(core);
    let checkpoint = lock(&hub.checkpointing.stats).clone();
    json!({
        "schema": "market-runtime-metrics-v1", "service_id": SERVICE_ID, "instance_id": hub.instance_id, "sampled_at_ns": now_ns().to_string(),
        "health": health(hub),
        "ingest": {"accepted": load(&c.accepted), "indicative_live_only": load(&c.indicative_live_only), "unstored_live_only": load(&c.unstored_live_only), "reference_already_held": load(&c.reference_already_held), "unlisted_live_only": load(&c.unlisted_live_only), "rejected_validation": load(&c.rejected_validation), "rejected_wal_full": load(&c.rejected_wal_full),
                   "rejected_wal_failed": load(&c.rejected_wal_failed), "rejected_forbidden": load(&c.rejected_forbidden),
                   "rejected_draining": load(&c.rejected_draining), "rejected_parse": load(&c.rejected_parse),
                   "rejected_missing_time": load(&c.rejected_missing_time), "rejected_no_session": load(&c.rejected_no_session), "rejected_closed_partition": load(&c.rejected_closed_partition), "dropped_resent_print": load(&c.dropped_resent_print), "dropped_resent_print_gap_before": load(&c.dropped_resent_print_gap_before), "loss_records": load(&c.loss_records), "total_not_advanced": load(&c.total_not_advanced), "rejected_old_format": load(&c.rejected_old_format), "clock_events": load(&c.clock_events),
                   "coverage_records": load(&c.coverage_records), "rollover_rebinds": load(&c.rollover_rebinds), "coverage_unwritten": load(&c.coverage_unwritten),
                   "core_wait_max_us": load(&c.ingest_core_wait_max_us)},
        "wal": {"committed": wal.committed(), "pruned_through": wal.index_snapshot().pruned_through, "queue_depth": wal.queued(), "queue_capacity": wal.capacity(), "failed": wal.failed(),
                "batches": load(&ws.batches), "records": load(&ws.records), "syncs": load(&ws.syncs),
                "last_sync_us": load(&ws.last_sync_us), "max_sync_us": load(&ws.max_sync_us),
                "sync_latency": lock(&ws.sync_latency).summary("wal_flush", "wal_fsync"), "disk": wal.disk_summary(),
                "rejected_full": load(&wal.shared.rejected_full), "old_format_records_refused": load(&wal::OLD_FORMAT_RECORDS), "integrity_complete": lock(&hub.integrity).status == "COMPLETE",
                "integrity_detail": serde_json::to_value(lock(&hub.integrity).clone()).unwrap_or(Value::Null)},
        "delivery": {"deltas_sent": load(&c.deltas_sent), "deltas_filtered": load(&c.deltas_filtered), "snapshots_sent": load(&c.snapshots_sent), "view_rebinds": load(&c.view_rebinds), "slow_resyncs": load(&c.slow_resyncs),
                     "durable_overflow_replays": load(&c.durable_overflow_replays), "durable_gaps_declared": load(&c.durable_gaps_declared), "commands_forbidden": load(&c.commands_forbidden),
                     "client_queue_capacity": hub.config.client_queue, "clients": queues},
        "latency": lock(&hub.latency).summary(),
        "projection": projection, "projection_rejected": load(&c.projection_rejected),
        "projection_timing": {"core_hold_max_us": load(&c.projection_core_hold_max_us), "publish_max_us": load(&c.projection_publish_max_us)},
        "large_order_queries": lock(&hub.queries).status(),
        "demand": lock(&hub.demand).status(), "breadth": breadth, "ungoverned_families": ungoverned, "hot_states": hot,
        "checkpoint": {"last_durable_sequence": checkpoint.last_durable_sequence, "capture_us": checkpoint.last_capture_us,
                       "write_us": checkpoint.last_write_us, "bytes": checkpoint.last_bytes, "written": checkpoint.written,
                       "capture_failed": checkpoint.capture_failed, "failed_by_stage": checkpoint.failed_by_stage,
                       "last_error": checkpoint.last_error, "last": checkpoint.last,
                       "last_at_ns": (checkpoint.written > 0).then(|| checkpoint.last_at_ns.to_string()),
                       "events_since": hub.checkpointing.events_since.load(Ordering::Relaxed)},
        "recovery": lock(&hub.recovery).clone(),
        "replay": {"opened": load(&c.replays_opened), "events_attempted": load(&c.replay_events_attempted),
                   "events_applied": load(&c.replay_events_applied), "events_rejected": load(&c.replay_events_rejected), "deltas_sent": load(&c.replay_deltas_sent), "diffs_sent": load(&c.replay_diffs_sent),
                   "timeline_spans": load(&c.replay_timeline_spans), "timeline_spans_dropped": load(&c.replay_timeline_spans_dropped),
                   "timeline_spans_refused": load(&c.replay_timeline_spans_refused),
                   "active": lock(&hub.replays.session).as_ref().map(|r| r.status()), "cached": lock(&hub.replays.cache).status()},
        "connections": Value::Object(lock(&hub.stalls).iter()
            .map(|(role, (us, what))| (role.to_string(), json!({"max_command_us": us, "command": what}))).collect()),
    })
}
