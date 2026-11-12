//! The one raw-market WAL (docs/system-architecture/03 sections 4-6).
//!
//! * Accept: the ingest path first RESERVES a slot in a bounded queue; without a slot nothing is accepted.
//! * Write: one background writer appends in accept order (segment, length, CRC32 framing), batching by time and
//!   size, then flush + sync. Only after sync does the durable watermark advance and the batch go to Rust B.
//! * Read: chunked by event count and bytes through a sparse index, so a large catch-up never loads the WAL.
//! * Recovery: an unfinished record at the very end of the newest segment is a torn tail and is truncated to the
//!   last valid boundary; a bad record anywhere else is corruption, reported with the sequence range it hides,
//!   never skipped silently.
//!
//! Framing is unchanged from v1 (`STKMWAL1` magic, u32 LE length, JSON, u32 LE CRC32), so existing WALs stay readable.

use crate::event::{MarketEvent, Refused};
use crate::trade_pages::{self, Mark, TradeIndex, TradeKey};
use crate::latency::Histogram;
use crate::voided::Voided;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const WAL_MAGIC: &[u8; 8] = b"STKMWAL1";
pub const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;
const INDEX_EVERY: u64 = 256;

pub fn segment_path(dir: &Path, id: u64) -> PathBuf {
    dir.join(format!("wal-{id:020}.bin"))
}

pub fn segment_ids(dir: &Path) -> io::Result<Vec<u64>> {
    let mut ids = Vec::new();
    if !dir.exists() {
        return Ok(ids);
    }
    for entry in fs::read_dir(dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_prefix("wal-").and_then(|s| s.strip_suffix(".bin")).and_then(|s| s.parse().ok()) {
            ids.push(id);
        }
    }
    ids.sort_unstable();
    Ok(ids)
}

const CRC_TABLES: [[u32; 256]; 8] = {
    let mut tables = [[0u32; 256]; 8];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            bit += 1;
        }
        tables[0][i] = crc;
        i += 1;
    }
    let mut k = 1;
    while k < 8 {
        let mut i = 0;
        while i < 256 {
            let previous = tables[k - 1][i];
            tables[k][i] = (previous >> 8) ^ tables[0][(previous & 0xff) as usize];
            i += 1;
        }
        k += 1;
    }
    tables
};

/// CRC-32 (IEEE), slicing-by-8. A's start verifies every record of the WAL; a byte-at-a-time CRC was ~5 s of it at
/// 2.6 GB.
pub fn crc32(bytes: &[u8]) -> u32 {
    let t = &CRC_TABLES;
    let mut crc = !0u32;
    let mut chunks = bytes.chunks_exact(8);
    for c in &mut chunks {
        let lo = u32::from_le_bytes([c[0], c[1], c[2], c[3]]) ^ crc;
        let hi = u32::from_le_bytes([c[4], c[5], c[6], c[7]]);
        crc = t[7][(lo & 0xff) as usize] ^ t[6][((lo >> 8) & 0xff) as usize] ^ t[5][((lo >> 16) & 0xff) as usize]
            ^ t[4][(lo >> 24) as usize] ^ t[3][(hi & 0xff) as usize] ^ t[2][((hi >> 8) & 0xff) as usize]
            ^ t[1][((hi >> 16) & 0xff) as usize] ^ t[0][(hi >> 24) as usize];
    }
    for &byte in chunks.remainder() {
        crc = t[0][((crc ^ byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SegmentInfo {
    pub id: u64,
    pub first_sequence: Option<u64>,
    pub last_sequence: Option<u64>,
    pub records: u64,
    pub valid_bytes: u64,
    /// Newest exchange time in the segment: retention prunes only segments whose every event is older than a cutoff.
    pub max_exchange_ts_ns: Option<i64>,
    /// Oldest exchange time in the segment: how far back the WAL still reaches (連線診斷 最早資料).
    pub min_exchange_ts_ns: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Corruption {
    pub segment: u64,
    pub offset: u64,
    pub reason: String,
    /// Last valid sequence before the bad record and first valid sequence after it (if any): the hidden range.
    pub last_valid_before: Option<u64>,
    pub first_valid_after: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Integrity {
    /// COMPLETE | TAIL_REPAIRED | CORRUPT
    pub status: String,
    pub repaired_tail: Option<(u64, u64)>,
    pub corruption: Vec<Corruption>,
    /// Discontinuities in the durable sequence (from, to) exclusive of the ends.
    pub sequence_gaps: Vec<(u64, u64)>,
}

#[derive(Debug, Clone, Default)]
pub struct WalIndex {
    pub segments: Vec<SegmentInfo>,
    /// (sequence, segment, offset) every INDEX_EVERY records and at every segment start.
    pub sparse: Vec<(u64, u64, u64)>,
    pub max_sequence: u64,
    pub first_record: Option<(u64, u32, u32)>,
    /// Every sequence at or below this was removed by retention (0: nothing was). A replay that starts inside the
    /// removed prefix is told so explicitly instead of discovering a hole.
    pub pruned_through: u64,
}

impl WalIndex {
    fn note(&mut self, segment: u64, offset: u64, sequence: u64, index_in_segment: u64) {
        if index_in_segment == 0 || index_in_segment % INDEX_EVERY == 0 {
            self.sparse.push((sequence, segment, offset));
        }
        self.max_sequence = self.max_sequence.max(sequence);
    }

    /// Where to start reading to find the first record with sequence > after.
    fn seek_point(&self, after: u64) -> Option<(u64, u64)> {
        let target = after.saturating_add(1);
        let pos = self.sparse.partition_point(|(seq, _, _)| *seq <= target);
        if pos == 0 {
            self.sparse.first().map(|(_, seg, off)| (*seg, *off))
        } else {
            let (_, seg, off) = self.sparse[pos - 1];
            Some((seg, off))
        }
    }

    /// Anchor of this WAL history: fingerprint of its first record.
    pub fn anchor(&self) -> Option<String> {
        self.first_record.map(|(seg, crc, len)| format!("{seg}:{crc:08x}:{len}"))
    }
}

enum Record {
    Event(MarketEvent, u64),
    /// A sound record of an older format: skipped (its size), never converted. Counted in OLD_FORMAT_RECORDS.
    OldFormat(u64),
    End,
    Bad(String),
}

/// WAL records of an older format this process refused while reading (see MarketEvent::refusal).
pub static OLD_FORMAT_RECORDS: AtomicU64 = AtomicU64::new(0);

/// Count one refused record and log it: the first, then every 10,000th (an old segment holds millions).
fn refuse_old_format(bytes: &[u8], reason: &str) {
    let n = OLD_FORMAT_RECORDS.fetch_add(1, Ordering::Relaxed) + 1;
    if n == 1 || n % 10_000 == 0 {
        let sequence = serde_json::from_slice::<SequenceOnly>(bytes).map(|s| s.durable_sequence).ok();
        eprintln!("[wal] refused an older-format record (sequence {sequence:?}): {reason} ({n} refused by this process)");
    }
}

pub(crate) enum RawRecord {
    Bytes(Vec<u8>, u64),
    End,
    /// The file ends inside this frame: an append that never finished. Only this may be truncated away.
    Torn(String),
    /// A complete frame that is wrong (checksum, length out of range, unreadable): corruption, never truncated.
    Bad(String),
}

fn read_record(reader: &mut BufReader<File>) -> Record {
    match read_record_bytes(reader) {
        RawRecord::Bytes(bytes, size) => match MarketEvent::decode_slice(&bytes) {
            Ok(event) => Record::Event(event, size),
            Err(Refused::OldFormat(reason)) => {
                refuse_old_format(&bytes, &reason);
                Record::OldFormat(size)
            }
            Err(Refused::Undecodable(reason)) => Record::Bad(format!("undecodable record: {reason}")),
        },
        RawRecord::End => Record::End,
        RawRecord::Torn(reason) | RawRecord::Bad(reason) => Record::Bad(reason),
    }
}

/// A record the index says is there (inside a segment's verified bytes) that could not be read: which segment, at
/// which offset, and why. The scan verified those bytes, so this is a file removed, changed or unreadable since.
fn read_problem(segment: u64, offset: u64, reason: impl std::fmt::Display) -> String {
    format!("WAL segment {segment} offset {offset}: {reason}")
}

/// Open segment `info` positioned at `offset`, or say why not.
fn open_at(dir: &Path, info: &SegmentInfo, offset: u64, capacity: usize) -> Result<BufReader<File>, String> {
    let file = File::open(segment_path(dir, info.id)).map_err(|e| read_problem(info.id, offset, format!("open: {e}")))?;
    let mut reader = BufReader::with_capacity(capacity, file);
    reader.seek(SeekFrom::Start(offset)).map_err(|e| read_problem(info.id, offset, format!("seek: {e}")))?;
    Ok(reader)
}

/// One framed record, checksum-verified, NOT decoded.
pub(crate) fn read_record_bytes(reader: &mut BufReader<File>) -> RawRecord {
    // Only a clean end (no byte at all) ends a segment. One to three bytes of a length are a torn append: reporting
    // them as the end left them in place, and the next record was appended after them, misaligning the segment.
    let mut len = [0u8; 4];
    let mut filled = 0;
    while filled < len.len() {
        match reader.read(&mut len[filled..]) {
            Ok(0) if filled == 0 => return RawRecord::End,
            Ok(0) => return RawRecord::Torn(format!("torn record length ({filled} of 4 bytes)")),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return RawRecord::Bad(format!("read length: {e}")),
        }
    }
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > MAX_RECORD_BYTES {
        return RawRecord::Bad(format!("record length {len} out of range"));
    }
    let mut bytes = vec![0u8; len];
    if let Err(e) = reader.read_exact(&mut bytes) {
        return if e.kind() == io::ErrorKind::UnexpectedEof { RawRecord::Torn(format!("short record: {e}")) } else { RawRecord::Bad(format!("read record: {e}")) };
    }
    let mut crc = [0u8; 4];
    if let Err(e) = reader.read_exact(&mut crc) {
        return if e.kind() == io::ErrorKind::UnexpectedEof { RawRecord::Torn(format!("short checksum: {e}")) } else { RawRecord::Bad(format!("read checksum: {e}")) };
    }
    if crc32(&bytes) != u32::from_le_bytes(crc) {
        return RawRecord::Bad("checksum mismatch".into());
    }
    RawRecord::Bytes(bytes, 4 + len as u64 + 4)
}

/// What the startup scan needs of a record: its sequence and time, and what the trade index reads (the partition and
/// the tape rule's fields, trade_pages::mark). Decoding every record into a MarketEvent made the scan ~17 s of A's
/// ~25 s start at a 2.6 GB WAL, and every Python API waited for it.
#[derive(serde::Deserialize)]
struct ScanHead<'a> {
    durable_sequence: u64,
    #[serde(default)]
    exchange_ts_ns: i64,
    #[serde(borrow, default)]
    provider: std::borrow::Cow<'a, str>,
    #[serde(borrow, default)]
    market: std::borrow::Cow<'a, str>,
    #[serde(borrow, default)]
    code: std::borrow::Cow<'a, str>,
    #[serde(borrow, default)]
    trading_date: std::borrow::Cow<'a, str>,
    #[serde(borrow, default)]
    session: std::borrow::Cow<'a, str>,
    #[serde(borrow, default)]
    payload: Option<ScanPayload<'a>>,
}

#[derive(serde::Deserialize, Default)]
struct ScanPayload<'a> {
    #[serde(borrow, default)]
    kind: std::borrow::Cow<'a, str>,
    #[serde(default)]
    simtrade: bool,
    #[serde(borrow, default)]
    status: std::borrow::Cow<'a, str>,
    #[serde(default)]
    total_volume: f64,
    #[serde(default)]
    volume: f64,
}

/// A segment's tape records grouped by partition (each group in WAL order: (sequence, offset, mark)). A partition's
/// key is built once per segment: the record's fields are matched by a hash of the borrowed text, so a record of a
/// partition already seen allocates nothing.
#[derive(Default)]
struct SegmentTrades {
    keys: Vec<TradeKey>,
    numbers: std::collections::HashMap<u64, Vec<usize>>,
    marks: Vec<Vec<(u64, i64, u64, Mark)>>,
}

impl SegmentTrades {
    fn note(&mut self, head: &ScanHead<'_>, offset: u64) {
        use std::hash::{Hash, Hasher};

        let Some(bits) = head.payload.as_ref() else { return };
        let Some(mark) = trade_pages::mark(&head.market, &bits.kind, bits.simtrade, &bits.status, bits.total_volume, bits.volume) else {
            return;
        };
        let fields = [&*head.provider, &*head.market, &*head.code, &*head.trading_date, &*head.session];
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        fields.hash(&mut hasher);
        let same = |key: &TradeKey| {
            [&*key.source, &*key.market, &*key.code, &*key.trading_date, &*key.session] == fields
        };
        let candidates = self.numbers.entry(hasher.finish()).or_default();
        let number = match candidates.iter().copied().find(|&n| same(&self.keys[n])) {
            Some(n) => n,
            None => {
                let [source, market, code, trading_date, session] = fields.map(str::to_string);
                self.keys.push(TradeKey { source, market, code, trading_date, session });
                self.marks.push(Vec::new());
                candidates.push(self.keys.len() - 1);
                self.keys.len() - 1
            }
        };
        self.marks[number].push((head.durable_sequence, head.exchange_ts_ns, offset, mark));
    }
}

#[derive(serde::Deserialize)]
struct SequenceOnly {
    durable_sequence: u64,
}

/// What a replay read returned: the records found, and every verified span it could not read (segment, offset,
/// reason). A replay goes on past an unreadable span -- the consumer is told the range it did not get as a
/// `durable.gap` -- so the problems travel with the records instead of the read pretending to be complete.
#[derive(Debug, Default)]
pub struct RawRange {
    pub events: Vec<(u64, Vec<u8>)>,
    pub problems: Vec<String>,
}

/// Like `read_range`, but each event is returned as its stored JSON with only its sequence parsed. A durable
/// replay forwards WAL records verbatim: decoding every record into a MarketEvent and encoding it again capped
/// replay near the ingest rate under load, so a consumer that fell behind never caught up.
pub fn read_range_raw(dir: &Path, index: &WalIndex, after: u64, upto: u64, max_events: usize, max_bytes: usize) -> RawRange {
    let mut out = RawRange::default();
    if upto <= after {
        return out;
    }
    let Some((start_segment, start_offset)) = index.seek_point(after) else { return out };
    let mut bytes = 0usize;
    for info in index.segments.iter().filter(|s| s.id >= start_segment) {
        let offset = if info.id == start_segment { start_offset.max(WAL_MAGIC.len() as u64) } else { WAL_MAGIC.len() as u64 };
        if offset >= info.valid_bytes {
            continue;
        }
        let mut reader = match open_at(dir, info, offset, 1 << 20) {
            Ok(reader) => reader,
            Err(problem) => {
                out.problems.push(problem);
                continue;
            }
        };
        let mut position = offset;
        while position < info.valid_bytes {
            let reason = match read_record_bytes(&mut reader) {
                RawRecord::Bytes(record, size) => match serde_json::from_slice::<SequenceOnly>(&record) {
                    Ok(SequenceOnly { durable_sequence: seq }) => {
                        position += size;
                        if seq > upto {
                            return out;
                        }
                        if seq > after {
                            bytes += record.len();
                            out.events.push((seq, record));
                            if out.events.len() >= max_events || bytes >= max_bytes {
                                return out;
                            }
                        }
                        continue;
                    }
                    Err(e) => format!("record without a durable sequence: {e}"),
                },
                RawRecord::End => "segment ends before its verified length".to_string(),
                RawRecord::Torn(reason) | RawRecord::Bad(reason) => reason,
            };
            out.problems.push(read_problem(info.id, position, reason));
            break;
        }
    }
    out
}

/// One segment read on its own (no cross-segment state): what `scan` merges in order.
struct SegmentScan {
    header_ok: bool,
    file_len: u64,
    first: Option<u64>,
    last: Option<u64>,
    max_sequence: u64,
    records: u64,
    max_exchange_ts_ns: Option<i64>,
    min_exchange_ts_ns: Option<i64>,
    /// (sequence, offset) of the records `WalIndex::note` keeps.
    notes: Vec<(u64, u64)>,
    gaps: Vec<(u64, u64)>,
    /// End of the last valid record.
    end: u64,
    /// Why reading stopped before the end of the file, if it did.
    bad: Option<String>,
    /// It stopped because the file ends inside a frame (an unfinished append), not because a frame is wrong.
    torn: bool,
    /// Valid frames found past a wrong one in this segment by resynchronizing: (first, max) durable sequence. They
    /// are not readable through the index, but their sequences are taken: counting only the records before the
    /// damage let the writer hand the same durable sequences out again.
    hidden: Option<(u64, u64)>,
    /// The tape records read before the end (or the damage), when the scan indexes trades.
    trades: Option<SegmentTrades>,
}

/// Find valid frames after a wrong one: every offset past `from` where a whole frame (length in range, CRC match,
/// a decodable head) parses. Runs only on a damaged segment.
fn resync_hidden(path: &Path, from: u64) -> Option<(u64, u64)> {
    let bytes = fs::read(path).ok()?;
    let mut i = from as usize + 1;
    let (mut first, mut max) = (None, 0u64);
    while i + 8 <= bytes.len() {
        let len = u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        let end = i + 4 + len + 4;
        if len == 0 || len > MAX_RECORD_BYTES || end > bytes.len() {
            i += 1;
            continue;
        }
        let payload = &bytes[i + 4..i + 4 + len];
        let crc = u32::from_le_bytes([bytes[end - 4], bytes[end - 3], bytes[end - 2], bytes[end - 1]]);
        match (crc32(payload) == crc).then(|| serde_json::from_slice::<ScanHead>(payload).ok()).flatten() {
            Some(head) => {
                first.get_or_insert(head.durable_sequence);
                max = max.max(head.durable_sequence);
                i = end;
            }
            None => i += 1,
        }
    }
    first.map(|f| (f, max))
}

fn scan_segment(path: &Path, index_trades: bool) -> io::Result<SegmentScan> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut out = SegmentScan { header_ok: false, file_len, first: None, last: None, max_sequence: 0, records: 0,
        max_exchange_ts_ns: None, min_exchange_ts_ns: None, notes: Vec::new(), gaps: Vec::new(), end: 0, bad: None, torn: false, hidden: None,
        trades: index_trades.then(SegmentTrades::default) };
    let mut magic = [0u8; 8];
    if reader.read_exact(&mut magic).is_err() || &magic != WAL_MAGIC {
        return Ok(out);
    }
    out.header_ok = true;
    let mut offset = WAL_MAGIC.len() as u64;
    loop {
        let (bytes, size) = match read_record_bytes(&mut reader) {
            RawRecord::Bytes(bytes, size) => (bytes, size),
            RawRecord::End => break,
            RawRecord::Torn(reason) => {
                out.bad = Some(reason);
                out.torn = true;
                break;
            }
            RawRecord::Bad(reason) => {
                out.bad = Some(reason);
                break;
            }
        };
        let head = match serde_json::from_slice::<ScanHead>(&bytes) {
            Ok(head) => head,
            Err(e) => {
                out.bad = Some(format!("undecodable record: {e}"));
                break;
            }
        };
        if let Some(trades) = out.trades.as_mut() {
            trades.note(&head, offset);
        }
        let seq = head.durable_sequence;
        if let Some(p) = out.last {
            if seq > p + 1 {
                out.gaps.push((p, seq));
            }
        }
        if out.records == 0 || out.records % INDEX_EVERY == 0 {
            out.notes.push((seq, offset));
        }
        out.max_sequence = out.max_sequence.max(seq);
        out.max_exchange_ts_ns = Some(out.max_exchange_ts_ns.map_or(head.exchange_ts_ns, |t| t.max(head.exchange_ts_ns)));
        out.min_exchange_ts_ns = Some(out.min_exchange_ts_ns.map_or(head.exchange_ts_ns, |t| t.min(head.exchange_ts_ns)));
        out.first.get_or_insert(seq);
        out.last = Some(seq);
        out.records += 1;
        offset += size;
    }
    out.end = offset;
    if out.bad.is_some() && !out.torn {
        out.hidden = resync_hidden(path, offset);
    }
    Ok(out)
}

/// Scan every segment, repair a torn tail in the newest one, and report corruption elsewhere.
///
/// Segments are read in parallel (each on its own) and merged in order, so everything that spans segments -- a gap
/// between them, the first valid record after a corruption, the torn tail of the newest -- is decided exactly as a
/// sequential scan would. A's start waited ~23 s for a sequential scan of a 2.6 GB WAL.
pub fn scan(dir: &Path, repair_tail: bool) -> io::Result<(WalIndex, Integrity)> {
    scan_inner(dir, repair_tail, None).map(|(index, integrity, _)| (index, integrity))
}

/// `scan`, also indexing every trade-tape record in the same pass (trade_pages.rs): Market Runtime's start, which
/// then answers the trade-detail pages from it (the writer extends it as it appends).
/// The void records (crate::voided) are left out of the index.
pub fn scan_indexing_trades(dir: &Path, repair_tail: bool, voided: Arc<Voided>) -> io::Result<(WalIndex, Integrity, TradeIndex)> {
    scan_inner(dir, repair_tail, Some(voided))
}

fn scan_inner(dir: &Path, repair_tail: bool, voided: Option<Arc<Voided>>) -> io::Result<(WalIndex, Integrity, TradeIndex)> {
    let index_trades = voided.is_some();
    fs::create_dir_all(dir)?;
    let ids = segment_ids(dir)?;
    let next = AtomicUsize::new(0);
    let workers = thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8).min(ids.len().max(1));
    let mut index = WalIndex::default();
    let mut integrity = Integrity { status: "COMPLETE".into(), ..Default::default() };
    let mut trades = TradeIndex::new(voided.unwrap_or_default());
    let mut previous: Option<u64> = None;
    let mut pending_corruption: Option<usize> = None;
    let mut merge = |position: usize, scanned: io::Result<SegmentScan>| -> io::Result<()> {
        let id = ids[position];
        let newest = position + 1 == ids.len();
        let path = segment_path(dir, id);
        let mut s = scanned?;
        // Merged in segment order: a FUT quote's traded volume depends on every quote before it.
        if let Some(found) = s.trades.take() {
            for (key, records) in found.keys.into_iter().zip(found.marks) {
                trades.note_segment(key, &records, id);
            }
        }
        let mut info = SegmentInfo { id, ..Default::default() };
        if !s.header_ok {
            if newest && s.file_len < WAL_MAGIC.len() as u64 && repair_tail {
                // A segment created but never initialized: rewrite its header.
                let mut file = OpenOptions::new().write(true).truncate(true).open(&path)?;
                file.write_all(WAL_MAGIC)?;
                file.sync_all()?;
                integrity.repaired_tail = Some((id, s.file_len));
                info.valid_bytes = WAL_MAGIC.len() as u64;
            } else {
                integrity.corruption.push(Corruption { segment: id, offset: 0, reason: "bad segment header".into(),
                    last_valid_before: previous, first_valid_after: None });
                pending_corruption = Some(integrity.corruption.len() - 1);
            }
            index.segments.push(info);
            return Ok(());
        }
        if let (Some(p), Some(first)) = (previous, s.first) {
            if first > p + 1 {
                integrity.sequence_gaps.push((p, first));
            }
        }
        if let Some(first) = s.first {
            if let Some(c) = pending_corruption.take() {
                integrity.corruption[c].first_valid_after = Some(first);
            }
        }
        integrity.sequence_gaps.extend(s.gaps);
        index.sparse.extend(s.notes.iter().map(|(seq, offset)| (*seq, id, *offset)));
        index.max_sequence = index.max_sequence.max(s.max_sequence).max(s.hidden.map_or(0, |(_, max)| max));
        info.first_sequence = s.first;
        info.last_sequence = s.last;
        info.records = s.records;
        info.max_exchange_ts_ns = s.max_exchange_ts_ns;
        info.min_exchange_ts_ns = s.min_exchange_ts_ns;
        if s.last.is_some() {
            previous = s.last;
        }
        if let Some(reason) = s.bad {
            // Only an unfinished append at the very end is cut. A complete but wrong frame in the newest segment is
            // corruption like anywhere else: truncating it would discard every valid record after it.
            // The writer then continues in a new segment (see WalWriter::open).
            if newest && s.torn {
                // Everything after the last valid boundary of the newest segment is an unfinished append. A read-only
                // scan (another reader while the writer is live) leaves it alone: it is not corruption.
                if repair_tail {
                    let file = OpenOptions::new().write(true).open(&path)?;
                    file.set_len(s.end)?;
                    file.sync_all()?;
                    integrity.repaired_tail = Some((id, s.file_len - s.end));
                }
            } else if let Some((first, max)) = s.hidden {
                // The valid records after the damage in this segment bound the hidden range, and the range they
                // cover is unreadable through the index: a durable-sequence gap like any other loss.
                integrity.corruption.push(Corruption { segment: id, offset: s.end, reason, last_valid_before: previous,
                    first_valid_after: Some(first) });
                integrity.sequence_gaps.push((previous.unwrap_or(0), max + 1));
                previous = Some(max);
            } else {
                integrity.corruption.push(Corruption { segment: id, offset: s.end, reason, last_valid_before: previous, first_valid_after: None });
                pending_corruption = Some(integrity.corruption.len() - 1);
            }
        }
        info.valid_bytes = s.end;
        index.segments.push(info);
        Ok(())
    };
    // Each segment is merged as soon as it and every one before it are scanned: holding every segment's scan until
    // the last one finished made the start's peak half again the index it builds (11-12: 266 MB for 177 MB).
    let (sender, results) = mpsc::channel::<(usize, io::Result<SegmentScan>)>();
    thread::scope(|scope| -> io::Result<()> {
        for _ in 0..workers {
            let (sender, next, ids) = (sender.clone(), &next, &ids);
            scope.spawn(move || loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                // A merge that failed dropped the receiver: the rest is not read.
                if i >= ids.len() || sender.send((i, scan_segment(&segment_path(dir, ids[i]), index_trades))).is_err() {
                    break;
                }
            });
        }
        drop(sender);
        let mut ready = std::collections::BTreeMap::new();
        let mut position = 0;
        for (i, scanned) in results {
            ready.insert(i, scanned);
            while let Some(scanned) = ready.remove(&position) {
                merge(position, scanned)?;
                position += 1;
            }
        }
        if position < ids.len() {
            return Err(io::Error::other(format!("segment {} scan did not run", ids[position])));
        }
        Ok(())
    })?;
    index.first_record = first_record_fingerprint(dir, &ids)?;
    index.pruned_through = index.segments.iter().find_map(|s| s.first_sequence).map_or(0, |first| first.saturating_sub(1));
    if !integrity.corruption.is_empty() {
        integrity.status = "CORRUPT".into();
    } else if integrity.repaired_tail.is_some() {
        integrity.status = "TAIL_REPAIRED".into();
    }
    trades.shrink_to_fit();
    Ok((index, integrity, trades))
}

/// The anchor string of the first valid record in segment `id` (what `WalIndex::anchor` would report if the WAL
/// started there). `Ok(None)` only when the segment's own bytes say it has none (no header, no whole first
/// record); a segment that cannot be opened or read is an error, never "no anchor".
pub fn segment_anchor(dir: &Path, id: u64) -> io::Result<Option<String>> {
    Ok(first_record_fingerprint(dir, &[id])?.map(|(seg, crc, len)| format!("{seg}:{crc:08x}:{len}")))
}

/// `read_exact` where a file that simply ends is `false` (the bytes are not there) and any other failure is an error.
fn read_present(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<bool> {
    match reader.read_exact(buf) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(e),
    }
}

fn first_record_fingerprint(dir: &Path, ids: &[u64]) -> io::Result<Option<(u64, u32, u32)>> {
    for id in ids {
        let mut reader = BufReader::new(File::open(segment_path(dir, *id))?);
        let mut magic = [0u8; 8];
        if !read_present(&mut reader, &mut magic)? || &magic != WAL_MAGIC {
            continue;
        }
        let mut len = [0u8; 4];
        if !read_present(&mut reader, &mut len)? {
            continue;
        }
        let len = u32::from_le_bytes(len);
        if len as usize > MAX_RECORD_BYTES || len == 0 {
            return Ok(None);
        }
        let mut bytes = vec![0u8; len as usize];
        let mut crc = [0u8; 4];
        if !read_present(&mut reader, &mut bytes)? || !read_present(&mut reader, &mut crc)? {
            return Ok(None);
        }
        let crc = u32::from_le_bytes(crc);
        if crc32(&bytes) != crc {
            return Ok(None);
        }
        return Ok(Some((*id, crc, len)));
    }
    Ok(None)
}

/// Read committed events with after < sequence <= upto, bounded by count and bytes. Every record inside the
/// verified bytes must read: a segment that cannot be opened or a record that cannot be read there is an error
/// naming the segment, offset and reason, never a shorter result that looks complete.
pub fn read_range(dir: &Path, index: &WalIndex, after: u64, upto: u64, max_events: usize, max_bytes: usize) -> io::Result<Vec<MarketEvent>> {
    let mut out = Vec::new();
    if upto <= after {
        return Ok(out);
    }
    let Some((start_segment, start_offset)) = index.seek_point(after) else { return Ok(out) };
    let mut bytes = 0usize;
    for info in index.segments.iter().filter(|s| s.id >= start_segment) {
        let offset = if info.id == start_segment { start_offset.max(WAL_MAGIC.len() as u64) } else { WAL_MAGIC.len() as u64 };
        if offset >= info.valid_bytes {
            continue;
        }
        let mut reader = open_at(dir, info, offset, 8 * 1024).map_err(io::Error::other)?;
        let mut position = offset;
        while position < info.valid_bytes {
            match read_record(&mut reader) {
                Record::Event(event, size) => {
                    position += size;
                    let seq = event.durable_sequence;
                    if seq > upto {
                        return Ok(out);
                    }
                    if seq > after {
                        bytes += size as usize;
                        out.push(event);
                        if out.len() >= max_events || bytes >= max_bytes {
                            return Ok(out);
                        }
                    }
                }
                Record::OldFormat(size) => position += size,
                Record::End => return Err(io::Error::other(read_problem(info.id, position, "segment ends before its verified length"))),
                Record::Bad(reason) => return Err(io::Error::other(read_problem(info.id, position, reason))),
            }
        }
    }
    Ok(out)
}

/// Stream every committed event with sequence > after (startup replay), without holding them all.
/// Every readable record, segment by segment in file order, up to each segment's verified end (no sequence cursor:
/// a reader that must not depend on sequences being unique, like the materializer).
/// A record that cannot be read inside the verified bytes is an error naming segment, offset and reason (the
/// damage the scan found is in its Integrity, outside the verified bytes, and is not read).
pub fn for_each_record(dir: &Path, index: &WalIndex, mut visit: impl FnMut(MarketEvent)) -> io::Result<u64> {
    let mut count = 0u64;
    for info in &index.segments {
        let mut position = WAL_MAGIC.len() as u64;
        if info.valid_bytes <= position {
            continue;
        }
        let mut reader = open_at(dir, info, position, 1 << 20).map_err(io::Error::other)?;
        while position < info.valid_bytes {
            match read_record(&mut reader) {
                Record::Event(event, size) => {
                    position += size;
                    count += 1;
                    visit(event);
                }
                Record::OldFormat(size) => position += size,
                Record::End => return Err(io::Error::other(read_problem(info.id, position, "segment ends before its verified length"))),
                Record::Bad(reason) => return Err(io::Error::other(read_problem(info.id, position, reason))),
            }
        }
    }
    Ok(count)
}

pub fn for_each(dir: &Path, index: &WalIndex, after: u64, mut visit: impl FnMut(MarketEvent)) -> io::Result<u64> {
    let mut cursor = after;
    let mut count = 0u64;
    loop {
        let chunk = read_range(dir, index, cursor, u64::MAX, 4096, 32 * 1024 * 1024)?;
        if chunk.is_empty() {
            return Ok(count);
        }
        for event in chunk {
            cursor = event.durable_sequence;
            count += 1;
            visit(event);
        }
    }
}

#[derive(Debug, Clone)]
pub struct WalConfig {
    pub segment_limit: u64,
    pub queue_capacity: usize,
    pub max_batch: usize,
    pub flush_interval: Duration,
    pub flush_bytes: usize,
    /// Test fault: the writer fails once this many bytes were written in this process.
    pub fail_after_bytes: Option<u64>,
    /// Today as a Taipei day number. A segment holds one day's appends: the first append of a new day starts a new
    /// segment, so retention (which removes only whole segments, every event older than its cutoff) can drop a day
    /// as soon as nothing in it is needed -- a quiet weekend no longer keeps Friday's events inside Monday's segment.
    pub day_of: fn() -> i64,
}

/// Taipei days since the epoch (UTC+8, no daylight saving).
pub fn taipei_day(unix_secs: i64) -> i64 {
    (unix_secs + 8 * 3600).div_euclid(86_400)
}

fn taipei_today() -> i64 {
    taipei_day(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))
}

impl Default for WalConfig {
    fn default() -> Self {
        Self {
            segment_limit: 64 * 1024 * 1024,
            queue_capacity: 65_536,
            max_batch: 4096,
            flush_interval: Duration::from_millis(5),
            flush_bytes: 1024 * 1024,
            fail_after_bytes: None,
            day_of: taipei_today,
        }
    }
}

enum Command {
    Append(MarketEvent),
    Flush(SyncSender<u64>),
    Stop,
}

#[derive(Default)]
pub struct WalStats {
    pub batches: AtomicU64,
    pub records: AtomicU64,
    pub bytes: AtomicU64,
    pub syncs: AtomicU64,
    pub last_sync_us: AtomicU64,
    pub max_sync_us: AtomicU64,
    /// Every flush+fsync, rolling 60 s: P50/P95/P99 instead of only the last and the worst one.
    pub sync_latency: Mutex<Histogram>,
}

pub struct WalShared {
    committed: AtomicU64,
    reserved: AtomicUsize,
    capacity: usize,
    failed: AtomicBool,
    error: Mutex<Option<String>>,
    pub index: Mutex<WalIndex>,
    commit_lock: Mutex<()>,
    commit_cv: Condvar,
    pub stats: WalStats,
    pub rejected_full: AtomicU64,
    /// Where every trade-tape record sits (trade_pages.rs): what the start's scan found, then each append.
    pub trades: Mutex<TradeIndex>,
}

pub type CommitHook = Box<dyn Fn(Vec<MarketEvent>, u64) + Send>;

/// Why the writer could not confirm a flush or a stop. Never folded into "no watermark": a shutdown that met one is
/// not clean, and the receipt says which.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalShutdownError {
    /// The writer did not answer within this many milliseconds (it may still be writing).
    Timeout(u128),
    /// The writer thread had already ended (its channel closed) without answering.
    WriterGone,
    /// The writer thread panicked.
    WriterPanicked(String),
    /// The writer's last flush / fsync on the way out failed.
    FinalSync(String),
}

impl std::fmt::Display for WalShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout(ms) => write!(f, "WAL writer did not answer within {ms} ms"),
            Self::WriterGone => write!(f, "WAL writer had already ended"),
            Self::WriterPanicked(why) => write!(f, "WAL writer panicked: {why}"),
            Self::FinalSync(why) => write!(f, "WAL writer's final flush/sync failed: {why}"),
        }
    }
}

pub struct WalWriter {
    tx: SyncSender<Command>,
    pub shared: Arc<WalShared>,
    /// Taken by `stop`, which joins it: the writer's own last flush/fsync result comes back through it.
    thread: Mutex<Option<JoinHandle<io::Result<()>>>>,
    pub dir: PathBuf,
}

impl WalWriter {
    /// Open for appending after `scan` validated/repaired the directory. `committed` is the highest durable sequence.
    pub fn open(dir: &Path, config: WalConfig, index: WalIndex, committed: u64, on_commit: CommitHook) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let mut segment = index.segments.last().map(|s| s.id).unwrap_or(1);
        // Never append after bytes the scan could not read (corruption kept for inspection): the new records would be
        // unreachable behind it. Start the next segment instead.
        if let Some(last) = index.segments.last() {
            let on_disk = fs::metadata(segment_path(dir, last.id)).map(|m| m.len()).unwrap_or(0);
            if on_disk > last.valid_bytes.max(WAL_MAGIC.len() as u64) {
                segment = last.id + 1;
            }
        }
        let path = segment_path(dir, segment);
        let fresh = !path.exists() || fs::metadata(&path)?.len() == 0;
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        if fresh {
            file.write_all(WAL_MAGIC)?;
            file.sync_all()?;
        }
        let bytes = file.metadata()?.len();
        let shared = Arc::new(WalShared {
            committed: AtomicU64::new(committed),
            reserved: AtomicUsize::new(0),
            capacity: config.queue_capacity.max(1),
            failed: AtomicBool::new(false),
            error: Mutex::new(None),
            index: Mutex::new(index),
            commit_lock: Mutex::new(()),
            commit_cv: Condvar::new(),
            stats: WalStats::default(),
            rejected_full: AtomicU64::new(0),
            trades: Mutex::new(TradeIndex::default()),
        });
        // Appending to an existing segment continues its record count (restarting at 0 would make the
        // segment's `records` -- and the index's per-record sampling -- count only this process's appends).
        let records_in_segment = shared.index.lock().unwrap().segments.iter().find(|s| s.id == segment).map(|s| s.records).unwrap_or(0);
        // Continuing a segment after a restart: its day is the day it was last written.
        let segment_day = (bytes > WAL_MAGIC.len() as u64).then(|| file.metadata().and_then(|m| m.modified()).ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| taipei_day(d.as_secs() as i64))).flatten();
        let (tx, rx) = mpsc::sync_channel(config.queue_capacity.max(1) + 64);
        let worker = Worker {
            dir: dir.to_path_buf(), config, segment, file: BufWriter::with_capacity(1 << 20, file), bytes,
            records_in_segment, shared: shared.clone(), on_commit, written_total: 0, segment_day,
        };
        let thread = thread::Builder::new().name("wal-writer".into()).spawn(move || worker.run(rx))?;
        Ok(Self { tx, shared, thread: Mutex::new(Some(thread)), dir: dir.to_path_buf() })
    }

    /// Reserve one slot. False = the queue is full or the WAL failed: the caller must NOT accept the event.
    pub fn reserve(&self) -> bool {
        if self.shared.failed.load(Ordering::Acquire) {
            return false;
        }
        let mut current = self.shared.reserved.load(Ordering::Acquire);
        loop {
            if current >= self.shared.capacity {
                self.shared.rejected_full.fetch_add(1, Ordering::Relaxed);
                return false;
            }
            match self.shared.reserved.compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    pub fn release(&self) {
        self.shared.reserved.fetch_sub(1, Ordering::AcqRel);
    }

    /// Queue a reserved event (never blocks: the channel is larger than the reservation capacity).
    pub fn submit(&self, event: MarketEvent) {
        if self.tx.try_send(Command::Append(event)).is_err() {
            self.release();
            self.shared.fail("writer channel closed");
        }
    }

    pub fn committed(&self) -> u64 {
        self.shared.committed.load(Ordering::Acquire)
    }

    pub fn queued(&self) -> usize {
        self.shared.reserved.load(Ordering::Acquire)
    }

    pub fn capacity(&self) -> usize {
        self.shared.capacity
    }

    pub fn failed(&self) -> Option<String> {
        if self.shared.failed.load(Ordering::Acquire) {
            Some(self.shared.error.lock().unwrap().clone().unwrap_or_else(|| "failed".into()))
        } else {
            None
        }
    }

    pub fn wait_committed(&self, sequence: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut guard = self.shared.commit_lock.lock().unwrap();
        while self.committed() < sequence {
            if self.shared.failed.load(Ordering::Acquire) {
                return false;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            guard = self.shared.commit_cv.wait_timeout(guard, deadline - now).unwrap().0;
        }
        true
    }

    /// Wait for the commit through `sequence` however long the disk takes: a slow sync (a Windows shadow copy holds
    /// every write for seconds) is still a sync. Ends early only when the WAL failed or `keep_waiting` says the
    /// caller is going away; false then.
    pub fn wait_committed_while(&self, sequence: u64, keep_waiting: impl Fn() -> bool) -> bool {
        // The slice only lets `keep_waiting` be asked again; it never decides the outcome.
        const RECHECK: Duration = Duration::from_millis(200);
        loop {
            if self.wait_committed(sequence, RECHECK) {
                return true;
            }
            if self.shared.failed.load(Ordering::Acquire) || !keep_waiting() {
                return false;
            }
        }
    }

    /// Force a flush/sync of everything queued so far and return the committed watermark.
    pub fn flush(&self, timeout: Duration) -> Result<u64, WalShutdownError> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx.send(Command::Flush(tx)).map_err(|_| WalShutdownError::WriterGone)?;
        rx.recv_timeout(timeout).map_err(|e| match e {
            RecvTimeoutError::Timeout => WalShutdownError::Timeout(timeout.as_millis()),
            RecvTimeoutError::Disconnected => WalShutdownError::WriterGone,
        })
    }

    /// What the WAL occupies (連線診斷 WAL 空間): verified bytes, segment count, how far back it reaches, and each
    /// segment's (bytes, oldest, newest exchange time) so a caller holding a "materialized up to" time can sum what
    /// is still unmerged. Built from the index; no file is touched.
    pub fn disk_summary(&self) -> serde_json::Value {
        let index = self.shared.index.lock().unwrap();
        let bytes: u64 = index.segments.iter().map(|s| s.valid_bytes).sum();
        let oldest = index.segments.iter().filter_map(|s| s.min_exchange_ts_ns).min();
        let newest = index.segments.iter().filter_map(|s| s.max_exchange_ts_ns).max();
        let ranges: Vec<serde_json::Value> = index.segments.iter()
            .map(|s| serde_json::json!([s.valid_bytes, s.min_exchange_ts_ns, s.max_exchange_ts_ns])).collect();
        serde_json::json!({"bytes": bytes, "segments": index.segments.len(), "oldest_exchange_ts_ns": oldest,
                           "newest_exchange_ts_ns": newest, "segment_ranges": ranges})
    }

    pub fn index_snapshot(&self) -> WalIndex {
        self.shared.index.lock().unwrap().clone()
    }

    /// The leading segments retention may remove: closed (never the one being written), every event older than
    /// `before_ns`, and every sequence at or below `through_sequence` (the checkpoint A would recover from).
    pub fn prune_candidates(&self, before_ns: i64, through_sequence: u64) -> Vec<u64> {
        let index = self.shared.index.lock().unwrap();
        let closed = index.segments.len().saturating_sub(1);
        index.segments[..closed].iter()
            .take_while(|s| s.last_sequence.is_some_and(|last| last <= through_sequence)
                && s.max_exchange_ts_ns.is_some_and(|ts| ts < before_ns))
            .map(|s| s.id).collect()
    }

    /// Drop removed segments from the index (and the trade index); the anchor moves to the first remaining record.
    pub fn forget_segments(&self, removed: &[u64]) -> io::Result<()> {
        self.shared.trades.lock().unwrap().forget_segments(removed);
        let mut index = self.shared.index.lock().unwrap();
        index.segments.retain(|s| !removed.contains(&s.id));
        index.sparse.retain(|(_, seg, _)| !removed.contains(seg));
        let ids: Vec<u64> = index.segments.iter().map(|s| s.id).collect();
        index.first_record = first_record_fingerprint(&self.dir, &ids)?;
        let first = index.segments.iter().find_map(|s| s.first_sequence).map_or(0, |f| f.saturating_sub(1));
        index.pruned_through = index.pruned_through.max(first);
        Ok(())
    }

    /// Stop the writer and join it: everything queued before is written, flushed and fsynced, and the committed
    /// watermark returned. Any later `submit` fails the WAL ("writer channel closed"). An error says why the stop
    /// could not be confirmed; a second stop finds the writer gone.
    pub fn stop(&self) -> Result<u64, WalShutdownError> {
        let thread = self.thread.lock().unwrap().take().ok_or(WalShutdownError::WriterGone)?;
        // A send that fails means the writer already ended: its join below says how.
        let sent = self.tx.send(Command::Stop).is_ok();
        match thread.join() {
            Err(payload) => Err(WalShutdownError::WriterPanicked(crate::panic_message(payload.as_ref()))),
            Ok(Err(e)) => Err(WalShutdownError::FinalSync(e.to_string())),
            Ok(Ok(())) if sent => Ok(self.committed()),
            Ok(Ok(())) => Err(WalShutdownError::WriterGone),
        }
    }
}

impl WalShared {
    fn fail(&self, reason: &str) {
        *self.error.lock().unwrap() = Some(reason.to_string());
        self.failed.store(true, Ordering::Release);
        self.commit_cv.notify_all();
    }
}

struct Worker {
    dir: PathBuf,
    config: WalConfig,
    segment: u64,
    file: BufWriter<File>,
    bytes: u64,
    records_in_segment: u64,
    shared: Arc<WalShared>,
    on_commit: CommitHook,
    written_total: u64,
    /// The Taipei day this segment's appends belong to (None until its first record).
    segment_day: Option<i64>,
}

impl Worker {
    /// Until Stop (or every sender gone); the result is the last flush and fsync of the open segment.
    fn run(mut self, rx: Receiver<Command>) -> io::Result<()> {
        let mut batch: Vec<MarketEvent> = Vec::new();
        let mut unsynced_bytes = 0usize;
        let mut waiters: Vec<SyncSender<u64>> = Vec::new();
        let mut stop = false;
        while !stop {
            match rx.recv_timeout(self.config.flush_interval) {
                Ok(Command::Append(event)) => {
                    if !self.append(&event, &mut unsynced_bytes) {
                        batch.push(event); // counted as released below; not committed
                        self.abandon(&mut batch);
                        continue;
                    }
                    batch.push(event);
                    while batch.len() < self.config.max_batch && unsynced_bytes < self.config.flush_bytes {
                        match rx.try_recv() {
                            Ok(Command::Append(event)) => {
                                if !self.append(&event, &mut unsynced_bytes) {
                                    batch.push(event);
                                    self.abandon(&mut batch);
                                    break;
                                }
                                batch.push(event);
                            }
                            Ok(Command::Flush(waiter)) => waiters.push(waiter),
                            Ok(Command::Stop) => {
                                stop = true;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                }
                Ok(Command::Flush(waiter)) => waiters.push(waiter),
                Ok(Command::Stop) => stop = true,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => stop = true,
            }
            if !batch.is_empty() || !waiters.is_empty() {
                self.commit(&mut batch, &mut unsynced_bytes);
                let committed = self.shared.committed.load(Ordering::Acquire);
                for waiter in waiters.drain(..) {
                    let _ = waiter.try_send(committed);
                }
            }
        }
        self.file.flush()?;
        self.file.get_ref().sync_all()
    }

    fn abandon(&mut self, batch: &mut Vec<MarketEvent>) {
        // The WAL failed: nothing in this batch becomes durable. Release their reservations; failed stays set so
        // no further event is accepted.
        for _ in batch.drain(..) {
            self.shared.reserved.fetch_sub(1, Ordering::AcqRel);
        }
    }

    fn append(&mut self, event: &MarketEvent, unsynced: &mut usize) -> bool {
        if self.shared.failed.load(Ordering::Acquire) {
            return false;
        }
        let payload = match serde_json::to_vec(event) {
            Ok(p) if p.len() <= MAX_RECORD_BYTES => p,
            _ => {
                self.shared.fail("unencodable or oversized record");
                return false;
            }
        };
        let record_len = 8 + payload.len() as u64;
        let today = (self.config.day_of)();
        let new_day = self.segment_day.is_some_and(|day| day != today);
        if (new_day || self.bytes + record_len > self.config.segment_limit) && self.bytes > WAL_MAGIC.len() as u64 {
            if let Err(e) = self.rotate() {
                self.shared.fail(&format!("rotate: {e}"));
                return false;
            }
        }
        if let Some(limit) = self.config.fail_after_bytes {
            if self.written_total + record_len > limit {
                self.shared.fail("TEST fault: disk write failure");
                return false;
            }
        }
        let offset = self.bytes;
        let crc = crc32(&payload);
        let result = self.file.write_all(&(payload.len() as u32).to_le_bytes())
            .and_then(|_| self.file.write_all(&payload))
            .and_then(|_| self.file.write_all(&crc.to_le_bytes()));
        if let Err(e) = result {
            self.shared.fail(&format!("write: {e}"));
            return false;
        }
        {
            let mut index = self.shared.index.lock().unwrap();
            if index.segments.last().map(|s| s.id) != Some(self.segment) {
                index.segments.push(SegmentInfo { id: self.segment, ..Default::default() });
            }
            index.note(self.segment, offset, event.durable_sequence, self.records_in_segment);
            if let Some(info) = index.segments.iter_mut().rev().find(|s| s.id == self.segment) {
                // Attributed here, where the segment is known: a batch can straddle a rotation, and crediting its
                // events at commit to the then-current segment left rotated segments without a sequence range.
                info.first_sequence.get_or_insert(event.durable_sequence);
                info.last_sequence = Some(event.durable_sequence);
                info.max_exchange_ts_ns = Some(info.max_exchange_ts_ns.map_or(event.exchange_ts_ns, |t| t.max(event.exchange_ts_ns)));
                info.min_exchange_ts_ns = Some(info.min_exchange_ts_ns.map_or(event.exchange_ts_ns, |t| t.min(event.exchange_ts_ns)));
            }
            if index.first_record.is_none() {
                index.first_record = Some((self.segment, crc, payload.len() as u32));
            }
        }
        if let Some(mark) = trade_pages::mark_event(event) {
            self.shared.trades.lock().unwrap().note(&TradeKey::of(event), mark, event.durable_sequence, event.exchange_ts_ns, self.segment, offset);
        }
        self.records_in_segment += 1;
        self.bytes += record_len;
        self.written_total += record_len;
        self.segment_day.get_or_insert(today);
        *unsynced += record_len as usize;
        true
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        self.file.get_ref().sync_all()?;
        self.update_segment_bytes();
        self.segment += 1;
        let mut file = OpenOptions::new().create(true).append(true).open(segment_path(&self.dir, self.segment))?;
        file.write_all(WAL_MAGIC)?;
        file.sync_all()?;
        self.file = BufWriter::with_capacity(1 << 20, file);
        self.bytes = WAL_MAGIC.len() as u64;
        self.records_in_segment = 0;
        self.segment_day = None;
        let mut index = self.shared.index.lock().unwrap();
        index.segments.push(SegmentInfo { id: self.segment, valid_bytes: self.bytes, ..Default::default() });
        Ok(())
    }

    fn update_segment_bytes(&self) {
        let mut index = self.shared.index.lock().unwrap();
        if let Some(info) = index.segments.iter_mut().find(|s| s.id == self.segment) {
            info.valid_bytes = self.bytes;
        }
    }

    fn commit(&mut self, batch: &mut Vec<MarketEvent>, unsynced: &mut usize) {
        if self.shared.failed.load(Ordering::Acquire) {
            self.abandon(batch);
            return;
        }
        let started = Instant::now();
        if let Err(e) = self.file.flush().and_then(|_| self.file.get_ref().sync_data()) {
            self.shared.fail(&format!("sync: {e}"));
            self.abandon(batch);
            return;
        }
        let sync_us = started.elapsed().as_micros() as u64;
        self.update_segment_bytes();
        {
            let mut index = self.shared.index.lock().unwrap();
            if let Some(info) = index.segments.iter_mut().find(|s| s.id == self.segment) {
                info.records = self.records_in_segment;
            }
        }
        let stats = &self.shared.stats;
        stats.syncs.fetch_add(1, Ordering::Relaxed);
        stats.last_sync_us.store(sync_us, Ordering::Relaxed);
        stats.max_sync_us.fetch_max(sync_us, Ordering::Relaxed);
        stats.sync_latency.lock().unwrap().record(sync_us);
        *unsynced = 0;
        if batch.is_empty() {
            return;
        }
        let last = batch.last().map(|e| e.durable_sequence).unwrap_or(0);
        stats.batches.fetch_add(1, Ordering::Relaxed);
        stats.records.fetch_add(batch.len() as u64, Ordering::Relaxed);
        let n = batch.len();
        {
            let _guard = self.shared.commit_lock.lock().unwrap();
            self.shared.committed.fetch_max(last, Ordering::AcqRel);
        }
        self.shared.commit_cv.notify_all();
        self.shared.reserved.fetch_sub(n, Ordering::AcqRel);
        let events = std::mem::take(batch);
        (self.on_commit)(events, last);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slicing_crc_matches_the_bitwise_definition() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926, "the CRC-32/IEEE check value");
        let bitwise = |bytes: &[u8]| {
            let mut crc = !0u32;
            for &byte in bytes {
                crc ^= byte as u32;
                for _ in 0..8 {
                    crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
                }
            }
            !crc
        };
        let data: Vec<u8> = (0..4099u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
        for len in [0, 1, 7, 8, 9, 15, 16, 17, 255, 4099] {
            assert_eq!(crc32(&data[..len]), bitwise(&data[..len]), "length {len}");
        }
    }
    use crate::event::{EventFlags, Payload};
    use std::sync::atomic::AtomicU64 as Counter;

    pub fn event(seq: u64) -> MarketEvent {
        MarketEvent {
            schema_version: 2, event_id: format!("e{seq}"), durable_sequence: seq, symbol: "t:TW:1".into(), provider: "t".into(),
            market: "TW".into(), code: "1".into(), session: "DAY".into(), trading_date: "2026-09-29".into(), generation: 1,
            sequence: seq, exchange_ts_ns: seq as i64, arrival_ns: 1, a_received_ns: 1, runtime_epoch: 1,
            time_quality: "exchange".into(), trace_id: String::new(), flags: EventFlags::default(), versions: Default::default(),
            payload: Payload::OrderBook { bids: vec![], asks: vec![], simtrade: false },
        }
    }

    fn dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("stk-wal-{name}-{}-{}", std::process::id(), Instant::now().elapsed().as_nanos()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn open(d: &Path, config: WalConfig) -> (WalWriter, Arc<Counter>) {
        let (index, _) = scan(d, true).unwrap();
        let committed = index.max_sequence;
        let seen = Arc::new(Counter::new(0));
        let hook_seen = seen.clone();
        let wal = WalWriter::open(d, config, index, committed, Box::new(move |events, _| { hook_seen.fetch_add(events.len() as u64, Ordering::Relaxed); })).unwrap();
        (wal, seen)
    }

    #[test]
    fn a_sync_slower_than_any_deadline_is_waited_for_and_only_a_failure_or_the_caller_ends_the_wait() {
        let d = dir("slow");
        let (index, _) = scan(&d, true).unwrap();
        // The writer is held 3.5 s after its first commit, as a shadow-copy freeze holds it: the next commit is late.
        let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let hold = first.clone();
        let wal = WalWriter::open(&d, WalConfig::default(), index, 0, Box::new(move |_, _| {
            if hold.swap(false, Ordering::AcqRel) {
                std::thread::sleep(Duration::from_millis(3500));
            }
        })).unwrap();
        assert!(wal.reserve());
        wal.submit(event(1));
        assert!(wal.wait_committed(1, Duration::from_secs(5)));
        assert!(wal.reserve());
        wal.submit(event(2));
        assert!(!wal.wait_committed(2, Duration::from_secs(3)), "a fixed 3 s deadline called this sync a failure");
        let started = Instant::now();
        assert!(wal.wait_committed_while(2, || true), "the late commit is waited for");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(wal.reserve());
        wal.submit(event(3));
        assert!(wal.wait_committed_while(3, || true));
        // A caller going away ends the wait for a commit that is not coming.
        assert!(!wal.wait_committed_while(99, || false));
        let _ = wal.stop();
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stop_joins_the_writer_and_a_stopped_writer_is_never_read_as_no_watermark() {
        let d = dir("stop");
        let (wal, _) = open(&d, WalConfig::default());
        for seq in 1..=5 {
            assert!(wal.reserve());
            wal.submit(event(seq));
        }
        assert_eq!(wal.flush(Duration::from_secs(5)), Ok(5));
        assert_eq!(wal.stop(), Ok(5), "everything queued is written and fsynced before the join returns");
        assert_eq!(wal.stop(), Err(WalShutdownError::WriterGone), "a second stop finds no writer");
        assert_eq!(wal.flush(Duration::from_millis(50)), Err(WalShutdownError::WriterGone));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn disk_summary_reports_bytes_segments_and_time_range_live_and_after_a_scan() {
        let d = dir("disk");
        let (wal, _) = open(&d, WalConfig { segment_limit: 4096, ..Default::default() });
        for seq in 10..=200 {
            assert!(wal.reserve());
            wal.submit(event(seq));
        }
        assert!(wal.wait_committed(200, Duration::from_secs(5)));
        let live = wal.disk_summary();
        let segments = live["segments"].as_u64().unwrap();
        assert!(segments > 3);
        assert_eq!(live["oldest_exchange_ts_ns"], 10, "event(seq) carries exchange_ts_ns = seq");
        assert_eq!(live["newest_exchange_ts_ns"], 200);
        let ranges = live["segment_ranges"].as_array().unwrap();
        assert_eq!(ranges.len() as u64, segments);
        let summed: u64 = ranges.iter().map(|r| r[0].as_u64().unwrap()).sum();
        assert_eq!(summed, live["bytes"].as_u64().unwrap());
        assert_eq!(ranges[0][1], 10);
        let sync = wal.shared.stats.sync_latency.lock().unwrap().summary("a", "b");
        assert_eq!(sync["availability"], "OK", "every fsync is a sample: P95/P99 are reported");
        wal.stop().unwrap();
        let (index, _) = scan(&d, true).unwrap();
        let on_disk: u64 = d.read_dir().unwrap().map(|e| e.unwrap().metadata().unwrap().len()).sum();
        assert_eq!(index.segments.iter().map(|s| s.valid_bytes).sum::<u64>(), on_disk, "the scan rebuilds the same bytes");
        assert_eq!(index.segments.iter().filter_map(|s| s.min_exchange_ts_ns).min(), Some(10), "and the same oldest time");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_older_format_record_is_refused_and_counted_and_reading_goes_on_past_it() {
        let d = dir("old-format");
        let (wal, _) = open(&d, WalConfig::default());
        for seq in 1..=3 {
            let mut e = event(seq);
            if seq == 2 {
                e.schema_version = 1;
            }
            assert!(wal.reserve());
            wal.submit(e);
        }
        assert!(wal.wait_committed(3, Duration::from_secs(5)));
        wal.stop().unwrap();
        let (index, _) = scan(&d, true).unwrap();
        let before = OLD_FORMAT_RECORDS.load(Ordering::Relaxed);
        let mut seen = Vec::new();
        for_each_record(&d, &index, |e| seen.push(e.durable_sequence)).unwrap();
        assert_eq!(seen, vec![1, 3], "the older record is skipped, never converted, and the next one is still read");
        assert!(OLD_FORMAT_RECORDS.load(Ordering::Relaxed) > before, "and counted");
        let mut ranged = Vec::new();
        for_each(&d, &index, 0, |e| ranged.push(e.durable_sequence)).unwrap();
        assert_eq!(ranged, vec![1, 3]);
        let _ = fs::remove_dir_all(&d);
    }

    static FAKE_DAY: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(100);
    fn fake_day() -> i64 {
        FAKE_DAY.load(Ordering::SeqCst)
    }

    #[test]
    fn the_first_append_of_a_new_day_starts_a_new_segment() {
        // One day's appends per segment, so retention can remove a whole day (user 10-14): a quiet weekend kept
        // Friday's events inside the segment Monday's pre-open filled, and that segment could not go.
        let d = dir("day-rotation");
        let (wal, _) = open(&d, WalConfig { day_of: fake_day, ..Default::default() });
        for seq in 1..=3 {
            assert!(wal.reserve());
            wal.submit(event(seq));
        }
        assert!(wal.wait_committed(3, Duration::from_secs(5)));
        FAKE_DAY.store(101, Ordering::SeqCst);
        for seq in 4..=6 {
            assert!(wal.reserve());
            wal.submit(event(seq));
        }
        assert!(wal.wait_committed(6, Duration::from_secs(5)));
        let segments: Vec<(Option<u64>, Option<u64>)> = wal.index_snapshot().segments.iter()
            .map(|s| (s.first_sequence, s.last_sequence)).collect();
        wal.stop().unwrap();
        assert_eq!(segments, vec![(Some(1), Some(3)), (Some(4), Some(6))], "the new day began a segment, once");
        assert_eq!(taipei_day(16 * 3600 - 1), 0, "15:59:59 UTC is still day 0 in Taipei");
        assert_eq!(taipei_day(16 * 3600), 1, "16:00 UTC is Taipei midnight");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn appending_after_a_restart_continues_the_segment_record_count() {
        // Reopened, the writer counted the segment's records from 0 again.
        let d = dir("reopen-records");
        let (wal, _) = open(&d, WalConfig::default());
        for seq in 1..=5 {
            assert!(wal.reserve());
            wal.submit(event(seq));
        }
        assert!(wal.wait_committed(5, Duration::from_secs(5)));
        wal.stop().unwrap();
        let (wal, _) = open(&d, WalConfig::default());
        for seq in 6..=8 {
            assert!(wal.reserve());
            wal.submit(event(seq));
        }
        assert!(wal.wait_committed(8, Duration::from_secs(5)));
        let live = wal.index_snapshot().segments.last().map(|s| s.records);
        wal.stop().unwrap();
        assert_eq!(live, Some(8), "the open segment holds 8 records, not the 3 this process appended");
        let (index, _) = scan(&d, true).unwrap();
        assert_eq!(index.segments.last().map(|s| s.records), Some(8));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn commit_advances_only_after_sync_and_reads_are_chunked() {
        let d = dir("chunk");
        let (wal, seen) = open(&d, WalConfig { segment_limit: 4096, ..Default::default() });
        for seq in 1..=500 {
            assert!(wal.reserve());
            wal.submit(event(seq));
        }
        assert!(wal.wait_committed(500, Duration::from_secs(5)));
        assert_eq!(seen.load(Ordering::Relaxed), 500, "every committed event reaches the durable hook exactly once");
        let index = wal.index_snapshot();
        assert!(index.segments.len() > 3, "small segment limit forces rotation");
        let chunk = read_range(&d, &index, 100, 500, 50, usize::MAX).unwrap();
        assert_eq!(chunk.len(), 50);
        assert_eq!(chunk[0].durable_sequence, 101);
        let bounded = read_range(&d, &index, 0, 250, usize::MAX, usize::MAX).unwrap();
        assert_eq!(bounded.last().unwrap().durable_sequence, 250);
        wal.stop().unwrap();
        let (index, integrity) = scan(&d, true).unwrap();
        assert_eq!(integrity.status, "COMPLETE");
        assert_eq!(index.max_sequence, 500);
        let mut n = 0;
        for_each(&d, &index, 490, |_| n += 1).unwrap();
        assert_eq!(n, 10);
    }

    #[test]
    fn a_verified_segment_that_cannot_be_read_is_reported_never_a_short_complete_read() {
        let d = dir("unreadable");
        let (wal, _) = open(&d, WalConfig { segment_limit: 4096, ..Default::default() });
        for seq in 1..=300 {
            assert!(wal.reserve());
            wal.submit(event(seq));
        }
        assert!(wal.wait_committed(300, Duration::from_secs(5)));
        wal.stop().unwrap();
        let (index, _) = scan(&d, true).unwrap();
        assert!(index.segments.len() > 3);
        // A middle segment disappears after the scan (removed or unreadable since).
        let gone = &index.segments[1];
        let (first, last) = (gone.first_sequence.unwrap(), gone.last_sequence.unwrap());
        fs::remove_file(segment_path(&d, gone.id)).unwrap();
        let error = read_range(&d, &index, 0, 300, usize::MAX, usize::MAX).unwrap_err().to_string();
        assert!(error.contains(&format!("WAL segment {}", gone.id)) && error.contains("open"), "{error}");
        assert!(for_each_record(&d, &index, |_| {}).is_err(), "the materializer's read fails instead of returning less");
        assert!(for_each(&d, &index, 0, |_| {}).is_err(), "startup replay fails instead of returning less");
        // A replay read goes on past it and says what it could not read.
        let raw = read_range_raw(&d, &index, 0, 300, usize::MAX, usize::MAX);
        assert_eq!(raw.problems.len(), 1, "{:?}", raw.problems);
        assert!(raw.problems[0].contains(&format!("WAL segment {}", gone.id)));
        assert!(raw.events.iter().all(|(seq, _)| *seq < first || *seq > last));
        assert_eq!(raw.events.last().map(|(seq, _)| *seq), Some(300));
        assert!(segment_anchor(&d, gone.id).is_err(), "an unreadable segment has no 'no anchor' answer");
        assert!(segment_anchor(&d, index.segments[2].id).unwrap().is_some());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_full_queue_refuses_before_accepting() {
        let d = dir("full");
        let (wal, _) = open(&d, WalConfig { queue_capacity: 2, flush_interval: Duration::from_secs(60), max_batch: 1, ..Default::default() });
        assert!(wal.reserve());
        assert!(wal.reserve());
        assert!(!wal.reserve(), "no slot, no accept");
        assert_eq!(wal.shared.rejected_full.load(Ordering::Relaxed), 1);
        wal.release();
        wal.release();
        wal.stop().unwrap();
    }

    #[test]
    fn a_disk_failure_stops_accepting_and_never_advances_the_watermark() {
        let d = dir("fail");
        let (wal, _) = open(&d, WalConfig { fail_after_bytes: Some(1500), ..Default::default() });
        let mut accepted = 0;
        for seq in 1..=100 {
            if !wal.reserve() {
                break;
            }
            wal.submit(event(seq));
            accepted = seq;
            thread::sleep(Duration::from_millis(1));
        }
        thread::sleep(Duration::from_millis(50));
        assert!(wal.failed().is_some());
        assert!(!wal.reserve());
        let committed = wal.committed();
        assert!(committed < accepted, "committed {committed} must stay behind accepted {accepted}");
        wal.stop().unwrap();
    }

    #[test]
    fn corruption_inside_the_newest_segment_is_reported_and_never_truncated() {
        // A bad frame in the middle of the newest segment must not be "repaired" as a torn tail,
        // truncating every valid committed record after it.
        let d = dir("newest-corrupt");
        let (wal, _) = open(&d, WalConfig::default());
        for seq in 1..=20 {
            wal.reserve();
            wal.submit(event(seq));
        }
        wal.wait_committed(20, Duration::from_secs(5));
        wal.stop().unwrap();
        let newest = segment_path(&d, *segment_ids(&d).unwrap().last().unwrap());
        let mut bytes = fs::read(&newest).unwrap();
        let size = bytes.len();
        let mid = size / 2;
        bytes[mid] ^= 0xff;
        fs::write(&newest, &bytes).unwrap();
        let (_, integrity) = scan(&d, true).unwrap();
        assert_eq!(integrity.status, "CORRUPT");
        assert_eq!(fs::metadata(&newest).unwrap().len() as usize, size, "nothing after the damage is cut away");
        let (wal, _) = open(&d, WalConfig::default());
        for seq in 21..=25 {
            wal.reserve();
            wal.submit(event(seq));
        }
        wal.wait_committed(25, Duration::from_secs(5));
        wal.stop().unwrap();
        assert!(segment_ids(&d).unwrap().len() >= 2, "new records go to a new segment, not behind the damage");
        let (index, integrity) = scan(&d, false).unwrap();
        assert_eq!(index.max_sequence, 25, "records written after reopening are reachable");
        assert_eq!(integrity.corruption.len(), 1);
    }

    #[test]
    fn a_torn_length_of_a_few_bytes_is_repaired_before_new_appends() {
        // 1-3 bytes of a record length at the end must not read as a clean end and stay in place:
        // the next start would append after them, misaligning every later record of the segment.
        let d = dir("torn-length");
        let (wal, _) = open(&d, WalConfig::default());
        for seq in 1..=5 {
            wal.reserve();
            wal.submit(event(seq));
        }
        wal.wait_committed(5, Duration::from_secs(5));
        wal.stop().unwrap();
        let newest = segment_path(&d, *segment_ids(&d).unwrap().last().unwrap());
        let mut f = OpenOptions::new().append(true).open(&newest).unwrap();
        f.write_all(&[7, 1]).unwrap();
        drop(f);
        let (wal, _) = open(&d, WalConfig::default());
        for seq in 6..=8 {
            wal.reserve();
            wal.submit(event(seq));
        }
        wal.wait_committed(8, Duration::from_secs(5));
        wal.stop().unwrap();
        let (index, integrity) = scan(&d, false).unwrap();
        assert_eq!(integrity.status, "COMPLETE", "{:?}", integrity.corruption);
        assert_eq!(index.max_sequence, 8, "records appended after the repair read back");
    }

    #[test]
    fn a_torn_tail_is_truncated_but_middle_corruption_is_reported_with_its_range() {
        let d = dir("torn");
        let (wal, _) = open(&d, WalConfig { segment_limit: 2048, ..Default::default() });
        for seq in 1..=60 {
            wal.reserve();
            wal.submit(event(seq));
        }
        wal.wait_committed(60, Duration::from_secs(5));
        wal.stop().unwrap();
        // torn tail on the newest segment
        let ids = segment_ids(&d).unwrap();
        let newest = segment_path(&d, *ids.last().unwrap());
        let mut f = OpenOptions::new().append(true).open(&newest).unwrap();
        f.write_all(&[9, 9, 0, 0, 1, 2]).unwrap();
        drop(f);
        let (index, integrity) = scan(&d, true).unwrap();
        assert_eq!(integrity.status, "TAIL_REPAIRED");
        assert_eq!(index.max_sequence, 60);
        // corrupt a byte in the middle of the first segment
        let first = segment_path(&d, ids[0]);
        let mut bytes = fs::read(&first).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xff;
        fs::write(&first, bytes).unwrap();
        let (_, integrity) = scan(&d, true).unwrap();
        assert_eq!(integrity.status, "CORRUPT");
        let c = &integrity.corruption[0];
        assert!(c.last_valid_before.is_some() && c.first_valid_after.is_some(), "the hidden range is known: {c:?}");
        assert!(!integrity.sequence_gaps.is_empty(), "the lost range shows up as a durable-sequence gap");
    }

    #[test]
    fn damage_inside_the_newest_segment_does_not_give_its_later_sequences_out_again() {
        // Only the records before the damage counted toward max_sequence, so after a restart the writer
        // reused the durable sequences of the valid records that followed it in the same (newest) segment.
        let d = dir("newest-mid");
        let (wal, _) = open(&d, WalConfig { segment_limit: 1 << 30, ..Default::default() });
        for seq in 1..=60 {
            wal.reserve();
            wal.submit(event(seq));
        }
        wal.wait_committed(60, Duration::from_secs(5));
        wal.stop().unwrap();
        let ids = segment_ids(&d).unwrap();
        assert_eq!(ids.len(), 1, "one segment: the damage is in the newest");
        let path = segment_path(&d, ids[0]);
        let mut bytes = fs::read(&path).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xff;
        fs::write(&path, bytes).unwrap();
        let (index, integrity) = scan(&d, true).unwrap();
        assert_eq!(integrity.status, "CORRUPT");
        assert_eq!(index.max_sequence, 60, "the sequences after the damage stay taken");
        let c = &integrity.corruption[0];
        let (before, after) = (c.last_valid_before.unwrap(), c.first_valid_after.unwrap());
        assert!(before < after && after <= 60, "{c:?}");
        assert!(integrity.sequence_gaps.iter().any(|(p, n)| *p == before && *n == 61), "{:?}", integrity.sequence_gaps);
    }

    fn tape_event(seq: u64, market: &str, payload: serde_json::Value) -> MarketEvent {
        let mut e = event(seq);
        (e.market, e.code, e.symbol) = (market.into(), "X".into(), format!("t:{market}:X"));
        e.payload = serde_json::from_value(payload).unwrap();
        e
    }

    #[test]
    fn the_trade_index_the_writer_extends_is_the_one_a_later_scan_builds_and_forgets_removed_segments() {
        let d = dir("trade-index");
        let quote = |total: f64, own: f64| serde_json::json!({"kind": "quote", "current": 200_000, "open": 0, "high": 0, "low": 0,
            "total_volume": total, "total_amount": 0.0, "status": "live", "minute": 540, "average": 0, "volume": own, "amount": 0.0});
        let trade = |simtrade: bool| serde_json::json!({"kind": "trade", "price": 100_000, "volume": 1.0, "total_volume": 1.0, "side": 1,
            "trade_id": "t", "minute": 540, "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0, "simtrade": simtrade});
        let events = vec![tape_event(1, "FUT", quote(10.0, 2.0)), tape_event(2, "FUT", quote(10.0, 1.0)), tape_event(3, "TW", trade(false)),
                          tape_event(4, "TW", trade(true)), event(5), tape_event(6, "FUT", quote(14.0, 1.0))];
        let (wal, _) = open(&d, WalConfig { segment_limit: 600, ..Default::default() });
        for e in &events {
            assert!(wal.reserve());
            wal.submit(e.clone());
        }
        wal.flush(Duration::from_secs(5)).unwrap();
        let fut = |market: &str| TradeKey { source: "t".into(), market: market.into(), code: "X".into(), trading_date: "2026-09-29".into(), session: "DAY".into() };
        let written = {
            let trades = wal.shared.trades.lock().unwrap();
            (trades.positions(&fut("FUT"), u64::MAX), trades.positions(&fut("TW"), u64::MAX))
        };
        assert_eq!(written.0.iter().map(|a| (a.sequence, a.derived)).collect::<Vec<_>>(), vec![(1, 2.0), (6, 4.0)],
                   "a quote that does not raise the total trades nothing");
        assert_eq!(written.1.iter().map(|a| a.sequence).collect::<Vec<_>>(), vec![3], "a 試撮 print is not on the tape");
        let segments: std::collections::BTreeSet<u64> = written.0.iter().chain(&written.1).map(|a| a.segment).collect();
        assert!(segments.len() > 1, "the records span segments: {segments:?}");
        wal.stop().unwrap();
        let (_, _, scanned) = scan_indexing_trades(&d, true, Default::default()).unwrap();
        assert_eq!((scanned.positions(&fut("FUT"), u64::MAX), scanned.positions(&fut("TW"), u64::MAX)), written);
        let (wal, _) = open(&d, WalConfig::default());
        *wal.shared.trades.lock().unwrap() = scanned;
        let first = *segments.iter().next().unwrap();
        wal.forget_segments(&[first]).unwrap();
        let kept = wal.shared.trades.lock().unwrap().positions(&fut("FUT"), u64::MAX);
        assert!(kept.iter().all(|a| a.segment != first) && !kept.is_empty());
        wal.stop().unwrap();
    }

    #[test]
    fn a_void_record_is_not_on_the_tape_and_the_quotes_after_it_trade_what_they_add_to_the_kept_ones() {
        let d = dir("trade-index-void");
        let quote = |total: f64, own: f64| serde_json::json!({"kind": "quote", "current": 200_000, "open": 0, "high": 0, "low": 0,
            "total_volume": total, "total_amount": 0.0, "status": "live", "minute": 540, "average": 0, "volume": own, "amount": 0.0});
        let trade = serde_json::json!({"kind": "trade", "price": 100_000, "volume": 1.0, "total_volume": 1.0, "side": 1,
            "trade_id": "t", "minute": 540, "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0, "simtrade": false});
        let events = vec![tape_event(1, "FUT", quote(10.0, 2.0)), tape_event(2, "FUT", quote(12.0, 1.0)), tape_event(3, "TW", trade.clone()),
                          tape_event(4, "TW", trade), tape_event(5, "FUT", quote(14.0, 1.0))];
        let (wal, _) = open(&d, WalConfig::default());
        for e in &events {
            assert!(wal.reserve());
            wal.submit(e.clone());
        }
        wal.flush(Duration::from_secs(5)).unwrap();
        wal.stop().unwrap();
        let key = |market: &str| TradeKey { source: "t".into(), market: market.into(), code: "X".into(), trading_date: "2026-09-29".into(), session: "DAY".into() };
        let (_, _, all) = scan_indexing_trades(&d, true, Default::default()).unwrap();
        assert_eq!(all.positions(&key("FUT"), u64::MAX).iter().map(|a| (a.sequence, a.derived)).collect::<Vec<_>>(), vec![(1, 2.0), (2, 2.0), (5, 2.0)]);
        let voided = Voided::parse(br#"[{"source": "t", "market": "FUT", "trading_date": "2026-09-29", "session": "DAY", "durable": "1-1", "reason": "test"},
            {"source": "t", "market": "TW", "trading_date": "2026-09-29", "session": "DAY", "durable": "3-3", "reason": "test"},
            {"source": "t", "market": "TW", "trading_date": "2026-09-30", "session": "DAY", "durable": "4-4", "reason": "another day"}]"#).unwrap();
        let (_, _, kept) = scan_indexing_trades(&d, true, Arc::new(voided)).unwrap();
        assert_eq!(kept.positions(&key("FUT"), u64::MAX).iter().map(|a| (a.sequence, a.derived)).collect::<Vec<_>>(), vec![(2, 1.0), (5, 2.0)],
                   "the void quote is gone and the first kept one is the session's first trade");
        assert_eq!(kept.positions(&key("TW"), u64::MAX).iter().map(|a| a.sequence).collect::<Vec<_>>(), vec![4], "a range of another partition voids nothing here");
        assert_eq!(kept.voided_skipped(), 2);
    }
}
