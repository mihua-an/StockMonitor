//! 歷史回放: a replay session played to its own views, never into the live state. Rust B's analysis of it is the
//! recording's timeline (crate::timeline), which B builds and sends span by span: a seek and a played step show the
//! analysis of exactly the step the replay stands on, together with the market state of that step.

use crate::contract::Role;
use crate::event::{InstrumentKey, SessionKey, StateKey};
use crate::projection::BlockKind;
use crate::replay::{self, Partition, Recording, ReplaySession};
use crate::state::ApplyResult;
use crate::timeline::{Moved, State};
use crate::view_diff;
use crate::wire::{self};
use crate::ws::{self, FrameWriter};
use serde_json::{json, Map, Value};
use std::io::{self};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self};
use std::time::{Duration, Instant};
use super::{hub::*, ingest::*, session::*, projection_publish::*};

/// Open a recorded partition for 歷史回放 (replaces any replay already open: one at a time). Paused at its first event.
pub(crate) fn replay_open(hub: &Hub, owner: u64, p: &Value) -> Value {
    let Some(dir) = hub.config.historical_dir.clone() else {
        return json!({"ok": false, "error": "NOT_CONFIGURED", "detail": "Market Runtime was started without --historical-dir"});
    };
    let text = |name: &str| p.get(name).and_then(Value::as_str).unwrap_or("").to_string();
    let market = text("market");
    let source = if text("source").is_empty() { source_for_market(&market).to_string() } else { text("source") };
    let partition = match Partition::new(&source, &market, &text("code"), &text("trading_date"), &text("session")) {
        Ok(partition) => partition,
        Err(e) => return json!({"ok": false, "error": "INVALID_IDENTITY", "detail": e}),
    };
    let started = Instant::now();
    let refused = |e: String| {
        let code = e.split(':').next().unwrap_or("LOAD_FAILED").to_string();
        json!({"ok": false, "error": code, "detail": e})
    };
    // One replay at a time, owned by the connection that opened it: another viewer's replay is not replaced from here
    // It ends with its owner's own close or its connection.
    if let Some(other) = lock(&hub.replays.session).as_ref().filter(|r| r.owner != owner) {
        return json!({"ok": false, "error": "REPLAY_BUSY", "replay_id": other.id});
    }
    let recording = match recording_for(hub, &partition, &dir) {
        Ok(recording) => recording,
        Err(e) => return refused(e),
    };
    let id = format!("replay-{}-{}", hub.runtime_epoch, hub.replays.next.fetch_add(1, Ordering::Relaxed));
    let mut session = ReplaySession::new(id.clone(), recording, owner);
    if let Some(speed) = p.get("speed").and_then(Value::as_u64) {
        if let Err(e) = session.set_speed(speed as u32) {
            return json!({"ok": false, "error": "INVALID_SPEED", "detail": e});
        }
    }
    if let Some(at) = p.get("at_ns").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))) {
        session.seek(at);
    }
    let status = session.status();
    // Installed before B is fed: B may publish while the prefix is still arriving, and that publish must find it.
    // Checked again under the lock that installs: the check above ran before the partition loaded, so another
    // viewer may have installed its replay meanwhile -- that one is never replaced from here.
    let mut slot = lock(&hub.replays.session);
    if let Some(other) = slot.as_ref().filter(|r| r.owner != owner) {
        return json!({"ok": false, "error": "REPLAY_BUSY", "replay_id": other.id});
    }
    if let Some(previous) = slot.replace(session) {
        replay_closed(hub, &previous);
    }
    // Counted once installed: a contender refused REPLAY_BUSY above opened nothing.
    hub.counters.replays_opened.fetch_add(1, Ordering::Relaxed);
    if let Some(installed) = slot.as_mut() {
        refresh_analysis(installed);
        tell_b_replay(hub, None, installed);
    }
    drop(slot);
    json!({"ok": true, "replay_id": id, "load_ms": started.elapsed().as_millis() as u64, "status": status})
}

/// The partition's recording: the cached one while the partition on disk is still what it was read from, else read
/// now, cached, and its checkpoints built over the whole day on a thread of their own (the part already built is
/// sought from at once; see replay::Recording).
fn recording_for(hub: &Hub, partition: &Partition, dir: &std::path::Path) -> Result<Arc<Recording>, String> {
    let (path, hash) = recorded_partition(hub, partition, dir)?;
    if let Some(cached) = lock(&hub.replays.cache).get(partition, &hash, Instant::now()) {
        return Ok(cached);
    }
    // B starts building the timeline now, while this one reads the partition: not after this load.
    tell_b(hub, None, json!({"type": "replay.prepare", "payload": {"recording": replay::wire_for_b(&path, &hash), "version": "", "held": []}}));
    let recording = Arc::new(Recording::new(partition.clone(), path.clone(), replay::load(&path)?));
    let builder = recording.clone();
    if let Err(e) = thread::Builder::new().name("replay-checkpoints".into()).spawn(move || builder.build_checkpoints()) {
        // Without its builder the recording is still played; a seek then applies from where the replay stands.
        eprintln!("[market_runtime] replay checkpoints of {}: builder thread not started: {e}", path.display());
    }
    let open = lock(&hub.replays.session).as_ref().map(|r| r.partition.clone());
    Ok(lock(&hub.replays.cache).insert(recording, open.as_ref(), Instant::now()))
}

/// The partition file a replay reads and its content hash: the historical store's once it is materialized, before that
/// the one written from Market Runtime's own WAL (replay::provisional_from_wal) -- a day can be replayed as soon as it
/// has traded, not only after its 14:40 seal. Any other refusal of the materialized partition (CORRUPT, OLD_FORMAT) is
/// the answer.
fn recorded_partition(hub: &Hub, partition: &Partition, dir: &std::path::Path) -> Result<(std::path::PathBuf, String), String> {
    let path = partition.events_path(dir);
    match replay::committed_hash(&path) {
        Ok(hash) => Ok((path, hash)),
        Err(e) if e.starts_with("NOT_COMMITTED") || e.starts_with("NOT_AVAILABLE") => {
            // The partition's newest durable event in the live state, once the WAL holds it on disk: a partition already
            // written through it is read again as it is.
            let key = StateKey { instrument: InstrumentKey::new(&partition.source, &partition.market, &partition.code),
                                 session: SessionKey { trading_date: partition.trading_date.clone(), session: partition.session.clone() } };
            let live = lock(&hub.core).engine.state(&key).map(|state| state.last_durable_sequence);
            let live_through = live.filter(|through| *through > 0 && *through <= hub.committed());
            let provisional = replay::provisional_from_wal(&hub.config.data_dir, partition, &hub.config.data_dir.join(replay::PROVISIONAL_DIR), live_through, &hub.voided)?;
            let hash = replay::committed_hash(&provisional)?;
            Ok((provisional, hash))
        }
        Err(e) => Err(e),
    }
}

/// A replay ended (closed, replaced, or its connection gone): B lets its context go, and its recording's idle time in
/// the cache starts.
pub(crate) fn replay_closed(hub: &Hub, closed: &ReplaySession) {
    tell_b(hub, None, json!({"type": "replay.close", "payload": {"replay_id": closed.id}}));
    lock(&hub.replays.cache).released(&closed.partition, Instant::now());
}

pub(crate) fn replay_control(hub: &Hub, requester: u64, p: &Value) -> Value {
    let id = identity_field(p, "replay_id").unwrap_or_default();
    let action = p.get("action").and_then(Value::as_str).unwrap_or("").to_string();
    let mut slot = lock(&hub.replays.session);
    let Some(session) = slot.as_mut().filter(|r| r.id == id) else {
        return json!({"ok": false, "error": "UNKNOWN_REPLAY", "replay_id": id});
    };
    if session.owner != requester {
        return json!({"ok": false, "error": "NOT_OWNER", "replay_id": id});
    }
    let mut resync = false;
    let result: Result<(), String> = match action.as_str() {
        "play" => {
            session.play();
            Ok(())
        }
        "pause" => {
            session.pause();
            Ok(())
        }
        "speed" => session.set_speed(p.get("speed").and_then(Value::as_u64).unwrap_or(0) as u32),
        "seek" => match p.get("at_ns").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))) {
            Some(at) => {
                // A seek is the user's own move, not a recovery (the remediation contract, 3.1): logged for the
                // audit with who moved which replay from where to where.
                let from = session.cursor;
                let started = Instant::now();
                let applied = session.seek(at);
                refresh_analysis(session);
                eprintln!("[market_runtime] replay {} seek by owner {}: cursor {} -> {} (generation {}, {} events applied, analysis {}) in {} us",
                    session.id, session.owner, from, session.cursor, session.generation, applied,
                    if session.analysis.is_some() { "held" } else { "not built yet" }, started.elapsed().as_micros());
                tell_b_replay(hub, None, session);
                resync = true;
                Ok(())
            }
            None => Err("at_ns required".into()),
        },
        other => Err(format!("unknown action {other}")),
    };
    let status = session.status();
    drop(slot);
    if resync {
        send_to_replay_viewers(hub, &id, OutKind::ReplayResync(Arc::from(id.as_str())), Arc::new(Vec::new()));
    }
    broadcast_replay_status(hub, &id, &status);
    match result {
        Ok(()) => json!({"ok": true, "status": status}),
        Err(e) => json!({"ok": false, "error": "INVALID_CONTROL", "detail": e, "status": status}),
    }
}

pub(crate) fn send_to_replay_viewers(hub: &Hub, replay_id: &str, kind: OutKind, bytes: Arc<Vec<u8>>) {
    let clients = hub.clients.read().unwrap();
    for client in clients.iter().filter(|c| c.role == Role::Viewer && c.replays.read().unwrap().contains(replay_id)) {
        send_to(client, Outgoing { kind: kind.clone(), bytes: bytes.clone(), trace: None }, &hub.counters);
    }
}

pub(crate) fn broadcast_replay_status(hub: &Hub, replay_id: &str, status: &Value) {
    let bytes = Arc::new(serde_json::to_vec(&json!({"type": "replay.status", "payload": status})).unwrap_or_default());
    send_to_replay_viewers(hub, replay_id, OutKind::Adapter, bytes);
}

pub(crate) fn send_replay_snapshot(stream: &mut FrameWriter, hub: &Hub, session: &mut Session, index: usize, replay_id: &str, request_id: Value,
                        reason: &str) -> io::Result<()> {
    let (payload, key, seq) = {
        let slot = lock(&hub.replays.session);
        let view = &session.views[index];
        let Some(replay) = slot.as_ref().filter(|r| r.id == replay_id) else {
            return write_json(stream, &json!({"type": "view.subscription.error", "request_id": request_id,
                "payload": {"subscription_id": view.id, "error": "UNKNOWN_REPLAY", "replay_id": replay_id}}));
        };
        let core = &replay.core;
        let key = core.engine.resolve(&view.instrument, view.trading_date.as_deref(), view.session.as_deref()).unwrap_or_else(|| StateKey {
            instrument: view.instrument.clone(),
            session: SessionKey { trading_date: replay.partition.trading_date.clone(), session: replay.partition.session.clone() },
        });
        let seq = core.view_seq.get(&key).copied().unwrap_or(0);
        let mut payload = wire::snapshot(&hub.identity(), &key.instrument, &key.session.trading_date, &key.session.session,
            core.engine.state(&key), core.projection.entry(&key), None, view.sent_sequence + 1, 0, json!({"state": "REPLAY"}), json!(view.id));
        wire::trim_to_channels(&mut payload, &view.channels);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("generation".into(), json!(replay.generation));
            obj.insert("request_id".into(), request_id.clone());
            obj.insert("replay_id".into(), json!(replay_id));
            obj.insert("replay".into(), replay.status());
            if !reason.is_empty() {
                obj.insert("resync_reason".into(), json!(reason));
            }
        }
        (payload, key, seq)
    };
    let view = &mut session.views[index];
    let held = view.shown.take();
    bind_view(view, key.clone(), seq);
    let sequence = view.sent_sequence;
    let whole = serde_json::to_vec(&json!({"type": "view.snapshot", "request_id": request_id, "payload": payload})).unwrap_or_default();
    // A seek moves the view the client holds -- the one sent just before this, nothing reached it since, of the same
    // state -- so it gets what changed. A subscribe, a client's own resync and anything that reached the view in
    // between get it whole.
    let moved = held.filter(|h| reason == "REPLAY_SEEK" && h.sequence + 1 == sequence && h.key == key)
        .and_then(|h| replay_diff_frame(&h, &view.id, replay_id, sequence, reason, &payload, whole.len()));
    view.shown = Some(Shown { sequence, key, view: payload });
    match moved {
        Some(bytes) => {
            hub.counters.replay_diffs_sent.fetch_add(1, Ordering::Relaxed);
            ws::write_frame(stream, 2, &bytes)
        }
        None => {
            hub.counters.snapshots_sent.fetch_add(1, Ordering::Relaxed);
            ws::write_frame(stream, 2, &whole)
        }
    }
}

/// The `view.replay_diff` frame that moves the view `held` to `view` (sent with `sequence`), or None when it is no
/// smaller than the view sent whole (`whole_bytes`): a jump across most of the day changes nearly every field.
pub(crate) fn replay_diff_frame(held: &Shown, subscription_id: &str, replay_id: &str, sequence: u64, reason: &str, view: &Value,
                                whole_bytes: usize) -> Option<Vec<u8>> {
    let ops = view_diff::diff(&held.view, view);
    let touched = view_diff::touched(&ops);
    let bytes = serde_json::to_vec(&json!({"type": "view.replay_diff", "payload": {"subscription_id": subscription_id, "replay_id": replay_id,
        "base_sequence": held.sequence, "base_generation": held.view["generation"], "sequence": sequence, "watermark": sequence,
        "generation": view["generation"], "resync_reason": reason, "channels": touched, "ops": ops}})).unwrap_or_default();
    (bytes.len() < whole_bytes).then_some(bytes)
}

/// A replay delta: the same frame a live event produces, numbered in the replay's own view sequence and routed only
/// to views of this replay. Its `generation` is the replay's (it rises at every open and seek), as on the replay's
/// snapshots: the frame's own is the recorded provider connection of the last event applied, which falls whenever a
/// seek goes back across a reconnect in the recording, and a view's generation may only rise (the renderer refuses
/// an older one, as it must for a live view).
pub(crate) fn emit_replay_delta(hub: &Hub, replay: &mut ReplaySession, key: &StateKey, frame: Frame) {
    let (_, delta_type, channels, payload, extra, _trace) = frame;
    let generation = replay.generation;
    let seq = {
        let s = replay.core.view_seq.entry(key.clone()).or_insert(0);
        *s += 1;
        *s
    };
    let mut extra = extra;
    extra.insert("replay_id".into(), json!(replay.id));
    let body = wire::delta(&hub.identity(), key, generation, seq, delta_type, channels, payload, extra);
    let bytes = Arc::new(serde_json::to_vec(&json!({"type": "view.delta", "payload": body})).unwrap_or_default());
    hub.counters.replay_deltas_sent.fetch_add(1, Ordering::Relaxed);
    send_to_replay_viewers(hub, &replay.id, OutKind::Delta { key: key.clone(), sequence: seq, replay: Some(Arc::from(replay.id.as_str())) }, bytes);
}

/// B's reader connection (the one consuming the durable stream), or one named client of it.
pub(crate) fn tell_b(hub: &Hub, only: Option<u64>, message: Value) {
    let bytes = Arc::new(serde_json::to_vec(&message).unwrap_or_default());
    let clients = hub.clients.read().unwrap();
    for client in clients.iter().filter(|c| c.role == Role::AnalysisRuntime && c.wants_durable.load(Ordering::Acquire) && only.is_none_or(|id| id == c.id)) {
        send_to(client, Outgoing { kind: OutKind::Adapter, bytes: bytes.clone(), trace: None }, &hub.counters);
    }
}

/// What B needs of the open replay: its recording's timeline built (`replay.prepare`, naming the spans held, so a B
/// whose build is under way carries on and one that has none builds only what is missing), the step the replay
/// stands on built first (`replay.focus`). Sent on open and seek, to a B that (re)subscribes, and the position as the
/// replay plays.
pub(crate) fn tell_b_replay(hub: &Hub, only: Option<u64>, replay: &ReplaySession) {
    let recording = replay.rec.wire_for_b();
    let (complete, version, held) = {
        let timeline = replay.rec.timeline.read().unwrap_or_else(|e| e.into_inner());
        (timeline.complete(), timeline.version.clone(), timeline.held())
    };
    if !complete {
        tell_b(hub, only, json!({"type": "replay.prepare", "payload": {"recording": recording, "version": version, "held": held}}));
    }
    tell_focus(hub, only, replay);
}

fn tell_focus(hub: &Hub, only: Option<u64>, replay: &ReplaySession) {
    tell_b(hub, only, json!({"type": "replay.focus", "payload": {"replay_id": replay.id, "recording": replay.rec.wire_for_b(), "position": replay.position}}));
}

/// The instrument and session a timeline target names (its identity as B wrote it).
fn key_of(identity: &Value) -> Option<StateKey> {
    Some(StateKey { instrument: instrument_from(identity)?,
                    session: SessionKey { trading_date: identity_field(identity, "trading_date")?, session: identity_field(identity, "session")? } })
}

/// A timeline target split into the state it is of and its block.
fn target_parts(target: &str) -> Option<(StateKey, &str)> {
    let (identity, block) = target.rsplit_once('|')?;
    Some((key_of(&serde_json::from_str(identity).ok()?)?, block))
}

/// Put `targets` of `state` into the replay's cache (every target when None).
fn install(replay: &mut ReplaySession, state: &State, targets: Option<&Moved>) {
    let now = now_ns();
    let all: Vec<&String> = match targets {
        Some(moved) => moved.targets.keys().collect(),
        None => state.blocks.keys().collect(),
    };
    for target in all {
        let Some((key, block)) = target_parts(target) else { continue };
        match state.blocks.get(target) {
            Some(body) => {
                let order = state.event_order.get(target).map(Vec::as_slice).unwrap_or(&[]);
                replay.core.projection.set_timeline_block(key, block, body, order, now);
            }
            None => replay.core.projection.set_timeline_block(key, block, &json!({"data": null}), &[], now),
        }
    }
}

/// The replay's analysis taken again from its timeline at the step it stands on now (an open, a seek, a span that
/// arrived or replaced the timeline): the cache holds that step's analysis, or none while it is not built.
pub(crate) fn refresh_analysis(replay: &mut ReplaySession) {
    replay.position = replay.position_now();
    let rec = replay.rec.clone();
    let state = match rec.timeline.read().unwrap_or_else(|e| e.into_inner()).state_at(replay.position) {
        Ok(state) => state,
        Err(e) => {
            // A span Market Runtime took is unreadable (never by design: it was checked when taken): recorded, and the
            // step shows no analysis rather than a wrong one.
            eprintln!("[market_runtime] replay {}: timeline unreadable at step {}: {e}", replay.id, replay.position);
            None
        }
    };
    replay.core.projection.clear_analysis();
    if let Some(state) = &state {
        install(replay, state, None);
    }
    replay.analysis = state;
}

/// The replay moved forward to the step it stands on now (played): its analysis moves with it -- every change of the
/// steps between, the same step as the market state the deltas just sent -- and the views get what changed.
fn advance_analysis(hub: &Hub, replay: &mut ReplaySession) {
    let position = replay.position_now();
    if position == replay.position {
        return;
    }
    let rec = replay.rec.clone();
    let timeline = rec.timeline.read().unwrap_or_else(|e| e.into_inner());
    let mut moved = Moved::default();
    let reached = match replay.analysis.as_mut() {
        Some(state) => match timeline.advance(state, position, &mut moved) {
            Ok(reached) => reached,
            Err(e) => {
                eprintln!("[market_runtime] replay {}: timeline unreadable past step {}: {e}", replay.id, state.position);
                false
            }
        },
        None => false,
    };
    drop(timeline);
    if reached {
        replay.position = position;
        let state = replay.analysis.take().expect("advanced above");
        install(replay, &state, Some(&moved));
        emit_moved(hub, replay, &state, &moved);
        replay.analysis = Some(state);
    } else {
        // Not built this far (or the replay had none): the step shown says so, or gets its analysis once built.
        let had = replay.analysis.is_some();
        refresh_analysis(replay);
        if had || replay.analysis.is_some() {
            send_to_replay_viewers(hub, &replay.id.clone(), OutKind::ReplayResync(Arc::from(replay.id.as_str())), Arc::new(Vec::new()));
        }
    }
}

/// The deltas of what moved: whole blocks, the records of a record block that changed (all of them, `replace`, when it
/// moved whole), the model predictions.
fn emit_moved(hub: &Hub, replay: &mut ReplaySession, state: &State, moved: &Moved) {
    for (target, records) in &moved.targets {
        let Some((key, block)) = target_parts(target) else { continue };
        let body = state.blocks.get(target).cloned().unwrap_or(Value::Null);
        if block == "signals" {
            let signals = replay.core.projection.entry(&key).and_then(|e| e.signals.clone()).map(Value::Object).unwrap_or(Value::Null);
            emit_replay_delta(hub, replay, &key, (0, "signals.frame", &["signals"], json!({"signals": signals}), Map::new(), None));
            continue;
        }
        let Some(kind) = BlockKind::parse(block) else { continue };
        let data = &body["data"];
        let delivered = match (kind, records) {
            (BlockKind::Minutes | BlockKind::Events, Some(ids)) => {
                let field = block;
                let rows: Vec<Value> = ids.iter().filter_map(|id| data[field].get(id).cloned()).collect();
                if rows.is_empty() {
                    continue;
                }
                json!({field: rows, "replace": false})
            }
            (BlockKind::Minutes, None) => json!({"minutes": data["minutes"].as_object().map(|m| m.values().cloned().collect::<Vec<_>>()).unwrap_or_default(), "replace": true}),
            (BlockKind::Events, None) => {
                let order = state.event_order.get(target).map(Vec::as_slice).unwrap_or(&[]);
                json!({"events": order.iter().filter_map(|id| data["events"].get(id).cloned()).collect::<Vec<_>>(), "replace": true})
            }
            (BlockKind::Flow, _) => crate::timeline::flow_unkeyed(data),
            _ => data.clone(),
        };
        let (delta_type, channels, payload) = projection_delta(kind, &delivered, &key, replay.core.engine.state(&key), replay.core.projection.entry(&key));
        let mut extra = Map::new();
        extra.insert("block_meta".into(), json!({"input_watermark": body["input_watermark"], "revision": body["input_watermark"], "projection_epoch": 0,
            "completeness": body["completeness"], "as_of": body["as_of"]}));
        emit_replay_delta(hub, replay, &key, (0, delta_type, channels, payload, extra, None));
    }
}

/// A span of a recording's timeline from B (`replay.timeline`): kept with the recording (a span of another analysis
/// version replaces the timeline); the open replay of that recording gets its analysis at once when it was waiting for
/// this span, or anew when the version changed.
pub(crate) fn replay_timeline(hub: &Hub, p: &Value) {
    let recording = &p["recording"];
    let version = p["version"].as_str().unwrap_or("");
    // Each lock on its own (a replay opening holds the session's while it takes the cache's).
    let open = lock(&hub.replays.session).as_ref().map(|r| r.rec.clone());
    let rec = open.filter(|r| r.is(recording)).or_else(|| lock(&hub.replays.cache).find(recording));
    let Some(rec) = rec else {
        // A recording the cache let go meanwhile: nothing holds its timeline any more.
        hub.counters.replay_timeline_spans_dropped.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let (taken, replaced) = {
        let mut timeline = rec.timeline.write().unwrap_or_else(|e| e.into_inner());
        let replaced = timeline.version != version && !timeline.version.is_empty();
        match timeline.insert(version, &p["span"]) {
            Ok(taken) => (taken, replaced),
            Err(e) => {
                // B and Market Runtime disagree on the recording's steps: recorded, the span is not used.
                eprintln!("[market_runtime] replay timeline of {}: span refused: {e}", rec.events_path.display());
                hub.counters.replay_timeline_spans_refused.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
    };
    if !taken {
        return;
    }
    hub.counters.replay_timeline_spans.fetch_add(1, Ordering::Relaxed);
    let mut slot = lock(&hub.replays.session);
    let Some(replay) = slot.as_mut().filter(|r| Arc::ptr_eq(&r.rec, &rec)) else { return };
    if replay.analysis.is_none() || replaced {
        refresh_analysis(replay);
        if replay.analysis.is_some() || replaced {
            let id = replay.id.clone();
            let status = replay.status();
            drop(slot);
            send_to_replay_viewers(hub, &id, OutKind::ReplayResync(Arc::from(id.as_str())), Arc::new(Vec::new()));
            broadcast_replay_status(hub, &id, &status);
        }
    }
}

/// Apply the replay events now due and push their deltas, the analysis of the same step with them; returns how long
/// the next one is away.
pub(crate) fn replay_step(hub: &Hub, replay: &mut ReplaySession) -> Option<Duration> {
    let range = replay.due_now();
    for index in range.clone() {
        let (verdict, changed) = replay.apply_at(index);
        hub.counters.replay_events_attempted.fetch_add(1, Ordering::Relaxed);
        match verdict {
            ApplyResult::Applied => hub.counters.replay_events_applied.fetch_add(1, Ordering::Relaxed),
            ApplyResult::Control => 0,
            _ => hub.counters.replay_events_rejected.fetch_add(1, Ordering::Relaxed),
        };
        if verdict != ApplyResult::Applied || !changed.any() {
            continue;
        }
        let event = replay.rec.events[index].clone();
        let key = event.state_key();
        let frame = replay.core.engine.state(&key)
            .and_then(|state| state_frame(state, replay.core.projection.entry(&key), None, &event, &changed, None));
        match frame {
            Some(frame) => emit_replay_delta(hub, replay, &key, frame),
            None => *replay.core.view_seq.entry(key).or_insert(0) += 1,
        }
    }
    let before = replay.position;
    advance_analysis(hub, replay);
    if replay.position != before {
        tell_focus(hub, None, replay);
    }
    if !range.is_empty() && replay.cursor >= replay.rec.events.len() || replay.last_status_at.elapsed() >= Duration::from_millis(250) {
        replay.last_status_at = Instant::now();
        let status = replay.status();
        broadcast_replay_status(hub, &replay.id.clone(), &status);
    }
    replay.wait_ns().map(|ns| Duration::from_nanos(ns.max(0) as u64))
}

/// The replay clock: releases each recorded event when it is due (see replay.rs). Never touches the live `core`.
pub(crate) fn replay_loop(hub: Arc<Hub>) {
    let mut last_eviction = Instant::now();
    while hub.lifecycle.running.load(Ordering::Acquire) {
        let (wait, open) = {
            let mut slot = lock(&hub.replays.session);
            match slot.as_mut() {
                Some(replay) => (replay_step(&hub, replay), Some(replay.partition.clone())),
                None => (None, None),
            }
        };
        // Recordings closed longer than the cache keeps them are let go (checked every few seconds, never the open one).
        if last_eviction.elapsed() >= Duration::from_secs(5) {
            last_eviction = Instant::now();
            lock(&hub.replays.cache).evict_idle(open.as_ref(), Instant::now());
        }
        // Due again at once: yield only (a burst longer than one step continues next turn).
        match wait {
            Some(w) if w.is_zero() => thread::yield_now(),
            Some(w) => thread::sleep(w.min(Duration::from_millis(20))),
            None => thread::sleep(Duration::from_millis(20)),
        }
    }
}
