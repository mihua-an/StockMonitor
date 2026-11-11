//! The rule-event archive: `<events-dir>/<trading_date>.jsonl`, one line per event revision, read back by
//! quote_api's AnalysisEventArchive (readers keep the newest revision per event_id). Events are derived data -- B can
//! recompute them from the durable stream -- so they are B's own file, never Market Runtime's WAL.
//!
//! Reliability: a record is appended only when the file does not already hold that exact revision
//! (an index per date, loaded once from the file), so a full republish never duplicates the day and the same check
//! is the startup comparison: whatever B holds that the file lacks is written (`reconcile`). A failed write is kept
//! and retried on the next append or tick, never just counted; past `PENDING_CAP` bytes the date is marked as a gap and
//! a full reconcile against what B holds is requested. Written dates are fsynced every `SYNC_EVERY` (power loss loses
//! at most that much; a crash of B alone loses nothing, the OS has the bytes).
//!
//! A date is settled only once nothing of it is pending AND what was written is fsynced: only then is
//! its gap cleared, its reconciled records counted as `repaired`, and its remediation recorded as succeeded. A
//! failed fsync keeps the date for the next tick with its error; a reconcile whose rewrite fails again is neither
//! counted as repaired nor clears the gap.
//!
//! The per-date index is installed only from a whole read of the file. A missing file is an empty index; an
//! unfinished last line (an append cut by a crash) is cut back to the last whole line -- appending after it would
//! glue the next record onto it; any other failure (open, read, a line that is not a record) leaves the date without
//! an index: nothing is appended to it, the records are counted as dropped and the date stays a gap with its error
//! until the file reads whole again (a reconcile then writes them back).

use market_runtime::event::parse_calendar_date;
use market_runtime::remediation;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const PENDING_CAP: usize = 8 << 20;
pub const SYNC_EVERY: Duration = Duration::from_secs(5);

fn digest(text: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// Why a reconcile runs (the trigger of its remediation when it writes anything back).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reconcile {
    /// Startup: what B restored may be ahead of the file.
    Startup,
    /// After pending lines overflowed and were dropped.
    AfterDrop,
}

#[derive(Debug, Default)]
pub struct Archive {
    dir: Option<PathBuf>,
    /// date -> event_id -> digest of the newest revision the file holds.
    index: HashMap<String, HashMap<String, u64>>,
    /// date -> lines not on disk yet (a failed write), retried first.
    pending: BTreeMap<String, String>,
    /// dates written since the last fsync.
    dirty: BTreeSet<String>,
    last_sync: Option<Instant>,
    /// dates whose pending lines overflowed and were dropped: a reconcile against B's state is due.
    pub gaps: BTreeSet<String>,
    /// Dates whose dropped records no reconcile has handed back yet.
    unreconciled: BTreeSet<String>,
    /// date -> records a reconcile wrote back that are not fsynced yet (counted in `repaired` once they are).
    repairing: BTreeMap<String, u64>,
    /// date -> the open remediation (a failed write/fsync, an overflow, a startup difference) and its retries.
    operations: BTreeMap<String, (remediation::Operation, u64)>,
    /// date -> the last error of a date not settled yet.
    pub date_errors: BTreeMap<String, String>,
    pub resync_wanted: bool,
    pub written: u64,
    pub skipped_same: u64,
    pub write_errors: u64,
    pub retried_ok: u64,
    pub dropped: u64,
    pub repaired: u64,
    pub sync_errors: u64,
    pub last_error: Option<String>,
}

impl Archive {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir: Some(dir), ..Self::default() }
    }

    fn path(&self, date: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(format!("{date}.jsonl")))
    }

    /// Install the date's index from a whole read of its file (see the module doc). Err names the file, the line and
    /// the reason; no index is installed then.
    fn load_index(&mut self, date: &str) -> Result<(), String> {
        if self.index.contains_key(date) {
            return Ok(());
        }
        let Some(path) = self.path(date) else {
            self.index.insert(date.to_string(), HashMap::new());
            return Ok(());
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.index.insert(date.to_string(), HashMap::new());
                return Ok(());
            }
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let whole = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        if whole < bytes.len() {
            let cut = std::fs::OpenOptions::new().write(true).open(&path)
                .and_then(|file| { file.set_len(whole as u64)?; file.sync_all() });
            if let Err(e) = cut {
                return Err(format!("{}: cutting the unfinished last line: {e}", path.display()));
            }
            let message = format!("{}: unfinished last line ({} bytes) cut back to the last whole line", path.display(), bytes.len() - whole);
            eprintln!("event archive {message}");
            self.note_problem(date, "torn_tail", &message);
        }
        let mut ids = HashMap::new();
        for (number, line) in bytes[..whole].split(|b| *b == b'\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            let record: Value = serde_json::from_slice(line).map_err(|e| format!("{} line {}: {e}", path.display(), number + 1))?;
            let id = record["event_id"].as_str().ok_or_else(|| format!("{} line {}: no event_id", path.display(), number + 1))?;
            ids.insert(id.to_string(), digest(&record.to_string()));
        }
        self.index.insert(date.to_string(), ids);
        Ok(())
    }

    fn write(&mut self, date: &str, text: &str) -> std::io::Result<()> {
        let dir = self.dir.clone().ok_or_else(|| std::io::Error::other("no archive dir"))?;
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{date}.jsonl"));
        std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(text.as_bytes())
    }

    /// Append the records the file does not hold yet. Returns how many were (or are pending to be) written.
    pub fn append<'a>(&mut self, records: impl IntoIterator<Item = &'a Value>) -> usize {
        self.append_by_date(records).values().sum()
    }

    fn append_by_date<'a>(&mut self, records: impl IntoIterator<Item = &'a Value>) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        if self.dir.is_none() {
            return counts;
        }
        let mut by_date: BTreeMap<String, Vec<(String, u64, String)>> = BTreeMap::new();
        for record in records {
            let date = record["trading_date"].as_str().unwrap_or("").to_string();
            let Some(id) = record["event_id"].as_str() else { continue };
            if parse_calendar_date(&date).is_none() {
                continue;
            }
            let text = record.to_string();
            by_date.entry(date).or_default().push((id.to_string(), digest(&text), text));
        }
        for (date, rows) in by_date {
            let mut count = 0;
            if let Err(error) = self.load_index(&date) {
                // No index, no dedup: appending could duplicate or interleave with what the file holds.
                eprintln!("event archive index unreadable ({date}): {error}; {} records not written", rows.len());
                self.dropped += rows.len() as u64;
                self.gaps.insert(date.clone());
                self.unreconciled.insert(date.clone());
                self.last_error = Some(error.clone());
                self.note_problem(&date, "index_unreadable", &error);
                counts.insert(date, 0);
                continue;
            }
            let known = self.index.get_mut(&date).expect("loaded");
            let mut text = String::new();
            for (id, hash, line) in rows {
                if known.get(&id) == Some(&hash) {
                    self.skipped_same += 1;
                    continue;
                }
                known.insert(id, hash);
                text.push_str(&line);
                text.push('\n');
                count += 1;
            }
            if !text.is_empty() {
                self.pending.entry(date.clone()).or_default().push_str(&text);
                self.flush_date(&date);
            }
            counts.insert(date, count);
        }
        counts
    }

    /// Open (or count a retry of) the date's remediation.
    fn note_problem(&mut self, date: &str, trigger: &str, error: &str) {
        self.date_errors.insert(date.to_string(), error.to_string());
        match self.operations.get_mut(date) {
            Some((_, retries)) => *retries += 1,
            None => {
                let operation = remediation::begin("event_archive", "analysis.event_archive_repair", trigger,
                    remediation::Identity { trading_date: Some(date.to_string()), ..Default::default() },
                    json!({"error": error, "pending_bytes": self.pending.get(date).map_or(0, String::len)}));
                self.operations.insert(date.to_string(), (operation, 0));
            }
        }
    }

    /// The date is settled when nothing of it is pending or unsynced: clear its gap, count what a reconcile wrote
    /// back, close its remediation.
    fn settle(&mut self, date: &str) {
        if self.pending.contains_key(date) || self.dirty.contains(date) || self.unreconciled.contains(date) {
            return;
        }
        let repaired = self.repairing.remove(date).unwrap_or(0);
        self.repaired += repaired;
        self.gaps.remove(date);
        self.date_errors.remove(date);
        if let Some((mut operation, retries)) = self.operations.remove(date) {
            operation.finish("succeeded", Some(retries + 1), json!({"records_written_back": repaired}));
        }
    }

    fn flush_date(&mut self, date: &str) {
        let Some(text) = self.pending.remove(date) else { return };
        let lines = text.lines().count() as u64;
        match self.write(date, &text) {
            Ok(()) => {
                self.written += lines;
                self.dirty.insert(date.to_string());
            }
            Err(e) => {
                self.write_errors += 1;
                self.last_error = Some(format!("{date}: {e}"));
                eprintln!("event archive write failed ({date}): {e}; kept for retry");
                if text.len() > PENDING_CAP {
                    // Too much to hold: drop it, forget we "have" those revisions, and ask for a reconcile.
                    self.dropped += lines;
                    self.index.remove(date);
                    self.gaps.insert(date.to_string());
                    self.unreconciled.insert(date.to_string());
                    // Whatever a reconcile handed over for this date was in what was just dropped.
                    self.repairing.remove(date);
                    self.resync_wanted = true;
                    self.note_problem(date, "pending_overflow", &e.to_string());
                } else {
                    self.pending.insert(date.to_string(), text);
                    self.note_problem(date, "write_failed", &e.to_string());
                }
            }
        }
    }

    /// Retry pending writes; fsync what was written since the last sync once `SYNC_EVERY` has passed.
    pub fn tick(&mut self) {
        let dates: Vec<String> = self.pending.keys().cloned().collect();
        for date in dates {
            let before = self.write_errors;
            self.flush_date(&date);
            if self.write_errors == before {
                self.retried_ok += 1;
            }
        }
        if self.last_sync.is_some_and(|t| t.elapsed() < SYNC_EVERY) {
            return;
        }
        self.last_sync = Some(Instant::now());
        let dates: Vec<String> = self.dirty.iter().cloned().collect();
        for date in dates {
            let synced = self.path(&date).map(|p| std::fs::OpenOptions::new().append(true).open(p).and_then(|f| f.sync_data()));
            match synced {
                Some(Err(e)) => {
                    // Kept for the next tick: the bytes are not durable until an fsync of them succeeds.
                    self.sync_errors += 1;
                    self.last_error = Some(format!("fsync {date}: {e}"));
                    self.note_problem(&date, "fsync_failed", &e.to_string());
                }
                _ => {
                    self.dirty.remove(&date);
                }
            }
        }
        let open: Vec<String> = self.operations.keys().chain(self.gaps.iter()).chain(self.repairing.keys()).cloned().collect();
        for date in open {
            self.settle(&date);
        }
    }

    /// Compare what B holds with the file and write what is missing or older (startup, and after a dropped write).
    /// Returns how many records were handed to the file; they count as `repaired` once their date is settled.
    pub fn reconcile<'a>(&mut self, held: impl IntoIterator<Item = &'a Value>, why: Reconcile) -> usize {
        let trigger = match why {
            Reconcile::Startup => "startup_difference",
            Reconcile::AfterDrop => "pending_overflow",
        };
        // What was dropped is handed back by this pass -- unless its rewrite overflows again, which marks it anew.
        self.unreconciled.clear();
        let counts = self.append_by_date(held);
        self.resync_wanted = !self.unreconciled.is_empty();
        for (date, n) in &counts {
            // A date dropped again by this very pass handed nothing over.
            if *n > 0 && !self.unreconciled.contains(date) {
                *self.repairing.entry(date.clone()).or_default() += *n as u64;
                if !self.operations.contains_key(date) {
                    self.note_problem(date, trigger, "the file lacked records B holds");
                }
            }
        }
        // A gap date whose records all reached the file again is settled at the next sync.
        counts.values().sum()
    }

    pub fn status(&self) -> Value {
        serde_json::json!({"written": self.written, "skipped_same_revision": self.skipped_same, "write_errors": self.write_errors,
            "retried_ok": self.retried_ok, "pending_dates": self.pending.keys().collect::<Vec<_>>(),
            "pending_bytes": self.pending.values().map(String::len).sum::<usize>(), "dropped": self.dropped,
            "gap_dates": self.gaps, "repaired": self.repaired, "repairing": self.repairing, "sync_errors": self.sync_errors,
            "unsynced_dates": self.dirty, "date_errors": self.date_errors, "last_error": self.last_error,
            "fsync_every_s": SYNC_EVERY.as_secs()})
    }
}

/// The newest revision per event_id a file holds.
#[cfg(test)]
pub fn read_newest(path: &std::path::Path) -> BTreeMap<String, Value> {
    use std::io::{BufRead, BufReader};
    let mut out = BTreeMap::new();
    if let Ok(file) = std::fs::File::open(path) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(record) = serde_json::from_str::<Value>(&line) {
                if let Some(id) = record["event_id"].as_str() {
                    out.insert(id.to_string(), record);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("stk-b-archive-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn event(id: &str, revision: u64) -> Value {
        json!({"event_id": id, "trading_date": "2026-10-06", "revision": revision, "state": "ACTIVE"})
    }

    fn lines(d: &std::path::Path) -> usize {
        std::fs::read_to_string(d.join("2026-10-06.jsonl")).map(|t| t.lines().count()).unwrap_or(0)
    }

    #[test]
    fn an_unreadable_archive_file_is_never_read_as_an_empty_one() {
        let d = dir("corrupt");
        std::fs::create_dir_all(&d).unwrap();
        let file = d.join("2026-10-06.jsonl");
        let held = format!("{}\nnot a record\n{}\n", event("e1", 1), event("e2", 1));
        std::fs::write(&file, &held).unwrap();
        let mut a = Archive::new(d.clone());
        assert_eq!(a.append([&event("e1", 1), &event("e3", 1)]), 0, "nothing is appended without a whole index");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), held, "the file is left as it is");
        assert!(a.gaps.contains("2026-10-06") && a.date_errors["2026-10-06"].contains("line 2"), "{:?}", a.date_errors);
        assert_eq!(a.dropped, 2);
        a.tick();
        assert!(a.gaps.contains("2026-10-06"), "not settled while the file cannot be read");
        // Once the file reads whole, a reconcile writes back only what it lacks.
        std::fs::write(&file, format!("{}\n{}\n", event("e1", 1), event("e2", 1))).unwrap();
        assert_eq!(a.reconcile([&event("e1", 1), &event("e3", 1)], Reconcile::AfterDrop), 1);
        assert_eq!(read_newest(&file).len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unfinished_last_line_is_cut_back_before_appending() {
        let d = dir("torn");
        std::fs::create_dir_all(&d).unwrap();
        let file = d.join("2026-10-06.jsonl");
        std::fs::write(&file, format!("{}\n{{\"event_id\": \"e2\", \"trad", event("e1", 1))).unwrap();
        let mut a = Archive::new(d.clone());
        assert_eq!(a.append([&event("e1", 1), &event("e2", 1)]), 1);
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
        assert!(text.lines().all(|line| serde_json::from_str::<Value>(line).is_ok()), "{text}");
        assert!(a.date_errors["2026-10-06"].contains("unfinished last line"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_republish_does_not_duplicate_and_a_new_revision_is_appended() {
        let d = dir("dup");
        let mut a = Archive::new(d.clone());
        assert_eq!(a.append([&event("e1", 1), &event("e2", 1)]), 2);
        assert_eq!(a.append([&event("e1", 1), &event("e2", 1)]), 0, "a full republish writes nothing again");
        assert_eq!(a.append([&event("e1", 2)]), 1);
        assert_eq!(lines(&d), 3);
        // A fresh process (restart) learns what the file holds from the file itself.
        let mut b = Archive::new(d.clone());
        assert_eq!(b.reconcile([&event("e1", 2), &event("e2", 1), &event("e3", 1)], Reconcile::Startup), 1, "only the missing one");
        assert_eq!(read_newest(&d.join("2026-10-06.jsonl")).len(), 3);
        assert_eq!(b.repaired, 0, "not repaired before it is fsynced");
        b.tick();
        assert_eq!(b.repaired, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_write_is_kept_and_retried_not_lost() {
        let d = dir("retry");
        std::fs::create_dir_all(d.parent().unwrap()).unwrap();
        std::fs::write(&d, b"a file where the directory should be").unwrap(); // every write fails
        let mut a = Archive::new(d.clone());
        a.append([&event("e1", 1)]);
        assert_eq!((a.write_errors, a.written), (1, 0));
        assert!(a.status()["pending_dates"].as_array().is_some_and(|p| p.len() == 1));
        std::fs::remove_file(&d).unwrap(); // the disk recovers
        a.tick();
        assert_eq!((a.written, a.retried_ok), (1, 1));
        assert_eq!(lines(&d), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_overflowing_failure_marks_a_gap_and_asks_for_a_reconcile_that_repairs_it() {
        let d = dir("gap");
        std::fs::create_dir_all(d.parent().unwrap()).unwrap();
        std::fs::write(&d, b"x").unwrap();
        let mut a = Archive::new(d.clone());
        let big: Vec<Value> = (0..2).map(|i| json!({"event_id": format!("e{i}"), "trading_date": "2026-10-06",
            "blob": "x".repeat(PENDING_CAP)})).collect();
        a.append(big.iter());
        assert!(a.resync_wanted && a.gaps.contains("2026-10-06") && a.dropped == 2);
        // The reconcile's rewrite fails again: the gap stays, nothing is "repaired", the error is kept.
        assert_eq!(a.reconcile(big.iter(), Reconcile::AfterDrop), 2);
        a.tick();
        assert!(a.gaps.contains("2026-10-06"), "a rewrite that failed again repairs nothing (BACKLOG S2b-08)");
        assert_eq!(a.repaired, 0);
        assert!(a.date_errors.contains_key("2026-10-06"));
        std::fs::remove_file(&d).unwrap();
        a.resync_wanted = true;
        assert_eq!(a.reconcile(big.iter(), Reconcile::AfterDrop), 2, "what B still holds is written back");
        a.last_sync = None; // the next fsync round is due
        a.tick();
        assert!(a.gaps.is_empty() && !a.resync_wanted, "settled once written and fsynced");
        assert_eq!(a.repaired, 2);
        assert!(a.date_errors.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
