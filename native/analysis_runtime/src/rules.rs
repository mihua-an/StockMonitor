//! Versioned flow (large/small order) and event rules, owned by settings_api (docs/system-architecture/02 section 5).
//! Rust B reads the ACTIVE revisions from the config store, reports what it applied, and never invents a
//! threshold: an instrument without a matching flow rule reports its classification as unavailable.

use serde::{Deserialize, Serialize};
use market_runtime::config_store::{read_active_revision, RevisionRead};
use market_runtime::wire::money;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Match {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub market: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

impl Match {
    /// None = no match; Some(specificity) otherwise (code > market > source).
    pub fn score(&self, source: &str, market: &str, code: &str) -> Option<u8> {
        let eq = |want: &Option<String>, have: &str| want.as_ref().is_none_or(|w| w.eq_ignore_ascii_case(have));
        if !(eq(&self.source, source) && eq(&self.market, market) && eq(&self.code, code)) {
            return None;
        }
        Some(self.code.is_some() as u8 * 4 + self.market.is_some() as u8 * 2 + self.source.is_some() as u8)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlowRule {
    pub rule_id: String,
    #[serde(default, rename = "match")]
    pub matcher: Match,
    /// "volume" (source volume units) or "amount" (price x volume x unit_size x multiplier, in `currency`)
    pub threshold_type: String,
    pub threshold: f64,
    #[serde(default)]
    pub unit: String,
    /// Shares per volume unit for amount rules (Taiwan stock lot = 1000).
    #[serde(default = "one")]
    pub unit_size: f64,
    #[serde(default = "one")]
    pub multiplier: f64,
    #[serde(default)]
    pub currency: String,
    /// Accumulated attack (the legacy LargeOrderPolicy "IMPACT" rule): consecutive same-side prints no more than
    /// `episode_gap_ms` apart, whose best opposite price never retreats, form one episode; once the episode has
    /// consumed at least `impact_ratio` of the opposite best-level liquidity it met, its prints are large. Absent
    /// = no accumulation rule (a threshold is never invented).
    #[serde(default)]
    pub impact_ratio: Option<f64>,
    #[serde(default)]
    pub episode_gap_ms: Option<i64>,
    /// Longest attack (first to last print); absent = 3000 ms.
    #[serde(default)]
    pub episode_max_ms: Option<i64>,
    /// Impact alone never makes an attack large: the attack must also reach this fraction of the size threshold
    /// (absent = 0.5, i.e. 50 lots against a 100-lot rule). Against a thin book, 1-lot prints "consumed 30%" of
    /// 2 lots and were all marked large.
    #[serde(default)]
    pub impact_min_fraction: Option<f64>,
    /// A print joins an attack's large verdict (EPISODE / IMPACT) only when it is itself at least this fraction
    /// of the size threshold (absent = 0.1, i.e. 10 lots against a 100-lot rule). Same-second 1-lot prints from
    /// unrelated traders chained into a 100-lot "attack" and were each listed as 大單.
    #[serde(default)]
    pub member_min_fraction: Option<f64>,
}

fn one() -> f64 {
    1.0
}

impl FlowRule {
    /// `volume` is a decimal quantity in the instrument's unit (market_runtime::volume). At the threshold counts as
    /// large; binary noise below it (0.1 + 0.2 lots against 0.3) does not make a print small.
    pub fn is_large(&self, price: i64, volume: f64) -> bool {
        let metric = match self.threshold_type.as_str() {
            "amount" => money(price) * volume * self.unit_size * self.multiplier,
            _ => volume,
        };
        !market_runtime::volume::lt(metric, self.threshold)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventRule {
    pub rule_id: String,
    /// window_move | opening_move (爆量 / volume_spike was removed 10-14: its volume is now 量比 on these events)
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, rename = "match")]
    pub matcher: Match,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub direction: Option<String>,
    /// The event's rank: of several events in one minute, a chart marks the highest (the rule's own setting, so a
    /// renamed or user-written label ranks as configured).
    pub priority: i32,
    #[serde(default)]
    pub window: Option<i32>,
    #[serde(default)]
    pub threshold_pct: Option<f64>,
    #[serde(default)]
    pub reset_ratio: Option<f64>,
    /// [from, to] minutes the rule applies in (e.g. opening window); empty = the whole session.
    #[serde(default)]
    pub active_minutes: Option<(i32, i32)>,
    /// minutes the rule is suppressed in (e.g. the closing auction).
    #[serde(default)]
    pub exclude_minutes: Vec<(i32, i32)>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct RuleSet {
    pub flow_revision: Option<u64>,
    pub event_revision: Option<u64>,
    pub flow: Vec<FlowRule>,
    pub events: Vec<EventRule>,
    /// "quote_rule" infers an unknown side from the book in force at the trade; "none" keeps it unknown.
    pub side_inference: String,
}

impl RuleSet {
    pub fn version_label(&self) -> String {
        format!("flow:{}/event:{}", self.flow_revision.map_or("none".into(), |r| format!("r{r}")),
            self.event_revision.map_or("none".into(), |r| format!("r{r}")))
    }

    /// Futu (US stocks, crypto) has no large-order statistics at all (user decision): no minute split,
    /// no per-price split, whatever the rule configuration says.
    pub fn flow_rule(&self, source: &str, market: &str, code: &str) -> Option<&FlowRule> {
        if source.eq_ignore_ascii_case("futu") {
            return None;
        }
        self.flow.iter().filter_map(|r| r.matcher.score(source, market, code).map(|s| (s, r))).max_by_key(|(s, _)| *s).map(|(_, r)| r)
    }

    pub fn event_rules<'a>(&'a self, source: &'a str, market: &'a str, code: &'a str) -> impl Iterator<Item = &'a EventRule> + 'a {
        self.events.iter().filter(move |r| r.enabled && r.matcher.score(source, market, code).is_some())
    }
}

/// The active revision document of a rule domain, read the way A and settings_api read every versioned store.
/// `Ok(None)` only when the domain has no active revision; a store that exists but cannot be read, parsed or
/// matched (a pointer missing beside revisions included) is an error naming the domain -- never "no rules".
fn active(config_root: &Path, domain: &str) -> Result<Option<Value>, String> {
    match read_active_revision(config_root, domain) {
        RevisionRead::Absent => Ok(None),
        RevisionRead::Active(doc) => Ok(Some(doc)),
        RevisionRead::Unusable(reason) => Err(format!("{domain}: {reason}")),
    }
}

/// Load the active flow/event rule revisions. Without a config root (the offline jobs Health starts without one) there
/// are no rules, as with a domain that has no active revision: neither is a problem. A domain
/// whose active revision cannot be read or parsed is a problem (returned, for the status and the caller to act on) and
/// keeps that domain's rules from `previous` -- the set in use when this is a reload; none at startup.
pub fn load(config_root: Option<&Path>, previous: Option<&RuleSet>) -> (RuleSet, Vec<String>) {
    let mut set = RuleSet { side_inference: "quote_rule".into(), ..Default::default() };
    let mut problems = Vec::new();
    let Some(root) = config_root else { return (set, Vec::new()) };
    let keep_flow = |set: &mut RuleSet| if let Some(old) = previous {
        set.flow_revision = old.flow_revision;
        set.flow = old.flow.clone();
        set.side_inference = old.side_inference.clone();
    };
    match active(root, "flow_rules") {
        Ok(None) => {}
        Ok(Some(doc)) => match serde_json::from_value::<Vec<FlowRule>>(doc["values"]["rules"].clone()) {
            Ok(rules) => {
                set.flow_revision = doc["revision"].as_u64();
                set.flow = rules;
                if let Some(s) = doc["values"]["side_inference"].as_str() {
                    set.side_inference = s.to_string();
                }
            }
            Err(e) => {
                problems.push(format!("flow_rules r{:?}: rules do not parse: {e}", doc["revision"].as_u64()));
                keep_flow(&mut set);
            }
        },
        Err(e) => {
            problems.push(e);
            keep_flow(&mut set);
        }
    }
    let keep_events = |set: &mut RuleSet| if let Some(old) = previous {
        set.event_revision = old.event_revision;
        set.events = old.events.clone();
    };
    match active(root, "event_rules") {
        Ok(None) => {}
        Ok(Some(doc)) => match serde_json::from_value::<Vec<EventRule>>(doc["values"]["rules"].clone()) {
            Ok(rules) => {
                set.event_revision = doc["revision"].as_u64();
                set.events = rules;
            }
            Err(e) => {
                problems.push(format!("event_rules r{:?}: rules do not parse: {e}", doc["revision"].as_u64()));
                keep_events(&mut set);
            }
        },
        Err(e) => {
            problems.push(e);
            keep_events(&mut set);
        }
    }
    for problem in &problems {
        eprintln!("[analysis_runtime] rules: {problem}");
    }
    (set, problems)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_most_specific_flow_rule_wins_and_amount_rules_use_unit_size() {
        let set = RuleSet {
            flow: vec![
                FlowRule { rule_id: "mkt".into(), matcher: Match { source: Some("shioaji".into()), market: Some("STK".into()), code: None },
                    threshold_type: "volume".into(), threshold: 100.0, unit: "lot".into(), unit_size: 1000.0, multiplier: 1.0, currency: "TWD".into(), impact_ratio: None, episode_gap_ms: None, episode_max_ms: None, impact_min_fraction: None, member_min_fraction: None },
                FlowRule { rule_id: "2330".into(), matcher: Match { source: Some("shioaji".into()), market: Some("STK".into()), code: Some("2330".into()) },
                    threshold_type: "amount".into(), threshold: 10_000_000.0, unit: "lot".into(), unit_size: 1000.0, multiplier: 1.0, currency: "TWD".into(), impact_ratio: None, episode_gap_ms: None, episode_max_ms: None, impact_min_fraction: None, member_min_fraction: None },
            ],
            ..Default::default()
        };
        let r = set.flow_rule("shioaji", "STK", "2330").unwrap();
        assert_eq!(r.rule_id, "2330");
        assert!(r.is_large(10_000_000, 10.0), "1000 x 10 lots x 1000 shares = 10M");
        assert!(!r.is_large(10_000_000, 9.0));
        assert_eq!(set.flow_rule("shioaji", "STK", "2317").unwrap().rule_id, "mkt");
        assert!(set.flow_rule("futu", "US", "AAPL").is_none(), "no rule, no guess");
    }

    #[test]
    fn a_damaged_rule_domain_is_a_problem_and_a_reload_keeps_the_rules_in_use() {
        let root = std::env::temp_dir().join(format!("b-rules-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let write = |domain: &str, pointer: &str, revision: Option<&str>| {
            let dir = root.join(domain);
            std::fs::create_dir_all(dir.join("revisions")).unwrap();
            std::fs::write(dir.join("pointer.json"), pointer).unwrap();
            if let Some(revision) = revision {
                std::fs::write(dir.join("revisions").join("r000001.json"), revision).unwrap();
            }
        };
        // No domain at all: no rules, no problem.
        let (empty, problems) = load(Some(&root), None);
        assert!(problems.is_empty() && empty.flow.is_empty() && empty.flow_revision.is_none());
        let rule = r#"{"rule_id":"all","match":{},"threshold_type":"volume","threshold":50,"unit":"lot","unit_size":1000}"#;
        write("flow_rules", r#"{"active":1}"#, Some(&format!(r#"{{"revision":1,"values":{{"rules":[{rule}]}}}}"#)));
        let (good, problems) = load(Some(&root), None);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!((good.flow.len(), good.flow_revision), (1, Some(1)));
        for (pointer, revision) in [(r#"{"active":1"#, None), (r#"{"active":"one"}"#, None), (r#"{"active":2}"#, None),
                                    (r#"{"active":1}"#, Some(r#"{"revision":1,"values":{"rules":[{"rule_id":5}]}}"#)),
                                    (r#"{"active":1}"#, Some(r#"{"revision":7,"values":{"rules":[]}}"#))] {
            write("flow_rules", pointer, revision);
            let (reloaded, problems) = load(Some(&root), Some(&good));
            assert_eq!(problems.len(), 1, "{pointer} {revision:?}");
            assert!(problems[0].contains("flow_rules"), "{problems:?}");
            assert_eq!(reloaded.flow, good.flow, "the rules in use are kept");
            assert_eq!(reloaded.flow_revision, Some(1));
            let (startup, problems) = load(Some(&root), None);
            assert!(startup.flow.is_empty() && !problems.is_empty(), "at startup there is nothing to keep; the problem is reported");
        }
        // A pointer missing beside revisions is a damaged store, not "no rules".
        write("flow_rules", r#"{"active":1}"#, Some(&format!(r#"{{"revision":1,"values":{{"rules":[{rule}]}}}}"#)));
        std::fs::remove_file(root.join("flow_rules").join("pointer.json")).unwrap();
        let (reloaded, problems) = load(Some(&root), Some(&good));
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].starts_with("flow_rules: pointer missing"), "{problems:?}");
        assert_eq!(reloaded.flow, good.flow);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_event_rule_states_its_priority() {
        let rule = json!({"rule_id": "win1_up", "type": "window_move", "window": 1, "direction": "up", "threshold_pct": 0.8, "label": "1分急拉"});
        assert!(serde_json::from_value::<EventRule>(rule.clone()).is_err(), "no priority is not read as some default rank");
        let mut ranked = rule;
        ranked["priority"] = json!(400);
        assert_eq!(serde_json::from_value::<EventRule>(ranked).unwrap().priority, 400);
    }

    #[test]
    fn futu_never_gets_a_large_order_rule_even_when_one_is_configured() {
        let any_source = FlowRule { rule_id: "all".into(), matcher: Match { source: None, market: None, code: None },
            threshold_type: "volume".into(), threshold: 100.0, unit: "share".into(), unit_size: 1.0, multiplier: 1.0, currency: "USD".into(),
            impact_ratio: None, episode_gap_ms: None, episode_max_ms: None, impact_min_fraction: None, member_min_fraction: None };
        let futu_rule = FlowRule { rule_id: "futu".into(), matcher: Match { source: Some("futu".into()), market: Some("US".into()), code: None }, ..any_source.clone() };
        let set = RuleSet { flow: vec![any_source, futu_rule], ..Default::default() };
        assert!(set.flow_rule("futu", "US", "NOK").is_none());
        assert!(set.flow_rule("FUTU", "CC", "BTCUSD").is_none());
        assert_eq!(set.flow_rule("shioaji", "STK", "2330").unwrap().rule_id, "all");
    }
}
