//! DemandManager: the one subscription plan per source (docs/system-architecture/01 section 3).
//!
//! Inputs: the background list (versioned by settings_api, applied here), view subscriptions, workspaces and the
//! focus. Output: one `adapter.subscription.replace` plan per provider, and a per-instrument status that shows the
//! three states Settings must tell apart: desired, planned by A, actually subscribed by the source.
//!
//! Closing a view never removes an instrument that is still on the background list. Background items are planned
//! first into the source quota minus a reserve kept for what the user is looking at; anything that does not fit is
//! reported as QUOTA_EXCEEDED, never silently claimed as maintained.

use crate::event::{InstrumentKey, MarketEvent};
use crate::rollover::{never_stored, stored_per_instrument};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::num::NonZeroUsize;
use std::sync::Arc;

/// The lanes an instrument can be subscribed with (config/background_list.py KINDS). An unknown name fails to parse.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Quote,
    Trade,
    Orderbook,
}

/// Most instruments one background list may hold (config/background_list.py MAX_ITEMS).
pub const MAX_BACKGROUND_ITEMS: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct BackgroundItem {
    pub source: String,
    pub market: String,
    pub code: String,
    /// Absent: every kind. Present: the kinds asked for, at least one, none twice.
    #[serde(default = "default_kinds")]
    pub kinds: Vec<Kind>,
    /// Who keeps it on the list (product pages, holdings, the market context): shown, never interpreted.
    #[serde(default)]
    pub owners: Vec<String>,
}

fn default_kinds() -> Vec<Kind> {
    vec![Kind::Quote, Kind::Trade, Kind::Orderbook]
}

impl BackgroundItem {
    pub fn instrument(&self) -> InstrumentKey {
        InstrumentKey::new(&self.source, &self.market, &self.code)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct BackgroundList {
    pub revision: Option<u64>,
    pub items: Vec<BackgroundItem>,
}

/// How an event is kept, decided by Market Runtime at ingest from one applied background revision (StoragePolicy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Storage {
    /// Written to the WAL: B reads it from the durable stream, history keeps it.
    Durable,
    /// 盤前試撮 of a stored instrument: shown, never written, never sent to B (user rule).
    Indicative,
    /// An instrument off the background list in a market of individual stocks (a searched stock, a workspace one --
    /// user 10-19): shown and analysed (B gets it over the live lane), never written, never in a checkpoint.
    Unlisted,
    /// A market nothing of is ever written (Futu crypto): shown and analysed over the live lane; its caches are kept
    /// whole (rollover::never_stored).
    NeverStored,
}

/// `live.batch` `storage`: why the events of a live-lane message are not stored (Storage::Unlisted / NeverStored).
pub const LIVE_UNLISTED: &str = "unlisted";
pub const LIVE_NEVER_STORED: &str = "never_stored";

impl Storage {
    /// The live lane's name for it (`live.batch` `storage`). Only the two classes B reads over the live lane.
    pub fn live_lane(self) -> Option<&'static str> {
        match self {
            Self::Unlisted => Some(LIVE_UNLISTED),
            Self::NeverStored => Some(LIVE_NEVER_STORED),
            Self::Durable | Self::Indicative => None,
        }
    }
}

/// Which instruments' events are stored, as of one applied background revision: built whole when a list is applied
/// (`DemandManager::storage_policy`) and swapped in under the lock every ingest classifies under, so each event is
/// classified by exactly one revision, in the order events are applied and sequenced. The background list itself
/// stays in DemandManager for the subscription plan; this is its storage half, never a second list.
#[derive(Debug, Clone, Default)]
pub struct StoragePolicy {
    pub revision: Option<u64>,
    /// The listed instruments (`source:MARKET:CODE`). None while no background revision has been applied: nothing is
    /// known yet, so everything is stored rather than lost.
    listed: Option<Arc<HashSet<String>>>,
}

impl StoragePolicy {
    /// How `event` is kept. A never-stored market never is; in a market of individual stocks only an instrument on
    /// the background list is (the product pages, the holdings, the paper ledger, the market context); indices,
    /// futures and the market context are stored as before. 盤前試撮 of a stored instrument is shown only.
    pub fn classify(&self, event: &MarketEvent) -> Storage {
        if never_stored(&event.provider, &event.market) {
            return Storage::NeverStored;
        }
        let listed = !stored_per_instrument(&event.provider, &event.market)
            || self.listed.as_ref().is_none_or(|listed| listed.contains(&event.symbol));
        match (listed, event.is_preopen_indicative()) {
            (false, _) => Storage::Unlisted,
            (true, true) => Storage::Indicative,
            (true, false) => Storage::Durable,
        }
    }
}

/// `adapter.register` `stream_budget`: a provider whose broker counts streams, not instruments (Shioaji: a stock's
/// Tick and BidAsk are one stream each, an index's Quote one, every futures month's Tick, BidAsk or Quote one) states
/// its capacity in streams and, per market, the streams each kind of an instrument takes (its capability's lanes). An
/// instrument costs the streams of the kinds asked of it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StreamBudgetWire {
    pub streams: usize,
    pub kinds_by_market: BTreeMap<String, BTreeMap<Kind, usize>>,
}

/// A validated stream budget: at least one stream, at least one market, each carrying at least one kind of at least
/// one stream, no market twice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StreamBudget {
    pub streams: NonZeroUsize,
    pub kinds_by_market: BTreeMap<String, BTreeMap<Kind, NonZeroUsize>>,
}

impl StreamBudget {
    pub fn new(wire: StreamBudgetWire) -> Result<Self, String> {
        let streams = NonZeroUsize::new(wire.streams).ok_or("stream_budget.streams must be at least 1")?;
        if wire.kinds_by_market.is_empty() {
            return Err("stream_budget.kinds_by_market must name at least one market".into());
        }
        let mut kinds_by_market = BTreeMap::new();
        for (market, kinds) in wire.kinds_by_market {
            let market = market.trim().to_uppercase();
            if kinds.is_empty() {
                return Err(format!("stream_budget.kinds_by_market.{market} must name at least one kind"));
            }
            let mut costs = BTreeMap::new();
            for (kind, n) in kinds {
                let n = NonZeroUsize::new(n).ok_or_else(|| format!("stream_budget.kinds_by_market.{market}.{kind:?} must be at least 1"))?;
                costs.insert(kind, n);
            }
            if market.is_empty() || kinds_by_market.insert(market.clone(), costs).is_some() {
                return Err(format!("stream_budget.kinds_by_market names {market:?} twice or empty"));
            }
        }
        Ok(Self { streams, kinds_by_market })
    }
}

/// What a provider says it can carry, validated: at least one instrument and at least one kind, none twice; and,
/// for a broker that counts streams, its stream budget. With a budget the plan is billed in streams (each instrument
/// by the streams of its kinds in its market) and `limit` -- the instruments that fit however a plan mixes them -- is
/// not what cuts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterCapacity {
    pub limit: NonZeroUsize,
    pub kinds: BTreeSet<Kind>,
    pub streams: Option<StreamBudget>,
}

impl AdapterCapacity {
    pub fn new(limit: usize, kinds: Vec<Kind>) -> Result<Self, String> {
        let limit = NonZeroUsize::new(limit).ok_or("max_subscriptions must be at least 1")?;
        if kinds.is_empty() {
            return Err("kinds must name at least one kind".into());
        }
        let count = kinds.len();
        let kinds: BTreeSet<Kind> = kinds.into_iter().collect();
        if kinds.len() != count {
            return Err("kinds names a kind twice".into());
        }
        Ok(Self { limit, kinds, streams: None })
    }

    pub fn with_streams(self, budget: StreamBudget) -> Self {
        Self { streams: Some(budget), ..self }
    }

    /// What the plan may spend, in its unit: streams with a budget, instruments without.
    fn total(&self) -> usize {
        self.streams.as_ref().map_or(self.limit.get(), |b| b.streams.get())
    }

    /// The kinds of `kinds` this provider carries for an instrument of `market`, and what they cost in the plan's
    /// unit. None: the budget names no streams for this market, so it is never planned on a guess
    /// (UNSUPPORTED_MARKET). An empty list: none of the kinds asked for is one the market carries (UNSUPPORTED_KINDS).
    fn billed(&self, market: &str, kinds: &[Kind]) -> Option<(Vec<Kind>, usize)> {
        let supported: Vec<Kind> = kinds.iter().filter(|k| self.kinds.contains(*k)).copied().collect();
        match &self.streams {
            None => Some((supported, 1)),
            Some(budget) => {
                let costs = budget.kinds_by_market.get(market)?;
                let carried: Vec<Kind> = supported.into_iter().filter(|k| costs.contains_key(k)).collect();
                let cost = carried.iter().map(|k| costs[k].get()).sum();
                Some((carried, cost))
            }
        }
    }

    /// The most any one instrument costs (every kind of its market): the smallest room the interactive reserve keeps.
    fn largest_cost(&self) -> usize {
        self.streams.as_ref()
            .and_then(|b| b.kinds_by_market.values().map(|kinds| kinds.values().map(|n| n.get()).sum::<usize>()).max())
            .unwrap_or(1)
    }
}

#[derive(Debug, Clone)]
struct Adapter {
    capacity: AdapterCapacity,
    connections: usize,
    planned: Vec<(InstrumentKey, Vec<Kind>)>,
    plan_generation: u64,
    reported_generation: Option<u64>,
    subscribed: BTreeSet<InstrumentKey>,
    failed: BTreeMap<InstrumentKey, String>,
    /// Out of the plan but still held by the broker (an unsubscribe not done yet), as the provider last reported.
    draining: BTreeSet<InstrumentKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Reason {
    Background,
    Focus,
    View,
    Workspace,
}

impl Reason {
    fn name(&self) -> &'static str {
        match self {
            Self::Background => "background",
            Self::Focus => "focus",
            Self::View => "view",
            Self::Workspace => "workspace",
        }
    }
}

pub struct Plan {
    pub source: String,
    pub generation: u64,
    pub items: Vec<(InstrumentKey, Vec<Kind>)>,
}

impl Plan {
    pub fn wire(&self) -> Value {
        json!({"type": "adapter.subscription.replace", "payload": {
            "source": self.source, "generation": self.generation,
            "codes": self.items.iter().map(|(k, _)| k.code.clone()).collect::<Vec<_>>(),
            "items": self.items.iter().map(|(k, kinds)| json!({"market": k.market, "code": k.code, "kinds": kinds}))
                .collect::<Vec<_>>(),
        }})
    }
}

#[derive(Default)]
pub struct DemandManager {
    background: BackgroundList,
    views: HashMap<InstrumentKey, HashMap<u64, u64>>,
    workspaces: HashMap<u64, BTreeSet<InstrumentKey>>,
    /// What the user is looking at, one per source: 即時報價 shows a Shioaji and a Futu product side by side.
    focus: BTreeMap<String, InstrumentKey>,
    adapters: HashMap<String, Adapter>,
    next_generation: u64,
    /// Views opened on an empty partition before their provider could be asked (server::session::request_view_history).
    view_history_waiting: Vec<(InstrumentKey, String, String)>,
    /// Percent of each source's quota kept for focus/views/workspace (the rest may be used by the background list).
    pub view_reserve_percent: usize,
}

impl DemandManager {
    pub fn new() -> Self {
        Self { view_reserve_percent: 20, next_generation: 1, ..Default::default() }
    }

    pub fn background(&self) -> &BackgroundList {
        &self.background
    }

    /// Apply a versioned background list. The names are put in their canonical case first; then the whole list is
    /// validated like config/background_list.py does, and every problem is returned together. Nothing is dropped
    /// or rewritten to make a list fit: a list with a problem is refused whole and the applied one stays. An older
    /// revision than the applied one is refused.
    pub fn replace_background(&mut self, list: BackgroundList) -> Result<(), String> {
        if let (Some(current), Some(incoming)) = (self.background.revision, list.revision) {
            if incoming < current {
                return Err(format!("background revision {incoming} is older than applied {current}"));
            }
        }
        let items: Vec<BackgroundItem> = list.items.into_iter().map(|mut item| {
            item.source = item.source.trim().to_lowercase();
            item.market = item.market.trim().to_uppercase();
            item.code = item.code.trim().to_uppercase();
            item
        }).collect();
        let problems = validate_background(&items);
        if !problems.is_empty() {
            return Err(problems.join("; "));
        }
        self.background = BackgroundList { revision: list.revision, items };
        Ok(())
    }

    pub fn view_opened(&mut self, client: u64, instrument: &InstrumentKey, now_ns: u64) {
        self.views.entry(instrument.clone()).or_default().insert(client, now_ns);
    }

    pub fn view_closed(&mut self, client: u64, instrument: &InstrumentKey) {
        if let Some(clients) = self.views.get_mut(instrument) {
            clients.remove(&client);
            if clients.is_empty() {
                self.views.remove(instrument);
            }
        }
    }

    pub fn set_workspace(&mut self, client: u64, instruments: BTreeSet<InstrumentKey>) {
        self.workspaces.insert(client, instruments);
    }

    /// Set (or, with None, clear) the focus of one source.
    pub fn set_focus(&mut self, source: &str, focus: Option<InstrumentKey>) {
        let source = source.trim().to_lowercase();
        match focus {
            Some(instrument) => {
                self.focus.insert(source, instrument);
            }
            None => {
                self.focus.remove(&source);
            }
        }
    }

    pub fn client_gone(&mut self, client: u64) {
        self.workspaces.remove(&client);
        self.views.retain(|_, clients| {
            clients.remove(&client);
            !clients.is_empty()
        });
    }

    /// A view's partition to ask its provider for once the provider can be asked.
    pub fn wait_view_history(&mut self, entry: (InstrumentKey, String, String)) {
        if !self.view_history_waiting.contains(&entry) {
            self.view_history_waiting.push(entry);
        }
    }

    /// The partitions waiting for `source`'s provider, taken.
    pub fn take_view_history(&mut self, source: &str) -> Vec<(InstrumentKey, String, String)> {
        let (taken, kept) = std::mem::take(&mut self.view_history_waiting).into_iter().partition(|(key, _, _)| key.source.eq_ignore_ascii_case(source));
        self.view_history_waiting = kept;
        taken
    }

    pub fn register_adapter(&mut self, source: &str, capacity: AdapterCapacity) {
        let adapter = self.adapter_entry(source, capacity);
        adapter.connections += 1;
    }

    /// A registered adapter's new capacity, on the same connection: a fresh plan is due.
    pub fn set_adapter_capacity(&mut self, source: &str, capacity: AdapterCapacity) {
        self.adapter_entry(source, capacity);
    }

    /// The source's adapter with `capacity` in force and a fresh plan due.
    fn adapter_entry(&mut self, source: &str, capacity: AdapterCapacity) -> &mut Adapter {
        let adapter = self.adapters.entry(source.to_lowercase()).or_insert_with(|| Adapter {
            capacity: capacity.clone(), connections: 0, planned: Vec::new(), plan_generation: 0, reported_generation: None,
            subscribed: BTreeSet::new(), failed: BTreeMap::new(), draining: BTreeSet::new(),
        });
        adapter.capacity = capacity;
        adapter.plan_generation = 0;
        adapter
    }

    pub fn adapter_disconnected(&mut self, source: &str) {
        if let Some(adapter) = self.adapters.get_mut(source) {
            adapter.connections = adapter.connections.saturating_sub(1);
            if adapter.connections == 0 {
                adapter.subscribed.clear();
                adapter.reported_generation = None;
            }
        }
    }

    /// Whether a provider of `source` is connected (an adapter session is registered).
    pub fn adapter_connected(&self, source: &str) -> bool {
        self.adapters.get(source).is_some_and(|a| a.connections > 0)
    }

    /// The storage half of the applied background list (StoragePolicy): whose events are stored (WAL, checkpoint,
    /// history). A searched stock (focus) or a workspace instrument is shown live and never stored (user 10-19).
    pub fn storage_policy(&self) -> StoragePolicy {
        StoragePolicy {
            revision: self.background.revision,
            listed: self.background.revision.map(|_| Arc::new(self.background.items.iter().map(|i| i.instrument().wire()).collect())),
        }
    }

    /// Everything the engine must keep resident (never evict).
    pub fn pinned(&self) -> BTreeSet<InstrumentKey> {
        let mut out: BTreeSet<InstrumentKey> = self.background.items.iter().map(BackgroundItem::instrument).collect();
        out.extend(self.views.keys().cloned());
        out.extend(self.workspaces.values().flatten().cloned());
        out.extend(self.focus.values().cloned());
        out
    }

    fn owners(&self, instrument: &InstrumentKey) -> Vec<String> {
        self.background.items.iter().find(|i| i.instrument() == *instrument).map(|i| i.owners.clone()).unwrap_or_default()
    }

    /// Every instrument of `source` with why it is wanted, the kinds wanted of it, and when it was last touched.
    /// The focus and the workspace columns show an order book, so they add every kind to what the background list
    /// wants (a Futu product page keeps only quote+trade, and the product the user opens still needs its book). A
    /// view adds none to a listed instrument: every product-list row opens the same full view as the selected product,
    /// and a book for each row is not what the list asks for.
    fn desired(&self, source: &str) -> BTreeMap<InstrumentKey, (BTreeSet<Reason>, Vec<Kind>, u64)> {
        let mut out: BTreeMap<InstrumentKey, (BTreeSet<Reason>, Vec<Kind>, u64)> = BTreeMap::new();
        let mut want = |instrument: InstrumentKey, reason: Reason, kinds: &[Kind], add_kinds: bool, touched: u64| {
            let fresh = !out.contains_key(&instrument);
            let entry = out.entry(instrument).or_insert_with(|| (BTreeSet::new(), Vec::new(), 0));
            entry.0.insert(reason);
            if fresh || add_kinds {
                for kind in kinds {
                    if !entry.1.contains(kind) {
                        entry.1.push(*kind);
                    }
                }
            }
            entry.2 = entry.2.max(touched);
        };
        for item in self.background.items.iter().filter(|i| i.source == source) {
            want(item.instrument(), Reason::Background, &item.kinds, true, 0);
        }
        if let Some(focus) = self.focus.get(source) {
            want(focus.clone(), Reason::Focus, &default_kinds(), true, u64::MAX);
        }
        for (instrument, clients) in self.views.iter().filter(|(k, _)| k.source == source) {
            want(instrument.clone(), Reason::View, &default_kinds(), false, clients.values().copied().max().unwrap_or(0));
        }
        for instrument in self.workspaces.values().flatten().filter(|k| k.source == source) {
            want(instrument.clone(), Reason::Workspace, &default_kinds(), true, 0);
        }
        out
    }

    /// Recompute one source's plan; Some(plan) only when it differs from the last plan sent.
    pub fn plan(&mut self, source: &str) -> Option<Plan> {
        let desired = self.desired(source);
        let adapter = self.adapters.get(source)?;
        let capacity = &adapter.capacity;
        // Billed in the provider's unit (AdapterCapacity::total / cost): instruments, or streams by each market's lanes.
        let total = capacity.total();
        let smallest_reserve = if total > capacity.largest_cost() { capacity.largest_cost() } else { 0 };
        let reserve = (total * self.view_reserve_percent / 100).max(smallest_reserve);
        let background_cap = total.saturating_sub(reserve);
        // An instrument the user is looking at (focus, a view, a workspace) is interactive even when it is also on the
        // background list: it competes in the interactive order, never in the background share, which would cut it off.
        // Only background-only instruments take the background share.
        let interactive_reason = |r: &BTreeSet<Reason>| r.iter().any(|x| *x != Reason::Background);
        let mut background: Vec<_> = desired.iter().filter(|(_, (r, _, _))| !interactive_reason(r)).collect();
        background.sort_by(|a, b| a.0.cmp(b.0));
        let mut interactive: Vec<_> = desired.iter().filter(|(_, (r, _, _))| interactive_reason(r)).collect();
        // focus first, then the most recently opened views, then workspace members.
        interactive.sort_by(|a, b| {
            let rank = |r: &BTreeSet<Reason>| if r.contains(&Reason::Focus) { 0 } else if r.contains(&Reason::View) { 1 } else { 2 };
            rank(&a.1 .0).cmp(&rank(&b.1 .0)).then(b.1 .2.cmp(&a.1 .2)).then(a.0.cmp(b.0))
        });
        let mut items = Vec::new();
        let mut spent = 0usize;
        let mut taken: BTreeSet<&InstrumentKey> = BTreeSet::new();
        // Each instrument that still fits within `cap` is taken; one that does not is passed over, never cut short, and
        // a cheaper one after it may still fit.
        // An instrument none of whose kinds its market carries is never planned (it would subscribe nothing).
        let mut take = |instrument: &InstrumentKey, kinds: &[Kind], cap: usize, items: &mut Vec<(InstrumentKey, Vec<Kind>)>| -> bool {
            let Some((carried, cost)) = capacity.billed(&instrument.market, kinds) else { return false };
            if carried.is_empty() || spent + cost > cap {
                return false;
            }
            spent += cost;
            items.push((instrument.clone(), carried));
            true
        };
        for (instrument, (_, kinds, _)) in &background {
            if take(instrument, kinds, background_cap, &mut items) {
                taken.insert(instrument);
            }
        }
        for (instrument, (_, kinds, _)) in interactive {
            take(instrument, kinds, total, &mut items);
        }
        // Background items beyond their share may still use room the interactive set left free.
        for (instrument, (_, kinds, _)) in background.iter().filter(|(i, _)| !taken.contains(i)) {
            take(instrument, kinds, total, &mut items);
        }
        let adapter = self.adapters.get_mut(source)?;
        if adapter.plan_generation != 0 && adapter.planned == items {
            return None;
        }
        let generation = self.next_generation;
        self.next_generation += 1;
        adapter.planned = items.clone();
        adapter.plan_generation = generation;
        Some(Plan { source: source.to_string(), generation, items })
    }

    pub fn sources(&self) -> Vec<String> {
        self.adapters.keys().cloned().collect()
    }

    /// The provider's report of what it actually subscribed for a plan generation.
    pub fn report(&mut self, source: &str, generation: u64, subscribed: Vec<InstrumentKey>, failed: Vec<(InstrumentKey, String)>)
                  -> Result<(), String> {
        let adapter = self.adapters.get_mut(source).ok_or_else(|| format!("no adapter registered for {source}"))?;
        // A report answers exactly the plan last sent. An older one describes a plan already replaced, and a newer one
        // a plan never sent: neither may stand for what is subscribed now.
        if generation != adapter.plan_generation {
            return Err(format!("report generation {generation} is not the current plan {}", adapter.plan_generation));
        }
        let planned: BTreeSet<&InstrumentKey> = adapter.planned.iter().map(|(k, _)| k).collect();
        if let Some(stray) = subscribed.iter().chain(failed.iter().map(|(k, _)| k)).find(|k| !planned.contains(k)) {
            return Err(format!("report names {}:{}, which the current plan does not", stray.market, stray.code));
        }
        adapter.reported_generation = Some(generation);
        adapter.subscribed = subscribed.into_iter().collect();
        adapter.failed = failed.into_iter().collect();
        Ok(())
    }

    /// What the provider reports it still holds outside the plan. A planned instrument is never draining.
    pub fn set_draining(&mut self, source: &str, draining: BTreeSet<InstrumentKey>) -> Result<(), String> {
        let adapter = self.adapters.get_mut(source).ok_or_else(|| format!("no adapter registered for {source}"))?;
        if let Some(planned) = draining.iter().find(|k| adapter.planned.iter().any(|(p, _)| p == *k)) {
            return Err(format!("{}:{} is planned, not draining", planned.market, planned.code));
        }
        adapter.draining = draining;
        Ok(())
    }

    /// Per-instrument desired / planned / actual status, for Settings (through Health) and the view meta block.
    pub fn status(&self) -> Value {
        let mut sources: BTreeSet<String> = self.adapters.keys().cloned().collect();
        sources.extend(self.background.items.iter().map(|i| i.source.clone()));
        sources.extend(self.views.keys().map(|k| k.source.clone()));
        let mut rows = Vec::new();
        for source in sources {
            let desired = self.desired(&source);
            let adapter = self.adapters.get(&source);
            for (instrument, (reasons, kinds, _)) in desired {
                let planned = adapter.and_then(|a| a.planned.iter().find(|(k, _)| *k == instrument));
                let state = match adapter {
                    None => "SOURCE_NOT_CONNECTED".to_string(),
                    Some(a) if a.connections == 0 => "SOURCE_NOT_CONNECTED".to_string(),
                    Some(a) => {
                        // Only a report of the plan in force describes the instrument now: until the
                        // provider answers a new generation, the previous report's subscribed / failed is history.
                        let billed = a.capacity.billed(&instrument.market, &kinds);
                        if planned.is_none() && billed.is_none() {
                            // The provider's stream budget does not say what an instrument of this market costs.
                            "UNSUPPORTED_MARKET".to_string()
                        } else if planned.is_none() && billed.is_some_and(|(carried, _)| carried.is_empty()) {
                            // None of the kinds asked for is one this provider carries for the market.
                            "UNSUPPORTED_KINDS".to_string()
                        } else if planned.is_none() {
                            "QUOTA_EXCEEDED".to_string()
                        } else if a.reported_generation != Some(a.plan_generation) {
                            "PENDING_SOURCE".to_string()
                        } else if let Some(reason) = a.failed.get(&instrument) {
                            format!("FAILED:{reason}")
                        } else if a.subscribed.contains(&instrument) {
                            "SUBSCRIBED".to_string()
                        } else {
                            "NOT_SUBSCRIBED".to_string()
                        }
                    }
                };
                let unsupported: Vec<Kind> = match adapter {
                    Some(a) => kinds.iter().filter(|k| !a.capacity.kinds.contains(*k)).copied().collect(),
                    None => Vec::new(),
                };
                rows.push(json!({
                    "source": instrument.source, "market": instrument.market, "code": instrument.code,
                    "reasons": reasons.iter().map(Reason::name).collect::<Vec<_>>(),
                    "background_owners": self.owners(&instrument),
                    "desired_kinds": kinds, "unsupported_kinds": unsupported,
                    "planned": planned.is_some(), "state": state,
                }));
            }
        }
        json!({
            "background_revision": self.background.revision,
            "background_items": self.background.items.len(),
            "adapters": self.adapters.iter().map(|(s, a)| (s.clone(), json!({
                "limit": a.capacity.limit, "stream_budget": a.capacity.streams,
                "planned_streams": a.planned.iter().filter_map(|(k, kinds)| a.capacity.billed(&k.market, kinds)).map(|(_, cost)| cost).sum::<usize>(),
                "connections": a.connections, "planned": a.planned.len(),
                "plan_generation": a.plan_generation, "reported_generation": a.reported_generation,
                "subscribed": a.subscribed.len(), "failed": a.failed.len(), "draining": a.draining.len(), "kinds": a.capacity.kinds,
            }))).collect::<serde_json::Map<String, Value>>(),
            "instruments": rows,
        })
    }
}

/// Every problem of a background list in canonical case (config/background_list.py validate_background).
fn validate_background(items: &[BackgroundItem]) -> Vec<String> {
    if items.len() > MAX_BACKGROUND_ITEMS {
        return vec![format!("at most {MAX_BACKGROUND_ITEMS} background instruments, got {}", items.len())];
    }
    let mut problems = Vec::new();
    let mut seen = BTreeSet::new();
    for (i, item) in items.iter().enumerate() {
        if item.source.is_empty() || item.market.is_empty() || item.code.is_empty() {
            problems.push(format!("item {i}: source, market and code are required"));
            continue;
        }
        let name = format!("{}:{}:{}", item.source, item.market, item.code);
        if item.kinds.is_empty() {
            problems.push(format!("item {i} {name}: kinds must name at least one kind"));
        } else if item.kinds.iter().collect::<BTreeSet<_>>().len() != item.kinds.len() {
            problems.push(format!("item {i} {name}: kinds names a kind twice"));
        }
        if !seen.insert(item.instrument()) {
            problems.push(format!("item {i}: {name} listed twice"));
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(limit: usize, kinds: &[Kind]) -> AdapterCapacity {
        AdapterCapacity::new(limit, if kinds.is_empty() { default_kinds() } else { kinds.to_vec() }).unwrap()
    }

    fn k(code: &str) -> InstrumentKey {
        InstrumentKey::new("shioaji", "STK", code)
    }

    fn wire(streams: usize, markets: &[(&str, &[(Kind, usize)])]) -> StreamBudgetWire {
        StreamBudgetWire { streams, kinds_by_market: markets.iter()
            .map(|(m, kinds)| (m.to_string(), kinds.iter().copied().collect())).collect() }
    }

    /// Shioaji's budget: a stock's Tick and BidAsk, an index's Quote, a future's Quote, Tick and BidAsk, one each.
    fn shioaji_budget(streams: usize) -> StreamBudget {
        StreamBudget::new(wire(streams, &[("STK", &[(Kind::Trade, 1), (Kind::Orderbook, 1)]), ("idx", &[(Kind::Quote, 1)]),
                                          ("FUT", &[(Kind::Quote, 1), (Kind::Trade, 1), (Kind::Orderbook, 1)])])).unwrap()
    }

    fn item(market: &str, code: &str, kinds: &[Kind], owner: &str) -> BackgroundItem {
        BackgroundItem { source: "shioaji".into(), market: market.into(), code: code.into(), kinds: kinds.to_vec(), owners: vec![owner.into()] }
    }

    #[test]
    fn a_stream_budget_bills_each_instrument_by_the_kinds_asked_of_it() {
        // Codex 1020-R05-10: the provider's limit was an instrument count at two streams each, so a list mixing
        // sector indices (one stream each) was cut while it fitted. 8 streams: 2 full stocks (4) + 4 indices (4).
        let mut d = DemandManager::new();
        d.register_adapter("shioaji", cap(4, &[]).with_streams(shioaji_budget(8)));
        let mut list = bg(&["2330", "2454"], 1);
        for code in ["T23", "T24", "T25", "T26"] {
            list.items.push(item("IDX", code, &default_kinds(), "sector_index"));
        }
        // A market the budget names no streams for is never planned on a guess.
        list.items.push(item("OPT", "TXO", &default_kinds(), "watchlist"));
        d.replace_background(list).unwrap();
        let plan = d.plan("shioaji").unwrap();
        assert_eq!(plan.items.len(), 6, "every stock and index fits in 8 streams although max_subscriptions says 4");
        let kinds_of = |plan: &Plan, code: &str| plan.items.iter().find(|(i, _)| i.code == code).unwrap().1.clone();
        assert_eq!(kinds_of(&plan, "2330"), vec![Kind::Trade, Kind::Orderbook], "a stock has no quote stream: never planned with one");
        assert_eq!(kinds_of(&plan, "T23"), vec![Kind::Quote]);
        let status = d.status();
        let state = |code: &str| status["instruments"].as_array().unwrap().iter().find(|r| r["code"] == code).unwrap()["state"].clone();
        assert_eq!(state("TXO"), "UNSUPPORTED_MARKET");
        assert_eq!(status["adapters"]["shioaji"]["planned_streams"], 8);
        assert_eq!(status["adapters"]["shioaji"]["stream_budget"]["kinds_by_market"]["IDX"]["quote"], 1);

        // One stream short: a stock no longer fits, an index after it still does.
        d.set_adapter_capacity("shioaji", cap(4, &[]).with_streams(shioaji_budget(7)));
        let plan = d.plan("shioaji").unwrap();
        let planned_streams: usize = plan.items.iter().map(|(_, kinds)| kinds.len()).sum();
        assert!(planned_streams <= 7 && plan.items.iter().filter(|(k, _)| k.market == "IDX").count() == 4, "{:?}", plan.items);
    }

    #[test]
    fn a_stock_with_its_order_book_off_costs_one_stream_and_one_with_nothing_carried_is_not_planned() {
        // 5 streams: 2330 trade only (1), 2454 orderbook only (1), TXF202612 trade + orderbook (2), TXFR1 quote (1).
        let mut d = DemandManager::new();
        d.register_adapter("shioaji", cap(1, &[]).with_streams(shioaji_budget(6)));
        d.view_reserve_percent = 0;
        d.replace_background(BackgroundList { revision: Some(1), items: vec![
            item("STK", "2330", &[Kind::Trade], "watchlist"),
            item("STK", "2454", &[Kind::Orderbook], "watchlist"),
            item("STK", "1101", &[Kind::Quote], "watchlist"),
            item("FUT", "TXF202612", &[Kind::Trade, Kind::Orderbook], "market_context"),
            item("FUT", "TXFR1", &[Kind::Quote], "market_context"),
        ] }).unwrap();
        let plan = d.plan("shioaji").unwrap();
        let mut codes: Vec<&str> = plan.items.iter().map(|(i, _)| i.code.as_str()).collect();
        codes.sort();
        assert_eq!(codes, vec!["2330", "2454", "TXF202612", "TXFR1"], "1101 asks only for a quote, which a stock never has");
        let status = d.status();
        assert_eq!(status["adapters"]["shioaji"]["planned_streams"], 5);
        let row = status["instruments"].as_array().unwrap().iter().find(|r| r["code"] == "1101").unwrap().clone();
        assert_eq!(row["state"], "UNSUPPORTED_KINDS");
    }

    #[test]
    fn a_futu_budget_bills_every_opend_type_and_cuts_at_the_quota_not_at_an_instrument_count() {
        // OpenD's quota counts every type of every instrument (service/market/futu/service.py stream_budget): 報價 is
        // QUOTE and RT_DATA (2), 明細 TICKER (1), 五檔 ORDER_BOOK (1). 11-01: 100 of them; at 3 a watchlist row the
        // background share (80) holds 26 rows, the focus takes 4 and the rows after them fill the 18 left: 32 rows, not
        // the 100 an instrument count would have planned.
        let budget = StreamBudget::new(wire(100, &[("US", &[(Kind::Quote, 2), (Kind::Trade, 1), (Kind::Orderbook, 1)]),
                                                   ("CC", &[(Kind::Quote, 2), (Kind::Trade, 1), (Kind::Orderbook, 1)])])).unwrap();
        let mut d = DemandManager::new();
        d.register_adapter("futu", cap(25, &[]).with_streams(budget));
        let rows: Vec<BackgroundItem> = (0..40).map(|i| BackgroundItem { source: "futu".into(), market: "US".into(),
            code: format!("US.S{i:02}"), kinds: vec![Kind::Quote, Kind::Trade], owners: vec!["watchlist".into()] }).collect();
        d.replace_background(BackgroundList { revision: Some(1), items: rows }).unwrap();
        d.set_focus("futu", Some(InstrumentKey::new("futu", "CC", "CC.BTC")));
        let plan = d.plan("futu").unwrap();
        assert_eq!(plan.items.iter().filter(|(k, _)| k.market == "US").count(), 32, "26 in the share, 6 in the room left");
        let focus = plan.items.iter().find(|(k, _)| k.code == "CC.BTC").unwrap();
        assert_eq!(focus.1, default_kinds(), "the product the user opened is planned with its book (4)");
        let status = d.status();
        assert_eq!(status["adapters"]["futu"]["planned_streams"], 100);
        let quota_exceeded = status["instruments"].as_array().unwrap().iter().filter(|r| r["state"] == "QUOTA_EXCEEDED").count();
        assert_eq!(quota_exceeded, 8);
    }

    #[test]
    fn a_stream_budget_is_validated_whole() {
        let trade = &[(Kind::Trade, 1)][..];
        assert!(StreamBudget::new(wire(0, &[("STK", trade)])).unwrap_err().contains("streams"));
        assert!(StreamBudget::new(wire(4, &[])).unwrap_err().contains("at least one market"));
        assert!(StreamBudget::new(wire(4, &[("STK", &[])])).unwrap_err().contains("at least one kind"));
        assert!(StreamBudget::new(wire(4, &[("STK", &[(Kind::Trade, 0)])])).unwrap_err().contains("STK"));
        assert!(StreamBudget::new(wire(4, &[("stk", trade), ("STK", trade)])).unwrap_err().contains("twice"));
        assert_eq!(StreamBudget::new(wire(4, &[("stk", trade)])).unwrap().kinds_by_market.keys().collect::<Vec<_>>(), vec!["STK"]);
        let parsed: StreamBudgetWire = serde_json::from_value(json!({"streams": 3, "kinds_by_market": {"STK": {"trade": 1, "orderbook": 1}}})).unwrap();
        assert_eq!(parsed.kinds_by_market["STK"].len(), 2);
        assert!(serde_json::from_value::<StreamBudgetWire>(json!({"streams": 3, "kinds_by_market": {"STK": {"tick": 1}}})).is_err(),
                "an unknown kind does not parse");
    }

    fn bg(codes: &[&str], revision: u64) -> BackgroundList {
        BackgroundList {
            revision: Some(revision),
            items: codes.iter().map(|c| BackgroundItem { source: "shioaji".into(), market: "STK".into(), code: (*c).into(), kinds: default_kinds(), owners: vec!["watchlist".into()] }).collect(),
        }
    }

    #[test]
    fn closing_a_view_keeps_a_background_instrument_planned() {
        let mut d = DemandManager::new();
        d.replace_background(bg(&["2330"], 1)).unwrap();
        d.register_adapter("shioaji", cap(10, &[]));
        d.view_opened(1, &k("2330"), 5);
        d.view_opened(1, &k("3481"), 6);
        let plan = d.plan("shioaji").unwrap();
        assert_eq!(plan.items.len(), 2);
        d.view_closed(1, &k("2330"));
        d.view_closed(1, &k("3481"));
        let plan = d.plan("shioaji").unwrap();
        assert_eq!(plan.items.iter().map(|(i, _)| i.code.as_str()).collect::<Vec<_>>(), vec!["2330"]);
        assert!(d.plan("shioaji").is_none(), "an unchanged plan is not re-sent");
    }

    #[test]
    fn quota_keeps_a_view_reserve_and_reports_what_does_not_fit() {
        let mut d = DemandManager::new();
        d.replace_background(bg(&["1101", "1102", "1103", "1104", "1105", "1106"], 1)).unwrap();
        d.register_adapter("shioaji", cap(5, &[]));
        d.set_focus("shioaji", Some(k("2330")));
        let plan = d.plan("shioaji").unwrap();
        assert_eq!(plan.items.len(), 5);
        assert!(plan.items.iter().any(|(i, _)| i.code == "2330"), "the reserve serves the focus");
        let status = d.status();
        let exceeded: Vec<_> = status["instruments"].as_array().unwrap().iter().filter(|r| r["state"] == "QUOTA_EXCEEDED").collect();
        assert_eq!(exceeded.len(), 2);
    }

    #[test]
    fn status_separates_planned_from_actually_subscribed() {
        let mut d = DemandManager::new();
        d.replace_background(bg(&["2330", "2317"], 3)).unwrap();
        d.register_adapter("shioaji", cap(10, &[Kind::Quote, Kind::Trade]));
        let plan = d.plan("shioaji").unwrap();
        let state_of = |d: &DemandManager, code: &str| d.status()["instruments"].as_array().unwrap().iter()
            .find(|r| r["code"] == code).unwrap()["state"].as_str().unwrap().to_owned();
        assert_eq!(state_of(&d, "2330"), "PENDING_SOURCE");
        d.report("shioaji", plan.generation, vec![k("2330")], vec![(k("2317"), "NO_CONTRACT".into())]).unwrap();
        assert_eq!(state_of(&d, "2330"), "SUBSCRIBED");
        assert_eq!(state_of(&d, "2317"), "FAILED:NO_CONTRACT");
        let row = d.status()["instruments"].as_array().unwrap().iter().find(|r| r["code"] == "2330").unwrap().clone();
        assert_eq!(row["unsupported_kinds"], json!(["orderbook"]), "a kind the source cannot give is shown, not assumed");
        assert!(d.replace_background(bg(&["9999"], 2)).is_err(), "an older revision is refused");
    }

    #[test]
    fn a_background_instrument_the_user_looks_at_is_never_cut_by_the_background_share() {
        // Limit 5, reserve 1 -> background share 4. 2330 is background AND the focus; it sorts last by code.
        let mut d = DemandManager::new();
        d.replace_background(bg(&["1101", "1102", "1103", "1104", "1105", "2330"], 1)).unwrap();
        d.register_adapter("shioaji", cap(5, &[]));
        d.set_focus("shioaji", Some(k("2330")));
        let plan = d.plan("shioaji").unwrap();
        let codes: Vec<&str> = plan.items.iter().map(|(i, _)| i.code.as_str()).collect();
        assert_eq!(codes.len(), 5);
        assert!(codes.contains(&"2330"), "the focused instrument is planned: {codes:?}");
        let row = d.status()["instruments"].as_array().unwrap().iter().find(|r| r["code"] == "2330").unwrap().clone();
        assert_eq!(row["reasons"], json!(["background", "focus"]));
    }

    #[test]
    fn the_focused_product_gets_its_order_book_even_when_its_product_page_keeps_none() {
        // A Futu product page keeps quote+trade in the background; the product opened in the Futu pane needs its book,
        // while the other rows (each with the same full view open) do not. Shioaji and Futu each have their own focus.
        let futu = |code: &str| InstrumentKey::new("futu", "US", code);
        let mut d = DemandManager::new();
        d.replace_background(BackgroundList { revision: Some(1), items: ["US.SPCX", "US.TSM"].iter().map(|c| BackgroundItem {
            source: "futu".into(), market: "US".into(), code: (*c).into(), kinds: vec![Kind::Quote, Kind::Trade],
            owners: vec!["watchlist".into()] }).collect() }).unwrap();
        d.register_adapter("futu", cap(10, &[]));
        d.register_adapter("shioaji", cap(10, &[]));
        d.view_opened(1, &futu("US.SPCX"), 5);
        d.view_opened(1, &futu("US.TSM"), 6);
        d.set_focus("shioaji", Some(k("2330")));
        d.set_focus("futu", Some(futu("US.SPCX")));
        let plan = d.plan("futu").unwrap();
        let kinds_of = |code: &str| plan.items.iter().find(|(i, _)| i.code == code).unwrap().1.clone();
        assert_eq!(kinds_of("US.SPCX"), vec![Kind::Quote, Kind::Trade, Kind::Orderbook]);
        assert_eq!(kinds_of("US.TSM"), vec![Kind::Quote, Kind::Trade], "an open view adds no book to a listed product");
        assert!(d.plan("shioaji").unwrap().items.iter().any(|(i, _)| i.code == "2330"), "the Shioaji focus stays");
        d.set_focus("futu", None);
        let plan = d.plan("futu").unwrap();
        assert!(plan.items.iter().all(|(_, kinds)| !kinds.contains(&Kind::Orderbook)), "a cleared focus drops the book");
    }

    #[test]
    fn a_report_must_answer_the_current_plan() {
        // A status report that does not answer the current plan is refused.
        let mut d = DemandManager::new();
        d.replace_background(bg(&["2330", "2317"], 1)).unwrap();
        d.register_adapter("shioaji", cap(10, &[]));
        let first = d.plan("shioaji").unwrap();
        d.report("shioaji", first.generation, vec![k("2330"), k("2317")], vec![]).unwrap();
        assert!(d.report("shioaji", first.generation + 7, vec![k("2330")], vec![]).is_err(), "a plan never sent");
        d.replace_background(bg(&["2330"], 2)).unwrap();
        let second = d.plan("shioaji").unwrap();
        assert!(d.report("shioaji", first.generation, vec![k("2330"), k("2317")], vec![]).is_err(), "a replaced plan");
        assert!(d.report("shioaji", second.generation, vec![k("2317")], vec![]).is_err(), "an instrument not planned");
        d.report("shioaji", second.generation, vec![k("2330")], vec![]).unwrap();
        assert_eq!(d.adapters["shioaji"].reported_generation, Some(second.generation));
    }

    #[test]
    fn draining_is_what_the_broker_still_holds_outside_the_plan() {
        // Never a planned instrument.
        let mut d = DemandManager::new();
        d.replace_background(bg(&["2330"], 1)).unwrap();
        d.register_adapter("shioaji", cap(10, &[]));
        d.plan("shioaji").unwrap();
        assert!(d.set_draining("shioaji", [k("2330")].into_iter().collect()).is_err());
        d.set_draining("shioaji", [k("2317")].into_iter().collect()).unwrap();
        assert_eq!(d.status()["adapters"]["shioaji"]["draining"], 1);
    }

    #[test]
    fn a_new_plan_is_pending_until_its_own_report() {
        // Generation 1 said SUBSCRIBED / FAILED; generation 2 is pending until it is answered.
        let mut d = DemandManager::new();
        d.replace_background(bg(&["2330", "2317"], 1)).unwrap();
        d.register_adapter("shioaji", cap(10, &[]));
        let first = d.plan("shioaji").unwrap();
        d.report("shioaji", first.generation, vec![k("2330")], vec![(k("2317"), "NO_CONTRACT".into())]).unwrap();
        let state_of = |d: &DemandManager, code: &str| d.status()["instruments"].as_array().unwrap().iter()
            .find(|r| r["code"] == code).unwrap()["state"].as_str().unwrap().to_owned();
        assert_eq!(state_of(&d, "2330"), "SUBSCRIBED");
        d.replace_background(bg(&["2330", "2317", "1101"], 2)).unwrap();
        let second = d.plan("shioaji").unwrap();
        assert_eq!(state_of(&d, "2330"), "PENDING_SOURCE", "the old report does not answer the new plan");
        assert_eq!(state_of(&d, "2317"), "PENDING_SOURCE", "nor does an old failure");
        d.report("shioaji", second.generation, vec![k("2330"), k("2317")], vec![]).unwrap();
        assert_eq!(state_of(&d, "2317"), "SUBSCRIBED");
        assert_eq!(state_of(&d, "1101"), "NOT_SUBSCRIBED");
    }

    #[test]
    fn a_background_list_with_problems_is_refused_whole_with_every_problem_named() {
        let mut d = DemandManager::new();
        d.replace_background(bg(&["2330"], 1)).unwrap();
        let mut list = bg(&["2317", " 2317 ", "", "1101"], 2);
        list.items[3].kinds = vec![];
        let err = d.replace_background(list).unwrap_err();
        assert!(err.contains("item 1: shioaji:STK:2317 listed twice"), "{err}");
        assert!(err.contains("item 2: source, market and code are required"), "{err}");
        assert!(err.contains("item 3 shioaji:STK:1101: kinds must name at least one kind"), "{err}");
        assert_eq!(d.background().revision, Some(1), "the applied list stays");
        assert_eq!(d.background().items.len(), 1);
        let unknown = serde_json::from_value::<Vec<BackgroundItem>>(json!([{"source": "shioaji", "market": "STK", "code": "2330", "kinds": ["tick"]}]));
        assert!(unknown.is_err(), "an unknown kind does not parse");
    }

    #[test]
    fn an_adapter_capacity_is_never_rewritten_to_fit() {
        assert!(AdapterCapacity::new(0, default_kinds()).unwrap_err().contains("at least 1"));
        assert!(AdapterCapacity::new(5, vec![]).unwrap_err().contains("at least one kind"));
        assert!(AdapterCapacity::new(5, vec![Kind::Quote, Kind::Quote]).unwrap_err().contains("twice"));
        let mut d = DemandManager::new();
        d.register_adapter("shioaji", cap(10, &[]));
        d.set_adapter_capacity("shioaji", cap(3, &[Kind::Quote]));
        assert_eq!(d.status()["adapters"]["shioaji"]["limit"], 3);
        assert_eq!(d.status()["adapters"]["shioaji"]["kinds"], json!(["quote"]));
        assert_eq!(d.status()["adapters"]["shioaji"]["connections"], 1);
    }
}
