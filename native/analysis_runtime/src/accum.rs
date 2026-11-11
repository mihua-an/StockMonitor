//! Rust B accumulation: per-minute OHLCV + quality, recent windows, full-session aggregates, fixed K bars and
//! large/small order flow (docs/system-architecture/02 sections 2-5).
//!
//! Volume authority per instrument and minute is chosen once, strongest first: individual prints (Trade, or a
//! Quote carrying its own tick volume) > a cumulative-total quote stream (volume = cumulative delta) > a source
//! minute bar (a later push for the same minute REPLACES it) > a backfill bar strictly before its cut-off.
//! Unknown volume is never zero: a minute nobody observed is MISSING, not a no-trade minute.

use market_runtime::calendar::{CalKey, Calendar};
use crate::rules::RuleSet;
use market_runtime::event::{minute_timestamp, partition_local_minute, MarketEvent, Payload};
use market_runtime::state::Reference;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

/// The product row's K columns (1mK / 3mK / 5mK).
pub const FIXED_K_ROW: [i32; 3] = [1, 3, 5];
const MAX_TICKS_PER_INSTRUMENT: usize = 2_000_000;
#[cfg(test)]
thread_local! { static TICK_CAP: std::cell::Cell<usize> = const { std::cell::Cell::new(MAX_TICKS_PER_INSTRUMENT) }; }
#[cfg(test)]
fn tick_cap() -> usize { TICK_CAP.with(|c| c.get()) }
#[cfg(not(test))]
fn tick_cap() -> usize { MAX_TICKS_PER_INSTRUMENT }

/// Price units -> the decimal money a wire carries: Market Runtime's one conversion (event::PRICE_SCALE).
pub use market_runtime::wire::money;
pub(crate) fn opt_money(v: Option<i64>) -> Value {
    v.map(|x| json!(money(x))).unwrap_or(Value::Null)
}
use market_runtime::volume::{self as vol, Volume};

/// One flow side bucket for the minute series: buy / sell / unknown / net, written as volumes.
pub(crate) fn side_wire(b: &SideBucket) -> Value {
    json!({"buy": vol::wire(b.buy), "sell": vol::wire(b.sell), "unknown": vol::wire(b.unknown), "net": vol::wire(b.buy - b.sell)})
}

/// A share of a volume total; none when the total is no real quantity (crate volume tolerance, not `> 0`).
pub(crate) fn ratio(num: Volume, den: Volume) -> Value {
    if vol::positive(den).is_some() { json!(vol::clean(num / den)) } else { Value::Null }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct InstrumentId {
    pub source: String,
    pub market: String,
    pub code: String,
    pub trading_date: String,
    pub session: String,
}

impl InstrumentId {
    pub fn of(e: &MarketEvent) -> Self {
        let k = e.instrument();
        Self { source: k.source, market: k.market, code: k.code, trading_date: e.trading_date.clone(), session: e.session.to_uppercase() }
    }
    /// The calendar key of this partition: a session-partitioned market (shioaji FUT) reads only its own session.
    pub fn cal_key(&self) -> CalKey<'_> {
        CalKey { source: &self.source, market: &self.market,
                 session: market_runtime::event::is_session_partitioned(&self.source, &self.market).then_some(self.session.as_str()),
                 date: Some(&self.trading_date) }
    }
    pub fn scope(&self) -> ScopeId {
        ScopeId { source: self.source.clone(), market: self.market.clone(), trading_date: self.trading_date.clone(), session: self.session.clone() }
    }
    pub fn identity(&self) -> Value {
        json!({"source": self.source, "market": self.market, "code": self.code, "trading_date": self.trading_date, "session": self.session})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ScopeId {
    pub source: String,
    pub market: String,
    pub trading_date: String,
    pub session: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Quality {
    Traded,
    NoTradeSynthetic,
    NoTradeNoPrice,
    Missing,
    Partial,
}

impl Quality {
    pub fn name(self) -> &'static str {
        match self {
            Quality::Traded => "TRADED",
            Quality::NoTradeSynthetic => "NO_TRADE_SYNTHETIC",
            Quality::NoTradeNoPrice => "NO_TRADE_NO_PRICE",
            Quality::Missing => "MISSING",
            Quality::Partial => "PARTIAL",
        }
    }
    pub(crate) fn gap(self) -> bool {
        matches!(self, Quality::Missing | Quality::Partial)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum Authority {
    None,
    BackfillBar,
    SourceBar,
    Cumulative,
    Ticks,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SideBucket {
    pub buy: f64,
    pub sell: f64,
    pub unknown: f64,
    pub count: u64,
}

impl SideBucket {
    /// `sign` +1 adds the print, -1 takes it back (a re-classification).
    fn add(&mut self, side: i8, volume: Volume, sign: i64) {
        let signed = sign as f64 * volume;
        match side {
            1 => self.buy += signed,
            -1 => self.sell += signed,
            _ => self.unknown += signed,
        }
        if sign > 0 {
            self.count += 1;
        } else {
            self.count = self.count.saturating_sub(1);
        }
    }
    pub(crate) fn merge(&mut self, other: &SideBucket) {
        self.buy += other.buy;
        self.sell += other.sell;
        self.unknown += other.unknown;
        self.count += other.count;
    }
    pub(crate) fn total(&self) -> Volume {
        self.buy + self.sell + self.unknown
    }
    /// Ratios over the KNOWN-direction denominator; the unknown share is reported separately.
    pub(crate) fn wire(&self, grand_total: Volume) -> Value {
        let known = self.buy + self.sell;
        json!({"buy": vol::wire(self.buy), "sell": vol::wire(self.sell), "unknown": vol::wire(self.unknown), "count": self.count,
               "total": vol::wire(self.total()), "net": vol::wire(self.buy - self.sell),
               "buy_ratio": ratio(self.buy, known), "sell_ratio": ratio(self.sell, known), "net_ratio": ratio(self.buy - self.sell, known),
               "unknown_ratio": ratio(self.unknown, self.total()), "class_ratio": ratio(self.total(), grand_total)})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Flow {
    pub large: SideBucket,
    pub small: SideBucket,
    /// Volume that could not be classified (no rule for the instrument): it never disappears.
    pub unclassified: SideBucket,
}

impl Flow {
    fn add(&mut self, large: Option<bool>, side: i8, volume: Volume, sign: i64) {
        match large {
            Some(true) => self.large.add(side, volume, sign),
            Some(false) => self.small.add(side, volume, sign),
            None => self.unclassified.add(side, volume, sign),
        }
    }
    pub(crate) fn merge(&mut self, o: &Flow) {
        self.large.merge(&o.large);
        self.small.merge(&o.small);
        self.unclassified.merge(&o.unclassified);
    }
    pub(crate) fn total(&self) -> Volume {
        self.large.total() + self.small.total() + self.unclassified.total()
    }
    /// `net`: buy - sell over every class, unclassified included (the 累計盤差 the ratio tab shows).
    pub fn wire(&self, rule: Option<&str>) -> Value {
        let total = self.total();
        let net = [&self.large, &self.small, &self.unclassified].iter().map(|b| b.buy - b.sell).sum::<Volume>();
        let mut wire = json!({"total": vol::wire(total), "net": vol::wire(net), "availability": if rule.is_some() { "OK" } else { "NO_RULE" }, "rule_id": rule,
                              "ratio_unit": "decimal_ratio"});
        wire["large"] = self.large.wire(total);
        wire["small"] = self.small.wire(total);
        wire["unclassified"] = self.unclassified.wire(total);
        wire
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CTrade {
    pub seq: u64,
    pub ts: i64,
    pub price: i64,
    pub volume: f64,
    /// 1 buy, -1 sell, 0 unknown
    pub side: i8,
    /// 0 unknown, 1 source, 2 quote rule
    pub method: u8,
    pub id: String,
    pub large: Option<bool>,
    /// Why it is large: bit 1 = single-print volume, bit 2 = accumulated attack impact.
    pub large_reason: u8,
    /// The attack episode the print belongs to (0 = none / unknown side).
    pub episode: u64,
    /// Matched by a call auction (see `Instrument::is_auction_print`): the whole book crossed at one price, not
    /// anybody's order. Never large, never part of an attack, and not continuous-trading volume (爆量).
    pub auction: bool,
    /// A print that sets no last sale (Market Runtime's Payload::Trade::no_last_sale: an odd lot, an average-price
    /// print): its volume is the minute's, its price is no open / high / low / close, it has no side and is never large.
    #[serde(default)]
    pub no_last_sale: bool,
    /// The print's traded amount and the broker's running average price as it reported them (0 = not reported):
    /// raw facts carried for the minute's 成交金額 / 均價 (the history store reads them).
    pub amount: f64,
    pub average: i64,
}

impl CTrade {
    /// The print's identity, as the renderer's tape matches it: a stored print is its durable sequence (unique in the
    /// stream); a never-stored one (the live lane, sequence 0) is its exchange time with the source trade id. The
    /// source trade id alone is not unique (Shioaji reuses it within a session).
    pub fn identity(&self) -> (u64, i64, String) {
        if self.seq > 0 { (self.seq, 0, String::new()) } else { (0, self.ts, self.id.clone()) }
    }

    /// The (durable sequence, exchange time) a list orders by first (`list_order`), as a minute records its newest.
    pub(crate) fn list_key(&self) -> (u64, i64) {
        (self.seq, self.ts)
    }

    /// The order large prints are listed in (callers reverse it for newest first): stream order for stored prints,
    /// exchange time for never-stored ones; the id last, so the copies of one print sit together for dedup.
    pub fn list_order(&self, other: &CTrade) -> std::cmp::Ordering {
        (self.seq, self.ts, &self.id).cmp(&(other.seq, other.ts, &other.id))
    }
}

pub const LARGE_BY_VOLUME: u8 = 1;
pub const LARGE_BY_IMPACT: u8 = 2;
/// The attack the print belongs to reached the rule's threshold in total (e.g. 5 x 80 lots against 100 lots).
pub const LARGE_BY_EPISODE: u8 = 4;
/// An attack is bounded in time as well as by its gaps: a large order split into child orders completes in
/// seconds; without a cap a busy stock's continuous small buying could chain into one "attack".
pub const EPISODE_MAX_MS_DEFAULT: i64 = 3000;
/// Impact needs the attack to reach this fraction of the size threshold too (see FlowRule::impact_min_fraction).
pub const IMPACT_MIN_FRACTION_DEFAULT: f64 = 0.5;
/// Smallest print (as a fraction of the size threshold) an attack's verdict applies to (FlowRule::member_min_fraction).
pub const MEMBER_MIN_FRACTION_DEFAULT: f64 = 0.1;
/// Prints remembered per attack for the retroactive mark (an attack longer than this is not a split order).
const EPISODE_MEMBERS_MAX: usize = 256;
/// Large prints kept for the trade-detail marks (newest first on the wire).
pub const LARGE_ORDERS_WIRE: usize = 300;

/// Best bid/ask with their volumes, from the latest order book at or before a print.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct BookTop {
    pub ts: i64,
    pub bid: i64,
    pub bid_volume: f64,
    pub ask: i64,
    pub ask_volume: f64,
}

/// One same-side attack (legacy LargeOrderPolicy episode): the opposite best liquidity it encountered and the
/// volume it consumed.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Episode {
    pub id: u64,
    pub side: i8,
    pub last_ts: i64,
    pub best_price: Option<i64>,
    pub encountered: f64,
    pub consumed: f64,
    /// The order book the episode last accounted for: a print without a newer book says nothing about
    /// replenishment (the same queue must not be counted twice).
    pub book_ts: i64,
    pub started_ts: i64,
    /// Once the attack qualifies, every print in it is large -- earlier ones included (one attack is one order).
    pub large: bool,
    /// (minute, durable sequence) of the attack's prints big enough to share its verdict, for the retroactive mark.
    pub members: Vec<(i32, u64)>,
    /// Volume of those prints: what the attack's total is held to the size threshold with.
    pub qualified: f64,
}

/// Prints folded into aggregates (what a checkpoint keeps instead of every print). The prices are those of the
/// prints that set the last sale (None when every print folded set none); volume, trades, flow and amount are every
/// print's.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TickAggregate {
    pub open: Option<i64>,
    pub high: Option<i64>,
    pub low: Option<i64>,
    pub close: Option<i64>,
    pub volume: f64,
    pub trades: u64,
    /// Exchange times of the first and the newest priced print (the open's and the close's).
    pub first_ts: i64,
    pub last_ts: i64,
    pub flow: Flow,
    pub auction_volume: f64,
    pub amount: f64,
    /// The broker's running average at the newest print (0 = none reported).
    pub average: i64,
}

impl TickAggregate {
    fn empty() -> Self {
        Self { open: None, high: None, low: None, close: None, volume: 0.0, trades: 0, first_ts: i64::MAX, last_ts: i64::MIN,
            flow: Flow::default(), auction_volume: 0.0, amount: 0.0, average: 0 }
    }

    /// One print, in any order: the open and close follow exchange time.
    fn absorb(&mut self, t: &CTrade) {
        self.volume += t.volume;
        self.trades += 1;
        self.flow.add(t.large, t.side, t.volume, 1);
        if t.auction {
            self.auction_volume += t.volume;
        }
        self.amount += t.amount;
        if t.no_last_sale {
            return;
        }
        if self.open.is_none() || t.ts < self.first_ts {
            self.open = Some(t.price);
            self.first_ts = t.ts;
        }
        if self.close.is_none() || t.ts >= self.last_ts {
            self.close = Some(t.price);
            self.last_ts = t.ts;
            if t.average > 0 {
                self.average = t.average;
            }
        }
        self.high = Some(self.high.map_or(t.price, |h| h.max(t.price)));
        self.low = Some(self.low.map_or(t.price, |l| l.min(t.price)));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Bar {
    pub open: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
    pub volume: f64,
    pub partial: bool,
    pub amount: f64,
    pub average: i64,
}

/// A minute's quote levels, open and close by exchange time: a quote filled into a restart's gap afterwards arrives
/// after newer ones of the gap's last minute, and is that minute's close only if its time says so.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct QuoteOhlc {
    pub open: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
    pub open_ns: i64,
    pub close_ns: i64,
}

impl QuoteOhlc {
    fn first(level: i64, ns: i64) -> Self {
        Self { open: level, high: level, low: level, close: level, open_ns: ns, close_ns: ns }
    }

    fn with(mut self, level: i64, ns: i64) -> Self {
        self.high = self.high.max(level);
        self.low = self.low.min(level);
        if ns < self.open_ns {
            (self.open, self.open_ns) = (level, ns);
        }
        if ns >= self.close_ns {
            (self.close, self.close_ns) = (level, ns);
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Minute {
    pub minute: i32,
    pub open: Option<i64>,
    pub high: Option<i64>,
    pub low: Option<i64>,
    pub close: Option<i64>,
    pub volume: Option<f64>,
    pub trades: u64,
    pub quality: Quality,
    pub finalized: bool,
    pub authority: Authority,
    pub revision: u64,
    pub revised_after_final: bool,
    pub flow: Flow,
    pub ticks: Vec<CTrade>,
    /// Prints before the last checkpoint restore, folded (their individual records are not kept across restarts).
    pub base: Option<TickAggregate>,
    /// The large prints among them, kept one by one: the 價量 tab lists a session bucket's large orders, and
    /// folding them away would make every B restart forget the day's earlier ones.
    pub large_prints: Vec<CTrade>,
    pub quote_ohlc: Option<QuoteOhlc>,
    /// Volume the exchange's cumulative total proved, at this minute's print, to have traded unseen (the App started
    /// late, a reconnect). WHEN it traded is unknown, so it is in no minute's volume (re-timing it into this minute
    /// would invent a spike) and in no flow (its side is unknown either); the day's volume carries it, and every
    /// minute it could have traded in is marked as lost input.
    pub unattributed_volume: f64,
    pub cum_base: Option<f64>,
    /// The base is fixed by the minute's FIRST cumulative quote (None when no earlier total existed).
    pub cum_started: bool,
    pub cum_last: Option<f64>,
    pub source_bar: Option<Bar>,
    pub backfill_bar: Option<Bar>,
    /// Coverage during this minute: 2 full, 1 partial, 0 not observed.
    pub coverage: u8,
    pub last_input_seq: u64,
    /// (ts, seq) of the newest live print folded into the aggregate: a print at or after it can be appended
    /// without rebuilding the minute (see append_newest).
    pub tick_last: (i64, u64),
    /// The producer dropped events of this instrument in this minute (flags.gap_before): whatever it shows is
    /// incomplete, so a minute that would read Traded reads Partial.
    pub source_gap: bool,
    /// How many open volume gaps (TradeChain) this minute lies in: the unseen volume may have traded in it. Counted,
    /// not a flag, since a print filled in afterwards closes a gap and the minute reads complete again.
    #[serde(default)]
    pub volume_gap_cover: u32,
    /// The newest of this minute's large prints in list order (durable sequence, exchange time): the newest large
    /// orders of a session are found from the minutes that can hold them, never by reading every print of the day
    /// (projection.rs `large_prints_of_side`).
    #[serde(default)]
    pub large_newest: Option<(u64, i64)>,
    /// The part of `volume` matched by call auctions (opening, closing, 處置股, 瞬間價格穩定措施): the minute's
    /// continuous-trading volume is `volume - auction_volume`.
    pub auction_volume: f64,
    /// 成交金額 of the minute's prints (or its source bar) as the source reported them; None when nothing reported it.
    pub amount: Option<f64>,
    /// The source's running average price at the minute's newest print (or its bar); None when not reported.
    pub average: Option<i64>,
}

impl Minute {
    pub(crate) fn new(minute: i32) -> Self {
        Self {
            minute, open: None, high: None, low: None, close: None, volume: None, trades: 0, quality: Quality::Missing,
            finalized: false, authority: Authority::None, revision: 1, revised_after_final: false, flow: Flow::default(),
            ticks: Vec::new(), base: None, large_prints: Vec::new(), quote_ohlc: None, unattributed_volume: 0.0, cum_base: None, cum_started: false, cum_last: None, source_bar: None, backfill_bar: None,
            coverage: 0, last_input_seq: 0, tick_last: (i64::MIN, 0), source_gap: false, volume_gap_cover: 0, large_newest: None, auction_volume: 0.0,
            amount: None, average: None,
        }
    }

    /// Fold the print just pushed (the last element of `ticks`) into a tick-authority aggregate in O(1), when it is
    /// the newest print of the minute. False = the caller must rebuild (`recompute`). Rebuilding on every print
    /// sorted and re-aggregated the whole minute each time -- O(n^2) per minute, B's bottleneck under load.
    fn append_newest(&mut self) -> bool {
        if self.authority != Authority::Ticks || self.quality != Quality::Traded || self.open.is_none() {
            return false;
        }
        let Some(t) = self.ticks.last() else { return false };
        if (t.ts, t.seq) < self.tick_last {
            return false;
        }
        if !t.no_last_sale {
            self.high = self.high.map(|h| h.max(t.price));
            self.low = self.low.map(|l| l.min(t.price));
            self.close = Some(t.price);
        }
        self.volume = Some(self.volume.unwrap_or(0.0) + t.volume);
        self.trades += 1;
        self.flow.add(t.large, t.side, t.volume, 1);
        if t.auction {
            self.auction_volume += t.volume;
        }
        if t.amount > 0.0 {
            self.amount = Some(self.amount.unwrap_or(0.0) + t.amount);
        }
        if t.average > 0 && !t.no_last_sale {
            self.average = Some(t.average);
        }
        self.tick_last = (t.ts, t.seq);
        true
    }

    /// Fold the individually kept prints into `base` (keeping the large ones), returning how many were folded.
    fn fold_ticks(&mut self) -> usize {
        if self.ticks.is_empty() {
            return 0;
        }
        self.base = Some(self.tick_aggregate());
        let large: Vec<CTrade> = self.ticks.iter().filter(|t| t.large == Some(true)).cloned().collect();
        self.large_prints.extend(large);
        let count = self.ticks.len();
        self.ticks.clear();
        count
    }

    /// The folded base with the individually kept prints added.
    fn tick_aggregate(&self) -> TickAggregate {
        let mut a = self.base.clone().unwrap_or_else(TickAggregate::empty);
        for t in &self.ticks {
            a.absorb(t);
        }
        a
    }

    fn has_data(&self) -> bool {
        self.base.is_some() || !self.ticks.is_empty() || self.quote_ohlc.is_some() || self.source_bar.is_some() || self.backfill_bar.is_some()
    }

    /// Rebuild OHLCV/flow from the strongest authority present, then state what is known to be incomplete: a minute
    /// with lost input (`source_gap`) never reads complete -- Traded becomes Partial, and "no trade" becomes Missing,
    /// since the lost events may have been the trades.
    /// A print of this minute became (or arrived) large.
    pub(crate) fn note_large(&mut self, seq: u64, ts: i64) {
        self.large_newest = Some(self.large_newest.map_or((seq, ts), |known| known.max((seq, ts))));
    }

    /// Whether input of this minute is known lost: the producer said so, or an open volume gap spans it.
    pub fn lost_input(&self) -> bool {
        self.source_gap || self.volume_gap_cover > 0
    }

    fn recompute(&mut self, prev_close: Option<i64>) {
        self.recompute_inputs(prev_close);
        if self.lost_input() {
            match self.quality {
                Quality::Traded => self.quality = Quality::Partial,
                // Prints that set no last sale: their volume is known, a price is not (the lost events may have set one).
                Quality::NoTradeSynthetic | Quality::NoTradeNoPrice if self.authority == Authority::Ticks => {
                    (self.open, self.high, self.low, self.close) = (None, None, None, None);
                    self.quality = Quality::Partial;
                }
                Quality::NoTradeSynthetic | Quality::NoTradeNoPrice => {
                    (self.open, self.high, self.low, self.close, self.volume) = (None, None, None, None, None);
                    self.quality = Quality::Missing;
                }
                Quality::Missing | Quality::Partial => {}
            }
        }
    }

    /// `prev_close` is the last valid price before this minute (for no-trade continuation); coverage decides
    /// no-trade vs missing.
    fn recompute_inputs(&mut self, prev_close: Option<i64>) {
        self.flow = Flow::default();
        self.auction_volume = 0.0;
        self.amount = None;
        self.average = None;
        if !self.ticks.is_empty() || self.base.is_some() {
            self.authority = Authority::Ticks;
            let a = self.tick_aggregate();
            self.tick_last = self.ticks.iter().map(|t| (t.ts, t.seq)).max()
                .or_else(|| self.base.as_ref().map(|b| (b.last_ts, 0))).unwrap_or((i64::MIN, 0));
            self.volume = Some(a.volume);
            self.trades = a.trades;
            self.flow = a.flow;
            self.auction_volume = a.auction_volume;
            self.amount = (a.amount > 0.0).then_some(a.amount);
            self.average = (a.average > 0).then_some(a.average);
            if let (Some(o), Some(h), Some(l), Some(c)) = (a.open, a.high, a.low, a.close) {
                (self.open, self.high, self.low, self.close) = (Some(o), Some(h), Some(l), Some(c));
                self.quality = Quality::Traded;
            } else {
                // Only prints that set no last sale (odd lots before the open): their volume traded, but the price
                // carries on from the last one that set it -- the minute reads like one without a trade.
                (self.open, self.high, self.low, self.close) = (prev_close, prev_close, prev_close, prev_close);
                self.quality = if prev_close.is_some() { Quality::NoTradeSynthetic } else { Quality::NoTradeNoPrice };
            }
            return;
        }
        self.trades = 0;
        if let Some(QuoteOhlc { open: o, high: h, low: l, close: c, .. }) = self.quote_ohlc {
            self.authority = Authority::Cumulative;
            self.open = Some(o);
            self.high = Some(h);
            self.low = Some(l);
            self.close = Some(c);
            self.volume = match (self.cum_base, self.cum_last) {
                // A cumulative total that did not move (or moved by binary noise) is 0, never a negative minute.
                (Some(b), Some(e)) if !vol::lt(e, b) => Some((e - b).max(0.0)),
                _ => None,
            };
            self.quality = if self.volume.is_some() && self.coverage == 2 { Quality::Traded } else { Quality::Partial };
            return;
        }
        let bar = self.source_bar.as_ref().map(|b| (b, Authority::SourceBar)).or(self.backfill_bar.as_ref().map(|b| (b, Authority::BackfillBar)));
        if let Some((b, authority)) = bar {
            self.authority = authority;
            self.open = Some(b.open);
            self.high = Some(b.high);
            self.low = Some(b.low);
            self.close = Some(b.close);
            self.volume = Some(b.volume);
            self.amount = (b.amount > 0.0).then_some(b.amount);
            self.average = (b.average > 0).then_some(b.average);
            self.quality = if b.partial { Quality::Partial } else { Quality::Traded };
            return;
        }
        self.authority = Authority::None;
        match (self.coverage, prev_close) {
            (2, Some(p)) => {
                self.open = Some(p);
                self.high = Some(p);
                self.low = Some(p);
                self.close = Some(p);
                self.volume = Some(0.0);
                self.quality = Quality::NoTradeSynthetic;
            }
            (2, None) => {
                self.open = None;
                self.high = None;
                self.low = None;
                self.close = None;
                self.volume = Some(0.0);
                self.quality = Quality::NoTradeNoPrice;
            }
            (c, _) => {
                self.open = None;
                self.high = None;
                self.low = None;
                self.close = None;
                self.volume = None;
                self.quality = if c == 1 { Quality::Partial } else { Quality::Missing };
            }
        }
    }

    /// Whether a print in this minute set a price: the one rule for "a minute that traded" (1 分 K, 3/5 分 K, the
    /// 1mK/3mK/5mK open, the session's open/high/low, the price a no-trade minute carries on). A minute of odd-lot or
    /// average-price prints alone (NoTradeSynthetic) carries the previous price and did not trade; a partial minute
    /// whose surviving prints set a price did.
    pub fn traded(&self) -> bool {
        self.authority != Authority::None && self.close.is_some() && self.quality != Quality::NoTradeSynthetic
    }

    pub fn wire(&self, id: &InstrumentId, cum: Option<(Volume, bool)>, rule: Option<&str>) -> Value {
        let ts = minute_timestamp(&id.market, &id.trading_date, self.minute);
        let mut wire = json!({
            "minute": self.minute, "time": crate::baseline::clock_text(self.minute), "timestamp": ts, "minute_timestamp": ts,
            "open": opt_money(self.open), "high": opt_money(self.high), "low": opt_money(self.low), "close": opt_money(self.close),
            // 均價: the source's session-to-now average at the minute's newest print; null when it reported none.
            "average_price": opt_money(self.average),
            // The minute's traded amount as the source reported it: what a session's own 均價 is summed from.
            "amount": self.amount,
            "volume": vol::wire_opt(self.volume), "minute_volume": vol::wire_opt(self.volume), "trades": self.trades,
            "unattributed_volume": vol::wire(self.unattributed_volume),
            "total_volume": cum.map(|c| vol::wire(c.0)), "total_volume_complete": cum.map(|c| c.1),
            // The source's own cumulative volume, from the newest quote of this minute (none in a minute without one).
            "quote_total_volume": vol::wire_opt(self.cum_last),
            "state": if self.finalized { "FINALIZED" } else { "FORMING" }, "quality": self.quality.name(),
            "synthetic": self.quality == Quality::NoTradeSynthetic,
            "authority": format!("{:?}", self.authority).to_uppercase(), "revision": self.revision,
            "revised_after_final": self.revised_after_final, "input_sequence": self.last_input_seq,
        });
        wire["flow"] = self.flow.wire(rule);
        wire
    }
}

/// One price of the 價量 ladder. Each statistic is its own field so a new dimension is a new field (and a new key in
/// `wire`), not a change to an existing one.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PriceBucket {
    pub volume: f64,
    pub buy: f64,
    pub sell: f64,
    pub unknown: f64,
    /// The same volume by order size: large / small / unclassified, each with buy, sell, unknown and
    /// print count -- the minute flow's classification, kept per price.
    pub flow: Flow,
}

/// The layout of each ladder row's `flow` array: per class buy, sell, unknown volume and print count. A new
/// statistic is appended here and in `PriceBucket::wire`, never inserted.
pub const LADDER_FLOW_FIELDS: [&str; 12] = [
    "large_buy", "large_sell", "large_unknown", "large_count",
    "small_buy", "small_sell", "small_unknown", "small_count",
    "unclassified_buy", "unclassified_sell", "unclassified_unknown", "unclassified_count",
];

impl PriceBucket {
    pub(crate) fn merge(&mut self, other: &PriceBucket) {
        self.volume += other.volume;
        self.buy += other.buy;
        self.sell += other.sell;
        self.unknown += other.unknown;
        self.flow.merge(&other.flow);
    }

    /// One ladder row. `flow` is a flat number array laid out by `LADDER_FLOW_FIELDS` (sent once per ladder): a US
    /// stock trades at thousands of sub-penny prices (MU: 13,422 in one day), and the minute-flow object per price
    /// made one ladder 18 MB, sent twice per snapshot and on every day update. Ratios are left to the reader. An
    /// instrument without a large-order rule (all of Futu, TXF today) has no split to show: its rows carry no `flow`.
    pub(crate) fn wire(&self, price: i64, with_flow: bool) -> Value {
        let row = json!({"price": money(price), "volume": vol::wire(self.volume), "out": vol::wire(self.buy), "in": vol::wire(self.sell), "unknown": vol::wire(self.unknown)});
        if !with_flow {
            return row;
        }
        let f = &self.flow;
        let mut row = row;
        row["flow"] = json!([vol::wire(f.large.buy), vol::wire(f.large.sell), vol::wire(f.large.unknown), f.large.count,
                        vol::wire(f.small.buy), vol::wire(f.small.sell), vol::wire(f.small.unknown), f.small.count,
                        vol::wire(f.unclassified.buy), vol::wire(f.unclassified.sell), vol::wire(f.unclassified.unknown), f.unclassified.count]);
        row
    }
}

/// `durable_gap_from` for a gap that came before the instrument held anything: from its session's open.
pub const GAP_FROM_OPEN: i32 = i32::MIN;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Dirty {
    pub minutes: BTreeSet<i32>,
    pub windows: bool,
    pub day: bool,
    pub flow: bool,
    pub events: BTreeSet<String>,
    /// Price-ladder rows that changed since the last day item (it sends only those).
    pub prices: BTreeSet<i64>,
    /// The next day / flow item is sent whole: a change an increment cannot say (a ladder row emptied away) or an
    /// item Market Runtime did not take, whose increment is no longer known.
    pub day_whole: bool,
    pub flow_whole: bool,
}

impl Dirty {
    pub fn any(&self) -> bool {
        !self.minutes.is_empty() || self.windows || self.day || self.flow || !self.events.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Revisions {
    pub minutes: u64,
    pub windows: u64,
    pub day: u64,
    pub flow: u64,
    pub events: u64,
}

/// The cumulative volume the seen prints account for, as covered spans: each print with the exchange's cumulative
/// total covers [total - volume, total], from the session's start (0). A hole between two spans is volume proven to
/// have traded unseen -- the App started after the open, a provider restart, a reconnect (Shioaji never re-sends
/// missed prints, so 3481 lost its 28,748-lot opening print to a late start). The model is order-free: a print that
/// arrives after the prints around it (a restart's gap filled from the broker's history afterwards) covers its part
/// of the hole, and the hole shrinks or closes. Only the spans' ends are kept (one per hole), never every print.
/// Every comparison uses the volume tolerance: a hole is never made of the binary noise between two decimal totals
/// (48,971,788.25 - 0.25 against 48,971,788), and a real fractional hole is never lost.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TradeChain {
    pub spans: Vec<Covered>,
}

/// A covered span of cumulative volume, with the minutes of the prints at its two ends.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Covered {
    pub lo: f64,
    pub hi: f64,
    pub lo_minute: i32,
    pub hi_minute: i32,
}

/// A hole of `size` unseen volume, revealed at `at_minute` (the print after it), traded somewhere from `from_minute`
/// (the print before it; GAP_FROM_OPEN: the session's open).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoleSpan {
    pub size: f64,
    pub at_minute: i32,
    pub from_minute: i32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hole {
    Opened(HoleSpan),
    Closed(HoleSpan),
}

impl TradeChain {
    fn origin() -> Covered {
        Covered { lo: 0.0, hi: 0.0, lo_minute: GAP_FROM_OPEN, hi_minute: GAP_FROM_OPEN }
    }

    /// The newest cumulative total seen.
    pub fn high(&self) -> Option<f64> {
        self.spans.last().map(|s| s.hi).filter(|hi| vol::positive(*hi).is_some())
    }

    /// One print's cumulative total and own volume, at `minute`: the holes it opened and closed. A print with no
    /// total says nothing. A live total far below the known one is a new count (a session's count restarting): the
    /// chain starts again from it. A print filled into a gap afterwards (`filled`) belongs to the count it was cut
    /// from by construction, however far below the newest total it lies -- a closed session's fill arrives after
    /// the whole day's prints. A print inside what is already covered (a resend, an older total) changes nothing.
    pub fn cover(&mut self, total: Volume, volume: Volume, minute: i32, filled: bool) -> Vec<Hole> {
        if vol::positive(total).is_none() || vol::positive(volume).is_none() {
            return Vec::new();
        }
        if !filled && self.high().is_some_and(|known| vol::lt(total, known / 2.0)) {
            self.spans.clear();
        }
        if self.spans.is_empty() {
            self.spans.push(Self::origin());
        }
        let (mut lo, mut hi) = ((total - volume).max(0.0), total);
        // The span ending at or below where this print starts (the origin always qualifies).
        let left = self.spans.iter().rposition(|s| !vol::gt(s.lo, lo)).unwrap_or(0);
        if !vol::gt(hi, self.spans[left].hi) {
            return Vec::new();
        }
        lo = lo.max(self.spans[left].hi);
        let right = (left + 1 < self.spans.len()).then_some(left + 1);
        if let Some(r) = right {
            hi = hi.min(self.spans[r].lo);
        }
        let mut changes = Vec::new();
        let l = self.spans[left];
        if let Some(r) = right.map(|r| self.spans[r]) {
            changes.push(Hole::Closed(HoleSpan { size: r.lo - l.hi, at_minute: r.lo_minute, from_minute: l.hi_minute }));
        }
        if vol::gt(lo, l.hi) {
            changes.push(Hole::Opened(HoleSpan { size: lo - l.hi, at_minute: minute, from_minute: l.hi_minute }));
        }
        if let Some(r) = right.map(|r| self.spans[r]) {
            if vol::gt(r.lo, hi) {
                changes.push(Hole::Opened(HoleSpan { size: r.lo - hi, at_minute: r.lo_minute, from_minute: minute }));
            }
        }
        // Join the print to the spans it touches.
        let joins_left = !vol::gt(lo, l.hi);
        let joins_right = right.is_some_and(|r| !vol::gt(self.spans[r].lo, hi));
        match (joins_left, joins_right) {
            (true, true) => {
                let r = self.spans.remove(left + 1);
                self.spans[left].hi = r.hi;
                self.spans[left].hi_minute = r.hi_minute;
            }
            (true, false) => {
                self.spans[left].hi = hi;
                self.spans[left].hi_minute = minute;
            }
            (false, true) => {
                self.spans[left + 1].lo = lo;
                self.spans[left + 1].lo_minute = minute;
            }
            (false, false) => self.spans.insert(left + 1, Covered { lo, hi, lo_minute: minute, hi_minute: minute }),
        }
        changes
    }
}

/// The latest prices and quantities the source reported, and the book: what the next print is judged against.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PriceState {
    /// Market Runtime's reference facts of the partition, applied by the same rule (Reference::absorb) from the same
    /// Reference events: B never takes a 昨收 from a quote or a print, so A and B compare against one value.
    pub reference: Reference,
    /// Latest valid price by exchange time: (price, ts, minute).
    pub last_price: Option<(i64, i64, i32)>,
    pub last_cum: Option<f64>,
    /// The cumulative volume the prints seen so far account for (see TradeChain).
    #[serde(default)]
    pub trade_chain: TradeChain,
    /// The source's cumulative 成交金額 at the newest print (a raw fact, for the history store's summary).
    pub total_amount: Option<f64>,
    pub book: Option<(i64, i64, i64)>,
    pub book_top: Option<BookTop>,
    /// The newest complete quote by exchange time (equal times keep durable order): a US day's official figures.
    pub day_quote: Option<DayQuote>,
}

/// A quote that reported the day's open, high and low.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DayQuote {
    pub ts: i64,
    pub open: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
    pub volume: f64,
}

/// Which minutes the partition saw, and which may have lost input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageState {
    /// Covered intervals [start, end]; an open interval has no end.
    pub coverage: Vec<(i32, Option<i32>)>,
    pub materialized_through: i32,
    /// Set by a durable gap: the minute of the newest data held then (GAP_FROM_OPEN when nothing was held). The
    /// instrument's lost events lie between that and its next event, so every minute in that span is marked when the
    /// next event arrives.
    pub durable_gap_from: Option<i32>,
}

/// A minute against covered intervals (an open interval has no end): 2 observed throughout, 1 only partly (an
/// interval's first or last minute), 0 not observed. The partition's coverage here and the feature fold's read this.
pub(crate) fn span_state(spans: &[(i32, Option<i32>)], minute: i32) -> u8 {
    let mut state = 0u8;
    for (start, end) in spans {
        let end_v = end.unwrap_or(i32::MAX);
        if minute > *start && minute < end_v {
            return 2;
        }
        if minute == *start || minute == end_v {
            state = state.max(1);
        }
        if minute >= *start && end.is_none() {
            state = state.max(if minute == *start { 1 } else { 2 });
        }
    }
    state
}

pub(crate) fn open_span(spans: &mut Vec<(i32, Option<i32>)>, minute: i32) {
    if !spans.last().is_some_and(|(_, e)| e.is_none()) {
        spans.push((minute, None));
    }
}

pub(crate) fn close_span(spans: &mut [(i32, Option<i32>)], minute: i32) {
    if let Some(last) = spans.last_mut() {
        if last.1.is_none() {
            last.1 = Some(minute.max(last.0));
        }
    }
}

impl Default for CoverageState {
    fn default() -> Self {
        Self { coverage: Vec::new(), materialized_through: -1, durable_gap_from: None }
    }
}

/// Large/small flow: the attack episode in progress, the call-auction state, and the 價量 ladders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowState {
    pub episode: Episode,
    pub next_episode: u64,
    /// A 試撮 (simulated match) was seen and no real print has followed yet: the next print is the auction's match.
    pub auction_pending: bool,
    #[serde(deserialize_with = "keyed_by_number::deserialize")]
    pub price_volume: BTreeMap<i64, PriceBucket>,
    /// The same ladder per business session (key: the session's start minute). A futures partition holds the tail
    /// of the previous night (00:00-05:00), the day session and a new night: one partition-wide ladder
    /// would mix them.
    #[serde(deserialize_with = "keyed_by_number::nested")]
    pub segment_price_volume: BTreeMap<i32, BTreeMap<i64, PriceBucket>>,
}

/// The ladders are keyed by price (and session start). JSON writes those keys as strings; read through a flattened
/// group (Instrument's checkpoint form) they stay strings, so they are parsed here -- a key that is no number refuses
/// the state.
mod keyed_by_number {
    use serde::de::Error;
    use serde::{Deserialize, Deserializer};
    use std::collections::BTreeMap;
    use std::fmt::Display;
    use std::str::FromStr;

    fn parse<K: FromStr<Err = impl Display> + Ord, V, E: Error>(map: BTreeMap<String, V>) -> Result<BTreeMap<K, V>, E> {
        map.into_iter().map(|(k, v)| k.parse().map(|k| (k, v)).map_err(|e| E::custom(format!("map key {k:?}: {e}")))).collect()
    }

    pub fn deserialize<'de, D, K, V>(d: D) -> Result<BTreeMap<K, V>, D::Error>
    where D: Deserializer<'de>, K: FromStr + Ord, K::Err: Display, V: Deserialize<'de> {
        parse(BTreeMap::<String, V>::deserialize(d)?)
    }

    pub fn nested<'de, D, K, J, V>(d: D) -> Result<BTreeMap<K, BTreeMap<J, V>>, D::Error>
    where D: Deserializer<'de>, K: FromStr + Ord, K::Err: Display, J: FromStr + Ord, J::Err: Display, V: Deserialize<'de> {
        let outer = parse::<K, _, D::Error>(BTreeMap::<String, BTreeMap<String, V>>::deserialize(d)?)?;
        outer.into_iter().map(|(k, inner)| parse(inner).map(|inner| (k, inner))).collect()
    }
}

impl Default for FlowState {
    fn default() -> Self {
        Self { episode: Episode::default(), next_episode: 1, auction_pending: false, price_volume: BTreeMap::new(),
               segment_price_volume: BTreeMap::new() }
    }
}

/// Counts of what was set aside or found missing, for diagnostics and completeness.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QualityDiagnostics {
    pub ticks_dropped: u64,
    pub outside_session: u64,
    pub simtrade_skipped: u64,
    /// Prints that were matched by a call auction (see `is_auction_print`).
    pub auction_prints: u64,
    /// Prints whose cumulative total proved unseen volume before them (see `volume_gap`).
    pub volume_gaps: u64,
    /// Events the producer dropped before handing them over (sum of flags.gap_before).
    pub source_gaps: u64,
    /// Durable gaps (events missing from Market Runtime's WAL) that arrived while this instrument was held.
    pub durable_gaps: u64,
}

/// What has been projected: each block's revision, and what changed since the last projection.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectionRevision {
    pub revisions: Revisions,
    #[serde(skip)]
    pub dirty: Dirty,
    /// The large prints the last flow item listed (projection.rs `flow_wire`).
    #[serde(skip)]
    pub large_orders_listed: Listed,
    /// The session frame (its first minute, the segment's start) of the last live day / flow item: an increment is
    /// sent only within the frame Market Runtime holds; a new frame (or none sent yet) goes whole.
    #[serde(skip)]
    pub day_frame: Option<(i32, i32)>,
    #[serde(skip)]
    pub flow_frame: Option<(i32, i32)>,
}

/// What a live day / flow item may leave out: it names only the minutes from `from` on (the earliest minute changed
/// since the last item; None when no minute changed), the ladder rows in `prices`, and the large-order list when it
/// differs from `listed`. `whole`: sent whole regardless (see `Dirty::day_whole`).
pub struct Increment<'a> {
    pub whole: bool,
    pub frame: Option<(i32, i32)>,
    pub from: Option<i32>,
    pub prices: &'a BTreeSet<i64>,
    pub listed: &'a Listed,
}

/// The large prints a flow item lists, each as (print identity, large reason): a print's row is made of its own
/// fields, of which only the reason changes once it is large, so the same list is the same rows.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Listed(pub Vec<((u64, i64, String), u8)>);

/// One partition (instrument, trading date, session). Its state is grouped by invariant; the checkpoint keeps the
/// groups flattened into one object, every field required.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instrument {
    pub id: InstrumentId,
    /// Shared on clone and copied only when written: a replay keeps an engine copy every interval of the day, and a
    /// closed minute is never written again, so those copies share every minute but the newest few.
    pub minutes: BTreeMap<i32, Arc<Minute>>,
    pub ticks_kept: usize,
    pub last_input_seq: u64,
    #[serde(flatten)]
    pub price: PriceState,
    #[serde(flatten)]
    pub cover: CoverageState,
    #[serde(flatten)]
    pub flow: FlowState,
    #[serde(flatten)]
    pub quality: QualityDiagnostics,
    #[serde(flatten)]
    pub projection: ProjectionRevision,
    pub events: crate::events::EventState,
}

impl Instrument {
    pub fn new(id: InstrumentId) -> Self {
        Self {
            id, minutes: BTreeMap::new(), ticks_kept: 0, last_input_seq: 0,
            price: PriceState::default(), cover: CoverageState::default(), flow: FlowState::default(),
            quality: QualityDiagnostics::default(), projection: ProjectionRevision::default(),
            events: crate::events::EventState::default(),
        }
    }

    /// The checkpoint form: every minute's prints folded into its aggregate, so a restore resumes exactly the
    /// aggregates without carrying every individual print.
    pub fn checkpoint_view(&self) -> Instrument {
        let mut out = self.clone();
        for m in out.minutes.values_mut().map(Arc::make_mut) {
            m.fold_ticks();
        }
        out.ticks_kept = 0;
        out
    }

    /// At the per-instrument print cap, fold every earlier minute's prints into its aggregate (the checkpoint form)
    /// instead of refusing new prints: refusing froze the minute OHLC, volume, 價量 and flow from that print on.
    fn relieve_tick_capacity(&mut self, minute: i32) {
        let mut folded = 0usize;
        for m in self.minutes.range_mut(..minute).map(|(_, m)| Arc::make_mut(m)) {
            folded += m.fold_ticks();
        }
        if self.ticks_kept.saturating_sub(folded) >= tick_cap() {
            if let Some(m) = self.minutes.get_mut(&minute).map(Arc::make_mut) {
                folded += m.fold_ticks();
            }
        }
        self.ticks_kept = self.ticks_kept.saturating_sub(folded);
        self.quality.ticks_dropped += folded as u64;
    }

    fn covered_state(&self, minute: i32) -> u8 {
        span_state(&self.cover.coverage, minute)
    }

    /// Subscribed before this partition existed: every minute of it is observed.
    pub fn cover_from_open(&mut self) {
        self.open_coverage(-1);
    }

    pub fn open_coverage(&mut self, minute: i32) {
        open_span(&mut self.cover.coverage, minute);
    }

    pub fn close_coverage(&mut self, minute: i32) {
        close_span(&mut self.cover.coverage, minute);
    }

    fn prev_close_before(&self, minute: i32) -> Option<i64> {
        self.minutes.range(..minute).rev().find(|(_, m)| m.traded()).and_then(|(_, m)| m.close)
    }

    fn touch(&mut self, minute: i32, seq: u64) {
        let prev = self.prev_close_before(minute);
        let coverage = self.covered_state(minute);
        let m = Arc::make_mut(self.minutes.entry(minute).or_insert_with(|| Arc::new(Minute::new(minute))));
        m.coverage = m.coverage.max(coverage);
        m.last_input_seq = seq;
        let was_final = m.finalized;
        let before = (m.open, m.high, m.low, m.close, m.volume, m.quality, m.flow.clone());
        m.recompute(prev);
        let after = (m.open, m.high, m.low, m.close, m.volume, m.quality, m.flow.clone());
        if before != after {
            if was_final {
                m.revision += 1;
                m.revised_after_final = true;
            }
            self.projection.dirty.minutes.insert(minute);
            self.projection.dirty.windows = true;
            self.projection.dirty.day = true;
            self.projection.dirty.flow = true;
            // A changed close moves the synthetic continuation of the following no-trade minutes.
            let follow: Vec<i32> = self.minutes.range(minute + 1..).take_while(|(_, x)| !x.has_data()).map(|(k, _)| *k).collect();
            for k in follow {
                let prev = self.prev_close_before(k);
                if let Some(x) = self.minutes.get_mut(&k).map(Arc::make_mut) {
                    let b = (x.close, x.quality);
                    x.recompute(prev);
                    if (x.close, x.quality) != b {
                        if x.finalized {
                            x.revision += 1;
                            x.revised_after_final = true;
                        }
                        self.projection.dirty.minutes.insert(k);
                    }
                }
            }
        }
    }

    /// Large/small for one print, causal (prints in durable order), the legacy LargeOrderPolicy semantics:
    /// large when the print alone reaches the rule threshold, OR when the same-side attack it belongs to has
    /// consumed at least `impact_ratio` of the opposite best-level liquidity it encountered. None when no rule
    /// applies to the instrument (never a guessed threshold).
    ///
    /// Classification is per ATTACK, not per print: when an attack qualifies (a print alone reaches the threshold,
    /// the attack's total reaches it, or it consumed `impact_ratio` of the opposite best liquidity it met), every
    /// print of that attack is large -- the earlier ones are re-marked (returned in the last element for the
    /// caller to apply). Five consecutive 80-lot buys are one 400-lot order, not three small prints and two large.
    fn classify(&mut self, rules: &RuleSet, price: i64, volume: Volume, side: i8, ts: i64, minute: i32, seq: u64)
        -> (Option<bool>, u8, u64, Vec<(i32, u64)>) {
        let Some(rule) = rules.flow_rule(&self.id.source, &self.id.market, &self.id.code).cloned() else { return (None, 0, 0, Vec::new()) };
        let mut reason = if rule.is_large(price, volume) { LARGE_BY_VOLUME } else { 0 };
        let mut episode_id = 0;
        let mut retro = Vec::new();
        if side != 0 {
            let top = self.price.book_top.filter(|b| b.ts <= ts);
            let top_ts = top.map(|b| b.ts).unwrap_or(0);
            let (best_price, best_volume) = match (side, top) {
                (1, Some(b)) if b.ask > 0 => (Some(b.ask), vol::positive(b.ask_volume)),
                (-1, Some(b)) if b.bid > 0 => (Some(b.bid), vol::positive(b.bid_volume)),
                _ => (None, None),
            };
            let gap_ns = rule.episode_gap_ms.unwrap_or(1500).max(1) * 1_000_000;
            let ep = &mut self.flow.episode;
            let retreated = match (ep.best_price, best_price) {
                (Some(prior), Some(now)) => (side == 1 && now < prior) || (side == -1 && now > prior),
                _ => false,
            };
            let max_ns = rule.episode_max_ms.unwrap_or(EPISODE_MAX_MS_DEFAULT).max(1) * 1_000_000;
            // Prints of one attack can arrive slightly out of exchange-time order (same-second prints, a late
            // callback): anything within the gap of the attack's newest print, in either direction, is still the
            // same attack. Requiring monotonic time cut an attack in two and left one of its prints small.
            let same = ep.id > 0 && ep.side == side && (ts - ep.last_ts).abs() <= gap_ns && !retreated
                && ts.max(ep.last_ts) - ep.started_ts.min(ts) <= max_ns && ep.members.len() < EPISODE_MEMBERS_MAX;
            if !same {
                *ep = Episode { id: self.flow.next_episode, side, last_ts: ts, best_price, encountered: best_volume.unwrap_or(0.0), consumed: 0.0,
                    book_ts: top_ts, started_ts: ts, large: false, members: Vec::new(), qualified: 0.0 };
                self.flow.next_episode += 1;
            } else if top_ts <= ep.book_ts {
                // No newer book since the last print of this attack: nothing new was encountered.
            } else if let (Some(now), Some(prior)) = (best_price, ep.best_price) {
                ep.book_ts = top_ts;
                if now != prior {
                    // Swept to a new best level: that level's queue is encountered once.
                    ep.encountered += best_volume.unwrap_or(0.0);
                    ep.best_price = Some(now);
                } else if let Some(v) = best_volume {
                    // Same level: only liquidity replenished beyond what should remain is added.
                    let remaining = (ep.encountered - ep.consumed).max(0.0);
                    if vol::gt(v, remaining) {
                        ep.encountered += v - remaining;
                    }
                }
            } else if ep.best_price.is_none() {
                ep.book_ts = top_ts;
                ep.best_price = best_price;
                ep.encountered += best_volume.unwrap_or(0.0);
            }
            // Every print consumes liquidity (impact), but only a print of real size is part of a split large order.
            let member_fraction = rule.member_min_fraction.unwrap_or(MEMBER_MIN_FRACTION_DEFAULT).clamp(0.0, 1.0);
            let member = member_fraction <= 0.0 || rule.is_large(price, volume / member_fraction);
            ep.consumed += volume;
            if member {
                ep.qualified += volume;
            }
            ep.last_ts = ep.last_ts.max(ts);
            ep.started_ts = ep.started_ts.min(ts);
            episode_id = ep.id;
            if let Some(ratio) = rule.impact_ratio {
                let fraction = rule.impact_min_fraction.unwrap_or(IMPACT_MIN_FRACTION_DEFAULT).clamp(0.0, 1.0);
                let floor_met = fraction <= 0.0 || rule.is_large(price, ep.qualified / fraction);
                if floor_met && vol::positive(ep.encountered).is_some() && !vol::lt(ep.consumed / ep.encountered, ratio) {
                    reason |= LARGE_BY_IMPACT;
                }
                // The attack's total against the same threshold a single print is held to (only with the
                // accumulation rule configured; a plain per-print rule stays per print).
                if member && ep.members.len() >= 1 && rule.is_large(price, ep.qualified) {
                    reason |= LARGE_BY_EPISODE;
                }
            }
            if reason != 0 && !ep.large {
                // The attack qualifies (possibly on a small print's impact): its earlier sized prints become large.
                ep.large = true;
                retro = ep.members.clone();
            }
            if !member {
                reason &= LARGE_BY_VOLUME;
            } else {
                if ep.large && reason == 0 {
                    reason = LARGE_BY_EPISODE;
                }
                ep.members.push((minute, seq));
            }
        }
        (Some(reason != 0), reason, episode_id, retro)
    }

    fn resolve_side(&self, rules: &RuleSet, side: i8, price: i64, ts: i64) -> (i8, u8) {
        match side {
            1 => (1, 1),
            -1 | 2 => (-1, 1),
            _ if rules.side_inference == "quote_rule" => match self.price.book {
                Some((book_ts, _, ask)) if book_ts <= ts && ask > 0 && price >= ask => (1, 2),
                Some((book_ts, bid, _)) if book_ts <= ts && bid > 0 && price <= bid => (-1, 2),
                _ => (0, 0),
            },
            _ => (0, 0),
        }
    }

    /// Futu (US stocks, crypto) has no 價量 ladder (user decision): no screen shows one, and a US stock's
    /// sub-penny prices made it the bulk of every snapshot (MU: 23,527 prices, sent four times over).
    pub fn keeps_price_ladder(&self) -> bool {
        !self.id.source.eq_ignore_ascii_case("futu")
    }

    fn ladder(&mut self, segment_start: Option<i32>, t: &CTrade, sign: i64) {
        // A print that sets no last sale traded at no price of the market: no 價量 level.
        if !self.keeps_price_ladder() || t.no_last_sale {
            return;
        }
        // A row emptied away is a removal an increment cannot name: the next day item goes whole.
        fn apply(ladder: &mut BTreeMap<i64, PriceBucket>, t: &CTrade, sign: i64) -> bool {
            let b = ladder.entry(t.price).or_default();
            let signed = sign as f64 * t.volume;
            b.volume += signed;
            match t.side {
                1 => b.buy += signed,
                -1 => b.sell += signed,
                _ => b.unknown += signed,
            }
            b.flow.add(t.large, t.side, t.volume, sign);
            // Emptied by a re-classification: compared with the volume tolerance, so 0.1 + 0.2 - 0.3 leaves no phantom row.
            let empty = |v: f64| vol::positive(v.abs()).is_none();
            if vol::positive(b.volume).is_none() && empty(b.buy) && empty(b.sell) && empty(b.unknown) {
                ladder.remove(&t.price);
                return true;
            }
            false
        }
        let mut removed = false;
        if let Some(start) = segment_start {
            removed |= apply(self.flow.segment_price_volume.entry(start).or_default(), t, sign);
        }
        removed |= apply(&mut self.flow.price_volume, t, sign);
        self.projection.dirty.prices.insert(t.price);
        self.projection.dirty.day_whole |= removed;
    }

    /// A print already on the ladder became large (its attack qualified later): move it to the large class at its
    /// price. Volume and side are unchanged.
    fn ladder_mark_large(&mut self, segment_start: Option<i32>, before: &CTrade) {
        fn mark(ladder: &mut BTreeMap<i64, PriceBucket>, t: &CTrade) {
            if let Some(b) = ladder.get_mut(&t.price) {
                b.flow.add(t.large, t.side, t.volume, -1);
                b.flow.add(Some(true), t.side, t.volume, 1);
            }
        }
        if let Some(start) = segment_start {
            if let Some(ladder) = self.flow.segment_price_volume.get_mut(&start) {
                mark(ladder, before);
            }
        }
        mark(&mut self.flow.price_volume, before);
        self.projection.dirty.prices.insert(before.price);
    }

    /// The price ladder of the business session starting at `segment_start` (empty when it has no print yet).
    pub(crate) fn session_ladder(&self, segment_start: i32) -> &BTreeMap<i64, PriceBucket> {
        static EMPTY: BTreeMap<i64, PriceBucket> = BTreeMap::new();
        self.flow.segment_price_volume.get(&segment_start).unwrap_or(&EMPTY)
    }

    /// A print's place in the cumulative volume (TradeChain::cover), and what that changed: each gap it opened is
    /// volume proven to have traded unseen, recorded at the minute of the print after it as unattributed (the day's
    /// total) with every minute it may have traded in marked as lost input; each gap it closed (a print filled in
    /// afterwards, a restart's gap from the broker's history) is taken back the same way.
    fn chain_print(&mut self, cal: &Calendar, e: &MarketEvent, minute: i32, total_volume: Volume, volume: Volume) {
        for change in self.price.trade_chain.cover(total_volume, volume, minute, e.flags.backfill) {
            let (hole, sign) = match change {
                Hole::Opened(hole) => (hole, 1),
                Hole::Closed(hole) => (hole, -1),
            };
            let Some(m) = self.minutes.get_mut(&hole.at_minute).map(Arc::make_mut) else { continue };
            if sign > 0 {
                m.unattributed_volume += hole.size;
                self.quality.volume_gaps += 1;
            } else {
                m.unattributed_volume = vol::clean((m.unattributed_volume - hole.size).max(0.0));
                self.quality.volume_gaps = self.quality.volume_gaps.saturating_sub(1);
            }
            let from = if hole.from_minute == GAP_FROM_OPEN || hole.from_minute > hole.at_minute {
                cal.segment_of(self.id.cal_key(), hole.at_minute).map_or(hole.at_minute, |s| s.start)
            } else {
                hole.from_minute
            };
            self.cover_gap_span(cal, from, hole.at_minute, e.durable_sequence, sign);
        }
    }

    /// Whether the print now arriving was matched by a call auction rather than continuous trading. TWSE runs one
    /// before the open, at the close, all day for a 處置股 (分盤集合競價) and for two minutes after a 瞬間價格穩定
    /// 措施 (緩漲緩跌); each publishes 試撮 while it collects orders, and its match is the first real print after them.
    /// Market Runtime decides it for TW stocks at ingest and stores the flag with the event (Engine::classify_print:
    /// it alone saw the pre-open 試撮, which is never stored); B takes that flag, and the 試撮 it saw itself for any
    /// other market. Consumes the pending 試撮 mark.
    fn is_auction_print(&mut self, flagged: bool) -> bool {
        std::mem::take(&mut self.flow.auction_pending) || flagged
    }

    /// `volume` is a decimal quantity: a 0.25-share print is a print, never a zero to drop.
    /// Returns whether the print was taken (a trading minute, a price and a volume).
    pub fn add_trade(&mut self, cal: &Calendar, rules: &RuleSet, e: &MarketEvent, price: i64, volume: Volume, side: i8, trade_id: &str, minute: i32) -> bool {
        if price <= 0 || vol::positive(volume).is_none() {
            return false;
        }
        if !cal.is_trading(self.id.cal_key(), minute) {
            self.quality.outside_session += 1;
            return false;
        }
        self.open_coverage(minute);
        if self.ticks_kept >= tick_cap() {
            self.relieve_tick_capacity(minute);
        }
        let id = if trade_id.is_empty() { format!("seq:{}", e.durable_sequence) } else { trade_id.to_string() };
        // A call-auction match is one print of the whole book, not anybody's order: never large, never part of an
        // attack, its volume visible as unclassified (2344's 5,371-lot close; 2330's 2,573-lot open), and 不分內外盤
        // (user 10-20): the broker's tick_type on it is the price move, not an aggressor.
        // A print that sets no last sale (an odd lot, an average-price print) is volume alone: no side, never large,
        // no 價量 level, no price -- and no auction's match either, which is the next print that sets one.
        let no_last_sale = matches!(&e.payload, Payload::Trade { no_last_sale: true, .. });
        let flagged = matches!(&e.payload, Payload::Trade { auction: true, .. });
        let auction = !no_last_sale && self.is_auction_print(flagged);
        if auction {
            self.quality.auction_prints += 1;
        }
        let unclassified = auction || no_last_sale;
        let (side, method) = if unclassified { (0, 0) } else { self.resolve_side(rules, side, price, e.exchange_ts_ns) };
        let (large, large_reason, episode, retro) = if unclassified {
            (None, 0, 0, Vec::new())
        } else {
            self.classify(rules, price, volume, side, e.exchange_ts_ns, minute, e.durable_sequence)
        };
        // A print's amount and 均價 come with it whichever way it arrived: a Trade, or a quote carrying its own print
        // volume (the futures stream), whose average/amount are the same exchange fields.
        let (amount, average) = match &e.payload {
            Payload::Trade { amount, average, .. } | Payload::Quote { amount, average, .. } => (amount.max(0.0), (*average).max(0)),
            _ => (0.0, 0),
        };
        let t = CTrade { seq: e.durable_sequence, ts: e.exchange_ts_ns, price, volume, side, method, id: id.clone(),
            large, large_reason, episode, auction, no_last_sale, amount, average };
        let retro_count = retro.len();
        // Earlier prints of an attack that just qualified become large too (their minutes' flow is revised).
        for (m, s) in retro {
            let mut changed = None;
            if let Some(x) = self.minutes.get_mut(&m).map(Arc::make_mut) {
                if let Some(prior) = x.ticks.iter_mut().find(|p| p.seq == s && p.large != Some(true)) {
                    changed = Some(prior.clone());
                    prior.large = Some(true);
                    prior.large_reason |= LARGE_BY_EPISODE;
                }
                if let Some(prior) = &changed {
                    x.note_large(prior.seq, prior.ts);
                }
            }
            if let Some(before) = changed {
                // ... and so is the per-price split (各價位大單).
                let prior_segment = cal.segment_of(self.id.cal_key(), m).map(|s| s.start);
                self.ladder_mark_large(prior_segment, &before);
                if m != minute {
                    self.touch(m, e.durable_sequence);
                }
            }
        }
        let segment_start = cal.segment_of(self.id.cal_key(), minute).map(|s| s.start);
        self.ladder(segment_start, &t, 1);
        self.ticks_kept += 1;
        let retro_free = retro_count == 0;
        let held = Arc::make_mut(self.minutes.entry(minute).or_insert_with(|| Arc::new(Minute::new(minute))));
        if t.large == Some(true) {
            held.note_large(t.seq, t.ts);
        }
        held.ticks.push(t);
        if !no_last_sale && self.price.last_price.is_none_or(|(_, ts, _)| e.exchange_ts_ns >= ts) {
            self.price.last_price = Some((price, e.exchange_ts_ns, minute));
        }
        // The live common case -- the newest print of the newest minute -- is folded in O(1). Anything else (a late
        // print, a retro-marked attack, a finalized minute, no-trade minutes after it) takes the full rebuild.
        let fast = retro_free && self.minutes.range(minute + 1..).next().is_none() && {
            let coverage = self.covered_state(minute);
            let m = self.minutes.get_mut(&minute).map(Arc::make_mut).expect("minute just written");
            if !m.finalized && m.append_newest() {
                m.coverage = m.coverage.max(coverage);
                m.last_input_seq = e.durable_sequence;
                true
            } else {
                false
            }
        };
        if fast {
            self.projection.dirty.minutes.insert(minute);
            self.projection.dirty.windows = true;
            self.projection.dirty.day = true;
            self.projection.dirty.flow = true;
        } else {
            self.touch(minute, e.durable_sequence);
        }
        true
    }

    /// Events are missing from the durable stream (a corrupt WAL span Market Runtime could not read) while this
    /// instrument is held. Which of them were this instrument's is unknown, but they come after everything applied
    /// so far: the newest minute held is marked now, and the span up to the next event when it arrives.
    pub fn mark_durable_gap(&mut self) {
        self.quality.durable_gaps += 1;
        // Nothing held yet (the lost event was the instrument's first): what was lost lies between the
        // session's open and the next event.
        let Some(&newest) = self.minutes.keys().next_back() else {
            self.cover.durable_gap_from = Some(GAP_FROM_OPEN);
            return;
        };
        self.cover.durable_gap_from = Some(self.cover.durable_gap_from.map_or(newest, |f| f.min(newest)));
        if let Some(m) = self.minutes.get_mut(&newest).map(Arc::make_mut) {
            m.source_gap = true;
        }
        self.touch(newest, self.last_input_seq);
    }

    /// Input of this partition was lost from its session's open (B joined the live lane after the partition opened):
    /// counted as a durable gap, and marked from the open through the minute of the next event when it arrives --
    /// minutes already held included, since the lost events fall anywhere in that span.
    pub fn mark_gap_from_open(&mut self) {
        self.quality.durable_gaps += 1;
        self.cover.durable_gap_from = Some(GAP_FROM_OPEN);
    }

    /// Every held minute and every trading minute in [from, to] lies in one more (`sign` 1) or one fewer (-1) open
    /// volume gap.
    fn cover_gap_span(&mut self, cal: &Calendar, from: i32, to: i32, seq: u64, sign: i32) {
        let mut span: BTreeSet<i32> = self.minutes.range(from..=to).map(|(k, _)| *k).collect();
        for segment in cal.segments(self.id.cal_key()) {
            span.extend(segment.minutes_between(from, to));
        }
        for m in span {
            let minute = Arc::make_mut(self.minutes.entry(m).or_insert_with(|| Arc::new(Minute::new(m))));
            minute.volume_gap_cover = if sign > 0 { minute.volume_gap_cover + 1 } else { minute.volume_gap_cover.saturating_sub(1) };
            self.touch(m, seq);
        }
    }

    /// Mark every held minute and every trading minute in [from, to] as having lost input.
    fn mark_gap_span(&mut self, cal: &Calendar, from: i32, to: i32, seq: u64) {
        let mut span: BTreeSet<i32> = self.minutes.range(from..=to).map(|(k, _)| *k).collect();
        for segment in cal.segments(self.id.cal_key()) {
            span.extend(segment.minutes_between(from, to));
        }
        for m in span {
            Arc::make_mut(self.minutes.entry(m).or_insert_with(|| Arc::new(Minute::new(m)))).source_gap = true;
            self.touch(m, seq);
        }
    }

    /// The producer dropped `e.flags.gap_before` events of this partition before `e` (stated on a print, or by Market
    /// Runtime's loss record where it did not store a re-sent print): counted, and the minute of `e` marked as having
    /// lost input.
    pub fn note_source_gap(&mut self, e: &MarketEvent) {
        if e.flags.gap_before > 0 {
            self.quality.source_gaps = self.quality.source_gaps.saturating_add(e.flags.gap_before);
            if let Some((_, m)) = partition_local_minute(&e.provider, &e.market, &e.session, e.exchange_ts_ns) {
                Arc::make_mut(self.minutes.entry(m).or_insert_with(|| Arc::new(Minute::new(m)))).source_gap = true;
                self.touch(m, e.durable_sequence);
            }
        }
    }

    pub fn apply(&mut self, cal: &Calendar, rules: &RuleSet, e: &MarketEvent) {
        self.last_input_seq = e.durable_sequence;
        self.note_source_gap(e);
        if let Some(from) = self.cover.durable_gap_from.take() {
            if let Some((_, m)) = partition_local_minute(&e.provider, &e.market, &e.session, e.exchange_ts_ns) {
                let from = if from == GAP_FROM_OPEN { cal.segment_of(self.id.cal_key(), m).map_or(m, |s| s.start) } else { from };
                self.mark_gap_span(cal, from.min(m), from.max(m), e.durable_sequence);
            }
        }
        // The minute bar the event belongs to: its stated (or exchange-time) minute, a session's closing publication
        // (13:33) folded into the session's last trading minute (Calendar::bar_minute). Any other minute outside the
        // session stays as it is and is refused as outside the session.
        let minute_of = |m: i32| {
            let m = if m >= 0 { m } else { partition_local_minute(&e.provider, &e.market, &e.session, e.exchange_ts_ns).map(|(_, m)| m).unwrap_or(-1) };
            if m < 0 { m } else { cal.bar_minute(self.id.cal_key(), m).unwrap_or(m) }
        };
        match &e.payload {
            Payload::Trade { price, volume, total_volume, side, trade_id, minute, simtrade, total_amount, .. } => {
                if *simtrade {
                    self.quality.simtrade_skipped += 1;
                    self.flow.auction_pending = true;
                    return;
                }
                if *total_amount > 0.0 {
                    self.price.total_amount = Some(*total_amount);
                }
                let minute = minute_of(*minute);
                let added = self.add_trade(cal, rules, e, *price, *volume, *side, trade_id, minute);
                // A FUT partition's first print carries the session before it, which is no gap.
                if added && self.id.market != "FUT" {
                    self.chain_print(cal, e, minute, *total_volume, *volume);
                }
            }
            Payload::Quote { current, open, high, low, total_volume, volume, status, minute, .. } => {
                let minute = minute_of(*minute);
                let simulated = matches!(status.as_str(), "simulated" | "simtrade");
                if simulated {
                    // A 試撮 quote: an auction is collecting orders (see is_auction_print).
                    self.flow.auction_pending = true;
                }
                if simulated || *current <= 0 || minute < 0 {
                    return;
                }
                if vol::positive(*volume).is_some() {
                    // A quote that carries its own print volume is a print (futures quote stream). Its total is not
                    // compared for unseen volume: the stream coalesces prints, and a FUT partition is a calendar day
                    // whose first print carries the whole night before it -- both read as gaps that are not.
                    let _ = self.add_trade(cal, rules, e, *current, *volume, 0, "", minute);
                    return;
                }
                if *open > 0 && *high > 0 && *low > 0 && self.price.day_quote.is_none_or(|q| e.exchange_ts_ns >= q.ts) {
                    self.price.day_quote = Some(DayQuote { ts: e.exchange_ts_ns, open: *open, high: *high, low: *low, close: *current, volume: *total_volume });
                }
                if !cal.is_trading(self.id.cal_key(), minute) {
                    self.quality.outside_session += 1;
                    return;
                }
                self.open_coverage(minute);
                let last_cum = self.price.last_cum;
                let m = Arc::make_mut(self.minutes.entry(minute).or_insert_with(|| Arc::new(Minute::new(minute))));
                m.quote_ohlc = Some(match m.quote_ohlc {
                    None => QuoteOhlc::first(*current, e.exchange_ts_ns),
                    Some(q) => q.with(*current, e.exchange_ts_ns),
                });
                if vol::positive(*total_volume).is_some() {
                    if !m.cum_started {
                        m.cum_started = true;
                        m.cum_base = last_cum;
                    }
                    m.cum_last = Some(*total_volume);
                    self.price.last_cum = Some(*total_volume);
                }
                if self.price.last_price.is_none_or(|(_, ts, _)| e.exchange_ts_ns >= ts) {
                    self.price.last_price = Some((*current, e.exchange_ts_ns, minute));
                }
                self.touch(minute, e.durable_sequence);
            }
            Payload::MinuteBar { minute, open, high, low, close, volume, amount, average } => {
                let minute = *minute;
                if minute < 0 || *close <= 0 || !cal.is_trading(self.id.cal_key(), minute) {
                    return;
                }
                // A bar without O/H/L (Futu RT_DATA is a 分時 point) keeps its close as the only known price, never 0.
                let known = |v: i64| if v > 0 { v } else { *close };
                let bar = Bar { open: known(*open), high: known(*high).max(*close), low: known(*low).min(*close), close: *close, volume: *volume,
                    partial: e.flags.partial || *open <= 0 || *high <= 0 || *low <= 0, amount: amount.max(0.0), average: (*average).max(0) };
                if e.flags.backfill {
                    // Valid strictly before the cut-off: the live stream owns everything from the cut-off on.
                    let cutoff = e.flags.backfill_cutoff_ns.and_then(|c| partition_local_minute(&e.provider, &e.market, &e.session, c).map(|(_, m)| m));
                    if cutoff.is_none_or(|c| minute >= c) {
                        return;
                    }
                    let m = Arc::make_mut(self.minutes.entry(minute).or_insert_with(|| Arc::new(Minute::new(minute))));
                    m.backfill_bar = Some(bar);
                    m.coverage = m.coverage.max(2);
                } else {
                    self.open_coverage(minute);
                    let m = Arc::make_mut(self.minutes.entry(minute).or_insert_with(|| Arc::new(Minute::new(minute))));
                    m.source_bar = Some(bar); // a later push for the same minute replaces, never adds
                    if self.price.last_price.is_none_or(|(_, ts, _)| e.exchange_ts_ns >= ts) {
                        self.price.last_price = Some((*close, e.exchange_ts_ns, minute));
                    }
                }
                self.touch(minute, e.durable_sequence);
            }
            Payload::OrderBook { bids, asks, .. } => {
                // The exchange's own book times are not monotonic: an older book never replaces a newer one (equal
                // times keep durable order), the rule of features.rs. It still proves the instrument is covered.
                if self.price.book.is_none_or(|(ts, ..)| e.exchange_ts_ns >= ts) {
                    let bid = bids.first().map(|l| l.price).unwrap_or(0);
                    let ask = asks.first().map(|l| l.price).unwrap_or(0);
                    self.price.book = Some((e.exchange_ts_ns, bid, ask));
                    self.price.book_top = Some(BookTop { ts: e.exchange_ts_ns, bid, bid_volume: bids.first().map(|l| l.volume).unwrap_or(0.0),
                        ask, ask_volume: asks.first().map(|l| l.volume).unwrap_or(0.0) });
                }
                if let Some(m) = partition_local_minute(&e.provider, &e.market, &e.session, e.exchange_ts_ns).map(|(_, m)| m) {
                    if cal.is_trading(self.id.cal_key(), m) {
                        self.open_coverage(m);
                    }
                }
            }
            Payload::Reference { .. } => {
                let before = self.price.reference.comparison_price();
                self.price.reference.absorb(&e.payload);
                if self.price.reference.comparison_price() != before {
                    self.projection.dirty.day = true;
                    self.projection.dirty.windows = true;
                }
            }
            // Coverage reaches an instrument through Engine::apply_coverage, never as one of its events.
            Payload::SourceStatus { .. } | Payload::Clock { .. } => {}
        }
    }

    /// Scope clock reached `minute`: every trading minute before it exists and is finalized.
    pub fn advance(&mut self, cal: &Calendar, minute: i32, seq: u64) {
        if minute <= 0 {
            return;
        }
        let from = self.cover.materialized_through + 1;
        let upto = minute - 1;
        if upto < from {
            return;
        }
        for segment in cal.segments(self.id.cal_key()) {
            for m in segment.minutes_between(from, upto) {
                // Minutes before this instrument was ever observed stay MISSING (joined mid-session).
                let exists = self.minutes.contains_key(&m);
                if !exists {
                    self.minutes.insert(m, Arc::new(Minute::new(m)));
                }
                self.touch(m, seq);
                if let Some(x) = self.minutes.get_mut(&m).map(Arc::make_mut) {
                    if !x.finalized {
                        x.finalized = true;
                        self.projection.dirty.minutes.insert(m);
                    }
                }
            }
        }
        self.cover.materialized_through = upto;
        self.projection.dirty.windows = true;
        self.projection.dirty.day = true;
        self.projection.dirty.flow = true;
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::rules::{FlowRule, Match};
    use market_runtime::event::{days_from_civil, EventFlags};

    #[test]
    fn every_quality_and_completeness_b_emits_is_in_the_system_contract() {
        // config/system_contract.json's minute_quality / block_completeness are the published vocabulary;
        // a name B emits outside it would be a value no reader was promised.
        let contract: Value = serde_json::from_str(market_runtime::contract::SYSTEM_CONTRACT).unwrap();
        let listed = |key: &str| -> Vec<String> {
            contract[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
        };
        let qualities = listed("minute_quality");
        for q in [Quality::Traded, Quality::NoTradeSynthetic, Quality::NoTradeNoPrice, Quality::Missing, Quality::Partial] {
            assert!(qualities.contains(&q.name().to_string()), "{}", q.name());
        }
        let completeness = listed("block_completeness");
        for c in ["COMPLETE", "PARTIAL", "WARMUP", "MISSING", "RECOVERING", "UNAVAILABLE"] {
            assert!(completeness.contains(&c.to_string()), "{c}");
        }
    }

    pub fn ts(minute: i32, second: i32) -> i64 {
        // 2026-09-29 Taipei local minute -> UTC ns
        (days_from_civil(2026, 9, 29) * 86_400 + (minute as i64) * 60 + second as i64 - 8 * 3600) * 1_000_000_000
    }

    pub fn trade_at(seq: u64, minute: i32, second: i32, price: i64, volume: impl Into<f64>, side: i8) -> MarketEvent {
        let volume: f64 = volume.into();
        MarketEvent {
            schema_version: 2, event_id: String::new(), durable_sequence: seq, symbol: "shioaji:STK:2330".into(), provider: "shioaji".into(),
            market: "STK".into(), code: "2330".into(), session: "DAY".into(), trading_date: "2026-09-29".into(), generation: 1, sequence: seq,
            exchange_ts_ns: ts(minute, second), arrival_ns: 0, a_received_ns: 0, runtime_epoch: 1, time_quality: "exchange".into(),
            trace_id: String::new(), flags: EventFlags::default(), versions: Default::default(),
            payload: Payload::Trade { price, volume, total_volume: 0.0, side, trade_id: format!("t{seq}"), minute,
                open: 0, high: 0, low: 0, average: 0, total_amount: 0.0, amount: 0.0, simtrade: false, bid_side_total_vol: None, ask_side_total_vol: None, auction: false, after_hours: false, condition: None, no_last_sale: false },
        }
    }

    /// The partition's 昨收 (`prev_close`), as its one source sends it: a Reference event.
    pub fn reference_at(seq: u64, prev_close: i64) -> MarketEvent {
        let mut e = trade_at(seq, 540, 0, 0, 0, 0);
        e.payload = Payload::Reference { limit_up: None, limit_down: None, prev_close: Some(prev_close), prev_volume: None,
                                         reference_price: None, name: None, reference_source: None };
        e
    }

    /// An instrument whose session has opened: its first print (the opening match, an auction print) is behind it,
    /// at a price of its own, so what a test applies next is continuous trading.
    fn opened(cal: &Calendar, r: &RuleSet) -> Instrument {
        let mut inst = Instrument::new(id());
        inst.apply(cal, r, &trade_at(0, 540, 0, 900_000, 1, 0));
        inst
    }

    fn id() -> InstrumentId {
        InstrumentId { source: "shioaji".into(), market: "STK".into(), code: "2330".into(), trading_date: "2026-09-29".into(), session: "DAY".into() }
    }

    pub fn rules() -> RuleSet {
        RuleSet { flow: vec![FlowRule { rule_id: "tw-100".into(), matcher: Match { source: Some("shioaji".into()), market: Some("STK".into()), code: None },
            threshold_type: "volume".into(), threshold: 100.0, unit: "lot".into(), unit_size: 1000.0, multiplier: 1.0, currency: "TWD".into(),
            impact_ratio: Some(0.30), episode_gap_ms: Some(1500), episode_max_ms: None, impact_min_fraction: None, member_min_fraction: None }],
            side_inference: "quote_rule".into(), flow_revision: Some(1), ..Default::default() }
    }


    fn book_at(seq: u64, minute: i32, second: i32, bid: (i64, i64), ask: (i64, i64)) -> MarketEvent {
        let mut e = trade_at(seq, minute, second, 0, 0, 0);
        e.payload = Payload::OrderBook { bids: vec![market_runtime::event::BookLevel { price: bid.0, volume: bid.1 as f64 }],
            asks: vec![market_runtime::event::BookLevel { price: ask.0, volume: ask.1 as f64 }], simtrade: false };
        e
    }

    fn with_ms(mut e: MarketEvent, ms: i64) -> MarketEvent {
        e.exchange_ts_ns += ms * 1_000_000;
        e
    }

    fn trade_total(seq: u64, minute: i32, second: i32, volume: i64, total: i64) -> MarketEvent {
        let mut e = trade_at(seq, minute, second, 1_000_000, volume as f64, 1);
        if let Payload::Trade { total_volume, .. } = &mut e.payload {
            *total_volume = total as f64;
        }
        e
    }

    #[test]
    fn volume_a_late_start_never_saw_is_unattributed_and_its_span_is_marked_lost() {
        // 3481: the App came up after the 28,748-lot opening print. The first print it saw carried a
        // cumulative total of 28,760: 28,748 lots traded before it that no print delivered. When they
        // traded is unknown, so no minute is given them -- the day's total is, and the minutes they may have traded
        // in are marked as lost input.
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_total(1, 543, 5, 12, 28_760));
        let m = &inst.minutes[&543];
        assert_eq!(m.unattributed_volume, 28_748.0);
        assert_eq!(m.volume, Some(12.0), "the minute holds only what was seen in it");
        assert_eq!(m.flow.total(), 12.0, "only the seen print is classified: the gap's side is unknown");
        for minute in 540..=543 {
            assert!(inst.minutes[&minute].lost_input(), "minute {minute} lies between the open and the first seen print");
        }
        // Prints that follow without a hole add nothing; the next minute's incremental path keeps working.
        inst.apply(&cal, &r, &trade_total(2, 543, 30, 3, 28_763));
        inst.apply(&cal, &r, &trade_total(3, 544, 1, 5, 28_768));
        assert_eq!(inst.minutes[&543].volume, Some(15.0));
        assert_eq!(inst.minutes[&544].volume, Some(5.0));
        assert!(!inst.minutes[&544].lost_input());
        // A reconnect that missed 40 lots mid-session: between the print at 09:04 and the one at 09:10.
        inst.apply(&cal, &r, &trade_total(4, 550, 0, 2, 28_810));
        assert_eq!(inst.minutes[&550].unattributed_volume, 40.0);
        assert_eq!(inst.minutes[&550].volume, Some(2.0));
        for minute in 544..=550 {
            assert!(inst.minutes[&minute].lost_input(), "minute {minute} may hold some of the 40 unseen lots");
        }
        assert_eq!(inst.quality.volume_gaps, 2);
        let day = inst.day_wire(&cal, &r, ts(551, 0), None, None).0;
        assert_eq!(day["volume"], 28_810.0, "the day's volume is the exchange's total: seen prints plus the unattributed");
        assert_eq!(day["volume_complete"], false, "but its minute breakdown is not complete");
    }

    #[test]
    fn an_older_or_unnumbered_print_proves_no_gap() {
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_total(1, 600, 0, 10, 10));
        inst.apply(&cal, &r, &trade_total(2, 600, 1, 5, 0)); // no total: nothing to compare
        inst.apply(&cal, &r, &trade_total(3, 600, 2, 5, 15)); // 10 + 5 = 15: no hole
        inst.apply(&cal, &r, &trade_total(4, 600, 3, 1, 12)); // behind the known total (late/out of order): no gap
        assert_eq!(inst.minutes[&600].unattributed_volume, 0.0);
        assert_eq!(inst.minutes[&600].volume, Some(21.0));
    }

    #[test]
    fn a_minute_carries_the_sources_running_average_as_its_average_price() {
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = opened(&cal, &r);
        let mut t = trade_at(1, 541, 5, 1_000_000, 1, 1);
        if let Payload::Trade { average, amount, .. } = &mut t.payload { *average = 995_000; *amount = 500.0; }
        inst.apply(&cal, &r, &t);
        assert_eq!(inst.minutes[&541].wire(&id(), None, None)["average_price"], json!(99.5), "the 均價 the source reported");
        assert_eq!(inst.minutes[&541].wire(&id(), None, None)["amount"], json!(500.0), "the amount a tab's own 均價 is summed from");
        inst.apply(&cal, &r, &trade_at(2, 542, 5, 1_000_000, 1, 1));
        assert_eq!(inst.minutes[&542].wire(&id(), None, None)["average_price"], Value::Null, "none reported: null, never 0");
    }

    #[test]
    fn a_futures_quote_print_carries_its_average_and_amount_into_the_minute() {
        // The futures stream sends each print as a quote with its own volume; its 均價 and amount are the exchange's
        // and belong to the minute exactly as a Trade's do.
        let (cal, r) = (Calendar::default(), rules());
        let id = InstrumentId { source: "shioaji".into(), market: "FUT".into(), code: "TXFR1".into(),
            trading_date: "2026-09-29".into(), session: "DAY".into() };
        let quote = |seq: u64, minute: i32, current: i64, average: i64, amount: f64| {
            let mut e = trade_at(seq, minute, 1, current, 1, 0);
            e.market = "FUT".into();
            e.code = "TXFR1".into();
            e.symbol = "shioaji:FUT:TXFR1".into();
            e.session = "DAY".into();
            e.trading_date = "2026-09-29".into();
            e.payload = Payload::Quote { current, open: 0, high: 0, low: 0, total_volume: 0.0, total_amount: 0.0,
                status: "live".into(), minute, average, volume: 2.0, amount, advance_count: None, decline_count: None,
                flat_count: None, limit_up_count: None, limit_down_count: None };
            e
        };
        let mut inst = Instrument::new(id.clone());
        inst.apply(&cal, &r, &quote(1, 540, 201_000_000, 200_500_000, 4_020_000.0));
        inst.apply(&cal, &r, &quote(2, 540, 201_200_000, 200_600_000, 4_024_000.0));
        inst.apply(&cal, &r, &quote(3, 541, 201_400_000, 0, 0.0));
        let first = inst.minutes[&540].wire(&id, None, None);
        assert_eq!(first["average_price"], json!(20060.0), "the minute's newest print's 均價");
        assert_eq!(inst.minutes[&540].amount, Some(8_044_000.0), "the prints' amounts summed");
        assert_eq!(inst.minutes[&541].wire(&id, None, None)["average_price"], Value::Null, "none reported: null, never 0");
    }

    #[test]
    fn a_new_sessions_count_restarts_the_comparison() {
        // A futures night restarts the exchange's cumulative count: the first seen print of it is compared from zero.
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_total(1, 600, 0, 10, 50_000));
        inst.apply(&cal, &r, &trade_total(2, 601, 0, 3, 3));
        assert_eq!(inst.minutes[&601].unattributed_volume, 0.0, "the new session's first print");
        assert_eq!(inst.price.trade_chain.high(), Some(3.0));
    }

    #[test]
    fn impact_against_a_thin_book_needs_a_real_size_too() {
        // Best ask only 2 lots: a 1-lot buy "consumes 50%" of it. That is not a large order -- impact only lowers the
        // bar to half the threshold (50 lots), it never replaces size.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = opened(&cal, &r);
        inst.apply(&cal, &r, &book_at(1, 600, 0, (999_000, 2), (1_000_000, 2)));
        for (i, seq) in (2..=6).enumerate() {
            inst.apply(&cal, &r, &with_ms(trade_at(seq, 600, 1, 1_000_000, 1, 1), i as i64 * 200));
        }
        assert!(inst.minutes[&600].ticks.iter().all(|t| t.large == Some(false)), "1-lot prints against a thin book stay small");
        // 60 lots that sweep >= 30% of a 150-lot ask: half the threshold AND a real impact -> large.
        let mut inst = opened(&cal, &r);
        inst.apply(&cal, &r, &book_at(1, 601, 0, (999_000, 150), (1_000_000, 150)));
        for (i, seq) in (2..=4).enumerate() {
            inst.apply(&cal, &r, &with_ms(trade_at(seq, 601, 1, 1_000_000, 20, 1), i as i64 * 200));
        }
        let t = &inst.minutes[&601].ticks;
        assert!(t.iter().all(|x| x.large == Some(true)), "60 lots taking 40% of the ask is one large attack");
        assert!(t.iter().any(|x| x.large_reason & LARGE_BY_IMPACT != 0));
    }

    #[test]
    fn small_prints_inside_a_large_attack_stay_small() {
        // 2344: 1-lot prints in the same second as 42/58-lot buys were each listed as 大單. A print
        // below 10% of the threshold never shares the attack's verdict, nor counts toward its size.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = opened(&cal, &r);
        for (i, (seq, volume)) in [(1, 1), (2, 42), (3, 1), (4, 58), (5, 2)].into_iter().enumerate() {
            inst.apply(&cal, &r, &with_ms(trade_at(seq, 600, 1, 1_000_000, volume, 1), i as i64 * 100));
        }
        let t = &inst.minutes[&600].ticks;
        let large: Vec<f64> = t.iter().filter(|x| x.large == Some(true)).map(|x| x.volume).collect();
        assert_eq!(large, vec![42.0, 58.0], "42 + 58 = 100 lots is one attack; the 1- and 2-lot prints are not part of it");
        assert!(t.iter().filter(|x| x.volume >= 42.0).all(|x| x.large_reason & LARGE_BY_EPISODE != 0));
        // Many small prints never add up to an attack on their own.
        let mut inst = opened(&cal, &r);
        for (i, seq) in (1..=20).enumerate() {
            inst.apply(&cal, &r, &with_ms(trade_at(seq, 601, 1, 1_000_000, 9, 1), i as i64 * 100));
        }
        assert!(inst.minutes[&601].ticks.iter().all(|x| x.large == Some(false)), "20 x 9 lots is not a split large order");
    }

    /// The per-price split recomputed from the prints held one by one (every print here is held).
    fn ladder_flow_from_ticks(inst: &Instrument) -> BTreeMap<i64, Flow> {
        let mut out: BTreeMap<i64, Flow> = BTreeMap::new();
        for t in inst.minutes.values().flat_map(|m| m.ticks.iter()) {
            out.entry(t.price).or_default().add(t.large, t.side, t.volume, 1);
        }
        out
    }

    #[test]
    fn each_price_carries_its_large_and_small_volume_including_retro_marked_prints() {
        // 各價位大單: 42 lots at 100 is small on arrival; the 58 lots at 100.5 that follow make one 100-lot attack,
        // so the 42 becomes large afterwards -- the ladder at 100 must move it from small to large.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = opened(&cal, &r);
        let tape = [(1, 1_000_000, 1, 1), (2, 1_000_000, 42, 1), (3, 1_005_000, 58, 1), (4, 1_005_000, 3, -1)];
        for (i, (seq, price, volume, side)) in tape.into_iter().enumerate() {
            inst.apply(&cal, &r, &with_ms(trade_at(seq, 600, 1, price, volume, side), i as i64 * 100));
        }
        let at_100 = &inst.flow.price_volume[&1_000_000].flow;
        assert_eq!((at_100.large.buy, at_100.large.count, at_100.small.buy, at_100.small.count), (42.0, 1, 1.0, 1));
        let at_1005 = &inst.flow.price_volume[&1_005_000].flow;
        assert_eq!((at_1005.large.buy, at_1005.small.sell, at_1005.small.count), (58.0, 3.0, 1));
        let session: BTreeMap<i64, Flow> = inst.flow.segment_price_volume.values().next().unwrap().iter().map(|(p, b)| (*p, b.flow.clone())).collect();
        assert_eq!(session, ladder_flow_from_ticks(&inst), "the session ladder is revised the same way");

        // The wire: per price, 大單 buy/sell, 總量 buy/sell and counts, as a flat array laid out by flow_fields.
        let day = inst.day_wire(&cal, &r, ts(600, 30), None, None).0;
        let pv = &day["price_volume"];
        let fields: Vec<&str> = pv["flow_fields"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(fields, LADDER_FLOW_FIELDS.to_vec());
        let bucket = pv["buckets"].as_array().unwrap().iter().find(|b| b["price"].as_f64() == Some(100.0)).unwrap();
        assert_eq!((bucket["out"].as_i64(), bucket["in"].as_i64()), (Some(43), Some(0)));
        let flow: Vec<i64> = bucket["flow"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
        let at = |name: &str| flow[fields.iter().position(|f| *f == name).unwrap()];
        assert_eq!((at("large_buy"), at("large_sell"), at("large_count")), (42, 0, 1));
        assert_eq!((at("small_buy"), at("small_count")), (1, 1));
        assert!(pv["flow_rule_id"].is_string(), "the rule the split was made under is named once per ladder");
        // Compact: a row stays a few dozen bytes however many prices a stock trades at.
        assert!(serde_json::to_string(bucket).unwrap().len() < 160);
        // The header's totals are B's session flow, equal to the rows' sum (the retro-marked 42 lots counted as large).
        let mut rows = Flow::default();
        for b in inst.session_ladder(540).values() {
            rows.merge(&b.flow);
        }
        assert_eq!(pv["totals"], json!({"large": side_wire(&rows.large), "small": side_wire(&rows.small), "unclassified": side_wire(&rows.unclassified)}));
        assert_eq!((pv["totals"]["large"]["buy"].as_i64(), pv["totals"]["small"]["buy"].as_i64(), pv["totals"]["small"]["sell"].as_i64()),
                   (Some(100), Some(1), Some(3)));
    }

    #[test]
    fn an_instrument_without_a_large_order_rule_has_no_per_price_split() {
        // All of Futu (and TXF today): the ladder stays the plain price / volume / out / in rows.
        let cal = Calendar::default();
        let none = RuleSet::default();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &none, &trade_at(1, 600, 1, 1_000_000, 500, 1));
        let day = inst.day_wire(&cal, &none, ts(600, 30), None, None).0;
        let pv = &day["price_volume"];
        assert!(pv["flow_fields"].is_null() && pv["flow_rule_id"].is_null() && pv["totals"].is_null());
        let row = &pv["buckets"][0];
        assert!(row.get("flow").is_none(), "no rule, no split: {row}");
        assert_eq!((row["volume"].as_i64(), row["out"].as_i64()), (Some(500), Some(500)));
    }

    #[test]
    fn futu_keeps_no_price_ladder_and_its_day_has_no_price_volume() {
        let cal = Calendar::default();
        let r = rules();
        let id = InstrumentId { source: "futu".into(), market: "HK".into(), code: "HK.00700".into(), trading_date: "2026-09-29".into(), session: "DAY".into() };
        let mut inst = Instrument::new(id);
        let mut e = trade_at(1, 600, 1, 3_000_000, 500, 1);
        e.provider = "futu".into();
        e.market = "HK".into();
        e.code = "HK.00700".into();
        e.symbol = "futu:HK:HK.00700".into();
        inst.apply(&cal, &r, &e);
        assert!(inst.minutes.get(&600).is_some_and(|m| m.ticks.len() == 1), "the print itself is still held");
        assert!(inst.flow.price_volume.is_empty() && inst.flow.segment_price_volume.is_empty(), "but no ladder is kept");
        let day = inst.day_wire(&cal, &r, ts(600, 30), None, None).0;
        let pv = day["price_volume"].as_object().expect("the 內外盤 totals");
        assert_eq!(pv.keys().map(String::as_str).collect::<Vec<_>>(), ["in_volume", "out_volume"], "no 價量 ladder, only the totals");
        assert!(day.get("volume").is_some(), "the rest of the day is unchanged");
    }

    #[test]
    fn the_incremental_minute_fold_equals_a_full_rebuild() {
        // Deterministic pseudo-random tape: in-order prints, out-of-order ones, attacks that qualify (retro marks),
        // books in between and minute changes. After every event, each minute must equal a from-scratch rebuild.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
        let mut seq = 1u64;
        for step in 0..3000 {
            let minute = 540 + (step / 400) as i32;
            let second = ((step % 400) * 60 / 400) as i32;
            let jitter = (next() % 5) as i32 - 1; // occasionally a print stamped a second early
            let e = if next() % 5 == 0 {
                book_at(seq, minute, second, (999_000, 50 + (next() % 200) as i64), (1_000_000, 50 + (next() % 200) as i64))
            } else {
                let volume = if next() % 20 == 0 { 80 } else { 1 + (next() % 9) as i64 };
                let side = if next() % 2 == 0 { 1 } else { -1 };
                trade_at(seq, minute, (second + jitter).clamp(0, 59), 999_000 + (next() % 30) as i64 * 100, volume as f64, side)
            };
            inst.apply(&cal, &r, &e);
            seq += 1;
            for (m, got) in &inst.minutes {
                let mut rebuilt = Minute::clone(got);
                rebuilt.recompute(inst.prev_close_before(*m));
                assert_eq!((got.open, got.high, got.low, got.close, got.volume, got.trades, got.quality, &got.flow),
                    (rebuilt.open, rebuilt.high, rebuilt.low, rebuilt.close, rebuilt.volume, rebuilt.trades, rebuilt.quality, &rebuilt.flow),
                    "minute {m} after step {step}");
            }
        }
    }

    #[test]
    fn a_futures_night_session_is_one_partition_across_midnight() {
        // A night is ONE partition, dated by the day it opens, its minutes continuing past midnight:
        // 15:00 = 900, 23:59 = 1439, 00:30 = 1470. Nothing is joined across partitions and nothing restarts at 00:00.
        // The producer names the NIGHT partition and the continued minute (session_identity_contract.wal_partition).
        let cal = Calendar::default();
        let r = rules();
        let fut = |seq: u64, minute: i32, price: i64, volume: i64| {
            let mut e = trade_at(seq, minute, 1, price, volume as f64, 1);
            e.market = "FUT".into();
            e.code = "TXFR1".into();
            e.symbol = "shioaji:FUT:TXFR1".into();
            e.session = "NIGHT".into();
            e.trading_date = "2026-09-29".into();
            e
        };
        let id = InstrumentId { source: "shioaji".into(), market: "FUT".into(), code: "TXFR1".into(),
            trading_date: "2026-09-29".into(), session: "NIGHT".into() };
        let mut night = Instrument::new(id.clone());
        for e in [fut(1, 900, 200_000_000, 3), fut(2, 1439, 201_000_000, 4), fut(3, 1470, 202_000_000, 5)] {
            assert_eq!(InstrumentId::of(&e), id, "every print of the night is in the night's partition");
            night.apply(&cal, &r, &e);
        }
        let t_tail = ts(31, 0) + 86_400_000_000_000;
        let day = night.day_wire(&cal, &r, t_tail, None, None).0;
        assert_eq!(day["session"], "NIGHT");
        assert_eq!(day["open"], json!(20000.0), "the night opened at 15:00");
        assert_eq!(day["volume"], json!(12), "15:00-24:00 and 00:00-00:30 are one session");
        assert_eq!(day["session_start_minute"], json!(900));
        assert_eq!(day["price_volume"]["buckets"].as_array().unwrap().len(), 3);
        let (flow, _, _) = night.flow_wire(&cal, &r, t_tail, None, None, None);
        let minutes: Vec<i64> = flow["minuteSeries"].as_array().unwrap().iter().map(|x| x["minute"].as_i64().unwrap()).collect();
        assert_eq!(minutes.first(), Some(&900), "the series starts where the night started");
        assert_eq!(minutes.last(), Some(&1470), "and continues past midnight");
        let times: Vec<&str> = flow["minuteSeries"].as_array().unwrap().iter().map(|x| x["time"].as_str().unwrap()).collect();
        assert_eq!(times.last(), Some(&"00:30"), "the series' clock wraps at 24 hours, never 24:30");
        let last = &night.minutes[&1470].wire(&id, None, None);
        assert_eq!(last["minute_timestamp"], "2026-09-30T00:30:00+08:00", "a minute past 1440 is on the next day");
        assert_eq!(last["time"], "00:30", "and its clock is the next morning's, never 24:30");
    }

    #[test]
    fn the_grouped_state_keeps_the_checkpoints_one_flat_layout() {
        // PriceState, CoverageState, FlowState, QualityDiagnostics and ProjectionRevision are flattened: a checkpoint
        // written before the grouping reads as before, and one written now has the same fields.
        let cal = Calendar::default();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &rules(), &trade_at(1, 600, 1, 1_000_000, 10, 1));
        let image = serde_json::to_value(inst.checkpoint_view()).unwrap();
        let keys: BTreeSet<&str> = image.as_object().unwrap().keys().map(String::as_str).collect();
        let layout: BTreeSet<&str> = ["id", "reference", "minutes", "last_price", "last_cum", "trade_chain",
            "total_amount", "coverage", "book", "book_top", "day_quote", "episode", "next_episode", "materialized_through", "price_volume",
            "segment_price_volume", "ticks_kept", "ticks_dropped", "outside_session", "simtrade_skipped", "auction_pending",
            "auction_prints", "volume_gaps", "source_gaps", "durable_gaps", "durable_gap_from",
            "last_input_seq", "revisions", "events"].into_iter().collect();
        assert_eq!(keys, layout);
        let back: Instrument = serde_json::from_value(image.clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), image, "the price-keyed ladders read back");
    }

    /// A replay keeps an engine copy every interval of the day: a copy shares every minute the engine does not write
    /// afterwards, and a minute written afterwards (a late print) is copied, never changed under the copy.
    #[test]
    fn an_engine_copy_shares_its_minutes_until_one_is_written() {
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 600, 1, 1_000_000, 10, 1));
        inst.apply(&cal, &r, &trade_at(2, 601, 1, 1_010_000, 10, 1));
        let copy = inst.clone();
        inst.apply(&cal, &r, &trade_at(3, 602, 1, 1_020_000, 10, 1));
        assert!(Arc::ptr_eq(&copy.minutes[&600], &inst.minutes[&600]), "a closed minute is shared");
        inst.apply(&cal, &r, &trade_at(4, 601, 30, 1_030_000, 5, 1));
        assert!(!Arc::ptr_eq(&copy.minutes[&601], &inst.minutes[&601]), "the written minute is the engine's own copy");
        assert_eq!((copy.minutes[&601].volume, inst.minutes[&601].volume), (Some(10.0), Some(15.0)), "the copy keeps its state");
        assert!(!copy.minutes.contains_key(&602));
    }

    #[test]
    fn a_checkpoint_state_missing_a_field_is_refused_not_zero_filled() {
        // Every field of the checkpointed state is required: a state written without one (an older layout) does not
        // decode, so the checkpoint is refused and rebuilt from the stream instead of resumed with zeros.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 600, 1, 1_000_000, 10, 1));
        let image = serde_json::to_value(inst.checkpoint_view()).unwrap();
        assert!(serde_json::from_value::<Instrument>(image.clone()).is_ok());
        for field in ["segment_price_volume", "auction_prints", "durable_gaps"] {
            let mut older = image.clone();
            older.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<Instrument>(older).is_err(), "{field}");
        }
        let mut minute = serde_json::to_value(&inst.minutes[&600]).unwrap();
        let volume = minute["unattributed_volume"].take();
        minute.as_object_mut().unwrap().remove("unattributed_volume");
        minute["gap_volume"] = volume;
        assert!(serde_json::from_value::<Minute>(minute).is_err(), "the retired name gap_volume is not read");
    }

    /// A print Market Runtime flagged at ingest as setting no last sale (an odd lot, an average-price print).
    fn no_last_sale_at(seq: u64, minute: i32, second: i32, price: i64, volume: impl Into<f64>, side: i8) -> MarketEvent {
        let mut e = trade_at(seq, minute, second, price, volume, side);
        if let Payload::Trade { no_last_sale, condition, .. } = &mut e.payload {
            *no_last_sale = true;
            *condition = Some("ODD_LOT".into());
        }
        e
    }

    #[test]
    fn a_print_that_sets_no_last_sale_is_volume_alone() {
        // 11-06 US.TSM: odd lots at 昨收 before the open and 392.26 / 350.09 average-price prints after hours were each
        // a minute's open / high / low / close, and the trend line spiked to them.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        // The session's first minute holds only such prints: it traded volume, at no price.
        inst.apply(&cal, &r, &no_last_sale_at(1, 540, 1, 1_200_000, 3, 1));
        let first = &inst.minutes[&540];
        assert_eq!((first.open, first.close, first.volume, first.quality), (None, None, Some(3.0), Quality::NoTradeNoPrice));
        inst.apply(&cal, &r, &trade_at(2, 541, 1, 1_000_000, 5, 1));
        inst.apply(&cal, &r, &no_last_sale_at(3, 541, 2, 1_200_000, 500, 1));
        inst.apply(&cal, &r, &trade_at(4, 541, 3, 1_010_000, 2, -1));
        inst.apply(&cal, &r, &no_last_sale_at(5, 541, 4, 800_000, 1, -1));
        let m = &inst.minutes[&541];
        assert_eq!((m.open, m.high, m.low, m.close), (Some(1_000_000), Some(1_010_000), Some(1_000_000), Some(1_010_000)));
        assert_eq!((m.volume, m.trades, m.quality), (Some(508.0), 4, Quality::Traded), "their volume is the minute's");
        let odd = &m.ticks[1];
        assert_eq!((odd.no_last_sale, odd.side, odd.large, odd.episode), (true, 0, None, 0), "不分內外盤, never 大單 (500 lots)");
        assert_eq!(inst.price.last_price.map(|p| p.0), Some(1_010_000), "the newest print set no last sale");
        assert!(!inst.flow.price_volume.contains_key(&1_200_000) && !inst.flow.price_volume.contains_key(&800_000), "no 價量 level");
        // A later minute of such prints alone carries the price on.
        inst.apply(&cal, &r, &no_last_sale_at(6, 542, 1, 1_300_000, 2, 1));
        let carried = &inst.minutes[&542];
        assert_eq!((carried.open, carried.high, carried.close, carried.volume, carried.quality),
                   (Some(1_010_000), Some(1_010_000), Some(1_010_000), Some(2.0), Quality::NoTradeSynthetic));
        let day = inst.day_wire(&cal, &r, ts(542, 30), None, None).0;
        assert_eq!((day["open"].clone(), day["high"].clone(), day["close"].clone()), (json!(100.0), json!(101.0), json!(101.0)));
        // Folded (a checkpoint keeps aggregates): the same minute, the same volume.
        let restored = inst.checkpoint_view();
        let (m, f) = (&inst.minutes[&541], &restored.minutes[&541]);
        assert_eq!((f.open, f.high, f.low, f.close, f.volume, f.trades), (m.open, m.high, m.low, m.close, m.volume, m.trades));
        let f540 = &restored.minutes[&540];
        assert_eq!((f540.close, f540.volume), (None, Some(3.0)), "a folded minute of such prints keeps its volume");
    }

    #[test]
    fn the_session_open_survives_a_restart() {
        // After a checkpoint restore the first NEW print must not become the session open.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 540, 1, 1_000_000, 1, 1));
        inst.apply(&cal, &r, &trade_at(2, 541, 1, 1_010_000, 1, 1));
        let mut restored = inst.checkpoint_view();
        restored.apply(&cal, &r, &trade_at(3, 600, 1, 1_050_000, 1, 1));
        let t = ts(600, 30);
        let day = restored.day_wire(&cal, &r, t, None, None).0;
        assert_eq!(day["open"], json!(100.0), "the open is the 09:00 print, not the first print after the restart");
        let fresh = {
            let mut i = Instrument::new(id());
            i.apply(&cal, &r, &trade_at(1, 540, 1, 1_000_000, 1, 1));
            i.day_wire(&cal, &r, t, None, None).0
        };
        assert_eq!(fresh["open"], json!(100.0));
    }

    #[test]
    fn the_closing_auction_print_is_never_a_large_order() {
        // 2344: the 13:30 closing call auction (5,371 lots) was listed as 大單.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = opened(&cal, &r);
        inst.apply(&cal, &r, &trade_at(1, 809, 30, 1_000_000, 500, 1));
        inst.apply(&cal, &r, &auction_at(2, 810, 0, 1_000_000, 5371, 1));
        assert_eq!(inst.minutes[&809].ticks[0].large, Some(true), "the same size in continuous trading is large");
        let auction = &inst.minutes[&810].ticks[0];
        assert_eq!((auction.large, auction.episode), (None, 0), "the auction print is neither large nor part of an attack");
        assert_eq!(auction.side, 0, "不分內外盤: the broker's tick_type 1 on it is not taken (user 10-20)");
        assert_eq!(inst.minutes[&810].flow.unclassified.total(), 5371.0, "its volume stays visible as unclassified");
        let listed: Vec<u64> = inst.session_large_orders(&cal, None, 0, 1440, 100, None).0.iter().map(|x| x["durable_sequence"].as_u64().unwrap()).collect();
        assert_eq!(listed, vec![1]);
    }

    /// A print Market Runtime flagged as a call-auction match at ingest (Engine::classify_print).
    fn auction_at(seq: u64, minute: i32, second: i32, price: i64, volume: impl Into<f64>, side: i8) -> MarketEvent {
        let mut e = trade_at(seq, minute, second, price, volume, side);
        if let Payload::Trade { auction, .. } = &mut e.payload {
            *auction = true;
        }
        e
    }

    fn simtrade_at(seq: u64, minute: i32, second: i32, price: i64, volume: impl Into<f64>) -> MarketEvent {
        let mut e = trade_at(seq, minute, second, price, volume, 0);
        if let Payload::Trade { simtrade, .. } = &mut e.payload {
            *simtrade = true;
        }
        e
    }

    #[test]
    fn every_print_matched_by_a_call_auction_is_never_large_and_never_starts_an_attack() {
        // 2330's opening match (2,573 lots after the 08:30-09:00 試撮) was 大單 and pulled the next
        // sells into its attack; a 處置股's every match and the match after 緩漲緩跌 follow the same 試撮 -> print.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &simtrade_at(1, 535, 0, 1_000_000, 1800));
        inst.apply(&cal, &r, &simtrade_at(2, 539, 50, 1_005_000, 2400));
        inst.apply(&cal, &r, &trade_at(3, 540, 9, 1_005_000, 2573, -1));
        inst.apply(&cal, &r, &trade_at(4, 540, 10, 1_005_000, 12, -1));
        let open = &inst.minutes[&540].ticks[0];
        assert_eq!((open.auction, open.large, open.episode, open.side), (true, None, 0, 0), "the opening match is an auction print, 不分內外盤");
        assert_eq!(inst.minutes[&540].ticks[1].large, Some(false), "the print after it is continuous trading, judged on its own");
        assert_eq!(inst.minutes[&540].auction_volume, 2573.0);
        // 瞬間價格穩定措施 / 處置股 mid-session: 試撮, then the match.
        inst.apply(&cal, &r, &trade_at(5, 600, 0, 1_005_000, 500, 1));
        inst.apply(&cal, &r, &simtrade_at(6, 610, 0, 1_050_000, 900));
        inst.apply(&cal, &r, &trade_at(7, 612, 0, 1_050_000, 900, 1));
        inst.apply(&cal, &r, &trade_at(8, 612, 5, 1_050_000, 500, 1));
        assert_eq!(inst.minutes[&600].ticks[0].large, Some(true), "the same size in continuous trading is large");
        assert!(inst.minutes[&612].ticks[0].auction && inst.minutes[&612].ticks[0].large.is_none());
        assert_eq!(inst.minutes[&612].ticks[1].large, Some(true), "only the match itself; the next print is continuous");
        assert_eq!(inst.quality.auction_prints, 2);
        // Market Runtime keeps no pre-open 試撮: it flags the session's first print as the opening match at ingest.
        let mut bare = Instrument::new(id());
        bare.apply(&cal, &r, &auction_at(1, 540, 9, 1_005_000, 2573, -1));
        bare.apply(&cal, &r, &trade_at(2, 540, 10, 1_005_000, 300, -1));
        assert!(bare.minutes[&540].ticks[0].auction && bare.minutes[&540].ticks[0].large.is_none());
        assert_eq!(bare.minutes[&540].ticks[1].large, Some(true), "the next print is continuous trading");
        // The mark survives a checkpoint fold.
        Arc::make_mut(inst.minutes.get_mut(&540).unwrap()).fold_ticks();
        let mut m = Minute::clone(&inst.minutes[&540]);
        m.recompute(None);
        assert_eq!(m.auction_volume, 2573.0);
    }

    #[test]
    fn large_orders_survive_a_checkpoint_and_are_listed_per_window() {
        // A checkpoint folded every print into its minute, so after any B restart the 價量 tab
        // lost the day's earlier large orders (even the newest-300 list only held prints since the restart).
        let cal = Calendar::default();
        let r = rules();
        let mut inst = opened(&cal, &r);
        inst.apply(&cal, &r, &book_at(1, 570, 0, (999_000, 2000), (1_000_000, 2000)));
        inst.apply(&cal, &r, &trade_at(2, 570, 1, 1_000_000, 499, 1));
        inst.apply(&cal, &r, &trade_at(3, 600, 1, 1_000_000, 99, -1));
        inst.apply(&cal, &r, &trade_at(4, 660, 1, 1_000_000, 300, -1));
        let restored = inst.checkpoint_view();
        assert!(restored.minutes.values().all(|m| m.ticks.is_empty()), "a checkpoint still folds the prints");
        let seqs = |rows: &[Value]| rows.iter().map(|x| x["durable_sequence"].as_u64().unwrap()).collect::<Vec<_>>();
        let (all, truncated) = restored.session_large_orders(&cal, None, 0, 1440, 100, None);
        assert_eq!((seqs(&all), truncated), (vec![4, 2], false), "both large prints, newest first; the small one never");
        assert_eq!(seqs(&restored.session_large_orders(&cal, None, 540, 630, 100, None).0), vec![2], "one session bucket");
        assert_eq!(seqs(&restored.session_large_orders(&cal, None, 0, 1440, 1, None).0), vec![4]);
        // One side is chosen before the limit -- the newest buy although the newest large print is a sell.
        assert_eq!(seqs(&restored.session_large_orders(&cal, None, 0, 1440, 1, Some(1)).0), vec![2]);
        assert_eq!(seqs(&restored.session_large_orders(&cal, None, 0, 1440, 1, Some(-1)).0), vec![4]);
        let buys = restored.session_large_orders(&cal, None, 0, 1440, 100, Some(1)).0;
        assert!(buys.iter().all(|row| row["side"] == "BUY"));
        assert_eq!(buys.len() + restored.session_large_orders(&cal, None, 0, 1440, 100, Some(-1)).0.len()
            + restored.session_large_orders(&cal, None, 0, 1440, 100, Some(0)).0.len(), all.len());
        assert!(restored.session_large_orders(&cal, None, 0, 1440, 1, None).1, "a cut list says so");
        // A restore that later sees new prints lists both kinds, and a second checkpoint keeps both.
        let mut again = restored.clone();
        again.apply(&cal, &r, &trade_at(5, 700, 1, 1_000_000, 200, 1));
        assert_eq!(seqs(&again.session_large_orders(&cal, None, 0, 1440, 100, None).0), vec![5, 4, 2]);
        assert_eq!(seqs(&again.checkpoint_view().session_large_orders(&cal, None, 0, 1440, 100, None).0), vec![5, 4, 2]);
        assert_eq!(seqs(&serde_json::from_value::<Instrument>(serde_json::to_value(again.checkpoint_view()).unwrap()).unwrap()
            .session_large_orders(&cal, None, 0, 1440, 100, None).0), vec![5, 4, 2], "and it round-trips through the checkpoint file");
    }

    #[test]
    fn never_stored_large_prints_are_each_listed_by_their_own_identity() {
        // A never-stored print (the live lane) has durable sequence 0: listing by sequence alone kept one of them.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = opened(&cal, &r);
        let reused_id = |mut e: MarketEvent| {
            if let Payload::Trade { trade_id, .. } = &mut e.payload {
                *trade_id = "A1".into();
            }
            e
        };
        let first = reused_id(trade_at(0, 570, 1, 1_000_000, 300, 1));
        let second = reused_id(trade_at(0, 571, 5, 1_000_000, 200, -1));
        inst.apply(&cal, &r, &first);
        inst.apply(&cal, &r, &second);
        let rows = inst.session_large_orders(&cal, None, 0, 1440, 100, None).0;
        assert_eq!(rows.len(), 2, "two prints, the same reused source id, both listed: {rows:?}");
        assert_eq!(rows[0]["time"], json!("09:31:05"), "newest first by exchange time");
    }

    #[test]
    fn a_print_at_the_threshold_is_large_and_an_attack_accumulates_into_large() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = opened(&cal, &r);
        // Single print: 499 lots against a 100-lot rule is large by volume; 99 is small.
        inst.apply(&cal, &r, &book_at(1, 570, 0, (999_000, 2000), (1_000_000, 2000)));
        inst.apply(&cal, &r, &trade_at(2, 570, 1, 1_000_000, 499, 1));
        inst.apply(&cal, &r, &trade_at(3, 570, 5, 1_000_000, 99, -1));
        let ticks = &inst.minutes[&570].ticks;
        assert_eq!((ticks[0].large, ticks[0].large_reason), (Some(true), LARGE_BY_VOLUME));
        assert_eq!(ticks[1].large, Some(false));

        // An attack: buys of 80 lots every 300 ms into a 1000-lot ask. None is large alone, but the attack is one
        // order: once it qualifies (its total reaches 100 lots at the 2nd print, 30% impact at the 4th) EVERY print
        // of it is large -- the first one included, retroactively.
        let mut inst = opened(&cal, &r);
        inst.apply(&cal, &r, &book_at(1, 600, 0, (999_000, 50), (1_000_000, 1000)));
        for (i, seq) in (2..=6).enumerate() {
            inst.apply(&cal, &r, &with_ms(trade_at(seq, 600, 1, 1_000_000, 80, 1), i as i64 * 300));
        }
        let t = inst.minutes[&600].ticks.clone();
        assert!(t.iter().all(|x| x.episode == t[0].episode && x.episode > 0), "one episode");
        let now = inst.minutes[&600].ticks.clone();
        assert_eq!(now.iter().map(|x| x.large).collect::<Vec<_>>(), vec![Some(true); 5], "one attack, one classification");
        assert_ne!(now[1].large_reason & LARGE_BY_EPISODE, 0, "the 2nd print brought the attack to 160 >= 100 lots");
        assert_ne!(now[3].large_reason & LARGE_BY_IMPACT, 0, "the 4th consumed 320 of 1000 (>= 30%)");
        assert_ne!(now[0].large_reason & LARGE_BY_EPISODE, 0, "the 1st is re-marked when the attack qualifies");

        // Out-of-order arrival (the 5th print stamped between the 1st and 2nd): still the
        // same attack, still large.
        let mut late = opened(&cal, &r);
        late.apply(&cal, &r, &book_at(1, 600, 0, (999_000, 50), (1_000_000, 1000)));
        for (seq, ms) in [(2, 0), (3, 300), (4, 600), (5, 900), (6, 120)] {
            late.apply(&cal, &r, &with_ms(trade_at(seq, 600, 1, 1_000_000, 80, 1), ms));
        }
        let lt = &late.minutes[&600].ticks;
        assert!(lt.iter().all(|x| x.episode == lt[0].episode), "an out-of-order print stays in its attack");
        assert!(lt.iter().all(|x| x.large == Some(true)), "all five 80-lot prints of the attack are large");

        // A pause longer than the gap starts a new episode: the next 80 lots are small again.
        inst.apply(&cal, &r, &with_ms(trade_at(7, 600, 4, 1_000_000, 80, 1), 0));
        let last = inst.minutes[&600].ticks.last().unwrap().clone();
        assert_eq!(last.large, Some(false));
        assert_ne!(last.episode, t[0].episode);

        // The flow panel lists the large prints by durable sequence, newest first, with their reason.
        let (flow, _, _) = inst.flow_wire(&cal, &r, ts(601, 0), None, None, None);
        let listed: Vec<u64> = flow["largeOrders"].as_array().unwrap().iter().map(|x| x["durable_sequence"].as_u64().unwrap()).collect();
        assert_eq!(listed, vec![6, 5, 4, 3, 2]);
        assert_eq!(flow["largeOrders"][0]["large_reason"], "EPISODE+IMPACT");
        assert_eq!(flow["cumulative"]["large"]["buy"], 400, "the flow totals follow the per-attack classification");
        assert_eq!(flow["cumulative"]["small"]["buy"], 80, "the lone 80-lot print after the pause stays small");
    }

    #[test]
    fn every_minute_of_the_flow_series_carries_the_running_total_through_it() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        for e in [trade_at(1, 600, 1, 1_000_000, 150, 1), trade_at(2, 601, 1, 1_000_000, 30, -1), trade_at(3, 601, 2, 1_000_000, 10, 1),
                  trade_at(4, 603, 1, 1_000_000, 200, -1)] {
            inst.apply(&cal, &r, &e);
        }
        let (flow, _, _) = inst.flow_wire(&cal, &r, ts(604, 0), None, None, None);
        let rows = flow["minuteSeries"].as_array().unwrap();
        let net = |row: &Value, size: &str| (row["cumulative"][size]["net"].as_f64().unwrap(), row[size]["net"].as_f64().unwrap());
        assert_eq!(rows.iter().map(|x| x["minute"].as_i64().unwrap()).collect::<Vec<_>>(), vec![600, 601, 603]);
        assert_eq!(rows.iter().map(|x| net(x, "large")).collect::<Vec<_>>(), vec![(150.0, 150.0), (150.0, 0.0), (-50.0, -200.0)]);
        assert_eq!(rows.iter().map(|x| net(x, "small")).collect::<Vec<_>>(), vec![(0.0, 0.0), (-20.0, -20.0), (-20.0, 0.0)]);
        assert_eq!(rows[1]["cumulative"]["small"], json!({"buy": 10, "sell": 30, "net": -20}));
        assert_eq!(rows.last().unwrap()["cumulative"], flow["cumulative"], "the last minute's running total is the panel's 累計");
    }

    #[test]
    fn the_flow_s_hour_buckets_follow_the_session_from_its_open_to_its_close() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        for e in [trade_at(1, 540, 1, 1_000_000, 150, 1), trade_at(2, 559, 1, 1_000_000, 50, -1), trade_at(3, 601, 1, 1_000_000, 200, -1),
                  trade_at(4, 790, 1, 1_000_000, 100, 1)] {
            inst.apply(&cal, &r, &e);
        }
        let (flow, _, _) = inst.flow_wire(&cal, &r, ts(800, 0), None, None, None);
        let buckets = flow["hourSeries"].as_array().unwrap();
        let shape: Vec<(&str, i64, i64, bool, bool)> = buckets.iter().map(|b| (b["key"].as_str().unwrap(), b["from_minute"].as_i64().unwrap(),
            b["to_minute"].as_i64().unwrap(), b["opens_session"].as_bool().unwrap(), b["closes_session"].as_bool().unwrap())).collect();
        assert_eq!(shape, vec![("all", 540, 810, true, true), ("m540", 540, 599, true, false), ("m600", 600, 659, false, false),
                               ("m780", 780, 810, false, true)], "the hours that traded, the first from 09:00 and the last to 13:30");
        assert_eq!(buckets[1]["large"], json!({"buy": 150, "sell": 0}));
        assert_eq!((buckets[1]["total"].as_f64(), buckets[1]["buy_ratio"].as_f64()), (Some(200.0), Some(0.75)), "of the bucket's own volume");
        assert_eq!((buckets[0]["total"].as_f64(), buckets[0]["sell_ratio"].as_f64()), (Some(500.0), Some(0.4)));
    }

    #[test]
    fn the_flow_names_its_session_s_open_and_close_minutes() {
        // The 進出 chart's frame is B's session calendar: a stock's day, also before it opens.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        let (before, _, _) = inst.flow_wire(&cal, &r, ts(480, 0), None, None, None);
        assert_eq!((before["availability"].as_str(), before["session"].as_str()), (Some("BEFORE_SESSION"), Some("DAY")));
        assert_eq!((before["session_open_minute"].as_i64(), before["session_close_minute"].as_i64()), (Some(540), Some(810)));
        inst.apply(&cal, &r, &trade_at(1, 600, 1, 1_000_000, 10, 1));
        let (flow, _, _) = inst.flow_wire(&cal, &r, ts(601, 0), None, None, None);
        assert_eq!((flow["session_open_minute"].as_i64(), flow["session_close_minute"].as_i64()), (Some(540), Some(810)));

        // A futures night is one partition from 15:00 to 05:00 the next morning (minutes past 1440).
        let night_id = InstrumentId { source: "shioaji".into(), market: "FUT".into(), code: "TXFR1".into(),
            trading_date: "2026-09-29".into(), session: "NIGHT".into() };
        let mut night = Instrument::new(night_id);
        let mut e = trade_at(1, 1470, 0, 200_000_000, 3.0, 1);
        (e.market, e.code, e.symbol, e.session) = ("FUT".into(), "TXFR1".into(), "shioaji:FUT:TXFR1".into(), "NIGHT".into());
        night.apply(&cal, &r, &e);
        let (flow, _, _) = night.flow_wire(&cal, &r, ts(31, 0) + 86_400_000_000_000, None, None, None);
        assert_eq!(flow["session"], "NIGHT");
        assert_eq!((flow["session_open_minute"].as_i64(), flow["session_close_minute"].as_i64()), (Some(900), Some(1740)));

        // A session continuing from the previous partition opens there: before this partition's 0, on the axis the
        // series' minutes are on (the previous part at minute - 1440).
        let us = |date: &str| InstrumentId { trading_date: date.into(), ..futu_us() };
        let mut previous = Instrument::new(us("2026-09-29"));
        previous.apply(&cal, &r, &as_futu(trade_at(1, 1300, 0, 108_550, 5.0, 1)));
        let mut overnight = Instrument::new(us("2026-09-30"));
        let mut e = as_futu(trade_at(2, 30, 0, 108_560, 7.0, -1));
        e.trading_date = "2026-09-30".into();
        overnight.apply(&cal, &r, &e);
        // 01:00 New York on 09-30 is 13:00 in Taipei.
        let (flow, _, _) = overnight.flow_wire(&cal, &r, ts(13 * 60, 0) + 86_400_000_000_000, Some(&previous), None, None);
        assert_eq!(flow["session"], "OVERNIGHT");
        assert_eq!((flow["session_open_minute"].as_i64(), flow["session_close_minute"].as_i64()), (Some(-240), Some(239)));
        let rows: Vec<(i64, &str)> = flow["minuteSeries"].as_array().unwrap().iter()
            .map(|x| (x["minute"].as_i64().unwrap(), x["time"].as_str().unwrap())).collect();
        assert_eq!(rows, vec![(-140, "21:40"), (30, "00:30")]);
    }

    /// `rules()` with a 1-lot rule for TW futures, so every futures print is large.
    pub fn rules_with_fut() -> RuleSet {
        let mut r = rules();
        let base = r.flow[0].clone();
        r.flow.push(FlowRule { rule_id: "fut-1".into(), matcher: Match { source: Some("shioaji".into()), market: Some("FUT".into()), code: None },
            threshold: 1.0, impact_ratio: None, episode_gap_ms: None, ..base });
        r
    }

    /// Futu has no large-order rule (RuleSet::flow_rule): a test of the session axis marks a print large itself.
    pub fn mark_large(inst: &mut Instrument, minute: i32) {
        let m = Arc::make_mut(inst.minutes.get_mut(&minute).unwrap());
        let mut newest = Vec::new();
        for t in &mut m.ticks {
            t.large = Some(true);
            newest.push(t.list_key());
        }
        for (seq, ts) in newest {
            m.note_large(seq, ts);
        }
    }

    #[test]
    fn the_newest_large_orders_are_found_from_the_minutes_that_can_hold_them() {
        // Sequence 9 arrived last but belongs to 09:01 (a gap filled afterwards): it is the newest, listed first, and
        // read without reading every print of the session.
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        for (seq, minute) in [(1, 541), (2, 542), (3, 543), (4, 544), (9, 541)] {
            inst.apply(&cal, &r, &trade_at(seq, minute, 1, 1_000_000, 1, 1));
        }
        for m in 541..=544 {
            mark_large(&mut inst, m);
        }
        let seqs = |limit: usize| {
            let (rows, more) = inst.session_large_orders(&cal, None, 540, 600, limit, None);
            (rows.iter().map(|r| r["durable_sequence"].as_u64().unwrap()).collect::<Vec<_>>(), more)
        };
        assert_eq!(seqs(3), (vec![9, 4, 3], true));
        assert_eq!(seqs(10), (vec![9, 4, 3, 2, 1], false));
        let (sells, _) = inst.session_large_orders(&cal, None, 540, 600, 10, Some(1));
        assert_eq!(sells.len(), 5, "one side still reads every large print of the range");
    }

    #[test]
    fn large_orders_carry_the_session_minute_their_buckets_are_on() {
        // A large print's `minute` is on the axis of hourSeries / minuteSeries: past 1440 on a futures night, before 0
        // in the previous partition's part of a continuing session; a bucket's query by those minutes lists it.
        let cal = Calendar::default();
        let r = rules_with_fut();
        let night_id = InstrumentId { source: "shioaji".into(), market: "FUT".into(), code: "TXFR1".into(),
            trading_date: "2026-09-29".into(), session: "NIGHT".into() };
        let mut night = Instrument::new(night_id);
        for (seq, minute) in [(1, 910), (2, 1470)] {
            let mut e = trade_at(seq, minute, 5, 200_000_000, 3.0, 1);
            (e.market, e.code, e.symbol, e.session) = ("FUT".into(), "TXFR1".into(), "shioaji:FUT:TXFR1".into(), "NIGHT".into());
            night.apply(&cal, &r, &e);
        }
        let (flow, _, _) = night.flow_wire(&cal, &r, ts(31, 0) + 86_400_000_000_000, None, None, None);
        let rows: Vec<(u64, i64, &str)> = flow["largeOrders"].as_array().unwrap().iter()
            .map(|x| (x["durable_sequence"].as_u64().unwrap(), x["minute"].as_i64().unwrap(), x["time"].as_str().unwrap())).collect();
        assert_eq!(rows, vec![(2, 1470, "00:30:05"), (1, 910, "15:10:05")], "past midnight the minute continues, the clock wraps");
        let keys: Vec<(&str, i64, i64)> = flow["hourSeries"].as_array().unwrap().iter()
            .map(|b| (b["key"].as_str().unwrap(), b["from_minute"].as_i64().unwrap(), b["to_minute"].as_i64().unwrap())).collect();
        assert_eq!(keys, vec![("all", 900, 1740), ("m900", 900, 959), ("m1440", 1440, 1499)]);
        let seqs = |rows: &[Value]| rows.iter().map(|x| x["durable_sequence"].as_u64().unwrap()).collect::<Vec<_>>();
        assert_eq!(seqs(&night.session_large_orders(&cal, None, 1440, 1499, 100, None).0), vec![2], "the 00:00 bucket's print");
        assert_eq!(seqs(&night.session_large_orders(&cal, None, 900, 1740, 100, None).0), vec![2, 1]);

        // Futu US overnight: 20:00-23:59 of 09-29 continue into 00:00-03:59 of 09-30.
        let us = |date: &str| InstrumentId { trading_date: date.into(), ..futu_us() };
        let mut previous = Instrument::new(us("2026-09-29"));
        previous.apply(&cal, &r, &as_futu(trade_at(1, 1300, 0, 108_550, 5.0, 1)));
        let mut overnight = Instrument::new(us("2026-09-30"));
        let mut e = as_futu(trade_at(2, 30, 0, 108_560, 7.0, -1));
        e.trading_date = "2026-09-30".into();
        overnight.apply(&cal, &r, &e);
        mark_large(&mut previous, 1300);
        mark_large(&mut overnight, 30);
        let (flow, _, _) = overnight.flow_wire(&cal, &r, ts(13 * 60, 0) + 86_400_000_000_000, Some(&previous), None, None);
        let rows: Vec<(u64, i64)> = flow["largeOrders"].as_array().unwrap().iter()
            .map(|x| (x["durable_sequence"].as_u64().unwrap(), x["minute"].as_i64().unwrap())).collect();
        assert_eq!(rows, vec![(2, 30), (1, -140)], "the previous partition's print is before 0");
        let keys: Vec<(&str, i64, i64)> = flow["hourSeries"].as_array().unwrap().iter()
            .map(|b| (b["key"].as_str().unwrap(), b["from_minute"].as_i64().unwrap(), b["to_minute"].as_i64().unwrap())).collect();
        assert_eq!(keys, vec![("all", -240, 239), ("m-180", -180, -121), ("m0", 0, 59)], "buckets on the series' axis");
        assert_eq!(seqs(&overnight.session_large_orders(&cal, Some(&previous), -180, -121, 100, None).0), vec![1]);
        assert_eq!(seqs(&overnight.session_large_orders(&cal, Some(&previous), 0, 59, 100, None).0), vec![2]);
        let (all, truncated) = overnight.session_large_orders(&cal, Some(&previous), -240, 239, 1, None);
        assert_eq!((seqs(&all), truncated), (vec![2], true), "newest first across both parts, a cut list says so");
        assert_eq!(seqs(&overnight.session_large_orders(&cal, Some(&previous), -240, 239, 1, Some(1)).0), vec![1], "side before the limit");
    }

    #[test]
    fn a_retreating_best_price_ends_the_attack() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &book_at(1, 600, 0, (999_000, 50), (1_000_000, 1000)));
        inst.apply(&cal, &r, &trade_at(2, 600, 1, 1_000_000, 90, 1));
        // The ask falls back to a lower price: a buyer's attack did not continue upward, so this is a new episode.
        inst.apply(&cal, &r, &with_ms(book_at(3, 600, 1, (998_000, 50), (999_500, 1000)), 100));
        inst.apply(&cal, &r, &with_ms(trade_at(4, 600, 1, 999_500, 90, 1), 200));
        let t = &inst.minutes[&600].ticks;
        assert_ne!(t[0].episode, t[1].episode);
        assert_eq!(t[1].large, Some(false), "90 of a fresh 1000-lot queue is 9%, below 30% (the old episode's 90 does not carry over)");
    }

    #[test]
    fn window_at_100759_starts_at_whole_minute_minus_n_and_includes_the_current_minute() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        let mut seq = 0;
        // prints every minute 09:00..10:07 at price = 1000 + minute offset; one exactly at 10:04:00.000
        for minute in 540..=607 {
            seq += 1;
            inst.apply(&cal, &r, &trade_at(seq, minute, 30, 1_000_000 + (minute as i64 - 540) * 100, 1, 1));
        }
        seq += 1;
        inst.apply(&cal, &r, &trade_at(seq, 604, 0, 2_000_000, 7, 1)); // exactly at the 10:04 start
        inst.advance(&cal, 607, seq);
        let t = ts(607, 59); // 10:07:59
        let w = inst.windows_wire(&cal, &r, t, None);
        let w3 = &w["windows"]["3"];
        assert_eq!(w3["base_minute"], 603, "base = last valid print before 10:04:00, i.e. the 10:03 close");
        assert_eq!(w3["base_price"], money(1_000_000 + 63 * 100));
        assert_eq!(w3["close"], money(1_000_000 + 67 * 100));
        assert_eq!(w3["volume"], 1 + 7 + 1 + 1 + 1, "10:04 (two prints incl. the one AT the start), 10:05, 10:06, 10:07");
        // at 10:08:00 the start moves to 10:05: 10:04's close becomes the base
        let w = inst.windows_wire(&cal, &r, ts(608, 0), None);
        assert_eq!(w["windows"]["3"]["base_minute"], 604);
    }

    #[test]
    fn no_trade_minutes_continue_the_previous_price_and_unobserved_minutes_stay_missing() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 545, 10, 1_010_000, 3, 1)); // first seen at 09:05
        inst.advance(&cal, 550, 1); // clock reached 09:10
        let q = |m: i32| inst.minutes[&m].quality;
        assert_eq!(q(544), Quality::Missing, "before this instrument was observed");
        assert_eq!(q(545), Quality::Traded);
        assert_eq!(q(546), Quality::NoTradeSynthetic);
        assert_eq!(inst.minutes[&546].close, Some(1_010_000));
        assert_eq!(inst.minutes[&546].volume, Some(0.0));
        assert_eq!(inst.minutes[&544].volume, None, "unknown volume is never zero");
        assert!(inst.minutes[&549].finalized);
        assert!(!inst.minutes.contains_key(&550), "the clock minute itself is not closed yet");
    }

    #[test]
    fn a_late_print_revises_a_finalized_minute_and_its_windows() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 600, 10, 1_000_000, 1, 1));
        inst.advance(&cal, 601, 1);
        assert!(inst.minutes[&600].finalized);
        let rev = inst.minutes[&600].revision;
        inst.projection.dirty = Dirty::default();
        inst.apply(&cal, &r, &trade_at(2, 600, 50, 1_050_000, 4, -1));
        let m = &inst.minutes[&600];
        assert_eq!(m.revision, rev + 1);
        assert!(m.revised_after_final);
        assert_eq!(m.close, Some(1_050_000));
        assert_eq!(m.volume, Some(5.0));
        assert!(inst.projection.dirty.minutes.contains(&600) && inst.projection.dirty.windows);
    }

    #[test]
    fn a_source_bar_replaces_itself_and_ticks_outrank_it_and_backfill_stops_at_the_cutoff() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        let bar = |seq: u64, minute: i32, close: i64, volume: i64, backfill: Option<i64>| {
            let mut e = trade_at(seq, minute, 59, close, 1, 0);
            e.payload = Payload::MinuteBar { minute, open: close, high: close, low: close, close, average: 0, volume: volume as f64, amount: 0.0 };
            if let Some(cut) = backfill {
                e.flags.backfill = true;
                e.flags.backfill_cutoff_ns = Some(cut);
            }
            e
        };
        inst.apply(&cal, &r, &bar(1, 600, 1_000_000, 10, None));
        inst.apply(&cal, &r, &bar(2, 600, 1_001_000, 25, None)); // cumulative re-push of the same minute
        assert_eq!(inst.minutes[&600].volume, Some(25.0), "replaced, not 10 + 25");
        inst.apply(&cal, &r, &trade_at(3, 600, 30, 1_002_000, 3, 1));
        assert_eq!(inst.minutes[&600].volume, Some(3.0), "prints are the stronger authority");
        let cutoff = ts(590, 0);
        inst.apply(&cal, &r, &bar(4, 580, 990_000, 40, Some(cutoff)));
        inst.apply(&cal, &r, &bar(5, 595, 990_000, 40, Some(cutoff)));
        assert_eq!(inst.minutes[&580].authority, Authority::BackfillBar);
        assert!(!inst.minutes.contains_key(&595), "a backfill bar at/after the cut-off is refused");
    }

    #[test]
    fn the_print_cap_folds_earlier_minutes_instead_of_freezing_the_instrument() {
        // Past the cap every print returned before updating OHLC/volume/flow.
        TICK_CAP.with(|c| c.set(4));
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        let mut seq = 0;
        for minute in [600, 601] {
            for price in [1_000_000, 1_001_000, 999_000] {
                seq += 1;
                inst.apply(&cal, &r, &trade_at(seq, minute, seq as i32, price, 2, 1));
            }
        }
        seq += 1;
        inst.apply(&cal, &r, &trade_at(seq, 602, 1, 1_005_000, 4, 1));
        let m = &inst.minutes[&600];
        assert_eq!((m.open, m.high, m.low, m.close, m.volume), (Some(1_000_000), Some(1_001_000), Some(999_000), Some(999_000), Some(6.0)));
        assert_eq!(inst.minutes[&601].volume, Some(6.0), "a folded minute keeps its aggregate");
        let m = &inst.minutes[&602];
        assert_eq!((m.close, m.volume), (Some(1_005_000), Some(4.0)), "the newest print is applied, not dropped");
        assert!(inst.ticks_kept <= 4);
        assert!(inst.quality.ticks_dropped > 0);
    }

    #[test]
    fn minutes_a_durable_gap_may_have_lost_never_read_complete() {
        // Events missing from the WAL left the held minutes looking Traded / no-trade.
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 600, 1, 1_000_000, 2, 1));
        assert_eq!(inst.minutes[&600].quality, Quality::Traded);
        inst.mark_durable_gap();
        assert_eq!(inst.quality.durable_gaps, 1);
        assert_eq!(inst.minutes[&600].quality, Quality::Partial, "the newest held minute may continue in the hole");

        inst.apply(&cal, &r, &trade_at(9, 603, 5, 1_001_000, 3, 1));
        assert_eq!(inst.minutes[&603].quality, Quality::Partial, "the next event's minute may have started in the hole");
        for m in [601, 602] {
            assert!(inst.minutes[&m].source_gap, "minute {m} lies in the hole");
        }
        inst.advance(&cal, 605, 10);
        for m in [601, 602] {
            assert_eq!(inst.minutes[&m].quality, Quality::Missing, "minute {m}: lost events may have been trades, not 'no trade'");
            assert_eq!(inst.minutes[&m].close, None);
        }
        inst.apply(&cal, &r, &trade_at(11, 605, 1, 1_002_000, 1, 1));
        assert_eq!(inst.minutes[&605].quality, Quality::Traded, "after the next event the stream is whole again");
        assert!(inst.cover.durable_gap_from.is_none());
    }

    #[test]
    fn a_lost_first_event_marks_the_session_from_its_open() {
        // The instrument did not exist yet when its first event could not be decoded, so nothing was
        // marked and its first data read as complete.
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        inst.mark_durable_gap();
        assert_eq!(inst.cover.durable_gap_from, Some(GAP_FROM_OPEN));
        inst.apply(&cal, &r, &trade_at(2, 545, 1, 1_000_000, 2, 1));
        for m in 540..545 {
            assert!(inst.minutes[&m].source_gap, "minute {m} lies between the open and the first readable event");
        }
        assert!(inst.cover.durable_gap_from.is_none());
    }

    #[test]
    fn a_minute_the_producer_dropped_events_in_is_partial() {
        // Lost prints left the minute looking complete (Traded).
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 600, 1, 1_000_000, 2, 1));
        assert_eq!(inst.minutes[&600].quality, Quality::Traded);
        let mut after_drop = trade_at(2, 600, 30, 1_001_000, 3, 1);
        after_drop.flags.gap_before = 4;
        inst.apply(&cal, &r, &after_drop);
        assert_eq!(inst.quality.source_gaps, 4);
        assert_eq!(inst.minutes[&600].quality, Quality::Partial);
        inst.apply(&cal, &r, &trade_at(3, 601, 1, 1_002_000, 1, 1));
        assert_eq!(inst.minutes[&601].quality, Quality::Traded, "only the gapped minute is marked");
    }

    #[test]
    fn a_source_bar_without_ohlc_reports_its_close_not_zero() {
        // Futu RT_DATA carries close/volume only.
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        let mut e = trade_at(1, 600, 59, 0, 0, 0);
        e.payload = Payload::MinuteBar { minute: 600, open: 0, high: 0, low: 0, close: 1_001_000, average: 0, volume: 9.0, amount: 0.0 };
        inst.apply(&cal, &r, &e);
        let m = &inst.minutes[&600];
        assert_eq!((m.open, m.high, m.low, m.close), (Some(1_001_000), Some(1_001_000), Some(1_001_000), Some(1_001_000)));
        assert_eq!(m.quality, Quality::Partial);
    }

    #[test]
    fn a_cumulative_quote_stream_gives_minute_volume_by_difference() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(InstrumentId { market: "IDX".into(), code: "TAIEX".into(), ..id() });
        let quote = |seq: u64, minute: i32, sec: i32, current: i64, total: i64| {
            let mut e = trade_at(seq, minute, sec, current, 1, 0);
            e.market = "IDX".into();
            e.code = "TAIEX".into();
            e.payload = Payload::Quote { current, open: 0, high: 0, low: 0, total_volume: total as f64, total_amount: 0.0,
                status: "live".into(), minute, average: 0, volume: 0.0, amount: 0.0, advance_count: None, decline_count: None,
                flat_count: None, limit_up_count: None, limit_down_count: None };
            e
        };
        inst.apply(&cal, &r, &quote(1, 600, 5, 201_000_000, 1000));
        inst.apply(&cal, &r, &quote(2, 600, 50, 201_500_000, 1300));
        inst.apply(&cal, &r, &quote(3, 601, 5, 201_200_000, 1450));
        assert_eq!(inst.minutes[&600].volume, None, "the first minute has no earlier total to difference against");
        assert_eq!(inst.minutes[&601].volume, Some(150.0));
        assert_eq!(inst.minutes[&600].high, Some(201_500_000));
    }

    /// decisions.md「歷史回放的加權疊圖」: the index's day ends at its published closing index, stamped 13:33 -- the
    /// same quote the next day's 昨收 is -- which closes the 13:30 bar; later quotes have no bar.
    #[test]
    fn the_published_closing_index_closes_the_last_minute() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(InstrumentId { market: "IDX".into(), code: "TAIEX".into(), ..id() });
        let quote = |seq: u64, minute: i32, sec: i32, current: i64| {
            let mut e = trade_at(seq, minute, sec, current, 1, 0);
            e.market = "IDX".into();
            e.code = "TAIEX".into();
            e.payload = Payload::Quote { current, open: 0, high: 0, low: 0, total_volume: 0.0, total_amount: 0.0,
                status: "live".into(), minute, average: 0, volume: 0.0, amount: 0.0, advance_count: None, decline_count: None,
                flat_count: None, limit_up_count: None, limit_down_count: None };
            e
        };
        inst.apply(&cal, &r, &quote(1, 810, 5, 201_000_000));
        inst.apply(&cal, &r, &quote(2, 813, 0, 201_300_000));
        inst.apply(&cal, &r, &quote(3, 830, 0, 209_000_000));
        let m = &inst.minutes[&810];
        assert_eq!((m.open, m.high, m.close), (Some(201_000_000), Some(201_300_000), Some(201_300_000)));
        assert!(!inst.minutes.contains_key(&813) && !inst.minutes.contains_key(&830));
        assert_eq!(inst.price.last_price.map(|p| (p.0, p.2)), Some((201_300_000, 810)));
        assert_eq!(inst.quality.outside_session, 1, "13:50 is no publication of the session");
        assert_eq!(cal.bar_minute(inst.id.cal_key(), 813), Some(810));
        let stk = Instrument::new(id());
        assert_eq!(cal.bar_minute(stk.id.cal_key(), 870), None, "14:30 盤後定價 is a match of its own");
    }

    /// A restart's index fill: the gap's quotes (flags.backfill) arrive after the live quotes that ended it, the gap's
    /// last minute holding both. Its open and close are the earliest and newest by exchange time, not by arrival.
    #[test]
    fn a_backfill_quote_arriving_late_is_its_minutes_close_only_by_exchange_time() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(InstrumentId { market: "IDX".into(), code: "TAIEX".into(), ..id() });
        let quote = |seq: u64, minute: i32, sec: i32, current: i64, backfill: bool| {
            let mut e = trade_at(seq, minute, sec, current, 1, 0);
            e.market = "IDX".into();
            e.code = "TAIEX".into();
            e.flags.backfill = backfill;
            e.flags.backfill_cutoff_ns = backfill.then(|| ts(600, 30));
            e.payload = Payload::Quote { current, open: 0, high: 0, low: 0, total_volume: 0.0, total_amount: 0.0,
                status: "live".into(), minute, average: 0, volume: 0.0, amount: 0.0, advance_count: None, decline_count: None,
                flat_count: None, limit_up_count: None, limit_down_count: None };
            e
        };
        inst.apply(&cal, &r, &quote(1, 600, 30, 201_000_000, false));
        inst.apply(&cal, &r, &quote(2, 600, 55, 201_500_000, false));
        inst.apply(&cal, &r, &quote(3, 599, 50, 200_000_000, true));
        inst.apply(&cal, &r, &quote(4, 600, 5, 200_800_000, true));
        inst.apply(&cal, &r, &quote(5, 600, 25, 200_900_000, true));
        let m = &inst.minutes[&600];
        assert_eq!((m.open, m.close), (Some(200_800_000), Some(201_500_000)), "open = 10:00:05 (filled), close = 10:00:55 (live)");
        assert_eq!((m.high, m.low), (Some(201_500_000), Some(200_800_000)));
        assert_eq!(inst.minutes[&599].close, Some(200_000_000), "the gap's earlier minute is observed");
    }

    #[test]
    fn windows_never_bridge_sessions_and_warm_up_at_the_open() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &reference_at(0, 1_000_000));
        inst.apply(&cal, &r, &trade_at(1, 540, 5, 1_010_000, 1, 1));
        inst.apply(&cal, &r, &trade_at(2, 541, 5, 1_020_000, 1, 1));
        let w = inst.windows_wire(&cal, &r, ts(541, 30), None);
        assert_eq!(w["windows"]["5"]["completeness"], "WARMUP");
        assert_eq!(w["windows"]["5"]["base_source"], "reference", "no print before the start in this session");
        assert_eq!(w["windows"]["1"]["completeness"], "COMPLETE", "a window starting exactly at the open is not warm-up");
        assert_eq!(w["windows"]["1"]["base_source"], "reference", "the 09:00 print is inside the window, not its base");
        // after the close the windows freeze at 13:30
        let w = inst.windows_wire(&cal, &r, ts(840, 0), None);
        assert_eq!(w["session_closed"], true);
        assert_eq!(w["evaluation_minute"], 810);
    }

    #[test]
    fn a_gap_before_the_window_start_is_not_a_reliable_base() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 600, 5, 1_000_000, 1, 1));
        // The subscription is lost at 10:02 (a coverage record, applied by Engine::apply_coverage).
        inst.close_coverage(602);
        inst.advance(&cal, 606, 2);
        inst.apply(&cal, &r, &trade_at(3, 606, 10, 1_010_000, 1, 1));
        let w = inst.windows_wire(&cal, &r, ts(606, 20), None);
        assert_eq!(inst.minutes[&604].quality, Quality::Missing);
        assert_eq!(w["windows"]["1"]["base_source"], "GAP");
        assert!(w["windows"]["1"]["change"].is_null());
        assert_eq!(w["windows"]["1"]["completeness"], "PARTIAL", "10:05 inside the window was not observed");
        assert_eq!(w["windows"]["5"]["completeness"], "PARTIAL");
    }

    #[test]
    fn a_minute_of_odd_lots_alone_opens_no_bar() {
        // decisions.md「有成交的分鐘」: the 1mK/3mK/5mK open and the fixed K skip a minute of odd lots alone, as the
        // 1-minute K and the session's open/high/low do -- it carries 100 on and traded no price.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 540, 5, 1_000_000, 2, 1));
        inst.apply(&cal, &r, &no_last_sale_at(2, 543, 5, 1_300_000, 1, 1));
        inst.apply(&cal, &r, &trade_at(3, 544, 5, 1_020_000, 4, 1));
        inst.advance(&cal, 544, 3);
        assert!(!inst.minutes[&543].traded() && inst.minutes[&544].traded());
        let w = inst.windows_wire(&cal, &r, ts(544, 30), None);
        assert_eq!(w["k"]["3"]["frame_start_minute"], 543);
        assert_eq!(w["k"]["3"]["open"], 102.0, "09:03 traded nothing: the bar opens at 09:04's print, not the carried 100");
        assert_eq!(w["k"]["3"]["change_pct"], 0.0);
        let day = inst.day_wire(&cal, &r, ts(544, 30), None, None).0;
        let bar = day["fixed_k"]["k3"].as_array().unwrap().iter().find(|b| b["start_minute"] == 543).unwrap().clone();
        assert_eq!((bar["open"].clone(), bar["low"].clone(), bar["volume"].clone()), (json!(102.0), json!(102.0), json!(5)),
                   "the odd lot's volume stays in its bar");
    }

    #[test]
    fn row_k_is_the_price_against_the_open_of_the_session_aligned_bar_and_volume_compares_the_completed_minute() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_at(1, 540, 5, 1_000_000, 2, 1));
        inst.apply(&cal, &r, &trade_at(2, 542, 5, 1_010_000, 3, 1));
        inst.apply(&cal, &r, &trade_at(3, 543, 5, 1_020_000, 4, 1));
        inst.apply(&cal, &r, &trade_at(4, 544, 5, 990_000, 5, -1));
        let w = inst.windows_wire(&cal, &r, ts(544, 30), None);
        assert_eq!(w["k"]["1"]["change_pct"], 0.0, "09:04's bar opened at the current price");
        assert_eq!(w["k"]["3"]["frame_start_minute"], 543, "3-minute bars from 09:00: 09:03-09:05");
        let k3 = w["k"]["3"]["change_pct"].as_f64().unwrap();
        assert!((k3 - (99.0 - 102.0) / 102.0 * 100.0).abs() < 1e-9);
        assert_eq!(w["k"]["5"]["change_pct"], -1.0, "09:00-09:04 opened at 100");

        let mut day = crate::baseline::Day { date: "2026-09-26".into(), ..Default::default() };
        day.items.insert("2330".into(), [(543, 2.0)].into_iter().collect());
        let day = crate::baseline::Lookup::Ready(std::sync::Arc::new(day));
        let v = inst.volume_compare_wire(&cal, ts(544, 30), Some(&day)).unwrap();
        assert_eq!(v["minute"], 543, "09:04 is still forming: compare 09:03");
        assert_eq!(v["baseline_minute"], "09:03");
        assert_eq!((v["volume"].clone(), v["baseline_volume"].clone(), v["change_pct"].clone()), (json!(4), json!(2), json!(100.0)));
        assert_eq!(v["baseline_date"], "2026-09-26");
        let none = inst.volume_compare_wire(&cal, ts(545, 10), Some(&day)).unwrap();
        assert_eq!(none["minute"], 544);
        assert!(none["change_pct"].is_null(), "no baseline for 09:04: the minute is named, the percent cleared");
        assert!(inst.volume_compare_wire(&cal, ts(544, 30), None).unwrap()["change_pct"].is_null());
        // Not written yet and unreadable read differently, both without a figure.
        let not_yet = inst.volume_compare_wire(&cal, ts(544, 30), Some(&crate::baseline::Lookup::NotYet)).unwrap();
        assert_eq!((not_yet["baseline_state"].as_str(), not_yet["change_pct"].is_null()), (Some("NOT_YET"), true));
        let corrupt = inst.volume_compare_wire(&cal, ts(544, 30), Some(&crate::baseline::Lookup::Corrupt("bad".into()))).unwrap();
        assert_eq!((corrupt["baseline_state"].as_str(), corrupt["baseline_reason"].as_str()), (Some("CORRUPT"), Some("bad")));
    }

    /// 量變 of a minute without a known volume says nothing; a covered minute without a trade is a real 0.
    #[test]
    fn volume_compare_is_null_for_an_unknown_minute_and_real_for_a_no_trade_minute() {
        let cal = Calendar::default();
        let r = rules();
        let mut day = crate::baseline::Day { date: "2026-09-26".into(), ..Default::default() };
        day.items.insert("2330".into(), [(541, 2.0), (549, 2.0)].into_iter().collect());
        let day = crate::baseline::Lookup::Ready(std::sync::Arc::new(day));
        let unknown = |v: &Value| ["volume", "ratio", "diff", "change_pct"].iter().all(|f| v[*f].is_null());

        // Subscribed the whole time: `advance` makes the silent minute a real no-trade minute.
        let mut covered = Instrument::new(id());
        covered.cover_from_open();
        covered.apply(&cal, &r, &trade_at(1, 540, 5, 1_000_000, 2, 1));
        covered.advance(&cal, 543, 2);
        assert_eq!(covered.minutes[&541].quality, Quality::NoTradeSynthetic);
        let v = covered.volume_compare_wire(&cal, ts(542, 30), Some(&day)).unwrap();
        assert_eq!((v["volume"].clone(), v["ratio"].clone(), v["diff"].clone(), v["change_pct"].clone()),
                   (json!(0), json!(0.0), json!(-2), json!(-100.0)), "{v}");
        // No record of the minute yet (nothing has finalized 09:09).
        let v = covered.volume_compare_wire(&cal, ts(550, 0), Some(&day)).unwrap();
        assert_eq!((v["minute"].clone(), v["baseline_volume"].clone()), (json!(549), json!(2)));
        assert!(unknown(&v), "{v}");

        // A coverage gap: the source was gone in 09:01, so nobody knows what traded.
        let mut gap = Instrument::new(id());
        gap.apply(&cal, &r, &trade_at(1, 540, 5, 1_000_000, 2, 1));
        gap.close_coverage(540);
        gap.advance(&cal, 543, 2);
        assert_eq!(gap.minutes[&541].volume, None);
        let v = gap.volume_compare_wire(&cal, ts(542, 30), Some(&day)).unwrap();
        assert!(unknown(&v), "not -100%: {v}");
    }

    #[test]
    fn an_older_book_leaves_the_current_one() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &book_at(1, 540, 10, (1_000_000, 5), (1_010_000, 6)));
        inst.apply(&cal, &r, &book_at(2, 540, 9, (990_000, 1), (1_000_000, 1)));
        assert_eq!(inst.price.book, Some((ts(540, 10), 1_000_000, 1_010_000)));
        assert_eq!(inst.price.book_top.as_ref().map(|b| (b.ts, b.bid_volume)), Some((ts(540, 10), 5.0)));
        inst.apply(&cal, &r, &book_at(3, 540, 10, (1_005_000, 2), (1_015_000, 2)));
        assert_eq!(inst.price.book, Some((ts(540, 10), 1_005_000, 1_015_000)), "the same exchange time keeps durable order");
    }

    #[test]
    fn the_reference_is_market_runtimes_rule_over_reference_events_only() {
        // D03-01: B kept its own rule (a print filled an empty reference, a quote and a Reference event replaced it), so
        // event order could leave A and B on different 昨收. Now both apply Reference::absorb to Reference events only.
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        let mut print = serde_json::to_value(trade_at(1, 541, 5, 1_020_000, 2, 1)).unwrap();
        print["payload"]["prev_close"] = json!(990_000);
        inst.apply(&cal, &r, &serde_json::from_value::<MarketEvent>(print).unwrap());
        assert_eq!(inst.price.reference.comparison_price(), None, "a print names no 昨收");
        let mut settlement = reference_at(2, 1_000_000);
        if let Payload::Reference { ref mut prev_close, ref mut reference_price, .. } = settlement.payload {
            (*prev_close, *reference_price) = (None, Some(1_005_000));
        }
        inst.apply(&cal, &r, &settlement);
        inst.apply(&cal, &r, &reference_at(3, 1_000_000));
        let mut a = market_runtime::state::Reference::default();
        a.absorb(&settlement.payload);
        a.absorb(&reference_at(3, 1_000_000).payload);
        assert_eq!(inst.price.reference, a, "the same facts as Market Runtime's LatestState");
        assert_eq!(inst.price.reference.comparison_price(), Some(1_005_000), "a later 昨收 does not replace the contract reference");
    }

    #[test]
    fn full_day_uses_the_real_first_print_and_the_reference_for_change() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &reference_at(0, 1_000_000));
        inst.apply(&cal, &r, &trade_at(1, 541, 5, 1_020_000, 2, 1));
        inst.apply(&cal, &r, &trade_at(2, 540, 50, 1_010_000, 1, -1)); // earlier exchange time, arrived later
        inst.apply(&cal, &r, &trade_at(3, 543, 5, 990_000, 150, -1));
        let d = inst.day_wire(&cal, &r, ts(543, 30), None, None).0;
        assert_eq!(d["open"], 101.0, "O is the earliest print by exchange time");
        assert_eq!(d["close"], 99.0);
        assert_eq!(d["close_change"], -1.0, "vs reference 100, not vs open");
        assert!(d.get("change").is_none(), "the instrument's 漲跌 is Market Runtime's alone");
        assert_eq!(d["open_to_close"], -2.0);
        assert_eq!(d["flow"]["large"]["sell"], 150);
        assert_eq!(d["fixed_k"]["k3"][0]["start_minute"], 540);
        assert_eq!(d["fixed_k"]["k3"][1]["start_minute"], 543);
    }

    // ---------------------------------------------------------------- 成交量 is a decimal quantity

    pub fn futu_us() -> InstrumentId {
        InstrumentId { source: "futu".into(), market: "US".into(), code: "US.NOK".into(), trading_date: "2026-09-29".into(), session: "DAY".into() }
    }

    pub fn as_futu(mut e: MarketEvent) -> MarketEvent {
        (e.provider, e.market, e.code, e.symbol) = ("futu".into(), "US".into(), "US.NOK".into(), "futu:US:US.NOK".into());
        e
    }

    #[test]
    fn fractional_prints_are_prints_in_every_aggregate() {
        // A 0.25-share print must not arrive as 0 and be dropped by add_trade: no minute volume, no 內外盤, no day volume.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = opened(&cal, &r);
        for (seq, volume, side) in [(1, 0.25, 1), (2, 0.25, -1), (3, 0.1, 1), (4, 0.2, 1), (5, 0.2, 0)] {
            inst.apply(&cal, &r, &trade_at(seq, 600, seq as i32, 1_000_000, volume, side));
        }
        let m = &inst.minutes[&600];
        assert!(vol::eq(m.volume.unwrap(), 1.0), "{:?}", m.volume);
        assert_eq!(m.trades, 5);
        assert!(vol::eq(m.flow.small.buy, 0.55) && vol::eq(m.flow.small.sell, 0.25) && vol::eq(m.flow.small.unknown, 0.2));
        // Output carries no binary noise (0.1 + 0.2 + 0.25 is 0.55000000000000004 in f64).
        let wire = m.wire(&id(), None, Some("tw-100"));
        assert_eq!(wire["volume"], json!(1));
        assert_eq!(wire["flow"]["small"]["buy"], json!(0.55));
        let ladder = &inst.flow.price_volume[&1_000_000];
        assert!(vol::eq(ladder.volume, 1.0) && vol::eq(ladder.buy, 0.55));
        let day = inst.day_wire(&cal, &r, ts(600, 59), None, None).0;
        assert_eq!(day["volume"], json!(2), "1 + the opening match's 1: {}", day["volume"]);
    }

    #[test]
    fn a_decimal_cumulative_total_never_invents_or_loses_a_gap() {
        let opened = |changes: Vec<Hole>| changes.iter().filter_map(|c| match c { Hole::Opened(h) => Some(h.size), _ => None }).sum::<f64>();
        // The first print's total equals its own size up to binary noise: no unseen volume before it.
        assert!(TradeChain::default().cover(0.1 + 0.2, 0.3, 600, false).is_empty());
        // A total that moved only by noise is not a gap; a real fractional jump is (exactly the missing part).
        let mut chain = TradeChain::default();
        assert_eq!(opened(chain.cover(48_971_788.25, 0.25, 600, false)), 48_971_788.0, "a late start: everything before the print went unseen");
        assert!(chain.cover(48_971_788.5, 0.25, 600, false).is_empty(), "48,971,788.25 + 0.25 = .5: nothing unseen");
        let gap = opened(chain.cover(48_971_789.0, 0.25, 601, false));
        assert!(vol::eq(gap, 0.25), "0.25 shares traded unseen between the prints: {gap}");
        // A resend is inside what is covered: nothing changes, and the known total stays.
        assert!(chain.cover(48_971_789.0, 0.25, 601, false).is_empty());
        // The print that was missing, arriving afterwards, closes the hole it was.
        let late = chain.cover(48_971_788.75, 0.25, 600, true);
        assert!(matches!(late.as_slice(), [Hole::Closed(h)] if vol::eq(h.size, 0.25) && h.at_minute == 601), "{late:?}");
        assert_eq!(chain.high(), Some(48_971_789.0));
        assert_eq!(chain.spans.len(), 2, "the origin and one span: only the late start's hole is left");
    }

    #[test]
    fn a_closed_sessions_fill_far_below_the_days_total_is_no_new_count() {
        // 1802 on 11-06: the 10:29 gap (total ~41,700) filled after the whole day's prints (total ~80,000). A live
        // print that far below would be a new count; a filled one is part of the day's.
        let mut chain = TradeChain::default();
        chain.cover(41_699.0, 5.0, 569, false);
        chain.cover(41_816.0, 2.0, 570, false);
        chain.cover(80_000.0, 10.0, 800, false);
        let closed = chain.cover(41_814.0, 115.0, 569, true);
        assert!(closed.iter().any(|c| matches!(c, Hole::Closed(h) if vol::eq(h.size, 115.0))), "{closed:?}");
        assert_eq!(chain.spans.get(1).map(|s| (s.lo, s.hi)), Some((41_694.0, 41_816.0)), "the day's first spans are still there, joined by the fill");
    }

    #[test]
    fn a_restarts_gap_filled_afterwards_closes_its_volume_gap_and_its_minutes_read_complete_again() {
        // The provider restarted between 10:00 and 10:05: its successor's first print (10:05, total 130) proves 25
        // lots traded unseen after the predecessor's last (10:00, total 100). The broker's history fills them in
        // afterwards, in durable order after the 10:05 print: 15 lots at 10:02 and 10 at 10:04.
        let (cal, r) = (Calendar::default(), rules());
        let mut inst = Instrument::new(id());
        inst.apply(&cal, &r, &trade_total(1, 540, 1, 100, 100));
        inst.apply(&cal, &r, &trade_total(2, 600, 0, 5, 105));
        inst.apply(&cal, &r, &trade_total(3, 605, 0, 5, 135));
        assert_eq!((inst.minutes[&605].unattributed_volume, inst.quality.volume_gaps), (25.0, 1));
        assert!((600..=605).all(|m| inst.minutes.get(&m).is_some_and(|x| x.lost_input())));
        inst.apply(&cal, &r, &trade_total(4, 602, 10, 15, 120));
        assert_eq!((inst.minutes[&605].unattributed_volume, inst.minutes[&602].unattributed_volume), (10.0, 0.0),
                   "the 10:02 print closes the first part; 10 lots after it are still unseen");
        assert!(!inst.minutes[&601].lost_input() && inst.minutes[&603].lost_input());
        inst.apply(&cal, &r, &trade_total(5, 604, 30, 10, 130));
        assert_eq!((inst.minutes[&605].unattributed_volume, inst.quality.volume_gaps), (0.0, 0), "the gap is filled");
        assert!((540..=605).all(|m| inst.minutes.get(&m).is_none_or(|x| !x.lost_input())), "no minute reads lost any more");
        assert_eq!(inst.minutes[&602].volume, Some(15.0));
        assert_eq!(inst.minutes[&604].volume, Some(10.0));
        let day = inst.day_wire(&cal, &r, ts(606, 0), None, None).0;
        assert_eq!(day["volume"], json!(135), "seen prints only: nothing unattributed is left");
    }

    #[test]
    fn thresholds_hold_at_the_boundary_for_decimal_volumes() {
        let mut rule = rules().flow[0].clone();
        rule.threshold = 0.3;
        assert!(rule.is_large(1_000_000, 0.1 + 0.2), "0.30000000000000004 and 0.3 are the same size");
        assert!(rule.is_large(1_000_000, 0.3));
        assert!(!rule.is_large(1_000_000, 0.29));
        rule.threshold = 100.0;
        assert!(rule.is_large(1_000_000, 100.0));
        assert!(!rule.is_large(1_000_000, 99.99));
    }

    #[test]
    fn whole_lots_behave_exactly_as_before() {
        // TW lots are whole numbers: f64 holds them exactly, so every aggregate is identical to the integer version.
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(id());
        let mut expected = 0.0;
        for seq in 1..=500u64 {
            let lots = (seq % 37 + 1) as f64;
            expected += lots;
            inst.apply(&cal, &r, &trade_at(seq, 600 + (seq / 50) as i32, (seq % 50) as i32, 1_000_000, lots, if seq % 2 == 0 { 1 } else { -1 }));
        }
        let total: f64 = inst.minutes.values().filter_map(|m| m.volume).sum();
        assert_eq!(total, expected, "exact, not approximately");
        let day = inst.day_wire(&cal, &r, ts(611, 0), None, None).0;
        assert!(day["volume"].is_i64(), "a whole total is still an integer on the wire: {}", day["volume"]);
    }

    #[test]
    fn a_futu_fractional_print_reaches_the_minute_and_day() {
        let cal = Calendar::default();
        let r = rules();
        let mut inst = Instrument::new(futu_us());
        inst.apply(&cal, &r, &as_futu(trade_at(1, 600, 1, 108_550, 0.25, 1)));
        inst.apply(&cal, &r, &as_futu(trade_at(2, 600, 2, 108_550, 100.0, 1)));
        assert!(vol::eq(inst.minutes[&600].volume.unwrap(), 100.25));
        // ts() is Taiwan time; this partition is New York's: 10:00 EDT on 2026-09-29 is 22:00 in Taipei.
        let day = inst.day_wire(&cal, &r, ts(22 * 60, 59), None, None).0;
        assert_eq!(day["volume"], json!(100.25), "{day}");
    }
}
