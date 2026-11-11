//! Health's channel: JSON lines out on stdout (hello, metrics, stopped), commands in on stdin (shutdown, reload, metrics).

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use crate::timing;
use super::{shared::*, inference_runtime::*};

/// Failed writes of the stdout management channel to Health, for the stderr record.
pub(crate) static STDOUT_FAILURES: AtomicU64 = AtomicU64::new(0);

/// One line of the stdout management channel. A failed write is recorded on stderr (Health's service log): the first
/// one, then every 100th with the running count, so a channel that stays broken is not one line every 2 s.
pub(crate) fn stdout_line(value: &Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let written = out.write_all(value.to_string().as_bytes()).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush());
    if let Err(error) = written {
        let failures = STDOUT_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
        if failures == 1 || failures % 100 == 0 {
            let kind = value.get("type").and_then(Value::as_str).unwrap_or("?");
            eprintln!("[analysis_runtime] writing the {kind} line to Health failed: {error} ({failures} failed writes so far)");
        }
    }
}

/// What B keeps of Health's stop deadline for its own `stopped` report.
pub(crate) const STOP_REPORT_MARGIN_MS: u64 = 2_000;

pub(crate) fn metrics(shared: &Shared) -> Value {
    let v = shared.view.lock().unwrap().clone();
    let c = &shared.counters;
    let load = |a: &AtomicU64| a.load(Ordering::Relaxed);
    json!({
        "type": "metrics", "schema": "analysis-runtime-metrics-v1", "service_id": SERVICE_ID, "instance_id": shared.instance,
        "incompatible": *shared.incompatible.lock().unwrap(),
        "pid": std::process::id(), "sampled_at_ns": now_ns().to_string(),
        "stream": {"connected": v.connected, "state": v.state, "cursor": v.cursor, "head": v.head, "lag": v.lag, "lag_unit": "events",
                   "stream_id": v.stream_id, "runtime_epoch": v.runtime_epoch, "resets": v.resets, "gaps": v.gaps,
                   "permanent_holes": v.permanent_holes, "undeclared_gaps": v.undeclared_gaps, "pruned_skipped": v.pruned_skipped, "duplicates": v.duplicates, "last_error": v.last_error},
        "engine": v.engine, "rules": v.rules, "checkpoint": v.last_checkpoint, "paper": v.paper, "replay_timelines": v.replay_timelines,
        "publish": {"messages": load(&c.publish_messages), "items": load(&c.publish_items), "bytes": load(&c.publish_bytes),
                    "acks_ok": load(&c.publish_acks_ok), "acks_rejected": load(&c.publish_acks_rejected), "duplicates": load(&c.publish_duplicate),
                    "requeued": load(&c.publish_requeued), "dropped": load(&c.publish_dropped), "contract_refused": load(&c.publish_contract_refused), "in_flight": v.publish_in_flight,
                    "last_publish_us": v.last_publish_us, "rebuilds": load(&c.rebuilds),
                    "undecodable_events": load(&c.undecodable_events), "voided_events": load(&c.voided_events), "old_format_events": load(&c.old_format_events), "contract_violations": load(&c.contract_violations)},
        "features": {"keys": v.feature_keys, "warm_keys": v.feature_warm_keys, "spec_id": shared.spec.spec_id},
        "signals": shared.signals_health.lock().unwrap().clone(),
        "checkpoints": {"written": load(&c.checkpoints), "errors": load(&c.checkpoint_errors), "skipped_busy": load(&c.checkpoints_skipped_busy),
                        "captured": load(&c.checkpoints_captured), "failed_by_stage": shared.checkpoint_failed_by_stage.lock().unwrap().clone()},
        "reconnects": load(&c.reconnects),
        "event_archive": shared.archive.lock().unwrap().status(),
        "volume_baseline": shared.baselines.status(),
        "inference_config": shared.config_state.lock().unwrap().clone(),
        "status_write_failures": STATUS_WRITE_FAILURES.snapshot(),
    })
}

/// Health's commands on stdin, until `shutdown` or EOF (Health gone: finish the durable part and leave rather than
/// orphan).
pub(crate) fn serve_health_commands(shared: &Shared) {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("[analysis_runtime] reading Health's command channel failed: {error}; stopping as if Health had gone");
                break;
            }
        };
        let message = match serde_json::from_str::<Value>(&line) {
            Ok(message) => message,
            Err(error) => {
                eprintln!("[analysis_runtime] Health command is not JSON ({error}): {}", line.chars().take(200).collect::<String>());
                continue;
            }
        };
        match message.get("type").and_then(Value::as_str) {
            Some("shutdown") => {
                // Health says how long it waits; B answers a margin before that, its report included.
                let within = message.get("deadline_ms").and_then(Value::as_u64).unwrap_or(timing::DEFAULT_STOP_WITHIN.as_millis() as u64);
                *shared.stop_deadline.lock().unwrap() = Some(Instant::now() + Duration::from_millis(within.saturating_sub(STOP_REPORT_MARGIN_MS)));
                break;
            }
            Some("reload") => shared.reload.store(true, Ordering::Release),
            Some("metrics") => stdout_line(&metrics(shared)),
            other => eprintln!("[analysis_runtime] unknown Health command {other:?} ignored"),
        }
    }
}
