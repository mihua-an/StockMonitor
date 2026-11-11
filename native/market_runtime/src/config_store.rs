//! The versioned settings store settings_api writes (`<config_root>/<domain>/pointer.json` + `revisions/rNNNNNN.json`),
//! read by A and by the historical store manager (historical_store.rs, run in B).

use serde_json::Value;
use std::fs;
use std::io;
use std::path::Path;

/// What reading a config domain's active revision found (settings_api writes the versioned store). Only `Absent` --
/// no pointer and no revisions, or nothing activated yet -- means "no settings, use the defaults"; a store that
/// exists but cannot be read, parsed or matched is `Unusable`, never mistaken for an empty one.
pub enum RevisionRead {
    Absent,
    Active(Value),
    Unusable(String),
}

fn is_revision_file(name: &str) -> bool {
    name.strip_prefix('r').and_then(|rest| rest.strip_suffix(".json")).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub fn read_active_revision(config_root: &Path, domain: &str) -> RevisionRead {
    let dir = config_root.join(domain);
    let pointer_text = match fs::read_to_string(dir.join("pointer.json")) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // Absent only when the revisions folder is missing or provably empty: any other error reading it
            // is an unusable store, so a default such as Futu persist:false never prunes on an I/O failure.
            // Only `r<digits>.json` is a revision (as config_revisions.py counts them): a leftover tmp is not.
            return match fs::read_dir(dir.join("revisions")) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => RevisionRead::Absent,
                Err(e) => RevisionRead::Unusable(format!("pointer missing and revisions unreadable: {e}")),
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) if is_revision_file(&entry.file_name().to_string_lossy()) => {
                                return RevisionRead::Unusable("pointer missing while revisions exist".into());
                            }
                            Ok(_) => {}
                            Err(e) => return RevisionRead::Unusable(format!("pointer missing and revisions unreadable: {e}")),
                        }
                    }
                    RevisionRead::Absent
                }
            };
        }
        Err(e) => return RevisionRead::Unusable(format!("pointer unreadable: {e}")),
    };
    let Ok(pointer) = serde_json::from_str::<Value>(&pointer_text) else { return RevisionRead::Unusable("pointer is not JSON".into()) };
    let active = match pointer.get("active") {
        None | Some(Value::Null) => return RevisionRead::Absent,
        Some(value) => match value.as_u64() {
            Some(active) => active,
            None => return RevisionRead::Unusable(format!("pointer active {value} is not a revision number")),
        },
    };
    let text = match fs::read_to_string(dir.join("revisions").join(format!("r{active:06}.json"))) {
        Ok(text) => text,
        Err(e) => return RevisionRead::Unusable(format!("active revision r{active} unreadable: {e}")),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(doc) if doc.get("revision").and_then(Value::as_u64) == Some(active) => RevisionRead::Active(doc),
        Ok(_) => RevisionRead::Unusable(format!("revision file r{active} does not hold revision {active}")),
        Err(e) => RevisionRead::Unusable(format!("active revision r{active} is not JSON: {e}")),
    }
}
