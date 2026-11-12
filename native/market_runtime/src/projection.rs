//! ProjectionCache: Rust B's minute/window/day/flow/event results and the producer's model signals, validated,
//! merged, cached and delivered -- never recomputed (docs/system-architecture/01 section 2, 03 section 3).
//!
//! Validation per block: the durable stream must be Rust A's own; a lower projection epoch is stale; within an
//! epoch the input watermark never goes backwards and an equal watermark needs a higher revision. Minutes and
//! events carry their own per-record revision, so a late correction of one minute replaces only that minute.
//! The cache is rebuildable: after a restart it is empty and reported as RECOVERING until B republishes.

use crate::event::StateKey;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

pub const EVENT_CAPACITY: usize = 200;
const MODEL_ENTRY_CAPACITY: usize = 16;

/// The blocks Rust B publishes per state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BlockKind {
    Minutes,
    Windows,
    Day,
    Flow,
    Events,
}

impl BlockKind {
    pub const ALL: [BlockKind; 5] = [BlockKind::Minutes, BlockKind::Windows, BlockKind::Day, BlockKind::Flow, BlockKind::Events];

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|b| b.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            BlockKind::Minutes => "minutes",
            BlockKind::Windows => "windows",
            BlockKind::Day => "day",
            BlockKind::Flow => "flow",
            BlockKind::Events => "events",
        }
    }
}

/// The publisher's description of one block, stored with it and served as its meta.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProjectionMeta {
    pub as_of: Value,
    pub config_version: Value,
    pub completeness: Value,
}

/// One block's records, validated before anything in the cache changes: minutes keyed by their integer minute,
/// events by their non-empty `event_id`, each with its own revision. A record without them refuses the whole
/// item; it is never skipped while the publisher is told the block was taken.
#[derive(Debug, Clone, PartialEq)]
pub enum BlockData {
    Minutes { records: Vec<(i32, u64, Value)>, replace: bool },
    Events { records: Vec<(String, u64, Value)>, replace: bool },
    Whole(Value),
    /// A day / flow item naming only what changed since the one before (merge_increment).
    Increment(Value),
}

impl BlockData {
    pub fn parse(block: BlockKind, data: &Value) -> Result<Self, Refusal> {
        let malformed = |why: String| Refusal::new("MALFORMED_RECORD", format!("{}: {why}", block.name()));
        let replace = match data.get("replace") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(other) => return Err(malformed(format!("replace must be a boolean, got {other}"))),
        };
        let records = |field: &str| -> Result<&Vec<Value>, Refusal> {
            data.get(field).and_then(Value::as_array).ok_or_else(|| malformed(format!("data.{field} must be an array")))
        };
        let revision = |index: usize, record: &Value| -> Result<u64, Refusal> {
            record.get("revision").and_then(Value::as_u64)
                .ok_or_else(|| malformed(format!("record {index} has no unsigned integer revision")))
        };
        match block {
            BlockKind::Minutes => {
                let mut out = Vec::new();
                for (index, record) in records("minutes")?.iter().enumerate() {
                    let minute = record.get("minute").and_then(Value::as_i64).and_then(|m| i32::try_from(m).ok())
                        .ok_or_else(|| malformed(format!("record {index} has no integer minute")))?;
                    out.push((minute, revision(index, record)?, record.clone()));
                }
                Ok(BlockData::Minutes { records: out, replace })
            }
            BlockKind::Events => {
                let mut out = Vec::new();
                for (index, record) in records("events")?.iter().enumerate() {
                    let id = record.get("event_id").and_then(Value::as_str).filter(|id| !id.is_empty())
                        .ok_or_else(|| malformed(format!("record {index} has no event_id")))?;
                    out.push((id.to_owned(), revision(index, record)?, record.clone()));
                }
                Ok(BlockData::Events { records: out, replace })
            }
            // A live day / flow item that says `replace: false` names only what changed (Rust B's Increment): its
            // keyed records merge into the block held (merge_increment).
            BlockKind::Day | BlockKind::Flow if data.get("replace") == Some(&Value::Bool(false)) => Ok(BlockData::Increment(data.clone())),
            BlockKind::Windows | BlockKind::Day | BlockKind::Flow => Ok(BlockData::Whole(data.clone())),
        }
    }
}

/// Upsert `incoming` rows into `held` (both arrays of objects ordered by the numeric `key`), each row whole.
fn upsert_rows(held: &mut Value, incoming: &Value, key: &str) {
    let number = |row: &Value| row.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
    if !held.is_array() {
        *held = Value::Array(Vec::new());
    }
    let rows = held.as_array_mut().expect("made an array above");
    for row in incoming.as_array().into_iter().flatten() {
        let at = number(row);
        match rows.binary_search_by(|r| number(r).partial_cmp(&at).unwrap_or(std::cmp::Ordering::Less)) {
            Ok(i) => rows[i] = row.clone(),
            Err(i) => rows.insert(i, row.clone()),
        }
    }
}

/// Merge a day / flow increment into the block held: its plain fields replace the held ones, its keyed records
/// (flow `minuteSeries` by minute; day `fixed_k` bars by start minute, `price_volume.buckets` by price) are upserted,
/// and a flow `largeOrders` it carries replaces the list (left out: unchanged).
fn merge_increment(block: BlockKind, held: &mut Value, increment: &Value) {
    let (Some(target), Some(fields)) = (held.as_object_mut(), increment.as_object()) else { return };
    for (field, value) in fields {
        match (block, field.as_str()) {
            (_, "replace") => {}
            (BlockKind::Flow, "minuteSeries") => upsert_rows(target.entry(field.clone()).or_insert(Value::Null), value, "minute"),
            (BlockKind::Day, "fixed_k") => {
                let slot = target.entry(field.clone()).or_insert_with(|| json!({}));
                for (timeframe, bars) in value.as_object().into_iter().flatten() {
                    if let Some(map) = slot.as_object_mut() {
                        upsert_rows(map.entry(timeframe.clone()).or_insert(Value::Null), bars, "start_minute");
                    }
                }
            }
            (BlockKind::Day, "price_volume") => {
                let slot = target.entry(field.clone()).or_insert_with(|| json!({}));
                for (key, part) in value.as_object().into_iter().flatten() {
                    if let Some(map) = slot.as_object_mut() {
                        if key == "buckets" {
                            upsert_rows(map.entry(key.clone()).or_insert(Value::Null), part, "price");
                        } else {
                            map.insert(key.clone(), part.clone());
                        }
                    }
                }
            }
            _ => {
                target.insert(field.clone(), value.clone());
            }
        }
    }
}

/// One published item, its block already validated.
#[derive(Debug, Clone)]
pub struct PublishRequest {
    pub key: StateKey,
    pub block: BlockKind,
    pub epoch: u64,
    pub watermark: u64,
    pub revision: u64,
    pub data: BlockData,
    pub meta: ProjectionMeta,
}

impl PublishRequest {
    /// The item as `projection.publish` carries it; the caller has resolved its identity to `key`.
    pub fn from_item(key: StateKey, epoch: u64, item: &Value) -> Result<Self, Refusal> {
        let name = item.get("block").and_then(Value::as_str).unwrap_or("");
        let block = BlockKind::parse(name).ok_or_else(|| Refusal::new("UNKNOWN_BLOCK", format!("unknown block {name}")))?;
        let number = |field: &str| item.get(field).and_then(Value::as_u64)
            .ok_or_else(|| Refusal::new("MALFORMED_RECORD", format!("{name}: {field} must be an unsigned integer")));
        let watermark = number("input_watermark")?;
        let revision = number("revision")?;
        let data = BlockData::parse(block, item.get("data").unwrap_or(&Value::Null))?;
        let field = |f: &str| item.get(f).cloned().unwrap_or(Value::Null);
        Ok(Self { key, block, epoch, watermark, revision, data,
                  meta: ProjectionMeta { as_of: field("as_of"), config_version: field("config_version"), completeness: field("completeness") } })
    }
}

#[derive(Debug, Clone, Default)]
pub struct BlockMeta {
    pub projection_epoch: u64,
    pub input_watermark: u64,
    pub revision: u64,
    pub as_of: Value,
    pub config_version: Value,
    pub completeness: Value,
    pub updated_at_ns: u64,
}

impl BlockMeta {
    fn wire(&self) -> Value {
        json!({"projection_epoch": self.projection_epoch, "input_watermark": self.input_watermark, "revision": self.revision,
               "as_of": self.as_of, "config_version": self.config_version, "completeness": self.completeness,
               "updated_at_us": self.updated_at_ns / 1000})
    }
}

/// A block of Rust B's as Market Runtime holds it: its compact JSON text (None: null). A serves B's results and never
/// computes on them, and a serde_json tree costs 5 to 12 times its text in memory (11-12: the minute, flow and day
/// blocks of 111 states held 405 MB as trees). The text is decoded where a block is served or merged.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Held(Option<Box<str>>);

impl Held {
    pub fn of(value: &Value) -> Self {
        Self((!value.is_null()).then(|| value.to_string().into_boxed_str()))
    }

    pub fn value(&self) -> Value {
        self.0.as_deref().map(decode).unwrap_or(Value::Null)
    }

    pub fn is_null(&self) -> bool {
        self.0.is_none()
    }

    /// A JSON object (what a day / flow increment merges into).
    pub fn is_object(&self) -> bool {
        self.0.as_deref().is_some_and(|text| text.starts_with('{'))
    }
}

/// Text this module wrote with serde_json, back to the value it was written from.
fn decode(text: &str) -> Value {
    serde_json::from_str(text).expect("held JSON is serde_json's own output")
}

/// One minute record as held: its text, and the two things its merge compares (`Minutes::newer`).
#[derive(Debug, Clone)]
struct HeldMinute {
    revision: u64,
    forming: bool,
    text: Box<str>,
}

/// Rust B's minute records of one state, by minute, each as its compact text (see `Held`). The newest minute is
/// also held decoded: every quote and trade of the state reads it (wire::current_point).
#[derive(Debug, Clone, Default)]
pub struct Minutes {
    records: BTreeMap<i32, HeldMinute>,
    newest: Option<(i32, Value)>,
}

impl Minutes {
    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn keys(&self) -> impl Iterator<Item = i32> + '_ {
        self.records.keys().copied()
    }

    pub fn clear(&mut self) {
        self.records.clear();
        self.newest = None;
    }

    /// The record of `minute`.
    pub fn get(&self, minute: i32) -> Option<std::borrow::Cow<'_, Value>> {
        match &self.newest {
            Some((m, record)) if *m == minute => Some(std::borrow::Cow::Borrowed(record)),
            _ => self.records.get(&minute).map(|held| std::borrow::Cow::Owned(decode(&held.text))),
        }
    }

    /// Every record, oldest minute first.
    pub fn values(&self) -> impl Iterator<Item = Value> + '_ {
        self.records.values().map(|held| decode(&held.text))
    }

    /// Whether `record` (of revision `revision`) replaces what is held for `minute`: a higher revision, or a forming
    /// minute published again with other figures at the same revision.
    fn newer(&self, minute: i32, revision: u64, text: &str) -> bool {
        self.records.get(&minute).is_none_or(|old| revision > old.revision || (revision == old.revision && old.forming && *old.text != *text))
    }

    pub fn insert(&mut self, minute: i32, record: Value) {
        let text = record.to_string().into_boxed_str();
        self.insert_text(minute, record, text);
    }

    fn insert_text(&mut self, minute: i32, record: Value, text: Box<str>) {
        let held = HeldMinute { revision: record_revision(&record), forming: record.get("state") == Some(&json!("FORMING")), text };
        self.records.insert(minute, held);
        if self.newest.as_ref().is_none_or(|(m, _)| minute >= *m) {
            self.newest = Some((minute, record));
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProjectionEntry {
    pub epoch: u64,
    pub minutes: Minutes,
    pub windows: Value,
    pub day: Held,
    pub flow: Held,
    pub events: VecDeque<Value>,
    pub signals: Option<Map<String, Value>>,
    pub signals_updated_ns: u64,
    pub meta: BTreeMap<BlockKind, BlockMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// What the cache took, in the block's own shape: only the minute/event records that won their merge (with the
    /// `replace` flag when the block was replaced), or the block as stored. Deltas are built from this, never from
    /// the publisher's raw input (a record the cache refused must not reach the screens).
    Accepted(Value),
    Duplicate,
    /// Terminal: this item will never be taken (an older epoch, a watermark or revision behind what is held, an
    /// unknown block). Its code says which, so the publisher never parses the prose.
    Rejected(Refusal),
    /// Not yet: the item names input beyond what is committed here. The publisher keeps it and sends it again
    /// (never only a counter on B's side).
    NotYet(String),
    /// An increment of a day / flow block this state does not hold (Market Runtime restarted, a new epoch reset it):
    /// it cannot be merged; the publisher sends the block whole.
    BaseRequired(String),
}

/// Why an item is refused for good, as the publisher acts on it (the `code` of a `projection.ack` result):
/// - `STALE`: obsolete here (a watermark/revision or an epoch behind what this state holds) -- dropping it loses nothing;
/// - `EPOCH_BEHIND`: the cache holds a newer projection epoch (`held_epoch`) -- the publisher must move above it;
/// - `UNKNOWN_BLOCK`: a contract disagreement between the two builds.
/// Server-side refusals add `IDENTITY_REQUIRED` (contract) and `ROLLED_OVER` (obsolete).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub reason: String,
    pub held_epoch: Option<u64>,
}

impl Refusal {
    pub fn new(code: &'static str, reason: String) -> Self {
        Self { code, reason, held_epoch: None }
    }

    /// The `projection.ack` result of this refusal.
    pub fn wire(&self) -> Value {
        let mut out = json!({"ok": false, "code": self.code, "reason": self.reason});
        if let Some(epoch) = self.held_epoch {
            out["held_epoch"] = json!(epoch);
        }
        out
    }
}

#[derive(Debug, Default)]
pub struct ProjectionCache {
    entries: HashMap<StateKey, ProjectionEntry>,
    /// What Rust B last reported about itself (LIVE / CATCHING_UP, cursor, lag, where its catch-up started), in
    /// `stats()`. It is not part of any view snapshot -- each block's own meta (`meta_wire`) says whether that block is
    /// there and from which epoch; a global `analysis_status` in every view snapshot would be a second "truth" that a
    /// reset overwrites with RECOVERING while the blocks say otherwise. Viewers get B's rebuild progress as its own
    /// connection message instead (server/analysis_state.rs).
    pub analysis_reported: Value,
    /// The B session whose report that is (None once it ended).
    pub analysis_reporter: Option<u64>,
    /// The state viewers were last told (server/analysis_state.rs pushes on a change).
    pub analysis_shown_state: Option<String>,
    /// The last projection reset (epoch and B's reason), for diagnostics.
    last_reset: Option<String>,
    pub analysis_epoch: u64,
    /// Keys whose blocks a publish of a newer epoch invalidated, with the blocks each held that the new epoch has not
    /// replaced yet. The publisher drains them after each message (`take_unreplaced`): a key whose every block that
    /// message replaced (a full publish: whole blocks, record blocks with `replace`) needs nothing more -- its views got
    /// the new epoch's blocks as deltas; the others are re-snapshotted, exactly as after a `projection.reset` (a view
    /// would otherwise keep an old block the new epoch never sends again).
    invalidated_by_publish: HashMap<StateKey, BTreeSet<BlockKind>>,
    pub accepted: u64,
    pub rejected: u64,
    pub duplicates: u64,
    /// Increments refused because the block they extend was not held (Verdict::BaseRequired).
    pub base_required: u64,
    pub last_reject: Option<String>,
    /// Events pushed out of a full per-symbol tape (`EVENT_CAPACITY`), never silently (user rule): the
    /// count and the symbol it last happened to are shown in 連線診斷.
    pub events_evicted: u64,
    pub last_evicted: Option<String>,
}

fn record_revision(record: &Value) -> u64 {
    record.get("revision").and_then(Value::as_u64).unwrap_or(0)
}

impl ProjectionCache {
    pub fn entry(&self, key: &StateKey) -> Option<&ProjectionEntry> {
        self.entries.get(key)
    }

    /// Every cached signal row (model predictions and the producer's fields), for `signals.snapshot`.
    pub fn signal_rows(&self) -> Vec<(StateKey, Map<String, Value>)> {
        self.entries.iter().filter_map(|(k, e)| e.signals.clone().map(|s| (k.clone(), s))).collect()
    }

    /// The cross-symbol event tape (事件列表): every cached event of the `market`/`session`/`trading_date`
    /// family, the symbol's identity filled in, newest first by trigger minute then `as_of_ns`, at most `limit`.
    /// Only the `limit` newest are copied: the family is ranked by reference, then the winners are cloned.
    pub fn event_tape(&self, market: &str, session: &str, trading_date: &str, limit: usize) -> Vec<Value> {
        let mut rows: Vec<((i64, u64), &StateKey, &Value)> = Vec::new();
        for (key, entry) in &self.entries {
            if !key.instrument.market.eq_ignore_ascii_case(market) || !key.session.session.eq_ignore_ascii_case(session)
                || key.session.trading_date != trading_date {
                continue;
            }
            for event in &entry.events {
                let minute = event.get("trigger_minute").and_then(Value::as_i64).unwrap_or(-1);
                let as_of = event.get("as_of_ns").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
                rows.push(((minute, as_of), key, event));
            }
        }
        let newest_first = |a: &((i64, u64), &StateKey, &Value), b: &((i64, u64), &StateKey, &Value)| b.0.cmp(&a.0);
        if rows.len() > limit && limit > 0 {
            rows.select_nth_unstable_by(limit - 1, newest_first);
        }
        rows.truncate(limit);
        rows.sort_by(newest_first);
        rows.into_iter().map(|(_, key, event)| {
            let mut event = event.clone();
            if let Some(obj) = event.as_object_mut() {
                for (field, value) in [("source", &key.instrument.source), ("market", &key.instrument.market),
                                       ("code", &key.instrument.code), ("trading_date", &key.session.trading_date),
                                       ("session", &key.session.session)] {
                    obj.entry(field).or_insert_with(|| json!(value));
                }
            }
            event
        }).collect()
    }

    /// Drops every cached entry whose key `gone` says left (a session rollover); returns those keys.
    pub fn remove_where(&mut self, gone: impl Fn(&StateKey) -> bool) -> Vec<StateKey> {
        let keys: Vec<StateKey> = self.entries.keys().filter(|k| gone(k)).cloned().collect();
        for key in &keys {
            self.entries.remove(key);
        }
        keys
    }

    /// A projection reset: every block of an older epoch stops being served at once.
    /// Rust B's blocks are dropped -- the producer's signals stay -- and the keys that lost blocks are returned so
    /// their views can be re-snapshotted; a block is RECOVERING until the new epoch republishes it. Before, the
    /// reset only set a status field and snapshots kept serving the old blocks.
    pub fn reset(&mut self, epoch: u64, reason: &str) -> Vec<StateKey> {
        self.reset_blocks(epoch, reason).into_iter().map(|(key, _)| key).collect()
    }

    /// `reset`, returning with each key the blocks it lost.
    fn reset_blocks(&mut self, epoch: u64, reason: &str) -> Vec<(StateKey, BTreeSet<BlockKind>)> {
        self.analysis_epoch = self.analysis_epoch.max(epoch);
        self.last_reset = Some(format!("epoch {epoch}: {reason}"));
        let mut invalidated = Vec::new();
        for (key, entry) in self.entries.iter_mut() {
            if entry.epoch < self.analysis_epoch && !entry.meta.is_empty() {
                let blocks = entry.meta.keys().copied().collect();
                let signals = entry.signals.take();
                let signals_updated_ns = entry.signals_updated_ns;
                *entry = ProjectionEntry { epoch: self.analysis_epoch, signals, signals_updated_ns, ..Default::default() };
                invalidated.push((key.clone(), blocks));
            }
        }
        invalidated
    }

    /// The keys a newer epoch invalidated whose views still hold a block it has not replaced (drained).
    pub fn take_unreplaced(&mut self) -> Vec<StateKey> {
        self.invalidated_by_publish.drain().filter(|(_, blocks)| !blocks.is_empty()).map(|(key, _)| key).collect()
    }

    fn reject(&mut self, refusal: Refusal) -> Verdict {
        self.rejected += 1;
        self.last_reject = Some(refusal.reason.clone());
        Verdict::Rejected(refusal)
    }

    /// Count and keep a refusal decided before the cache was asked (the item's identity, a rollover, a malformed item).
    pub fn refuse(&mut self, refusal: Refusal) -> Verdict {
        self.reject(refusal)
    }

    /// Merge one validated block for one state.
    pub fn publish(&mut self, request: PublishRequest, committed: u64, now_ns: u64) -> Verdict {
        let PublishRequest { key, block, epoch, watermark, revision, data, meta } = request;
        if watermark > committed {
            self.rejected += 1;
            let why = format!("input_watermark {watermark} is beyond the committed stream {committed}");
            self.last_reject = Some(why.clone());
            return Verdict::NotYet(why);
        }
        if epoch < self.analysis_epoch {
            let held = self.analysis_epoch;
            return self.reject(Refusal { code: "EPOCH_BEHIND", reason: format!("projection epoch {epoch} is older than {held}"),
                                         held_epoch: Some(held) });
        }
        // A newer epoch accepted for one key is the epoch for all: no other key may take an older one
        // afterwards, and every block an older epoch published stops being served at once -- B may never republish
        // a key it no longer holds, so waiting for the new epoch to reach each key would leave old blocks up.
        if epoch > self.analysis_epoch {
            let invalidated = self.reset_blocks(epoch, "a newer projection epoch was published");
            self.invalidated_by_publish.extend(invalidated);
        }
        let entry = self.entries.entry(key.clone()).or_default();
        if epoch < entry.epoch {
            let held = entry.epoch;
            return self.reject(Refusal::new("STALE", format!("stale epoch {epoch} < {held}")));
        }
        if epoch > entry.epoch {
            // A new projection epoch replaces everything B said before; signals belong to the producer and stay.
            let signals = entry.signals.take();
            let signals_updated_ns = entry.signals_updated_ns;
            *entry = ProjectionEntry { epoch, signals, signals_updated_ns, ..Default::default() };
        }
        let record_block = matches!(block, BlockKind::Minutes | BlockKind::Events);
        // Minutes and events merge record by record (each with its own revision), so an equal watermark may still
        // carry newer records; the block's own meta only ever moves forward.
        let meta_advances = entry.meta.get(&block).is_none_or(|current| (watermark, revision) > (current.input_watermark, current.revision));
        if let Some(current) = entry.meta.get(&block) {
            if watermark < current.input_watermark || (watermark == current.input_watermark && revision <= current.revision && !record_block) {
                if watermark == current.input_watermark && revision == current.revision {
                    self.duplicates += 1;
                    return Verdict::Duplicate;
                }
                return self.reject(Refusal::new("STALE", format!("{}: stale watermark or revision", block.name())));
            }
        }
        let mut changed = false;
        let mut evicted = 0u64;
        let replaces = match &data {
            BlockData::Minutes { replace, .. } | BlockData::Events { replace, .. } => *replace,
            BlockData::Whole(_) => true,
            BlockData::Increment(_) => false,
        };
        if matches!(data, BlockData::Increment(_)) {
            let held = match block {
                BlockKind::Day => &entry.day,
                _ => &entry.flow,
            };
            if !held.is_object() {
                self.base_required += 1;
                let why = format!("{}: an increment of a block not held", block.name());
                self.last_reject = Some(why.clone());
                return Verdict::BaseRequired(why);
            }
        }
        if replaces {
            if let Some(held) = self.invalidated_by_publish.get_mut(&key) {
                held.remove(&block);
            }
        }
        let delivered = match data {
            BlockData::Minutes { records, replace } => {
                if replace {
                    entry.minutes.clear();
                    changed = true;
                }
                let mut taken = Vec::new();
                for (minute, record_rev, record) in records {
                    let text = record.to_string().into_boxed_str();
                    if entry.minutes.newer(minute, record_rev, &text) {
                        taken.push(record.clone());
                        entry.minutes.insert_text(minute, record, text);
                        changed = true;
                    }
                }
                json!({"minutes": taken, "replace": replace})
            }
            BlockData::Events { records, replace } => {
                if replace {
                    entry.events.clear();
                    changed = true;
                }
                let mut taken = Vec::new();
                for (id, record_rev, record) in records {
                    match entry.events.iter().position(|e| e.get("event_id").and_then(Value::as_str) == Some(&id)) {
                        Some(i) if record_rev > record_revision(&entry.events[i]) => {
                            taken.push(record.clone());
                            entry.events[i] = record;
                            changed = true;
                        }
                        Some(_) => {}
                        None => {
                            if entry.events.len() >= EVENT_CAPACITY {
                                entry.events.pop_front();
                                evicted += 1;
                            }
                            taken.push(record.clone());
                            entry.events.push_back(record);
                            changed = true;
                        }
                    }
                }
                json!({"events": taken, "replace": replace})
            }
            BlockData::Whole(value) => {
                match block {
                    BlockKind::Windows => entry.windows = value.clone(),
                    BlockKind::Day => entry.day = Held::of(&value),
                    BlockKind::Flow => entry.flow = Held::of(&value),
                    BlockKind::Minutes | BlockKind::Events => unreachable!("record blocks parse as BlockData::Minutes/Events"),
                }
                changed = true;
                value
            }
            BlockData::Increment(value) => {
                let slot = match block {
                    BlockKind::Day => &mut entry.day,
                    _ => &mut entry.flow,
                };
                let mut held = slot.value();
                merge_increment(block, &mut held, &value);
                *slot = Held::of(&held);
                changed = true;
                // Delivered as it came: the screens merge the same increment into the block they hold.
                value
            }
        };
        if meta_advances {
            entry.meta.insert(block, BlockMeta {
                projection_epoch: epoch, input_watermark: watermark, revision,
                as_of: meta.as_of, config_version: meta.config_version, completeness: meta.completeness, updated_at_ns: now_ns,
            });
        }
        if evicted > 0 {
            self.events_evicted += evicted;
            self.last_evicted = Some(format!("{}:{}:{} {} {}", key.instrument.source, key.instrument.market, key.instrument.code,
                                             key.session.trading_date, key.session.session));
        }
        if changed {
            self.accepted += 1;
            Verdict::Accepted(delivered)
        } else {
            self.duplicates += 1;
            Verdict::Duplicate
        }
    }

    /// Merge one producer-validated signals row: a field left out is "no new value"; model predictions merge entry
    /// by entry so one horizon never erases another; an explicit null status/probability clears only that entry.
    pub fn merge_signals(&mut self, key: StateKey, row: &Map<String, Value>, now_ns: u64) {
        let entry = self.entries.entry(key).or_default();
        let current = entry.signals.get_or_insert_with(Map::new);
        for (field, value) in row {
            if field == "model_predictions" {
                let Some(incoming) = value.as_object() else { continue };
                let slot = current.entry("model_predictions").or_insert_with(|| Value::Object(Map::new()));
                if let Some(entries) = slot.as_object_mut() {
                    for (k, v) in incoming {
                        if entries.contains_key(k) || entries.len() < MODEL_ENTRY_CAPACITY {
                            entries.insert(k.clone(), v.clone());
                        }
                    }
                }
            } else if field == "volume_compare_minute" && !value.is_null() {
                // 量變 is one fact with the minute it describes: naming the minute replaces the pair.
                current.insert(field.clone(), value.clone());
                current.insert("volume_change_pct".into(), row.get("volume_change_pct").cloned().unwrap_or(Value::Null));
            } else if field == "volume_change_pct" && row.contains_key("volume_compare_minute") {
            } else if !value.is_null() {
                current.insert(field.clone(), value.clone());
            }
        }
        entry.signals_updated_ns = now_ns;
    }

    /// A replay's analysis block as its timeline holds it at the replay's step (timeline::body_of): it replaces the
    /// entry's block whole -- the timeline is the analysis there, nothing is merged or validated against what was held.
    /// `event_order`: the order an events block's records were first shown in.
    pub fn set_timeline_block(&mut self, key: StateKey, block: &str, body: &Value, event_order: &[String], now_ns: u64) {
        let entry = self.entries.entry(key).or_default();
        let data = &body["data"];
        match block {
            "minutes" => {
                entry.minutes.clear();
                for record in data["minutes"].as_object().into_iter().flatten().map(|(_, r)| r) {
                    if let Some(minute) = record["minute"].as_i64().and_then(|m| i32::try_from(m).ok()) {
                        entry.minutes.insert(minute, record.clone());
                    }
                }
            }
            "events" => {
                let records = data["events"].as_object();
                entry.events = event_order.iter().filter_map(|id| records.and_then(|r| r.get(id)).cloned()).collect();
                while entry.events.len() > EVENT_CAPACITY {
                    entry.events.pop_front();
                }
            }
            "windows" => entry.windows = data.clone(),
            "day" => entry.day = Held::of(data),
            "flow" => entry.flow = Held::of(&crate::timeline::flow_unkeyed(data)),
            "signals" => {
                entry.signals = data.as_object().cloned();
                entry.signals_updated_ns = now_ns;
                return;
            }
            _ => return,
        }
        if let Some(kind) = BlockKind::parse(block) {
            let watermark = body["input_watermark"].as_u64().unwrap_or(0);
            entry.meta.insert(kind, BlockMeta { projection_epoch: 0, input_watermark: watermark, revision: watermark, as_of: body["as_of"].clone(),
                config_version: body["config_version"].clone(), completeness: body["completeness"].clone(), updated_at_ns: now_ns });
        }
    }

    /// A replay's analysis is not held at its step: every block and every signal row goes (its views say RECOVERING,
    /// the page 計算中), never another step's.
    pub fn clear_analysis(&mut self) {
        for entry in self.entries.values_mut() {
            *entry = ProjectionEntry::default();
        }
    }

    pub fn minutes_wire(entry: &ProjectionEntry) -> Vec<Value> {
        entry.minutes.values().collect()
    }

    pub fn meta_wire(entry: Option<&ProjectionEntry>) -> Value {
        let mut out = Map::new();
        for block in BlockKind::ALL {
            let value = entry.and_then(|e| e.meta.get(&block)).map(BlockMeta::wire)
                .unwrap_or_else(|| json!({"completeness": "RECOVERING", "reason": "no result from analysis_runtime yet"}));
            out.insert(block.name().to_string(), value);
        }
        Value::Object(out)
    }

    pub fn stats(&self) -> Value {
        json!({"entries": self.entries.len(), "accepted": self.accepted, "rejected": self.rejected, "duplicates": self.duplicates, "base_required": self.base_required,
               "last_reject": self.last_reject, "analysis_reported": self.analysis_reported, "last_reset": self.last_reset, "analysis_epoch": self.analysis_epoch,
               "event_capacity": EVENT_CAPACITY, "events_evicted": self.events_evicted, "last_evicted": self.last_evicted})
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{InstrumentKey, SessionKey};

    fn key() -> StateKey {
        StateKey { instrument: InstrumentKey::new("shioaji", "STK", "2330"), session: SessionKey { trading_date: "2026-09-29".into(), session: "DAY".into() } }
    }
    fn m(minute: i32, close: i64, revision: u64, state: &str) -> Value {
        json!({"minute": minute, "close": close, "revision": revision, "state": state})
    }

    /// Held as text, a minute record and a block read back as what was published, the newest minute included
    /// whatever order the minutes came in.
    #[test]
    fn held_minutes_and_blocks_read_back_as_published() {
        let mut minutes = Minutes::default();
        minutes.insert(571, m(571, 101, 1, "FORMING"));
        minutes.insert(570, m(570, 100, 2, "FINALIZED"));
        assert_eq!(minutes.get(571).as_deref(), Some(&m(571, 101, 1, "FORMING")), "the newest, held decoded");
        assert_eq!(minutes.get(570).as_deref(), Some(&m(570, 100, 2, "FINALIZED")), "an older one, decoded from its text");
        assert_eq!(minutes.values().collect::<Vec<_>>(), vec![m(570, 100, 2, "FINALIZED"), m(571, 101, 1, "FORMING")]);
        assert!(minutes.newer(571, 1, &m(571, 102, 1, "FORMING").to_string()), "a forming minute published again with other figures");
        assert!(!minutes.newer(571, 1, &m(571, 101, 1, "FORMING").to_string()), "the same record again");
        assert!(!minutes.newer(570, 2, &m(570, 99, 2, "FINALIZED").to_string()), "a finalized minute at its own revision stays");
        minutes.clear();
        assert!(minutes.get(571).is_none() && minutes.is_empty());

        let block = json!({"price_volume": {"buckets": [{"price": 100.5, "volume": 0.25}]}, "close": 1e-7, "list": [1, null, "x"]});
        assert_eq!(Held::of(&block).value(), block);
        assert!(Held::of(&block).is_object() && Held::of(&Value::Null).is_null() && !Held::of(&json!([1])).is_object());
    }
    /// One publish as `projection.publish` carries it.
    #[allow(clippy::too_many_arguments)]
    fn publish(cache: &mut ProjectionCache, key: StateKey, block: &str, epoch: u64, watermark: u64, revision: u64, committed: u64,
               data: &Value) -> Verdict {
        let item = json!({"block": block, "input_watermark": watermark, "revision": revision, "data": data});
        match PublishRequest::from_item(key, epoch, &item) {
            Ok(request) => cache.publish(request, committed, 1),
            Err(refusal) => cache.refuse(refusal),
        }
    }

    #[test]
    fn day_and_flow_increments_merge_into_the_block_held_and_need_one() {
        // A live day / flow item names only what changed after the first: its keyed rows merge into the held block,
        // which then reads as the whole block would; with nothing held it is refused for the whole one.
        let mut cache = ProjectionCache::default();
        let flow_inc = json!({"replace": false, "header_total": 7, "minuteSeries": [{"minute": 602, "cumulative": 7}]});
        assert!(matches!(publish(&mut cache, key(), "flow", 1, 10, 1, 10, &flow_inc), Verdict::BaseRequired(_)), "no base, no merge");
        let whole = json!({"replace": true, "header_total": 5, "minuteSeries": [{"minute": 600, "cumulative": 1}, {"minute": 601, "cumulative": 5}],
                           "largeOrders": [{"durable_sequence": 3}]});
        assert!(matches!(publish(&mut cache, key(), "flow", 1, 10, 2, 10, &whole), Verdict::Accepted(_)));
        let inc = json!({"replace": false, "header_total": 9, "minuteSeries": [{"minute": 601, "cumulative": 6}, {"minute": 602, "cumulative": 9}]});
        match publish(&mut cache, key(), "flow", 1, 11, 3, 11, &inc) {
            Verdict::Accepted(delivered) => assert_eq!(delivered, inc, "the screens get the increment as it came"),
            other => panic!("{other:?}"),
        }
        let flow = &cache.entry(&key()).unwrap().flow.value();
        assert_eq!(flow["header_total"], json!(9));
        assert_eq!(flow["minuteSeries"], json!([{"minute": 600, "cumulative": 1}, {"minute": 601, "cumulative": 6}, {"minute": 602, "cumulative": 9}]));
        assert_eq!(flow["largeOrders"], json!([{"durable_sequence": 3}]), "a list left out is unchanged");
        assert_eq!(flow["replace"], json!(true), "the held block keeps the whole item's own fields");

        let day = json!({"replace": true, "volume": 5, "fixed_k": {"k5": [{"start_minute": 600, "close": 1}]},
                         "price_volume": {"out_volume": 5, "buckets": [{"price": 100.0, "volume": 2}, {"price": 102.0, "volume": 3}]}});
        assert!(matches!(publish(&mut cache, key(), "day", 1, 10, 1, 10, &day), Verdict::Accepted(_)));
        let day_inc = json!({"replace": false, "volume": 8, "fixed_k": {"k5": [{"start_minute": 600, "close": 2}, {"start_minute": 605, "close": 3}]},
                             "price_volume": {"out_volume": 8, "buckets": [{"price": 101.0, "volume": 3}]}});
        assert!(matches!(publish(&mut cache, key(), "day", 1, 11, 2, 11, &day_inc), Verdict::Accepted(_)));
        let day = &cache.entry(&key()).unwrap().day.value();
        assert_eq!(day["fixed_k"]["k5"], json!([{"start_minute": 600, "close": 2}, {"start_minute": 605, "close": 3}]));
        assert_eq!(day["price_volume"]["buckets"].as_array().unwrap().iter().map(|b| b["price"].as_f64().unwrap()).collect::<Vec<_>>(),
                   vec![100.0, 101.0, 102.0], "rows by price, in price order");
        assert_eq!((day["volume"].clone(), day["price_volume"]["out_volume"].clone()), (json!(8), json!(8)));
    }

    #[test]
    fn entries_leave_when_the_rollover_cutoff_names_them_and_not_by_calendar_days() {
        // The one owner of retention is the cutoff (server.rs roll_over removes what is gone), never a rule of the
        // cache's own (such as "more than 3 calendar days behind its newest date") beside A's rollover and B's.
        let mut cache = ProjectionCache::default();
        let at = |date: &str| StateKey { instrument: InstrumentKey::new("shioaji", "STK", "2330"),
            session: SessionKey { trading_date: date.into(), session: "DAY".into() } };
        for date in ["2026-09-24", "2026-09-29", "2026-09-30"] {
            assert!(matches!(publish(&mut cache, at(date), "windows", 1, 1, 1, 100, &json!({"w": 1})), Verdict::Accepted(_)));
        }
        let mut engine = crate::state::Engine::default();
        assert!(cache.remove_where(|k| engine.is_gone(k)).is_empty(), "six days old, and no cutoff names it: kept");
        engine.rollover(&std::collections::BTreeMap::from([("shioaji|STK|DAY".to_string(), "2026-09-30".to_string())]));
        let mut gone: Vec<String> = cache.remove_where(|k| engine.is_gone(k)).into_iter().map(|k| k.session.trading_date).collect();
        gone.sort();
        assert_eq!(gone, vec!["2026-09-24", "2026-09-29"]);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn the_delta_carries_only_what_the_cache_took() {
        // A minute the cache refused (an older revision) still reached the screens in the delta.
        let mut cache = ProjectionCache::default();
        publish(&mut cache, key(), "minutes", 1, 10, 1, 100, &json!({"minutes": [m(570, 100, 3, "FINALIZED")]}));
        let data = json!({"minutes": [m(570, 999, 2, "FINALIZED"), m(571, 101, 1, "FINALIZED")]});
        let Verdict::Accepted(delivered) = publish(&mut cache, key(), "minutes", 1, 11, 1, 100, &data) else { panic!("accepted") };
        assert_eq!(delivered["minutes"].as_array().unwrap().iter().map(|r| r["minute"].as_i64().unwrap()).collect::<Vec<_>>(), vec![571]);
        assert_eq!(cache.entry(&key()).unwrap().minutes.get(570).unwrap()["close"], 100);
    }

    #[test]
    fn a_newer_epoch_on_one_key_is_the_epoch_for_every_key() {
        // A newer epoch on one key is the epoch for every key.
        let mut cache = ProjectionCache::default();
        let other = StateKey { instrument: InstrumentKey::new("shioaji", "STK", "2317"), session: key().session };
        assert!(matches!(publish(&mut cache, key(), "windows", 5, 1, 1, 100, &json!({"w": 1})), Verdict::Accepted(_)));
        assert!(matches!(publish(&mut cache, other, "windows", 4, 1, 1, 100, &json!({"w": 1})), Verdict::Rejected(_)));
    }

    #[test]
    fn a_newer_epoch_on_one_key_stops_serving_every_older_block() {
        // Only the published key was replaced; another key's old-epoch blocks stayed up -- forever if the new
        // epoch never publishes it again.
        let mut cache = ProjectionCache::default();
        let other = StateKey { instrument: InstrumentKey::new("shioaji", "STK", "2317"), session: key().session };
        publish(&mut cache, key(), "windows", 4, 1, 1, 100, &json!({"w": 1}));
        publish(&mut cache, other.clone(), "windows", 4, 1, 1, 100, &json!({"w": 1}));
        assert!(cache.take_unreplaced().is_empty(), "the first epoch invalidates nothing");
        assert!(matches!(publish(&mut cache, key(), "windows", 5, 2, 1, 100, &json!({"w": 2})), Verdict::Accepted(_)));
        let entry = cache.entry(&other).unwrap();
        assert!(entry.windows.is_null() && entry.meta.is_empty(), "the other key's epoch-4 block is no longer served");
        assert_eq!(cache.take_unreplaced(), vec![other], "the other key's views re-snapshot; the published key got its block as a delta");
        assert_eq!(cache.entry(&key()).unwrap().windows, json!({"w": 2}));
    }

    #[test]
    fn a_new_epoch_that_replaces_every_block_a_key_held_needs_no_re_snapshot() {
        // Each seek of a replay is a new epoch: B's full publish replaced every block and its deltas carried them, and
        // the views were still re-snapshotted -- the whole view sent a second time per seek.
        let mut cache = ProjectionCache::default();
        let minutes = json!({"minutes": [m(570, 100, 1, "FINALIZED")]});
        let events = json!({"events": [{"event_id": "a", "revision": 1}]});
        publish(&mut cache, key(), "minutes", 1, 10, 1, 100, &minutes);
        publish(&mut cache, key(), "events", 1, 10, 1, 100, &events);
        publish(&mut cache, key(), "flow", 1, 10, 1, 100, &json!({"f": 1}));
        let replace = |data: &Value| { let mut d = data.clone(); d["replace"] = json!(true); d };
        // Minutes and events of the new epoch that do not replace leave the old records on the views.
        publish(&mut cache, key(), "minutes", 2, 11, 1, 100, &minutes);
        publish(&mut cache, key(), "events", 2, 11, 1, 100, &replace(&events));
        publish(&mut cache, key(), "flow", 2, 11, 1, 100, &json!({"f": 2}));
        assert_eq!(cache.take_unreplaced(), vec![key()], "minutes did not replace: re-snapshot");
        // A full publish (record blocks replace, whole blocks always do).
        publish(&mut cache, key(), "minutes", 3, 12, 1, 100, &replace(&minutes));
        publish(&mut cache, key(), "events", 3, 12, 1, 100, &replace(&events));
        assert_eq!(cache.take_unreplaced(), vec![key()], "the flow it held is not replaced yet");
        publish(&mut cache, key(), "minutes", 4, 13, 1, 100, &replace(&minutes));
        publish(&mut cache, key(), "events", 4, 13, 1, 100, &replace(&events));
        publish(&mut cache, key(), "flow", 4, 13, 1, 100, &json!({"f": 4}));
        assert!(cache.take_unreplaced().is_empty(), "every block it held was replaced in the message");
    }

    #[test]
    fn block_meta_never_moves_back_to_a_lower_revision() {
        // Minutes/events of the same watermark and a lower revision overwrote the block meta.
        let mut cache = ProjectionCache::default();
        publish(&mut cache, key(), "events", 1, 10, 5, 100, &json!({"events": [{"event_id": "a", "revision": 1}]}));
        publish(&mut cache, key(), "events", 1, 10, 3, 100, &json!({"events": [{"event_id": "b", "revision": 1}]}));
        let entry = cache.entry(&key()).unwrap();
        assert_eq!(entry.events.len(), 2, "the new record is still merged");
        assert_eq!(entry.meta[&BlockKind::Events].revision, 5);
    }

    #[test]
    fn a_reset_stops_serving_the_old_epoch_at_once_and_keeps_the_signals() {
        // A reset must stop serving the old blocks, not set a status field while snapshots keep them.
        let mut cache = ProjectionCache::default();
        publish(&mut cache, key(), "windows", 1, 10, 1, 100, &json!({"w": 1}));
        let mut signals = Map::new();
        signals.insert("volume_change_pct".into(), json!(12.5));
        cache.merge_signals(key(), &signals, 1);
        let invalidated = cache.reset(2, "flow rules changed");
        assert_eq!(invalidated, vec![key()]);
        let entry = cache.entry(&key()).unwrap();
        assert!(entry.windows.is_null() && entry.meta.is_empty(), "nothing of epoch 1 is served");
        assert_eq!(entry.signals.as_ref().unwrap()["volume_change_pct"], 12.5, "the producer's signals stay");
        assert!(matches!(publish(&mut cache, key(), "windows", 1, 11, 1, 100, &json!({"w": 2})), Verdict::Rejected(_)));
        assert!(cache.reset(2, "again").is_empty(), "an entry already of the new epoch is not invalidated twice");
    }

    #[test]
    fn stale_epochs_watermarks_and_future_watermarks_are_refused() {
        let mut cache = ProjectionCache::default();
        let data = json!({"minutes": [m(570, 100, 1, "FINALIZED")]});
        assert!(matches!(publish(&mut cache, key(), "minutes", 2, 50, 1, 100, &data), Verdict::Accepted(_)));
        assert!(matches!(publish(&mut cache, key(), "minutes", 1, 60, 1, 100, &data), Verdict::Rejected(_)));
        assert!(matches!(publish(&mut cache, key(), "minutes", 2, 40, 1, 100, &data), Verdict::Rejected(_)));
        assert!(matches!(publish(&mut cache, key(), "minutes", 2, 101, 1, 100, &data), Verdict::NotYet(_)));
        assert!(matches!(publish(&mut cache, key(), "windows", 2, 50, 1, 100, &json!({"w": 1})), Verdict::Accepted(_)));
        assert_eq!(publish(&mut cache, key(), "windows", 2, 50, 1, 100, &json!({"w": 1})), Verdict::Duplicate);
    }

    #[test]
    fn a_minute_correction_replaces_only_that_minute_and_an_old_revision_cannot_overwrite() {
        let mut cache = ProjectionCache::default();
        publish(&mut cache, key(), "minutes", 1, 10, 1, 100, &json!({"minutes": [m(570, 100, 1, "FINALIZED"), m(571, 101, 1, "FINALIZED")]}));
        publish(&mut cache, key(), "minutes", 1, 20, 2, 100, &json!({"minutes": [m(570, 99, 2, "FINALIZED")]}));
        publish(&mut cache, key(), "minutes", 1, 21, 3, 100, &json!({"minutes": [m(570, 50, 1, "FINALIZED")]}));
        let entry = cache.entry(&key()).unwrap();
        assert_eq!(entry.minutes.get(570).unwrap()["close"], 99);
        assert_eq!(entry.minutes.get(571).unwrap()["close"], 101);
    }

    #[test]
    fn a_new_epoch_replaces_b_blocks_but_keeps_producer_signals() {
        let mut cache = ProjectionCache::default();
        publish(&mut cache, key(), "day", 1, 10, 1, 100, &json!({"v": 1}));
        cache.merge_signals(key(), json!({"model_predictions": {"3m_up": {"probability": 0.6}}}).as_object().unwrap(), 1);
        publish(&mut cache, key(), "minutes", 2, 5, 1, 100, &json!({"minutes": [m(600, 1, 1, "FORMING")]}));
        let entry = cache.entry(&key()).unwrap();
        assert!(entry.day.is_null(), "an epoch change drops the old epoch's blocks");
        assert!(entry.signals.is_some());
    }

    #[test]
    fn signals_merge_entry_by_entry_and_volume_pair_replaces_together() {
        let mut cache = ProjectionCache::default();
        let row = |v: Value| v.as_object().unwrap().clone();
        cache.merge_signals(key(), &row(json!({"volume_change_pct": 12.0, "volume_compare_minute": 629,
            "model_predictions": {"3m_up": {"probability": 0.6, "status": "OK"}, "5m_up": {"probability": 0.55}}})), 1);
        cache.merge_signals(key(), &row(json!({"volume_change_pct": null, "volume_compare_minute": 630,
            "model_predictions": {"3m_up": {"probability": null, "status": "UNAVAILABLE"}}})), 2);
        let s = cache.entry(&key()).unwrap().signals.clone().unwrap();
        assert_eq!(s["volume_compare_minute"], 630);
        assert!(s["volume_change_pct"].is_null());
        assert_eq!(s["model_predictions"]["3m_up"]["status"], "UNAVAILABLE");
        assert_eq!(s["model_predictions"]["5m_up"]["probability"], 0.55);
    }

    #[test]
    fn events_update_by_id_and_stay_bounded() {
        let mut cache = ProjectionCache::default();
        for i in 0..(EVENT_CAPACITY + 10) {
            publish(&mut cache, key(), "events", 1, i as u64 + 1, 1, 10_000, &json!({"events": [{"event_id": format!("e{i}"), "revision": 1}]}));
        }
        publish(&mut cache, key(), "events", 1, 10_000, 1, 10_000, &json!({"events": [{"event_id": "e209", "revision": 2, "state": "REVOKED"}]}));
        let entry = cache.entry(&key()).unwrap();
        assert_eq!(entry.events.len(), EVENT_CAPACITY);
        assert_eq!(entry.events.back().unwrap()["state"], "REVOKED");
        // The overflow is counted, never silent (user rule); a revision of a held event is not an eviction.
        assert_eq!(cache.events_evicted, 10);
        assert_eq!(cache.last_evicted.as_deref(), Some("shioaji:STK:2330 2026-09-29 DAY"));
        assert_eq!(cache.stats()["events_evicted"], 10);
    }

    #[test]
    fn the_event_tape_merges_symbols_of_one_session_newest_first() {
        let mut cache = ProjectionCache::default();
        let at = |code: &str, date: &str, session: &str| StateKey { instrument: InstrumentKey::new("shioaji", "STK", code),
            session: SessionKey { trading_date: date.into(), session: session.into() } };
        let ev = |id: &str, minute: i64, as_of: &str| json!({"event_id": id, "revision": 1, "trigger_minute": minute, "as_of_ns": as_of});
        publish(&mut cache, at("2330", "2026-10-05", "DAY"), "events", 1, 1, 1, 100, &json!({"events": [ev("a", 540, "1"), ev("b", 600, "5")]}));
        publish(&mut cache, at("2317", "2026-10-05", "DAY"), "events", 1, 2, 1, 100, &json!({"events": [ev("c", 600, "9"), ev("d", 545, "2")]}));
        publish(&mut cache, at("2317", "2026-10-02", "DAY"), "events", 1, 3, 1, 100, &json!({"events": [ev("old", 700, "1")]}));
        let tape = cache.event_tape("STK", "DAY", "2026-10-05", 10);
        let ids: Vec<&str> = tape.iter().map(|e| e["event_id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["c", "b", "d", "a"], "another trading date is not this tape's");
        assert_eq!(tape[0]["code"], "2317", "the symbol identity is filled in");
        assert_eq!(tape[0]["trading_date"], "2026-10-05");
        assert_eq!(cache.event_tape("STK", "DAY", "2026-10-05", 2).len(), 2);
        let two: Vec<String> = cache.event_tape("STK", "DAY", "2026-10-05", 2).iter().map(|e| e["event_id"].as_str().unwrap().to_owned()).collect();
        assert_eq!(two, vec!["c", "b"], "the limit keeps the newest");
        assert!(cache.event_tape("STK", "DAY", "2026-10-05", 0).is_empty());
    }

    #[test]
    fn a_malformed_record_refuses_the_whole_item_and_changes_nothing() {
        // A minute without an integer `minute` or an event without `event_id` was skipped and the item still
        // answered ok: the publisher never learned a record had been dropped.
        let mut cache = ProjectionCache::default();
        publish(&mut cache, key(), "minutes", 1, 10, 1, 100, &json!({"minutes": [m(570, 100, 1, "FINALIZED")]}));
        for (block, data, why) in [
            ("minutes", json!({"minutes": [m(571, 1, 1, "FINALIZED"), {"minute": "572", "revision": 1}]}), "record 1 has no integer minute"),
            ("minutes", json!({"minutes": [{"minute": 573}]}), "record 0 has no unsigned integer revision"),
            ("minutes", json!({"replace": "yes", "minutes": []}), "replace must be a boolean"),
            ("minutes", json!({}), "data.minutes must be an array"),
            ("events", json!({"events": [{"event_id": "", "revision": 1}]}), "record 0 has no event_id"),
            ("events", json!({"events": [{"revision": 1}]}), "record 0 has no event_id"),
        ] {
            let Verdict::Rejected(refusal) = publish(&mut cache, key(), block, 1, 20, 2, 100, &data) else { panic!("{data} must be refused") };
            assert_eq!(refusal.code, "MALFORMED_RECORD");
            assert!(refusal.reason.contains(why), "{} names {why}", refusal.reason);
        }
        let entry = cache.entry(&key()).unwrap();
        assert_eq!(entry.minutes.keys().collect::<Vec<_>>(), vec![570], "the valid minute of a refused item was not merged either");
        assert_eq!(entry.meta[&BlockKind::Minutes].input_watermark, 10, "a refused item never moves the block meta");
        assert_eq!(cache.rejected, 6);
        assert!(cache.last_reject.as_deref().unwrap().contains("event_id"));
    }

    #[test]
    fn an_item_without_a_watermark_or_revision_is_refused_not_read_as_zero() {
        for item in [json!({"block": "windows", "revision": 1, "data": {}}), json!({"block": "windows", "input_watermark": 1, "data": {}})] {
            let refusal = PublishRequest::from_item(key(), 1, &item).unwrap_err();
            assert_eq!(refusal.code, "MALFORMED_RECORD", "{item}");
        }
        assert_eq!(PublishRequest::from_item(key(), 1, &json!({"block": "minutez", "input_watermark": 1, "revision": 1})).unwrap_err().code,
                   "UNKNOWN_BLOCK");
    }
}
