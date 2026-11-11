//! Roles, permissions and credentials of the market_runtime listener (docs/system-architecture/00 section 4).
//!
//! The permission table is config/system_contract.json -- the same file Python and Node read -- compiled in, so a
//! client can never widen its own rights and the three languages cannot drift apart.
//! A role is proven by a credential; it is never taken from what the client says about itself.

use crate::sha256;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

pub const SYSTEM_CONTRACT: &str = include_str!("../../../config/system_contract.json");
pub const CREDENTIALS_SCHEMA: &str = "market-runtime-credentials-v1";

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    /// A provider is bound to exactly one source: it may ingest only that source's raw events.
    Provider(String),
    AnalysisRuntime,
    SignalProducer,
    Controller,
}

impl Role {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "viewer" => Some(Self::Viewer),
            "analysis_runtime" => Some(Self::AnalysisRuntime),
            "signal_producer" => Some(Self::SignalProducer),
            "controller" => Some(Self::Controller),
            other => other.strip_prefix("provider:").filter(|s| !s.is_empty()).map(|s| Self::Provider(s.to_lowercase())),
        }
    }
    pub fn table_name(&self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Provider(_) => "provider",
            Self::AnalysisRuntime => "analysis_runtime",
            Self::SignalProducer => "signal_producer",
            Self::Controller => "controller",
        }
    }
    pub fn label(&self) -> String {
        match self {
            Self::Provider(source) => format!("provider:{source}"),
            other => other.table_name().to_string(),
        }
    }
}

#[derive(Debug)]
struct Tables {
    permissions: BTreeMap<String, BTreeSet<String>>,
    ingest_kinds: BTreeMap<String, BTreeSet<String>>,
    windows: Vec<i32>,
    fixed_kbars: Vec<i32>,
    kbar_tiers: Vec<(i32, i64)>,
}

/// The part of system_contract.json this listener reads. Parsed whole: a missing table, a non-string command or a
/// window that does not fit used to become an empty set or be dropped, leaving a partial contract nobody noticed.
#[derive(Deserialize)]
struct ContractTables {
    market_runtime_roles: BTreeMap<String, Vec<String>>,
    role_ingest_kinds: BTreeMap<String, Vec<String>>,
    windows_minutes: Vec<i64>,
    fixed_kbar_minutes: Vec<i64>,
    kbar_retention_months: BTreeMap<String, i64>,
}

const TABLE_ROLES: [&str; 5] = ["viewer", "provider", "analysis_runtime", "signal_producer", "controller"];

fn unique_set(what: &str, items: Vec<String>) -> Result<BTreeSet<String>, String> {
    if items.is_empty() {
        return Err(format!("{what} is empty"));
    }
    let mut set = BTreeSet::new();
    for item in items {
        if item.is_empty() || !set.insert(item.clone()) {
            return Err(format!("{what} holds an empty or repeated entry {item:?}"));
        }
    }
    Ok(set)
}

fn minutes(what: &str, values: Vec<i64>) -> Result<Vec<i32>, String> {
    if values.is_empty() {
        return Err(format!("{what} is empty"));
    }
    let out = values.iter().map(|v| i32::try_from(*v).ok().filter(|m| (1..=1440).contains(m)).ok_or_else(|| format!("{what}: {v} is not a minute count in 1..=1440")))
        .collect::<Result<Vec<_>, _>>()?;
    if out.windows(2).any(|w| w[0] >= w[1]) {
        return Err(format!("{what} must be strictly increasing: {out:?}"));
    }
    Ok(out)
}

/// The K-bar tiers, finest first: starting at 1 minute, each a multiple of the one before (a date is folded along them).
fn kbar_tiers(raw: BTreeMap<String, i64>) -> Result<Vec<(i32, i64)>, String> {
    let mut tiers = raw.into_iter().map(|(timeframe, months)| timeframe.parse::<i32>().ok().filter(|m| (1..=1440).contains(m))
        .map(|m| (m, months)).ok_or_else(|| format!("kbar_retention_months: {timeframe} is not a minute count in 1..=1440")))
        .collect::<Result<Vec<_>, _>>()?;
    tiers.sort_unstable();
    if tiers.first().map(|(timeframe, _)| *timeframe) != Some(1) {
        return Err("kbar_retention_months must start at 1 minute".into());
    }
    if tiers.windows(2).any(|pair| pair[1].0 % pair[0].0 != 0) {
        return Err(format!("kbar_retention_months: each timeframe must be a multiple of the one before: {tiers:?}"));
    }
    Ok(tiers)
}

fn parse_tables(text: &str) -> Result<Tables, String> {
    let raw: ContractTables = serde_json::from_str(text).map_err(|e| format!("system_contract.json: {e}"))?;
    let mut permissions = BTreeMap::new();
    for (role, commands) in raw.market_runtime_roles {
        if !TABLE_ROLES.contains(&role.as_str()) {
            return Err(format!("market_runtime_roles: unknown role {role}"));
        }
        permissions.insert(role.clone(), unique_set(&format!("market_runtime_roles.{role}"), commands)?);
    }
    if let Some(missing) = TABLE_ROLES.iter().find(|role| !permissions.contains_key(**role)) {
        return Err(format!("market_runtime_roles: role {missing} missing"));
    }
    let mut ingest_kinds = BTreeMap::new();
    for (role, kinds) in raw.role_ingest_kinds {
        if !permissions.get(&role).is_some_and(|commands| commands.contains("event.ingest") || commands.contains("signals.publish")) {
            return Err(format!("role_ingest_kinds: role {role} has no ingest or publish command"));
        }
        ingest_kinds.insert(role.clone(), unique_set(&format!("role_ingest_kinds.{role}"), kinds)?);
    }
    if !ingest_kinds.contains_key("provider") {
        return Err("role_ingest_kinds: role provider missing".into());
    }
    Ok(Tables {
        permissions,
        ingest_kinds,
        windows: minutes("windows_minutes", raw.windows_minutes)?,
        fixed_kbars: minutes("fixed_kbar_minutes", raw.fixed_kbar_minutes)?,
        kbar_tiers: kbar_tiers(raw.kbar_retention_months)?,
    })
}

/// The compiled-in contract, checked at startup (`server::start`) so a bad one stops the listener with the reason
/// instead of panicking at the first command.
pub fn check() -> Result<(), String> {
    parse_tables(SYSTEM_CONTRACT).map(|_| ())
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| parse_tables(SYSTEM_CONTRACT).unwrap_or_else(|e| panic!("{e}")))
}

pub fn permits(role: &Role, command: &str) -> bool {
    tables().permissions.get(role.table_name()).is_some_and(|set| set.contains(command))
}

pub fn may_ingest_kind(role: &Role, kind: &str) -> bool {
    tables().ingest_kinds.get(role.table_name()).is_some_and(|set| set.contains(kind))
}

pub fn windows_minutes() -> &'static [i32] {
    &tables().windows
}

/// The fixed K-bar periods (3/5/15/30/60 m) Rust B aggregates; system_contract.json is their one authority.
pub fn fixed_kbar_minutes() -> &'static [i32] {
    &tables().fixed_kbars
}

/// The stored K-bar timeframes and how many months each is kept by default, finest first.
pub fn kbar_retention_months() -> &'static [(i32, i64)] {
    &tables().kbar_tiers
}

#[derive(Deserialize)]
struct CredentialFile {
    schema: String,
    /// role label -> lowercase hex SHA-256 of the token.
    roles: BTreeMap<String, String>,
}

/// Token hashes per role. The daemon never stores or logs a token, only its digest.
#[derive(Debug, Clone, Default)]
pub struct Credentials {
    entries: Vec<(Role, [u8; 32])>,
}

impl Credentials {
    pub fn from_json(text: &str) -> Result<Self, String> {
        let file: CredentialFile = serde_json::from_str(text).map_err(|e| format!("credentials: {e}"))?;
        if file.schema != CREDENTIALS_SCHEMA {
            return Err(format!("credentials schema must be {CREDENTIALS_SCHEMA}"));
        }
        let mut entries = Vec::new();
        for (label, hex) in file.roles {
            let role = Role::parse(&label).ok_or_else(|| format!("unknown role {label}"))?;
            let digest = decode_hex32(&hex).ok_or_else(|| format!("role {label}: digest must be 64 hex chars"))?;
            entries.push((role, digest));
        }
        if entries.is_empty() {
            return Err("credentials: no roles".into());
        }
        Ok(Self { entries })
    }

    #[cfg(test)]
    pub fn for_tests(pairs: &[(&str, &str)]) -> Self {
        Self {
            entries: pairs.iter().map(|(label, token)| (Role::parse(label).expect("role"), sha256::digest(token.as_bytes()))).collect(),
        }
    }

    /// Constant-time over every entry, so the answer does not reveal which role (if any) came close.
    pub fn authenticate(&self, token: &str) -> Option<Role> {
        if token.len() < 16 {
            return None;
        }
        let presented = sha256::digest(token.as_bytes());
        let mut found: Option<Role> = None;
        for (role, digest) in &self.entries {
            let mut diff = 0u8;
            for i in 0..32 {
                diff |= digest[i] ^ presented[i];
            }
            if std::hint::black_box(diff) == 0 && found.is_none() {
                found = Some(role.clone());
            }
        }
        found
    }

    pub fn roles(&self) -> Vec<String> {
        self.entries.iter().map(|(role, _)| role.label()).collect()
    }
}

fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.trim();
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn permissions_come_from_the_shared_contract() {
        assert!(permits(&Role::Viewer, "view.subscribe"));
        assert!(!permits(&Role::Viewer, "event.ingest"));
        assert!(!permits(&Role::Viewer, "shutdown"));
        assert!(permits(&Role::Provider("shioaji".into()), "event.ingest"));
        assert!(!permits(&Role::Provider("shioaji".into()), "signals.publish"));
        assert!(permits(&Role::AnalysisRuntime, "projection.publish"));
        assert!(!permits(&Role::AnalysisRuntime, "event.ingest"));
        assert!(permits(&Role::SignalProducer, "signals.publish"));
        // Rust B is the model-signal authority; viewers read the rows back.
        assert!(permits(&Role::AnalysisRuntime, "signals.publish"));
        assert!(permits(&Role::Viewer, "signals.snapshot"));
        assert!(!permits(&Role::SignalProducer, "projection.publish"));
        assert!(permits(&Role::Controller, "shutdown"));
        assert!(may_ingest_kind(&Role::Provider("futu".into()), "trade"));
        assert!(!may_ingest_kind(&Role::Provider("futu".into()), "analysis_signals"));
        assert_eq!(windows_minutes(), &[1, 3, 5, 15, 30, 60]);
        assert_eq!(fixed_kbar_minutes(), &[3, 5, 15, 30, 60]);
        assert_eq!(kbar_retention_months(), &[(1, 3), (5, 5), (15, 7), (30, 9), (60, 11)]);
    }

    #[test]
    fn a_partial_contract_is_refused_with_the_field() {
        let good: Value = serde_json::from_str(SYSTEM_CONTRACT).unwrap();
        assert!(check().is_ok());
        let refused = |edit: &dyn Fn(&mut Value)| {
            let mut doc = good.clone();
            edit(&mut doc);
            parse_tables(&doc.to_string()).unwrap_err()
        };
        assert!(refused(&|d| { d.as_object_mut().unwrap().remove("role_ingest_kinds"); }).contains("role_ingest_kinds"));
        assert!(refused(&|d| { d["market_runtime_roles"].as_object_mut().unwrap().remove("controller"); }).contains("controller"));
        assert!(refused(&|d| d["market_runtime_roles"]["viewer"] = serde_json::json!([])).contains("empty"));
        assert!(refused(&|d| d["market_runtime_roles"]["viewer"] = serde_json::json!(["health", 3])).contains("system_contract.json"));
        assert!(refused(&|d| d["market_runtime_roles"]["viewer"] = serde_json::json!(["health", "health"])).contains("repeated"));
        assert!(refused(&|d| d["windows_minutes"] = serde_json::json!([1, 4294967297i64])).contains("windows_minutes"));
        assert!(refused(&|d| d["fixed_kbar_minutes"] = serde_json::json!([5, 3])).contains("increasing"));
        assert!(refused(&|d| d["kbar_retention_months"] = serde_json::json!({"1": 3, "3": 4, "5": 5})).contains("multiple"), "5 is no multiple of 3");
        assert!(refused(&|d| d["kbar_retention_months"] = serde_json::json!({"5": 5})).contains("start at 1"));
    }

    #[test]
    fn a_role_is_proven_by_its_credential_only() {
        let creds = Credentials::for_tests(&[("viewer", "viewer-token-0123456789"), ("provider:shioaji", "provider-token-0123456789")]);
        assert_eq!(creds.authenticate("viewer-token-0123456789"), Some(Role::Viewer));
        assert_eq!(creds.authenticate("provider-token-0123456789"), Some(Role::Provider("shioaji".into())));
        assert_eq!(creds.authenticate("viewer-token-012345678"), None);
        assert_eq!(creds.authenticate("short"), None);
        let text = format!(r#"{{"schema":"{CREDENTIALS_SCHEMA}","roles":{{"controller":"{}"}}}}"#, sha256::hex(b"controller-token-0123456"));
        assert_eq!(Credentials::from_json(&text).unwrap().authenticate("controller-token-0123456"), Some(Role::Controller));
        assert!(Credentials::from_json(r#"{"schema":"x","roles":{}}"#).is_err());
    }
}
