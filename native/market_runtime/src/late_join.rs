//! Late joins: a code whose print stream its provider subscribed once its session was trading (decisions.md
//! 盤中才訂閱的商品補當天資料). From the open to its first print nothing of it was recorded; that window is handed to
//! the provider as a gap, the same one a provider restart leaves, and filled from the broker's history by the same
//! path (service/market/shioaji/restart_backfill.py): stored when the code is on the background list, over the live
//! lane to B when it is not. Rust B folds the filled prints into the session from its open.
//!
//! The code's first print in its partition is where it is noticed (Engine::holds_print turning true). Whether its
//! subscription came after the trading had begun is the provider's to say: each subscription report states when each
//! instrument's print stream was subscribed in its process (`since_ns`), which a restart of Market Runtime does not
//! reset. A first print can arrive before the report that states its subscription: it waits for it (`awaiting`).
//! The gaps go back to the provider in the answer to its next ingest batch (`event.ack.batch` `gaps`).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{json, Value};

use crate::event::{InstrumentKey, MarketEvent, Payload};
use crate::evidence::{Ledger, PartitionId, CAUSE_LATE_JOIN};

/// A code's first print in a partition, waiting to be judged.
#[derive(Debug, Clone, PartialEq)]
pub struct FirstPrint {
    pub id: PartitionId,
    pub code: String,
    pub exchange_ns: i64,
    /// The cumulative volume before the print (the exchange's total less its own); None when the stream states none.
    pub total_before: Option<f64>,
}

impl FirstPrint {
    /// The first print `event` is, given that its partition held none before it.
    pub fn of(event: &MarketEvent) -> Option<Self> {
        if event.flags.backfill || event.is_indicative() || crate::rollover::is_odd_lot(&event.provider, &event.market) {
            return None;
        }
        let total_before = match &event.payload {
            Payload::Trade { volume, total_volume, simtrade: false, .. } => before(*total_volume, *volume),
            Payload::Quote { total_volume, volume, .. } if event.market == "FUT" => before(*total_volume, *volume),
            Payload::Quote { .. } if event.market == "IDX" => None,
            _ => return None,
        };
        Some(Self { id: event.clock_scope(), code: event.code.to_uppercase(), exchange_ns: event.exchange_ts_ns, total_before })
    }
}

fn before(total: f64, own: f64) -> Option<f64> {
    (total > 0.0 && own >= 0.0).then(|| (total - own).max(0.0))
}

#[derive(Debug, Default)]
pub struct LateJoins {
    /// The sources whose provider fills gaps from its broker's history (`ingest.hello` `fills_gaps`).
    fills_gaps: BTreeSet<String>,
    /// When each subscribed instrument's print stream was subscribed, as its provider last reported.
    since: HashMap<InstrumentKey, i64>,
    /// First prints whose subscription no report has stated yet.
    awaiting: HashMap<InstrumentKey, FirstPrint>,
    /// The gaps to answer each source's provider with.
    ready: BTreeMap<String, Vec<Value>>,
}

impl LateJoins {
    pub fn set_fills_gaps(&mut self, source: &str, fills: bool) {
        let source = source.to_lowercase();
        if fills {
            self.fills_gaps.insert(source);
        } else {
            self.fills_gaps.remove(&source);
            self.awaiting.retain(|key, _| key.source != source);
        }
    }

    pub fn fills_gaps(&self, source: &str) -> bool {
        self.fills_gaps.contains(&source.to_lowercase())
    }

    /// A provider's subscription report: `subscribed` is every instrument it holds with when its print stream was
    /// subscribed. First prints waiting on one of them are judged now; those of instruments it no longer holds are
    /// dropped (not an error: what it unsubscribed has nothing to fill).
    pub fn subscribed(&mut self, source: &str, subscribed: Vec<(InstrumentKey, i64)>, ledger: &mut Ledger) {
        let source = source.to_lowercase();
        self.since.retain(|key, _| key.source != source);
        self.since.extend(subscribed);
        let waiting: Vec<InstrumentKey> = self.awaiting.keys().filter(|key| key.source == source).cloned().collect();
        for key in waiting {
            let Some(first) = self.awaiting.remove(&key) else { continue };
            if let Some(since) = self.since.get(&key).copied() {
                self.judge(&key, since, first, ledger);
            }
        }
    }

    /// `first`, the first print of `key` in its partition: a late join when its subscription came once the trading
    /// had begun. Judged now when the subscription is known, else when the report stating it arrives.
    pub fn first_print(&mut self, key: InstrumentKey, first: FirstPrint, ledger: &mut Ledger) {
        if !self.fills_gaps(&key.source) {
            return;
        }
        match self.since.get(&key).copied() {
            Some(since) => self.judge(&key, since, first, ledger),
            None => {
                self.awaiting.insert(key, first);
            }
        }
    }

    fn judge(&mut self, key: &InstrumentKey, since_ns: i64, first: FirstPrint, ledger: &mut Ledger) {
        if !ledger.late_join(&first.id, &first.code, since_ns, first.exchange_ns) {
            return;
        }
        let id = &first.id;
        // From the open: a stock's cumulative volume is 0 there; a futures or index stream's total at its open is not
        // known (a FUT session's first total carries the session before it).
        let total_before = (id.market == "STK").then_some(0.0);
        eprintln!("[market_runtime] late join {}:{}:{} {} {}: subscribed after the trading began, its first print at {} -- filled from the open",
                  key.source, id.market, first.code, id.trading_date, id.session, first.exchange_ns);
        self.ready.entry(key.source.clone()).or_default().push(json!({
            "cause": CAUSE_LATE_JOIN, "market": id.market, "code": first.code, "trading_date": id.trading_date, "session": id.session,
            "after_ns": 0, "volume_at_after": 0.0, "total_before": total_before, "since_ns": since_ns,
            "next_ns": first.exchange_ns, "next_total_before": first.total_before,
        }));
    }

    /// The gaps to answer `source`'s provider with, taken.
    pub fn take(&mut self, source: &str) -> Vec<Value> {
        self.ready.remove(&source.to_lowercase()).unwrap_or_default()
    }

    pub fn awaiting(&self) -> usize {
        self.awaiting.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{days_from_civil, wal_partition};

    const SECOND: i64 = 1_000_000_000;

    /// 2026-11-06 (a Friday) at Taipei `hh:mm`.
    fn taipei(hh: i64, mm: i64) -> i64 {
        (days_from_civil(2026, 11, 6) * 86_400 + (hh - 8) * 3_600 + mm * 60) * SECOND
    }

    fn event(market: &str, code: &str, ts: i64, payload: Value) -> MarketEvent {
        let (trading_date, session, _) = wal_partition("shioaji", market, ts).unwrap();
        serde_json::from_value(json!({"schema_version": 2, "symbol": format!("shioaji:{market}:{code}"), "provider": "shioaji",
            "market": market, "code": code, "session": session, "trading_date": trading_date, "generation": 1, "sequence": 1,
            "exchange_ts_ns": ts, "time_quality": "exchange", "payload": payload})).unwrap()
    }

    fn trade(total: f64, volume: f64) -> Value {
        json!({"kind": "trade", "price": 1000000, "volume": volume, "total_volume": total, "side": 1, "trade_id": "x", "minute": -1,
               "open": 0, "high": 0, "low": 0, "average": 0, "total_amount": 0.0, "amount": 0.0})
    }

    fn quote(total: f64, volume: f64) -> Value {
        json!({"kind": "quote", "current": 5000000, "open": 0, "high": 0, "low": 0, "total_volume": total, "total_amount": 0.0,
               "status": "live", "minute": -1, "average": 0, "volume": volume, "amount": 0.0})
    }

    fn joins() -> LateJoins {
        let mut joins = LateJoins::default();
        joins.set_fills_gaps("shioaji", true);
        joins
    }

    #[test]
    fn a_stock_subscribed_mid_session_is_filled_from_the_open_to_its_first_print() {
        let (mut joins, mut ledger) = (joins(), Ledger::default());
        let key = InstrumentKey::new("shioaji", "STK", "2330");
        joins.subscribed("shioaji", vec![(key.clone(), taipei(10, 0))], &mut ledger);
        let first = FirstPrint::of(&event("STK", "2330", taipei(10, 0) + SECOND, trade(15_000.0, 5.0))).unwrap();
        joins.first_print(key, first, &mut ledger);
        let gaps = joins.take("shioaji");
        assert_eq!(gaps.len(), 1);
        let gap = &gaps[0];
        assert_eq!(gap["cause"], "late_join");
        assert_eq!((gap["market"].as_str(), gap["session"].as_str(), gap["trading_date"].as_str()), (Some("STK"), Some("DAY"), Some("2026-11-06")));
        assert_eq!(gap["after_ns"], 0, "from the session's open");
        assert_eq!(gap["total_before"], 0.0, "a stock's count starts at 0");
        assert_eq!(gap["next_ns"], taipei(10, 0) + SECOND);
        assert_eq!(gap["next_total_before"], 14_995.0);
        assert!(joins.take("shioaji").is_empty(), "taken once");
    }

    #[test]
    fn an_index_and_a_futures_contract_join_late_the_same_way() {
        let (mut joins, mut ledger) = (joins(), Ledger::default());
        let index = InstrumentKey::new("shioaji", "IDX", "IX0028");
        let future = InstrumentKey::new("shioaji", "FUT", "TXFR1");
        joins.subscribed("shioaji", vec![(index.clone(), taipei(10, 30)), (future.clone(), taipei(10, 30))], &mut ledger);
        joins.first_print(index, FirstPrint::of(&event("IDX", "IX0028", taipei(10, 31), quote(0.0, 0.0))).unwrap(), &mut ledger);
        joins.first_print(future, FirstPrint::of(&event("FUT", "TXFR1", taipei(10, 31), quote(40_000.0, 3.0))).unwrap(), &mut ledger);
        let gaps = joins.take("shioaji");
        assert_eq!(gaps.len(), 2);
        let idx = gaps.iter().find(|g| g["market"] == "IDX").unwrap();
        assert!(idx["total_before"].is_null() && idx["next_total_before"].is_null(), "an index states no print volume");
        let fut = gaps.iter().find(|g| g["market"] == "FUT").unwrap();
        assert!(fut["total_before"].is_null(), "a FUT session's total at its open is not known");
        assert_eq!(fut["next_total_before"], 39_997.0);
    }

    #[test]
    fn a_subscription_before_the_open_is_no_late_join() {
        let (mut joins, mut ledger) = (joins(), Ledger::default());
        let key = InstrumentKey::new("shioaji", "STK", "2330");
        joins.subscribed("shioaji", vec![(key.clone(), taipei(8, 30))], &mut ledger);
        let first = FirstPrint::of(&event("STK", "2330", taipei(9, 0) + SECOND, trade(3_000.0, 3_000.0))).unwrap();
        joins.first_print(key, first, &mut ledger);
        assert!(joins.take("shioaji").is_empty());
    }

    #[test]
    fn a_first_print_ahead_of_its_subscription_report_waits_for_it() {
        let (mut joins, mut ledger) = (joins(), Ledger::default());
        let key = InstrumentKey::new("shioaji", "STK", "2603");
        let first = FirstPrint::of(&event("STK", "2603", taipei(11, 0), trade(9_000.0, 1.0))).unwrap();
        joins.first_print(key.clone(), first, &mut ledger);
        assert_eq!((joins.awaiting(), joins.take("shioaji").len()), (1, 0));
        joins.subscribed("shioaji", vec![(key, taipei(10, 59))], &mut ledger);
        assert_eq!((joins.awaiting(), joins.take("shioaji").len()), (0, 1));
    }

    #[test]
    fn a_provider_that_fills_no_gaps_is_never_asked() {
        let (mut joins, mut ledger) = (LateJoins::default(), Ledger::default());
        let key = InstrumentKey::new("shioaji", "STK", "2330");
        joins.subscribed("shioaji", vec![(key.clone(), taipei(10, 0))], &mut ledger);
        let first = FirstPrint::of(&event("STK", "2330", taipei(10, 1), trade(10.0, 1.0))).unwrap();
        joins.first_print(key, first, &mut ledger);
        assert_eq!((joins.awaiting(), joins.take("shioaji").len()), (0, 0));
    }

    #[test]
    fn a_backfill_print_or_a_trial_match_is_no_first_print() {
        let mut filled = event("STK", "2330", taipei(10, 1), trade(10.0, 1.0));
        filled.flags.backfill = true;
        assert!(FirstPrint::of(&filled).is_none());
        let mut trial = trade(10.0, 1.0);
        trial["simtrade"] = json!(true);
        assert!(FirstPrint::of(&event("STK", "2330", taipei(8, 50), trial)).is_none());
    }
}
