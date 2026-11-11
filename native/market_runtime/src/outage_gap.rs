//! Broker-connection outages: a connection of a provider that stopped delivering while the process kept running (the
//! Shioaji SDK reconnecting a session by itself, or the App logging in again; decisions.md 券商連線自己重連的空檔記在
//! 商品層). What the connection's codes printed meanwhile is filled from the broker's history by the path a provider
//! restart's gap takes (service/market/shioaji/restart_backfill.py), Market Runtime judging the gap as it does a
//! restart's:
//!
//! - its start: when the provider says the connection went down (`ingest.outage`), each code's newest stored print
//!   then (Engine::gap_starts), the moment nothing more of it can arrive. Taken at the outage's start, not its end:
//!   by its end the reconnected stream may have stored newer prints.
//! - its end: the code's first print after that start, seen as the stream applies it (or, when the code does not
//!   print again, its partition's close), stated to the provider like a late join's.
//! - whether it is filled at all: only when the outage's report (`ingest.loss` `broker_outage`, sent once the
//!   connection is back) touched the trading of the code's partition, which is when the outage is kept in the
//!   partition's evidence ([`Ledger::outage_backfill_requested`]). One outside trading fetches nothing.
//!
//! A partition the outage reached that began after it started (an outage across a session's open) is filled from its
//! open. The gaps go back to the provider in the answer to its next ingest command (`ingest.loss.ack`,
//! `event.ack.batch` `gaps`). Kept in memory only: an outage whose start a restart of Market Runtime lost stays a
//! hole in its codes (logged when its report arrives).

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::event::InstrumentKey;
use crate::evidence::{Ledger, LossReport, PartitionId, CAUSE_OUTAGE};
use crate::late_join::FirstPrint;
use crate::state::GapStart;

/// One code of a connection that went down: where its gap starts, and the first prints seen after it, per partition.
#[derive(Debug, Clone)]
struct Watch {
    start: GapStart,
    next: BTreeMap<PartitionId, FirstPrint>,
}

impl Watch {
    fn partition(&self, source: &str) -> PartitionId {
        PartitionId { source: source.to_owned(), market: self.start.market.clone(), trading_date: self.start.trading_date.clone(),
            session: self.start.session.clone() }
    }
}

#[derive(Debug, Default)]
struct Down {
    from_ns: i64,
    codes: BTreeMap<InstrumentKey, Watch>,
}

/// A gap the outage's report confirmed, waiting for its end (its first print after the start, or its close).
#[derive(Debug, Clone)]
struct Confirmed {
    key: InstrumentKey,
    id: PartitionId,
    connection: String,
    to_ns: i64,
    start: GapStart,
}

#[derive(Debug, Default)]
pub struct OutageGaps {
    /// Per (source, connection): the connection that went down and its codes.
    down: BTreeMap<(String, String), Down>,
    confirmed: Vec<Confirmed>,
    /// The gaps to answer each source's provider with.
    ready: BTreeMap<String, Vec<Value>>,
}

fn open_start(id: &PartitionId, code: &str) -> GapStart {
    GapStart { market: id.market.clone(), code: code.to_owned(), trading_date: id.trading_date.clone(), session: id.session.clone(),
        after_ns: 0, volume_at_after: 0.0, total_before: (id.market == "STK").then_some(0.0) }
}

impl OutageGaps {
    /// `connection` of `source` went down at `from_ns` (the provider's clock): `starts` are its stored codes' gap starts
    /// now. The same connection reported down again before its end keeps its first start and adds the codes it did not
    /// hold.
    pub fn began(&mut self, source: &str, connection: &str, from_ns: i64, starts: Vec<GapStart>) {
        let source = source.to_lowercase();
        let down = self.down.entry((source.clone(), connection.to_owned())).or_insert_with(|| Down { from_ns, ..Down::default() });
        down.from_ns = down.from_ns.min(from_ns);
        for start in starts {
            let key = InstrumentKey::new(&source, &start.market, &start.code);
            down.codes.entry(key).or_insert(Watch { start, next: BTreeMap::new() });
        }
    }

    /// Whether any code waits for its first print after an outage.
    pub fn watching(&self) -> bool {
        !self.confirmed.is_empty() || self.down.values().any(|down| !down.codes.is_empty())
    }

    /// A print of `key` the stream applied (`FirstPrint::of`: a real trade, a futures quote with its own volume, an
    /// index's priced quote; never a backfill): the first after a gap's start ends it.
    pub fn print(&mut self, key: &InstrumentKey, first: &FirstPrint) {
        for ((source, _), down) in self.down.iter_mut() {
            let Some(watch) = down.codes.get_mut(key) else { continue };
            let after = if first.id == watch.partition(source) { watch.start.after_ns } else { 0 };
            if first.exchange_ns > after {
                watch.next.entry(first.id.clone()).or_insert_with(|| first.clone());
            }
        }
        let mut index = 0;
        while index < self.confirmed.len() {
            let gap = &self.confirmed[index];
            if gap.key == *key && gap.id == first.id && first.exchange_ns > gap.start.after_ns {
                let gap = self.confirmed.remove(index);
                self.answer(&gap, Some(first));
            } else {
                index += 1;
            }
        }
    }

    /// The outage's report for one code: `written` are the partitions it was kept in (its end touched their trading).
    /// Each is asked to be filled from the code's start there, answered once its end is known.
    pub fn ended(&mut self, source: &str, report: &LossReport, written: &[PartitionId], ledger: &mut Ledger) {
        let source = source.to_lowercase();
        let key = InstrumentKey::new(&source, &report.market, &report.code);
        let slot = (source.clone(), report.connection.clone());
        let watch = self.down.get_mut(&slot).and_then(|down| down.codes.remove(&key));
        if self.down.get(&slot).is_some_and(|down| down.codes.is_empty()) {
            self.down.remove(&slot);
        }
        if written.is_empty() {
            return; // not an error: the outage touched no trading of the code, so nothing of it is missing
        }
        let Some(watch) = watch else {
            // not an error: no start was recorded for it (this process started after the connection went down, or the
            // code was not stored then): its hole stays in the partition's gap codes
            eprintln!("[market_runtime] outage of {source} {} ({}:{}) has no recorded start: left as a gap", report.connection,
                      report.market, report.code);
            return;
        };
        let own = watch.partition(&source);
        for id in written {
            if !ledger.outage_backfill_requested(id, &report.connection, report.to_ns, &key.code) {
                continue;
            }
            let start = if *id == own { watch.start.clone() } else { open_start(id, &key.code) };
            let gap = Confirmed { key: key.clone(), id: id.clone(), connection: report.connection.clone(), to_ns: report.to_ns, start };
            eprintln!("[market_runtime] outage of {source} {} {}:{} {} {}: filled from {}", report.connection, id.market, key.code,
                      id.trading_date, id.session, gap.start.after_ns);
            match watch.next.get(id) {
                Some(first) => self.answer(&gap, Some(first)),
                None => self.confirmed.push(gap),
            }
        }
    }

    /// Gaps still waiting for a print whose partition's trading is over: they end at its close.
    pub fn due(&mut self, ledger: &Ledger, now_ns: i64) {
        let mut index = 0;
        while index < self.confirmed.len() {
            let gap = &self.confirmed[index];
            if ledger.trades_after(&gap.id, now_ns) {
                index += 1;
            } else {
                let gap = self.confirmed.remove(index);
                self.answer(&gap, None);
            }
        }
    }

    fn answer(&mut self, gap: &Confirmed, next: Option<&FirstPrint>) {
        let mut wire = json!(gap.start);
        wire["cause"] = json!(CAUSE_OUTAGE);
        wire["connection"] = json!(gap.connection);
        wire["outage_to_ns"] = json!(gap.to_ns);
        wire["next_ns"] = json!(next.map(|n| n.exchange_ns));
        wire["next_total_before"] = json!(next.and_then(|n| n.total_before));
        self.ready.entry(gap.key.source.clone()).or_default().push(wire);
    }

    /// The gaps to answer `source`'s provider with, taken.
    pub fn take(&mut self, source: &str) -> Vec<Value> {
        self.ready.remove(&source.to_lowercase()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{days_from_civil, wal_partition, MarketEvent};
    use crate::evidence::{Ledger, FILL_FILLED, LOSS_BROKER_OUTAGE};

    const SECOND: i64 = 1_000_000_000;

    /// 2026-11-06 (a Friday) at Taipei `hh:mm`.
    fn taipei(hh: i64, mm: i64) -> i64 {
        (days_from_civil(2026, 11, 6) * 86_400 + (hh - 8) * 3_600 + mm * 60) * SECOND
    }

    fn trade(code: &str, ts: i64, total: f64, volume: f64) -> MarketEvent {
        let (trading_date, session, _) = wal_partition("shioaji", "STK", ts).unwrap();
        serde_json::from_value(json!({"schema_version": 2, "symbol": format!("shioaji:STK:{code}"), "provider": "shioaji",
            "market": "STK", "code": code, "session": session, "trading_date": trading_date, "generation": 1, "sequence": 1,
            "exchange_ts_ns": ts, "time_quality": "exchange", "payload": {"kind": "trade", "price": 1000000, "volume": volume,
            "total_volume": total, "side": 1, "trade_id": "x", "minute": -1, "open": 0, "high": 0, "low": 0, "average": 0,
            "total_amount": 0.0, "amount": 0.0}})).unwrap()
    }

    fn stk() -> PartitionId {
        PartitionId { source: "shioaji".into(), market: "STK".into(), trading_date: "2026-11-06".into(), session: "DAY".into() }
    }

    fn start(code: &str, after_ns: i64, total: f64) -> GapStart {
        GapStart { market: "STK".into(), code: code.into(), trading_date: "2026-11-06".into(), session: "DAY".into(), after_ns,
            volume_at_after: 2.0, total_before: Some(total) }
    }

    fn report(code: &str, from_ns: i64, to_ns: i64) -> LossReport {
        serde_json::from_value(json!({"market": "STK", "code": code, "from_ns": from_ns, "to_ns": to_ns, "reason": LOSS_BROKER_OUTAGE,
            "connection": "connection 2"})).unwrap()
    }

    /// The ledger with the outage kept, as cmd_loss folds the report's loss record.
    fn ledger_with_outage(code: &str, from_ns: i64, to_ns: i64) -> Ledger {
        let mut ledger = Ledger::default();
        ledger.fold(&trade(code, taipei(9, 0), 10.0, 10.0), true);
        let template = trade(code, taipei(9, 0), 0.0, 0.0);
        for record in ledger.loss_records("shioaji", &report(code, from_ns, to_ns), &|_| true, &template) {
            ledger.fold(&record, true);
        }
        ledger
    }

    #[test]
    fn a_stock_on_a_dropped_connection_is_filled_from_its_last_print_to_its_first_after_the_reconnect() {
        let (down, up) = (taipei(10, 0), taipei(10, 2));
        let mut ledger = ledger_with_outage("2330", down, up);
        assert_eq!(ledger.row(&stk()).unwrap().gap_codes(), vec!["2330".to_string()]);
        let mut gaps = OutageGaps::default();
        gaps.began("shioaji", "connection 2", down, vec![start("2330", taipei(9, 59), 1200.0)]);
        // The reconnected stream's first print reaches Market Runtime before the outage's report.
        let first = trade("2330", taipei(10, 2) + SECOND, 1250.0, 5.0);
        gaps.print(&first.instrument(), &FirstPrint::of(&first).unwrap());
        gaps.ended("shioaji", &report("2330", down, up), &[stk()], &mut ledger);
        let answered = gaps.take("shioaji");
        assert_eq!(answered.len(), 1, "{answered:?}");
        let gap = &answered[0];
        assert_eq!(gap["cause"], "outage");
        assert_eq!(gap["after_ns"], taipei(9, 59));
        assert_eq!(gap["total_before"], 1200.0);
        assert_eq!(gap["next_ns"], taipei(10, 2) + SECOND);
        assert_eq!(gap["next_total_before"], 1245.0);
        assert_eq!(gap["connection"], "connection 2");
        assert_eq!(gap["outage_to_ns"], up);
        assert!(!gaps.watching());

        // Its fill, reported and verified, takes the code out of the gap codes: repaired, no longer a hole.
        let fill: crate::evidence::FillReport = serde_json::from_value(json!({"market": "STK", "code": "2330", "trading_date": "2026-11-06",
            "session": "DAY", "cause": "outage", "connection": "connection 2", "outage_to_ns": up, "outcome": "stored",
            "end": "first_live_print", "prints": 3, "volume": 45.0, "total_before": 1200.0, "next_total_before": 1245.0})).unwrap();
        assert!(ledger.backfill_reported("shioaji", &fill));
        let row = ledger.row(&stk()).unwrap();
        assert_eq!(row.outage_fills[0].backfill["2330"].state, FILL_FILLED);
        assert!(row.gap_codes().is_empty());
        assert_eq!(row.repaired_codes(), vec!["2330".to_string()]);
    }

    #[test]
    fn a_gap_whose_print_comes_after_the_report_is_answered_then_and_one_that_never_prints_at_the_close() {
        let (down, up) = (taipei(13, 20), taipei(13, 21));
        let mut ledger = ledger_with_outage("2330", down, up);
        let template = trade("2603", taipei(9, 0), 0.0, 0.0);
        ledger.fold(&trade("2603", taipei(9, 0), 10.0, 10.0), true);
        for record in ledger.loss_records("shioaji", &report("2603", down, up), &|_| true, &template) {
            ledger.fold(&record, true);
        }
        let mut gaps = OutageGaps::default();
        gaps.began("shioaji", "connection 2", down, vec![start("2330", taipei(13, 19), 1200.0), start("2603", taipei(13, 18), 50.0)]);
        gaps.ended("shioaji", &report("2330", down, up), &[stk()], &mut ledger);
        gaps.ended("shioaji", &report("2603", down, up), &[stk()], &mut ledger);
        assert!(gaps.take("shioaji").is_empty(), "no end known yet");
        let first = trade("2330", taipei(13, 22), 1300.0, 1.0);
        gaps.print(&first.instrument(), &FirstPrint::of(&first).unwrap());
        let answered = gaps.take("shioaji");
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0]["code"], "2330");
        assert_eq!(answered[0]["next_total_before"], 1299.0);
        gaps.due(&ledger, taipei(13, 25));
        assert!(gaps.take("shioaji").is_empty(), "13:33 and 14:30 still print");
        gaps.due(&ledger, taipei(14, 40));
        let answered = gaps.take("shioaji");
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0]["code"], "2603");
        assert!(answered[0]["next_ns"].is_null(), "ends at the close");
    }

    #[test]
    fn an_outage_outside_trading_fetches_nothing() {
        let mut ledger = Ledger::default();
        let mut gaps = OutageGaps::default();
        gaps.began("shioaji", "connection 2", taipei(7, 0), vec![start("2330", 0, 0.0)]);
        gaps.ended("shioaji", &report("2330", taipei(7, 0), taipei(7, 1)), &[], &mut ledger);
        assert!(gaps.take("shioaji").is_empty());
        assert!(!gaps.watching());
    }
}
