//! One client connection: views and their snapshots, the delivery loop, overflow recovery and durable replay to B.

use crate::contract::Role;
use crate::event::{
    InstrumentKey,
    SessionKey, StateKey,
};
use crate::remediation::{self, utc_iso_ms};
use crate::rollover::{self};
use crate::wal::{self, WalIndex};
use crate::wire::{self};
use crate::ws::{self, FrameWriter};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::io;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use super::{hub::*, ingest::*, durable::*, replay_feed::*, commands::*, position_push::PositionPush, retention::rollover_notice};

pub(crate) struct View {
    pub(crate) id: String,
    /// The view.subscribe request that opened it: a client that lets go of a view before the reply names it by this.
    pub(crate) request_id: String,
    pub(crate) instrument: InstrumentKey,
    pub(crate) trading_date: Option<String>,
    pub(crate) session: Option<String>,
    pub(crate) channels: Vec<String>,
    /// The one state this view shows, fixed by its last snapshot. A view whose identity leaves the trading date (or
    /// the session) open still shows ONE partition -- the one `resolve` picks -- and only that partition's deltas
    /// are its deltas. Delivering every matching partition would mix sessions into one stream (B's
    /// republished minutes of earlier US sessions reached the Futu views of the current one).
    pub(crate) bound: Option<StateKey>,
    /// The instrument sequence (`core.view_seq`) the snapshot was cut at: deltas of `bound` at or below it are in it.
    pub(crate) baseline: u64,
    /// The view's own sequence space, the only one its client sees: every snapshot and every delivered delta takes the
    /// next number. The instrument's `view_seq` is never shown to the client: snapshots carrying `view_seq` while
    /// deltas carry this counter would, whenever the two drift, make a resync snapshot look older than the deltas already
    /// applied, and the renderer would refuse it (STALE_SNAPSHOT), freezing the view until it re-subscribed.
    pub(crate) sent_sequence: u64,
    /// Bound to this replay (歷史回放) instead of the live market.
    pub(crate) replay: Option<String>,
    /// A replay view's whole state as last sent (a snapshot, or a seek's diff applied to the one before): a seek sends
    /// what changed from it while the client holds exactly it (server::replay_feed).
    pub(crate) shown: Option<Shown>,
}

/// What a replay view's client holds: the view sent with `sequence`, of `key`.
pub(crate) struct Shown {
    pub(crate) sequence: u64,
    pub(crate) key: StateKey,
    pub(crate) view: Value,
}

impl View {
    /// Whether a delta carrying these channels is for this view. No channels subscribed = everything.
    pub(crate) fn wants(&self, delta_channels: &[Value]) -> bool {
        if self.channels.is_empty() {
            return true;
        }
        let has = |name: &str| self.channels.iter().any(|c| c == name);
        delta_channels.iter().filter_map(Value::as_str).any(|channel| match channel {
            // Source state: every view shows whether its source is connected.
            "meta" => true,
            // Rolling windows feed the summary's window fields and the big-order flow.
            "windows" => has("windows") || has("summary") || has("tradeflow"),
            other => has(other),
        })
    }
}

impl View {
    pub(crate) fn matches(&self, key: &StateKey, replay: Option<&str>) -> bool {
        self.replay.as_deref() == replay
            && self.instrument == key.instrument
            && self.trading_date.as_ref().is_none_or(|d| *d == key.session.trading_date)
            && self.session.as_ref().is_none_or(|s| s.eq_ignore_ascii_case(&key.session.session))
    }
}

/// A snapshot was just cut for this view: it now shows `key` as of instrument sequence `cut`, and the snapshot took
/// the next number of the view's own sequence.
/// The reasons a client may give for `view.resync` (the renderer's renderer.view_resync triggers).
pub(crate) const CLIENT_RESYNC_REASONS: [&str; 8] = ["snapshot_not_applied", "daemon_instance_changed", "session_generation_changed",
    "sequence_gap", "server_reset", "resync_retry", "client_request", "replay_diff_unfit"];

pub(crate) fn bind_view(view: &mut View, key: StateKey, cut: u64) {
    view.bound = Some(key);
    view.baseline = cut;
    view.sent_sequence += 1;
}

/// Whether a session rollover moved a live view's partition: the partition its identity resolves to now is not the one
/// it shows (or it shows none yet). Only such a view is re-snapshotted, not every live view at every market's
/// rollover (Futu's midnight would re-send all the Shioaji views).
pub(crate) fn rolled_under(view: &View, resolve_now: impl FnOnce() -> Option<StateKey>) -> bool {
    view.bound.is_none() || resolve_now() != view.bound
}

/// The partition a view's identity resolves to right now (live engine, or the view's replay).
pub(crate) fn resolve_view(hub: &Hub, view: &View) -> Option<StateKey> {
    match &view.replay {
        Some(id) => lock(&hub.replays.session).as_ref().filter(|r| r.id == *id)
            .and_then(|r| r.core.engine.resolve(&view.instrument, view.trading_date.as_deref(), view.session.as_deref())),
        None => lock(&hub.core).engine.resolve(&view.instrument, view.trading_date.as_deref(), view.session.as_deref()),
    }
}

pub(crate) enum DurableMode {
    Off,
    Replay { next: u64 },
    Live { last: u64 },
}

pub(crate) struct Session {
    pub(crate) id: u64,
    pub(crate) role: Role,
    pub(crate) views: Vec<View>,
    pub(crate) batch_deltas: bool,
    pub(crate) watched: Arc<RwLock<HashSet<InstrumentKey>>>,
    pub(crate) replays: Arc<RwLock<HashSet<String>>>,
    pub(crate) wants_durable: Arc<AtomicBool>,
    pub(crate) adapter: Arc<AtomicBool>,
    pub(crate) overflowed: Arc<AtomicBool>,
    pub(crate) event_tape: Arc<RwLock<Option<(String, String, usize)>>>,
    /// Changed only through `set_durable`.
    pub(crate) durable: DurableMode,
    /// `durable` is Live: only then are the committed batches queued for this connection. A consumer reading the WAL
    /// from its cursor would drop them unread, and a slow one would see its queue overflow on batches it never needed.
    pub(crate) durable_live: Arc<AtomicBool>,
    pub(crate) pending: Vec<Value>,
    pub(crate) adapter_source: Option<String>,
    /// The source whose ingest this connection carries, once it said which process it is (`ingest.hello`).
    pub(crate) ingest_source: Option<String>,
    /// Set by `event.durable.subscribe`: the WAL watermark this provider connection was last told.
    pub(crate) durable_push: Option<PositionPush>,
    pub(crate) diag: SessionDiag,
}

/// Why a connection ended, logged once when it does: time, connection and step, so a renderer disconnect can be
/// matched to the errors it lists (a 997 / 10054 / 10060 per closed connection says nothing about which one ended
/// the renderer's).
pub(crate) struct SessionDiag {
    pub(crate) opened: Instant,
    /// The step the serve loop was in; an error leaves it pointing at the step that failed.
    pub(crate) stage: &'static str,
    pub(crate) command: String,
    /// The client's own connection id (the renderer sends it in its first `health`), to join both sides' records.
    pub(crate) peer: String,
    pub(crate) last_frame_in: Option<Instant>,
    /// Close code and reason the peer sent, when it closed with a frame.
    pub(crate) peer_close: Option<(u16, String)>,
}

impl Session {
    pub(crate) fn set_durable(&mut self, mode: DurableMode) {
        self.durable_live.store(matches!(mode, DurableMode::Live { .. }), Ordering::SeqCst);
        self.durable = mode;
    }
}

pub(crate) fn log_session_end(session: &Session, result: &io::Result<()>) {
    let d = &session.diag;
    let idle = d.last_frame_in.map_or_else(|| "none".to_string(), |t| format!("{}ms", t.elapsed().as_millis()));
    let outcome = match (result, &d.peer_close) {
        (Err(e), _) => format!("error kind={:?} os_error={:?}: {e}", e.kind(), e.raw_os_error()),
        (Ok(()), Some((code, reason))) => format!("peer closed code={code} reason={reason:?}"),
        (Ok(()), None) => "ended".to_string(),
    };
    eprintln!("client closed at={} session={} role={} peer={} age_ms={} stage={} command={} last_frame_in={} overflowed={} views={}: {outcome}",
        utc_iso_ms(now_ns()), session.id, session.role.label(), if d.peer.is_empty() { "-" } else { &d.peer },
        d.opened.elapsed().as_millis(), d.stage, if d.command.is_empty() { "-" } else { &d.command }, idle,
        session.overflowed.load(Ordering::Acquire), session.views.len());
}

pub(crate) fn identity_field(p: &Value, name: &str) -> Option<String> {
    let raw = p.get(name).and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(if name == "session" { raw.to_uppercase() } else { raw.to_owned() })
}

pub(crate) use crate::event::source_for_market;

pub(crate) fn instrument_from(p: &Value) -> Option<InstrumentKey> {
    // A symbol names an instrument only as source:MARKET:CODE (InstrumentKey::parse); any other form names none.
    if let Some(s) = p.get("symbol").and_then(Value::as_str) {
        return InstrumentKey::parse(s);
    }
    let market = p.get("market").and_then(Value::as_str)?;
    let code = p.get("code").and_then(Value::as_str)?;
    let source = p.get("source").and_then(Value::as_str).unwrap_or_else(|| source_for_market(market));
    Some(InstrumentKey::new(source, market, code))
}

pub(crate) fn channels_from(p: &Value) -> Vec<String> {
    let mut c: Vec<String> = p.get("channels").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
        .map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    c.sort();
    c.dedup();
    c
}

pub(crate) fn client_session(mut stream: TcpStream, hub: Arc<Hub>) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    let role = match ws::handshake(&mut stream, &hub.config.credentials) {
        Ok(role) => role,
        Err(e) => return Err(e),
    };
    stream.set_nodelay(true)?;
    let reader = ws::FrameReader::spawn(&stream, ws::CLIENT_FRAMES, "client-reader")?;
    let mut out = FrameWriter::spawn(&stream, "client-writer")?;
    let (tx, rx) = mpsc::sync_channel(hub.config.client_queue.max(16));
    let id = hub.next_client.fetch_add(1, Ordering::Relaxed);
    let mut session = Session {
        id, role: role.clone(), views: Vec::new(), batch_deltas: false,
        watched: Arc::new(RwLock::new(HashSet::new())), replays: Arc::new(RwLock::new(HashSet::new())),
        wants_durable: Arc::new(AtomicBool::new(false)), adapter: Arc::new(AtomicBool::new(false)),
        overflowed: Arc::new(AtomicBool::new(false)), event_tape: Arc::new(RwLock::new(None)),
        durable: DurableMode::Off, durable_live: Arc::new(AtomicBool::new(false)), pending: Vec::new(), adapter_source: None, ingest_source: None, durable_push: None,
        diag: SessionDiag { opened: Instant::now(), stage: "open", command: String::new(), peer: String::new(),
            last_frame_in: None, peer_close: None },
    };
    hub.clients.write().unwrap().push(ClientHandle {
        id, role: role.clone(), tx, socket: stream.try_clone().ok(), watched: session.watched.clone(),
        replays: session.replays.clone(), wants_durable: session.wants_durable.clone(), durable_live: session.durable_live.clone(),
        adapter: session.adapter.clone(), overflowed: session.overflowed.clone(),
        event_tape: session.event_tape.clone(),
    });
    // A screen learns the session it shows from the connection itself: no read that can fail on a live
    // socket and need a retry of its own. Rollovers carry the new session below.
    // The same for B's rebuild progress (分析資料重建中): pushed again whenever it moves.
    let served = if role == Role::Viewer {
        write_json(&mut out, &json!({"type": "session.current", "payload": session_current(&hub)}))
            .and_then(|_| write_json(&mut out, &super::analysis_state::current_message(&hub)))
            .and_then(|_| serve(&mut out, &reader, &hub, &rx, &mut session))
    } else {
        serve(&mut out, &reader, &hub, &rx, &mut session)
    };
    let written = reader.close_with(out);
    let result = served.and(written);
    log_session_end(&session, &result);
    hub.clients.write().unwrap().retain(|c| c.id != id);
    if role == Role::AnalysisRuntime {
        super::analysis_state::on_session_end(&hub, id);
    }
    if let Some(source) = &session.ingest_source {
        super::evidence::connection_closed(&hub, source);
    }
    // A replay ends with the connection that opened it (the page that played it is gone).
    {
        let mut slot = lock(&hub.replays.session);
        if slot.as_ref().is_some_and(|r| r.owner == id) {
            if let Some(closed) = slot.take() {
                drop(slot);
                replay_closed(&hub, &closed);
            }
        }
    }
    {
        let mut demand = lock(&hub.demand);
        demand.client_gone(id);
        if let Some(source) = &session.adapter_source {
            demand.adapter_disconnected(source);
            // The provider's last connection is gone: nothing it subscribed is observed any more.
            if !demand.adapter_connected(source) {
                drop(demand);
                lock(&hub.broker_since).remove(source);
                write_coverage(&hub, source, BTreeSet::new());
            }
        }
    }
    replan(&hub);
    // The end was logged above with the session's identity; the caller logs only failures before a session existed.
    Ok(())
}

pub(crate) fn note_stall(hub: &Hub, role: &Role, started: Instant, what: &str) {
    let us = started.elapsed().as_micros() as u64;
    if us < 1000 {
        return;
    }
    let mut stalls = lock(&hub.stalls);
    let entry = stalls.entry(role.table_name()).or_insert((0, String::new()));
    if us > entry.0 {
        *entry = (us, what.to_string());
    }
}

pub(crate) fn serve(stream: &mut FrameWriter, reader: &ws::FrameReader, hub: &Arc<Hub>, rx: &Receiver<Outgoing>, session: &mut Session) -> io::Result<()> {
    while hub.lifecycle.running.load(Ordering::Acquire) {
        let started = Instant::now();
        session.diag.stage = "write";
        stream.check()?;
        // The writer never makes this loop wait for a slow peer; what it still holds is bounded here instead. While
        // it holds a replay chunk's worth, nothing more is produced: queued messages wait in the bounded queue (whose
        // overflow is recovered once the peer catches up), the durable replay waits at its WAL cursor, and commands
        // and pings are still read and answered.
        if stream.queued() < OUTBOUND_HIGH_WATER {
            if session.overflowed.load(Ordering::Acquire) {
                session.diag.stage = "write:overflow_resync";
                recover_overflow(stream, hub, rx, session)?;
            }
            session.diag.stage = "write:deliver";
            while stream.queued() < OUTBOUND_HIGH_WATER {
                match rx.try_recv() {
                    Ok(msg) => deliver(stream, hub, session, msg)?,
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return Ok(()),
                }
            }
            session.diag.stage = "write:flush";
            flush_pending(stream, session)?;
            session.diag.stage = "write:durable_watermark";
            push_durable(stream, hub, session)?;
            if let DurableMode::Replay { next } = session.durable {
                session.diag.stage = "write:durable_replay";
                replay_chunk(stream, hub, session, next)?;
            }
        }
        note_stall(hub, &session.role, started, "delivery");
        session.diag.stage = "read";
        let frame = reader.next(Duration::from_millis(15));
        if matches!(frame, Ok(Some(_))) {
            session.diag.last_frame_in = Some(Instant::now());
        }
        match frame {
            Ok(None) => {
                if matches!(session.role, Role::Provider(_)) {
                    let silent = session.diag.last_frame_in.unwrap_or(session.diag.opened).elapsed();
                    if silent >= hub.config.provider_silence {
                        return close_silent_provider(stream, session, silent);
                    }
                }
            }
            Ok(Some((8, p))) => {
                let code = if p.len() >= 2 { u16::from_be_bytes([p[0], p[1]]) } else { 1005 };
                session.diag.peer_close = Some((code, String::from_utf8_lossy(p.get(2..).unwrap_or_default()).into_owned()));
                return Ok(());
            }
            Ok(Some((9, p))) => {
                session.diag.stage = "write:pong";
                ws::write_frame(stream, 10, &p)?
            }
            Ok(Some((1, p))) | Ok(Some((2, p))) => {
                let command: Value = match serde_json::from_slice(&p) {
                    Ok(v) => v,
                    Err(e) => {
                        session.diag.stage = "write:parse_error";
                        write_json(stream, &json!({"type": "error", "error": e.to_string()}))?;
                        continue;
                    }
                };
                let kind = command.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                session.diag.stage = "command";
                session.diag.command.clone_from(&kind);
                let started = Instant::now();
                handle(stream, hub, session, command)?;
                note_stall(hub, &session.role, started, &kind);
            }
            Ok(Some(_)) => {}
            Err(e) => {
                ws::close_for_violation(stream, &e);
                return Err(e);
            }
        }
    }
    session.diag.stage = "shutdown";
    ws::write_close(stream, ws::CLOSE_SHUTDOWN, "market_runtime shutting down")
}

/// A provider connection that sent nothing, not even its keepalive pings, for `provider_silence`: the process is frozen
/// with its socket still open. The connection is ended so that the usual end of a connection withdraws what it covered.
fn close_silent_provider(stream: &mut FrameWriter, session: &mut Session, silent: Duration) -> io::Result<()> {
    session.diag.stage = "provider_silent";
    let source = match &session.role {
        Role::Provider(source) => Some(source.clone()),
        _ => None,
    };
    remediation::emit(remediation::Emit { component: "provider_connection", mechanism_id: "market.provider_silent_closed",
        trigger_reason: "no_frame_within_keepalive",
        identity: remediation::Identity { source, connection_id: Some(session.id.to_string()), ..Default::default() },
        attempt: None, outcome: "succeeded", detail: json!({"silent_ms": silent.as_millis() as u64, "ingest": session.ingest_source.is_some()})});
    ws::write_close(stream, ws::CLOSE_PEER_SILENT, "no frame within the keepalive period")
}

/// The WAL's committed watermark to a provider connection that subscribed: what it holds through this sequence is on
/// disk. Pushed when it moves, and when the WAL fails (the held events then wait for another Market Runtime process,
/// whose instance id tells the producer to send them again). Checked once per pass of the serve loop.
pub(crate) fn push_durable(stream: &mut FrameWriter, hub: &Hub, session: &mut Session) -> io::Result<()> {
    let Some(push) = session.durable_push.as_mut() else {
        return Ok(());
    };
    let wal = hub.wal();
    let failed = wal.failed();
    let Some(committed) = push.due(wal.committed(), failed.is_some()) else {
        return Ok(());
    };
    write_json(stream, &json!({"type": "event.durable", "payload": {
        "committed": committed, "instance_id": hub.instance_id, "wal_failed": failed}}))
}

pub(crate) fn deliver(stream: &mut FrameWriter, hub: &Hub, session: &mut Session, msg: Outgoing) -> io::Result<()> {
    match &msg.kind {
        OutKind::Delta { key, sequence, replay } => {
            let replay = replay.as_deref();
            let value: Value = serde_json::from_slice(&msg.bytes).unwrap_or(Value::Null);
            let delta_channels = value["payload"]["channels"].as_array().cloned().unwrap_or_default();
            // Only the views that subscribed to one of the delta's channels (never every channel to every view),
            // every channel), each numbered in its own sequence.
            // A delta of another partition than the one a view shows is either the partition the view now resolves to
            // (a new session began: the view is re-cut onto it by a snapshot) or not the view's at all (an older
            // session, e.g. B republishing a day that is still cached) -- never a delta of the view.
            let mut targets: Vec<(String, u64)> = Vec::new();
            let mut rebind: Vec<usize> = Vec::new();
            for (index, view) in session.views.iter_mut().enumerate() {
                if !view.matches(key, replay) || !view.wants(&delta_channels) {
                    continue;
                }
                if view.bound.as_ref() != Some(key) {
                    if resolve_view(hub, view).as_ref() == Some(key) {
                        rebind.push(index);
                    }
                    continue;
                }
                if *sequence > view.baseline {
                    view.sent_sequence += 1;
                    targets.push((view.id.clone(), view.sent_sequence));
                }
            }
            if !rebind.is_empty() {
                flush_pending(stream, session)?;
                for index in rebind {
                    let view = &session.views[index];
                    hub.counters.view_rebinds.fetch_add(1, Ordering::Relaxed);
                    eprintln!("view {} {} rebound {:?} -> {}/{}", view.id, key.instrument.wire(),
                        view.bound.as_ref().map(|b| format!("{}/{}", b.session.trading_date, b.session.session)),
                        key.session.trading_date, key.session.session);
                    send_view_snapshot(stream, hub, session, index, json!(null), "SESSION_CHANGED")?;
                }
            }
            if targets.is_empty() {
                hub.counters.deltas_filtered.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
            let sent_us = now_ns() / 1000;
            if let Some((symbol, version, backend_us, a_us, exchange_us)) = &msg.trace {
                lock(&hub.latency).on_sent(symbol, *version, *backend_us, *a_us, *exchange_us, sent_us);
            }
            for (id, view_sequence) in targets {
                let mut item = value.get("payload").cloned().unwrap_or(Value::Null);
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("subscription_id".into(), json!(id));
                    obj.insert("sequence".into(), json!(view_sequence));
                    obj.insert("watermark".into(), json!(view_sequence));
                    if let Some(trace) = obj.get_mut("trace").and_then(Value::as_object_mut) {
                        trace.insert("a_sent_us".into(), json!(sent_us));
                    }
                }
                session.pending.push(item);
                hub.counters.deltas_sent.fetch_add(1, Ordering::Relaxed);
            }
            if !session.batch_deltas || session.pending.len() >= DELTA_BATCH_MAX {
                flush_pending(stream, session)?;
            }
        }
        OutKind::Durable { from, to } => {
            flush_pending(stream, session)?;
            match session.durable {
                DurableMode::Live { last } => {
                    if *to <= last {
                    } else if *from == last + 1 {
                        ws::write_frame(stream, 2, &msg.bytes)?;
                        session.set_durable(DurableMode::Live { last: *to });
                    } else {
                        // Overlap or a hole: read the exact range from the WAL instead.
                        if *from > last + 1 {
                            remediation::emit(remediation::Emit { component: "durable_delivery", mechanism_id: "market.durable_delivery_hole",
                                trigger_reason: "live_delivery_hole",
                                identity: remediation::Identity { connection_id: Some(session.id.to_string()), ..Default::default() },
                                attempt: None, outcome: "succeeded",
                                detail: json!({"expected_sequence": last + 1, "received_from": from, "received_to": to,
                                               "role": session.role.label(), "action": "replay_from_wal"})});
                        }
                        session.set_durable(DurableMode::Replay { next: last + 1 });
                    }
                }
                DurableMode::Replay { .. } | DurableMode::Off => {}
            }
        }
        OutKind::Adapter => {
            flush_pending(stream, session)?;
            ws::write_frame(stream, 1, &msg.bytes)?;
        }
        OutKind::ReplayResync(id) => {
            flush_pending(stream, session)?;
            for i in 0..session.views.len() {
                if session.views[i].replay.as_deref() == Some(&**id) {
                    send_view_snapshot(stream, hub, session, i, json!(null), "REPLAY_SEEK")?;
                }
            }
        }
        OutKind::KeysResync(keys) => {
            flush_pending(stream, session)?;
            for i in 0..session.views.len() {
                let view = &session.views[i];
                if view.replay.is_none() && view.bound.as_ref().is_some_and(|k| keys.contains(k)) {
                    send_view_snapshot(stream, hub, session, i, json!(null), "PROJECTION_RESET")?;
                }
            }
        }
        OutKind::LiveResync(moved) => {
            flush_pending(stream, session)?;
            if !msg.bytes.is_empty() {
                ws::write_frame(stream, 1, &msg.bytes)?;
            }
            for i in 0..session.views.len() {
                let view = &session.views[i];
                let market = rollover::clear_family(&view.instrument.source, &view.instrument.market);
                if view.replay.is_some() || !moved.contains(&market) || !rolled_under(view, || resolve_view(hub, view)) {
                    continue;
                }
                // The daily rollover moving an open view onto the new session is routine, not a recovery (decisions.md
                // 什麼算補救): counted only. A snapshot that cannot be written ends the connection like any other.
                hub.counters.rollover_rebinds.fetch_add(1, Ordering::Relaxed);
                send_view_snapshot(stream, hub, session, i, json!(null), "SESSION_ROLLOVER")?;
            }
        }
    }
    Ok(())
}

pub(crate) fn flush_pending(stream: &mut FrameWriter, session: &mut Session) -> io::Result<()> {
    match session.pending.len() {
        0 => Ok(()),
        1 => {
            let item = session.pending.pop().unwrap_or(Value::Null);
            ws::write_frame(stream, 2, &serde_json::to_vec(&json!({"type": "view.delta", "payload": item})).unwrap_or_default())
        }
        _ => {
            let items = std::mem::take(&mut session.pending);
            if session.batch_deltas {
                ws::write_frame(stream, 2, &serde_json::to_vec(&json!({"type": "view.delta.batch", "payload": {"items": items}})).unwrap_or_default())
            } else {
                for item in items {
                    ws::write_frame(stream, 2, &serde_json::to_vec(&json!({"type": "view.delta", "payload": item})).unwrap_or_default())?;
                }
                Ok(())
            }
        }
    }
}

/// Slow consumer: queued deltas are dropped and every view is re-snapshotted with an explicit reason; a durable
/// consumer switches to reading the WAL from its cursor. Nothing is silently skipped.
/// A client's bounded outbound queue overflowed: what was queued is dropped and the client is brought back
/// from authoritative state -- views re-snapshotted, durable delivery read from the WAL, a replay fed again. Every
/// overflow is a recorded remediation: role, client, how much was dropped, what was done, and
/// whether the recovery completed.
pub(crate) fn recover_overflow(stream: &mut FrameWriter, hub: &Arc<Hub>, rx: &Receiver<Outgoing>, session: &mut Session) -> io::Result<()> {
    let dropped_pending = session.pending.len();
    session.pending.clear();
    let mut adapters = Vec::new();
    let mut dropped_queued = 0usize;
    while let Ok(msg) = rx.try_recv() {
        // A replay resync is superseded by the full re-snapshot below.
        if matches!(msg.kind, OutKind::Adapter) {
            adapters.push(msg);
        } else {
            dropped_queued += 1;
        }
    }
    session.overflowed.store(false, Ordering::Release);
    let replay_from = match session.durable {
        DurableMode::Live { last } => Some(last + 1),
        _ => None,
    };
    let mut operation = remediation::begin("delivery", "market.slow_consumer_recovery", "outbound_queue_full",
        remediation::Identity { connection_id: Some(session.id.to_string()), ..Default::default() },
        json!({"role": session.role.label(), "dropped_pending": dropped_pending, "dropped_queued": dropped_queued,
               "views": session.views.len(), "durable_replay_from": replay_from}));
    let result = (|| -> io::Result<()> {
        for msg in adapters {
            ws::write_frame(stream, 1, &msg.bytes)?;
        }
        if let Some(next) = replay_from {
            session.set_durable(DurableMode::Replay { next });
            hub.counters.durable_overflow_replays.fetch_add(1, Ordering::Relaxed);
        }
        // The dropped messages may have been what B needs of the open replay: told again (B ignores what it has).
        if session.role == Role::AnalysisRuntime && session.wants_durable.load(Ordering::Acquire) {
            if let Some(replay) = lock(&hub.replays.session).as_ref() {
                tell_b_replay(hub, Some(session.id), replay);
            }
        }
        resend_connection_state(stream, hub, session)?;
        if !session.views.is_empty() {
            let ids: Vec<String> = session.views.iter().map(|v| v.id.clone()).collect();
            write_json(stream, &json!({"type": "view.resync_required", "payload": {"reason": "SLOW_CONSUMER", "subscription_ids": ids}}))?;
            for i in 0..session.views.len() {
                send_view_snapshot(stream, hub, session, i, json!(null), "SLOW_CONSUMER")?;
            }
        }
        Ok(())
    })();
    match &result {
        Ok(()) => operation.finish("succeeded", Some(1), json!({"views_resnapshotted": session.views.len()})),
        Err(e) => operation.finish("failed", Some(1), json!({"error": e.to_string()})),
    }
    result
}

/// The notices an overflow may have dropped, each sent once and never again until its state moves: the current rollover
/// state to B and the screens, and to a screen the analysis state and its event tape. The current state, so a receiver
/// that missed nothing is told what it already holds (each of them ignores that). A provider's queue holds only its
/// plans, which are kept.
fn resend_connection_state(stream: &mut FrameWriter, hub: &Hub, session: &Session) -> io::Result<()> {
    let viewer = session.role == Role::Viewer;
    if !viewer && session.role != Role::AnalysisRuntime {
        return Ok(());
    }
    let tape = session.event_tape.read().unwrap().clone().filter(|_| viewer);
    let (rollover, tape_snapshot) = {
        let core = lock(&hub.core);
        let rollover = rollover_notice(&json!(core.engine.rolled()), &json!(core.engine.cleared()), session_current_with(hub, &core));
        (rollover, tape.map(|(market, sess, limit)| event_tape_snapshot(hub, &core, &market, &sess, limit, None)))
    };
    write_json(stream, &rollover)?;
    if viewer {
        write_json(stream, &super::analysis_state::current_message(hub))?;
    }
    if let Some(payload) = tape_snapshot {
        write_json(stream, &json!({"type": "events.snapshot", "request_id": Value::Null, "payload": payload}))?;
    }
    Ok(())
}

/// A durable range that cannot be delivered, declared to the consumer as one formal range with its reason:
/// `PRUNED` (retention removed it -- also when the prune ran while this replay was reading)
/// or `UNREADABLE` (the WAL holds no readable record for it). The consumer never has to infer a hole from a
/// jump in the sequence, nor decide on "still missing the second time" whether it is permanent.
/// `problems`: what the reader could not read in this range (segment, offset, reason), kept in the record.
pub(crate) fn send_durable_gap(stream: &mut FrameWriter, hub: &Hub, session: &Session, after: u64, through: u64, problems: &[String]) -> io::Result<()> {
    let pruned = hub.wal().index_snapshot().pruned_through >= through;
    let reason = if pruned { "PRUNED" } else { "UNREADABLE" };
    hub.counters.durable_gaps_declared.fetch_add(1, Ordering::Relaxed);
    if pruned && after == 0 {
        // not an error: a consumer that holds nothing (no checkpoint, or one set aside) asked for the whole stream,
        // and retention keeps only the newest part of it. Declared to it like any range and logged, not a hole.
        eprintln!("[market_runtime] durable consumer {} holds nothing: retention starts after {through}", session.role.label());
    } else {
        remediation::emit(remediation::Emit { component: "durable_delivery", mechanism_id: "market.durable_delivery_hole",
            trigger_reason: if pruned { "wal_pruned" } else { "wal_unreadable" },
            identity: remediation::Identity { connection_id: Some(session.id.to_string()), ..Default::default() }, attempt: None, outcome: "failed",
            detail: json!({"after_sequence": after, "through_sequence": through, "events": through - after, "role": session.role.label(),
                           "durable_stream_id": hub.durable_stream_id, "read_problems": problems})});
    }
    write_json(stream, &json!({"type": "durable.gap", "payload": {"after_sequence": after, "through_sequence": through,
        "committed": hub.committed(), "reason": reason, "durable_stream_id": hub.durable_stream_id}}))
}

pub(crate) fn replay_chunk(stream: &mut FrameWriter, hub: &Hub, session: &mut Session, next: u64) -> io::Result<()> {
    // This turn may end the replay at the watermark read below: batches are queued again before it is read, so one
    // committed after it is never missed. A commit publishes the watermark before broadcasting (`on_commit`), and both
    // sides fence between their store and load: either this read sees that batch's sequence, or the broadcast sees
    // the flag. A turn that stays in Replay clears the flag again; a batch queued meanwhile is dropped by `deliver` (the replay
    // reads it from the WAL).
    session.durable_live.store(true, Ordering::SeqCst);
    std::sync::atomic::fence(Ordering::SeqCst);
    let committed = hub.committed();
    if next > committed {
        session.set_durable(DurableMode::Live { last: next - 1 });
        return Ok(());
    }
    let index: WalIndex = hub.wal().index_snapshot();
    if next <= index.pruned_through {
        // Retention removed this prefix: say so once and continue after it.
        send_durable_gap(stream, hub, session, next - 1, index.pruned_through, &[])?;
        session.set_durable(DurableMode::Replay { next: index.pruned_through + 1 });
        return Ok(());
    }
    let wal::RawRange { mut events, problems } =
        wal::read_range_raw(&hub.config.data_dir, &index, next - 1, committed, REPLAY_CHUNK_EVENTS, REPLAY_CHUNK_BYTES);
    if events.is_empty() {
        // The WAL holds nothing readable in (next-1, committed]: a declared range, not a silent jump.
        send_durable_gap(stream, hub, session, next - 1, committed, &problems)?;
        session.set_durable(DurableMode::Live { last: committed });
        return Ok(());
    }
    let from = events[0].0;
    // The reader goes on past what it cannot open or read (a segment pruned under it, a damaged span) and says so in
    // `problems`: the first record it found is past `next`, so (next-1, from-1] is declared, with those problems,
    // before the records are sent.
    if from > next {
        send_durable_gap(stream, hub, session, next - 1, from - 1, &problems)?;
    }
    // A batch is contiguous: a jump inside the chunk ends it, and the next turn declares the range it skipped.
    if let Some(cut) = events.windows(2).position(|w| w[1].0 != w[0].0 + 1) {
        events.truncate(cut + 1);
    }
    let to = events.last().map(|(seq, _)| *seq).unwrap_or(from);
    // The stored records are forwarded verbatim (same JSON the live broadcast encodes); only the envelope is built.
    let body: usize = events.iter().map(|(_, raw)| raw.len() + 1).sum();
    let mut frame = Vec::with_capacity(body + 192);
    frame.extend_from_slice(format!(r#"{{"type":"durable.batch","payload":{{"from_sequence":{from},"to_sequence":{to},"durable_stream_id":{},"replay":true,"events":["#,
        serde_json::to_string(&hub.durable_stream_id).unwrap_or_else(|_| "null".into())).as_bytes());
    for (i, (_, raw)) in events.iter().enumerate() {
        if i > 0 {
            frame.push(b',');
        }
        frame.extend_from_slice(raw);
    }
    frame.extend_from_slice(b"]}}");
    ws::write_frame(stream, 2, &frame)?;
    session.set_durable(if to >= committed { DurableMode::Live { last: to } } else { DurableMode::Replay { next: to + 1 } });
    Ok(())
}

pub(crate) fn replan(hub: &Hub) {
    let plans = {
        let mut demand = lock(&hub.demand);
        let sources = demand.sources();
        let plans: Vec<_> = sources.iter().filter_map(|s| demand.plan(s)).collect();
        let pinned = demand.pinned();
        drop(demand);
        lock(&hub.core).engine.set_pinned(pinned);
        plans
    };
    for plan in plans {
        let bytes = Arc::new(serde_json::to_vec(&plan.wire()).unwrap_or_default());
        let source = plan.source.clone();
        broadcast_role(hub, |c| matches!(&c.role, Role::Provider(s) if *s == source) && c.adapter.load(Ordering::Acquire),
            Outgoing { kind: OutKind::Adapter, bytes, trace: None });
    }
}

/// A view opened on a partition holding nothing: its provider is asked for the session's prints from its broker's
/// history. Whether the session is over, and whether it was already fetched, is the provider's to judge. The App opens
/// its views before the provider connects: until it can be asked the view waits (flush_view_history).
pub(crate) fn request_view_history(hub: &Hub, instrument: &InstrumentKey, trading_date: Option<&str>, session: Option<&str>) {
    let (Some(date), Some(name)) = (trading_date, session) else { return };
    if !matches!(instrument.market.as_str(), "STK" | "FUT" | "IDX") || view_holds_data(hub, instrument, date, name) {
        return;
    }
    if provider_answers_history(hub, &instrument.source) {
        send_view_history(hub, instrument, date, name);
    } else {
        lock(&hub.demand).wait_view_history((instrument.clone(), date.to_string(), name.to_string()));
    }
}

/// `source`'s provider said who it is or registered its adapter: what waited for it is asked for, once both are done.
pub(crate) fn flush_view_history(hub: &Hub, source: &str) {
    if !provider_answers_history(hub, source) {
        return;
    }
    let waiting = lock(&hub.demand).take_view_history(source);
    for (instrument, date, name) in waiting {
        if !view_holds_data(hub, &instrument, &date, &name) {
            send_view_history(hub, &instrument, &date, &name);
        }
    }
}

fn view_holds_data(hub: &Hub, instrument: &InstrumentKey, date: &str, name: &str) -> bool {
    let core = lock(&hub.core);
    core.engine.resolve(instrument, Some(date), Some(name)).is_some_and(|k| k.session.trading_date == date && core.engine.holds_data(&k))
}

fn provider_answers_history(hub: &Hub, source: &str) -> bool {
    let fills = lock(&hub.core).late_joins.fills_gaps(source);
    fills && lock(&hub.demand).adapter_connected(source)
}

fn send_view_history(hub: &Hub, instrument: &InstrumentKey, date: &str, name: &str) {
    let message = json!({"type": "adapter.history.view", "payload": {"source": instrument.source, "market": instrument.market,
        "code": instrument.code, "trading_date": date, "session": name}});
    let bytes = Arc::new(serde_json::to_vec(&message).unwrap_or_default());
    let source = instrument.source.clone();
    broadcast_role(hub, |c| matches!(&c.role, Role::Provider(s) if *s == source) && c.adapter.load(Ordering::Acquire),
        Outgoing { kind: OutKind::Adapter, bytes, trace: None });
}

pub(crate) fn send_view_snapshot(stream: &mut FrameWriter, hub: &Hub, session: &mut Session, index: usize, request_id: Value, reason: &str) -> io::Result<()> {
    if let Some(replay_id) = session.views[index].replay.clone() {
        return send_replay_snapshot(stream, hub, session, index, &replay_id, request_id, reason);
    }
    let started = Instant::now();
    let (payload, key, seq) = {
        let core = lock(&hub.core);
        let locked = started.elapsed();
        let view = &session.views[index];
        let resolved = core.engine.resolve(&view.instrument, view.trading_date.as_deref(), view.session.as_deref());
        let key = resolved.unwrap_or_else(|| StateKey {
            instrument: view.instrument.clone(),
            session: SessionKey { trading_date: view.trading_date.clone().unwrap_or_default(), session: view.session.clone().unwrap_or_default() },
        });
        let state = core.engine.state(&key);
        let entry = core.projection.entry(&key);
        let seq = core.view_seq.get(&key).copied().unwrap_or(0);
        let breadth = core.breadth.wire();
        let demand_state = demand_state_for(hub, &key.instrument);
        let view_sequence = view.sent_sequence + 1;
        let mut payload = wire::snapshot(&hub.identity(), &key.instrument, &key.session.trading_date, &key.session.session, state, entry,
            Some(&breadth), view_sequence, hub.committed(), demand_state, json!(view.id));
        wire::trim_to_channels(&mut payload, &view.channels);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("request_id".into(), request_id.clone());
            if !reason.is_empty() {
                obj.insert("resync_reason".into(), json!(reason));
            }
            if !request_id.is_null() {
                // What the renderer asked for (a selection): Rust A's own share of its latency, for the developer's
                // selection trace (selection_latency_trace.js reads every *_ms).
                let ms = |d: Duration| (d.as_secs_f64() * 1_000_000.0).round() / 1000.0;
                obj.insert("selection_timing".into(), json!({"lock_wait_ms": ms(locked), "build_ms": ms(started.elapsed() - locked),
                    "rust_a_ms": ms(started.elapsed())}));
            }
        }
        (payload, key, seq)
    };
    bind_view(&mut session.views[index], key, seq);
    hub.counters.snapshots_sent.fetch_add(1, Ordering::Relaxed);
    ws::write_frame(stream, 2, &serde_json::to_vec(&json!({"type": "view.snapshot", "request_id": request_id, "payload": payload})).unwrap_or_default())
}

pub(crate) fn demand_state_for(hub: &Hub, instrument: &InstrumentKey) -> Value {
    let status = lock(&hub.demand).status();
    status["instruments"].as_array().into_iter().flatten()
        .find(|r| r["source"] == instrument.source && r["market"] == instrument.market && r["code"] == instrument.code)
        .cloned().unwrap_or_else(|| json!({"state": "NOT_REQUESTED"}))
}

pub(crate) fn forbidden(stream: &mut FrameWriter, hub: &Hub, session: &Session, kind: &str) -> io::Result<()> {
    hub.counters.commands_forbidden.fetch_add(1, Ordering::Relaxed);
    write_json(stream, &json!({"type": "error", "error": "FORBIDDEN", "command": kind, "role": session.role.label()}))
}
