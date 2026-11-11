//! 量變's baseline, written by the close-of-day materialization (materialize.rs, `--volume-baseline-root`).
//!
//! A whole session (`--code *`) of a scope that has 量變 (`scope`: Shioaji STK DAY, Futu US) publishes its date into
//! `<root>/<source>/volume_baseline` from the very fold it stores: per code, each clock minute's volume of the
//! instrument the canonical engine built -- the same `Instrument::minutes` volume the live 量變 compares
//! (projection.rs `volume_compare_wire`), so the baseline and the live minute are one quantity. Nothing reads the
//! history back for it: a US session's partitions are gigabytes (mostly order books), and reading them again in a
//! provider process held that process for minutes.
//!
//! The layout baseline.rs reads: a JSON twin `<date>.<generation>.json` (`{"schema", "date", "items": {code:
//! {"HH:MM": volume}}}`), then, written last, `<date>.manifest.json` naming it with its codes, row count and FNV-1a
//! 64 -- the manifest is the commit point. A re-materialization (a gap filled from the broker's history) publishes the
//! date again over the same name; the files the previous manifest named go once the new one is committed. The
//! newest KEEP_SESSIONS dates stay. A session with no traded minute publishes nothing (NO_INPUT): the reader then
//! keeps comparing against the session before it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use market_runtime::fsutil::atomic_write;
use market_runtime::volume as vol;
use serde_json::{json, Map, Value};

use crate::accum::Instrument;
use crate::baseline::clock_text;

/// The twin's layout and the manifest's (baseline.rs MANIFEST_SCHEMA).
const TWIN_SCHEMA: &str = "volume-baseline-v1";
const MANIFEST_SCHEMA: &str = "volume-baseline-manifest-v2";
/// How many published sessions a baseline directory keeps (user 10-14: 30). 量比 averages up to
/// baseline::MONTH_DAYS of them, so this stays above that.
pub const KEEP_SESSIONS: usize = 30;

/// The scopes with a previous-session minute baseline: Shioaji stocks' day session and Futu US.
pub fn scope(source: &str, market: &str, session: &str) -> bool {
    (source.eq_ignore_ascii_case("shioaji") && market.eq_ignore_ascii_case("STK") && session.eq_ignore_ascii_case("DAY"))
        || (source.eq_ignore_ascii_case("futu") && market.eq_ignore_ascii_case("US"))
}

/// The directory of a source's baselines under `root` (the daemon's `--volume-baseline-root`).
pub fn dir(root: &Path, source: &str) -> PathBuf {
    root.join(source.to_lowercase()).join("volume_baseline")
}

/// One code's entry: "HH:MM" -> volume of every minute that traded (a minute of no volume is left out).
pub fn code_minutes(inst: &Instrument) -> Map<String, Value> {
    inst.minutes.iter()
        .filter_map(|(minute, m)| vol::positive(m.volume.unwrap_or(0.0)).map(|v| (clock_text(*minute), vol::wire(v))))
        .collect()
}

/// Publish `date` from its codes' entries (codes with no entry are left out). The answer goes into the job's result:
/// what was published, or why not; `problems` are files an earlier build left that could not be removed.
pub fn publish(dir: &Path, date: &str, items: BTreeMap<String, Map<String, Value>>) -> Result<Value, String> {
    let items: BTreeMap<String, Map<String, Value>> = items.into_iter()
        .filter(|(_, minutes)| !minutes.is_empty()).map(|(code, minutes)| (code.trim().to_uppercase(), minutes)).collect();
    if items.is_empty() {
        return Ok(json!({"published": false, "reason": "NO_INPUT", "date": date}));
    }
    fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let rows: usize = items.values().map(Map::len).sum();
    let codes: Vec<&String> = items.keys().collect();
    let body = serde_json::to_vec(&json!({"schema": TWIN_SCHEMA, "date": date, "items": items})).map_err(|e| e.to_string())?;
    let generation = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let twin = format!("{date}.{generation:x}.json");
    atomic_write(&dir.join(&twin), &body).map_err(|e| format!("write {twin}: {e}"))?;
    let manifest_path = dir.join(format!("{date}.manifest.json"));
    let previous = previous_files(&manifest_path);
    let manifest = json!({"schema": MANIFEST_SCHEMA, "date": date, "json": twin, "json_fnv1a64": market_runtime::replay::fnv1a64(&body),
                          "codes": codes, "rows": rows});
    atomic_write(&manifest_path, &serde_json::to_vec(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write {}: {e}", manifest_path.display()))?;
    let mut problems = Vec::new();
    for name in previous.into_iter().filter(|name| *name != twin) {
        remove(&dir.join(&name), &mut problems);
    }
    prune(dir, &mut problems);
    Ok(json!({"published": true, "date": date, "manifest": manifest_path.to_string_lossy(), "codes": codes.len(), "rows": rows,
              "problems": problems}))
}

/// The files the date's current manifest names (its twin, and the parquet an earlier publisher wrote beside it).
fn previous_files(manifest_path: &Path) -> Vec<String> {
    let Ok(bytes) = fs::read(manifest_path) else {
        return Vec::new(); // not an error: the date was not published before (an unreadable one is replaced whole)
    };
    let manifest: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    ["json", "parquet"].iter().filter_map(|field| manifest.get(*field).and_then(Value::as_str))
        .filter(|name| !name.contains(['/', '\\'])).map(str::to_owned).collect()
}

fn remove(path: &Path, problems: &mut Vec<String>) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // not an error: already gone
        Err(e) => problems.push(format!("remove {}: {e}", path.display())),
    }
}

/// Keep the newest KEEP_SESSIONS published dates: every dated file before the oldest kept one goes, its manifest
/// first, so a reader never finds a manifest naming a missing file.
fn prune(dir: &Path, problems: &mut Vec<String>) {
    let names: Vec<String> = match fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect(),
        Err(e) => {
            problems.push(format!("list {}: {e}", dir.display()));
            return;
        }
    };
    let dated = |name: &str| name.len() > 11 && name.as_bytes()[10] == b'.'
        && name[..10].bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    let mut published: Vec<&str> = names.iter().filter(|n| dated(n) && n.ends_with(".manifest.json")).map(|n| &n[..10]).collect();
    published.sort_unstable();
    published.dedup();
    if published.len() <= KEEP_SESSIONS {
        return;
    }
    let oldest_kept = published[published.len() - KEEP_SESSIONS].to_owned();
    let mut old: Vec<&String> = names.iter().filter(|n| dated(n) && n[..10] < *oldest_kept).collect();
    old.sort_by_key(|n| !n.ends_with(".manifest.json"));
    for name in old {
        remove(&dir.join(name), problems);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::baseline::Store;

    struct Root(PathBuf);
    impl Root {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("b-baseline-publish-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            Root(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn minutes(pairs: &[(&str, f64)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), vol::wire(*v))).collect()
    }

    #[test]
    fn a_published_date_is_what_the_reader_reads() {
        let root = Root::new("read");
        let dir = dir(root.path(), "futu");
        let items = BTreeMap::from([("us.mu".to_string(), minutes(&[("09:30", 1200.0), ("09:31", 0.5)])),
                                    ("US.NOK".to_string(), Map::new())]);
        let answer = publish(&dir, "2026-11-05", items).unwrap();
        assert_eq!((answer["published"].clone(), answer["codes"].clone(), answer["rows"].clone()), (json!(true), json!(1), json!(2)));
        let store = Store::new(Some(root.path().to_path_buf()));
        let day = store.for_date("futu", "2026-11-06");
        let day = day.day().expect("READY");
        assert_eq!(day.date, "2026-11-05");
        assert_eq!(day.items["US.MU"][&(9 * 60 + 31)], 0.5);
        assert!(!day.items.contains_key("US.NOK"), "a code with no traded minute is left out");
    }

    #[test]
    fn a_republish_replaces_the_files_the_old_manifest_named() {
        let root = Root::new("replace");
        let dir = dir(root.path(), "shioaji");
        fs::create_dir_all(&dir).unwrap();
        // An earlier publisher's files: a parquet beside its twin.
        fs::write(dir.join("2026-11-06.g1.json"), "{}").unwrap();
        fs::write(dir.join("2026-11-06.g1.parquet"), "x").unwrap();
        fs::write(dir.join("2026-11-06.manifest.json"), json!({"schema": MANIFEST_SCHEMA, "date": "2026-11-06",
            "json": "2026-11-06.g1.json", "parquet": "2026-11-06.g1.parquet"}).to_string()).unwrap();
        publish(&dir, "2026-11-06", BTreeMap::from([("2330".to_string(), minutes(&[("09:00", 5.0)]))])).unwrap();
        let left: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(left.len(), 2, "{left:?}");
        assert!(!left.iter().any(|n| n.contains(".g1.")), "{left:?}");
    }

    #[test]
    fn no_traded_minute_publishes_nothing() {
        let root = Root::new("nothing");
        let dir = dir(root.path(), "futu");
        let answer = publish(&dir, "2026-11-05", BTreeMap::from([("US.MU".to_string(), Map::new())])).unwrap();
        assert_eq!(answer["reason"], "NO_INPUT");
        assert!(!dir.exists());
    }

    #[test]
    fn only_the_newest_sessions_stay() {
        let root = Root::new("newest");
        let dir = dir(root.path(), "shioaji");
        for day in 1..=(KEEP_SESSIONS + 2) {
            let date = format!("2026-10-{day:02}");
            publish(&dir, &date, BTreeMap::from([("2330".to_string(), minutes(&[("09:00", 1.0)]))])).unwrap();
        }
        let mut manifests: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".manifest.json")).collect();
        manifests.sort();
        assert_eq!(manifests.len(), KEEP_SESSIONS);
        assert_eq!(manifests[0], "2026-10-03.manifest.json");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2 * KEEP_SESSIONS);
    }
}
