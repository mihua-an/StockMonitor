//! online-v3 features, online: the Rust half of the FeatureSpec a deployable model is bound to
//! (spec/feature_spec_online_v3.json: every column, its unit and its rule).
//!
//! Folded event by event in durable order. This is the ONLY implementation: the training dataset
//! is this same fold run over the historical store (dataset.rs, `--export-features`), so a model is trained on
//! exactly the features it is later fed live. There is no offline twin to keep in step.
//!
//! Only market events change state: the analysis graph's own derived output (analysis_signals,
//! monitor_event) is excluded, so a published result can never become its own input.
//!
//! Continuous trading only: a call-auction match (the opening and closing auctions, an intraday 處置 / 緩漲緩跌 match),
//! a 盤後定價 print and a simtrade print never enter a column (an auction 1,615 lots at the open is nobody's outer
//! volume). An intraday call auction is shown as itself (`intraday_auction`).
//!
//! Every windowed column has the windows S = 1, 3, 5, 10, 15, 30, 60 minutes and today: a window that would start
//! before 09:00 is missing (NaN), never filled with zero. Today's figures and the minute map cover the whole session.
//! The day columns read the previous sessions' daily summaries (day_context.rs), and so do the stock's behaviour
//! columns (BEHAVIOUR_COLUMNS, measured once per trading date).
//!
//! This fold is also the only one of the daily summary: a session's summary is the closing state of its keys
//! (`KeyState::stock_day` / `index_day`, daily_summary.rs), so what the day columns compare today against was folded
//! by the same rules as today.
//!
//! A generation is one broker connection. It says nothing about what the session already traded, so a key's state
//! stays across a reconnect; only an event of an older connection arriving after a newer one's is refused. Generation
//! 0 is the broker's history filling a gap (history_fill.py), never an old connection.
//!
//! A late print or quote (a gap filled after the fact, however late) enters today's totals and its own minute, as it
//! would have on time. What follows the tape as it goes -- the last price, the crossings, the running open and average
//! -- stays with the newest event by exchange time.
//!
//! The `*_this_minute` columns are the minute in progress (the scope's newest, L + 1) up to the sample: a burst or a
//! large print shows at once instead of when its minute completes. Their only time is the sample's own.
//!
//! Besides the numeric row, every snapshot carries its CATEGORY_COLUMNS: the stock's industry group (`tse:24`,
//! day_context.rs; MISSING_TOKEN when the security master has none) and its code. Which categories a model reads and
//! how they are encoded is the model's (model.rs).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use market_runtime::event::{partition_local_minute, MarketEvent, Payload, COVERAGE_CONTROL, COVERAGE_SUBSCRIBED, PRICE_SCALE};
use market_runtime::state::Reference;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::accum::{close_span, open_span, span_state};
use crate::day_context::{ContextSource, DayContext, History, BEHAVIOUR_COLUMNS};

/// What this fold computes, for the training data made with it: a stored shard is reused only under the same value
/// (service/analysis/online_training/dataset.py). Change it whenever the numbers of an existing column change while
/// the column list, and so the FeatureSpec digest, stays the same.
pub const FOLD_VERSION: &str = "single-fold-3";
/// The book per minute kept for the book_flow windows (the longest window plus its margin).
const KEEP_BOOK_MINUTES: i32 = 64;
const WARMUP_MINUTES: i32 = 5;
/// 09:00, the TWSE continuous session's first minute: no window reaches before it.
const SESSION_OPEN: i32 = 540;
/// 13:30, the closing auction's minute.
const CLOSING_AUCTION: i32 = 810;
/// 13:25: from here the book is the closing auction's.
const CLOSING_BOOK: i32 = 805;
const WINDOWS: [i32; 7] = [1, 3, 5, 10, 15, 30, 60];
const STD_WINDOWS: [i32; 5] = [5, 10, 15, 30, 60];
/// One print of at least this many lots is large (the user's single-print 大單 threshold), under SMALL_LOTS small.
const LARGE_LOTS: f64 = 50.0;
const SMALL_LOTS: f64 = 10.0;
/// online-v3 numeric columns, in spec order (spec/feature_spec_online_v3.json): online-v2's (179 since the 11-08 removal), then the minute in
/// progress and the stock's behaviour.
pub const NUMERIC_COLUMNS: [&str; 195] = [
    "last_price", "session_minute", "day_range_position", "open_gap", "minutes_since_day_high",
    "minutes_since_day_low", "ret_1m", "ret_3m", "ret_5m", "ret_10m", "ret_15m", "ret_30m", "ret_60m", "ret_today",
    "range_1m", "range_3m", "range_5m", "range_10m", "range_15m", "range_30m", "range_60m", "range_today",
    "ret_std_5m", "ret_std_10m", "ret_std_15m", "ret_std_30m", "ret_std_60m", "ret_std_today", "vol_1m", "vol_3m",
    "vol_5m", "vol_10m", "vol_15m", "vol_30m", "vol_60m", "vol_today", "vol_ratio_1m", "vol_ratio_3m", "vol_ratio_5m",
    "vol_ratio_10m", "vol_ratio_15m", "vol_ratio_30m", "vol_ratio_60m", "trades_1m", "trades_3m", "trades_5m",
    "trades_10m", "trades_15m", "trades_30m", "trades_60m", "trades_today", "vol_today_vs_5d", "vol_today_vs_22d",
    "vol_today_vs_88d", "vol_same_time_vs_1d", "vol_same_time_vs_5d", "log_amount_today", "buy_ratio_1m",
    "buy_ratio_3m", "buy_ratio_5m", "buy_ratio_10m", "buy_ratio_15m", "buy_ratio_30m", "buy_ratio_60m",
    "buy_ratio_today", "price_level_buy_ratio", "above_buy_ratio", "below_buy_ratio", "above_volume_share",
    "dist_max_volume_price", "bid5_traded_vs_queue", "ask5_traded_vs_queue", "bid5_large_sell_share",
    "ask5_large_buy_share", "dist_upper_node", "dist_lower_node", "dist_open", "dist_vwap", "dist_day_high",
    "dist_day_low", "dist_ma5", "dist_ma22", "dist_ma88", "nearest_resistance", "nearest_support",
    "levels_within_1pct", "upper_node_volume_share", "lower_node_volume_share", "minutes_since_cross_open",
    "minutes_since_cross_vwap", "minutes_since_cross_prev_close", "large_net_1m", "large_net_3m", "large_net_5m",
    "large_net_10m", "large_net_15m", "large_net_30m", "large_net_60m", "large_net_today", "large_share_1m",
    "large_share_3m", "large_share_5m", "large_share_10m", "large_share_15m", "large_share_30m", "large_share_60m",
    "large_share_today", "small_net_1m", "small_net_3m", "small_net_5m", "small_net_10m", "small_net_15m",
    "small_net_30m", "small_net_60m", "small_net_today", "flow_divergence_1m", "flow_divergence_3m",
    "flow_divergence_5m", "flow_divergence_10m", "flow_divergence_15m", "flow_divergence_30m", "flow_divergence_60m",
    "flow_divergence_today", "large_net_positive_minute_ratio", "large_buy_ratio_today", "large_trades_today",
    "minutes_since_large", "spread_bp", "book_imbalance_1", "book_imbalance_5", "book_flow_1m", "book_flow_3m",
    "book_flow_5m", "book_flow_10m", "book_flow_15m", "book_flow_30m", "book_flow_60m", "book_flow_today",
    "index_ret_1m", "index_ret_3m", "index_ret_5m", "index_ret_10m", "index_ret_15m", "index_ret_30m",
    "index_ret_60m", "index_ret_today", "index_fresh", "index_advance_ratio", "index_limit_up_count",
    "index_limit_down_count", "index_amount_vs_1d", "industry_ret_1m", "industry_ret_3m", "industry_ret_5m",
    "industry_ret_10m", "industry_ret_15m", "industry_ret_30m", "industry_ret_60m", "industry_ret_today",
    "excess_ret_1m", "excess_ret_3m", "excess_ret_5m", "excess_ret_10m", "excess_ret_15m", "excess_ret_30m",
    "excess_ret_60m", "excess_ret_today", "industry_advance_ratio", "industry_limit_up_ratio",
    "industry_limit_down_ratio", "industry_fresh", "prev_day_return", "ret_5d", "ret_22d", "dist_20d_high",
    "dist_20d_low", "atr_14d", "minutes_observed", "intraday_auction", "minute_elapsed_seconds", "ret_this_minute",
    "vol_this_minute", "buy_ratio_this_minute", "large_net_this_minute", "stock_log_amount_22d", "stock_ret_std_22d",
    "stock_no_trade_ratio_22d", "stock_limit_up_days_22d", "stock_gap_up_fade_60d", "stock_up_burst_ret_5m_22d",
    "stock_down_burst_ret_5m_22d", "stock_tail_ret_22d", "stock_morning_ret_22d", "stock_ret_5m_autocorr_22d",
    "stock_large_buy_ret_5m_22d",
];
/// The category columns, in spec order: the industry group and the stock code.
pub const CATEGORY_COLUMNS: [&str; 2] = ["industry", "stock"];
/// A category with no value (service/analysis/inference/contract.py MISSING_TOKEN).
pub const MISSING_TOKEN: &str = "__MISSING__";
pub const RET_1M: usize = 6;
const REFERENCE: (&str, &str, &str) = ("shioaji", "IDX", "TAIEX");

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct KeyId {
    pub source: String,
    pub market: String,
    pub trading_date: String,
    pub session: String,
    pub code: String,
}

impl KeyId {
    /// Normalised exactly as Market Runtime's partition identity is.
    pub fn of(event: &MarketEvent) -> Option<Self> {
        let instrument = event.instrument();
        let key = Self {
            source: instrument.source,
            market: instrument.market,
            trading_date: event.trading_date.trim().chars().take(10).collect(),
            session: event.session.trim().to_uppercase(),
            code: instrument.code,
        };
        (!key.source.is_empty() && !key.code.is_empty() && !key.trading_date.is_empty()).then_some(key)
    }

    fn group(&self) -> (String, String, String) {
        (self.source.clone(), self.market.clone(), self.session.clone())
    }

    fn scope(&self) -> ScopeId {
        (self.source.clone(), self.market.clone(), self.trading_date.clone(), self.session.clone())
    }
}

type ScopeId = (String, String, String, String);

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct MinuteAgg {
    /// The minute's first price by exchange time, with that time (a fill arrives after the prints around it).
    open: Option<f64>,
    open_ns: i64,
    close: Option<f64>,
    /// The exchange time of `close`: a print or quote filled into a restart's gap afterwards arrives after newer
    /// ones of the gap's last minute, and is its close only if its time says so.
    close_ns: i64,
    high: Option<f64>,
    low: Option<f64>,
    volume: f64,
    amount: f64,
    trades: i64,
    buy: f64,
    sell: f64,
    large_buy: f64,
    large_sell: f64,
    small_buy: f64,
    small_sell: f64,
}

/// Today's continuous trading, folded over the whole session.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct DayTotals {
    volume: f64,
    amount: f64,
    trades: f64,
    buy: f64,
    sell: f64,
    large_buy: f64,
    large_sell: f64,
    small_buy: f64,
    small_sell: f64,
    large_trades: f64,
    high: Option<(f64, i32)>,
    low: Option<(f64, i32)>,
    last_large_minute: Option<i32>,
}

/// What only the session's daily summary reads: the day's bar over every regular print (the call auctions included,
/// where DayTotals is continuous trading alone), the call auctions' part of the volume and amount, and the limit prices.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SessionDay {
    /// The first and last price by exchange time, with that time.
    open: Option<(f64, i64)>,
    close: Option<(f64, i64)>,
    high: Option<f64>,
    low: Option<f64>,
    auction_volume: f64,
    auction_amount: f64,
}

impl SessionDay {
    fn print(&mut self, p: f64, ts: i64) {
        if self.open.is_none_or(|(_, at)| ts < at) {
            self.open = Some((p, ts));
        }
        if self.close.is_none_or(|(_, at)| ts >= at) {
            self.close = Some((p, ts));
        }
        self.high = Some(self.high.map_or(p, |h| h.max(p)));
        self.low = Some(self.low.map_or(p, |l| l.min(p)));
    }
}

/// One price level's volume today.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Bin {
    volume: f64,
    buy: f64,
    sell: f64,
    large_buy: f64,
    large_sell: f64,
}

/// Which side of a level the prints are on, and since which minute (the last time they crossed it).
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
struct Cross {
    side: i8,
    since: Option<i32>,
}

/// An index quote's breadth and turnover.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct IndexFacts {
    advance: Option<f64>,
    decline: Option<f64>,
    flat: Option<f64>,
    limit_up: Option<f64>,
    limit_down: Option<f64>,
    total_amount: Option<(f64, i32)>,
    /// The exchange's own open / high / low as of the newest quote that states all three, with that quote's time (the
    /// first quotes of the day repeat the previous close and state none; a gap's fill states none).
    day_bar: Option<(f64, f64, f64, i64)>,
    /// The cumulative amount at each minute's last quote that has one (the market's turnover at that time of day).
    amount_by_minute: BTreeMap<i32, f64>,
}

/// The day statistics of completed minutes, folded up to `upto` (inclusive).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct DayMinutes {
    upto: Option<i32>,
    returns: f64,
    sum: f64,
    sum_squares: f64,
    large_positive: f64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct KeyState {
    generation: u64,
    last_price: Option<f64>,
    last_price_minute: Option<i32>,
    /// The exchange time of `last_price` (see MinuteAgg::close_ns).
    last_price_ns: i64,
    /// The Reference facts, absorbed by Market Runtime's one rule (`Reference::absorb`).
    reference: Reference,
    open: Option<f64>,
    average: Option<f64>,
    /// Every minute of the session with a price.
    minutes: BTreeMap<i32, MinuteAgg>,
    first_price_minute: Option<i32>,
    minutes_observed: u64,
    day: DayTotals,
    session: SessionDay,
    day_minutes: DayMinutes,
    /// Today's volume per price (price units).
    profile: BTreeMap<i64, Bin>,
    /// open, vwap, the comparison price (`comparison`).
    crosses: [Cross; 3],
    intraday_auction: bool,
    bids: Vec<(i64, f64)>,
    asks: Vec<(i64, f64)>,
    /// The exchange time of `bids` / `asks`: the exchange's own book times are not monotonic, and an older book never
    /// replaces a newer one (equal times keep durable order).
    book_ns: i64,
    /// The 5 levels' queued volume (bid, ask) at the end of each minute with a book, and the first of the day.
    book_minutes: BTreeMap<i32, (f64, f64)>,
    book_floor: Option<(i32, (f64, f64))>,
    first_book: Option<(f64, f64)>,
    index: IndexFacts,
    /// The minutes this key's subscription covered, from Market Runtime's coverage records (accum.rs's intervals).
    /// Empty: no record has ended it, so the key has been observed since its open.
    coverage: Vec<(i32, Option<i32>)>,
    /// The Market Runtime epoch whose coverage record last confirmed the subscription.
    confirmed_epoch: u64,
    pub cutoff_ns: i64,
    pub watermark: u64,
}

impl KeyState {
    /// Whether the subscription saw the whole of `minute`: only then does silence mean nothing traded.
    fn observed(&self, minute: i32) -> bool {
        self.coverage.is_empty() || span_state(&self.coverage, minute) == 2
    }

    fn cover(&mut self, minute: i32, subscribed: bool) {
        if subscribed {
            if !self.coverage.is_empty() {
                open_span(&mut self.coverage, minute);
            }
            return;
        }
        if self.coverage.is_empty() {
            self.coverage.push((-1, None));
        }
        close_span(&mut self.coverage, minute);
    }

    /// The price a move is measured from: the reference price (futures settlement, a stock's 參考價) or else 昨收, the
    /// rule Market Runtime's change uses (`Reference::comparison_price`).
    fn comparison(&self) -> Option<f64> {
        self.reference.comparison_price().map(price)
    }

    /// Whether an event of `generation` is folded, keeping the newest connection seen (see the module documentation).
    fn admit(&mut self, generation: u64) -> bool {
        if generation != 0 && generation < self.generation {
            return false;
        }
        self.generation = self.generation.max(generation);
        true
    }

    /// Whether an event at (`minute`, `ts`) is the newest the key has priced: a fill is no newer than its exchange time.
    fn is_newest(&self, minute: i32, ts: i64) -> bool {
        self.last_price_minute.is_none_or(|m| minute > m || (minute == m && ts >= self.last_price_ns))
    }

    /// The closing state of a stock as its daily summary keeps it (daily_summary.rs): the day over every regular print
    /// and, per clock minute of continuous trading, `[volume, amount, close, high, low, large_buy, large_sell, open]`.
    pub fn stock_day(&self) -> Value {
        let session = &self.session;
        let minutes: Map<String, Value> = self.minutes.iter().map(|(m, a)| {
            (m.to_string(), json!([a.volume, a.amount, a.close, a.high, a.low, a.large_buy, a.large_sell, a.open]))
        }).collect();
        json!({"open": session.open.map(|o| o.0), "high": session.high, "low": session.low, "close": session.close.map(|c| c.0),
               "prev_close": self.reference.prev_close.map(price), "limit_up": self.reference.limit_up.map(price),
               "limit_down": self.reference.limit_down.map(price),
               "volume": self.day.volume + session.auction_volume, "amount": self.day.amount + session.auction_amount,
               "auction_volume": session.auction_volume, "auction_amount": session.auction_amount, "minutes": minutes})
    }

    /// The closing state of an index as its daily summary keeps it: the exchange's own open / high / low, the newest
    /// level as the close, and per minute the cumulative amount.
    pub fn index_day(&self) -> Value {
        let bar = self.index.day_bar;
        let minutes: Map<String, Value> = self.index.amount_by_minute.iter().map(|(m, a)| (m.to_string(), json!(a))).collect();
        json!({"open": bar.map(|b| b.0), "high": bar.map(|b| b.1), "low": bar.map(|b| b.2), "close": self.last_price,
               "prev_close": self.reference.prev_close.map(price), "minutes": minutes})
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct ScopeState {
    clock: Option<i32>,
    /// Every minute of the date any event of the scope carried a price in.
    active: BTreeSet<i32>,
}

impl ScopeState {
    fn touch(&mut self, minute: i32) {
        if self.clock.is_none_or(|c| minute > c) {
            self.clock = Some(minute);
        }
        self.active.insert(minute);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Traded,
    NoTrade,
    NoData,
    Before,
}

#[derive(Debug, Clone)]
pub struct FeatureSnapshot {
    pub values: Vec<f64>,
    /// CATEGORY_COLUMNS' values.
    pub categories: Vec<String>,
    pub warm: bool,
    pub watermark: u64,
    pub generation: u64,
    pub cutoff_ns: i64,
}

impl FeatureSnapshot {
    /// The capture/parity wire form. NaN travels as null (JSON has no NaN).
    pub fn to_json(&self, key: &KeyId, durable_sequence: u64) -> Value {
        json!({
            "identity": {"source": key.source, "market": key.market, "trading_date": key.trading_date,
                          "session": key.session, "code": key.code},
            "durable_sequence": durable_sequence,
            "watermark": self.watermark,
            "cutoff_ns": self.cutoff_ns,
            "generation": self.generation,
            "warm": self.warm,
            "values": self.values.iter().map(|v| if v.is_finite() { json!(v) } else { Value::Null }).collect::<Vec<_>>(),
            "categories": self.categories,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Folded {
    Changed(KeyId),
    NoFeatureEffect,
    RetiredScope,
    StaleGeneration,
    Unplaceable,
}

/// The fold of the stored events (`keys`, `scopes`: what a replay of the WAL rebuilds, the only part a checkpoint and
/// the feature capture keep) and, beside it, the keys of stocks off the background list as inference sees them
/// (`live_keys`, `live_scopes`: engine::LiveOverlay's twin, Codex 1020-R04-03). An unlisted event forks its key and
/// scope from their stored fold (or starts them) and from then on both lanes' events reach the fork; a scope's
/// activity seen only in unlisted events never moves the stored scope. Memory only; it leaves with its keys.
///
/// `context` gives each trading date its day context (previous sessions, industry indexes), loaded the first time
/// the date is folded and kept for the newest two dates; it is read from files, never part of the image.
#[derive(Debug, Default)]
pub struct FeatureStore {
    keys: HashMap<KeyId, KeyState>,
    scopes: HashMap<ScopeId, ScopeState>,
    current_date: HashMap<(String, String, String), String>,
    reference: HashMap<(String, String, String, String), KeyId>,
    live_keys: HashMap<KeyId, KeyState>,
    live_scopes: HashMap<ScopeId, ScopeState>,
    /// The newest Market Runtime epoch that wrote coverage, per source.
    coverage_epoch: HashMap<String, u64>,
    context: ContextSource,
    contexts: BTreeMap<(String, String), Arc<DayContext>>,
    pub market_events: u64,
    pub retired_events: u64,
    pub stale_generation: u64,
    pub rollovers: u64,
    /// Unlisted events folded (not in the image's counters).
    pub live_events: u64,
    /// Day contexts loaded from disk (one per (source, trading date) while its keys are held).
    pub context_loads: u64,
}

/// What one event did to a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Effect {
    None,
    Book,
    /// A price of this minute: the scope saw activity in it.
    Minute(i32),
}

fn same_group(a: &KeyId, b: &KeyId) -> bool {
    a.source == b.source && a.market == b.market && a.session == b.session
}

/// Checkpoint image of a FeatureStore (JSON maps need string keys, so maps travel as pair lists).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FeatureImage {
    keys: Vec<(KeyId, KeyState)>,
    scopes: Vec<(ScopeId, ScopeState)>,
    current_date: Vec<((String, String, String), String)>,
    reference: Vec<((String, String, String, String), KeyId)>,
    coverage_epoch: Vec<(String, u64)>,
    counters: (u64, u64, u64, u64),
}

fn price(units: i64) -> f64 {
    market_runtime::wire::money(units)
}

/// The Taipei clock minute of an exchange time (the minute numbering of trade.minute).
fn clock_minute(ts_ns: i64) -> i32 {
    (ts_ns.div_euclid(60_000_000_000) + 8 * 60).rem_euclid(24 * 60) as i32
}

impl FeatureStore {
    pub fn with_context(context: ContextSource) -> Self {
        Self { context, ..Self::default() }
    }

    pub fn context(&self) -> &ContextSource {
        &self.context
    }

    /// Drops every key (and its scope / reference entries) `gone` names: Market Runtime's session rollover and clears.
    /// Returns the keys dropped, so queued inference for them can be cancelled.
    pub fn forget(&mut self, gone: impl Fn(&KeyId) -> bool) -> Vec<KeyId> {
        let mut dropped: Vec<KeyId> = self.keys.keys().filter(|k| gone(k)).cloned().collect();
        for key in &dropped {
            self.keys.remove(key);
        }
        let live: Vec<KeyId> = self.live_keys.keys().filter(|k| gone(k)).cloned().collect();
        for key in live {
            self.live_keys.remove(&key);
            if !dropped.contains(&key) {
                dropped.push(key);
            }
        }
        self.reference.retain(|_, k| !gone(k));
        let scope_gone = |s: &ScopeId| gone(&KeyId { source: s.0.clone(), market: s.1.clone(), trading_date: s.2.clone(),
                                                     session: s.3.clone(), code: String::new() });
        self.scopes.retain(|s, _| !scope_gone(s));
        self.live_scopes.retain(|s, _| !scope_gone(s));
        dropped
    }

    /// The day context of a key's trading date, loaded on its first event.
    fn ensure_context(&mut self, key: &KeyId) {
        let id = (key.source.clone(), key.trading_date.clone());
        if self.contexts.contains_key(&id) {
            return;
        }
        let context = self.context.load(&key.source, &key.trading_date);
        self.context_loads += 1;
        for problem in &context.problems {
            eprintln!("[analysis_runtime] day context {} {}: {problem}", key.source, key.trading_date);
        }
        // Held while a key of its (source, date) is: a context goes with the rollover that retires its last key
        // (`drop_unused_contexts`). A fixed count of two thrashed at night, when a futures night, US stocks and
        // crypto -- three (source, date)s -- interleave: nearly every event loaded its context from disk again.
        self.contexts.insert(id, Arc::new(context));
    }

    /// Contexts whose (source, trading date) no key, stored or forked, belongs to any more.
    fn drop_unused_contexts(&mut self) {
        let used: HashSet<(String, String)> = self.keys.keys().chain(self.live_keys.keys())
            .map(|k| (k.source.clone(), k.trading_date.clone())).collect();
        self.contexts.retain(|id, _| used.contains(id));
    }

    /// Fold one stored event (durable, or of a never-stored market): the stored fold, and the unlisted fork of its key
    /// and scope when there is one. Returns what happened plus the keys a rollover retired. Control records (coverage,
    /// loss) are no market data and change nothing.
    pub fn fold(&mut self, event: &MarketEvent) -> (Folded, Vec<KeyId>) {
        if let Payload::SourceStatus { state, .. } = &event.payload {
            if event.time_quality == COVERAGE_CONTROL {
                self.apply_coverage(event, state == COVERAGE_SUBSCRIBED);
            }
            return (Folded::NoFeatureEffect, Vec::new());
        }
        let Some(key) = KeyId::of(event) else { return (Folded::Unplaceable, Vec::new()) };
        self.market_events += 1;
        let group = key.group();
        let mut retired = Vec::new();
        let current = self.current_date.get(&group).cloned();
        if let Some(current) = &current {
            if key.trading_date < *current {
                self.retired_events += 1;
                return (Folded::RetiredScope, retired);
            }
            if key.trading_date > *current {
                retired = self.keys.keys().filter(|k| k.group() == group && k.trading_date < key.trading_date).cloned().collect();
                for k in &retired {
                    self.keys.remove(k);
                }
                self.scopes.retain(|s, _| !((s.0.clone(), s.1.clone(), s.3.clone()) == group && s.2 < key.trading_date));
                self.reference.retain(|_, k| !(k.group() == group && k.trading_date < key.trading_date));
                let live: Vec<KeyId> = self.live_keys.keys().filter(|k| same_group(k, &key) && k.trading_date < key.trading_date).cloned().collect();
                for k in live {
                    self.live_keys.remove(&k);
                    retired.push(k);
                }
                self.live_scopes.retain(|s, _| !((s.0.clone(), s.1.clone(), s.3.clone()) == group && s.2 < key.trading_date));
                self.rollovers += 1;
                self.drop_unused_contexts();
            }
        }
        if current.as_ref().is_none_or(|c| key.trading_date > *c) {
            self.current_date.insert(group, key.trading_date.clone());
        }
        self.ensure_context(&key);

        if !self.keys.contains_key(&key) {
            self.keys.insert(key.clone(), KeyState::default());
            self.reference.insert((key.source.clone(), key.market.clone(), key.code.clone(), key.trading_date.clone()), key.clone());
        }
        let state = self.keys.get_mut(&key).expect("inserted above");
        if !state.admit(event.generation) {
            self.stale_generation += 1;
            return (Folded::StaleGeneration, retired);
        }
        let scope = self.scopes.entry(key.scope()).or_default();
        let effect = apply(event, state, scope);
        if effect != Effect::None {
            state.watermark = event.durable_sequence;
            state.cutoff_ns = state.cutoff_ns.max(event.exchange_ts_ns);
        }
        let shown = self.keep_fork_in_step(&key, event, effect);
        if effect == Effect::None && !shown {
            return (Folded::NoFeatureEffect, retired);
        }
        (Folded::Changed(key), retired)
    }

    /// A coverage record (a subscription of a listed or an unlisted stock, both durable; Engine::apply_coverage is the
    /// partitions' side of the same records): the instrument's keys take it at the record's minute. A restarted Market
    /// Runtime confirms its subscriptions afresh, so its first record ends what an older epoch confirmed; a store that
    /// has seen no epoch yet (a partition folded for training starts mid-history) has nothing to end.
    fn apply_coverage(&mut self, event: &MarketEvent, subscribed: bool) {
        let source = event.provider.to_lowercase();
        let known = self.coverage_epoch.get(&source).copied().unwrap_or(0);
        let new_epoch = known != 0 && event.generation > known;
        self.coverage_epoch.insert(source.clone(), known.max(event.generation));
        for (key, state) in self.keys.iter_mut().chain(self.live_keys.iter_mut()) {
            if !key.source.eq_ignore_ascii_case(&source) {
                continue;
            }
            let own = key.market.eq_ignore_ascii_case(&event.market) && key.code.eq_ignore_ascii_case(&event.code);
            if !own && !(new_epoch && state.confirmed_epoch < event.generation) {
                continue;
            }
            let Some((date, minute)) = partition_local_minute(&key.source, &key.market, &key.session, event.exchange_ts_ns) else { continue };
            let minute = match date.as_str().cmp(key.trading_date.as_str()) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => minute,
                std::cmp::Ordering::Greater => continue,
            };
            state.cover(minute, own && subscribed);
            if own && subscribed {
                state.confirmed_epoch = event.generation;
            }
        }
    }

    /// A stored event reaches the unlisted fork of its scope (its activity) and of its key (the event itself).
    /// Returns whether the forked key changed.
    fn keep_fork_in_step(&mut self, key: &KeyId, event: &MarketEvent, stored: Effect) -> bool {
        if self.live_scopes.is_empty() {
            return false;
        }
        let Some(scope) = self.live_scopes.get_mut(&key.scope()) else { return false };
        let Some(state) = self.live_keys.get_mut(key) else {
            if let Effect::Minute(minute) = stored {
                scope.touch(minute);
            }
            return false;
        };
        if !state.admit(event.generation) {
            return false;
        }
        if apply(event, state, scope) == Effect::None {
            return false;
        }
        state.watermark = event.durable_sequence;
        state.cutoff_ns = state.cutoff_ns.max(event.exchange_ts_ns);
        true
    }

    /// Fold one event of a stock off the background list (engine::Lane::Unlisted): its fork only, forked from the
    /// stored fold the first time. Nothing of the stored fold, its rollover or its counters moves.
    pub fn fold_live_only(&mut self, event: &MarketEvent) -> Folded {
        if matches!(event.payload, Payload::SourceStatus { .. }) {
            return Folded::NoFeatureEffect;
        }
        let Some(key) = KeyId::of(event) else { return Folded::Unplaceable };
        self.live_events += 1;
        if self.current_date.get(&key.group()).is_some_and(|current| key.trading_date < *current) {
            return Folded::RetiredScope;
        }
        self.ensure_context(&key);
        let scope_id = key.scope();
        if !self.live_scopes.contains_key(&scope_id) {
            let scope = self.scopes.get(&scope_id).cloned().unwrap_or_default();
            self.live_scopes.insert(scope_id.clone(), scope);
        }
        if !self.live_keys.contains_key(&key) {
            let state = self.keys.get(&key).cloned().unwrap_or_else(|| KeyState { generation: event.generation, ..KeyState::default() });
            self.live_keys.insert(key.clone(), state);
        }
        let state = self.live_keys.get_mut(&key).expect("inserted above");
        if !state.admit(event.generation) {
            return Folded::StaleGeneration;
        }
        let scope = self.live_scopes.get_mut(&scope_id).expect("inserted above");
        if apply(event, state, scope) == Effect::None {
            return Folded::NoFeatureEffect;
        }
        state.cutoff_ns = state.cutoff_ns.max(event.exchange_ts_ns);
        Folded::Changed(key)
    }

    /// The features inference sees: the unlisted fork where there is one, else the stored fold.
    pub fn snapshot(&self, key: &KeyId) -> Option<FeatureSnapshot> {
        match (self.live_keys.get(key), self.live_scopes.get(&key.scope())) {
            (Some(state), Some(scope)) => Some(evaluate(state, scope, &self.refs(key))),
            _ => self.stored_snapshot(key),
        }
    }

    /// The stored fold's features: what the feature capture (training data) records.
    pub fn stored_snapshot(&self, key: &KeyId) -> Option<FeatureSnapshot> {
        let state = self.keys.get(key)?;
        let scope = self.scopes.get(&key.scope())?;
        Some(evaluate(state, scope, &self.refs(key)))
    }

    /// A key's stored fold as it stands: after the session's last event, its closing state.
    pub fn closing_state(&self, key: &KeyId) -> Option<&KeyState> {
        self.keys.get(key)
    }

    /// An index's stored fold on the key's date (`code` of the reference source's IDX market).
    fn index_of(&self, key: &KeyId, code: &str) -> Option<(&KeyState, &ScopeState)> {
        self.reference
            .get(&(REFERENCE.0.to_string(), REFERENCE.1.to_string(), code.to_string(), key.trading_date.clone()))
            .and_then(|r| Some((self.keys.get(r)?, self.scopes.get(&r.scope())?)))
    }

    fn refs(&self, key: &KeyId) -> Refs<'_> {
        let context = self.contexts.get(&(key.source.clone(), key.trading_date.clone())).map(Arc::as_ref);
        let industry_code = context.and_then(|c| c.industry.get(&key.code.to_uppercase()).cloned());
        let code = key.code.to_uppercase();
        Refs {
            index: self.index_of(key, REFERENCE.2),
            industry: industry_code.as_deref().and_then(|code| self.index_of(key, code)),
            history: context.and_then(|c| c.stock(&code)),
            index_history: context.and_then(|c| c.index(REFERENCE.2)),
            industry_group: context.and_then(|c| c.industry_group.get(&code).cloned()),
            code,
        }
    }

    /// The checkpoint image: the stored fold alone.
    pub fn image(&self) -> FeatureImage {
        FeatureImage {
            keys: self.keys.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            scopes: self.scopes.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            current_date: self.current_date.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            reference: self.reference.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            coverage_epoch: self.coverage_epoch.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            counters: (self.market_events, self.retired_events, self.stale_generation, self.rollovers),
        }
    }

    pub fn from_image(image: FeatureImage, context: ContextSource) -> Self {
        let (market_events, retired_events, stale_generation, rollovers) = image.counters;
        Self {
            keys: image.keys.into_iter().collect(), scopes: image.scopes.into_iter().collect(),
            current_date: image.current_date.into_iter().collect(), reference: image.reference.into_iter().collect(),
            coverage_epoch: image.coverage_epoch.into_iter().collect(), context, market_events, retired_events, stale_generation, rollovers, ..Self::default()
        }
    }

    pub fn clear(&mut self) {
        self.keys.clear();
        self.scopes.clear();
        self.current_date.clear();
        self.reference.clear();
        self.live_keys.clear();
        self.live_scopes.clear();
        self.coverage_epoch.clear();
    }

    /// Every key inference may be asked for: the stored ones and the unlisted forks.
    pub fn key_ids(&self) -> Vec<KeyId> {
        self.keys.keys().chain(self.live_keys.keys().filter(|k| !self.keys.contains_key(*k))).cloned().collect()
    }

    pub fn key_count(&self) -> usize {
        self.keys.len() + self.live_keys.keys().filter(|k| !self.keys.contains_key(*k)).count()
    }

    pub fn warm_count(&self) -> usize {
        self.key_ids().iter().filter(|k| self.snapshot(k).is_some_and(|s| s.warm)).count()
    }
}

/// What a key's features read besides its own state.
struct Refs<'a> {
    index: Option<(&'a KeyState, &'a ScopeState)>,
    industry: Option<(&'a KeyState, &'a ScopeState)>,
    history: Option<&'a History>,
    index_history: Option<&'a History>,
    industry_group: Option<String>,
    code: String,
}

fn positive(units: i64) -> Option<f64> {
    (units > 0).then(|| price(units))
}

fn apply(event: &MarketEvent, state: &mut KeyState, scope: &mut ScopeState) -> Effect {
    let ts = event.exchange_ts_ns;
    let (minute, units, volume, side, kind) = match &event.payload {
        Payload::OrderBook { bids, asks, simtrade } => {
            let minute = clock_minute(event.exchange_ts_ns);
            if *simtrade && (SESSION_OPEN..CLOSING_BOOK).contains(&minute) {
                state.intraday_auction = true;
            }
            if !event.flags.backfill {
                state.cover(minute, true);
            }
            if ts < state.book_ns {
                return Effect::None;
            }
            state.book_ns = ts;
            state.bids = bids.iter().take(5).map(|l| (l.price, l.volume)).collect();
            state.asks = asks.iter().take(5).map(|l| (l.price, l.volume)).collect();
            let totals = (state.bids.iter().map(|l| l.1).sum::<f64>(), state.asks.iter().map(|l| l.1).sum::<f64>());
            state.first_book.get_or_insert(totals);
            state.book_minutes.insert(minute, totals);
            let newest = *state.book_minutes.keys().next_back().expect("inserted");
            while let Some((&oldest, &value)) = state.book_minutes.first_key_value() {
                if oldest >= newest - (KEEP_BOOK_MINUTES - 1) {
                    break;
                }
                state.book_minutes.remove(&oldest);
                state.book_floor = Some((oldest, value));
            }
            return Effect::Book;
        }
        Payload::Reference { .. } => {
            state.reference.absorb(&event.payload);
            return Effect::None;
        }
        Payload::Trade { price: p, minute, simtrade, volume, side, auction, after_hours, no_last_sale, open, average, amount, .. } => {
            // A print that sets no last sale (an odd lot, an average-price print) is no price, no side and no print
            // size of the market: in no column and, so that a day compares with its history, in no daily summary.
            if *simtrade || *after_hours || *no_last_sale || *p <= 0 {
                return Effect::None;
            }
            if state.is_newest(*minute, ts) {
                state.open = positive(*open).or(state.open);
                state.average = positive(*average).or(state.average);
            }
            state.session.print(price(*p), ts);
            if *auction {
                state.session.auction_volume += *volume;
                state.session.auction_amount += *amount;
                if *minute != SESSION_OPEN && *minute < CLOSING_AUCTION {
                    state.intraday_auction = true;
                }
                return Effect::None;
            }
            (*minute, *p, *volume, *side, "trade")
        }
        Payload::Quote { current, minute, volume, open, high, low, advance_count, decline_count, flat_count,
                         limit_up_count, limit_down_count, total_amount, .. } => {
            if state.is_newest(*minute, ts) {
                state.open = positive(*open).or(state.open);
                let count = |c: &Option<i64>, known: Option<f64>| c.map(|v| v as f64).or(known);
                let index = &mut state.index;
                index.advance = count(advance_count, index.advance);
                index.decline = count(decline_count, index.decline);
                index.flat = count(flat_count, index.flat);
                index.limit_up = count(limit_up_count, index.limit_up);
                index.limit_down = count(limit_down_count, index.limit_down);
                if *total_amount > 0.0 {
                    index.total_amount = Some((*total_amount, *minute));
                }
            }
            if *total_amount > 0.0 {
                state.index.amount_by_minute.insert(*minute, *total_amount);
            }
            if let (Some(o), Some(h), Some(l)) = (positive(*open), positive(*high), positive(*low)) {
                if state.index.day_bar.is_none_or(|(.., at)| ts >= at) {
                    state.index.day_bar = Some((o, h, l, ts));
                }
            }
            (*minute, *current, *volume, 0, "quote")
        }
        Payload::MinuteBar { minute, close, volume, .. } => (*minute, *close, *volume, 0, "minute_bar"),
        _ => return Effect::None,
    };
    if units <= 0 || minute < 0 {
        return Effect::None;
    }
    scope.touch(minute);
    // A live event proves the subscription is back; a gap's fill says nothing about the minutes after it.
    if !event.flags.backfill {
        state.cover(minute, true);
    }
    let newest = state.is_newest(minute, ts);
    let p = price(units);
    let agg = state.minutes.entry(minute).or_default();
    if agg.close.is_none() {
        state.minutes_observed += 1;
        if state.first_price_minute.is_none_or(|f| minute < f) {
            state.first_price_minute = Some(minute);
        }
    }
    if agg.open.is_none() || ts < agg.open_ns {
        (agg.open, agg.open_ns) = (Some(p), ts);
    }
    if agg.close.is_none() || ts >= agg.close_ns {
        (agg.close, agg.close_ns) = (Some(p), ts);
    }
    agg.high = Some(agg.high.map_or(p, |h| h.max(p)));
    agg.low = Some(agg.low.map_or(p, |l| l.min(p)));
    if kind == "minute_bar" {
        agg.volume = volume;
    } else {
        agg.volume += volume;
    }
    if kind == "trade" {
        let large = volume >= LARGE_LOTS;
        let small = volume < SMALL_LOTS;
        let amount = match &event.payload { Payload::Trade { amount, .. } => *amount, _ => 0.0 };
        agg.amount += amount;
        agg.trades += 1;
        let (buy, sell) = match side {
            1 => (volume, 0.0),
            -1 => (0.0, volume),
            _ => (0.0, 0.0),
        };
        agg.buy += buy;
        agg.sell += sell;
        if large {
            agg.large_buy += buy;
            agg.large_sell += sell;
        }
        if small {
            agg.small_buy += buy;
            agg.small_sell += sell;
        }
        let day = &mut state.day;
        day.volume += volume;
        day.amount += amount;
        day.trades += 1.0;
        day.buy += buy;
        day.sell += sell;
        if large {
            day.large_buy += buy;
            day.large_sell += sell;
            day.large_trades += 1.0;
            day.last_large_minute = Some(day.last_large_minute.map_or(minute, |m| m.max(minute)));
        }
        if small {
            day.small_buy += buy;
            day.small_sell += sell;
        }
        if day.high.is_none_or(|(h, _)| p > h) {
            day.high = Some((p, minute));
        }
        if day.low.is_none_or(|(l, _)| p < l) {
            day.low = Some((p, minute));
        }
        let bin = state.profile.entry(units).or_default();
        bin.volume += volume;
        bin.buy += buy;
        bin.sell += sell;
        if large {
            bin.large_buy += buy;
            bin.large_sell += sell;
        }
        if newest {
            let levels = [state.open, state.average, state.comparison()];
            for (cross, level) in state.crosses.iter_mut().zip(levels) {
                let Some(level) = level else { continue };
                let side = if p > level { 1 } else if p < level { -1 } else { 0 };
                if side != 0 && side != cross.side {
                    if cross.side != 0 {
                        cross.since = Some(minute);
                    }
                    cross.side = side;
                }
            }
        }
    }
    if newest {
        state.last_price = Some(p);
        state.last_price_minute = Some(minute);
        state.last_price_ns = ts;
    }
    match state.day_minutes.upto {
        // Into a minute already folded: the statistics are folded again from the minutes, which hold the whole day.
        Some(upto) if minute <= upto => state.day_minutes = DayMinutes::default(),
        _ if scope.clock == Some(minute) => {
            let mut day_minutes = std::mem::take(&mut state.day_minutes);
            advance_day(&mut day_minutes, state, scope);
            state.day_minutes = day_minutes;
        }
        _ => {}
    }
    Effect::Minute(minute)
}

/// Folds the completed minutes after `day.upto` through the scope's L into the day statistics: the 1-minute returns
/// (for today's std) and the minutes whose large outer volume exceeded large inner. The minute map holds them all, so
/// how often this runs is cost only: a snapshot folds whatever is still ahead of the cursor.
fn advance_day(day: &mut DayMinutes, state: &KeyState, scope: &ScopeState) {
    let Some(last) = scope.clock.map(|c| c - 1) else { return };
    let from = day.upto.map_or(SESSION_OPEN, |u| (u + 1).max(SESSION_OPEN));
    for m in from..=last {
        if m > SESSION_OPEN && usable(status(state, scope, m)) && usable(status(state, scope, m - 1)) {
            if let (Some(c1), Some(c0)) = (close_at(state, scope, m), close_at(state, scope, m - 1)) {
                if c0 > 0.0 {
                    let r = c1 / c0 - 1.0;
                    day.returns += 1.0;
                    day.sum += r;
                    day.sum_squares += r * r;
                }
            }
        }
        if state.minutes.get(&m).is_some_and(|a| a.large_buy > a.large_sell) {
            day.large_positive += 1.0;
        }
    }
    if last >= from {
        day.upto = Some(last);
    }
}

fn status(state: &KeyState, scope: &ScopeState, minute: i32) -> Status {
    if state.minutes.get(&minute).is_some_and(|a| a.close.is_some()) {
        return Status::Traded;
    }
    if state.first_price_minute.is_none_or(|f| minute < f) {
        return Status::Before;
    }
    // The scope's activity says the market was on; only the key's own subscription says this key would have been seen.
    if scope.active.contains(&minute) && state.observed(minute) { Status::NoTrade } else { Status::NoData }
}

fn close_at(state: &KeyState, scope: &ScopeState, minute: i32) -> Option<f64> {
    match status(state, scope, minute) {
        Status::Traded => state.minutes.get(&minute).and_then(|a| a.close),
        Status::NoTrade => state.minutes.range(..minute).rev().find_map(|(_, a)| a.close),
        _ => None,
    }
}

fn usable(s: Status) -> bool {
    matches!(s, Status::Traded | Status::NoTrade)
}

fn window_ok(state: &KeyState, scope: &ScopeState, first: i32, last: i32) -> bool {
    first >= SESSION_OPEN && (first..=last).all(|m| usable(status(state, scope, m)))
}

/// close(L) / close(L - n) - 1, both minutes inside the session and every minute between usable.
fn ret(state: &KeyState, scope: &ScopeState, last: i32, n: i32) -> f64 {
    if !window_ok(state, scope, last - n, last) {
        return f64::NAN;
    }
    match (close_at(state, scope, last), close_at(state, scope, last - n)) {
        (Some(c1), Some(c0)) if c0 > 0.0 => c1 / c0 - 1.0,
        _ => f64::NAN,
    }
}

fn ratio(a: f64, b: f64) -> f64 {
    if b != 0.0 && a.is_finite() && b.is_finite() { a / b } else { f64::NAN }
}

fn opt(value: Option<f64>) -> f64 {
    value.unwrap_or(f64::NAN)
}

/// Sums of minutes L-n+1..L.
#[derive(Default)]
struct Sums {
    volume: f64,
    trades: f64,
    buy: f64,
    sell: f64,
    large_buy: f64,
    large_sell: f64,
    small_buy: f64,
    small_sell: f64,
    high: Option<f64>,
    low: Option<f64>,
}

fn sums(state: &KeyState, scope: &ScopeState, last: i32, n: i32) -> Option<Sums> {
    if !window_ok(state, scope, last - n + 1, last) {
        return None;
    }
    let mut s = Sums::default();
    for m in last - n + 1..=last {
        let (high, low) = match state.minutes.get(&m).filter(|a| a.close.is_some()) {
            Some(agg) => {
                s.volume += agg.volume;
                s.trades += agg.trades as f64;
                s.buy += agg.buy;
                s.sell += agg.sell;
                s.large_buy += agg.large_buy;
                s.large_sell += agg.large_sell;
                s.small_buy += agg.small_buy;
                s.small_sell += agg.small_sell;
                (agg.high, agg.low)
            }
            None => (close_at(state, scope, m), close_at(state, scope, m)),
        };
        if let Some(h) = high {
            s.high = Some(s.high.map_or(h, |x| x.max(h)));
        }
        if let Some(l) = low {
            s.low = Some(s.low.map_or(l, |x| x.min(l)));
        }
    }
    Some(s)
}

/// Sample std of the 1-minute returns ending in minutes L-n+1..L (every minute L-n..L usable, inside the session).
fn ret_std(state: &KeyState, scope: &ScopeState, last: i32, n: i32) -> f64 {
    if !window_ok(state, scope, last - n, last) {
        return f64::NAN;
    }
    let mut returns = Vec::with_capacity(n as usize);
    for m in last - n + 1..=last {
        if let (Some(c1), Some(c0)) = (close_at(state, scope, m), close_at(state, scope, m - 1)) {
            if c0 > 0.0 {
                returns.push(c1 / c0 - 1.0);
            }
        }
    }
    std(returns.len() as f64, returns.iter().sum(), returns.iter().map(|r| r * r).sum())
}

fn std(n: f64, sum: f64, sum_squares: f64) -> f64 {
    if n < 3.0 {
        return f64::NAN;
    }
    let mean = sum / n;
    ((sum_squares - n * mean * mean).max(0.0) / (n - 1.0)).sqrt()
}

/// The 5 levels' queued volume at the end of `minute`, carried from the last minute with a book.
fn book_at(state: &KeyState, minute: i32) -> Option<(f64, f64)> {
    state.book_minutes.range(..=minute).next_back().map(|(_, v)| *v)
        .or_else(|| state.book_floor.filter(|(m, _)| *m <= minute).map(|(_, v)| v))
}

/// Builds the row in spec order; a debug build checks each name against NUMERIC_COLUMNS.
struct Row(Vec<f64>);

impl Row {
    fn push(&mut self, name: &str, value: f64) {
        debug_assert_eq!(NUMERIC_COLUMNS.get(self.0.len()).copied(), Some(name), "column {} out of spec order", self.0.len());
        self.0.push(value);
    }

    fn windows(&mut self, prefix: &str, values: impl IntoIterator<Item = f64>) {
        let names = ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "today"];
        for (suffix, value) in names.iter().zip(values) {
            self.push(&format!("{prefix}_{suffix}"), value);
        }
    }
}

fn evaluate(state: &KeyState, scope: &ScopeState, refs: &Refs) -> FeatureSnapshot {
    let last = scope.clock.map(|c| c - 1);
    let mut day_minutes = state.day_minutes.clone();
    advance_day(&mut day_minutes, state, scope);
    let lp = opt(state.last_price);
    let distance = |level: Option<f64>| level.map_or(f64::NAN, |l| ratio(lp - l, lp));
    let session_minutes = last.map_or(f64::NAN, |l| (l - SESSION_OPEN + 1) as f64);
    let since = |minute: Option<i32>| match (last, minute) {
        (Some(l), Some(m)) => (l - m).max(0) as f64,
        _ => f64::NAN,
    };
    let at = |n: i32| last.and_then(|l| sums(state, scope, l, n));
    let windows: Vec<Option<Sums>> = WINDOWS.iter().map(|n| at(*n)).collect();
    let day = &state.day;
    let mut row = Row(Vec::with_capacity(NUMERIC_COLUMNS.len()));

    // 價格位置
    row.push("last_price", lp);
    row.push("session_minute", session_minutes);
    let (high, low) = (day.high.map(|h| h.0), day.low.map(|l| l.0));
    row.push("day_range_position", match (high, low) {
        (Some(h), Some(l)) if h > l => (lp - l) / (h - l),
        _ => f64::NAN,
    });
    row.push("open_gap", match (state.open, state.comparison()) {
        (Some(o), Some(pc)) => ratio(o, pc) - 1.0,
        _ => f64::NAN,
    });
    row.push("minutes_since_day_high", since(day.high.map(|h| h.1)));
    row.push("minutes_since_day_low", since(day.low.map(|l| l.1)));

    // 報酬, 振幅, 報酬標準差
    let day_return = state.comparison().map_or(f64::NAN, |pc| ratio(lp, pc) - 1.0);
    let rets: Vec<f64> = WINDOWS.iter().map(|n| last.map_or(f64::NAN, |l| ret(state, scope, l, *n))).collect();
    row.windows("ret", rets.iter().copied().chain([day_return]));
    let ranges = windows.iter().map(|w| w.as_ref().and_then(|w| Some(ratio(w.high? - w.low?, lp))).unwrap_or(f64::NAN));
    row.windows("range", ranges.chain([match (high, low) {
        (Some(h), Some(l)) => ratio(h - l, lp),
        _ => f64::NAN,
    }]));
    for n in STD_WINDOWS {
        row.push(&format!("ret_std_{n}m"), last.map_or(f64::NAN, |l| ret_std(state, scope, l, n)));
    }
    row.push("ret_std_today", std(day_minutes.returns, day_minutes.sum, day_minutes.sum_squares));

    // 成交量, 量比, 成交筆數
    let per = |f: fn(&Sums) -> f64| -> Vec<f64> { windows.iter().map(|w| w.as_ref().map_or(f64::NAN, f)).collect() };
    let volumes = per(|w| w.volume);
    row.windows("vol", volumes.iter().copied().chain([day.volume]));
    for (n, v) in WINDOWS.iter().zip(&volumes) {
        row.push(&format!("vol_ratio_{n}m"), ratio(*v, day.volume / session_minutes * *n as f64));
    }
    row.windows("trades", per(|w| w.trades).into_iter().chain([day.trades]));

    // 日量與金額
    let history = refs.history;
    let mean = |n: usize, value: fn(&crate::day_context::PastDay) -> Option<f64>| history.and_then(|h| h.mean(n, value));
    for n in [5, 22, 88] {
        row.push(&format!("vol_today_vs_{n}d"), mean(n, |d| d.volume).map_or(f64::NAN, |m| ratio(day.volume, m)));
    }
    let same_time = |d: &crate::day_context::PastDay| last.and_then(|l| d.cumulative_at(l, true));
    row.push("vol_same_time_vs_1d", history.and_then(|h| h.previous()).and_then(same_time).map_or(f64::NAN, |v| ratio(day.volume, v)));
    let five = history.filter(|h| h.previous().is_some() && h.days.len() >= 5)
        .and_then(|h| h.days[..5].iter().map(same_time).sum::<Option<f64>>()).map(|total| total / 5.0);
    row.push("vol_same_time_vs_5d", five.map_or(f64::NAN, |v| ratio(day.volume, v)));
    row.push("log_amount_today", (1.0 + day.amount).ln());

    // 外盤比
    row.windows("buy_ratio", per(|w| ratio(w.buy, w.buy + w.sell)).into_iter().chain([ratio(day.buy, day.buy + day.sell)]));

    // 價位帶
    let last_units = state.last_price.map(|p| (p * PRICE_SCALE as f64).round() as i64);
    let side_ratio = |bins: &mut dyn Iterator<Item = &Bin>| {
        let (mut buy, mut sell) = (0.0, 0.0);
        for bin in bins {
            buy += bin.buy;
            sell += bin.sell;
        }
        ratio(buy, buy + sell)
    };
    let (at_level, above, below, above_share) = match last_units {
        Some(u) => (side_ratio(&mut state.profile.get(&u).into_iter()),
                    side_ratio(&mut state.profile.range(u + 1..).map(|(_, b)| b)),
                    side_ratio(&mut state.profile.range(..u).map(|(_, b)| b)),
                    ratio(state.profile.range(u + 1..).map(|(_, b)| b.volume).sum(), day.volume)),
        None => (f64::NAN, f64::NAN, f64::NAN, f64::NAN),
    };
    row.push("price_level_buy_ratio", at_level);
    row.push("above_buy_ratio", above);
    row.push("below_buy_ratio", below);
    row.push("above_volume_share", above_share);
    let poc = state.profile.iter().max_by(|a, b| a.1.volume.total_cmp(&b.1.volume).then(b.0.cmp(a.0))).map(|(p, _)| price(*p));
    row.push("dist_max_volume_price", distance(poc));
    let traded = |levels: &[(i64, f64)]| -> f64 {
        let queued: f64 = levels.iter().filter(|l| l.0 > 0).map(|l| l.1).sum();
        ratio(levels.iter().filter(|l| l.0 > 0).map(|l| state.profile.get(&l.0).map_or(0.0, |b| b.volume)).sum(), queued)
    };
    row.push("bid5_traded_vs_queue", traded(&state.bids));
    row.push("ask5_traded_vs_queue", traded(&state.asks));
    let large_at = |levels: &[(i64, f64)], f: fn(&Bin) -> f64| -> f64 {
        if levels.iter().all(|l| l.0 <= 0) {
            return f64::NAN;
        }
        ratio(levels.iter().filter(|l| l.0 > 0).map(|l| state.profile.get(&l.0).map_or(0.0, f)).sum(), day.volume)
    };
    row.push("bid5_large_sell_share", large_at(&state.bids, |b| b.large_sell));
    row.push("ask5_large_buy_share", large_at(&state.asks, |b| b.large_buy));

    // 壓力／支撐
    // A volume node (user's definition): of the 3 largest-volume prices on one side of the last price, the nearest.
    let largest_three = |side: &dyn Fn(i64) -> bool| -> Vec<(i64, f64)> {
        let mut nodes: Vec<(i64, f64)> = state.profile.iter().filter(|(p, _)| side(**p)).map(|(p, b)| (*p, b.volume)).collect();
        nodes.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        nodes.truncate(3);
        nodes
    };
    let (upper, lower) = match last_units {
        Some(u) => (largest_three(&|p| p > u).into_iter().min_by_key(|n| n.0),
                    largest_three(&|p| p < u).into_iter().max_by_key(|n| n.0)),
        None => (None, None),
    };
    let ma = |n: usize| mean(n, |d| d.close);
    let levels = [upper.map(|n| price(n.0)), lower.map(|n| price(n.0)), state.open, state.average, state.comparison(), high, low,
                  ma(5), ma(22), ma(88)];
    // prev_close is one of the levels (nearest_*, levels_within_1pct) but has no dist_ column: its distance is a
    // monotone transform of ret_today (user 11-08, feature importance report).
    for (name, level) in ["upper_node", "lower_node", "open", "vwap", "prev_close", "day_high", "day_low", "ma5", "ma22", "ma88"]
        .iter().zip(levels).filter(|(name, _)| **name != "prev_close") {
        row.push(&format!("dist_{name}"), distance(level));
    }
    let known: Vec<f64> = levels.iter().flatten().copied().filter(|_| lp.is_finite()).collect();
    let nearest = |pick: fn(f64, f64) -> Option<f64>| known.iter().filter_map(|l| pick(*l, lp)).fold(f64::NAN, f64::min);
    row.push("nearest_resistance", nearest(|l, p| (l > p).then(|| (l - p) / p)));
    row.push("nearest_support", nearest(|l, p| (l < p).then(|| (p - l) / p)));
    row.push("levels_within_1pct", if lp.is_finite() { known.iter().filter(|l| ((lp - *l) / lp).abs() <= 0.01).count() as f64 } else { f64::NAN });
    row.push("upper_node_volume_share", upper.map_or(f64::NAN, |n| ratio(n.1, day.volume)));
    row.push("lower_node_volume_share", lower.map_or(f64::NAN, |n| ratio(n.1, day.volume)));
    for (name, cross) in ["open", "vwap", "prev_close"].iter().zip(state.crosses) {
        row.push(&format!("minutes_since_cross_{name}"), match cross.since {
            Some(m) => since(Some(m)) * cross.side as f64,
            None => f64::NAN,
        });
    }

    // 大單／小單
    let net = |buy: f64, sell: f64, volume: f64| ratio(buy - sell, volume);
    let large_net: Vec<f64> = windows.iter().map(|w| w.as_ref().map_or(f64::NAN, |w| net(w.large_buy, w.large_sell, w.volume)))
        .chain([net(day.large_buy, day.large_sell, day.volume)]).collect();
    let small_net: Vec<f64> = windows.iter().map(|w| w.as_ref().map_or(f64::NAN, |w| net(w.small_buy, w.small_sell, w.volume)))
        .chain([net(day.small_buy, day.small_sell, day.volume)]).collect();
    row.windows("large_net", large_net.iter().copied());
    row.windows("large_share", windows.iter().map(|w| w.as_ref().map_or(f64::NAN, |w| ratio(w.large_buy + w.large_sell, w.volume)))
        .chain([ratio(day.large_buy + day.large_sell, day.volume)]));
    row.windows("small_net", small_net.iter().copied());
    row.windows("flow_divergence", large_net.iter().zip(&small_net).map(|(l, s)| l - s));
    row.push("large_net_positive_minute_ratio", ratio(day_minutes.large_positive, session_minutes));
    row.push("large_buy_ratio_today", ratio(day.large_buy, day.large_buy + day.large_sell));
    row.push("large_trades_today", day.large_trades);
    row.push("minutes_since_large", since(day.last_large_minute));

    // 五檔
    let bids: Vec<(f64, f64)> = state.bids.iter().filter(|l| l.0 > 0).map(|l| (price(l.0), l.1)).collect();
    let asks: Vec<(f64, f64)> = state.asks.iter().filter(|l| l.0 > 0).map(|l| (price(l.0), l.1)).collect();
    let (mut spread, mut imbalance_1, mut imbalance_5) = (f64::NAN, f64::NAN, f64::NAN);
    if !bids.is_empty() && !asks.is_empty() {
        let (b1, a1) = (bids[0].0, asks[0].0);
        if a1 >= b1 {
            spread = (a1 - b1) / ((a1 + b1) / 2.0) * 10_000.0;
        }
        imbalance_1 = ratio(bids[0].1 - asks[0].1, bids[0].1 + asks[0].1);
        let (bid_sum, ask_sum): (f64, f64) = (bids.iter().map(|l| l.1).sum(), asks.iter().map(|l| l.1).sum());
        imbalance_5 = ratio(bid_sum - ask_sum, bid_sum + ask_sum);
    }
    row.push("spread_bp", spread);
    row.push("book_imbalance_1", imbalance_1);
    row.push("book_imbalance_5", imbalance_5);
    let flow = |from: Option<(f64, f64)>, to: Option<(f64, f64)>| match (from, to) {
        (Some(a), Some(b)) => (b.0 - a.0) - (b.1 - a.1),
        _ => f64::NAN,
    };
    let book_last = last.and_then(|l| book_at(state, l));
    row.windows("book_flow", WINDOWS.iter().map(|n| match last {
        Some(l) if l - n >= SESSION_OPEN => flow(book_at(state, l - n), book_last),
        _ => f64::NAN,
    }).chain([flow(state.first_book, book_last)]));

    // 大盤
    let index = fresh(refs.index, last);
    let index_rets = index_returns(index, last);
    row.windows("index_ret", index_rets.iter().copied());
    row.push("index_fresh", if index.is_some() { 1.0 } else { 0.0 });
    let breadth = |facts: Option<&IndexFacts>, f: fn(&IndexFacts) -> Option<f64>| -> f64 {
        let Some(facts) = facts else { return f64::NAN };
        match (f(facts), facts.advance, facts.decline, facts.flat) {
            (Some(x), Some(a), Some(d), Some(fl)) => ratio(x, a + d + fl),
            _ => f64::NAN,
        }
    };
    let index_facts = index.map(|(s, _)| &s.index);
    row.push("index_advance_ratio", breadth(index_facts, |f| f.advance));
    row.push("index_limit_up_count", opt(index_facts.and_then(|f| f.limit_up)));
    row.push("index_limit_down_count", opt(index_facts.and_then(|f| f.limit_down)));
    row.push("index_amount_vs_1d", match (index_facts.and_then(|f| f.total_amount), refs.index_history.and_then(|h| h.previous())) {
        (Some((amount, minute)), Some(previous)) => previous.cumulative_at(minute, false).map_or(f64::NAN, |p| ratio(amount, p)),
        _ => f64::NAN,
    });

    // 產業
    let industry = fresh(refs.industry, last);
    let industry_rets = index_returns(industry, last);
    row.windows("industry_ret", industry_rets.iter().copied());
    row.windows("excess_ret", rets.iter().copied().chain([day_return]).zip(&industry_rets).map(|(r, i)| r - i));
    let industry_facts = industry.map(|(s, _)| &s.index);
    row.push("industry_advance_ratio", breadth(industry_facts, |f| f.advance));
    row.push("industry_limit_up_ratio", breadth(industry_facts, |f| f.limit_up));
    row.push("industry_limit_down_ratio", breadth(industry_facts, |f| f.limit_down));
    row.push("industry_fresh", if industry.is_some() { 1.0 } else { 0.0 });

    // 日 K
    let days = history.map(|h| h.days.as_slice()).unwrap_or(&[]);
    row.push("prev_day_return", history.and_then(|h| h.previous()).and_then(|d| Some(ratio(d.close?, d.prev_close?) - 1.0)).unwrap_or(f64::NAN));
    let back = |n: usize| -> f64 {
        match (days.first().and_then(|d| d.close), days.get(n).and_then(|d| d.close)) {
            (Some(c0), Some(cn)) => ratio(c0, cn) - 1.0,
            _ => f64::NAN,
        }
    };
    row.push("ret_5d", back(5));
    row.push("ret_22d", back(22));
    let extreme = |n: usize, f: fn(&crate::day_context::PastDay) -> Option<f64>, max: bool| -> Option<f64> {
        if days.len() < n {
            return None;
        }
        days[..n].iter().map(f).try_fold(if max { f64::NEG_INFINITY } else { f64::INFINITY }, |acc, v| v.map(|v| if max { acc.max(v) } else { acc.min(v) }))
    };
    row.push("dist_20d_high", distance(extreme(20, |d| d.high, true)));
    row.push("dist_20d_low", distance(extreme(20, |d| d.low, false)));
    let atr = if days.len() >= 14 {
        days[..14].iter().map(|d| Some(d.high?.max(d.prev_close?) - d.low?.min(d.prev_close?))).sum::<Option<f64>>().map(|t| t / 14.0)
    } else {
        None
    };
    row.push("atr_14d", atr.map_or(f64::NAN, |a| ratio(a, lp)));

    // 資料品質
    row.push("minutes_observed", state.minutes_observed as f64);
    row.push("intraday_auction", if state.intraday_auction { 1.0 } else { 0.0 });

    // 這一分鐘到目前為止
    let current = scope.clock.filter(|c| *c >= SESSION_OPEN);
    let this_minute = current.map(|c| state.minutes.get(&c).cloned().unwrap_or_default());
    row.push("minute_elapsed_seconds", if state.cutoff_ns > 0 { state.cutoff_ns.rem_euclid(60_000_000_000) as f64 / 1e9 } else { f64::NAN });
    row.push("ret_this_minute", match last {
        Some(l) if current.is_some() && l >= SESSION_OPEN && usable(status(state, scope, l)) => {
            close_at(state, scope, l).map_or(f64::NAN, |c| ratio(lp, c) - 1.0)
        }
        _ => f64::NAN,
    });
    row.push("vol_this_minute", this_minute.as_ref().map_or(f64::NAN, |m| m.volume));
    row.push("buy_ratio_this_minute", this_minute.as_ref().map_or(f64::NAN, |m| ratio(m.buy, m.buy + m.sell)));
    row.push("large_net_this_minute", this_minute.as_ref().map_or(f64::NAN, |m| ratio(m.large_buy - m.large_sell, m.volume)));

    // 個股性格
    let behaviour = history.map_or([f64::NAN; BEHAVIOUR_COLUMNS.len()], |h| h.behaviour);
    for (name, value) in BEHAVIOUR_COLUMNS.iter().zip(behaviour) {
        row.push(name, value);
    }

    debug_assert_eq!(row.0.len(), NUMERIC_COLUMNS.len());
    let warm = match (last, state.first_price_minute) {
        (Some(last), Some(first)) => last - first + 1 >= WARMUP_MINUTES,
        _ => false,
    };
    let categories = vec![refs.industry_group.clone().unwrap_or_else(|| MISSING_TOKEN.to_string()), refs.code.clone()];
    FeatureSnapshot { values: row.0, categories, warm, watermark: state.watermark, generation: state.generation, cutoff_ns: state.cutoff_ns }
}

/// An index whose scope has reached past the stock's L (its figures are as new as the stock's).
fn fresh<'a>(index: Option<(&'a KeyState, &'a ScopeState)>, last: Option<i32>) -> Option<(&'a KeyState, &'a ScopeState)> {
    index.filter(|(_, s)| last.is_some_and(|l| s.clock.is_some_and(|c| c > l)))
}

/// An index's returns over the windows and today, at the stock's L.
fn index_returns(index: Option<(&KeyState, &ScopeState)>, last: Option<i32>) -> Vec<f64> {
    let Some((state, scope)) = index else { return vec![f64::NAN; WINDOWS.len() + 1] };
    WINDOWS.iter().map(|n| last.map_or(f64::NAN, |l| ret(state, scope, l, *n)))
        .chain([match (state.last_price, state.comparison()) {
            (Some(p), Some(pc)) => ratio(p, pc) - 1.0,
            _ => f64::NAN,
        }]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(seq: u64, code: &str, date: &str, generation: u64, payload: Value) -> MarketEvent {
        serde_json::from_value(json!({
            "schema_version": 2, "durable_sequence": seq, "symbol": format!("shioaji:STK:{code}"), "provider": "shioaji",
            "market": "STK", "code": code, "session": "DAY", "trading_date": date,
            "generation": generation, "sequence": seq, "exchange_ts_ns": seq as i64 * 1_000_000_000, "payload": payload
        })).unwrap()
    }

    fn trade(price: i64, minute: i32, volume: i64, side: i8) -> Value {
        json!({"kind": "trade", "price": price, "volume": volume, "total_volume": 1, "side": side,
               "trade_id": "", "minute": minute, "open": 1_000_000, "high": 1_050_000,
               "low": 950_000, "average": 1_000_000, "total_amount": 0.0, "amount": price as f64 / PRICE_SCALE as f64 * volume as f64 * 1000.0})
    }

    fn key(code: &str) -> KeyId {
        KeyId { source: "shioaji".into(), market: "STK".into(), trading_date: "2026-09-29".into(), session: "DAY".into(), code: code.into() }
    }

    fn col(name: &str) -> usize {
        NUMERIC_COLUMNS.iter().position(|c| *c == name).unwrap()
    }

    /// A restart's index fill arrives after the live quote that ended its gap, in the same minute: the minute's close
    /// and the last price stay the live one (newest by exchange time); the filled minutes before it are observed.
    #[test]
    fn a_late_backfill_quote_is_no_newer_than_its_exchange_time() {
        let quote = |seq: u64, minute: i32, second: i64, current: i64| {
            let mut e = event(seq, "TAIEX", "2026-09-29", 1, json!({"kind": "quote", "current": current, "open": 0, "high": 0, "low": 0,
                "total_volume": 0.0, "total_amount": 0.0, "status": "live", "minute": minute, "average": 0, "volume": 0.0, "amount": 0.0}));
            e.market = "IDX".into();
            e.exchange_ts_ns = (i64::from(minute) * 60 + second) * 1_000_000_000;
            e.flags.backfill = seq > 1;
            e
        };
        let (mut state, mut scope) = (KeyState::default(), ScopeState::default());
        apply(&quote(1, 600, 30, 201_000_000), &mut state, &mut scope);
        apply(&quote(2, 599, 55, 200_000_000), &mut state, &mut scope);
        apply(&quote(3, 600, 10, 200_500_000), &mut state, &mut scope);
        assert_eq!(state.minutes[&600].close, Some(price(201_000_000)), "the live 10:00:30 quote stays the close");
        assert_eq!(state.minutes[&600].low, Some(price(200_500_000)));
        assert_eq!(state.last_price, Some(price(201_000_000)));
        assert_eq!(state.minutes[&599].close, Some(price(200_000_000)));
        assert_eq!(scope.clock, Some(600));
    }

    /// The user's definition: of the 3 largest-volume prices on ONE side of the last price, the nearest. The day's 3
    /// largest overall are all below here, which left the upper node missing although prices traded above.
    #[test]
    fn volume_nodes_are_taken_from_each_side_of_the_last_price() {
        let mut s = FeatureStore::default();
        for (i, (units, volume)) in [(1_000_000, 50), (1_010_000, 40), (1_020_000, 30), (1_090_000, 1), (1_120_000, 2), (1_110_000, 1), (1_100_000, 1)]
            .into_iter().enumerate() {
            s.fold(&event(i as u64 + 1, "A", "2026-09-29", 1, trade(units, 540 + i as i32, volume, 1)));
        }
        let values = s.snapshot(&key("A")).unwrap().values;
        let near = |a: f64, b: f64| (a - b).abs() < 1e-12;
        assert!(near(values[col("dist_upper_node")], (110.0 - 111.0) / 110.0), "the nearer of 111 and 112: {}", values[col("dist_upper_node")]);
        assert!(near(values[col("upper_node_volume_share")], 1.0 / 125.0));
        assert!(near(values[col("dist_lower_node")], (110.0 - 102.0) / 110.0), "109 is nearer but not among the 3 largest below");
        assert!(near(values[col("lower_node_volume_share")], 30.0 / 125.0));
        assert!(near(values[col("nearest_resistance")], 1.0 / 110.0));
        assert_eq!(values[col("levels_within_1pct")], 1.0, "111 is within 1%");
    }

    /// Market Runtime's coverage record of A or B at a Taipei minute of the test's trading date.
    fn coverage(seq: u64, code: &str, epoch: u64, minute: i64, state: &str) -> MarketEvent {
        let mut e = event(seq, code, "2026-09-29", epoch, json!({"kind": "source_status", "state": state, "detail": ""}));
        e.time_quality = COVERAGE_CONTROL.into();
        e.exchange_ts_ns = (market_runtime::event::days_from_civil(2026, 9, 29) * 86_400 + minute * 60 - 8 * 3600) * 1_000_000_000;
        e
    }

    /// A stock viewed for a while and left: the other stocks of its scope keep the minutes "active", but this key was
    /// not subscribed, so its silence is no data, never no trade carried forward on the old price.
    #[test]
    fn a_silent_minute_outside_the_keys_own_subscription_is_no_data() {
        let date = "2026-09-29";
        let mut s = FeatureStore::default();
        // The unlisted fork, as an unlisted stock reaches inference.
        assert!(matches!(s.fold_live_only(&event(1, "A", date, 1, trade(1_000_000, 540, 10, 1))), Folded::Changed(_)));
        let mut seq = 10;
        let mut other = |s: &mut FeatureStore, minute: i32| {
            seq += 1;
            s.fold(&event(seq, "B", date, 1, trade(500_000, minute, 1, 1)));
        };
        for m in 541..=544 {
            other(&mut s, m);
        }
        let vol_1m = |s: &FeatureStore| s.snapshot(&key("A")).unwrap().values[col("vol_1m")];
        assert_eq!(vol_1m(&s), 0.0, "subscribed and silent: no trade");
        s.fold(&coverage(100, "A", 1, 545, "unsubscribed"));
        for m in 545..=550 {
            other(&mut s, m);
        }
        assert!(vol_1m(&s).is_nan(), "L = 549: the scope was active, A was not subscribed");
        s.fold(&coverage(101, "A", 1, 555, "subscribed"));
        for m in 551..=556 {
            other(&mut s, m);
        }
        assert!(vol_1m(&s).is_nan(), "L = 555: subscribed during the minute, only partly seen");
        other(&mut s, 557);
        assert_eq!(vol_1m(&s), 0.0, "L = 556: subscribed for the whole minute again");
        assert!(s.snapshot(&key("A")).unwrap().values[col("ret_5m")].is_nan(), "a window across the gap is missing");
    }

    #[test]
    fn a_new_epoch_ends_the_subscriptions_it_does_not_confirm_and_a_first_record_ends_none() {
        let date = "2026-09-29";
        let mut s = FeatureStore::default();
        s.fold(&event(1, "A", date, 1, trade(1_000_000, 540, 10, 1)));
        s.fold(&event(2, "C", date, 1, trade(1_000_000, 540, 10, 1)));
        // A training fold's first record, of another code: A and C are not ended by it.
        s.fold(&coverage(3, "B", 5, 541, "subscribed"));
        s.fold(&coverage(4, "C", 5, 541, "subscribed"));
        for (i, m) in (541..=544).enumerate() {
            s.fold(&event(10 + i as u64, "B", date, 1, trade(500_000, m, 1, 1)));
        }
        let vol_1m = |s: &FeatureStore, code: &str| s.snapshot(&key(code)).unwrap().values[col("vol_1m")];
        assert_eq!(vol_1m(&s, "A"), 0.0);
        // Market Runtime restarted (epoch 6) and confirms C but no longer A.
        s.fold(&coverage(20, "C", 6, 545, "subscribed"));
        for (i, m) in (545..=548).enumerate() {
            s.fold(&event(30 + i as u64, "B", date, 1, trade(500_000, m, 1, 1)));
        }
        assert!(vol_1m(&s, "A").is_nan(), "L = 547: nobody confirmed A");
        assert_eq!(vol_1m(&s, "C"), 0.0, "C's own record carried it over");
        let restored = FeatureStore::from_image(s.image(), ContextSource::default());
        assert_eq!(restored.coverage_epoch["shioaji"], 6, "a checkpoint keeps the epoch");
        assert!(restored.stored_snapshot(&key("A")).unwrap().values[col("vol_1m")].is_nan());
    }

    /// A gap's fill says nothing about the minutes after it; a live event does prove the subscription is back.
    #[test]
    fn only_a_live_event_reopens_the_coverage() {
        let date = "2026-09-29";
        let mut s = FeatureStore::default();
        s.fold(&event(1, "A", date, 1, trade(1_000_000, 540, 10, 1)));
        s.fold(&coverage(2, "A", 1, 541, "unsubscribed"));
        let mut fill = event(3, "A", date, 0, trade(1_000_000, 545, 1, 1));
        fill.flags.backfill = true;
        s.fold(&fill);
        for (i, m) in (546..=549).enumerate() {
            s.fold(&event(10 + i as u64, "B", date, 1, trade(500_000, m, 1, 1)));
        }
        assert!(s.snapshot(&key("A")).unwrap().values[col("vol_1m")].is_nan(), "L = 548: still not subscribed");
        s.fold(&event(20, "A", date, 1, trade(1_000_000, 550, 1, 1)));
        for (i, m) in (551..=553).enumerate() {
            s.fold(&event(30 + i as u64, "B", date, 1, trade(500_000, m, 1, 1)));
        }
        assert_eq!(s.snapshot(&key("A")).unwrap().values[col("vol_1m")], 0.0, "L = 552: observed since its live print");
    }

    fn book(seq: u64, second: i64, bid: i64) -> MarketEvent {
        let mut e = event(seq, "A", "2026-09-29", 1, json!({"kind": "order_book", "simtrade": false,
            "bids": [{"price": bid, "volume": 7.0}], "asks": [{"price": bid + 10_000, "volume": 3.0}]}));
        e.exchange_ts_ns = second * 1_000_000_000;
        e
    }

    /// The exchange's own book times go backwards (1.3-1.5% of the books of a day, up to 0.14 s).
    #[test]
    fn an_older_book_never_replaces_a_newer_one() {
        let (mut state, mut scope) = (KeyState::default(), ScopeState::default());
        assert_eq!(apply(&book(1, 100, 1_000_000), &mut state, &mut scope), Effect::Book);
        assert_eq!(apply(&book(2, 99, 990_000), &mut state, &mut scope), Effect::None, "older: no change, nothing to infer");
        assert_eq!(state.bids[0].0, 1_000_000);
        assert_eq!(apply(&book(3, 100, 1_010_000), &mut state, &mut scope), Effect::Book);
        assert_eq!(state.bids[0].0, 1_010_000, "the same exchange time keeps durable order");
    }

    #[test]
    fn interleaved_sources_and_dates_load_each_day_context_once() {
        // A futures night, US stocks and crypto fold interleaved at night: a context cache of two reloaded one of the
        // three from disk on nearly every event (22:00-23:00 of 11-05: 324 s of feature folding in the hour).
        let mut s = FeatureStore::default();
        let at = |seq: u64, provider: &str, market: &str, code: &str, date: &str| -> MarketEvent {
            serde_json::from_value(json!({
                "schema_version": 2, "durable_sequence": seq, "symbol": format!("{provider}:{market}:{code}"), "provider": provider,
                "market": market, "code": code, "session": if provider == "futu" { "FULL" } else { "NIGHT" }, "trading_date": date,
                "generation": 1, "sequence": seq, "exchange_ts_ns": seq as i64 * 1_000_000_000, "payload": trade(1_000_000, 900, 1, 1)
            })).unwrap()
        };
        for i in 0..30u64 {
            s.fold(&at(3 * i + 1, "shioaji", "FUT", "TXFR1", "2026-11-05"));
            s.fold(&at(3 * i + 2, "futu", "US", "US.MU", "2026-11-05"));
            s.fold(&at(3 * i + 3, "futu", "CC", "CC.BTCUSD", "2026-11-06"));
        }
        assert_eq!(s.context_loads, 3, "one load per (source, trading date) held");
    }

    #[test]
    fn every_column_is_built_in_spec_order() {
        let mut s = FeatureStore::default();
        for m in 540..560 {
            s.fold(&event(m as u64, "A", "2026-09-29", 1, trade(1_000_000 + m as i64, m, 60, 1)));
        }
        assert_eq!(s.snapshot(&key("A")).unwrap().values.len(), NUMERIC_COLUMNS.len());
    }

    #[test]
    fn no_trade_carries_forward_and_no_data_is_never_zero() {
        let mut s = FeatureStore::default();
        s.fold(&event(1, "A", "2026-09-29", 1, trade(1_000_000, 540, 10, 1)));
        s.fold(&event(2, "B", "2026-09-29", 1, trade(500_000, 541, 1, 1)));  // scope alive in 541, A silent
        s.fold(&event(3, "A", "2026-09-29", 1, trade(1_010_000, 542, 5, -1)));
        let snap = s.snapshot(&key("A")).unwrap();
        // L = 541: NO_TRADE for A -> volume 0, close carried from 540.
        assert_eq!(snap.values[col("vol_1m")], 0.0);
        assert!((snap.values[col("ret_1m")] - 0.0).abs() < 1e-15, "541 carries 540's close: ret_1m 0");
        assert!(snap.values[col("ret_3m")].is_nan(), "a window reaching before 09:00 is missing");
        s.fold(&event(4, "B", "2026-09-29", 1, trade(500_000, 545, 1, 1)));
        s.fold(&event(5, "A", "2026-09-29", 1, trade(1_020_000, 545, 1, 1)));
        let snap = s.snapshot(&key("A")).unwrap();
        assert!(snap.values[col("vol_1m")].is_nan(), "L = 544 is NO_DATA: vol_1m is missing, not 0");
    }

    #[test]
    fn call_auctions_and_after_hours_never_enter_a_column() {
        let mut s = FeatureStore::default();
        let mut opening = trade(990_000, 540, 1615, 1);
        opening["auction"] = json!(true);
        s.fold(&event(1, "A", "2026-09-29", 1, opening));
        for m in 540..550 {
            s.fold(&event(10 + m as u64, "A", "2026-09-29", 1, trade(1_000_000, m, 2, -1)));
        }
        let mut after = trade(1_100_000, 870, 500, 1);
        after["after_hours"] = json!(true);
        assert_eq!(s.fold(&event(900, "A", "2026-09-29", 1, after)).0, Folded::NoFeatureEffect);
        let snap = s.snapshot(&key("A")).unwrap();
        assert_eq!(snap.values[col("vol_today")], 20.0, "the opening auction's 1,615 lots are not continuous trading");
        assert_eq!(snap.values[col("buy_ratio_today")], 0.0, "nor outer volume");
        assert_eq!(snap.values[col("last_price")], 100.0, "nor the price");
        assert_eq!(snap.values[col("intraday_auction")], 0.0, "the opening auction is not an intraday one");
        let mut intraday = trade(1_000_000, 600, 3, 1);
        intraday["auction"] = json!(true);
        s.fold(&event(901, "A", "2026-09-29", 1, intraday));
        assert_eq!(s.snapshot(&key("A")).unwrap().values[col("intraday_auction")], 1.0);
    }

    #[test]
    fn a_print_that_sets_no_last_sale_never_enters_a_column() {
        let mut s = FeatureStore::default();
        s.fold(&event(1, "A", "2026-09-29", 1, trade(1_000_000, 545, 2, -1)));
        let mut odd = trade(1_200_000, 546, 300, 1);
        odd["no_last_sale"] = json!(true);
        assert_eq!(s.fold(&event(2, "A", "2026-09-29", 1, odd)).0, Folded::NoFeatureEffect);
        let snap = s.snapshot(&key("A")).unwrap();
        assert_eq!((snap.values[col("last_price")], snap.values[col("vol_today")], snap.values[col("buy_ratio_today")]), (100.0, 2.0, 0.0));
    }

    #[test]
    fn large_and_small_prints_and_the_price_profile() {
        let mut s = FeatureStore::default();
        s.fold(&event(1, "A", "2026-09-29", 1, trade(1_000_000, 540, 60, 1)));    // large outer
        s.fold(&event(2, "A", "2026-09-29", 1, trade(1_010_000, 540, 5, -1)));    // small inner
        s.fold(&event(3, "A", "2026-09-29", 1, trade(1_010_000, 541, 20, 1)));    // medium outer
        s.fold(&event(4, "A", "2026-09-29", 1, trade(1_000_000, 542, 1, 1)));
        let v = s.snapshot(&key("A")).unwrap().values;
        assert_eq!(v[col("large_trades_today")], 1.0);
        assert!((v[col("large_net_today")] - 60.0 / 86.0).abs() < 1e-12);
        assert!((v[col("small_net_today")] - (1.0 - 5.0) / 86.0).abs() < 1e-12);
        assert!((v[col("above_volume_share")] - 25.0 / 86.0).abs() < 1e-12, "101 traded above the last price 100");
        assert_eq!(v[col("dist_max_volume_price")], 0.0, "100 has the most volume");
        assert_eq!(v[col("minutes_since_large")], 1.0, "L = 541, the large print in 540");
    }

    fn timed(seq: u64, code: &str, generation: u64, minute: i32, second: i64, payload: Value) -> MarketEvent {
        let mut e = event(seq, code, "2026-09-29", generation, payload);
        e.exchange_ts_ns = (i64::from(minute) * 60 + second) * 1_000_000_000;
        e
    }

    fn index_quote(seq: u64, generation: u64, minute: i32, current: i64, ohl: [i64; 3], amount: f64) -> MarketEvent {
        let mut e = timed(seq, "TAIEX", generation, minute, 0, json!({"kind": "quote", "current": current, "open": ohl[0],
            "high": ohl[1], "low": ohl[2], "total_volume": 0.0, "total_amount": amount, "status": "live", "minute": minute,
            "average": 0, "volume": 0.0, "amount": 0.0}));
        e.market = "IDX".into();
        e.symbol = "shioaji:IDX:TAIEX".into();
        e
    }

    fn index_key() -> KeyId {
        KeyId { market: "IDX".into(), ..key("TAIEX") }
    }

    /// A reconnect is a new broker connection, not a new day: the key keeps what the session traded.
    #[test]
    fn a_reconnect_keeps_the_days_totals_and_only_an_older_connection_is_refused() {
        let mut s = FeatureStore::default();
        s.fold(&event(0, "A", "2026-09-29", 1, json!({"kind": "reference", "prev_close": 800_000})));
        s.fold(&timed(1, "A", 1, 540, 1, trade(1_000_000, 540, 60, 1)));
        s.fold(&timed(2, "A", 2, 541, 1, trade(1_000_000, 541, 10, -1)));
        let v = s.snapshot(&key("A")).unwrap().values;
        assert_eq!((v[col("vol_today")], v[col("trades_today")], v[col("large_trades_today")]), (70.0, 2.0, 1.0));
        assert_eq!(v[col("minutes_observed")], 2.0);
        assert!((v[col("ret_today")] - 0.25).abs() < 1e-12);
        assert_eq!(s.snapshot(&key("A")).unwrap().generation, 2);
        let (folded, _) = s.fold(&timed(3, "A", 1, 542, 1, trade(1_000_000, 542, 10, 1)));
        assert_eq!(folded, Folded::StaleGeneration, "an event of a connection older than the newest seen");
        assert_eq!(s.snapshot(&key("A")).unwrap().values[col("vol_today")], 70.0);
    }

    #[test]
    fn a_reconnect_keeps_an_index_keys_state() {
        let mut s = FeatureStore::default();
        let ohl = [1_010_000, 1_030_000, 990_000];
        s.fold(&index_quote(1, 1, 540, 1_010_000, ohl, 5.0e9));
        s.fold(&index_quote(2, 2, 541, 1_020_000, ohl, 6.0e9));
        let day = s.closing_state(&index_key()).unwrap().index_day();
        assert_eq!(day["minutes"], json!({"540": 5.0e9, "541": 6.0e9}), "{day}");
        assert_eq!(s.snapshot(&index_key()).unwrap().values[col("minutes_observed")], 2.0);
    }

    #[test]
    fn the_reference_after_the_close_leaves_the_closing_state() {
        let mut s = FeatureStore::default();
        s.fold(&timed(1, "A", 1, 530, 0, json!({"kind": "reference", "prev_close": 800_000, "limit_up": 880_000, "limit_down": 720_000})));
        s.fold(&timed(2, "A", 1, 700, 0, trade(1_000_000, 700, 10, 1)));
        let before = s.closing_state(&key("A")).unwrap().stock_day();
        // 13:40: every code's reference again, on a connection of its own.
        let (folded, _) = s.fold(&timed(3, "A", 9, 820, 0, json!({"kind": "reference", "prev_close": 800_000, "limit_up": 880_000, "limit_down": 720_000})));
        assert_eq!(folded, Folded::NoFeatureEffect);
        assert_eq!(s.closing_state(&key("A")).unwrap().stock_day(), before);
        assert_eq!(before["volume"], json!(10.0));
    }

    /// The broker's history (generation 0) fills a gap of the morning after the close: the day's totals and the minute
    /// take it, more than KEEP_BOOK_MINUTES late or not; the last price and what follows the tape do not move.
    #[test]
    fn a_print_filled_hours_late_enters_the_day_and_its_minute_but_is_not_the_newest() {
        let mut s = FeatureStore::default();
        for m in [540, 541, 800] {
            s.fold(&timed(m as u64, "A", 5, m, 1, trade(1_000_000, m, 2, 1)));
        }
        let mut filled = trade(1_100_000, 600, 70, 1);
        filled["amount"] = json!(0.0);
        filled["average"] = json!(900_000);
        let (folded, _) = s.fold(&timed(900, "A", 0, 600, 1, filled));
        assert_eq!(folded, Folded::Changed(key("A")));
        let state = s.closing_state(&key("A")).unwrap();
        assert_eq!(state.minutes[&600].volume, 70.0);
        assert_eq!(state.day.volume, 76.0);
        assert_eq!(state.day.high, Some((110.0, 600)));
        assert_eq!(state.last_price, Some(100.0), "the newest print stays the last price");
        assert_eq!(state.average, Some(100.0), "the running average stays the newest print's");
        assert_eq!(state.day.last_large_minute, Some(600));
        let mut older = trade(1_000_000, 590, 60, 1);
        older["amount"] = json!(0.0);
        s.fold(&timed(901, "A", 0, 590, 1, older));
        let state = s.closing_state(&key("A")).unwrap();
        assert_eq!(state.day.last_large_minute, Some(600), "the newest large print is by time, not by arrival");
    }

    #[test]
    fn a_late_print_does_not_cross_a_level() {
        let mut s = FeatureStore::default();
        s.fold(&event(0, "A", "2026-09-29", 1, json!({"kind": "reference", "prev_close": 1_000_000})));
        s.fold(&timed(1, "A", 1, 540, 1, trade(1_010_000, 540, 1, 1)));
        s.fold(&timed(2, "A", 1, 700, 1, trade(1_020_000, 700, 1, 1)));
        s.fold(&timed(3, "A", 0, 600, 1, trade(900_000, 600, 1, -1)));
        let crosses = s.closing_state(&key("A")).unwrap().crosses;
        assert_eq!((crosses[2].side, crosses[2].since), (1, None), "above prev_close all along as the tape went");
    }

    /// A future's Reference names its settlement (reference_price) and no prev_close: its moves are measured from the
    /// settlement, by the one absorb rule, and a later partial Reference never erases a known field.
    #[test]
    fn the_comparison_price_is_the_reference_price_or_else_prev_close() {
        let mut s = FeatureStore::default();
        s.fold(&event(0, "A", "2026-09-29", 1, json!({"kind": "reference", "reference_price": 1_000_000, "limit_up": 1_100_000})));
        s.fold(&event(1, "A", "2026-09-29", 1, json!({"kind": "reference", "limit_down": 900_000})));
        let state = s.closing_state(&key("A")).unwrap();
        assert_eq!(state.comparison(), Some(100.0));
        assert_eq!((state.reference.limit_up, state.reference.limit_down), (Some(1_100_000), Some(900_000)));
        let mut s = FeatureStore::default();
        s.fold(&event(0, "A", "2026-09-29", 1, json!({"kind": "reference", "prev_close": 990_000})));
        assert_eq!(s.closing_state(&key("A")).unwrap().comparison(), Some(99.0));
    }

    /// The day statistics are those of the minutes, however the prints arrived.
    #[test]
    fn the_day_statistics_of_a_late_arrival_equal_those_of_the_same_prints_on_time() {
        let prints: Vec<(i32, i64, i64)> = (540..640).map(|m| (m, 1_000_000 + (i64::from(m) * 7) % 13 * 1_000, if m % 5 == 0 { 60 } else { 2 })).collect();
        let mut on_time = FeatureStore::default();
        for (i, (m, p, v)) in prints.iter().enumerate() {
            on_time.fold(&timed(i as u64, "A", 1, *m, 1, trade(*p, *m, *v, 1)));
        }
        let mut late = FeatureStore::default();
        let (held, sent): (Vec<_>, Vec<_>) = prints.iter().partition(|(m, ..)| (560..570).contains(m));
        for (i, (m, p, v)) in sent.iter().enumerate() {
            late.fold(&timed(i as u64, "A", 1, *m, 1, trade(*p, *m, *v, 1)));
        }
        for (i, (m, p, v)) in held.iter().enumerate() {
            late.fold(&timed(1000 + i as u64, "A", 0, *m, 1, trade(*p, *m, *v, 1)));
        }
        let (a, b) = (on_time.snapshot(&key("A")).unwrap().values, late.snapshot(&key("A")).unwrap().values);
        for name in ["ret_std_today", "large_net_positive_minute_ratio", "vol_today", "trades_today"] {
            assert_eq!(a[col(name)], b[col(name)], "{name}");
        }
    }

    #[test]
    fn the_windows_read_only_their_own_minutes_with_the_whole_day_kept() {
        let mut s = FeatureStore::default();
        for m in 540..700 {
            s.fold(&event(m as u64, "A", "2026-09-29", 1, trade(1_000_000 + i64::from(m) * 100, m, 1, 1)));
        }
        let v = s.snapshot(&key("A")).unwrap().values;
        assert_eq!(v[col("vol_60m")], 60.0, "L = 698: minutes 639..=698");
        assert!((v[col("ret_60m")] - ((1_000_000.0 + 69_800.0) / (1_000_000.0 + 63_800.0) - 1.0)).abs() < 1e-12);
        assert_eq!(s.closing_state(&key("A")).unwrap().minutes.len(), 160);
    }

    /// The daily summary is the closing state: the call auctions in the day's bar and volume, not in a minute.
    #[test]
    fn a_stocks_closing_state_is_its_day() {
        let mut s = FeatureStore::default();
        s.fold(&event(0, "A", "2026-09-29", 1, json!({"kind": "reference", "prev_close": 1_000_000, "limit_up": 1_100_000, "limit_down": 900_000})));
        let mut open = trade(990_000, 540, 5, 1);
        open["auction"] = json!(true);
        s.fold(&timed(1, "A", 1, 540, 0, open));
        s.fold(&timed(2, "A", 1, 540, 5, trade(1_010_000, 540, 60, 1)));
        s.fold(&timed(3, "A", 1, 540, 9, trade(1_020_000, 540, 1, -1)));
        // A fill of the same minute, earlier than both: the minute's first price by exchange time.
        s.fold(&timed(4, "A", 0, 540, 2, trade(1_000_000, 540, 2, -1)));
        let mut close = trade(1_030_000, 810, 7, 1);
        close["auction"] = json!(true);
        s.fold(&timed(5, "A", 1, 810, 0, close));
        let day = s.closing_state(&key("A")).unwrap().stock_day();
        assert_eq!([&day["open"], &day["high"], &day["low"], &day["close"]].map(|v| v.as_f64()), [Some(99.0), Some(103.0), Some(99.0), Some(103.0)], "{day}");
        assert_eq!((&day["volume"], &day["auction_volume"]), (&json!(75.0), &json!(12.0)));
        assert_eq!([&day["prev_close"], &day["limit_up"], &day["limit_down"]].map(|v| v.as_f64()), [Some(100.0), Some(110.0), Some(90.0)]);
        let amount = 101.0 * 60.0 * 1000.0 + 102.0 * 1000.0 + 100.0 * 2.0 * 1000.0;
        assert_eq!(day["minutes"], json!({"540": [63.0, amount, 102.0, 102.0, 100.0, 60.0, 0.0, 100.0]}), "[volume, amount, close, high, low, large_buy, large_sell, open]");
    }

    #[test]
    fn rollover_retires_and_late_events_do_not_resurrect() {
        let mut s = FeatureStore::default();
        s.fold(&event(1, "A", "2026-09-28", 1, trade(1_000_000, 540, 1, 1)));
        let (_, retired) = s.fold(&event(2, "A", "2026-09-29", 1, trade(1_000_000, 540, 1, 1)));
        assert_eq!(retired.len(), 1);
        let (folded, _) = s.fold(&event(3, "A", "2026-09-28", 1, trade(1_000_000, 541, 1, 1)));
        assert_eq!(folded, Folded::RetiredScope);
    }

    #[test]
    fn today_statistics_survive_the_minute_map_window() {
        // A key silent for longer than the longest window still has its whole day.
        let mut s = FeatureStore::default();
        for m in 540..560 {
            s.fold(&event(m as u64, "A", "2026-09-29", 1, trade(1_000_000 + (m as i64 % 3) * 1_000, m, 1, 1)));
        }
        for m in 560..700 {
            s.fold(&event(m as u64, "B", "2026-09-29", 1, trade(500_000, m, 1, 1)));
        }
        s.fold(&event(700, "A", "2026-09-29", 1, trade(1_000_000, 700, 1, 1)));
        let v = s.snapshot(&key("A")).unwrap().values;
        assert_eq!(v[col("vol_today")], 21.0);
        assert!(v[col("ret_std_today")] > 0.0);
    }
}
