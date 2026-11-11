//! The session evidence on a provider's connection (crate::evidence): who the provider process is (`ingest.hello`),
//! what it lost before Market Runtime (`ingest.loss`), and its session owners' decisions (`evidence.seal`,
//! `evidence.quarantine`, `evidence.mark_repaired`, `evidence.prune`). A command's reply comes once the partition's
//! file is written: the owner reads the file after it. The records are changed under `core` and written outside it.

use crate::evidence::{closed_through_path, is_closed_on_disk, path_of, File, FillReport, LossReport, PartitionId, LOSS_BROKER_OUTAGE, LOSS_DROPPED};
use crate::event::{EventFlags, MarketEvent, Payload, EVENT_SCHEMA_VERSION};
use crate::fsutil::atomic_write;
use crate::contract::Role;
use crate::ws::FrameWriter;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use super::{hub::*, commands::*, session::Session, startup::FILE_WRITE_FAILURES};

/// How often an open record's `recorded_until_ns` is renewed while its provider's connection is up: a restart's
/// outage starts at most this much before the earlier process actually stopped (never later).
const RECORDING_STAMP: Duration = Duration::from_secs(30);
/// How often records changed by events are written. A record a command or a restart changed is written at once.
const FLUSH_EVERY: Duration = Duration::from_secs(1);

/// Write these records' files; one that fails is recorded and stays to be written again.
pub(crate) fn write_files(hub: &Hub, files: Vec<(PartitionId, File)>) -> bool {
    let Some(root) = hub.config.evidence_root.clone() else { return true };
    let mut ok = true;
    for (id, file) in files {
        let path = path_of(&root, &id);
        let written = serde_json::to_vec_pretty(&file).map_err(io::Error::other)
            .and_then(|bytes| path.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| atomic_write(&path, &bytes)));
        if let Err(e) = written {
            FILE_WRITE_FAILURES.record("session evidence", &path, &e);
            lock(&hub.core).evidence.redirty(id);
            ok = false;
        }
    }
    ok
}

/// Write the records changed in what completeness is judged from: before a provider's events are answered.
pub(crate) fn flush_urgent(hub: &Hub) -> bool {
    let files = lock(&hub.core).evidence.take_urgent();
    files.is_empty() || write_files(hub, files)
}

/// Write every record that changed, and the days closed through.
pub(crate) fn flush(hub: &Hub) -> bool {
    let files = lock(&hub.core).evidence.take_dirty(None);
    let written = write_files(hub, files);
    write_closed_through(hub) && written
}

/// Write the day each source + market + session is closed through, when it moved. It is written before any sealed
/// record is pruned (cmd_prune): once that record is gone, this file alone keeps its session closed.
pub(crate) fn write_closed_through(hub: &Hub) -> bool {
    let Some(file) = lock(&hub.core).evidence.take_closed_through() else { return true };
    let Some(root) = hub.config.evidence_root.clone() else { return true };
    let path = closed_through_path(&root);
    let written = serde_json::to_vec_pretty(&file).map_err(io::Error::other)
        .and_then(|bytes| std::fs::create_dir_all(&root).and_then(|_| atomic_write(&path, &bytes)));
    if let Err(e) = written {
        FILE_WRITE_FAILURES.record("the days closed through", &path, &e);
        lock(&hub.core).evidence.redirty_closed_through();
        return false;
    }
    true
}

pub(crate) fn evidence_loop(hub: Arc<Hub>) {
    let mut stamped = Instant::now();
    let mut half_days = hub.us_calendar.get().half_days().clone();
    while hub.lifecycle.running.load(Ordering::Acquire) {
        thread::sleep(FLUSH_EVERY);
        // The provider rewrites the US calendar once a New York day.
        let now_half_days = hub.us_calendar.get().half_days().clone();
        if now_half_days != half_days {
            crate::calendar::install_half_days(now_half_days.clone());
            half_days = now_half_days;
        }
        if stamped.elapsed() >= RECORDING_STAMP {
            stamped = Instant::now();
            let sources: Vec<String> = lock(&hub.evidence_connections).iter().filter(|(_, n)| **n > 0).map(|(s, _)| s.clone()).collect();
            let now = now_ns() as i64;
            let mut core = lock(&hub.core);
            for source in sources {
                core.evidence.stamp(&source, now);
            }
        }
        flush(&hub);
    }
    flush(&hub);
}

/// A provider's ingest connection ended: its process is known to have recorded its partitions until now.
pub(crate) fn connection_closed(hub: &Hub, source: &str) {
    {
        let mut connections = lock(&hub.evidence_connections);
        if let Some(n) = connections.get_mut(source) {
            *n = n.saturating_sub(1);
        }
    }
    lock(&hub.core).evidence.stamp(source, now_ns() as i64);
    flush(hub);
}

fn provider_source(session: &Session) -> Option<String> {
    match &session.role {
        Role::Provider(source) => Some(source.clone()),
        _ => None,
    }
}

fn partition_of(source: &str, p: &Value) -> Result<PartitionId, String> {
    let text = |field: &str| p.get(field).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{field} required"));
    let trading_date = text("trading_date")?.to_owned();
    if crate::event::parse_calendar_date(&trading_date).is_none() {
        return Err(format!("trading_date {trading_date:?} is no date"));
    }
    Ok(PartitionId { source: source.to_lowercase(), market: text("market")?.to_uppercase(), trading_date,
        session: text("session")?.to_uppercase() })
}

/// `ingest.hello {instance, fills_gaps}`: the provider process this connection's events come from. A new process is a
/// restart of every open partition of its source that another one recorded (evidence::Ledger::hello). A provider that
/// fills gaps from its broker's history (`fills_gaps`) is answered, for each restart during trading, where each code's
/// gap starts (`gaps`, Engine::gap_starts): it fetches only from there to its own subscription, and reports each code
/// with `ingest.backfill` (decisions.md 盤中重啟的缺口只補空檔時段).
pub(crate) fn cmd_hello(stream: &mut FrameWriter, hub: &Hub, session: &mut Session, p: &Value, request_id: Value) -> io::Result<()> {
    let Some(source) = provider_source(session) else { return invalid_payload(stream, "ingest.hello", &request_id, "a provider's command") };
    let Some(instance) = p.get("instance").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
        return invalid_payload(stream, "ingest.hello", &request_id, "instance required");
    };
    if session.ingest_source.is_none() {
        *lock(&hub.evidence_connections).entry(source.clone()).or_insert(0) += 1;
        session.ingest_source = Some(source.clone());
    }
    let fills_gaps = p.get("fills_gaps").and_then(Value::as_bool).unwrap_or(false);
    // The background list's codes, read before `core` (never both locks at once).
    let listed: Vec<(String, String)> = if fills_gaps {
        lock(&hub.demand).background().items.iter().filter(|i| i.source.eq_ignore_ascii_case(&source))
            .map(|i| (i.market.to_uppercase(), i.code.to_uppercase())).collect()
    } else {
        Vec::new()
    };
    let now = now_ns() as i64;
    let mut gaps = Vec::new();
    let restarted = {
        let mut core = lock(&hub.core);
        let restarted = core.evidence.hello(&source, instance, now);
        core.late_joins.set_fills_gaps(&source, fills_gaps);
        if fills_gaps {
            for id in &restarted {
                let Some(restart) = core.evidence.row(id).and_then(|row| row.restarts.last()).filter(|r| r.during_trading && r.to_ns == now).cloned()
                else { continue };
                let codes: Vec<String> = listed.iter().filter(|(market, _)| *market == id.market).map(|(_, code)| code.clone()).collect();
                let starts = core.engine.gap_starts(&id.source, &id.market, &id.trading_date, &id.session, &codes);
                core.evidence.backfill_requested(id, restart.to_ns, starts.iter().map(|s| s.code.clone()));
                gaps.extend(starts.into_iter().map(|s| {
                    let mut gap = json!(s);
                    gap["restart_from_ns"] = json!(restart.from_ns);
                    gap["restart_to_ns"] = json!(restart.to_ns);
                    gap
                }));
            }
        }
        restarted
    };
    if !restarted.is_empty() {
        eprintln!("[market_runtime] provider {source} is a new process ({instance}): a restart of {} open partition(s), {} code(s) to fill",
                  restarted.len(), gaps.len());
    }
    super::session::flush_view_history(hub, &source);
    let written = flush(hub);
    write_json(stream, &json!({"type": "ingest.hello.ack", "request_id": request_id, "payload": {
        "instance": instance, "restarted": restarted, "gaps": gaps, "written": written}}))
}

/// `ingest.backfill {reports: [...]}`: what the provider stored of each code's gap after a restart (FillReport),
/// recorded on that restart (evidence::Ledger::backfill_reported); answered once the files are written. `known`: per
/// report, whether an open record asked for that code.
pub(crate) fn cmd_backfill(stream: &mut FrameWriter, hub: &Hub, session: &Session, p: &Value, request_id: Value) -> io::Result<()> {
    let Some(source) = provider_source(session) else { return invalid_payload(stream, "ingest.backfill", &request_id, "a provider's command") };
    let reports: Vec<FillReport> = match batch_field(p, "reports").and_then(|list| list.iter()
        .map(|v| serde_json::from_value::<FillReport>(v.clone()).map_err(|e| e.to_string())).collect::<Result<Vec<_>, _>>()) {
        Ok(reports) => reports,
        Err(e) => return invalid_payload(stream, "ingest.backfill", &request_id, &e),
    };
    let known: Vec<bool> = {
        let mut core = lock(&hub.core);
        reports.iter().map(|r| core.evidence.backfill_reported(&source, r)).collect()
    };
    for (report, known) in reports.iter().zip(&known) {
        if !known {
            // not an error: the partition was sealed (or its record pruned) before the fill was reported; counted in the reply
            eprintln!("[market_runtime] backfill report for {source}:{}:{} {} {} names no open restart", report.market, report.code,
                      report.trading_date, report.session);
        }
    }
    let written = flush(hub);
    write_json(stream, &json!({"type": "ingest.backfill.ack", "request_id": request_id, "payload": {"known": known, "written": written}}))
}

/// `ingest.loss {reports: [...]}`: events the provider lost before they reached Market Runtime. Each report becomes
/// the SOURCE_GAP records of the partitions it touches (evidence::Ledger::loss_records), stored like any event: the
/// reply names the last durable sequence, and the provider holds the report until the WAL watermark passes it.
pub(crate) fn cmd_loss(stream: &mut FrameWriter, hub: &Hub, session: &Session, p: &Value, request_id: Value) -> io::Result<()> {
    let Some(source) = provider_source(session) else { return invalid_payload(stream, "ingest.loss", &request_id, "a provider's command") };
    let reports: Vec<LossReport> = match batch_field(p, "reports").and_then(|list| list.iter()
        .map(|v| serde_json::from_value::<LossReport>(v.clone()).map_err(|e| e.to_string())).collect::<Result<Vec<_>, _>>()) {
        Ok(reports) => reports,
        Err(e) => return invalid_payload(stream, "ingest.loss", &request_id, &e),
    };
    if let Some(bad) = reports.iter().find(|r| (r.reason != LOSS_DROPPED && r.reason != LOSS_BROKER_OUTAGE) || r.from_ns <= 0 || r.to_ns <= 0) {
        return invalid_payload(stream, "ingest.loss", &request_id, &format!("{} {}: reason must be dropped or broker_outage with \
            exchange times", bad.market, bad.code));
    }
    let now = now_ns();
    let template = MarketEvent { schema_version: EVENT_SCHEMA_VERSION, event_id: String::new(), durable_sequence: 0, symbol: String::new(),
        provider: source.clone(), market: String::new(), code: String::new(), session: String::new(), trading_date: String::new(),
        generation: 0, sequence: 0, exchange_ts_ns: 0, arrival_ns: now, a_received_ns: now, runtime_epoch: hub.runtime_epoch,
        time_quality: String::new(), trace_id: String::new(), flags: EventFlags::default(), versions: BTreeMap::new(),
        payload: Payload::SourceStatus { state: String::new(), detail: String::new() } };
    let mut results = Vec::with_capacity(reports.len());
    for report in &reports {
        let mut next = lock(&hub.lane.sequencer);
        let mut core = lock(&hub.core);
        let calendar = hub.calendar();
        let records = core.evidence.loss_records(&source, report, &|date: &str| calendar.is_trading_day(date), &template);
        drop(calendar);
        let written: Vec<PartitionId> = records.iter().map(|r| PartitionId { source: r.provider.clone(), market: r.market.clone(),
            trading_date: r.trading_date.clone(), session: r.session.clone() }).collect();
        let wal = hub.wal();
        let mut last = None;
        for mut record in records {
            if !wal.reserve() {
                let reason = wal.failed().map_or_else(|| "WAL_QUEUE_FULL: retry".to_owned(), |why| format!("WAL_FAILED: {why}"));
                drop(core);
                drop(next);
                results.push(json!({"accepted": false, "reason": reason, "durable_sequence": last}));
                return write_json(stream, &json!({"type": "ingest.loss.ack", "request_id": request_id, "payload": {"results": results,
                    "instance_id": hub.instance_id}}));
            }
            record.durable_sequence = *next;
            *next += 1;
            last = Some(record.durable_sequence);
            core.evidence.fold(&record, true);
            hub.counters.loss_records.fetch_add(1, Ordering::Relaxed);
            wal.submit(record);
        }
        if report.reason == LOSS_BROKER_OUTAGE {
            // Kept in the partitions it touched: each code's gap there is filled from the start taken when the
            // connection went down (outage_gap.rs).
            let Core { outage_gaps, evidence, .. } = &mut *core;
            outage_gaps.ended(&source, report, &written, evidence);
        }
        drop(core);
        drop(next);
        flush_urgent(hub);
        // A broker outage outside trading loses nothing: nothing is written, and it is said so.
        results.push(json!({"accepted": true, "durable_sequence": last, "written": last.is_some()}));
    }
    let gaps = answered_gaps(hub, &source);
    write_json(stream, &json!({"type": "ingest.loss.ack", "request_id": request_id, "payload": {"results": results,
        "instance_id": hub.instance_id, "gaps": gaps}}))
}

/// The gaps judged since `source`'s provider was last answered: late joins' (late_join.rs) and broker outages' whose
/// end is known (outage_gap.rs; one waiting for a print its partition's close has passed ends at that close).
pub(crate) fn answered_gaps(hub: &Hub, source: &str) -> Vec<Value> {
    let mut core = lock(&hub.core);
    let mut gaps = core.late_joins.take(source);
    let Core { outage_gaps, evidence, .. } = &mut *core;
    outage_gaps.due(evidence, now_ns() as i64);
    gaps.extend(outage_gaps.take(source));
    gaps
}

/// `ingest.outage {connection, from_ns, instruments: [{market, code}]}`: a broker connection of the provider stopped
/// delivering at `from_ns` (its clock) while the process kept running; `instruments` are what its streams carried. For a
/// provider that fills gaps from its broker's history, each stored instrument's gap start is taken now
/// (Engine::gap_starts in the partition `from_ns` falls in; a listed code with nothing stored yet starts at its open):
/// nothing newer of it can arrive until the connection is back. Whether the gap is filled is the outage's report's
/// (`ingest.loss`) to decide. Answered at once.
pub(crate) fn cmd_outage(stream: &mut FrameWriter, hub: &Hub, session: &Session, p: &Value, request_id: Value) -> io::Result<()> {
    let Some(source) = provider_source(session) else { return invalid_payload(stream, "ingest.outage", &request_id, "a provider's command") };
    let connection = p.get("connection").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    let from_ns = p.get("from_ns").and_then(Value::as_i64).filter(|ns| *ns > 0);
    let instruments: Option<Vec<(String, String)>> = p.get("instruments").and_then(Value::as_array).map(|list| list.iter().filter_map(|i| {
        let text = |field: &str| i.get(field).and_then(Value::as_str).map(|s| s.trim().to_uppercase()).filter(|s| !s.is_empty());
        Some((text("market")?, text("code")?))
    }).collect());
    let (Some(connection), Some(from_ns), Some(instruments)) = (connection, from_ns, instruments) else {
        return invalid_payload(stream, "ingest.outage", &request_id, "connection, from_ns and instruments required");
    };
    // The background list's codes, read before `core` (never both locks at once).
    let listed: Vec<(String, String)> = lock(&hub.demand).background().items.iter().filter(|i| i.source.eq_ignore_ascii_case(&source))
        .map(|i| (i.market.to_uppercase(), i.code.to_uppercase())).collect();
    let mut core = lock(&hub.core);
    let mut watched = 0;
    if core.late_joins.fills_gaps(&source) {
        let mut by_partition: BTreeMap<(String, String, &'static str), Vec<String>> = BTreeMap::new();
        for (market, code) in &instruments {
            if let Some((trading_date, session, _)) = crate::event::wal_partition(&source, market, from_ns) {
                by_partition.entry((market.clone(), trading_date, session)).or_default().push(code.clone());
            }
        }
        let mut starts = Vec::new();
        for ((market, trading_date, session), codes) in by_partition {
            let unstored: Vec<String> = codes.iter().filter(|c| listed.contains(&(market.clone(), (*c).clone()))).cloned().collect();
            starts.extend(core.engine.gap_starts(&source, &market, &trading_date, session, &unstored).into_iter()
                .filter(|s| codes.contains(&s.code)));
        }
        watched = starts.len();
        core.outage_gaps.began(&source, &connection, from_ns, starts);
    }
    drop(core);
    if watched > 0 {
        eprintln!("[market_runtime] provider {source} {connection} went down at {from_ns}: {watched} code(s) watched for an outage gap");
    }
    write_json(stream, &json!({"type": "ingest.outage.ack", "request_id": request_id, "payload": {"watched": watched}}))
}

/// `evidence.seal` / `evidence.quarantine` / `evidence.mark_repaired {market, trading_date, session, ...}`: the
/// owner's decision on one partition of its own source, answered once the file is written (`ok`: there is a record).
pub(crate) fn cmd_decide(stream: &mut FrameWriter, hub: &Hub, session: &Session, kind: &str, p: &Value, request_id: Value) -> io::Result<()> {
    let Some(source) = provider_source(session) else { return invalid_payload(stream, kind, &request_id, "a provider's command") };
    let id = match partition_of(&source, p) {
        Ok(id) => id,
        Err(e) => return invalid_payload(stream, kind, &request_id, &e),
    };
    let note = p.get("reason").or_else(|| p.get("note")).and_then(Value::as_str).unwrap_or_default().to_owned();
    if kind != "evidence.seal" && note.trim().is_empty() {
        return invalid_payload(stream, kind, &request_id, "a reason (quarantine) or note (mark_repaired) is required");
    }
    let now = now_ns() as i64;
    let (ok, files) = {
        let mut core = lock(&hub.core);
        let ok = match kind {
            "evidence.seal" => core.evidence.seal(&id),
            "evidence.quarantine" => core.evidence.quarantine(&id, &note, now),
            _ => core.evidence.mark_repaired(&id, &note, now),
        };
        (ok, core.evidence.take_dirty(Some(&id)))
    };
    let written = write_files(hub, files) && write_closed_through(hub);
    if kind == "evidence.quarantine" && ok {
        eprintln!("[market_runtime] session evidence {}|{}|{}|{} quarantined: {note}", id.source, id.market, id.trading_date, id.session);
    }
    write_json(stream, &json!({"type": format!("{kind}.ack"), "request_id": request_id, "payload": {"ok": ok, "written": written,
        "partition": id}}))
}

/// `evidence.prune {sessions: [{market, trading_date, session}]}`: delete the files of these finished partitions of
/// the provider's source that are closed (sealed or quarantined) -- a record of an earlier format by its own
/// `sealed` / `quarantined` fields -- and answer which went.
pub(crate) fn cmd_prune(stream: &mut FrameWriter, hub: &Hub, session: &Session, p: &Value, request_id: Value) -> io::Result<()> {
    let Some(source) = provider_source(session) else { return invalid_payload(stream, "evidence.prune", &request_id, "a provider's command") };
    let ids: Vec<PartitionId> = match batch_field(p, "sessions").and_then(|list| list.iter().map(|v| partition_of(&source, v)).collect()) {
        Ok(ids) => ids,
        Err(e) => return invalid_payload(stream, "evidence.prune", &request_id, &e),
    };
    // Nothing goes while the days closed through are not on disk: a pruned record's session would open again.
    if !write_closed_through(hub) {
        return write_json(stream, &json!({"type": "evidence.prune.ack", "request_id": request_id, "payload": {"removed": []}}));
    }
    let Some(root) = hub.config.evidence_root.clone() else {
        let (closed, _) = lock(&hub.core).evidence.take_closed(&ids);
        return write_json(stream, &json!({"type": "evidence.prune.ack", "request_id": request_id, "payload": {"removed": closed}}));
    };
    let (closed, unknown) = lock(&hub.core).evidence.take_closed(&ids);
    let mut removed = Vec::new();
    for id in closed.into_iter().chain(unknown.into_iter().filter(|id| is_closed_on_disk(&path_of(&root, id)) == Some(true))) {
        let path = path_of(&root, &id);
        match std::fs::remove_file(&path) {
            Ok(()) => removed.push(id),
            Err(e) if e.kind() == io::ErrorKind::NotFound => removed.push(id),
            Err(e) => { FILE_WRITE_FAILURES.record("deleting a pruned session evidence file", &path, &e); }
        }
    }
    write_json(stream, &json!({"type": "evidence.prune.ack", "request_id": request_id, "payload": {"removed": removed}}))
}
