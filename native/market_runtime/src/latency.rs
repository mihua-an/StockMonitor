//! Latency accounting owned by Rust A (docs/system-architecture/04 section 1, 07 section 3).
//!
//! Every stage is its own histogram with explicit endpoints; stages are never averaged together. A missing or
//! synthetic source time is counted as "unmeasured", never as a zero-latency sample, and so is an end before its
//! start -- each under its own reason, so a clock running backwards is never mistaken for a time the source left
//! out. UI endpoints are reported by the renderer and correlated here with what Rust A sent (it cannot know them in
//! advance).

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::{Duration, Instant};

/// Log-spaced buckets from 1 us to ~68 s.
const BUCKETS: usize = 64;
const SLICE: Duration = Duration::from_secs(10);
const SLICES: usize = 6;

fn bucket_of(us: u64) -> usize {
    if us <= 1 {
        return 0;
    }
    let b = ((us as f64).log2() * 2.4) as usize;
    b.min(BUCKETS - 1)
}

fn bucket_upper(b: usize) -> f64 {
    2f64.powf((b as f64 + 1.0) / 2.4)
}

#[derive(Clone)]
struct Slice {
    counts: [u64; BUCKETS],
    n: u64,
    max: u64,
    started: Instant,
}

impl Slice {
    fn new(now: Instant) -> Self {
        Self { counts: [0; BUCKETS], n: 0, max: 0, started: now }
    }
}

/// Why a stage had no sample.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unmeasured {
    /// One of the two times is not there (the source sent none, or it is synthetic).
    MissingTimestamp,
    /// Both times are there and the end is before the start: the two clocks disagree.
    NegativeInterval,
}

/// Rolling 60 s histogram in 10 s slices.
pub struct Histogram {
    slices: VecDeque<Slice>,
    /// Every unmeasured event; `missing_timestamp` + `negative_interval` add up to it.
    pub unmeasured: u64,
    pub missing_timestamp: u64,
    pub negative_interval: u64,
    pub total: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self { slices: VecDeque::from([Slice::new(Instant::now())]), unmeasured: 0, missing_timestamp: 0, negative_interval: 0, total: 0 }
    }
}

impl Histogram {
    /// Keeps only slices that started within the last 60 s: after an idle stretch every older slice is
    /// dropped, not just one, so a quiet minute never reports samples from before it.
    fn roll(&mut self, now: Instant) {
        let window = SLICE * SLICES as u32;
        while self.slices.front().is_some_and(|s| now.duration_since(s.started) >= window) {
            self.slices.pop_front();
        }
        if self.slices.back().map_or(true, |s| now.duration_since(s.started) >= SLICE) {
            self.slices.push_back(Slice::new(now));
        }
        while self.slices.len() > SLICES {
            self.slices.pop_front();
        }
    }

    pub fn record(&mut self, us: u64) {
        let now = Instant::now();
        self.roll(now);
        let slice = self.slices.back_mut().unwrap();
        slice.counts[bucket_of(us)] += 1;
        slice.n += 1;
        slice.max = slice.max.max(us);
        self.total += 1;
    }

    pub fn unmeasured(&mut self, why: Unmeasured) {
        self.unmeasured += 1;
        match why {
            Unmeasured::MissingTimestamp => self.missing_timestamp += 1,
            Unmeasured::NegativeInterval => self.negative_interval += 1,
        }
    }

    /// `end - start` when both are there and in order; otherwise counted as unmeasured with its reason.
    pub fn record_interval(&mut self, start: Option<u64>, end: Option<u64>) {
        match (start, end) {
            (Some(start), Some(end)) if end >= start => self.record(end - start),
            (Some(_), Some(_)) => self.unmeasured(Unmeasured::NegativeInterval),
            _ => self.unmeasured(Unmeasured::MissingTimestamp),
        }
    }

    fn unmeasured_reasons(&self) -> Value {
        json!({"missing_timestamp": self.missing_timestamp, "negative_interval": self.negative_interval})
    }

    pub fn summary(&mut self, start: &str, end: &str) -> Value {
        self.roll(Instant::now());
        let mut counts = [0u64; BUCKETS];
        let mut n = 0;
        let mut max = 0;
        for slice in &self.slices {
            for (i, c) in slice.counts.iter().enumerate() {
                counts[i] += c;
            }
            n += slice.n;
            max = max.max(slice.max);
        }
        let window_ms = self.slices.front().map(|s| s.started.elapsed().as_millis() as u64).unwrap_or(0);
        if n == 0 {
            return json!({"start": start, "end": end, "samples": 0, "availability": "NO_SAMPLE", "window_ms": window_ms,
                          "unmeasured": self.unmeasured, "unmeasured_reasons": self.unmeasured_reasons(), "total": self.total, "unit": "us"});
        }
        let pct = |p: f64| -> f64 {
            let target = (p * n as f64).ceil().max(1.0) as u64;
            let mut seen = 0;
            for (i, c) in counts.iter().enumerate() {
                seen += c;
                if seen >= target {
                    return bucket_upper(i).min(max as f64);
                }
            }
            max as f64
        };
        json!({"start": start, "end": end, "samples": n, "availability": "OK", "window_ms": window_ms, "unit": "us",
               "p50": pct(0.5), "p95": pct(0.95), "p99": pct(0.99), "max": max,
               "unmeasured": self.unmeasured, "unmeasured_reasons": self.unmeasured_reasons(), "total": self.total})
    }
}

/// What Rust A sent for one (symbol, version), kept briefly so a UI report can be matched to it.
#[derive(Clone, Copy)]
struct Sent {
    backend_received_us: u64,
    /// The event's exchange time, 0 when it had none (never a synthetic one).
    exchange_us: u64,
    sent_us: u64,
}

/// One source's four numbers for 系統拓樸's latency board: how late the exchange's data reaches its provider
/// (交易所延遲), provider -> Rust A (資料傳遞延遲), Rust A -> screen (畫面繪製延遲), and the whole way from the
/// exchange to the screen (整體延遲).
#[derive(Default)]
pub struct SourceLatency {
    pub exchange_to_backend: Histogram,
    pub backend_to_a: Histogram,
    pub a_to_ui_paint: Histogram,
    pub exchange_to_ui_paint: Histogram,
}

/// `shioaji:STK:2330` -> `shioaji`.
fn source_of(symbol: &str) -> String {
    symbol.split(':').next().unwrap_or_default().to_lowercase()
}

pub struct Latency {
    pub exchange_to_backend: Histogram,
    pub a_receive_to_send: Histogram,
    pub a_to_ui_paint: Histogram,
    pub backend_to_ui_paint: Histogram,
    pub projection_publish: Histogram,
    pub ui_reports: u64,
    pub ui_unmatched: u64,
    pub ui_coalesced: u64,
    pub by_source: BTreeMap<String, SourceLatency>,
    sent: HashMap<(String, u64), Sent>,
    sent_order: VecDeque<(String, u64)>,
}

impl Default for Latency {
    fn default() -> Self {
        Self {
            exchange_to_backend: Histogram::default(),
            a_receive_to_send: Histogram::default(),
            a_to_ui_paint: Histogram::default(), backend_to_ui_paint: Histogram::default(),
            projection_publish: Histogram::default(), ui_reports: 0, ui_unmatched: 0, ui_coalesced: 0,
            by_source: BTreeMap::new(), sent: HashMap::new(), sent_order: VecDeque::new(),
        }
    }
}

const SENT_CAPACITY: usize = 50_000;

impl Latency {
    /// exchange_ns: the event's own exchange time (MarketEvent::latency_exchange_ns), None when it carries none.
    pub fn on_accept(&mut self, symbol: &str, exchange_ns: Option<i64>, backend_received_ns: u64, a_received_ns: u64) {
        let source = self.by_source.entry(source_of(symbol)).or_default();
        let backend = (backend_received_ns > 0).then_some(backend_received_ns / 1000);
        source.backend_to_a.record_interval(backend, (a_received_ns > 0).then_some(a_received_ns / 1000));
        let exchange = exchange_ns.filter(|ns| *ns > 0).map(|ns| ns as u64 / 1000);
        self.exchange_to_backend.record_interval(exchange, backend);
        source.exchange_to_backend.record_interval(exchange, backend);
    }


    pub fn on_sent(&mut self, symbol: &str, version: u64, backend_received_us: u64, a_received_us: u64, exchange_us: u64, sent_us: u64) {
        let key = (symbol.to_string(), version);
        // A's own dispatch: accepted -> written to the viewers' sockets (a_received_us is a measured stage).
        self.a_receive_to_send.record_interval((a_received_us > 0).then_some(a_received_us), Some(sent_us));
        if self.sent.insert(key.clone(), Sent { backend_received_us, exchange_us, sent_us }).is_none() {
            self.sent_order.push_back(key);
        }
        while self.sent_order.len() > SENT_CAPACITY {
            if let Some(old) = self.sent_order.pop_front() {
                self.sent.remove(&old);
            }
        }
    }

    /// One UI report: {symbol, version, received_us, applied_us, painted_us?, coalesced?}. Wall-clock microseconds
    /// on both sides (same machine); a negative difference is counted as unmeasured, never recorded as zero.
    pub fn on_ui_report(&mut self, sample: &Value) {
        self.ui_reports += 1;
        if sample.get("coalesced").and_then(Value::as_u64).unwrap_or(0) > 0 {
            self.ui_coalesced += sample["coalesced"].as_u64().unwrap_or(0);
        }
        let symbol = sample.get("symbol").and_then(Value::as_str).unwrap_or_default().to_string();
        let version = sample.get("version").and_then(Value::as_u64).unwrap_or(0);
        let source = source_of(&symbol);
        let Some(sent) = self.sent.get(&(symbol, version)).copied() else {
            self.ui_unmatched += 1;
            return;
        };
        // No end reported (the frame was applied and not painted yet): nothing to count.
        let record = |hist: &mut Histogram, from: u64, to: Option<u64>| {
            if to.is_some() {
                hist.record_interval(Some(from), to);
            }
        };
        let applied = sample.get("applied_us").and_then(Value::as_u64);
        let painted = sample.get("painted_us").and_then(Value::as_u64);
        record(&mut self.a_to_ui_paint, sent.sent_us, painted);
        if sent.backend_received_us > 0 {
            record(&mut self.backend_to_ui_paint, sent.backend_received_us, painted.or(applied));
        }
        let own = self.by_source.entry(source).or_default();
        record(&mut own.a_to_ui_paint, sent.sent_us, painted);
        if sent.exchange_us > 0 {
            record(&mut own.exchange_to_ui_paint, sent.exchange_us, painted);
        } else if painted.is_some() {
            own.exchange_to_ui_paint.unmeasured(Unmeasured::MissingTimestamp);
        }
    }

    pub fn summary(&mut self) -> Value {
        json!({
            "exchange_to_backend": self.exchange_to_backend.summary("exchange_ts", "backend_received"),
            "a_receive_to_send": self.a_receive_to_send.summary("a_received", "a_sent"),
            "a_to_ui_paint": self.a_to_ui_paint.summary("a_sent", "ui_frame_proxy"),
            "backend_to_ui_paint": self.backend_to_ui_paint.summary("backend_received", "ui_frame_proxy"),
            "projection_publish": self.projection_publish.summary("analysis_as_of", "a_merged"),
            "ui_reports": self.ui_reports, "ui_unmatched": self.ui_unmatched, "ui_coalesced": self.ui_coalesced,
            // Per source (系統拓樸): 交易所延遲 / 資料傳遞延遲 / 畫面繪製延遲 / 交易所 -> 畫面 整體延遲, each with p50 / p95 / p99.
            "by_source": self.by_source.iter_mut().map(|(source, l)| (source.clone(), json!({
                "exchange_to_backend": l.exchange_to_backend.summary("exchange_ts", "backend_received"),
                "backend_to_a": l.backend_to_a.summary("backend_received", "a_received"),
                "a_to_ui_paint": l.a_to_ui_paint.summary("a_sent", "ui_frame_proxy"),
                "exchange_to_ui_paint": l.exchange_to_ui_paint.summary("exchange_ts", "ui_frame_proxy"),
            }))).collect::<serde_json::Map<String, Value>>(),
            "note": "ui_frame_proxy is a requestAnimationFrame proxy, not measured screen pixels",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_longer_than_the_window_drops_every_old_slice() {
        let mut h = Histogram::default();
        h.record(100);
        h.record(200);
        let later = Instant::now() + Duration::from_secs(75);
        h.roll(later);
        assert_eq!(h.slices.iter().map(|s| s.n).sum::<u64>(), 0, "nothing older than 60 s is left");
        assert_eq!(h.slices.len(), 1);
        h.roll(later + Duration::from_secs(25));
        assert_eq!(h.slices.len(), 2);
    }

    #[test]
    fn a_receive_to_send_is_recorded_from_the_sent_trace() {
        let mut l = Latency::default();
        l.on_sent("shioaji:STK:2330", 1, 1_000, 1_500, 0, 2_000);
        l.on_sent("shioaji:STK:2330", 2, 1_000, 0, 0, 2_000);
        let s = l.summary();
        assert_eq!(s["a_receive_to_send"]["samples"], 1);
        assert_eq!(s["a_receive_to_send"]["unmeasured"], 1);
    }

    #[test]
    fn missing_or_synthetic_times_are_unmeasured_not_zero() {
        let mut l = Latency::default();
        l.on_accept("shioaji", None, 5_000_000, 6_000_000);
        l.on_accept("shioaji", None, 2_000_000, 3_000_000);
        let s = l.summary();
        assert_eq!(s["exchange_to_backend"]["samples"], 0);
        assert_eq!(s["exchange_to_backend"]["unmeasured"], 2);
        assert_eq!(s["exchange_to_backend"]["unmeasured_reasons"], json!({"missing_timestamp": 2, "negative_interval": 0}));
        assert_eq!(s["by_source"]["shioaji"]["backend_to_a"]["samples"], 2, "provider->A is Rust A's own measurement and valid, per source");
    }

    #[test]
    fn ui_reports_correlate_with_what_was_sent_and_refuse_negative_differences() {
        let mut l = Latency::default();
        l.on_sent("shioaji:STK:2330", 7, 1_000, 1_500, 0, 2_000);
        l.on_ui_report(&json!({"symbol": "shioaji:STK:2330", "version": 7, "applied_us": 2_600, "painted_us": 3_000}));
        l.on_ui_report(&json!({"symbol": "shioaji:STK:2330", "version": 8, "applied_us": 9}));
        l.on_ui_report(&json!({"symbol": "shioaji:STK:2330", "version": 7, "applied_us": 100}));
        let s = l.summary();
        assert_eq!(s["a_to_ui_paint"]["samples"], 1);
        assert_eq!(s["backend_to_ui_paint"]["max"], 2_000);
        assert_eq!(s["ui_unmatched"], 1);
        assert_eq!(s["backend_to_ui_paint"]["unmeasured"], 1, "backend->paint (falling back to applied) refused the negative difference");
        assert_eq!(s["backend_to_ui_paint"]["unmeasured_reasons"]["negative_interval"], 1);
    }

    #[test]
    fn a_clock_running_backwards_and_a_missing_time_are_counted_apart_in_total_and_per_source() {
        let mut l = Latency::default();
        l.on_accept("futu:US:AAPL", Some(2_000_000_000), 1_000_000_000, 1_001_000_000);   // exchange after the provider got it
        l.on_accept("futu:US:AAPL", None, 1_000_000_000, 1_001_000_000);
        l.on_accept("futu:US:AAPL", Some(1_000_000_000), 1_000_000_000, 900_000_000);     // A before the provider
        let s = l.summary();
        assert_eq!(s["exchange_to_backend"]["unmeasured"], 2);
        assert_eq!(s["exchange_to_backend"]["unmeasured_reasons"], json!({"missing_timestamp": 1, "negative_interval": 1}));
        let futu = &s["by_source"]["futu"];
        assert_eq!(futu["exchange_to_backend"]["unmeasured_reasons"], json!({"missing_timestamp": 1, "negative_interval": 1}));
        assert_eq!(futu["exchange_to_backend"]["samples"], 1);
        assert_eq!(futu["backend_to_a"]["unmeasured_reasons"], json!({"missing_timestamp": 0, "negative_interval": 1}));
    }

    #[test]
    fn each_source_has_its_exchange_render_and_total_latency() {
        let mut l = Latency::default();
        l.on_accept("futu", Some(1_000_000_000), 1_050_000_000, 1_051_000_000);
        l.on_accept("shioaji", Some(1_000_000_000), 1_020_000_000, 1_021_000_000);
        l.on_sent("futu:US:AAPL", 3, 1_050_000, 1_051_000, 1_000_000, 1_052_000);
        l.on_ui_report(&json!({"symbol": "futu:US:AAPL", "version": 3, "applied_us": 1_060_000, "painted_us": 1_070_000}));
        l.on_sent("shioaji:STK:2330", 9, 1_020_000, 1_021_000, 0, 1_022_000);
        l.on_ui_report(&json!({"symbol": "shioaji:STK:2330", "version": 9, "applied_us": 1_030_000, "painted_us": 1_040_000}));
        let s = l.summary();
        let futu = &s["by_source"]["futu"];
        assert_eq!(futu["exchange_to_backend"]["max"], 50_000);
        assert_eq!(futu["a_to_ui_paint"]["max"], 18_000);
        assert_eq!(futu["exchange_to_ui_paint"]["max"], 70_000, "exchange -> screen is the whole way");
        let shioaji = &s["by_source"]["shioaji"];
        assert_eq!(shioaji["exchange_to_backend"]["max"], 20_000);
        assert_eq!(shioaji["exchange_to_ui_paint"]["samples"], 0);
        assert_eq!(shioaji["exchange_to_ui_paint"]["unmeasured"], 1, "a missing exchange time is never a zero");
    }

    #[test]
    fn percentiles_are_ordered() {
        let mut h = Histogram::default();
        for us in 1..=1000 {
            h.record(us);
        }
        let s = h.summary("a", "b");
        assert!(s["p50"].as_f64().unwrap() <= s["p95"].as_f64().unwrap());
        assert!(s["p95"].as_f64().unwrap() <= s["p99"].as_f64().unwrap());
        assert!(s["p99"].as_f64().unwrap() <= 1000.0);
    }
}
