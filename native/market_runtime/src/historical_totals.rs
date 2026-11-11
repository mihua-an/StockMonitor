//! One trading date's index in the historical store: every committed partition of the date (session, code) with what
//! its manifest says -- events per lane, the events file's bytes, its completeness -- and the bytes its files take on disk, in
//! `<root>/source=../market=../trading_date=../totals.json`. A reader that wants a date's counts or size (資料中心's
//! date list and expanded date, service/market/query/historical_catalog.py; 模型中心「今天的狀態」,
//! service/analysis/online_training/today.py) reads this one file instead of every partition's manifest.
//!
//! The partition manifests are the authority; this file is an index built from them, written only by the store's
//! manager (historical_store.rs) under the store lock. Each entry carries the stamp of the partition folder it was read
//! from (the folder's modified time): a published partition is a folder renamed in
//! from staging, so a partition published again, added or removed changes the stamps listed. `sync` compares the file with
//! the listing and reads again only the manifests whose stamp it does not hold, so the same call keeps the file
//! current after a publish or a removal and repairs it when an earlier write never happened (a crash between the
//! partition's rename and the file's, a failed write). A date folder with no committed partition has no file.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsutil::atomic_write;

pub const FILE_NAME: &str = "totals.json";
pub const SCHEMA: &str = "historical-date-totals-v3";

/// One committed partition as its manifest describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Partition {
    pub session: String,
    pub code: String,
    /// The partition folder's modified time (ns since the epoch).
    pub stamp_ns: u64,
    /// The manifest's `event_count`.
    pub events: u64,
    /// The manifest's `events_bytes`: the size of its events file.
    pub events_bytes: u64,
    /// Every file of the folder (manifest, state, events), in-flight `.name.tmp` files left out.
    pub bytes: u64,
    /// The manifest's `lane_report`: events per lane, by the lane names Rust B writes (trade, orderbook, quote, ...).
    pub lanes: BTreeMap<String, u64>,
    /// The manifest's `completeness`: complete, repaired (prints filled, the book of a gap lost) or gap_detected.
    pub completeness: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Doc {
    schema: String,
    trading_date: String,
    partitions: Vec<Partition>,
}

/// Every committed partition of one date, by (session, code).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct DateTotals {
    partitions: BTreeMap<(String, String), Partition>,
}

/// How a date's file stood when `sync` compared it with the partitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Synced {
    /// It already held exactly the date's partitions (or the date has none and there is no file).
    Current,
    /// It was written (or removed) from the partitions; `was` says what the file was before.
    Written { was: Was },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Was {
    /// No file, while the date has committed partitions.
    Missing,
    /// Not this schema's file (another schema, not JSON, unreadable).
    Unreadable,
    /// A valid file that no longer matched the partitions.
    Stale,
}

impl Was {
    pub fn reason(self) -> &'static str {
        match self {
            Was::Missing => "missing",
            Was::Unreadable => "unreadable",
            Was::Stale => "stale",
        }
    }
}

fn stamp(meta: &fs::Metadata) -> io::Result<u64> {
    let modified = meta.modified()?;
    Ok(modified.duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0))
}

/// The date's partition folders now: (session, code) -> stamp. Fail-closed: any listing error is returned, never
/// read as an absent partition.
fn listing(date_dir: &Path) -> io::Result<BTreeMap<(String, String), u64>> {
    let mut found = BTreeMap::new();
    let sessions = match fs::read_dir(date_dir) {
        Ok(sessions) => sessions,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(found),
        Err(e) => return Err(e),
    };
    for session in sessions {
        let session = session?;
        let name = session.file_name().to_string_lossy().into_owned();
        let Some(session_name) = name.strip_prefix("session=") else { continue };
        for code in fs::read_dir(session.path())? {
            let code = code?;
            let code_name = code.file_name().to_string_lossy().into_owned();
            if code_name.starts_with('.') {
                continue;
            }
            // The folder's own metadata, not the listing's copy: NTFS updates a child's times in its parent's listing
            // lazily, so the listing can show a time the folder no longer has.
            let meta = fs::metadata(code.path())?;
            if !meta.is_dir() {
                continue;
            }
            found.insert((session_name.to_uppercase(), code_name.to_uppercase()), stamp(&meta)?);
        }
    }
    Ok(found)
}

/// One partition folder read from its manifest. None: the folder has no usable manifest, so it is not a committed
/// partition (reported; readers skip such a folder too).
fn read_partition(partition_dir: &Path, session: &str, code: &str, stamp_ns: u64) -> io::Result<Option<Partition>> {
    let manifest_path = partition_dir.join("manifest.json");
    let manifest = match fs::read(&manifest_path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            eprintln!("[historical_totals] {} has no manifest: not a committed partition, not counted", partition_dir.display());
            return Ok(None);
        }
        Err(e) => return Err(io::Error::new(e.kind(), format!("{}: {e}", manifest_path.display()))),
    };
    let manifest: Value = match serde_json::from_slice(&manifest) {
        Ok(manifest) => manifest,
        Err(e) => {
            eprintln!("[historical_totals] {} is not JSON ({e}): not a committed partition, not counted", manifest_path.display());
            return Ok(None);
        }
    };
    let count = |key: &str| manifest.get(key).and_then(Value::as_u64).unwrap_or(0);
    let lanes = manifest.get("lane_report").and_then(Value::as_object).map(|lanes| lanes.iter()
        .map(|(lane, report)| (lane.clone(), report.get("events").and_then(Value::as_u64).unwrap_or(0))).collect())
        .unwrap_or_default();
    let mut bytes = 0;
    for file in fs::read_dir(partition_dir)? {
        let file = file?;
        if file.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let meta = file.metadata()?;
        if meta.is_file() {
            bytes += meta.len();
        }
    }
    let completeness = manifest.get("completeness").and_then(Value::as_str).unwrap_or("gap_detected").to_owned();
    Ok(Some(Partition { session: session.to_owned(), code: code.to_owned(), stamp_ns, events: count("event_count"),
                        events_bytes: count("events_bytes"), bytes, lanes, completeness }))
}

impl DateTotals {
    /// The date's file. Ok(None): there is none. Err: it is not this schema's file (or cannot be read).
    fn read(date_dir: &Path) -> Result<Option<Self>, String> {
        let path = date_dir.join(FILE_NAME);
        let text = match fs::read(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let doc: Doc = serde_json::from_slice(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        if doc.schema != SCHEMA {
            return Err(format!("{}: schema is not {SCHEMA}", path.display()));
        }
        Ok(Some(Self { partitions: doc.partitions.into_iter().map(|p| ((p.session.clone(), p.code.clone()), p)).collect() }))
    }

    /// The date's partitions now, reusing every entry of `known` whose folder still has the same stamp.
    fn build(date_dir: &Path, known: Option<&Self>) -> io::Result<Self> {
        let mut partitions = BTreeMap::new();
        for ((session, code), stamp_ns) in listing(date_dir)? {
            let kept = known.and_then(|k| k.partitions.get(&(session.clone(), code.clone()))).filter(|p| p.stamp_ns == stamp_ns);
            let partition = match kept {
                Some(partition) => Some(partition.clone()),
                None => read_partition(&date_dir.join(format!("session={session}")).join(&code), &session, &code, stamp_ns)?,
            };
            if let Some(partition) = partition {
                partitions.insert((session, code), partition);
            }
        }
        Ok(Self { partitions })
    }

    /// The date's file, replaced atomically; a date with no partition has none.
    fn write(&self, date_dir: &Path) -> io::Result<()> {
        let path = date_dir.join(FILE_NAME);
        if self.partitions.is_empty() {
            return match fs::remove_file(&path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            };
        }
        let trading_date = date_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let trading_date = trading_date.strip_prefix("trading_date=").unwrap_or(&trading_date).to_owned();
        let doc = Doc { schema: SCHEMA.to_owned(), trading_date, partitions: self.partitions.values().cloned().collect() };
        atomic_write(&path, &serde_json::to_vec_pretty(&doc).map_err(io::Error::other)?)
    }
}

/// Brings one date's file in line with its partitions (see the module documentation): run by the manager under the
/// store lock after it publishes or removes partitions of the date, and over every date when it opens or prunes the
/// store. Only the manifests of partitions the file does not hold as they are now are read.
pub fn sync(date_dir: &Path) -> io::Result<Synced> {
    let (known, unreadable) = match DateTotals::read(date_dir) {
        Ok(known) => (known, false),
        Err(reason) => {
            eprintln!("[historical_totals] {reason}: rebuilt from the partitions");
            (None, true)
        }
    };
    let now = DateTotals::build(date_dir, known.as_ref())?;
    let was = match &known {
        _ if unreadable => Was::Unreadable,
        Some(known) if *known == now => return Ok(Synced::Current),
        Some(_) => Was::Stale,
        None if now.partitions.is_empty() => return Ok(Synced::Current),
        None => Was::Missing,
    };
    now.write(date_dir)?;
    Ok(Synced::Written { was })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("mr-totals-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root.join("trading_date=2026-10-30")
    }

    fn partition(date_dir: &Path, session: &str, code: &str, lanes: &[(&str, u64)], payload: &[u8]) {
        let dir = date_dir.join(format!("session={session}")).join(code);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("events.jsonl"), payload).unwrap();
        let report: serde_json::Map<String, Value> = lanes.iter().map(|(lane, n)| (lane.to_string(), json!({"events": n}))).collect();
        let events: u64 = lanes.iter().map(|(_, n)| n).sum();
        fs::write(dir.join("manifest.json"), json!({"event_count": events, "events_bytes": payload.len(), "lane_report": report}).to_string()).unwrap();
    }

    fn doc(date_dir: &Path) -> Value {
        serde_json::from_slice(&fs::read(date_dir.join(FILE_NAME)).unwrap()).unwrap()
    }

    fn entry<'a>(doc: &'a Value, session: &str, code: &str) -> &'a Value {
        doc["partitions"].as_array().unwrap().iter().find(|p| p["session"] == session && p["code"] == code).unwrap()
    }

    #[test]
    fn a_date_lists_each_committed_partition_with_its_lanes_and_sizes() {
        let day = temp("scan");
        partition(&day, "DAY", "2330", &[("trade", 2), ("orderbook", 3)], b"12345");
        partition(&day, "NIGHT", "TXFR1", &[("quote", 1)], b"1");
        // Not committed: no manifest yet.
        fs::create_dir_all(day.join("session=DAY/1303")).unwrap();
        assert_eq!(sync(&day).unwrap(), Synced::Written { was: Was::Missing });
        let doc = doc(&day);
        assert_eq!(doc["schema"], json!(SCHEMA));
        assert_eq!(doc["trading_date"], json!("2026-10-30"));
        assert_eq!(doc["partitions"].as_array().unwrap().len(), 2);
        let stock = entry(&doc, "DAY", "2330");
        assert_eq!((stock["events"].clone(), stock["events_bytes"].clone()), (json!(5), json!(5)));
        assert_eq!(stock["lanes"], json!({"trade": 2, "orderbook": 3}));
        let on_disk: u64 = fs::read_dir(day.join("session=DAY/2330")).unwrap().map(|f| f.unwrap().metadata().unwrap().len()).sum();
        assert_eq!(stock["bytes"], json!(on_disk));
        assert_eq!(sync(&day).unwrap(), Synced::Current, "nothing changed: the file is left as it is");
        let _ = fs::remove_dir_all(day.parent().unwrap());
    }

    #[test]
    fn a_partition_published_again_is_read_again_and_only_it() {
        let day = temp("republish");
        partition(&day, "DAY", "2330", &[("trade", 2)], b"12");
        partition(&day, "DAY", "2303", &[("trade", 1)], b"1");
        sync(&day).unwrap();
        // 2303's manifest changes without its folder being published again: the index keeps what it read.
        fs::write(day.join("session=DAY/2303/manifest.json"), b"{").unwrap();
        // 2330 published again: a new folder renamed in place of the old one.
        let staged = day.parent().unwrap().join("staged");
        partition(&staged, "DAY", "2330", &[("trade", 7)], b"1234567");
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::remove_dir_all(day.join("session=DAY/2330")).unwrap();
        fs::rename(staged.join("session=DAY/2330"), day.join("session=DAY/2330")).unwrap();
        assert_eq!(sync(&day).unwrap(), Synced::Written { was: Was::Stale });
        let doc = doc(&day);
        assert_eq!(entry(&doc, "DAY", "2330")["events"], json!(7));
        assert_eq!(entry(&doc, "DAY", "2303")["events"], json!(1), "an unchanged folder's entry is reused, its manifest not read");
        let _ = fs::remove_dir_all(day.parent().unwrap());
    }

    #[test]
    fn a_removed_partition_leaves_and_a_date_with_none_has_no_file() {
        let day = temp("removed");
        partition(&day, "DAY", "2330", &[("trade", 2)], b"12");
        partition(&day, "DAY", "2303", &[("trade", 1)], b"1");
        sync(&day).unwrap();
        fs::remove_dir_all(day.join("session=DAY/2303")).unwrap();
        assert_eq!(sync(&day).unwrap(), Synced::Written { was: Was::Stale });
        assert_eq!(doc(&day)["partitions"].as_array().unwrap().len(), 1);
        fs::remove_dir_all(day.join("session=DAY/2330")).unwrap();
        assert_eq!(sync(&day).unwrap(), Synced::Written { was: Was::Stale });
        assert!(!day.join(FILE_NAME).exists(), "a date with no partition left has no totals");
        assert_eq!(sync(&day).unwrap(), Synced::Current);
        let _ = fs::remove_dir_all(day.parent().unwrap());
    }

    #[test]
    fn a_file_of_another_schema_is_rebuilt_from_the_partitions() {
        let day = temp("schema");
        partition(&day, "DAY", "2330", &[("trade", 2)], b"12");
        fs::write(day.join(FILE_NAME), json!({"schema": "historical-date-totals-v1", "events": 99}).to_string()).unwrap();
        assert_eq!(sync(&day).unwrap(), Synced::Written { was: Was::Unreadable });
        assert_eq!(doc(&day)["schema"], json!(SCHEMA));
        fs::write(day.join(FILE_NAME), b"{").unwrap();
        assert_eq!(sync(&day).unwrap(), Synced::Written { was: Was::Unreadable });
        assert_eq!(entry(&doc(&day), "DAY", "2330")["events"], json!(2));
        let _ = fs::remove_dir_all(day.parent().unwrap());
    }
}
