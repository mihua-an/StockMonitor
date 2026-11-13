//! The command dispatcher and each command a client may send.

use crate::breadth::BreadthConfig;
use crate::contract::{self, Role};
use crate::demand::{AdapterCapacity, BackgroundList, Kind, StreamBudget, StreamBudgetWire};
use crate::event::{
    InstrumentKey,
    wal_sessions, SessionKey, StateKey, EVENT_SCHEMA_VERSION,
};
use crate::remediation::{self};
use crate::trade_pages::{self, paginate, partition_end_ns, wal_rows, At, PageRequest, Paged, RowContext, Stored};
use crate::wire::{self};
use crate::ws::{self, FrameWriter};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use super::{hub::*, startup::*, ingest::*, durable::*, session::*, projection_publish::*, replay_feed::*, position_push::PositionPush};

/// Most events a batch command (`event.ingest.batch`, `signals.publish`) may carry. A larger batch is refused whole:
/// cutting it would answer for the first part and leave the rest neither accepted nor refused.
pub(crate) const COMMAND_BATCH_MAX: usize = 4096;

/// A command whose payload does not have the shape it requires is refused with the reason (and logged), never read
/// as an empty or default payload: an empty batch would be ACKed as success, an unparsable background list would
/// clear the background demand.
pub(crate) fn invalid_payload(stream: &mut FrameWriter, kind: &str, request_id: &Value, detail: &str) -> io::Result<()> {
    eprintln!("[market_runtime] {kind}: invalid payload: {detail}");
    write_json(stream, &json!({"type": "error", "error": "INVALID_PAYLOAD", "command": kind, "request_id": request_id, "detail": detail}))
}

/// The list field `name` of a batch payload, at most COMMAND_BATCH_MAX long.
pub(crate) fn batch_field<'a>(p: &'a Value, name: &str) -> Result<&'a Vec<Value>, String> {
    let list = p.get(name).and_then(Value::as_array).ok_or_else(|| format!("{name} must be a list"))?;
    if list.len() > COMMAND_BATCH_MAX {
        return Err(format!("{name} holds {} items; at most {COMMAND_BATCH_MAX} per command", list.len()));
    }
    Ok(list)
}

pub(crate) fn handle(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, command: Value) -> io::Result<()> {
    let Some(kind) = command.get("type").and_then(Value::as_str).map(str::to_string) else {
        return invalid_payload(stream, "", &command.get("request_id").cloned().unwrap_or(Value::Null), "command type missing");
    };
    // A command without a payload has an empty one; a payload that is not an object is no payload of any command.
    let p = match command.get("payload") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(Value::Object(_)) => command["payload"].clone(),
        Some(other) => {
            let request_id = command.get("request_id").cloned().unwrap_or(Value::Null);
            return invalid_payload(stream, &kind, &request_id, &format!("payload {other} is not an object"));
        }
    };
    let request_id = command.get("request_id").cloned().or_else(|| p.get("request_id").cloned()).unwrap_or(Value::Null);
    if !contract::permits(&session.role, &kind) {
        return forbidden(stream, hub, session, &kind);
    }
    match kind.as_str() {
        "event.ingest" => {
            let ack = ingest_one(hub, &session.role, p);
            super::evidence::flush_urgent(hub);
            write_json(stream, &json!({"type": "event.ack", "payload": ack}))
        }
        "event.ingest.batch" => {
            let events = match batch_field(&p, "events") {
                Ok(events) => events.clone(),
                Err(detail) => return invalid_payload(stream, &kind, &request_id, &detail),
            };
            let results: Vec<Value> = events.into_iter().map(|e| ingest_one(hub, &session.role, e)).collect();
            // The late joins judged since this provider was last answered (the windows it fills from the open), and the
            // broker-outage gaps whose end is known now.
            let gaps = match &session.role {
                Role::Provider(own) => super::evidence::answered_gaps(hub, own),
                _ => Vec::new(),
            };
            // What the batch changed in a partition's completeness is on disk before the provider is answered.
            super::evidence::flush_urgent(hub);
            write_json(stream, &json!({"type": "event.ack.batch", "request_id": request_id,
                "payload": {"results": results, "instance_id": hub.instance_id, "gaps": gaps}}))
        }
        "ingest.hello" => super::evidence::cmd_hello(stream, hub, session, &p, request_id),
        "ingest.loss" => super::evidence::cmd_loss(stream, hub, session, &p, request_id),
        "ingest.outage" => super::evidence::cmd_outage(stream, hub, session, &p, request_id),
        "ingest.backfill" => super::evidence::cmd_backfill(stream, hub, session, &p, request_id),
        "evidence.seal" | "evidence.quarantine" | "evidence.mark_repaired" =>
            super::evidence::cmd_decide(stream, hub, session, &kind, &p, request_id),
        "evidence.prune" => super::evidence::cmd_prune(stream, hub, session, &p, request_id),
        // A producer that holds the events it sent until they are on disk subscribes to the WAL's committed
        // watermark on this connection: told at once, then whenever it moves (session::push_durable).
        "event.durable.subscribe" => {
            session.durable_push = Some(PositionPush::default());
            push_durable(stream, hub, session)
        }
        "view.subscribe" => cmd_view_subscribe(stream, hub, session, &p, request_id),
        "view.snapshot" => cmd_view_snapshot(stream, hub, session, &p, request_id),
        "trades.page" => cmd_trades_page(stream, hub, &p, request_id),
        "view.resync" => cmd_view_resync(stream, hub, session, &p, request_id),
        "view.unsubscribe" => cmd_view_unsubscribe(stream, hub, session, &p),
        "flow.large_orders" => {
            // The 價量 tab asks for one session bucket's large orders. B holds them (A keeps no prints per window), so
            // the query is forwarded to B's durable connection and the answer routed back here by query id (B9).
            let reply = forward_large_orders_query(hub, session.id, &p, request_id.clone());
            match reply {
                Some(refusal) => write_json(stream, &json!({"type": "flow.large_orders.result", "request_id": request_id, "payload": refusal})),
                None => Ok(()),
            }
        }
        "flow.large_orders.result" => {
            route_large_orders_result(hub, p);
            Ok(())
        }
        "replay.open" => {
            let reply = replay_open(hub, session.id, &p);
            write_json(stream, &json!({"type": "replay.opened", "request_id": request_id, "payload": reply}))
        }
        "replay.control" => {
            let reply = replay_control(hub, session.id, &p);
            write_json(stream, &json!({"type": "replay.control.ack", "request_id": request_id, "payload": reply}))
        }
        // A span of a recording's analysis timeline, from B.
        "replay.timeline" => {
            if session.role != Role::AnalysisRuntime {
                return forbidden(stream, hub, session, "replay.timeline");
            }
            replay_timeline(hub, &p);
            Ok(())
        }
        "replay.close" => cmd_replay_close(stream, hub, session, &p, request_id),
        // One focus per source (即時報價 shows a Shioaji and a Futu product side by side); an empty code clears that
        // source's focus.
        "focus.set" => {
            let focus = instrument_from(&p).filter(|f| !f.code.is_empty());
            let Some(source) = p.get("source").and_then(Value::as_str).map(str::to_owned).or_else(|| focus.as_ref().map(|f| f.source.clone()))
            else {
                return write_json(stream, &json!({"type": "error", "error": "source required", "command": kind, "request_id": request_id}));
            };
            lock(&hub.demand).set_focus(&source, focus);
            replan(hub);
            // The ACK names the request and source it answers: a client switching fast must not take one source's or an
            // older request's ACK for its newest focus.
            write_json(stream, &json!({"type": "focus.set.ack", "request_id": request_id, "payload": {"source": source.to_lowercase(), "request_id": request_id}}))
        }
        "workspace.replace" => cmd_workspace_replace(stream, hub, session, &p),
        "latency.report" => {
            let samples = p.get("samples").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut latency = lock(&hub.latency);
            for s in samples.iter().take(512) {
                latency.on_ui_report(s);
            }
            Ok(())
        }
        "adapter.register" => cmd_adapter_register(stream, hub, session, &p),
        "adapter.subscription.status" => cmd_adapter_subscription_status(stream, hub, session, &p),
        "durable.subscribe" => cmd_durable_subscribe(stream, hub, session, &p),
        "projection.publish" => {
            let result = publish_projection(hub, &p);
            write_json(stream, &json!({"type": "projection.ack", "request_id": request_id, "payload": result}))
        }
        "projection.reset" => cmd_projection_reset(stream, hub, &p),
        "analysis.status" => {
            super::analysis_state::on_status(hub, session.id, &p);
            Ok(())
        }
        "signals.publish" => cmd_signals_publish(stream, hub, &p, request_id),
        // The current model-signal rows (what /api/latest-signals serves): Market Runtime holds them since Rust B
        // publishes its own signals; FastAPI keeps no copy.
        "signals.snapshot" => cmd_signals_snapshot(stream, hub, request_id),
        // 事件列表: the tape's current events from the projection cache, then every new or revised event of
        // that market/session as `events.tape` -- the snapshot and the subscription are cut under one `core` lock.
        "events.subscribe" => cmd_events_subscribe(stream, hub, session, &p, request_id),
        "events.unsubscribe" => {
            *session.event_tape.write().unwrap() = None;
            write_json(stream, &json!({"type": "events.unsubscribed", "request_id": request_id}))
        }
        "health" => {
            // The renderer names its connection in the first health it sends, so a close here can be matched to the
            // one it records on its side.
            if let Some(peer) = p.get("connection_id").and_then(Value::as_str) {
                session.diag.peer = peer.chars().take(80).collect();
            }
            write_json(stream, &json!({"type": "health", "payload": health(hub)}))
        }
        "metrics" => write_json(stream, &json!({"type": "metrics", "payload": metrics(hub)})),
        "demand.status" => write_json(stream, &json!({"type": "demand.status", "payload": lock(&hub.demand).status()})),
        "background.replace" => cmd_background_replace(stream, hub, &p),
        "demand.release" => cmd_demand_release(stream, hub, session, &p),
        "breadth.configure" => cmd_breadth_configure(stream, hub, &p),
        "wal.prune" => {
            let result = prune_wal(hub, &p);
            write_json(stream, &json!({"type": "wal.prune.ack", "payload": result}))
        }
        "checkpoint.now" => {
            let result = write_checkpoint(hub);
            write_json(stream, &json!({"type": "checkpoint.ack", "payload": match result { Ok(v) => v, Err(e) => json!({"error": e}) }}))
        }
        "drain" => {
            hub.lifecycle.draining.store(true, Ordering::Release);
            let flushed = hub.wal().flush(Duration::from_secs(5));
            let (committed, wal_error) = match flushed {
                Ok(at) => (Some(at), None),
                Err(e) => (None, Some(e.to_string())),
            };
            write_json(stream, &json!({"type": "drain.ack", "payload": {"draining": true, "committed": committed, "wal_error": wal_error,
                "accepted_not_committed": hub.wal().queued()}}))
        }
        "shutdown" => {
            let receipt = finish_shutdown(hub).unwrap_or_else(|e| json!({"clean": false, "error": e}));
            // The receipt is on the socket before the stop is announced. Announced first, the accept loop's wake-up
            // (it shuts every client socket down) or the process exit can cut it off while it still waits in this
            // connection's writer: the requester then sees the connection close without it and cannot tell whether
            // the stop happened. The stop is announced either way; a receipt that could not be sent ends this session
            // with that error (logged with the session).
            let delivered = write_json(stream, &json!({"type": "shutdown.ack", "payload": receipt})).and_then(|()| stream.wait_written());
            hub.lifecycle.running.store(false, Ordering::Release);
            delivered
        }
        _ => write_json(stream, &json!({"type": "error", "error": "unknown command", "command": kind})),
    }
}

pub(crate) fn cmd_view_subscribe(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value, request_id: Value) -> io::Result<()> {
    let Some(instrument) = instrument_from(&p) else {
        return write_json(stream, &json!({"type": "error", "error": "symbol/code required", "request_id": request_id}));
    };
    let trading_date = identity_field(&p, "trading_date");
    let sess = identity_field(&p, "session");
    let channels = channels_from(&p);
    let replay_id = identity_field(&p, "replay_id");
    if p.get("delta_batch").and_then(Value::as_bool) == Some(true) {
        session.batch_deltas = true;
    }
    let opened_by = request_id.as_str().unwrap_or("").to_string();
    if let Some(id) = &replay_id {
        if !lock(&hub.replays.session).as_ref().is_some_and(|r| r.id == *id) {
            return write_json(stream, &json!({"type": "view.subscription.error", "request_id": request_id,
                "payload": {"error": "UNKNOWN_REPLAY", "replay_id": id}}));
        }
        // A replay view is the replay's own: it never registers market demand or watches the live instrument.
        session.replays.write().unwrap().insert(id.clone());
        let view_id = format!("sub-{}", hub.next_subscription.fetch_add(1, Ordering::Relaxed));
        session.views.push(View { id: view_id, request_id: opened_by, instrument: instrument.clone(), trading_date: trading_date.clone(), session: sess.clone(),
            channels, bound: None, baseline: 0, sent_sequence: 0, replay: Some(id.clone()), shown: None });
        let index = session.views.len() - 1;
        let view_id = session.views[index].id.clone();
        write_json(stream, &json!({"type": "view.subscription.accepted", "request_id": request_id, "payload": {
            "symbol": instrument.wire(), "subscription_id": view_id, "stream_id": hub.instance_id, "replay_id": id,
            "daemon_instance_id": hub.instance_id, "runtime_epoch": hub.runtime_epoch, "trading_date": trading_date,
            "session": sess, "watermark": 0, "snapshot_follows": true}}))?;
        return send_view_snapshot(stream, hub, session, index, request_id, "");
    }
    // Every subscribe is its own view with its own id, closed only by its own unsubscribe. Handing every subscribe
    // of one spec the same id made a late reply to an abandoned request name the view a newer request was bound
    // to, so closing the "orphan" closed the live view (Futu 成交明細 stalled).
    let id = format!("sub-{}", hub.next_subscription.fetch_add(1, Ordering::Relaxed));
    session.views.push(View { id, request_id: opened_by, instrument: instrument.clone(), trading_date: trading_date.clone(), session: sess.clone(), channels, bound: None, baseline: 0, sent_sequence: 0, replay: None, shown: None });
    let index = session.views.len() - 1;
    // Register interest BEFORE the snapshot cut, so nothing after the cut can be missed.
    session.watched.write().unwrap().insert(instrument.clone());
    lock(&hub.demand).view_opened(session.id, &instrument, now_ns());
    replan(hub);
    request_view_history(hub, &instrument, trading_date.as_deref(), sess.as_deref());
    let resolved = lock(&hub.core).engine.resolve(&instrument, trading_date.as_deref(), sess.as_deref());
    let view_id = session.views[index].id.clone();
    write_json(stream, &json!({"type": "view.subscription.accepted", "request_id": request_id, "payload": {
        "symbol": instrument.wire(), "subscription_id": view_id, "stream_id": hub.instance_id,
        "daemon_instance_id": hub.instance_id, "runtime_epoch": hub.runtime_epoch,
        "trading_date": resolved.as_ref().map(|k| k.session.trading_date.clone()).or(trading_date),
        "session": resolved.as_ref().map(|k| k.session.session.clone()).or(sess),
        "watermark": 0, "snapshot_follows": true}}))?;
    send_view_snapshot(stream, hub, session, index, request_id, "")
}

pub(crate) fn cmd_view_snapshot(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value, request_id: Value) -> io::Result<()> {
    let Some(instrument) = instrument_from(&p) else {
        return write_json(stream, &json!({"type": "error", "error": "symbol/code required"}));
    };
    let trading_date = identity_field(&p, "trading_date");
    let sess = identity_field(&p, "session");
    let channels = channels_from(&p);
    match session.views.iter().position(|v| v.replay.is_none() && v.instrument == instrument && v.trading_date == trading_date && v.session == sess && v.channels == channels) {
        Some(i) => send_view_snapshot(stream, hub, session, i, request_id, ""),
        None => {
            // One-shot read without a subscription.
            let core = lock(&hub.core);
            let key = core.engine.resolve(&instrument, trading_date.as_deref(), sess.as_deref());
            let payload = key.as_ref().map(|k| {
                let breadth = core.breadth.wire();
                wire::snapshot(&hub.identity(), &k.instrument, &k.session.trading_date, &k.session.session, core.engine.state(k),
                    core.projection.entry(k), Some(&breadth), core.view_seq.get(k).copied().unwrap_or(0),
                    hub.committed(), Value::Null, Value::Null)
            });
            drop(core);
            ws::write_frame(stream, 2, &serde_json::to_vec(&json!({"type": "view.snapshot", "request_id": request_id, "payload": payload})).unwrap_or_default())
        }
    }
}

/// One page of a session's trade tape (成交明細往前翻, trade_pages.rs), newest first.
pub(crate) fn cmd_trades_page(stream: &mut FrameWriter, hub: &Arc<Hub>, p: &Value, request_id: Value) -> io::Result<()> {
    let started = Instant::now();
    let req = match PageRequest::parse(p) {
        Ok(req) => req,
        Err(detail) => return invalid_payload(stream, "trades.page", &request_id, &detail),
    };
    let mut payload = trades_page(hub, &req);
    payload["latency_ms"] = json!((started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0);
    write_json(stream, &json!({"type": "trades.page", "request_id": request_id, "payload": payload}))
}

fn trades_page(hub: &Hub, req: &PageRequest) -> Value {
    let answer = |rows: Vec<Value>, paged: &Paged, coverage: &str| json!({
        "ok": true, "market": req.market, "logical_code": req.code, "trading_date": req.trading_date, "session": req.session,
        "rows": rows, "page": req.page, "page_size": req.page_size, "total_rows": paged.total_rows, "total_pages": paged.total_pages,
        "snapshot_watermark": paged.watermark, "coverage": coverage});
    let dated = !req.trading_date.is_empty();
    // A session that names one partition and has been materialized: the historical store's copy.
    if dated && wal_sessions(&req.source, &req.market).contains(&req.session.as_str()) {
        if let Some(root) = hub.config.historical_dir.as_deref() {
            match hub.materialized_trades.tape(root, req) {
                Ok(tape) => {
                    let paged = paginate(&tape.order(), req);
                    let rows = paged.page.iter().map(|&i| tape.row(i, req)).collect();
                    let mut out = answer(rows, &paged, "MATERIALIZED");
                    out["parts_opened"] = json!(1);
                    return out;
                }
                Err(Stored::NotMaterialized) => {}
                Err(Stored::Failed(reason)) => {
                    eprintln!("[market_runtime] trades.page {}:{}:{} {} {}: materialized partition unreadable: {reason}",
                              req.source, req.market, req.code, req.trading_date, req.session);
                    return json!({"ok": false, "error": "MATERIALIZED_PARTITION_UNREADABLE", "detail": reason,
                                  "rows": [], "page": req.page, "page_size": req.page_size});
                }
            }
        }
    }
    if dated && !req.session.is_empty() {
        // Not materialized: an open session, or an ended one whose materialization has not run yet. Its tape is in the
        // WAL, as far as it is committed (a record still in the writer's buffer is not on disk).
        // Prints shown and never stored (an instrument off the background list) are on the same tape, from A's memory
        // (trade_pages::LiveTapes).
        let wal = hub.wal();
        let committed = hub.committed();
        let at = wal.shared.trades.lock().unwrap().positions(&req.key(), committed);
        // Not materialized: the session's state is still held, and its Reference is the comparison price.
        let (live, comparison) = {
            let core = lock(&hub.core);
            let comparison = core.engine.state(&StateKey { instrument: InstrumentKey::new(&req.source, &req.market, &req.code),
                session: SessionKey { trading_date: req.trading_date.clone(), session: req.session.clone() } })
                .and_then(|state| state.reference.comparison_price());
            (core.live_tapes.prints(&req.key()), comparison)
        };
        // Each record of the tape: a stored one's place in the WAL, or a live print's index in `live`.
        let mut tape: Vec<(i64, u64, Result<At, usize>)> = at.iter().map(|a| (a.exchange_ts_ns, a.sequence, Ok(*a)))
            .chain(live.iter().enumerate().map(|(i, p)| (p.trade.exchange_ts_ns, p.stamp, Err(i)))).collect();
        tape.sort_by_key(|(ts, sequence, _)| (*ts, *sequence));
        let order: Vec<(i64, u64)> = tape.iter().map(|(ts, sequence, _)| (*ts, *sequence)).collect();
        // A read that froze nothing is the tape as stored up to now: its watermark is the committed sequence (a live
        // print is stamped with the one of its moment), so the pager freezing on it leaves out what comes after.
        let frozen = if req.snapshot_watermark > 0 { req.clone() } else { PageRequest { snapshot_watermark: committed, ..req.clone() } };
        let paged = paginate(&order, &frozen);
        let wanted: Vec<At> = paged.page.iter().filter_map(|&i| tape[i].2.ok()).collect();
        let ctx = RowContext::of_request(req, comparison);
        let (mut found, segments, problems) = wal_rows(&wal.dir, &wanted, &ctx);
        for problem in &problems {
            eprintln!("[market_runtime] trades.page {}:{}:{} {} {}: {problem}", req.source, req.market, req.code, req.trading_date, req.session);
        }
        let rows = paged.page.iter().filter_map(|&i| match tape[i].2 {
            Ok(a) => found.remove(&a.sequence),
            Err(l) => Some(trade_pages::row(&live[l].trade, &ctx)),
        }).collect();
        let wal_coverage = if problems.is_empty() { "WAL" } else { "WAL_PARTIAL" };
        let mut out = answer(rows, &paged, wal_coverage);
        out["parts_opened"] = json!(segments.len());
        let ended = partition_end_ns(&req.source, &req.market, &req.trading_date, &req.session)
            .is_some_and(|end| now_ns() as i64 >= end);
        if ended {
            let found = paged.total_rows > 0;
            out["wal_coverage"] = json!(wal_coverage);
            out["coverage"] = json!(if found { "PENDING" } else { "MISSING" });
            out["coverage_reason"] = json!(if found { "session ended; not materialized yet, served from the WAL" }
                                           else { "session ended; not materialized and the WAL holds no trades for it" });
        }
        return out;
    }
    // No partition named: only the newest trades this process holds for the instrument can be answered.
    let instrument = InstrumentKey::new(&req.source, &req.market, &req.code);
    let core = lock(&hub.core);
    let key = core.engine.resolve(&instrument, (!req.trading_date.is_empty()).then_some(req.trading_date.as_str()),
                                  (!req.session.is_empty()).then_some(req.session.as_str()));
    let Some(state) = key.as_ref().and_then(|k| core.engine.state(k)) else {
        return answer(Vec::new(), &paginate(&[], req), "LIVE");
    };
    let ctx = RowContext::of_state(state);
    let mut tape: Vec<((i64, u64), Value)> = state.recent_trades.iter().filter(|t| !t.simtrade)
        .map(|t| ((t.exchange_ts_ns, t.durable_sequence), trade_pages::row(t, &ctx))).collect();
    drop(core);
    tape.sort_by_key(|(order, _)| *order);
    let order: Vec<(i64, u64)> = tape.iter().map(|(order, _)| *order).collect();
    let paged = paginate(&order, req);
    let rows = paged.page.iter().map(|&i| tape[i].1.clone()).collect();
    let mut out = answer(rows, &paged, "LIVE");
    out["parts_opened"] = json!(0);
    out
}

pub(crate) fn cmd_view_resync(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value, request_id: Value) -> io::Result<()> {
    let id = p.get("subscription_id").and_then(Value::as_str).unwrap_or("").to_string();
    // Why the client asks, from a closed list (anything else is recorded as "unspecified"), so a re-baseline is
    // countable by view and reason across days.
    let asked = p.get("reason").and_then(Value::as_str).unwrap_or("");
    let reason = CLIENT_RESYNC_REASONS.iter().copied().find(|r| *r == asked).unwrap_or("unspecified");
    match session.views.iter().position(|v| v.id == id) {
        Some(i) => {
            let before = (session.views[i].bound.clone(), session.views[i].sent_sequence);
            let client_sequence = p.get("last_sequence").and_then(Value::as_u64);
            let result = send_view_snapshot(stream, hub, session, i, request_id, "CLIENT_REQUESTED");
            let view = &session.views[i];
            let partition = |key: &Option<StateKey>| key.as_ref().map(|k| format!("{}/{}", k.session.trading_date, k.session.session));
            remediation::emit(remediation::Emit { component: "view_delivery", mechanism_id: "market.client_resync",
                trigger_reason: reason,
                identity: remediation::Identity { source: Some(view.instrument.source.clone()), market: Some(view.instrument.market.clone()),
                    code: Some(view.instrument.code.clone()),
                    session: view.bound.as_ref().map(|k| k.session.session.clone()),
                    trading_date: view.bound.as_ref().map(|k| k.session.trading_date.clone()),
                    view_id: Some(view.id.clone()), subscription_id: Some(view.id.clone()),
                    connection_id: Some(session.id.to_string()) },
                attempt: None, outcome: if result.is_ok() { "succeeded" } else { "failed" },
                detail: json!({"client_sequence": client_sequence, "sequence_before": before.1, "sequence_after": view.sent_sequence,
                               "partition_before": partition(&before.0), "partition_after": partition(&view.bound),
                               "error": result.as_ref().err().map(|e| e.to_string())})});
            result
        }
        None => write_json(stream, &json!({"type": "view.subscription.error", "payload": {"subscription_id": id, "error": "unknown subscription"}})),
    }
}

/// Closes views by their subscription id, by the view.subscribe request that opened them, or by instrument. A client
/// that lets go of a view before the reply arrives names the request: one connection's commands run in order, so the
/// subscribe has already opened its view (or been refused) when the cancel is read, and the cancel always finds it.
pub(crate) fn cmd_view_unsubscribe(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value) -> io::Result<()> {
    let id = p.get("subscription_id").and_then(Value::as_str).unwrap_or("").to_string();
    let request = p.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
    let removed: Vec<View> = if !id.is_empty() {
        let (gone, keep): (Vec<View>, Vec<View>) = std::mem::take(&mut session.views).into_iter().partition(|v| v.id == id);
        session.views = keep;
        gone
    } else if !request.is_empty() {
        let (gone, keep): (Vec<View>, Vec<View>) = std::mem::take(&mut session.views).into_iter().partition(|v| v.request_id == request);
        session.views = keep;
        gone
    } else if let Some(instrument) = instrument_from(&p) {
        let (gone, keep): (Vec<View>, Vec<View>) = std::mem::take(&mut session.views).into_iter().partition(|v| v.instrument == instrument);
        session.views = keep;
        gone
    } else {
        Vec::new()
    };
    let mut changed = false;
    for view in &removed {
        if let Some(id) = &view.replay {
            if !session.views.iter().any(|v| v.replay.as_ref() == Some(id)) {
                session.replays.write().unwrap().remove(id);
            }
            continue;
        }
        if !session.views.iter().any(|v| v.replay.is_none() && v.instrument == view.instrument) {
            session.watched.write().unwrap().remove(&view.instrument);
            lock(&hub.demand).view_closed(session.id, &view.instrument);
            changed = true;
        }
    }
    if changed {
        replan(hub);
    }
    // A cancel by request learns here which view it closed (none when the subscribe was refused).
    let closed_id = if id.is_empty() { removed.first().map(|v| v.id.clone()).unwrap_or_default() } else { id };
    let request = if request.is_empty() { Value::Null } else { Value::String(request) };
    write_json(stream, &json!({"type": "view.unsubscribed", "payload": {"subscription_id": closed_id, "request_id": request,
        "closed": removed.len(), "remaining_views": session.views.len()}}))
}

pub(crate) fn cmd_replay_close(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value, request_id: Value) -> io::Result<()> {
    let id = identity_field(&p, "replay_id").unwrap_or_default();
    // Only the connection that opened a replay closes it (never another viewer).
    let (closed, error) = {
        let mut slot = lock(&hub.replays.session);
        match slot.as_ref().filter(|r| r.id == id) {
            None => (false, Some("UNKNOWN_REPLAY")),
            Some(r) if r.owner != session.id => (false, Some("NOT_OWNER")),
            Some(_) => {
                if let Some(replay) = slot.take() {
                    replay_closed(hub, &replay);
                }
                (true, None)
            }
        }
    };
    // `ok` like every other replay reply: whether the request was done (a refusal names its error).
    write_json(stream, &json!({"type": "replay.closed", "request_id": request_id,
        "payload": {"ok": closed, "replay_id": id, "closed": closed, "error": error}}))
}

pub(crate) fn cmd_workspace_replace(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value) -> io::Result<()> {
    let market = p.get("market").and_then(Value::as_str).unwrap_or("STK").to_string();
    let source = p.get("source").and_then(Value::as_str).unwrap_or_else(|| source_for_market(&market)).to_string();
    let mut set: BTreeSet<InstrumentKey> = BTreeSet::new();
    let mut refused: Vec<&str> = Vec::new();
    for c in p.get("codes").or_else(|| p.get("symbols")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        // A qualified entry names its instrument only as source:MARKET:CODE; another form is refused and answered.
        match if c.contains(':') { InstrumentKey::parse(c) } else { Some(InstrumentKey::new(&source, &market, c)) } {
            Some(key) => { set.insert(key); }
            None => refused.push(c),
        }
    }
    if !refused.is_empty() {
        eprintln!("[market_runtime] workspace.replace refused entries {refused:?}: a qualified symbol is source:MARKET:CODE");
    }
    lock(&hub.demand).set_workspace(session.id, set);
    replan(hub);
    write_json(stream, &json!({"type": "workspace.replace.ack", "payload": {"refused": refused}}))
}

/// `adapter.register`: every field is required -- a missing limit used to become 200 and a malformed kind list an
/// empty one, so the plan was built for a capacity the provider never stated. `stream_budget` is the one optional
/// field: a provider whose broker counts streams states it (service/market/shared/adapter_control.py), and the plan
/// is then billed in streams (demand::StreamBudget); a malformed one refuses the registration.
#[derive(serde::Deserialize)]
pub(crate) struct AdapterRegister {
    pub(crate) source: String,
    pub(crate) max_subscriptions: u32,
    pub(crate) kinds: Vec<Kind>,
    #[serde(default)]
    pub(crate) stream_budget: Option<StreamBudgetWire>,
    /// What this provider subscribed stays subscribed until its session is materialized (Shioaji, user 11-13).
    #[serde(default)]
    pub(crate) hold_until_close: bool,
}

/// `demand.release`: a closed session is materialized, so what was held subscribed for it is let go (the provider
/// that owns the session's lifecycle says so; rollover lets go of whatever no release named).
#[derive(serde::Deserialize)]
struct DemandRelease {
    source: String,
    markets: Vec<String>,
    trading_date: String,
    session: String,
}

fn cmd_demand_release(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value) -> io::Result<()> {
    let Role::Provider(own) = &session.role else { return forbidden(stream, hub, session, "demand.release") };
    let release: DemandRelease = match serde_json::from_value(p.clone()) {
        Ok(release) => release,
        Err(e) => return invalid_payload(stream, "demand.release", &Value::Null, &e.to_string()),
    };
    if !release.source.eq_ignore_ascii_case(own) {
        return forbidden(stream, hub, session, "demand.release(other source)");
    }
    let released = lock(&hub.demand).release_session(&release.source.to_lowercase(), &release.markets, &release.trading_date, &release.session);
    write_json(stream, &json!({"type": "demand.released", "payload": {"source": release.source, "markets": release.markets,
        "trading_date": release.trading_date, "session": release.session, "released": released}}))?;
    if released {
        replan(hub);
    }
    Ok(())
}

pub(crate) fn cmd_adapter_register(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value) -> io::Result<()> {
    let Role::Provider(own) = &session.role else { return forbidden(stream, hub, session, "adapter.register") };
    let register: AdapterRegister = match serde_json::from_value(p.clone()) {
        Ok(register) => register,
        Err(e) => return invalid_payload(stream, "adapter.register", &Value::Null, &e.to_string()),
    };
    let source = register.source.to_lowercase();
    if source != *own {
        return forbidden(stream, hub, session, "adapter.register(other source)");
    }
    let capacity = match AdapterCapacity::new(register.max_subscriptions as usize, register.kinds).and_then(|capacity| {
        match register.stream_budget {
            Some(wire) => StreamBudget::new(wire).map(|budget| capacity.with_streams(budget)),
            None => Ok(capacity),
        }
    }) {
        Ok(capacity) => capacity.holding_until_close(register.hold_until_close),
        Err(e) => return invalid_payload(stream, "adapter.register", &Value::Null, &e),
    };
    let limit = capacity.limit;
    if session.adapter_source.as_deref() == Some(source.as_str()) {
        // The same connection registering again: the provider's capacity changed (設定 → 永豐行情連線). One adapter
        // connection still, a fresh plan within the new limit.
        lock(&hub.demand).set_adapter_capacity(&source, capacity);
    } else {
        lock(&hub.demand).register_adapter(&source, capacity);
        lock(&hub.broker_since).entry(source.clone()).or_insert(now_ns() as i64);
        session.adapter_source = Some(source.clone());
        session.adapter.store(true, Ordering::Release);
    }
    write_json(stream, &json!({"type": "adapter.registered", "payload": {"source": source, "max_subscriptions": limit}}))?;
    replan(hub);
    flush_view_history(hub, &source);
    Ok(())
}

pub(crate) fn cmd_adapter_subscription_status(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value) -> io::Result<()> {
    let Role::Provider(own) = &session.role else { return forbidden(stream, hub, session, "adapter.subscription.status") };
    let generation = p.get("generation").and_then(Value::as_u64).unwrap_or(0);
    let items = |name: &str| -> Vec<(InstrumentKey, String)> {
        p.get(name).and_then(Value::as_array).into_iter().flatten().filter_map(|v| {
            let market = v.get("market").and_then(Value::as_str)?;
            let code = v.get("code").and_then(Value::as_str)?;
            let extra = v.get("reason").or_else(|| v.get("state")).and_then(Value::as_str).unwrap_or("").to_string();
            Some((InstrumentKey::new(own, market, code), extra))
        }).collect()
    };
    let subscribed: Vec<InstrumentKey> = items("subscribed").into_iter().map(|(k, _)| k).collect();
    // When each one's print stream was subscribed in the provider's process (a provider that fills gaps states it).
    let since: Vec<(InstrumentKey, i64)> = p.get("subscribed").and_then(Value::as_array).into_iter().flatten().filter_map(|v| {
        let key = InstrumentKey::new(own, v.get("market").and_then(Value::as_str)?, v.get("code").and_then(Value::as_str)?);
        Some((key, v.get("since_ns").and_then(Value::as_i64)?))
    }).collect();
    // What the broker still holds although the plan dropped it (its unsubscribe waits out a minimum subscription
    // time): it is still pushed, so it stays covered until the provider reports it gone.
    let draining: BTreeSet<InstrumentKey> = items("draining").into_iter().map(|(k, _)| k).collect();
    let confirmed: BTreeSet<InstrumentKey> = subscribed.iter().cloned().chain(draining.iter().cloned()).collect();
    let result = {
        let mut demand = lock(&hub.demand);
        demand.report(own, generation, subscribed, items("failed")).and_then(|()| demand.set_draining(own, draining))
    };
    if result.is_ok() {
        {
            let mut core = lock(&hub.core);
            let Core { late_joins, evidence, .. } = &mut *core;
            late_joins.subscribed(own, since, evidence);
        }
        write_coverage(hub, own, confirmed);
    }
    write_json(stream, &json!({"type": "adapter.subscription.status.ack", "payload": {"ok": result.is_ok(), "error": result.err()}}))
}

pub(crate) fn cmd_durable_subscribe(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value) -> io::Result<()> {
    let after = p.get("after_sequence").and_then(Value::as_u64).unwrap_or(0);
    let committed = hub.committed();
    let integrity = lock(&hub.integrity).clone();
    session.wants_durable.store(true, Ordering::Release);
    session.set_durable(DurableMode::Replay { next: after + 1 });
    forget_live_coverage(hub);
    // The open replay's timeline: a B building it carries on, one that has none (restarted) builds what is missing.
    // Its id goes in the answer: B lets go of any other replay it still holds. What is queued for this connection is
    // delivered after this answer, so a replay opened from here on reaches B after B has compared.
    let open_replay = lock(&hub.replays.session).as_ref().map(|replay| {
        tell_b_replay(hub, Some(session.id), replay);
        replay.id.clone()
    });
    write_json(stream, &json!({"type": "durable.subscribed", "payload": {
        "after_sequence": after, "durable_sequence": committed, "durable_stream_id": hub.durable_stream_id,
        "runtime_epoch": hub.runtime_epoch, "replay_id": open_replay, "wal_integrity": integrity.status,
        "sequence_gaps": integrity.sequence_gaps, "event_schema_version": EVENT_SCHEMA_VERSION,
        "rolled": lock(&hub.core).engine.rolled(), "cleared": lock(&hub.core).engine.cleared()}}))?;
    // the never-stored coverage this B does not have yet, right after its subscription
    reconcile_coverage(hub);
    Ok(())
}

pub(crate) fn cmd_projection_reset(stream: &mut FrameWriter, hub: &Arc<Hub>, p: &Value) -> io::Result<()> {
    let epoch = p.get("projection_epoch").and_then(Value::as_u64).unwrap_or(0);
    let reason = p.get("reason").and_then(Value::as_str).unwrap_or("reset").to_string();
    let invalidated = lock(&hub.core).projection.reset(epoch, &reason);
    // The views showing what was just invalidated are told at once: a re-snapshot (B's blocks RECOVERING).
    if !invalidated.is_empty() {
        let keys: Arc<HashSet<StateKey>> = Arc::new(invalidated.into_iter().collect());
        broadcast_role(hub, |c| c.role == Role::Viewer, Outgoing { kind: OutKind::KeysResync(keys), bytes: Arc::new(Vec::new()), trace: None });
    }
    write_json(stream, &json!({"type": "projection.reset.ack", "payload": {"projection_epoch": epoch}}))
}

pub(crate) fn cmd_signals_publish(stream: &mut FrameWriter, hub: &Arc<Hub>, p: &Value, request_id: Value) -> io::Result<()> {
    let items = match batch_field(p, "items") {
        Ok(items) => items.clone(),
        Err(detail) => return invalid_payload(stream, "signals.publish", &request_id, &detail),
    };
    let now = now_ns();
    let mut merged = 0;
    // Fenced like a projection publish: the batch must be of this durable stream and of an epoch
    // no older than the projection's; a row of a session that rolled over never brings it back.
    if !items.is_empty() {
        if p.get("durable_stream_id").and_then(Value::as_str) != Some(hub.durable_stream_id.as_str()) {
            hub.counters.projection_rejected.fetch_add(1, Ordering::Relaxed);
            return write_json(stream, &json!({"type": "signals.ack", "request_id": request_id,
                "payload": {"merged": merged, "ok": false, "reason": "STREAM_MISMATCH"}}));
        }
        let epoch = p.get("projection_epoch").and_then(Value::as_u64).unwrap_or(0);
        let current = lock(&hub.core).projection.analysis_epoch;
        if epoch < current {
            hub.counters.projection_rejected.fetch_add(1, Ordering::Relaxed);
            return write_json(stream, &json!({"type": "signals.ack", "request_id": request_id,
                "payload": {"merged": merged, "ok": false, "reason": format!("projection epoch {epoch} is older than {current}")}}));
        }
    }
    let mut rolled = 0;
    // A row that does not name an instrument, trading date and session, or carries no row object, is refused by its
    // position in the batch (listed in the ack and logged here); the rest of the batch still applies, and the batch is
    // not refused as a whole -- a refusal makes B resend everything, and a row that cannot parse never will.
    let mut invalid: Vec<Value> = Vec::new();
    // Every row of the batch is merged first and each instrument's views get ONE signals frame with the merged set: B
    // sends one row per model slot, and a frame per row put ten whole signals sets per inference on every viewer.
    let mut touched: Vec<StateKey> = Vec::new();
    let mut core = lock(&hub.core);
    for (position, item) in items.iter().enumerate() {
        let (Some(instrument), Some(row)) = (instrument_from(&item["identity"]), item.get("row").and_then(Value::as_object)) else {
            invalid.push(json!({"index": position, "reason": "identity names no instrument or row is not an object"}));
            continue;
        };
        let key = match (identity_field(&item["identity"], "trading_date"), identity_field(&item["identity"], "session")) {
            (Some(d), Some(s)) => StateKey { instrument, session: SessionKey { trading_date: d, session: s } },
            _ => {
                invalid.push(json!({"index": position, "reason": "identity names no trading_date or session"}));
                continue;
            }
        };
        if core.engine.is_gone(&key) {
            rolled += 1;
            continue;
        }
        core.projection.merge_signals(key.clone(), row, now);
        if !touched.contains(&key) {
            touched.push(key);
        }
        merged += 1;
    }
    for key in touched {
        let signals = core.projection.entry(&key).and_then(|e| e.signals.clone()).map(Value::Object).unwrap_or(Value::Null);
        let generation = core.engine.state(&key).map(|s| s.generation).unwrap_or(0);
        emit_delta(hub, &mut core, &key, generation, "signals.frame", &["signals"], json!({"signals": signals}), Map::new(), None);
    }
    drop(core);
    if !invalid.is_empty() {
        eprintln!("[market_runtime] signals.publish: {} invalid rows refused: {}", invalid.len(), Value::Array(invalid.clone()));
    }
    write_json(stream, &json!({"type": "signals.ack", "request_id": request_id, "payload": {"merged": merged, "ok": true,
        "rolled_over": rolled, "invalid": invalid}}))
}

pub(crate) fn cmd_signals_snapshot(stream: &mut FrameWriter, hub: &Arc<Hub>, request_id: Value) -> io::Result<()> {
    let rows: Vec<Value> = lock(&hub.core).projection.signal_rows().into_iter().map(|(key, mut row)| {
        row.insert("source".into(), json!(key.instrument.source));
        row.insert("market".into(), json!(key.instrument.market));
        row.insert("code".into(), json!(key.instrument.code));
        row.insert("trading_date".into(), json!(key.session.trading_date));
        row.insert("session".into(), json!(key.session.session));
        Value::Object(row)
    }).collect();
    write_json(stream, &json!({"type": "signals.snapshot", "request_id": request_id, "payload": {"signals": rows}}))
}

pub(crate) fn cmd_events_subscribe(stream: &mut FrameWriter, hub: &Arc<Hub>, session: &mut Session, p: &Value, request_id: Value) -> io::Result<()> {
    let market = identity_field(&p, "market").unwrap_or_else(|| "STK".into()).to_uppercase();
    let sess = identity_field(&p, "session").unwrap_or_else(|| "DAY".into());
    let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(600).clamp(1, 5000) as usize;
    let trading_date = identity_field(&p, "trading_date");
    if let Some(date) = trading_date.as_deref().filter(|d| crate::event::parse_calendar_date(d).is_none()) {
        return invalid_payload(stream, "events.subscribe", &request_id, &format!("trading_date {date:?} is not a YYYY-MM-DD date"));
    }
    let core = lock(&hub.core);
    *session.event_tape.write().unwrap() = Some((market.clone(), sess.clone(), limit));
    let payload = event_tape_snapshot(hub, &core, &market, &sess, limit, trading_date);
    drop(core);
    write_json(stream, &json!({"type": "events.snapshot", "request_id": request_id, "payload": payload}))
}

pub(crate) fn cmd_background_replace(stream: &mut FrameWriter, hub: &Arc<Hub>, p: &Value) -> io::Result<()> {
    // The whole list validates or nothing is replaced: an unparsable list read as empty cleared every background owner.
    let refuse = |stream: &mut FrameWriter, error: String| {
        eprintln!("[market_runtime] background.replace refused: {error}");
        write_json(stream, &json!({"type": "background.replace.ack", "payload": {"ok": false, "error": error,
            "applied_revision": lock(&hub.demand).background().revision}}))
    };
    let revision = match p.get("revision") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_u64() {
            Some(revision) => Some(revision),
            None => return refuse(stream, format!("revision {value} is not a revision number")),
        },
    };
    let Some(items) = p.get("items") else { return refuse(stream, "items required".into()) };
    let items = match serde_json::from_value(items.clone()) {
        Ok(items) => items,
        Err(e) => return refuse(stream, format!("items do not parse: {e}")),
    };
    let list = BackgroundList { revision, items };
    let result = install_background(hub, list);
    write_json(stream, &json!({"type": "background.replace.ack", "payload": {"ok": result.is_ok(), "error": result.err(),
        "applied_revision": lock(&hub.demand).background().revision}}))
}

pub(crate) fn cmd_breadth_configure(stream: &mut FrameWriter, hub: &Arc<Hub>, p: &Value) -> io::Result<()> {
    let mut config: BreadthConfig = match serde_json::from_value(p.get("config").cloned().unwrap_or(Value::Null)) {
        Ok(c) => c,
        Err(e) => return write_json(stream, &json!({"type": "breadth.configure.ack", "payload": {"ok": false, "error": e.to_string()}})),
    };
    config.revision = p.get("revision").and_then(Value::as_u64);
    let wire = apply_breadth(hub, config);
    write_json(stream, &json!({"type": "breadth.configure.ack", "payload": {"ok": true, "breadth": wire}}))
}

pub(crate) const QUERY_TTL: Duration = Duration::from_secs(15);

pub(crate) const QUERIES_MAX: usize = 256;

/// Large-order window queries forwarded to B: query id -> (asking viewer's client id, its request id, when).
/// A query is registered before it is sent, so an answer can never arrive before its correlation exists; a query
/// that outlived `QUERY_TTL` and an answer nobody waits for are counted and named, never dropped silently.
#[derive(Default)]
pub(crate) struct LargeOrderQueries {
    pub(crate) pending: HashMap<String, (u64, Value, Instant)>,
    pub(crate) expired: u64,
    pub(crate) unrouted: u64,
    pub(crate) last_unrouted: Option<String>,
}

impl LargeOrderQueries {
    /// Reserve a correlation; Err when `QUERIES_MAX` are already waiting.
    pub(crate) fn reserve(&mut self, query_id: &str, client_id: u64, request_id: Value) -> Result<(), ()> {
        let before = self.pending.len();
        self.pending.retain(|_, (_, _, at)| at.elapsed() < QUERY_TTL);
        self.expired += (before - self.pending.len()) as u64;
        if self.pending.len() >= QUERIES_MAX {
            return Err(());
        }
        self.pending.insert(query_id.to_string(), (client_id, request_id, Instant::now()));
        Ok(())
    }

    pub(crate) fn take(&mut self, query_id: &str) -> Option<(u64, Value)> {
        self.pending.remove(query_id).map(|(client, request, _)| (client, request))
    }

    pub(crate) fn unrouted(&mut self, why: String) {
        eprintln!("[market_runtime] flow.large_orders.result not routed: {why}");
        self.unrouted += 1;
        self.last_unrouted = Some(why);
    }

    pub(crate) fn status(&self) -> Value {
        json!({"pending": self.pending.len(), "capacity": QUERIES_MAX, "expired": self.expired,
               "unrouted": self.unrouted, "last_unrouted": self.last_unrouted})
    }
}

/// Forward a viewer's large-order window query to B. Some(refusal) when it cannot be asked at all.
pub(crate) fn forward_large_orders_query(hub: &Hub, client_id: u64, p: &Value, request_id: Value) -> Option<Value> {
    let Some(instrument) = instrument_from(p) else {
        return Some(json!({"ok": false, "reason": "symbol/code required", "request_id": request_id, "rows": []}));
    };
    let query_id = format!("q{}-{}", client_id, hub.next_subscription.fetch_add(1, Ordering::Relaxed));
    let query = json!({"type": "flow.large_orders.query", "payload": {"query_id": query_id,
        "identity": {"source": instrument.source, "market": instrument.market, "code": instrument.code,
                     "trading_date": identity_field(p, "trading_date"), "session": identity_field(p, "session")},
        "from_minute": p.get("from_minute"), "to_minute": p.get("to_minute"), "limit": p.get("limit"), "side": p.get("side")}});
    let bytes = match serde_json::to_vec(&query) {
        Ok(bytes) => Arc::new(bytes),
        Err(e) => return Some(json!({"ok": false, "reason": format!("ENCODE_FAILED: {e}"), "request_id": request_id, "rows": []})),
    };
    if lock(&hub.queries).reserve(&query_id, client_id, request_id.clone()).is_err() {
        return Some(json!({"ok": false, "reason": "TOO_MANY_QUERIES", "request_id": request_id, "rows": []}));
    }
    let sent = {
        let clients = hub.clients.read().unwrap();
        // B's reader connection (the one consuming the durable stream) answers queries; its publisher only publishes.
        let reader = clients.iter().find(|c| c.role == Role::AnalysisRuntime && c.wants_durable.load(Ordering::Acquire));
        reader.is_some_and(|c| c.tx.try_send(Outgoing { kind: OutKind::Adapter, bytes, trace: None }).is_ok())
    };
    if !sent {
        lock(&hub.queries).take(&query_id);
        return Some(json!({"ok": false, "reason": "ANALYSIS_RUNTIME_UNAVAILABLE", "request_id": request_id, "rows": []}));
    }
    None
}

/// B's answer goes to the viewer that asked, and only to it; an answer without a query id, of an unknown or expired
/// query, or to a viewer that has left is counted and named.
pub(crate) fn route_large_orders_result(hub: &Hub, mut p: Value) {
    let Some(query_id) = p.get("query_id").and_then(Value::as_str).map(str::to_string) else {
        lock(&hub.queries).unrouted("an answer without a query_id".into());
        return;
    };
    let Some((client_id, request_id)) = lock(&hub.queries).take(&query_id) else {
        lock(&hub.queries).unrouted(format!("{query_id}: no query waits for it (unknown or expired)"));
        return;
    };
    if let Some(obj) = p.as_object_mut() {
        obj.remove("query_id");
        obj.insert("request_id".into(), request_id.clone());
    }
    let bytes = Arc::new(serde_json::to_vec(&json!({"type": "flow.large_orders.result", "request_id": request_id, "payload": p})).unwrap_or_default());
    let clients = hub.clients.read().unwrap();
    match clients.iter().find(|c| c.id == client_id) {
        Some(client) => send_to(client, Outgoing { kind: OutKind::Adapter, bytes, trace: None }, &hub.counters),
        None => lock(&hub.queries).unrouted(format!("{query_id}: viewer {client_id} has disconnected")),
    }
}
