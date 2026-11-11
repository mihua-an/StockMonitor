//! 分析資料重建中: whether Rust B is rebuilding or catching up, and how far, for every screen that shows B's blocks.
//!
//! B reports its state, cursor and where its catching-up span started (`analysis.status`, every 2 s); Market Runtime
//! measures the progress against its own committed durable head -- the head B is catching up to -- and pushes the
//! result to viewers as `analysis.state`: on connect, at every report while B catches up, and once when the state
//! changes. It is a connection-level notice, never part of a view snapshot: each block's own meta still says whether
//! that block is there.

use super::hub::*;
use crate::contract::Role;
use crate::projection::ProjectionCache;
use serde_json::{json, Value};
use std::sync::Arc;

/// What viewers are told: `state` is B's (CATCHING_UP / LIVE / INCOMPATIBLE), or OFFLINE while no B session reports;
/// `progress` (0..1) only while catching up with a known span start.
pub(crate) fn wire(projection: &ProjectionCache, committed: u64) -> Value {
    let reported = &projection.analysis_reported;
    let state = if projection.analysis_reporter.is_some() { reported["state"].as_str().unwrap_or("OFFLINE") } else { "OFFLINE" };
    let cursor = reported["cursor"].as_u64();
    let from = reported["catch_up_from"].as_u64();
    let progress = match (state, cursor, from) {
        ("CATCHING_UP", Some(cursor), Some(from)) if committed > from => {
            Some((cursor.saturating_sub(from) as f64 / (committed - from) as f64).clamp(0.0, 1.0))
        }
        _ => None,
    };
    json!({"state": state, "cursor": cursor, "head": committed, "catch_up_from": from, "progress": progress})
}

/// The `analysis.state` message a viewer gets when it connects.
pub(crate) fn current_message(hub: &Hub) -> Value {
    let committed = hub.committed();
    let core = lock(&hub.core);
    json!({"type": "analysis.state", "payload": wire(&core.projection, committed)})
}

/// B's `analysis.status`: kept when its projection epoch is not older than the one Market Runtime holds.
pub(crate) fn on_status(hub: &Hub, session_id: u64, payload: &Value) {
    let committed = hub.committed();
    let message = {
        let mut core = lock(&hub.core);
        let projection = &mut core.projection;
        if payload.get("projection_epoch").and_then(Value::as_u64).unwrap_or(0) < projection.analysis_epoch {
            return;
        }
        projection.analysis_reported = payload.clone();
        projection.analysis_reporter = Some(session_id);
        pending_notice(projection, committed)
    };
    broadcast(hub, message);
}

/// The B session that reported ended: viewers hear OFFLINE rather than a rebuild that no longer advances.
pub(crate) fn on_session_end(hub: &Hub, session_id: u64) {
    let committed = hub.committed();
    let message = {
        let mut core = lock(&hub.core);
        let projection = &mut core.projection;
        if projection.analysis_reporter != Some(session_id) {
            return;
        }
        projection.analysis_reporter = None;
        pending_notice(projection, committed)
    };
    broadcast(hub, message);
}

/// The notice to push now, if any: every report while catching up (its progress moved), and a change of state.
fn pending_notice(projection: &mut ProjectionCache, committed: u64) -> Option<Vec<u8>> {
    let next = wire(projection, committed);
    let state = next["state"].as_str().unwrap_or_default().to_string();
    if state != "CATCHING_UP" && projection.analysis_shown_state.as_deref() == Some(state.as_str()) {
        return None;
    }
    projection.analysis_shown_state = Some(state);
    Some(json!({"type": "analysis.state", "payload": next}).to_string().into_bytes())
}

fn broadcast(hub: &Hub, message: Option<Vec<u8>>) {
    if let Some(bytes) = message {
        broadcast_role(hub, |c| c.role == Role::Viewer, Outgoing { kind: OutKind::Adapter, bytes: Arc::new(bytes), trace: None });
    }
}
