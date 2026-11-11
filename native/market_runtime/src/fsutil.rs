//! The one atomic file replace for Rust A and Rust B: write a temp file next to the target, fsync
//! it, rename it over the target. Readers see the old file or the new one, never part of either.
//!
//! Every call writes its own temp file (process id + a per-process serial, created with `create_new`), and writes to
//! the same target are serialized inside the process: B's config watcher and its health thread both write
//! `status.json`, and a temp name shared by the two let one rename or delete the other's half-written file.

use std::collections::BTreeMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static TEMP_SERIAL: AtomicU64 = AtomicU64::new(1);
/// A fixed set of locks, shared out by the target's path: writes of one target always take the same lock, and the
/// number of targets a process ever wrote costs nothing. Two targets sharing a lock only wait for each other.
const TARGET_LOCK_COUNT: usize = 64;
static TARGET_LOCKS: [Mutex<()>; TARGET_LOCK_COUNT] = [const { Mutex::new(()) }; TARGET_LOCK_COUNT];

fn target_lock(path: &Path) -> &'static Mutex<()> {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    &TARGET_LOCKS[hasher.finish() as usize % TARGET_LOCK_COUNT]
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let _serialized = target_lock(path).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let serial = TEMP_SERIAL.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{name}.{}.{serial}.tmp", std::process::id()));
    let written = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        if let Err(e) = fs::remove_file(&tmp) {
            if e.kind() != io::ErrorKind::NotFound {
                eprintln!("[fsutil] could not remove the temp file {} after a failed write: {e}", tmp.display());
            }
        }
    }
    written
}

/// A failed atomic write that the caller keeps running after: counted per target and logged once per distinct
/// error (repeats of the same error are counted, not printed again). Returns the running failure count.
pub struct WriteFailures {
    by_target: Mutex<BTreeMap<String, (u64, String)>>,
}

impl WriteFailures {
    pub const fn new() -> Self {
        WriteFailures { by_target: Mutex::new(BTreeMap::new()) }
    }

    pub fn record(&self, what: &str, path: &Path, error: &io::Error) -> u64 {
        let key = format!("{what}:{}", path.display());
        let text = error.to_string();
        let mut map = self.by_target.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = map.entry(key).or_insert((0, String::new()));
        entry.0 += 1;
        if entry.1 != text {
            eprintln!("[fsutil] {what}: writing {} failed ({} so far): {text}", path.display(), entry.0);
            entry.1 = text;
        }
        entry.0
    }

    /// Failures per target, for a metrics block.
    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        let map = self.by_target.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        map.iter().map(|(k, (n, _))| (k.clone(), *n)).collect()
    }
}

impl Default for WriteFailures {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn replaces_the_whole_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("fsutil-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("state.json");
        atomic_write(&target, b"one").unwrap();
        atomic_write(&target, b"two").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"two");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no temp file left");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writers_of_one_target_never_collide() {
        let dir = std::env::temp_dir().join(format!("fsutil-race-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = Arc::new(dir.join("status.json"));
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|n| {
            let (target, barrier) = (target.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                for round in 0..50 {
                    atomic_write(&target, format!("writer {n} round {round}").as_bytes()).expect("every write succeeds");
                }
            })
        }).collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let text = String::from_utf8(fs::read(&*target).unwrap()).unwrap();
        assert!(text.starts_with("writer ") && text.ends_with("round 49"), "one whole write won: {text}");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no temp file left");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repeated_failure_is_counted() {
        let failures = WriteFailures::new();
        let error = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(failures.record("status", Path::new("x/status.json"), &error), 1);
        assert_eq!(failures.record("status", Path::new("x/status.json"), &error), 2);
        assert_eq!(failures.snapshot().values().copied().collect::<Vec<_>>(), vec![2]);
    }
}
