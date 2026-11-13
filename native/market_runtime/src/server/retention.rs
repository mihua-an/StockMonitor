//! Session rollover, and the cutoffs it hands to the historical store's manager (historical_store.rs, run in B).

use crate::contract::Role;
use crate::event::StateKey;
use crate::rollover::{self};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self};
use std::time::{Duration, Instant};
use super::{hub::*, ingest::*, durable::*};

/// Session rollover on the wall clock (rollover.rs): the moment a pre-open comes, the session it replaces leaves A's
/// cache (state, B's results, view sequences), B is told to drop the same partitions, every live view is
/// re-snapshotted, and a checkpoint is written so a restart cannot bring the old session back.
pub(crate) fn rollover_loop(hub: Arc<Hub>) {
    let mut last_provisional_prune = Instant::now();
    let mut sessions_log = SessionsLog::default();
    let mut us_session = Value::Null;
    while hub.lifecycle.running.load(Ordering::Acquire) {
        thread::sleep(Duration::from_secs(1));
        if hub.lifecycle.draining.load(Ordering::Acquire) {
            continue;
        }
        let now = now_ns() as i64;
        observe_closure(&hub, now, &mut sessions_log);
        write_sessions(&hub, &mut sessions_log);
        roll_over(&hub, now);
        push_us_session(&hub, now, &mut us_session);
        reconcile_coverage(&hub);
        // A replay's partition written from the WAL (A's own folder) goes once the materializer has written the day.
        if last_provisional_prune.elapsed() >= Duration::from_secs(60) {
            last_provisional_prune = Instant::now();
            if let Some(historical) = hub.config.historical_dir.as_deref() {
                crate::replay::prune_provisional(&hub.config.data_dir.join(crate::replay::PROVISIONAL_DIR), historical);
            }
        }
    }
}

/// The Futu US session moves on the clock (盤前 -> 盤中 -> 盤後 -> 夜盤, a holiday, a half day's 13:00), not only at a
/// rollover: every viewer gets `session.current` again the moment it changes, so the screens never read a clock of
/// their own. `last` is what was pushed (or sent on connect) last; the first pass only records it.
pub(crate) fn push_us_session(hub: &Arc<Hub>, now: i64, last: &mut Value) {
    let us = crate::us_session::us_session(&hub.us_calendar.get(), now).unwrap_or(Value::Null);
    if us == *last {
        return;
    }
    let first = last.is_null();
    *last = us;
    if first {
        return;
    }
    let bytes = Arc::new(json!({"type": "session.current", "payload": session_current(hub)}).to_string().into_bytes());
    broadcast_role(hub, |c| c.role == Role::Viewer, Outgoing { kind: OutKind::Adapter, bytes, trace: None });
}

/// The markets (`source|MARKET`) whose session moved in one rollover pass: a `source|MARKET|SESSION` family whose
/// cutoff advanced, or a `source|MARKET` clear family whose clear time advanced.
pub(crate) fn moved_markets(rolled_before: &BTreeMap<String, String>, rolled_after: &BTreeMap<String, String>,
                 cleared_before: &BTreeMap<String, i64>, cleared_after: &BTreeMap<String, i64>) -> HashSet<String> {
    let rolled = rolled_after.iter().filter(|(family, date)| rolled_before.get(*family) != Some(*date))
        .map(|(family, _)| family.rsplit_once('|').map_or(family.as_str(), |(market, _)| market).to_string());
    let cleared = cleared_after.iter().filter(|(family, at)| cleared_before.get(*family) != Some(*at)).map(|(family, _)| family.clone());
    rolled.chain(cleared).collect()
}

/// What the sessions pass has already logged: the date it could not decide, the last write failure.
#[derive(Default)]
pub(crate) struct SessionsLog {
    undecided: String,
    write_error: String,
}

/// 09:00 of a trading day that has not opened (rollover::TradingCalendar::unopened_at_open) is an observed closure
/// when the Shioaji broker has been connected through the whole pre-open, since before 08:30 (the provider logs in again
/// before it every day): the day goes into the sessions file and A's calendar (B and Python read it from the file), and
/// the screens keep the last session. A broker that connected later may not have had its subscriptions in force for the
/// whole window, and one not connected shows as 已斷線: the day is not decided then, and its first print still opens it.
pub(crate) fn observe_closure(hub: &Hub, now: i64, log: &mut SessionsLog) {
    if !hub.config.rollover {
        return;
    }
    let opened = hub.opened();
    let Some(date) = hub.calendar().unopened_at_open(&opened, now) else { return };
    let Some(preopen_ns) = rollover::taipei_minute_ns(&date, rollover::DAY_PREOPEN_MINUTE) else { return };
    let since = lock(&hub.broker_since).get("shioaji").copied();
    if !since.is_some_and(|since| since <= preopen_ns) {
        if log.undecided != date {
            eprintln!("[market_runtime] {date}: no Shioaji print by 09:00, but the broker {} -- not recorded as a closure",
                      if since.is_some() { "connected only after 08:30" } else { "is not connected" });
            log.undecided = date;
        }
        return;
    }
    let closure = rollover::ObservedClosure {
        date: date.clone(),
        observed_at: rollover::taipei_stamp(now),
        reason: "no Shioaji stock, index or futures print from the 08:30 pre-open to 09:00, the broker connected since before 08:30".into(),
    };
    let mut state = lock(&hub.sessions);
    if state.sessions.is_closed(&date) {
        return;
    }
    let calendar = hub.calendar().with_closures(std::slice::from_ref(&closure));
    *hub.calendar.write().unwrap_or_else(|p| p.into_inner()) = calendar;
    eprintln!("[market_runtime] {date}: observed market closure ({})", closure.reason);
    state.sessions.closures.push(closure);
    state.dirty = true;
}

/// Writes the sessions file when it changed. A failed write is logged once per distinct error and stays due: the
/// next pass writes the then-current sessions.
pub(crate) fn write_sessions(hub: &Hub, log: &mut SessionsLog) {
    let Some(path) = hub.config.sessions_path.as_deref() else { return };
    let mut state = lock(&hub.sessions);
    if !state.dirty {
        return;
    }
    match state.sessions.save(path) {
        Ok(()) => {
            state.dirty = false;
            log.write_error.clear();
        }
        Err(e) => {
            if log.write_error != e {
                eprintln!("[market_runtime] writing the market sessions file failed: {e}");
                log.write_error = e;
            }
        }
    }
}

/// The `session.rollover` message: everything rolled and cleared so far, not only what just moved, so a receiver that
/// missed one is brought up to date by the next.
pub(crate) fn rollover_notice(rolled: &Value, cleared: &Value, session: Value) -> Value {
    json!({"type": "session.rollover", "payload": {"rolled": rolled, "cleared": cleared, "session": session}})
}

pub(crate) fn roll_over(hub: &Arc<Hub>, now: i64) -> Option<usize> {
    let cutoffs = rollover::cutoffs(&hub.calendar(), &hub.us_calendar.get(), &hub.opened(), now);
    let clears = rollover::clears(now);
    let (dropped, rolled, cleared, moved) = {
        let mut core = lock(&hub.core);
        let (rolled_before, cleared_before) = (core.engine.rolled().clone(), core.engine.cleared().clone());
        let rolled = core.engine.rollover(&cutoffs);
        let cleared = core.engine.clear(&clears);
        if rolled.is_none() && cleared.is_none() {
            return None;
        }
        let moved = moved_markets(&rolled_before, core.engine.rolled(), &cleared_before, core.engine.cleared());
        let gone: HashSet<StateKey> = rolled.into_iter().chain(cleared).flatten().collect();
        let Core { engine, projection, view_seq, live_tapes, .. } = &mut *core;
        let projected = projection.remove_where(|k| gone.contains(k) || engine.is_gone(k));
        view_seq.retain(|k, _| !gone.contains(k) && !engine.is_gone(k));
        live_tapes.retain(|t| {
            let k = t.state_key();
            !gone.contains(&k) && !engine.is_gone(&k)
        });
        (gone.len() + projected.len(), json!(engine.rolled()), json!(engine.cleared()), Arc::new(moved))
    };
    // Before B hears of the rollover: its prune reads these cutoffs.
    let cutoffs: BTreeMap<String, String> = serde_json::from_value(rolled.clone()).unwrap_or_default();
    write_cutoffs(&hub.config, &cutoffs);
    // What was held subscribed for a session that just rolled over is let go.
    if lock(&hub.demand).release_rolled(&cutoffs) {
        crate::server::session::replan(hub);
    }
    let session = session_current(hub);
    let bytes = Arc::new(rollover_notice(&rolled, &cleared, session).to_string().into_bytes());
    broadcast_role(hub, |c| c.role == Role::AnalysisRuntime, Outgoing { kind: OutKind::Adapter, bytes: bytes.clone(), trace: None });
    // Viewers get the same notice ahead of their re-snapshots: the UI rebinds its session-keyed views on it instead
    // of polling /api/status.
    broadcast_role(hub, |c| c.role == Role::Viewer, Outgoing { kind: OutKind::LiveResync(moved), bytes, trace: None });
    // Every 事件列表 subscriber gets the new session's tape from here, so the renderer never re-subscribes on the
    // notice, and on every reconnect, to learn the date.
    {
        let core = lock(&hub.core);
        for client in hub.clients.read().unwrap().iter().filter(|c| c.role == Role::Viewer) {
            let Some((market, sess, limit)) = client.event_tape.read().unwrap().clone() else { continue };
            let payload = event_tape_snapshot(hub, &core, &market, &sess, limit, None);
            let bytes = Arc::new(json!({"type": "events.snapshot", "request_id": Value::Null, "payload": payload}).to_string().into_bytes());
            send_to(client, Outgoing { kind: OutKind::Adapter, bytes, trace: None }, &hub.counters);
        }
    }
    if let Err(e) = write_checkpoint(hub) {
        eprintln!("rollover checkpoint: {e}");
    }
    eprintln!("session rollover {rolled} {cleared}: {dropped} cached partitions dropped");
    Some(dropped)
}

/// A's whole part in the historical store's retention (設定 → 資料儲存): its rollover cutoffs, written whenever they
/// move, for the store's manager (historical_store.rs), which Rust B runs at the rollover and at its start and every
/// materialization job consults when it publishes. A failed write is logged; the manager keeps judging by the cutoffs
/// it last read, so stored history is kept longer, never removed early.
pub(crate) fn write_cutoffs(config: &ServerConfig, rolled: &BTreeMap<String, String>) {
    let Some(path) = config.rollover_cutoffs.as_deref() else { return };
    if let Err(e) = crate::historical_store::write_cutoffs(path, rolled) {
        eprintln!("[market_runtime] writing the rollover cutoffs {}: {e}", path.display());
    }
}
