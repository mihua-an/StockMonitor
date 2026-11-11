//! The historical store's one manager (`<root>/source=../market=../trading_date=../session=../<CODE>/`, docs/decisions.md
//! 歷史分區的管理者, user 11-03): every change to the store's partitions and to its dates' totals (historical_totals.rs)
//! goes through here, under one OS file lock on `<root>/.store.lock`. Run by Rust B: the materialization job publishes
//! through it (analysis_runtime materialize.rs) and B's daemon prunes through it at a session rollover and at its start.
//!
//! Rust A writes nothing in the store. It writes only the rollover cutoffs (`write_cutoffs`, its `rolled` families:
//! `source|MARKET|SESSION` -> the date before which that session has rolled over) whenever they move; retention is
//! judged here against them, the active `storage_retention` revision and the codes the account ledgers traded
//! (storage.rs), all read again under the lock at every decision.
//!
//! A job writes each partition into its own staging folder (`<root>/.staging/<job>/`, invisible to readers, which only
//! list `source=` folders) and verifies it there. Publishing then takes the lock and decides with the retention in
//! force at that moment: a partition retention would remove right away is dropped ("expired"), never renamed into the
//! store; any other is renamed into place and its date's totals updated. Because the decision and the prune run under
//! the same lock against the same cutoffs, a prune can never be followed by a late write of what it removed, and a job
//! never sees half a prune.
//!
//! Replacing a partition takes two renames, so its previous copy waits beside it (`.<CODE>.replaced`, same folder and
//! disk) until the new one is in place: a process killed between them leaves that copy for the next prune to put back,
//! and readers skip a session folder's dot entries (`is_hidden`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::config_store::{read_active_revision, RevisionRead};
use crate::fsutil::atomic_write;
use crate::historical_totals;
use crate::remediation;
use crate::rollover;
use crate::storage;

/// The store lock: whoever holds it is the only one changing partitions or totals.
pub const LOCK_FILE: &str = ".store.lock";
/// The jobs' staging folders, one per running job, each beside its `<name>.lock` held for the job's life.
pub const STAGING_DIR: &str = ".staging";
pub const CUTOFFS_SCHEMA: &str = "rollover-cutoffs-v1";
const REPLACED_SUFFIX: &str = ".replaced";

/// A dot entry of a session folder is no partition (a previous copy waiting beside its replacement).
pub fn is_hidden(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.'))
}

#[cfg(test)]
thread_local! {
    /// Tests only: `replace_dir` stops right after moving the previous copy aside, as a killed process would.
    static DIE_AFTER_MOVING_ASIDE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Rust A's one write for the store: its rollover cutoffs, replaced atomically.
pub fn write_cutoffs(path: &Path, rolled: &BTreeMap<String, String>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(&json!({"schema": CUTOFFS_SCHEMA, "rolled": rolled})).map_err(io::Error::other)?;
    atomic_write(path, &bytes)
}

/// The cutoffs A last wrote. No file yet (A never rolled over): no market has a cutoff, so nothing is past retention.
pub fn read_cutoffs(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let doc: Value = serde_json::from_str(&text).map_err(|e| format!("{}: not JSON: {e}", path.display()))?;
    if doc.get("schema").and_then(Value::as_str) != Some(CUTOFFS_SCHEMA) {
        return Err(format!("{}: schema is not {CUTOFFS_SCHEMA}", path.display()));
    }
    serde_json::from_value(doc.get("rolled").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("{}: rolled is not a map of family to date: {e}", path.display()))
}

/// Where the store and its retention inputs are. A missing input path is read as A read it before: no cutoffs file =
/// no cutoff, no config root = the default retention, no traded-codes folder = no kept codes.
#[derive(Clone, Debug)]
pub struct StoreConfig {
    pub root: PathBuf,
    pub cutoffs: Option<PathBuf>,
    pub config_root: Option<PathBuf>,
    pub traded_codes_dir: Option<PathBuf>,
}

/// One partition's identity, as its folders name it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartitionKey {
    pub source: String,
    pub market: String,
    pub trading_date: String,
    pub session: String,
    pub code: String,
}

impl PartitionKey {
    pub fn new(source: &str, market: &str, trading_date: &str, session: &str, code: &str) -> Self {
        Self { source: source.to_lowercase(), market: market.to_uppercase(), trading_date: trading_date.to_owned(),
               session: session.to_uppercase(), code: code.to_uppercase() }
    }

    fn market_dir(&self, root: &Path) -> PathBuf {
        root.join(format!("source={}", self.source)).join(format!("market={}", self.market))
    }

    pub fn date_dir(&self, root: &Path) -> PathBuf {
        self.market_dir(root).join(format!("trading_date={}", self.trading_date))
    }

    fn session_dir(&self, root: &Path) -> PathBuf {
        self.date_dir(root).join(format!("session={}", self.session))
    }

    pub fn dir(&self, root: &Path) -> PathBuf {
        self.session_dir(root).join(&self.code)
    }
}

/// What publishing a staged partition did.
#[derive(Debug, PartialEq, Eq)]
pub enum Published {
    /// Renamed into the store, at this folder.
    Stored(PathBuf),
    /// Retention removes it as it stands now (its date or its category is past retention, or the source/market is
    /// never stored): dropped from staging, never in the store.
    Expired,
}

/// The store lock, held until dropped.
pub struct StoreLock {
    _file: File,
}

/// One job's staging folder. Dropped (job done or failed), the folder and its lock file go; a job that died leaves
/// both, and the next prune removes them once their lock is free.
pub struct Staging {
    dir: PathBuf,
    lock_path: PathBuf,
    lock: Option<File>,
}

impl Staging {
    pub fn partition_dir(&self, key: &PartitionKey) -> PathBuf {
        self.dir.join(format!("session={}", key.session)).join(&key.code)
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        match fs::remove_dir_all(&self.dir) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => eprintln!("[historical_store] removing staging {}: {e}", self.dir.display()),
            _ => {}
        }
        drop(self.lock.take());
        match fs::remove_file(&self.lock_path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => eprintln!("[historical_store] removing {}: {e}", self.lock_path.display()),
            _ => {}
        }
    }
}

/// The retention inputs as read at one decision.
struct Inputs {
    cutoffs: BTreeMap<String, String>,
    policies: BTreeMap<String, storage::Retention>,
    kept: storage::KeptCodes,
}

/// Retention for one market given every date it stores: which partitions it removes.
struct MarketPlan<'a> {
    unstored: bool,
    cutoff: String,
    retention: storage::Retention,
    gone_dates: BTreeSet<String>,
    traded: Option<&'a BTreeSet<String>>,
}

impl<'a> MarketPlan<'a> {
    /// None: nothing of this market is removed (a source the policy does not know, or a market with no cutoff yet).
    fn new(inputs: &'a Inputs, source: &str, market: &str, stored: &[String]) -> Option<Self> {
        // A source the policy does not know is not this program's to prune.
        let retention = *inputs.policies.get(&source.to_lowercase())?;
        let unstored = rollover::never_stored(source, market);
        let cutoff = storage::market_cutoff(&inputs.cutoffs, source, market);
        if cutoff.is_none() && !unstored {
            return None;
        }
        let cutoff = cutoff.unwrap_or_default();
        let gone_dates = if unstored { stored.iter().cloned().collect() } else { storage::dates_to_remove(stored, &cutoff, retention).into_iter().collect() };
        let traded = inputs.kept.get(&(source.to_lowercase(), market.to_uppercase())).filter(|codes| !codes.is_empty() && !unstored);
        Some(Self { unstored, cutoff, retention, gone_dates, traded })
    }

    /// Whether any partition of the date can be removed (a date that cannot is not listed).
    fn touches(&self, date: &str) -> bool {
        self.gone_dates.contains(date) || (self.retention.keep != storage::Categories::ALL && date < self.cutoff.as_str())
    }

    /// Whether one partition goes: its date is past retention, or (a date retention keeps, before the cutoff) its
    /// category is not kept (設定 → 資料儲存 → Shioaji) -- a code an account ledger traded stays either way. Futu
    /// crypto is never stored, so any partition of it goes. `siblings`: every code of its session folder.
    fn removes(&self, date: &str, code: &str, market: &str, siblings: &[String]) -> bool {
        if self.unstored {
            return true;
        }
        if self.traded.is_some_and(|codes| codes.contains(code)) {
            return false;
        }
        if self.gone_dates.contains(date) {
            return true;
        }
        self.retention.keep != storage::Categories::ALL && date < self.cutoff.as_str()
            && storage::category(market, code, siblings).is_some_and(|c| !self.retention.keep.contains(c))
    }
}

/// What one prune did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Maintained {
    /// Date folders, session folders or partitions removed by retention.
    pub removed: usize,
    /// Dates whose totals did not match their partitions (missing, another schema, behind) and were rebuilt.
    pub totals_rebuilt: usize,
}

pub struct Store {
    config: StoreConfig,
    /// The last reason each unusable input was reported for: logged once per new reason.
    reported: Mutex<BTreeMap<&'static str, String>>,
}

impl Store {
    pub fn new(config: StoreConfig) -> Self {
        Self { config, reported: Mutex::new(BTreeMap::new()) }
    }

    pub fn root(&self) -> &Path {
        &self.config.root
    }

    fn report(&self, input: &'static str, reason: &str, consequence: &str) {
        let mut reported = self.reported.lock().unwrap_or_else(|p| p.into_inner());
        if reported.get(input).map(String::as_str) != Some(reason) {
            eprintln!("[historical_store] {input} unusable ({reason}): {consequence}");
            reported.insert(input, reason.to_owned());
        }
    }

    /// The retention inputs now. Fail-closed: only a store with no revision at all takes the defaults; an unreadable
    /// cutoffs file, policy or traded-codes folder is reported and gives None -- nothing is removed or dropped as
    /// expired until it is fixed (a partition is then stored, and the next prune judges it).
    fn inputs(&self) -> Option<Inputs> {
        const CONSEQUENCE: &str = "no stored history is removed or dropped as expired until it is fixed";
        let cutoffs = match self.config.cutoffs.as_deref().map(read_cutoffs) {
            None => BTreeMap::new(),
            Some(Ok(cutoffs)) => cutoffs,
            Some(Err(reason)) => {
                self.report("rollover_cutoffs", &reason, CONSEQUENCE);
                return None;
            }
        };
        let policy = match self.config.config_root.as_deref().map(|r| read_active_revision(r, "storage_retention")) {
            None | Some(RevisionRead::Absent) => None,
            Some(RevisionRead::Active(doc)) => Some(doc),
            Some(RevisionRead::Unusable(reason)) => {
                self.report("storage_retention", &reason, CONSEQUENCE);
                return None;
            }
        };
        let policies = match storage::retention_policy(policy.as_ref()) {
            Ok(policies) => policies,
            Err(reason) => {
                self.report("storage_retention", &reason, CONSEQUENCE);
                return None;
            }
        };
        let kept = match self.config.traded_codes_dir.as_deref().map(storage::kept_codes) {
            None => storage::KeptCodes::new(),
            Some(Ok(kept)) => kept,
            Some(Err(reason)) => {
                self.report("traded_codes", &reason, "no stored history is removed or dropped as expired until every ledger's traded codes can be read");
                return None;
            }
        };
        Some(Inputs { cutoffs, policies, kept })
    }

    /// Takes the store lock, waiting while another process holds it.
    pub fn lock(&self) -> io::Result<StoreLock> {
        fs::create_dir_all(&self.config.root)?;
        let file = File::options().create(true).truncate(false).write(true).open(self.config.root.join(LOCK_FILE))?;
        file.lock()?;
        Ok(StoreLock { _file: file })
    }

    /// A new staging folder for one job, its lock taken before the folder exists (so a prune never takes a folder
    /// being written for one that was left behind).
    pub fn stage(&self) -> io::Result<Staging> {
        let staging = self.config.root.join(STAGING_DIR);
        fs::create_dir_all(&staging)?;
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let name = format!("job-{}-{nanos}", std::process::id());
        let lock_path = staging.join(format!("{name}.lock"));
        let lock = File::options().create_new(true).write(true).open(&lock_path)?;
        lock.lock()?;
        let dir = staging.join(&name);
        fs::create_dir_all(&dir)?;
        Ok(Staging { dir, lock_path, lock: Some(lock) })
    }

    /// Publishes one verified partition from `staging` (see the module documentation). Err: nothing changed in the
    /// store for this partition (the job fails and is retried).
    pub fn publish(&self, staging: &Staging, key: &PartitionKey) -> Result<Published, String> {
        let staged = staging.partition_dir(key);
        let _lock = self.lock().map_err(|e| format!("historical store lock: {e}"))?;
        let root = &self.config.root;
        let stored = stored_dates(&key.market_dir(root));
        let new_date = !stored.contains(&key.trading_date);
        let inputs = self.inputs();
        if let Some(inputs) = &inputs {
            let mut with = stored.clone();
            if new_date {
                with.push(key.trading_date.clone());
            }
            let mut siblings = codes_of(&key.session_dir(root));
            if !siblings.contains(&key.code) {
                siblings.push(key.code.clone());
            }
            let plan = MarketPlan::new(inputs, &key.source, &key.market, &with);
            if plan.is_some_and(|plan| plan.removes(&key.trading_date, &key.code, &key.market, &siblings)) {
                fs::remove_dir_all(&staged).map_err(|e| format!("dropping expired {}: {e}", staged.display()))?;
                return Ok(Published::Expired);
            }
        }
        let target = key.dir(root);
        replace_dir(&staged, &target)?;
        // The date's index follows at once; were this write to fail or never happen (a crash right here), the next
        // prune or the next open finds the file behind the partitions and rebuilds it (sync_all).
        historical_totals::sync(&key.date_dir(root))
            .map_err(|e| format!("{} {}: {e}", historical_totals::FILE_NAME, key.date_dir(root).display()))?;
        // A new date can push the oldest one past an N-day retention, and a TXF month can turn another month of its
        // session into a far month: the market is pruned at once, under the same lock.
        if new_date || storage::category_depends_on_siblings(&key.market, &key.code) {
            if let Some(inputs) = &inputs {
                prune_market(inputs, &key.source, &key.market, &key.market_dir(root));
            }
        }
        Ok(Published::Stored(target))
    }

    /// Retention over the whole store, under the lock: what A's rollover cutoffs, the policy and the traded codes say
    /// goes, goes; then every date's totals are compared with its partitions and rebuilt where they differ. Also
    /// removes staging folders whose job is gone. Run by B's daemon at its start and at each rollover.
    pub fn prune(&self) -> Result<Maintained, String> {
        let _lock = self.lock().map_err(|e| format!("historical store lock: {e}"))?;
        settle_interrupted_replacements(&self.config.root);
        self.sweep_staging();
        let removed = self.inputs().map(|inputs| prune_all(&inputs, &self.config.root)).unwrap_or(0);
        Ok(Maintained { removed, totals_rebuilt: sync_all(&self.config.root) })
    }

    /// Staging folders left by a job that died before it published or dropped them (killed at its timeout, a crash):
    /// a folder whose lock file can be locked (or has none) belongs to no running job.
    fn sweep_staging(&self) {
        let staging = self.config.root.join(STAGING_DIR);
        let entries = match fs::read_dir(&staging) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return,
            Err(e) => {
                eprintln!("[historical_store] listing {}: {e}", staging.display());
                return;
            }
        };
        let mut names = BTreeSet::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            names.insert(name.strip_suffix(".lock").map(str::to_owned).unwrap_or(name));
        }
        for name in names {
            let lock_path = staging.join(format!("{name}.lock"));
            let held = match File::options().write(true).open(&lock_path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => None,
                Err(e) => {
                    eprintln!("[historical_store] opening {}: {e}; its staging is left", lock_path.display());
                    continue;
                }
                Ok(file) => match file.try_lock() {
                    Ok(()) => Some(file),
                    Err(TryLockError::WouldBlock) => continue,
                    Err(TryLockError::Error(e)) => {
                        eprintln!("[historical_store] locking {}: {e}; its staging is left", lock_path.display());
                        continue;
                    }
                },
            };
            let dir = staging.join(&name);
            let removed = match fs::remove_dir_all(&dir) {
                Ok(()) => true,
                Err(e) if e.kind() == io::ErrorKind::NotFound => false,
                Err(e) => {
                    eprintln!("[historical_store] removing staging {}: {e}", dir.display());
                    continue;
                }
            };
            drop(held);
            match fs::remove_file(&lock_path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => eprintln!("[historical_store] removing {}: {e}", lock_path.display()),
                _ => {}
            }
            if removed {
                eprintln!("[historical_store] staging {} of a job that ended without publishing removed", dir.display());
                remediation::emit(remediation::Emit { component: "historical_store", mechanism_id: "historical.staging_orphan_removed",
                    trigger_reason: "job_ended_unpublished", identity: remediation::Identity::default(), attempt: None,
                    outcome: "succeeded", detail: json!({"staging": dir.to_string_lossy()})});
            }
        }
    }
}

/// Where a partition's previous copy waits while it is replaced.
fn aside_of(target: &Path) -> Result<PathBuf, String> {
    let code = target.file_name().ok_or_else(|| format!("{} has no name", target.display()))?;
    Ok(target.with_file_name(format!(".{}{REPLACED_SUFFIX}", code.to_string_lossy())))
}

/// A replacement that never finished, found under the store lock: with no partition in place the previous copy goes
/// back; with one in place (the process died after the second rename) the previous copy is what is left to remove.
fn settle_replacement(aside: &Path, target: &Path) -> Result<(), String> {
    let (action, done) = if target.exists() {
        ("removed_previous", fs::remove_dir_all(aside))
    } else {
        ("restored_previous", fs::rename(aside, target))
    };
    let result = done.map_err(|e| format!("{action} {}: {e}", aside.display()));
    remediation::emit(remediation::Emit { component: "historical_store", mechanism_id: "historical.partition_replace_recovered",
        trigger_reason: "replace_interrupted", identity: remediation::Identity::default(), attempt: None,
        outcome: if result.is_ok() { "succeeded" } else { "failed" },
        detail: json!({"partition": target.to_string_lossy(), "action": action, "error": result.as_ref().err()})});
    result
}

/// Every replacement a killed job left, settled before retention and the totals look at the partitions.
fn settle_interrupted_replacements(root: &Path) {
    let mut each = |date_dir: &Path| {
        let sessions = match fs::read_dir(date_dir) {
            Ok(sessions) => sessions,
            Err(e) => {
                eprintln!("[historical_store] listing {}: {e}", date_dir.display());
                return;
            }
        };
        for session in sessions.flatten().filter(|s| s.file_name().to_string_lossy().starts_with("session=")) {
            let entries = match fs::read_dir(session.path()) {
                Ok(entries) => entries,
                Err(e) => {
                    eprintln!("[historical_store] listing {}: {e}", session.path().display());
                    continue;
                }
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(code) = name.strip_prefix('.').and_then(|n| n.strip_suffix(REPLACED_SUFFIX)) else { continue };
                if let Err(e) = settle_replacement(&entry.path(), &session.path().join(code)) {
                    eprintln!("[historical_store] {e}; tried again at the next prune");
                }
            }
        }
    };
    for_each_date(root, &mut each);
}

/// Moves `staged` to `target`; an existing `target` (the same partition materialized again) is moved aside beside it
/// first and removed after, or put back when the move fails.
fn replace_dir(staged: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| format!("{} has no parent", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let aside = aside_of(target)?;
    // Left by a job killed since the last prune; a rename onto it would fail.
    if aside.exists() {
        settle_replacement(&aside, target)?;
    }
    let replacing = target.exists();
    if replacing {
        fs::rename(target, &aside).map_err(|e| format!("moving aside {}: {e}", target.display()))?;
        #[cfg(test)]
        if DIE_AFTER_MOVING_ASIDE.get() {
            return Err("test: the process died here".into());
        }
    }
    if let Err(e) = fs::rename(staged, target) {
        if replacing {
            if let Err(back) = fs::rename(&aside, target) {
                return Err(format!("publishing {}: {e}; putting the previous partition back failed: {back}", target.display()));
            }
        }
        return Err(format!("publishing {}: {e}", target.display()));
    }
    if replacing {
        if let Err(e) = fs::remove_dir_all(&aside) {
            eprintln!("[historical_store] removing the replaced partition {}: {e} (the next prune tries again)", aside.display());
        }
    }
    Ok(())
}

/// Every `trading_date=` folder of one market.
fn stored_dates(market_dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(market_dir) else { return Vec::new() };
    entries.flatten().filter_map(|e| e.file_name().to_string_lossy().strip_prefix("trading_date=").map(str::to_owned)).collect()
}

/// Every partition of a session folder, upper-cased.
fn codes_of(session_dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(session_dir) else { return Vec::new() };
    entries.flatten().filter(|e| !is_hidden(&e.path())).map(|e| e.file_name().to_string_lossy().to_uppercase()).collect()
}

fn prune_all(inputs: &Inputs, root: &Path) -> usize {
    let mut removed = 0;
    let Ok(sources) = fs::read_dir(root) else { return 0 };
    for source_dir in sources.flatten() {
        let name = source_dir.file_name().to_string_lossy().into_owned();
        let Some(source) = name.strip_prefix("source=") else { continue };
        let Ok(markets) = fs::read_dir(source_dir.path()) else { continue };
        for market_dir in markets.flatten() {
            let name = market_dir.file_name().to_string_lossy().into_owned();
            let Some(market) = name.strip_prefix("market=") else { continue };
            removed += prune_market(inputs, source, market, &market_dir.path());
        }
    }
    removed
}

fn prune_market(inputs: &Inputs, source: &str, market: &str, market_dir: &Path) -> usize {
    let stored = stored_dates(market_dir);
    let Some(plan) = MarketPlan::new(inputs, source, market, &stored) else { return 0 };
    let mut removed = 0;
    for date in stored.iter().filter(|d| plan.touches(d)) {
        let dir = market_dir.join(format!("trading_date={date}"));
        removed += remove_partitions(&dir, |code, siblings| plan.removes(date, code, market, siblings));
    }
    removed
}

fn remove_tree(dir: &Path) -> usize {
    match fs::remove_dir_all(dir) {
        Ok(()) => 1,
        Err(e) => {
            eprintln!("[historical_store] prune {}: {e}", dir.display());
            0
        }
    }
}

/// One date of a market: the partitions `remove(code, codes of its session folder)` names go; a session folder and
/// the date folder go with their last partition, and a date that keeps some gets its totals rewritten.
fn remove_partitions(date_dir: &Path, remove: impl Fn(&str, &[String]) -> bool) -> usize {
    let Ok(sessions) = fs::read_dir(date_dir) else { return 0 };
    let mut removed = 0;
    let mut left = 0;
    for session in sessions.flatten() {
        // The date's totals file is no session.
        if !session.file_name().to_string_lossy().starts_with("session=") {
            continue;
        }
        let Ok(codes) = fs::read_dir(session.path()) else {
            left += 1;
            continue;
        };
        let (hidden, codes): (Vec<fs::DirEntry>, Vec<fs::DirEntry>) = codes.flatten().partition(|c| is_hidden(&c.path()));
        let names: Vec<String> = codes.iter().map(|c| c.file_name().to_string_lossy().to_uppercase()).collect();
        // A previous copy that could not be settled is never removed with the folder around it.
        let mut session_left = hidden.len();
        for (code, name) in codes.iter().zip(&names) {
            if !remove(name, &names) {
                session_left += 1;
                continue;
            }
            let gone = if code.path().is_dir() { remove_tree(&code.path()) } else {
                fs::remove_file(code.path()).map(|_| 1).unwrap_or_else(|e| {
                    eprintln!("[historical_store] prune {}: {e}", code.path().display());
                    0
                })
            };
            removed += gone;
            session_left += 1 - gone;
        }
        if session_left == 0 {
            removed += remove_tree(&session.path());
        } else {
            left += 1;
        }
    }
    if left == 0 {
        removed += remove_tree(date_dir);
    } else if removed > 0 {
        // A failed write leaves the file behind the partitions: the prune's sync_all, right after, tries again.
        if let Err(e) = historical_totals::sync(date_dir) {
            eprintln!("[historical_store] totals {}: {e}", date_dir.display());
        }
    }
    removed
}

/// Every stored date's totals compared with its partitions (historical_totals::sync), under the store lock. A date
/// whose file had to be written is one a publish or a prune left behind (it crashed, or the write failed) or that was
/// stored under another schema: rebuilt, and recorded. Returns how many were rebuilt.
fn sync_all(root: &Path) -> usize {
    let mut rebuilt = 0;
    let mut each = |dir: &Path| match historical_totals::sync(dir) {
        Ok(historical_totals::Synced::Current) => {}
        Ok(historical_totals::Synced::Written { was }) => {
            rebuilt += 1;
            eprintln!("[historical_store] totals {} were {} and are rebuilt from the partitions", dir.display(), was.reason());
            remediation::emit(remediation::Emit { component: "historical_store", mechanism_id: "historical.totals_rebuilt",
                trigger_reason: was.reason(), identity: remediation::Identity::default(), attempt: None,
                outcome: "succeeded", detail: json!({"date_dir": dir.to_string_lossy()})});
        }
        Err(e) => {
            eprintln!("[historical_store] totals {}: {e}; tried again at the next prune", dir.display());
            remediation::emit(remediation::Emit { component: "historical_store", mechanism_id: "historical.totals_rebuilt",
                trigger_reason: "rebuild_failed", identity: remediation::Identity::default(), attempt: None,
                outcome: "failed", detail: json!({"date_dir": dir.to_string_lossy(), "error": e.to_string()})});
        }
    };
    for_each_date(root, &mut each);
    rebuilt
}

/// Every `trading_date=` folder of every market of the store. A folder that cannot be listed is reported.
fn for_each_date(root: &Path, each: &mut dyn FnMut(&Path)) {
    let list = |dir: &Path, prefix: &str| -> Vec<PathBuf> {
        match fs::read_dir(dir) {
            Ok(entries) => entries.filter_map(|e| match e {
                Ok(e) => Some(e),
                Err(err) => {
                    eprintln!("[historical_store] listing {}: {err}", dir.display());
                    None
                }
            }).filter(|e| e.file_name().to_string_lossy().starts_with(prefix)).map(|e| e.path()).collect(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                eprintln!("[historical_store] listing {}: {e}", dir.display());
                Vec::new()
            }
        }
    };
    for source in list(root, "source=") {
        for market in list(&source, "market=") {
            for date in list(&market, "trading_date=") {
                each(&date);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn temp(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mr-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn partition(dir: &Path, events: u64) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("events.jsonl"), "{}\n".repeat(events as usize)).unwrap();
        fs::write(dir.join("manifest.json"), json!({"event_count": events}).to_string()).unwrap();
    }

    fn rolled(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// A store whose policy is the defaults (Shioaji 3 trading dates, Futu not kept) and whose ledgers traded `traded`
    /// on shioaji STK.
    fn store(root: &Path, cutoffs: &[(&str, &str)], traded: &[&str]) -> Store {
        let codes = root.with_extension("traded");
        let _ = fs::remove_dir_all(&codes);
        fs::create_dir_all(&codes).unwrap();
        fs::write(codes.join("actual.json"), json!({"schema": storage::TRADED_CODES_SCHEMA, "codes": {"shioaji": {"STK": traded}}}).to_string()).unwrap();
        let cutoffs_path = root.with_extension("cutoffs.json");
        write_cutoffs(&cutoffs_path, &rolled(cutoffs)).unwrap();
        Store::new(StoreConfig { root: root.to_path_buf(), cutoffs: Some(cutoffs_path), config_root: None, traded_codes_dir: Some(codes) })
    }

    fn stk(date: &str, code: &str) -> PartitionKey {
        PartitionKey::new("shioaji", "STK", date, "DAY", code)
    }

    fn totals(root: &Path, key: &PartitionKey) -> Value {
        serde_json::from_slice(&fs::read(key.date_dir(root).join(historical_totals::FILE_NAME)).unwrap()).unwrap()
    }

    /// The date's events as its totals count them.
    fn events(root: &Path, key: &PartitionKey) -> u64 {
        totals(root, key)["partitions"].as_array().unwrap().iter().map(|p| p["events"].as_u64().unwrap()).sum()
    }

    /// The date's totals built again from nothing but its partitions.
    fn rebuilt(root: &Path, key: &PartitionKey) -> Value {
        let date_dir = key.date_dir(root);
        let kept = fs::read(date_dir.join(historical_totals::FILE_NAME)).unwrap();
        fs::remove_file(date_dir.join(historical_totals::FILE_NAME)).unwrap();
        historical_totals::sync(&date_dir).unwrap();
        let fresh = totals(root, key);
        fs::write(date_dir.join(historical_totals::FILE_NAME), kept).unwrap();
        fresh
    }

    fn stage(store: &Store, key: &PartitionKey, events: u64) -> Staging {
        let staging = store.stage().unwrap();
        partition(&staging.partition_dir(key), events);
        staging
    }

    #[test]
    fn cutoffs_round_trip_and_a_missing_file_is_no_cutoff() {
        let root = temp("cutoffs");
        let path = root.join("rollover_cutoffs.json");
        assert_eq!(read_cutoffs(&path).unwrap(), BTreeMap::new());
        write_cutoffs(&path, &rolled(&[("shioaji|STK|DAY", "2026-11-03")])).unwrap();
        assert_eq!(read_cutoffs(&path).unwrap(), rolled(&[("shioaji|STK|DAY", "2026-11-03")]));
        fs::write(&path, r#"{"schema": "other", "rolled": {}}"#).unwrap();
        assert!(read_cutoffs(&path).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_published_partition_moves_out_of_staging_and_counts_in_its_dates_totals() {
        let root = temp("publish");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-03")], &[]);
        let key = stk("2026-11-03", "2330");
        let staging = stage(&store, &key, 3);
        assert_eq!(store.publish(&staging, &key).unwrap(), Published::Stored(key.dir(&root)));
        assert!(key.dir(&root).join("manifest.json").is_file() && !staging.partition_dir(&key).exists());
        assert_eq!(events(&root, &key), 3);
        // The same partition materialized again replaces the first, counted once.
        partition(&staging.partition_dir(&key), 5);
        store.publish(&staging, &key).unwrap();
        assert_eq!(totals(&root, &key), rebuilt(&root, &key));
        assert_eq!(events(&root, &key), 5);
        let staging_dir = staging.dir.clone();
        drop(staging);
        assert!(!staging_dir.exists(), "a finished job's staging goes with it");
        let _ = fs::remove_dir_all(&root);
    }

    /// The overlap D05-01 is about: a job for a date the rollover has already put past retention publishes after the
    /// prune. Before, the job wrote the partition straight into the store after A pruned, and it stayed until A's next
    /// one-minute re-prune; now it is dropped at publish and never in the store.
    #[test]
    fn a_job_that_publishes_after_the_prune_of_its_date_drops_the_partition() {
        let root = temp("expired");
        // Futu US is not kept: every date before the cutoff goes. The job starts while 11-02 is the current session.
        let store = store(&root, &[("futu|US|FULL", "2026-11-02")], &[]);
        let key = PartitionKey::new("futu", "US", "2026-11-02", "FULL", "US.AAPL");
        let staging = stage(&store, &key, 2);
        // The rollover moved the cutoff past the date and pruned while the job was still writing.
        write_cutoffs(store.config.cutoffs.as_ref().unwrap(), &rolled(&[("futu|US|FULL", "2026-11-03")])).unwrap();
        store.prune().unwrap();
        assert_eq!(store.publish(&staging, &key).unwrap(), Published::Expired);
        assert!(!key.date_dir(&root).exists(), "never written into the store, no totals for it");
        assert!(!staging.partition_dir(&key).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_kept_date_and_a_traded_code_are_published_whatever_the_date() {
        let root = temp("kept");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-06")], &["2303"]);
        for date in ["2026-11-03", "2026-11-04", "2026-11-05"] {
            let key = stk(date, "2330");
            let staging = stage(&store, &key, 1);
            assert!(matches!(store.publish(&staging, &key).unwrap(), Published::Stored(_)), "{date}: one of the 3 newest");
        }
        // Older than the 3 kept dates: dropped, unless an account ledger traded the code.
        let old = stk("2026-11-02", "2330");
        let staging = stage(&store, &old, 1);
        assert_eq!(store.publish(&staging, &old).unwrap(), Published::Expired);
        let traded = stk("2026-11-02", "2303");
        let staging = stage(&store, &traded, 1);
        assert!(matches!(store.publish(&staging, &traded).unwrap(), Published::Stored(_)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_date_published_late_pushes_the_oldest_past_retention_at_once() {
        let root = temp("late");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-07")], &[]);
        for date in ["2026-11-03", "2026-11-04", "2026-11-05"] {
            partition(&stk(date, "2330").dir(&root), 1);
        }
        assert_eq!(store.prune().unwrap().removed, 0, "3 dates before the cutoff: all kept");
        // 11-06 materialized after the rollover to 11-07: it is the newest of the 4, so 11-03 goes now.
        let key = stk("2026-11-06", "2330");
        let staging = stage(&store, &key, 1);
        assert!(matches!(store.publish(&staging, &key).unwrap(), Published::Stored(_)));
        assert!(!stk("2026-11-03", "2330").date_dir(&root).exists());
        assert!(stk("2026-11-04", "2330").dir(&root).is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_publish_waits_for_the_prune_holding_the_lock() {
        let root = temp("contention");
        let store = Arc::new(store(&root, &[("shioaji|STK|DAY", "2026-11-03")], &[]));
        let key = stk("2026-11-03", "2330");
        let staging = stage(&store, &key, 1);
        let held = store.lock().unwrap();
        let publisher = {
            let store = store.clone();
            let key = key.clone();
            std::thread::spawn(move || {
                let started = Instant::now();
                let published = store.publish(&staging, &key).unwrap();
                (published, started.elapsed())
            })
        };
        std::thread::sleep(Duration::from_millis(300));
        assert!(!key.dir(&root).exists(), "nothing is published while another holds the store lock");
        drop(held);
        let (published, waited) = publisher.join().unwrap();
        assert_eq!(published, Published::Stored(key.dir(&root)));
        assert!(waited >= Duration::from_millis(250), "the publish waited for the lock ({waited:?})");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pruning_the_store_writes_missing_totals_and_removes_a_dead_jobs_staging() {
        let root = temp("open");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-07")], &[]);
        for date in ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"] {
            partition(&stk(date, "2330").dir(&root), 1);
        }
        // A job that died: its staging folder and lock file stay, the lock free.
        let dead = root.join(STAGING_DIR).join("job-1-1");
        partition(&dead.join("session=DAY").join("2317"), 1);
        fs::write(root.join(STAGING_DIR).join("job-1-1.lock"), b"").unwrap();
        // A running job: its lock is held.
        let running = store.stage().unwrap();
        partition(&running.partition_dir(&stk("2026-11-06", "2454")), 1);
        assert_eq!(store.prune().unwrap(), Maintained { removed: 6, totals_rebuilt: 3 },
                   "11-02 and 11-03 (partition, session, date) are past the 3 kept; the 3 kept dates had no totals");
        assert!(stk("2026-11-04", "2330").date_dir(&root).join(historical_totals::FILE_NAME).is_file());
        assert!(!dead.exists() && !root.join(STAGING_DIR).join("job-1-1.lock").exists());
        assert!(running.partition_dir(&stk("2026-11-06", "2454")).is_dir(), "a running job's staging stays");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unreadable_input_removes_nothing_and_drops_nothing() {
        let root = temp("unusable");
        let store = store(&root, &[], &[]);
        fs::write(store.config.cutoffs.as_ref().unwrap(), b"{").unwrap();
        partition(&PartitionKey::new("futu", "US", "2026-11-01", "FULL", "US.MU").dir(&root), 1);
        assert_eq!(store.prune().unwrap(), Maintained { removed: 0, totals_rebuilt: 1 }, "nothing removed; the date's missing totals written");
        let key = PartitionKey::new("futu", "US", "2026-11-02", "FULL", "US.AAPL");
        let staging = stage(&store, &key, 1);
        assert!(matches!(store.publish(&staging, &key).unwrap(), Published::Stored(_)), "stored; the next prune judges it");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_date_with_traded_codes_keeps_only_their_partitions() {
        let root = temp("untraded");
        for (session, code) in [("DAY", "2330"), ("DAY", "2303"), ("DAY", "1303"), ("NIGHT", "1303")] {
            partition(&root.join(format!("session={session}")).join(code), 1);
        }
        let keep: BTreeSet<String> = ["2330".to_string()].into();
        assert_eq!(remove_partitions(&root, |code, _| !keep.contains(code)), 4, "2303, 1303 of DAY; 1303 of NIGHT and its emptied session folder");
        assert!(root.join("session=DAY/2330/manifest.json").is_file());
        assert!(!root.join("session=DAY/1303").exists() && !root.join("session=NIGHT").exists());
        let totals: Value = serde_json::from_slice(&fs::read(root.join(historical_totals::FILE_NAME)).unwrap()).unwrap();
        assert_eq!(totals["partitions"].as_array().unwrap().len(), 1, "the kept date's totals count only what stayed");
        assert_eq!(remove_partitions(&root, |code, _| !keep.contains(code)), 0, "nothing more on the next prune");
        remove_partitions(&root, |_, _| true);
        assert!(!root.exists(), "the date folder goes with its last partition");
    }

    #[test]
    fn a_kept_date_drops_the_far_txf_months_when_only_the_near_month_is_kept() {
        let root = temp("categories");
        for (session, code) in [("DAY", "TXFR1"), ("DAY", "TXF202611"), ("DAY", "TXF202612"), ("DAY", "CDF202611"), ("NIGHT", "TXF202612")] {
            partition(&root.join(format!("session={session}")).join(code), 1);
        }
        let keep = storage::Categories::none().with(storage::Category::TxfNear);
        let removed = remove_partitions(&root, |code, siblings| storage::category("FUT", code, siblings).is_some_and(|c| !keep.contains(c)));
        assert_eq!(removed, 2, "TXF202612 and CDF202611 of DAY");
        assert!(root.join("session=DAY/TXFR1").is_dir() && root.join("session=DAY/TXF202611").is_dir());
        assert!(root.join("session=NIGHT/TXF202612").is_dir(), "alone in its session, the night's month is that session's near month");
        let _ = fs::remove_dir_all(&root);
    }

    /// 1104-C01-03: a job killed between replacement's two renames left no partition at all, and its only copy in a
    /// staging folder the next sweep deleted.
    #[test]
    fn a_replacement_killed_between_its_renames_is_put_back_by_the_next_prune() {
        let root = temp("killed-replace");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-03")], &[]);
        let key = stk("2026-11-03", "2330");
        let staging = stage(&store, &key, 3);
        store.publish(&staging, &key).unwrap();
        partition(&staging.partition_dir(&key), 5);
        DIE_AFTER_MOVING_ASIDE.set(true);
        let died = replace_dir(&staging.partition_dir(&key), &key.dir(&root));
        DIE_AFTER_MOVING_ASIDE.set(false);
        let aside = aside_of(&key.dir(&root)).unwrap();
        assert!(died.is_err() && !key.dir(&root).exists() && aside.is_dir());
        assert!(codes_of(key.dir(&root).parent().unwrap()).is_empty(), "the waiting copy is no partition");
        store.prune().unwrap();
        assert!(key.dir(&root).is_dir() && !aside.exists());
        assert_eq!(events(&root, &key), 3, "the previous copy, whole");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_previous_copy_left_behind_a_landed_replacement_is_removed_and_a_new_replacement_is_not_blocked_by_one() {
        let root = temp("landed-replace");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-03")], &[]);
        let key = stk("2026-11-03", "2330");
        let staging = stage(&store, &key, 3);
        store.publish(&staging, &key).unwrap();
        let aside = aside_of(&key.dir(&root)).unwrap();
        partition(&aside, 9);
        store.prune().unwrap();
        assert!(!aside.exists() && key.dir(&root).is_dir());
        assert_eq!(events(&root, &key), 3, "the partition in place is the replacement");
        partition(&aside, 9);
        partition(&staging.partition_dir(&key), 5);
        replace_dir(&staging.partition_dir(&key), &key.dir(&root)).unwrap();
        assert!(!aside.exists(), "a rename onto the leftover would have failed");
        let _ = fs::remove_dir_all(&root);
    }

    /// 1104-C01-04: a publish renames the partition into place and then writes the date's totals -- two commits. A
    /// crash between them used to leave the old totals for good, since opening the store wrote only missing ones.
    #[test]
    fn totals_left_behind_a_published_partition_are_rebuilt_by_the_next_prune() {
        let root = temp("crashed-publish");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-03")], &[]);
        let key = stk("2026-11-03", "2330");
        let staging = stage(&store, &key, 3);
        store.publish(&staging, &key).unwrap();
        // The partition materialized again and renamed into place; the process dies before the totals are written.
        partition(&staging.partition_dir(&key), 5);
        std::thread::sleep(Duration::from_millis(20));
        replace_dir(&staging.partition_dir(&key), &key.dir(&root)).unwrap();
        assert_eq!(events(&root, &key), 3, "the crash left the totals of the partition that is gone");
        // B starts again: its first prune finds the totals behind the partitions.
        assert_eq!(store.prune().unwrap(), Maintained { removed: 0, totals_rebuilt: 1 });
        assert_eq!(events(&root, &key), 5);
        assert_eq!(totals(&root, &key), rebuilt(&root, &key));
        assert_eq!(store.prune().unwrap(), Maintained { removed: 0, totals_rebuilt: 0 }, "current totals are left as they are");
        let _ = fs::remove_dir_all(&root);
    }

    /// 1104-C01-04: a prune removes partitions and then rewrites the date's totals; a failed rewrite was only logged,
    /// and the totals kept counting the removed partitions for good.
    #[test]
    fn totals_left_behind_a_prune_are_rebuilt_by_the_next_prune() {
        let root = temp("crashed-prune");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-04")], &[]);
        for code in ["2330", "2303"] {
            let key = stk("2026-11-03", code);
            let staging = stage(&store, &key, 2);
            store.publish(&staging, &key).unwrap();
        }
        let key = stk("2026-11-03", "2330");
        let stale = fs::read(key.date_dir(&root).join(historical_totals::FILE_NAME)).unwrap();
        // The prune removed 2303 but its totals write never happened.
        fs::remove_dir_all(stk("2026-11-03", "2303").dir(&root)).unwrap();
        fs::write(key.date_dir(&root).join(historical_totals::FILE_NAME), &stale).unwrap();
        assert_eq!(events(&root, &key), 4);
        assert_eq!(store.prune().unwrap(), Maintained { removed: 0, totals_rebuilt: 1 });
        assert_eq!(events(&root, &key), 2);
        let _ = fs::remove_dir_all(&root);
    }

    /// Totals of the earlier schema are not read: the first prune after the upgrade writes every date's anew.
    #[test]
    fn totals_of_the_earlier_schema_are_rewritten_by_the_first_prune() {
        let root = temp("schema");
        let store = store(&root, &[("shioaji|STK|DAY", "2026-11-04")], &[]);
        let key = stk("2026-11-03", "2330");
        partition(&key.dir(&root), 4);
        fs::write(key.date_dir(&root).join(historical_totals::FILE_NAME),
                  json!({"schema": "historical-date-totals-v1", "instruments": 1, "events": 4, "bytes": 9, "sessions": {}}).to_string()).unwrap();
        assert_eq!(store.prune().unwrap().totals_rebuilt, 1);
        assert_eq!(totals(&root, &key)["schema"], json!(historical_totals::SCHEMA));
        assert_eq!(events(&root, &key), 4);
        let _ = fs::remove_dir_all(&root);
    }
}
