//! 歷史回放's analysis timeline: Rust B's analysis of a recorded partition at every step of it, built once by B and
//! held by Market Runtime, so a seek or a played step shows the analysis of exactly the step the replay stands on --
//! never another one (docs/system-architecture/03 section 6).
//!
//! * Steps: the recorded events in their order, and a market clock at every minute from the first market event on,
//!   each before the events of its minute -- the clock B finalizes minutes and windows by. Both sides compute them
//!   from the same recording (`steps`), so a step index means the same moment to both.
//! * Spans: the steps cut every `span_len` steps. B builds a span from its own checkpoint, on its own, so the spans
//!   near the user's position are built first and the rest later; a span is the analysis at its first step (the
//!   keyframe) and every step's change after it.
//! * A change is one field of one block of one instrument: its path (the block, then keys and indices) and its new
//!   value. The records of `minutes` and `events` are keyed by their minute and event id, so a minute that changes is
//!   one or two fields, not the whole record again; `flow`'s large prints by their durable sequence, so a new print
//!   is one row, not the newest-first list shifted by one (every row of it again).
//! * Position p is the analysis with steps `..p` applied: the keyframe of the span holding p, and that span's changes
//!   of the steps before p.

use crate::ws::{base64, unbase64};
use crate::event::{MarketEvent, Payload};
use crate::replay::{self, Partition};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

/// The blocks a timeline holds per instrument: Rust B's projection blocks and its model predictions (`signals`, the
/// row Market Runtime merges as the live producer's).
pub const BLOCKS: [&str; 6] = ["minutes", "windows", "day", "flow", "events", "signals"];

/// One step of a recording: a recorded event (its index) or the market clock of a minute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub due_ns: i64,
    pub event: Option<usize>,
}

/// The steps of a recording: its events in recorded order, and before the first event of each minute from the first
/// market event (a print, a book or a quote) on, that minute's clock. `due` is each event's due time
/// (`replay::due_times`), nondecreasing, so the steps are in time order too.
pub fn steps(events: &[MarketEvent], due: &[i64]) -> Vec<Step> {
    let market = |e: &MarketEvent| matches!(e.payload, Payload::Trade { .. } | Payload::OrderBook { .. } | Payload::Quote { .. });
    let mut next_clock = events.iter().position(market).map(|i| minute_start(due[i]));
    let mut out = Vec::with_capacity(events.len() + 300);
    for (index, &at) in due.iter().enumerate() {
        while let Some(clock) = next_clock.filter(|c| *c <= at) {
            out.push(Step { due_ns: clock, event: None });
            next_clock = Some(clock + 60_000_000_000);
        }
        out.push(Step { due_ns: at, event: Some(index) });
    }
    out
}

/// The start of the minute `ns` is in: every market's offset from UTC is whole hours, so its minutes start on UTC's.
pub fn minute_start(ns: i64) -> i64 {
    ns.div_euclid(60_000_000_000) * 60_000_000_000
}

/// The event a step applies: the recorded event, or the minute's clock.
pub fn step_event<'a>(partition: &Partition, events: &'a [MarketEvent], step: &Step) -> std::borrow::Cow<'a, MarketEvent> {
    match step.event {
        Some(index) => std::borrow::Cow::Borrowed(&events[index]),
        None => std::borrow::Cow::Owned(replay::clock_event(partition, "timeline", 0, step.due_ns)
            .expect("a minute of the recording's own market has a local minute")),
    }
}

/// How many steps a span holds (the replay checkpoint interval of the step count).
pub fn span_len(steps: usize) -> usize {
    replay::checkpoint_interval(steps)
}

/// The position at replay time `at_ns`: every step due by then applied.
pub fn position_at(steps: &[Step], at_ns: i64) -> usize {
    steps.partition_point(|s| s.due_ns <= at_ns)
}

/// One part of a change's path below its block.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Seg {
    Key(String),
    Index(u32),
}

impl Seg {
    fn wire(&self) -> Value {
        match self {
            Seg::Key(k) => json!(k),
            Seg::Index(i) => json!(i),
        }
    }

    fn parse(v: &Value) -> Result<Self, String> {
        match v {
            Value::String(s) => Ok(Seg::Key(s.clone())),
            Value::Number(n) => n.as_u64().and_then(|i| u32::try_from(i).ok()).map(Seg::Index).ok_or_else(|| format!("path index {n}")),
            other => Err(format!("path segment {other}")),
        }
    }
}

/// An item's target: the instrument's identity and the block, as one text (the identity as Rust B wrote it).
pub fn target_of(identity: &Value, block: &str) -> String {
    format!("{identity}|{block}")
}

/// What a timeline keeps of one published item: everything but its identity, block and revision (a played step is
/// the revision), its record arrays keyed by record (`keyed`), and no `replace` (a keyframe is whole). The item is
/// taken, not copied: a step's items are as large as the session so far.
pub fn body_of(item: Value) -> Value {
    let Value::Object(mut body) = item else { return Value::Object(Map::new()) };
    let block = match body.remove("block") {
        Some(Value::String(s)) => s,
        _ => String::new(),
    };
    body.remove("identity");
    body.remove("revision");
    if let Some(data) = body.get_mut("data") {
        *data = keyed(&block, data.take());
    }
    Value::Object(body)
}

/// A block's data with its record array (`minutes` by minute, `events` by event id, `flow`'s `largeOrders` by durable
/// sequence) as an object keyed by record, and without `replace`.
pub fn keyed(block: &str, mut data: Value) -> Value {
    if let Some(obj) = data.as_object_mut() {
        obj.remove("replace");
    }
    let (field, key) = match block {
        "minutes" => ("minutes", "minute"),
        "events" => ("events", "event_id"),
        "flow" => ("largeOrders", "durable_sequence"),
        _ => return data,
    };
    if let Some(records) = data.get_mut(field).map(Value::take) {
        let mut by_key = Map::new();
        if let Value::Array(records) = records {
            for record in records {
                let id = match &record[key] {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                by_key.insert(id, record);
            }
        }
        data[field] = Value::Object(by_key);
    }
    data
}

/// `flow`'s data as a view shows it: its large prints (keyed by `keyed`) a list again, newest first -- the order Rust B
/// lists them in (projection.rs `flow_wire`: by durable sequence, newest first).
pub fn flow_unkeyed(data: &Value) -> Value {
    let mut out = data.clone();
    if let Some(rows) = data.get("largeOrders").and_then(Value::as_object) {
        let mut rows: Vec<&Value> = rows.values().collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row["durable_sequence"].as_u64().unwrap_or(0)));
        out["largeOrders"] = Value::Array(rows.into_iter().cloned().collect());
    }
    out
}

/// A change found by `diff`: the path and the new value, None for a field that went away (a field whose new value is
/// null is Some(Null): both read back exactly).
pub type Found = (Vec<Seg>, Option<Value>);

/// The fields of `next` that differ from `prev`. `merge`: `next` names only what changed (an increment of a record
/// block: its records object holds the records that changed, each whole), so what it leaves out stays. An array is
/// compared element by element while it only grows.
pub fn diff(prev: &Value, next: &Value, merge: bool, out: &mut Vec<Found>) {
    diff_at(prev, next, merge, &mut Vec::new(), out);
}

/// A path being walked by `diff`: borrowed, made into `Seg`s only where a change is found (a step walks every field
/// of a session-sized block and changes a few).
#[derive(Clone, Copy)]
enum At<'a> {
    Key(&'a str),
    Index(u32),
}

fn found_at(path: &[At]) -> Vec<Seg> {
    path.iter().map(|at| match at {
        At::Key(k) => Seg::Key((*k).to_string()),
        At::Index(i) => Seg::Index(*i),
    }).collect()
}

fn diff_at<'a>(prev: &'a Value, next: &'a Value, merge: bool, path: &mut Vec<At<'a>>, out: &mut Vec<Found>) {
    match (prev, next) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                path.push(At::Key(k));
                // Inside an increment the body and its data merge (data holds the records object); a record is whole.
                let inner = merge && path.len() <= 2;
                match a.get(k) {
                    Some(old) => diff_at(old, v, inner, path, out),
                    None => out.push((found_at(path), Some(v.clone()))),
                }
                path.pop();
            }
            if !merge {
                for k in a.keys().filter(|k| !b.contains_key(*k)) {
                    path.push(At::Key(k));
                    out.push((found_at(path), None));
                    path.pop();
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if !a.is_empty() && a.len() <= b.len() => {
            for (i, v) in b.iter().enumerate() {
                path.push(At::Index(i as u32));
                match a.get(i) {
                    Some(old) => diff_at(old, v, false, path, out),
                    None => out.push((found_at(path), Some(v.clone()))),
                }
                path.pop();
            }
        }
        _ if prev == next => {}
        _ => out.push((found_at(path), Some(next.clone()))),
    }
}

/// Set `value` at `path` under `root` (an object made where the path leads past one; an index one past the end
/// appends); None removes the field.
pub fn set_path(root: &mut Value, path: &[Seg], value: Option<Value>) {
    let Some((last, parents)) = path.split_last() else {
        *root = value.unwrap_or(Value::Null);
        return;
    };
    let mut at = root;
    for seg in parents {
        let index = match (seg, &*at) {
            (Seg::Index(i), Value::Array(items)) if (*i as usize) < items.len() => Some(*i as usize),
            _ => None,
        };
        at = match index {
            Some(i) => &mut at.as_array_mut().expect("an array, checked above")[i],
            None => {
                let key = match seg { Seg::Index(i) => i.to_string(), Seg::Key(k) => k.clone() };
                if !at.is_object() {
                    *at = Value::Object(Map::new());
                }
                at.as_object_mut().expect("made an object above").entry(key).or_insert(Value::Null)
            }
        };
    }
    match (last, at, value) {
        (Seg::Index(i), Value::Array(items), Some(value)) => {
            let i = *i as usize;
            if i < items.len() {
                items[i] = value;
            } else {
                items.push(value);
            }
        }
        (Seg::Index(i), Value::Array(items), None) => {
            items.truncate(*i as usize);
        }
        (Seg::Key(k), other, value) => {
            if !other.is_object() {
                *other = Value::Object(Map::new());
            }
            let obj = other.as_object_mut().expect("made an object above");
            match value {
                Some(value) => obj.insert(k.clone(), value),
                None => obj.remove(k),
            };
        }
        (Seg::Index(i), other, value) => {
            *other = Value::Object(Map::new());
            if let Some(value) = value {
                other.as_object_mut().expect("made an object above").insert(i.to_string(), value);
            }
        }
    }
}

// ------------------------------------------------------------------ the change bytes

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn get_varint(bytes: &[u8], at: &mut usize) -> Result<u64, String> {
    let mut v = 0u64;
    let mut shift = 0;
    loop {
        let b = *bytes.get(*at).ok_or("changes end inside a number")?;
        *at += 1;
        v |= ((b & 0x7f) as u64) << shift;
        if b < 0x80 {
            return Ok(v);
        }
        shift += 7;
        if shift > 63 {
            return Err("a number in the changes is too long".into());
        }
    }
}

const NULL: u8 = 0;
const FALSE: u8 = 1;
const TRUE: u8 = 2;
const INT: u8 = 3;
const FLOAT: u8 = 4;
const TEXT: u8 = 5;
const JSON: u8 = 6;
const GONE: u8 = 7;

fn put_change(out: &mut Vec<u8>, v: &Option<Value>) {
    match v {
        Some(v) => put_value(out, v),
        None => out.push(GONE),
    }
}

fn get_change(bytes: &[u8], at: &mut usize) -> Result<Option<Value>, String> {
    if bytes.get(*at) == Some(&GONE) {
        *at += 1;
        return Ok(None);
    }
    get_value(bytes, at).map(Some)
}

fn put_value(out: &mut Vec<u8>, v: &Value) {
    match v {
        Value::Null => out.push(NULL),
        Value::Bool(false) => out.push(FALSE),
        Value::Bool(true) => out.push(TRUE),
        Value::Number(n) if n.as_i64().is_some() => {
            let i = n.as_i64().expect("checked");
            out.push(INT);
            put_varint(out, ((i << 1) ^ (i >> 63)) as u64);
        }
        Value::Number(n) if n.is_f64() => {
            out.push(FLOAT);
            out.extend_from_slice(&n.as_f64().expect("checked").to_le_bytes());
        }
        Value::String(s) => {
            out.push(TEXT);
            put_varint(out, s.len() as u64);
            out.extend_from_slice(s.as_bytes());
        }
        other => {
            let text = other.to_string();
            out.push(JSON);
            put_varint(out, text.len() as u64);
            out.extend_from_slice(text.as_bytes());
        }
    }
}

fn get_value(bytes: &[u8], at: &mut usize) -> Result<Value, String> {
    let tag = *bytes.get(*at).ok_or("changes end before a value")?;
    *at += 1;
    let text = |at: &mut usize| -> Result<&str, String> {
        let len = get_varint(bytes, at)? as usize;
        let end = at.checked_add(len).filter(|e| *e <= bytes.len()).ok_or("a text runs past the changes")?;
        let s = std::str::from_utf8(&bytes[*at..end]).map_err(|e| format!("a text is not UTF-8: {e}"))?;
        *at = end;
        Ok(s)
    };
    Ok(match tag {
        NULL => Value::Null,
        FALSE => Value::Bool(false),
        TRUE => Value::Bool(true),
        INT => {
            let z = get_varint(bytes, at)?;
            json!(((z >> 1) as i64) ^ -((z & 1) as i64))
        }
        FLOAT => {
            let raw: [u8; 8] = bytes.get(*at..*at + 8).ok_or("a float runs past the changes")?.try_into().expect("8 bytes");
            *at += 8;
            serde_json::Number::from_f64(f64::from_le_bytes(raw)).map(Value::Number).ok_or("a float is not finite")?
        }
        TEXT => Value::String(text(at)?.to_string()),
        JSON => serde_json::from_str(text(at)?).map_err(|e| format!("a value is not JSON: {e}"))?,
        other => return Err(format!("unknown value tag {other}")),
    })
}

// ------------------------------------------------------------------ building a span (Rust B)

/// One span as Rust B builds it: the analysis at its first step, then every step's change.
pub struct SpanBuilder {
    first_step: usize,
    /// The analysis as of the last step put in, per target.
    state: HashMap<String, Value>,
    keyframe: Vec<Value>,
    targets: Vec<String>,
    target_ids: HashMap<String, u32>,
    paths: Vec<(u32, Vec<Seg>)>,
    path_ids: HashMap<(u32, Vec<Seg>), u32>,
    changes: Vec<u8>,
    last_offset: u64,
    count: usize,
}

impl SpanBuilder {
    /// A span starting at `first_step`, whose analysis there is `items` (a full projection: every block whole).
    pub fn new(first_step: usize, items: Vec<Value>) -> Self {
        let mut state = HashMap::new();
        for item in &items {
            state.insert(target_of(&item["identity"], item["block"].as_str().unwrap_or("")), body_of(item.clone()));
        }
        Self { first_step, state, keyframe: items, targets: Vec::new(), target_ids: HashMap::new(), paths: Vec::new(),
               path_ids: HashMap::new(), changes: Vec::new(), last_offset: 0, count: 0 }
    }

    /// What step `step` (absolute) changed: `items` is what the analysis published after it (blocks that changed; a
    /// record block with only its changed records unless it says `replace`).
    pub fn step(&mut self, step: usize, items: Vec<Value>) {
        let offset = (step - self.first_step) as u64;
        for item in items {
            let block = item["block"].as_str().unwrap_or("").to_string();
            let target = target_of(&item["identity"], &block);
            let replace = item["data"].get("replace") == Some(&Value::Bool(true));
            // A record block's increment, or a block that says it names only what changed (`replace: false`).
            let merge = (matches!(block.as_str(), "minutes" | "events" | "signals") && !replace) || item["data"].get("replace") == Some(&Value::Bool(false));
            let body = body_of(item);
            let mut found = Vec::new();
            match self.state.get(&target) {
                Some(prev) => diff(prev, &body, merge, &mut found),
                None => found.push((Vec::new(), Some(body))),
            }
            if found.is_empty() {
                continue;
            }
            let target_id = match self.target_ids.get(&target) {
                Some(id) => *id,
                None => {
                    let id = self.targets.len() as u32;
                    self.targets.push(target.clone());
                    self.target_ids.insert(target.clone(), id);
                    id
                }
            };
            let root = self.state.entry(target).or_insert(Value::Null);
            for (path, value) in found {
                set_path(root, &path, value.clone());
                let key = (target_id, path);
                let path_id = match self.path_ids.get(&key) {
                    Some(id) => *id,
                    None => {
                        let id = self.paths.len() as u32;
                        self.paths.push(key.clone());
                        self.path_ids.insert(key, id);
                        id
                    }
                };
                put_varint(&mut self.changes, offset - self.last_offset);
                self.last_offset = offset;
                put_varint(&mut self.changes, path_id as u64);
                put_change(&mut self.changes, &value);
                self.count += 1;
            }
        }
    }

    pub fn changes(&self) -> usize {
        self.count
    }

    /// The span as it travels to Market Runtime (inside `replay.timeline`).
    pub fn wire(self, steps: usize) -> Value {
        json!({"first_step": self.first_step, "steps": steps, "keyframe": self.keyframe, "targets": self.targets,
               "paths": self.paths.iter().map(|(t, p)| { let mut v = vec![json!(t)]; v.extend(p.iter().map(Seg::wire)); v }).collect::<Vec<_>>(),
               "changes": base64(&self.changes)})
    }
}

// ------------------------------------------------------------------ holding a timeline (Market Runtime)

/// The fields a timeline's changes name (a target and a path below it), held once for the whole timeline: every span
/// names the same few thousand fields again (2303's day: 657k path entries across 400 spans, 14k distinct).
#[derive(Default)]
pub struct Paths {
    targets: Vec<String>,
    target_ids: HashMap<String, u32>,
    paths: Vec<(u32, Vec<Seg>)>,
    ids: HashMap<(u32, Vec<Seg>), u32>,
}

impl Paths {
    fn intern(&mut self, target: &str, path: Vec<Seg>) -> u32 {
        let target = match self.target_ids.get(target) {
            Some(id) => *id,
            None => {
                let id = self.targets.len() as u32;
                self.targets.push(target.to_string());
                self.target_ids.insert(target.to_string(), id);
                id
            }
        };
        let key = (target, path);
        if let Some(id) = self.ids.get(&key) {
            return *id;
        }
        let id = self.paths.len() as u32;
        self.paths.push(key.clone());
        self.ids.insert(key, id);
        id
    }

    /// The target and the path of field `id`.
    fn get(&self, id: u32) -> (&str, &[Seg]) {
        let (target, path) = &self.paths[id as usize];
        (&self.targets[*target as usize], path)
    }

    /// Bytes held (both the list and its lookup hold each path).
    fn bytes(&self) -> usize {
        let seg = |s: &Seg| std::mem::size_of::<Seg>() + match s { Seg::Key(k) => k.len(), Seg::Index(_) => 0 };
        2 * self.paths.iter().map(|(_, p)| std::mem::size_of::<(u32, Vec<Seg>, u32)>() + p.iter().map(seg).sum::<usize>()).sum::<usize>()
            + 2 * self.targets.iter().map(String::len).sum::<usize>()
    }
}

/// The deflate level a span's changes are held at.
const DEFLATE_LEVEL: u8 = 6;

/// A span as Market Runtime holds it: its keyframe as shared-record JSON (`SharedJson`, one per item, named by its
/// block), its change bytes deflated (most of a timeline's memory is its changes, and they repeat the same fields
/// and values step after step), and its path numbers as the timeline's (`Paths`).
pub struct Span {
    pub first_step: usize,
    pub steps: usize,
    keyframe: Vec<(String, SharedJson)>,
    /// The timeline's number of each path this span's changes name.
    paths: Vec<u32>,
    /// The change bytes, deflated; `raw_len` long inflated.
    packed: Box<[u8]>,
    raw_len: usize,
    /// Where each step's changes start in the inflated changes (one past the last step: the end), so moving one step
    /// decodes that step's changes only.
    starts: Vec<u32>,
}

/// A span's change bytes inflated, held by the state reading that span so a played step does not inflate them again.
#[derive(Clone)]
pub struct Changes {
    first_step: usize,
    bytes: Arc<[u8]>,
}

impl std::fmt::Debug for Changes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Changes(span {}, {} bytes)", self.first_step, self.bytes.len())
    }
}

impl Span {
    /// A span from its wire form; `pool` holds the records the recording's keyframes share, `fields` the fields their
    /// changes name.
    pub fn from_wire(wire: &Value, pool: &mut HashSet<Arc<str>>, fields: &mut Paths) -> Result<Self, String> {
        let number = |f: &str| wire[f].as_u64().map(|n| n as usize).ok_or_else(|| format!("{f} must be an unsigned integer"));
        let targets = wire["targets"].as_array().ok_or("targets must be an array")?.iter()
            .map(|t| t.as_str().ok_or_else(|| "a target is not text".to_string())).collect::<Result<Vec<_>, _>>()?;
        let mut paths = Vec::new();
        for path in wire["paths"].as_array().ok_or("paths must be an array")? {
            let parts = path.as_array().ok_or("a path is not an array")?;
            let target = parts.first().and_then(Value::as_u64).and_then(|t| targets.get(t as usize)).ok_or("a path names no target")?;
            paths.push(fields.intern(target, parts[1..].iter().map(Seg::parse).collect::<Result<Vec<_>, _>>()?));
        }
        let keyframe = wire["keyframe"].as_array().ok_or("keyframe must be an array")?.iter()
            .map(|item| (item["block"].as_str().unwrap_or("").to_string(), SharedJson::of(item, pool))).collect();
        let changes = unbase64(wire["changes"].as_str().ok_or("changes must be text")?)?;
        let mut span = Self { first_step: number("first_step")?, steps: number("steps")?, keyframe, paths, packed: Box::default(),
                              raw_len: changes.len(), starts: Vec::new() };
        // Every change must decode, name a known path and stay inside the span: checked once, here, noting where
        // each step's changes start.
        let mut starts = vec![u32::MAX; span.steps + 1];
        span.each_change(&changes, span.first_step, usize::MAX, |step, at, _, _| {
            let slot = &mut starts[step - span.first_step];
            *slot = (*slot).min(at as u32);
        })?;
        starts[span.steps] = changes.len() as u32;
        for i in (0..span.steps).rev() {
            starts[i] = starts[i].min(starts[i + 1]);
        }
        span.starts = starts;
        span.packed = miniz_oxide::deflate::compress_to_vec(&changes, DEFLATE_LEVEL).into_boxed_slice();
        Ok(span)
    }

    /// Its change bytes inflated.
    fn inflate(&self) -> Result<Changes, String> {
        let bytes = miniz_oxide::inflate::decompress_to_vec_with_limit(&self.packed, self.raw_len)
            .map_err(|e| format!("span {}'s changes do not inflate: {e}", self.first_step))?;
        if bytes.len() != self.raw_len {
            return Err(format!("span {}'s changes inflate to {} bytes, not {}", self.first_step, bytes.len(), self.raw_len));
        }
        Ok(Changes { first_step: self.first_step, bytes: bytes.into() })
    }

    /// Bytes held of its own (its keyframe's shared records are the pool's).
    pub fn own_bytes(&self) -> usize {
        self.keyframe.iter().map(|(_, k)| k.own_bytes()).sum::<usize>() + self.packed.len() + self.index_bytes()
    }

    /// Bytes of what finds a step's changes: where each step starts and its path numbers.
    fn index_bytes(&self) -> usize {
        self.starts.len() * 4 + self.paths.len() * 4
    }

    /// Every change in `changes` (this span's, inflated) of the steps from `from` up to (not including) `until`
    /// (absolute), in order: (step, the byte it starts at, path id, value). Starts at `from`'s first change once the
    /// span is read (`starts`).
    fn each_change(&self, changes: &[u8], from: usize, until: usize, mut each: impl FnMut(usize, usize, u32, Option<Value>)) -> Result<(), String> {
        let from_offset = from.saturating_sub(self.first_step);
        let mut at = match self.starts.get(from_offset) {
            Some(start) if from_offset > 0 => *start as usize,
            _ => 0,
        };
        // A step's first change says how far it is from the step of the change before it: decoding from the middle
        // starts with the distance from that earlier step, so the offset to add from is the earlier step's; from the
        // first byte (no step before `from` changed anything) it is the span's first step.
        let mut offset = if at > 0 { self.step_before(at)? } else { 0 };
        while at < changes.len() {
            let start = at;
            offset += get_varint(changes, &mut at)?;
            let path = get_varint(changes, &mut at)?;
            if path as usize >= self.paths.len() {
                return Err(format!("a change names path {path} of {}", self.paths.len()));
            }
            let value = get_change(changes, &mut at)?;
            let step = self.first_step + offset as usize;
            if offset as usize >= self.steps {
                return Err(format!("a change of step {step} is past the span's {} steps", self.steps));
            }
            if step >= until {
                return Ok(());
            }
            if step >= from {
                each(step, start, path as u32, value);
            }
        }
        Ok(())
    }

    /// The step offset of the last change before byte `at` (a change's step is coded as the distance from it).
    fn step_before(&self, at: usize) -> Result<u64, String> {
        // `starts` is nondecreasing: the steps whose changes start before `at` end at the last one below it.
        let i = self.starts.partition_point(|s| (*s as usize) < at);
        Ok(i.saturating_sub(1) as u64)
    }
}

/// What changed when the analysis moved: per target, the records changed (a record block) or the whole block.
#[derive(Debug, Default)]
pub struct Moved {
    pub targets: BTreeMap<String, Option<HashSet<String>>>,
}

/// The analysis at one position of a timeline, per target (`target_of`): each block's body (`body_of`), and the order
/// each events block first showed its events in (the cache's tape order).
#[derive(Debug, Default, Clone)]
pub struct State {
    pub position: usize,
    /// The first step of the span this state is of (read from its keyframe).
    span: usize,
    /// That span's changes inflated, once a step past its keyframe was read (a played replay reads them step by step).
    changes: Option<Changes>,
    pub blocks: HashMap<String, Value>,
    pub event_order: HashMap<String, Vec<String>>,
}

impl State {
    /// The state at `span`'s first step.
    pub fn keyframe(span: &Span) -> Result<Self, String> {
        let mut state = State { position: span.first_step, span: span.first_step, ..Default::default() };
        for (_, held) in &span.keyframe {
            let item: Value = serde_json::from_str(&held.json()).map_err(|e| format!("keyframe is not JSON: {e}"))?;
            let block = item["block"].as_str().unwrap_or("");
            let target = target_of(&item["identity"], block);
            if block == "events" {
                let order = item["data"]["events"].as_array().into_iter().flatten()
                    .filter_map(|e| e["event_id"].as_str().map(str::to_string)).collect();
                state.event_order.insert(target.clone(), order);
            }
            state.blocks.insert(target, body_of(item));
        }
        Ok(state)
    }

    /// Apply `span`'s changes from this state's position up to `until` (both inside the span), noting what moved;
    /// `fields` names the fields its changes set.
    pub fn advance(&mut self, span: &Span, fields: &Paths, until: usize, moved: &mut Moved) -> Result<(), String> {
        let from = self.position;
        if from == until {
            return Ok(());
        }
        let changes = match self.changes.take() {
            Some(held) if held.first_step == span.first_step => held,
            _ => span.inflate()?,
        };
        span.each_change(&changes.bytes, from, until, |_, _, path_id, value| {
            let (target, path) = fields.get(span.paths[path_id as usize]);
            // A record block moves by records (data.<block>.<key>...); its other fields are its meta.
            let block = target.rsplit('|').next().unwrap_or("");
            let record_block = matches!(block, "minutes" | "events");
            let record = match (record_block, path) {
                (true, [Seg::Key(d), Seg::Key(b), Seg::Key(k), ..]) if d == "data" && b == block => Some(k.clone()),
                _ => None,
            };
            if block == "events" {
                if let Some(id) = &record {
                    let order = self.event_order.entry(target.to_string()).or_default();
                    if !order.contains(id) {
                        order.push(id.clone());
                    }
                }
            }
            let slot = moved.targets.entry(target.to_string()).or_insert_with(|| record_block.then(HashSet::new));
            if let (Some(records), Some(id)) = (slot, record) {
                records.insert(id);
            }
            set_path(self.blocks.entry(target.to_string()).or_insert(Value::Null), path, value);
        })?;
        self.changes = Some(changes);
        self.position = until;
        Ok(())
    }
}

/// A timeline as Market Runtime holds it: the spans built so far, of one analysis version.
#[derive(Default)]
pub struct Timeline {
    pub version: String,
    pub steps: usize,
    pub span_len: usize,
    spans: BTreeMap<usize, Span>,
    pool: HashSet<Arc<str>>,
    fields: Paths,
}

impl Timeline {
    pub fn new(steps: usize) -> Self {
        Self { steps, span_len: span_len(steps), ..Default::default() }
    }

    /// Keep one span of `version`; a span of another version starts the timeline over (B's rules or models changed).
    /// Returns whether it was taken (false: a span already held).
    pub fn insert(&mut self, version: &str, wire: &Value) -> Result<bool, String> {
        if version != self.version {
            self.spans.clear();
            self.pool.clear();
            self.fields = Paths::default();
            self.version = version.to_string();
        }
        let span = Span::from_wire(wire, &mut self.pool, &mut self.fields)?;
        if span.first_step % self.span_len.max(1) != 0 || span.first_step + span.steps > self.steps
            || span.steps != self.span_len.min(self.steps - span.first_step) {
            return Err(format!("span at step {} of {} steps does not fit {} steps of {} each", span.first_step, span.steps, self.steps, self.span_len));
        }
        if self.spans.contains_key(&span.first_step) {
            return Ok(false);
        }
        self.spans.insert(span.first_step, span);
        Ok(true)
    }

    /// The span whose analysis gives position `p`: the one it lies in (a position at a span's end is its next one's
    /// start, else this one's end).
    fn span_for(&self, p: usize) -> Option<&Span> {
        let first = (p / self.span_len.max(1)) * self.span_len.max(1);
        self.spans.get(&first).filter(|s| p <= s.first_step + s.steps)
            .or_else(|| first.checked_sub(self.span_len).and_then(|prev| self.spans.get(&prev)).filter(|s| p == s.first_step + s.steps))
    }

    pub fn has(&self, p: usize) -> bool {
        self.span_for(p).is_some()
    }

    /// The analysis at position `p`, or None while its span is not built.
    pub fn state_at(&self, p: usize) -> Result<Option<State>, String> {
        let Some(span) = self.span_for(p) else { return Ok(None) };
        let mut state = State::keyframe(span)?;
        state.advance(span, &self.fields, p, &mut Moved::default())?;
        Ok(Some(state))
    }

    /// Move `state` forward to `p` through the spans between, noting what moved. False when a span on the way is not
    /// built (the state is then where it stopped). Reaching the next span's first step, the state becomes that span's
    /// keyframe (every block that differs moved whole): a position reads the same played up to as sought to, to the
    /// stamp of every block.
    pub fn advance(&self, state: &mut State, p: usize, moved: &mut Moved) -> Result<bool, String> {
        loop {
            // At a span's first step the state is that span's (once it is built).
            if let Some(span) = self.spans.get(&state.position).filter(|s| s.first_step != state.span) {
                let next = State::keyframe(span)?;
                for target in state.blocks.keys().chain(next.blocks.keys()) {
                    if state.blocks.get(target) != next.blocks.get(target) {
                        moved.targets.insert(target.clone(), None);
                    }
                }
                *state = next;
            }
            if state.position >= p {
                return Ok(true);
            }
            let Some(span) = self.span_for(state.position).filter(|s| state.position < s.first_step + s.steps && s.first_step == state.span)
                else { return Ok(false) };
            let until = p.min(span.first_step + span.steps);
            state.advance(span, &self.fields, until, moved)?;
        }
    }

    /// The ranges of steps whose analysis is held, merged: [first, last] positions.
    pub fn held(&self) -> Vec<(usize, usize)> {
        let mut out: Vec<(usize, usize)> = Vec::new();
        for span in self.spans.values() {
            let (a, b) = (span.first_step, span.first_step + span.steps);
            match out.last_mut() {
                Some(last) if last.1 >= a => last.1 = last.1.max(b),
                _ => out.push((a, b)),
            }
        }
        out
    }

    pub fn complete(&self) -> bool {
        self.held() == [(0, self.steps)] || self.steps == 0
    }

    /// The bytes it holds: the spans' own and the shared records.
    pub fn bytes(&self) -> usize {
        self.spans.values().map(Span::own_bytes).sum::<usize>() + self.pool.iter().map(|r| r.len()).sum::<usize>() + self.fields.bytes()
    }

    /// What it holds, by part: the keyframes' own bytes per block, the shared records, the change bytes and the index
    /// that finds a step's changes (the replay's diagnostics, and the measurement of its memory).
    pub fn stats(&self) -> Value {
        let mut keyframe_bytes: BTreeMap<&str, usize> = BTreeMap::new();
        let mut keyframes = 0;
        for span in self.spans.values() {
            keyframes += usize::from(!span.keyframe.is_empty());
            for (block, held) in &span.keyframe {
                *keyframe_bytes.entry(block.as_str()).or_default() += held.own_bytes();
            }
        }
        json!({"spans": self.spans.len(), "keyframes": keyframes, "keyframe_bytes": keyframe_bytes,
               "pool_records": self.pool.len(), "pool_bytes": self.pool.iter().map(|r| r.len()).sum::<usize>(),
               "change_bytes": self.spans.values().map(|s| s.packed.len()).sum::<usize>(),
               "change_raw_bytes": self.spans.values().map(|s| s.raw_len).sum::<usize>(),
               "index_bytes": self.spans.values().map(Span::index_bytes).sum::<usize>(), "fields": self.fields.paths.len(),
               "field_bytes": self.fields.bytes(), "bytes": self.bytes()})
    }

    /// The changes by block (decodes every span: a measurement, not a status): how many, their bytes inflated, the paths the
    /// spans name, and how many of those paths are distinct across the whole timeline.
    pub fn change_stats(&self) -> Result<Value, String> {
        #[derive(Default)]
        struct Block { changes: usize, bytes: usize, values: BTreeMap<&'static str, usize>, paths: usize, distinct: HashSet<Vec<Seg>> }
        let mut blocks: BTreeMap<String, Block> = BTreeMap::new();
        for span in self.spans.values() {
            let block_of = |path_id: u32| self.fields.get(span.paths[path_id as usize]).0.rsplit('|').next().unwrap_or("").to_string();
            for id in &span.paths {
                let (target, path) = self.fields.get(*id);
                let block = blocks.entry(target.rsplit('|').next().unwrap_or("").to_string()).or_default();
                block.paths += 1;
                block.distinct.insert(path.to_vec());
            }
            let mut last: Option<(usize, u32)> = None;
            let mut each = |at: usize, path: u32, value: &Option<Value>| {
                if let Some((start, p)) = last {
                    blocks.entry(block_of(p)).or_default().bytes += at - start;
                }
                let block = blocks.entry(block_of(path)).or_default();
                block.changes += 1;
                *block.values.entry(match value {
                    None => "gone", Some(Value::Number(n)) if n.is_f64() => "float", Some(Value::Number(_)) => "int",
                    Some(Value::String(_)) => "text", Some(Value::Object(_) | Value::Array(_)) => "json", Some(_) => "other",
                }).or_default() += 1;
                last = Some((at, path));
            };
            let changes = span.inflate()?;
            span.each_change(&changes.bytes, span.first_step, usize::MAX, |_, at, path, value| each(at, path, &value))?;
            if let Some((start, p)) = last {
                blocks.entry(block_of(p)).or_default().bytes += changes.bytes.len() - start;
            }
        }
        Ok(Value::Object(blocks.into_iter().map(|(name, b)| (name, json!({"changes": b.changes, "bytes": b.bytes, "values": b.values,
            "paths": b.paths, "distinct_paths": b.distinct.len()}))).collect()))
    }

    /// The changes by field (decodes every span: a measurement): the block and the path with every record key and
    /// array index made `*`, how many changes, their bytes inflated, and how many steps changed it.
    pub fn field_stats(&self) -> Result<Value, String> {
        #[derive(Default)]
        struct Field { changes: usize, bytes: usize, steps: usize, last_step: Option<usize> }
        let mut fields: BTreeMap<String, Field> = BTreeMap::new();
        let mut names: HashMap<u32, String> = HashMap::new();
        for span in self.spans.values() {
            let mut name_of = |path_id: u32| -> String {
                let id = span.paths[path_id as usize];
                names.entry(id).or_insert_with(|| {
                    let (target, path) = self.fields.get(id);
                    let block = target.rsplit('|').next().unwrap_or("");
                    let record = matches!(block, "minutes" | "events");
                    let mut name = block.to_string();
                    for (i, seg) in path.iter().enumerate() {
                        name.push('.');
                        match seg {
                            Seg::Key(_) if record && i == 2 => name.push('*'),
                            Seg::Key(k) => name.push_str(k),
                            Seg::Index(_) => name.push('*'),
                        }
                    }
                    name
                }).clone()
            };
            let mut last: Option<(usize, String)> = None;
            let mut found: Vec<(usize, usize, String)> = Vec::new();
            let changes = span.inflate()?;
            span.each_change(&changes.bytes, span.first_step, usize::MAX, |step, at, path, _| found.push((step, at, name_of(path))))?;
            for (step, at, name) in found {
                if let Some((start, prev)) = last.take() {
                    fields.entry(prev).or_default().bytes += at - start;
                }
                let field = fields.entry(name.clone()).or_default();
                field.changes += 1;
                if field.last_step != Some(step) {
                    field.steps += 1;
                    field.last_step = Some(step);
                }
                last = Some((at, name));
            }
            if let Some((start, prev)) = last {
                fields.entry(prev).or_default().bytes += changes.bytes.len() - start;
            }
        }
        Ok(Value::Object(fields.into_iter().map(|(name, f)| (name, json!({"changes": f.changes, "bytes": f.bytes, "steps": f.steps}))).collect()))
    }
}

// ------------------------------------------------------------------ shared-record JSON

/// A JSON value as text in pieces: the records of its arrays of records (every array whose elements are all objects)
/// are shared by every value of the same pool whose record is the same text -- a closed minute, a K bar, an event is
/// held once, not once per keyframe.
pub struct SharedJson {
    parts: Vec<Part>,
}

enum Part {
    Text(Box<str>),
    /// A record array's elements, written comma-separated.
    Records(Vec<Arc<str>>),
}

struct SharedWriter<'a> {
    text: String,
    parts: Vec<Part>,
    pool: &'a mut HashSet<Arc<str>>,
}

impl SharedWriter<'_> {
    fn value(&mut self, value: &Value, top: bool) {
        match value {
            Value::Object(map) => {
                self.text.push('{');
                for (index, (key, v)) in map.iter().enumerate() {
                    if index > 0 {
                        self.text.push(',');
                    }
                    self.text.push_str(&Value::String(key.clone()).to_string());
                    self.text.push(':');
                    self.value(v, false);
                }
                self.text.push('}');
            }
            Value::Array(records) if !top && !records.is_empty() && records.iter().all(Value::is_object) => {
                self.text.push('[');
                self.parts.push(Part::Text(std::mem::take(&mut self.text).into_boxed_str()));
                let held = records.iter().map(|record| {
                    let own = record.to_string();
                    match self.pool.get(own.as_str()) {
                        Some(held) => held.clone(),
                        None => {
                            let held: Arc<str> = Arc::from(own);
                            self.pool.insert(held.clone());
                            held
                        }
                    }
                }).collect();
                self.parts.push(Part::Records(held));
                self.text.push(']');
            }
            Value::Array(values) => {
                self.text.push('[');
                for (index, v) in values.iter().enumerate() {
                    if index > 0 {
                        self.text.push(',');
                    }
                    self.value(v, false);
                }
                self.text.push(']');
            }
            scalar => self.text.push_str(&scalar.to_string()),
        }
    }
}

impl SharedJson {
    /// `value` with the records of its arrays taken from `pool` when another value already holds the same.
    pub fn of(value: &Value, pool: &mut HashSet<Arc<str>>) -> Self {
        let mut writer = SharedWriter { text: String::new(), parts: Vec::new(), pool };
        writer.value(value, true);
        let SharedWriter { text, mut parts, .. } = writer;
        parts.push(Part::Text(text.into_boxed_str()));
        Self { parts }
    }

    pub fn json(&self) -> String {
        let mut out = String::with_capacity(self.parts.iter().map(|p| match p {
            Part::Text(t) => t.len(),
            Part::Records(m) => m.iter().map(|x| x.len() + 1).sum(),
        }).sum());
        for part in &self.parts {
            match part {
                Part::Text(t) => out.push_str(t),
                Part::Records(records) => for (i, m) in records.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(m);
                },
            }
        }
        out
    }

    /// The bytes this value holds of its own (its records are the pool's).
    pub fn own_bytes(&self) -> usize {
        self.parts.iter().map(|p| match p {
            Part::Text(t) => t.len(),
            Part::Records(m) => m.len() * std::mem::size_of::<Arc<str>>(),
        }).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(code: &str, block: &str, data: Value) -> Value {
        json!({"identity": {"code": code}, "block": block, "revision": 1, "input_watermark": 1, "data": data})
    }

    #[test]
    fn a_value_survives_the_change_bytes() {
        let values = [json!(null), json!(true), json!(false), json!(0), json!(-7), json!(i64::MAX), json!(i64::MIN), json!(1.25),
                      json!(-0.1), json!(u64::MAX), json!("價量"), json!([1, {"a": 2}]), json!({"k": [1.5]})];
        let mut bytes = Vec::new();
        for v in &values {
            put_value(&mut bytes, v);
        }
        let mut at = 0;
        for v in &values {
            assert_eq!(&get_value(&bytes, &mut at).unwrap(), v);
        }
        assert_eq!(at, bytes.len());
    }

    #[test]
    fn base64_round_trips() {
        for n in 0..10usize {
            let bytes: Vec<u8> = (0..n as u8).map(|b| b.wrapping_mul(97)).collect();
            assert_eq!(unbase64(&base64(&bytes)).unwrap(), bytes);
        }
        assert!(unbase64("abc").is_err());
    }

    /// Built step by step, read back at every position: each is exactly what the analysis published up to it -- a
    /// minute changing in place, a minute added, a whole block replaced, an event added, a field gone.
    #[test]
    fn every_position_reads_back_as_the_steps_built_it() {
        let day = |close: f64, extra: Option<i64>| {
            let mut d = json!({"close": close, "fixed_k": {"k3": [{"start_minute": 540, "close": close}]}});
            if let Some(x) = extra {
                d["extra"] = json!(x);
            }
            d
        };
        let keyframe = vec![
            item("2303", "minutes", json!({"minutes": [{"minute": 540, "close": 10, "revision": 1}], "replace": true})),
            item("2303", "day", day(10.0, Some(1))),
            item("2303", "events", json!({"events": [{"event_id": "e1", "label": "a"}], "replace": true})),
        ];
        let steps: Vec<Vec<Value>> = vec![
            vec![item("2303", "minutes", json!({"minutes": [{"minute": 540, "close": 11, "revision": 2}], "replace": false}))],
            vec![],
            vec![item("2303", "minutes", json!({"minutes": [{"minute": 541, "close": 12, "revision": 1}], "replace": false})),
                 item("2303", "day", day(12.0, None))],
            vec![item("2303", "events", json!({"events": [{"event_id": "e0", "label": "b"}], "replace": false}))],
        ];
        // What the cache would hold after each step (keyed records), built independently of the span.
        let mut expected = vec![{
            let mut s = HashMap::new();
            for i in &keyframe {
                s.insert(target_of(&i["identity"], i["block"].as_str().unwrap()), body_of(i.clone()));
            }
            s
        }];
        let mut builder = SpanBuilder::new(100, keyframe.clone());
        for (offset, items) in steps.iter().enumerate() {
            let mut next = expected.last().unwrap().clone();
            for i in items {
                let target = target_of(&i["identity"], i["block"].as_str().unwrap());
                let body = body_of(i.clone());
                if matches!(i["block"].as_str(), Some("minutes" | "events")) {
                    let block = i["block"].as_str().unwrap();
                    let held = next.get_mut(&target).unwrap();
                    for (k, r) in body["data"][block].as_object().unwrap() {
                        held["data"][block][k] = r.clone();
                    }
                    held["input_watermark"] = body["input_watermark"].clone();
                } else {
                    next.insert(target, body);
                }
            }
            expected.push(next);
            builder.step(100 + offset, items.clone());
        }
        let wire = builder.wire(4);
        let mut timeline = Timeline::new(104);
        timeline.span_len = 100;
        assert!(Timeline::insert(&mut timeline, "v1", &json!({"first_step": 0, "steps": 100, "keyframe": [], "targets": [], "paths": [], "changes": ""})).unwrap());
        assert!(timeline.insert("v1", &wire).unwrap());
        for (offset, want) in expected.iter().enumerate() {
            let got = timeline.state_at(100 + offset).unwrap().unwrap();
            assert_eq!(&got.blocks, want, "position {}", 100 + offset);
        }
        // Moving forward one step at a time gives the same, and names what moved.
        let mut state = timeline.state_at(100).unwrap().unwrap();
        let mut moved = Moved::default();
        assert!(timeline.advance(&mut state, 103, &mut moved).unwrap());
        assert_eq!(state.blocks, expected[3]);
        let minutes = target_of(&json!({"code": "2303"}), "minutes");
        assert_eq!(moved.targets[&minutes].as_ref().unwrap().len(), 2, "minutes 540 and 541");
        assert_eq!(moved.targets[&target_of(&json!({"code": "2303"}), "day")], None, "the day block whole");
        let mut state4 = timeline.state_at(104).unwrap().unwrap();
        assert_eq!(state4.event_order[&target_of(&json!({"code": "2303"}), "events")], vec!["e1", "e0"], "first shown order");
        assert!(timeline.advance(&mut state4, 104, &mut Moved::default()).unwrap());
        assert!(timeline.has(0) && timeline.has(104) && !Timeline::new(10).has(3));
        assert_eq!(timeline.held(), vec![(0, 104)]);
        assert!(timeline.complete());
    }

    /// A span whose first steps change nothing (an instrument's blocks first appear a few steps in, as on the day's
    /// first span): played one step at a time, every position reads as sought to -- the block's first, whole change
    /// included.
    #[test]
    fn a_span_played_step_by_step_from_steps_that_changed_nothing_reads_as_sought_to() {
        let mut builder = SpanBuilder::new(0, Vec::new());
        builder.step(0, Vec::new());
        builder.step(1, Vec::new());
        builder.step(2, vec![item("2303", "flow", json!({"thresholds": {"volume_cutoff": 50}, "totals": {"buy": 1}}))]);
        builder.step(3, vec![item("2303", "flow", json!({"thresholds": {"volume_cutoff": 50}, "totals": {"buy": 4}}))]);
        let mut timeline = Timeline::new(5);
        timeline.span_len = 5;
        assert!(timeline.insert("v1", &builder.wire(5)).unwrap());
        let mut state = timeline.state_at(0).unwrap().unwrap();
        for p in 1..=5 {
            assert!(timeline.advance(&mut state, p, &mut Moved::default()).unwrap());
            assert_eq!(state.blocks, timeline.state_at(p).unwrap().unwrap().blocks, "played to {p}");
        }
        assert_eq!(state.blocks[&target_of(&json!({"code": "2303"}), "flow")]["data"]["thresholds"]["volume_cutoff"], 50);
    }

    /// A new large print is one row of change (the newest-first list shifted every row by one), and the list reads back
    /// newest first, as B listed it.
    #[test]
    fn a_new_large_print_is_one_row_and_the_list_reads_back_newest_first() {
        let row = |seq: u64| json!({"durable_sequence": seq, "trade_id": format!("t{seq}"), "price": 50.0, "volume": 10, "side": "BUY"});
        let flow = |seqs: &[u64]| item("2303", "flow", json!({"totals": {"net": 1}, "largeOrders": seqs.iter().map(|s| row(*s)).collect::<Vec<_>>()}));
        let mut builder = SpanBuilder::new(0, vec![flow(&[1000, 999, 30])]);
        builder.step(0, vec![flow(&[1001, 1000, 999])]);
        assert_eq!(builder.changes(), 2, "1001 added, 30 gone");
        builder.step(1, vec![item("2303", "flow", json!({"totals": {"net": 2}, "replace": false}))]);
        let mut timeline = Timeline::new(2);
        timeline.span_len = 2;
        timeline.insert("v1", &builder.wire(2)).unwrap();
        let state = timeline.state_at(2).unwrap().unwrap();
        let data = flow_unkeyed(&state.blocks[&target_of(&json!({"code": "2303"}), "flow")]["data"]);
        assert_eq!(data["largeOrders"], json!([row(1001), row(1000), row(999)]), "newest first, past the step that left the list out");
        assert_eq!(data["totals"]["net"], 2);
    }

    #[test]
    fn a_span_of_another_version_starts_the_timeline_over_and_a_misfit_is_refused() {
        let mut timeline = Timeline::new(500);
        let span = |first: usize, steps: usize| json!({"first_step": first, "steps": steps, "keyframe": [], "targets": [], "paths": [], "changes": ""});
        let len = timeline.span_len;
        assert!(timeline.insert("v1", &span(0, len)).unwrap());
        assert!(!timeline.insert("v1", &span(0, len)).unwrap(), "held already");
        assert!(timeline.insert("v1", &span(len + 1, len)).is_err());
        assert!(timeline.insert("v2", &span(len, 500 - len)).unwrap());
        assert_eq!(timeline.held(), vec![(len, 500)], "v1's span went with its version");
    }

    #[test]
    fn steps_put_each_minute_s_clock_before_its_first_event() {
        let minute = 60_000_000_000i64;
        let t0 = 1_000 * minute;
        let mk = |ts: i64| {
            let mut e = crate::state::tests_support::trade_event("2303", 1, 100);
            e.exchange_ts_ns = ts;
            e
        };
        let events = vec![mk(t0 + 5), mk(t0 + 6), mk(t0 + 3 * minute)];
        let due = replay::due_times(&events);
        let s = steps(&events, &due);
        let kinds: Vec<Option<usize>> = s.iter().map(|x| x.event).collect();
        assert_eq!(kinds, vec![None, Some(0), Some(1), None, None, None, Some(2)]);
        assert_eq!(position_at(&s, t0 + 5), 2);
        assert_eq!(position_at(&s, t0 + 2 * minute), 5);
    }

    #[test]
    fn shared_json_reads_back_and_holds_a_record_once() {
        let mut pool = HashSet::new();
        let item = json!({"data": {"minutes": [{"m": 1}, {"m": 2}], "x": [1, 2], "s": "a\"b"}, "k": []});
        let one = SharedJson::of(&item, &mut pool);
        let two = SharedJson::of(&item, &mut pool);
        assert_eq!(serde_json::from_str::<Value>(&one.json()).unwrap(), item);
        assert_eq!(pool.len(), 2, "each record once across both");
        assert!(one.own_bytes() > 0 && two.json() == one.json());
    }
}
