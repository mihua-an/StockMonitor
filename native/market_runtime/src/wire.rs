//! UI wire shapes for snapshots and deltas (docs/system-architecture/01 sections 7-9, 03 section 3).
//!
//! Blocks keep their own cut-off: the quote/tape/book come from Rust A's latest state at `version`, the minute,
//! window, day, flow and event blocks are Rust B's results at their own input watermark, signals are the
//! producer's. Nothing waits for the others. Money is sent as decimal numbers derived from the 1e4 fixed point;
//! epoch nanoseconds travel as strings (they do not fit a JavaScript Number). Volumes are decimal quantities, written by
//! crate::volume::wire (whole values as integers, no binary noise), and every summary names their `volume_unit`.

use crate::event::{minute_timestamp, InstrumentKey, PRICE_SCALE};
use crate::projection::{ProjectionCache, ProjectionEntry};
use crate::state::{Book, SymbolState};
use crate::trade_pages::{row as trade_row, RowContext};
use crate::volume::{wire as vol, wire_opt as vol_opt};
use serde_json::{json, Map, Value};

pub fn money(units: i64) -> f64 {
    units as f64 / PRICE_SCALE as f64
}

fn opt_money(v: Option<i64>) -> Value {
    v.map(|x| json!(money(x))).unwrap_or(Value::Null)
}

/// The index whose view shows the combined STK+OTC breadth.
pub fn breadth_index() -> InstrumentKey {
    InstrumentKey::new("shioaji", "IDX", "TAIEX")
}

pub fn summary(state: &SymbolState, breadth: Option<&Value>) -> Value {
    let (change, change_pct) = match state.change() {
        Some((c, p)) => (json!(money(c)), json!(p)),
        None => (Value::Null, Value::Null),
    };
    let q = &state.quote;
    let r = &state.reference;
    // 振幅: the day's range against the price 漲跌 is measured from, in percent.
    let amplitude = match (q.high, q.low, r.comparison_price()) {
        (Some(high), Some(low), Some(base)) if high > 0 && low > 0 && base > 0 => json!((high - low) as f64 / base as f64 * 100.0),
        _ => Value::Null,
    };
    let mut out = json!({
        "current": opt_money(q.current), "prev_close": opt_money(r.prev_close), "reference_price": opt_money(r.comparison_price()),
        "open": opt_money(q.open), "high": opt_money(q.high), "low": opt_money(q.low),
        "change": change, "change_pct": change_pct, "change_pct_unit": "percent", "amplitude": amplitude,
        "total_volume": vol_opt(q.total_volume), "prev_volume": vol_opt(r.prev_volume), "total_amount": q.total_amount, "average": opt_money(q.average),
        "status": q.status, "indicative_price": opt_money(q.indicative_price),
        "limit_up": opt_money(r.limit_up), "limit_down": opt_money(r.limit_down), "name": r.name,
        "reference_source": r.reference_source,
        "advance_count": q.advance_count, "decline_count": q.decline_count, "flat_count": q.flat_count,
        "limit_up_count": q.limit_up_count, "limit_down_count": q.limit_down_count,
        "volume_unit": crate::volume::unit(&state.key.instrument.source, &state.key.instrument.market),
        "price_minute": q.price_minute, "price_exchange_ts_ns": q.price_exchange_ts_ns.to_string(),
        "source_gaps": state.source_gaps,
    });
    // The index view shows the ONE combined STK+OTC breadth figure, never a single exchange's own counts.
    if let (Some(b), true) = (breadth, state.key.instrument == breadth_index()) {
        if let Some(obj) = out.as_object_mut() {
            obj.insert("advance_count".into(), b.get("advance").cloned().unwrap_or(Value::Null));
            obj.insert("decline_count".into(), b.get("decline").cloned().unwrap_or(Value::Null));
            obj.insert("flat_count".into(), b.get("flat").cloned().unwrap_or(Value::Null));
            obj.insert("breadth".into(), b.clone());
        }
    }
    out
}

/// The view's tape: every print it holds as the one tape row (trade_pages::row), measured against its session's
/// comparison price.
pub fn trades(state: &SymbolState) -> Vec<Value> {
    let ctx = RowContext::of_state(state);
    state.recent_trades.iter().map(|t| trade_row(t, &ctx)).collect()
}

/// The print the state's last applied event put on its tape, as the one tape row (the trade frame): stamped with the
/// state's version when it was inserted, which may be anywhere in exchange-time order (a gap filled afterwards).
pub fn applied_trade(state: &SymbolState) -> Value {
    state.recent_trades.iter().rev().find(|t| t.version == state.version)
        .map_or(Value::Null, |t| trade_row(t, &RowContext::of_state(state)))
}

pub fn book(b: &Book) -> Value {
    json!({"bids": b.bids.iter().map(|l| json!({"price": money(l.price), "volume": vol(l.volume)})).collect::<Vec<_>>(),
        "asks": b.asks.iter().map(|l| json!({"price": money(l.price), "volume": vol(l.volume)})).collect::<Vec<_>>(),
        "bid_prices": b.bids.iter().map(|l| money(l.price)).collect::<Vec<_>>(),
        "bid_volumes": b.bids.iter().map(|l| vol(l.volume)).collect::<Vec<_>>(),
        "ask_prices": b.asks.iter().map(|l| money(l.price)).collect::<Vec<_>>(),
        "ask_volumes": b.asks.iter().map(|l| vol(l.volume)).collect::<Vec<_>>(),
        // Level change (source figure, or derived from the previous book); null where nothing is known.
        "diff_bid_vol": b.bids.iter().map(|l| vol_opt(l.diff)).collect::<Vec<_>>(),
        "diff_ask_vol": b.asks.iter().map(|l| vol_opt(l.diff)).collect::<Vec<_>>(),
        "exchange_ts_ns": b.exchange_ts_ns.to_string(), "arrival_ns": b.received_ns.to_string()})
}

/// The trend point Rust A overlays for the current minute: the latest valid price, never a claimed volume.
pub fn current_point(state: &SymbolState, entry: Option<&ProjectionEntry>) -> Value {
    let (Some(price), Some(minute)) = (state.quote.current, state.quote.price_minute) else { return Value::Null };
    let key = &state.key;
    let b_minute = entry.and_then(|e| e.minutes.get(&minute));
    if let Some(record) = b_minute {
        if record.get("state").and_then(Value::as_str) == Some("FINALIZED") {
            // B already fixed this minute: its close is authoritative; do not overwrite it with a quote.
            return trend_point(record, &key.instrument, &key.session.trading_date);
        }
    }
    let mut point = b_minute.map(|r| trend_point(r, &key.instrument, &key.session.trading_date)).unwrap_or_else(|| {
        let ts = minute_timestamp(&key.instrument.market, &key.session.trading_date, minute);
        json!({"minute": minute, "time": clock_label(minute), "timestamp": ts, "minute_timestamp": ts,
               "volume": Value::Null, "minute_volume": Value::Null})
    });
    if let Some(obj) = point.as_object_mut() {
        let p = money(price);
        obj.insert("close".into(), json!(p));
        obj.insert("price".into(), json!(p));
        obj.insert("forming".into(), json!(true));
        obj.insert("state".into(), json!("FORMING"));
        obj.insert("price_source".into(), json!("market_runtime"));
        // 均價 of the forming minute: the quote's running average is the newest; without one B's stays.
        if let Some(a) = state.quote.average {
            obj.insert("average_price".into(), json!(money(a)));
        }
        for f in ["high", "low", "open"] {
            let merged = match (obj.get(f).and_then(Value::as_f64), f) {
                (Some(v), "high") => json!(v.max(p)),
                (Some(v), "low") => json!(v.min(p)),
                (Some(v), _) => json!(v),
                (None, _) => json!(p),
            };
            obj.insert(f.into(), merged);
        }
    }
    point
}

/// The wall-clock HH:MM of a session minute. A night session counts its minutes on from its trading day's midnight
/// (04:23 the next morning is minute 1703), so the label wraps at 24 hours: "04:23", never "28:23".
pub fn clock_label(minute: i32) -> String {
    let clock = minute.rem_euclid(24 * 60);
    format!("{:02}:{:02}", clock / 60, clock % 60)
}

/// Map one Rust B minute record to the renderer's trend-point vocabulary (B records already carry most fields).
pub fn trend_point(record: &Value, instrument: &InstrumentKey, trading_date: &str) -> Value {
    let mut point = record.clone();
    if let Some(obj) = point.as_object_mut() {
        let minute = obj.get("minute").and_then(Value::as_i64).unwrap_or(0) as i32;
        if !obj.contains_key("timestamp") {
            let ts = minute_timestamp(&instrument.market, trading_date, minute);
            obj.insert("timestamp".into(), json!(ts.clone()));
            obj.insert("minute_timestamp".into(), json!(ts));
        }
        obj.entry("time").or_insert_with(|| json!(clock_label(minute)));
        if let Some(close) = obj.get("close").cloned() {
            obj.entry("price").or_insert(close);
        }
        if let Some(v) = obj.get("volume").cloned() {
            obj.entry("minute_volume").or_insert(v);
        }
    }
    point
}

pub fn trend(state: Option<&SymbolState>, entry: Option<&ProjectionEntry>, instrument: &InstrumentKey, trading_date: &str) -> Vec<Value> {
    let mut points: Vec<Value> = entry
        .map(|e| e.minutes.values().map(|r| trend_point(r, instrument, trading_date)).collect())
        .unwrap_or_default();
    if let Some(state) = state {
        let point = current_point(state, entry);
        if let Some(minute) = point.get("minute").and_then(Value::as_i64) {
            points.retain(|p| p.get("minute").and_then(Value::as_i64) != Some(minute));
            points.push(point);
            points.sort_by_key(|p| p.get("minute").and_then(Value::as_i64).unwrap_or(0));
        }
    }
    points
}

pub struct Identity<'a> {
    pub stream_id: &'a str,
    pub durable_stream_id: &'a str,
    pub runtime_epoch: u64,
}

pub fn snapshot(id: &Identity, instrument: &InstrumentKey, trading_date: &str, session: &str, state: Option<&SymbolState>,
                entry: Option<&ProjectionEntry>, breadth: Option<&Value>, view_sequence: u64,
                committed: u64, demand_state: Value, subscription_id: Value) -> Value {
    let e = entry;
    let signals = e.and_then(|e| e.signals.clone()).map(Value::Object).unwrap_or(Value::Null);
    json!({
        "subscription_id": subscription_id,
        "symbol": instrument.wire(), "source": instrument.source, "market": instrument.market, "code": instrument.code,
        "trading_date": trading_date, "session": session,
        "volume_unit": crate::volume::unit(&instrument.source, &instrument.market),
        "stream_id": id.stream_id, "daemon_instance_id": id.stream_id, "durable_stream_id": id.durable_stream_id,
        "runtime_epoch": id.runtime_epoch,
        "generation": state.map(|s| s.generation).unwrap_or(0),
        "sequence": view_sequence, "watermark": view_sequence,
        "state_version": state.map(|s| s.version).unwrap_or(0),
        "durable_watermark": committed,
        "summary": state.map(|s| summary(s, breadth)).unwrap_or_else(|| json!({})),
        "trades": state.map(trades).unwrap_or_default(),
        "orderbook": state.map(|s| book(&s.book)).unwrap_or_else(|| json!({})),
        "trend": trend(state, e, instrument, trading_date),
        "minutes": e.map(ProjectionCache::minutes_wire).unwrap_or_default(),
        "windows": e.map(|e| e.windows.clone()).unwrap_or(Value::Null),
        "day": e.map(|e| e.day.clone()).unwrap_or(Value::Null),
        "tradeflow": e.map(|e| e.flow.clone()).filter(|v| !v.is_null()).unwrap_or_else(|| json!({})),
        "price_volume": e.and_then(|e| e.day.get("price_volume").cloned()).unwrap_or_else(|| json!({})),
        "signals": signals,
        "events": e.map(|e| e.events.iter().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        "coverage": coverage(state, e),
        "channel_arrival_us": state.map(arrivals).unwrap_or(Value::Null),
        "meta": {
            "state_versions": state.map(|s| json!(s.block_versions)).unwrap_or(Value::Null),
            "projection": ProjectionCache::meta_wire(e),
            "demand": demand_state,
            "latest_durable_sequence": state.map(|s| s.last_durable_sequence),
        },
    })
}

/// `minutes` (B's raw minute records) duplicates `trend` (~270 KB of a ~680 KB stock snapshot) and no subscribed client
/// reads it: a subscription gets it only by asking for the `minutes` channel. Every product-list row subscribes,
/// so returning to the live page re-sent ~50 MB and froze the renderer. One-shot reads (no channels)
/// keep the full payload.
pub fn trim_to_channels(payload: &mut Value, channels: &[String]) {
    if channels.is_empty() || channels.iter().any(|c| c == "minutes") {
        return;
    }
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("minutes");
    }
}

#[cfg(test)]
mod trim_tests {
    use super::*;

    #[test]
    fn a_night_minute_after_midnight_is_labelled_with_the_clock() {
        assert_eq!(clock_label(15 * 60), "15:00");
        assert_eq!(clock_label(28 * 60 + 23), "04:23");
        assert_eq!(clock_label(29 * 60), "05:00");
        let point = trend_point(&json!({"minute": 28 * 60 + 23, "close": 1.0}),
                                &InstrumentKey::parse("shioaji:FUT:TXFR1").unwrap(), "2026-10-15");
        assert_eq!(point["time"], "04:23");
    }

    #[test]
    fn a_subscription_gets_minutes_only_by_asking_and_a_one_shot_read_keeps_everything() {
        let full = json!({"summary": {}, "trend": [1], "minutes": [1]});
        let mut view = full.clone();
        trim_to_channels(&mut view, &["summary".into(), "trend".into()]);
        assert!(view.get("minutes").is_none() && view.get("trend").is_some());
        let mut asked = full.clone();
        trim_to_channels(&mut asked, &["minutes".into()]);
        assert!(asked.get("minutes").is_some());
        let mut one_shot = full.clone();
        trim_to_channels(&mut one_shot, &[]);
        assert_eq!(one_shot, full);
    }
}

pub fn coverage(state: Option<&SymbolState>, entry: Option<&ProjectionEntry>) -> Value {
    json!({
        "quote": state.is_some_and(|s| s.quote.current.is_some()),
        "recent_trades": state.is_some_and(|s| !s.recent_trades.is_empty()),
        "orderbook": state.is_some_and(|s| !s.book.bids.is_empty() || !s.book.asks.is_empty()),
        "trend": entry.is_some_and(|e| !e.minutes.is_empty()) || state.is_some_and(|s| s.quote.current.is_some()),
        "minutes": entry.is_some_and(|e| !e.minutes.is_empty()),
        "trade_flow": entry.is_some_and(|e| !e.flow.is_null()),
        "price_levels": entry.is_some_and(|e| e.day.get("price_volume").is_some_and(|p| p.get("buckets").is_some())),
        "signals": entry.is_some_and(|e| e.signals.is_some()),
        "events": entry.is_some_and(|e| !e.events.is_empty()),
    })
}

pub fn arrivals(state: &SymbolState) -> Value {
    json!({"summary": state.arrivals.summary_us, "trades": state.arrivals.trades_us, "orderbook": state.arrivals.orderbook_us,
           "trend": state.arrivals.summary_us, "resolution": "epoch_microseconds"})
}

/// Envelope shared by every delta for one state: identity, the per-state contiguous view sequence, and the trace
/// the renderer echoes back for UI latency.
pub fn delta(id: &Identity, state_key: &crate::event::StateKey, generation: u64, view_sequence: u64, delta_type: &str,
             channels: &[&str], payload: Value, extra: Map<String, Value>) -> Value {
    let instrument = &state_key.instrument;
    let mut out = json!({
        "symbol": instrument.wire(), "source": instrument.source, "market": instrument.market, "code": instrument.code,
        "trading_date": state_key.session.trading_date, "session": state_key.session.session,
        "stream_id": id.stream_id, "daemon_instance_id": id.stream_id, "runtime_epoch": id.runtime_epoch,
        "generation": generation, "sequence": view_sequence, "watermark": view_sequence,
        "delta_type": delta_type, "channels": channels, "payload": payload,
    });
    if let Some(obj) = out.as_object_mut() {
        obj.extend(extra);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{SessionKey, StateKey};
    use crate::projection::ProjectionCache;

    #[test]
    fn a_finalized_b_minute_is_never_overwritten_by_a_quote_and_a_forming_one_takes_the_latest_price() {
        let key = StateKey { instrument: InstrumentKey::new("shioaji", "STK", "2330"), session: SessionKey { trading_date: "2026-09-29".into(), session: "DAY".into() } };
        let mut cache = ProjectionCache::default();
        let item = json!({"block": "minutes", "input_watermark": 1, "revision": 1, "data": {"minutes": [
            {"minute": 570, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 10, "state": "FINALIZED", "revision": 1},
            {"minute": 571, "open": 100.5, "high": 100.8, "low": 100.2, "close": 100.6, "average_price": 100.4, "volume": 4, "state": "FORMING", "revision": 1}]}});
        cache.publish(crate::projection::PublishRequest::from_item(key.clone(), 1, &item).unwrap(), 10, 1);
        let entry = cache.entry(&key);
        let mut engine = crate::state::Engine::default();
        let mut ev = crate::state::tests_support::trade_event("2330", 1, 1_012_000);
        ev.payload = match ev.payload { crate::event::Payload::Trade { .. } => crate::event::Payload::Trade {
            price: 1_012_000, volume: 1.0, total_volume: 1.0, side: 1, trade_id: "1".into(), minute: 571,
            open: 0, high: 0, low: 0, average: 0, total_amount: 0.0, amount: 0.0, simtrade: false, bid_side_total_vol: None, ask_side_total_vol: None, auction: false, after_hours: false, condition: None, no_last_sale: false }, p => p };
        engine.apply(&ev);
        let state = engine.state(&key).unwrap();
        let points = trend(Some(state), entry, &key.instrument, "2026-09-29");
        assert_eq!(points[1]["average_price"], 100.4, "no quote average yet: the forming minute keeps B's 均價");
        assert_eq!(points.len(), 2);
        assert_eq!(points[0]["close"], 100.5, "finalized minute keeps B's close");
        assert_eq!(points[1]["close"], 101.2, "forming minute shows A's latest price");
        assert_eq!(points[1]["high"], 101.2);
        assert_eq!(points[1]["volume"], 4, "volume stays B's; A never claims one");
        let mut ev2 = crate::state::tests_support::trade_event("2330", 2, 1_013_000);
        ev2.payload = match ev2.payload { crate::event::Payload::Trade { .. } => crate::event::Payload::Trade {
            price: 1_013_000, volume: 1.0, total_volume: 2.0, side: 1, trade_id: "2".into(), minute: 571,
            open: 0, high: 0, low: 0, average: 1_005_000, total_amount: 0.0, amount: 0.0, simtrade: false, bid_side_total_vol: None, ask_side_total_vol: None, auction: false, after_hours: false, condition: None, no_last_sale: false }, p => p };
        engine.apply(&ev2);
        let state = engine.state(&key).unwrap();
        let with_average = trend(Some(state), entry, &key.instrument, "2026-09-29");
        assert_eq!(with_average[1]["average_price"], 100.5, "the quote's newer running average is the forming minute's 均價");
    }
}
