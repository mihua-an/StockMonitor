// The 即時報價 page's shared state: the page's resources and visibility, the selection authority and the view gateway.
// It is the bottom of the page's controllers (session_state, product_pages, live_redraw, canonical_view_owner,
// live_view_models, selection_controller, session_controller, startup_diagnostics) and imports none of them; each value
// has one writer, named beside it.
import { createViewResources } from "../../market_data/view_resources.js";
import { createMarketPanelUiState } from "./market_panel_ui_state.js";
import { createSelectionIntentStore } from "./selection_intent_store.js";
import { getRealtimeViewSnapshot, subscribeRealtimeView } from "../../market_data/realtime.js";
import { MarketDataGateway } from "../../market_data/market_data_gateway.js";

// The page's timers, frames and listeners: all released when the page is disposed.
export const viewResources = createViewResources();
export const setTimeout = (callback, delay) => viewResources.timeout(callback, delay);
export const requestAnimationFrame = callback => viewResources.frame(callback);
export const cancelAnimationFrame = id => viewResources.cancelFrame(id);

// Whether the page's dashboard is mounted, and whether it is being mounted (a slot restored then is not a user's
// choice). Written by the page's mount and dispose (pages/realtime.js).
export let livePageMounted = false;
export let mountingPresentation = false;
export function setLivePageMounted(mounted) { livePageMounted = Boolean(mounted); }
export function setMountingPresentation(mounting) { mountingPresentation = Boolean(mounting); }

// Whether the page is shown, and the epoch that counts every show, hide and market-data rebind: what a panel was last
// handed is compared within one epoch only (canonical_view_owner.js changedSnapshotChannels). Written by the page's
// lifecycle and by the session controller's rebind.
export let realtimePageVisible = false;
export let realtimeVisibleEpoch = 0;
export function setRealtimePageShown(visible) { realtimePageVisible = Boolean(visible); realtimeVisibleEpoch += 1; }
export function nextRealtimeVisibleEpoch() { realtimeVisibleEpoch += 1; }

export const marketPanelUiState = createMarketPanelUiState();
export const restoredMarketPanelState = marketPanelUiState.snapshot();
// SelectionIntentStore is the single renderer authority for user selection.
// Scoped symbol/UI stores remain adapters for component fan-out and persistence;
// page logic reads trend/detail/search ownership only from this generationed store.
// No built-in product: before the first selection every detail panel asks for one
// (NO_SELECTION_TEXT).
export const selectionIntentStore = createSelectionIntentStore({
  panelState: restoredMarketPanelState,
});
// UI latency budget: canonical state may update many times per second, but the
// visible trend must normally reach the next 1-3 display frames, never seconds.
export const liveMarketDataGateway = new MarketDataGateway({
  subscribeView: subscribeRealtimeView,
  getSnapshot: getRealtimeViewSnapshot,
});

// The selection as every controller reads it (selection_controller.js writes it).
export function selectedStockCode() {
  return selectionIntentStore.selectedSymbol;
}

export function activeTrendTarget() {
  return selectionIntentStore.trendCode;
}

export function lastStockDetailTarget() {
  return selectionIntentStore.lastStockDetailCode;
}

export function searchFocusTarget() {
  return selectionIntentStore.searchFocusCode;
}

export function detailTargetCode() {
  return String(selectionIntentStore.detailCode || "").trim().toUpperCase();
}

export function detailSymbolContext() {
  const symbol = detailTargetCode();
  return { symbol, market: symbol === "TXFR1" ? "futures" : "stock" };
}
