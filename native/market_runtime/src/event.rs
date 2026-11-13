//! Raw market event contract v2 (docs/system-architecture/03 section 2).
//!
//! One event type for the WAL, the durable stream and every consumer. Only the current format is read: a record of
//! an older one (no `schema_version`, identity only in `symbol`, a derived row, a calendar-day FUT partition, a
//! provider-written source_status) is refused by [`MarketEvent::decode_value`] / [`MarketEvent::decode_slice`] /
//! [`MarketEvent::refusal`] and the caller records it; nothing converts it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const EVENT_SCHEMA_VERSION: u32 = 2;
/// The `schema` a provider's ingest envelope names (config/system_contract.json `event.schema`).
pub const INGEST_SCHEMA: &str = "market-event-v2";
/// Prices and money are integers in 1/10_000 units on every boundary. Volumes are decimal quantities (crate::volume).
pub const PRICE_SCALE: i64 = 10_000;

/// One book level as the source states it: a price and its volume, nothing derived. Each level's change is Market
/// Runtime's (state::BookRow), never the source's.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BookLevel {
    pub price: i64,
    /// A decimal quantity (crate::volume): Futu reports fractional US shares.
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Payload {
    /// A quote or a print never carries 昨收: the Reference event is its one source (see Reference below).
    Quote {
        current: i64,
        open: i64,
        high: i64,
        low: i64,
        total_volume: f64,
        total_amount: f64,
        status: String,
        minute: i32,
        average: i64,
        volume: f64,
        amount: f64,
        #[serde(default)]
        advance_count: Option<i64>,
        #[serde(default)]
        decline_count: Option<i64>,
        #[serde(default)]
        flat_count: Option<i64>,
        #[serde(default)]
        limit_up_count: Option<i64>,
        #[serde(default)]
        limit_down_count: Option<i64>,
    },
    Trade {
        price: i64,
        volume: f64,
        total_volume: f64,
        side: i8,
        trade_id: String,
        minute: i32,
        open: i64,
        high: i64,
        low: i64,
        average: i64,
        total_amount: f64,
        amount: f64,
        /// Indicative call-auction match (Shioaji `simtrade`): forwarded, never aggregated.
        #[serde(default)]
        simtrade: bool,
        /// The producer's cumulative 內外盤 volumes: source data kept as received; no view reads them (the order
        /// book's 內外盤比 is Rust B's per-print direction, user 11-01).
        #[serde(default)]
        bid_side_total_vol: Option<f64>,
        #[serde(default)]
        ask_side_total_vol: Option<f64>,
        /// Matched by a call auction (opening, closing, an intraday 緩漲緩跌 / 處置股 match): one price for the whole
        /// book, nobody's aggressive order -- 不分內外盤, never 大單 (user 10-20). Set by Market Runtime at ingest
        /// (Engine::classify_print), stored with the event; the producer's tick_type stays in `side` as it came.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        auction: bool,
        /// A 盤後定價 print (TW stocks, 14:30): kept on the tape and in history, never in intraday figures
        /// (現價, 總量, 內外盤). Set by Market Runtime at ingest like `auction`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        after_hours: bool,
        /// The source's sale condition as it came (Futu TickerType: AUTO_MATCH, ODD_LOT, AVERAGE_PRICE...); None when
        /// the source names none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        condition: Option<String>,
        /// A print whose condition does not set the last sale (state::condition_sets_no_last_sale: odd lot, average
        /// price, prior reference price...): on the tape, in history and in volume, never in 現價, the high / low,
        /// the trend line or a bar's prices, 不分內外盤, never 大單, 價量 or a paper fill. Set by Market Runtime at
        /// ingest (Engine::classify_print) like `auction`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        no_last_sale: bool,
    },
    OrderBook {
        bids: Vec<BookLevel>,
        asks: Vec<BookLevel>,
        /// Call-auction book (Shioaji BidAskSTKv1.simtrade): an intraday 緩漲緩跌 or the closing auction. Absent = false.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        simtrade: bool,
    },
    /// An authoritative source minute bar (broker bar push or a backfill). For one instrument/minute exactly one
    /// volume authority is chosen by Rust B; a cumulative source bar replaces, it is never added again.
    MinuteBar {
        minute: i32,
        open: i64,
        high: i64,
        low: i64,
        close: i64,
        average: i64,
        volume: f64,
        amount: f64,
    },
    /// Low-frequency reference facts. Never hot-path quote activity. A missing field never erases a known one. The
    /// only carrier of 昨收 / 參考價: every reader applies it with state::Reference::absorb.
    Reference {
        #[serde(default)]
        limit_up: Option<i64>,
        #[serde(default)]
        limit_down: Option<i64>,
        #[serde(default)]
        prev_close: Option<i64>,
        #[serde(default)]
        prev_volume: Option<f64>,
        /// Futures compare against the contract's own reference (settlement), not necessarily prev_close.
        #[serde(default)]
        reference_price: Option<i64>,
        #[serde(default)]
        name: Option<String>,
        /// Where `reference_price` came from (TXF: `shioaji.quote.close_minus_price_chg`); the renderer only uses a
        /// futures reference whose source it recognises.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reference_source: Option<String>,
    },
    /// Source connectivity/coverage transitions (connected, disconnected, resubscribed, gap). Persisted so a replay
    /// reproduces exactly which minutes were unobserved rather than traded-with-zero-volume.
    SourceStatus {
        state: String,
        #[serde(default)]
        detail: String,
    },
    /// Market clock advance written by Rust A: exchange time of this market/session has reached the START of
    /// `minute`. Lets Rust B close minutes that had no trade, identically live and on replay.
    Clock {
        minute: i32,
    },
}

impl Payload {
    /// Per-kind fence key: sequences are monotonic per (state, kind).
    pub fn stream_key(&self) -> &'static str {
        match self {
            Self::Quote { .. } => "quote",
            Self::Trade { .. } => "trade",
            Self::OrderBook { .. } => "orderbook",
            Self::MinuteBar { .. } => "minute_bar",
            Self::Reference { .. } => "reference",
            Self::SourceStatus { .. } => "source_status",
            Self::Clock { .. } => "clock",
        }
    }
}

/// Payload kinds of derived rows an older WAL layout carried in the raw stream. Refused as an older format.
const RETIRED_PAYLOAD_KINDS: [&str; 2] = ["analysis_signals", "monitor_event"];

/// Backfill/integrity marks carried with a raw event.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct EventFlags {
    /// Fetched from the broker's history after the fact: the minutes before a late join, or the prints a provider
    /// restart missed (its gap, filled by the successor). Valid only strictly before `backfill_cutoff_ns`, where the
    /// live stream took over.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub backfill: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backfill_cutoff_ns: Option<i64>,
    /// A closed session's print fetched only so a view has something to show: never written, whether or not the code
    /// is on the background list and whether or not its session is sealed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub view_only: bool,
    /// The source says this record is incomplete (e.g. a snapshot bar missing O/H/L).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
    /// Events of this instrument the producer dropped (its ingress queue was full) just before this one. Producer
    /// sequence spaces differ per source, so a hole cannot be inferred here; the producer states it.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub gap_before: u64,
    /// The producer says the event's exchange time is a label, not the moment it happened: Futu's quote (its
    /// last-update second) and minute bar (its minute). It still files the event; it is not a latency start.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub time_label: bool,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

/// Typed instrument identity: source + market/venue + code. The `source:MARKET:CODE` string exists only at edges.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub struct InstrumentKey {
    pub source: String,
    pub market: String,
    pub code: String,
}

impl InstrumentKey {
    pub fn new(source: &str, market: &str, code: &str) -> Self {
        Self { source: source.trim().to_lowercase(), market: market.trim().to_uppercase(), code: code.trim().to_uppercase() }
    }
    /// The edge form `source:MARKET:CODE`, all three present. Anything else names no instrument (None).
    pub fn parse(wire: &str) -> Option<Self> {
        let mut parts = wire.splitn(3, ':');
        let (source, market, code) = (parts.next()?, parts.next()?, parts.next()?);
        let key = Self::new(source, market, code);
        (!key.source.is_empty() && !key.market.is_empty() && !key.code.is_empty()).then_some(key)
    }
    pub fn wire(&self) -> String {
        format!("{}:{}:{}", self.source, self.market, self.code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub struct SessionKey {
    pub trading_date: String,
    pub session: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub struct StateKey {
    pub instrument: InstrumentKey,
    pub session: SessionKey,
}

/// The scope a market clock applies to: every instrument of one source/market/session/date.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub struct ClockScope {
    pub source: String,
    pub market: String,
    pub trading_date: String,
    pub session: String,
}

pub const CLOCK_CODE: &str = "*";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MarketEvent {
    /// Always EVENT_SCHEMA_VERSION; a record with another is refused (`refusal`).
    pub schema_version: u32,
    /// Resend-stable identity from the source.
    #[serde(default)]
    pub event_id: String,
    /// Rust-assigned global accept order. Producers send zero.
    #[serde(default)]
    pub durable_sequence: u64,
    /// Edge form `source:MARKET:CODE`; identity is `instrument()` (provider, market, code).
    pub symbol: String,
    pub provider: String,
    pub market: String,
    pub code: String,
    pub session: String,
    pub trading_date: String,
    pub generation: u64,
    pub sequence: u64,
    pub exchange_ts_ns: i64,
    /// Backend callback receive time (epoch ns), from the provider.
    #[serde(default)]
    pub arrival_ns: u64,
    /// Rust A accept time (epoch ns).
    #[serde(default)]
    pub a_received_ns: u64,
    /// Rust A process incarnation that accepted this event.
    #[serde(default)]
    pub runtime_epoch: u64,
    /// exchange | backend_clock | synthetic | missing -- a missing or synthetic time is never a zero latency.
    #[serde(default)]
    pub time_quality: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub trace_id: String,
    #[serde(default, skip_serializing_if = "is_default_flags")]
    pub flags: EventFlags,
    /// Calendar / rule / config versions needed to rebuild from this event.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub versions: BTreeMap<String, String>,
    pub payload: Payload,
}

fn is_default_flags(flags: &EventFlags) -> bool {
    *flags == EventFlags::default()
}

/// Why a record is not taken as a market event. Either way it is never applied; the caller counts and logs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// A record of a format the current one replaced. Never converted (pre-launch data is disposable): refused.
    OldFormat(String),
    /// Not a current event at all: broken, or written by a newer build.
    Undecodable(String),
}

impl Refused {
    pub fn reason(&self) -> &str {
        match self {
            Self::OldFormat(reason) | Self::Undecodable(reason) => reason,
        }
    }
    pub fn is_old_format(&self) -> bool {
        matches!(self, Self::OldFormat(_))
    }
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OldFormat(reason) => write!(f, "OLD_FORMAT: {reason}"),
            Self::Undecodable(reason) => write!(f, "UNDECODABLE: {reason}"),
        }
    }
}

impl MarketEvent {
    /// The exchange time of THIS event, for latency: when it happened at the exchange. A time the producer marks
    /// as a label (flags.time_label: Futu's quote last-update second, its bar's minute) is not: measuring from it
    /// reads the label's age -- a bar of the minute still running is "in the future", one re-sent for an earlier
    /// minute "minutes late" (Futu 交易所延遲 P95 106 s on 10-16). Which events carry a label is the producer's to say:
    /// a Shioaji TXF quote is a single print with its own time, and is the only Shioaji event at night (10-19).
    pub fn latency_exchange_ns(&self) -> Option<i64> {
        (self.time_quality == "exchange" && !self.flags.time_label && self.exchange_ts_ns > 0).then_some(self.exchange_ts_ns)
    }

    /// A stored or received record as a current event. The typed decode runs first; only a record it refuses is
    /// looked at as a tree, to say whether it is an older format or simply broken.
    pub fn decode_slice(bytes: &[u8]) -> Result<Self, Refused> {
        match serde_json::from_slice::<MarketEvent>(bytes) {
            Ok(event) => event.checked(),
            Err(error) => match serde_json::from_slice::<Value>(bytes) {
                Ok(value) => Err(Self::classify(&value, error)),
                Err(_) => Err(Refused::Undecodable(error.to_string())),
            },
        }
    }

    pub fn decode_value(value: &Value) -> Result<Self, Refused> {
        match MarketEvent::deserialize(value) {
            Ok(event) => event.checked(),
            Err(error) => Err(Self::classify(value, error)),
        }
    }

    fn checked(self) -> Result<Self, Refused> {
        match self.refusal() {
            Some(refused) => Err(refused),
            None => Ok(self),
        }
    }

    /// A record serde could not type: an older format when it names one (no or an older schema_version, identity only
    /// in `symbol`, a retired derived kind), otherwise undecodable.
    fn classify(value: &Value, error: serde_json::Error) -> Refused {
        match value.get("schema_version").and_then(Value::as_u64) {
            None => return Refused::OldFormat("no schema_version (event schema 1)".into()),
            Some(v) if v < EVENT_SCHEMA_VERSION as u64 => return Refused::OldFormat(format!("event schema {v}; only {EVENT_SCHEMA_VERSION} is read")),
            Some(v) if v > EVENT_SCHEMA_VERSION as u64 => return Refused::Undecodable(format!("event schema {v} is newer than {EVENT_SCHEMA_VERSION}")),
            Some(_) => {}
        }
        let text = |field: &str| value.get(field).and_then(Value::as_str).map(str::trim).unwrap_or_default();
        if text("market").is_empty() || text("code").is_empty() {
            return Refused::OldFormat(format!("no market/code (identity only in symbol {:?})", text("symbol")));
        }
        let kind = value.get("payload").and_then(|p| p.get("kind")).and_then(Value::as_str).unwrap_or_default();
        if RETIRED_PAYLOAD_KINDS.contains(&kind) {
            return Refused::OldFormat(format!("derived {kind} row in the raw stream"));
        }
        Refused::Undecodable(error.to_string())
    }

    /// Why this typed record is not a current event (None: it is). Rust A applies it to what it accepts too.
    pub fn refusal(&self) -> Option<Refused> {
        if self.schema_version > EVENT_SCHEMA_VERSION {
            return Some(Refused::Undecodable(format!("event schema {} is newer than {EVENT_SCHEMA_VERSION}", self.schema_version)));
        }
        if self.schema_version != EVENT_SCHEMA_VERSION {
            return Some(Refused::OldFormat(format!("event schema {}; only {EVENT_SCHEMA_VERSION} is read", self.schema_version)));
        }
        if self.provider.trim().is_empty() || self.market.trim().is_empty() || self.code.trim().is_empty() {
            return Some(Refused::OldFormat(format!("no provider/market/code (identity only in symbol {:?})", self.symbol)));
        }
        if is_session_partitioned(&self.provider, &self.market)
            && !self.session.eq_ignore_ascii_case("DAY") && !self.session.eq_ignore_ascii_case("NIGHT") {
            return Some(Refused::OldFormat(format!("{} {} partition {:?}: FUT is stored per DAY / NIGHT session",
                self.provider, self.market, self.session)));
        }
        if let Payload::SourceStatus { state, .. } = &self.payload {
            let control = (self.time_quality == COVERAGE_CONTROL && (state == COVERAGE_SUBSCRIBED || state == COVERAGE_UNSUBSCRIBED))
                || (self.time_quality == LOSS_CONTROL && state == SOURCE_GAP);
            if !control {
                return Some(Refused::OldFormat(format!("source_status {state:?} with time quality {:?}: only Market Runtime's coverage \
                    and loss records are", self.time_quality)));
            }
        }
        None
    }

    pub fn instrument(&self) -> InstrumentKey {
        InstrumentKey::new(&self.provider, &self.market, &self.code)
    }
    pub fn session_key(&self) -> SessionKey {
        SessionKey { trading_date: self.trading_date.clone(), session: self.session.clone() }
    }
    pub fn state_key(&self) -> StateKey {
        StateKey { instrument: self.instrument(), session: self.session_key() }
    }
    pub fn clock_scope(&self) -> ClockScope {
        ClockScope {
            source: self.provider.trim().to_lowercase(),
            market: self.market.trim().to_uppercase(),
            trading_date: self.trading_date.clone(),
            session: self.session.trim().to_uppercase(),
        }
    }
    pub fn is_clock(&self) -> bool {
        matches!(self.payload, Payload::Clock { .. })
    }
    /// 試撮 (call-auction indicative) data -- a simtrade print or a futures quote marked simulated.
    pub fn is_indicative(&self) -> bool {
        match &self.payload {
            Payload::Trade { simtrade, .. } | Payload::OrderBook { simtrade, .. } => *simtrade,
            Payload::Quote { status, .. } => matches!(status.as_str(), "simulated" | "simtrade"),
            _ => false,
        }
    }
    /// Before the market opens: stock 08:30-09:00, futures 08:30-08:45 (day) and 14:50-15:00 (night).
    pub fn is_preopen(&self) -> bool {
        preopen_at(&self.market, self.exchange_ts_ns)
    }
    /// 盤前試撮 is shown live but never stored (user rule). An intraday 緩漲緩跌 auction and the 13:25
    /// closing auction ARE stored, flagged: only the pre-open indicative data is dropped.
    pub fn is_preopen_indicative(&self) -> bool {
        self.is_indicative() && self.is_preopen()
    }
}

/// `time_quality` of a subscription-coverage record. Coverage is a control fact Market Runtime writes
/// from what a provider's broker confirmed, never a market event: it carries A's clock, is dated to the calendar's
/// current-or-next business session, and creates no instrument state or session anywhere. A `source_status` record
/// with any other time quality is of an older layout (provider-written, wall-clock partitions): refused.
pub const COVERAGE_CONTROL: &str = "coverage_control";
pub const COVERAGE_SUBSCRIBED: &str = "subscribed";
pub const COVERAGE_UNSUBSCRIBED: &str = "unsubscribed";

/// `time_quality` of a loss record: Market Runtime's durable statement that the source dropped events of an
/// instrument, written where it dropped the print that said so (a re-sent print carrying `flags.gap_before`, which
/// is never stored). Its state is SOURCE_GAP, its count `flags.gap_before`, its identity and exchange time the
/// dropped print's. It moves no market figure: B and the history mark the partition's minute as missing events,
/// exactly as the gap on a stored print does. Unlisted instruments get it over the live lane, like their prints.
pub const LOSS_CONTROL: &str = "loss_control";
pub const SOURCE_GAP: &str = "source_gap";

/// Whether an exchange time falls before a market's open: stock 08:30-09:00, futures 08:30-08:45 (day) and
/// 14:50-15:00 (night). A missing time is never pre-open.
pub fn preopen_at(market: &str, ts_ns: i64) -> bool {
    let Some((_, minute)) = market_local_minute(market, ts_ns) else { return false };
    match market {
        "STK" | "IDX" => (480..540).contains(&minute),
        "FUT" => (480..525).contains(&minute) || (840..900).contains(&minute),
        _ => false,
    }
}

// ------------------------------------------------------------------------------ futures session partitions
//
// Shioaji FUT (TXFR1) is stored per business session, never per calendar day: DAY is 08:45-13:45 of
// its own date; NIGHT is 15:00 -> 05:00 dated by the day it OPENS, its minutes continuing past midnight at 1440
// (00:00 = 1440, 05:00 = 1740). One session is one partition: nothing is split at midnight and nothing is stored
// twice. 全日 is a reading of a NIGHT and the next business DAY, never a partition. Market Runtime is the one judge
// of every partition's identity (decisions: 分區身分與分區完整性紀錄的擁有者): it names an ingested event's partition and
// minute from the exchange time ([`wal_partition`]); a provider names none. A record of any other FUT session is
// refused (`MarketEvent::refusal`).

/// The first local minute that belongs to a futures DAY partition rather than to the night before (06:00), and
/// the first that belongs to the night that opens that day (14:30). Both lie in gaps between sessions.
const FUT_DAY_FROM: i32 = 6 * 60;
const FUT_NIGHT_FROM: i32 = 14 * 60 + 30;
/// A NIGHT minute below this is past midnight (the night opens at 15:00).
pub const NIGHT_OPEN_MINUTE: i32 = 15 * 60;

/// The source a market's events come from, for a request that names none.
pub fn source_for_market(market: &str) -> &'static str {
    match market.to_ascii_uppercase().as_str() {
        "STK" | "ODD" | "OTC" | "TW" | "IDX" | "INDEX" | "FUT" | "FUTURES" => "shioaji",
        _ => "futu",
    }
}

pub fn is_session_partitioned(provider: &str, market: &str) -> bool {
    provider.eq_ignore_ascii_case("shioaji") && market.eq_ignore_ascii_case("FUT")
}

/// The one WAL session of a market that is not partitioned per business session: Shioaji stocks and indices `DAY`,
/// every Futu market `FULL`. A session-partitioned market (shioaji FUT) has none: its event time decides.
pub fn single_session(provider: &str, market: &str) -> Option<&'static str> {
    if is_session_partitioned(provider, market) {
        return None;
    }
    Some(if provider.eq_ignore_ascii_case("shioaji") { "DAY" } else { "FULL" })
}

/// Every WAL session a market's partitions can carry.
pub fn wal_sessions(provider: &str, market: &str) -> &'static [&'static str] {
    match single_session(provider, market) {
        None => &["DAY", "NIGHT"],
        Some("DAY") => &["DAY"],
        Some(_) => &["FULL"],
    }
}

/// (trading date, session, partition minute) of the partition an event with this exchange time belongs to: Shioaji
/// FUT its business session ([`futures_partition`]), every other market the exchange-local calendar date, its single
/// session and the minute of day. None without an exchange time: arrival or wall-clock time never names a partition.
pub fn wal_partition(provider: &str, market: &str, ts_ns: i64) -> Option<(String, &'static str, i32)> {
    match single_session(provider, market) {
        None => futures_partition(ts_ns),
        Some(session) => market_local_minute(market, ts_ns).map(|(date, minute)| (date, session, minute)),
    }
}

/// (partition date, session, partition minute) of a shioaji FUT timestamp.
pub fn futures_partition(ts_ns: i64) -> Option<(String, &'static str, i32)> {
    let (date, minute) = market_local_minute("FUT", ts_ns)?;
    Some(if minute < FUT_DAY_FROM {
        (shift_date(&date, -1), "NIGHT", minute + 1440)
    } else if minute < FUT_NIGHT_FROM {
        (date, "DAY", minute)
    } else {
        (date, "NIGHT", minute)
    })
}

/// (partition date, partition minute) of a timestamp read in a partition of `session`: a FUT NIGHT names
/// its post-midnight minutes from the day it opened; everything else is the exchange-local date and minute of day.
pub fn partition_local_minute(provider: &str, market: &str, session: &str, ts_ns: i64) -> Option<(String, i32)> {
    let (date, minute) = market_local_minute(market, ts_ns)?;
    if is_session_partitioned(provider, market) && session.eq_ignore_ascii_case("NIGHT") && minute < FUT_DAY_FROM {
        return Some((shift_date(&date, -1), minute + 1440));
    }
    Some((date, minute))
}

/// A strictly written `YYYY-MM-DD` moved by `days`; None for anything else. The one validated date shift.
pub fn checked_shift_date(date: &str, days: i64) -> Option<String> {
    let (y, m, d) = parse_calendar_date(date)?;
    let (y, m, d) = civil_from_days(days_from_civil(y, m, d) + days);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// A real calendar date in exactly `YYYY-MM-DD` form, or None ("month 1-12, day 1-31" would let 2026-02-31 through,
/// silently normalized to March 3rd). The day must exist in its month, leap years included.
pub fn parse_calendar_date(date: &str) -> Option<(i64, i64, i64)> {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit()) {
        return None;
    }
    let (y, m, d) = (date[0..4].parse::<i64>().ok()?, date[5..7].parse::<i64>().ok()?, date[8..10].parse::<i64>().ok()?);
    if !(1..=12).contains(&m) || d < 1 || civil_from_days(days_from_civil(y, m, d)) != (y, m, d) {
        return None;
    }
    Some((y, m, d))
}

/// `date` (YYYY-MM-DD) moved by whole days. For dates this runtime wrote itself; input from outside goes through
/// [`checked_shift_date`].
pub fn shift_date(date: &str, days: i64) -> String {
    let mut parts = date.split('-').filter_map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next().unwrap_or(1970), parts.next().unwrap_or(1), parts.next().unwrap_or(1));
    let (y, m, d) = civil_from_days(days_from_civil(y, m, d) + days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Minute of day (exchange clock) and the exchange-local civil date of an epoch-ns timestamp.
/// Taiwan/HK/China UTC+8 without DST; US New York with DST; crypto on New York's day too (like the US stocks it is
/// compared with, and the day the CC cache is cleared on, rollover::clears) -- same table as MARKET_TIMEZONES in
/// service/market/shared/session_identity_contract.py.
pub fn market_local_minute(market: &str, ts_ns: i64) -> Option<(String, i32)> {
    if ts_ns <= 0 {
        return None;
    }
    let secs = ts_ns.div_euclid(1_000_000_000);
    let offset_s = market_offset_seconds(market, secs);
    let local = secs + offset_s;
    let days = local.div_euclid(86_400);
    let minute = (local.rem_euclid(86_400) / 60) as i32;
    let (y, m, d) = civil_from_days(days);
    Some((format!("{y:04}-{m:02}-{d:02}"), minute))
}

pub fn market_offset_seconds(market: &str, utc_secs: i64) -> i64 {
    match market.to_ascii_uppercase().as_str() {
        "US" | "CC" => {
            let (y, _, _) = civil_from_days(utc_secs.div_euclid(86_400));
            // DST: second Sunday of March 02:00 local (07:00 UTC) -> first Sunday of November 02:00 local (06:00 UTC).
            let start = days_from_civil(y, 3, nth_sunday(y, 3, 2)) * 86_400 + 7 * 3600;
            let end = days_from_civil(y, 11, nth_sunday(y, 11, 1)) * 86_400 + 6 * 3600;
            if utc_secs >= start && utc_secs < end {
                -4 * 3600
            } else {
                -5 * 3600
            }
        }
        _ => 8 * 3600,
    }
}

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn nth_sunday(y: i64, m: i64, n: i64) -> i64 {
    let first = days_from_civil(y, m, 1);
    let dow = (first + 4).rem_euclid(7);
    1 + (7 - dow).rem_euclid(7) + 7 * (n - 1)
}

/// The UTC offset in force at a wall-clock time (`local`: seconds since the epoch read as the market's local time).
/// The offset is looked up at the instant the standard offset gives, then again at the instant that one gives, so a
/// time on a DST change day gets the offset of its own instant, not the one of the same digits read as UTC.
pub fn local_offset_seconds(market: &str, local: i64) -> i64 {
    let guess = local - market_offset_seconds(market, local);
    market_offset_seconds(market, guess)
}

/// The instant (epoch ns) of a market-local minute of a calendar date. A minute past 1440 (a futures NIGHT after
/// midnight, a partition's end at 24:00) is on the following day. None for a date that is not one.
pub fn local_minute_ns(market: &str, trading_date: &str, minute: i32) -> Option<i64> {
    let (y, m, d) = parse_calendar_date(trading_date)?;
    let local = days_from_civil(y, m, d) * 86_400 + i64::from(minute) * 60;
    Some((local - local_offset_seconds(market, local)) * 1_000_000_000)
}

/// The side a print shows on the tape: a call-auction match, a 盤後定價 print and a print that sets no last sale
/// (an odd lot, an average-price print) are 不分內外盤 -- the broker's tick_type kept in `side` is only the price move.
pub fn tape_side(side: i8, auction: bool, after_hours: bool, no_last_sale: bool) -> i8 {
    if auction || after_hours || no_last_sale { 0 } else { side.signum() }
}

/// ISO-8601 local timestamp of a market minute, with the market's own offset.
pub fn minute_timestamp(market: &str, trading_date: &str, minute: i32) -> String {
    // A minute past 1440 (a futures NIGHT after midnight) is on the following day(s).
    let (trading_date, minute) = if minute >= 1440 {
        (shift_date(trading_date, (minute / 1440) as i64), minute % 1440)
    } else {
        (trading_date.to_string(), minute)
    };
    let trading_date = trading_date.as_str();
    let mut parts = trading_date.split('-').filter_map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next().unwrap_or(1970), parts.next().unwrap_or(1), parts.next().unwrap_or(1));
    let local = days_from_civil(y, m, d) * 86_400 + (minute as i64) * 60;
    let offset = local_offset_seconds(market, local);
    let sign = if offset < 0 { '-' } else { '+' };
    let abs = offset.abs();
    format!("{trading_date}T{:02}:{:02}:00{sign}{:02}:{:02}", minute.div_euclid(60), minute.rem_euclid(60), abs / 3600, (abs % 3600) / 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A New York wall-clock time on a DST change day is the instant of its own offset: 03:00 on the March change
    /// day is EDT, 01:30 on the November one is still EDT, 03:00 there is EST.
    #[test]
    fn a_local_minute_on_a_dst_change_day_takes_the_offset_of_its_own_instant() {
        let utc = |d: &str, h: i64, m: i64| { let (y, mo, da) = parse_calendar_date(d).unwrap(); (days_from_civil(y, mo, da) * 86_400 + h * 3600 + m * 60) * 1_000_000_000 };
        assert_eq!(local_minute_ns("US", "2026-03-08", 3 * 60), Some(utc("2026-03-08", 7, 0)), "EDT, -4");
        assert_eq!(local_minute_ns("US", "2026-03-08", 60), Some(utc("2026-03-08", 6, 0)), "before the change: EST, -5");
        assert_eq!(local_minute_ns("US", "2026-11-01", 3 * 60), Some(utc("2026-11-01", 8, 0)), "after the change: EST, -5");
        assert_eq!(local_minute_ns("US", "2026-11-01", 60 + 30), Some(utc("2026-11-01", 5, 30)), "still EDT, -4");
        assert_eq!(local_minute_ns("STK", "2026-11-04", 29 * 60), Some(utc("2026-11-04", 21, 0)), "05:00 the next day, Taipei: a minute past 1440 is the next day");
        assert_eq!(local_minute_ns("STK", "2026-02-31", 0), None);
        assert_eq!(minute_timestamp("US", "2026-03-08", 3 * 60), "2026-03-08T03:00:00-04:00");
    }

    #[test]
    fn a_print_that_is_not_classified_has_no_tape_side() {
        assert_eq!(tape_side(1, false, false, false), 1);
        assert_eq!(tape_side(-2, false, false, false), -1);
        for flags in [(true, false, false), (false, true, false), (false, false, true)] {
            assert_eq!(tape_side(1, flags.0, flags.1, flags.2), 0, "{flags:?}");
        }
    }

    fn fut_at(date: (i64, i64, i64), minute: i32) -> i64 {
        (days_from_civil(date.0, date.1, date.2) * 86_400 + (minute as i64) * 60 - 8 * 3600) * 1_000_000_000
    }

    #[test]
    fn futures_partitions_are_business_sessions_and_a_night_is_dated_by_its_open() {
        assert_eq!(futures_partition(fut_at((2026, 10, 1), 9 * 60)).unwrap(), ("2026-10-01".into(), "DAY", 540));
        assert_eq!(futures_partition(fut_at((2026, 10, 1), 15 * 60)).unwrap(), ("2026-10-01".into(), "NIGHT", 900));
        assert_eq!(futures_partition(fut_at((2026, 10, 2), 0)).unwrap(), ("2026-10-01".into(), "NIGHT", 1440));
        assert_eq!(futures_partition(fut_at((2026, 10, 2), 5 * 60)).unwrap(), ("2026-10-01".into(), "NIGHT", 1740));
        assert_eq!(minute_timestamp("FUT", "2026-10-01", 1500), "2026-10-02T01:00:00+08:00");
        assert_eq!(shift_date("2026-03-01", -1), "2026-02-28");
    }

    #[test]
    fn a_latency_starts_at_an_exchange_time_the_producer_did_not_mark_as_a_label() {
        let event = |provider: &str, payload: serde_json::Value, quality: &str, flags: serde_json::Value| -> MarketEvent {
            serde_json::from_value(serde_json::json!({
                "schema_version": 2, "symbol": format!("{provider}:FUT:TXFR1"), "provider": provider, "market": "FUT", "code": "TXFR1",
                "session": "NIGHT", "trading_date": "2026-10-20", "generation": 1, "sequence": 1, "exchange_ts_ns": 5,
                "time_quality": quality, "flags": flags, "payload": payload,
            })).unwrap()
        };
        let none = serde_json::json!({});
        let label = serde_json::json!({"time_label": true});
        let trade = serde_json::json!({"kind": "trade", "price": 1, "volume": 1, "total_volume": 1, "side": 1, "trade_id": "x",
            "minute": 1, "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0});
        let bar = serde_json::json!({"kind": "minute_bar", "minute": 1, "open": 1, "high": 1, "low": 1, "close": 1, "average": 1,
            "volume": 1.0, "amount": 1.0});
        let quote = serde_json::json!({"kind": "quote", "current": 1, "open": 1, "high": 1, "low": 1,
            "total_volume": 1.0, "total_amount": 1.0, "status": "live", "minute": 1, "average": 1, "volume": 1.0, "amount": 1.0});
        assert_eq!(event("futu", trade.clone(), "exchange", none.clone()).latency_exchange_ns(), Some(5));
        assert_eq!(event("futu", trade, "backend_clock", none.clone()).latency_exchange_ns(), None, "an arrival stamp is no exchange time");
        assert_eq!(event("futu", bar, "exchange", label.clone()).latency_exchange_ns(), None, "a minute bar's time is its minute, not when it happened");
        assert_eq!(event("futu", quote.clone(), "exchange", label).latency_exchange_ns(), None, "a Futu quote's time is its last-update second");
        // A Shioaji TXF quote is one print with its own time -- the only Shioaji event at night (10-19: 沒有樣本 all night).
        assert_eq!(event("shioaji", quote, "exchange", none).latency_exchange_ns(), Some(5));
    }

    #[test]
    fn a_time_label_flag_survives_the_wire_and_is_left_out_when_false() {
        let flags: EventFlags = serde_json::from_value(serde_json::json!({"time_label": true})).unwrap();
        assert!(flags.time_label);
        assert_eq!(serde_json::to_value(EventFlags::default()).unwrap(), serde_json::json!({}), "an older record reads the same");
        let shown: EventFlags = serde_json::from_value(serde_json::json!({"backfill": true, "view_only": true})).unwrap();
        assert!(shown.view_only && !EventFlags::default().view_only, "a closed session's fetched print says it is not to be written");
    }

    #[test]
    fn only_preopen_call_auction_data_is_dropped() {
        let at = |market: &str, minute: i32, simtrade: bool| -> MarketEvent {
            serde_json::from_value(serde_json::json!({
                "schema_version": 2,
                "symbol": format!("shioaji:{market}:X"), "provider": "shioaji", "market": market, "code": "X", "session": "DAY",
                "trading_date": "2026-10-01", "generation": 1, "sequence": 1, "exchange_ts_ns": fut_at((2026, 10, 1), minute),
                "payload": {"kind": "trade", "price": 1, "volume": 1, "total_volume": 1, "side": 1, "trade_id": "x", "minute": minute,
                            "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0,
                            "simtrade": simtrade}
            })).unwrap()
        };
        assert!(at("STK", 8 * 60 + 30, true).is_preopen_indicative());
        assert!(at("STK", 8 * 60 + 59, true).is_preopen_indicative());
        assert!(!at("STK", 8 * 60 + 45, false).is_preopen_indicative(), "a real print is never dropped");
        assert!(!at("STK", 10 * 60, true).is_preopen_indicative(), "緩漲緩跌 auction is kept");
        assert!(!at("STK", 13 * 60 + 26, true).is_preopen_indicative(), "closing auction is kept");
        assert!(at("FUT", 8 * 60 + 40, true).is_preopen_indicative());
        assert!(!at("FUT", 8 * 60 + 45, true).is_preopen_indicative());
        assert!(at("FUT", 14 * 60 + 55, true).is_preopen_indicative(), "night pre-open");
        assert!(!at("FUT", 13 * 60 + 44, true).is_preopen_indicative(), "day closing auction is kept");
    }

    fn current() -> serde_json::Value {
        serde_json::json!({"schema_version": 2, "durable_sequence": 7, "symbol": "shioaji:STK:2330", "provider": "shioaji",
            "market": "STK", "code": "2330", "session": "DAY", "trading_date": "2026-09-21", "generation": 1, "sequence": 3,
            "exchange_ts_ns": 1, "arrival_ns": 2, "payload": {"kind": "reference", "limit_up": 110, "limit_down": 90}})
    }

    fn old_format(value: &serde_json::Value) -> String {
        let by_value = MarketEvent::decode_value(value).unwrap_err();
        let by_bytes = MarketEvent::decode_slice(&serde_json::to_vec(value).unwrap()).unwrap_err();
        assert_eq!(by_value, by_bytes, "both decoders refuse alike");
        assert!(by_value.is_old_format(), "{by_value}");
        by_value.reason().to_string()
    }

    #[test]
    fn a_current_record_decodes_and_every_older_format_is_refused() {
        let event = MarketEvent::decode_value(&current()).unwrap();
        assert_eq!(MarketEvent::decode_slice(&serde_json::to_vec(&event).unwrap()).unwrap(), event);

        // v1: no schema_version.
        let mut v1 = current();
        v1.as_object_mut().unwrap().remove("schema_version");
        assert!(old_format(&v1).contains("no schema_version"));
        let mut older = current();
        older["schema_version"] = serde_json::json!(1);
        assert!(old_format(&older).contains("event schema 1"));
        // Identity only in `symbol` (no market / code).
        let mut by_symbol = current();
        by_symbol.as_object_mut().unwrap().remove("market");
        by_symbol.as_object_mut().unwrap().remove("code");
        assert!(old_format(&by_symbol).contains("identity only in symbol"));
        // A derived row in the raw stream.
        let mut derived = current();
        derived["payload"] = serde_json::json!({"kind": "analysis_signals", "row": {"chg_1m": 1}});
        assert!(old_format(&derived).contains("analysis_signals"));
        // A calendar-day FUT partition.
        let mut full = current();
        (full["market"], full["code"], full["symbol"], full["session"]) =
            ("FUT".into(), "TXFR1".into(), "shioaji:FUT:TXFR1".into(), "FULL".into());
        assert!(old_format(&full).contains("DAY / NIGHT"));
        full["session"] = "NIGHT".into();
        assert!(MarketEvent::decode_value(&full).is_ok(), "a FUT NIGHT partition is current");
        // A provider-written source_status (wall-clock partitions).
        let mut status = current();
        status["payload"] = serde_json::json!({"kind": "source_status", "state": "subscribed", "detail": ""});
        status["time_quality"] = "backend_clock".into();
        assert!(old_format(&status).contains("coverage"));
        status["time_quality"] = COVERAGE_CONTROL.into();
        assert!(MarketEvent::decode_value(&status).is_ok(), "Market Runtime's coverage record is current");
        // Market Runtime's loss record, and each control time quality only with its own states.
        let mut loss = status.clone();
        loss["payload"] = serde_json::json!({"kind": "source_status", "state": SOURCE_GAP, "detail": ""});
        loss["time_quality"] = LOSS_CONTROL.into();
        assert!(MarketEvent::decode_value(&loss).is_ok(), "Market Runtime's loss record is current");
        loss["time_quality"] = COVERAGE_CONTROL.into();
        assert!(old_format(&loss).contains("source_gap"), "a gap is no coverage state");
        status["time_quality"] = LOSS_CONTROL.into();
        assert!(old_format(&status).contains("subscribed"), "a subscription is no loss");
        // A newer writer is undecodable, not an older format.
        let mut newer = current();
        newer["schema_version"] = serde_json::json!(EVENT_SCHEMA_VERSION + 1);
        assert!(matches!(MarketEvent::decode_value(&newer), Err(Refused::Undecodable(_))));
        assert!(matches!(MarketEvent::decode_slice(b"{not json"), Err(Refused::Undecodable(_))));
    }

    #[test]
    fn an_instrument_is_named_by_all_three_parts_only() {
        assert_eq!(InstrumentKey::parse("shioaji:STK:2330"), Some(InstrumentKey::new("shioaji", "STK", "2330")));
        assert_eq!(InstrumentKey::parse("futu:US:US.AAPL"), Some(InstrumentKey::new("futu", "US", "US.AAPL")));
        assert_eq!(InstrumentKey::parse("STK:2330"), None, "no source");
        assert_eq!(InstrumentKey::parse("2330"), None);
        assert_eq!(InstrumentKey::parse("shioaji::2330"), None);
        assert_eq!(InstrumentKey::parse(""), None);
    }

    #[test]
    fn market_minutes_follow_the_market_zone() {
        // 2026-09-29 01:30:00 UTC = 09:30 Taipei.
        let ts = (days_from_civil(2026, 9, 29) * 86_400 + 90 * 60) * 1_000_000_000;
        assert_eq!(market_local_minute("STK", ts), Some(("2026-09-29".into(), 570)));
        // 2026-09-29 13:30 UTC = 09:30 New York (EDT).
        let ts = (days_from_civil(2026, 9, 29) * 86_400 + 13 * 3600 + 30 * 60) * 1_000_000_000;
        assert_eq!(market_local_minute("US", ts), Some(("2026-09-29".into(), 570)));
        // 2026-12-01 14:30 UTC = 09:30 New York (EST).
        let ts = (days_from_civil(2026, 12, 1) * 86_400 + 14 * 3600 + 30 * 60) * 1_000_000_000;
        assert_eq!(market_local_minute("US", ts), Some(("2026-12-01".into(), 570)));
        assert_eq!(minute_timestamp("STK", "2026-09-29", 570), "2026-09-29T09:30:00+08:00");
        assert_eq!(minute_timestamp("US", "2026-12-01", 570), "2026-12-01T09:30:00-05:00");
        assert_eq!(minute_timestamp("US", "2026-09-29", 570), "2026-09-29T09:30:00-04:00");
    }

    #[test]
    fn crypto_days_are_new_york_days_like_its_clear() {
        // 2026-10-08 04:00 UTC = 00:00 New York (EDT): the CC cache is cleared here, and the CC day turns here too,
        // as the US stocks' day does.
        let midnight = (days_from_civil(2026, 10, 8) * 86_400 + 4 * 3600) * 1_000_000_000;
        assert_eq!(market_local_minute("CC", midnight), Some(("2026-10-08".into(), 0)));
        assert_eq!(market_local_minute("CC", midnight - 60_000_000_000), Some(("2026-10-07".into(), 1439)));
        assert_eq!(crate::rollover::clears(midnight + 5 * 3_600_000_000_000)["futu|CC"], midnight);
        assert_eq!(minute_timestamp("CC", "2026-10-08", 0), "2026-10-08T00:00:00-04:00");
        // After the clocks change (EST) the day turns at 05:00 UTC.
        let winter = (days_from_civil(2026, 11, 12) * 86_400 + 5 * 3600) * 1_000_000_000;
        assert_eq!(market_local_minute("CC", winter), Some(("2026-11-12".into(), 0)));
        assert_eq!(crate::rollover::clears(winter + 3_600_000_000_000)["futu|CC"], winter);
    }
}
