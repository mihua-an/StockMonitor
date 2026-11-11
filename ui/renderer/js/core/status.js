import { apiPost, sharedStatusGet } from "./api.js";

export const MOOMOO_STATUS_MAX_AGE_MS = 9000;
import { $, escapeHtml } from "./utility.js";
import { getRealtimeSession, getRealtimeViewStats, getRealtimeTransportHealth } from "./realtime_stats.js";
import { buildDiagnosticsModel } from "./diagnostics_model.js";
import { renderDiagnostics } from "./diagnostics_panel.js";
import { morphInto } from "./dom_morph.js";
import { createMonitoringTrend } from "./monitoring_trend.js";

// Bottom-dock connection indicators, clock and on-demand diagnostics.
// Diagnostics fetch only when the user clicks a connection item; the 2-second
// status refresh remains lightweight.

export function updateCurrentTime() {
  const currentTimeText = $("currentTimeText");
  if (!currentTimeText) return;
  currentTimeText.textContent = new Date().toLocaleString("zh-TW", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function setConnectionStatus(dotId, textId, label, isOnline) {
  const dot = $(dotId);
  const text = $(textId);
  const online = Boolean(isOnline);
  if (dot) {
    dot.classList.toggle("online", online);
    dot.classList.toggle("offline", !online);
    dot.classList.remove("degraded");
  }
  if (text) text.textContent = `${label} ${online ? "已連線" : "未連線"}`;
}

// The page-level "this is not live data" indicator now renders here
// instead of a separate banner -- one place for connection state, consistent
// with how setBrokerConnectionStatus()/setMoomooConnectionStatus() already
// fold their own "(行情停滯)"/"(休市)" nuance into this same dock instead of
// a dedicated element. `setWebSocketOnline()` (driven by
// subscribeRealtimeConnectionState, called frequently from app.js) and
// `setWebSocketFreshness()` (driven by features/realtime/session_state.js's
// recomputeFreshnessBanner(), realtime-page-only) each own one independent
// half of the dot's state and never overwrite the other's half -- avoids the
// two call sites racing to reset a class the other just set.
let wsOnline = false;
let wsFreshnessTone = null; // null | "reconnecting" | "stale"
// Market Runtime still replaying its WAL (realtime.js publishes its RECOVERING answers); null once it serves.
let marketRuntimeRecovery = null;
export function marketRuntimeRecoveryLabel(recovery) {
  if (!recovery) return "";
  const total = Number(recovery.total) || 0, replayed = Number(recovery.replayed) || 0;
  if (String(recovery.phase || "") !== "replaying" || total <= 0) return "行情引擎復原中（檢查資料）";
  return `行情引擎復原中 ${Math.min(100, Math.floor(replayed / total * 100))}%`;
}
try {
  window.addEventListener("stock-monitor:market-runtime-recovery", (event) => {
    marketRuntimeRecovery = event?.detail || null;
    renderWebSocketStatus();
  });
} catch (error) { console.warn("[status: hooking the WebSocket status] failed", error); }
function renderWebSocketStatus() {
  const dot = $("wsStatusDot");
  const text = $("wsStatusText");
  const staleWhileConnected = wsFreshnessTone === "stale" && wsOnline;
  const reconnecting = wsFreshnessTone === "reconnecting";
  const recovering = marketRuntimeRecoveryLabel(marketRuntimeRecovery);
  const label = recovering || (staleWhileConnected ? "已連線（資料未同步）" : reconnecting ? "重新連線中" : (wsOnline ? "已連線" : "未連線"));
  if (dot) {
    dot.classList.toggle("online", wsOnline && !staleWhileConnected);
    dot.classList.toggle("offline", !wsOnline && !reconnecting && !recovering);
    dot.classList.toggle("degraded", Boolean(recovering) || staleWhileConnected || reconnecting);
  }
  if (text) text.textContent = recovering || `WebSocket ${label}`;
}
// tone: null | "disconnected" | "reconnecting" | "stale" (mirrors
// core/realtime_freshness_banner.js's FRESHNESS_TONE plus null for "fresh").
// "disconnected" needs no special-casing here: wsOnline is already false by
// the time that tone is reported (both come from the same
// subscribeRealtimeConnectionState transition), so the plain offline label
// already reads correctly.
export function setWebSocketFreshness({ tone = null } = {}) {
  wsFreshnessTone = tone;
  renderWebSocketStatus();
}

function setBrokerConnectionStatus(brokerStatus) {
  const dot = $("shioajiStatusDot");
  const text = $("shioajiStatusText");
  const authority = String(brokerStatus?.authority || "");
  const readiness = brokerStatus?.readiness || {};
  const state = String(readiness?.state || "DISCONNECTED").toUpperCase();
  const connected = authority === "persistent_market_daemon" && Boolean(readiness?.connected);
  // No session trading yet, but Market Runtime's current session is in its pre-open (試撮 delivering): not 休市.
  const session = getRealtimeSession();
  const inPreopen = String(session?.equity?.phase || "").toUpperCase() === "PREOPEN"
    || Object.values(session?.futures || {}).some((entry) => String(entry?.phase || "").toUpperCase() === "PREOPEN");
  const preopen = connected && state === "MARKET_CLOSED" && inPreopen;
  const marketClosed = connected && state === "MARKET_CLOSED" && !preopen;
  const waitingSession = connected && state === "STARTING";
  const streamStale = connected && state === "STALE";
  const degraded = marketClosed || waitingSession || streamStale;
  if (dot) {
    dot.classList.toggle("online", connected && !degraded);
    dot.classList.toggle("offline", !connected);
    dot.classList.toggle("degraded", degraded);
  }
  let detail = "未連線";
  if (connected) {
    if (marketClosed) detail = "已連線（休市）";
    else if (preopen) detail = "已連線（盤前試撮）";
    else if (waitingSession) detail = "已連線（等待新時段）";
    else if (streamStale) detail = "已連線（行情停滯）";
    else detail = "已連線";
  }
  if (text) text.textContent = `永豐 ${detail}`;
}

// FastAPI answering again is a readiness transition: a page whose one read failed while it was down binds on it
// (onApiOnline) instead of retrying on a timer. The FASTAPI light and this state have one writer, refreshStatus()'s
// /api/status read: the Market Runtime socket, a page's own request or the model center answering says nothing about
// FastAPI, so none of them may turn it on or off.
let apiOnline = null;
const apiOnlineListeners = new Set();
function setApiOnline(isOnline) {
  const next = Boolean(isOnline);
  setConnectionStatus("apiStatusDot", "apiStatusText", "FASTAPI", next);
  const cameOnline = next && apiOnline !== true;
  apiOnline = next;
  if (!cameOnline) return;
  for (const listener of [...apiOnlineListeners]) {
    try { listener(); } catch (error) { console.warn("[STATUS] api-online listener failed", error); }
  }
}
/** Called once, the next time FastAPI comes (back) online; returns the unsubscribe. */
export function onApiOnline(listener) {
  const once = () => { apiOnlineListeners.delete(once); listener(); };
  apiOnlineListeners.add(once);
  return () => apiOnlineListeners.delete(once);
}
export function setWebSocketOnline(isOnline) { wsOnline = Boolean(isOnline); renderWebSocketStatus(); }
// /api/status unanswered: the persistent Shioaji provider may well still be connected, so the 永豐 light says it is
// unknown rather than 未連線 (the light's only input is that read's broker_status).
function setShioajiStatusUnknown() {
  const dot = $("shioajiStatusDot");
  const text = $("shioajiStatusText");
  if (dot) { dot.classList.remove("online", "offline"); dot.classList.add("degraded"); }
  if (text) text.textContent = "永豐 狀態未知（FastAPI 無回應）";
}
export function setMoomooOnline(isOnline) {
  setConnectionStatus("moomooStatusDot", "moomooStatusText", "Futu", isOnline);
}

export function setMoomooStatusUnknown() {
  const dot = $("moomooStatusDot");
  const text = $("moomooStatusText");
  if (dot) { dot.classList.remove("online", "degraded"); dot.classList.add("offline"); }
  if (text) text.textContent = "Futu 未連線（FastAPI 無回應）";
}

// The client only attaches once OpenD is reachable (attach_in_background
// gives up after a single OPEND_NOT_RUNNING classification instead of
// retrying forever -- see service/market/futu/daemon_client.py). While
// unattached, /api/futu/status 503s with the daemon's last cached probe
// under `daemon`; read that directly instead of showing an indefinite
// "confirming" label, so the dock always states a definite, actionable reason.
function setMoomooUnattachedStatus(body) {
  const dot = $("moomooStatusDot");
  const text = $("moomooStatusText");
  // disabled_source("futu") shapes the body itself this way (no `daemon` key);
  // the not-yet-attached 503 instead nests the daemon's cached probe.
  if (body?.enabled === false) {
    if (dot) { dot.classList.remove("online", "degraded"); dot.classList.add("offline"); }
    if (text) text.textContent = "Futu 未啟用";
    return;
  }
  const daemon = body?.daemon || {};
  if (dot) { dot.classList.remove("online", "degraded"); dot.classList.add("offline"); }
  if (text) text.textContent = daemon.opend_reachable === false
    ? "Futu 未連線（OpenD 未啟動）"
    : "Futu 未連線";
}

function setMoomooConnectionStatus(status = {}) {
  if (status?.enabled === false || status?.source_status?.lifecycle === "disabled") {
    const dot = document.getElementById("moomooStatusDot");
    const text = document.getElementById("moomooStatusText");
    if (dot) { dot.classList.remove("online", "degraded"); dot.classList.add("offline"); }
    if (text) text.textContent = "Futu 未啟用";
    return;
  }
  const readiness = status?.readiness || {};
  const connected = Boolean(readiness?.connected);
  const dot = document.getElementById("moomooStatusDot");
  const text = document.getElementById("moomooStatusText");
  const preparing = connected && readiness?.state === "STARTING";
  const stale = connected && readiness?.state === "STALE";
  const marketClosed = connected && readiness?.state === "MARKET_CLOSED";
  if (dot) {
    dot.classList.toggle("online", connected && !preparing && !stale && !marketClosed);
    dot.classList.toggle("offline", !connected);
    dot.classList.toggle("degraded", preparing || stale || marketClosed);
  }
  // opend_reachable is specifically a plain-TCP-connect result to OpenD's own
  // port (see service/market/futu/opend_lifecycle.py's _opend_port_reachable)
  // -- false means OpenD itself is not running/listening, not some other
  // connection/contract problem, so this is worth telling apart from a bare
  // "未連線" the user cannot act on.
  const opendNotRunning = !connected && status?.opend_reachable === false;
  if (text) text.textContent = !connected
    ? (opendNotRunning ? "Futu 未連線（OpenD 未啟動）" : "Futu 未連線")
    : (marketClosed ? "Futu 已連線（休市）" : (stale ? "Futu 已連線（行情停滯）" : (preparing ? "Futu 已連線（行情準備中）" : "Futu 已連線")));
}

export async function refreshStatus() {
  // Shared with the session lifecycle (/api/status) and the Futu product list (/api/futu/status). This read sets the
  // /api/status cadence (app.js), so it never reuses a finished answer -- the poll's 1 s turns would land inside the
  // reuse window and every other one would read nothing new -- and only joins one in flight. Futu readiness changes on
  // the order of seconds to minutes: the dock reuses a fresh answer instead of asking again.
  const [statusResult, moomooResult] = await Promise.allSettled([
    sharedStatusGet("/api/status", 0),
    sharedStatusGet("/api/futu/status", MOOMOO_STATUS_MAX_AGE_MS),
  ]);
  // apiGet() no longer throws for a classified non-2xx response (e.g. the
  // not-yet-attached/shutdown-gate 503 this route can return) - it resolves
  // with the parsed `{ok:false, ...}` body instead, which already carries the
  // daemon's last cached probe under `daemon`. Use that to render a definite
  // reason instead of only distinguishing "ok" versus totally unreachable.
  const moomooBody = moomooResult.status === "fulfilled" ? moomooResult.value : null;
  if (moomooResult.status === "rejected") console.warn("[status: GET /api/futu/status] failed", moomooResult.reason);
  if (moomooBody?.ok) setMoomooConnectionStatus(moomooBody);
  else if (moomooBody) setMoomooUnattachedStatus(moomooBody);
  else setMoomooStatusUnknown();
  if (statusResult.status === "rejected" || statusResult.value?.ok === false) {
    setApiOnline(false);
    setShioajiStatusUnknown();
    if (statusResult.status === "rejected") throw statusResult.reason;
    throw new Error(statusResult.value?.error || "GET /api/status failed");
  }
  setApiOnline(true);
  const shioaji = statusResult.value?.sources?.shioaji;
  if (shioaji?.enabled === false) {
    const dot = document.getElementById("shioajiStatusDot");
    const text = document.getElementById("shioajiStatusText");
    if (dot) { dot.classList.remove("online", "degraded"); dot.classList.add("offline"); }
    if (text) text.textContent = "永豐未啟用";
  } else {
    const brokerStatus = statusResult.value?.broker_status || {};
    setBrokerConnectionStatus(brokerStatus);
  }
  return statusResult.value;
}

// 系統連線診斷 (core/diagnostics_panel.js draws it). While the popover is open it polls every 2 s -- the same
// cadence as Health's snapshot -- and keeps Health's detail collection alive; closing it stops both.
const DIAGNOSTICS_POLL_MS = 2000;
const DIAGNOSTICS_DETAIL_RENEW_MS = 4000;
// No single source may hold the panel up: a busy API (realtime_api with every worker thread parsing a
// closed 期貨 session) could keep it closed for 30 s+. A source that misses this is drawn as not reported.
const DIAGNOSTICS_SOURCE_TIMEOUT_MS = 2500;
function withinDiagnosticsBudget(promise) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("diagnostics source timed out")), DIAGNOSTICS_SOURCE_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
const diagnostics = { timer: null, model: null, trend: createMonitoringTrend(), selected: "sources", startup: null, detailAt: 0, busy: false };

async function loadDiagnosticsInputs() {
  const api = window.desktopAPI;
  if (Date.now() - diagnostics.detailAt >= DIAGNOSTICS_DETAIL_RENEW_MS) {
    diagnostics.detailAt = Date.now();
    api?.requestMonitoringDetail?.()?.catch?.((error) => console.warn("[diagnostics: requestMonitoringDetail] failed", error));
  }
  let monitoringReceivedAt = null;
  // How long this App start took (Electron main's startup coordinator): read until the first screen is in, then kept.
  const readStartup = !diagnostics.startup?.steps?.some((step) => step.id === "first_paint" && step.status === "done");
  // The Shioaji connection and each provider's acknowledgements are Health's snapshot alone (its provider probes):
  // /api/status is not read here.
  const [external, monitoring, moomoo, startup] = await Promise.allSettled([
    api?.getExternalHealth?.() || Promise.resolve(null),
    Promise.resolve(api?.getMonitoringSnapshot?.({ trendSince: diagnostics.trend.since() }) || null).then((value) => { monitoringReceivedAt = Date.now(); return value; }),
    sharedStatusGet("/api/futu/status", MOOMOO_STATUS_MAX_AGE_MS),
    readStartup ? Promise.resolve(api?.getStartupState?.() || null) : Promise.resolve(diagnostics.startup),
  ].map(withinDiagnosticsBudget));
  // A source that failed or missed its budget is drawn as not reported, and recorded by name; the start-up steps
  // keep what was last read.
  const sources = { getExternalHealth: external, getMonitoringSnapshot: monitoring, "GET /api/futu/status": moomoo, getStartupState: startup };
  for (const [source, result] of Object.entries(sources)) {
    if (result.status === "rejected") console.warn(`[diagnostics: ${source}] failed`, result.reason);
  }
  const value = (result) => (result.status === "fulfilled" ? result.value : null);
  const snapshot = value(monitoring)?.snapshot || null;
  // The totals' lines are Health's trend points only (monitoring_trend.js).
  if (snapshot) diagnostics.trend.apply(snapshot);
  if (startup.status === "fulfilled") diagnostics.startup = startup.value;
  // Already loaded by app.js (startRendererRuntimeHealth); imported lazily so status.js does not pull it in first.
  const paint = await import("./renderer_runtime_health.js").then((m) => m.rendererPaintStats?.() || null).catch((error) => { console.warn("[diagnostics: reading paint stats] failed", error); return null; });
  return {
    external: value(external), monitoring: snapshot, monitoringReceivedAt, moomoo: value(moomoo),
    trend: diagnostics.trend.points(), views: getRealtimeViewStats(), transport: getRealtimeTransportHealth(), paint, startup: diagnostics.startup,
    // The dock's own 資料未同步 (setWebSocketFreshness): the WebSocket node says the same.
    freshness: wsFreshnessTone,
  };
}

async function loadDiagnostics() {
  const input = await loadDiagnosticsInputs();
  diagnostics.model = buildDiagnosticsModel(input, diagnostics.model);
  // The topology is the overview: no separate 服務總覽 card lists the same services again.
  return renderDiagnostics(diagnostics.model, diagnostics.selected);
}

// Every poll morphs the panel to the new markup (dom_morph.js): only the values that changed are written, so the
// cards, keyboard focus and the map's SVG stay the same elements. A failed poll replaces the panel with the error.
async function refreshDiagnostics() {
  const body = $("serviceDiagnosticsBody");
  if (!body || diagnostics.busy) return;
  diagnostics.busy = true;
  try {
    morphInto(body, await loadDiagnostics());
  } catch (error) {
    console.warn("[diagnostics: drawing the panel] failed", error);
    morphInto(body, `<p class="dg-empty">診斷資料讀取失敗：${escapeHtml(error?.message || error)}</p>`);
  } finally {
    diagnostics.busy = false;
  }
}

export async function openServiceDiagnostics() {
  const popover = $("serviceDiagnosticsPopover");
  const body = $("serviceDiagnosticsBody");
  if (!popover || !body) return;
  popover.hidden = false;
  popover.setAttribute("aria-hidden", "false");
  if (!diagnostics.model) morphInto(body, '<p class="dg-empty">讀取中…</p>');
  // Health kept sampling while the panel was closed: the first read takes the points after the last one held.
  await refreshDiagnostics();
  clearInterval(diagnostics.timer);
  diagnostics.timer = setInterval(() => { void refreshDiagnostics(); }, DIAGNOSTICS_POLL_MS);
}

export function closeServiceDiagnostics() {
  const popover = $("serviceDiagnosticsPopover");
  clearInterval(diagnostics.timer);
  diagnostics.timer = null;
  if (!popover) return;
  popover.hidden = true;
  popover.setAttribute("aria-hidden", "true");
}

export function bindServiceStatusDiagnostics() {
  document.querySelectorAll("[data-service-diagnostics]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openServiceDiagnostics();
    });
  });
  $("serviceDiagnosticsCloseBtn")?.addEventListener("click", closeServiceDiagnostics);
  // Manual retry only -- attach_in_background stops on its own once OpenD is
  // confirmed down (see service/market/futu/daemon_client.py), so this button
  // is the one place a reattach attempt gets triggered again.
  const selectNode = (event) => {
    const node = event.target?.closest?.("[data-dg-node]");
    if (!node) return false;
    diagnostics.selected = node.dataset.dgNode;
    void refreshDiagnostics();
    return true;
  };
  $("serviceDiagnosticsBody")?.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && selectNode(event)) event.preventDefault();
  });
  $("serviceDiagnosticsBody")?.addEventListener("click", async (event) => {
    if (selectNode(event)) return;
    const button = event.target?.closest?.("[data-moomoo-reconnect]");
    if (!button) return;
    event.stopPropagation();
    button.disabled = true;
    button.textContent = "檢查中...";
    try {
      // A classified failure answers {ok:false} (api.js returns the body): it is a failure, not a reconnect.
      const result = await apiPost("/api/futu-daemon/reconnect");
      if (result?.ok === false) throw new Error(result.error || result.message || "reconnect refused");
      await refreshStatus().catch((error) => console.warn("[status: refreshing after the Futu reconnect] failed", error));
      await refreshDiagnostics();
    } catch (error) {
      console.warn("[diagnostics: POST /api/futu-daemon/reconnect] failed", error);
      button.disabled = false;
      button.textContent = `失敗：${error?.message || error}`;
    }
  });
  document.addEventListener("click", (event) => {
    const popover = $("serviceDiagnosticsPopover");
    if (!popover || popover.hidden) return;
    if (popover.contains(event.target) || event.target?.closest?.("[data-service-diagnostics]")) return;
    closeServiceDiagnostics();
  });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeServiceDiagnostics(); });
}
