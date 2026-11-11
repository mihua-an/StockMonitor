//! `analysis_runtime --verify-partitions <dir>...`: whether each materialized partition's events.jsonl is still the
//! content its manifest describes. The materializer (materialize.rs) is the writer of both files, so this is the one
//! place their agreement is checked; the Python history store asks it (historical_store.py) instead of keeping a second
//! implementation of the hash and the event schema.
//!
//! A partition is intact when its manifest names a content hash and an event count, the raw bytes of events.jsonl
//! hash to that FNV-1a 64, the non-blank lines are that many, and every one of them is a current market event (an
//! older-format line counts as bad, as replay and the dataset builder refuse it). Anything else
//! is reported as the partition's problem; a reader treats it as a gap, never as complete data.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use market_runtime::event::MarketEvent;
use serde_json::{json, Value};

use market_runtime::replay::Fnv1a64;

/// The verdict on one partition directory: `problem` is "" when intact.
pub fn partition(dir: &Path) -> Value {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let verdict = |problem: String, lines: u64, bad: u64| json!({"dir": dir.display().to_string(), "problem": problem,
                                                              "lines": lines, "bad": bad});
    let manifest: Value = match std::fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())
        .and_then(|raw| serde_json::from_slice(&raw).map_err(|e| e.to_string())) {
        Ok(value) => value,
        Err(error) => return verdict(format!("manifest.json of {name} is unreadable: {error}"), 0, 0),
    };
    let file = match File::open(dir.join("events.jsonl")) {
        Ok(file) => file,
        Err(error) => return verdict(format!("events.jsonl of {name} is unreadable: {error}"), 0, 0),
    };
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut line = Vec::new();
    let (mut hash, mut lines, mut bad) = (Fnv1a64::default(), 0u64, 0u64);
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => return verdict(format!("events.jsonl of {name} is unreadable: {error}"), lines, bad),
        }
        hash.update(&line);
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        lines += 1;
        if MarketEvent::decode_slice(&line).is_err() {
            bad += 1;
        }
    }
    let actual = hash.hex();
    let problem = match (manifest.get("content_hash_fnv1a64").and_then(Value::as_str), manifest.get("event_count").and_then(Value::as_u64)) {
        _ if bad > 0 => format!("{bad} undecodable lines in events.jsonl of {name}"),
        (None, _) => format!("the manifest of {name} names no content hash"),
        (_, None) => format!("the manifest of {name} names no event count"),
        (_, Some(count)) if count != lines => format!("{lines} events in events.jsonl of {name}, its manifest says {count}"),
        (Some(expected), _) if expected != actual => format!("events.jsonl of {name} hashes to {actual}, its manifest says {expected}"),
        _ => String::new(),
    };
    verdict(problem, lines, bad)
}

pub fn run(dirs: &[&str]) -> Value {
    json!({"ok": true, "partitions": dirs.iter().map(|dir| partition(Path::new(dir))).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVENT: &str = r#"{"schema_version":2,"event_id":"e1","durable_sequence":1,"symbol":"shioaji:STK:2330","provider":"shioaji","market":"STK","code":"2330","session":"DAY","trading_date":"2026-10-08","generation":1,"sequence":1,"exchange_ts_ns":1,"time_quality":"coverage_control","payload":{"kind":"source_status","state":"subscribed","detail":""}}"#;

    fn write(dir: &Path, events: &str, manifest: Value) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("events.jsonl"), events).unwrap();
        std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    }

    fn hash(text: &str) -> String {
        market_runtime::replay::fnv1a64(text.as_bytes())
    }

    #[test]
    fn intact_damaged_and_unproven_partitions() {
        let root = std::env::temp_dir().join(format!("verify_partition_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let good = format!("{EVENT}\n{EVENT}\n");
        let dir = root.join("good");
        write(&dir, &good, json!({"event_count": 2, "content_hash_fnv1a64": hash(&good)}));
        assert_eq!(partition(&dir)["problem"], "");

        // One valid event changed into another valid event: same line count, only the hash can tell.
        let changed = good.replacen("\"sequence\":1", "\"sequence\":7", 1);
        let dir = root.join("changed");
        write(&dir, &changed, json!({"event_count": 2, "content_hash_fnv1a64": hash(&good)}));
        assert!(partition(&dir)["problem"].as_str().unwrap().contains("hashes to"));

        // JSON that is not a market event is damage, even under a matching hash.
        let foreign = format!("{EVENT}\n{{\"durable_sequence\":3}}\n");
        let dir = root.join("foreign");
        write(&dir, &foreign, json!({"event_count": 2, "content_hash_fnv1a64": hash(&foreign)}));
        assert!(partition(&dir)["problem"].as_str().unwrap().contains("1 undecodable"));

        // An older-format line (a source_status that is not a coverage/loss record) is refused like replay refuses it.
        let old = format!("{EVENT}\n{}\n", EVENT.replace("\"time_quality\":\"coverage_control\",", ""));
        let dir = root.join("old_format");
        write(&dir, &old, json!({"event_count": 2, "content_hash_fnv1a64": hash(&old)}));
        assert!(partition(&dir)["problem"].as_str().unwrap().contains("1 undecodable"));

        let dir = root.join("unhashed");
        write(&dir, &good, json!({"event_count": 2}));
        assert!(partition(&dir)["problem"].as_str().unwrap().contains("no content hash"));

        let dir = root.join("short");
        write(&dir, &format!("{EVENT}\n"), json!({"event_count": 2, "content_hash_fnv1a64": hash(&good)}));
        assert!(partition(&dir)["problem"].as_str().unwrap().contains("manifest says 2"));

        assert!(partition(&root.join("missing"))["problem"].as_str().unwrap().contains("unreadable"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
