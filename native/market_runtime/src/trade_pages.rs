//! Trade-detail pages (成交明細往前翻): Market Runtime answers them itself (`trades.page`).
//!
//! The screens get a session's newest trades over the live view; every page behind them is read here, from what A
//! already owns: its WAL for a session not materialized yet, the historical store for one that is. The API that
//! used to do this in Python (an index of the WAL built from a scan's output, a whole day's `events.jsonl` parsed on
//! the first page) held the GIL of the process answering the screens for seconds at every start.
//!
//! The WAL side is an index of every trade-tape record, built in the start's own WAL scan (`wal::scan_indexing_trades`)
//! and extended by the writer as it appends (`TradeIndex::note`): the position of each record, never its content, so
//! a page reads only its own records back from disk.
//!
//! The tape rule is here, once: a trade that is not a 試撮 (`simtrade`) print is on the tape; TXF has no trade
//! records, so a FUT quote that raises the session's cumulative volume is a trade of the volume it adds
//! (`QuoteTrades`, decided in durable order).

use crate::calendar::{CalKey, Calendar};
use crate::event::{is_session_partitioned, local_minute_ns, source_for_market, tape_side, wal_sessions, MarketEvent, Payload};
use crate::replay::{check_committed, Fnv1a64, Partition};
use crate::state::{Reference, SymbolState, Trade};
use crate::voided::Voided;
use crate::volume as vol;
use crate::wal::{read_record_bytes, segment_path, RawRecord};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// The partition a tape belongs to, in the WAL's own names.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TradeKey {
    pub source: String,
    pub market: String,
    pub code: String,
    pub trading_date: String,
    pub session: String,
}

impl TradeKey {
    pub fn of(event: &MarketEvent) -> Self {
        Self { source: event.provider.clone(), market: event.market.clone(), code: event.code.clone(),
               trading_date: event.trading_date.clone(), session: event.session.clone() }
    }

    /// The partition's state in the engine.
    pub fn state_key(&self) -> crate::event::StateKey {
        crate::event::StateKey { instrument: crate::event::InstrumentKey::new(&self.source, &self.market, &self.code),
            session: crate::event::SessionKey { trading_date: self.trading_date.clone(), session: self.session.clone() } }
    }
}

/// What a stored record is to the tape.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mark {
    Trade,
    /// A FUT quote: a trade only if it raises the cumulative volume (QuoteTrades).
    Quote { total: f64, own: f64, simulated: bool },
}

/// The tape rule on a record's kind and the fields it reads (the WAL scan decodes only these).
pub fn mark(market: &str, kind: &str, simtrade: bool, status: &str, total: f64, own: f64) -> Option<Mark> {
    match kind {
        "trade" if !simtrade => Some(Mark::Trade),
        "quote" if market.eq_ignore_ascii_case("FUT") => {
            Some(Mark::Quote { total, own, simulated: status.eq_ignore_ascii_case("simulated") })
        }
        _ => None,
    }
}

pub fn mark_event(event: &MarketEvent) -> Option<Mark> {
    match &event.payload {
        Payload::Trade { simtrade, .. } => mark(&event.market, "trade", *simtrade, "", 0.0, 0.0),
        Payload::Quote { total_volume, volume, status, .. } => mark(&event.market, "quote", false, status, *total_volume, *volume),
        _ => None,
    }
}

/// A session's high-water mark of the cumulative volume: the volume each FUT quote trades, in durable order.
#[derive(Clone, Copy, Debug, Default)]
pub struct QuoteTrades {
    high: f64,
}

impl QuoteTrades {
    /// The traded volume this quote adds, 0 when it is not a trade. The session's first trade is the quote's own
    /// volume when it has one below the total (the total then also holds what traded before the subscription).
    pub fn volume(&mut self, total: f64, own: f64, simulated: bool) -> f64 {
        let (total, own) = (vol::sanitize(total), vol::sanitize(own));
        // "Repeats or lowers the total" includes a total that moved only by binary noise.
        if simulated || !vol::gt(total, self.high) {
            return 0.0;
        }
        let delta = if vol::positive(self.high).is_none() {
            if vol::positive(own).is_some() && vol::lt(own, total) { own } else { total }
        } else {
            total - self.high
        };
        self.high = total;
        delta
    }
}

/// Where one tape record sits in the WAL. `derived`: the volume a FUT quote trades (0 for a trade record).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct At {
    pub sequence: u64,
    pub exchange_ts_ns: i64,
    pub segment: u64,
    pub offset: u64,
    pub derived: f64,
}

#[derive(Debug, Default)]
struct Tape {
    at: Vec<At>,
    quotes: QuoteTrades,
}

impl Tape {
    fn push(&mut self, mark: Mark, sequence: u64, exchange_ts_ns: i64, segment: u64, offset: u64) {
        let derived = match mark {
            Mark::Trade => 0.0,
            Mark::Quote { total, own, simulated } => {
                let volume = self.quotes.volume(total, own, simulated);
                if vol::positive(volume).is_none() {
                    return;
                }
                volume
            }
        };
        if self.at.len() == self.at.capacity() {
            // An open partition's tape grows by an eighth, not double: a Futu day is millions of records, and a
            // doubled Vec holds as much unused as used (11-12: 60 MB over the scan's exact size within an hour).
            self.at.reserve_exact((self.at.len() / 8).max(1024));
        }
        self.at.push(At { sequence, exchange_ts_ns, segment, offset, derived });
    }
}

/// Every tape record of the WAL, per partition, in durable order. A void record (crate::voided) is not on the tape:
/// left out before a FUT quote's traded volume is derived, so the quotes after it trade what they add to the ones kept.
#[derive(Debug, Default)]
pub struct TradeIndex {
    tapes: HashMap<TradeKey, Tape>,
    voided: Arc<Voided>,
    /// Void records left out so far.
    voided_skipped: u64,
}

impl TradeIndex {
    pub fn new(voided: Arc<Voided>) -> Self {
        Self { tapes: HashMap::new(), voided, voided_skipped: 0 }
    }

    fn is_void(&self, key: &TradeKey, sequence: u64) -> bool {
        !self.voided.is_empty() && self.voided.covers_at(&key.source, &key.market, &key.trading_date, &key.session, sequence)
    }

    /// One record, in WAL order (the start's scan merges its segments in order; the writer appends after it).
    pub fn note(&mut self, key: &TradeKey, mark: Mark, sequence: u64, exchange_ts_ns: i64, segment: u64, offset: u64) {
        if self.is_void(key, sequence) {
            self.voided_skipped += 1;
            return;
        }
        if !self.tapes.contains_key(key) {
            self.tapes.insert(key.clone(), Tape::default());
        }
        if let Some(tape) = self.tapes.get_mut(key) {
            tape.push(mark, sequence, exchange_ts_ns, segment, offset);
        }
    }

    /// One segment's records of one partition, in WAL order: the start's scan merges each segment this way, one
    /// lookup per partition instead of one per record.
    pub fn note_segment(&mut self, key: TradeKey, records: &[(u64, i64, u64, Mark)], segment: u64) {
        let void: Vec<bool> = records.iter().map(|&(sequence, ..)| self.is_void(&key, sequence)).collect();
        self.voided_skipped += void.iter().filter(|v| **v).count() as u64;
        let tape = self.tapes.entry(key).or_default();
        tape.at.reserve(records.len());
        for (&(sequence, exchange_ts_ns, offset, mark), void) in records.iter().zip(void) {
            if !void {
                tape.push(mark, sequence, exchange_ts_ns, segment, offset);
            }
        }
    }

    /// Drop the room the scan's segment-by-segment growth left (a third more than the records, 11-12: 46 MB): only
    /// the open partitions grow after the scan, a closed one never does.
    pub fn shrink_to_fit(&mut self) {
        for tape in self.tapes.values_mut() {
            tape.at.shrink_to_fit();
        }
    }

    /// The memory the index holds (metrics `trade_index_bytes`).
    pub fn bytes(&self) -> usize {
        self.tapes.values().map(|t| t.at.capacity() * std::mem::size_of::<At>()).sum()
    }

    /// Void records left out of the tape (crate::voided).
    pub fn voided_skipped(&self) -> u64 {
        self.voided_skipped
    }

    /// Segments retention removed: their records can no longer be read.
    pub fn forget_segments(&mut self, removed: &[u64]) {
        for tape in self.tapes.values_mut() {
            tape.at.retain(|at| !removed.contains(&at.segment));
        }
        self.tapes.retain(|_, tape| !tape.at.is_empty());
    }

    /// The partition's records up to `through` (the committed watermark: a record still in the writer's buffer is
    /// not on disk yet), oldest first by exchange time.
    pub fn positions(&self, key: &TradeKey, through: u64) -> Vec<At> {
        let mut at: Vec<At> = self.tapes.get(key).map_or_else(Vec::new, |tape| tape.at.iter().copied().filter(|at| at.sequence <= through).collect());
        at.sort_by_key(|a| (a.exchange_ts_ns, a.sequence));
        at
    }

    /// Where the partition's FUT quote rule stands after its stored records: a tape that goes on without the WAL
    /// (LiveTapes) continues from it.
    pub fn quote_trades(&self, key: &TradeKey) -> QuoteTrades {
        self.tapes.get(key).map_or_else(QuoteTrades::default, |tape| tape.quotes)
    }

    pub fn partitions(&self) -> usize {
        self.tapes.len()
    }

    pub fn records(&self) -> usize {
        self.tapes.values().map(|tape| tape.at.len()).sum()
    }
}

/// A print shown and never stored, as the tape holds it. `stamp`: the committed durable sequence when it was applied,
/// its place against the stored records and a page's snapshot watermark (the rule the history fill numbers its
/// unsequenced events by), so a page frozen before it leaves it out.
#[derive(Clone, Debug, PartialEq)]
pub struct LivePrint {
    pub stamp: u64,
    pub trade: Trade,
}

#[derive(Debug, Default)]
struct LiveTape {
    prints: Vec<LivePrint>,
    quotes: QuoteTrades,
}

/// The tape of every partition that took events of an instrument off the background list (a searched stock, a
/// workspace instrument): shown, never stored, so no WAL holds its prints -- including a gap filled from the broker
/// afterwards (a late join). Held here so its pages are answered like a stored one's. Like the shown state, a restart
/// forgets it; it leaves with its partition at rollover and clear (server::retention).
#[derive(Debug, Default)]
pub struct LiveTapes {
    tapes: HashMap<TradeKey, LiveTape>,
}

impl LiveTapes {
    /// One applied live-only event; only tape records are kept. `stored`: the partition's quote rule after its stored
    /// records, read when its live tape starts.
    pub fn note(&mut self, event: &MarketEvent, stamp: u64, stored: impl FnOnce() -> QuoteTrades) {
        let Some(mark) = mark_event(event) else { return };
        let tape = self.tapes.entry(TradeKey::of(event)).or_insert_with(|| LiveTape { prints: Vec::new(), quotes: stored() });
        let trade = match mark {
            Mark::Trade => trade_of(event, event.sequence),
            Mark::Quote { total, own, simulated } => {
                let traded = tape.quotes.volume(total, own, simulated);
                if vol::positive(traded).is_none() {
                    return;
                }
                // With no durable sequence to name it, a derived print is named by its source numbering.
                quote_trade(event, traded).map(|t| Trade { trade_id: format!("q{}:{}", event.generation, event.sequence), ..t })
            }
        };
        if let Some(trade) = trade {
            tape.prints.push(LivePrint { stamp, trade });
        }
    }

    pub fn prints(&self, key: &TradeKey) -> Vec<LivePrint> {
        self.tapes.get(key).map_or_else(Vec::new, |tape| tape.prints.clone())
    }

    /// Keeps the partitions `keep` names.
    pub fn retain(&mut self, mut keep: impl FnMut(&TradeKey) -> bool) {
        self.tapes.retain(|key, _| keep(key));
    }

    pub fn partitions(&self) -> usize {
        self.tapes.len()
    }
}

/// One `trades.page` request.
#[derive(Clone, Debug, PartialEq)]
pub struct PageRequest {
    pub source: String,
    pub market: String,
    pub code: String,
    pub trading_date: String,
    pub session: String,
    pub page: usize,
    pub page_size: usize,
    pub snapshot_watermark: u64,
    pub before_sequence: u64,
    pub metadata_only: bool,
}

pub const PAGE_SIZE_MAX: usize = 100;

impl PageRequest {
    pub fn parse(p: &Value) -> Result<Self, String> {
        let text = |name: &str| p.get(name).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let number = |name: &str| p.get(name).and_then(Value::as_u64).unwrap_or(0);
        let market = text("market").to_uppercase();
        let code = text("code").to_uppercase();
        if market.is_empty() || code.is_empty() {
            return Err("market and code required".into());
        }
        let source = match text("source").to_lowercase() {
            s if s.is_empty() => source_for_market(&market).to_string(),
            s => s,
        };
        let mut session = text("session").to_uppercase();
        let trading_date: String = text("trading_date").chars().take(10).collect();
        // A request that names no session reads the market's one WAL session when it has only one.
        if session.is_empty() {
            if let [only] = wal_sessions(&source, &market) {
                session = (*only).to_string();
            }
        }
        Ok(Self { source, market, code, trading_date, session, page: (number("page") as usize).max(1),
                  page_size: (number("page_size") as usize).clamp(1, PAGE_SIZE_MAX), snapshot_watermark: number("snapshot_watermark"),
                  before_sequence: number("before_sequence"), metadata_only: p.get("metadata_only").and_then(Value::as_bool).unwrap_or(false) })
    }

    pub fn key(&self) -> TradeKey {
        TradeKey { source: self.source.clone(), market: self.market.clone(), code: self.code.clone(),
                   trading_date: self.trading_date.clone(), session: self.session.clone() }
    }
}

/// Which records a page shows (their places in the order it was given), newest first, and the counts the pager reads.
#[derive(Debug, PartialEq)]
pub struct Paged {
    pub page: Vec<usize>,
    pub total_rows: usize,
    pub total_pages: usize,
    pub watermark: u64,
}

/// The tape is in exchange-time order (`order`: each record's exchange time and durable sequence, ascending): a print
/// stored late -- a restart's gap filled from the broker afterwards -- takes its place among the prints of its
/// time, not at the newest end. A snapshot (`snapshot_watermark`, `before_sequence`) is the records stored up to a
/// durable sequence, so a page frozen by it does not shift when later records arrive. A print that is never stored
/// is placed by its stamp (LivePrint::stamp), in the same sequence space.
pub fn paginate(order: &[(i64, u64)], req: &PageRequest) -> Paged {
    let watermark = if req.snapshot_watermark > 0 { req.snapshot_watermark } else { order.iter().map(|(_, s)| *s).max().unwrap_or(0) };
    let cutoff = if req.before_sequence > 0 { watermark.min(req.before_sequence) } else { watermark };
    let shown: Vec<usize> = (0..order.len()).filter(|&i| cutoff == 0 || order[i].1 <= cutoff).collect();
    let total_rows = shown.len();
    let total_pages = total_rows.div_ceil(req.page_size).max(1);
    let page = if req.metadata_only {
        Vec::new()
    } else {
        shown.iter().rev().skip((req.page - 1) * req.page_size).take(req.page_size).copied().collect()
    };
    Paged { page, total_rows, total_pages, watermark }
}

/// A print as the tape holds it (`sequence`: the producer's, or the state version on the live view's tape). The side
/// is the tape side (event::tape_side). A 試撮 print is kept with its flag: the live view shows it, a page does not.
pub fn trade_of(event: &MarketEvent, sequence: u64) -> Option<Trade> {
    let Payload::Trade { price, volume, total_volume, side, trade_id, minute, simtrade, auction, after_hours, no_last_sale, .. } = &event.payload else {
        return None;
    };
    Some(Trade {
        version: sequence, durable_sequence: event.durable_sequence, exchange_ts_ns: event.exchange_ts_ns, price: *price,
        volume: *volume, total_volume: vol::positive(*total_volume), side: tape_side(*side, *auction, *after_hours, *no_last_sale),
        trade_id: trade_id.clone(), simtrade: *simtrade, minute: (*minute >= 0).then_some(*minute),
        auction: *auction, after_hours: *after_hours, no_last_sale: *no_last_sale,
    })
}

/// A FUT quote that traded `traded` (QuoteTrades) as a print: its total is the session's cumulative volume through it.
pub fn quote_trade(event: &MarketEvent, traded: f64) -> Option<Trade> {
    let Payload::Quote { current, total_volume, minute, .. } = &event.payload else { return None };
    let sequence = event.durable_sequence;
    Some(Trade {
        version: event.sequence, durable_sequence: sequence, exchange_ts_ns: event.exchange_ts_ns, price: *current,
        volume: traded, total_volume: vol::positive(*total_volume), side: 0, trade_id: format!("q{sequence}"), simtrade: false,
        minute: (*minute >= 0).then_some(*minute), auction: false, after_hours: false, no_last_sale: false,
    })
}

/// What a tape row is measured against: the partition it belongs to and the session's comparison price
/// (state::Reference::comparison_price), the one every 漲跌 / 漲跌幅 of the session is taken from.
#[derive(Clone, Copy, Debug)]
pub struct RowContext<'a> {
    pub source: &'a str,
    pub market: &'a str,
    pub code: &'a str,
    pub trading_date: &'a str,
    pub comparison: Option<i64>,
}

impl<'a> RowContext<'a> {
    pub fn of_state(state: &'a SymbolState) -> Self {
        let key = &state.key;
        Self { source: &key.instrument.source, market: &key.instrument.market, code: &key.instrument.code,
               trading_date: &key.session.trading_date, comparison: state.reference.comparison_price() }
    }

    pub fn of_request(req: &'a PageRequest, comparison: Option<i64>) -> Self {
        Self { source: &req.source, market: &req.market, code: &req.code, trading_date: &req.trading_date, comparison }
    }
}

/// One row of the 成交明細 tape, the one shape every reader sends: the live view's trades (snapshot and trade frame),
/// a page read from the WAL or the historical store, and the newest trades A holds. 漲跌 / 漲跌幅 are the print's
/// price against the session's comparison price; `total_volume` is the cumulative volume through this print (null
/// where the source states none). Exchange nanoseconds travel as a string (beyond a JavaScript Number).
pub fn row(t: &Trade, ctx: &RowContext) -> Value {
    let change = ctx.comparison.filter(|c| *c > 0 && t.price > 0).map(|c| (t.price - c, (t.price - c) as f64 / c as f64 * 100.0));
    json!({
        "sequence": t.version, "durable_sequence": t.durable_sequence, "ingest_sequence": t.durable_sequence,
        "source": ctx.source, "market": ctx.market, "code": ctx.code, "trading_date": ctx.trading_date,
        "exchange_ts_ns": t.exchange_ts_ns.to_string(), "minute": t.minute, "price": crate::wire::money(t.price),
        "change": change.map(|(c, _)| crate::wire::money(c)), "change_pct": change.map(|(_, p)| p),
        "volume": vol::wire(t.volume), "total_volume": vol::wire_opt(t.total_volume), "volume_unit": vol::unit(ctx.source, ctx.market),
        "side": side_label(t.side), "tick_type": tick_type(t.side),
        "trade_id": t.trade_id, "simtrade": t.simtrade, "auction": t.auction, "after_hours": t.after_hours, "no_last_sale": t.no_last_sale,
    })
}

pub fn side_label(side: i8) -> &'static str {
    if side > 0 { "BUY" } else if side < 0 { "SELL" } else { "NEUTRAL" }
}

/// The broker's tick_type numbering of a tape side (1 外盤, 2 內盤, 0 neither).
pub fn tick_type(side: i8) -> u8 {
    if side > 0 { 1 } else if side < 0 { 2 } else { 0 }
}

/// A stored tape record as a page row: a non-試撮 print, or a FUT quote that traded `derived` (> 0).
fn stored_row(event: &MarketEvent, derived: f64, ctx: &RowContext) -> Option<Value> {
    Some(row(&stored_trade(event, derived)?, ctx))
}

/// A stored tape record as the print it is on the tape (see `stored_row`).
fn stored_trade(event: &MarketEvent, derived: f64) -> Option<Trade> {
    if derived > 0.0 { quote_trade(event, derived) } else { trade_of(event, event.sequence).filter(|t| !t.simtrade) }
}

/// The comparison price a partition's own Reference events give (applied in durable order, as LatestState does).
fn partition_comparison(events: &[&MarketEvent]) -> Option<i64> {
    let mut reference = Reference::default();
    for event in events {
        reference.absorb(&event.payload);
    }
    reference.comparison_price()
}

/// The tape of a materialized partition: its prints oldest first by exchange time (then durable sequence), and the
/// partition's own comparison price every row is measured against. The prints are held as `Trade`s and a page's rows
/// are made when it is asked for (`StoredTape::row`): a Futu day is hundreds of thousands of prints, and a print as a JSON
/// row costs some 3 KB of memory against ~100 bytes as a `Trade` (11-12: one US day held 680 MB in A).
#[derive(Debug)]
pub struct StoredTape {
    pub trades: Vec<Trade>,
    pub comparison: Option<i64>,
}

impl StoredTape {
    /// The tape's exchange time and durable sequence per print, in its order (what `paginate` reads).
    pub fn order(&self) -> Vec<(i64, u64)> {
        self.trades.iter().map(|t| (t.exchange_ts_ns, t.durable_sequence)).collect()
    }

    /// The `i`th print as a page row of `req`'s partition.
    pub fn row(&self, i: usize, req: &PageRequest) -> Value {
        row(&self.trades[i], &RowContext::of_request(req, self.comparison))
    }

    /// What the tape holds in memory.
    pub fn bytes(&self) -> usize {
        std::mem::size_of::<Self>() + self.trades.capacity() * std::mem::size_of::<Trade>()
            + self.trades.iter().map(|t| t.trade_id.capacity()).sum::<usize>()
    }
}

/// The tape of a materialized partition's tape records (a FUT quote's traded volume is decided in durable order first).
pub fn tape_of(events: &[MarketEvent]) -> StoredTape {
    let mut ordered: Vec<&MarketEvent> = events.iter().collect();
    ordered.sort_by_key(|e| e.durable_sequence);
    let comparison = partition_comparison(&ordered);
    let mut quotes = QuoteTrades::default();
    let mut trades = Vec::new();
    for event in ordered {
        let trade = match mark_event(event) {
            Some(Mark::Trade) => stored_trade(event, 0.0),
            Some(Mark::Quote { total, own, simulated }) => {
                let traded = quotes.volume(total, own, simulated);
                if vol::positive(traded).is_some() { stored_trade(event, traded) } else { None }
            }
            None => None,
        };
        trades.extend(trade);
    }
    trades.sort_by_key(|t| (t.exchange_ts_ns, t.durable_sequence));
    trades.shrink_to_fit();
    StoredTape { trades, comparison }
}

/// The page's records read back from the WAL in `dir` (`wanted`: their positions), as rows by sequence, the segments
/// opened, and every record that could not be read (where and why): the index named it, so it is a page with a hole.
pub fn wal_rows(dir: &Path, wanted: &[At], ctx: &RowContext) -> (HashMap<u64, Value>, BTreeSet<u64>, Vec<String>) {
    let mut files: HashMap<u64, BufReader<File>> = HashMap::new();
    let mut rows = HashMap::new();
    let mut problems = Vec::new();
    for at in wanted {
        let problem = |why: String| format!("WAL segment {} offset {} (sequence {}): {why}", at.segment, at.offset, at.sequence);
        if !files.contains_key(&at.segment) {
            match File::open(segment_path(dir, at.segment)) {
                Ok(file) => { files.insert(at.segment, BufReader::with_capacity(64 * 1024, file)); }
                Err(e) => {
                    problems.push(problem(format!("open: {e}")));
                    continue;
                }
            }
        }
        let Some(reader) = files.get_mut(&at.segment) else { continue };
        if let Err(e) = reader.seek(SeekFrom::Start(at.offset)) {
            problems.push(problem(format!("seek: {e}")));
            continue;
        }
        let bytes = match read_record_bytes(reader) {
            RawRecord::Bytes(bytes, _) => bytes,
            RawRecord::End => { problems.push(problem("no record there".into())); continue; }
            RawRecord::Torn(why) | RawRecord::Bad(why) => { problems.push(problem(why)); continue; }
        };
        let event = match MarketEvent::decode_slice(&bytes) {
            Ok(event) => event,
            Err(e) => { problems.push(problem(e.reason().to_string())); continue; }
        };
        match stored_row(&event, at.derived, ctx) {
            Some(row) => { rows.insert(at.sequence, row); }
            None => problems.push(problem("not a tape record".into())),
        }
    }
    (rows, files.into_keys().collect(), problems)
}

fn calendar() -> &'static Calendar {
    static CALENDAR: OnceLock<Calendar> = OnceLock::new();
    CALENDAR.get_or_init(Calendar::default)
}

/// When a partition can receive nothing more (epoch ns, exchange time): a session-partitioned market's partition at
/// its session's last trading minute (shioaji FUT DAY 13:45; a NIGHT dated by its open, 05:00 the next day), every
/// other market's at the end of its calendar date in the market's zone. None for a date that is not one.
pub fn partition_end_ns(source: &str, market: &str, trading_date: &str, session: &str) -> Option<i64> {
    crate::event::parse_calendar_date(trading_date)?;
    let (source, market, session) = (source.to_lowercase(), market.to_uppercase(), session.to_uppercase());
    let end_minute = if is_session_partitioned(&source, &market) {
        let key = CalKey { source: &source, market: &market, session: Some(&session), date: Some(trading_date) };
        calendar().segments(key).iter().filter(|s| s.known_market).map(|s| s.end).max()?
    } else {
        1440
    };
    local_minute_ns(&market, trading_date, end_minute)
}

/// Why a materialized partition could not be served.
#[derive(Debug, PartialEq)]
pub enum Stored {
    /// No committed manifest: the session is not materialized (yet).
    NotMaterialized,
    Failed(String),
}

/// Materialized sessions' tapes, parsed once per content: a pager opening a window asks for several pages of the same
/// day at once. The newest are kept up to a total size (`StoredTape::bytes`); a Futu day can be millions of prints, so a
/// count of partitions says nothing about memory. The newest stays even alone over the limit: its pager's next page
/// would read it again.
pub struct MaterializedCache {
    kept: Mutex<VecDeque<(PathBuf, String, Arc<StoredTape>)>>,
    limit_bytes: usize,
}

pub const MATERIALIZED_KEPT_BYTES: usize = 128 << 20;

impl Default for MaterializedCache {
    fn default() -> Self {
        Self { kept: Mutex::new(VecDeque::new()), limit_bytes: MATERIALIZED_KEPT_BYTES }
    }
}

/// Which of a partition's lines a tape reads, without decoding the whole event (most lines are books and quotes): its
/// tape records and its Reference events (the comparison price of every row).
#[derive(Deserialize)]
struct LineHead {
    payload: LineKind,
}

#[derive(Deserialize)]
struct LineKind {
    kind: String,
    #[serde(default)]
    simtrade: bool,
}

impl LineHead {
    fn read(&self, market: &str) -> bool {
        match self.payload.kind.as_str() {
            "trade" => !self.payload.simtrade,
            "quote" => market.eq_ignore_ascii_case("FUT"),
            "reference" => true,
            _ => false,
        }
    }
}

impl MaterializedCache {
    /// The partition's tape from the historical store under `root`, or why there is none.
    pub fn tape(&self, root: &Path, req: &PageRequest) -> Result<Arc<StoredTape>, Stored> {
        let partition = Partition::new(&req.source, &req.market, &req.code, &req.trading_date, &req.session).map_err(Stored::Failed)?;
        let path = partition.events_path(root);
        let hash = match crate::replay::committed_hash(&path) {
            Ok(hash) => hash,
            // No partition, or one still being written (no manifest yet): not materialized.
            Err(reason) if reason.starts_with("NOT_AVAILABLE") || reason.starts_with("NOT_COMMITTED") => return Err(Stored::NotMaterialized),
            Err(reason) => return Err(Stored::Failed(reason)),
        };
        if let Some(tape) = self.kept.lock().unwrap().iter().find(|(p, h, _)| *p == path && *h == hash).map(|(_, _, tape)| tape.clone()) {
            return Ok(tape);
        }
        // Line by line: the partition's hash and count are measured on the way, and only its tape is decoded and held.
        let failed = |e: String| Stored::Failed(format!("{}: {e}", path.display()));
        let mut reader = BufReader::with_capacity(1 << 20, File::open(&path).map_err(|e| failed(e.to_string()))?);
        let (mut line, mut number, mut lines, mut hash, mut events) = (Vec::new(), 0u64, 0u64, Fnv1a64::default(), Vec::new());
        loop {
            line.clear();
            if reader.read_until(b'\n', &mut line).map_err(|e| failed(e.to_string()))? == 0 {
                break;
            }
            number += 1;
            hash.update(&line);
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            lines += 1;
            let head: LineHead = serde_json::from_slice(&line).map_err(|e| failed(format!("line {number}: {e}")))?;
            if head.read(&req.market) {
                events.push(MarketEvent::decode_slice(line.strip_suffix(b"\n").unwrap_or(&line))
                    .map_err(|e| failed(format!("line {number}: {}", e.reason())))?);
            }
        }
        let committed = check_committed(&path, lines, hash.hex()).map_err(Stored::Failed)?;
        let tape = Arc::new(tape_of(&events));
        drop(events);
        let mut kept = self.kept.lock().unwrap();
        kept.retain(|(p, _, _)| *p != path);
        kept.push_back((path, committed.content_hash, tape.clone()));
        let mut total: usize = kept.iter().map(|(_, _, tape)| tape.bytes()).sum();
        while total > self.limit_bytes && kept.len() > 1 {
            if let Some((_, _, gone)) = kept.pop_front() {
                total -= gone.bytes();
            }
        }
        Ok(tape)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(market: &str, page: usize, page_size: usize) -> PageRequest {
        PageRequest::parse(&json!({"market": market, "code": "X", "trading_date": "2026-11-04", "session": "DAY",
                                   "page": page, "page_size": page_size})).unwrap()
    }

    #[test]
    fn a_fut_quote_trades_what_it_adds_to_the_cumulative_volume_and_a_repeat_or_simulated_one_nothing() {
        let mut q = QuoteTrades::default();
        assert_eq!(q.volume(100.0, 3.0, false), 3.0, "the first: its own volume, below the total");
        assert_eq!(q.volume(100.0, 3.0, false), 0.0, "the total did not move");
        assert_eq!(q.volume(100.0 + 1e-12, 1.0, false), 0.0, "binary noise is not a move");
        assert_eq!(q.volume(105.0, 9.0, true), 0.0, "試撮");
        assert_eq!(q.volume(104.0, 1.0, false), 4.0, "the rise over the high-water mark");
        assert_eq!(q.volume(90.0, 1.0, false), 0.0, "an older quote's smaller total");
        let mut first = QuoteTrades::default();
        assert_eq!(first.volume(50.0, 0.0, false), 50.0, "no own volume: the whole total");
    }

    #[test]
    fn fut_quote_trades_keep_fractions_and_whole_contracts_count_as_before() {
        let mut q = QuoteTrades::default();
        assert_eq!(q.volume(0.3, 0.3, false), 0.3);
        assert_eq!(q.volume(0.1 + 0.2, 0.0, false), 0.0, "a total equal up to binary noise is a book update");
        assert!(vol::eq(q.volume(0.55, 0.0, false), 0.25), "a real fractional increase is a trade");
        assert_eq!(q.volume(0.5, 0.0, false), 0.0, "a lower total is an out-of-order delivery");
        let mut whole = QuoteTrades::default();
        assert_eq!([100.0, 100.0, 103.0, 103.0, 110.0].map(|t| whole.volume(t, 0.0, false)), [100.0, 0.0, 3.0, 0.0, 7.0]);
    }

    fn event(sequence: u64, market: &str, payload: Value) -> MarketEvent {
        serde_json::from_value(json!({"schema_version": crate::event::EVENT_SCHEMA_VERSION, "durable_sequence": sequence,
            "symbol": format!("x:{market}:X"), "provider": "x", "market": market, "code": "X", "session": "DAY",
            "trading_date": "2026-10-20", "generation": 1, "sequence": sequence, "exchange_ts_ns": 1, "payload": payload})).unwrap()
    }

    fn print(sequence: u64, extra: Value) -> Value {
        let mut payload = json!({"kind": "trade", "price": 10_000_000, "volume": 0.25, "total_volume": 102.05, "side": -1,
            "trade_id": sequence.to_string(), "minute": 570, "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0});
        payload.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        payload
    }

    #[test]
    fn rows_keep_fractions_name_the_unit_and_an_auction_or_after_hours_print_has_no_side() {
        let us = PageRequest::parse(&json!({"market": "US", "code": "US.NOK", "trading_date": "2026-10-06"})).unwrap();
        let row = stored_row(&event(7, "US", print(7, json!({}))), 0.0, &RowContext::of_request(&us, None)).unwrap();
        assert_eq!((row["volume"].clone(), row["total_volume"].clone(), row["volume_unit"].clone()), (json!(0.25), json!(102.05), json!("share")));
        assert_eq!((row["side"].clone(), row["tick_type"].clone(), row["price"].clone()), (json!("SELL"), json!(2), json!(1000.0)));
        assert_eq!((row["change"].clone(), row["change_pct"].clone()), (Value::Null, Value::Null), "no comparison price: no 漲跌");
        let stk = req("STK", 1, 10);
        let ctx = RowContext::of_request(&stk, None);
        for flag in ["auction", "after_hours", "no_last_sale"] {
            let row = stored_row(&event(1, "STK", print(1, json!({flag: true}))), 0.0, &ctx).unwrap();
            assert_eq!((row["side"].clone(), row["tick_type"].clone(), row[flag].clone()), (json!("NEUTRAL"), json!(0), json!(true)), "{flag}");
        }
        assert!(stored_row(&event(2, "STK", print(2, json!({"simtrade": true}))), 0.0, &ctx).is_none(), "試撮");
    }

    /// The live view's tape, a page read from the WAL and a materialized page send one row shape: 漲跌 / 漲跌幅
    /// against the session's comparison price, and the cumulative volume through the print.
    #[test]
    fn every_reader_sends_one_row_with_the_change_and_the_cumulative_volume_through_the_print() {
        let stk = req("STK", 1, 10);
        let ctx = RowContext::of_request(&stk, Some(9_500_000));
        let stored = stored_row(&event(3, "STK", print(3, json!({}))), 0.0, &ctx).unwrap();
        assert_eq!((stored["change"].clone(), stored["total_volume"].clone()), (json!(50.0), json!(102.05)));
        assert!((stored["change_pct"].as_f64().unwrap() - 500_000.0 / 9_500_000.0 * 100.0).abs() < 1e-9);
        assert_eq!(stored["exchange_ts_ns"], json!("1"), "nanoseconds travel as a string");

        let mut engine = crate::state::Engine::default();
        let mut reference = event(1, "STK", json!({"kind": "reference", "prev_close": 9_500_000}));
        let mut trade = event(3, "STK", print(3, json!({})));
        for e in [&mut reference, &mut trade] {
            e.trading_date = "2026-11-04".into();
        }
        engine.apply(&reference);
        engine.apply(&trade);
        let state = engine.state(&trade.state_key()).unwrap();
        let live = crate::wire::applied_trade(state);
        // The page of the fixture's own source: the unit of a row follows its source.
        let same_source = PageRequest { source: state.key.instrument.source.clone(), ..stk.clone() };
        let ctx = RowContext::of_request(&same_source, Some(9_500_000));
        let page = stored_row(&trade, 0.0, &ctx).unwrap();
        let fields = |v: &Value| ["price", "change", "change_pct", "volume", "total_volume", "volume_unit", "side", "tick_type",
                                  "durable_sequence", "exchange_ts_ns", "trading_date", "trade_id"].map(|k| v[k].clone());
        assert_eq!(fields(&live), fields(&page));

        // A materialized partition is measured against its own Reference events.
        let tape = tape_of(&[reference.clone(), trade.clone()]);
        assert_eq!(tape.trades.len(), 1);
        assert_eq!(tape.row(0, &stk)["change"], json!(50.0));
        assert_eq!(tape.row(0, &stk), stored_row(&trade, 0.0, &RowContext::of_request(&stk, Some(9_500_000))).unwrap(),
                   "a cached print's row is the row a page read from the WAL sends");
    }

    fn materialized(root: &Path, code: &str, lines: &[String]) -> PageRequest {
        let request = PageRequest::parse(&json!({"market": "STK", "code": code, "trading_date": "2026-11-04", "session": "DAY"})).unwrap();
        let partition = Partition::new(&request.source, &request.market, &request.code, &request.trading_date, &request.session).unwrap();
        let path = partition.events_path(root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(&path, &body).unwrap();
        let mut hash = Fnv1a64::default();
        hash.update(body.as_bytes());
        std::fs::write(path.with_file_name("manifest.json"), json!({"event_count": lines.len(), "content_hash_fnv1a64": hash.hex()}).to_string()).unwrap();
        request
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("trade-pages-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    /// A line off the tape is measured but never decoded: this one could not be.
    #[test]
    fn a_partition_is_read_line_by_line_and_only_its_tape_is_decoded() {
        let root = temp_root("stream");
        let trade = |s: u64| serde_json::to_string(&event(s, "STK", print(s, json!({})))).unwrap();
        let book = r#"{"payload":{"kind":"order_book"}}"#.to_string();
        let request = materialized(&root, "X", &[trade(1), book, trade(2)]);
        let tape = MaterializedCache::default().tape(&root, &request).ok().expect("committed");
        assert_eq!(tape.trades.iter().map(|t| t.durable_sequence).collect::<Vec<_>>(), vec![1, 2]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_partition_that_is_not_what_its_manifest_committed_is_refused() {
        let root = temp_root("corrupt");
        let line = serde_json::to_string(&event(1, "STK", print(1, json!({})))).unwrap();
        let request = materialized(&root, "X", &[line.clone()]);
        let partition = Partition::new(&request.source, &request.market, &request.code, &request.trading_date, &request.session).unwrap();
        std::fs::write(partition.events_path(&root), format!("{line}\n{line}\n")).unwrap();
        match MaterializedCache::default().tape(&root, &request) {
            Err(Stored::Failed(reason)) => assert!(reason.contains("CORRUPT"), "{reason}"),
            _ => panic!("a partition that differs from its manifest is refused"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_cache_is_bounded_by_size_and_keeps_the_newest_even_alone_over_the_limit() {
        let root = temp_root("bound");
        let lines = |n: u64| (1..=n).map(|s| serde_json::to_string(&event(s, "STK", print(s, json!({})))).unwrap()).collect::<Vec<_>>();
        let (first, second) = (materialized(&root, "X", &lines(2)), materialized(&root, "Y", &lines(3)));
        let two = MaterializedCache::default().tape(&root, &first).ok().expect("committed").bytes();
        let cache = MaterializedCache { limit_bytes: two + 1, ..Default::default() };
        let held = |c: &MaterializedCache| c.kept.lock().unwrap().iter().map(|(_, _, tape)| tape.trades.len()).collect::<Vec<_>>();
        assert!(cache.tape(&root, &first).is_ok());
        assert_eq!(held(&cache), vec![2]);
        assert!(cache.tape(&root, &second).is_ok());
        assert_eq!(held(&cache), vec![3], "2 + 3 rows are over the limit: the older goes");
        let tiny = MaterializedCache { limit_bytes: 1, ..Default::default() };
        assert!(tiny.tape(&root, &first).is_ok());
        assert_eq!(held(&tiny), vec![2], "the newest stays: its pager's next page reads it");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_materialized_fut_partitions_tape_is_its_quotes_that_raise_the_total() {
        let quote = |sequence: u64, total: f64| event(sequence, "FUT", json!({"kind": "quote", "current": 230_000_000, "open": 0, "high": 0,
            "low": 0, "total_volume": total, "total_amount": 0.0, "status": "live", "minute": 540, "average": 0, "volume": 0.0, "amount": 0.0}));
        let fut = PageRequest::parse(&json!({"market": "FUT", "code": "TXFR1", "trading_date": "2026-10-06", "session": "DAY"})).unwrap();
        // Out of file order on purpose: the rule runs in durable order.
        let tape = tape_of(&[quote(3, 1.5), quote(1, 1.0), quote(2, 1.0 + 1e-12)]);
        let rows: Vec<Value> = (0..tape.trades.len()).map(|i| tape.row(i, &fut)).collect();
        assert_eq!(rows.iter().map(|r| (r["durable_sequence"].as_u64().unwrap(), r["volume"].as_f64().unwrap())).collect::<Vec<_>>(), vec![(1, 1.0), (3, 0.5)]);
        assert_eq!((rows[1]["volume_unit"].clone(), rows[1]["trade_id"].clone(), rows[1]["total_volume"].clone()),
                   (json!("contract"), json!("q3"), json!(1.5)), "a quote's total is the cumulative volume through it");
    }

    #[test]
    fn a_partition_ends_at_its_sessions_last_minute_or_its_dates_end() {
        let at = |s: &str, m: &str, d: &str, session: &str| partition_end_ns(s, m, d, session).map(|ns| ns / 1_000_000_000);
        use crate::event::{days_from_civil, parse_calendar_date};
        let taipei = |d: &str, minutes: i64| { let (y, m, day) = parse_calendar_date(d).unwrap(); days_from_civil(y, m, day) * 86_400 + minutes * 60 - 8 * 3600 };
        assert_eq!(at("shioaji", "FUT", "2026-11-04", "DAY"), Some(taipei("2026-11-04", 13 * 60 + 45)));
        assert_eq!(at("shioaji", "FUT", "2026-11-04", "NIGHT"), Some(taipei("2026-11-05", 5 * 60)), "a night dated by its open");
        assert_eq!(at("shioaji", "STK", "2026-11-04", "DAY"), Some(taipei("2026-11-05", 0)));
        let new_york = |d: &str| { let (y, m, day) = parse_calendar_date(d).unwrap(); days_from_civil(y, m, day) * 86_400 + 86_400 + 5 * 3600 };
        assert_eq!(at("futu", "US", "2026-11-04", "FULL"), Some(new_york("2026-11-04")), "the end of the New York date (EST)");
        assert_eq!(at("shioaji", "STK", "2026-02-31", "DAY"), None);
    }

    #[test]
    fn the_tape_is_non_simtrade_trades_and_fut_quotes_only() {
        assert_eq!(mark("STK", "trade", false, "", 0.0, 0.0), Some(Mark::Trade));
        assert_eq!(mark("STK", "trade", true, "", 0.0, 0.0), None);
        assert_eq!(mark("STK", "quote", false, "", 5.0, 1.0), None);
        assert_eq!(mark("FUT", "quote", false, "Simulated", 5.0, 1.0), Some(Mark::Quote { total: 5.0, own: 1.0, simulated: true }));
        assert_eq!(mark("FUT", "book", false, "", 0.0, 0.0), None);
    }

    #[test]
    fn the_index_keeps_wal_order_per_partition_skips_quotes_that_trade_nothing_and_forgets_removed_segments() {
        let key = TradeKey { source: "shioaji".into(), market: "FUT".into(), code: "TXFR1".into(), trading_date: "2026-11-04".into(), session: "DAY".into() };
        let mut index = TradeIndex::default();
        index.note(&key, Mark::Quote { total: 10.0, own: 2.0, simulated: false }, 5, 50, 1, 8);
        index.note(&key, Mark::Quote { total: 10.0, own: 2.0, simulated: false }, 6, 60, 1, 90);
        index.note(&key, Mark::Quote { total: 13.0, own: 3.0, simulated: false }, 7, 70, 2, 8);
        let at = index.positions(&key, u64::MAX);
        assert_eq!(at.iter().map(|a| (a.sequence, a.derived)).collect::<Vec<_>>(), vec![(5, 2.0), (7, 3.0)]);
        assert_eq!(index.positions(&key, 6).len(), 1, "nothing past the committed watermark");
        index.forget_segments(&[1]);
        assert_eq!(index.positions(&key, u64::MAX).iter().map(|a| a.sequence).collect::<Vec<_>>(), vec![7]);
        index.forget_segments(&[2]);
        assert_eq!(index.partitions(), 0);
    }

    #[test]
    fn pages_are_newest_first_under_the_watermark_and_before_sequence() {
        let sequences: Vec<(i64, u64)> = (1..=25).map(|s| (s as i64 * 10, s)).collect();
        let seqs = |p: &Paged| p.page.iter().map(|&i| sequences[i].1).collect::<Vec<_>>();
        let first = paginate(&sequences, &req("STK", 1, 10));
        assert_eq!((seqs(&first).first().copied(), first.page.len(), first.total_rows, first.total_pages, first.watermark), (Some(25), 10, 25, 3, 25));
        let last = paginate(&sequences, &req("STK", 3, 10));
        assert_eq!(seqs(&last), vec![5, 4, 3, 2, 1]);
        let frozen = paginate(&sequences, &PageRequest { snapshot_watermark: 20, before_sequence: 15, ..req("STK", 1, 10) });
        assert_eq!((seqs(&frozen).first().copied(), frozen.total_rows, frozen.watermark), (Some(15), 15, 20));
        let counted = paginate(&sequences, &PageRequest { metadata_only: true, ..req("STK", 1, 10) });
        assert!(counted.page.is_empty());
        assert_eq!(counted.total_pages, 3);
        assert_eq!(paginate(&[], &req("STK", 1, 10)).total_pages, 1);
    }

    #[test]
    fn a_print_stored_late_is_paged_at_its_exchange_time() {
        // Sequences 1..=4 at 10..40; sequence 5 is a print of time 25 stored afterwards (a restart's gap filled).
        let mut order: Vec<(i64, u64)> = vec![(10, 1), (20, 2), (30, 3), (40, 4), (25, 5)];
        order.sort();
        let seqs = |p: &Paged| p.page.iter().map(|&i| order[i].1).collect::<Vec<_>>();
        let all = paginate(&order, &req("STK", 1, 10));
        assert_eq!(seqs(&all), vec![4, 3, 5, 2, 1], "newest first by exchange time");
        let frozen = paginate(&order, &PageRequest { snapshot_watermark: 4, ..req("STK", 1, 10) });
        assert_eq!(seqs(&frozen), vec![4, 3, 2, 1], "a snapshot taken before it does not show it");
    }

    #[test]
    fn a_request_without_a_session_reads_the_markets_only_wal_session() {
        let p = |v: Value| PageRequest::parse(&v).unwrap();
        assert_eq!(p(json!({"market": "stk", "code": "2330"})).session, "DAY");
        assert_eq!(p(json!({"market": "US", "code": "US.AAPL"})).session, "FULL");
        assert_eq!(p(json!({"market": "FUT", "code": "TXFR1"})).session, "", "FUT has two: none is guessed");
        assert_eq!(p(json!({"market": "US", "code": "US.AAPL"})).source, "futu");
        assert!(PageRequest::parse(&json!({"market": "STK"})).is_err());
        assert_eq!(p(json!({"market": "STK", "code": "1", "page_size": 500})).page_size, PAGE_SIZE_MAX);
    }
}
