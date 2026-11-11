//! Raw-history retention (設定 → 資料儲存): which stored partitions the historical store's manager removes
//! (historical_store.rs, run in Rust B).
//!
//! The policy is the active `storage_retention` revision (config/storage_settings.py): per source, `persist` and
//! `retention_days` (null = forever). Counting is by the trading dates actually stored, before the family's rollover
//! cutoff -- the current session is never removed:
//!
//! * not kept (`persist: false`): every date before the cutoff. The session stays on disk until the next session's
//!   pre-open (the user's rule: a day stays viewable after the close and across restarts until the next one begins).
//! * kept N trading dates: the newest N dates before the cutoff stay, older ones go.
//! * kept forever: nothing is removed.
//!
//! Defaults when no revision exists: Shioaji kept 3 trading dates, Futu not kept.
//!
//! The codes an account ledger has traded are kept forever, whatever the retention (user 10-22): each ledger
//! publishes them in `<data>/accounts/traded_codes/<ledger>.json` (service/account/account_ledger_service.py
//! publish_traded_codes), and a date being removed keeps those codes' partitions. Removal is fail-closed here too:
//! while that folder is missing (no ledger has published yet) or any file in it cannot be read, nothing is removed.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Retention {
    pub persist: bool,
    /// Trading dates kept before the current session; `None` with `persist` = forever.
    pub days: Option<usize>,
    /// Which kinds of data a kept source keeps (設定 → 資料儲存 → Shioaji, user 11-01); a kind not kept is removed
    /// like a source not kept: at the next session's pre-open.
    pub keep: Categories,
}

/// The kinds of Shioaji data the user picks to keep (config/storage_settings.py CATEGORIES): 大盤 (the indexes),
/// 台指 near month and far months, 個股 spot and futures.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Category {
    Index,
    TxfNear,
    TxfFar,
    Stock,
    StockFutures,
}

pub const CATEGORIES: [(Category, &str); 5] = [(Category::Index, "index"), (Category::TxfNear, "txf_near"),
    (Category::TxfFar, "txf_far"), (Category::Stock, "stock"), (Category::StockFutures, "stock_futures")];

/// A set of categories.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Categories(u8);

impl Categories {
    pub const ALL: Self = Self(0b1_1111);

    pub fn none() -> Self {
        Self(0)
    }

    pub fn with(self, category: Category) -> Self {
        Self(self.0 | (1 << category as u8))
    }

    pub fn contains(self, category: Category) -> bool {
        self.0 & (1 << category as u8) != 0
    }
}

/// The category of one stored Shioaji partition: the market and the code's folder name, with the codes beside it in
/// the same session folder. A TXF month is the near month when it is the earliest TXF month stored in that session
/// (the near month is always subscribed while TXF is: config/subscription_preferences.py); `TXFR1` is the near
/// month's continuous Quote. None: not a market these categories cover (the source keeps it as its retention says).
pub fn category(market: &str, code: &str, siblings: &[String]) -> Option<Category> {
    let code = code.to_uppercase();
    match market.to_uppercase().as_str() {
        "STK" => Some(Category::Stock),
        "IDX" => Some(Category::Index),
        "FUT" if code == "TXFR1" => Some(Category::TxfNear),
        "FUT" => match txf_month(&code) {
            None => Some(Category::StockFutures),
            Some(month) => {
                let earliest = siblings.iter().filter_map(|c| txf_month(&c.to_uppercase())).min();
                Some(if earliest.is_none_or(|e| month <= e) { Category::TxfNear } else { Category::TxfFar })
            }
        },
        _ => None,
    }
}

/// Whether adding this partition can change the category of others in its session folder: a TXF month decides which
/// month is the near one.
pub fn category_depends_on_siblings(market: &str, code: &str) -> bool {
    market.eq_ignore_ascii_case("FUT") && txf_month(&code.to_uppercase()).is_some()
}

/// `TXF<YYYYMM>` -> its delivery month.
fn txf_month(code: &str) -> Option<u32> {
    let month = code.strip_prefix("TXF")?;
    if month.len() == 6 && month.bytes().all(|b| b.is_ascii_digit()) { month.parse().ok() } else { None }
}

pub fn default_retention(source: &str) -> Retention {
    if source.eq_ignore_ascii_case("shioaji") {
        Retention { persist: true, days: Some(3), keep: Categories::ALL }
    } else {
        Retention { persist: false, days: None, keep: Categories::ALL }
    }
}

/// The sources whose raw history is stored, and so pruned by this policy (config/storage_settings.py SOURCES).
pub const SOURCES: [&str; 2] = ["shioaji", "futu"];

/// Every source's policy from the active revision document (`{"values": {"sources": {...}}}`); the defaults when
/// there is no revision. A revision is taken whole or not at all, as settings_api validated it: each source present,
/// `persist` a boolean, `retention_days` null or a positive whole number. Anything else is an error -- never a field
/// quietly replaced by its default.
pub fn retention_policy(doc: Option<&Value>) -> Result<BTreeMap<String, Retention>, String> {
    let Some(doc) = doc else {
        return Ok(SOURCES.iter().map(|s| (s.to_string(), default_retention(s))).collect());
    };
    let sources = doc.get("values").and_then(|v| v.get("sources")).and_then(Value::as_object)
        .ok_or("values.sources is not an object")?;
    let mut out = BTreeMap::new();
    for source in SOURCES {
        let entry = sources.get(source).and_then(Value::as_object).ok_or(format!("{source} is missing"))?;
        let persist = entry.get("persist").and_then(Value::as_bool).ok_or(format!("{source}.persist is not a boolean"))?;
        let days = match entry.get("retention_days") {
            None | Some(Value::Null) => None,
            Some(v) => match v.as_u64() {
                Some(d) if d >= 1 => Some(d as usize),
                _ => return Err(format!("{source}.retention_days {v} is not null or a positive whole number")),
            },
        };
        // `keep` absent: every category (as saved before the choice existed); present: Shioaji only, every category
        // named with a boolean.
        let keep = match entry.get("keep") {
            None => Categories::ALL,
            Some(_) if source != "shioaji" => return Err(format!("{source}.keep is only for shioaji")),
            Some(keep) => {
                let keep = keep.as_object().ok_or(format!("{source}.keep is not an object"))?;
                if keep.len() != CATEGORIES.len() {
                    return Err(format!("{source}.keep must name exactly {:?}", CATEGORIES.map(|(_, n)| n)));
                }
                let mut set = Categories::none();
                for (category, name) in CATEGORIES {
                    match keep.get(name).and_then(Value::as_bool) {
                        Some(true) => set = set.with(category),
                        Some(false) => {}
                        None => return Err(format!("{source}.keep.{name} is not a boolean")),
                    }
                }
                set
            }
        };
        out.insert(source.to_string(), Retention { persist, days, keep });
    }
    Ok(out)
}

/// The cutoff of a market: the oldest of its families' (`source|MARKET|SESSION`) cutoffs, so a date one session still
/// holds (a TXF NIGHT that opened yesterday, before the night pre-open) is not removed for the other.
pub fn market_cutoff(rolled: &BTreeMap<String, String>, source: &str, market: &str) -> Option<String> {
    let prefix = format!("{}|{}|", source.to_lowercase(), market.to_uppercase());
    rolled.iter().filter(|(family, _)| family.starts_with(&prefix)).map(|(_, date)| date.clone()).min()
}

/// The stored dates to remove, given every stored date of one market and its cutoff.
pub fn dates_to_remove(stored: &[String], cutoff: &str, retention: Retention) -> Vec<String> {
    if retention.persist && retention.days.is_none() {
        return Vec::new();
    }
    let keep = if retention.persist { retention.days.unwrap_or(0) } else { 0 };
    let mut older: Vec<&String> = stored.iter().filter(|date| date.as_str() < cutoff).collect();
    older.sort_by(|a, b| b.cmp(a));
    older.into_iter().skip(keep).cloned().collect()
}

/// The traded-codes file a ledger writes (account_ledger_service.py TRADED_CODES_SCHEMA).
pub const TRADED_CODES_SCHEMA: &str = "traded-codes-v1";

/// Kept codes per (source, MARKET): the partition directory names under `session=*/` that are never removed.
pub type KeptCodes = BTreeMap<(String, String), BTreeSet<String>>;

/// Every ledger's traded codes, merged. Err when the folder is missing or any file in it is not a valid
/// traded-codes document: the caller then removes nothing.
pub fn kept_codes(dir: &Path) -> Result<KeptCodes, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut kept = KeptCodes::new();
    let mut files = 0;
    for entry in entries {
        let path = entry.map_err(|e| format!("{}: {e}", dir.display()))?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        files += 1;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let doc: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        if doc.get("schema").and_then(Value::as_str) != Some(TRADED_CODES_SCHEMA) {
            return Err(format!("{}: schema is not {TRADED_CODES_SCHEMA}", path.display()));
        }
        let sources = doc.get("codes").and_then(Value::as_object).ok_or(format!("{}: codes is not an object", path.display()))?;
        for (source, markets) in sources {
            let markets = markets.as_object().ok_or(format!("{}: codes.{source} is not an object", path.display()))?;
            for (market, codes) in markets {
                let codes = codes.as_array().ok_or(format!("{}: codes.{source}.{market} is not a list", path.display()))?;
                let set = kept.entry((source.to_lowercase(), market.to_uppercase())).or_default();
                for code in codes {
                    set.insert(code.as_str().ok_or(format!("{}: a code in {source}.{market} is not a string", path.display()))?.to_uppercase());
                }
            }
        }
    }
    if files == 0 {
        return Err(format!("{}: no ledger has published its traded codes yet", dir.display()));
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn traded_codes_merge_across_ledgers_and_any_bad_file_refuses_them_all() {
        let dir = std::env::temp_dir().join(format!("mr-traded-codes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(kept_codes(&dir).is_err(), "not published yet: nothing may be removed");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(kept_codes(&dir).is_err(), "an empty folder is not published either");
        let write = |name: &str, doc: Value| std::fs::write(dir.join(name), doc.to_string()).unwrap();
        write("actual.json", json!({"schema": TRADED_CODES_SCHEMA, "codes": {"shioaji": {"STK": ["2330", "00981a"]}, "futu": {"US": ["US.MU"]}}}));
        write("paper.json", json!({"schema": TRADED_CODES_SCHEMA, "codes": {"shioaji": {"STK": ["2303"]}, "futu": {"US": []}}}));
        let kept = kept_codes(&dir).unwrap();
        assert_eq!(kept[&("shioaji".into(), "STK".into())], ["00981A", "2303", "2330"].iter().map(|c| c.to_string()).collect());
        assert_eq!(kept[&("futu".into(), "US".into())].len(), 1);
        write("paper.json", json!({"schema": "other", "codes": {}}));
        assert!(kept_codes(&dir).is_err());
        std::fs::write(dir.join("paper.json"), "{").unwrap();
        assert!(kept_codes(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn dates(list: &[&str]) -> Vec<String> {
        list.iter().map(|d| d.to_string()).collect()
    }

    #[test]
    fn not_kept_removes_everything_before_the_current_session() {
        let stored = dates(&["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
        let gone = dates_to_remove(&stored, "2026-10-08", Retention { persist: false, days: None, keep: Categories::ALL });
        assert_eq!(gone, dates(&["2026-10-07", "2026-10-06", "2026-10-05"]));
    }

    #[test]
    fn kept_n_counts_stored_trading_dates_and_never_the_current_one() {
        // A weekend has no partition, so "3 days" is the three newest stored dates before today.
        let stored = dates(&["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
        let gone = dates_to_remove(&stored, "2026-10-08", Retention { persist: true, days: Some(3), keep: Categories::ALL });
        assert_eq!(gone, dates(&["2026-10-02", "2026-10-01", "2026-09-30"]));
        assert!(dates_to_remove(&stored, "2026-10-08", Retention { persist: true, days: None, keep: Categories::ALL }).is_empty(), "forever");
    }

    #[test]
    fn policy_comes_from_the_active_revision_or_the_defaults_without_one() {
        let doc = json!({"values": {"sources": {"shioaji": {"persist": true, "retention_days": null}, "futu": {"persist": true, "retention_days": 5}}}});
        let policy = retention_policy(Some(&doc)).unwrap();
        assert_eq!(policy["shioaji"], Retention { persist: true, days: None, keep: Categories::ALL });
        assert_eq!(policy["futu"], Retention { persist: true, days: Some(5), keep: Categories::ALL });
        let defaults = retention_policy(None).unwrap();
        assert_eq!(defaults["shioaji"], Retention { persist: true, days: Some(3), keep: Categories::ALL });
        assert_eq!(defaults["futu"], Retention { persist: false, days: None, keep: Categories::ALL });
    }

    #[test]
    fn a_partition_is_categorised_by_market_and_code() {
        let siblings = dates(&["TXFR1", "TXF202612", "TXF202611", "CDF202611"]);
        assert_eq!(category("STK", "2330", &siblings), Some(Category::Stock));
        assert_eq!(category("IDX", "TAIEX", &siblings), Some(Category::Index));
        assert_eq!(category("FUT", "TXFR1", &siblings), Some(Category::TxfNear));
        assert_eq!(category("FUT", "TXF202611", &siblings), Some(Category::TxfNear), "the earliest month stored that session");
        assert_eq!(category("FUT", "TXF202612", &siblings), Some(Category::TxfFar));
        assert_eq!(category("FUT", "CDF202611", &siblings), Some(Category::StockFutures));
        assert_eq!(category("US", "US.AAPL", &siblings), None);
    }

    #[test]
    fn keep_names_every_category_or_is_absent() {
        let doc = |keep: Value| json!({"values": {"sources": {"shioaji": {"persist": true, "retention_days": 3, "keep": keep},
                                                              "futu": {"persist": false, "retention_days": null}}}});
        let keep = json!({"index": true, "txf_near": true, "txf_far": false, "stock": true, "stock_futures": false});
        let policy = retention_policy(Some(&doc(keep))).unwrap();
        let shioaji = policy["shioaji"].keep;
        assert!(shioaji.contains(Category::TxfNear) && !shioaji.contains(Category::TxfFar) && !shioaji.contains(Category::StockFutures));
        assert_eq!(policy["futu"].keep, Categories::ALL, "absent: every category");
        for bad in [json!({"index": true}), json!({"index": "yes", "txf_near": true, "txf_far": true, "stock": true, "stock_futures": true}), json!([])] {
            assert!(retention_policy(Some(&doc(bad.clone()))).is_err(), "{bad}");
        }
        let futu_keep = json!({"values": {"sources": {"shioaji": {"persist": true}, "futu": {"persist": true, "keep": {}}}}});
        assert!(retention_policy(Some(&futu_keep)).is_err(), "keep is Shioaji's only");
    }

    #[test]
    fn an_invalid_revision_is_an_error_never_a_field_default() {
        // A persist that is not a boolean must not become the futu default (persist: false = remove everything).
        for doc in [
            json!({"values": {}}),
            json!({"values": {"sources": {"shioaji": {"persist": true}}}}),
            json!({"values": {"sources": {"shioaji": {"persist": true}, "futu": {"persist": "true"}}}}),
            json!({"values": {"sources": {"shioaji": {"persist": true, "retention_days": 0}, "futu": {"persist": true}}}}),
            json!({"values": {"sources": {"shioaji": {"persist": true, "retention_days": "3"}, "futu": {"persist": true}}}}),
        ] {
            assert!(retention_policy(Some(&doc)).is_err(), "{doc}");
        }
    }

    #[test]
    fn a_market_is_cut_at_its_oldest_family() {
        let rolled: BTreeMap<String, String> = [("shioaji|FUT|DAY", "2026-10-08"), ("shioaji|FUT|NIGHT", "2026-10-07"), ("shioaji|STK|DAY", "2026-10-08")]
            .into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(market_cutoff(&rolled, "shioaji", "FUT").as_deref(), Some("2026-10-07"));
        assert_eq!(market_cutoff(&rolled, "shioaji", "STK").as_deref(), Some("2026-10-08"));
        assert_eq!(market_cutoff(&rolled, "futu", "US"), None);
    }
}
