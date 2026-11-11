//! MarketBreadth: one combined STK+OTC advance/decline figure (docs/system-architecture/01 section 3).
//!
//! Exactly one method is active, chosen by configuration -- never both summed:
//! * `computed`: classify each in-universe stock against its own previous close and keep the counts by applying
//!   the difference between an instrument's old and new class. An instrument is counted once; flat, unknown and
//!   uncovered are separate from up/down.
//! * `source`: take the counts the configured index quotes report (e.g. the TSE and OTC indices) and add them.

use crate::event::InstrumentKey;
use crate::state::SymbolState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Which one method produces the figure. An unknown name fails to parse: the settings are reported unusable,
/// never read as off.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BreadthMode {
    Computed,
    Source,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BreadthConfig {
    pub mode: BreadthMode,
    pub source: String,
    pub markets: Vec<String>,
    /// Only codes of exactly this many ASCII digits are "stocks" (4 = common shares; ETFs/warrants excluded).
    pub stock_code_digits: usize,
    /// Codes starting with any of these are not common stocks (Taiwan ETFs are 00xx).
    #[serde(default = "default_excluded_prefixes")]
    pub excluded_prefixes: Vec<String>,
    /// Size of the in-scope universe from the product catalog; None = unknown (no coverage ratio then).
    pub universe_size: Option<u64>,
    /// `source` mode: the index instruments whose reported counts are summed (wire form).
    pub index_symbols: Vec<String>,
    pub revision: Option<u64>,
}

fn default_excluded_prefixes() -> Vec<String> {
    vec!["00".into()]
}

impl Default for BreadthConfig {
    fn default() -> Self {
        Self {
            mode: BreadthMode::Source,
            source: "shioaji".into(),
            markets: vec!["STK".into(), "OTC".into()],
            stock_code_digits: 4,
            excluded_prefixes: default_excluded_prefixes(),
            universe_size: None,
            index_symbols: vec!["shioaji:IDX:TAIEX".into(), "shioaji:IDX:OTC".into()],
            revision: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Up,
    Down,
    Flat,
    Unknown,
}

#[derive(Debug, Default)]
pub struct MarketBreadth {
    pub config: BreadthConfig,
    classes: HashMap<InstrumentKey, Class>,
    up: u64,
    down: u64,
    flat: u64,
    unknown: u64,
    trading_date: String,
    index_counts: BTreeMap<String, (i64, i64, i64)>,
    pub version: u64,
}

impl MarketBreadth {
    pub fn new(config: BreadthConfig) -> Self {
        Self { config, ..Default::default() }
    }

    /// The settings revision of the configuration in force (None: the built-in default).
    pub fn revision(&self) -> Option<u64> {
        self.config.revision
    }

    pub fn configure(&mut self, config: BreadthConfig) {
        *self = Self::new(config);
        self.version = 1;
    }

    fn in_universe(&self, key: &InstrumentKey) -> bool {
        key.source == self.config.source
            && self.config.markets.iter().any(|m| m.eq_ignore_ascii_case(&key.market))
            && key.code.len() == self.config.stock_code_digits
            && key.code.bytes().all(|b| b.is_ascii_digit())
            && !self.config.excluded_prefixes.iter().any(|p| key.code.starts_with(p.as_str()))
    }

    fn classify(state: &SymbolState) -> Class {
        match (state.quote.current, state.reference.prev_close.filter(|v| *v > 0)) {
            (Some(current), Some(prev)) if current > prev => Class::Up,
            (Some(current), Some(prev)) if current < prev => Class::Down,
            (Some(_), Some(_)) => Class::Flat,
            _ => Class::Unknown,
        }
    }

    fn count(&mut self, class: Class, delta: i64) {
        let slot = match class {
            Class::Up => &mut self.up,
            Class::Down => &mut self.down,
            Class::Flat => &mut self.flat,
            Class::Unknown => &mut self.unknown,
        };
        *slot = (*slot as i64 + delta).max(0) as u64;
    }

    /// The count belongs to one trading date, in both modes: an older date's state is ignored, a newer one starts a
    /// new count: keeping the other indices' previous-day counts after a rollover could report
    /// COMPLETE on a mix of two days. False: the state belongs to an older date.
    fn enter_date(&mut self, trading_date: &str) -> bool {
        if trading_date == self.trading_date {
            return true;
        }
        if trading_date < self.trading_date.as_str() {
            return false;
        }
        self.classes.clear();
        self.up = 0;
        self.down = 0;
        self.flat = 0;
        self.unknown = 0;
        self.index_counts.clear();
        self.trading_date = trading_date.to_owned();
        self.version += 1;
        true
    }

    /// Feed one changed state. Returns true when the published figure changed.
    pub fn observe(&mut self, state: &SymbolState) -> bool {
        match self.config.mode {
            BreadthMode::Computed => {
                let key = &state.key.instrument;
                if !self.in_universe(key) || !self.enter_date(&state.key.session.trading_date) {
                    return false;
                }
                let new = Self::classify(state);
                let old = self.classes.insert(key.clone(), new);
                if old == Some(new) {
                    return false;
                }
                if let Some(old) = old {
                    self.count(old, -1);
                }
                self.count(new, 1);
                self.version += 1;
                true
            }
            BreadthMode::Source => {
                let wire = state.key.instrument.wire();
                if !self.config.index_symbols.iter().any(|s| s.eq_ignore_ascii_case(&wire)) {
                    return false;
                }
                let (Some(a), Some(d)) = (state.quote.advance_count, state.quote.decline_count) else { return false };
                let f = state.quote.flat_count.unwrap_or(0);
                let before = self.version;
                if !self.enter_date(&state.key.session.trading_date) {
                    return false;
                }
                if self.index_counts.get(&wire) == Some(&(a, d, f)) {
                    return self.version != before;
                }
                self.index_counts.insert(wire, (a, d, f));
                self.version += 1;
                true
            }
            BreadthMode::Off => false,
        }
    }

    pub fn wire(&self) -> Value {
        match self.config.mode {
            BreadthMode::Computed => {
                let covered = self.up + self.down + self.flat;
                json!({
                    "mode": "computed", "trading_date": self.trading_date, "version": self.version,
                    "advance": self.up, "decline": self.down, "flat": self.flat, "unknown": self.unknown,
                    "covered": covered, "tracked": self.classes.len(),
                    "universe": self.config.universe_size,
                    "coverage_ratio": self.config.universe_size.filter(|u| *u > 0).map(|u| covered as f64 / u as f64),
                    "markets": self.config.markets, "config_revision": self.config.revision,
                })
            }
            BreadthMode::Source => {
                let expected: BTreeSet<String> = self.config.index_symbols.iter().map(|s| s.to_uppercase()).collect();
                let reported: BTreeSet<String> = self.index_counts.keys().map(|s| s.to_uppercase()).collect();
                let (a, d, f) = self.index_counts.values().fold((0, 0, 0), |acc, v| (acc.0 + v.0, acc.1 + v.1, acc.2 + v.2));
                let complete = !self.index_counts.is_empty() && expected.is_subset(&reported);
                json!({
                    "mode": "source", "trading_date": self.trading_date, "version": self.version,
                    "advance": if self.index_counts.is_empty() { Value::Null } else { json!(a) },
                    "decline": if self.index_counts.is_empty() { Value::Null } else { json!(d) },
                    "flat": if self.index_counts.is_empty() { Value::Null } else { json!(f) },
                    "sources_reported": reported, "sources_expected": expected,
                    "completeness": if complete { "COMPLETE" } else if self.index_counts.is_empty() { "MISSING" } else { "PARTIAL" },
                    "config_revision": self.config.revision,
                })
            }
            BreadthMode::Off => json!({"mode": "off"}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{EventFlags, MarketEvent, Payload};
    use crate::state::Engine;

    /// The instrument's 昨收 (a Reference event, its one source) followed by its quote.
    fn priced(market: &str, code: &str, current: i64, prev: i64) -> [MarketEvent; 2] {
        let mut reference = quote(market, code, 1, current);
        reference.payload = Payload::Reference { limit_up: None, limit_down: None, prev_close: Some(prev), prev_volume: None,
                                                 reference_price: None, name: None, reference_source: None };
        [reference, quote(market, code, 1, current)]
    }

    fn quote(market: &str, code: &str, seq: u64, current: i64) -> MarketEvent {
        MarketEvent {
            schema_version: 2, event_id: String::new(), durable_sequence: seq,
            symbol: format!("shioaji:{market}:{code}"), provider: "shioaji".into(), market: market.into(), code: code.into(),
            session: "DAY".into(), trading_date: "2026-09-29".into(), generation: 1, sequence: seq,
            exchange_ts_ns: 1, arrival_ns: 1, a_received_ns: 1, runtime_epoch: 1, time_quality: "exchange".into(),
            trace_id: String::new(), flags: EventFlags::default(), versions: Default::default(),
            payload: Payload::Quote {
                current, open: 0, high: 0, low: 0, total_volume: 0.0, total_amount: 0.0,
                status: String::new(), minute: 570, average: 0, volume: 0.0, amount: 0.0,
                advance_count: None, decline_count: None, flat_count: None, limit_up_count: None, limit_down_count: None,
            },
        }
    }

    #[test]
    fn computed_counts_each_stock_once_by_difference_and_keeps_flat_and_unknown_apart() {
        let mut engine = Engine::default();
        let mut breadth = MarketBreadth::new(BreadthConfig { mode: BreadthMode::Computed, universe_size: Some(4), ..Default::default() });
        for [reference, event] in [
            priced("STK", "2330", 110, 100), priced("OTC", "6488", 90, 100),
            priced("STK", "2317", 100, 100), priced("STK", "0050", 120, 100),
            priced("IDX", "TAIEX", 120, 100),
        ] {
            engine.apply(&reference);
            engine.apply(&event);
            breadth.observe(engine.state(&event.state_key()).unwrap());
        }
        // 2330 flips from up to down: one move, not a second count.
        let flip = quote("STK", "2330", 2, 95);
        engine.apply(&flip);
        breadth.observe(engine.state(&flip.state_key()).unwrap());
        let w = breadth.wire();
        assert_eq!((w["advance"].as_u64(), w["decline"].as_u64(), w["flat"].as_u64()), (Some(0), Some(2), Some(1)));
        assert_eq!(w["tracked"], 3, "ETF 0050 and the index are outside the stock universe");
        assert!((w["coverage_ratio"].as_f64().unwrap() - 0.75).abs() < 1e-9);
    }

    #[test]
    fn an_unknown_mode_does_not_parse_instead_of_reading_as_off() {
        let mut values = serde_json::to_value(BreadthConfig::default()).unwrap();
        values["mode"] = json!("computd");
        let err = serde_json::from_value::<BreadthConfig>(values).unwrap_err().to_string();
        assert!(err.contains("computd"), "{err}");
    }

    #[test]
    fn source_mode_adds_the_configured_indices_and_reports_partial_until_all_report() {
        let mut engine = Engine::default();
        let mut breadth = MarketBreadth::new(BreadthConfig::default());
        let mut tse = quote("IDX", "TAIEX", 1, 20000);
        if let Payload::Quote { ref mut advance_count, ref mut decline_count, ref mut flat_count, .. } = tse.payload {
            *advance_count = Some(500);
            *decline_count = Some(300);
            *flat_count = Some(100);
        }
        engine.apply(&tse);
        breadth.observe(engine.state(&tse.state_key()).unwrap());
        assert_eq!(breadth.wire()["completeness"], "PARTIAL");
        let mut otc = quote("IDX", "OTC", 1, 250);
        if let Payload::Quote { ref mut advance_count, ref mut decline_count, .. } = otc.payload {
            *advance_count = Some(400);
            *decline_count = Some(200);
        }
        engine.apply(&otc);
        breadth.observe(engine.state(&otc.state_key()).unwrap());
        let w = breadth.wire();
        assert_eq!((w["advance"].as_i64(), w["decline"].as_i64()), (Some(900), Some(500)));
        assert_eq!(w["completeness"], "COMPLETE");

        // The next trading date's first index starts a new count -- yesterday's OTC never joins it.
        let mut next_tse = tse.clone();
        next_tse.trading_date = "2026-09-30".into();
        next_tse.sequence = 2;
        if let Payload::Quote { ref mut advance_count, .. } = next_tse.payload {
            *advance_count = Some(10);
        }
        engine.apply(&next_tse);
        assert!(breadth.observe(engine.state(&next_tse.state_key()).unwrap()));
        let w = breadth.wire();
        assert_eq!(w["trading_date"], "2026-09-30");
        assert_eq!(w["advance"].as_i64(), Some(10));
        assert_eq!(w["completeness"], "PARTIAL", "one of two indices for the new day");
        // A late state of the older date changes nothing.
        assert!(!breadth.observe(engine.state(&otc.state_key()).unwrap()));
        assert_eq!(breadth.wire()["advance"].as_i64(), Some(10));
    }
}
