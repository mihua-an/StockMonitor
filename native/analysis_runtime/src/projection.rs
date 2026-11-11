//! Rust B's projection of an instrument: the minute, window, day and flow blocks it publishes to Market Runtime, and
//! the large-order lists. Read-only over the accumulated state (accum.rs); nothing here changes it.

use crate::accum::*;
use market_runtime::calendar::{Calendar, Segment};
use crate::rules::RuleSet;
use market_runtime::event::{market_local_minute, partition_local_minute};
use market_runtime::volume::{self as vol, Volume};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// A flow's large and small buy / sell / net, as the trade-flow panel's 累計 reads it.
fn cumulative_wire(flow: &Flow) -> Value {
    let side = |b: &SideBucket| json!({"buy": vol::wire(b.buy), "sell": vol::wire(b.sell), "net": vol::wire(b.buy - b.sell)});
    json!({"small": side(&flow.small), "large": side(&flow.large)})
}

/// 分時's buckets, B's one session rule for them: the whole span so far (`all`), then each clock hour of the session
/// that traded -- the first from the session's open, the last to its close (`opens_session` / `closes_session`), so a
/// 09:00-13:30 day is 開盤~10:00 ... 13:00~收盤 and a 08:45 open starts with its quarter hour. Minutes are inclusive,
/// on the session's axis (session_frame; each part comes with its shift onto it), as the large-order query takes them. Each bucket's large buy / sell share is of that bucket's
/// own volume (every class, unclassified included); a bucket without volume is not listed.
fn hour_buckets(parts: &[(&Segment, i32, &[(i32, &Minute)])]) -> Vec<Value> {
    let (Some((first, first_shift, _)), Some((last, last_shift, _))) = (parts.first(), parts.last()) else { return Vec::new() };
    let (open, close) = (first.start + first_shift, last.end + last_shift);
    let mut all = Flow::default();
    let mut hours: Vec<(i32, i32, Flow)> = Vec::new();
    for (seg, shift, rows) in parts {
        for (k, r) in rows.iter() {
            all.merge(&r.flow);
            let k = k + shift;
            let from = (k.div_euclid(60) * 60).max(seg.start + shift);
            match hours.last_mut() {
                Some((start, _, flow)) if *start == from => flow.merge(&r.flow),
                _ => hours.push((from, (k.div_euclid(60) * 60 + 59).min(seg.end + shift), r.flow.clone())),
            }
        }
    }
    let bucket = |key: String, from: i32, to: i32, flow: &Flow| {
        let total = flow.total();
        vol::positive(total).map(|_| json!({"key": key, "from_minute": from, "to_minute": to, "opens_session": from == open, "closes_session": to == close,
            "large": {"buy": vol::wire(flow.large.buy), "sell": vol::wire(flow.large.sell)}, "total": vol::wire(total),
            "buy_ratio": ratio(flow.large.buy, total), "sell_ratio": ratio(flow.large.sell, total), "ratio_unit": "decimal_ratio"}))
    };
    bucket("all".into(), open, close, &all).into_iter()
        .chain(hours.iter().filter_map(|(from, to, flow)| bucket(format!("m{from}"), *from, *to, flow)))
        .collect()
}

/// The flow chart's frame, B's session calendar the one owner of it: the business session's name and its first and
/// last trading minute (inclusive minute starts). A session continuing from the previous partition opens there, before
/// this partition's 0 (its open is that segment's start - 1440), on the same axis as the series' `minute`.
fn session_frame(wire: &mut Value, cal: &Calendar, key: market_runtime::calendar::CalKey<'_>, seg: &Segment) {
    let open = cal.previous_day_segment(key, seg).map_or(seg.start, |ps| ps.start - 1440);
    wire["session"] = json!(seg.name);
    wire["session_open_minute"] = json!(open);
    wire["session_close_minute"] = json!(seg.end);
}

impl Instrument {
    fn rule_id<'a>(&self, rules: &'a RuleSet) -> Option<&'a str> {
        rules.flow_rule(&self.id.source, &self.id.market, &self.id.code).map(|r| r.rule_id.as_str())
    }

    /// Session-cumulative volume through each minute, and whether every earlier minute's volume was known.
    fn cumulative(&self, segment: &Segment) -> BTreeMap<i32, (Volume, bool)> {
        let mut out = BTreeMap::new();
        let (mut total, mut complete) = (0.0, true);
        for (k, m) in self.minutes.range(segment.start..=segment.end) {
            match m.volume {
                Some(v) => total += v,
                None => complete = false,
            }
            out.insert(*k, (total, complete));
        }
        out
    }

    pub fn minutes_wire(&self, cal: &Calendar, rules: &RuleSet, which: &BTreeSet<i32>) -> Vec<Value> {
        let rule = self.rule_id(rules);
        let mut cum_cache: HashMap<usize, BTreeMap<i32, (Volume, bool)>> = HashMap::new();
        which.iter().filter_map(|k| {
            let m = self.minutes.get(k)?;
            let seg = cal.segment_of(self.id.cal_key(), *k)?;
            let cum = cum_cache.entry(seg.index).or_insert_with(|| self.cumulative(seg)).get(k).copied();
            Some(m.wire(&self.id, cum, rule))
        }).collect()
    }

    /// Effective evaluation minute and segment: after a session ends, windows freeze at its last trading minute.
    fn evaluation<'c>(&self, cal: &'c Calendar, t_minute: i32) -> Option<(&'c Segment, i32, bool)> {
        if let Some(seg) = cal.segment_of(self.id.cal_key(), t_minute) {
            if t_minute < seg.start {
                return None;
            }
            return Some((seg, t_minute, false));
        }
        cal.segments(self.id.cal_key()).into_iter().filter(|s| s.end < t_minute).max_by_key(|s| s.end).map(|s| {
            let end = s.end;
            (s, end, true)
        })
    }

    /// Minutes of a window [start, end] inside a business session, continuing into the previous partition when the
    /// session crosses midnight (returns records from `previous` for minutes before this partition's session start).
    fn window_minutes<'a>(&'a self, seg: &Segment, start: i32, end: i32, previous: Option<(&'a Instrument, &Segment)>) -> (Vec<(i32, &'a Minute, bool)>, bool) {
        let mut out = Vec::new();
        let mut warmup = false;
        if start < seg.start {
            match previous {
                Some((prev, pseg)) => {
                    let need = seg.start - start; // minutes before this partition's start
                    let from = 1440 - need;
                    for m in pseg.minutes_between(from.max(pseg.start), pseg.end) {
                        if let Some(rec) = prev.minutes.get(&m) {
                            out.push((m - 1440, &**rec, true));
                        }
                    }
                    if from < pseg.start {
                        warmup = true;
                    }
                }
                None => warmup = true,
            }
        }
        for m in seg.minutes_between(start.max(seg.start), end) {
            if let Some(rec) = self.minutes.get(&m) {
                out.push((m, &**rec, false));
            }
        }
        (out, warmup)
    }

    /// Recent windows at market time t (02 section 3): start = start of t's minute - N, end = t; includes the current
    /// forming minute; the base price is the last valid print before the start, never across a data gap.
    /// As of minute m: the latest print when it is inside m, else the close of the last priced minute <= m (a past
    /// minute evaluated during catch-up or a correction recheck; without it such a window had no close).
    fn end_price(&self, m: i32) -> Option<i64> {
        self.price.last_price.filter(|(_, _, pm)| *pm <= m).map(|(p, _, _)| p)
            .or_else(|| self.minutes.range(..=m).rev().find_map(|(_, r)| r.close))
    }

    /// A rolling window's move: its base price (where it comes from, which minute) and the change to `end_price`.
    fn window_move(&self, seg: &Segment, start: i32, prev_pair: Option<(&Instrument, &Segment)>, end_price: Option<i64>)
                   -> (Option<i64>, &'static str, Option<i32>, (Value, Value)) {
        let (base, base_source, base_minute) = self.base_price(seg, start, prev_pair);
        let change = match (end_price, base) {
            (Some(e), Some(b)) if b > 0 => (json!(money(e - b)), json!((e - b) as f64 / b as f64 * 100.0)),
            _ => (Value::Null, Value::Null),
        };
        (base, base_source, base_minute, change)
    }

    /// What the rules read of the windows at `t_ns` (events.rs `evaluate_rule`): each rolling window's base and change,
    /// computed as `windows_wire` computes them, without the rest of the window (its minutes, volume and flow) -- the
    /// rule events of a replay timeline's fold and of a catch-up, evaluated every step and every skipped minute.
    pub fn rule_windows(&self, cal: &Calendar, t_ns: i64, previous: Option<&Instrument>) -> Value {
        let Some(t_minute) = partition_local_minute(&self.id.source, &self.id.market, &self.id.session, t_ns).map(|(_, m)| m) else { return Value::Null };
        let Some((seg, m, _)) = self.evaluation(cal, t_minute) else {
            return json!({"state": "BEFORE_SESSION", "as_of_ns": t_ns.to_string()});
        };
        let prev_pair = previous.zip(cal.previous_day_segment(self.id.cal_key(), seg));
        let end_price = self.end_price(m);
        let mut out = serde_json::Map::new();
        for &n in market_runtime::contract::windows_minutes() {
            let (base, base_source, base_minute, change) = self.window_move(seg, m - n, prev_pair, end_price);
            out.insert(format!("{n}"), json!({"base_price": opt_money(base), "base_source": base_source, "base_minute": base_minute,
                                               "change_pct": change.1, "close": opt_money(end_price)}));
        }
        json!({"windows": out})
    }

    pub fn windows_wire(&self, cal: &Calendar, rules: &RuleSet, t_ns: i64, previous: Option<&Instrument>) -> Value {
        let Some(t_minute) = partition_local_minute(&self.id.source, &self.id.market, &self.id.session, t_ns).map(|(_, m)| m) else { return Value::Null };
        let Some((seg, m, closed)) = self.evaluation(cal, t_minute) else {
            return json!({"state": "BEFORE_SESSION", "as_of_ns": t_ns.to_string()});
        };
        let prev_seg = cal.previous_day_segment(self.id.cal_key(), seg);
        let prev_pair = previous.zip(prev_seg);
        let rule = self.rule_id(rules);
        let end_price = self.end_price(m);
        let mut out = serde_json::Map::new();
        // The rolling windows and fixed K periods come from config/system_contract.json, never a copy here.
        for &n in market_runtime::contract::windows_minutes() {
            let start = m - n;
            let (records, warmup) = self.window_minutes(&seg, start, m, prev_pair);
            let gaps = records.iter().filter(|(_, r, _)| r.quality.gap()).count();
            let expected = seg.minutes_between(start.max(seg.start), m).len();
            let observed = records.iter().filter(|(k, _, _)| *k >= seg.start).count();
            let volume_known: Volume = records.iter().filter_map(|(_, r, _)| r.volume).sum();
            let volume_complete = records.iter().all(|(_, r, _)| r.volume.is_some()) && observed == expected;
            let mut flow = Flow::default();
            for (_, r, _) in &records {
                flow.merge(&r.flow);
            }
            let (base, base_source, base_minute, change) = self.window_move(seg, start, prev_pair, end_price);
            let completeness = if warmup { "WARMUP" } else if gaps > 0 || observed < expected { "PARTIAL" } else { "COMPLETE" };
            out.insert(format!("{n}"), json!({
                "minutes": n,
                "as_of_ns": t_ns.to_string(),
                "close": opt_money(end_price),
                "volume": vol::wire(volume_known), "volume_complete": volume_complete,
                "base_price": opt_money(base), "base_source": base_source, "base_minute": base_minute,
                "change": change.0, "change_pct": change.1, "change_pct_unit": "percent",
                "flow": flow.wire(rule), "completeness": completeness, "gap_minutes": gaps,
                "synthetic_minutes": records.iter().filter(|(_, r, _)| r.quality == Quality::NoTradeSynthetic).count(),
            }));
        }
        // 1mK / 3mK / 5mK: the price against the open of the current n-minute bar, bars aligned to the session
        // start (09:00 for TW stocks -- the old snapshot store's fixed frames). The open is the bar's first minute that
        // traded (`Minute::traded`); a bar with no trade yet has not moved: 0, while there is a price at all.
        let mut k = serde_json::Map::new();
        for n in FIXED_K_ROW {
            let frame_start = seg.start + (m - seg.start).max(0) / n * n;
            let open = self.minutes.range(frame_start..=m).find_map(|(_, r)| r.traded().then_some(r.open).flatten());
            let pct = match (end_price, open) {
                (Some(e), Some(o)) if o > 0 => json!((e - o) as f64 / o as f64 * 100.0),
                (Some(_), None) => json!(0.0),
                _ => Value::Null,
            };
            k.insert(format!("{n}"), json!({"frame_start_minute": frame_start, "open": opt_money(open), "change_pct": pct}));
        }
        let mut wire = json!({"session": seg.name, "session_closed": closed, "evaluation_minute": m, "as_of_ns": t_ns.to_string(),
                              "calendar_quality": if seg.known_market { "KNOWN" } else { "UNKNOWN_MARKET" }});
        wire["windows"] = Value::Object(out);
        wire["k"] = Value::Object(k);
        wire
    }

    /// 量變 is defined for TW stocks' day session only (the baseline files hold nothing else).
    /// The scopes that have a previous-session minute baseline: Shioaji stocks and Futu US.
    pub fn volume_compare_applies(&self) -> bool {
        crate::baseline_publish::scope(&self.id.source, &self.id.market, &self.id.session)
    }

    /// 量變: the last COMPLETED clock minute's volume against the previous closed session's same minute,
    /// (current / baseline - 1) x 100. While the session runs the completed minute is the one before the evaluation
    /// minute; on the session's last minute (the 13:30 closing auction is a single print) and after close it is
    /// that last minute itself. No baseline file, or a baseline of 0 for that minute, gives a null percent with the
    /// minute still named, so a stale number never outlives its minute. So does a minute whose volume is not known (a
    /// coverage gap, or a minute not finalized yet): its volume is null, never 0; a covered minute without a trade is
    /// a real 0, finalized by `advance`.
    /// `lookup`: the baseline lookup and its state (READY / NOT_YET / CORRUPT / NO_ROOT), carried into the wire so a
    /// missing, not-yet-written and unreadable baseline read differently.
    pub fn volume_compare_wire(&self, cal: &Calendar, t_ns: i64, lookup: Option<&crate::baseline::Lookup>) -> Option<Value> {
        let baseline = lookup.and_then(|l| l.day());
        if !self.volume_compare_applies() {
            return None;
        }
        let t_minute = partition_local_minute(&self.id.source, &self.id.market, &self.id.session, t_ns).map(|(_, m)| m)?;
        let (seg, m, closed) = self.evaluation(cal, t_minute)?;
        let minute = if closed || m >= seg.end { m } else { m - 1 };
        if minute < seg.start {
            return None;
        }
        let current = self.minutes.get(&minute).and_then(|r| r.volume);
        let base = baseline.and_then(|d| d.items.get(&self.id.code.to_uppercase())).and_then(|per| per.get(&minute)).copied();
        let (pct, ratio, diff) = match (current, base) {
            (Some(c), Some(b)) if vol::positive(b).is_some() => (json!((c / b - 1.0) * 100.0), json!(c / b), vol::wire(c - b)),
            _ => (Value::Null, Value::Null, Value::Null),
        };
        Some(json!({"minute": minute, "baseline_minute": crate::baseline::clock_text(minute), "volume": vol::wire_opt(current),
                    "baseline_date": baseline.map(|d| d.date.clone()), "baseline_volume": vol::wire_opt(base),
                    "change_pct": pct, "ratio": ratio, "diff": diff, "scope": "COMPLETED_CLOCK_MINUTE",
                    "baseline_state": lookup.map(|l| l.state()).unwrap_or("NO_ROOT"), "baseline_reason": lookup.and_then(|l| l.reason())}))
    }

    /// Last valid print before `start` inside the session (or its previous-day part). A missing/partial minute between
    /// that print and the start makes the base unreliable; with no print yet in the session the reference is used.
    fn base_price(&self, seg: &Segment, start: i32, previous: Option<(&Instrument, &Segment)>) -> (Option<i64>, &'static str, Option<i32>) {
        let lo = seg.start;
        let mut saw_gap = false;
        if start > lo {
            for (k, m) in self.minutes.range(lo..start).rev() {
                if !seg.is_trading(*k) {
                    continue;
                }
                if m.quality.gap() && !m.traded() {
                    saw_gap = true;
                    continue;
                }
                if m.close.is_some() && m.authority != Authority::None {
                    return if saw_gap { (None, "GAP", Some(*k)) } else { (m.close, "print", Some(*k)) };
                }
            }
        }
        if let Some((prev, pseg)) = previous {
            // Only minutes strictly before the window start count as its base.
            let upper = if start < lo { (1440 + start - 1).min(pseg.end) } else { pseg.end };
            if upper >= pseg.start {
                for (k, m) in prev.minutes.range(pseg.start..=upper).rev() {
                    if m.quality.gap() && !m.traded() {
                        saw_gap = true;
                        continue;
                    }
                    if m.close.is_some() && m.authority != Authority::None {
                        return if saw_gap { (None, "GAP", Some(*k - 1440)) } else { (m.close, "print_previous_day", Some(*k - 1440)) };
                    }
                }
            }
        }
        if saw_gap {
            return (None, "GAP", None);
        }
        let reference = self.price.reference.comparison_price();
        (reference, if reference.is_some() { "reference" } else { "none" }, None)
    }

    /// Full business session to t: real first print as O, max/min, last print as C, deduplicated V; change vs the
    /// instrument's reference price, kept apart from C - O. Includes the flow totals, price ladder and fixed K bars.
    ///
    /// A session that continues from the previous calendar partition (the futures night after 00:00) includes that
    /// partition's part of it (15:00-24:00): `previous`. Without it the night's day block would restart at midnight.
    /// `inc`: a live item's increment (None: the whole block). The frame it was built in is returned for the next item.
    pub fn day_wire(&self, cal: &Calendar, rules: &RuleSet, t_ns: i64, previous: Option<&Instrument>, inc: Option<&Increment>)
        -> (Value, Option<(i32, i32)>) {
        let t_minute = partition_local_minute(&self.id.source, &self.id.market, &self.id.session, t_ns).map(|(_, m)| m).unwrap_or(0);
        let Some((seg, m, closed)) = self.evaluation(cal, t_minute) else { return (json!({"state": "BEFORE_SESSION"}), None) };
        let prev_seg = cal.previous_day_segment(self.id.cal_key(), seg);
        let frame = (prev_seg.as_ref().map_or(seg.start, |ps| ps.start - 1440), seg.start);
        // Whole unless this is a live increment inside the frame Market Runtime already holds.
        let increment = inc.filter(|i| !i.whole && i.frame == Some(frame));
        let prev_part: Vec<&Minute> = match (previous, prev_seg.as_ref()) {
            (Some(p), Some(ps)) => p.minutes.range(ps.start..=ps.end).map(|(_, r)| &**r).collect(),
            _ => Vec::new(),
        };
        let own: Vec<&Minute> = self.minutes.range(seg.start..=m).map(|(_, r)| &**r).collect();
        // In business order: the previous partition's part of the session first.
        let records: Vec<&Minute> = prev_part.iter().chain(own.iter()).copied().collect();
        // The session's first live print: in the first minute that holds any (minutes are in exchange-time order), so
        // only that minute's prints are read -- never every print of the day on every publish.
        // A print that sets no last sale (an odd lot) is no open.
        let priced = |t: &&CTrade| !t.no_last_sale;
        let first: Option<(usize, &CTrade)> = records.iter().enumerate().find(|(_, r)| r.ticks.iter().any(|t| !t.no_last_sale))
            .and_then(|(position, r)| r.ticks.iter().filter(priced).min_by_key(|t| (t.ts, t.seq)).map(|t| (position, t)));
        // A minute of such prints alone carries the price on (NoTradeSynthetic): it traded no price.
        let traded: Vec<&Minute> = records.iter().copied().filter(|r| r.traded()).collect();
        // The first live print is the open only if nothing traded before it. After a restart the earlier prints are
        // folded into their minutes' aggregates (`base`), and the first new print must not move the session open to it.
        let first_traded = records.iter().position(|r| r.traded());
        let open = match (first, first_traded) {
            (Some((position, t)), Some(fp)) if position == fp && records[fp].base.as_ref().is_none_or(|b| t.ts <= b.first_ts) => Some(t.price),
            (Some((position, t)), Some(fp)) if position < fp => Some(t.price),
            (Some((_, t)), None) => Some(t.price),
            _ => first_traded.and_then(|fp| records[fp].open),
        };
        let close = self.price.last_price.filter(|(_, _, pm)| *pm >= seg.start && *pm <= m).map(|(p, _, _)| p)
            .or_else(|| match (previous, prev_seg.as_ref()) {
                (Some(p), Some(ps)) => p.price.last_price.filter(|(_, _, pm)| *pm >= ps.start && *pm <= ps.end).map(|(price, _, _)| price),
                _ => None,
            });
        let mut flow = Flow::default();
        for r in &records {
            flow.merge(&r.flow);
        }
        // The day's volume is the minutes' plus what the cumulative total proved traded at an unknown time.
        let unattributed: Volume = records.iter().map(|r| r.unattributed_volume).sum();
        let volume: Volume = records.iter().filter_map(|r| r.volume).sum::<Volume>() + unattributed;
        let expected = seg.minutes_between(seg.start, m).len() + prev_seg.as_ref().map_or(0, |ps| ps.minutes_between(ps.start, ps.end).len());
        let volume_complete = records.iter().all(|r| r.volume.is_some()) && expected == records.len();
        let (change, pct) = match (close, self.price.reference.comparison_price()) {
            (Some(c), Some(r)) if r > 0 => (json!(money(c - r)), json!((c - r) as f64 / r as f64 * 100.0)),
            _ => (Value::Null, Value::Null),
        };
        let flow_rule = self.rule_id(rules);
        // An increment names the rows that changed (a row emptied away made the item whole: Dirty::day_whole): only
        // those rows are built. A session continuing a previous partition's part merges the two ladders.
        let own_ladder = self.session_ladder(seg.start);
        let earlier_ladder = match (previous, prev_seg.as_ref()) {
            (Some(p), Some(ps)) => Some(p.session_ladder(ps.start)),
            _ => None,
        };
        let row = |price: i64| -> Option<Value> {
            let mut bucket = own_ladder.get(&price).cloned();
            if let Some(b) = earlier_ladder.and_then(|l| l.get(&price)) {
                bucket.get_or_insert_with(PriceBucket::default).merge(b);
            }
            bucket.map(|b| b.wire(price, flow_rule.is_some()))
        };
        let ladder: Vec<Value> = match increment {
            Some(i) => i.prices.iter().filter_map(|p| row(*p)).collect(),
            None => {
                let prices: std::collections::BTreeSet<i64> = own_ladder.keys().chain(earlier_ladder.into_iter().flat_map(|l| l.keys())).copied().collect();
                prices.into_iter().filter_map(row).collect()
            }
        };
        let ticks_only = traded.iter().all(|r| r.authority == Authority::Ticks);
        // The session's minutes in business order, each with its record (from the partition it lives in).
        let mut timeline: Vec<(i32, Option<&Minute>)> = Vec::new();
        if let (Some(p), Some(ps)) = (previous, prev_seg.as_ref()) {
            timeline.extend(ps.minutes_between(ps.start, ps.end).into_iter().map(|x| (x, p.minutes.get(&x).map(|r| &**r))));
        }
        timeline.extend(seg.minutes_between(seg.start, m).into_iter().map(|x| (x, self.minutes.get(&x).map(|r| &**r))));
        let mut fixed = serde_json::Map::new();
        for &k in market_runtime::contract::fixed_kbar_minutes() {
            let mut bars = Vec::new();
            for chunk in timeline.chunks(k as usize) {
                // An increment names the bars from the one holding the earliest changed minute.
                if let Some(i) = increment {
                    if i.from.is_none_or(|from| chunk[chunk.len() - 1].0 < from) {
                        continue;
                    }
                }
                let recs: Vec<&Minute> = chunk.iter().filter_map(|(_, r)| *r).collect();
                let tr: Vec<&&Minute> = recs.iter().filter(|r| r.traded()).collect();
                bars.push(json!({"timeframe": format!("k{k}"), "start_minute": chunk[0].0, "end_minute": chunk[chunk.len() - 1].0,
                    "open": opt_money(tr.first().and_then(|r| r.open)), "high": opt_money(tr.iter().filter_map(|r| r.high).max()),
                    "low": opt_money(tr.iter().filter_map(|r| r.low).min()), "close": opt_money(tr.last().and_then(|r| r.close)),
                    "volume": vol::wire(recs.iter().filter_map(|r| r.volume).sum::<Volume>()),
                    "complete": chunk.len() == k as usize && recs.len() == chunk.len() && recs.iter().all(|r| r.finalized && !r.quality.gap())}));
            }
            fixed.insert(format!("k{k}"), Value::Array(bars));
        }
        let continues = prev_seg.is_some();
        let mut day = json!({
            "session": seg.name, "session_closed": closed, "as_of_ns": t_ns.to_string(),
            "session_start_minute": prev_seg.as_ref().map_or(seg.start, |ps| ps.start),
            "continues_previous_partition": continues, "previous_partition_joined": continues && previous.is_some(),
            "open": opt_money(open), "high": opt_money(traded.iter().filter_map(|r| r.high).max()), "low": opt_money(traded.iter().filter_map(|r| r.low).min()),
            "close": opt_money(close), "volume": vol::wire(volume), "volume_complete": volume_complete,
            // The session close against the reference, for analysis: never the instrument's 漲跌 (Market Runtime's
            // summary `change` is the one every screen shows, D01-04).
            "reference_price": opt_money(self.price.reference.comparison_price()), "close_change": change, "close_change_pct": pct, "change_pct_unit": "percent",
            "open_to_close": match (open, close) { (Some(o), Some(c)) => json!(money(c - o)), _ => Value::Null },
            "price_volume": {"complete": ticks_only, "current_price": opt_money(close),
                             "flow_fields": if flow_rule.is_some() { json!(LADDER_FLOW_FIELDS) } else { Value::Null },
                             "flow_rule_id": flow_rule,
                             // The session's large / small / unclassified buy-sell, the 價量 header's one source (the
                             // same fold as the rows' `flow`; never summed back from the rows by a reader).
                             "totals": if flow_rule.is_some() { json!({"large": side_wire(&flow.large), "small": side_wire(&flow.small),
                                                                       "unclassified": side_wire(&flow.unclassified)}) } else { Value::Null },
                             "out_volume": vol::wire(flow.large.buy + flow.small.buy + flow.unclassified.buy),
                             "in_volume": vol::wire(flow.large.sell + flow.small.sell + flow.unclassified.sell)},
            "diagnostics": {"outside_session_prints": self.quality.outside_session, "simtrade_skipped": self.quality.simtrade_skipped, "auction_prints": self.quality.auction_prints, "ticks_folded_capacity": self.quality.ticks_dropped,
                            "volume_gaps": self.quality.volume_gaps, "source_gaps": self.quality.source_gaps, "durable_gaps": self.quality.durable_gaps,
                            "unattributed_volume": vol::wire(self.minutes.values().map(|m| m.unattributed_volume).sum::<Volume>())},
        });
        // The large parts go in by move (json! would copy each whole).
        day["flow"] = flow.wire(self.rule_id(rules));
        day["fixed_k"] = Value::Object(fixed);
        // Once: the page reads the rows as `buckets` and names them `byPrice` itself (view_state_reducer.js).
        day["price_volume"]["buckets"] = Value::Array(ladder);
        if inc.is_some() {
            // A live item says which it is: the whole block, or an increment (bars and rows by key) of the one held.
            day["replace"] = json!(increment.is_none());
        }
        if !self.keeps_price_ladder() {
            // No 價量 ladder, only the session's 內外盤 totals: the book's 內外盤 bar reads them, as on a Taiwan stock.
            let totals = json!({"out_volume": day["price_volume"]["out_volume"].take(), "in_volume": day["price_volume"]["in_volume"].take()});
            day["price_volume"] = totals;
        }
        (day, Some(frame))
    }

    /// The trade-flow panel's shape (minute series + cumulative) on B's own classification, for the business session
    /// being evaluated only (a futures partition's night tail no longer mixes into its day or new night), joined with
    /// the previous partition's part when the session continues from it.
    ///
    /// Also the large prints it lists (`Listed`). `unchanged`: the ones the previous flow item listed, when the item
    /// may leave the list out while it is the same -- a replay timeline's step, which re-sent the newest 300 rows
    /// after every print (half the time a timeline of a busy stock took to build); the item then says `replace: false`
    /// (it names only what changed, the timeline keeps the rest).
    ///
    /// `inc`: a live item's increment (None: the whole block, as a replay step or a full publish sends it). The frame
    /// it was built in is returned for the next item.
    pub fn flow_wire(&self, cal: &Calendar, rules: &RuleSet, t_ns: i64, previous: Option<&Instrument>, unchanged: Option<&Listed>,
                     inc: Option<&Increment>) -> (Value, Listed, Option<(i32, i32)>) {
        let t_minute = partition_local_minute(&self.id.source, &self.id.market, &self.id.session, t_ns).map(|(_, m)| m).unwrap_or(0);
        let Some((seg, m, _)) = self.evaluation(cal, t_minute) else {
            // Before the first session the chart is framed by the session about to open.
            let mut wire = json!({"availability": "BEFORE_SESSION"});
            if let Some(next) = cal.segments(self.id.cal_key()).iter().find(|s| s.start > t_minute) {
                session_frame(&mut wire, cal, self.id.cal_key(), next);
            }
            return (wire, Listed::default(), None);
        };
        let rule = self.rule_id(rules);
        let prev_seg = cal.previous_day_segment(self.id.cal_key(), seg);
        let prev_part: Vec<(i32, &Minute)> = match (previous, prev_seg.as_ref()) {
            (Some(p), Some(ps)) => p.minutes.range(ps.start..=ps.end).map(|(k, r)| (*k, &**r)).collect(),
            _ => Vec::new(),
        };
        let own_part: Vec<(i32, &Minute)> = self.minutes.range(seg.start..=m).map(|(k, r)| (*k, &**r)).collect();
        let mut parts: Vec<(&Segment, i32, &[(i32, &Minute)])> = Vec::new();
        if let (Some(_), Some(ps)) = (previous, prev_seg.as_ref()) {
            parts.push((ps, -1440, &prev_part));
        }
        parts.push((seg, 0, &own_part));
        let hours = hour_buckets(&parts);
        let open = match (previous, prev_seg.as_ref()) {
            (Some(_), Some(ps)) => ps.start - 1440,
            _ => seg.start,
        };
        let frame = (open, seg.start);
        // Whole unless this is a live increment inside the frame Market Runtime already holds.
        let increment = inc.filter(|i| !i.whole && i.frame == Some(frame));
        let from = increment.map(|i| i.from.unwrap_or(i32::MAX));
        let mut total = Flow::default();
        // `minute` is on the session's axis (session_frame): the previous partition's part is before this one's 0.
        let series: Vec<Value> = prev_part.iter().map(|&(k, r)| (k - 1440, r)).chain(own_part.iter().copied()).filter_map(|(k, r)| {
            total.merge(&r.flow);
            // An increment names the minutes from the earliest one that changed (their running totals moved with it).
            if from.is_some_and(|f| k < f) {
                return None;
            }
            let mut entry = json!({"minute": k, "time": crate::baseline::clock_text(k),
                                   "unclassified": vol::wire(r.flow.unclassified.total()), "quality": r.quality.name()});
            entry["small"] = side_wire(&r.flow.small);
            entry["large"] = side_wire(&r.flow.large);
            // The running total from the series' first minute through this one: the 累計 chart, its crosshair and
            // the summary all read B's sum, never a prefix sum of their own.
            entry["cumulative"] = cumulative_wire(&total);
            Some(entry)
        }).collect();
        // The newest LARGE_ORDERS_WIRE of the session so far, the previous partition's part included.
        let prints = self.session_large_prints(cal, previous, open, m, LARGE_ORDERS_WIRE, None).0;
        let listed = Listed(prints.iter().map(|(_, t)| (t.identity(), t.large_reason)).collect());
        let held = increment.map(|i| i.listed).or(unchanged);
        let large_orders = (held != Some(&listed))
            .then(|| prints.iter().map(|&(minute, t)| self.large_order_row(minute, t)).collect::<Vec<Value>>());
        let mut wire = json!({"market": self.id.market, "availability": if rule.is_some() { "OK" } else { "NO_RULE" }, "rule_id": rule,
               "cumulative": cumulative_wire(&total),
               "definition_version": rules.flow_revision.map(|r| format!("flow_rules@{r}"))});
        // The large parts go in by move (json! would copy each whole).
        wire["totals"] = total.wire(rule);
        wire["minuteSeries"] = Value::Array(series);
        wire["hourSeries"] = Value::Array(hours);
        session_frame(&mut wire, cal, self.id.cal_key(), seg);
        match large_orders {
            Some(rows) => wire["largeOrders"] = Value::Array(rows),
            None => wire["replace"] = json!(false),
        }
        if inc.is_some() {
            // A live item says which it is: the whole block, or an increment of the one Market Runtime holds.
            wire["replace"] = json!(increment.is_none());
        }
        wire["thresholds"] = self.thresholds_wire(rules);
        (wire, listed, Some(frame))
    }

    /// The rule the classification used, stated (the trade detail shows its threshold, never a guess).
    fn thresholds_wire(&self, rules: &RuleSet) -> Value {
        match rules.flow_rule(&self.id.source, &self.id.market, &self.id.code) {
            Some(r) => json!({"rule_id": r.rule_id, "threshold_type": r.threshold_type, "threshold": r.threshold, "unit": r.unit,
                              "volume_cutoff": if r.threshold_type == "volume" { json!(r.threshold) } else { Value::Null },
                              "impact_ratio": r.impact_ratio, "episode_gap_ms": r.episode_gap_ms}),
            None => Value::Null,
        }
    }

    /// Large prints of minutes [from, to] on the session's axis -- the one hourSeries, minuteSeries and each row's
    /// `minute` are on: this partition's minutes, and before 0 the segment of `previous` that a session of this
    /// partition continues (calendar previous_day_segment) -- newest first, at most `limit`; true when more existed.
    /// What the 分時 tab asks for when one bucket is opened. `side` (1 = buy, -1 = sell) is chosen before the limit,
    /// so a window whose newest prints are all buys still lists its sells.
    pub fn session_large_orders(&self, cal: &Calendar, previous: Option<&Instrument>, from: i32, to: i32, limit: usize, side: Option<i8>)
        -> (Vec<Value>, bool) {
        let (prints, truncated) = self.session_large_prints(cal, previous, from, to, limit, side);
        (prints.into_iter().map(|(minute, t)| self.large_order_row(minute, t)).collect(), truncated)
    }

    /// The prints `session_large_orders` lists, each with its session minute.
    fn session_large_prints<'a>(&'a self, cal: &Calendar, previous: Option<&'a Instrument>, from: i32, to: i32, limit: usize, side: Option<i8>)
        -> (Vec<(i32, &'a CTrade)>, bool) {
        let (mut rows, mut truncated) = self.large_prints_of_side(from.max(0), to, limit, side);
        let key = self.id.cal_key();
        let joined = cal.segments(key).iter().find(|s| s.continues_previous_day).and_then(|s| cal.previous_day_segment(key, s));
        if let (Some(p), Some(ps), true) = (previous, joined, from < 0) {
            let (older, cut) = p.large_prints_of_side((from + 1440).max(ps.start), (to + 1440).min(ps.end), limit, side);
            rows.extend(older.into_iter().map(|(k, t)| (k - 1440, t)));
            rows.sort_by(|a, b| b.1.list_order(a.1));
            truncated |= cut || rows.len() > limit;
            rows.truncate(limit);
        }
        (rows, truncated)
    }

    /// Large prints of this partition's minutes [from, to], each with its minute, newest first, at most `limit`.
    /// Either side: read from the minutes that can hold the newest ones (each minute's `large_newest`), newest first,
    /// until `limit` prints are held and no minute left can hold a newer one -- every publish of a busy session asked
    /// this of all its prints. One side: every large print of the range (a page's query, not a publish).
    fn large_prints_of_side(&self, from: i32, to: i32, limit: usize, side: Option<i8>) -> (Vec<(i32, &CTrade)>, bool) {
        if from > to {
            return (Vec::new(), false);
        }
        if side.is_none() {
            let mut candidates: Vec<((u64, i64), i32, &Minute)> = self.minutes.range(from..=to)
                .filter_map(|(k, m)| m.large_newest.map(|newest| (newest, *k, &**m))).collect();
            candidates.sort_by(|a, b| b.0.cmp(&a.0));
            let mut rows: Vec<(i32, &CTrade)> = Vec::new();
            let mut more = false;
            for (position, (newest, k, m)) in candidates.iter().enumerate() {
                if rows.len() >= limit && rows[limit - 1].1.list_key() > *newest {
                    more = true;
                    let _ = position;
                    break;
                }
                rows.extend(m.ticks.iter().chain(m.large_prints.iter()).filter(|t| t.large == Some(true)).map(|t| (*k, t)));
                rows.sort_by(|a, b| b.1.list_order(a.1));
                rows.dedup_by(|a, b| a.1.identity() == b.1.identity());
            }
            let truncated = more || rows.len() > limit;
            rows.truncate(limit);
            return (rows, truncated);
        }
        let mut rows: Vec<(i32, &CTrade)> = self.minutes.range(from..=to)
            .flat_map(|(k, m)| m.ticks.iter().chain(m.large_prints.iter()).map(move |t| (*k, t)))
            .filter(|(_, t)| t.large == Some(true) && side.is_none_or(|s| t.side == s)).collect();
        rows.sort_by(|a, b| b.1.list_order(a.1));
        rows.dedup_by(|a, b| a.1.identity() == b.1.identity());
        let truncated = rows.len() > limit;
        rows.truncate(limit);
        (rows, truncated)
    }

    /// One listed print; `minute` is its minute on the session's axis, the one its bucket is on.
    fn large_order_row(&self, minute: i32, t: &CTrade) -> Value {
        {
            let reason = [(LARGE_BY_VOLUME, "VOLUME"), (LARGE_BY_EPISODE, "EPISODE"), (LARGE_BY_IMPACT, "IMPACT")].iter()
                .filter(|(bit, _)| t.large_reason & bit != 0).map(|(_, name)| *name).collect::<Vec<_>>().join("+");
            // Exchange-local wall clock (market offsets are whole minutes, so the seconds are the UTC seconds).
            let time = market_local_minute(&self.id.market, t.ts)
                .map(|(_, m)| format!("{:02}:{:02}:{:02}", m / 60, m % 60, (t.ts / 1_000_000_000).rem_euclid(60)));
            json!({"durable_sequence": t.seq, "trade_id": t.id, "exchange_ts_ns": t.ts.to_string(), "minute": minute, "time": time, "price": money(t.price),
                   "volume": vol::wire(t.volume), "side": match t.side { 1 => "BUY", -1 => "SELL", _ => "UNKNOWN" },
                   "large_reason": reason, "episode_id": t.episode})
        }
    }
}
