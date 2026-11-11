//! Rust B checkpoint (docs/system-architecture/03 section 5): accumulation state + online features + the cursor
//! they exactly correspond to, for one durable stream. Unfinished inference tasks are not part of it (they are
//! not resumable). Temp file + checksum + atomic replace, previous version kept as the fallback.

use crate::engine::Engine;
use crate::features::FeatureImage;
use crate::rules::RuleSet;
use market_runtime::calendar::Calendar;
use market_runtime::sha256;
use market_runtime::voided::Voided;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// v2: rule events are evaluated by the data (events::evaluate_pending) and each partition carries its pending second;
/// a v1 image holds events a publish-time evaluation made, so it is not read: B rebuilds from the durable stream.
pub const SCHEMA: &str = "analysis-runtime-checkpoint-v2";

#[derive(Serialize, Deserialize)]
pub struct Body {
    pub schema: String,
    pub durable_stream_id: String,
    pub projection_epoch: u64,
    pub cursor: u64,
    pub written_at_ns: i64,
    pub engine: Engine,
    pub features: FeatureImage,
    /// Flow/event rule revisions and calendar version the engine state was built under. A restore under different
    /// ones would mix two classifications and advertise the new version for all of it.
    pub config_label: String,
    /// 模擬下單's matching state at `cursor` (paper.rs). A checkpoint from before it had no orders to hold.
    #[serde(default)]
    pub paper: crate::paper::PaperCheckpoint,
}

/// A checkpoint is resumed as-is only if it was built under the current rules and calendar.
pub fn resumable(built_under: &str, current: &str) -> bool {
    built_under == current
}

/// The shape of the accumulated state. A state that gains a statistic which cannot be derived from what an older
/// checkpoint holds, or whose serialized form changes (a field renamed or retyped), bumps this: that checkpoint is
/// then set aside by its header and rebuilt from the stream, instead of resumed with the new statistic silently
/// zero or failing to decode as this build's types. `ladder-flow-v1`: the 價量 ladder's per-price large/small split.
/// `auction-prints-v2`: call-auction matches (the session's first print included) are marked, never large, and
/// kept out of 爆量 (v1 missed the opening, whose 試撮 Market Runtime does not keep).
/// `midnight-clock-v3`: a clock from the evening before a partition's day no longer finalizes that whole day as
/// no-trade (Futu US partitions were sealed at 23:59 the day before; a v2 checkpoint holds those synthetic minutes).
/// `online-v2-features-v4`: the feature fold's state is online-v2's (today's totals, the price profile, the book per
/// minute), which a v3 checkpoint does not hold. `no-trade-cancels-v5`: a held print has no `cancelled` mark (no
/// source sends a cancel or a correction). `event-priority-v6`: an event record carries its rule's `priority`.
/// `trade-chain-v7`: a volume gap is a hole in the cumulative volume the seen prints cover (accum::TradeChain); a v6
/// checkpoint holds only the newest total, from which the covered spans cannot be known.
/// `large-index-v8`: each minute records its newest large print (`Minute::large_newest`), which the session's newest
/// large orders are found from; a v7 checkpoint holds none.
/// `exchange-time-close-v9`: a minute's quote open / close and the feature fold's minute close and last price are
/// chosen by exchange time (a restart's backfill arrives after newer events); a v8 checkpoint holds no such times.
/// `single-fold-v10`: the feature fold's keys hold the whole session's minutes and the daily summary's day; a v9
/// checkpoint holds 64 minutes and was reset by each reconnect.
/// `key-coverage-v11`: the feature fold's keys hold their book's exchange time and their subscription's coverage; a
/// v10 checkpoint holds neither.
pub const STATE_LAYOUT: &str = "key-coverage-v11";

/// What a restored engine must have been built under to be resumed as-is.
pub fn config_label(engine: &Engine, voided: &Voided) -> String {
    label(&engine.rules, &engine.cal, voided)
}

/// The label a checkpoint built now under these rules, calendar and void-event list (market_runtime voided.rs)
/// carries: a state folded under another list may hold an event now void, or lack one no longer void.
pub fn label(rules: &RuleSet, cal: &Calendar, voided: &Voided) -> String {
    format!("{}|cal:{}|state:{STATE_LAYOUT}|voided:{}", rules.version_label(), cal.version, voided.fingerprint())
}

/// What a checkpoint is judged by before its state is decoded. The state's types belong to the build that wrote it:
/// one built under another layout, rules or calendar is set aside on these fields alone, never decoded as this
/// build's types (where a changed field reads as a damaged file).
#[derive(Deserialize)]
pub struct Header {
    pub schema: String,
    pub cursor: u64,
    pub projection_epoch: u64,
    pub config_label: String,
}

/// A checkpoint that passed its checksum: resumed, or set aside by design because it was built under another
/// label (the stream is replayed from the start, under a newer projection epoch).
pub enum Restored {
    Resume(Body),
    Superseded(Header),
}

impl Restored {
    pub fn cursor(&self) -> u64 {
        match self {
            Restored::Resume(body) => body.cursor,
            Restored::Superseded(header) => header.cursor,
        }
    }
}

/// On disk: `{"body_sha256": <hex>, "body": <Body>}`, the checksum over the body's bytes exactly as written, so a
/// write serializes the state once and a read hashes what it read. Any other envelope (e.g. the older `sha256` over
/// a re-serialized tree) is refused; the caller records the refusal and rebuilds from the stream.
#[derive(Deserialize)]
struct Stored<'a> {
    body_sha256: String,
    #[serde(borrow)]
    body: &'a serde_json::value::RawValue,
}

fn current(dir: &Path) -> PathBuf {
    dir.join("checkpoint.json")
}
fn previous(dir: &Path) -> PathBuf {
    dir.join("checkpoint.prev.json")
}

pub fn encode(body: &Body) -> io::Result<Vec<u8>> {
    let body_bytes = serde_json::to_vec(body).map_err(io::Error::other)?;
    let mut out = Vec::with_capacity(body_bytes.len() + 96);
    out.extend_from_slice(b"{\"body_sha256\":\"");
    out.extend_from_slice(sha256::hex(&body_bytes).as_bytes());
    out.extend_from_slice(b"\",\"body\":");
    out.extend_from_slice(&body_bytes);
    out.push(b'}');
    Ok(out)
}

/// The `checkpoint.json` this process wrote or verified itself, by (size, mtime). Rotating it into the fallback slot
/// needs it to be valid; re-reading and re-hashing the whole file every 30 s to learn that took most of the 13.7 s a
/// 165 MB write was observed to take, so the final checkpoint on stop overran Health's 15 s and B was
/// killed (`checkpoint on stop not confirmed`). A file that is not the one recorded here is still verified in full.
static KNOWN_GOOD: Mutex<Vec<(PathBuf, u64, SystemTime)>> = Mutex::new(Vec::new());

fn stamp(path: &Path) -> Option<(u64, SystemTime)> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

fn remember_good(path: &Path) {
    let Some((len, modified)) = stamp(path) else { return };
    let mut known = KNOWN_GOOD.lock().unwrap();
    known.retain(|(p, _, _)| p != path);
    known.push((path.to_path_buf(), len, modified));
}

fn known_good(path: &Path) -> bool {
    let Some((len, modified)) = stamp(path) else { return false };
    KNOWN_GOOD.lock().unwrap().iter().any(|(p, l, m)| p == path && *l == len && *m == modified)
}

/// Writes the encoded checkpoint; on failure, the stage that failed (write / fsync / rotate), each counted on its own
/// by the caller.
pub fn write_bytes(dir: &Path, bytes: &[u8]) -> Result<(), (&'static str, io::Error)> {
    fs::create_dir_all(dir).map_err(|e| ("write", e))?;
    let tmp = dir.join("checkpoint.json.tmp");
    let _ = fs::remove_file(&tmp);
    {
        let mut f = File::create(&tmp).map_err(|e| ("write", e))?;
        f.write_all(bytes).map_err(|e| ("write", e))?;
        f.sync_all().map_err(|e| ("fsync", e))?;
    }
    let cur = current(dir);
    if cur.exists() && (known_good(&cur) || verify(&cur).is_ok()) {
        fs::rename(&cur, previous(dir)).map_err(|e| ("rotate", e))?;
    }
    fs::rename(tmp, &cur).map_err(|e| ("rotate", e))?;
    remember_good(&cur);
    Ok(())
}

/// The envelope, checksum and header of a checkpoint file; the state itself is not decoded.
fn read_checked(path: &Path) -> Result<(Vec<u8>, std::ops::Range<usize>, Header), String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let stored: Stored = serde_json::from_slice(&bytes).map_err(|e| format!("envelope: {e}"))?;
    let raw = stored.body.get().as_bytes();
    if sha256::hex(raw) != stored.body_sha256 {
        return Err("checksum mismatch".into());
    }
    let header: Header = serde_json::from_slice(raw).map_err(|e| format!("header: {e}"))?;
    if header.schema != SCHEMA {
        return Err(format!("schema {}", header.schema));
    }
    let start = raw.as_ptr() as usize - bytes.as_ptr() as usize;
    let span = start..start + raw.len();
    Ok((bytes, span, header))
}

/// Whether a file is an intact checkpoint (of any label), so it may become the fallback.
fn verify(path: &Path) -> Result<Header, String> {
    read_checked(path).map(|(_, _, header)| header)
}

fn load_file(path: &Path, current_label: &str) -> Result<Restored, String> {
    let (bytes, span, header) = read_checked(path)?;
    if !resumable(&header.config_label, current_label) {
        return Ok(Restored::Superseded(header));
    }
    // Same label, so the same types: a body that does not decode now is a damaged file or a layout change that
    // did not bump STATE_LAYOUT.
    let body: Body = serde_json::from_slice(&bytes[span]).map_err(|e| format!("body: {e}"))?;
    Ok(Restored::Resume(body))
}

/// The newest intact checkpoint, which one it is (`current`, `previous` or `none`), and why each newer one was not
/// used. Not having `current` while `previous` exists is one of those reasons (a write stopped between its two
/// renames, or the file was removed): restoring the older state without saying so would hide the fallback.
/// A `current` built under another label is returned as such (the caller rebuilds by design); `previous` is
/// older still and is not tried in its place.
pub fn load(dir: &Path, current_label: &str) -> (Option<Restored>, String, Vec<String>) {
    let mut problems = Vec::new();
    for (label, path) in [("current", current(dir)), ("previous", previous(dir))] {
        if !path.exists() {
            if label == "current" && previous(dir).exists() {
                problems.push("current: missing".to_string());
            }
            continue;
        }
        match load_file(&path, current_label) {
            Ok(restored) => {
                if label == "current" {
                    remember_good(&path);
                }
                return (Some(restored), label.into(), problems);
            }
            Err(e) => problems.push(format!("{label}: {e}")),
        }
    }
    (None, "none".into(), problems)
}

#[cfg(test)]
mod resume_tests {
    #[test]
    fn a_checkpoint_built_under_other_rules_is_not_resumed() {
        let now = "flow:r3/event:r2|cal:v1";
        assert!(super::resumable(now, now));
        assert!(!super::resumable("flow:r2/event:r2|cal:v1", now), "flow rules changed while stopped");
        assert!(!super::resumable("flow:r3/event:r2|cal:v0", now), "calendar changed");
    }
}

#[cfg(test)]
mod float_tests {
    use serde_json::{json, Value};

    #[test]
    fn a_checksummed_body_with_hard_floats_reads_back_to_the_same_bytes() {
        // A checkpoint failing its own checksum on restart ("checksum mismatch") makes B replay the day
        // from 0. The checksum is over the re-serialized JSON; without serde_json's float_roundtrip a parsed f64 can
        // be one ULP off, and one such value in the state changes the bytes.
        let values: Vec<f64> = (1..20000).map(|i| (i as f64) * 0.1 / 3.0 + 1e-9 * i as f64).collect();
        let body = json!({"floats": values});
        let bytes = serde_json::to_vec(&body).unwrap();
        let back: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(serde_json::to_vec(&back).unwrap(), bytes, "every f64 must read back exactly");
    }
}

#[cfg(test)]
mod rotation_tests {
    use super::*;

    #[test]
    fn its_own_last_checkpoint_rotates_without_a_reread_and_a_foreign_file_is_still_verified() {
        let dir = std::env::temp_dir().join(format!("ar-rotation-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // Not loadable checkpoints on purpose: rotation can only happen through the known-good record.
        write_bytes(&dir, b"first").unwrap();
        write_bytes(&dir, b"second").unwrap();
        assert_eq!(fs::read(previous(&dir)).unwrap(), b"first", "this process wrote it: rotated without re-reading it");
        // Replaced behind B's back: no longer the file it wrote, so it is verified in full -- and refused.
        fs::write(current(&dir), b"tampered with").unwrap();
        write_bytes(&dir, b"third").unwrap();
        assert_eq!(fs::read(previous(&dir)).unwrap(), b"first", "an unverifiable current never replaces the fallback");
        assert_eq!(fs::read(current(&dir)).unwrap(), b"third");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_current_beside_a_previous_is_a_reason_not_a_silent_fallback() {
        let dir = std::env::temp_dir().join(format!("ar-load-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (body, source, problems) = load(&dir, "test");
        assert!(body.is_none() && source == "none" && problems.is_empty(), "a first start has no reason to report");
        fs::create_dir_all(&dir).unwrap();
        fs::write(previous(&dir), b"not a checkpoint").unwrap();
        let (body, source, problems) = load(&dir, "test");
        assert!(body.is_none());
        assert_eq!(source, "none");
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert_eq!(problems[0], "current: missing");
        assert!(problems[1].starts_with("previous: envelope"), "{problems:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
