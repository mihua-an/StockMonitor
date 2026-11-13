//! 模擬下單的排隊撮合 (docs/system-architecture/11_paper_order_matching.md).
//!
//! The paper ledger's orders are matched against the real market without touching it ("shadow" matching, M12): a
//! whole-lot order waits behind the volume the 五檔 showed at its price when it reached the exchange, that volume is
//! worked off by the prints at its price coming from the other side and by the book shrinking there (a shrink beyond
//! the prints is cancellations, all counted ahead of us: user 2026-10-16), and only then is the order filled. A print
//! through its price fills it at its price. An odd-lot order is matched as 零股交易 said when it was placed (user
//! 11-13): `direct` never queues and fills at the whole-lot book's best price once that reaches its price (M11);
//! `queue` waits in the stock's 盤中零股 (the market ODD: its own book and its periodic matches) like a call auction
//! (M13). Call auctions (pre-open, close, 緩漲緩跌) are resolved by their match.
//!
//! Files, all in the paper matching directory (`--paper-dir`):
//! * `orders.jsonl`  -- paper_account_api is its only writer: one command per line (`new`, `cancel`, `reduce`).
//! * `results.jsonl` -- this module is its only writer: what happened to each command (`read`, `entered`, `fill`,
//!                      `done`, `refused`). Every record has an `id` derived from the command, so replaying the same
//!                      stream again (a restart from an older checkpoint, a rebuild) writes nothing twice.
//!
//! Determinism: an order enters at the first event after the cursor B had when it read the command (`read` record)
//! whose Rust A receive time is past the order's acceptance plus the measured exchange delay (O8). A rebuild reads
//! the `read` records back, so it enters every order at the same event as the live pass did.

use market_runtime::event::{BookLevel, MarketEvent, Payload, CLOCK_CODE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const SOURCE: &str = "shioaji";
pub const MARKET: &str = "STK";
/// A stock's 盤中零股: read by the odd-lot orders queued at it (OddMatching::Queue).
pub const ODD_MARKET: &str = market_runtime::rollover::ODD_MARKET;
pub const LOT: f64 = 1000.0;
const ORDERS_FILE: &str = "orders.jsonl";
const RESULTS_FILE: &str = "results.jsonl";
/// The close auction ends at 13:30; a ROD still open at 13:31 has expired.
const EXPIRE_MINUTE: i32 = 13 * 60 + 31;
const LATENCY_SAMPLES: usize = 101;
const DEFAULT_DELAY_NS: u64 = 100_000_000;
const MAX_DELAY_NS: u64 = 5_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lot {
    Whole,
    Odd,
}

/// 零股交易 (decisions.md 模擬零股的成交方式): how an odd-lot order is matched, as set when it was placed. A whole-lot
/// order, and a command that names none, is `Direct`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OddMatching {
    /// Fills whole at the whole-lot book's best price once that reaches its price (M11).
    #[default]
    Direct,
    /// Queues at the stock's 盤中零股 matches (M13).
    Queue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceType {
    Limit,
    Market,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tif {
    ROD,
    IOC,
    FOK,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Read, not at the exchange yet (the simulated delay).
    Pending,
    Working,
    Filled,
    Cancelled,
    Expired,
    Rejected,
}

impl State {
    fn done(self) -> bool {
        matches!(self, State::Filled | State::Cancelled | State::Expired | State::Rejected)
    }
    fn name(self) -> &'static str {
        match self {
            State::Pending => "pending",
            State::Working => "working",
            State::Filled => "filled",
            State::Cancelled => "cancelled",
            State::Expired => "expired",
            State::Rejected => "rejected",
        }
    }
}

/// One line of `orders.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    New {
        cmd_id: String,
        order_id: String,
        accepted_ns: u64,
        trading_date: String,
        code: String,
        side: Side,
        lot: Lot,
        price_type: PriceType,
        /// 1/10_000 units (market_runtime PRICE_SCALE); absent for a market order.
        #[serde(default)]
        price: Option<i64>,
        /// Shares.
        qty: f64,
        tif: Tif,
        #[serde(default)]
        odd_matching: OddMatching,
    },
    Cancel {
        cmd_id: String,
        order_id: String,
        accepted_ns: u64,
    },
    /// Reduce the open quantity by `qty` shares; the order keeps its place in the queue (C2).
    Reduce {
        cmd_id: String,
        order_id: String,
        accepted_ns: u64,
        qty: f64,
    },
    /// 改價 (C3): the same order (its number kept, as at the exchange) takes `price` and goes to the back of that
    /// price's queue with what it has left. A price outside the day's limits is refused and the order stays as it was.
    Replace {
        cmd_id: String,
        order_id: String,
        accepted_ns: u64,
        price: i64,
    },
}

impl Command {
    fn cmd_id(&self) -> &str {
        match self {
            Command::New { cmd_id, .. } | Command::Cancel { cmd_id, .. } | Command::Reduce { cmd_id, .. } | Command::Replace { cmd_id, .. } => cmd_id,
        }
    }
    fn order_id(&self) -> &str {
        match self {
            Command::New { order_id, .. } | Command::Cancel { order_id, .. } | Command::Reduce { order_id, .. }
            | Command::Replace { order_id, .. } => order_id,
        }
    }
    fn accepted_ns(&self) -> u64 {
        match self {
            Command::New { accepted_ns, .. } | Command::Cancel { accepted_ns, .. } | Command::Reduce { accepted_ns, .. }
            | Command::Replace { accepted_ns, .. } => *accepted_ns,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    command: Command,
    /// The position B had applied when it read the command: the command enters strictly after it.
    after: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub order_id: String,
    pub code: String,
    pub trading_date: String,
    pub side: Side,
    pub lot: Lot,
    pub price_type: PriceType,
    /// The limit price (a market order rests at the limit-up / limit-down price once it is known).
    pub price: Option<i64>,
    pub qty: f64,
    pub tif: Tif,
    pub state: State,
    pub filled: f64,
    pub fills: u32,
    /// Shares taken off by reductions and the cancel / expiry at the end.
    pub removed: f64,
    /// Whole lots: the volume (lots) estimated ahead of this order at its price; None = not visible yet (M3).
    pub ahead: Option<f64>,
    /// The position it reached the exchange at: my own orders at one price queue in this order.
    #[serde(default)]
    pub entered: u64,
    /// Notices written for this order (a coverage loss / its return), numbering their record ids.
    #[serde(default)]
    pub notices: u32,
    #[serde(default)]
    pub odd_matching: OddMatching,
}

impl Order {
    pub fn remaining(&self) -> f64 {
        (self.qty - self.filled - self.removed).max(0.0)
    }
    fn remaining_lots(&self) -> f64 {
        (self.remaining() / LOT).floor()
    }
    /// An odd-lot order queued at the 盤中零股 matches: the whole-lot book and prints do not fill it.
    fn queued_odd(&self) -> bool {
        self.lot == Lot::Odd && self.odd_matching == OddMatching::Queue
    }
    /// The price this order is matched at: its limit, or for a market order the limit price it rests at.
    fn limit(&self, book: &Book) -> Option<i64> {
        match self.price_type {
            PriceType::Limit => self.price,
            PriceType::Market => match self.side {
                Side::Buy => book.limit_up,
                Side::Sell => book.limit_down,
            },
        }
    }
}

/// The last 五檔 of one instrument and what the module knows of its session.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Book {
    pub bids: Vec<(i64, f64)>,
    pub asks: Vec<(i64, f64)>,
    /// The book is a call auction's (試撮): pre-open, the close, or an intraday 緩漲緩跌.
    pub auction: bool,
    /// 漲停／跌停: only the official values the provider publishes (Reference events); never derived from 昨收.
    pub limit_up: Option<i64>,
    pub limit_down: Option<i64>,
    pub trading_date: String,
}

impl Book {
    fn best_bid(&self) -> Option<i64> {
        self.bids.first().map(|l| l.0)
    }
    fn best_ask(&self) -> Option<i64> {
        self.asks.first().map(|l| l.0)
    }
    fn own(&self, side: Side) -> &[(i64, f64)] {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }
    fn opposite(&self, side: Side) -> &[(i64, f64)] {
        match side {
            Side::Buy => &self.asks,
            Side::Sell => &self.bids,
        }
    }
}

/// Where the desk keeps a stock's 盤中零股 book, beside the stock's own (keyed by its code).
fn odd_book_key(code: &str) -> String {
    format!("{ODD_MARKET}:{code}")
}

fn levels(levels: &[BookLevel]) -> Vec<(i64, f64)> {
    levels.iter().filter(|l| l.price > 0 && l.volume > 0.0).map(|l| (l.price, l.volume)).collect()
}

/// `price` is at least as good as `level` for `side` (a buy pays up to its price, a sell takes down to it).
fn reaches(side: Side, price: i64, level: i64) -> bool {
    match side {
        Side::Buy => level <= price,
        Side::Sell => level >= price,
    }
}

/// `a` is strictly better than `b` for `side`'s queue (a higher bid, a lower ask).
fn better(side: Side, a: i64, b: i64) -> bool {
    match side {
        Side::Buy => a > b,
        Side::Sell => a < b,
    }
}

/// The queue estimate when the book shows `book`: the volume at `price` on the order's own side, capped by what was
/// estimated before (the queue only ever shortens: a level that grew grew behind us, one that shrank lost orders
/// ahead of us). An empty level inside the visible range, or a price better than the best, has nobody ahead (M4,
/// M8). A price beyond the deepest visible level stays as it was (unknown until it shows, M3).
fn ahead_after_book(side: Side, price: i64, book_side: &[(i64, f64)], before: Option<f64>) -> Option<f64> {
    if let Some(&(_, volume)) = book_side.iter().find(|l| l.0 == price) {
        return Some(before.map_or(volume, |b| b.min(volume)));
    }
    match (book_side.first(), book_side.last()) {
        (None, _) | (_, None) => before,
        (Some(&(best, _)), Some(&(deepest, _))) => {
            if better(side, price, best) || !better(side, deepest, price) {
                Some(0.0)
            } else {
                before
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Latency {
    samples: VecDeque<u64>,
}

impl Latency {
    fn observe(&mut self, event: &MarketEvent) {
        if event.time_quality != "exchange" || event.a_received_ns == 0 || event.exchange_ts_ns <= 0 {
            return;
        }
        let delay = event.a_received_ns.saturating_sub(event.exchange_ts_ns as u64).min(MAX_DELAY_NS);
        if self.samples.len() == LATENCY_SAMPLES {
            self.samples.pop_front();
        }
        self.samples.push_back(delay);
    }
    /// The measured exchange -> Rust A delay (median of the recent prints and books), the same quantity 連線診斷
    /// shows as 交易所延遲 (user 2026-10-16: the simulated order delay).
    fn delay_ns(&self) -> u64 {
        if self.samples.is_empty() {
            return DEFAULT_DELAY_NS;
        }
        let mut sorted: Vec<u64> = self.samples.iter().copied().collect();
        sorted.sort_unstable();
        sorted[sorted.len() / 2]
    }
}

/// What a process of this module produced and has not written yet.
#[derive(Debug, Default)]
struct Out {
    records: Vec<Value>,
}

/// Displayed volume my orders already took from a stock's book, per side and price, not yet worked off by the prints
/// there: the shadow book must not hand the same displayed volume to my orders twice (one shared count for all of
/// them, not one per order).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Shadow {
    asks: BTreeMap<i64, f64>,
    bids: BTreeMap<i64, f64>,
}

impl Shadow {
    fn side(&mut self, of_asks: bool) -> &mut BTreeMap<i64, f64> {
        if of_asks { &mut self.asks } else { &mut self.bids }
    }
}

/// The matching state a B checkpoint holds (persist.rs), exactly at its cursor. Only `PaperDesk::checkpoint` builds
/// one and only `PaperDesk::restore` reads one: both name every desk field, so a field added to the desk does not
/// compile until it is decided whether it is kept here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PaperCheckpoint {
    orders: BTreeMap<String, Order>,
    pending: Vec<Pending>,
    books: HashMap<String, Book>,
    #[serde(default)]
    shadow: HashMap<String, Shadow>,
    /// Records produced and not yet in results.jsonl when the checkpoint was taken: written after a restore, so a
    /// crash between the checkpoint and the next write loses none.
    #[serde(default)]
    unwritten: Vec<Value>,
    latency: Latency,
    applied: u64,
    journal_offset: u64,
}

/// Where a paper file operation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IoStage {
    /// orders.jsonl, the command journal paper_account_api appends: open, size, seek, read.
    JournalRead,
    /// results.jsonl read back: which records it already holds.
    ResultsRead,
    /// results.jsonl append and sync.
    ResultsWrite,
}

/// Paper file errors by stage, each with the last one's path and error, for B's metrics. Every error is also logged.
#[derive(Debug, Default)]
pub struct PaperIoErrors {
    journal_read: u64,
    results_read: u64,
    results_write: u64,
    last: Option<(IoStage, String, String)>,
}

impl PaperIoErrors {
    pub fn wire(&self) -> Value {
        let stage = |s: IoStage| match s {
            IoStage::JournalRead => "journal_read",
            IoStage::ResultsRead => "results_read",
            IoStage::ResultsWrite => "results_write",
        };
        json!({"journal_read": self.journal_read, "results_read": self.results_read, "results_write": self.results_write,
               "last": self.last.as_ref().map(|(s, path, error)| json!({"stage": stage(*s), "path": path, "error": error}))})
    }
}

#[derive(Debug, Default)]
pub struct PaperDesk {
    pub orders: BTreeMap<String, Order>,
    pending: Vec<Pending>,
    books: HashMap<String, Book>,
    shadow: HashMap<String, Shadow>,
    /// A restored checkpoint's records not yet in results.jsonl; written when the desk opens its directory.
    unwritten: Vec<Value>,
    latency: Latency,
    /// The last position applied; an event at or before it is not applied twice (a rebuild from an earlier cursor).
    pub applied: u64,
    /// Bytes of `orders.jsonl` already read.
    journal_offset: u64,
    dir: Option<PathBuf>,
    /// Ids of the records `results.jsonl` holds (read when the desk opens its directory).
    written: HashSet<String>,
    /// `read` records found in `results.jsonl`: where an earlier pass entered each command.
    recorded_reads: HashMap<String, u64>,
    out: Out,
    pub io_errors: PaperIoErrors,
    /// A results write failed part-way: before the next one, what reached the file is taken out of the batch.
    reconcile: bool,
}

impl PaperDesk {
    /// The state a checkpoint keeps: the matching, and every record not yet written (produced, or restored and not
    /// written since). The directory, the written set, the read positions and the error counts belong to this
    /// process and are found again when the restored desk opens its directory.
    pub fn checkpoint(&self) -> PaperCheckpoint {
        let PaperDesk { orders, pending, books, shadow, unwritten, latency, applied, journal_offset,
                        dir: _, written: _, recorded_reads: _, out, io_errors: _, reconcile: _ } = self;
        PaperCheckpoint {
            orders: orders.clone(), pending: pending.clone(), books: books.clone(), shadow: shadow.clone(),
            unwritten: out.records.iter().chain(unwritten.iter()).cloned().collect(), latency: latency.clone(),
            applied: *applied, journal_offset: *journal_offset,
        }
    }

    /// A desk with a checkpoint's state; `open` gives it its directory.
    pub fn restore(checkpoint: PaperCheckpoint) -> Self {
        let PaperCheckpoint { orders, pending, books, shadow, unwritten, latency, applied, journal_offset } = checkpoint;
        PaperDesk {
            orders, pending, books, shadow, unwritten, latency, applied, journal_offset,
            dir: None, written: HashSet::new(), recorded_reads: HashMap::new(), out: Out::default(),
            io_errors: PaperIoErrors::default(), reconcile: false,
        }
    }

    /// Count, record and log one paper file error.
    fn io_error(&mut self, stage: IoStage, path: &Path, what: &str, error: impl std::fmt::Display) {
        let counter = match stage {
            IoStage::JournalRead => &mut self.io_errors.journal_read,
            IoStage::ResultsRead => &mut self.io_errors.results_read,
            IoStage::ResultsWrite => &mut self.io_errors.results_write,
        };
        *counter += 1;
        let error = format!("{what}: {error}");
        eprintln!("[analysis_runtime] paper: {} {error}", path.display());
        self.io_errors.last = Some((stage, path.display().to_string(), error));
    }

    /// Open the desk on its directory: the records already written (so none is written twice) and the `read`
    /// positions of an earlier pass.
    pub fn open(&mut self, dir: Option<PathBuf>) {
        self.written.clear();
        self.recorded_reads.clear();
        if let Some(dir) = &dir {
            // Not cut: the first write cuts it, so the next line never joins the fragment.
            self.reconcile = !self.cut_torn_tail(dir);
            for record in self.read_results(dir) {
                if let Some(id) = record["id"].as_str() {
                    self.written.insert(id.to_string());
                }
                if record["type"] == "read" {
                    if let (Some(cmd), Some(after)) = (record["cmd_id"].as_str(), record["after_sequence"].as_u64()) {
                        self.recorded_reads.insert(cmd.to_string(), after);
                    }
                }
            }
        }
        // What the checkpoint held unwritten goes out with the next write, unless the file got it before the crash.
        for record in std::mem::take(&mut self.unwritten) {
            let id = record["id"].as_str().unwrap_or_default().to_string();
            if !id.is_empty() && self.written.insert(id) {
                self.out.records.push(record);
            }
        }
        self.dir = dir;
    }

    /// Cut results.jsonl back to its last whole line. A fragment (a power loss, a write that failed part-way) holds no
    /// record anyone read, and what it would have held is produced again: from the checkpoint's `unwritten`, or by
    /// replaying from the cursor. False when the file could not be cut (recorded): nothing may be appended to it.
    fn cut_torn_tail(&mut self, dir: &Path) -> bool {
        let path = dir.join(RESULTS_FILE);
        match cut_to_last_line(&path) {
            Ok(0) => true,
            Ok(cut) => {
                self.io_error(IoStage::ResultsRead, &path, "unfinished last line cut back to the last whole line", format!("{cut} bytes"));
                true
            }
            Err(error) => {
                self.io_error(IoStage::ResultsWrite, &path, "cutting the unfinished last line", error);
                false
            }
        }
    }

    /// Every record of results.jsonl. No file yet is normal; any other failure is recorded and counted.
    fn read_results(&mut self, dir: &Path) -> Vec<Value> {
        let path = dir.join(RESULTS_FILE);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
            Err(error) => {
                self.io_error(IoStage::ResultsRead, &path, "opening", error);
                return Vec::new();
            }
        };
        let mut out = Vec::new();
        for (n, line) in BufReader::new(file).lines().enumerate() {
            match line {
                Ok(line) if line.trim().is_empty() => {}
                Ok(line) => match serde_json::from_str::<Value>(&line) {
                    Ok(record) => out.push(record),
                    Err(error) => self.io_error(IoStage::ResultsRead, &path, &format!("line {}", n + 1), error),
                },
                Err(error) => {
                    self.io_error(IoStage::ResultsRead, &path, "reading", error);
                    break;
                }
            }
        }
        out
    }

    pub fn working_count(&self) -> usize {
        self.orders.values().filter(|o| !o.state.done()).count()
    }

    pub fn delay_ms(&self) -> f64 {
        self.latency.delay_ns() as f64 / 1e6
    }

    /// Start over from an empty state on the same directory: the journal is read again from its start and the
    /// stream replayed into it (a stream reset). Records already written stay written.
    pub fn restart(&mut self) {
        let (dir, io_errors) = (self.dir.take(), std::mem::take(&mut self.io_errors));
        *self = PaperDesk::default();
        self.io_errors = io_errors;
        self.open(dir);
    }

    fn emit(&mut self, record: Value) {
        let id = record["id"].as_str().unwrap_or_default().to_string();
        if !id.is_empty() && self.written.insert(id) {
            self.out.records.push(record);
        }
    }

    /// Read the commands appended since the last read. `position` is what B has applied: each command enters
    /// strictly after it (or where the earlier pass recorded it did).
    pub fn poll_commands(&mut self, position: u64) {
        let Some(dir) = self.dir.clone() else { return };
        let path = dir.join(ORDERS_FILE);
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(error) => {
                self.io_error(IoStage::JournalRead, &path, "opening", error);
                return;
            }
        };
        let len = match file.metadata() {
            Ok(meta) => meta.len(),
            Err(error) => {
                self.io_error(IoStage::JournalRead, &path, "reading the size", error);
                return;
            }
        };
        if len < self.journal_offset {
            // The journal was replaced (never by design: it is append-only); read it again from the start.
            eprintln!("[analysis_runtime] paper: {} shrank from {} to {len} bytes; reading it again", path.display(), self.journal_offset);
            self.journal_offset = 0;
        }
        if len == self.journal_offset {
            return;
        }
        if let Err(error) = file.seek(SeekFrom::Start(self.journal_offset)) {
            self.io_error(IoStage::JournalRead, &path, "seeking", error);
            return;
        }
        let mut text = String::new();
        if let Err(error) = file.read_to_string(&mut text) {
            self.io_error(IoStage::JournalRead, &path, "reading", error);
            return;
        }
        // Only whole lines: a line still being written is read next time.
        let complete = text.rfind('\n').map_or(0, |i| i + 1);
        for line in text[..complete].lines().filter(|l| !l.trim().is_empty()) {
            match serde_json::from_str::<Command>(line) {
                Ok(command) => self.receive(command, position),
                Err(error) => {
                    eprintln!("[analysis_runtime] paper: unreadable command {line:?}: {error}");
                    self.emit(json!({"type": "refused", "id": format!("bad-{}-{}", self.journal_offset, line.len()),
                        "reason": format!("無法讀取的委託：{error}")}));
                }
            }
        }
        self.journal_offset += complete as u64;
    }

    fn receive(&mut self, command: Command, position: u64) {
        let cmd_id = command.cmd_id().to_string();
        // A line read twice (never by design) is one command.
        let duplicate_new = matches!(command, Command::New { .. }) && self.orders.contains_key(command.order_id());
        if duplicate_new || self.pending.iter().any(|p| p.command.cmd_id() == cmd_id) {
            return;
        }
        let after = self.recorded_reads.get(&cmd_id).copied().unwrap_or(position);
        self.emit(json!({"type": "read", "id": format!("{cmd_id}-R"), "cmd_id": cmd_id, "order_id": command.order_id(),
            "after_sequence": after}));
        if let Command::New { order_id, trading_date, code, side, lot, price_type, price, qty, tif, odd_matching, .. } = &command {
            self.orders.entry(order_id.clone()).or_insert_with(|| Order {
                order_id: order_id.clone(), code: code.trim().to_uppercase(), trading_date: trading_date.clone(), side: *side, lot: *lot,
                price_type: *price_type, price: *price, qty: *qty, tif: *tif, state: State::Pending, filled: 0.0, fills: 0, removed: 0.0,
                ahead: None, entered: 0, notices: 0, odd_matching: if *lot == Lot::Odd { *odd_matching } else { OddMatching::Direct },
            });
        }
        self.pending.push(Pending { command, after });
    }

    /// One market event of the durable stream (`position`: its durable sequence; a replay's own count). Only stored
    /// events reach the desk: every stock with a working order is on the background list (background owner
    /// paper_orders), and a searched stock's live-only events must not build books a checkpoint keeps (Codex
    /// 1020-R04-05).
    pub fn apply(&mut self, event: &MarketEvent, position: u64) {
        if position != 0 && position <= self.applied {
            return;
        }
        self.applied = self.applied.max(position);
        let odd = event.market == ODD_MARKET;
        if event.provider != SOURCE || (event.market != MARKET && !odd) {
            return;
        }
        if let Payload::Clock { .. } = &event.payload {
            // The stock market's clock closes the day; the odd-lot scope's is the same time.
            if event.code == CLOCK_CODE && !odd {
                self.on_clock(event.exchange_ts_ns);
            }
            return;
        }
        if matches!(event.payload, Payload::Trade { .. } | Payload::OrderBook { .. }) {
            self.latency.observe(event);
        }
        // A later day is told by market data only: Rust A's coverage controls carry the wall clock's date.
        if matches!(event.payload, Payload::Trade { .. } | Payload::OrderBook { .. } | Payload::Quote { .. }) {
            self.expire_before(&event.trading_date);
        }
        self.enter_due(event, position);
        let code = event.code.to_uppercase();
        if odd {
            self.apply_odd(&code, event);
            return;
        }
        match &event.payload {
            // Rust A's coverage control: the source stopped (or resumed) delivering this stock. While it is out the
            // orders cannot be matched -- said so on each order at the exchange, never filled from a guess (R1). An
            // order still Pending is not at the exchange: in a rebuild every order of the journal is Pending from the
            // start of the stream until its recorded position, so the controls of the days before it was placed are
            // not its own.
            Payload::SourceStatus { state, .. } => self.coverage_notice(&code, state, event.exchange_ts_ns, false),
            Payload::Reference { limit_up, limit_down, .. } => {
                let book = self.book_of(&code, &event.trading_date);
                book.limit_up = limit_up.or(book.limit_up);
                book.limit_down = limit_down.or(book.limit_down);
            }
            Payload::OrderBook { bids, asks, simtrade } => {
                let book = self.book_of(&code, &event.trading_date);
                book.bids = levels(bids);
                book.asks = levels(asks);
                book.auction = *simtrade;
                if *simtrade {
                    self.on_auction_book(&code);
                } else {
                    self.on_book(&code, event);
                }
            }
            Payload::Trade { price, volume, side, simtrade, no_last_sale, .. } => {
                // A print that sets no last sale (an odd lot, an average-price print) fills no paper order: its price
                // is not where the book traded.
                if *simtrade || *no_last_sale {
                    return;
                }
                let auction = self.books.get(&code).is_some_and(|b| b.auction);
                if auction {
                    self.on_auction_match(&code, *price, *volume, event);
                    if let Some(book) = self.books.get_mut(&code) {
                        book.auction = false;
                    }
                } else {
                    self.on_trade(&code, *price, *volume, *side, event);
                }
            }
            _ => {}
        }
    }

    /// The durable stream lost events through `through` (unreadable, or a jump Market Runtime did not declare): said on
    /// every order at the exchange, since nothing in that stretch could work it off or fill it. The orders stay as they
    /// are: the books and prints after the gap are the real market. Numbered by the gap, so a second pass over the same
    /// gap writes nothing twice. `at_ns` is when B met it: the gap itself has no market time.
    pub fn on_durable_gap(&mut self, through: u64, at_ns: i64) {
        let ids: Vec<String> = self.orders.values().filter(|o| o.state == State::Working).map(|o| o.order_id.clone()).collect();
        for id in ids {
            self.emit(json!({"type": "notice", "id": format!("{id}-G{through}"), "order_id": id,
                "reason": "行情遺失（事件流缺口）：這段期間無法撮合", "exchange_ts_ns": at_ns}));
        }
    }

    /// Rust A's coverage control of the stock (`odd`: of its 盤中零股) said on each order at the exchange that reads it.
    fn coverage_notice(&mut self, code: &str, state: &str, ts: i64, odd: bool) {
        let reason = match state {
            "unsubscribed" => "行情中斷（訂閱中止）：這段期間無法撮合",
            "subscribed" => "行情恢復：繼續撮合",
            _ => return,
        };
        let ids: Vec<String> = self.orders.values().filter(|o| o.code == code && o.state == State::Working && o.queued_odd() == odd)
            .map(|o| o.order_id.clone()).collect();
        for id in ids {
            let Some(order) = self.orders.get_mut(&id) else { continue };
            if state == "subscribed" && order.notices == 0 {
                continue;   // a first subscription is not a recovery
            }
            order.notices += 1;
            let n = order.notices;
            self.emit(json!({"type": "notice", "id": format!("{id}-N{n}"), "order_id": id, "reason": reason, "exchange_ts_ns": ts}));
        }
    }

    /// One event of a stock's 盤中零股 (M13). Its book places each queued odd-lot order at its price (the queue only
    /// shortens, as a whole-lot one's); each print is one of the periodic matches.
    fn apply_odd(&mut self, code: &str, event: &MarketEvent) {
        let key = odd_book_key(code);
        match &event.payload {
            Payload::SourceStatus { state, .. } => self.coverage_notice(code, state, event.exchange_ts_ns, true),
            Payload::OrderBook { bids, asks, simtrade } => {
                let book = self.book_of(&key, &event.trading_date);
                book.bids = levels(bids);
                book.asks = levels(asks);
                book.auction = *simtrade;
                let book = book.clone();
                for id in self.queued_odd_on(code) {
                    let Some(limit) = self.odd_limit(&id) else { continue };
                    if let Some(o) = self.orders.get_mut(&id) {
                        o.ahead = ahead_after_book(o.side, limit, book.own(o.side), o.ahead);
                    }
                }
            }
            Payload::Trade { price, volume, simtrade: false, no_last_sale: false, .. } => self.on_odd_match(code, *price, *volume, event.exchange_ts_ns),
            _ => {}
        }
    }

    /// A 盤中零股 match at `price` of `volume` shares: a queued order better than it fills whole at it, one at it fills
    /// from what the match leaves after the queue ahead (an unknown place is behind the whole match), a worse one waits
    /// (M13, as M10). An IOC / FOK has its one match: what it did not fill is gone (a FOK fills whole or not at all).
    fn on_odd_match(&mut self, code: &str, price: i64, volume: f64, ts: i64) {
        let mut used = 0.0;
        for id in self.queued_odd_on(code) {
            let (Some(order), Some(limit)) = (self.orders.get(&id).cloned(), self.odd_limit(&id)) else { continue };
            let qty = if !reaches(order.side, limit, price) {
                0.0
            } else if limit != price {
                order.remaining()
            } else {
                let ahead = order.ahead.unwrap_or(volume);
                if let Some(o) = self.orders.get_mut(&id) {
                    o.ahead = Some((ahead - volume).max(0.0));
                }
                ((volume - ahead).max(0.0) - used).floor().min(order.remaining())
            };
            if order.tif == Tif::FOK && qty + 1e-9 < order.remaining() {
                self.finish(&id, State::Cancelled, "FOK 無法全部成交", ts);
                continue;
            }
            if qty > 0.0 {
                if limit == price {
                    used += qty;
                }
                self.fill(&id, qty, price, ts, if limit == price { "零股排隊輪到" } else { "零股撮合（價格優於撮合價）" });
            }
            if order.tif != Tif::ROD {
                self.finish(&id, State::Cancelled, "IOC／FOK 未成交部分取消", ts);
            }
        }
    }

    /// The odd-lot orders of `code` queued at its 盤中零股, in the order they reached the exchange.
    fn queued_odd_on(&self, code: &str) -> Vec<String> {
        self.working_on(code).filter(|id| self.orders.get(id).is_some_and(Order::queued_odd)).collect()
    }

    /// A queued odd-lot order's price: its limit, or a market order's protection price from the stock's official limits.
    fn odd_limit(&self, order_id: &str) -> Option<i64> {
        let order = self.orders.get(order_id)?;
        let book = self.books.get(&order.code).filter(|b| b.trading_date == order.trading_date).cloned().unwrap_or_default();
        order.limit(&book)
    }

    /// The book of `code` on `trading_date`. A new day starts it empty -- yesterday's limits, reference and shadow are
    /// not today's -- and every book (and shadow) of an earlier day leaves: no order of an earlier day is still working
    /// (`expire_before` ran first), so the desk never holds more than the stocks of the days it is matching.
    fn book_of(&mut self, code: &str, trading_date: &str) -> &mut Book {
        if self.books.get(code).is_none_or(|b| b.trading_date != trading_date) {
            self.books.insert(code.to_string(), Book { trading_date: trading_date.to_string(), ..Default::default() });
            self.shadow.remove(code);
            let books = &mut self.books;
            books.retain(|_, b| b.trading_date.as_str() >= trading_date);
            let books = &self.books;
            self.shadow.retain(|c, _| books.contains_key(c));
        }
        self.books.get_mut(code).expect("inserted above")
    }

    /// A call auction's book: an order still without a place at its price gets the volume the auction shows there.
    fn on_auction_book(&mut self, code: &str) {
        let Some(book) = self.books.get(code).cloned() else { return };
        let ids: Vec<String> = self.working_on(code).collect();
        for id in ids {
            let Some(order) = self.orders.get_mut(&id) else { continue };
            if order.lot != Lot::Whole || order.ahead.is_some() {
                continue;
            }
            if let Some(limit) = order.limit(&book) {
                order.ahead = ahead_after_book(order.side, limit, book.own(order.side), None);
            }
        }
    }

    /// Commands whose time has come enter before `event` is applied (the book they meet is the one before it).
    fn enter_due(&mut self, event: &MarketEvent, position: u64) {
        if self.pending.is_empty() {
            return;
        }
        let delay = self.latency.delay_ns();
        let (due, waiting): (Vec<Pending>, Vec<Pending>) = std::mem::take(&mut self.pending).into_iter().partition(|p| {
            position > p.after && event.a_received_ns >= p.command.accepted_ns().saturating_add(delay)
        });
        self.pending = waiting;
        for pending in due {
            self.enter(pending.command, event, position);
        }
    }

    fn enter(&mut self, command: Command, event: &MarketEvent, position: u64) {
        let cmd_id = command.cmd_id().to_string();
        let order_id = command.order_id().to_string();
        let ts = event.exchange_ts_ns;
        self.emit(json!({"type": "entered", "id": format!("{cmd_id}-E"), "cmd_id": cmd_id, "order_id": order_id,
            "sequence": position, "exchange_ts_ns": ts}));
        match command {
            Command::New { .. } => self.enter_new(&order_id, event, position),
            Command::Cancel { .. } => {
                let Some(order) = self.orders.get_mut(&order_id) else {
                    self.refuse(&cmd_id, &order_id, "找不到這筆委託", ts);
                    return;
                };
                if order.state.done() {
                    let reason = format!("委託已{}，刪單失敗", state_label(order.state));
                    self.refuse(&cmd_id, &order_id, &reason, ts);
                    return;
                }
                self.finish(&order_id, State::Cancelled, "刪單", ts);
            }
            Command::Reduce { qty, .. } => {
                let Some(order) = self.orders.get_mut(&order_id) else {
                    self.refuse(&cmd_id, &order_id, "找不到這筆委託", ts);
                    return;
                };
                if order.state.done() {
                    let reason = format!("委託已{}，減量失敗", state_label(order.state));
                    self.refuse(&cmd_id, &order_id, &reason, ts);
                    return;
                }
                let remaining = order.remaining();
                if qty >= remaining {
                    self.finish(&order_id, State::Cancelled, "減量至 0", ts);
                    return;
                }
                order.removed += qty;
                let remaining = order.remaining();
                self.emit(json!({"type": "reduced", "id": format!("{cmd_id}-D"), "cmd_id": cmd_id, "order_id": order_id,
                    "qty": qty, "remaining": remaining, "exchange_ts_ns": ts}));
            }
            Command::Replace { price, .. } => {
                let Some(order) = self.orders.get(&order_id).cloned() else {
                    self.refuse(&cmd_id, &order_id, "找不到這筆委託", ts);
                    return;
                };
                if order.state.done() {
                    let reason = format!("委託已{}，改價失敗", state_label(order.state));
                    self.refuse(&cmd_id, &order_id, &reason, ts);
                    return;
                }
                if order.lot == Lot::Whole && order.remaining_lots() < 1.0 {
                    self.refuse(&cmd_id, &order_id, "沒有可改價的剩餘數量", ts);
                    return;
                }
                // Outside the day's official limits the change is refused and the order keeps its price and place.
                let book = self.books.get(&order.code).filter(|b| b.trading_date == order.trading_date);
                if book.is_some_and(|b| b.limit_up.is_some_and(|up| price > up) || b.limit_down.is_some_and(|down| price < down)) {
                    self.refuse(&cmd_id, &order_id, "價格超出漲跌停，改價失敗", ts);
                    return;
                }
                // The same order at its new price, entering again: the back of that price's queue (C3).
                if let Some(o) = self.orders.get_mut(&order_id) {
                    o.price_type = PriceType::Limit;
                    o.price = Some(price);
                    o.state = State::Pending;
                    o.ahead = None;
                }
                let qty = order.remaining();
                self.emit(json!({"type": "replaced", "id": format!("{cmd_id}-P"), "cmd_id": cmd_id, "order_id": order_id,
                    "qty": qty, "price": price, "exchange_ts_ns": ts}));
                self.enter_new(&order_id, event, position);
            }
        }
    }

    fn refuse(&mut self, cmd_id: &str, order_id: &str, reason: &str, ts: i64) {
        self.emit(json!({"type": "refused", "id": format!("{cmd_id}-X"), "cmd_id": cmd_id, "order_id": order_id,
            "reason": reason, "exchange_ts_ns": ts}));
    }

    fn enter_new(&mut self, order_id: &str, event: &MarketEvent, position: u64) {
        let ts = event.exchange_ts_ns;
        let Some(order) = self.orders.get(order_id).cloned() else { return };
        if order.state != State::Pending {
            return;
        }
        if event.trading_date > order.trading_date {
            self.finish(order_id, State::Expired, "委託日已收盤", ts);
            return;
        }
        // Only the order's own day's book: yesterday's closing book is no market for an order of today.
        let book = self.books.get(&order.code).filter(|b| b.trading_date == order.trading_date).cloned()
            .unwrap_or_else(|| Book { trading_date: order.trading_date.clone(), ..Default::default() });
        let (up, down) = (book.limit_up, book.limit_down);
        if let (PriceType::Limit, Some(price)) = (order.price_type, order.price) {
            if up.is_some_and(|up| price > up) || down.is_some_and(|down| price < down) {
                self.finish(order_id, State::Rejected, "價格超出漲跌停", ts);
                return;
            }
        }
        // A market order is matched at its protection price, the day's official 漲停 (buy) / 跌停 (sell): without
        // the provider's limits there is none, and the order is refused (never priced from 昨收).
        if order.price_type == PriceType::Market && order.limit(&book).is_none() {
            self.finish(order_id, State::Rejected, "還沒有今天的官方漲跌停價：不受理市價單", ts);
            return;
        }
        if order.queued_odd() {
            // Waits for the 盤中零股 matches (M13); its place is what the odd-lot book shows at its price.
            let odd_book = self.books.get(&odd_book_key(&order.code)).filter(|b| b.trading_date == order.trading_date).cloned();
            let ahead = match (odd_book, order.limit(&book)) {
                (Some(odd), Some(limit)) => ahead_after_book(order.side, limit, odd.own(order.side), None),
                _ => None,
            };
            if let Some(o) = self.orders.get_mut(order_id) {
                o.state = State::Working;
                o.entered = position;
                o.ahead = ahead;
            }
            return;
        }
        if book.auction && order.tif != Tif::ROD {
            self.finish(order_id, State::Rejected, "集合競價時段只接受 ROD", ts);
            return;
        }
        let has_book = !book.bids.is_empty() || !book.asks.is_empty();
        if !has_book && order.tif != Tif::ROD {
            self.finish(order_id, State::Cancelled, "還沒有今天的五檔：IOC／FOK 取消", ts);
            return;
        }
        if let Some(o) = self.orders.get_mut(order_id) {
            o.state = State::Working;
            o.entered = position;
        }
        if !has_book {
            // Waits for the day's first book (on_book / on_auction_book place it then).
            return;
        }
        if book.auction {
            // Waits for the match (M10); its place at an equal price is what the auction book shows there.
            if order.lot == Lot::Whole {
                if let Some(price) = order.limit(&book) {
                    let ahead = ahead_after_book(order.side, price, book.own(order.side), None);
                    if let Some(o) = self.orders.get_mut(order_id) {
                        o.ahead = ahead;
                    }
                }
            }
            return;
        }
        match order.lot {
            Lot::Odd => self.match_odd(order_id, &book, ts, "零股（依整股價）"),
            Lot::Whole => self.match_marketable(order_id, &book, ts, true),
        }
        // Whatever an IOC / FOK did not fill right away is gone.
        if let Some(o) = self.orders.get(order_id) {
            if !o.state.done() && o.tif != Tif::ROD {
                self.finish(order_id, State::Cancelled, "IOC／FOK 未成交部分取消", ts);
            }
        }
    }

    /// A whole-lot order meets the book: it takes the opposite levels its price reaches (M1), and what is left rests
    /// behind the volume at its price (M2-M4). `entering`: the order just arrived (FOK is decided here, and the
    /// resting price's queue is set); later calls are a book that moved into the order's price.
    fn match_marketable(&mut self, order_id: &str, book: &Book, ts: i64, entering: bool) {
        let Some(order) = self.orders.get(order_id).cloned() else { return };
        // Every working order has its price: a limit order its own, a market order the official limit it entered with.
        let Some(limit) = order.limit(book) else { return };
        let reachable: Vec<(i64, f64)> = book.opposite(order.side).iter().copied().filter(|l| reaches(order.side, limit, l.0)).collect();
        if entering && order.tif == Tif::FOK {
            let taken = self.shadow.get(&order.code).cloned().unwrap_or_default();
            let taken = if order.side == Side::Buy { taken.asks } else { taken.bids };
            let available: f64 = reachable.iter().map(|l| (l.1 - taken.get(&l.0).copied().unwrap_or(0.0)).max(0.0).floor()).sum();
            if available + 1e-9 < order.remaining_lots() {
                self.finish(order_id, State::Cancelled, "FOK 無法全部成交", ts);
                return;
            }
        }
        // A resting order is the one at the exchange first: a book that comes to it trades at its own price.
        let at = if entering { None } else { Some(limit) };
        self.take_levels(order_id, &reachable, at, ts, if entering { "吃單" } else { "穿價" });
        if entering {
            if let Some(o) = self.orders.get_mut(order_id) {
                if !o.state.done() {
                    o.ahead = ahead_after_book(o.side, limit, book.own(o.side), None);
                }
            }
        }
    }

    /// Fill against displayed levels (lots), each at its own price or at `at`.
    fn take_levels(&mut self, order_id: &str, levels: &[(i64, f64)], at: Option<i64>, ts: i64, reason: &str) {
        for &(price, volume) in levels {
            let Some(order) = self.orders.get(order_id) else { return };
            let want = order.remaining_lots();
            if want <= 0.0 || order.state.done() {
                break;
            }
            let (code, of_asks) = (order.code.clone(), order.side == Side::Buy);
            let taken = self.shadow.entry(code).or_default().side(of_asks).entry(price).or_insert(0.0);
            let take = want.min((volume - *taken).max(0.0).floor());
            if take <= 0.0 {
                continue;
            }
            *taken += take;
            self.fill(order_id, take * LOT, at.unwrap_or(price), ts, reason);
        }
    }

    /// An odd lot fills whole at the whole-lot book's best opposite price once that reaches its price (M11).
    fn match_odd(&mut self, order_id: &str, book: &Book, ts: i64, reason: &str) {
        let Some(order) = self.orders.get(order_id).cloned() else { return };
        let best = match order.side {
            Side::Buy => book.best_ask(),
            Side::Sell => book.best_bid(),
        };
        let Some(best) = best else { return };
        let reached = match (order.price_type, order.price) {
            (PriceType::Market, _) => true,
            (PriceType::Limit, Some(price)) => reaches(order.side, price, best),
            (PriceType::Limit, None) => false,
        };
        if reached {
            let qty = order.remaining();
            self.fill(order_id, qty, best, ts, reason);
        }
    }

    /// The working orders of `code`, in the order they reached the exchange (my own orders at one price queue so).
    fn working_on(&self, code: &str) -> impl Iterator<Item = String> {
        let mut orders: Vec<(u64, String)> = self.orders.values().filter(|o| o.code == code && o.state == State::Working)
            .map(|o| (o.entered, o.order_id.clone())).collect();
        orders.sort();
        orders.into_iter().map(|(_, id)| id)
    }

    fn on_book(&mut self, code: &str, event: &MarketEvent) {
        let Some(book) = self.books.get(code).cloned() else { return };
        // What my orders took and the book no longer shows was traded away by others.
        if let Some(shadow) = self.shadow.get_mut(code) {
            for (taken, shown) in [(&mut shadow.asks, &book.asks), (&mut shadow.bids, &book.bids)] {
                taken.retain(|price, t| {
                    *t = t.min(shown.iter().find(|l| l.0 == *price).map_or(0.0, |l| l.1));
                    *t > 0.0
                });
            }
        }
        let ids: Vec<String> = self.working_on(code).collect();
        for id in ids {
            let Some(order) = self.orders.get(&id).cloned() else { continue };
            match order.lot {
                Lot::Odd if order.queued_odd() => {}
                Lot::Odd => self.match_odd(&id, &book, event.exchange_ts_ns, "零股（依整股價）"),
                Lot::Whole => {
                    let Some(limit) = order.limit(&book) else { continue };
                    if let Some(o) = self.orders.get_mut(&id) {
                        o.ahead = ahead_after_book(o.side, limit, book.own(o.side), o.ahead);
                    }
                    // A book whose opposite side reached a resting order: that volume trades with it at its price.
                    if book.opposite(order.side).first().is_some_and(|l| reaches(order.side, limit, l.0)) {
                        self.match_marketable(&id, &book, event.exchange_ts_ns, false);
                    }
                }
            }
        }
    }

    fn on_trade(&mut self, code: &str, price: i64, volume: f64, side: i8, event: &MarketEvent) {
        let ts = event.exchange_ts_ns;
        let book = self.books.get(code).cloned().unwrap_or_default();
        // The side the print traded against: its own mark, else where its price stands in the book (at or above the
        // best ask it bought the asks, at or below the best bid it sold into the bids); else neither.
        let side = match side {
            1 | -1 => side,
            _ if book.best_ask().is_some_and(|a| price >= a) => 1,
            _ if book.best_bid().is_some_and(|b| price <= b) => -1,
            _ => 0,
        };
        // A buy print ate displayed asks, a sell print bids: of what my orders already took there, that much is gone.
        if side != 0 {
            if let Some(shadow) = self.shadow.get_mut(code) {
                let taken = shadow.side(side == 1);
                if let Some(t) = taken.get_mut(&price) {
                    *t = (*t - volume).max(0.0);
                }
                taken.retain(|_, t| *t > 0.0);
            }
        }
        // One print fills my own orders at one price once, in their queue order: what an earlier one of mine took is
        // not there for a later one.
        let mut used: HashMap<i64, f64> = HashMap::new();
        let ids: Vec<String> = self.working_on(code).collect();
        for id in ids {
            let Some(order) = self.orders.get(&id).cloned() else { continue };
            if order.lot == Lot::Odd {
                continue;
            }
            let Some(limit) = order.limit(&book) else { continue };
            // A print beyond the order's price: everything at its price traded first (M6).
            if better(order.side, limit, price) {
                let qty = order.remaining_lots() * LOT;
                if qty > 0.0 {
                    self.fill(&id, qty, limit, ts, "穿價");
                }
                continue;
            }
            if price != limit {
                continue;
            }
            // A print at the order's price from the other side works off the queue ahead (M5).
            let toward = matches!((order.side, side), (Side::Buy, -1) | (Side::Sell, 1));
            if !toward {
                continue;
            }
            let Some(ahead) = order.ahead else { continue };
            if let Some(o) = self.orders.get_mut(&id) {
                o.ahead = Some((ahead - volume).max(0.0));
            }
            let taken_before = used.get(&limit).copied().unwrap_or(0.0);
            let lots = ((volume - ahead).max(0.0) - taken_before).floor().min(order.remaining_lots());
            if lots > 0.0 {
                *used.entry(limit).or_insert(0.0) += lots;
                self.fill(&id, lots * LOT, limit, ts, "排隊輪到");
            }
        }
    }

    /// A call auction's match (the first real print after 試撮): orders better than the match price fill at it,
    /// orders at it fill from what the match leaves after the queue ahead, worse ones keep waiting (M10).
    fn on_auction_match(&mut self, code: &str, price: i64, volume: f64, event: &MarketEvent) {
        let ts = event.exchange_ts_ns;
        let book = self.books.get(code).cloned().unwrap_or_default();
        // My orders at the match price share what the match leaves, in their queue order.
        let mut used = 0.0;
        let ids: Vec<String> = self.working_on(code).collect();
        for id in ids {
            let Some(order) = self.orders.get(&id).cloned() else { continue };
            let Some(limit) = order.limit(&book) else { continue };
            if !reaches(order.side, limit, price) || order.queued_odd() {
                continue;
            }
            match order.lot {
                Lot::Odd => {
                    let qty = order.remaining();
                    self.fill(&id, qty, price, ts, "集合競價（零股依整股價）");
                }
                Lot::Whole if limit != price => {
                    let qty = order.remaining_lots() * LOT;
                    self.fill(&id, qty, price, ts, "集合競價");
                }
                Lot::Whole => {
                    // Unknown place (no auction book showed its price): behind everything the match shows.
                    let ahead = order.ahead.unwrap_or(volume);
                    let lots = ((volume - ahead).max(0.0) - used).floor().min(order.remaining_lots());
                    if let Some(o) = self.orders.get_mut(&id) {
                        o.ahead = Some((ahead - volume).max(0.0));
                    }
                    if lots > 0.0 {
                        used += lots;
                        self.fill(&id, lots * LOT, price, ts, "集合競價");
                    }
                }
            }
        }
    }

    fn fill(&mut self, order_id: &str, qty: f64, price: i64, ts: i64, reason: &str) {
        let Some(order) = self.orders.get_mut(order_id) else { return };
        let qty = qty.min(order.remaining());
        if qty <= 0.0 {
            return;
        }
        order.filled += qty;
        order.fills += 1;
        let n = order.fills;
        let (code, side, date, remaining) = (order.code.clone(), order.side, order.trading_date.clone(), order.remaining());
        // A whole-lot order with less than a lot left (never: whole orders are whole lots) or nothing left is done.
        let done = remaining <= 1e-9 || (order.lot == Lot::Whole && remaining < LOT);
        self.emit(json!({"type": "fill", "id": format!("{order_id}-F{n}"), "order_id": order_id, "code": code, "side": side,
            "qty": qty, "price": price, "exchange_ts_ns": ts, "trading_date": date, "reason": reason}));
        if done {
            // Filled says it all: a done reason is why an order ended otherwise (改價, FOK, the close).
            self.finish(order_id, State::Filled, "", ts);
        }
    }

    fn finish(&mut self, order_id: &str, state: State, reason: &str, ts: i64) {
        let Some(order) = self.orders.get_mut(order_id) else { return };
        if order.state.done() {
            return;
        }
        let remaining = order.remaining();
        if state != State::Filled {
            order.removed += remaining;
        }
        order.state = state;
        order.ahead = None;
        let filled = order.filled;
        self.pending.retain(|p| !(matches!(p.command, Command::New { .. }) && p.command.order_id() == order_id));
        self.emit(json!({"type": "done", "id": format!("{order_id}-D"), "order_id": order_id, "state": state.name(),
            "reason": reason, "filled": filled, "unfilled": if state == State::Filled { 0.0 } else { remaining }, "exchange_ts_ns": ts}));
    }

    /// The day's close: every order of it still open expires (C5).
    /// Read off the clock's own time, in Taipei: the partition a clock is filed under is not always the day its time is
    /// on (Rust A keeps a scope's clock running after its day), and only the time says whether a day has closed.
    fn on_clock(&mut self, clock_ts_ns: i64) {
        let Some((today, minute)) = market_runtime::event::market_local_minute(MARKET, clock_ts_ns) else { return };
        let due: Vec<(String, i64)> = self.orders.values()
            .filter(|o| !o.state.done() && (o.trading_date < today || (o.trading_date == today && minute >= EXPIRE_MINUTE)))
            .map(|o| (o.order_id.clone(), expiry_ns(&o.trading_date))).collect();
        for (id, at) in due {
            self.finish(&id, State::Expired, "收盤未成交", at);
        }
    }

    /// An event of a later trading day: whatever an earlier day left open has expired, and the earlier days' orders
    /// leave memory (and the checkpoint): results.jsonl and the paper ledger keep them.
    fn expire_before(&mut self, trading_date: &str) {
        if trading_date.is_empty() || self.orders.values().all(|o| o.trading_date.as_str() >= trading_date) {
            return;
        }
        let due: Vec<(String, i64)> = self.orders.values()
            .filter(|o| !o.state.done() && o.trading_date.as_str() < trading_date)
            .map(|o| (o.order_id.clone(), expiry_ns(&o.trading_date))).collect();
        for (id, at) in due {
            self.finish(&id, State::Expired, "委託日已收盤", at);
        }
        let pending: HashSet<String> = self.pending.iter().map(|p| p.command.order_id().to_string()).collect();
        self.orders.retain(|id, o| o.trading_date.as_str() >= trading_date || pending.contains(id));
    }

    /// Append the records produced so far to results.jsonl. The queue estimate stays inside the matching: it decides
    /// the fills, and is never written out (user 2026-10-17: the place in the queue is not shown).
    pub fn flush(&mut self) {
        let Some(dir) = self.dir.clone() else {
            self.out.records.clear();
            return;
        };
        if self.reconcile && !self.out.records.is_empty() {
            // The last write failed after some bytes may have landed: a fragment goes, and what the file already has
            // is not written again.
            if !self.cut_torn_tail(&dir) {
                return;
            }
            let present: HashSet<String> = self.read_results(&dir).iter().filter_map(|r| r["id"].as_str().map(str::to_string)).collect();
            self.out.records.retain(|r| r["id"].as_str().is_none_or(|id| !present.contains(id)));
            self.reconcile = false;
        }
        if !self.out.records.is_empty() {
            let path = dir.join(RESULTS_FILE);
            match append_lines(&path, &self.out.records) {
                Ok(()) => self.out.records.clear(),
                Err(error) => {
                    // Kept for the next turn: a record is never dropped.
                    self.reconcile = true;
                    let kept = format!("appending ({} records kept)", self.out.records.len());
                    self.io_error(IoStage::ResultsWrite, &path, &kept, error);
                }
            }
        }
    }

    /// Records produced and not written yet (a failed write keeps them).
    #[cfg(test)]
    pub fn unflushed(&self) -> usize {
        self.out.records.len()
    }

    #[cfg(test)]
    fn take_records(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.out.records)
    }
}

fn state_label(state: State) -> &'static str {
    match state {
        State::Filled => "全部成交",
        State::Cancelled => "取消",
        State::Expired => "失效",
        State::Rejected => "被拒絕",
        State::Pending | State::Working => "有效",
    }
}

/// When the orders of `trading_date` still open at the close expired: the same in a live pass and a rebuild, whenever
/// the event that tells of it arrives.
fn expiry_ns(trading_date: &str) -> i64 {
    market_runtime::rollover::taipei_minute_ns(trading_date, EXPIRE_MINUTE).unwrap_or(0)
}

/// Bytes after the file's last newline, cut off and synced. No file: nothing to cut.
fn cut_to_last_line(path: &Path) -> io::Result<usize> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let whole = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    if whole < bytes.len() {
        let file = OpenOptions::new().write(true).open(path)?;
        file.set_len(whole as u64)?;
        file.sync_all()?;
    }
    Ok(bytes.len() - whole)
}

fn append_lines(path: &Path, records: &[Value]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut text = String::new();
    for record in records {
        text.push_str(&record.to_string());
        text.push('\n');
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_data()
}

#[cfg(test)]
mod tests {
    use super::*;
    use market_runtime::event::EventFlags;

    const P: i64 = 10_000; // one dollar

    fn base(code: &str, seq: u64, ts_s: i64, payload: Payload) -> MarketEvent {
        MarketEvent {
            schema_version: 2, event_id: String::new(), durable_sequence: seq, symbol: format!("shioaji:STK:{code}"),
            provider: "shioaji".into(), market: "STK".into(), code: code.into(), session: "DAY".into(), trading_date: "2026-10-16".into(),
            generation: 1, sequence: seq, exchange_ts_ns: ts_s * 1_000_000_000, arrival_ns: 0,
            a_received_ns: (ts_s * 1_000_000_000) as u64 + 50_000_000, runtime_epoch: 1, time_quality: "exchange".into(),
            trace_id: String::new(), flags: EventFlags::default(), versions: Default::default(), payload,
        }
    }

    fn book(code: &str, seq: u64, ts: i64, bids: &[(f64, f64)], asks: &[(f64, f64)], simtrade: bool) -> MarketEvent {
        let lv = |v: &[(f64, f64)]| v.iter().map(|&(p, q)| BookLevel { price: (p * P as f64) as i64, volume: q }).collect();
        base(code, seq, ts, Payload::OrderBook { bids: lv(bids), asks: lv(asks), simtrade })
    }

    fn trade(code: &str, seq: u64, ts: i64, price: f64, volume: f64, side: i8, simtrade: bool) -> MarketEvent {
        base(code, seq, ts, Payload::Trade { price: (price * P as f64) as i64, volume, total_volume: 0.0, side, trade_id: seq.to_string(),
            minute: 0, open: 0, high: 0, low: 0, average: 0, total_amount: 0.0, amount: 0.0, simtrade,
            bid_side_total_vol: None, ask_side_total_vol: None, auction: false, after_hours: false, condition: None, no_last_sale: false })
    }

    fn new(id: &str, side: Side, lot: Lot, price: Option<f64>, qty: f64, tif: Tif, accepted_s: i64) -> Command {
        Command::New { cmd_id: id.into(), order_id: id.into(), accepted_ns: (accepted_s * 1_000_000_000) as u64,
            trading_date: "2026-10-16".into(), code: "2330".into(), side, lot,
            price_type: if price.is_some() { PriceType::Limit } else { PriceType::Market },
            price: price.map(|p| (p * P as f64) as i64), qty, tif, odd_matching: OddMatching::Direct }
    }

    fn fills(records: &[Value]) -> Vec<(f64, f64, String)> {
        records.iter().filter(|r| r["type"] == "fill")
            .map(|r| (r["qty"].as_f64().unwrap(), r["price"].as_f64().unwrap() / P as f64, r["reason"].as_str().unwrap().to_string())).collect()
    }

    fn done(records: &[Value]) -> Vec<String> {
        records.iter().filter(|r| r["type"] == "done").map(|r| r["state"].as_str().unwrap().to_string()).collect()
    }

    /// §4 of the design: 260 ahead at 100.0, prints and cancellations work it off, a partial fill, then a print through.
    #[test]
    fn the_design_example_queues_partially_fills_then_fills_through() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 250.0)], &[(100.5, 80.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 3000.0, Tif::ROD, 102), 1);
        // Before the delay has passed the order is not at the exchange.
        d.apply(&book("2330", 2, 101, &[(100.0, 260.0)], &[(100.5, 80.0)], false), 2);
        assert_eq!(d.orders["A"].state, State::Pending);
        d.apply(&book("2330", 3, 102, &[(100.0, 260.0)], &[(100.5, 80.0)], false), 3);
        assert_eq!(d.orders["A"].state, State::Working);
        assert_eq!(d.orders["A"].ahead, Some(260.0), "ahead = the volume shown when it arrived");
        d.apply(&trade("2330", 4, 103, 100.0, 40.0, -1, false), 4);
        assert_eq!(d.orders["A"].ahead, Some(220.0));
        // The level shrank by 40 more than the prints: cancellations, all ahead of us.
        d.apply(&book("2330", 5, 104, &[(100.0, 180.0)], &[(100.5, 80.0)], false), 5);
        assert_eq!(d.orders["A"].ahead, Some(180.0));
        // A buy-side print at 100.0 does not move a bid's queue.
        d.apply(&trade("2330", 6, 105, 100.0, 50.0, 1, false), 6);
        assert_eq!(d.orders["A"].ahead, Some(180.0));
        d.apply(&trade("2330", 7, 106, 100.0, 182.0, -1, false), 7);
        assert_eq!(fills(&d.take_records()), vec![(2000.0, 100.0, "排隊輪到".into())]);
        assert_eq!(d.orders["A"].remaining(), 1000.0);
        d.apply(&trade("2330", 8, 107, 99.5, 5.0, -1, false), 8);
        let records = d.take_records();
        assert_eq!(fills(&records), vec![(1000.0, 100.0, "穿價".into())]);
        assert_eq!(done(&records), vec!["filled"]);
        // The state is the whole answer: no reason repeats it (the 經過 would read 全部成交：全部成交).
        assert_eq!(records.iter().find(|r| r["type"] == "done").unwrap()["reason"], "");
    }

    fn results_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("paper-torn-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lines_of(dir: &Path) -> Vec<Value> {
        fs::read_to_string(dir.join(RESULTS_FILE)).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn a_fragment_at_the_end_of_results_is_cut_when_the_desk_opens() {
        let dir = results_dir("open");
        fs::write(dir.join(RESULTS_FILE), "{\"type\":\"read\",\"id\":\"A-R\",\"cmd_id\":\"A\",\"after_sequence\":1}\n{\"type\":\"fill\",\"id\":\"A-").unwrap();
        let mut d = PaperDesk::default();
        d.open(Some(dir.clone()));
        d.emit(json!({"type": "done", "id": "A-D"}));
        d.flush();
        let ids: Vec<Value> = lines_of(&dir).iter().map(|r| r["id"].clone()).collect();
        assert_eq!(ids, vec![json!("A-R"), json!("A-D")], "the next record starts a line of its own");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fragment_a_failed_write_left_is_cut_before_the_retry() {
        let dir = results_dir("retry");
        let mut d = PaperDesk::default();
        d.open(Some(dir.clone()));
        fs::write(dir.join(RESULTS_FILE), "{\"id\":\"A-R\"}\n{\"id\":\"A-").unwrap();
        d.reconcile = true;
        d.out.records = vec![json!({"id": "A-R"}), json!({"id": "A-E"})];
        d.flush();
        let ids: Vec<Value> = lines_of(&dir).iter().map(|r| r["id"].clone()).collect();
        assert_eq!(ids, vec![json!("A-R"), json!("A-E")], "what landed whole is not written twice, the fragment is gone");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_durable_gap_is_said_once_on_each_order_at_the_exchange_and_freezes_nothing() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 1.0)], &[(100.5, 1.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 1);
        d.receive(new("P", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 900), 1);
        d.apply(&book("2330", 2, 101, &[(100.0, 1.0)], &[(100.5, 1.0)], false), 2);
        d.take_records();
        d.on_durable_gap(7, 123);
        d.on_durable_gap(7, 456);
        let records = d.take_records();
        assert_eq!(records.len(), 1, "only the order at the exchange, once per gap: {records:?}");
        assert_eq!((records[0]["type"].as_str(), records[0]["id"].as_str(), records[0]["exchange_ts_ns"].as_i64()),
                   (Some("notice"), Some("A-G7"), Some(123)));
        d.apply(&trade("2330", 8, 102, 99.5, 5.0, -1, false), 8);
        assert_eq!(fills(&d.take_records()), vec![(1000.0, 100.0, "穿價".into())], "the market after the gap still fills it");
    }

    #[test]
    fn an_order_that_expires_is_stamped_with_its_own_day_s_close_on_either_path() {
        let close = market_runtime::rollover::taipei_minute_ns("2026-10-16", EXPIRE_MINUTE).unwrap();
        let entered = || {
            let mut d = PaperDesk::default();
            d.apply(&book("2330", 1, 100, &[(100.0, 1.0)], &[(100.5, 1.0)], false), 1);
            d.receive(new("A", Side::Buy, Lot::Whole, Some(90.0), 1000.0, Tif::ROD, 100), 1);
            d.apply(&book("2330", 2, 101, &[(100.0, 1.0)], &[(100.5, 1.0)], false), 2);
            d.take_records();
            d
        };
        let mut by_clock = entered();
        let mut clock = base(CLOCK_CODE, 3, close / 1_000_000_000 + 3600, Payload::Clock { minute: 14 * 60 + 31 });
        clock.code = CLOCK_CODE.into();
        by_clock.apply(&clock, 3);
        let records = by_clock.take_records();
        assert_eq!(done(&records), vec!["expired"]);
        assert_eq!(records.iter().find(|r| r["type"] == "done").unwrap()["exchange_ts_ns"], close);

        let mut by_next_day = entered();
        let mut next = book("2330", 3, 400_000, &[(100.0, 1.0)], &[(100.5, 1.0)], false);
        next.trading_date = "2026-10-19".into();
        by_next_day.apply(&next, 3);
        let records = by_next_day.take_records();
        assert_eq!(done(&records), vec!["expired"]);
        assert_eq!(records.iter().find(|r| r["type"] == "done").unwrap()["exchange_ts_ns"], close, "whenever the next day's event came");
    }

    #[test]
    fn a_print_that_sets_no_last_sale_fills_nothing() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 10.0)], &[(100.5, 80.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(100.0, 10.0)], &[(100.5, 80.0)], false), 2);
        let mut odd = trade("2330", 3, 102, 99.0, 50.0, -1, false);
        if let Payload::Trade { no_last_sale, .. } = &mut odd.payload {
            *no_last_sale = true;
        }
        d.apply(&odd, 3);
        assert!(fills(&d.take_records()).is_empty(), "an average-price print below the bid is no print through it");
        assert_eq!(d.orders["A"].ahead, Some(10.0), "nor does it work off the queue");
    }

    #[test]
    fn a_marketable_order_walks_the_book_and_rests_the_rest() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(99.5, 10.0)], &[(100.0, 2.0), (100.5, 3.0), (101.0, 9.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.5), 7000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(99.5, 10.0)], &[(100.0, 2.0), (100.5, 3.0), (101.0, 9.0)], false), 2);
        let records = d.take_records();
        assert_eq!(fills(&records), vec![(2000.0, 100.0, "吃單".into()), (3000.0, 100.5, "吃單".into())]);
        assert_eq!(d.orders["A"].remaining(), 2000.0);
        assert_eq!(d.orders["A"].ahead, Some(0.0), "the rest is the best bid, nobody ahead");
        // The same displayed asks are not handed to the order again.
        d.apply(&book("2330", 3, 102, &[(99.5, 10.0)], &[(100.0, 2.0), (100.5, 3.0), (101.0, 9.0)], false), 3);
        assert!(fills(&d.take_records()).is_empty());
        // A new ask volume at 100.5 beyond what the order took trades with it at its own price.
        d.apply(&book("2330", 4, 103, &[(99.5, 10.0)], &[(100.5, 6.0), (101.0, 9.0)], false), 4);
        assert_eq!(fills(&d.take_records()), vec![(2000.0, 100.5, "穿價".into())]);
    }

    #[test]
    fn ioc_cancels_the_rest_and_fok_all_or_nothing() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(99.5, 10.0)], &[(100.0, 2.0)], false), 1);
        d.receive(new("I", Side::Buy, Lot::Whole, Some(100.0), 5000.0, Tif::IOC, 100), 1);
        d.receive(new("F", Side::Buy, Lot::Whole, Some(100.0), 5000.0, Tif::FOK, 100), 1);
        d.apply(&book("2330", 2, 101, &[(99.5, 10.0)], &[(100.0, 2.0)], false), 2);
        let records = d.take_records();
        assert_eq!(fills(&records), vec![(2000.0, 100.0, "吃單".into())]);
        assert_eq!(d.orders["I"].state, State::Cancelled);
        assert_eq!(d.orders["F"].state, State::Cancelled);
        assert_eq!(d.orders["F"].filled, 0.0);
    }

    #[test]
    fn a_price_deeper_than_the_book_waits_until_it_shows() {
        let mut d = PaperDesk::default();
        let bids = [(100.0, 1.0), (99.5, 1.0), (99.0, 1.0), (98.5, 1.0), (98.0, 1.0)];
        d.apply(&book("2330", 1, 100, &bids, &[(100.5, 1.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(97.0), 1000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &bids, &[(100.5, 1.0)], false), 2);
        assert_eq!(d.orders["A"].ahead, None, "beyond the fifth level: unknown");
        d.apply(&book("2330", 3, 102, &[(98.0, 1.0), (97.5, 2.0), (97.0, 40.0)], &[(98.5, 1.0)], false), 3);
        assert_eq!(d.orders["A"].ahead, Some(40.0));
    }

    #[test]
    fn a_level_left_without_prints_puts_the_order_first() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 30.0), (99.5, 5.0)], &[(100.5, 1.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(100.0, 30.0), (99.5, 5.0)], &[(100.5, 1.0)], false), 2);
        assert_eq!(d.orders["A"].ahead, Some(30.0));
        // 100.0 is gone, the best bid is now 99.5: everyone ahead cancelled.
        d.apply(&book("2330", 3, 102, &[(99.5, 5.0)], &[(100.5, 1.0)], false), 3);
        assert_eq!(d.orders["A"].ahead, Some(0.0));
        d.apply(&trade("2330", 4, 103, 100.0, 1.0, -1, false), 4);
        assert_eq!(fills(&d.take_records()), vec![(1000.0, 100.0, "排隊輪到".into())]);
    }

    #[test]
    fn odd_lots_fill_whole_at_the_whole_lot_best_price() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(99.5, 10.0)], &[(100.0, 2.0)], false), 1);
        let mut official = trade("2330", 1, 100, 0.0, 0.0, 0, false);
        official.payload = Payload::Reference { limit_up: Some(1_090_000), limit_down: Some(900_000), prev_close: None,
            prev_volume: None, reference_price: None, name: None, reference_source: None };
        d.apply(&official, 0);
        d.receive(new("O", Side::Buy, Lot::Odd, Some(99.5), 300.0, Tif::ROD, 100), 1);
        d.receive(new("M", Side::Buy, Lot::Odd, None, 50.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(99.5, 10.0)], &[(100.0, 2.0)], false), 2);
        assert_eq!(fills(&d.take_records()), vec![(50.0, 100.0, "零股（依整股價）".into())]);
        assert_eq!(d.orders["O"].state, State::Working, "no queue, but the ask has not come down to 99.5");
        d.apply(&book("2330", 3, 102, &[(99.0, 10.0)], &[(99.5, 1.0)], false), 3);
        assert_eq!(fills(&d.take_records()), vec![(300.0, 99.5, "零股（依整股價）".into())]);
    }

    #[test]
    fn the_opening_auction_fills_better_prices_and_queues_equal_ones() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 50.0)], &[(100.5, 30.0)], true), 1);
        d.receive(new("B", Side::Buy, Lot::Whole, Some(101.0), 2000.0, Tif::ROD, 100), 1);
        d.receive(new("E", Side::Buy, Lot::Whole, Some(100.5), 3000.0, Tif::ROD, 100), 1);
        d.receive(new("W", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 1);
        d.receive(new("I", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::IOC, 100), 1);
        d.apply(&book("2330", 2, 101, &[(100.0, 50.0)], &[(100.5, 30.0)], true), 2);
        assert_eq!(d.orders["I"].state, State::Rejected, "only ROD in a call auction");
        assert!(fills(&d.take_records()).is_empty(), "試撮 never fills");
        assert_eq!(d.orders["E"].ahead, Some(0.0), "nobody shown at 100.5 on the bid side");
        d.apply(&trade("2330", 3, 102, 100.5, 2.0, 0, false), 3);
        let f = fills(&d.take_records());
        assert_eq!(f, vec![(2000.0, 100.5, "集合競價".into()), (2000.0, 100.5, "集合競價".into())]);
        assert_eq!(d.orders["E"].remaining(), 1000.0, "at the match price: only what the match volume leaves");
        assert_eq!(d.orders["W"].filled, 0.0);
        assert!(!d.books["2330"].auction, "continuous trading after the match");
    }

    #[test]
    fn cancel_reduce_and_expiry() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 30.0)], &[(100.5, 1.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 3000.0, Tif::ROD, 100), 1);
        d.receive(new("B", Side::Buy, Lot::Whole, Some(100.0), 3000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(100.0, 30.0)], &[(100.5, 1.0)], false), 2);
        d.receive(Command::Reduce { cmd_id: "A:r1".into(), order_id: "A".into(), accepted_ns: 102_000_000_000, qty: 1000.0 }, 2);
        d.receive(Command::Cancel { cmd_id: "B:c1".into(), order_id: "B".into(), accepted_ns: 102_000_000_000 }, 2);
        d.apply(&book("2330", 3, 103, &[(100.0, 30.0)], &[(100.5, 1.0)], false), 3);
        assert_eq!(d.orders["A"].remaining(), 2000.0);
        assert_eq!(d.orders["A"].ahead, Some(30.0), "a reduction keeps the place");
        assert_eq!(d.orders["B"].state, State::Cancelled);
        // A cancel of a finished order fails.
        d.receive(Command::Cancel { cmd_id: "B:c2".into(), order_id: "B".into(), accepted_ns: 103_000_000_000 }, 3);
        d.apply(&book("2330", 4, 104, &[(100.0, 30.0)], &[(100.5, 1.0)], false), 4);
        assert!(d.take_records().iter().any(|r| r["type"] == "refused" && r["cmd_id"] == "B:c2"));
        // 2026-10-16 13:31 Taipei is 05:31 UTC.
        let at = |minute: i64| (market_runtime::event::days_from_civil(2026, 10, 16) * 86_400 + minute * 60 - 8 * 3600) * 1_000_000_000;
        let mut clock = base("*", 5, 0, Payload::Clock { minute: EXPIRE_MINUTE });
        clock.code = CLOCK_CODE.into();
        clock.exchange_ts_ns = at(EXPIRE_MINUTE as i64 - 1);
        d.apply(&clock, 5);
        assert_eq!(d.orders["A"].state, State::Working, "13:30 is not past the close auction yet");
        // A clock filed under another day but reading this day's 13:31 closes it; its label does not matter.
        clock.exchange_ts_ns = at(EXPIRE_MINUTE as i64);
        clock.trading_date = "2099-01-01".into();
        d.apply(&clock, 6);
        assert_eq!(d.orders["A"].state, State::Expired);
    }

    /// The lines paper_account_api writes (tests/test_paper_orders.py compares its own with this file).
    #[test]
    fn the_commands_paper_account_api_writes_are_read() {
        let commands: Vec<Command> = include_str!("../../../tests/fixtures/paper_commands.jsonl").lines().filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l}: {e}"))).collect();
        assert!(matches!(&commands[0], Command::New { qty, price: Some(1_005_000), tif: Tif::ROD, lot: Lot::Whole, .. } if *qty == 2000.0));
        assert!(matches!(&commands[1], Command::Reduce { .. }));
        assert!(matches!(&commands[2], Command::Replace { order_id, price: 1_000_000, .. } if order_id == "PO-20261016-0001"));
        assert!(matches!(&commands[3], Command::Cancel { .. }));
    }

    #[test]
    fn a_price_change_keeps_the_order_and_requeues_the_rest_at_the_back() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 30.0), (99.5, 20.0)], &[(100.5, 1.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 3000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(100.0, 30.0), (99.5, 20.0)], &[(100.5, 1.0)], false), 2);
        d.apply(&trade("2330", 3, 102, 100.0, 31.0, -1, false), 3);
        assert_eq!(d.orders["A"].remaining(), 2000.0);
        d.take_records();
        d.receive(Command::Replace { cmd_id: "A:p1".into(), order_id: "A".into(),
            accepted_ns: 103_000_000_000, price: (99.5 * P as f64) as i64 }, 3);
        d.apply(&book("2330", 4, 104, &[(99.5, 20.0)], &[(100.0, 1.0)], false), 4);
        // The same order, its number kept: working at 99.5 with what it had left, at the back of 99.5's queue.
        assert_eq!(d.orders.len(), 1, "no second order");
        let a = &d.orders["A"];
        assert_eq!((a.state, a.price, a.filled, a.remaining()), (State::Working, Some((99.5 * P as f64) as i64), 1000.0, 2000.0));
        assert_eq!(a.ahead, Some(20.0), "the back of 99.5's queue");
        let records = d.take_records();
        let replaced = records.iter().find(|r| r["type"] == "replaced").expect("a replaced record");
        assert_eq!((replaced["order_id"].as_str(), replaced["qty"].as_f64()), (Some("A"), Some(2000.0)));
        assert!(replaced.get("new_order_id").is_none());
        assert!(!records.iter().any(|r| r["type"] == "done"), "the order is not cancelled by its change: {records:?}");
        // A price outside the day's limits is refused and the order stays at 99.5 in its place.
        d.books.get_mut("2330").unwrap().limit_down = Some((95.0 * P as f64) as i64);
        d.receive(Command::Replace { cmd_id: "A:p2".into(), order_id: "A".into(),
            accepted_ns: 104_000_000_000, price: (90.0 * P as f64) as i64 }, 4);
        d.apply(&book("2330", 5, 105, &[(99.5, 20.0)], &[(100.0, 1.0)], false), 5);
        assert!(d.take_records().iter().any(|r| r["type"] == "refused" && r["cmd_id"] == "A:p2"));
        assert_eq!((d.orders["A"].state, d.orders["A"].price), (State::Working, Some((99.5 * P as f64) as i64)));
        // A change that comes after the order finished fails.
        d.receive(Command::Cancel { cmd_id: "A:c3".into(), order_id: "A".into(), accepted_ns: 106_000_000_000 }, 5);
        d.apply(&book("2330", 6, 107, &[(99.5, 20.0)], &[(100.0, 1.0)], false), 6);
        d.receive(Command::Replace { cmd_id: "A:p4".into(), order_id: "A".into(),
            accepted_ns: 107_000_000_000, price: (99.0 * P as f64) as i64 }, 6);
        d.apply(&book("2330", 7, 108, &[(99.5, 20.0)], &[(100.0, 1.0)], false), 7);
        assert!(d.take_records().iter().any(|r| r["type"] == "refused" && r["cmd_id"] == "A:p4"));
        assert_eq!(d.orders["A"].state, State::Cancelled);
    }

    #[test]
    fn a_coverage_loss_is_noted_on_the_working_orders() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 30.0)], &[(100.5, 1.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(100.0, 30.0)], &[(100.5, 1.0)], false), 2);
        let status = |seq, state: &str| base("2330", seq, 102, Payload::SourceStatus { state: state.into(), detail: String::new() });
        d.apply(&status(3, "subscribed"), 3);
        d.apply(&status(4, "unsubscribed"), 4);
        d.apply(&status(5, "subscribed"), 5);
        let notes: Vec<String> = d.take_records().iter().filter(|r| r["type"] == "notice").map(|r| r["reason"].as_str().unwrap().to_string()).collect();
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(notes[0].contains("無法撮合") && notes[1].contains("恢復"));
        assert_eq!(d.orders["A"].state, State::Working, "nothing filled or cancelled for the gap");
    }

    /// A rebuild reads the whole journal at the start of the stream: each order waits (Pending) for the position it
    /// was read at. The coverage controls of the stream before that are not the order's (11-07: 168 notices of
    /// 10-30..11-01 on orders placed 11-02).
    #[test]
    fn coverage_controls_before_an_order_reached_the_exchange_are_not_its_own() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(100.0, 30.0)], &[(100.5, 1.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 10);
        let status = |seq, state: &str| base("2330", seq, 102, Payload::SourceStatus { state: state.into(), detail: String::new() });
        d.apply(&status(3, "unsubscribed"), 3);
        d.apply(&status(4, "subscribed"), 4);
        assert_eq!(d.orders["A"].state, State::Pending, "not at the exchange before its recorded position");
        assert!(d.take_records().iter().all(|r| r["type"] != "notice"), "no notice for the days before the order");
        d.apply(&book("2330", 11, 103, &[(100.0, 30.0)], &[(100.5, 1.0)], false), 11);
        assert_eq!(d.orders["A"].state, State::Working);
        d.apply(&status(12, "unsubscribed"), 12);
        let notes: Vec<String> = d.take_records().iter().filter(|r| r["type"] == "notice").map(|r| r["reason"].as_str().unwrap().to_string()).collect();
        assert_eq!(notes, vec!["行情中斷（訂閱中止）：這段期間無法撮合".to_string()], "once at the exchange it is told");
    }

    /// Codex 10-17 #3: the asks an order took are worked off by buy prints, which never move a buy's queue.
    #[test]
    fn taken_asks_and_the_queue_do_not_share_one_print() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(99.5, 10.0)], &[(100.0, 3.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 5000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(99.5, 10.0)], &[(100.0, 3.0)], false), 2);
        assert_eq!(d.orders["A"].filled, 3000.0);
        d.take_records();
        d.apply(&trade("2330", 3, 102, 100.0, 3.0, 1, false), 3);
        assert!(fills(&d.take_records()).is_empty(), "a buy print at 100 ate the asks it took, it does not fill the bid");
        d.apply(&trade("2330", 4, 103, 100.0, 1.0, -1, false), 4);
        assert_eq!(fills(&d.take_records()), vec![(1000.0, 100.0, "排隊輪到".into())]);
    }

    /// Codex 10-17 #4: my own orders at one price share one print, and one displayed level, in their queue order.
    #[test]
    fn my_orders_at_one_price_share_a_print_and_a_level() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(99.5, 10.0)], &[(100.5, 2.0)], false), 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 1);
        d.receive(new("B", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 1);
        d.apply(&book("2330", 2, 101, &[(99.5, 10.0)], &[(100.5, 2.0)], false), 2);
        d.apply(&trade("2330", 3, 102, 100.0, 1.0, -1, false), 3);
        let f: Vec<String> = d.take_records().iter().filter(|r| r["type"] == "fill").map(|r| r["order_id"].as_str().unwrap().to_string()).collect();
        assert_eq!(f, vec!["A".to_string()], "one lot traded: the first of mine only");
        // Two marketable buys meet the same 2 displayed lots: 2 lots between them, not 4.
        d.receive(new("C", Side::Buy, Lot::Whole, Some(100.5), 2000.0, Tif::ROD, 103), 3);
        d.receive(new("D", Side::Buy, Lot::Whole, Some(100.5), 2000.0, Tif::ROD, 103), 3);
        d.apply(&book("2330", 4, 104, &[(99.5, 10.0)], &[(100.5, 2.0)], false), 4);
        assert_eq!(d.orders["C"].filled + d.orders["D"].filled, 2000.0);
    }

    /// Codex 10-17 #5: an order of today never meets yesterday's book; today's auction book gives it its place.
    #[test]
    fn yesterdays_book_is_no_market_for_today() {
        let mut d = PaperDesk::default();
        let mut old = book("2330", 1, 100, &[(99.5, 10.0)], &[(100.0, 9.0)], false);
        old.trading_date = "2026-10-15".into();
        d.apply(&old, 1);
        d.receive(new("A", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100), 1);
        d.receive(new("I", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::IOC, 100), 1);
        d.apply(&book("2330", 2, 101, &[(100.0, 40.0)], &[(100.5, 5.0)], true), 2);
        assert_eq!(d.orders["A"].filled, 0.0, "no fill against the 10-15 close");
        assert_eq!(d.orders["I"].state, State::Cancelled);
        assert_eq!(d.orders["A"].ahead, Some(40.0), "behind what today's auction shows at 100");
    }

    /// A market order is matched at the day's official 漲停 / 跌停 (the provider's Reference): without them it is
    /// refused, whatever its TIF, and 昨收 alone never prices one.
    #[test]
    fn market_orders_need_the_official_limits() {
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(99.5, 10.0)], &[(100.0, 2.0)], false), 1);
        d.receive(new("F", Side::Buy, Lot::Whole, None, 5000.0, Tif::FOK, 100), 1);
        d.receive(new("I", Side::Buy, Lot::Whole, None, 1000.0, Tif::IOC, 100), 1);
        let mut prev_close_only = trade("2330", 2, 101, 0.0, 0.0, 0, false);
        prev_close_only.payload = Payload::Reference { limit_up: None, limit_down: None, prev_close: Some(1_000_000),    // 昨收 100
            prev_volume: None, reference_price: None, name: None, reference_source: None };
        d.apply(&prev_close_only, 2);
        d.receive(new("R", Side::Buy, Lot::Whole, None, 1000.0, Tif::ROD, 101), 2);
        d.apply(&book("2330", 3, 102, &[(99.5, 10.0)], &[(100.0, 2.0)], false), 3);
        for id in ["F", "I", "R"] {
            assert_eq!(d.orders[id].state, State::Rejected, "{id}: no official limits yet");
            assert_eq!(d.orders[id].filled, 0.0, "{id}");
        }
        let mut official = trade("2330", 4, 103, 0.0, 0.0, 0, false);
        official.payload = Payload::Reference { limit_up: Some(1_100_000), limit_down: Some(900_000), prev_close: None,
            prev_volume: None, reference_price: None, name: None, reference_source: None };
        d.apply(&official, 4);
        d.receive(new("M", Side::Buy, Lot::Whole, None, 5000.0, Tif::ROD, 104), 4);
        d.apply(&book("2330", 5, 105, &[(99.5, 10.0)], &[(100.0, 2.0)], false), 5);
        assert_eq!(d.orders["M"].filled, 2000.0);
        assert_eq!(d.orders["M"].limit(&d.books["2330"]), Some(1_100_000), "the rest rests at the official 漲停");
    }

    #[test]
    fn a_journal_read_and_a_results_write_failure_are_counted_by_stage_with_the_last_error() {
        let dir = std::env::temp_dir().join(format!("paper-io-{}-{}", std::process::id(), line!()));
        let _ = fs::remove_dir_all(&dir);
        // Both files are directories: the journal cannot be read, the results cannot be appended.
        fs::create_dir_all(dir.join(ORDERS_FILE)).unwrap();
        fs::create_dir_all(dir.join(RESULTS_FILE)).unwrap();
        let mut d = PaperDesk::default();
        d.open(Some(dir.clone()));
        let after_open = d.io_errors.wire();
        assert_eq!(after_open["results_read"], 1, "{after_open}");
        d.poll_commands(0);
        d.emit(json!({"type": "fill", "id": "X-F1"}));
        d.flush();
        let w = d.io_errors.wire();
        assert_eq!((w["journal_read"].as_u64(), w["results_write"].as_u64()), (Some(1), Some(2)), "cutting the tail failed at the open and before the write: {w}");
        assert_eq!(w["last"]["stage"], "results_write");
        assert!(w["last"]["path"].as_str().unwrap().ends_with(RESULTS_FILE), "{w}");
        assert_eq!(d.unflushed(), 1, "the record is kept for the next write");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Codex 10-17 #1 / #13: records not yet written travel in the checkpoint, and a write that failed part-way is
    /// not repeated.
    #[test]
    fn unwritten_records_survive_a_checkpoint_and_a_partial_write() {
        let dir = std::env::temp_dir().join(format!("paper-unwritten-{}-{}", std::process::id(), line!()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut d = PaperDesk::default();
        d.open(Some(dir.clone()));
        d.emit(json!({"type": "fill", "id": "X-F1"}));
        d.emit(json!({"type": "fill", "id": "X-F2"}));
        let checkpoint: PaperCheckpoint = serde_json::from_str(&serde_json::to_string(&d.checkpoint()).unwrap()).unwrap();
        // The crash came after X-F1 reached the file.
        fs::write(dir.join(RESULTS_FILE), "{\"type\":\"fill\",\"id\":\"X-F1\"}\n").unwrap();
        let mut restored = PaperDesk::restore(checkpoint);
        restored.open(Some(dir.clone()));
        restored.flush();
        let ids: Vec<String> = fs::read_to_string(dir.join(RESULTS_FILE)).unwrap().lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap()["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["X-F1", "X-F2"]);
        // A failed write that left its first line behind: the retry does not write it twice.
        restored.emit(json!({"type": "fill", "id": "X-F3"}));
        restored.emit(json!({"type": "fill", "id": "X-F4"}));
        let mut f = OpenOptions::new().append(true).open(dir.join(RESULTS_FILE)).unwrap();
        writeln!(f, "{{\"type\":\"fill\",\"id\":\"X-F3\"}}").unwrap();
        restored.reconcile = true;
        restored.flush();
        let count = |id: &str| fs::read_to_string(dir.join(RESULTS_FILE)).unwrap().matches(&format!("\"{id}\"")).count();
        assert_eq!((count("X-F3"), count("X-F4")), (1, 1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rebuild_enters_at_the_recorded_position_and_writes_nothing_twice() {
        let dir = std::env::temp_dir().join(format!("paper-test-{}-{}", std::process::id(), line!()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let cmd = new("A", Side::Buy, Lot::Whole, Some(100.0), 1000.0, Tif::ROD, 100);
        fs::write(dir.join(ORDERS_FILE), format!("{}\n", serde_json::to_string(&cmd).unwrap())).unwrap();
        let events = vec![book("2330", 1, 100, &[(100.0, 5.0)], &[(100.5, 1.0)], false), book("2330", 2, 101, &[(100.0, 6.0)], &[(100.5, 1.0)], false),
                          trade("2330", 3, 102, 100.0, 7.0, -1, false)];
        let run = |dir: &Path, read_at: u64| {
            let mut d = PaperDesk::default();
            d.open(Some(dir.to_path_buf()));
            for e in &events {
                if e.durable_sequence == read_at {
                    d.poll_commands(read_at);
                }
                d.apply(e, e.durable_sequence);
            }
            d.flush();
            d
        };
        let first = run(&dir, 1);
        assert_eq!(first.orders["A"].state, State::Filled);
        let written = fs::read_to_string(dir.join(RESULTS_FILE)).unwrap();
        // The rebuild reads the command before the first event but enters where the live pass did.
        let second = run(&dir, 1);
        assert_eq!(second.orders["A"].state, State::Filled);
        assert_eq!(fs::read_to_string(dir.join(RESULTS_FILE)).unwrap(), written, "nothing written twice");
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn books_are_of_the_days_being_matched_and_a_reference_starts_its_day() {
        // Codex 1020-R04-05: a book was kept for every stock that ever sent a quote, for good. A new day's book
        // replaces each stock's, and every book of an earlier day leaves with the first one.
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(99.0, 5.0)], &[(100.0, 5.0)], false), 1);
        d.apply(&book("2454", 2, 100, &[(49.0, 5.0)], &[(50.0, 5.0)], false), 2);
        assert_eq!(d.books.len(), 2);
        // The next day's limits come first (a Reference names its day too): they are not lost to the day's first book.
        let mut limits = base("2330", 3, 90_000, serde_json::from_value(json!({"kind": "reference", "limit_up": 1_090_000, "limit_down": 900_000})).unwrap());
        limits.trading_date = "2026-10-19".into();
        d.apply(&limits, 3);
        assert_eq!(d.books.keys().collect::<Vec<_>>(), vec!["2330"], "the earlier day's books left");
        let mut next = book("2330", 4, 90_100, &[(99.0, 5.0)], &[(100.0, 5.0)], false);
        next.trading_date = "2026-10-19".into();
        d.apply(&next, 4);
        let today = &d.books["2330"];
        assert_eq!((today.trading_date.as_str(), today.limit_up, today.limit_down), ("2026-10-19", Some(1_090_000), Some(900_000)));
    }


    /// The same event of the stock's 盤中零股 (market ODD).
    fn odd(mut event: MarketEvent) -> MarketEvent {
        event.market = ODD_MARKET.into();
        event.symbol = format!("shioaji:{ODD_MARKET}:{}", event.code);
        event
    }

    fn queued(id: &str, side: Side, price: Option<f64>, qty: f64, tif: Tif, accepted_s: i64) -> Command {
        match new(id, side, Lot::Odd, price, qty, tif, accepted_s) {
            Command::New { cmd_id, order_id, accepted_ns, trading_date, code, side, lot, price_type, price, qty, tif, .. } =>
                Command::New { cmd_id, order_id, accepted_ns, trading_date, code, side, lot, price_type, price, qty, tif, odd_matching: OddMatching::Queue },
            other => other,
        }
    }

    #[test]
    fn a_queued_odd_lot_waits_behind_the_odd_lot_book_and_fills_at_the_odd_lot_matches() {
        // decisions.md 模擬零股的成交方式 (user 11-13): 根據實際排隊 reads the 盤中零股 book and matches, never the whole lots.
        let mut d = PaperDesk::default();
        d.apply(&book("2330", 1, 100, &[(99.0, 10.0)], &[(99.5, 2.0)], false), 1);
        d.apply(&odd(book("2330", 2, 100, &[(100.0, 500.0)], &[(100.5, 80.0)], false)), 2);
        d.receive(queued("Q", Side::Buy, Some(100.0), 300.0, Tif::ROD, 100), 2);
        d.apply(&book("2330", 3, 101, &[(99.0, 10.0)], &[(99.5, 2.0)], false), 3);
        assert_eq!((d.orders["Q"].state, d.orders["Q"].ahead), (State::Working, Some(500.0)), "behind the 500 shares shown at 100");
        // The whole-lot ask at 99.5 is below its price: a direct odd lot would fill, a queued one does not.
        d.apply(&trade("2330", 4, 102, 99.5, 3.0, 1, false), 4);
        assert!(fills(&d.take_records()).is_empty());
        d.apply(&odd(trade("2330", 5, 103, 100.0, 600.0, 0, false)), 5);
        assert_eq!(fills(&d.take_records()), vec![(100.0, 100.0, "零股排隊輪到".into())], "600 matched, 500 ahead");
        d.apply(&odd(trade("2330", 6, 104, 100.0, 50.0, 0, false)), 6);
        assert_eq!(fills(&d.take_records()), vec![(50.0, 100.0, "零股排隊輪到".into())]);
        d.apply(&odd(trade("2330", 7, 105, 99.5, 10.0, 0, false)), 7);
        let records = d.take_records();
        assert_eq!(fills(&records), vec![(150.0, 99.5, "零股撮合（價格優於撮合價）".into())], "a match below a buy's price fills it whole");
        assert_eq!(done(&records), vec!["filled".to_string()]);

        // A match above a buy's price fills nothing; an IOC has its one match and the rest is gone.
        d.receive(queued("I", Side::Buy, Some(100.0), 200.0, Tif::IOC, 105), 7);
        d.apply(&book("2330", 8, 106, &[(99.0, 10.0)], &[(99.5, 2.0)], false), 8);
        d.apply(&odd(trade("2330", 9, 107, 100.5, 10.0, 0, false)), 9);
        let records = d.take_records();
        assert!(fills(&records).is_empty());
        assert_eq!(d.orders["I"].state, State::Cancelled);
    }

    #[test]
    fn a_command_without_odd_matching_is_direct_and_the_fixture_names_a_queued_one() {
        let commands: Vec<Command> = include_str!("../../../tests/fixtures/paper_commands.jsonl").lines().filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l}: {e}"))).collect();
        assert!(matches!(&commands[0], Command::New { odd_matching: OddMatching::Direct, .. }));
        assert!(matches!(&commands[4], Command::New { lot: Lot::Odd, odd_matching: OddMatching::Queue, .. }));
    }
}
