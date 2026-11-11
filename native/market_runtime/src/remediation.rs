//! Remediation event emission for Rust A and Rust B (the remediation event contract in docs/BACKLOG.md).
//!
//! Every retry, reconnect, resend, rebuild, fallback or rollback this process performs is recorded as a
//! `stock-monitor-remediation-event-v1` event in Health's ledger (health/remediation/ledger.js). The registry of
//! mechanisms is config/remediation_registry.json (compiled in); the frame is the one config/js/remediation_contract.js
//! defines: a 4-byte little-endian length, then one UTF-8 JSON event. The writer answers with the cumulative number of
//! frames it has taken, as an 8-byte little-endian integer; a frame is dropped from the queue only once acknowledged,
//! so a lost connection sends it again (the writer drops duplicates by event_id). An acknowledgement not received
//! within the registry's `client_ack_timeout_ms` drops the connection the same way: a writer that took the pipe and
//! stopped answering is not waited on forever while the queue fills.
//!
//! `init` once at startup (service id + instance id); then `emit` for a one-shot remediation, or `begin` for one that
//! runs over time and `Operation::finish` for its single terminal outcome. Nothing here blocks the caller or fails it:
//! events go through a bounded queue to one background thread. What cannot be delivered is counted, and once
//! delivery works again a `sink.client_loss` event records how many were lost, since when and why. A process that was
//! never `init`ed (a test, an offline tool) emits nothing.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::hash_map::RandomState;
use std::collections::{BTreeMap, VecDeque};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Write};
use std::num::{NonZeroU64, NonZeroUsize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PIPE_ENV: &str = "STOCK_MONITOR_REMEDIATION_PIPE";
const REGISTRY: &str = include_str!("../../../config/remediation_registry.json");

/// The registry as this crate uses it. Every field is required and every limit non-zero: a registry that does not
/// parse into this is a build defect (the tests below parse it), never read as empty lists or zero limits.
#[derive(Deserialize)]
struct Limits {
    frame_bytes: NonZeroUsize,
    detail_keys: NonZeroUsize,
    string_chars: NonZeroUsize,
    client_queue_events: NonZeroUsize,
    client_ack_timeout_ms: NonZeroU64,
}

#[derive(Deserialize)]
struct Mechanism {
    trigger_reasons: Vec<String>,
}

#[derive(Deserialize)]
struct Contract {
    event_schema: String,
    identity_fields: Vec<String>,
    mechanisms: BTreeMap<String, Mechanism>,
    limits: Limits,
}

fn parse_contract(text: &str) -> Result<Contract, String> {
    let c: Contract = serde_json::from_str(text).map_err(|e| format!("remediation registry: {e}"))?;
    if c.event_schema.is_empty() || c.identity_fields.is_empty() || c.mechanisms.is_empty() {
        return Err("remediation registry: event_schema, identity_fields and mechanisms must not be empty".into());
    }
    if let Some((id, _)) = c.mechanisms.iter().find(|(_, m)| m.trigger_reasons.is_empty()) {
        return Err(format!("remediation registry: mechanism {id} lists no trigger_reasons"));
    }
    Ok(c)
}

fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| parse_contract(REGISTRY).unwrap_or_else(|e| panic!("config/remediation_registry.json (compiled in): {e}")))
}

/// True when `mechanism_id` is in the registry (tests assert every id this crate and B use is).
pub fn registered(mechanism_id: &str) -> bool {
    contract().mechanisms.contains_key(mechanism_id)
}

/// Why an event cannot be emitted as asked: the writer would refuse it, so it is refused here, where it is recorded.
fn unregistered(mechanism_id: &str, trigger_reason: &str) -> Option<String> {
    match contract().mechanisms.get(mechanism_id) {
        None => Some(format!("unregistered mechanism_id {mechanism_id}")),
        Some(m) if !m.trigger_reasons.iter().any(|r| r == trigger_reason) =>
            Some(format!("trigger_reason {trigger_reason} is not registered for {mechanism_id}")),
        Some(_) => None,
    }
}

/// UTC wall-clock time with milliseconds, e.g. 2026-10-08T04:44:14.150Z (the ledger buckets by its own local day).
pub fn utc_iso_ms(ns: u64) -> String {
    let ms = ns / 1_000_000;
    let secs = (ms / 1000) as i64;
    let (y, m, d) = crate::event::civil_from_days(secs.div_euclid(86_400));
    let day = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", day / 3600, day % 3600 / 60, day % 60, ms % 1000)
}

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

/// A random version-4-shaped UUID (std only: RandomState is seeded from the OS per instance).
fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut words = [0u64; 2];
    for word in &mut words {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(now_ns());
        h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        *word = h.finish();
    }
    let (a, b) = (words[0], words[1]);
    format!("{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}", a >> 32, (a >> 16) & 0xffff, a & 0x0fff,
        ((b >> 48) & 0x3fff) | 0x8000, b & 0xffff_ffff_ffff)
}

fn bounded(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Finding secrets in names and values: config/secret_scrub.json holds the rules and their exact wording;
/// config/secret_scrub.py and config/js/secret_scrub.js implement the same ones, and
/// tests/fixtures/secret_scrub_cases.json holds the cases all three must agree on. Positions are in chars, as in Python.
mod scrub {
    use serde::Deserialize;
    use serde_json::{Map, Value};
    use std::sync::OnceLock;

    #[derive(Deserialize)]
    struct Rules {
        key_markers: Vec<String>,
        exact_names: Vec<String>,
        auth_schemes: Vec<String>,
        bare_schemes: Vec<String>,
        pem_marker: String,
        redacted: String,
        max_depth: usize,
    }

    fn rules() -> &'static Rules {
        static RULES: OnceLock<Rules> = OnceLock::new();
        RULES.get_or_init(|| serde_json::from_str(include_str!("../../../config/secret_scrub.json"))
            .unwrap_or_else(|e| panic!("config/secret_scrub.json (compiled in): {e}")))
    }

    fn is_alnum(c: char) -> bool {
        c.is_ascii_alphanumeric()
    }
    fn is_name(c: char) -> bool {
        is_alnum(c) || matches!(c, '_' | '.' | '-')
    }
    fn is_jwt(c: char) -> bool {
        is_alnum(c) || matches!(c, '_' | '-')
    }
    fn is_space(c: char) -> bool {
        matches!(c, ' ' | '\t')
    }
    fn is_quote(c: char) -> bool {
        matches!(c, '"' | '\'')
    }
    fn is_value_stop(c: char) -> bool {
        matches!(c, ' ' | '\t' | '\r' | '\n' | '\x0c' | '\x0b' | '"' | '\'' | '&' | ';' | ',' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>')
    }

    pub fn secret_name(name: &str) -> bool {
        let normalized: String = name.to_uppercase().chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).collect();
        let r = rules();
        r.exact_names.iter().any(|n| *n == normalized) || r.key_markers.iter().any(|m| normalized.contains(m.as_str()))
    }

    fn skip(text: &[char], mut at: usize, keep: fn(char) -> bool) -> usize {
        while at < text.len() && keep(text[at]) {
            at += 1;
        }
        at
    }

    fn run_end(text: &[char], at: usize) -> usize {
        skip(text, at, |c| !is_value_stop(c))
    }

    fn upper(text: &[char]) -> String {
        text.iter().collect::<String>().to_uppercase()
    }

    /// The secret after a secret name ending at `name_end` (rule 1), or None.
    fn named_value(text: &[char], name_end: usize) -> Option<(usize, usize)> {
        let mut at = if name_end < text.len() && is_quote(text[name_end]) { name_end + 1 } else { name_end };
        at = skip(text, at, is_space);
        if at >= text.len() || !matches!(text[at], '=' | ':') {
            return None;
        }
        at = skip(text, at + 1, is_space);
        if at < text.len() && is_quote(text[at]) {
            at += 1;
        }
        let end = run_end(text, at);
        if end == at {
            return None;
        }
        if rules().auth_schemes.iter().any(|s| *s == upper(&text[at..end])) {
            let after = skip(text, end, is_space);
            let last = if after > end { run_end(text, after) } else { after };
            return Some(if last > after { (after, last) } else { (end, end) });
        }
        Some((at, end))
    }

    /// The merged [start, end) char spans of `text` that are secret.
    pub fn secret_spans(text: &str) -> Vec<(usize, usize)> {
        let r = rules();
        let chars: Vec<char> = text.chars().collect();
        let size = chars.len();
        if text.contains(r.pem_marker.as_str()) {
            return if size > 0 { vec![(0, size)] } else { Vec::new() };
        }
        let mut spans = Vec::new();
        let mut at = 0;
        while at < size {
            if is_name(chars[at]) && (at == 0 || !is_name(chars[at - 1])) {
                let end = skip(&chars, at, is_name);
                let name: String = chars[at..end].iter().collect();
                match if secret_name(&name) { named_value(&chars, end) } else { None } {
                    Some(found) if found.1 > found.0 => {
                        spans.push(found);
                        at = found.1;
                    }
                    _ => at = end,
                }
                continue;
            }
            at += 1;
        }
        for scheme in &r.bare_schemes {
            let len = scheme.chars().count();
            for start in 0..size.saturating_sub(len) {
                let after = start + len;
                if is_space(chars[after]) && upper(&chars[start..after]) == *scheme && (start == 0 || !is_alnum(chars[start - 1])) {
                    let value = skip(&chars, after, is_space);
                    let end = run_end(&chars, value);
                    if end > value {
                        spans.push((value, end));
                    }
                }
            }
        }
        for start in 0..size {
            if !chars[start..].starts_with(&['e', 'y', 'J']) || (start > 0 && is_jwt(chars[start - 1])) {
                continue;
            }
            let first = skip(&chars, start + 3, is_jwt);
            if !(first > start + 3 && first < size && chars[first] == '.') {
                continue;
            }
            let second = skip(&chars, first + 1, is_jwt);
            if second > first + 1 && second < size && chars[second] == '.' {
                spans.push((start, skip(&chars, second + 1, is_jwt)));
            }
        }
        spans.sort();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for span in spans {
            match merged.last_mut() {
                Some(last) if span.0 < last.1 => last.1 = last.1.max(span.1),
                _ => merged.push(span),
            }
        }
        merged
    }

    pub fn scrub_text(text: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::with_capacity(text.len());
        let mut cursor = 0;
        for (start, end) in secret_spans(text) {
            out.extend(&chars[cursor..start]);
            out.push_str(&rules().redacted);
            cursor = end;
        }
        out.extend(&chars[cursor..]);
        out
    }

    /// `value` with every secret key dropped and every string scrubbed; a container at max_depth is redacted whole.
    pub fn scrub_value(value: Value, depth: usize) -> Value {
        match value {
            Value::String(s) => Value::String(scrub_text(&s)),
            Value::Array(_) | Value::Object(_) if depth >= rules().max_depth => Value::String(rules().redacted.clone()),
            Value::Array(items) => Value::Array(items.into_iter().map(|item| scrub_value(item, depth + 1)).collect()),
            Value::Object(map) => Value::Object(map.into_iter().filter(|(key, _)| !secret_name(key))
                .map(|(key, item)| (key, scrub_value(item, depth + 1))).collect::<Map<String, Value>>()),
            scalar => scalar,
        }
    }
}

/// A detail scalar as written: null/bool/number kept, a string scrubbed, a nested structure scrubbed at every depth and
/// written as JSON -- all bounded to `limit` characters.
fn scalar_or_text(value: Value, limit: usize) -> Value {
    match value {
        Value::String(s) => Value::String(bounded(&scrub::scrub_text(&s), limit)),
        Value::Array(_) | Value::Object(_) => Value::String(bounded(&scrub::scrub_value(value, 1).to_string(), limit)),
        scalar => scalar,
    }
}

/// Detail as the ledger takes it (scalars and short scalar lists, bounded) with no secret anywhere in it: secret keys
/// are dropped at every depth and every string is scrubbed by value (config/secret_scrub.json).
fn sanitize_detail(detail: Value) -> Value {
    let c = contract();
    let mut out = Map::new();
    let mut totals = Vec::new();
    if let Value::Object(map) = detail {
        for (key, value) in map.into_iter().take(c.limits.detail_keys.get()) {
            if scrub::secret_name(&key) {
                continue;
            }
            let value = match value {
                Value::Array(items) => {
                    if items.len() > 16 {
                        totals.push((format!("{key}_total"), items.len()));
                    }
                    Value::Array(items.into_iter().take(16).map(|item| scalar_or_text(item, 128)).collect())
                }
                other => scalar_or_text(other, c.limits.string_chars.get()),
            };
            out.insert(key, value);
        }
    }
    // Never a silent cut: how many items a list had when it had more than were kept, within the key limit.
    for (key, total) in totals {
        if out.len() >= c.limits.detail_keys.get() {
            break;
        }
        out.entry(key).or_insert(Value::from(total));
    }
    Value::Object(out)
}

/// The identity of what the remediation was about; every field unknown unless set.
#[derive(Clone, Debug, Default)]
pub struct Identity {
    pub source: Option<String>,
    pub market: Option<String>,
    pub code: Option<String>,
    pub session: Option<String>,
    pub trading_date: Option<String>,
    pub view_id: Option<String>,
    pub subscription_id: Option<String>,
    pub connection_id: Option<String>,
}

impl Identity {
    fn to_value(&self) -> Value {
        let mut map = Map::new();
        let fields = [("source", &self.source), ("market", &self.market), ("code", &self.code), ("session", &self.session),
            ("trading_date", &self.trading_date), ("view_id", &self.view_id), ("subscription_id", &self.subscription_id),
            ("connection_id", &self.connection_id)];
        for field in &contract().identity_fields {
            let value = fields.iter().find(|(name, _)| name == field).and_then(|(_, v)| v.as_deref());
            map.insert(field.clone(), value.map_or(Value::Null, |v| Value::String(bounded(v, 256))));
        }
        Value::Object(map)
    }
}

/// One event, before it gets an id, a time and this process's identity.
pub struct Emit<'a> {
    pub component: &'a str,
    pub mechanism_id: &'a str,
    pub trigger_reason: &'a str,
    pub identity: Identity,
    pub attempt: Option<u64>,
    pub outcome: &'a str,
    pub detail: Value,
}

struct Loss {
    count: u64,
    since: String,
    reason: &'static str,
    last_error: Option<String>,
}

struct Queue {
    frames: VecDeque<Vec<u8>>,
    loss: Option<Loss>,
    connected: bool,
    last_error: Option<String>,
    delivered: u64,
    dropped_total: u64,
    ack_timeouts: u64,
    last_ack_at: Option<String>,
}

impl Queue {
    fn new() -> Self {
        Queue { frames: VecDeque::new(), loss: None, connected: false, last_error: None, delivered: 0, dropped_total: 0,
            ack_timeouts: 0, last_ack_at: None }
    }
}

struct Emitter {
    service_id: String,
    instance_id: String,
    pipe: Option<String>,
    queue: Mutex<Queue>,
    wake: Condvar,
}

static EMITTER: OnceLock<Emitter> = OnceLock::new();

/// Sets this process's identity and starts the delivery thread (the pipe comes from STOCK_MONITOR_REMEDIATION_PIPE,
/// which Health exports to every child). A second call is ignored.
pub fn init(service_id: &str, instance_id: &str) {
    let pipe = std::env::var(PIPE_ENV).ok().map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let created = EMITTER.set(Emitter {
        service_id: service_id.to_string(), instance_id: instance_id.to_string(), pipe: pipe.clone(),
        queue: Mutex::new(Queue::new()),
        wake: Condvar::new(),
    });
    if created.is_err() {
        return;
    }
    match pipe {
        Some(path) => {
            let _ = thread::Builder::new().name("remediation".into()).spawn(move || deliver_loop(path));
        }
        None => eprintln!("[{service_id}] {PIPE_ENV} is not set; remediation events are counted, not recorded"),
    }
}

fn record_loss(q: &mut Queue, reason: &'static str) {
    q.dropped_total += 1;
    let since = utc_iso_ms(now_ns());
    let loss = q.loss.get_or_insert(Loss { count: 0, since, reason, last_error: None });
    loss.count += 1;
    loss.reason = reason;
    if let Some(error) = &q.last_error {
        loss.last_error = Some(bounded(error, 300));
    }
}

fn build(e: &Emitter, item: &Emit, operation_id: Option<&str>, related: Option<&str>) -> Value {
    json!({
        "schema": contract().event_schema,
        "event_id": new_id(),
        "at": utc_iso_ms(now_ns()),
        "process": {"service_id": e.service_id, "instance_id": e.instance_id, "pid": std::process::id(), "runtime": "rust"},
        "component": item.component,
        "mechanism_id": item.mechanism_id,
        "trigger_reason": item.trigger_reason,
        "identity": item.identity.to_value(),
        "attempt": item.attempt,
        "outcome": item.outcome,
        "related_upstream_event_id": related,
        "operation_id": operation_id,
        "detail": sanitize_detail(item.detail.clone()),
    })
}

fn frame(event: &Value) -> Result<Vec<u8>, usize> {
    let body = serde_json::to_vec(event).unwrap_or_default();
    if body.is_empty() || body.len() > contract().limits.frame_bytes.get() {
        return Err(body.len());
    }
    let mut out = (body.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(&body);
    Ok(out)
}

fn enqueue(e: &Emitter, event: &Value) {
    let mut q = e.queue.lock().unwrap_or_else(|p| p.into_inner());
    if e.pipe.is_none() {
        record_loss(&mut q, "sink_unconfigured");
        return;
    }
    match frame(event) {
        Err(_) => record_loss(&mut q, "frame_too_large"),
        Ok(_) if q.frames.len() >= contract().limits.client_queue_events.get() => {
            let reason = if q.connected { "queue_full" } else { "sink_unreachable" };
            record_loss(&mut q, reason);
        }
        Ok(bytes) => {
            q.frames.push_back(bytes);
            e.wake.notify_all();
        }
    }
}

/// Events refused before building because the registry does not list their mechanism or trigger reason.
static REFUSED_UNREGISTERED: AtomicU64 = AtomicU64::new(0);

fn emit_with(item: &Emit, operation_id: Option<&str>, related: Option<&str>) -> Option<String> {
    let e = EMITTER.get()?;
    if let Some(reason) = unregistered(item.mechanism_id, item.trigger_reason) {
        REFUSED_UNREGISTERED.fetch_add(1, Ordering::Relaxed);
        eprintln!("[{}] remediation event refused ({}): {reason}", e.service_id, item.component);
        return None;
    }
    let event = build(e, item, operation_id, related);
    let id = event["event_id"].as_str().map(String::from);
    enqueue(e, &event);
    id
}

/// Records a one-shot remediation. Returns its event id (None when this process was never `init`ed).
pub fn emit(item: Emit) -> Option<String> {
    emit_with(&item, None, None)
}

/// One remediation that runs over time: started now, exactly one terminal outcome later.
#[derive(Debug)]
pub struct Operation {
    component: String,
    mechanism_id: String,
    trigger_reason: String,
    identity: Identity,
    operation_id: String,
    started_event: Option<String>,
    finished: bool,
}

/// Announces a remediation (outcome `started`, attempt 0) and returns the handle that records its result.
pub fn begin(component: &str, mechanism_id: &str, trigger_reason: &str, identity: Identity, detail: Value) -> Operation {
    let operation_id = new_id();
    let started_event = emit_with(&Emit { component, mechanism_id, trigger_reason, identity: identity.clone(), attempt: Some(0),
        outcome: "started", detail }, Some(&operation_id), None);
    Operation { component: component.into(), mechanism_id: mechanism_id.into(), trigger_reason: trigger_reason.into(), identity,
        operation_id, started_event, finished: false }
}

impl Operation {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn trigger_reason(&self) -> &str {
        &self.trigger_reason
    }

    /// The single terminal outcome (`succeeded`, `failed`, `abandoned`, `suppressed`); a second call is ignored.
    pub fn finish(&mut self, outcome: &str, attempt: Option<u64>, detail: Value) {
        if self.finished {
            return;
        }
        self.finished = true;
        let Some(related) = self.started_event.clone() else { return };
        emit_with(&Emit { component: &self.component, mechanism_id: &self.mechanism_id, trigger_reason: &self.trigger_reason,
            identity: self.identity.clone(), attempt, outcome, detail }, Some(&self.operation_id), Some(&related));
    }
}

/// Delivery counters of this process's emitter (for its own metrics document).
pub fn status() -> Value {
    let Some(e) = EMITTER.get() else { return json!({"configured": false, "initialized": false}) };
    let q = e.queue.lock().unwrap_or_else(|p| p.into_inner());
    json!({"configured": e.pipe.is_some(), "initialized": true, "connected": q.connected, "queued": q.frames.len(),
        "delivered": q.delivered, "dropped_total": q.dropped_total, "unreported_loss": q.loss.as_ref().map_or(0, |l| l.count),
        "last_error": q.last_error, "ack_timeouts": q.ack_timeouts, "last_ack_at": q.last_ack_at,
        "refused_unregistered": REFUSED_UNREGISTERED.load(Ordering::Relaxed)})
}

#[cfg(windows)]
mod pipe_peek {
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    extern "system" {
        fn PeekNamedPipe(pipe: *mut core::ffi::c_void, buffer: *mut core::ffi::c_void, size: u32, read: *mut u32,
            available: *mut u32, left: *mut u32) -> i32;
    }

    /// Bytes waiting in the pipe, without reading them.
    pub fn available(file: &std::fs::File) -> std::io::Result<u32> {
        let mut available = 0u32;
        // SAFETY: the handle is the open file's own; null buffer and size 0 only query the byte count.
        let ok = unsafe { PeekNamedPipe(file.as_raw_handle() as *mut _, std::ptr::null_mut(), 0, std::ptr::null_mut(),
            &mut available, std::ptr::null_mut()) };
        if ok == 0 { Err(std::io::Error::last_os_error()) } else { Ok(available) }
    }
}

/// The connection to Health's ledger pipe: a Windows named pipe opened as a file, or a Unix socket elsewhere. A
/// synchronous Windows pipe read cannot time out, so a read with a deadline first polls PeekNamedPipe.
struct Channel {
    #[cfg(windows)]
    io: std::fs::File,
    #[cfg(not(windows))]
    io: std::os::unix::net::UnixStream,
}

impl Channel {
    fn open(path: &str) -> io::Result<Self> {
        #[cfg(windows)]
        let io = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
        #[cfg(not(windows))]
        let io = std::os::unix::net::UnixStream::connect(path)?;
        Ok(Channel { io })
    }

    fn send(&mut self, frame: &[u8]) -> io::Result<()> {
        self.io.write_all(frame)?;
        self.io.flush()
    }

    fn timed_out() -> io::Error {
        io::Error::new(io::ErrorKind::TimedOut, "remediation ledger did not acknowledge in time")
    }

    /// Exactly `buf.len()` bytes, or TimedOut once `deadline` passes.
    fn read_exact_by(&mut self, buf: &mut [u8], deadline: Instant) -> io::Result<()> {
        let mut filled = 0;
        let mut pause = Duration::from_millis(1);
        while filled < buf.len() {
            let now = Instant::now();
            if now >= deadline {
                return Err(Self::timed_out());
            }
            #[cfg(windows)]
            {
                if pipe_peek::available(&self.io)? == 0 {
                    thread::sleep(pause.min(deadline - now));
                    pause = (pause * 2).min(Duration::from_millis(20));
                    continue;
                }
            }
            #[cfg(not(windows))]
            {
                let _ = &mut pause;
                self.io.set_read_timeout(Some(deadline - now))?;
            }
            let n = match self.io.read(&mut buf[filled..]) {
                Ok(n) => n,
                Err(err) if matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => return Err(Self::timed_out()),
                Err(err) => return Err(err),
            };
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "remediation ledger closed the pipe"));
            }
            filled += n;
        }
        Ok(())
    }
}

fn loss_marker(e: &Emitter, q: &mut Queue) -> Option<Vec<u8>> {
    let loss = q.loss.take()?;
    let item = Emit { component: "remediation_client", mechanism_id: "sink.client_loss", trigger_reason: loss.reason,
        identity: Identity::default(), attempt: None, outcome: "failed",
        detail: json!({"lost_events": loss.count, "lost_since": loss.since, "last_error": loss.last_error}) };
    frame(&build(e, &item, None, None)).ok()
}

fn deliver_loop(path: String) {
    let Some(e) = EMITTER.get() else { return };
    let mut backoff = Duration::from_millis(500);
    loop {
        {
            let mut q = e.queue.lock().unwrap_or_else(|p| p.into_inner());
            while q.frames.is_empty() && q.loss.is_none() {
                q = e.wake.wait(q).unwrap_or_else(|p| p.into_inner());
            }
        }
        let mut channel = match Channel::open(&path) {
            Ok(c) => c,
            Err(err) => {
                e.queue.lock().unwrap_or_else(|p| p.into_inner()).last_error = Some(format!("open {path}: {err}"));
                thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(10));
                continue;
            }
        };
        backoff = Duration::from_millis(500);
        {
            let mut q = e.queue.lock().unwrap_or_else(|p| p.into_inner());
            q.connected = true;
            if let Some(marker) = loss_marker(e, &mut q) {
                q.frames.push_front(marker);
            }
        }
        let ack_timeout = Duration::from_millis(contract().limits.client_ack_timeout_ms.get());
        let mut sent: u64 = 0;
        let result: io::Result<()> = (|| loop {
            let next = {
                let mut q = e.queue.lock().unwrap_or_else(|p| p.into_inner());
                while q.frames.is_empty() {
                    q = e.wake.wait(q).unwrap_or_else(|p| p.into_inner());
                }
                q.frames.front().cloned().unwrap_or_default()
            };
            channel.send(&next)?;
            sent += 1;
            let deadline = Instant::now() + ack_timeout;
            let mut acked = 0u64;
            while acked < sent {
                let mut buf = [0u8; 8];
                channel.read_exact_by(&mut buf, deadline)?;
                acked = u64::from_le_bytes(buf);
            }
            // Acknowledged: only now does it leave the queue (a lost connection sends it again).
            let mut q = e.queue.lock().unwrap_or_else(|p| p.into_inner());
            q.frames.pop_front();
            q.delivered += 1;
            q.last_ack_at = Some(utc_iso_ms(now_ns()));
        })();
        drop(channel);
        let mut q = e.queue.lock().unwrap_or_else(|p| p.into_inner());
        q.connected = false;
        if let Err(err) = result {
            if err.kind() == io::ErrorKind::TimedOut {
                q.ack_timeouts += 1;
            }
            q.last_error = Some(format!("pipe {path}: {err}"));
        }
        drop(q);
        thread::sleep(backoff);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_is_compiled_in_and_lists_this_crates_mechanisms() {
        assert!(registered("market.wal_tail_repair"));
        assert!(registered("analysis.a_reconnect"));
        assert!(registered("sink.client_loss"));
        assert!(!registered("not.a.mechanism"));
        assert_eq!(unregistered("market.wal_tail_repair", "unfinished_append"), None);
        assert!(unregistered("market.wal_tail_repair", "not_a_reason").is_some());
        assert!(unregistered("not.a.mechanism", "x").is_some());
    }

    #[test]
    fn a_registry_with_a_missing_field_or_a_zero_limit_is_refused() {
        let good: Value = serde_json::from_str(REGISTRY).unwrap();
        let mut zero = good.clone();
        zero["limits"]["detail_keys"] = json!(0);
        assert!(parse_contract(&zero.to_string()).is_err());
        let mut missing = good.clone();
        missing.as_object_mut().unwrap().remove("identity_fields");
        assert!(parse_contract(&missing.to_string()).is_err());
        let mut no_reasons = good.clone();
        no_reasons["mechanisms"]["sink.client_loss"]["trigger_reasons"] = json!([]);
        assert!(parse_contract(&no_reasons.to_string()).is_err());
        assert!(parse_contract(REGISTRY).is_ok());
    }

    #[test]
    fn secrets_are_found_by_the_cases_python_and_node_share() {
        let cases: Value = serde_json::from_str(include_str!("../../../tests/fixtures/secret_scrub_cases.json")).unwrap();
        for case in cases["text"].as_array().unwrap() {
            assert_eq!(scrub::scrub_text(case[0].as_str().unwrap()), case[1].as_str().unwrap(), "{case}");
        }
        for case in cases["names"].as_array().unwrap() {
            assert_eq!(scrub::secret_name(case[0].as_str().unwrap()), case[1].as_bool().unwrap(), "{case}");
        }
        for case in cases["values"].as_array().unwrap() {
            assert_eq!(scrub::scrub_value(case["in"].clone(), 0), case["scrubbed"], "{case}");
        }
        for case in cases["detail"].as_array().unwrap() {
            assert_eq!(sanitize_detail(case["in"].clone()), case["out"], "{case}");
        }
    }

    #[test]
    fn an_event_has_every_identity_field_and_no_credential_detail() {
        let e = Emitter { service_id: "market_runtime".into(), instance_id: "mr-1".into(), pipe: None,
            queue: Mutex::new(Queue::new()),
            wake: Condvar::new() };
        let item = Emit { component: "wal_scan", mechanism_id: "market.wal_tail_repair", trigger_reason: "unfinished_append",
            identity: Identity { code: Some("2330".into()), ..Identity::default() }, attempt: None, outcome: "succeeded",
            detail: json!({"segment": 7, "access_token": "x", "nested": {"a": 1}}) };
        let event = build(&e, &item, None, None);
        let identity = event["identity"].as_object().unwrap();
        assert_eq!(identity.len(), 8);
        assert_eq!(identity["code"], "2330");
        assert!(identity["source"].is_null());
        assert!(event["detail"].get("access_token").is_none());
        assert!(event["detail"]["nested"].is_string());
        assert_eq!(event["process"]["runtime"], "rust");
        assert!(event["at"].as_str().unwrap().ends_with('Z'));
        let bytes = frame(&event).unwrap();
        assert_eq!(u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize, bytes.len() - 4);
    }

    #[test]
    fn an_unconfigured_emitter_counts_what_it_cannot_deliver() {
        let e = Emitter { service_id: "t".into(), instance_id: "t-1".into(), pipe: None,
            queue: Mutex::new(Queue::new()),
            wake: Condvar::new() };
        enqueue(&e, &json!({"x": 1}));
        enqueue(&e, &json!({"x": 2}));
        let q = e.queue.lock().unwrap();
        assert_eq!(q.dropped_total, 2);
        assert_eq!(q.loss.as_ref().unwrap().count, 2);
        assert_eq!(q.loss.as_ref().unwrap().reason, "sink_unconfigured");
    }

    #[test]
    fn the_ack_deadline_is_in_the_compiled_registry() {
        assert!(contract().limits.client_ack_timeout_ms.get() >= 100);
    }

    /// A writer that took the frame and answers only part of the acknowledgement (or nothing): the read ends at the
    /// deadline as TimedOut instead of blocking; once the rest arrives a new read completes.
    #[cfg(windows)]
    #[test]
    fn an_acknowledgement_not_received_by_the_deadline_times_out() {
        use std::os::windows::io::OwnedHandle;
        let (reader, mut writer) = io::pipe().unwrap();
        let mut channel = Channel { io: std::fs::File::from(OwnedHandle::from(reader)) };
        let mut buf = [0u8; 8];
        let started = Instant::now();
        let err = channel.read_exact_by(&mut buf, Instant::now() + Duration::from_millis(80)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        writer.write_all(&7u64.to_le_bytes()).unwrap();
        channel.read_exact_by(&mut buf, Instant::now() + Duration::from_millis(500)).unwrap();
        assert_eq!(u64::from_le_bytes(buf), 7);
        drop(writer);
        let err = channel.read_exact_by(&mut buf, Instant::now() + Duration::from_millis(500)).unwrap_err();
        assert_ne!(err.kind(), io::ErrorKind::TimedOut, "a closed pipe is a disconnect, not a timeout");
    }

    #[test]
    fn ids_are_unique_and_uuid_shaped() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
    }
}
