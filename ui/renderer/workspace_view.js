// First: every later warning and error is recorded as text (js/core/console_relay.js).
import "./js/core/console_relay.js";
import "./js/dashboard_components.js";
import { ComponentHost } from "./js/core/component_host.js";
import { componentRegistry } from "./js/core/component_registry.js";
import { createDashboardContext, realtimeContext } from "./js/core/dashboard_context.js";
import { apiGet } from "./js/core/api.js";
import { liveEventMarkers, stockTrendEventMarkersVisible, subscribeStockTrendEventMarkers } from "./js/core/event_markers.js";
import {
  startRealtimeStream, notifyBackendReadyForRealtime,
  subscribeRealtimeView, getRealtimeViewSnapshot,
  replaceRealtimeWorkspace, subscribeRealtimeConnectionState, subscribeRealtimeSession, subscribeRealtimeAnalysisState,
} from "./js/market_data/realtime.js";
import { MarketDataGateway } from "./js/market_data/market_data_gateway.js";
import { shioajiMarketOf } from "./js/market_data/futures_symbol.js";
import { getLiveMonitorEvents, startMonitorEventTape } from "./js/features/realtime/live_monitor_events.js";
import { createTechnicalWindowService } from "./js/features/realtime/technical_window_service.js";
import { futuresLivePartitionOf } from "./js/features/realtime/txf_session_identity.js";
import { WorkspaceStore, WORKSPACE_MAX_SYMBOLS, isFutuWorkspaceCode } from "./js/features/workspace/workspace_store.js";
import { createWorkspaceBenchmarkSource } from "./js/features/workspace/workspace_benchmark_source.js";
import { WorkspaceColumn } from "./js/features/workspace/workspace_column_runtime.js";
import { WorkspaceProductDock } from "./js/features/workspace/workspace_product_dock.js";
import { WorkspaceTradesComponent } from "./js/features/workspace/workspace_trades_component.js";
import { onInstrumentNamesLearned, requestInstrumentNames } from "./js/core/instrument_names.js";
import { installSecondaryWindowRealtime } from "./js/market_data/secondary_window_realtime.js";

const gateway = new MarketDataGateway({ subscribeView: subscribeRealtimeView, getSnapshot: getRealtimeViewSnapshot });
const benchmarkSource = createWorkspaceBenchmarkSource({
  subscribeView: subscribeRealtimeView,
  tradingDate: () => tradingDate,
});
const store = new WorkspaceStore({ maxSymbols: WORKSPACE_MAX_SYMBOLS });

// entries: Map<code, { column, host, root }>
const entries = new Map();
let tradingDate = "";
let futuresPartition = null;
// A column's name is the catalog's (instrument_names.js): it redraws when the catalog names its code.
onInstrumentNamesLearned((code) => { const column = entries.get(code)?.column; if (column && !column.disposed) column.refreshFreshness(); });
let workspacePushTimer = null;

const DOCK_DRAG_TYPE = "application/x-workspace-product";
const COLUMN_DRAG_TYPE = "application/x-workspace-column";
let draggedProduct = "";
let draggedColumn = "";

const columnsHost = document.getElementById("workspaceColumns");
const emptyHint = document.createElement("div");
emptyHint.className = "workspace-empty-hint";
emptyHint.textContent = "把下面的商品拖到這裡";

function addProduct(code) {
  const result = store.add(code);
  if (!result.ok) console.warn("[workspace: adding a product] refused", code, result.error);
  return result;
}

// The window's products and the dock's cards share one quote service over this window's connection.
const quoteService = createTechnicalWindowService({ futuresPartition: () => futuresPartition });
const dock = new WorkspaceProductDock({
  host: document.getElementById("workspaceDock"),
  service: quoteService,
  isAdded: (code) => store.has(code),
  isFull: () => store.isFull(),
  onAdd: addProduct,
  dragType: DOCK_DRAG_TYPE,
  onDrag: (code) => { draggedProduct = code; },
  onDemandChanged: () => scheduleWorkspaceSubscriptionPush(),
});

// What this window asks Market Runtime to keep subscribed: its columns and the dock's Taiwan products. Each provider's
// WORKSPACE owner is full-replaced, so a symbol still on the main page's WATCHLIST stays subscribed when it leaves here.
// A futures month is named in full: the transport's bare codes are stocks.
function demandCodes() {
  return [...new Set([...store.list(), ...dock.demand()])]
    .map((code) => (!isFutuWorkspaceCode(code) && shioajiMarketOf(code) === "FUT" ? `shioaji:FUT:${code}` : code));
}

function scheduleWorkspaceSubscriptionPush() {
  if (workspacePushTimer) clearTimeout(workspacePushTimer);
  workspacePushTimer = setTimeout(() => {
    workspacePushTimer = null;
    // The transport keeps this set and sends it again on every (re)connect: nothing here retries.
    replaceRealtimeWorkspace(demandCodes());
  }, 150);
}

// The window is closing: its workspace set is emptied with one workspace.replace sent synchronously on the open socket
// (the lifecycle installer stops the stream right after).
function releaseWorkspaceSubscriptionsOnClose() {
  if (workspacePushTimer) clearTimeout(workspacePushTimer);
  workspacePushTimer = null;
  replaceRealtimeWorkspace([]);
}

function clearDropMarks() {
  columnsHost.classList.remove("is-drop-target");
  for (const entry of entries.values()) entry.root.classList.remove("is-drop-target");
}

// The ✕ and the drag handling are this column's own elements' listeners: the trend component keeps its surface for the
// next column that mounts one, so anything added to its header would come back on another column.
function bindColumnControls(root, code) {
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "workspace-column-remove";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "移除");
  remove.addEventListener("click", () => {
    const result = store.remove(code);
    if (!result.ok) console.warn("[workspace: removing a column] refused", code, result.error);
  });
  root.appendChild(remove);

  const grip = root.querySelector(".product-quote-header");
  if (!grip) { console.error("[workspace] the column's trend has no header to drag it by", code); return; }
  grip.draggable = true;
  root.addEventListener("dragstart", (event) => {
    if (event.target !== grip) return;
    event.dataTransfer.setData(COLUMN_DRAG_TYPE, code);
    event.dataTransfer.effectAllowed = "move";
    draggedColumn = code;
    root.classList.add("is-moving");
  });
  root.addEventListener("dragend", (event) => {
    if (event.target !== grip) return;
    draggedColumn = "";
    root.classList.remove("is-moving");
  });
  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes(COLUMN_DRAG_TYPE) || draggedColumn === code) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    root.classList.add("is-drop-target");
  });
  root.addEventListener("dragleave", (event) => { if (!root.contains(event.relatedTarget)) root.classList.remove("is-drop-target"); });
  root.addEventListener("drop", (event) => {
    root.classList.remove("is-drop-target");
    const moved = event.dataTransfer.getData(COLUMN_DRAG_TYPE);
    if (!moved) return;
    event.preventDefault();
    const list = store.list();
    const result = store.reorder(list.indexOf(moved), list.indexOf(code));
    if (!result.ok) console.warn("[workspace: moving a column] refused", moved, result.error);
  });
}

// A product dragged up: not yet six, anywhere is a new column; six, it replaces the column under the pointer.
function productDropTarget(event) {
  if (!draggedProduct || store.has(draggedProduct)) return null;
  if (!store.isFull()) return { add: true };
  const column = event.target.closest?.("[data-workspace-column]");
  return column ? { column } : null;
}

function bindProductDrop() {
  columnsHost.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes(DOCK_DRAG_TYPE)) return;
    clearDropMarks();
    const target = productDropTarget(event);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    (target.column || columnsHost).classList.add("is-drop-target");
  });
  columnsHost.addEventListener("dragleave", (event) => { if (!columnsHost.contains(event.relatedTarget)) clearDropMarks(); });
  columnsHost.addEventListener("drop", (event) => {
    const target = productDropTarget(event);
    clearDropMarks();
    if (!target) return;
    event.preventDefault();
    const code = event.dataTransfer.getData(DOCK_DRAG_TYPE);
    if (target.add) { addProduct(code); return; }
    const result = store.replace(store.list().indexOf(target.column.dataset.workspaceColumn), code);
    if (!result.ok) console.warn("[workspace: replacing a column] refused", code, result.error);
  });
}

function mountColumn(code) {
  const root = document.createElement("section");
  root.className = "workspace-column dashboard-card";
  root.dataset.workspaceColumn = code;
  root.innerHTML = `
    <div class="workspace-column-panel workspace-column-trend" data-role="panel-trend"></div>
    <div class="workspace-column-panel workspace-column-orderbook" data-role="panel-orderbook" data-component-title="hidden"></div>
    <div class="workspace-column-panel workspace-column-trades" data-role="panel-trades"></div>
  `;
  columnsHost.appendChild(root);

  const context = createDashboardContext({
    id: `workspace:${code}`,
    mode: "live",
    capabilities: ["tick", "bidask", "trend"],
    // 分析資料重建中 over this column's 走勢 (Rust B's minutes), from this window's own Market Runtime connection.
    // No product search: a column's product comes from the dock, so its header shows the name and code as text.
    services: { analysisState: { subscribe: subscribeRealtimeAnalysisState }, productSearchProvider: "" },
  });
  const column = new WorkspaceColumn({ code, tradingDate, futuresPartition, gateway, apiGet, context, benchmarkSource,
    eventOptions: (shownCode, points) => {
      const visible = stockTrendEventMarkersVisible();
      return { eventMarkers: visible ? liveEventMarkers(getLiveMonitorEvents(), { code: shownCode, points }) : [], eventMarkersVisible: visible };
    } });
  // A's summary carries no name, so a code typed into the box (e.g. 6173) showed only its code: the catalog names it.
  if (!isFutuWorkspaceCode(code)) requestInstrumentNames("shioaji", [code]);

  const panel = (role) => root.querySelector(`[data-role="${role}"]`);
  const trendHost = new ComponentHost({
    host: panel("panel-trend"), hostId: `workspace:${code}:trend`, hostType: "detached",
    pageId: "workspace", slotId: "detached", context, registry: componentRegistry, hydrate: false,
  });
  trendHost.mount("workspaceTrendChart");
  context.dataSource?.invalidate?.("trendChart", { symbol: code });
  const orderbookHost = new ComponentHost({
    host: panel("panel-orderbook"), hostId: `workspace:${code}:orderbook`, hostType: "detached",
    pageId: "workspace", slotId: "detached", context, registry: componentRegistry, hydrate: false,
  });
  orderbookHost.mount("workspaceOrderbook");
  const tradesComponent = new WorkspaceTradesComponent();
  tradesComponent.mount({ host: panel("panel-trades"), context });

  bindColumnControls(root, code);
  entries.set(code, { column, root, trendHost, orderbookHost, tradesComponent });
}

function unmountColumn(code) {
  const entry = entries.get(code);
  if (!entry) return;
  entry.trendHost.destroy();
  entry.orderbookHost.destroy();
  entry.tradesComponent.destroy();
  entry.column.dispose();
  entry.root.remove();
  entries.delete(code);
}

function reconcileColumns() {
  const symbols = store.list();
  const desired = new Set(symbols);
  for (const code of [...entries.keys()]) if (!desired.has(code)) unmountColumn(code);
  emptyHint.remove();
  // Only a column out of place moves: moving an element resets its lists' scroll positions.
  let anchor = columnsHost.firstElementChild;
  for (const code of symbols) {
    if (!entries.has(code)) mountColumn(code);
    const { root } = entries.get(code);
    if (root === anchor) anchor = anchor.nextElementSibling;
    else columnsHost.insertBefore(root, anchor);
  }
  if (!symbols.length) columnsHost.appendChild(emptyHint);
  dock.markAddedChanged();
}

const MEMBERS_KEY = "workspace.members";

function readMembers() {
  try {
    const value = JSON.parse(window.sessionStorage?.getItem(MEMBERS_KEY) || "[]");
    return Array.isArray(value) ? value.filter((code) => typeof code === "string" && code) : [];
  } catch (error) { console.warn("[workspace: reading the members] failed", error); return []; }
}

function writeMembers(codes) {
  try { window.sessionStorage?.setItem(MEMBERS_KEY, JSON.stringify(codes)); } catch (error) { console.warn("[workspace: saving the members] failed", error); }
}

// The event tape's changes and the shared 盤中事件 switch redraw the columns' markers.
function bindEventMarkers() {
  startMonitorEventTape();
  const redraw = () => { for (const entry of entries.values()) entry.column.refreshTrend(); };
  realtimeContext.dataSource.setResolver("eventFeed", () => ({ rows: getLiveMonitorEvents() }));
  realtimeContext.dataSource.subscribe("eventFeed", redraw);
  subscribeStockTrendEventMarkers(redraw);
}

async function init() {
  bindProductDrop();
  bindEventMarkers();
  dock.mount();
  // Register before any asynchronous bootstrap so the one-shot IPC seed is
  // captured even while the session read is slow. Mount after the date resolves.
  let ready = false;
  let seeded = false;
  // The members survive a reload of this window (an endpoint change reloads it): kept in this
  // window's sessionStorage, which ends with the window. Without it every column was reset on reload.
  const restored = readMembers();
  for (const code of restored) store.add(code);
  window.desktopAPI?.onWorkspaceSeed?.((code) => {
    if (seeded || restored.length) return;  // a reload's re-sent seed is already among the restored members
    seeded = true;
    addProduct(code);
  });
  store.subscribe(() => {
    writeMembers(store.list());
    if (!ready) return;
    reconcileColumns();
    scheduleWorkspaceSubscriptionPush();
  });
  // The session is Market Runtime's, pushed on every connection of the WS this window opens anyway and with every
  // rollover: the columns start on the first one, and a workspace left open follows the next, the futures columns
  // between 日盤 and 夜盤 too. Futu columns follow Market Runtime's own partition already.
  startRealtimeStream();
  subscribeRealtimeSession((session) => {
    const next = String(session?.equity?.trading_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) {
      console.warn("[WORKSPACE] Market Runtime's session has no trading date", session);
      return;
    }
    const partition = futuresLivePartitionOf(session);
    const dateMoved = next !== tradingDate;
    const partitionMoved = partition.trading_date !== futuresPartition?.trading_date || partition.session !== futuresPartition?.session;
    tradingDate = next;
    futuresPartition = partition;
    if (!ready) {
      ready = true;
      reconcileColumns();
      dock.sessionChanged();
      scheduleWorkspaceSubscriptionPush();
      return;
    }
    if (!dateMoved && !partitionMoved) return;
    for (const entry of entries.values()) entry.column.setSession({ tradingDate, futuresPartition });
    if (dateMoved) benchmarkSource.rebind();
    dock.sessionChanged();
  });
  // A reconnect re-sends the workspace from the transport itself (realtime.js keeps the desired set); here the
  // columns only refresh their freshness labels.
  subscribeRealtimeConnectionState(() => {
    for (const entry of entries.values()) entry.column.refreshFreshness();
  });
  notifyBackendReadyForRealtime();
}

installSecondaryWindowRealtime({ release: releaseWorkspaceSubscriptionsOnClose, reason: "workspace_window_closed" });
init();
