//! Rust B engine: applies the durable stream in order to per-partition instruments and market scopes, and builds
//! the projection items it returns to Rust A (docs/system-architecture/02 section 6, 03 section 3).
//!
//! Single-threaded by design: events are applied in durable order and a checkpoint is therefore always the state
//! exactly at the cursor it names. Inference runs elsewhere and never blocks this loop.

use crate::accum::{Increment, Instrument, InstrumentId, Listed, ScopeId};
use market_runtime::calendar::Calendar;
use crate::events;
use crate::signals::SignalBook;
use crate::rules::RuleSet;
use market_runtime::demand::{LIVE_NEVER_STORED, LIVE_UNLISTED};
use market_runtime::event::{checked_shift_date, is_session_partitioned, partition_local_minute, MarketEvent, Payload, CLOCK_CODE, COVERAGE_SUBSCRIBED,
    LOSS_CONTROL};
use market_runtime::rollover::{clear_family, family, stored_per_instrument};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Scope {
    /// Latest exchange time observed in the scope (exchange-quality prints and market clocks).
    pub market_ns: i64,
    pub clock_minute: i32,
    pub finalized_through: i32,
    /// First durable sequence of this partition: where an exact rebuild of the day starts.
    pub first_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Stats {
    pub events: u64,
    pub raw_applied: u64,
    pub clocks: u64,
    pub retired_partitions: u64,
    /// Coverage records Market Runtime wrote.
    pub coverage_records: u64,
    /// Loss records Market Runtime wrote (a re-sent print's stated gap, event::LOSS_CONTROL).
    #[serde(default)]
    pub loss_records: u64,
}

/// How an event reached B. Market Runtime decides at ingest, by one applied background revision, how each event is
/// kept (market_runtime::demand::Storage) and names it on the live lane (`live.batch` `storage`); B never infers it
/// from which events happened to arrive (Codex 1020-R04-04).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// The durable stream: in the WAL, so in everything B writes.
    Durable,
    /// A market nothing of is ever written (Futu crypto): kept whole as the stored partitions are (its caches are
    /// cleared at Market Runtime's moments, rollover::never_stored).
    NeverStored,
    /// A stock off the background list (a searched stock, a workspace one -- user 10-19): shown and analysed, never
    /// in anything B writes (`LiveOverlay`).
    Unlisted,
}

impl Lane {
    /// The lane of a live-lane event. A Market Runtime before 10-27 named none: it sent exactly these two classes,
    /// told apart by the market. A class this build does not know is kept out of everything written.
    pub fn live(storage: Option<&str>, source: &str, market: &str) -> Self {
        match storage {
            Some(LIVE_NEVER_STORED) => Self::NeverStored,
            Some(LIVE_UNLISTED) => Self::Unlisted,
            None if !stored_per_instrument(source, market) => Self::NeverStored,
            _ => Self::Unlisted,
        }
    }
}

/// The partitions of stocks off the background list as the screens see them (Codex 1020-R04-03, -06).
///
/// `Engine::instruments`/`scopes` are the stored fold: exactly what a replay of the WAL rebuilds, so the checkpoint,
/// the event archive and the feature capture never hold what the WAL does not. A partition that takes an unlisted
/// event is forked here from its stored fold (or created) and from then on takes both lanes' events, while the
/// stored fold keeps taking the stored ones -- a stock searched first and listed later, or listed and later dropped,
/// is shown whole and stored as the WAL holds it. A scope here is its stored scope plus the unlisted events' market
/// time: an unlisted print never finalizes a minute of a stored partition. Projection publishes the overlay's
/// partition in place of its stored one. Keyed by partition, it leaves with the partition (rollover, clear); memory
/// only.
#[derive(Debug, Clone, Default)]
pub struct LiveOverlay {
    pub instruments: BTreeMap<InstrumentId, Instrument>,
    pub scopes: BTreeMap<ScopeId, Scope>,
    /// Unlisted events applied (not in `Stats`, which a checkpoint keeps).
    pub events: u64,
}

/// One partition's projection items (`Engine::collect`).
pub struct Collected {
    pub id: InstrumentId,
    pub items: Vec<Value>,
    /// Published to Market Runtime: the overlay's partition where there is one, else the stored one.
    pub shown: bool,
    /// From the stored fold: its rule events are archived. An overlay's never are.
    pub stored: bool,
}

/// What `apply_market` did, for the stats.
enum Applied {
    Skipped,
    Clock,
    Raw,
}

/// The instrument of a partition, created as an event creates it (covered from its open while its instrument is
/// subscribed).
fn instrument_entry<'a>(instruments: &'a mut BTreeMap<InstrumentId, Instrument>, subscribed: &BTreeMap<String, u64>,
                        id: InstrumentId) -> &'a mut Instrument {
    let covered = subscribed.contains_key(&subscription_key(&id.source, &id.market, &id.code));
    instruments.entry(id.clone()).or_insert_with(|| {
        let mut inst = Instrument::new(id);
        if covered {
            inst.cover_from_open();
        }
        inst
    })
}

impl ScopeId {
    fn of(e: &MarketEvent) -> Self {
        ScopeId { source: e.provider.to_lowercase(), market: e.market.to_uppercase(), trading_date: e.trading_date.clone(), session: e.session.to_uppercase() }
    }
}

/// Every partition of `scope` in one layer (the stored fold or the overlay) moves to `minute`.
fn advance_scope(instruments: &mut BTreeMap<InstrumentId, Instrument>, scopes: &mut BTreeMap<ScopeId, Scope>, cal: &Calendar, scope: &ScopeId,
                 minute: i32, seq: u64) {
    for (id, inst) in instruments.iter_mut() {
        if id.scope() == *scope {
            inst.advance(cal, minute, seq);
        }
    }
    if let Some(s) = scopes.get_mut(scope) {
        s.finalized_through = s.finalized_through.max(minute - 1);
    }
}

/// One market event (a print, a quote, a book, a clock; rolled-over and cleared ones already skipped) into one layer:
/// the stored fold (`Engine::instruments`/`scopes`) or the overlay (LiveOverlay). `create`: it may create its
/// partition -- false when a stored event only keeps an overlay's scope in step with its stored one.
#[allow(clippy::too_many_arguments)]
fn apply_market(instruments: &mut BTreeMap<InstrumentId, Instrument>, scopes: &mut BTreeMap<ScopeId, Scope>, cal: &Calendar, rules: &RuleSet,
                subscribed: &BTreeMap<String, u64>, scope_id: &ScopeId, e: &MarketEvent, create: bool) -> Applied {
    let scope = scopes.entry(scope_id.clone()).or_insert_with(|| Scope { first_sequence: e.durable_sequence, clock_minute: -1, finalized_through: -1, market_ns: 0 });
    if e.code == CLOCK_CODE {
        let Payload::Clock { minute } = &e.payload else { return Applied::Skipped };
        // A clock names a minute of ITS local day. When that day is later than the partition's trading
        // date (a day partition still resident after midnight, a backfilled earlier day), the partition's
        // day is over: every minute finalizes and market time moves to the end of that day -- the
        // clock's minute-of-day must not be read as an early minute of the old day ("before session").
        // A night session whose local date is at or before its trading date keeps the normal path.
        let (clock_date, ts_minute) = partition_local_minute(&e.provider, &e.market, &e.session, e.exchange_ts_ns).unwrap_or_default();
        // A lagged clock just after midnight names the PREVIOUS day's minute (23:59 = 1439) while its
        // timestamp is already on the new day; read as a minute of the new partition it finalized the
        // whole future day as no-trade (a print at 00:00). A minute ahead of its own timestamp's minute on
        // the partition's own day never advances the partition.
        if !clock_date.is_empty() && clock_date == scope_id.trading_date && *minute > ts_minute {
            return Applied::Clock;
        }
        // A clock from the evening before the partition's day names a minute of that day (Futu's "00:00"
        // bar opens the 10-16 partition at 23:59 on 10-15, and a clock 1439 followed): nothing of this
        // partition is due yet. Only that midnight straddle: a recorded feed may carry a trading date
        // unrelated to its timestamps. Session-partitioned families (FUT NIGHT) start the evening before
        // their trading date and are clocked by their own session rule.
        if checked_shift_date(&clock_date, 1).as_deref() == Some(scope_id.trading_date.as_str())
            && !is_session_partitioned(&e.provider, &e.market) {
            return Applied::Clock;
        }
        let (m, market_ns) = if !clock_date.is_empty() && clock_date > scope_id.trading_date {
            let secs_of_day = (*minute as i64) * 60 + e.exchange_ts_ns.div_euclid(1_000_000_000).rem_euclid(60);
            let day_start = e.exchange_ts_ns - secs_of_day * 1_000_000_000 - e.exchange_ts_ns.rem_euclid(1_000_000_000);
            (24 * 60, day_start - 1)
        } else {
            (*minute, e.exchange_ts_ns)
        };
        scope.clock_minute = scope.clock_minute.max(m);
        scope.market_ns = scope.market_ns.max(market_ns);
        advance_scope(instruments, scopes, cal, scope_id, m, e.durable_sequence);
        return Applied::Clock;
    }
    let exchange_time = e.time_quality == "exchange" && e.exchange_ts_ns > 0;
    if exchange_time {
        scope.market_ns = scope.market_ns.max(e.exchange_ts_ns);
    }
    let due = if exchange_time {
        // Just after midnight, market time minus the late allowance is still on the previous day: its minute
        // (23:59 = 1439) is not a minute of this partition. Read as one, the first print of a day would finalize the
        // whole day as no-trade. Nothing of the new day is due yet.
        let now_date = partition_local_minute(&e.provider, &e.market, &e.session, scope.market_ns).map(|(d, _)| d).unwrap_or_default();
        match partition_local_minute(&e.provider, &e.market, &e.session, scope.market_ns - cal.late_allowance_ns) {
            Some((date, _)) if now_date == scope_id.trading_date && date < now_date => -1,
            Some((_, m)) => m,
            None => -1,
        }
    } else {
        -1
    };
    let finalized = scope.finalized_through;
    let id = InstrumentId::of(e);
    // Borrowed, never cloned: this runs once per durable event. Cloning the calendar and the rule set here, and
    // collecting every finalized minute of the instrument into a fresh set, made B's per-event cost grow through
    // the day (~54 us/event, ~5k events/s on one core under load). `inst.apply` never changes a
    // minute's finalized flag, so "finalized now" is the same set the old pre-apply snapshot captured.
    let held = if create { Some(instrument_entry(instruments, subscribed, id)) } else { instruments.get_mut(&id) };
    if let Some(inst) = held {
        // A finalized minute this event changed may invalidate events triggered in it. Only the minutes of this
        // event: the dirty set also holds what changed since the last publish, and rechecking those made the events
        // depend on when B published (a replay published once revoked events a live publish kept).
        let before = std::mem::take(&mut inst.projection.dirty.minutes);
        inst.apply(cal, rules, e);
        let touched: Vec<i32> = inst.projection.dirty.minutes.iter().copied()
            .filter(|m| inst.minutes.get(m).is_some_and(|x| x.finalized)).collect();
        inst.projection.dirty.minutes.extend(before);
        for minute in touched {
            let ids = events::recheck(inst, cal, rules, minute, e.durable_sequence);
            inst.projection.dirty.events.extend(ids);
        }
    }
    if due > finalized + 1 {
        advance_scope(instruments, scopes, cal, scope_id, due, e.durable_sequence);
    }
    Applied::Raw
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Engine {
    #[serde(skip, default)]
    pub cal: Calendar,
    #[serde(skip, default)]
    pub rules: RuleSet,
    #[serde(with = "pairs")]
    pub instruments: BTreeMap<InstrumentId, Instrument>,
    #[serde(with = "pairs")]
    pub scopes: BTreeMap<ScopeId, Scope>,
    pub stats: Stats,
    pub cursor: u64,
    /// 量變's previous-session baseline files (set by the process; none in tests and offline replays).
    #[serde(skip, default)]
    pub baselines: std::sync::Arc<crate::baseline::Store>,
    /// Market Runtime's session rollover cutoffs (market_runtime::rollover): `source|MARKET|SESSION` -> date. A
    /// partition dated before its family's cutoff has left both caches; its late events are skipped.
    pub rolled: BTreeMap<String, String>,
    /// Families Market Runtime empties whole at a moment (market_runtime::rollover::clears): `source|MARKET` -> ns.
    pub cleared: BTreeMap<String, i64>,
    /// Instruments a provider's broker has confirmed subscribed, `source|MARKET|CODE` -> the Market Runtime epoch that
    /// confirmed it (from Market Runtime's coverage records). A subscription outlives sessions: a partition created
    /// while its instrument is subscribed is covered from its open, so a no-trade minute before the first print is
    /// "no trade", not "missing".
    pub subscribed: BTreeMap<String, u64>,
    /// The newest Market Runtime epoch that wrote coverage, per source. A restarted Market Runtime confirms its
    /// providers' subscriptions afresh; what an older epoch confirmed and the new one does not is no longer observed.
    pub coverage_epoch: BTreeMap<String, u64>,
    /// Stocks off the background list as shown (LiveOverlay). Memory only.
    #[serde(skip, default)]
    pub live: LiveOverlay,
    /// When this run of B joined the live lane after Market Runtime had already sent on it (its first live.batch was
    /// not the lane's first): the time it joined. A live-lane partition created from then on that was open before it
    /// lost what the lane carried from its open (`join_live_lane`). Memory only: it is this process's.
    #[serde(skip, default)]
    pub live_joined_late_ns: Option<i64>,
}

fn subscription_key(source: &str, market: &str, code: &str) -> String {
    format!("{}|{}|{}", source.to_lowercase(), market.to_uppercase(), code.to_uppercase())
}

impl Default for Engine {
    fn default() -> Self {
        Self { cal: Calendar::default(), rules: RuleSet::default(), instruments: BTreeMap::new(), scopes: BTreeMap::new(), stats: Stats::default(), cursor: 0,
               baselines: Default::default(), rolled: BTreeMap::new(), cleared: BTreeMap::new(), subscribed: BTreeMap::new(), coverage_epoch: BTreeMap::new(),
               live: LiveOverlay::default(), live_joined_late_ns: None }
    }
}

impl Engine {
    pub fn new(cal: Calendar, rules: RuleSet) -> Self {
        Self { cal, rules, ..Default::default() }
    }

    /// Apply one durable event (already cursor-checked by the caller), or one of a never-stored market: the stored
    /// fold, and the overlay's scope and partition when it holds them.
    pub fn apply(&mut self, e: &MarketEvent) {
        self.stats.events += 1;
        self.cursor = self.cursor.max(e.durable_sequence);
        if let Payload::SourceStatus { state, .. } = &e.payload {
            // Control, not market data: it never creates a scope or a session. The decoder (MarketEvent::decode_*)
            // refused every source_status that is not Market Runtime's coverage or loss record.
            if e.time_quality == LOSS_CONTROL {
                self.stats.loss_records += 1;
                self.apply_loss(e, false);
                return;
            }
            self.stats.coverage_records += 1;
            self.apply_coverage(e, state == COVERAGE_SUBSCRIBED);
            return;
        }
        let scope_id = ScopeId::of(e);
        if self.is_rolled(&scope_id) || self.is_cleared_event(e) {
            return;
        }
        // A never-stored partition (it comes only over the live lane) first seen after B joined that lane late.
        if e.code != CLOCK_CODE && !stored_per_instrument(&e.provider, &e.market) {
            let id = InstrumentId::of(e);
            if !self.instruments.contains_key(&id) && self.opened_before_live_join(&id) {
                instrument_entry(&mut self.instruments, &self.subscribed, id).mark_gap_from_open();
            }
        }
        let second = market_second(e);
        let live_scope = self.live.scopes.contains_key(&scope_id);
        if let Some(now) = second {
            evaluate_passed(&mut self.instruments, None, &self.cal, &self.rules, &self.baselines, &scope_id, now, self.cursor);
            if live_scope {
                evaluate_passed(&mut self.live.instruments, Some(&self.instruments), &self.cal, &self.rules, &self.baselines, &scope_id, now, self.cursor);
            }
        }
        match apply_market(&mut self.instruments, &mut self.scopes, &self.cal, &self.rules, &self.subscribed, &scope_id, e, true) {
            Applied::Clock => self.stats.clocks += 1,
            Applied::Raw => {
                self.stats.raw_applied += 1;
                if let Some(now) = second { mark_pending(&mut self.instruments, e, now); }
            }
            Applied::Skipped => {}
        }
        if live_scope {
            let applied = apply_market(&mut self.live.instruments, &mut self.live.scopes, &self.cal, &self.rules, &self.subscribed, &scope_id, e, false);
            if let (Applied::Raw, Some(now)) = (applied, second) { mark_pending(&mut self.live.instruments, e, now); }
        }
    }

    /// Apply one event of a stock off the background list (Lane::Unlisted): the overlay only (LiveOverlay). The
    /// durable cursor and the stats never move.
    pub fn apply_live_only(&mut self, e: &MarketEvent) {
        self.live.events += 1;
        let scope_id = ScopeId::of(e);
        if self.is_rolled(&scope_id) || self.is_cleared_event(e) {
            return;
        }
        if let Payload::SourceStatus { .. } = &e.payload {
            // Coverage is always durable; a loss record of an unlisted stock comes this way.
            if e.time_quality == LOSS_CONTROL {
                self.apply_loss(e, true);
            }
            return;
        }
        if !self.live.scopes.contains_key(&scope_id) {
            let scope = self.scopes.get(&scope_id).cloned()
                .unwrap_or(Scope { first_sequence: 0, clock_minute: -1, finalized_through: -1, market_ns: 0 });
            self.live.scopes.insert(scope_id.clone(), scope);
        }
        if e.code != CLOCK_CODE {
            self.live_entry(InstrumentId::of(e));
        }
        let second = market_second(e);
        if let Some(now) = second {
            evaluate_passed(&mut self.live.instruments, Some(&self.instruments), &self.cal, &self.rules, &self.baselines, &scope_id, now, self.cursor);
        }
        let applied = apply_market(&mut self.live.instruments, &mut self.live.scopes, &self.cal, &self.rules, &self.subscribed, &scope_id, e, true);
        if let (Applied::Raw, Some(now)) = (applied, second) { mark_pending(&mut self.live.instruments, e, now); }
    }

    /// The overlay's partition of `id`, forked from its stored fold the first time (or created as an event creates one).
    /// One forked or created after B joined the live lane late, and open before that, lost the unlisted events the
    /// lane carried from its open.
    fn live_entry(&mut self, id: InstrumentId) -> &mut Instrument {
        if !self.live.instruments.contains_key(&id) {
            let missed = self.opened_before_live_join(&id);
            if let Some(stored) = self.instruments.get(&id) {
                self.live.instruments.insert(id.clone(), stored.clone());
            }
            let inst = instrument_entry(&mut self.live.instruments, &self.subscribed, id.clone());
            if missed {
                inst.mark_gap_from_open();
            }
        }
        instrument_entry(&mut self.live.instruments, &self.subscribed, id)
    }

    /// This run's first live.batch. Every never-stored partition held from the checkpoint lost what the lane carried
    /// between that checkpoint and now -- nobody keeps it while B is down. `late`: the lane had carried messages
    /// before this one (Market Runtime was sending before B joined), so a live-lane partition created from now on
    /// that was open before `now_ns` lost what came from its open. Returns the partitions marked now.
    pub fn join_live_lane(&mut self, late: bool, now_ns: i64) -> usize {
        if late {
            self.live_joined_late_ns = Some(now_ns);
        }
        self.mark_never_stored_gap()
    }

    /// Whether `id` was open when B joined the live lane late (false when it did not join late): its trading date is
    /// before the join's, or the same and its first session had started by the join's minute.
    fn opened_before_live_join(&self, id: &InstrumentId) -> bool {
        let Some(joined_ns) = self.live_joined_late_ns else { return false };
        let Some((date, minute)) = partition_local_minute(&id.source, &id.market, &id.session, joined_ns) else { return true };
        match id.trading_date.as_str().cmp(date.as_str()) {
            std::cmp::Ordering::Less => true,
            std::cmp::Ordering::Greater => false,
            std::cmp::Ordering::Equal => self.cal.segments(id.cal_key()).iter().map(|s| s.start).min().is_none_or(|start| start <= minute),
        }
    }

    /// Market Runtime's loss record (event::LOSS_CONTROL): the source dropped events of this partition where it
    /// re-sent a print that was not stored. Marked as a gap stated on a print is (`Instrument::note_source_gap`),
    /// never read as a change of subscription. `live_only`: it came over the live lane (an unlisted stock).
    fn apply_loss(&mut self, e: &MarketEvent, live_only: bool) {
        let id = InstrumentId::of(e);
        if self.is_rolled(&id.scope()) {
            return;
        }
        if live_only {
            self.live_entry(id).note_source_gap(e);
            return;
        }
        instrument_entry(&mut self.instruments, &self.subscribed, id.clone()).note_source_gap(e);
        if let Some(inst) = self.live.instruments.get_mut(&id) {
            inst.note_source_gap(e);
        }
    }

    /// A coverage record: the instrument's subscription state changes now. Partitions already held take it at the
    /// record's minute -- a change before a partition's own day covers (or uncovers) it from its open, one after its
    /// day leaves it alone -- and partitions created later start from the new state.
    fn apply_coverage(&mut self, e: &MarketEvent, subscribed: bool) {
        let source = e.provider.to_lowercase();
        // The first record of a newer Market Runtime epoch for this source: whatever an older epoch confirmed ends
        // here; the new epoch's own records re-confirm what is still subscribed.
        if e.generation > self.coverage_epoch.get(&source).copied().unwrap_or(0) {
            self.coverage_epoch.insert(source.clone(), e.generation);
            let prefix = format!("{source}|");
            let stale: Vec<String> = self.subscribed.iter()
                .filter(|(k, epoch)| k.starts_with(&prefix) && **epoch < e.generation).map(|(k, _)| k.clone()).collect();
            for key in stale {
                self.subscribed.remove(&key);
                let mut parts = key.splitn(3, '|');
                let (Some(_), Some(market), Some(code)) = (parts.next(), parts.next(), parts.next()) else { continue };
                self.cover_held(&source, market, code, e.exchange_ts_ns, false);
            }
        }
        let key = subscription_key(&e.provider, &e.market, &e.code);
        if subscribed {
            self.subscribed.insert(key, e.generation);
        } else {
            self.subscribed.remove(&key);
        }
        self.cover_held(&e.provider, &e.market, &e.code, e.exchange_ts_ns, subscribed);
    }

    /// Open or close the coverage of every held partition of one instrument at `ts_ns`, stored and shown alike.
    fn cover_held(&mut self, source: &str, market: &str, code: &str, ts_ns: i64, subscribed: bool) {
        for inst in self.instruments.values_mut().chain(self.live.instruments.values_mut()) {
            let id = &inst.id;
            if !(id.source.eq_ignore_ascii_case(source) && id.market.eq_ignore_ascii_case(market) && id.code.eq_ignore_ascii_case(code)) {
                continue;
            }
            let Some((date, minute)) = partition_local_minute(&id.source, &id.market, &id.session, ts_ns) else { continue };
            let minute = match date.as_str().cmp(id.trading_date.as_str()) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => minute,
                std::cmp::Ordering::Greater => continue,
            };
            if subscribed {
                inst.open_coverage(minute);
            } else {
                inst.close_coverage(minute);
            }
        }
    }

    /// The partition as the screens see it: the overlay's where there is one (LiveOverlay), else the stored one.
    pub fn shown_mut(&mut self, id: &InstrumentId) -> Option<&mut Instrument> {
        match self.live.instruments.get_mut(id) {
            Some(inst) => Some(inst),
            None => self.instruments.get_mut(id),
        }
    }

    /// Every partition as the screens see it (`shown`).
    pub fn shown_partitions(&self) -> impl Iterator<Item = (&InstrumentId, &Instrument)> {
        let live = &self.live.instruments;
        live.iter().chain(self.instruments.iter().filter(move |(id, _)| !live.contains_key(*id)))
    }

    /// The previous partition of a shown partition, found as its projection finds it: of an overlay partition the
    /// overlay's, else the stored one; of a stored partition the stored one.
    pub fn shown_previous_partition(&self, id: &InstrumentId) -> Option<&Instrument> {
        let live = self.live.instruments.contains_key(id).then(|| previous_partition_in(&self.live.instruments, id)).flatten();
        live.or_else(|| previous_partition_in(&self.instruments, id))
    }

    /// Replace the rule set. A flow-rule change needs every print of the day reclassified: the caller rebuilds
    /// the affected partitions from the WAL (returns true) so the new version is complete, not half-applied.
    pub fn set_rules(&mut self, rules: RuleSet) -> bool {
        let flow_changed = rules.flow != self.rules.flow || rules.side_inference != self.rules.side_inference;
        let event_changed = rules.events != self.rules.events;
        self.rules = rules;
        if event_changed {
            for inst in self.instruments.values_mut().chain(self.live.instruments.values_mut()) {
                inst.events = events::EventState::default();
                inst.projection.dirty.events.insert("*".into());
            }
        }
        flow_changed
    }

    /// Earliest partition start among the live partitions: an exact rebuild replays from here.
    pub fn rebuild_from(&self) -> u64 {
        self.scopes.values().map(|s| s.first_sequence).min().unwrap_or(1).saturating_sub(1)
    }

    /// An event of this partition was lost (undecodable): marked even when it was the partition's first -- the
    /// instrument is created holding the loss, so its first data does not read as complete. A durable one is the
    /// stored fold's (and the overlay's, which takes every stored event); `lane` Unlisted: the overlay's only.
    pub fn mark_lost_input(&mut self, id: &InstrumentId, lane: Lane) {
        if self.is_rolled(&id.scope()) {
            return;
        }
        if lane == Lane::Unlisted {
            self.live_entry(id.clone()).mark_durable_gap();
            return;
        }
        instrument_entry(&mut self.instruments, &self.subscribed, id.clone()).mark_durable_gap();
        if let Some(inst) = self.live.instruments.get_mut(id) {
            inst.mark_durable_gap();
        }
    }

    /// A durable gap inside the stream being projected: every held instrument may have lost events (see
    /// `Instrument::mark_durable_gap`), stored and shown.
    pub fn mark_durable_gap(&mut self) {
        for inst in self.instruments.values_mut().chain(self.live.instruments.values_mut()) {
            inst.mark_durable_gap();
        }
    }

    pub fn clear(&mut self) {
        self.instruments.clear();
        self.scopes.clear();
        self.live.instruments.clear();
        self.live.scopes.clear();
        self.cursor = 0;
    }

    /// Marks every held partition of a never-stored market as having lost events (the live lane dropped a message, or
    /// B was down): the ones held, whether from the checkpoint or this run. Returns how many.
    pub fn mark_never_stored_gap(&mut self) -> usize {
        let mut marked = 0;
        for (id, inst) in self.instruments.iter_mut() {
            if !stored_per_instrument(&id.source, &id.market) {
                inst.mark_durable_gap();
                marked += 1;
            }
        }
        marked
    }

    /// The live lane lost a message: every unlisted stock may have lost an event of it (never the stored folds).
    pub fn mark_live_only_gap(&mut self) {
        for inst in self.live.instruments.values_mut() {
            inst.mark_durable_gap();
        }
    }

    pub fn is_rolled(&self, scope: &ScopeId) -> bool {
        self.rolled.get(&family(&scope.source, &scope.market, &scope.session)).is_some_and(|cutoff| scope.trading_date < *cutoff)
    }

    /// Whether `e` belongs to a rolled-over partition or a cleared moment (skipped by `apply`, and by the feature fold).
    pub fn is_rolled_event(&self, e: &MarketEvent) -> bool {
        self.is_rolled(&ScopeId::of(e)) || self.is_cleared_event(e)
    }

    fn is_cleared_event(&self, e: &MarketEvent) -> bool {
        e.exchange_ts_ns > 0 && self.cleared.get(&clear_family(&e.provider, &e.market)).is_some_and(|before| e.exchange_ts_ns < *before)
    }

    /// Drop the scopes `gone` names, with their partitions, from the stored fold and the overlay. Returns how many
    /// partitions (scopes) left; only the stored ones count in `Stats`.
    fn retire(&mut self, gone: impl Fn(&ScopeId, &Scope) -> bool) -> usize {
        let stored: Vec<ScopeId> = self.scopes.iter().filter(|(s, scope)| gone(s, scope)).map(|(s, _)| s.clone()).collect();
        for scope in &stored {
            self.scopes.remove(scope);
            self.instruments.retain(|id, _| id.scope() != *scope);
            self.stats.retired_partitions += 1;
        }
        let shown: Vec<ScopeId> = self.live.scopes.iter().filter(|(s, scope)| gone(s, scope)).map(|(s, _)| s.clone()).collect();
        for scope in &shown {
            self.live.scopes.remove(scope);
            self.live.instruments.retain(|id, _| id.scope() != *scope);
        }
        stored.len() + shown.iter().filter(|s| !stored.contains(s)).count()
    }

    /// Market Runtime emptied whole families (Futu crypto at New York 00:00): every partition of the family whose
    /// newest market time is before the moment leaves. Returns how many left.
    pub fn clear_families(&mut self, cleared: &BTreeMap<String, i64>) -> usize {
        for (family, before) in cleared {
            let entry = self.cleared.entry(family.clone()).or_insert(0);
            if *before > *entry {
                *entry = *before;
            }
        }
        let known = self.cleared.clone();
        self.retire(|s, scope| known.get(&clear_family(&s.source, &s.market)).is_some_and(|before| scope.market_ns < *before))
    }

    /// Market Runtime's session rollover: the cutoffs only move forward; every partition now before its cutoff is
    /// dropped. Returns how many partitions left.
    pub fn rollover(&mut self, rolled: &BTreeMap<String, String>) -> usize {
        for (family, date) in rolled {
            let entry = self.rolled.entry(family.clone()).or_default();
            if *date > *entry {
                entry.clone_from(date);
            }
        }
        let cutoffs = self.rolled.clone();
        self.retire(|s, _| cutoffs.get(&family(&s.source, &s.market, &s.session)).is_some_and(|cutoff| s.trading_date < *cutoff))
    }

    /// Projection items for dirty blocks (or every block when `full`), per partition: the stored folds' and the
    /// overlay's (LiveOverlay). The overlay's partition is the one published; a stored fold the overlay shows in its
    /// place is still projected, for its rule events' archive only. `signals` is the live model-signal book (None for
    /// a replay, whose predictions never enter it): a rule event triggering now records the instrument's predictions
    /// of this moment.
    pub fn collect(&mut self, full: bool, watermark: u64, signals: Option<&SignalBook>) -> Vec<Collected> {
        self.collect_as(full, watermark, signals, false)
    }

    /// What a replay timeline's step publishes: a `collect(false, watermark, None)` whose flow items leave out a large-order
    /// list that is the same as the one they last sent (`Instrument::flow_wire`).
    pub fn collect_step(&mut self, watermark: u64) -> Vec<Collected> {
        self.collect_as(false, watermark, None, true)
    }

    fn collect_as(&mut self, full: bool, watermark: u64, signals: Option<&SignalBook>, step: bool) -> Vec<Collected> {
        let ctx = Projecting { cal: &self.cal, rules: &self.rules, baselines: &self.baselines, full, watermark, signals, step };
        let mut out: Vec<Collected> = ctx.layer(&mut self.instruments, &self.scopes, None).into_iter()
            .map(|(id, items)| Collected { shown: !self.live.instruments.contains_key(&id), stored: true, id, items }).collect();
        out.extend(ctx.layer(&mut self.live.instruments, &self.live.scopes, Some(&self.instruments)).into_iter()
            .map(|(id, items)| Collected { id, items, shown: true, stored: false }));
        out
    }

    /// Checkpoint form: aggregates only (prints folded), exactly at `cursor` -- the stored folds alone.
    pub fn checkpoint_view(&self) -> Engine {
        Engine {
            cal: self.cal.clone(), rules: self.rules.clone(),
            instruments: self.instruments.iter().map(|(k, v)| (k.clone(), v.checkpoint_view())).collect(),
            scopes: self.scopes.clone(), stats: self.stats.clone(), cursor: self.cursor, baselines: self.baselines.clone(),
            rolled: self.rolled.clone(), cleared: self.cleared.clone(), subscribed: self.subscribed.clone(), coverage_epoch: self.coverage_epoch.clone(),
            live: LiveOverlay::default(), live_joined_late_ns: None,
        }
    }

    pub fn summary(&self) -> Value {
        json!({"instruments": self.instruments.len(), "scopes": self.scopes.len(), "cursor": self.cursor, "stats": self.stats,
               "live_only": {"partitions": self.live.instruments.len(), "scopes": self.live.scopes.len(), "events": self.live.events},
               "rules": self.rules.version_label(), "calendar": self.cal.version})
    }
}

/// The market second an event moves its scope's market time to, when it carries one: an exchange-stamped event, or a
/// clock (Market Runtime's market time without a print).
fn market_second(e: &MarketEvent) -> Option<i64> {
    ((e.time_quality == "exchange" || e.code == CLOCK_CODE) && e.exchange_ts_ns > 0).then(|| e.exchange_ts_ns.div_euclid(1_000_000_000))
}

/// The rule events of every partition in `scope_id` whose pending second market time has now passed
/// (events::evaluate_pending): run before the event at `now_second` applies, so a partition is evaluated with exactly
/// the data it held at the end of that second, live and in a replay alike. `beneath`: the stored folds under an
/// overlay, where a partition's previous partition is found when the overlay holds none.
#[allow(clippy::too_many_arguments)]
fn evaluate_passed(instruments: &mut BTreeMap<InstrumentId, Instrument>, beneath: Option<&BTreeMap<InstrumentId, Instrument>>, cal: &Calendar,
                   rules: &RuleSet, baselines: &crate::baseline::Store, scope_id: &ScopeId, now_second: i64, watermark: u64) {
    let due: Vec<InstrumentId> = instruments.iter()
        .filter(|(k, i)| k.source == scope_id.source && k.market == scope_id.market && k.trading_date == scope_id.trading_date
            && k.session == scope_id.session && i.events.pending_second.is_some_and(|s| s < now_second))
        .map(|(k, _)| k.clone()).collect();
    for id in due {
        let Some(mut inst) = instruments.remove(&id) else { continue };
        let previous = previous_partition_in(instruments, &id).or_else(|| beneath.and_then(|b| previous_partition_in(b, &id)));
        let usual = inst.volume_compare_applies().then(|| baselines.month_for_date(&id.source, &id.trading_date)).flatten();
        let changed = events::evaluate_pending(&mut inst, cal, rules, previous, watermark, usual.as_deref());
        inst.projection.dirty.events.extend(changed);
        instruments.insert(id, inst);
    }
}

/// The partition `e` applied to has data at `second` not evaluated yet.
fn mark_pending(instruments: &mut BTreeMap<InstrumentId, Instrument>, e: &MarketEvent, second: i64) {
    if let Some(inst) = instruments.get_mut(&InstrumentId::of(e)) {
        inst.events.pending_second = Some(inst.events.pending_second.map_or(second, |s| s.max(second)));
    }
}

fn market_time_in(scopes: &BTreeMap<ScopeId, Scope>, instruments: &BTreeMap<InstrumentId, Instrument>, id: &InstrumentId) -> i64 {
    let scope = scopes.get(&id.scope()).map(|s| s.market_ns).unwrap_or(0);
    let own = instruments.get(id).and_then(|i| i.price.last_price.map(|(_, ts, _)| ts)).unwrap_or(0);
    scope.max(own)
}

fn previous_partition_in<'a>(instruments: &'a BTreeMap<InstrumentId, Instrument>, id: &InstrumentId) -> Option<&'a Instrument> {
    instruments.range(..id.clone()).rev()
        .find(|(k, _)| k.source == id.source && k.market == id.market && k.code == id.code && k.session == id.session && k.trading_date < id.trading_date)
        .map(|(_, v)| v)
}

/// What one `Engine::collect` projects with.
struct Projecting<'a> {
    cal: &'a Calendar,
    rules: &'a RuleSet,
    baselines: &'a crate::baseline::Store,
    full: bool,
    watermark: u64,
    signals: Option<&'a SignalBook>,
    /// A replay timeline's step (`Engine::collect_step`).
    step: bool,
}

impl Projecting<'_> {
    /// One layer's items, one list per partition. `beneath`: the stored folds under an overlay, where a partition's
    /// previous partition is found when the overlay holds none.
    fn layer(&self, instruments: &mut BTreeMap<InstrumentId, Instrument>, scopes: &BTreeMap<ScopeId, Scope>,
             beneath: Option<&BTreeMap<InstrumentId, Instrument>>) -> Vec<(InstrumentId, Vec<Value>)> {
        let (cal, rules, full, watermark) = (self.cal, self.rules, self.full, self.watermark);
        let ids: Vec<InstrumentId> = instruments.iter().filter(|(_, i)| full || i.projection.dirty.any()).map(|(k, _)| k.clone()).collect();
        let mut out = Vec::new();
        for id in ids {
            let t = market_time_in(scopes, instruments, &id);
            // The partition is taken out of the map while it is projected, so the previous partition, the calendar and
            // the rules are read in place beside it: nothing of either partition is copied.
            let Some(mut current) = instruments.remove(&id) else { continue };
            let inst = &mut current;
            let previous = previous_partition_in(instruments, &id).or_else(|| beneath.and_then(|b| previous_partition_in(b, &id)));
            let config_version = json!(format!("{}|{}", rules.version_label(), cal.version));
            let mut items = Vec::new();
            let identity = id.identity();
            // The rule events were evaluated as the data applied (Engine::apply, events::evaluate_pending). What a
            // live publish adds is the model's predictions to the events created since the last one: what the model
            // says at the moment they are shown. A replay has no predictions to add.
            let created = std::mem::take(&mut inst.events.awaiting_model);
            if let Some(book) = self.signals.filter(|_| !created.is_empty()) {
                if let Some(model) = book.at_trigger(&id.source, &id.market, &id.trading_date, &id.session, &id.code) {
                    for event_id in created {
                        if let Some(record) = inst.events.records.get_mut(&event_id).filter(|r| r.model_predictions.is_none()) {
                            record.model_predictions = Some(model.clone());
                            inst.projection.dirty.events.insert(event_id);
                        }
                    }
                }
            }
            let mut windows = if t > 0 { inst.windows_wire(cal, rules, t, previous) } else { Value::Null };
            if let Some(obj) = windows.as_object_mut().filter(|o| o.contains_key("windows")) {
                let baseline = inst.volume_compare_applies().then(|| self.baselines.for_date(&id.source, &id.trading_date));
                if let Some(compare) = inst.volume_compare_wire(cal, t, baseline.as_ref()) {
                    obj.insert("volume_compare".into(), compare);
                }
            }
            let completeness = |w: &Value| w.get("windows").and_then(|x| x.get("1")).and_then(|x| x.get("completeness")).cloned().unwrap_or(json!("UNKNOWN"));
            // A full publish carries every minute, so the minutes dirty before it are published by it too: the next
            // publish sends only what changes after (it re-sent the whole day once more).
            let dirty_minutes = std::mem::take(&mut inst.projection.dirty.minutes);
            // A live (non-replay) item of day / flow names only what changed since the last one: the minutes from the
            // earliest changed one on, the ladder rows touched, the large-order list when it moved.
            let changed_from = dirty_minutes.iter().next().copied();
            let dirty_prices = std::mem::take(&mut inst.projection.dirty.prices);
            let minutes: BTreeSet<i32> = if full { inst.minutes.keys().copied().collect() } else { dirty_minutes };
            // `data` goes in by move: json! would copy it whole (to_value), and a block is as large as the session.
            let item = |block: &str, revision: u64, completeness: Value, data: Value| {
                let mut item = json!({"identity": identity, "block": block, "input_watermark": watermark, "revision": revision,
                    "config_version": config_version, "completeness": completeness, "as_of": t.to_string()});
                item["data"] = data;
                item
            };
            if !minutes.is_empty() {
                inst.projection.revisions.minutes += 1;
                let completeness = if inst.minutes.values().any(|m| m.quality.name() == "MISSING") { "PARTIAL" } else { "COMPLETE" };
                let mut data = json!({"replace": full});
                data["minutes"] = Value::Array(inst.minutes_wire(cal, rules, &minutes));
                items.push(item("minutes", inst.projection.revisions.minutes, json!(completeness), data));
            }
            if (full || inst.projection.dirty.windows) && !windows.is_null() {
                inst.projection.revisions.windows += 1;
                let completeness = completeness(&windows);
                items.push(item("windows", inst.projection.revisions.windows, completeness, windows));
            }
            if (full || inst.projection.dirty.day) && t > 0 {
                inst.projection.revisions.day += 1;
                let listed = Listed::default();
                let inc = (!self.step).then(|| Increment { whole: full || inst.projection.dirty.day_whole, frame: inst.projection.day_frame,
                    from: changed_from, prices: &dirty_prices, listed: &listed });
                let (day, frame) = inst.day_wire(cal, rules, t, previous, inc.as_ref());
                if !self.step {
                    inst.projection.day_frame = frame;
                    inst.projection.dirty.day_whole = false;
                }
                let completeness = if day["volume_complete"] == true { "COMPLETE" } else { "PARTIAL" };
                items.push(item("day", inst.projection.revisions.day, json!(completeness), day));
            }
            if (full || inst.projection.dirty.flow) && t > 0 {
                inst.projection.revisions.flow += 1;
                let unchanged = self.step.then_some(&inst.projection.large_orders_listed);
                let held = inst.projection.large_orders_listed.clone();
                let no_prices = BTreeSet::new();
                let inc = (!self.step).then(|| Increment { whole: full || inst.projection.dirty.flow_whole, frame: inst.projection.flow_frame,
                    from: changed_from, prices: &no_prices, listed: &held });
                let (flow, listed, frame) = inst.flow_wire(cal, rules, t, previous, unchanged, inc.as_ref());
                inst.projection.large_orders_listed = listed;
                if !self.step {
                    inst.projection.flow_frame = frame;
                    inst.projection.dirty.flow_whole = false;
                }
                let completeness = flow["availability"].clone();
                items.push(item("flow", inst.projection.revisions.flow, completeness, flow));
            }
            if full || !inst.projection.dirty.events.is_empty() {
                let replace = full || inst.projection.dirty.events.contains("*");
                let changed: Vec<Value> = if replace { inst.events.wire() } else {
                    inst.projection.dirty.events.iter().filter_map(|id| inst.events.records.get(id)).map(events::EventRecord::wire).collect()
                };
                inst.projection.revisions.events += 1;
                let mut data = json!({"replace": replace});
                data["events"] = Value::Array(changed);
                items.push(item("events", inst.projection.revisions.events, json!("COMPLETE"), data));
            }
            inst.projection.dirty.windows = false;
            inst.projection.dirty.day = false;
            inst.projection.dirty.flow = false;
            inst.projection.dirty.events.clear();
            instruments.insert(id.clone(), current);
            if !items.is_empty() {
                out.push((id, items));
            }
        }
        out
    }
}

/// Maps with structured keys travel as [key, value] lists (JSON object keys must be strings).
mod pairs {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;

    pub fn serialize<K: Serialize, V: Serialize, S: Serializer>(map: &BTreeMap<K, V>, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(map.iter())
    }

    pub fn deserialize<'de, K: Deserialize<'de> + Ord, V: Deserialize<'de>, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<K, V>, D::Error> {
        Ok(Vec::<(K, V)>::deserialize(d)?.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accum::tests::{rules as flow_rules, trade_at, ts};
    use market_runtime::event::{EventFlags, COVERAGE_CONTROL, COVERAGE_SUBSCRIBED};

    fn clock(seq: u64, minute: i32) -> MarketEvent {
        let mut e = trade_at(seq, minute, 5, 0, 0, 0);
        e.code = CLOCK_CODE.into();
        e.symbol = "shioaji:STK:*".into();
        e.time_quality = "backend_clock".into();
        e.flags = EventFlags::default();
        e.payload = Payload::Clock { minute };
        e
    }

    fn coverage(seq: u64, minute: i32, trading_date: &str, state: &str, quality: &str) -> MarketEvent {
        let mut e = trade_at(seq, minute, 0, 0, 0, 0);
        e.trading_date = trading_date.into();
        e.time_quality = quality.into();
        e.payload = Payload::SourceStatus { state: state.into(), detail: String::new() };
        e
    }

    #[test]
    fn coverage_is_a_subscription_across_sessions_and_never_creates_one() {
        // A coverage record marks a subscription across sessions and never creates a session.
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        // Market Runtime's record, dated to the next business session, creates nothing either -- it is a subscription.
        engine.apply(&coverage(2, 480, "2026-09-29", COVERAGE_SUBSCRIBED, COVERAGE_CONTROL));
        assert!(engine.instruments.is_empty() && engine.scopes.is_empty());
        assert!(engine.subscribed.contains_key("shioaji|STK|2330"));
        // The day's first print comes at 10:00: the partition it creates is covered from the open, so 09:30 with no
        // print is "no trade", not "missing".
        engine.apply(&trade_at(3, 600, 5, 1_000_000, 1, 1));
        engine.apply(&clock(4, 603));
        let inst = engine.instruments.values().next().unwrap();
        assert_eq!(inst.cover.coverage.first(), Some(&(-1, None)));
        // Unsubscribed at 10:05: a held partition's coverage closes at that minute.
        engine.apply(&coverage(5, 605, "2026-09-29", "unsubscribed", COVERAGE_CONTROL));
        let inst = engine.instruments.values().next().unwrap();
        assert_eq!(inst.cover.coverage.last(), Some(&(-1, Some(605))));
        assert!(!engine.subscribed.contains_key("shioaji|STK|2330"));
        // The subscription survives a checkpoint.
        engine.apply(&coverage(6, 606, "2026-09-29", COVERAGE_SUBSCRIBED, COVERAGE_CONTROL));
        let restored: Engine = serde_json::from_value(serde_json::to_value(engine.checkpoint_view()).unwrap()).unwrap();
        assert!(restored.subscribed.contains_key("shioaji|STK|2330"));
    }

    #[test]
    fn a_restarted_market_runtime_ends_what_only_the_old_epoch_confirmed() {
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        let sub = |seq: u64, code: &str, minute: i32, epoch: u64, state: &str| {
            let mut e = coverage(seq, minute, "2026-09-29", state, COVERAGE_CONTROL);
            e.code = code.into();
            e.generation = epoch;
            e
        };
        engine.apply(&sub(1, "2330", 500, 1, COVERAGE_SUBSCRIBED));
        engine.apply(&sub(2, "2317", 500, 1, COVERAGE_SUBSCRIBED));
        engine.apply(&trade_at(3, 600, 5, 1_000_000, 1, 1));
        // Market Runtime restarts (epoch 2); its first report confirms only 2317.
        engine.apply(&sub(4, "2317", 610, 2, COVERAGE_SUBSCRIBED));
        assert!(!engine.subscribed.contains_key("shioaji|STK|2330"), "2330 was confirmed by the old epoch only");
        assert_eq!(engine.subscribed.get("shioaji|STK|2317"), Some(&2));
        let inst = engine.instruments.values().find(|i| i.id.code == "2330").unwrap();
        assert_eq!(inst.cover.coverage.last(), Some(&(-1, Some(610))), "2330's partition stops being observed at the restart");
    }

    #[test]
    fn a_quiet_market_still_gets_every_minute_through_the_clock_and_replay_is_identical() {
        let cal = Calendar::default();
        let mut live = Engine::new(cal.clone(), flow_rules());
        let events = vec![trade_at(1, 600, 5, 1_000_000, 1, 1), clock(2, 601), clock(3, 602), clock(4, 603), trade_at(5, 603, 10, 1_001_000, 2, 1), clock(6, 604)];
        for e in &events {
            live.apply(e);
        }
        let inst = live.instruments.values().next().unwrap();
        assert_eq!(inst.minutes[&601].quality.name(), "NO_TRADE_SYNTHETIC");
        assert!(inst.minutes[&603].finalized);
        let mut replay = Engine::new(cal, flow_rules());
        for e in &events {
            replay.apply(e);
        }
        let a = serde_json::to_value(live.checkpoint_view()).unwrap();
        let b = serde_json::to_value(replay.checkpoint_view()).unwrap();
        assert_eq!(a, b, "live and replay produce the same state");
    }

    #[test]
    fn a_lagged_clock_naming_the_previous_days_minute_never_finalizes_the_new_day() {
        // A print opened the new partition at 00:00, then a clock stamped 00:00:01 carried minute 1439.
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        // The first print of the day at 00:00:00: market time minus the late allowance is yesterday 23:59.
        engine.apply(&trade_at(1, 0, 0, 1_000_000, 1, 1));
        assert!(!engine.instruments.values().next().unwrap().minutes.contains_key(&600), "a midnight print finalizes nothing of the new day");
        engine.apply(&trade_at(1, 600, 5, 1_000_000, 1, 1));
        let mut stale = clock(2, 600);
        stale.payload = Payload::Clock { minute: 1439 };
        engine.apply(&stale);
        let inst = engine.instruments.values().next().unwrap();
        assert!(!inst.minutes.contains_key(&700), "no future minute is synthesized");
        assert!(!inst.minutes.get(&600).is_some_and(|m| m.finalized), "the open minute is still open");
        engine.apply(&clock(3, 602));
        assert!(engine.instruments.values().next().unwrap().minutes[&600].finalized, "a real clock still advances");
    }

    #[test]
    fn a_clock_from_before_the_partitions_day_never_finalizes_it() {
        // Futu stamps a minute bar with the minute's end: its "00:00" bar opened the new partition at 23:59 the day
        // before, and the clock that followed (stamped 23:59:30 of that day) carried 1439.
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        engine.apply(&trade_at(1, 0, 0, 1_000_000, 1, 1));
        let mut early = clock(2, 0);
        early.exchange_ts_ns -= 35 * 1_000_000_000;
        early.payload = Payload::Clock { minute: 1439 };
        engine.apply(&early);
        let inst = engine.instruments.values().next().unwrap();
        assert!(!inst.minutes.contains_key(&600), "no minute of the new day is synthesized");
        assert_eq!(inst.cover.materialized_through, -1, "nothing of the new day is finalized");
        engine.apply(&trade_at(3, 600, 5, 1_000_000, 1, 1));
        engine.apply(&clock(4, 602));
        assert!(engine.instruments.values().next().unwrap().minutes[&600].finalized, "a clock of the day still advances");
    }

    #[test]
    fn a_futures_night_partition_holds_only_night_minutes_through_midnight() {
        // FUT is partitioned per business session. A NIGHT partition's clock finalized the DAY
        // session's 08:45-13:45 into it as no-trade minutes: the calendar of a partition is its own session only.
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        // The producer names the NIGHT partition (dated by its open) and the minute continued past 1440.
        let fut = |mut e: MarketEvent| {
            e.market = "FUT".into();
            e.code = if e.code == CLOCK_CODE { CLOCK_CODE.into() } else { "TXFR1".into() };
            e.symbol = format!("shioaji:FUT:{}", e.code);
            e.session = "NIGHT".into();
            e
        };
        engine.apply(&fut(trade_at(1, 900, 5, 2_000_000, 1, 1)));
        engine.apply(&fut(clock(2, 1000)));
        engine.apply(&fut(trade_at(3, 1470, 5, 2_010_000, 1, 1))); // 00:30 the next day
        engine.apply(&fut(clock(4, 1480)));
        assert_eq!(engine.instruments.len(), 1, "one partition for the whole night");
        let inst = engine.instruments.values().next().unwrap();
        assert_eq!((inst.id.trading_date.as_str(), inst.id.session.as_str()), ("2026-09-29", "NIGHT"));
        assert!(inst.minutes.keys().all(|m| (900..=1740).contains(m)), "no DAY minute in a NIGHT partition: {:?}",
            inst.minutes.keys().take(3).collect::<Vec<_>>());
        assert!(inst.minutes.contains_key(&1470) && inst.minutes[&999].finalized, "the night continues past midnight");
    }

    #[test]
    fn projection_items_carry_identity_watermark_and_revision_and_a_full_publish_replaces() {
        let cal = Calendar::default();
        let mut engine = Engine::new(cal, flow_rules());
        engine.apply(&trade_at(1, 600, 5, 1_000_000, 1, 1));
        let items = engine.collect(false, 1, None);
        let blocks: Vec<&str> = items[0].items.iter().map(|i| i["block"].as_str().unwrap()).collect();
        assert!(blocks.contains(&"minutes") && blocks.contains(&"windows") && blocks.contains(&"day") && blocks.contains(&"flow"));
        assert!(items[0].items.iter().all(|i| i["input_watermark"] == 1 && i["identity"]["code"] == "2330"));
        assert!(engine.collect(false, 1, None).is_empty(), "nothing dirty, nothing sent");
        let full = engine.collect(true, 1, None);
        let minutes = full[0].items.iter().find(|i| i["block"] == "minutes").unwrap();
        assert_eq!(minutes["data"]["replace"], true);
    }

    #[test]
    fn live_day_and_flow_items_name_only_what_changed_after_the_first() {
        // Every publish sent the whole session's minute series, K bars and price ladder of every changed instrument:
        // 11-05 13:00-14:00 that was 4.8 GB of flow and 1.7 GB of day items, merged by Market Runtime and pushed to
        // every screen four times a second. After the first item, a live one names only what changed.
        let cal = Calendar::default();
        let mut engine = Engine::new(cal, flow_rules());
        for (seq, minute) in [(1, 600), (2, 601), (3, 602), (4, 603)] {
            engine.apply(&trade_at(seq, minute, 5, 1_000_000 + seq as i64 * 10_000, 1, 1));
        }
        let block = |items: &[Collected], name: &str| items[0].items.iter().find(|i| i["block"] == name).map(|i| i["data"].clone());
        let first = engine.collect(false, 4, None);
        let (day, flow) = (block(&first, "day").unwrap(), block(&first, "flow").unwrap());
        assert_eq!((day["replace"].clone(), flow["replace"].clone()), (json!(true), json!(true)), "the first item of a frame is whole");
        assert!(flow["minuteSeries"].as_array().unwrap().len() >= 4);
        let first_buckets = day["price_volume"]["buckets"].as_array().unwrap().len();
        assert_eq!(first_buckets, 4);

        engine.apply(&trade_at(5, 603, 30, 1_040_000, 2, 1));
        let next = engine.collect(false, 5, None);
        let (day, flow) = (block(&next, "day").unwrap(), block(&next, "flow").unwrap());
        assert_eq!((day["replace"].clone(), flow["replace"].clone()), (json!(false), json!(false)), "an increment");
        let minutes: Vec<i64> = flow["minuteSeries"].as_array().unwrap().iter().map(|r| r["minute"].as_i64().unwrap()).collect();
        assert_eq!(minutes, vec![603], "only the minute that changed, with its running total");
        assert_eq!(flow["minuteSeries"][0]["cumulative"]["small"]["buy"].as_f64(), Some(6.0), "the running total still counts every minute");
        assert!(flow.get("largeOrders").is_none(), "an unchanged large-order list is left out");
        let buckets: Vec<f64> = day["price_volume"]["buckets"].as_array().unwrap().iter().map(|b| b["price"].as_f64().unwrap()).collect();
        assert_eq!(buckets, vec![104.0], "only the ladder row the print touched");
        assert!(day["fixed_k"]["k5"].as_array().unwrap().iter().all(|b| b["end_minute"].as_i64().unwrap() >= 603),
            "only the K bars holding the changed minute: {}", day["fixed_k"]["k5"]);
        assert_eq!(day["volume"].as_f64(), Some(6.0), "the header is always whole");

        // A new full publish (a reconnect, a new epoch) and an item Market Runtime did not take go whole again.
        let full = engine.collect(true, 5, None);
        assert_eq!(block(&full, "flow").unwrap()["replace"], json!(true));
        engine.shown_mut(&next[0].id).unwrap().projection.dirty.flow = true;
        engine.shown_mut(&next[0].id).unwrap().projection.dirty.flow_whole = true;
        assert_eq!(block(&engine.collect(false, 5, None), "flow").unwrap()["replace"], json!(true));
    }

    #[test]
    fn checkpoint_restore_resumes_the_aggregates_and_new_prints_merge_into_them() {
        let cal = Calendar::default();
        let mut engine = Engine::new(cal.clone(), flow_rules());
        engine.apply(&trade_at(1, 600, 5, 1_000_000, 5, 1));
        engine.apply(&trade_at(2, 600, 20, 1_020_000, 150, -1));
        let text = serde_json::to_string(&engine.checkpoint_view()).unwrap();
        let mut restored: Engine = serde_json::from_str(&text).unwrap();
        restored.cal = cal;
        restored.rules = flow_rules();
        restored.apply(&trade_at(3, 600, 30, 990_000, 1, 1));
        let m = &restored.instruments.values().next().unwrap().minutes[&600];
        assert_eq!((m.open, m.high, m.low, m.close, m.volume), (Some(1_000_000), Some(1_020_000), Some(990_000), Some(990_000), Some(156.0)));
        assert_eq!(m.flow.large.sell, 150.0);
        let _ = ts(0, 0);
    }

    #[test]
    fn a_rollover_drops_the_old_session_survives_a_checkpoint_and_skips_its_late_events() {
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        engine.apply(&trade_at(1, 600, 5, 1_000_000, 1, 1));
        assert_eq!(engine.instruments.len(), 1);
        let rolled = BTreeMap::from([("shioaji|STK|DAY".to_string(), "2026-09-30".to_string())]);
        assert_eq!(engine.rollover(&rolled), 1);
        assert!(engine.instruments.is_empty() && engine.scopes.is_empty());
        // A late event of the rolled day (B rebuilding from the WAL) does not bring it back.
        let late = trade_at(2, 601, 5, 1_000_000, 1, 1);
        assert!(engine.is_rolled_event(&late));
        engine.apply(&late);
        assert!(engine.instruments.is_empty());
        assert_eq!(engine.cursor, 2, "the cursor still moves past it");
        let restored: Engine = serde_json::from_value(serde_json::to_value(engine.checkpoint_view()).unwrap()).unwrap();
        assert_eq!(restored.rolled, engine.rolled);
    }

    #[test]
    fn crypto_is_cleared_whole_at_a_moment_and_its_late_events_skipped() {
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        let mut print = trade_at(1, 600, 5, 650_000_000, 1, 1);
        (print.provider, print.market, print.code, print.session) = ("futu".into(), "CC".into(), "CC.BTCUSD".into(), "FULL".into());
        print.durable_sequence = 0;
        engine.apply(&print);
        engine.apply(&trade_at(2, 600, 5, 1_000_000, 1, 1));
        assert_eq!(engine.scopes.len(), 2);
        let moment = print.exchange_ts_ns + 1;
        assert_eq!(engine.clear_families(&BTreeMap::from([("futu|CC".to_string(), moment)])), 1);
        assert_eq!(engine.scopes.len(), 1, "only crypto left");
        assert!(engine.is_rolled_event(&print), "a late crypto event from before the clear is skipped");
        assert_eq!(engine.cursor, 2, "the live lane never moved the durable cursor");
    }

    #[test]
    fn the_live_lane_names_how_each_event_is_kept_and_an_older_runtime_is_read_by_its_market() {
        assert_eq!(Lane::live(Some(LIVE_UNLISTED), "futu", "CC"), Lane::Unlisted, "what Market Runtime names wins");
        assert_eq!(Lane::live(Some(LIVE_NEVER_STORED), "futu", "CC"), Lane::NeverStored);
        assert_eq!(Lane::live(None, "futu", "CC"), Lane::NeverStored, "a Market Runtime before 10-27: crypto");
        assert_eq!(Lane::live(None, "shioaji", "STK"), Lane::Unlisted, "... and an unlisted stock");
        assert_eq!(Lane::live(Some("newer"), "futu", "CC"), Lane::Unlisted, "an unknown class is written nowhere");
    }

    #[test]
    fn an_unlisted_stock_is_published_from_its_overlay_and_its_stored_fold_archived_only() {
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        let mut live = trade_at(0, 600, 5, 1_000_000, 1, 1);
        live.sequence = 1;
        engine.apply_live_only(&live);
        engine.apply(&trade_at(2, 601, 5, 1_010_000, 1, 1));
        let collected = engine.collect(false, 2, None);
        let flags: Vec<(bool, bool)> = collected.iter().map(|c| (c.shown, c.stored)).collect();
        assert_eq!(flags, vec![(false, true), (true, false)], "the stored fold for the archive, the overlay for the screens");
        // A returned item marks the partition the screens see, never the stored fold under it.
        let id = collected[1].id.clone();
        engine.shown_mut(&id).unwrap().projection.dirty.day = true;
        assert!(engine.live.instruments[&id].projection.dirty.day && !engine.instruments[&id].projection.dirty.day);
        assert!(engine.instruments[&id].minutes.get(&600).is_none_or(|m| m.quality.name() != "TRADED"), "the live print is the overlay's only");
        assert_eq!(engine.live.instruments[&id].minutes[&600].quality.name(), "TRADED");
    }

    #[test]
    fn partitions_leave_only_by_market_runtimes_rollover() {
        // Only Market Runtime's cutoffs (the one calendar owner) remove a partition, never B on its own (it once retired
        // partitions two calendar days behind the newest one), so A and B never disagree.
        let mut engine = Engine::new(Calendar::default(), flow_rules());
        let mut friday = trade_at(1, 600, 5, 2_300_000, 1, 1);
        (friday.provider, friday.market, friday.code, friday.session, friday.trading_date) =
            ("futu".into(), "US".into(), "US.AAPL".into(), "FULL".into(), "2026-10-02".into());
        let mut wednesday = friday.clone();
        (wednesday.durable_sequence, wednesday.sequence, wednesday.trading_date) = (2, 2, "2026-10-07".into());
        engine.apply(&friday);
        engine.apply(&wednesday);
        assert_eq!(engine.scopes.len(), 2, "five calendar days apart, and still held: no cutoff named Friday");
        assert_eq!(engine.rollover(&BTreeMap::from([("futu|US|FULL".to_string(), "2026-10-05".to_string())])), 1);
        assert_eq!(engine.scopes.len(), 1);
    }

    #[test]
    fn rule_events_follow_the_data_so_a_replay_keeps_what_live_triggered_within_a_minute() {
        // 11-10: a 1-minute drop that spiked and came back within its minute was shown live; B restarted, replayed the
        // day publishing once, and the event was gone (299 such events). Events are now evaluated as the data applies,
        // so publishing after every print and publishing once after the tape hold the same events.
        let mut rules = flow_rules();
        rules.event_revision = Some(3);
        rules.events = vec![crate::rules::EventRule { rule_id: "win1_up".into(), kind: "window_move".into(), matcher: crate::rules::Match::default(),
            label: "1分急漲".into(), direction: Some("up".into()), priority: 300, window: Some(1), threshold_pct: Some(0.8),
            reset_ratio: None, active_minutes: None, exclude_minutes: vec![], enabled: true }];
        let tape = [trade_at(1, 600, 5, 1_000_000, 1, 1), trade_at(2, 601, 5, 1_000_000, 1, 1),
            trade_at(3, 602, 10, 1_010_000, 1, 1), // +1.0% against 10:01's close ...
            trade_at(4, 602, 20, 1_000_000, 1, 1), // ... and back within the minute
            trade_at(5, 603, 5, 1_000_000, 1, 1), clock(6, 604)];
        let ids = |engine: &Engine| engine.instruments.values().flat_map(|i| i.events.wire()).map(|r| r["event_id"].as_str().unwrap().to_string()).collect::<Vec<_>>();

        let mut live = Engine::new(Calendar::default(), rules.clone());
        for e in &tape {
            live.apply(e);
            live.collect(false, e.durable_sequence, None);
        }
        let mut replay = Engine::new(Calendar::default(), rules);
        for e in &tape {
            replay.apply(e);
        }
        replay.collect(true, 6, None);

        assert_eq!(ids(&live), vec!["win1_up:3:2330:2026-09-29:DAY:602".to_string()], "the spike triggered");
        assert_eq!(ids(&replay), ids(&live), "a replay published once keeps it");
        let triggered = |engine: &Engine| engine.instruments.values().flat_map(|i| i.events.wire()).map(|r| r["triggered_at_ns"].clone()).collect::<Vec<_>>();
        assert_eq!(triggered(&live), vec![json!((ts(602, 10) + 999_999_999).to_string())], "the second it triggered in, from the data");
        assert_eq!(triggered(&replay), triggered(&live));
        // Nothing is evaluated before market time has passed a second: its later prints may still come.
        let mut early = Engine::new(Calendar::default(), live.rules.clone());
        for e in &tape[..3] {
            early.apply(e);
        }
        early.collect(false, 3, None);
        assert!(ids(&early).is_empty(), "10:02:10 is still open");
    }
}
