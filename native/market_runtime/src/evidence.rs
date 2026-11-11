//! Session evidence: every WAL partition's completeness record, kept by Market Runtime alone (docs/decisions.md
//! 分區身分與分區完整性紀錄的擁有者; docs/system-architecture/01_rust_a.md section 9).
//!
//! A partition is `source + market + trading_date + session`, the identity Market Runtime names for every event it
//! stores (event::wal_partition). Its record says what reached the WAL and what did not:
//!
//! - written as the WAL is: `accepted` (events stored), the first and last exchange time stored, `dropped` (events
//!   the provider dropped before they reached Market Runtime, from its `ingest.loss` reports) and `outages` (a broker
//!   connection that delivered nothing for a span of trading, with the codes it carried). Each of these is folded
//!   from the stored event itself ([`Ledger::fold`]), live and when the WAL is replayed, so the checkpoint keeps them
//!   ([`Ledger::image`]) and a restart rebuilds them exactly.
//! - decided by Market Runtime outside the WAL, written to the partition's file at once: `rejected` (by reason),
//!   `duplicates`, `restarts` (a provider process that ended while the partition was open: the new one says who it
//!   is in `ingest.hello`), and the owner's `sealed`, `quarantined` and `repaired` (evidence.* commands).
//!
//! The file `<root>/<source>/<market>/<date>_<session>.json` is the record readers read -- the session owners after
//! their commands, the 收盤進度 and the WAL retention, in processes that also run while Market Runtime is stopped.
//! Market Runtime is its only writer. A sealed or quarantined partition is frozen: nothing changes it any more. A
//! sealed day also closes every partition of that source + market + session up to it, past its record's prune
//! (`<root>/closed_through.json`, [`Ledger::is_closed`]): an event of a closed partition is refused, never stored.
//!
//! Completeness, written with the record: `complete` when nothing was dropped, rejected or interrupted during trading;
//! `repaired` only when the owner marked a verified recovery; else `gap_detected`. A broker outage leaves a hole in
//! its codes only (`gap_codes`), not in the partition's other codes.

use crate::calendar::{CalKey, Calendar};
use crate::event::{
    days_from_civil, is_session_partitioned, market_offset_seconds, parse_calendar_date, wal_partition, ClockScope, EventFlags,
    MarketEvent, Payload, COVERAGE_CONTROL, EVENT_SCHEMA_VERSION, LOSS_CONTROL, SOURCE_GAP,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub const EVIDENCE_SCHEMA: &str = "market-runtime-session-evidence-v1";
/// A partition: source, market, trading date and session (the scope a market clock applies to is the same identity).
pub type PartitionId = ClockScope;

/// Why a provider lost events before they reached Market Runtime (`ingest.loss`).
pub const LOSS_DROPPED: &str = "dropped";
pub const LOSS_BROKER_OUTAGE: &str = "broker_outage";

/// What a checkpoint keeps of the evidence: each open partition's stored-event fields (a list: JSON keys are text).
pub type Image = Vec<(PartitionId, Stored)>;

/// The fields folded from stored events: what the checkpoint keeps and a replay rebuilds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Stored {
    pub accepted: u64,
    pub first_ts_ns: i64,
    pub last_ts_ns: i64,
    pub dropped: u64,
    pub outages: Vec<Outage>,
}

/// A broker connection that delivered nothing from `from_ns` to `to_ns` during trading, for these codes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Outage {
    pub connection: String,
    pub from_ns: i64,
    pub to_ns: i64,
    pub codes: Vec<String>,
}

/// A provider process that ended while the partition was open: from the last moment it is known to have been
/// recording the partition to the moment its successor said who it is. One during trading is filled afterwards from
/// the broker's history, each code from its own last stored print (`backfill`, decisions.md 盤中重啟的缺口).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Restart {
    pub from_ns: i64,
    pub to_ns: i64,
    pub during_trading: bool,
    /// Per code asked to be filled: what its provider reported. Empty: none was asked (outside trading, or nothing
    /// stored to fill from).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub backfill: BTreeMap<String, Fill>,
}

/// One code's fill of a restart's gap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Fill {
    /// `requested` (asked at the successor's hello), `filled` (stored, and its cumulative volume meets the first live
    /// print after it), `unverified` (stored, but the volumes do not meet: prints are still missing), `after_close`
    /// (the broker's history does not hold the gap yet: the fill after the session's materialization takes it) or
    /// `failed`.
    pub state: String,
    #[serde(default)]
    pub prints: u64,
    #[serde(default)]
    pub volume: f64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

pub const FILL_REQUESTED: &str = "requested";
pub const FILL_FILLED: &str = "filled";
pub const FILL_UNVERIFIED: &str = "unverified";
pub const FILL_FAILED: &str = "failed";
pub const FILL_AFTER_CLOSE: &str = "after_close";

impl Restart {
    /// Every code asked was filled, and verified: what the restart missed is stored.
    pub fn filled(&self) -> bool {
        !self.backfill.is_empty() && self.backfill.values().all(|f| f.state == FILL_FILLED)
    }
}

/// A code whose print stream its provider subscribed once the partition was trading (a late join, decisions.md
/// 盤中才訂閱的商品補當天資料): from the open to its first print it holds nothing, and that window is filled from the
/// broker's history like a restart's gap. `since_ns`: when the provider subscribed it (its clock); `first_ns`: the
/// exchange time of its first print. Not a loss of the partition: the code was not asked for before.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LateJoin {
    pub since_ns: i64,
    pub first_ns: i64,
    pub fill: Fill,
}

/// The fill of one broker-connection outage of the partition (decisions.md 券商連線自己重連的空檔): the codes it was
/// asked for when its end touched trading (outage_gap.rs), each with what its provider reported. Named like its
/// [`Outage`]: the connection and the outage's end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutageFill {
    pub connection: String,
    pub to_ns: i64,
    pub backfill: BTreeMap<String, Fill>,
}

/// What a fill report answers: a restart's gap (`restart_to_ns` names the restart), a late join's, or a
/// broker-connection outage's (`connection` and `outage_to_ns` name the outage).
pub const CAUSE_RESTART: &str = "restart";
pub const CAUSE_LATE_JOIN: &str = "late_join";
pub const CAUSE_OUTAGE: &str = "outage";

fn cause_restart() -> String {
    CAUSE_RESTART.into()
}

/// Why a stored fill stays unverified: the volumes that did not meet, or the one nobody stated (a futures session's
/// total at its open is not known), and how far the broker's history reached.
fn unverified_reason(report: &FillReport) -> String {
    let stated = |volume: Option<f64>| volume.map_or_else(|| "unstated".to_owned(), |v| v.to_string());
    let held = report.history_last_ns.map_or_else(String::new, |ns| format!("; the broker's history answered up to {ns}"));
    format!("{} + {} stored != {} before the first live print{held}", stated(report.total_before), report.volume, stated(report.next_total_before))
}

/// What a provider reports of one code's fill (`ingest.backfill`). `total_before`: the cumulative volume the gap
/// started from (A's, as asked); `next_total_before`: the first live print after the gap, its cumulative volume less
/// its own (None when none came yet, or the stream states no cumulative volume).
#[derive(Debug, Clone, Deserialize)]
pub struct FillReport {
    pub market: String,
    pub code: String,
    pub trading_date: String,
    pub session: String,
    #[serde(default = "cause_restart")]
    pub cause: String,
    /// The restart the gap belongs to (a late join's report names none).
    #[serde(default)]
    pub restart_to_ns: i64,
    /// The outage the gap belongs to (an outage's report only): its connection and end.
    #[serde(default)]
    pub connection: String,
    #[serde(default)]
    pub outage_to_ns: i64,
    pub outcome: String,
    /// `first_live_print` (the gap ended where the live stream took over) or `session_close`.
    #[serde(default)]
    pub end: String,
    #[serde(default)]
    pub prints: u64,
    #[serde(default)]
    pub volume: f64,
    #[serde(default)]
    pub total_before: Option<f64>,
    #[serde(default)]
    pub next_total_before: Option<f64>,
    /// The newest print the broker's history answered with (exchange ns), kept or not: a shortfall with this before
    /// the gap's end is a history that had not caught up with the live stream when it was asked.
    #[serde(default)]
    pub history_last_ns: Option<i64>,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quarantine {
    pub reason: String,
    pub at_ns: i64,
    pub accepted: u64,
    pub sealed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Repaired {
    pub note: String,
    pub at_ns: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Row {
    #[serde(flatten)]
    pub stored: Stored,
    #[serde(default)]
    pub rejected: BTreeMap<String, u64>,
    #[serde(default)]
    pub duplicates: u64,
    #[serde(default)]
    pub restarts: Vec<Restart>,
    /// The codes that joined once the partition was trading, by code.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub late_joins: BTreeMap<String, LateJoin>,
    /// The broker-connection outages during trading whose gaps were asked to be filled.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outage_fills: Vec<OutageFill>,
    /// The provider process recording the partition (its `ingest.hello`), and until when it is known to have been.
    #[serde(default)]
    pub instance: String,
    #[serde(default)]
    pub recorded_until_ns: i64,
    #[serde(default)]
    pub sealed: bool,
    #[serde(default)]
    pub quarantined: Option<Quarantine>,
    #[serde(default)]
    pub repaired: Option<Repaired>,
}

impl Row {
    pub fn open(&self) -> bool {
        !self.sealed && self.quarantined.is_none()
    }
    /// Restarts during trading whose gap is not (yet) filled and verified.
    pub fn interruptions(&self) -> u64 {
        self.restarts.iter().filter(|r| r.during_trading && !r.filled()).count() as u64
    }
    /// Restarts during trading whose gap was filled from the broker's history and verified.
    pub fn filled_restarts(&self) -> u64 {
        self.restarts.iter().filter(|r| r.during_trading && r.filled()).count() as u64
    }
    pub fn loss(&self) -> u64 {
        self.stored.dropped + self.rejected.values().sum::<u64>() + self.interruptions()
    }
    pub fn completeness(&self) -> &'static str {
        match (self.loss(), &self.repaired) {
            (0, _) if self.filled_restarts() > 0 => "repaired",
            (0, _) => "complete",
            (_, Some(_)) => "repaired",
            _ => "gap_detected",
        }
    }
    /// Whether `code`'s gap in `outage` was filled from the broker's history and verified.
    fn outage_filled(&self, outage: &Outage, code: &str) -> bool {
        self.outage_fills.iter().find(|f| f.connection == outage.connection && f.to_ns == outage.to_ns)
            .and_then(|f| f.backfill.get(code)).is_some_and(|fill| fill.state == FILL_FILLED)
    }
    /// The codes a broker outage during trading left a hole in: one not filled and verified.
    pub fn gap_codes(&self) -> Vec<String> {
        self.stored.outages.iter().flat_map(|o| o.codes.iter().filter(|code| !self.outage_filled(o, code)).cloned())
            .collect::<BTreeSet<_>>().into_iter().collect()
    }
    /// The codes whose every broker-outage hole was filled and verified: their prints are whole again, the book of
    /// those spans is gone for good (decisions.md 盤中重啟的缺口只補空檔時段: 補過的是 `repaired`).
    pub fn repaired_codes(&self) -> Vec<String> {
        let gaps: BTreeSet<String> = self.gap_codes().into_iter().collect();
        self.stored.outages.iter().flat_map(|o| o.codes.iter().cloned()).filter(|code| !gaps.contains(code))
            .collect::<BTreeSet<_>>().into_iter().collect()
    }
}

/// The file of one partition: its identity, its record and the completeness judged from it (readers never judge it
/// again).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct File {
    pub schema: String,
    pub source: String,
    pub market: String,
    pub trading_date: String,
    pub session: String,
    #[serde(flatten)]
    pub row: Row,
    pub completeness: String,
    pub gap_codes: Vec<String>,
    #[serde(default)]
    pub repaired_codes: Vec<String>,
    pub interruptions: u64,
}

impl File {
    pub fn of(id: &PartitionId, row: &Row) -> Self {
        Self { schema: EVIDENCE_SCHEMA.into(), source: id.source.clone(), market: id.market.clone(), trading_date: id.trading_date.clone(),
            session: id.session.clone(), row: row.clone(), completeness: row.completeness().into(), gap_codes: row.gap_codes(),
            repaired_codes: row.repaired_codes(), interruptions: row.interruptions() }
    }
}

pub fn path_of(root: &Path, id: &PartitionId) -> PathBuf {
    root.join(&id.source).join(&id.market).join(format!("{}_{}.json", id.trading_date, id.session))
}

pub const CLOSED_THROUGH_SCHEMA: &str = "market-runtime-closed-through-v1";

/// Where the day each source + market + session is closed through is kept: beside the partition files, not among them
/// (readers list `<source>/<market>/*.json`), and never pruned with them.
pub fn closed_through_path(root: &Path) -> PathBuf {
    root.join("closed_through.json")
}

/// The newest trading date an owner sealed, per source + market + session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClosedFamily {
    pub source: String,
    pub market: String,
    pub session: String,
    pub trading_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClosedThroughFile {
    pub schema: String,
    pub families: Vec<ClosedFamily>,
}

type Family = (String, String, String);

fn family_of(id: &PartitionId) -> Family {
    (id.source.clone(), id.market.clone(), id.session.clone())
}

/// One `ingest.loss` report: a provider lost `count` events of `code` with exchange times from `from_ns` to `to_ns`.
#[derive(Debug, Clone, Deserialize)]
pub struct LossReport {
    pub market: String,
    pub code: String,
    pub from_ns: i64,
    pub to_ns: i64,
    #[serde(default)]
    pub count: u64,
    pub reason: String,
    #[serde(default)]
    pub connection: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LossDetail {
    reason: String,
    to_ns: i64,
    #[serde(default)]
    connection: String,
}

/// Whether the exchange-time span [from_ns, to_ns] touches a trading minute or a print instant of a partition
/// (config/trading_sessions.json; minutes past 1440 are the next calendar day's, a FUT NIGHT after midnight).
pub fn covers_trading(calendar: &Calendar, id: &PartitionId, from_ns: i64, to_ns: i64) -> bool {
    let Some((y, m, d)) = parse_calendar_date(&id.trading_date) else { return false };
    let day_start_ns = days_from_civil(y, m, d) as i128 * 86_400 * 1_000_000_000;
    // Exchange-local nanoseconds since the partition date's midnight.
    let local = |ts: i64| -> i128 {
        let secs = ts.div_euclid(1_000_000_000);
        ts as i128 + market_offset_seconds(&id.market, secs) as i128 * 1_000_000_000 - day_start_ns
    };
    let (start, end) = (local(from_ns), local(to_ns));
    let minute = |m: i32| m as i128 * 60_000_000_000;
    let key = CalKey { source: &id.source, market: &id.market,
        session: is_session_partitioned(&id.source, &id.market).then_some(id.session.as_str()), date: Some(&id.trading_date) };
    calendar.segments(key).iter().any(|segment| {
        segment.intervals.iter().any(|(open, close)| start < minute(*close + 1) && end >= minute(*open))
            || segment.print_instants.iter().any(|instant| start <= minute(*instant) && minute(*instant) <= end)
    })
}

/// Whether `id` can be a session at all: a Shioaji partition other than a NIGHT (dated by the day it opened) exists
/// only on a trading day.
pub type TradingDay<'a> = &'a dyn Fn(&str) -> bool;

/// The partition records Market Runtime keeps (in `Core`, folded under the lock events are sequenced under).
#[derive(Debug, Default)]
pub struct Ledger {
    root: Option<PathBuf>,
    rows: BTreeMap<PartitionId, Row>,
    /// Changed since last written.
    dirty: BTreeSet<PartitionId>,
    /// Changed in what completeness is judged from (a new record, a loss, a refusal, a restart): written before the
    /// provider is answered, so an owner reading the file after its events are confirmed reads them.
    urgent: BTreeSet<PartitionId>,
    /// The provider process each source's ingest now comes from (`ingest.hello`).
    instances: BTreeMap<String, String>,
    calendar: Calendar,
    /// Whether a replay may create a record: only when the checkpoint held the records (see `restore`).
    pub replay_creates: bool,
    /// The newest sealed trading date of each source + market + session. A session is closed once its owner sealed
    /// it, and stays closed after its record is pruned: a partition of that day or before with no open record takes
    /// nothing any more (a broker re-sending its last print on a new subscription made the pruned session look new).
    closed_through: BTreeMap<Family, String>,
    /// `closed_through` changed since last written.
    closed_through_dirty: bool,
    /// The closed partitions an event was refused for in this process (each is logged once).
    refused: BTreeSet<PartitionId>,
}

impl Ledger {
    /// The records of `root` (each partition's file of this format; a file of another one is left alone: only
    /// `prune` reads it, for whether it was closed). None: kept in memory only (tests, a replay).
    pub fn load(root: Option<PathBuf>) -> (Self, Vec<String>) {
        let mut ledger = Ledger { root: root.clone(), ..Ledger::default() };
        let mut problems = Vec::new();
        let Some(root) = root else { return (ledger, problems) };
        for source in read_dirs(&root) {
            for market in read_dirs(&source) {
                let Ok(entries) = std::fs::read_dir(&market) else { continue };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue;
                    }
                    match std::fs::read(&path).map_err(|e| e.to_string())
                        .and_then(|bytes| serde_json::from_slice::<File>(&bytes).map_err(|e| e.to_string())) {
                        Ok(file) if file.schema == EVIDENCE_SCHEMA => {
                            let id = PartitionId { source: file.source, market: file.market, trading_date: file.trading_date, session: file.session };
                            ledger.rows.insert(id, file.row);
                        }
                        // not an error: a record of the earlier provider-written format; only prune reads it
                        Ok(_) | Err(_) if is_closed_on_disk(&path).is_some() => {}
                        Ok(file) => problems.push(format!("{}: schema {:?}", path.display(), file.schema)),
                        Err(why) => problems.push(format!("{}: {why}", path.display())),
                    }
                }
            }
        }
        let path = closed_through_path(&root);
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<ClosedThroughFile>(&bytes) {
                Ok(file) if file.schema == CLOSED_THROUGH_SCHEMA => {
                    for family in file.families {
                        ledger.closed_through.insert((family.source, family.market, family.session), family.trading_date);
                    }
                }
                Ok(file) => problems.push(format!("{}: schema {:?}", path.display(), file.schema)),
                Err(why) => problems.push(format!("{}: {why}", path.display())),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // not an error: nothing was sealed yet
            Err(e) => problems.push(format!("{}: {e}", path.display())),
        }
        // A sealed record still on disk closes its day whatever the file says (sealed before it could be written).
        let sealed: Vec<PartitionId> = ledger.rows.iter().filter(|(_, row)| row.sealed).map(|(id, _)| id.clone()).collect();
        for id in sealed {
            ledger.close_through(&id);
        }
        (ledger, problems)
    }

    /// Whether the partition takes nothing any more: its record is sealed or quarantined, or it has none and its day is
    /// at or before the newest one sealed in its source + market + session.
    pub fn is_closed(&self, id: &PartitionId) -> bool {
        match self.rows.get(id) {
            Some(row) => !row.open(),
            None => self.closed_through.get(&family_of(id)).is_some_and(|through| id.trading_date <= *through),
        }
    }

    fn close_through(&mut self, id: &PartitionId) {
        let family = family_of(id);
        if self.closed_through.get(&family).is_none_or(|through| *through < id.trading_date) {
            self.closed_through.insert(family, id.trading_date.clone());
            self.closed_through_dirty = true;
        }
    }

    /// The days closed through, as their file, when they changed since last written; `redirty_closed_through` takes
    /// it back when writing failed.
    pub fn take_closed_through(&mut self) -> Option<ClosedThroughFile> {
        if !std::mem::take(&mut self.closed_through_dirty) {
            return None;
        }
        Some(ClosedThroughFile { schema: CLOSED_THROUGH_SCHEMA.into(), families: self.closed_through.iter()
            .map(|((source, market, session), trading_date)| ClosedFamily { source: source.clone(), market: market.clone(),
                session: session.clone(), trading_date: trading_date.clone() }).collect() })
    }

    pub fn redirty_closed_through(&mut self) {
        self.closed_through_dirty = true;
    }

    /// An event of a closed partition was refused: true the first time for that partition in this process.
    pub fn note_refused(&mut self, id: PartitionId) -> bool {
        self.refused.insert(id)
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    pub fn row(&self, id: &PartitionId) -> Option<&Row> {
        self.rows.get(id)
    }

    pub fn rows(&self) -> impl Iterator<Item = (&PartitionId, &Row)> {
        self.rows.iter()
    }

    /// What the checkpoint keeps: the stored-event fields of every open record.
    pub fn image(&self) -> Image {
        self.rows.iter().filter(|(_, row)| row.open()).map(|(id, row)| (id.clone(), row.stored.clone())).collect()
    }

    /// Start from a checkpoint: each open record's stored-event fields are the image's as of its WAL position (zero
    /// for one the image does not hold: made after it), and the replay that follows folds the rest. Without an image
    /// (no checkpoint of this format) the whole WAL is replayed into the open records from zero and creates none: a
    /// partition only in the WAL is one an earlier format kept. A record only in the image was pruned since.
    pub fn restore(&mut self, image: Option<&Image>) {
        let held: Option<BTreeMap<&PartitionId, &Stored>> = image.map(|image| image.iter().map(|(id, stored)| (id, stored)).collect());
        for (id, row) in self.rows.iter_mut().filter(|(_, row)| row.open()) {
            row.stored = held.as_ref().and_then(|held| held.get(id)).map(|stored| (*stored).clone()).unwrap_or_default();
        }
        self.replay_creates = image.is_some();
    }

    /// Fold one event that was written to the WAL (live as it is sequenced, or replayed). A market event counts as
    /// accepted (its exchange time moves the record's span); a loss record adds what it states. Clocks and coverage
    /// are Market Runtime's own facts, no provider's input. Returns true when it made a new record.
    pub fn fold(&mut self, event: &MarketEvent, create: bool) -> bool {
        if matches!(event.payload, Payload::Clock { .. }) || event.time_quality == COVERAGE_CONTROL {
            return false;
        }
        let id = PartitionId { source: event.provider.clone(), market: event.market.clone(), trading_date: event.trading_date.clone(),
            session: event.session.clone() };
        let created = !self.rows.contains_key(&id);
        if (created && !create) || self.is_closed(&id) {
            return false;
        }
        let instance = self.instances.get(&id.source).cloned().unwrap_or_default();
        let row = self.rows.entry(id.clone()).or_insert_with(|| Row { instance, ..Row::default() });
        if !row.open() {
            return false;
        }
        let stored = &mut row.stored;
        if event.time_quality == LOSS_CONTROL {
            match loss_detail(event) {
                Some(detail) if detail.reason == LOSS_BROKER_OUTAGE => {
                    match stored.outages.iter_mut().find(|o| o.connection == detail.connection && o.from_ns == event.exchange_ts_ns.min(detail.to_ns)
                        && o.to_ns == detail.to_ns.max(event.exchange_ts_ns)) {
                        Some(outage) => {
                            if !outage.codes.contains(&event.code) {
                                outage.codes.push(event.code.clone());
                                outage.codes.sort();
                            }
                        }
                        None => stored.outages.push(Outage { connection: detail.connection, from_ns: event.exchange_ts_ns.min(detail.to_ns),
                            to_ns: detail.to_ns.max(event.exchange_ts_ns), codes: vec![event.code.clone()] }),
                    }
                }
                _ => stored.dropped += event.flags.gap_before,
            }
            self.urgent.insert(id.clone());
        } else {
            stored.accepted += 1;
            stored.dropped += event.flags.gap_before;
            if created || event.flags.gap_before > 0 {
                self.urgent.insert(id.clone());
            }
            if event.time_quality == "exchange" && event.exchange_ts_ns > 0 {
                stored.first_ts_ns = if stored.first_ts_ns > 0 { stored.first_ts_ns.min(event.exchange_ts_ns) } else { event.exchange_ts_ns };
                // A time label (Futu's minute bar is filed under the minute it ends) can lie ahead of the moment it
                // came: it says no more than that the event had arrived by then.
                let happened_ns = if event.flags.time_label { event.exchange_ts_ns.min(event.arrival_ns as i64) } else { event.exchange_ts_ns };
                stored.last_ts_ns = stored.last_ts_ns.max(happened_ns);
            }
        }
        self.dirty.insert(id);
        created
    }

    /// An event of this partition Market Runtime refused for good (`reason`), or a re-sent one it already held. A
    /// closed partition's record is frozen, and a pruned one is never made again.
    pub fn rejected(&mut self, id: &PartitionId, reason: &str) {
        if self.is_closed(id) {
            return;
        }
        let duplicate = reason == "RejectedSequence";
        let Some(row) = self.rows.get_mut(id).filter(|row| row.open()) else {
            if duplicate {
                return;
            }
            let instance = self.instances.get(&id.source).cloned().unwrap_or_default();
            self.rows.insert(id.clone(), Row { instance, rejected: BTreeMap::from([(reason.to_owned(), 1)]), ..Row::default() });
            self.dirty.insert(id.clone());
            self.urgent.insert(id.clone());
            return;
        };
        if duplicate {
            row.duplicates += 1;
        } else {
            *row.rejected.entry(reason.to_owned()).or_insert(0) += 1;
            self.urgent.insert(id.clone());
        }
        self.dirty.insert(id.clone());
    }

    /// A provider connection says which process it is. Every open record of its source with events that another
    /// process recorded gets a restart: from the last moment that process is known to have been recording it (its
    /// newest stored exchange time, or the last stamp of its connection, whichever is later) to now. The same process
    /// reconnecting (its ingest connection dropped, or Market Runtime restarted) restarts nothing: it kept what it
    /// could not send and reports what it dropped. Returns the records that got a restart.
    pub fn hello(&mut self, source: &str, instance: &str, now_ns: i64) -> Vec<PartitionId> {
        self.instances.insert(source.to_owned(), instance.to_owned());
        let mut restarted = Vec::new();
        for (id, row) in self.rows.iter_mut().filter(|(id, row)| id.source == source && row.open()) {
            if row.instance != instance && !row.instance.is_empty() && row.stored.accepted > 0 {
                // Exchange times and this machine's clock are two clocks: the start is never past the end.
                let from_ns = row.stored.last_ts_ns.max(row.recorded_until_ns).min(now_ns);
                let during_trading = covers_trading(&self.calendar, id, from_ns, now_ns);
                row.restarts.push(Restart { from_ns, to_ns: now_ns, during_trading, backfill: BTreeMap::new() });
                restarted.push(id.clone());
            }
            row.instance = instance.to_owned();
            row.recorded_until_ns = now_ns;
            self.dirty.insert(id.clone());
        }
        restarted
    }

    /// The codes the successor was asked to fill a restart of the partition for (at its hello).
    pub fn backfill_requested(&mut self, id: &PartitionId, to_ns: i64, codes: impl IntoIterator<Item = String>) {
        let Some(row) = self.rows.get_mut(id).filter(|row| row.open()) else { return };
        let Some(restart) = row.restarts.iter_mut().find(|r| r.to_ns == to_ns) else { return };
        for code in codes {
            restart.backfill.entry(code).or_insert_with(|| Fill { state: FILL_REQUESTED.into(), ..Fill::default() });
        }
        self.dirty.insert(id.clone());
        self.urgent.insert(id.clone());
    }

    /// A broker-connection outage of the partition (its connection and end) whose gap in `code` its provider is asked
    /// to fill (outage_gap.rs). False: no open record holds that outage for the code (its end touched no trading of
    /// the partition, so no loss record was written for it).
    pub fn outage_backfill_requested(&mut self, id: &PartitionId, connection: &str, to_ns: i64, code: &str) -> bool {
        let Some(row) = self.rows.get_mut(id).filter(|row| row.open()) else { return false };
        let code = code.to_uppercase();
        if !row.stored.outages.iter().any(|o| o.connection == connection && o.to_ns == to_ns && o.codes.contains(&code)) {
            return false;
        }
        let index = match row.outage_fills.iter().position(|f| f.connection == connection && f.to_ns == to_ns) {
            Some(index) => index,
            None => {
                row.outage_fills.push(OutageFill { connection: connection.to_owned(), to_ns, backfill: BTreeMap::new() });
                row.outage_fills.len() - 1
            }
        };
        row.outage_fills[index].backfill.entry(code).or_insert_with(|| Fill { state: FILL_REQUESTED.into(), ..Fill::default() });
        self.dirty.insert(id.clone());
        self.urgent.insert(id.clone());
        true
    }

    /// Whether the partition trades (or prints) at `now_ns` or later: false once its trading is over.
    pub fn trades_after(&self, id: &PartitionId, now_ns: i64) -> bool {
        covers_trading(&self.calendar, id, now_ns, now_ns + 3 * 86_400 * 1_000_000_000)
    }

    /// Whether the first print of `code` in `id` (at `first_ns`) is a late join, recorded as such when it is: its
    /// provider subscribed it (`since_ns`, its clock) after the partition's trading had begun, so the open to that
    /// print is a window nothing recorded. Not one when the subscription came before any trading, when a restart of
    /// the partition already asked for the code (its gap runs from the open too), or when the code joined before. A
    /// partition with no record (nothing of its market stored) is judged by the calendar alone.
    pub fn late_join(&mut self, id: &PartitionId, code: &str, since_ns: i64, first_ns: i64) -> bool {
        let Some((y, m, d)) = parse_calendar_date(&id.trading_date) else { return false };
        // The day before the partition's date: earlier than any of its trading (a NIGHT counts from its evening).
        let before_ns = (days_from_civil(y, m, d) - 1) * 86_400 * 1_000_000_000;
        if since_ns <= before_ns || !covers_trading(&self.calendar, id, before_ns, since_ns) {
            return false;
        }
        let code = code.to_uppercase();
        let Some(row) = self.rows.get_mut(id) else { return true };
        if !row.open() {
            return false;
        }
        if row.late_joins.contains_key(&code) || row.restarts.iter().any(|r| r.backfill.contains_key(&code)) {
            return false;
        }
        row.late_joins.insert(code, LateJoin { since_ns, first_ns, fill: Fill { state: FILL_REQUESTED.into(), ..Fill::default() } });
        self.dirty.insert(id.clone());
        self.urgent.insert(id.clone());
        true
    }

    /// A provider's report of one code's fill. A stored fill is `filled` only when its volumes meet: the cumulative
    /// volume it started from plus what it stored is the first live print's before its own. A stock's or a futures
    /// contract's gap that ended at a live print must state both; only an index (no print volume) or a gap that ran to
    /// the close (no print after it) has nothing to check, and stands as fetched. False: no open record holds that
    /// restart (or late join) and code.
    pub fn backfill_reported(&mut self, source: &str, report: &FillReport) -> bool {
        let id = PartitionId { source: source.to_lowercase(), market: report.market.to_uppercase(), trading_date: report.trading_date.clone(),
            session: report.session.to_uppercase() };
        let Some(row) = self.rows.get_mut(&id).filter(|row| row.open()) else { return false };
        let code = report.code.to_uppercase();
        let fill = if report.cause == CAUSE_LATE_JOIN {
            row.late_joins.get_mut(&code).map(|join| &mut join.fill)
        } else if report.cause == CAUSE_OUTAGE {
            row.outage_fills.iter_mut().find(|f| f.connection == report.connection && f.to_ns == report.outage_to_ns)
                .and_then(|f| f.backfill.get_mut(&code))
        } else {
            row.restarts.iter_mut().find(|r| r.to_ns == report.restart_to_ns).and_then(|restart| restart.backfill.get_mut(&code))
        };
        let Some(fill) = fill else { return false };
        let checkable = report.market.to_uppercase() != "IDX" && report.end != "session_close";
        let met = match (report.total_before, report.next_total_before) {
            (Some(from), Some(next)) => crate::volume::eq(from + report.volume, next),
            _ => !checkable,
        };
        *fill = Fill {
            state: match (report.outcome.as_str(), met) {
                ("stored", true) => FILL_FILLED,
                ("stored", false) => FILL_UNVERIFIED,
                ("after_close", _) => FILL_AFTER_CLOSE,
                _ => FILL_FAILED,
            }.into(),
            prints: report.prints, volume: report.volume,
            reason: if report.outcome == "stored" && !met {
                unverified_reason(report)
            } else { report.reason.clone() },
        };
        self.dirty.insert(id.clone());
        self.urgent.insert(id);
        true
    }

    /// The source's process is known to be recording its open records up to `now_ns` (its connection is up, or it
    /// just closed).
    pub fn stamp(&mut self, source: &str, now_ns: i64) {
        let Some(instance) = self.instances.get(source) else { return };
        for (id, row) in self.rows.iter_mut().filter(|(id, row)| id.source == source && row.open() && row.instance == *instance) {
            row.recorded_until_ns = now_ns;
            self.dirty.insert(id.clone());
        }
    }

    /// The SOURCE_GAP records an `ingest.loss` report is written as, one per partition it touches, each at an
    /// exchange time inside it (the report's start, or its end for the partition it ends in). Events the provider
    /// dropped are always a loss. A broker outage is one only for a partition whose trading (or a print instant) it
    /// touches, of a day that is a session; its count is unknown to the provider and is written as at least one, the
    /// least B must mark. `template` carries the provider's identity fields (generation, arrival, epoch).
    pub fn loss_records(&self, source: &str, report: &LossReport, trading_day: TradingDay<'_>, template: &MarketEvent) -> Vec<MarketEvent> {
        let (from_ns, to_ns) = (report.from_ns.min(report.to_ns), report.from_ns.max(report.to_ns));
        let mut touched: Vec<(PartitionId, i64)> = Vec::new();
        for ts in [from_ns, to_ns] {
            if let Some((trading_date, session, _)) = wal_partition(source, &report.market, ts) {
                let id = PartitionId { source: source.to_lowercase(), market: report.market.to_uppercase(), trading_date, session: session.into() };
                if !touched.iter().any(|(seen, _)| *seen == id) {
                    touched.push((id, ts));
                }
            }
            if report.reason == LOSS_DROPPED {
                break;
            }
        }
        // A closed session loses nothing any more: its record and its history are final.
        touched.into_iter().filter(|(id, _)| !self.is_closed(id)).filter(|(id, _)| {
            report.reason == LOSS_DROPPED
                || (covers_trading(&self.calendar, id, from_ns, to_ns)
                    && (id.source != "shioaji" || id.session == "NIGHT" || trading_day(&id.trading_date)))
        }).map(|(id, ts)| {
            let detail = serde_json::to_string(&LossDetail { reason: report.reason.clone(), to_ns, connection: report.connection.clone() })
                .unwrap_or_default();
            MarketEvent {
                schema_version: EVENT_SCHEMA_VERSION, event_id: format!("loss:{}:{}:{}:{}:{}", id.source, id.market, report.code, report.reason, ts),
                durable_sequence: 0, symbol: format!("{}:{}:{}", id.source, id.market, report.code.to_uppercase()),
                provider: id.source.clone(), market: id.market.clone(), code: report.code.to_uppercase(), session: id.session.clone(),
                trading_date: id.trading_date.clone(), exchange_ts_ns: if ts == to_ns { to_ns } else { from_ns }, time_quality: LOSS_CONTROL.into(),
                flags: EventFlags { gap_before: report.count.max(1), ..EventFlags::default() },
                payload: Payload::SourceStatus { state: SOURCE_GAP.into(), detail },
                ..template.clone()
            }
        }).collect()
    }

    /// The owner sealed the partition: frozen from now on, and its day closed in its source + market + session. False:
    /// there is no record (sealing invents none).
    pub fn seal(&mut self, id: &PartitionId) -> bool {
        let Some(row) = self.rows.get_mut(id) else { return false };
        if !row.sealed {
            row.sealed = true;
            self.dirty.insert(id.clone());
        }
        self.close_through(id);
        true
    }

    /// Close for good a record that is no session of its market (a day it had none); frozen like a sealed one. False
    /// when there is no record or it is quarantined already.
    pub fn quarantine(&mut self, id: &PartitionId, reason: &str, now_ns: i64) -> bool {
        let Some(row) = self.rows.get_mut(id).filter(|row| row.quarantined.is_none()) else { return false };
        row.quarantined = Some(Quarantine { reason: reason.into(), at_ns: now_ns, accepted: row.stored.accepted, sealed: row.sealed });
        self.dirty.insert(id.clone());
        true
    }

    /// Only for a real, verified backfill or recovery; nothing infers it.
    pub fn mark_repaired(&mut self, id: &PartitionId, note: &str, now_ns: i64) -> bool {
        let Some(row) = self.rows.get_mut(id) else { return false };
        row.repaired = Some(Repaired { note: note.into(), at_ns: now_ns });
        self.dirty.insert(id.clone());
        true
    }

    /// The closed (sealed or quarantined) records among `ids` with nothing left to write: forgotten here; the caller
    /// deletes their files. A partition this ledger holds no record of is the caller's to judge from its file.
    pub fn take_closed(&mut self, ids: &[PartitionId]) -> (Vec<PartitionId>, Vec<PartitionId>) {
        let (mut closed, mut unknown) = (Vec::new(), Vec::new());
        for id in ids {
            match self.rows.get(id) {
                Some(row) if !row.open() && !self.dirty.contains(id) => {
                    self.rows.remove(id);
                    closed.push(id.clone());
                }
                Some(_) => {}
                None => unknown.push(id.clone()),
            }
        }
        (closed, unknown)
    }

    /// The records changed since last written, as their files; `written` takes back each one that failed.
    pub fn take_dirty(&mut self, only: Option<&PartitionId>) -> Vec<(PartitionId, File)> {
        let ids: Vec<PartitionId> = match only {
            Some(id) => self.dirty.take(id).into_iter().collect(),
            None => std::mem::take(&mut self.dirty).into_iter().collect(),
        };
        for id in &ids {
            self.urgent.remove(id);
        }
        ids.into_iter().filter_map(|id| self.rows.get(&id).map(|row| (id.clone(), File::of(&id, row)))).collect()
    }

    /// The records changed in what completeness is judged from, as their files (see `urgent`).
    pub fn take_urgent(&mut self) -> Vec<(PartitionId, File)> {
        let ids = std::mem::take(&mut self.urgent);
        ids.into_iter().filter_map(|id| {
            self.dirty.remove(&id);
            self.rows.get(&id).map(|row| (id.clone(), File::of(&id, row)))
        }).collect()
    }

    pub fn redirty(&mut self, id: PartitionId) {
        if self.rows.contains_key(&id) {
            self.dirty.insert(id);
        }
    }
}

fn loss_detail(event: &MarketEvent) -> Option<LossDetail> {
    match &event.payload {
        Payload::SourceStatus { detail, .. } => serde_json::from_str(detail).ok(),
        _ => None,
    }
}

fn read_dirs(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(path) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs
}

/// Whether a partition file on disk is closed -- sealed or quarantined -- whatever format wrote it (both formats
/// name these two fields alike); None when it cannot be read as a record at all.
pub fn is_closed_on_disk(path: &Path) -> Option<bool> {
    let value: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let object = value.as_object()?;
    Some(object.get("sealed").and_then(Value::as_bool).unwrap_or(false)
        || object.get("quarantined").is_some_and(|q| !q.is_null() && q != &json!(false)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::days_from_civil;

    fn taipei(date: (i64, i64, i64), minute: i64) -> i64 {
        (days_from_civil(date.0, date.1, date.2) * 86_400 + minute * 60 - 8 * 3600) * 1_000_000_000
    }

    fn print(market: &str, ts: i64, code: &str) -> MarketEvent {
        let (trading_date, session, minute) = wal_partition("shioaji", market, ts).unwrap();
        serde_json::from_value(json!({"schema_version": 2, "symbol": format!("shioaji:{market}:{code}"), "provider": "shioaji",
            "market": market, "code": code, "session": session, "trading_date": trading_date, "generation": 1, "sequence": 1,
            "exchange_ts_ns": ts, "time_quality": "exchange",
            "payload": {"kind": "trade", "price": 1, "volume": 1, "total_volume": 1, "side": 1, "trade_id": "x", "minute": minute,
                        "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0}})).unwrap()
    }

    fn id(market: &str, date: &str, session: &str) -> PartitionId {
        PartitionId { source: "shioaji".into(), market: market.into(), trading_date: date.into(), session: session.into() }
    }

    #[test]
    fn a_span_covers_trading_when_it_touches_a_trading_minute_or_a_print_instant() {
        let cal = Calendar::default();
        let stk = id("STK", "2026-09-29", "DAY");
        assert!(covers_trading(&cal, &stk, taipei((2026, 9, 29), 600), taipei((2026, 9, 29), 601)));
        assert!(!covers_trading(&cal, &stk, taipei((2026, 9, 29), 820), taipei((2026, 9, 29), 860)), "13:40-14:20: nothing trades");
        assert!(covers_trading(&cal, &stk, taipei((2026, 9, 29), 860), taipei((2026, 9, 29), 875)), "14:30 盤後定價 is a print instant");
        let night = id("FUT", "2026-09-29", "NIGHT");
        assert!(covers_trading(&cal, &night, taipei((2026, 9, 30), 60), taipei((2026, 9, 30), 70)), "01:00 the next day is the night's");
        assert!(!covers_trading(&cal, &night, taipei((2026, 9, 29), 600), taipei((2026, 9, 29), 700)), "the DAY's minutes are not the NIGHT's");
    }

    /// 1104-C06-07: after a US half day's 17:00 close nothing trades until the overnight session.
    #[test]
    fn a_half_days_early_close_ends_the_post_session_only_on_that_day() {
        // 2026-11-27 is a half day of the built-in holidays file, which every Calendar reads until a process installs its own.
        let cal = Calendar::default();
        let new_york = |day: i64, minute: i64| (days_from_civil(2026, 11, day) * 86_400 + minute * 60 + 5 * 3600) * 1_000_000_000;
        let partition = |date: &str| PartitionId { source: "futu".into(), market: "US".into(), trading_date: date.into(), session: "FULL".into() };
        let (half, whole) = (partition("2026-11-27"), partition("2026-11-26"));
        assert!(!covers_trading(&cal, &half, new_york(27, 1050), new_york(27, 1140)), "17:30-19:00 of the half day");
        assert!(covers_trading(&cal, &half, new_york(27, 1000), new_york(27, 1010)), "16:40: the shortened session still trades");
        assert!(covers_trading(&cal, &whole, new_york(26, 1050), new_york(26, 1140)), "the same span of a whole day");
        assert!(covers_trading(&cal, &half, new_york(27, 1250), new_york(27, 1260)), "the overnight session is not shortened");
        assert!(covers_trading(&cal, &half, new_york(27, 800), new_york(27, 810)), "13:20: the half day's after-hours session trades from 13:00");
        assert!(covers_trading(&cal, &half, new_york(27, 700), new_york(27, 710)), "11:40: the shortened regular session");
    }

    #[test]
    fn stored_events_fold_into_their_partition_and_a_replay_from_the_image_gives_the_same_record() {
        let mut live = Ledger::default();
        let a = print("FUT", taipei((2026, 9, 29), 1300), "TXFR1");
        let b = print("FUT", taipei((2026, 9, 30), 120), "TXFR1");
        assert!(live.fold(&a, true));
        let image = live.image();
        assert!(!live.fold(&b, true), "the 02:00 print is the same NIGHT partition");
        let night = id("FUT", "2026-09-29", "NIGHT");
        let row = live.row(&night).unwrap().clone();
        assert_eq!((row.stored.accepted, row.stored.first_ts_ns, row.stored.last_ts_ns), (2, a.exchange_ts_ns, b.exchange_ts_ns));

        let mut restarted = Ledger { rows: BTreeMap::from([(night.clone(), Row { stored: Stored { accepted: 99, ..Stored::default() }, ..Row::default() })]),
            ..Ledger::default() };
        restarted.restore(Some(&image));
        restarted.fold(&b, restarted.replay_creates);
        assert_eq!(restarted.row(&night).unwrap().stored, row.stored, "image + replay of what followed it");
    }

    #[test]
    fn a_minute_bar_filed_under_its_end_does_not_move_a_restart_past_the_moment_it_came() {
        let mut ledger = Ledger::default();
        let now = taipei((2026, 9, 29), 600);
        ledger.hello("shioaji", "p1", now - 120_000_000_000);
        let mut bar = print("STK", now + 30_000_000_000, "2330");
        bar.flags.time_label = true;
        bar.arrival_ns = (now - 30_000_000_000) as u64;
        ledger.fold(&bar, true);
        let stk = id("STK", "2026-09-29", "DAY");
        assert_eq!(ledger.row(&stk).unwrap().stored.last_ts_ns, bar.arrival_ns as i64, "the label says no more than that it had arrived");
        assert_eq!(ledger.hello("shioaji", "p2", now), vec![stk.clone()]);
        let restart = &ledger.row(&stk).unwrap().restarts[0];
        assert_eq!((restart.from_ns, restart.to_ns), (bar.arrival_ns as i64, now));
    }

    #[test]
    fn a_restart_starts_no_later_than_it_ends_when_the_exchange_clock_runs_ahead() {
        let mut ledger = Ledger::default();
        let now = taipei((2026, 9, 29), 600);
        ledger.hello("shioaji", "p1", now - 120_000_000_000);
        ledger.fold(&print("STK", now + 1_000_000_000, "2330"), true);
        ledger.hello("shioaji", "p2", now);
        let restart = &ledger.row(&id("STK", "2026-09-29", "DAY")).unwrap().restarts[0];
        assert_eq!((restart.from_ns, restart.to_ns), (now, now));
    }

    #[test]
    fn a_new_process_is_a_restart_of_its_open_partitions_and_the_same_one_reconnecting_is_not() {
        let mut ledger = Ledger::default();
        ledger.hello("shioaji", "p1", taipei((2026, 9, 29), 530));
        ledger.fold(&print("STK", taipei((2026, 9, 29), 600), "2330"), true);
        let stk = id("STK", "2026-09-29", "DAY");
        assert!(ledger.hello("shioaji", "p1", taipei((2026, 9, 29), 610)).is_empty(), "the same process: it kept what it held");
        assert_eq!(ledger.hello("shioaji", "p2", taipei((2026, 9, 29), 620)), vec![stk.clone()]);
        let row = ledger.row(&stk).unwrap();
        assert_eq!(row.restarts, vec![Restart { from_ns: taipei((2026, 9, 29), 610), to_ns: taipei((2026, 9, 29), 620), during_trading: true,
            backfill: BTreeMap::new() }]);
        assert_eq!(row.completeness(), "gap_detected");
        ledger.backfill_requested(&stk, taipei((2026, 9, 29), 620), ["2330".to_owned()]);
        assert_eq!(ledger.row(&stk).unwrap().completeness(), "gap_detected", "asked, not filled yet");
        let later = FillReport { market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into(),
            cause: CAUSE_RESTART.into(), restart_to_ns: taipei((2026, 9, 29), 620), connection: String::new(), outage_to_ns: 0, outcome: "after_close".into(), end: "first_live_print".into(),
            prints: 0, volume: 0.0, total_before: Some(100.0), next_total_before: Some(130.0), history_last_ns: None, reason: "not held yet".into() };
        assert!(ledger.backfill_reported("shioaji", &later));
        let fill = &ledger.row(&stk).unwrap().restarts[0].backfill["2330"];
        assert_eq!((fill.state.as_str(), fill.reason.as_str()), (FILL_AFTER_CLOSE, "not held yet"), "left to the close's fill, not failed");
        assert_eq!(ledger.row(&stk).unwrap().completeness(), "gap_detected", "the gap is still open until then");
        let report = |volume: f64| FillReport { market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into(),
            cause: CAUSE_RESTART.into(), restart_to_ns: taipei((2026, 9, 29), 620), connection: String::new(), outage_to_ns: 0, outcome: "stored".into(), end: "first_live_print".into(), prints: 3, volume, total_before: Some(100.0),
            next_total_before: Some(130.0), history_last_ns: None, reason: String::new() };
        assert!(ledger.backfill_reported("shioaji", &report(20.0)));
        assert_eq!(ledger.row(&stk).unwrap().restarts[0].backfill["2330"].state, FILL_UNVERIFIED, "10 lots still missing");
        assert_eq!(ledger.row(&stk).unwrap().completeness(), "gap_detected");
        assert!(ledger.backfill_reported("shioaji", &report(30.0)));
        assert_eq!(ledger.row(&stk).unwrap().completeness(), "repaired", "the gap is stored and its volumes meet");
        assert_eq!(ledger.row(&stk).unwrap().interruptions(), 0);
        // The reason says what was short and how far the broker's history reached (11-09: 1101 and TXFR1 asked under a
        // second after their end, each answer ending before it).
        let short = FillReport { history_last_ns: Some(taipei((2026, 9, 29), 619)), ..report(20.0) };
        assert!(ledger.backfill_reported("shioaji", &short));
        let fill = &ledger.row(&stk).unwrap().restarts[0].backfill["2330"];
        assert_eq!((fill.state.as_str(), fill.reason.clone()), (FILL_UNVERIFIED,
            format!("100 + 20 stored != 130 before the first live print; the broker's history answered up to {}", taipei((2026, 9, 29), 619))));
        assert!(ledger.backfill_reported("shioaji", &report(30.0)));
        // A total nobody stated is not a 0 that failed to meet (11-09: FZF202611 read "0 + 1497 stored != 1497").
        let no_open_total = FillReport { total_before: None, next_total_before: Some(1497.0), ..report(1497.0) };
        assert!(ledger.backfill_reported("shioaji", &no_open_total));
        let fill = &ledger.row(&stk).unwrap().restarts[0].backfill["2330"];
        assert_eq!((fill.state.as_str(), fill.reason.as_str()), (FILL_UNVERIFIED, "unstated + 1497 stored != 1497 before the first live print"));
        assert!(ledger.backfill_reported("shioaji", &report(30.0)));
        let unstated = FillReport { next_total_before: None, ..report(30.0) };
        assert!(ledger.backfill_reported("shioaji", &unstated));
        assert_eq!(ledger.row(&stk).unwrap().restarts[0].backfill["2330"].state, FILL_UNVERIFIED, "a live end states the volume after it");
        ledger.seal(&stk);
        assert!(ledger.hello("shioaji", "p3", taipei((2026, 9, 29), 700)).is_empty(), "a sealed partition is frozen");
    }

    #[test]
    fn a_code_subscribed_once_trading_began_is_a_late_join_recorded_once_and_its_fill_verified() {
        let mut ledger = Ledger::default();
        ledger.hello("shioaji", "p1", taipei((2026, 9, 29), 500));
        ledger.fold(&print("STK", taipei((2026, 9, 29), 540), "2330"), true);
        let stk = id("STK", "2026-09-29", "DAY");
        let first = taipei((2026, 9, 29), 601);
        assert!(!ledger.late_join(&stk, "2317", taipei((2026, 9, 29), 530), first), "subscribed 08:50: before any trading");
        assert!(ledger.late_join(&stk, "2317", taipei((2026, 9, 29), 600), first), "subscribed 10:00");
        assert!(!ledger.late_join(&stk, "2317", taipei((2026, 9, 29), 600), first), "judged once");
        assert_eq!(ledger.row(&stk).unwrap().late_joins["2317"].fill.state, FILL_REQUESTED);
        assert_eq!(ledger.row(&stk).unwrap().completeness(), "complete", "a late join is no loss of the partition");
        let report = |volume: f64| FillReport { market: "STK".into(), code: "2317".into(), trading_date: "2026-09-29".into(), session: "DAY".into(),
            cause: CAUSE_LATE_JOIN.into(), restart_to_ns: 0, connection: String::new(), outage_to_ns: 0, outcome: "stored".into(), end: "first_live_print".into(), prints: 40, volume,
            total_before: Some(0.0), next_total_before: Some(900.0), history_last_ns: None, reason: String::new() };
        assert!(ledger.backfill_reported("shioaji", &report(899.0)));
        assert_eq!(ledger.row(&stk).unwrap().late_joins["2317"].fill.state, FILL_UNVERIFIED);
        assert!(ledger.backfill_reported("shioaji", &report(900.0)));
        assert_eq!(ledger.row(&stk).unwrap().late_joins["2317"].fill.state, FILL_FILLED);
        assert!(!ledger.backfill_reported("shioaji", &FillReport { code: "2603".into(), ..report(1.0) }), "never asked");
        // A code a restart already asked for is filled from the open by that restart.
        ledger.hello("shioaji", "p2", taipei((2026, 9, 29), 620));
        ledger.backfill_requested(&stk, taipei((2026, 9, 29), 620), ["2603".to_owned()]);
        assert!(!ledger.late_join(&stk, "2603", taipei((2026, 9, 29), 620), taipei((2026, 9, 29), 621)));
        let night = id("FUT", "2026-09-29", "NIGHT");
        assert!(!ledger.late_join(&night, "TXFR1", taipei((2026, 9, 29), 880), taipei((2026, 9, 29), 900)), "14:40: before the night opens");
        assert!(ledger.late_join(&night, "TXFR1", taipei((2026, 9, 30), 60), taipei((2026, 9, 30), 61)), "01:00: the night is trading");
    }

    #[test]
    fn a_broker_outage_during_trading_is_a_hole_in_its_codes_only_and_one_outside_trading_is_none() {
        let mut ledger = Ledger::default();
        ledger.fold(&print("STK", taipei((2026, 9, 29), 600), "2330"), true);
        let template = print("STK", taipei((2026, 9, 29), 600), "2330");
        let weekday = |_: &str| true;
        let report = |from: i64, to: i64| LossReport { market: "STK".into(), code: "2317".into(), from_ns: taipei((2026, 9, 29), from),
            to_ns: taipei((2026, 9, 29), to), count: 0, reason: LOSS_BROKER_OUTAGE.into(), connection: "c2".into() };
        assert!(ledger.loss_records("shioaji", &report(830, 840), &weekday, &template).is_empty(), "13:50-14:00 trades nothing");
        let records = ledger.loss_records("shioaji", &report(610, 615), &weekday, &template);
        assert_eq!(records.len(), 1);
        assert_eq!((records[0].flags.gap_before, records[0].code.as_str()), (1, "2317"), "an unknown count is at least one");
        for record in &records {
            ledger.fold(record, true);
        }
        let row = ledger.row(&id("STK", "2026-09-29", "DAY")).unwrap();
        assert_eq!((row.gap_codes(), row.completeness()), (vec!["2317".to_owned()], "complete"));
        let dropped = LossReport { reason: LOSS_DROPPED.into(), count: 3, ..report(830, 831) };
        for record in ledger.loss_records("shioaji", &dropped, &weekday, &template) {
            ledger.fold(&record, true);
        }
        let row = ledger.row(&id("STK", "2026-09-29", "DAY")).unwrap();
        assert_eq!((row.stored.dropped, row.completeness()), (3, "gap_detected"), "dropped events are always a loss");
    }

    #[test]
    fn a_resent_event_is_a_duplicate_and_any_other_refusal_a_loss() {
        let mut ledger = Ledger::default();
        ledger.fold(&print("STK", taipei((2026, 9, 29), 600), "2330"), true);
        let stk = id("STK", "2026-09-29", "DAY");
        ledger.rejected(&stk, "RejectedSequence");
        assert_eq!((ledger.row(&stk).unwrap().duplicates, ledger.row(&stk).unwrap().completeness()), (1, "complete"));
        ledger.rejected(&stk, "WAL_FAILED: disk");
        assert_eq!(ledger.row(&stk).unwrap().completeness(), "gap_detected");
        ledger.mark_repaired(&stk, "verified", 1);
        assert_eq!(ledger.row(&stk).unwrap().completeness(), "repaired");
    }

    #[test]
    fn a_sealed_partition_stays_closed_after_its_record_is_pruned_and_takes_no_event_refusal_or_loss() {
        let mut ledger = Ledger::default();
        let day = print("STK", taipei((2026, 9, 29), 600), "2330");
        ledger.fold(&day, true);
        let stk = id("STK", "2026-09-29", "DAY");
        assert!(!ledger.is_closed(&stk));
        ledger.seal(&stk);
        assert!(ledger.is_closed(&stk));
        let late = print("STK", taipei((2026, 9, 29), 601), "2330");
        assert!(!ledger.fold(&late, true));
        ledger.rejected(&stk, "WAL_FAILED: disk");
        assert!(ledger.row(&stk).unwrap().sealed, "a refusal never replaces a sealed record with an open one");
        ledger.take_dirty(None);
        assert_eq!(ledger.take_closed(std::slice::from_ref(&stk)).0, vec![stk.clone()]);

        // Pruned: no record any more, and still closed -- a late event (a broker's first push) makes no new record.
        assert!(ledger.is_closed(&stk));
        assert!(!ledger.fold(&late, true));
        assert!(ledger.row(&stk).is_none(), "a pruned session is never recorded again");
        ledger.rejected(&stk, "WAL_FAILED: disk");
        assert!(ledger.row(&stk).is_none());
        let template = print("STK", taipei((2026, 9, 29), 600), "2330");
        let dropped = LossReport { market: "STK".into(), code: "2317".into(), from_ns: taipei((2026, 9, 29), 610),
            to_ns: taipei((2026, 9, 29), 611), count: 2, reason: LOSS_DROPPED.into(), connection: String::new() };
        assert!(ledger.loss_records("shioaji", &dropped, &|_: &str| true, &template).is_empty());

        // An earlier day still open is not closed by a later seal; a later day opens as usual.
        assert!(ledger.is_closed(&id("STK", "2026-09-28", "DAY")), "no record and before the newest sealed day: closed");
        assert!(!ledger.is_closed(&id("FUT", "2026-09-28", "DAY")), "another market's days are its own");
        assert!(ledger.fold(&print("STK", taipei((2026, 9, 30), 600), "2330"), true));
    }

    #[test]
    fn the_day_closed_through_is_kept_in_its_own_file_and_read_back_with_the_sealed_records() {
        let root = std::env::temp_dir().join(format!("mr-closed-through-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (mut ledger, problems) = Ledger::load(Some(root.clone()));
        assert!(problems.is_empty());
        ledger.fold(&print("STK", taipei((2026, 9, 29), 600), "2330"), true);
        let stk = id("STK", "2026-09-29", "DAY");
        ledger.seal(&stk);
        let file = ledger.take_closed_through().expect("sealing moves the day");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(closed_through_path(&root), serde_json::to_vec(&file).unwrap()).unwrap();
        assert!(ledger.take_closed_through().is_none(), "written once");
        // The sealed record is gone (pruned): the file alone says it is closed.
        let (reloaded, problems) = Ledger::load(Some(root.clone()));
        assert!(problems.is_empty(), "{problems:?}");
        assert!(reloaded.is_closed(&stk));
        assert!(!reloaded.is_closed(&id("STK", "2026-09-30", "DAY")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
