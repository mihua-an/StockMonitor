//! Rust A checkpoint (docs/system-architecture/03 section 5).
//!
//! A checkpoint is the latest state EXACTLY at a committed prefix of the WAL: the daemon captures it only while
//! ingest is paused and the writer has committed everything accepted, so the image can never be ahead of the
//! cursor it names. Files are written to a temp path with a SHA-256 of the body, synced and atomically renamed;
//! the previous valid checkpoint is kept, and a corrupt newest one falls back to it, then to the anchor (a copy
//! refreshed at most every ANCHOR_INTERVAL), and only then to a full WAL replay. Before the anchor two
//! bad files meant replaying every day the WAL still held -- minutes of startup.

use crate::evidence::Image;
use crate::sha256;
use crate::state::EngineImage;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// v5: each tape print in the image carries its cumulative volume (state::Trade::total_volume). An older checkpoint
/// is not read: recovery replays the WAL (an older format is rebuilt, never converted). The version moves with every
/// change to what the image holds -- a field a v4 image never had would otherwise be restored as "unknown" and
/// written back that way by every later checkpoint.
pub const CHECKPOINT_SCHEMA: &str = "market-runtime-checkpoint-v5";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointBody {
    pub schema: String,
    pub durable_stream_id: String,
    pub runtime_epoch: u64,
    /// Every event with durable_sequence <= this is reflected in `engine`, and nothing after it.
    pub durable_sequence: u64,
    pub background_revision: Option<u64>,
    pub breadth_revision: Option<u64>,
    pub written_at_ns: u64,
    pub engine: EngineImage,
    /// Each open partition's session-evidence fields folded from stored events, as of `durable_sequence`.
    pub evidence: Image,
    /// The void-event list (crate::voided) the image was folded under: a start under another list rebuilds from the WAL.
    pub voided_fingerprint: String,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    sha256: String,
    body: serde_json::Value,
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join("checkpoint.json")
}
fn previous_path(dir: &Path) -> PathBuf {
    dir.join("checkpoint.prev.json")
}
fn anchor_path(dir: &Path) -> PathBuf {
    dir.join("checkpoint.anchor.json")
}

/// How old the anchor may get before the next checkpoint refreshes it: the most a last-resort recovery replays.
pub const ANCHOR_INTERVAL: std::time::Duration = std::time::Duration::from_secs(4 * 3600);

fn anchor_due(dir: &Path) -> bool {
    match fs::metadata(anchor_path(dir)).and_then(|m| m.modified()) {
        Ok(at) => at.elapsed().map(|age| age >= ANCHOR_INTERVAL).unwrap_or(true),
        Err(_) => true,
    }
}

/// A checkpoint write that failed, and at which stage: each stage is counted on its own.
#[derive(Debug)]
pub struct WriteError {
    pub stage: &'static str,
    pub error: io::Error,
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.stage, self.error)
    }
}

pub fn write(dir: &Path, body: &CheckpointBody) -> Result<u64, WriteError> {
    let at = |stage: &'static str| move |error: io::Error| WriteError { stage, error };
    fs::create_dir_all(dir).map_err(at("write"))?;
    let value = serde_json::to_value(body).map_err(io::Error::other).map_err(at("encode"))?;
    let canonical = serde_json::to_vec(&value).map_err(io::Error::other).map_err(at("encode"))?;
    let envelope = Envelope { sha256: sha256::hex(&canonical), body: value };
    let bytes = serde_json::to_vec(&envelope).map_err(io::Error::other).map_err(at("encode"))?;
    let tmp = dir.join("checkpoint.json.tmp");
    let _ = fs::remove_file(&tmp);
    {
        let mut file = File::create(&tmp).map_err(at("write"))?;
        file.write_all(&bytes).map_err(at("write"))?;
        file.sync_all().map_err(at("fsync"))?;
    }
    let current = path(dir);
    if current.exists() && load_file(&current).is_ok() {
        fs::rename(&current, previous_path(dir)).map_err(at("rotate"))?;
    }
    fs::rename(&tmp, &current).map_err(at("rotate"))?;
    if anchor_due(dir) {
        let tmp = dir.join("checkpoint.anchor.json.tmp");
        let _ = fs::remove_file(&tmp);
        fs::copy(&current, &tmp).map_err(at("anchor"))?;
        fs::OpenOptions::new().write(true).open(&tmp).and_then(|f| f.sync_all()).map_err(at("anchor"))?;
        fs::rename(&tmp, anchor_path(dir)).map_err(at("anchor"))?;
    }
    Ok(bytes.len() as u64)
}

fn load_file(file: &Path) -> Result<CheckpointBody, String> {
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|e| format!("envelope: {e}"))?;
    let canonical = serde_json::to_vec(&envelope.body).map_err(|e| e.to_string())?;
    if sha256::hex(&canonical) != envelope.sha256 {
        return Err("checksum mismatch".into());
    }
    let body: CheckpointBody = serde_json::from_value(envelope.body).map_err(|e| format!("body: {e}"))?;
    if body.schema != CHECKPOINT_SCHEMA {
        return Err(format!("schema {}", body.schema));
    }
    Ok(body)
}

/// Durable sequences of the checkpoints recovery could start from (current, and the previous it falls back to).
/// Retention must keep the WAL after the OLDEST of them, or a fallback would replay across a removed range.
pub fn recoverable_sequences(dir: &Path) -> Vec<u64> {
    [path(dir), previous_path(dir), anchor_path(dir)].iter().filter(|f| f.exists()).filter_map(|f| load_file(f).ok()).map(|b| b.durable_sequence).collect()
}

pub struct Loaded {
    pub body: Option<CheckpointBody>,
    /// "current" | "previous" | "none" and why the newer one was skipped.
    pub source: String,
    pub problems: Vec<String>,
}

pub fn load(dir: &Path) -> Loaded {
    let mut problems = Vec::new();
    for (label, file) in [("current", path(dir)), ("previous", previous_path(dir)), ("anchor", anchor_path(dir))] {
        if !file.exists() {
            // A write stopped between its two renames (or the file was removed): the older state is a fallback.
            if label == "current" && (previous_path(dir).exists() || anchor_path(dir).exists()) {
                problems.push("current: missing".to_string());
            }
            continue;
        }
        match load_file(&file) {
            Ok(body) => return Loaded { body: Some(body), source: label.into(), problems },
            Err(e) => problems.push(format!("{label}: {e}")),
        }
    }
    Loaded { body: None, source: "none".into(), problems }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(seq: u64) -> CheckpointBody {
        CheckpointBody { schema: CHECKPOINT_SCHEMA.into(), durable_stream_id: "s".into(), runtime_epoch: 1, durable_sequence: seq,
            background_revision: None, breadth_revision: None, written_at_ns: 0, engine: EngineImage::default(), evidence: Vec::new(),
            voided_fingerprint: "none".into() }
    }

    #[test]
    fn a_corrupt_newest_checkpoint_falls_back_to_the_previous_one() {
        let d = std::env::temp_dir().join(format!("stk-ckpt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        write(&d, &body(10)).unwrap();
        write(&d, &body(20)).unwrap();
        assert_eq!(load(&d).body.unwrap().durable_sequence, 20);
        let mut bytes = fs::read(path(&d)).unwrap();
        let n = bytes.len();
        bytes[n / 2] ^= 0x55;
        fs::write(path(&d), bytes).unwrap();
        let loaded = load(&d);
        assert_eq!(loaded.source, "previous");
        assert_eq!(loaded.body.unwrap().durable_sequence, 10);
        assert!(!loaded.problems.is_empty());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_checkpoint_of_an_older_schema_is_not_read() {
        // A v4 image holds prints without their cumulative volume: restoring it would show every 總量 as unknown.
        let d = std::env::temp_dir().join(format!("stk-ckpt-schema-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        write(&d, &CheckpointBody { schema: "market-runtime-checkpoint-v4".into(), ..body(10) }).unwrap();
        let loaded = load(&d);
        assert!(loaded.body.is_none(), "recovery replays the WAL");
        assert!(loaded.problems.iter().any(|p| p.contains("schema market-runtime-checkpoint-v4")), "{:?}", loaded.problems);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_missing_current_beside_an_older_checkpoint_is_reported_as_a_fallback() {
        let d = std::env::temp_dir().join(format!("stk-ckpt-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        write(&d, &body(10)).unwrap();
        write(&d, &body(20)).unwrap();
        fs::remove_file(path(&d)).unwrap(); // a write stopped between its two renames
        let loaded = load(&d);
        assert_eq!(loaded.source, "previous");
        assert_eq!(loaded.problems, vec!["current: missing".to_string()]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn with_both_rolling_checkpoints_bad_recovery_starts_from_the_anchor_not_the_whole_wal() {
        let d = std::env::temp_dir().join(format!("stk-ckpt-anchor-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        write(&d, &body(10)).unwrap(); // first write: no anchor yet, so it becomes the anchor
        write(&d, &body(20)).unwrap();
        write(&d, &body(30)).unwrap(); // anchor is fresh: not refreshed
        assert_eq!(load_file(&anchor_path(&d)).unwrap().durable_sequence, 10);
        for file in [path(&d), previous_path(&d)] {
            fs::write(file, b"{}").unwrap();
        }
        let loaded = load(&d);
        assert_eq!(loaded.source, "anchor");
        assert_eq!(loaded.body.unwrap().durable_sequence, 10);
        assert!(recoverable_sequences(&d).contains(&10), "WAL retention keeps what the anchor needs");
        fs::remove_dir_all(&d).unwrap();
    }
}
