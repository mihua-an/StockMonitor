//! LatestState: per instrument/trading-date/session reference, latest quote, recent 100 trades and latest BidAsk
//! (docs/system-architecture/01 sections 1-2).
//!
//! Rust A does not build minute OHLCV, trend history or order flow: those are Rust B's results, cached by
//! `projection.rs` and delivered, never recomputed here (01 section 2). What stays is exactly what the UI needs
//! instantly and what only the live stream knows: the newest price, the tape, the book.

use crate::event::{partition_local_minute, preopen_at, BookLevel, InstrumentKey, MarketEvent, Payload, SessionKey, StateKey, LOSS_CONTROL, SOURCE_GAP};
use crate::rollover::{clear_family, family, never_stored};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

pub const RECENT_TRADES: usize = 100;
pub const BOOK_LEVELS: usize = 10;
const DEFAULT_HOT_CAPACITY: usize = 4000;
/// TW stock day session: 09:00 opening match, 13:30 closing match (minutes after local midnight).
const STOCK_OPEN_MINUTE: i32 = 9 * 60;
const STOCK_CLOSE_MINUTE: i32 = 13 * 60 + 30;

/// Sale conditions (Futu TickerType names) that the US consolidated tape does not let update the last sale price:
/// an odd lot, a price set elsewhere or earlier (average, prior reference, derivatively priced, a market center's
/// official open / close), or a settlement other than regular. Their price is no price of the market -- 11-06 US.TSM
/// odd lots at exactly 昨收 before the open and 392.26 / 350.09 prints after hours spiked the trend line. A regular
/// print of the extended sessions still sets the last sale.
const NO_LAST_SALE_CONDITIONS: [&str; 10] = [
    "ODD_LOT", "ODD_LOT_CROSS_MARKET", "AVERAGE_PRICE", "PRIOR_REFERENCE_PRICE", "DERIVATIVELY_PRICED", "NEXT_DAY",
    "SELLER", "CONTINGENT", "MARKET_CENTER_CLOSE_PRICE", "MARKET_CENTER_OPEN_PRICE",
];

/// Whether a print with this source condition sets no last sale: the one rule, applied at ingest
/// (Engine::classify_print); every reader takes the stored Payload::Trade::no_last_sale.
pub fn condition_sets_no_last_sale(condition: &str) -> bool {
    NO_LAST_SALE_CONDITIONS.iter().any(|c| c.eq_ignore_ascii_case(condition.trim()))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Reference {
    pub prev_close: Option<i64>,
    pub prev_volume: Option<f64>,
    /// Explicit contract reference (futures settlement); falls back to prev_close when absent.
    pub reference_price: Option<i64>,
    pub limit_up: Option<i64>,
    pub limit_down: Option<i64>,
    pub name: Option<String>,
    pub reference_source: Option<String>,
}

impl Reference {
    pub fn comparison_price(&self) -> Option<i64> {
        self.reference_price.or(self.prev_close).filter(|v| *v > 0)
    }

    /// The one rule for a Reference event, applied by Market Runtime's LatestState and by every Rust B reader alike:
    /// each field the source sent replaces the known one, a missing one never erases it. No other event writes these
    /// facts. Returns false for any other payload.
    pub fn absorb(&mut self, payload: &Payload) -> bool {
        let Payload::Reference { limit_up, limit_down, prev_close, prev_volume, reference_price, name, reference_source } = payload else { return false };
        macro_rules! keep_pos {
            ($($f:ident),+) => { $( if let Some(v) = $f.filter(|v| *v > 0) { self.$f = Some(v); } )+ };
        }
        keep_pos!(limit_up, limit_down, prev_close, reference_price);
        if let Some(v) = prev_volume.and_then(positive_volume) {
            self.prev_volume = Some(v);
        }
        if let Some(n) = name.as_ref().filter(|n| !n.trim().is_empty()) {
            self.name = Some(n.clone());
        }
        if reference_price.is_some_and(|v| v > 0) {
            if let Some(source) = reference_source.as_ref().filter(|s| !s.trim().is_empty()) {
                self.reference_source = Some(source.clone());
            }
        }
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Quote {
    pub open: Option<i64>,
    pub current: Option<i64>,
    pub high: Option<i64>,
    pub low: Option<i64>,
    pub total_volume: Option<f64>,
    pub total_amount: Option<f64>,
    pub average: Option<i64>,
    pub status: String,
    /// The newest indicative (試撮) price: shown as such, never as 現價.
    pub indicative_price: Option<i64>,
    /// Exchange time of `indicative_price`: a pre-open one is left out of the checkpoint (see `durable_image`).
    pub indicative_ts_ns: i64,
    /// Breadth counts an index quote carries (source-reported breadth).
    pub advance_count: Option<i64>,
    pub decline_count: Option<i64>,
    pub flat_count: Option<i64>,
    pub limit_up_count: Option<i64>,
    pub limit_down_count: Option<i64>,
    /// Exchange time and market minute of the newest valid price.
    pub price_exchange_ts_ns: i64,
    pub price_minute: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Trade {
    pub version: u64,
    pub durable_sequence: u64,
    pub exchange_ts_ns: i64,
    pub price: i64,
    /// Decimal quantity in the instrument's unit (crate::volume::unit).
    pub volume: f64,
    /// The session's cumulative volume through this print as the source states it (Shioaji's per-print total);
    /// None where the source states none (a Futu ticker row). A checkpoint image older than this field is another
    /// checkpoint schema and is rebuilt from the WAL (checkpoint::CHECKPOINT_SCHEMA), never read as "no total".
    pub total_volume: Option<f64>,
    /// The tape side (event::tape_side): 0 for a print that is 不分內外盤.
    pub side: i8,
    pub trade_id: String,
    pub simtrade: bool,
    pub minute: Option<i32>,
    /// A call-auction match (Payload::Trade::auction): `side` is 0 here, 不分內外盤.
    #[serde(default)]
    pub auction: bool,
    /// A 盤後定價 print (Payload::Trade::after_hours): on the tape, `side` 0, in no intraday figure.
    #[serde(default)]
    pub after_hours: bool,
    /// A print that sets no last sale (Payload::Trade::no_last_sale): on the tape, `side` 0, no 現價.
    #[serde(default)]
    pub no_last_sale: bool,
}

/// A level of the shown book: the source's price and volume, and its change against the previous book at the same
/// price (a new price shows its whole volume; None for the first book of the partition). One meaning whatever the
/// source: Shioaji's own per-index diff is not read (D01-05).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BookRow {
    pub price: i64,
    pub volume: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Book {
    pub bids: Vec<BookRow>,
    pub asks: Vec<BookRow>,
    pub exchange_ts_ns: i64,
    pub received_ns: u64,
    /// A call-auction (試撮) book: with a pre-open time it is left out of the checkpoint (see `durable_image`).
    pub simtrade: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct BlockVersions {
    pub reference: u64,
    pub quote: u64,
    pub trades: u64,
    pub book: u64,
}

/// Arrival (backend receive) time, epoch microseconds, of the newest event that CHANGED each block.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Arrivals {
    pub summary_us: u64,
    pub trades_us: u64,
    pub orderbook_us: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SymbolState {
    pub key: StateKey,
    pub provider: String,
    pub generation: u64,
    pub version: u64,
    pub source_sequences: BTreeMap<String, u64>,
    pub last_durable_sequence: u64,
    pub exchange_ts_ns: i64,
    pub updated_at_ns: u64,
    pub reference: Reference,
    pub quote: Quote,
    pub recent_trades: VecDeque<Trade>,
    pub book: Book,
    pub arrivals: Arrivals,
    pub block_versions: BlockVersions,
    /// Cumulative volume carried by the newest applied trade (trades only: a quote's total never decides it).
    pub last_trade_total_volume: Option<f64>,
    /// Events of this instrument the producer dropped before handing them over (flags.gap_before): the state is
    /// missing them, and nothing else can tell.
    pub source_gaps: u64,
    /// Events older (exchange time) than the latest price / book already shown: stored, not shown.
    pub stale_latest_updates: u64,
    /// Real (non-試撮) prints applied: the first one at 09:00 is the opening auction's match (classify_print).
    #[serde(default)]
    pub real_prints: u64,
    /// Shioaji prints whose cumulative total did not move but that are not the newest print again
    /// (PrintRepeat::TotalNotAdvanced): kept and applied, counted here as a quality problem of the source.
    #[serde(default)]
    pub total_not_advanced: u64,
    /// The newest real print by exchange time (a trade, or a FUT quote carrying its own print volume): where a gap the
    /// stream leaves starts, for the fill of a provider restart (Engine::gap_starts).
    #[serde(default)]
    pub newest_print: NewestPrint,
}

/// The exchange time of the newest real print and the volume stored at exactly that time (several prints can share
/// it): the fill of a gap after it skips that much of the broker's history at that instant.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct NewestPrint {
    pub exchange_ts_ns: i64,
    pub volume_at_ts: f64,
}

impl NewestPrint {
    fn note(&mut self, exchange_ts_ns: i64, volume: f64) {
        if exchange_ts_ns > self.exchange_ts_ns {
            *self = Self { exchange_ts_ns, volume_at_ts: volume };
        } else if exchange_ts_ns == self.exchange_ts_ns {
            self.volume_at_ts += volume;
        }
    }
}

/// Where one code's gap starts, for a provider restart's fill (`ingest.hello.ack`): its newest stored print (none:
/// the session's open), the volume stored at that instant, and the cumulative volume then (None when the stream
/// states none).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GapStart {
    pub market: String,
    pub code: String,
    pub trading_date: String,
    pub session: String,
    pub after_ns: i64,
    pub volume_at_after: f64,
    pub total_before: Option<f64>,
}

/// A print next to the partition's newest real print (Shioaji's cumulative total says whether it is new).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrintRepeat {
    /// A print of its own: the total moved, it is no Shioaji print, or nothing to compare.
    New,
    /// The newest real print again -- same price, volume and cumulative total -- at its exchange time (a reconnect's
    /// resend) or, after the 13:30 closing match, at 盤後定價 time (the broker re-sends the close at 14:30 before the
    /// after-hours print). Never stored and never a trade. The trade id is not compared: a Shioaji tick carries
    /// none, and the provider fills in its own stream counter, which differs on every copy.
    Resent,
    /// The total did not move, yet it is not the newest print again: kept and applied as the print it says it is,
    /// and counted (`SymbolState::total_not_advanced`), never dropped on a guess.
    TotalNotAdvanced,
}

/// What an applied event changed, for delta building and breadth maintenance.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Changed {
    pub reference: bool,
    pub quote: bool,
    pub trade: bool,
    pub book: bool,
}

impl Changed {
    pub fn any(&self) -> bool {
        self.reference || self.quote || self.trade || self.book
    }
}

fn positive(v: i64) -> Option<i64> {
    (v > 0).then_some(v)
}

use crate::volume::positive as positive_volume;

impl SymbolState {
    fn empty(key: StateKey, event: &MarketEvent) -> Self {
        Self {
            key,
            provider: event.provider.clone(),
            generation: event.generation,
            version: 0,
            source_sequences: BTreeMap::new(),
            last_durable_sequence: 0,
            exchange_ts_ns: 0,
            updated_at_ns: 0,
            reference: Reference::default(),
            quote: Quote::default(),
            recent_trades: VecDeque::with_capacity(RECENT_TRADES),
            book: Book::default(),
            arrivals: Arrivals::default(),
            block_versions: BlockVersions::default(),
            last_trade_total_volume: None,
            source_gaps: 0,
            stale_latest_updates: 0,
            real_prints: 0,
            total_not_advanced: 0,
            newest_print: NewestPrint::default(),
        }
    }

    /// 現價 as every screen shows it: the auction's indicative price while a call auction runs (A holds one only until
    /// the next real print or quote), else the last real price.
    pub fn shown_price(&self) -> Option<i64> {
        self.quote.indicative_price.or(self.quote.current)
    }

    /// The one 漲跌 / 漲跌幅 of the session: shown price - comparison price; percent = change / comparison * 100. None
    /// when either is missing/zero. The renderer formats it and computes none of its own.
    pub fn change(&self) -> Option<(i64, f64)> {
        let current = self.shown_price()?;
        let reference = self.reference.comparison_price()?;
        let change = current - reference;
        Some((change, change as f64 / reference as f64 * 100.0))
    }

    /// This state as the checkpoint keeps it: without anything 盤前試撮 put in it, which is shown live and never
    /// stored (user rule) -- the checkpoint is a disk image, so a pre-open 試撮 in it would come back after a restart.
    /// A partition that has only 試撮 so far is not kept at all. Intraday and closing auctions are stored data and
    /// stay. Pre-open content is recognised by its 試撮 flag (simtrade / simulated) together with a pre-open exchange
    /// time: an intraday or closing auction has a flag but not the time, a real pre-open quote has the time but not
    /// the flag.
    pub fn durable_image(&self) -> Option<SymbolState> {
        // A market that is never stored (Futu crypto) has no durable events at all, and no pre-open: its cache is kept
        // whole, so it survives a restart until its Taipei-midnight clear.
        if never_stored(&self.key.instrument.source, &self.key.instrument.market) {
            return Some(self.clone());
        }
        if self.last_durable_sequence == 0 {
            return None;
        }
        let market = self.key.instrument.market.as_str();
        let preopen = |ts: i64| preopen_at(market, ts);
        let mut s = self.clone();
        s.recent_trades.retain(|t| !(t.simtrade && preopen(t.exchange_ts_ns)));
        if s.book.simtrade && preopen(s.book.exchange_ts_ns) {
            s.book = Book::default();
        }
        if s.quote.indicative_price.is_some() && preopen(s.quote.indicative_ts_ns) {
            s.quote.indicative_price = None;
            s.quote.indicative_ts_ns = 0;
        }
        if matches!(s.quote.status.as_str(), "simulated" | "simtrade") && s.quote.indicative_price.is_none() && s.quote.current.is_none() {
            s.quote.status.clear();
        }
        Some(s)
    }

    /// An event older (by exchange time) than what a "latest" value already shows. Sequence orders arrival, not the
    /// market: a resend after a reconnect or a reordered callback must not put an older price / book back on screen.
    /// Such an event is still stored and still counts for high / low / open; it only never replaces a
    /// newer latest value. Events without an exchange time cannot be judged and are applied as before.
    fn older_than(shown_ts_ns: i64, event: &MarketEvent) -> bool {
        event.exchange_ts_ns > 0 && shown_ts_ns > event.exchange_ts_ns
    }

    /// Futu's fields have one source each (user 11-02, docs/decisions.md): 現價 is the newest print alone (TICKER,
    /// every session) and 開盤／最高／最低 OpenD's own regular-session figures on its quote alone -- blank before the
    /// regular open. A print never moves the range and a quote never moves 現價, so no arrival order picks between them.
    fn futu(event: &MarketEvent) -> bool {
        event.provider.eq_ignore_ascii_case("futu")
    }

    /// A print's price: 現價, and (for a source whose day range is its prints') the day's open / high / low.
    fn set_price(&mut self, price: i64, event: &MarketEvent, minute: i32) {
        self.set_current(price, event, minute);
        self.quote.high = Some(self.quote.high.map_or(price, |h| h.max(price)));
        self.quote.low = Some(self.quote.low.map_or(price, |l| l.min(price)));
        if self.quote.open.is_none() {
            self.quote.open = Some(price);
        }
    }

    /// 現價 alone, unless an event newer by exchange time already set it.
    fn set_current(&mut self, price: i64, event: &MarketEvent, minute: i32) {
        if Self::older_than(self.quote.price_exchange_ts_ns, event) {
            self.stale_latest_updates = self.stale_latest_updates.saturating_add(1);
        } else {
            self.quote.current = Some(price);
            self.quote.price_exchange_ts_ns = event.exchange_ts_ns;
            self.quote.price_minute = if minute >= 0 {
                Some(minute)
            } else {
                partition_local_minute(&event.provider, &event.market, &event.session, event.exchange_ts_ns).map(|(_, m)| m)
            };
        }
    }

    /// Whether a Shioaji print is the newest print again (PrintRepeat). At 14:30 the broker re-sends the 13:30 closing
    /// print (same total_volume 82,884, same amount) before the after-hours print, and the tape showed 5,371 twice
    /// (2344); a reconnect re-sends the last print. Such a copy is not a trade here and the ingest never writes it to
    /// the WAL (user 10-20), so history and the trade pages never show it. A total that did not move proves nothing
    /// on its own: a print that is not the newest one again is kept (TotalNotAdvanced). Other sources' totals are not held to it. Volumes are compared with crate::volume's tolerance:
    /// "did not move" must not hinge on the last binary digit.
    pub fn print_repeat(&self, event: &MarketEvent) -> PrintRepeat {
        let Payload::Trade { price, volume, total_volume, simtrade, minute, .. } = &event.payload else { return PrintRepeat::New };
        // A print filled into a gap afterwards is older than the newest one by construction: its provider fetched
        // only what no stored print covers.
        if *simtrade || event.flags.backfill || positive_volume(*volume).is_none() || !event.provider.eq_ignore_ascii_case("shioaji") {
            return PrintRepeat::New;
        }
        let (Some(total), Some(known)) = (positive_volume(*total_volume), self.last_trade_total_volume) else { return PrintRepeat::New };
        if crate::volume::gt(total, known) {
            return PrintRepeat::New;
        }
        let Some(newest) = self.recent_trades.iter().rev().find(|t| !t.simtrade) else { return PrintRepeat::TotalNotAdvanced };
        let same = newest.price == *price && crate::volume::eq(newest.volume, *volume) && crate::volume::eq(total, known);
        let close_resent_after_hours = newest.auction && newest.minute == Some(STOCK_CLOSE_MINUTE) && *minute > STOCK_CLOSE_MINUTE;
        if same && (newest.exchange_ts_ns == event.exchange_ts_ns || close_resent_after_hours) {
            PrintRepeat::Resent
        } else {
            PrintRepeat::TotalNotAdvanced
        }
    }

    /// Events of this instrument the source dropped (a producer-stated `gap_before`): counted, and the summary that
    /// shows the count moves.
    fn note_source_gap(&mut self, events: u64, changed: &mut Changed) {
        if events > 0 {
            self.source_gaps = self.source_gaps.saturating_add(events);
            self.version = self.version.saturating_add(1);
            self.block_versions.quote += 1;
            changed.quote = true;
        }
    }

    fn apply(&mut self, event: &MarketEvent) -> Changed {
        let mut changed = Changed::default();
        self.source_sequences.insert(event.payload.stream_key().to_owned(), event.sequence);
        if event.durable_sequence > 0 {
            // 0 = an indicative (試撮) event applied live but never stored.
            self.last_durable_sequence = event.durable_sequence;
        }
        // Decided before anything else moves: a re-sent print changes neither the tape, the reference nor the totals
        // (with no block version or delta to say so they would all move). The gap
        // the producer states on it is still evidence that events before it were lost: it is counted, and the
        // summary that shows it moves.
        match self.print_repeat(event) {
            PrintRepeat::Resent => {
                self.note_source_gap(event.flags.gap_before, &mut changed);
                return changed;
            }
            PrintRepeat::TotalNotAdvanced => self.total_not_advanced = self.total_not_advanced.saturating_add(1),
            PrintRepeat::New => {}
        }
        self.provider.clone_from(&event.provider);
        self.generation = event.generation;
        self.version = self.version.saturating_add(1);
        self.source_gaps = self.source_gaps.saturating_add(event.flags.gap_before);
        self.exchange_ts_ns = event.exchange_ts_ns;
        self.updated_at_ns = if event.arrival_ns > 0 { event.arrival_ns } else { event.a_received_ns };
        let arrival_us = self.updated_at_ns / 1_000;
        match &event.payload {
            Payload::Quote { .. } => self.apply_quote(event, &mut changed, arrival_us),
            Payload::Trade { .. } => self.apply_trade(event, &mut changed, arrival_us),
            Payload::OrderBook { .. } => self.apply_book(event, &mut changed, arrival_us),
            Payload::Reference { .. } => self.apply_reference(event, &mut changed),
            // Coverage is a control record (event::COVERAGE_CONTROL): Engine::apply never hands it to a state.
            Payload::SourceStatus { .. } => {}
            // A source bar is Rust B's input only: it never moves 現價 or the day range here (user 11-02).
            Payload::MinuteBar { .. } => {}
            Payload::Clock { .. } => {}
        }
        if changed.reference {
            self.block_versions.reference += 1;
        }
        if changed.quote {
            self.block_versions.quote += 1;
        }
        if changed.trade {
            self.block_versions.trades += 1;
        }
        if changed.book {
            self.block_versions.book += 1;
        }
        changed
    }

    /// A quote: every field the source sent moves its own summary fact.
    fn apply_quote(&mut self, event: &MarketEvent, changed: &mut Changed, arrival_us: u64) {
        let Payload::Quote {
            current, open, high, low, total_volume, total_amount, status, minute, average, volume,
            advance_count, decline_count, flat_count, limit_up_count, limit_down_count, ..
        } = &event.payload else { return };
        // A field the source omitted (0 / sentinel) is "not known", never "reset to zero".
        if event.is_indicative() {
            // A futures quote marked simulated is 試撮, like a simtrade print: its price is the indicative price,
            // never 現價, and its open / high / low / volumes / average describe the auction, not the session.
            if let Some(price) = positive(*current) {
                self.quote.indicative_price = Some(price);
                self.quote.indicative_ts_ns = event.exchange_ts_ns;
            }
            self.quote.status.clone_from(status);
            self.arrivals.summary_us = arrival_us;
            changed.quote = true;
            return;
        }
        if positive(*current).is_some() {
            // A real quote ends the auction: its indicative price no longer describes anything.
            self.quote.indicative_price = None;
            self.quote.indicative_ts_ns = 0;
        }
        if let Some(price) = positive(*current).filter(|_| !Self::futu(event)) {
            self.set_price(price, event, *minute);
        }
        if let Some(o) = positive(*open) {
            self.quote.open = Some(o);
        }
        if let Some(h) = positive(*high) {
            self.quote.high = Some(self.quote.high.map_or(h, |x| x.max(h)));
        }
        if let Some(l) = positive(*low) {
            self.quote.low = Some(self.quote.low.map_or(l, |x| x.min(l)));
        }
        // A cumulative total never goes back (an older quote carries a smaller one).
        if let Some(v) = positive_volume(*total_volume) {
            self.quote.total_volume = Some(self.quote.total_volume.map_or(v, |known| known.max(v)));
        }
        if *total_amount > 0.0 {
            self.quote.total_amount = Some(*total_amount);
        }
        if let Some(a) = positive(*average) {
            self.quote.average = Some(a);
        }
        if !status.is_empty() {
            self.quote.status.clone_from(status);
        }
        macro_rules! keep {
            ($($f:ident),+) => { $( if $f.is_some() { self.quote.$f = *$f; } )+ };
        }
        keep!(advance_count, decline_count, flat_count, limit_up_count, limit_down_count);
        if let (Some(own), true) = (positive_volume(*volume), event.market == "FUT") {
            self.newest_print.note(event.exchange_ts_ns, own);
        }
        self.arrivals.summary_us = arrival_us;
        changed.quote = true;
    }

    /// A print: summary facts, the auction state, and the recent-trades tape.
    fn apply_trade(&mut self, event: &MarketEvent, changed: &mut Changed, arrival_us: u64) {
        let Payload::Trade {
            price, volume, total_volume, minute, open, high, low, average,
            total_amount, simtrade, after_hours, no_last_sale, ..
        } = &event.payload else { return };
        // A cumulative total never goes back: a print filled into a restart's gap afterwards carries a smaller one.
        if !*simtrade && positive_volume(*volume).is_some() && event.provider.eq_ignore_ascii_case("shioaji") {
            if let Some(total) = positive_volume(*total_volume) {
                self.last_trade_total_volume = Some(self.last_trade_total_volume.map_or(total, |known| known.max(total)));
            }
        }
        if *simtrade {
            // Indicative: recorded on the tape (flagged) and as an indicative price, never as 現價. The
            // instrument is in a call auction from now until the next real print -- 盤前試撮, an intraday
            // 緩漲緩跌 halt, or the 13:25 closing auction -- so the status says so in all three, not only
            // before the first trade of the day.
            self.quote.indicative_price = positive(*price);
            self.quote.indicative_ts_ns = event.exchange_ts_ns;
            if matches!(self.quote.status.as_str(), "" | "live" | "simtrade") {
                self.quote.status = "simtrade".into();
            }
        } else if *after_hours {
            // 盤後定價: the tape keeps it; 現價, 總量, 均價 and the day's range stay those of the session.
        } else if *no_last_sale {
            // An odd lot, an average-price or a prior-reference print: traded volume (the quote's total counts it
            // already), never a price of the market.
        } else if let Some(p) = positive(*price) {
            // A real print ends the auction: its indicative price no longer describes anything.
            self.quote.indicative_price = None;
            self.quote.indicative_ts_ns = 0;
            if Self::futu(event) {
                self.set_current(p, event, *minute);
            } else {
                self.set_price(p, event, *minute);
                if let Some(o) = positive(*open) {
                    self.quote.open = Some(o);
                }
                if let Some(h) = positive(*high) {
                    self.quote.high = Some(h.max(self.quote.high.unwrap_or(h)));
                }
                if let Some(l) = positive(*low) {
                    self.quote.low = Some(l.min(self.quote.low.unwrap_or(l)));
                }
            }
            if let Some(v) = positive_volume(*total_volume) {
                self.quote.total_volume = Some(self.quote.total_volume.map_or(v, |known| known.max(v)));
            }
            if *total_amount > 0.0 {
                self.quote.total_amount = Some(*total_amount);
            }
            if let Some(a) = positive(*average) {
                self.quote.average = Some(a);
            }
            if self.quote.status.is_empty() || self.quote.status == "simtrade" {
                self.quote.status = "live".into();
            }
        }
        // The tape is in exchange-time order: a print older than the newest one (a restart's gap filled afterwards)
        // takes its place among them; the trade frame carries the print inserted (wire::applied_trade), wherever it
        // sits, so the screen puts it in the same place. One older than the whole held tape is not on it.
        let at = self.recent_trades.partition_point(|t| t.exchange_ts_ns <= event.exchange_ts_ns);
        let newest = at == self.recent_trades.len();
        if !newest && at == 0 && self.recent_trades.len() == RECENT_TRADES {
            if !*simtrade {
                self.real_prints += 1;
            }
            self.arrivals.summary_us = arrival_us;
            changed.quote = true;
            return;
        }
        let Some(trade) = crate::trade_pages::trade_of(event, self.version) else { return };
        self.recent_trades.insert(at, trade);
        if self.recent_trades.len() > RECENT_TRADES {
            self.recent_trades.pop_front();
        }
        if !*simtrade {
            self.real_prints += 1;
            if !*after_hours {
                self.newest_print.note(event.exchange_ts_ns, *volume);
            }
        }
        self.arrivals.trades_us = arrival_us;
        self.arrivals.summary_us = arrival_us;
        changed.trade = true;
        changed.quote = true;
    }

    /// A book replaces the previous one unless it is older, with a per-level diff.
    fn apply_book(&mut self, event: &MarketEvent, changed: &mut Changed, arrival_us: u64) {
        let Payload::OrderBook { bids, asks, simtrade } = &event.payload else { return };
        // Per-level change for the renderer's diff: the difference against the previous book at the same price (a
        // new price shows its whole volume), the one meaning for every source.
        let with_diff = |levels: &[BookLevel], previous: &[BookRow]| -> Vec<BookRow> {
            levels.iter().take(BOOK_LEVELS).map(|l| {
                let diff = (!previous.is_empty())
                    .then(|| l.volume - previous.iter().find(|p| p.price == l.price).map(|p| p.volume).unwrap_or(0.0));
                BookRow { price: l.price, volume: l.volume, diff }
            }).collect()
        };
        if Self::older_than(self.book.exchange_ts_ns, event) {
            self.stale_latest_updates = self.stale_latest_updates.saturating_add(1);
            return;
        }
        let (prev_bids, prev_asks) = (self.book.bids.clone(), self.book.asks.clone());
        self.book = Book {
            bids: with_diff(bids, &prev_bids),
            asks: with_diff(asks, &prev_asks),
            exchange_ts_ns: event.exchange_ts_ns,
            received_ns: self.updated_at_ns,
            simtrade: *simtrade,
        };
        self.arrivals.orderbook_us = arrival_us;
        changed.book = true;
    }

    /// Reference facts (limits, previous close/volume, name) the source sent: the only writer of `reference`.
    fn apply_reference(&mut self, event: &MarketEvent, changed: &mut Changed) {
        if self.reference.absorb(&event.payload) {
            changed.reference = true;
        }
    }

}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventFence {
    pub generation: u64,
    pub source_sequences: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyResult {
    Applied,
    RejectedGeneration,
    RejectedSequence,
    /// Its trading date is no real calendar date (2026-10-32, a malformed string): it names no partition. Refused
    /// wherever an event enters the engine -- live ingest, WAL recovery, a replay -- not only at the ingest door.
    RejectedInvalidDate,
    /// Accepted into the WAL (clock/control) but not part of any instrument's latest state.
    Control,
}

const FENCE_RETENTION_DAYS: i64 = 3;

use crate::event::checked_shift_date as shift_date;

/// Instrument/session-partitioned latest state with generation/sequence fences.
///
/// `states` is what the screens are shown. A partition that took an event of an instrument off the background list
/// (`apply_live_only`: shown, never stored -- server::ingest decides) also keeps `stored_base`: the same partition
/// folded from its stored events alone, exactly what a replay of the WAL rebuilds. The checkpoint images the base,
/// never the shown state, so a stock that was shown before it was listed (or after it left the list) never puts
/// into a checkpoint what the WAL does not hold. A partition without a base never took such an event: its state is
/// its stored fold.
#[derive(Debug, Clone)]
pub struct Engine {
    states: HashMap<StateKey, SymbolState>,
    /// Per partition that took a live-only event: its stored fold (None: no stored event yet). Leaves with the state.
    stored_base: HashMap<StateKey, Option<SymbolState>>,
    fences: HashMap<StateKey, EventFence>,
    current: HashMap<InstrumentKey, SessionKey>,
    pinned: std::collections::BTreeSet<InstrumentKey>,
    capacity: usize,
    /// Every resident state by when it last changed (`updated_at_ns`), oldest first: eviction reads from the front
    /// instead of sorting every state.
    recency: BTreeSet<(u64, StateKey)>,
    /// Resident states eviction last could not bring under `capacity` because the rest were pinned: until the cache
    /// grows past this or what may be evicted changes, eviction is not tried again on every event.
    pinned_overflow: usize,
    /// Whether the current stretch over capacity has been logged.
    overflow_reported: bool,
    /// Session rollover cutoffs, `source|MARKET|SESSION` -> date: a partition of that family dated before it has left
    /// the cache (see rollover.rs). Only ever moves forward.
    rolled: BTreeMap<String, String>,
    /// Families emptied whole at a moment (rollover::clears), `source|MARKET` -> ns: what is older is gone.
    cleared: BTreeMap<String, i64>,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            states: HashMap::new(),
            stored_base: HashMap::new(),
            fences: HashMap::new(),
            current: HashMap::new(),
            pinned: Default::default(),
            capacity: DEFAULT_HOT_CAPACITY,
            recency: BTreeSet::new(),
            pinned_overflow: 0,
            overflow_reported: false,
            rolled: BTreeMap::new(),
            cleared: BTreeMap::new(),
        }
    }
}

/// A partition's reference shown and not stored (Engine::references_not_stored), with the source numbering a stored
/// copy of it takes: the partition's latest generation and sequence.
#[derive(Debug, Clone, PartialEq)]
pub struct UnstoredReference {
    pub key: StateKey,
    pub generation: u64,
    pub sequence: u64,
    pub reference: Reference,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EngineImage {
    pub states: Vec<SymbolState>,
    pub fences: Vec<(StateKey, EventFence)>,
    pub current: Vec<(InstrumentKey, SessionKey)>,
    pub rolled: Vec<(String, String)>,
    pub cleared: Vec<(String, i64)>,
}

impl Engine {
    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity.max(1);
        self.pinned_overflow = 0;
    }

    /// Instruments whose current-session state may not be evicted (background list, views, focus).
    pub fn set_pinned(&mut self, pinned: std::collections::BTreeSet<InstrumentKey>) {
        self.pinned = pinned;
        self.pinned_overflow = 0;
    }

    /// Resident states above capacity, kept because they are pinned (0 when the cache fits).
    pub fn over_capacity(&self) -> usize {
        self.states.len().saturating_sub(self.capacity)
    }

    fn insert_state(&mut self, state: SymbolState) {
        self.recency.insert((state.updated_at_ns, state.key.clone()));
        if let Some(old) = self.states.insert(state.key.clone(), state) {
            self.recency.remove(&(old.updated_at_ns, old.key));
        }
    }

    fn remove_state(&mut self, key: &StateKey) {
        if let Some(old) = self.states.remove(key) {
            self.recency.remove(&(old.updated_at_ns, old.key));
        }
        self.stored_base.remove(key);
        self.pinned_overflow = 0;
    }

    pub fn validate(&self, event: &MarketEvent) -> ApplyResult {
        if event.is_clock() {
            return ApplyResult::Control;
        }
        if crate::event::parse_calendar_date(&event.trading_date).is_none() {
            return ApplyResult::RejectedInvalidDate;
        }
        let Some(fence) = self.fences.get(&event.state_key()) else {
            return ApplyResult::Applied;
        };
        if event.generation < fence.generation {
            ApplyResult::RejectedGeneration
        } else if event.generation == fence.generation
            && event.sequence <= fence.source_sequences.get(event.payload.stream_key()).copied().unwrap_or(0)
        {
            ApplyResult::RejectedSequence
        } else {
            ApplyResult::Applied
        }
    }

    /// Validate and apply in one step (the only trustworthy accept decision under concurrent producers): an event that
    /// is stored (the WAL), or one shown and kept the way the stored ones are (盤前試撮 of a listed stock, a
    /// never-stored market's cache; `SymbolState::durable_image` decides what of them a checkpoint keeps).
    pub fn apply(&mut self, event: &MarketEvent) -> (ApplyResult, Changed) {
        self.apply_as(event, false)
    }

    /// An event of an instrument off the background list: shown, never stored. The partition keeps its stored fold
    /// apart from here on (`stored_base`).
    pub fn apply_live_only(&mut self, event: &MarketEvent) -> (ApplyResult, Changed) {
        self.apply_as(event, true)
    }

    fn apply_as(&mut self, event: &MarketEvent, live_only: bool) -> (ApplyResult, Changed) {
        // Subscription coverage is control, not market data: it never creates an instrument state, a view or a session.
        // A loss record (a re-sent print's stated gap, written in its place) counts the gap on the state it names.
        if let Payload::SourceStatus { state, .. } = &event.payload {
            let mut changed = Changed::default();
            if event.time_quality == LOSS_CONTROL && state == SOURCE_GAP {
                let key = event.state_key();
                if let Some(s) = self.states.get_mut(&key) {
                    s.note_source_gap(event.flags.gap_before, &mut changed);
                }
                if !live_only {
                    if let Some(Some(base)) = self.stored_base.get_mut(&key) {
                        base.note_source_gap(event.flags.gap_before, &mut Changed::default());
                    }
                }
            }
            return (ApplyResult::Control, changed);
        }
        let verdict = self.validate(event);
        if verdict != ApplyResult::Applied {
            return (verdict, Changed::default());
        }
        self.fold_validated(event, live_only)
    }

    /// The current partitions whose shown reference their stored fold does not hold: what an instrument off the
    /// background list was told while unlisted. Stated once by its provider, so nobody else will store it.
    pub fn references_not_stored(&self) -> Vec<UnstoredReference> {
        let mut out: Vec<UnstoredReference> = self.stored_base.iter().filter_map(|(key, base)| {
            let shown = &self.states.get(key)?.reference;
            let stored = base.as_ref().map_or(&Reference::default(), |b| &b.reference).clone();
            if *shown == stored || self.current.get(&key.instrument) != Some(&key.session) {
                return None;
            }
            let fence = self.fences.get(key)?;
            let sequence = fence.source_sequences.values().copied().max()?;
            Some(UnstoredReference { key: key.clone(), generation: fence.generation, sequence, reference: shown.clone() })
        }).collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    /// A reference Market Runtime writes itself from what it holds (`references_not_stored`): into the stored fold, past
    /// the fence, whose sequence it repeats (the provider's numbering goes on above it).
    pub fn apply_held_reference(&mut self, event: &MarketEvent) -> Changed {
        self.fold_validated(event, false).1
    }

    fn fold_validated(&mut self, event: &MarketEvent, live_only: bool) -> (ApplyResult, Changed) {
        let key = event.state_key();
        // A late event of a rolled-over partition is still stored (the WAL keeps everything); it is no longer cached.
        if self.is_rolled(&key) || self.is_cleared(&key.instrument, event.exchange_ts_ns) {
            return (ApplyResult::Control, Changed::default());
        }
        if live_only {
            // The first live-only event: what the partition holds so far is its stored fold.
            if !self.stored_base.contains_key(&key) {
                let base = self.states.get(&key).cloned();
                self.stored_base.insert(key.clone(), base);
            }
        } else if let Some(base) = self.stored_base.get_mut(&key) {
            let base = base.get_or_insert_with(|| SymbolState::empty(key.clone(), event));
            if event.generation > base.generation {
                base.source_sequences.clear();
            }
            base.apply(event);
        }
        let state = self.states.entry(key.clone()).or_insert_with(|| SymbolState::empty(key.clone(), event));
        let before = state.updated_at_ns;
        // A newer source generation is a new broker connection (a reconnect, an App restart), not a new market day:
        // what the session already traded stays. Only the connection's own sequence numbering restarts. Wiping the
        // state here reset the 成交帶 and summary at every intraday reconnect; a print the broker re-sends
        // after reconnecting is still recognised by its cumulative total (last_trade_total_volume).
        if event.generation > state.generation {
            state.source_sequences.clear();
        }
        let changed = state.apply(event);
        if state.updated_at_ns != before || !self.recency.contains(&(before, key.clone())) {
            self.recency.remove(&(before, key.clone()));
            self.recency.insert((state.updated_at_ns, key.clone()));
        }
        let fence = self.fences.entry(key.clone()).or_default();
        if event.generation > fence.generation {
            fence.source_sequences.clear();
        }
        fence.generation = event.generation;
        fence.source_sequences.insert(event.payload.stream_key().to_owned(), event.sequence);
        match self.current.get(&key.instrument) {
            Some(current) if partition_order(current) > partition_order(&key.session) => {}
            _ => {
                if self.current.insert(key.instrument.clone(), key.session.clone()).as_ref() != Some(&key.session) {
                    // The instrument's previous session is no longer pinned.
                    self.pinned_overflow = 0;
                }
            }
        }
        self.evict(Some(&key));
        (ApplyResult::Applied, changed)
    }

    fn is_pinned(&self, key: &StateKey) -> bool {
        self.current.get(&key.instrument) == Some(&key.session) && self.pinned.contains(&key.instrument)
    }

    /// Drops the least recently changed unpinned states until the cache fits. When pinned states alone keep it over
    /// capacity, that overflow is recorded (and reported once) instead of being searched again on every event.
    fn evict(&mut self, protected: Option<&StateKey>) {
        let len = self.states.len();
        if len <= self.capacity || len <= self.pinned_overflow {
            return;
        }
        let overflow = len - self.capacity;
        let victims: Vec<StateKey> = self.recency.iter().map(|(_, k)| k)
            .filter(|k| !self.is_pinned(k) && Some(*k) != protected)
            .take(overflow).cloned().collect();
        for key in &victims {
            if let Some(old) = self.states.remove(key) {
                self.recency.remove(&(old.updated_at_ns, old.key));
            }
            self.stored_base.remove(key);
        }
        // The state just applied is spared this once only: it is not part of the pinned overflow, so the next event
        // evicts it if it is still the least recent unpinned state.
        let spared = usize::from(protected.is_some_and(|k| self.states.contains_key(k) && !self.is_pinned(k)));
        let pinned_left = self.states.len() - spared;
        if pinned_left > self.capacity {
            if !self.overflow_reported {
                eprintln!("[market_runtime] hot state cache holds {pinned_left} pinned states (background list, views, focus), \
                           over its capacity {}", self.capacity);
                self.overflow_reported = true;
            }
            self.pinned_overflow = pinned_left;
        } else {
            self.pinned_overflow = 0;
            self.overflow_reported = false;
        }
    }

    /// Where each code's gap starts in a partition a provider restart interrupted: every code it holds a stored state
    /// of, and every code of `listed` (the background list's codes of its market) it holds none of -- nothing of it is
    /// stored, so its gap starts at the session's open. An index, whose quotes carry no print volume, starts after its
    /// newest quote.
    pub fn gap_starts(&self, source: &str, market: &str, trading_date: &str, session: &str, listed: &[String]) -> Vec<GapStart> {
        let mut starts: BTreeMap<String, GapStart> = BTreeMap::new();
        for (key, state) in &self.states {
            let (i, s) = (&key.instrument, &key.session);
            if !(i.source == source && i.market == market && s.trading_date == trading_date && s.session == session) {
                continue;
            }
            // A live-only partition (off the list) is shown, never stored: there is nothing to fill.
            if self.stored_base.contains_key(key) {
                continue;
            }
            let after_ns = if state.newest_print.exchange_ts_ns > 0 { state.newest_print.exchange_ts_ns } else { state.quote.price_exchange_ts_ns };
            let total_before = match market {
                "STK" if state.newest_print.exchange_ts_ns == 0 => Some(0.0),
                "STK" => state.last_trade_total_volume,
                _ => state.quote.total_volume,
            };
            starts.insert(i.code.clone(), GapStart { market: market.into(), code: i.code.clone(), trading_date: trading_date.into(),
                session: session.into(), after_ns, volume_at_after: state.newest_print.volume_at_ts, total_before });
        }
        for code in listed {
            starts.entry(code.clone()).or_insert_with(|| GapStart { market: market.into(), code: code.clone(), trading_date: trading_date.into(),
                session: session.into(), after_ns: 0, volume_at_after: 0.0, total_before: (market == "STK").then_some(0.0) });
        }
        starts.into_values().collect()
    }

    /// Whether `event`'s partition holds a print of its code yet: a real trade (or a FUT quote with its own volume),
    /// for an index a priced quote. The event that makes it true is the code's first print (late_join.rs).
    pub fn holds_print(&self, event: &MarketEvent) -> bool {
        self.states.get(&event.state_key()).is_some_and(|state| if event.market == "IDX" {
            state.quote.price_exchange_ts_ns > 0
        } else {
            state.newest_print.exchange_ts_ns > 0
        })
    }

    /// Whether this partition of the instrument has any print or index value to show.
    pub fn holds_data(&self, key: &StateKey) -> bool {
        self.states.get(key).is_some_and(|state| state.newest_print.exchange_ts_ns > 0 || state.quote.price_exchange_ts_ns > 0)
    }

    pub fn state(&self, key: &StateKey) -> Option<&SymbolState> {
        self.states.get(key)
    }

    /// Marks a TW stock print (Shioaji STK day session) matched by a call auction or traded 盤後定價, from what this
    /// partition has seen. The flag is stored with the event: B, history and the trade pages read it, nobody guesses
    /// again. A call auction is the print right after 試撮 (the status is `simtrade` until a real print: an intraday
    /// 緩漲緩跌 or 處置股 match, a delayed open), the session's first print at 09:00 (the opening match -- 盤前試撮 is
    /// never stored, so after a restart only the minute and "no print yet" tell it), and the 13:30 closing match.
    /// After 13:30 a print is 盤後定價. A stock first subscribed mid-session is no auction: its first print is not
    /// at 09:00.
    /// A print whose source condition sets no last sale is flagged here too (condition_sets_no_last_sale).
    pub fn classify_print(&self, event: &mut MarketEvent) {
        if let Payload::Trade { condition: Some(condition), no_last_sale, .. } = &mut event.payload {
            *no_last_sale = condition_sets_no_last_sale(condition);
        }
        if !(event.provider.eq_ignore_ascii_case("shioaji") && event.market == "STK" && event.session == "DAY") {
            return;
        }
        let state = self.states.get(&event.state_key());
        let (in_auction, no_print) = state.map_or((false, true), |s| (s.quote.status == "simtrade", s.real_prints == 0));
        let backfill = event.flags.backfill;
        let Payload::Trade { volume, total_volume, simtrade, minute, auction, after_hours, .. } = &mut event.payload else { return };
        if *simtrade || positive_volume(*volume).is_none() || *minute < 0 {
            return;
        }
        if *minute > STOCK_CLOSE_MINUTE {
            *after_hours = true;
        } else if backfill {
            // A gap filled afterwards arrives after the prints around it, so the state says nothing about it: the
            // opening match is the print whose cumulative total is its own volume (the day's first), the closing
            // one is at 13:30. A 試撮 the history does not carry cannot mark an intraday auction.
            let first = positive_volume(*total_volume).is_some_and(|total| crate::volume::eq(total, *volume));
            *auction = *minute == STOCK_CLOSE_MINUTE || (*minute == STOCK_OPEN_MINUTE && first);
        } else {
            *auction = in_auction || *minute == STOCK_CLOSE_MINUTE || (*minute == STOCK_OPEN_MINUTE && no_print);
        }
    }

    /// Recorded events as the ingest would take them today: re-sent prints dropped and call-auction / 盤後定價 prints
    /// flagged where the recording carries no flag (a WAL written before the ingest did both, 10-20). Used by the
    /// materialization job, so a re-run gives the same history as a live day. Returns the kept events and how many
    /// re-sent prints were dropped. Flags already recorded are kept as recorded.
    pub fn classify_recorded(events: Vec<MarketEvent>) -> (Vec<MarketEvent>, u64) {
        let mut engine = Engine::default();
        let mut kept = Vec::with_capacity(events.len());
        let mut resent = 0;
        for mut e in events {
            if engine.print_repeat(&e) == PrintRepeat::Resent {
                resent += 1;
                engine.apply(&e);
                continue;
            }
            if !matches!(&e.payload, Payload::Trade { auction: true, .. } | Payload::Trade { after_hours: true, .. }) {
                engine.classify_print(&mut e);
            }
            engine.apply(&e);
            kept.push(e);
        }
        (kept, resent)
    }

    /// What `event` is next to its partition's newest print (SymbolState::print_repeat).
    pub fn print_repeat(&self, event: &MarketEvent) -> PrintRepeat {
        self.states.get(&event.state_key()).map_or(PrintRepeat::New, |state| state.print_repeat(event))
    }

    pub fn current_session(&self, instrument: &InstrumentKey) -> Option<&SessionKey> {
        self.current.get(instrument)
    }

    /// Resolve a partially specified identity: both given -> exact; neither -> current pointer; one -> newest match.
    pub fn resolve(&self, instrument: &InstrumentKey, trading_date: Option<&str>, session: Option<&str>) -> Option<StateKey> {
        match (trading_date, session) {
            (Some(d), Some(s)) => Some(StateKey {
                instrument: instrument.clone(),
                session: SessionKey { trading_date: d.to_owned(), session: s.to_owned() },
            }),
            (None, None) => self.current.get(instrument).map(|s| StateKey { instrument: instrument.clone(), session: s.clone() }),
            _ => self
                .states
                .keys()
                .filter(|k| {
                    k.instrument == *instrument
                        && trading_date.is_none_or(|d| k.session.trading_date == d)
                        && session.is_none_or(|s| k.session.session.eq_ignore_ascii_case(s))
                })
                .max_by(|a, b| partition_order(&a.session).cmp(&partition_order(&b.session)))
                .cloned()
                // Nothing resident yet (after a rollover, before the session's first event): the session that is
                // now current for that family, empty, rather than an undated key.
                .or_else(|| {
                    let session = session?;
                    let date = self.rolled.get(&family(&instrument.source, &instrument.market, session))?;
                    trading_date.is_none_or(|d| d == date).then(|| StateKey {
                        instrument: instrument.clone(),
                        session: SessionKey { trading_date: date.clone(), session: session.to_uppercase() },
                    })
                }),
        }
    }

    pub fn is_rolled(&self, key: &StateKey) -> bool {
        self.rolled.get(&family(&key.instrument.source, &key.instrument.market, &key.session.session))
            .is_some_and(|cutoff| key.session.trading_date < *cutoff)
    }

    pub fn rolled(&self) -> &BTreeMap<String, String> {
        &self.rolled
    }

    pub fn cleared(&self) -> &BTreeMap<String, i64> {
        &self.cleared
    }

    fn is_cleared(&self, instrument: &InstrumentKey, ts_ns: i64) -> bool {
        ts_ns > 0 && self.cleared.get(&clear_family(&instrument.source, &instrument.market)).is_some_and(|before| ts_ns < *before)
    }

    /// Empties whole families at a moment (rollover::clears): every state of the family whose newest exchange time is
    /// before it leaves -- the same exchange-time rule `apply` and Rust B use, so the two never disagree. Returns those partitions, or None when no clear moved.
    pub fn clear(&mut self, clears: &BTreeMap<String, i64>) -> Option<Vec<StateKey>> {
        let mut moved = false;
        for (family, before) in clears {
            let entry = self.cleared.entry(family.clone()).or_insert(0);
            if *before > *entry {
                *entry = *before;
                moved = true;
            }
        }
        if !moved {
            return None;
        }
        let cleared = &self.cleared;
        let gone: Vec<StateKey> = self.states.iter()
            .filter(|(k, s)| cleared.get(&clear_family(&k.instrument.source, &k.instrument.market))
                .is_some_and(|before| s.exchange_ts_ns.max(s.quote.price_exchange_ts_ns) < *before))
            .map(|(k, _)| k.clone()).collect();
        for key in &gone {
            self.remove_state(key);
            self.fences.remove(key);
        }
        Some(gone)
    }

    /// Whether a cached partition left by rollover or by a clear (projection entries are matched by key only).
    pub fn is_gone(&self, key: &StateKey) -> bool {
        self.is_rolled(key) || (self.cleared.contains_key(&clear_family(&key.instrument.source, &key.instrument.market))
            && !self.states.contains_key(key))
    }

    /// Applies rollover cutoffs (see rollover.rs): every resident partition dated before its family's cutoff leaves
    /// the cache with its fence, and an instrument whose current session was rolled points at the new, still empty,
    /// session. Returns the partitions that left, or None when no cutoff moved.
    pub fn rollover(&mut self, cutoffs: &BTreeMap<String, String>) -> Option<Vec<StateKey>> {
        let mut moved = false;
        for (family, date) in cutoffs {
            let entry = self.rolled.entry(family.clone()).or_default();
            if *date > *entry {
                entry.clone_from(date);
                moved = true;
            }
        }
        if !moved {
            return None;
        }
        let gone: Vec<StateKey> = self.states.keys().filter(|k| self.is_rolled(k)).cloned().collect();
        for key in &gone {
            self.remove_state(key);
        }
        let stale: Vec<StateKey> = self.fences.keys().filter(|k| self.is_rolled(k)).cloned().collect();
        for key in stale {
            self.fences.remove(&key);
        }
        let rolled = &self.rolled;
        for (instrument, session) in self.current.iter_mut() {
            if let Some(cutoff) = rolled.get(&family(&instrument.source, &instrument.market, &session.session)) {
                if session.trading_date < *cutoff {
                    session.trading_date.clone_from(cutoff);
                }
            }
        }
        Some(gone)
    }

    pub fn states_len(&self) -> usize {
        self.states.len()
    }

    /// Partitions whose shown state holds live-only events (each keeps its stored fold apart).
    pub fn live_only_partitions(&self) -> usize {
        self.stored_base.len()
    }

    #[cfg(test)]
    pub fn fences_len(&self) -> usize {
        self.fences.len()
    }

    /// A fence outlives its evicted state so that a provider's resend is still refused; nothing else ever removed
    /// it, so every partition ever seen stayed in memory and in each checkpoint. A fence (and its
    /// `current` pointer) is retired once its state is not resident and its trading date is FENCE_RETENTION_DAYS
    /// behind the newest one seen -- no resend arrives that late. Returns how many fences were retired.
    pub fn retire_stale(&mut self) -> usize {
        // Only real dates take part: one impossible date sorting last would make the cutoff unknowable and stop the
        // cleanup for good.
        let Some(newest) = self.fences.keys().map(|k| k.session.trading_date.as_str())
            .filter(|d| crate::event::parse_calendar_date(d).is_some()).max() else { return 0 };
        let Some(cutoff) = shift_date(newest, -FENCE_RETENTION_DAYS) else { return 0 };
        let states = &self.states;
        let before = self.fences.len();
        self.fences.retain(|k, _| states.contains_key(k) || k.session.trading_date >= cutoff);
        self.current.retain(|instrument, session| {
            session.trading_date >= cutoff || states.contains_key(&StateKey { instrument: instrument.clone(), session: session.clone() })
        });
        before - self.fences.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &SymbolState> {
        self.states.values()
    }

    /// The checkpoint image: every partition's stored fold (its base when it took live-only events) as
    /// `durable_image` keeps it (no 盤前試撮), and the rollover cutoffs.
    pub fn image(&self) -> EngineImage {
        EngineImage {
            states: self.states.values().filter_map(|state| match self.stored_base.get(&state.key) {
                Some(base) => base.as_ref().and_then(SymbolState::durable_image),
                None => state.durable_image(),
            }).collect(),
            fences: self.fences.iter().map(|(k, f)| (k.clone(), f.clone())).collect(),
            current: self.current.iter().map(|(k, s)| (k.clone(), s.clone())).collect(),
            rolled: self.rolled.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            cleared: self.cleared.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        }
    }

    /// The engine a checkpoint image describes, or why the image cannot be one: a state, fence, current pointer or
    /// rollover cutoff naming no real trading date (an older or damaged checkpoint) refuses the whole image -- the
    /// caller rebuilds from the WAL, where such events are refused one by one.
    pub fn from_image(image: EngineImage) -> Result<Self, String> {
        let valid = |date: &str| crate::event::parse_calendar_date(date).is_some();
        let bad = image.states.iter().map(|s| &s.key.session.trading_date)
            .chain(image.fences.iter().map(|(k, _)| &k.session.trading_date))
            .chain(image.current.iter().map(|(_, s)| &s.trading_date))
            .chain(image.rolled.iter().map(|(_, d)| d))
            .find(|d| !valid(d));
        if let Some(date) = bad {
            return Err(format!("checkpoint names trading date {date:?}, which is no calendar date"));
        }
        let mut engine = Engine::default();
        for state in image.states {
            engine.insert_state(state);
        }
        engine.fences = image.fences.into_iter().collect();
        engine.current = image.current.into_iter().collect();
        engine.rolled = image.rolled.into_iter().collect();
        engine.cleared = image.cleared.into_iter().collect();
        Ok(engine)
    }
}

/// Chronological order of partitions. A FUT NIGHT partition is dated by the day it opens, so on one trading date it
/// FOLLOWS that day's DAY: a late DAY event must not pull the current pointer back from NIGHT.
fn partition_order(session: &SessionKey) -> (&str, u8) {
    (session.trading_date.as_str(), u8::from(session.session.eq_ignore_ascii_case("NIGHT")))
}

#[cfg(test)]
pub mod tests_support {
    pub fn trade_event(code: &str, seq: u64, price: i64) -> crate::event::MarketEvent {
        super::tests::trade(code, seq, price, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventFlags;

    pub fn trade(code: &str, seq: u64, price: i64, simtrade: bool) -> MarketEvent {
        MarketEvent {
            schema_version: 2,
            event_id: String::new(),
            durable_sequence: seq,
            symbol: format!("shioaji:STK:{code}"),
            provider: "shioaji".into(),
            market: "STK".into(),
            code: code.into(),
            session: "DAY".into(),
            trading_date: "2026-09-29".into(),
            generation: 1,
            sequence: seq,
            exchange_ts_ns: 1_790_000_000_000_000_000 + seq as i64,
            arrival_ns: 1_790_000_000_000_000_100,
            a_received_ns: 0,
            runtime_epoch: 1,
            time_quality: "exchange".into(),
            trace_id: String::new(),
            flags: EventFlags::default(),
            versions: Default::default(),
            payload: Payload::Trade {
                price, volume: 2.0, total_volume: seq as f64 * 2.0, side: 1, trade_id: seq.to_string(), minute: 570,
                open: 0, high: 0, low: 0, average: 0, total_amount: 0.0, amount: 0.0,
                simtrade, bid_side_total_vol: None, ask_side_total_vol: None, auction: false, after_hours: false, condition: None, no_last_sale: false,
            },
        }
    }

    #[test]
    fn a_checkpoint_image_keeps_each_prints_cumulative_volume() {
        // An image written before Trade had total_volume is a v4 checkpoint, never read (checkpoint.rs); a v5 one
        // carries every print's 總量 through a restart.
        let mut engine = Engine::default();
        engine.apply(&trade("2330", 3, 1_000_000, false));
        let json = serde_json::to_value(engine.image()).unwrap();
        let restored = Engine::from_image(serde_json::from_value(json).unwrap()).unwrap();
        let totals: Vec<Option<f64>> = restored.iter().next().unwrap().recent_trades.iter().map(|t| t.total_volume).collect();
        assert_eq!(totals, vec![Some(6.0)]);
    }

    #[test]
    fn coverage_is_control_it_creates_no_state_and_fences_nothing() {
        // A coverage record (written by Market Runtime, or a provider-written one a WAL recovery reads)
        // never becomes instrument state -- the weekend partitions came from exactly that.
        let mut engine = Engine::default();
        let mut status = trade("2330", 108, 0, false);
        status.generation = 0;
        status.payload = Payload::SourceStatus { state: "subscribed".into(), detail: String::new() };
        assert_eq!(engine.apply(&status).0, ApplyResult::Control);
        assert!(engine.state(&status.state_key()).is_none(), "no state, no view, no session");
        let mut restored = Engine::from_image(engine.image()).unwrap();
        let mut print = trade("2330", 1, 1_000_000, false);
        print.generation = 100;
        assert_eq!(restored.apply(&print).0, ApplyResult::Applied, "coverage leaves no sequence fence behind");
        status.generation = 101;
        assert_eq!(restored.apply(&status).0, ApplyResult::Control);
        assert_eq!(restored.state(&print.state_key()).unwrap().recent_trades.len(), 1, "coverage never touches market state");
        print.generation = 101;
        print.sequence = 1;
        assert_eq!(restored.apply(&print).0, ApplyResult::Applied);
        assert_eq!(restored.apply(&print).0, ApplyResult::RejectedSequence, "real duplicates still rejected");
    }

    #[test]
    fn a_resent_print_adds_no_trade_but_its_stated_gap_is_counted() {
        // The version and the reference must not move before the duplicate is recognised; the gap the
        // producer states on it is lost-event evidence and is still counted.
        let mut engine = Engine::default();
        let first = trade("2344", 1, 1_800_000, false);
        engine.apply(&first);
        let key = first.state_key();
        let before = engine.state(&key).unwrap().clone();
        let mut again = first.clone();
        again.generation = 2;   // a reconnect re-sends the last print
        again.flags.gap_before = 3;
        assert_eq!(engine.print_repeat(&again), PrintRepeat::Resent);
        let (verdict, changed) = engine.apply(&again);
        assert_eq!(verdict, ApplyResult::Applied, "it is stored");
        assert!(changed.quote && !changed.trade && !changed.reference, "only the summary (its gap count) moves");
        let after = engine.state(&key).unwrap();
        assert_eq!(after.source_gaps, before.source_gaps + 3);
        assert_eq!(after.reference.prev_close, before.reference.prev_close);
        assert_eq!(after.quote.current, before.quote.current);
        assert_eq!(after.recent_trades.len(), 1);
    }

    #[test]
    fn a_print_whose_total_did_not_move_is_dropped_only_when_it_is_the_newest_print_again() {
        // Codex 1020-R04-07: "the total did not move" alone dropped prints for good -- a reordered, corrected or
        // simply different print with an unchanged total never reached the WAL.
        let mut engine = Engine::default();
        let first = trade("2344", 1, 1_800_000, false);   // total 2
        engine.apply(&first);
        let total_of = |e: &MarketEvent| match &e.payload { Payload::Trade { total_volume, .. } => *total_volume, _ => 0.0 };
        assert_eq!(total_of(&first), 2.0);
        let with = |f: &dyn Fn(&mut MarketEvent)| { let mut e = first.clone(); e.sequence = 9; f(&mut e); e };
        assert_eq!(engine.print_repeat(&with(&|_| {})), PrintRepeat::Resent, "field for field, same exchange time");
        let other_price = with(&|e| if let Payload::Trade { ref mut price, .. } = e.payload { *price = 1_805_000 });
        assert_eq!(engine.print_repeat(&other_price), PrintRepeat::TotalNotAdvanced);
        let other_volume = with(&|e| if let Payload::Trade { ref mut volume, .. } = e.payload { *volume = 3.0 });
        assert_eq!(engine.print_repeat(&other_volume), PrintRepeat::TotalNotAdvanced);
        let other_time = with(&|e| e.exchange_ts_ns += 5_000_000_000);
        assert_eq!(engine.print_repeat(&other_time), PrintRepeat::TotalNotAdvanced, "a later print with the same values is a print");
        let other_id = with(&|e| if let Payload::Trade { ref mut trade_id, .. } = e.payload { *trade_id = "77".into() });
        assert_eq!(engine.print_repeat(&other_id), PrintRepeat::Resent, "the provider's own counter is no identity");
        // The kept one is applied as the print it says it is, and counted.
        let (_, changed) = engine.apply(&other_time);
        assert!(changed.trade);
        let state = engine.state(&first.state_key()).unwrap();
        assert_eq!((state.recent_trades.len(), state.total_not_advanced), (2, 1));
    }

    #[test]
    fn the_checkpoint_keeps_a_partitions_stored_fold_whichever_way_its_instrument_moved_on_the_list() {
        // Codex 1020-R04-03: a partition that took live-only events put them into the checkpoint with its first
        // stored event -- what no replay of the WAL can rebuild. The image is the stored fold; the screens keep all.
        let replayed = |events: &[&MarketEvent]| {
            let mut engine = Engine::default();
            for e in events {
                engine.apply(e);
            }
            engine.image().states
        };
        let (a, b, c) = (trade("2454", 1, 1_500_000, false), trade("2454", 2, 1_510_000, false), trade("2454", 3, 1_520_000, false));
        let key = a.state_key();

        // Searched first, then listed.
        let mut engine = Engine::default();
        engine.apply_live_only(&a);
        assert!(engine.image().states.is_empty(), "nothing stored yet");
        engine.apply(&b);
        engine.apply(&c);
        assert_eq!(engine.state(&key).unwrap().recent_trades.len(), 3, "shown: every print");
        assert_eq!(engine.image().states, replayed(&[&b, &c]), "imaged: what the WAL holds");

        // Listed first, then off the list (a finished paper order), still looked at.
        let mut engine = Engine::default();
        engine.apply(&a);
        engine.apply_live_only(&b);
        engine.apply_live_only(&c);
        assert_eq!(engine.state(&key).unwrap().quote.current, Some(1_520_000));
        assert_eq!(engine.image().states, replayed(&[&a]));

        // In, out and in again.
        let mut engine = Engine::default();
        engine.apply(&a);
        engine.apply_live_only(&b);
        engine.apply(&c);
        assert_eq!(engine.state(&key).unwrap().recent_trades.len(), 3);
        assert_eq!(engine.image().states, replayed(&[&a, &c]));
        assert_eq!(engine.live_only_partitions(), 1);

        // The stored fold leaves with its partition.
        engine.rollover(&BTreeMap::from([(family("shioaji", "STK", "DAY"), "2026-09-30".to_string())]));
        assert_eq!((engine.states_len(), engine.live_only_partitions()), (0, 0));
    }

    #[test]
    fn a_loss_record_counts_its_gap_on_the_state_like_the_dropped_print_did() {
        let mut engine = Engine::default();
        let first = trade("2344", 1, 1_800_000, false);
        engine.apply(&first);
        let mut record = first.clone();
        record.time_quality = LOSS_CONTROL.into();
        record.flags.gap_before = 4;
        record.payload = Payload::SourceStatus { state: SOURCE_GAP.into(), detail: String::new() };
        let (verdict, changed) = engine.apply(&record);
        assert_eq!(verdict, ApplyResult::Control);
        assert!(changed.quote);
        let state = engine.state(&first.state_key()).unwrap();
        assert_eq!((state.source_gaps, state.recent_trades.len()), (4, 1));
    }

    #[test]
    fn a_new_generation_reference_keeps_the_days_market_data_and_a_new_generation_trade_keeps_its_limits() {
        let mut engine = Engine::default();
        engine.apply(&trade("2344", 1, 1_795_000, false));
        engine.apply(&trade("2344", 2, 1_800_000, false));
        let key = trade("2344", 1, 1_800_000, false).state_key();
        let mut reference = trade("2344", 1, 0, false);
        reference.generation = 2;
        reference.payload = Payload::Reference { limit_up: Some(1_970_000), limit_down: Some(1_620_000), prev_close: None,
                                                 prev_volume: None, reference_price: None, name: None, reference_source: None };
        engine.apply(&reference);
        let state = engine.state(&key).unwrap();
        assert_eq!(state.quote.current, Some(1_800_000), "the App restarting after the close must not wipe the day");
        assert_eq!(state.recent_trades.len(), 2);
        assert_eq!(state.reference.limit_up, Some(1_970_000));
        let mut next = trade("2344", 3, 1_805_000, false);
        next.generation = 2;
        engine.apply(&next);
        assert_eq!(engine.state(&key).unwrap().reference.limit_up, Some(1_970_000), "the day's limits survive the restart");
    }

    #[test]
    fn an_intraday_reconnect_keeps_the_days_tape_and_still_drops_the_re_sent_print() {
        // The first market event of a newer generation (a reconnect) wiped quote, book and 成交帶.
        let mut engine = Engine::default();
        engine.apply(&trade("2344", 1, 1_795_000, false));
        engine.apply(&trade("2344", 2, 1_800_000, false));
        let key = trade("2344", 1, 0, false).state_key();
        let mut resent = trade("2344", 2, 1_800_000, false);
        resent.generation = 2;
        resent.sequence = 1;
        assert_eq!(engine.apply(&resent).0, ApplyResult::Applied, "a new connection's numbering restarts");
        let mut next = trade("2344", 3, 1_805_000, false);
        next.generation = 2;
        next.sequence = 2;
        engine.apply(&next);
        let state = engine.state(&key).unwrap();
        assert_eq!(state.recent_trades.len(), 3, "the day's tape survives, without the re-sent print");
        assert_eq!(state.quote.current, Some(1_805_000));
    }

    #[test]
    fn a_producer_stated_gap_is_counted_on_the_instrument() {
        // Dropped events were invisible; the producer now states them on the next event.
        let mut engine = Engine::default();
        engine.apply(&trade("2330", 1, 1_000_000, false));
        let mut after_drop = trade("2330", 5, 1_001_000, false);
        after_drop.flags.gap_before = 3;
        engine.apply(&after_drop);
        let state = engine.state(&trade("2330", 1, 0, false).state_key()).unwrap();
        assert_eq!(state.source_gaps, 3);
        let wire = crate::wire::summary(state, None);
        assert_eq!(wire["source_gaps"], 3);
    }

    #[test]
    fn a_late_day_event_does_not_pull_the_current_pointer_back_from_the_same_dates_night() {
        // The pointer compared trading_date only, so a 13:45 DAY print arriving after 15:00 made the
        // TXF snapshot jump back to the day session.
        let fut = |seq: u64, session: &str| {
            let mut e = trade("TXFR1", seq, 2_300_000_000, false);
            e.symbol = "shioaji:FUT:TXFR1".into();
            e.market = "FUT".into();
            e.session = session.into();
            e.trading_date = "2026-10-01".into();
            e
        };
        let mut engine = Engine::default();
        engine.apply(&fut(1, "DAY"));
        engine.apply(&fut(1, "NIGHT"));
        engine.apply(&fut(2, "DAY"));
        let instrument = fut(1, "DAY").state_key().instrument;
        assert_eq!(engine.current_session(&instrument).unwrap().session, "NIGHT");
        assert_eq!(engine.resolve(&instrument, Some("2026-10-01"), None).unwrap().session.session, "NIGHT");
    }

    #[test]
    fn a_print_that_does_not_move_the_cumulative_volume_is_not_a_new_trade() {
        // 2344: at 14:30 the broker re-sent the 13:30 closing print (total_volume 82,884 again) before
        // the after-hours print; the tape showed 5,371 twice.
        let with = |seq: u64, volume: f64, total: f64| {
            let mut e = trade("2344", seq, 1_795_000, false);
            if let Payload::Trade { volume: ref mut v, total_volume: ref mut t, .. } = e.payload {
                *v = volume;
                *t = total;
            }
            e
        };
        let at = |mut e: MarketEvent, minute: i32, auction: bool| {
            if let Payload::Trade { minute: ref mut m, auction: ref mut a, .. } = e.payload {
                *m = minute;
                *a = auction;
            }
            e
        };
        let mut engine = Engine::default();
        engine.apply(&at(with(1, 5371.0, 82_884.0), 810, true));
        engine.apply(&at(with(2, 5371.0, 82_884.0), 870, false));
        engine.apply(&at(with(3, 351.0, 83_235.0), 870, false));
        let state = engine.state(&with(1, 0.0, 0.0).state_key()).unwrap();
        let tape: Vec<f64> = state.recent_trades.iter().map(|t| t.volume).collect();
        assert_eq!(tape, vec![5371.0, 351.0], "the re-sent closing print is not a second trade");
        assert_eq!(state.quote.total_volume, Some(83_235.0));

        // Volumes are decimals now: a resend whose total differs from the known one only by binary noise is still a
        // resend, and a real (fractional) increase is still a trade -- never dropped as a duplicate.
        let again = |e: MarketEvent, seq: u64, total: f64| {
            let mut copy = e.clone();
            copy.sequence = seq;
            if let Payload::Trade { total_volume: ref mut t, .. } = copy.payload {
                *t = total;
            }
            copy
        };
        let mut engine = Engine::default();
        let first = with(1, 0.1, 0.1 + 0.2);
        engine.apply(&first);
        engine.apply(&again(first, 2, 0.3));
        engine.apply(&with(3, 0.25, 0.55));
        engine.apply(&with(4, 0.0001, 0.5501));
        let state = engine.state(&with(1, 0.0, 0.0).state_key()).unwrap();
        let tape: Vec<f64> = state.recent_trades.iter().map(|t| t.volume).collect();
        assert_eq!(tape, vec![0.1, 0.25, 0.0001], "noise-only resend dropped; every real fractional print kept");

        // A Futu ticker has no cumulative volume; a smaller print is still a trade.
        let futu = |seq: u64, volume: f64| {
            let mut e = with(seq, volume, volume);
            e.provider = "futu".into();
            e.symbol = "futu:US:US.AAPL".into();
            e.code = "US.AAPL".into();
            e.market = "US".into();
            e
        };
        let mut engine = Engine::default();
        engine.apply(&futu(1, 3.0));
        engine.apply(&futu(2, 2.0));
        // US fractional-share prints (0.25 shares must not truncate to 0 in the 成交明細).
        engine.apply(&futu(3, 0.25));
        engine.apply(&futu(4, 0.25));
        let state = engine.state(&futu(1, 0.0).state_key()).unwrap();
        assert_eq!(state.recent_trades.iter().map(|t| t.volume).collect::<Vec<_>>(), vec![3.0, 2.0, 0.25, 0.25]);
        let wire = crate::wire::applied_trade(state);
        assert_eq!(wire["volume"], serde_json::json!(0.25), "a positive fractional size is never 0 on the wire");
    }

    #[test]
    fn change_uses_the_reference_and_is_unavailable_without_one() {
        let mut engine = Engine::default();
        engine.apply(&previous_close("2330", 1_000_000));
        engine.apply(&trade("2330", 1, 1_050_000, false));
        let key = trade("2330", 1, 0, false).state_key();
        let (change, pct) = engine.state(&key).unwrap().change().unwrap();
        assert_eq!(change, 50_000);
        assert!((pct - 5.0).abs() < 1e-9);
        let no_ref = trade("2317", 1, 1_050_000, false);
        engine.apply(&no_ref);
        assert_eq!(engine.state(&no_ref.state_key()).unwrap().change(), None);
    }

    /// A Reference event carrying `prev_close` for `code`'s partition (trade()'s).
    fn previous_close(code: &str, prev_close: i64) -> MarketEvent {
        let mut reference = trade(code, 1, 0, false);
        reference.payload = Payload::Reference { limit_up: None, limit_down: None, prev_close: Some(prev_close), prev_volume: None,
                                                 reference_price: None, name: None, reference_source: None };
        reference
    }

    #[test]
    fn only_a_reference_event_moves_the_previous_close() {
        // D01-02: a quote or a print that still names a 昨收 (an older WAL record, a producer not yet changed) moves
        // nothing: the Reference event is its one source, so arrival order can never pick between two values.
        let mut engine = Engine::default();
        let mut print = serde_json::to_value(trade("2330", 1, 1_050_000, false)).unwrap();
        print["payload"]["prev_close"] = serde_json::json!(990_000);
        let print: MarketEvent = serde_json::from_value(print).unwrap();
        engine.apply(&previous_close("2330", 1_000_000));
        engine.apply(&print);
        let mut quote = serde_json::to_value(trade("2330", 2, 0, false)).unwrap();
        quote["payload"] = serde_json::json!({"kind": "quote", "current": 1_060_000, "prev_close": 980_000, "open": 0, "high": 0,
            "low": 0, "total_volume": 0.0, "total_amount": 0.0, "status": "live", "minute": 570, "average": 0, "volume": 0.0, "amount": 0.0});
        engine.apply(&serde_json::from_value::<MarketEvent>(quote).unwrap());
        let state = engine.state(&print.state_key()).unwrap();
        assert_eq!(state.reference.prev_close, Some(1_000_000));
        assert_eq!(state.change().map(|(c, _)| c), Some(60_000));
        let mut newer = previous_close("2330", 1_010_000);
        newer.sequence = 2;
        engine.apply(&newer);
        assert_eq!(engine.state(&print.state_key()).unwrap().reference.prev_close, Some(1_010_000), "a newer reference replaces it");
    }

    #[test]
    fn a_simtrade_is_on_the_tape_but_never_the_current_price() {
        let mut engine = Engine::default();
        engine.apply(&trade("2330", 1, 1_000_000, false));
        engine.apply(&trade("2330", 2, 1_100_000, true));
        let state = engine.state(&trade("2330", 1, 0, false).state_key()).unwrap();
        assert_eq!(state.quote.current, Some(1_000_000));
        assert_eq!(state.quote.indicative_price, Some(1_100_000));
        assert!(state.recent_trades.back().unwrap().simtrade);
        // Mid-session auction (緩漲緩跌 / closing 試撮): the status says so although the day already traded...
        assert_eq!(state.quote.status, "simtrade");
        // ...and the next real print ends it.
        engine.apply(&trade("2330", 3, 1_050_000, false));
        let state = engine.state(&trade("2330", 1, 0, false).state_key()).unwrap();
        assert_eq!((state.quote.status.as_str(), state.quote.indicative_price, state.quote.current), ("live", None, Some(1_050_000)));
    }

    #[test]
    fn futu_current_is_the_newest_print_and_its_day_range_the_quotes_regular_session_figures() {
        // D01-01 (user 11-02, option B): trade, quote and minute bar all wrote 現價 and the range, and a same-second
        // quote / bar arriving after a print put its own price back on screen.
        let event = |seq: u64, ts: i64, payload: serde_json::Value| -> MarketEvent {
            let mut e = serde_json::to_value(trade("X", seq, 0, false)).unwrap();
            e["provider"] = serde_json::json!("futu");
            e["symbol"] = serde_json::json!("futu:US:US.AAPL");
            e["market"] = serde_json::json!("US");
            e["code"] = serde_json::json!("US.AAPL");
            e["exchange_ts_ns"] = serde_json::json!(ts);
            e["payload"] = payload;
            serde_json::from_value(e).unwrap()
        };
        let print = |seq: u64, ts: i64, price: i64| event(seq, ts, serde_json::json!({"kind": "trade", "price": price, "volume": 1.0,
            "total_volume": 0.0, "side": 1, "trade_id": seq.to_string(), "minute": 600, "open": 0, "high": 0, "low": 0,
            "average": 0, "total_amount": 0.0, "amount": 0.0}));
        let mut engine = Engine::default();
        // Pre-market prints: 現價 moves, the day range stays blank until the regular session's quote.
        engine.apply(&print(1, 100, 2_000_000));
        let key = print(1, 100, 0).state_key();
        let q = &engine.state(&key).unwrap().quote;
        assert_eq!((q.current, q.open, q.high, q.low), (Some(2_000_000), None, None, None));
        engine.apply(&print(2, 200, 2_100_000));
        // The regular session's quote, same second as the print, with its own last price: it sets the range, not 現價.
        engine.apply(&event(3, 200, serde_json::json!({"kind": "quote", "current": 2_050_000, "open": 2_010_000, "high": 2_060_000,
            "low": 2_000_000, "total_volume": 100.0, "total_amount": 0.0, "status": "live", "minute": 570, "average": 0,
            "volume": 0.0, "amount": 0.0})));
        // A minute bar is Rust B's: it moves nothing here.
        engine.apply(&event(4, 300, serde_json::json!({"kind": "minute_bar", "minute": 571, "open": 1_900_000, "high": 2_500_000,
            "low": 1_800_000, "close": 2_400_000, "average": 0, "volume": 5.0, "amount": 0.0})));
        let q = &engine.state(&key).unwrap().quote;
        assert_eq!((q.current, q.open, q.high, q.low), (Some(2_100_000), Some(2_010_000), Some(2_060_000), Some(2_000_000)));
        assert_eq!(q.total_volume, Some(100.0), "the quote keeps its own fields");
    }

    #[test]
    fn a_print_whose_condition_sets_no_last_sale_is_on_the_tape_without_a_side_and_moves_no_price() {
        // 11-06 US.TSM: odd lots at exactly 昨收 353.10 before the open and 392.26 / 350.09 prints after hours (OpenD
        // TickerType ODD_LOT / AVERAGE_PRICE...) were each taken as 現價 and spiked the trend line.
        let print = |seq: u64, ts: i64, price: i64, condition: Option<&str>| -> MarketEvent {
            let mut e = serde_json::to_value(trade("X", seq, 0, false)).unwrap();
            e["provider"] = serde_json::json!("futu");
            e["symbol"] = serde_json::json!("futu:US:US.TSM");
            e["market"] = serde_json::json!("US");
            e["code"] = serde_json::json!("US.TSM");
            e["exchange_ts_ns"] = serde_json::json!(ts);
            let mut payload = serde_json::json!({"kind": "trade", "price": price, "volume": 0.25, "total_volume": 0.0, "side": 1,
                "trade_id": seq.to_string(), "minute": 456, "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0});
            if let Some(c) = condition {
                payload["condition"] = serde_json::json!(c);
            }
            e["payload"] = payload;
            serde_json::from_value(e).unwrap()
        };
        let mut engine = Engine::default();
        let ingest = |engine: &mut Engine, mut e: MarketEvent| -> MarketEvent {
            engine.classify_print(&mut e);
            engine.apply(&e);
            e
        };
        let regular = ingest(&mut engine, print(1, 100, 3_600_000, Some("AUTO_MATCH")));
        let unnamed = ingest(&mut engine, print(2, 200, 3_610_000, None));
        let odd = ingest(&mut engine, print(3, 300, 3_531_000, Some("ODD_LOT")));
        let average = ingest(&mut engine, print(4, 400, 3_922_600, Some("average_price")));
        let flag = |e: &MarketEvent| match &e.payload { Payload::Trade { no_last_sale, .. } => *no_last_sale, _ => panic!() };
        assert_eq!([&regular, &unnamed, &odd, &average].map(flag), [false, false, true, true]);
        let state = engine.state(&regular.state_key()).unwrap();
        assert_eq!(state.quote.current, Some(3_610_000), "only regular prints set 現價");
        let tape: Vec<(i64, i8, bool)> = state.recent_trades.iter().map(|t| (t.price, t.side, t.no_last_sale)).collect();
        assert_eq!(tape, vec![(3_600_000, 1, false), (3_610_000, 1, false), (3_531_000, 0, true), (3_922_600, 0, true)],
            "kept on the tape, 不分內外盤");
        // Stored with the event: the WAL record carries the raw condition and the flag, and a recording read again
        // (the materialization job) is flagged the same.
        let stored = serde_json::to_value(&odd).unwrap();
        assert_eq!((stored["payload"]["condition"].as_str(), stored["payload"]["no_last_sale"].as_bool()), (Some("ODD_LOT"), Some(true)));
        assert!(serde_json::to_value(&regular).unwrap()["payload"].get("no_last_sale").is_none(), "absent = false");
        let (kept, _) = Engine::classify_recorded(vec![print(1, 100, 3_600_000, Some("AUTO_MATCH")), print(2, 200, 3_531_000, Some("ODD_LOT"))]);
        assert_eq!(kept.iter().map(flag).collect::<Vec<_>>(), vec![false, true]);
        let row = crate::wire::trades(state)[2].clone();
        assert_eq!((row["side"].as_str(), row["no_last_sale"].as_bool()), (Some("NEUTRAL"), Some(true)));
    }

    #[test]
    fn the_conditions_that_set_no_last_sale() {
        for c in ["ODD_LOT", "ODD_LOT_CROSS_MARKET", "AVERAGE_PRICE", "PRIOR_REFERENCE_PRICE", "DERIVATIVELY_PRICED", "NEXT_DAY",
                  "SELLER", "CONTINGENT", "MARKET_CENTER_CLOSE_PRICE", "MARKET_CENTER_OPEN_PRICE"] {
            assert!(condition_sets_no_last_sale(c), "{c}");
        }
        // A regular print of any session sets it (the extended sessions' too).
        for c in ["AUTO_MATCH", "EXTENDED_TRADING_HOURS", "LATE", "CROSS_MARKET", "UNKNOWN", ""] {
            assert!(!condition_sets_no_last_sale(c), "{c}");
        }
    }

    #[test]
    fn a_book_level_change_is_the_same_price_difference_whatever_the_source_sent() {
        // D01-05: Shioaji's diff_bid_vol is by array index; when the ladder moved, index 0 compared two prices. A took
        // it when present and derived the same-price difference otherwise, so the 量差 animation changed meaning with
        // the SDK. A source's `diff` is no part of a level now (an older record that has one reads without it).
        let book = |seq: u64, bids: serde_json::Value| -> MarketEvent {
            let mut e = serde_json::to_value(trade("2330", seq, 0, false)).unwrap();
            e["payload"] = serde_json::json!({"kind": "order_book", "bids": bids, "asks": []});
            serde_json::from_value(e).unwrap()
        };
        let mut engine = Engine::default();
        engine.apply(&book(1, serde_json::json!([{"price": 1_000_000, "volume": 5.0}, {"price": 995_000, "volume": 8.0}])));
        let key = trade("2330", 1, 0, false).state_key();
        assert_eq!(engine.state(&key).unwrap().book.bids[0].diff, None, "the partition's first book has nothing to compare");
        // The ladder moves up a tick: index 0 is a new price (the SDK would say 7 - 5 = +2 by index).
        engine.apply(&book(2, serde_json::json!([{"price": 1_005_000, "volume": 7.0, "diff": 2.0},
                                                 {"price": 1_000_000, "volume": 6.0, "diff": -2.0}])));
        let bids = &engine.state(&key).unwrap().book.bids;
        assert_eq!((bids[0].diff, bids[1].diff), (Some(7.0), Some(1.0)), "a new price shows its whole volume; 5 -> 6 at 100.00");
    }

    #[test]
    fn the_change_follows_the_shown_price_through_a_call_auction() {
        // D01-04: the renderer derived 試撮 漲跌 itself (displayQuote) because A's change ignored the indicative price, and
        // every panel then computed its own. A's change is the one: the shown price against the reference.
        let mut engine = Engine::default();
        engine.apply(&previous_close("2330", 1_000_000));
        engine.apply(&trade("2330", 1, 1_010_000, false));
        engine.apply(&trade("2330", 2, 1_030_000, true));
        let key = trade("2330", 1, 0, false).state_key();
        let state = engine.state(&key).unwrap();
        assert_eq!((state.shown_price(), state.change().map(|(c, _)| c)), (Some(1_030_000), Some(30_000)), "試撮 #103.00 is +3.00");
        let wire = crate::wire::summary(state, None);
        assert_eq!((wire["change"].as_f64(), wire["current"].as_f64()), (Some(3.0), Some(101.0)), "現價 stays the last print");
        engine.apply(&trade("2330", 3, 1_020_000, false));
        assert_eq!(engine.state(&key).unwrap().change().map(|(c, _)| c), Some(20_000), "the next real print ends the auction");
    }

    #[test]
    fn an_impossible_trading_date_enters_the_engine_by_no_door() {
        // Only live ingest refused one: a WAL record or checkpoint written before that became a partition at
        // recovery, and sorting last it stopped retire_stale() for good.
        let on = |code: &str, seq: u64, date: &str| {
            let mut e = trade(code, seq, 1_000_000, false);
            e.trading_date = date.into();
            e
        };
        let mut engine = Engine::default();
        assert_eq!(engine.apply(&on("2330", 1, "2026-10-32")).0, ApplyResult::RejectedInvalidDate);
        assert_eq!(engine.apply(&on("2330", 2, "2026-02-29")).0, ApplyResult::RejectedInvalidDate, "2026 is not a leap year");
        assert_eq!(engine.fences_len(), 0, "nothing of them was kept");
        engine.apply(&on("1101", 5, "2026-09-20"));
        engine.apply(&on("1102", 5, "2026-09-29"));
        let mut image = engine.image();
        image.fences[0].0.session.trading_date = "2026-10-32".into();
        let refused = Engine::from_image(image).err().expect("an image naming an impossible date is refused whole");
        assert!(refused.contains("2026-10-32"), "{refused}");
        let mut image = engine.image();
        image.rolled.push(("shioaji|STK|DAY".into(), "garbage".into()));
        assert!(Engine::from_image(image).is_err(), "a rollover cutoff too");
    }

    #[test]
    fn eviction_drops_the_least_recently_changed_unpinned_states_and_records_pinned_overflow() {
        let at = |code: &str, seq: u64, arrival: u64| {
            let mut e = trade(code, seq, 1_000_000, false);
            e.arrival_ns = arrival;
            e
        };
        let mut engine = Engine::default();
        engine.set_capacity(2);
        engine.apply(&at("1101", 1, 10));
        engine.apply(&at("1102", 1, 20));
        engine.apply(&at("1101", 2, 30));   // 1101 is now the more recent
        engine.apply(&at("1103", 1, 40));
        let resident = |e: &Engine| { let mut v: Vec<String> = e.iter().map(|s| s.key.instrument.code.clone()).collect(); v.sort(); v };
        assert_eq!(resident(&engine), vec!["1101", "1103"], "the least recently changed state left");
        assert_eq!(engine.recency.len(), engine.states_len());

        // Pinned states alone over capacity: kept, counted, and not searched again on every event.
        let pinned: BTreeSet<InstrumentKey> = ["1101", "1103", "1104"].iter().map(|c| at(c, 1, 0).instrument()).collect();
        engine.set_pinned(pinned);
        engine.apply(&at("1104", 1, 50));
        assert_eq!(resident(&engine), vec!["1101", "1103", "1104"]);
        assert_eq!(engine.over_capacity(), 1);
        assert_eq!(engine.pinned_overflow, 3);
        engine.apply(&at("1105", 1, 60));
        assert_eq!(resident(&engine).len(), 4, "the state just applied is spared once");
        engine.apply(&at("1101", 3, 65));
        assert_eq!(resident(&engine), vec!["1101", "1103", "1104"], "the next event evicts the unpinned newcomer");
        engine.set_pinned(BTreeSet::new());
        engine.apply(&at("1101", 4, 70));
        assert_eq!(resident(&engine), vec!["1101", "1104"], "unpinned again: back under capacity");
        assert_eq!(engine.over_capacity(), 0);
        assert_eq!(engine.recency.len(), engine.states_len());
    }

    #[test]
    fn fences_of_long_gone_evicted_partitions_are_retired_recent_ones_still_refuse_resends() {
        // Evict() dropped states only, so every fence ever seen stayed in memory and every checkpoint.
        let on = |code: &str, seq: u64, date: &str| {
            let mut e = trade(code, seq, 1_000_000, false);
            e.trading_date = date.into();
            e
        };
        let mut engine = Engine::default();
        engine.set_capacity(1);
        engine.apply(&on("1101", 5, "2026-09-20"));
        engine.apply(&on("1102", 5, "2026-09-28"));
        engine.apply(&on("1103", 5, "2026-09-29"));
        assert_eq!((engine.states_len(), engine.fences_len()), (1, 3), "evicted states keep their fences");

        assert_eq!(engine.retire_stale(), 1);
        assert_eq!(engine.validate(&on("1102", 5, "2026-09-28")), ApplyResult::RejectedSequence, "a recent evicted partition still refuses resends");
        assert!(engine.current_session(&on("1101", 5, "2026-09-20").instrument()).is_none());
        assert_eq!(Engine::from_image(engine.image()).unwrap().fences_len(), 2, "the checkpoint no longer carries it");
        assert_eq!(shift_date("2026-10-02", -3).as_deref(), Some("2026-09-29"));
        // A day that does not exist in its month is refused, not normalized into the next month.
        assert_eq!(shift_date("2026-02-31", -3), None);
        assert_eq!(shift_date("2026-04-31", 0), None);
        assert_eq!(shift_date("2026-02-29", 0), None, "2026 is not a leap year");
        assert_eq!(shift_date("2028-02-29", 1).as_deref(), Some("2028-03-01"), "2028 is");
        assert_eq!(shift_date("2100-02-29", 0), None, "a century year is not, unless divisible by 400");
        assert_eq!(shift_date("2000-02-29", 0).as_deref(), Some("2000-02-29"));
        assert_eq!(shift_date("2026-1-05", 0), None);
        assert_eq!(shift_date("2026-10-0x", 0), None);
        assert_eq!(shift_date("2026-9-2", -3), None);
    }

    #[test]
    fn an_older_price_or_book_arriving_later_is_stored_but_never_shown_over_a_newer_one() {
        // Sequence orders arrival, not the market; a reordered callback put an older price back on screen.
        let mut engine = Engine::default();
        let mut newer = trade("2330", 1, 1_010_000, false);
        newer.exchange_ts_ns = 2_000;
        engine.apply(&newer);
        let mut older = trade("2330", 2, 990_000, false);
        older.exchange_ts_ns = 1_000;
        // No cumulative total (a Futu ticker): the re-send check cannot tell, so the exchange time must.
        if let Payload::Trade { total_volume, .. } = &mut older.payload { *total_volume = 0.0; }
        assert_eq!(engine.apply(&older).0, ApplyResult::Applied, "still accepted and stored");
        let key = newer.state_key();
        let state = engine.state(&key).unwrap();
        assert_eq!(state.quote.current, Some(1_010_000), "the newer price stays");
        assert_eq!(state.quote.low, Some(990_000), "the older print still counts for the day's low");
        assert_eq!(state.recent_trades.len(), 2, "the tape keeps every print");
        assert_eq!(state.stale_latest_updates, 1);

        let book = |seq: u64, ts: i64, price: i64| {
            let mut e = trade("2330", seq, 0, false);
            e.exchange_ts_ns = ts;
            e.payload = Payload::OrderBook { bids: vec![BookLevel { price, volume: 1.0 }], asks: vec![], simtrade: false };
            e
        };
        engine.apply(&book(3, 3_000, 1_005_000));
        engine.apply(&book(4, 2_500, 1_001_000));
        assert_eq!(engine.state(&key).unwrap().book.bids[0].price, 1_005_000, "an older book does not replace a newer one");
    }

    #[test]
    fn tape_is_bounded_to_100_and_fences_reject_resends() {
        let mut engine = Engine::default();
        for seq in 1..=150 {
            engine.apply(&trade("2330", seq, 1_000_000 + seq as i64, false));
        }
        let key = trade("2330", 1, 0, false).state_key();
        assert_eq!(engine.state(&key).unwrap().recent_trades.len(), RECENT_TRADES);
        assert_eq!(engine.apply(&trade("2330", 150, 1, false)).0, ApplyResult::RejectedSequence);
        let image = engine.image();
        let restored = Engine::from_image(image).unwrap();
        assert_eq!(restored.validate(&trade("2330", 150, 1, false)), ApplyResult::RejectedSequence);
        assert_eq!(restored.state(&key).unwrap().quote.current, Some(1_000_150));
    }

    fn at(code: &str, date: &str, seq: u64, minute: i64, simtrade: bool) -> MarketEvent {
        let mut e = trade(code, seq, 1_010_000 + seq as i64, simtrade);
        e.trading_date = date.into();
        let (y, m, d) = (date[0..4].parse().unwrap(), date[5..7].parse().unwrap(), date[8..10].parse().unwrap());
        e.exchange_ts_ns = crate::rollover::taipei_ns((y, m, d), minute) + seq as i64;
        if simtrade && crate::event::preopen_at("STK", e.exchange_ts_ns) {
            e.durable_sequence = 0;
        }
        e
    }

    fn cutoff(date: &str) -> BTreeMap<String, String> {
        BTreeMap::from([(family("shioaji", "STK", "DAY"), date.to_owned())])
    }

    #[test]
    fn rollover_drops_the_previous_session_and_points_at_the_new_one() {
        let mut engine = Engine::default();
        engine.apply(&at("2330", "2026-10-05", 1, 600, false));
        engine.apply(&at("2317", "2026-10-05", 2, 600, false));
        let gone = engine.rollover(&cutoff("2026-10-06")).unwrap();
        assert_eq!(gone.len(), 2);
        assert_eq!(engine.states_len(), 0);
        assert_eq!(engine.fences_len(), 0);
        let instrument = InstrumentKey::new("shioaji", "STK", "2330");
        // No 試撮 for 2330: it still switches, to the new empty session.
        assert_eq!(engine.current_session(&instrument).unwrap().trading_date, "2026-10-06");
        let resolved = engine.resolve(&instrument, None, Some("DAY")).unwrap();
        assert_eq!(resolved.session.trading_date, "2026-10-06");
        assert!(engine.state(&resolved).is_none());
        // A cutoff that does not move is a no-op; a late event of the rolled session is stored, not cached.
        assert!(engine.rollover(&cutoff("2026-10-06")).is_none());
        assert_eq!(engine.apply(&at("2330", "2026-10-05", 3, 610, false)).0, ApplyResult::Control);
        assert_eq!(engine.states_len(), 0);
        // The cutoffs survive a checkpoint.
        let restored = Engine::from_image(engine.image()).unwrap();
        assert_eq!(restored.rolled().get(&family("shioaji", "STK", "DAY")).map(String::as_str), Some("2026-10-06"));
    }

    #[test]
    fn checkpoint_leaves_preopen_simtrade_out_but_keeps_auctions() {
        let mut engine = Engine::default();
        // Only pre-open 試撮 so far: shown live, absent from the image.
        engine.apply(&at("2330", "2026-10-06", 1, 8 * 60 + 40, true));
        assert_eq!(engine.states_len(), 1);
        assert!(engine.image().states.is_empty());
        // A durable reference arrives in the pre-open: the partition is kept, its 試撮 is not.
        let mut reference = at("2330", "2026-10-06", 2, 8 * 60 + 41, false);
        reference.payload = Payload::Reference { limit_up: Some(1_100_000), limit_down: Some(900_000), prev_close: None,
            prev_volume: None, reference_price: None, name: None, reference_source: None };
        engine.apply(&reference);
        let image = engine.image();
        let kept = &image.states[0];
        assert!(kept.recent_trades.is_empty());
        assert_eq!(kept.quote.indicative_price, None);
        assert_eq!(kept.reference.limit_up, Some(1_100_000));
        // After the open: real prints and the 13:25 closing auction are stored data and stay.
        engine.apply(&at("2330", "2026-10-06", 3, 9 * 60, false));
        engine.apply(&at("2330", "2026-10-06", 4, 13 * 60 + 26, true));
        let image = engine.image();
        let tape: Vec<bool> = image.states[0].recent_trades.iter().map(|t| t.simtrade).collect();
        assert_eq!(tape, vec![false, true]);
        assert!(image.states[0].quote.indicative_price.is_some());
        // The live state still shows the pre-open row.
        let live = engine.iter().next().unwrap();
        assert_eq!(live.recent_trades.len(), 3);
    }

    #[test]
    fn crypto_is_checkpointed_whole_and_cleared_by_exchange_time() {
        let mut engine = Engine::default();
        let mut print = at("CC.BTCUSD", "2026-10-06", 1, 15 * 60, false);
        (print.provider, print.market, print.session, print.symbol) = ("futu".into(), "CC".into(), "FULL".into(), "futu:CC:CC.BTCUSD".into());
        print.durable_sequence = 0;
        engine.apply(&print);
        assert_eq!(engine.image().states.len(), 1, "never stored, but its cache survives a restart");
        // Stamped before midnight, arriving after it: cleared all the same (exchange time decides, as in Rust B).
        let midnight = print.exchange_ts_ns + 1;
        let cleared = engine.clear(&BTreeMap::from([("futu|CC".to_string(), midnight)])).unwrap();
        assert_eq!(cleared.len(), 1);
        assert_eq!(engine.apply(&print).0, ApplyResult::Control, "a late pre-midnight print does not come back");
    }

    #[test]
    fn a_simulated_futures_quote_leaves_the_checkpoint_whole_but_a_real_index_quote_stays() {
        let quote = |market: &str, code: &str, seq: u64, minute: i64, status: &str, durable: u64| {
            let mut e = at(code, "2026-10-06", seq, minute, false);
            (e.market, e.symbol, e.durable_sequence) = (market.into(), format!("shioaji:{market}:{code}"), durable);
            e.payload = Payload::Quote { current: 2_300_000_000, open: 2_300_000_000, high: 2_301_000_000,
                low: 2_299_000_000, total_volume: 12.0, total_amount: 0.0, status: status.into(), minute: minute as i32,
                average: 2_300_000_000, advance_count: None, decline_count: None, flat_count: None, limit_up_count: None,
                limit_down_count: None, volume: 0.0, amount: 0.0 };
            e
        };
        let mut engine = Engine::default();
        let mut reference = quote("FUT", "TXFR1", 1, 8 * 60 + 31, "live", 1);
        reference.payload = Payload::Reference { limit_up: Some(1), limit_down: Some(1), prev_close: None, prev_volume: None,
            reference_price: None, name: None, reference_source: None };
        engine.apply(&reference);
        engine.apply(&quote("FUT", "TXFR1", 2, 8 * 60 + 40, "simulated", 0));
        let image = engine.image();
        let q = &image.states[0].quote;
        assert_eq!((q.current, q.high, q.total_volume, q.average, q.status.as_str()), (None, None, None, None, ""));
        let mut engine = Engine::default();
        engine.apply(&quote("IDX", "TAIEX", 1, 8 * 60 + 40, "live", 1));
        assert!(engine.image().states[0].quote.current.is_some(), "a real (stored) pre-open quote is not 試撮");
    }

    #[test]
    fn a_simulated_futures_quote_is_an_indicative_price_and_never_moves_the_session_range() {
        // 10-27 night: 14:50-15:00 試撮 quotes carried 46588 / 45701, and 最高 / 最低 kept them all night.
        let quote = |seq: u64, minute: i64, status: &str, price: i64, high: i64, low: i64| {
            let mut e = at("TXFR1", "2026-10-27", seq, minute, false);
            (e.market, e.session, e.symbol) = ("FUT".into(), "NIGHT".into(), "shioaji:FUT:TXFR1".into());
            e.durable_sequence = if status == "simulated" { 0 } else { seq };
            e.payload = Payload::Quote { current: price, open: high, high, low, total_volume: 3.0,
                total_amount: 0.0, status: status.into(), minute: minute as i32, average: price, advance_count: None,
                decline_count: None, flat_count: None, limit_up_count: None, limit_down_count: None, volume: 0.0, amount: 0.0 };
            e
        };
        let mut engine = Engine::default();
        engine.apply(&quote(1, 14 * 60 + 55, "simulated", 46_080_000_000, 46_588_000_000, 45_701_000_000));
        let q = &engine.iter().next().unwrap().quote;
        assert_eq!((q.current, q.open, q.high, q.low, q.total_volume, q.average), (None, None, None, None, None, None));
        assert_eq!((q.indicative_price, q.status.as_str()), (Some(46_080_000_000), "simulated"));
        // The open: the session's range is the real quote's alone, and the auction is over.
        engine.apply(&quote(2, 15 * 60, "live", 46_080_000_000, 46_100_000_000, 46_050_000_000));
        let q = &engine.iter().next().unwrap().quote;
        assert_eq!((q.current, q.open, q.high, q.low), (Some(46_080_000_000), Some(46_100_000_000), Some(46_100_000_000), Some(46_050_000_000)));
        assert_eq!((q.indicative_price, q.status.as_str()), (None, "live"));
    }

    fn print_at(code: &str, seq: u64, minute: i32, simtrade: bool, volume: f64, total: f64, sides: (f64, f64)) -> MarketEvent {
        let mut e = trade(code, seq, 1_000_000, simtrade);
        if let Payload::Trade { minute: ref mut m, volume: ref mut v, total_volume: ref mut t, side: ref mut sd,
                                bid_side_total_vol: ref mut b, ask_side_total_vol: ref mut a, .. } = e.payload {
            *m = minute;
            *v = volume;
            *t = total;
            *sd = if sides.0 > 0.0 { 1 } else { 2 };
            *b = Some(sides.0);
            *a = Some(sides.1);
        }
        e
    }

    fn ingest(engine: &mut Engine, mut e: MarketEvent) -> MarketEvent {
        engine.classify_print(&mut e);
        engine.apply(&e);
        e
    }

    fn flags(e: &MarketEvent) -> (bool, bool) {
        match &e.payload { Payload::Trade { auction, after_hours, .. } => (*auction, *after_hours), _ => panic!() }
    }

    #[test]
    fn call_auction_and_after_hours_prints_are_flagged_and_shown_without_a_side() {
        // User 10-20: an auction match is 不分內外盤 and 盤後定價 is in no intraday figure; the broker's tick_type
        // on them is the price move, not an aggressor (2330 10-20: the 2,507-lot open came as 內盤).
        let mut engine = Engine::default();
        let sim = ingest(&mut engine, print_at("2330", 1, 540, true, 2507.0, 0.0, (0.0, 0.0)));
        assert_eq!(flags(&sim), (false, false), "試撮 is no print");
        let open = ingest(&mut engine, print_at("2330", 2, 540, false, 2507.0, 2507.0, (0.0, 2507.0)));
        assert_eq!(flags(&open), (true, false), "the first 09:00 print is the opening match");
        let next = ingest(&mut engine, print_at("2330", 3, 541, false, 1.0, 2508.0, (1.0, 2507.0)));
        assert_eq!(flags(&next), (false, false));
        let close = ingest(&mut engine, print_at("2330", 4, 810, false, 4040.0, 6548.0, (4041.0, 2507.0)));
        assert_eq!(flags(&close), (true, false), "13:30 is the closing match");
        let key = open.state_key();
        let q = &engine.state(&key).unwrap().quote;
        assert_eq!((q.total_volume, q.current), (Some(6548.0), Some(1_000_000)));
        let after = ingest(&mut engine, print_at("2330", 5, 870, false, 46.0, 6594.0, (4087.0, 2507.0)));
        assert_eq!(flags(&after), (false, true), "after 13:30: 盤後定價");
        let s = engine.state(&key).unwrap();
        assert_eq!(s.quote.total_volume, Some(6548.0), "盤後定價 is in no intraday figure");
        let tape: Vec<(f64, i8, bool, bool)> = s.recent_trades.iter().filter(|t| !t.simtrade).map(|t| (t.volume, t.side, t.auction, t.after_hours)).collect();
        assert_eq!(tape, vec![(2507.0, 0, true, false), (1.0, 1, false, false), (4040.0, 0, true, false), (46.0, 0, false, true)],
            "every print stays on the tape; auction and 盤後定價 ones without a side");
    }

    #[test]
    fn a_stock_first_seen_at_the_close_or_at_after_hours_is_classified_by_its_minute() {
        let mut engine = Engine::default();
        let close = ingest(&mut engine, print_at("2603", 1, 810, false, 4040.0, 96548.0, (50041.0, 42507.0)));
        assert_eq!(flags(&close), (true, false), "first seen at 13:30: the closing match");
        let after = ingest(&mut engine, print_at("2603", 2, 870, false, 46.0, 96594.0, (50087.0, 42507.0)));
        assert_eq!(flags(&after), (false, true));

        let mut engine = Engine::default();
        let late = ingest(&mut engine, print_at("1101", 1, 870, false, 46.0, 30046.0, (12046.0, 18000.0)));
        assert_eq!(flags(&late), (false, true), "first seen at 14:30: 盤後定價");

        let mut engine = Engine::default();
        let open = ingest(&mut engine, print_at("2330", 1, 540, false, 2507.0, 2507.0, (0.0, 2507.0)));
        assert_eq!(flags(&open), (true, false), "first seen at 09:00: the opening match");
    }

    #[test]
    fn a_print_after_an_intraday_auction_is_flagged_and_a_mid_session_first_print_is_not() {
        let mut engine = Engine::default();
        // First subscribed at 10:31: its first print is no opening match.
        let first = ingest(&mut engine, print_at("1815", 1, 631, false, 3.0, 9000.0, (5000.0, 4000.0)));
        assert_eq!(flags(&first), (false, false));
        ingest(&mut engine, print_at("1815", 2, 632, true, 1218.0, 9000.0, (5000.0, 4000.0)));
        let matched = ingest(&mut engine, print_at("1815", 3, 634, false, 1218.0, 10_218.0, (5000.0, 5218.0)));
        assert_eq!(flags(&matched), (true, false), "the print right after 試撮 is the 緩漲緩跌 match");
    }

    #[test]
    fn a_recording_without_flags_is_classified_and_cleaned_like_a_live_ingest() {
        // 10-20's WAL predates the ingest flags: re-materializing it must give the history a live day gives.
        let events = vec![
            print_at("2330", 1, 540, false, 2507.0, 2507.0, (0.0, 2507.0)),
            print_at("2330", 2, 541, false, 1.0, 2508.0, (1.0, 2507.0)),
            print_at("2330", 3, 810, false, 4040.0, 6548.0, (4041.0, 2507.0)),
            print_at("2330", 4, 870, false, 4040.0, 6548.0, (4041.0, 2507.0)),
            print_at("2330", 5, 870, false, 46.0, 6594.0, (4087.0, 2507.0)),
        ];
        let (kept, resent) = Engine::classify_recorded(events);
        assert_eq!(resent, 1, "the 14:30 copy of the close");
        let got: Vec<(u64, (bool, bool))> = kept.iter().map(|e| (e.sequence, flags(e))).collect();
        assert_eq!(got, vec![(1, (true, false)), (2, (false, false)), (3, (true, false)), (5, (false, true))]);
    }
}
