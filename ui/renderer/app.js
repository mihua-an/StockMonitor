// First: every later warning and error is recorded as text (js/core/console_relay.js).
import "./js/core/console_relay.js";
import "./js/dashboard_components.js";
import { appState } from "./js/core/state.js";
import { initializeSourceSettings, startupStepEnabled } from "./js/core/source_settings.js";
import { userFacingMessage } from "./js/core/user_action.js";
import { $, escapeHtml } from "./js/core/utility.js";
import { updateCurrentTime, setWebSocketOnline, setMoomooOnline, refreshStatus, bindServiceStatusDiagnostics } from "./js/core/status.js";
// Keep the live_* modules on one canonical module URL each: a query string makes Chromium instantiate a second copy
// (live_monitor_events.js would then hold a separate liveMonitorEvents, and the visible EventFeed would stay empty).
import { renderRealtimeQuoteTable } from "./js/features/realtime/realtime_presentation.js";
import { initGlobalTradeEntry } from "./js/features/account/trade_entry.js";
import { initUpdateNotice } from "./js/features/app_update/update_notice.js";
import { startRealtimeStream, stopRealtimeStream, notifyBackendReadyForRealtime, sendRealtimeClientMetric, subscribeRealtimeConnectionState, REALTIME_CONNECTION_STATE } from "./js/market_data/realtime.js";
import { isRealtimePageMounted, initRealtimePage, refreshRealtimePage, resumeRealtimePage, resizeRealtimePage, setRealtimePageVisible, getLiveMarketDataDiagnostics } from "./js/pages/realtime.js";
import { installStandardDataGridSystem, applyStandardDataGrids } from "./js/core/data_grid.js";
import { hydrateCanonicalColumnTitles } from "./js/core/column_schemas.js";
import { resolvePage, loadPageModule } from "./js/core/page_registry.js";
import { moomooQuoteStore } from "./js/features/realtime/moomoo_quote_store.js";
import { createNavigationCoordinator } from "./js/features/navigation/navigation_coordinator.js";
import { isModulePage, loadPageData, mountPageModule } from "./js/features/navigation/page_mount.js";
import { installDockScreenSwitcher } from "./js/features/layouts/dock_screen_switcher.js";

// 應用程式入口：切頁、自動刷新與啟動

const pageHtmlCache = new Map();
let realtimeConnected = false;
// A (re)connect needs nothing from this module: the transport re-subscribes every view it holds and re-sends the
// focus (realtime.js open handler, RealtimeViewStore.onConnected). The connect-time "subscription repair" timers
// (500/1500/3500 ms) and the full-page re-hydration after a reconnect are gone.

// Read-only acceptance surface used by the App-only restart stress harness.
// It observes the same renderer state and DOM that the user sees.
let startupAcceptanceReadySince = 0;
window.__stockMonitorStartupAcceptance = () => {
  const acceptance = getLiveMarketDataDiagnostics()?.startupAcceptance || { ok: false, checks: {} };
  if (!acceptance.ok) startupAcceptanceReadySince = 0;
  else if (!startupAcceptanceReadySince) startupAcceptanceReadySince = performance.now();
  const stableMs = startupAcceptanceReadySince ? performance.now() - startupAcceptanceReadySince : 0;
  const visualSettled = acceptance.ok && stableMs >= 500;
  return {
    ...acceptance,
    ok: Boolean(visualSettled),
    checks: { ...(acceptance.checks || {}), visual_settled: Boolean(visualSettled) },
    visual_stable_ms: Math.round(stableMs),
  };
};
let realtimePageCache = null;
let startupProgressSnapshot = null;
let startupProgressTimer = null;
let startupOverlayDismissed = false;
let lastStartupActiveStepId = "";

function formatStartupMs(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  return `${ms}ms`;
}

const STARTUP_PHASE_ORDER = Object.freeze(["CORE", "BACKEND", "CATALOG", "SHIOAJI", "FUTU", "UI"]);
const STARTUP_SETTLED_STATES = new Set(["done", "degraded", "failed", "skipped"]);

function startupPhaseGroups(steps = []) {
  const byPhase = new Map();
  for (const step of steps) {
    const phase = String(step?.phase || "UNIT").toUpperCase();
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(step);
  }
  const ordered = [];
  for (const phase of STARTUP_PHASE_ORDER) {
    if (byPhase.has(phase)) {
      ordered.push([phase, byPhase.get(phase)]);
      byPhase.delete(phase);
    }
  }
  for (const entry of byPhase.entries()) ordered.push(entry);
  return ordered;
}

function startupLocalPosition(step, steps = []) {
  const phase = String(step?.phase || "UNIT").toUpperCase();
  const phaseSteps = steps.filter((candidate) => String(candidate?.phase || "UNIT").toUpperCase() === phase);
  const index = Math.max(0, phaseSteps.findIndex((candidate) => candidate.id === step?.id)) + 1;
  return { phase, index, total: phaseSteps.length };
}

function ensureStartupStepRows(steps = []) {
  const list = document.getElementById("startupStepList");
  if (!list) return;
  const signature = steps.map((step) => `${step.id}:${step.label}:${step.phase || ""}`).join("|");
  if (list.dataset.startupSignature === signature) return;
  list.dataset.startupSignature = signature;
  list.replaceChildren();

  for (const [phaseName, phaseSteps] of startupPhaseGroups(steps)) {
    const group = document.createElement("section");
    group.className = "startup-phase-group";
    group.dataset.startupPhaseGroup = phaseName;

    const header = document.createElement("div");
    header.className = "startup-phase-header";
    const title = document.createElement("span");
    title.className = "startup-phase-title";
    title.textContent = phaseName;
    const count = document.createElement("span");
    count.className = "startup-phase-count";
    count.dataset.startupPhaseCount = phaseName;
    count.textContent = `0/${phaseSteps.length}`;
    header.append(title, count);

    const rows = document.createElement("div");
    rows.className = "startup-phase-rows";
    phaseSteps.forEach((step, phaseIndex) => {
      const row = document.createElement("div");
      row.className = "startup-step-row";
      row.dataset.startupStep = String(step.id || "");
      row.dataset.startupPhase = phaseName;

      const index = document.createElement("span");
      index.className = "startup-step-index";
      index.textContent = `[${phaseIndex + 1}/${phaseSteps.length}]`;

      const label = document.createElement("span");
      label.className = "startup-step-label";
      label.textContent = String(step.label || step.id || "Startup Unit");

      const duration = document.createElement("span");
      duration.className = "startup-step-duration";
      duration.textContent = "等待中";

      row.append(index, label, duration);
      rows.appendChild(row);
    });

    group.append(header, rows);
    list.appendChild(group);
  }
}

function renderStartupProgress(snapshot = startupProgressSnapshot) {
  if (LAYOUT_EDITOR_WINDOW || !snapshot || startupOverlayDismissed) return;
  startupProgressSnapshot = snapshot;
  const overlay = document.getElementById("startupOverlay");
  if (!overlay) return;
  const totalElapsed = document.getElementById("startupTotalElapsed");
  const overallProgress = document.getElementById("startupOverallProgress");
  const message = document.getElementById("startupProgressMessage");
  const nowMs = Date.now();
  if (totalElapsed) {
    const started = Date.parse(snapshot.startup_started_at || "");
    totalElapsed.textContent = formatStartupMs(Number.isFinite(started) ? nowMs - started : snapshot.startup_elapsed_ms);
  }

  const steps = Array.isArray(snapshot.steps) ? snapshot.steps : [];
  ensureStartupStepRows(steps);
  if (overallProgress) {
    const completed = Number(snapshot.startup_steps_completed) || steps.filter((step) => STARTUP_SETTLED_STATES.has(String(step.status || "pending"))).length;
    overallProgress.textContent = `完成 ${completed} / ${steps.length} 個啟動單元`;
  }
  for (const step of steps) {
    const row = overlay.querySelector(`[data-startup-step="${CSS.escape(String(step.id || ""))}"]`);
    if (!row) continue;
    row.classList.remove("is-running", "is-done", "is-degraded", "is-skipped", "is-failed");
    const status = String(step.status || "pending");
    if (status !== "pending") row.classList.add(`is-${status}`);
    const duration = row.querySelector(".startup-step-duration");
    if (!duration) continue;
    if (status === "running") {
      const started = Date.parse(step.started_at || "");
      const elapsed = Number.isFinite(started) ? Math.max(0, nowMs - started) : Number(step.elapsed_ms) || 0;
      duration.textContent = `載入中 [${formatStartupMs(elapsed)}]`;
    } else if (status === "done") {
      duration.textContent = formatStartupMs(step.duration_ms ?? step.elapsed_ms);
    } else if (status === "degraded") {
      duration.textContent = `背景處理 [${formatStartupMs(step.duration_ms ?? step.elapsed_ms)}]`;
    } else if (status === "skipped") {
      duration.textContent = `略過 [${formatStartupMs(step.duration_ms ?? step.elapsed_ms)}]`;
    } else if (status === "failed") {
      duration.textContent = `失敗 [${formatStartupMs(step.duration_ms ?? step.elapsed_ms)}]`;
    } else {
      duration.textContent = "等待中";
    }
  }

  for (const [phaseName, phaseSteps] of startupPhaseGroups(steps)) {
    const count = overlay.querySelector(`[data-startup-phase-count="${CSS.escape(phaseName)}"]`);
    const group = overlay.querySelector(`[data-startup-phase-group="${CSS.escape(phaseName)}"]`);
    const settled = phaseSteps.filter((step) => STARTUP_SETTLED_STATES.has(String(step.status || "pending"))).length;
    if (count) count.textContent = `${settled}/${phaseSteps.length}`;
    if (group) {
      group.classList.toggle("is-running", phaseSteps.some((step) => step.status === "running"));
      group.classList.toggle("is-failed", phaseSteps.some((step) => step.status === "failed"));
      group.classList.toggle("is-complete", settled === phaseSteps.length);
    }
  }

  const active = steps.find((step) => step.status === "running");
  if (active?.id && active.id !== lastStartupActiveStepId) {
    lastStartupActiveStepId = String(active.id);
    const activeRow = overlay.querySelector(`[data-startup-step="${CSS.escape(lastStartupActiveStepId)}"]`);
    activeRow?.scrollIntoView?.({ block: "nearest" });
  }
  const failure = steps.find((step) => step.required && step.status === "failed");
  if (message) {
    message.classList.toggle("is-error", Boolean(failure));
    if (failure) {
      const pos = startupLocalPosition(failure, steps);
      message.textContent = `${pos.phase} [${pos.index}/${pos.total}] ${failure.label}失敗：${failure.detail || "請查看啟動診斷"}`;
    } else if (active) {
      const pos = startupLocalPosition(active, steps);
      message.textContent = `目前：${pos.phase} [${pos.index}/${pos.total}] ${active.label}${active.detail ? `｜${active.detail}` : ""}`;
    }
    else if (snapshot.startup_progress_complete) message.textContent = "啟動流程完成，正在進入主介面...";
    else message.textContent = "等待啟動流程完成...";
  }

  // A blocking failure is terminal too: the overlay stays, but nothing on it changes any more, so the 50 ms
  // redraw stops (never running for the life of the window).
  if (snapshot.startup_blocking_failure && startupProgressTimer) {
    window.clearInterval(startupProgressTimer);
    startupProgressTimer = null;
  }
  if (snapshot.startup_progress_complete && !snapshot.startup_blocking_failure) {
    startupOverlayDismissed = true;
    window.setTimeout(() => {
      overlay.hidden = true;
      document.body.removeAttribute("data-startup-active");
      if (startupProgressTimer) window.clearInterval(startupProgressTimer);
      startupProgressTimer = null;
    }, 120);
  }
}

async function reportRendererStartupStep(stepId, action, detail = null) {
  if (LAYOUT_EDITOR_WINDOW) return null;   // the App's startup is the main window's to report
  try {
    const snapshot = await window.desktopAPI?.reportStartupStep?.({ step_id: stepId, action, detail });
    if (snapshot) renderStartupProgress(snapshot);
    return snapshot;
  } catch (error) {
    console.warn(`[STARTUP UI] report ${stepId}/${action} failed`, error);
    return null;
  }
}

async function runRendererStartupUnit(stepId, detail, executor, successDetail = null) {
  await reportRendererStartupStep(stepId, "start", detail);
  try {
    const result = await executor();
    const finalDetail = typeof successDetail === "function" ? successDetail(result) : successDetail;
    await reportRendererStartupStep(stepId, "complete", finalDetail);
    return result;
  } catch (error) {
    await reportRendererStartupStep(stepId, "failed", String(error?.message || error));
    throw error;
  }
}

function runOptionalRendererStartupUnit(stepId, { detail, timeoutMs, timeoutDetail }, executor) {
  if (!startupStepEnabled(stepId)) return Promise.resolve({ ok: true, skipped: true });
  void reportRendererStartupStep(stepId, "start", detail);
  let settled = false;
  const timeout = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    void reportRendererStartupStep(stepId, "degraded", timeoutDetail || "背景持續處理");
  }, Math.max(1, Number(timeoutMs) || 1));
  Promise.resolve()
    .then(executor)
    .then((result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (result && result.ok === false) {
        void reportRendererStartupStep(stepId, "degraded", result.error || "背景持續處理");
      } else {
        void reportRendererStartupStep(stepId, "complete", result?.detail || null);
      }
    })
    .catch((error) => {
      if (settled) {
        // The step was already reported degraded at its deadline; the failure that ended it still gets a record.
        console.warn(`[optional startup step ${stepId}] failed after its deadline`, error);
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      void reportRendererStartupStep(stepId, "degraded", String(error?.message || error));
    });
}

async function loadFutuWatchPagesStartup() {
  const payload = await window.desktopAPI?.loadWatchPagesLocal?.();
  const pages = (Array.isArray(payload?.pages) ? payload.pages : []).filter((page) => {
    return page?.source === "futu";
  });
  const codes = new Set();
  for (const page of pages) {
    for (const raw of Array.isArray(page?.codes) ? page.codes : []) {
      const code = String(raw || "").trim().toUpperCase();
      if (code) codes.add(code);
    }
  }
  return { ok: true, detail: `${pages.length} 個自選頁 · ${codes.size} 檔商品` };
}

// One read, made once Health says the Futu provider serves (the store waits for it); a start that is slower than this
// step's timeout reports "still loading" while the store keeps waiting.
async function bootstrapMoomooProducts() {
  const snapshot = await moomooQuoteStore.bootstrap();
  if (snapshot?.initialized) return { ok: true, detail: `${snapshot.products?.length || 0} 檔商品` };
  return { ok: false, error: String(snapshot?.status?.last_error || "Futu 商品背景載入中") };
}

async function initializeStartupProgressUi() {
  const unsubscribe = window.desktopAPI?.onStartupProgress?.((snapshot) => renderStartupProgress(snapshot));
  try {
    const snapshot = await window.desktopAPI?.getStartupState?.();
    if (snapshot) renderStartupProgress(snapshot);
  } catch (error) {
    console.warn("[STARTUP UI] initial state unavailable", error);
  }
  if (!startupProgressTimer) {
    startupProgressTimer = window.setInterval(() => renderStartupProgress(), 50);
  }
  return unsubscribe;
}

function waitForRendererPaint(frameCount = 2) {
  const frames = Math.max(1, Number(frameCount) || 1);
  return new Promise((resolve) => {
    const next = (remaining) => {
      if (remaining <= 0) return resolve();
      window.requestAnimationFrame(() => next(remaining - 1));
    };
    next(frames);
  });
}

function runPostStartupTask(label, task, delayMs = 180) {
  window.setTimeout(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => console.warn(`[POST STARTUP] ${label} failed`, error));
  }, Math.max(0, Number(delayMs) || 0));
}

function navigationTrace(event, detail = {}) {
  try {
    if (localStorage.getItem("marketDiagnostics") !== "1") return;
    const row = { event, timestamp: performance.now(), page: appState.currentPage, ...detail };
    window.__pageSwitchTrace = window.__pageSwitchTrace || [];
    window.__pageSwitchTrace.push(row);
    if (window.__pageSwitchTrace.length > 300) window.__pageSwitchTrace.splice(0, window.__pageSwitchTrace.length - 300);
    console.debug("[Navigation]", row);
  } catch (error) { console.warn("[navigation trace] failed", error); }
}

// Development-only bridge used by page-level layout/components so every
// navigation phase lands in one trace buffer.  It is inert unless diagnostics are enabled.
window.__navigationTrace = navigationTrace;

// This window is the 版型 editor 設定 opens (the same page with another start: ui/main/secondary_window_factory.js).
const LAYOUT_EDITOR_WINDOW = window.location.hash === "#layout-editor";

function cacheRealtimeDom(pageContainer) {
  if (!pageContainer || !pageContainer.childNodes.length) return;
  const fragment = document.createDocumentFragment();
  while (pageContainer.firstChild) fragment.appendChild(pageContainer.firstChild);
  realtimePageCache = fragment;
  navigationTrace("PAGE_HIDE", { reason: "CACHE_LIVE_DOM", subscription_reuse: true });
}

function restoreRealtimeDom(pageContainer) {
  if (!pageContainer || !realtimePageCache?.childNodes?.length) return false;
  pageContainer.replaceChildren(realtimePageCache);
  realtimePageCache = null;
  navigationTrace("PAGE_SHOW", { reason: "RESTORE_LIVE_DOM", chart_reuse: true, subscription_reuse: true });
  return true;
}

async function loadPageHtml(file) {
  if (pageHtmlCache.has(file)) return pageHtmlCache.get(file);
  const response = await fetch(file);
  if (!response.ok) throw new Error(`載入頁面失敗：${file}`);
  const html = await response.text();
  pageHtmlCache.set(file, html);
  return html;
}


// The window holds one page-fit job: a new schedule or a navigation cancels the pending one, and a job runs only while
// its page is still the current one (it never measures another page's DOM with the old page's rule).
const pageFitJob = { frame: 0, timer: 0 };
function cancelPageContentFit() {
  if (pageFitJob.frame) window.cancelAnimationFrame(pageFitJob.frame);
  if (pageFitJob.timer) window.clearTimeout(pageFitJob.timer);
  pageFitJob.frame = 0;
  pageFitJob.timer = 0;
}

function schedulePageContentFit(page) {
  cancelPageContentFit();
  if (page !== "realtime" && page !== "history") return;
  if (!window.desktopAPI?.fitPageContent) return;

  const run = () => {
    if (appState.currentPage !== page) return;
    const main = document.querySelector(".main-with-bottom-nav");
    if (!main) return;

    const mainStyle = window.getComputedStyle(main);
    const paddingRight = Number.parseFloat(mainStyle.paddingRight) || 0;

    if (page === "history") {
      window.desktopAPI.fitPageContent({
        mode: "history-minimum",
        fitWidth: false,
        fitHeight: false,
        viewportCssWidth: window.innerWidth,
        viewportCssHeight: window.innerHeight
      }).catch((error) => {
        console.warn("[WINDOW] history minimum width sync failed", error);
      });
      return;
    }

    // The pane workspace fills the page: its right edge is the page's.
    const realtimePage = document.querySelector(".realtime-workspace");
    if (!realtimePage) return;

    const targetCssWidth = Math.ceil(realtimePage.getBoundingClientRect().right + paddingRight);
    const realtimePageStyle = window.getComputedStyle(realtimePage);
    const realtimePageMinWidth = Number.parseFloat(realtimePageStyle?.minWidth) || 0;
    const paddingLeft = Number.parseFloat(mainStyle.paddingLeft) || 0;
    const minimumCssWidth = Math.ceil(realtimePageMinWidth + paddingLeft + paddingRight);

    window.desktopAPI.fitPageContent({
      mode: "realtime-right-edge",
      fitWidth: false,
      fitHeight: false,
      targetCssWidth,
      minimumCssWidth,
      viewportCssWidth: window.innerWidth,
      viewportCssHeight: window.innerHeight
    }).catch((error) => {
      console.warn("[WINDOW] realtime edge fit failed", error);
    });
  };

  // Two frames for layout, and once more after the late layout of the page's components settles.
  pageFitJob.frame = window.requestAnimationFrame(() => {
    pageFitJob.frame = window.requestAnimationFrame(() => { pageFitJob.frame = 0; run(); });
  });
  pageFitJob.timer = window.setTimeout(() => { pageFitJob.timer = 0; run(); }, 140);
}

// Navigation: one at a time, newest wins (navigation_coordinator.js); switchPage stops before it commits a page when a
// newer navigation was asked for meanwhile.
const navigation = createNavigationCoordinator((page, options, isCurrent) => switchPage(page, { ...options, isCurrent }));
const navigateTo = (page, options) => navigation.navigate(page, options);

// An event-driven UI action that failed: recorded with what was asked, never an unhandled rejection.
function recordUiActionError(action, detail) {
  return (error) => console.error(`[UI action: ${action}] failed`, { ...detail, from: appState.currentPage }, error);
}



async function switchPage(page, { startupFastPath = false, isCurrent = () => true } = {}) {
  const superseded = () => !isCurrent();
  const target = resolvePage(page);
  const previousPage = appState.currentPage;
  const navStarted = performance.now();
  const startupTimings = startupFastPath && page === "realtime" ? { started_at: navStarted } : null;
  const recordStartupPhase = (detail) => {
    if (!startupTimings) return;
    startupTimings[String(detail)] = Math.round(performance.now() - navStarted);
  };
  navigationTrace("NAV_START", { from: previousPage, to: page });
  cancelPageContentFit();
  // Clicking 即時報價 while already on it restored the DOM cached the last time the page was LEFT over the live
  // one, then resumeRealtimePage() found the page still mounted and mounted nothing: every panel became an
  // empty shell (商品列表「尚無資料」, blank Futu panels) until a reload. The live page is already shown.
  if (page === "realtime" && previousPage === "realtime" && !startupFastPath && isRealtimePageMounted()) {
    navigationTrace("NAV_END", { reason: "ALREADY_SHOWN" });
    schedulePageContentFit(page);
    return;
  }
  recordStartupPhase("準備即時報價頁面");

  // 進入新頁前只解除舊版可能殘留的最大寬度限制；
  // 監控報價 / 即時資訊只設定最小寬度，不限制使用者放大視窗。
  if (window.desktopAPI?.releasePageWidthLock) {
    try {
      await window.desktopAPI.releasePageWidthLock();
    } catch (error) {
      console.warn("[WINDOW] release page width lock failed", error);
    }
  }
  // Nothing of this navigation is committed yet: a newer one takes over from here.
  if (superseded()) {
    navigationTrace("NAV_END", { from: previousPage, to: page, reason: "SUPERSEDED" });
    return { superseded: true };
  }

  if (previousPage === "history" && page !== "history") {
    const historyModule = await loadPageModule("history");
    historyModule?.disposeHistoryPage?.();
  }

  if (previousPage === "training" && page !== "training") {
    const trainingModule = await loadPageModule("training");
    trainingModule?.disposeTrainingPage?.();
  }
  if (previousPage === "datacenter" && page !== "datacenter") {
    const mod = await loadPageModule("datacenter");
    mod?.disposeDataCenterPage?.();
  }
  if (previousPage === "account" && page !== previousPage) {
    const mod = await loadPageModule("account");
    mod?.disposeAccountPage?.();
  }
  if (previousPage === "settings" && page !== "settings") {
    const mod = await loadPageModule("settings");
    mod?.disposeSettingsPage?.();
  }

  const pageContainer = $("pageContainer");
  if (!pageContainer) throw new Error("pageContainer 不存在");

  // Retain the DOM shell and user layout. Page-owned listeners, components and
  // subscriptions are released while hidden and rehydrated from existing stores
  // on return; the renderer connection and canonical stores retain ownership.
  if (previousPage === "realtime" && page !== "realtime") {
    setRealtimePageVisible(false);
    cacheRealtimeDom(pageContainer);
  }

  appState.currentPage = page;
  // The shell lays itself out per page (layout/app-shell.css keys on it).
  document.body.dataset.activePage = page;
  document.querySelectorAll(".dock-nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === page);
  });

  let restoredRealtime = false;
  // The page's first data read, started once the page is mounted. The navigation does not wait for it (see
  // followPageLoad).
  let pageLoad = null;
  try {
    restoredRealtime = page === "realtime" && restoreRealtimeDom(pageContainer);
    if (restoredRealtime) {
      navigationTrace("PAGE_RESUME_MOUNT", { reason: "PAGE_RETURN" });
      const tableStarted = performance.now();
      navigationTrace("TABLE_RENDER_START", { reason: "PAGE_RETURN" });
      renderRealtimeQuoteTable();
      navigationTrace("TABLE_RENDER_END", { reason: "PAGE_RETURN", duration_ms: performance.now() - tableStarted });
      resumeRealtimePage();
      schedulePageContentFit(page);
    } else {
      const loadPageStructure = async () => {
        recordStartupPhase("載入頁面結構");
        pageContainer.innerHTML = await loadPageHtml(target.file);
        // Every real data-column Title is generated by the single canonical
        // Title engine before DataGrid turns the table into a split header/body shell.
        hydrateCanonicalColumnTitles(pageContainer);
        installStandardDataGridSystem(pageContainer);
        applyStandardDataGrids(pageContainer);
      };
      if (startupTimings) {
        await runRendererStartupUnit("realtime_html", "載入 HTML / DataGrid 結構", loadPageStructure, "頁面結構完成");
      } else {
        await loadPageStructure();
      }

      navigationTrace(page === "realtime" ? "REALTIME_MOUNT_START" : "PAGE_SHOW", { reason: "FRESH_MOUNT" });
      if (page === "realtime") {
        navigationTrace("SUBSCRIPTION_CREATE", { reason: "FRESH_MOUNT" });
        navigationTrace("CHART_RECREATE", { reason: "FRESH_MOUNT" });
      }
      recordStartupPhase("掛載即時元件");
      const mounted = await bindPageEvents(page, { startupFastPath });
      if (page === "realtime") {
        navigationTrace("REALTIME_MOUNT_END", { duration_ms: performance.now() - navStarted });
        recordStartupPhase("完成首屏排版");
      }
      schedulePageContentFit(page);
      // A restored live page already owns current canonical state/subscriptions and was invalidated by
      // resumeRealtimePage(), and the startup mount is hydrated after first paint (runPostStartupTask): neither
      // reads here.
      if (mounted) pageLoad = mounted.loaded;
      else if (!startupFastPath) pageLoad = refreshCurrentPage(page);
    }
  } catch (error) {
    pageContainer.innerHTML = `
      <div class="panel">
        <div class="empty">${escapeHtml(userFacingMessage(error, "頁面載入失敗，請重新開啟後再試", { context: "PAGE_LOAD" }))}</div>
      </div>
    `;
    // Startup failures must reach the coordinator. The old catch-and-return
    // behavior made a failed realtime mount look like a successful startup unit.
    if (startupFastPath) throw error;
    return;
  }

  if (pageLoad) followPageLoad(page, pageLoad, isCurrent);

  if (startupTimings) {
    await runRendererStartupUnit(
      "first_paint",
      "等待 Chromium 完成首屏 layout / paint",
      () => waitForRendererPaint(2),
      "首屏已繪製",
    );
    startupTimings.first_paint_ms = Math.round(performance.now() - navStarted);
    window.__realtimeStartupTimings = startupTimings;
    console.info("[REALTIME STARTUP PERF]", startupTimings);
  }
  navigationTrace("FIRST_MEANINGFUL_PAINT", { restored: restoredRealtime });
  navigationTrace("NAV_END", { from: previousPage, to: page, restored: restoredRealtime, duration_ms: performance.now() - navStarted });
}

// Mounts the page on its inserted HTML. A module page returns `{ loaded }` (page_mount.js: its first read, already
// started); 即時報價 returns null.
async function bindPageEvents(page, { startupFastPath = false } = {}) {
  if (page === "realtime") {
    await initRealtimePage({
      startupFastPath,
      reportStartupUnit: startupFastPath ? reportRendererStartupStep : null,
    });
    return null;
  }
  return mountPageModule(page, await loadPageModule(page));
}

// The page's first read runs beside the page: the navigation has ended and the next one may already run. The page
// drops an answer that arrives after it was left; here only the window fit waits for it, and only while this
// navigation is still the newest.
function followPageLoad(page, loaded, isCurrent) {
  navigationTrace("SNAPSHOT_REQUEST", { reason: "INITIAL_PAGE_REFRESH" });
  loaded.then(() => {
    navigationTrace("SNAPSHOT_APPLY", { reason: "INITIAL_PAGE_REFRESH" });
    if (isCurrent()) schedulePageContentFit(page);
  }).catch((error) => {
    // The page shows its own failure; the dock lights are refreshStatus()'s alone (its /api/status read).
    console.warn(`[PAGE] ${page} initial refresh waiting for backend`, error);
  });
}

async function refreshCurrentPage(page) {
  if (page === "realtime") {
    // The analysis rows arrive with each product's view snapshot (live_signals.js); nothing reads them separately.
    await Promise.all([
      refreshStatus().catch((error) => console.warn("[REALTIME INIT] status refresh failed", error)),
      refreshRealtimePage(),
    ]);
    return;
  }
  if (isModulePage(page)) await loadPageData(page, await loadPageModule(page));
  else await refreshStatus();
}

// Provider readiness can settle a few seconds after FastAPI. Keep the dock
// truthful instead of leaving a stale red Futu light after data is visible.
// 5 s while the live socket is up: the dock only shows connection lights, and the market data itself arrives by
// push. 1 s while it is down, so the lights follow FastAPI coming back. It never reconnects the socket: the live
// transport owns its reconnect (backoff, one attempt at a time) -- this poll forcing one every second was a second
// reconnect coordinator. A hidden window skips the read.
const STATUS_CONNECTED_MS = 5000;
const STATUS_RECOVERY_MS = 1000;
let statusPollGeneration = 0;
// Until /api/status says the Shioaji market data is available (or the source is off), the 1 s cadence holds even with
// the socket up: the broker logs in a few seconds after the socket and its data is ready after that, and at 5 s the
// 永豐 light -- and the 即時報價 「行情資料未同步」 notice, which this read also clears -- stayed up to 5 s longer.
let brokerLightSettled = false;
function brokerSettledIn(status) {
  if (status?.sources?.shioaji?.enabled === false) return true;
  const readiness = status?.broker_status?.readiness;
  return Boolean(readiness?.connected && readiness?.market_data_ready);
}

function scheduleStatusPoll({ immediate = false } = {}) {
  statusPollGeneration += 1;
  const generation = statusPollGeneration;
  if (appState.autoRefreshTimer) {
    clearTimeout(appState.autoRefreshTimer);
    appState.autoRefreshTimer = null;
  }
  const delay = immediate ? 0 : (realtimeConnected && brokerLightSettled ? STATUS_CONNECTED_MS : STATUS_RECOVERY_MS);
  appState.autoRefreshTimer = window.setTimeout(async () => {
    if (generation !== statusPollGeneration) return;
    if (document.hidden && realtimeConnected) { scheduleStatusPoll(); return; }
    try {
      const status = await refreshStatus();
      brokerLightSettled = brokerSettledIn(status);
      // The live page's session lifecycle applies this read instead of polling /api/status itself.
      window.dispatchEvent(new CustomEvent("stock-monitor:status", { detail: status }));
    } catch (_error) { /* not an error: the API is unreachable: refreshStatus() already shows it offline; polled again */ }
    if (generation === statusPollGeneration) scheduleStatusPoll();
  }, delay);
}

function startAutoRefresh({ immediate = true } = {}) {
  scheduleStatusPoll({ immediate });
}

window.addEventListener("stock-monitor:first-api-response", (event) => {
  const detail = event?.detail || {};
  sendRealtimeClientMetric("first_api_response", Number(detail.duration_ms) || 0, { path: detail.path || "" });
});

window.addEventListener("stock-monitor:open-history-replay", (event) => {
  const detail = event?.detail || {};
  void (async () => {
    const result = await navigateTo("history");
    if (result?.superseded || appState.currentPage !== "history") return;
    const mod = await loadPageModule("history");
    await mod?.openHistoryReplay?.(detail);
  })().catch(recordUiActionError("open history replay", { to: "history", code: detail?.code || "" }));
});

window.addEventListener("resize", () => {
  if (appState.currentPage === "realtime") {
    resizeRealtimePage();
    return;
  }
  if (appState.currentPage === "layouts") {
    loadPageModule("layouts")
      .then((mod) => mod?.resizeLayoutsPage?.())
      .catch((error) => console.warn("[resizing the screen layouts] failed", error));
    return;
  }
  if (appState.currentPage === "history") {
    loadPageModule("history")
      .then((mod) => mod?.resizeHistoryDashboard?.())
      .catch((error) => console.warn("[resizing the history dashboard] failed", error));
  }
});

async function waitForInitialBackendReady({
  pollMs = 120,
  maxPollMs = 1000,
} = {}) {
  const started = performance.now();
  // A failing startup-state read is recorded when it first fails, when its error changes, and once at the end with
  // how often and over what span -- not once per poll; while it fails the poll backs off up to maxPollMs.
  const readFailures = { count: 0, message: "", firstAt: 0, lastAt: 0 };
  const recordReadFailure = (error) => {
    const message = String(error?.message || error);
    const now = Date.now();
    if (!readFailures.count) readFailures.firstAt = now;
    if (message !== readFailures.message) console.warn("[reading the startup state over IPC] failed", { failures: readFailures.count + 1 }, error);
    readFailures.count += 1;
    readFailures.message = message;
    readFailures.lastAt = now;
  };
  const pollDelay = () => (readFailures.count ? Math.min(maxPollMs, pollMs * (2 ** Math.min(readFailures.count, 6))) : pollMs);

  const isReadyState = (snapshot) => {
    const state = String(snapshot?.state || "").toUpperCase();
    return state === "BACKEND_READY" || state === "RUNNING";
  };
  const isFailedState = (snapshot) => String(snapshot?.state || "").toUpperCase() === "BACKEND_FAILED";

  // Subscribe first so BACKEND_READY cannot race between state-read and listener setup.
  let eventReady = false;
  let resolveEvent;
  const eventPromise = new Promise((resolve) => {
    resolveEvent = resolve;
  });
  const unsubscribe = window.desktopAPI?.onBackendReady?.(() => {
    eventReady = true;
    resolveEvent?.("event");
  });

  try {
    for (;;) {
      if (eventReady) {
        return {
          ok: true,
          source: "electron_backend_ready_event",
          elapsed_ms: Math.round(performance.now() - started),
        };
      }

      // Pure Electron IPC: no TCP connect is attempted, so cold startup cannot
      // generate Chromium ERR_CONNECTION_REFUSED noise.
      try {
        const startupState = await window.desktopAPI?.getStartupState?.();
        if (isReadyState(startupState)) {
          return {
            ok: true,
            source: "electron_startup_state",
            state: String(startupState?.state || ""),
            elapsed_ms: Math.round(performance.now() - started),
          };
        }
        if (isFailedState(startupState)) {
          return {
            ok: false,
            source: "electron_backend_failed",
            state: String(startupState?.state || ""),
            detail: String(startupState?.last_detail || ""),
            elapsed_ms: Math.round(performance.now() - started),
          };
        }
      } catch (error) { recordReadFailure(error); }

      await Promise.race([
        eventPromise,
        new Promise((resolve) => setTimeout(resolve, pollDelay())),
      ]);
    }
  } finally {
    if (readFailures.count) {
      console.warn("[reading the startup state over IPC] failures while waiting", {
        count: readFailures.count, last_error: readFailures.message,
        first_at: new Date(readFailures.firstAt).toISOString(), last_at: new Date(readFailures.lastAt).toISOString() });
    }
    if (typeof unsubscribe === "function") {
      try { unsubscribe(); } catch (error) { console.warn("[unsubscribing the IPC status listener] failed", error); }
    }
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  if (LAYOUT_EDITOR_WINDOW) {
    document.title = "即時報價版型編輯";
    document.body.dataset.layoutEditor = "1";
    document.body.removeAttribute("data-startup-active");
    document.getElementById("startupOverlay").hidden = true;
    appState.currentPage = "layouts";
  } else {
    installDockScreenSwitcher(document.querySelector('[data-role="dock-screens"]'));
  }
  const { startRendererRuntimeHealth } = await import("./js/core/renderer_runtime_health.js");
  const stopRendererHealth = startRendererRuntimeHealth();
  window.addEventListener("pagehide", () => stopRendererHealth?.(), { once: true });
  document.getElementById("globalOpenWorkspaceBtn")?.addEventListener("click", () => {
    let seed = "";
    try {
      const raw = JSON.parse(window.localStorage?.getItem("shioajiMarketPanelUiStateV1") || "{}");
      seed = String(raw?.selectedSymbol || "").trim().toUpperCase();
    } catch (error) { console.warn("[reading the selected symbol for the workspace] failed", error); }
    window.desktopAPI?.openWorkspaceView?.(seed).catch((error) => console.warn("[WORKSPACE] open failed", error));
  });

  await initializeStartupProgressUi();
  setWebSocketOnline(false);
  setMoomooOnline(false);
  bindServiceStatusDiagnostics();
  initUpdateNotice();
  initGlobalTradeEntry({
    onSubmitted: async () => {
      // The trade window writes the actual ledger: the 帳務 page refreshes when it shows that ledger.
      if (appState.currentPage === "account") {
        const mod = await loadPageModule("account");
        await mod?.refreshAccountLedgerPage?.(false, "actual");
      }
    },
  });

  let backendBootstrapReady = false;
  document.querySelectorAll(".dock-nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      if (!backendBootstrapReady) return;
      void navigateTo(button.dataset.page).catch(recordUiActionError("navigate", { to: button.dataset.page }));
    });
  });

  updateCurrentTime();
  setInterval(updateCurrentTime, 1000);
  await reportRendererStartupStep("renderer_core", "complete", "核心模組與全域事件綁定完成");

  // No API or WebSocket connection is allowed before Electron confirms that the
  // FastAPI child spawned for this launch is actually listening.  This avoids the
  // old timeout path where renderer bootstrap continued after 15s and generated
  // a storm of ERR_CONNECTION_REFUSED requests.
  let initialRealtimeMounted = false;
  let realtimeBootstrapStarted = false;
  window.desktopAPI?.onBackendReady?.(() => {
    backendBootstrapReady = true;
    if (!realtimeBootstrapStarted) return;
    notifyBackendReadyForRealtime();
    if (!initialRealtimeMounted) return;
    refreshCurrentPage(appState.currentPage).catch((error) => {
      console.warn("[BACKEND READY] page refresh failed", error);
    });
  });

  // Electron alone decides how long a start may take (config/js/startup_budget.js, and a storage move as long as Health
  // reports one) and ends in BACKEND_READY or BACKEND_FAILED; a second clock here gave up on starts that went on to work.
  const initialBackendGate = await waitForInitialBackendReady();

  if (!initialBackendGate.ok) {
    // Surface *why* the gate gave up (timeout vs an explicit BACKEND_FAILED state,
    // plus elapsed_ms and the coordinator's last known detail) instead of a fixed
    // string, so a real slow-backend episode is distinguishable from a genuine
    // failure without re-deriving it from raw logs after the fact.
    const gateReason = `後端回報失敗 (${initialBackendGate.detail || initialBackendGate.state || "unknown"})`;
    const realtimeHtmlDetail = `FastAPI 未就緒，無法載入即時報價頁面：${gateReason}`;
    await reportRendererStartupStep("realtime_ws", "degraded", "FastAPI 未就緒，略過 WebSocket");
    await reportRendererStartupStep("realtime_html", "failed", realtimeHtmlDetail);
    for (const stepId of ["dashboard_components", "taiwan_products", "moomoo_products", "futu_product_cache", "first_paint"]) {
      await reportRendererStartupStep(stepId, "skipped", "前置 FastAPI 失敗");
    }
    console.error("[BACKEND READY GATE] FastAPI unavailable; network bootstrap suppressed", initialBackendGate);
    const pageContainer = $("pageContainer");
    if (pageContainer) {
      pageContainer.innerHTML = `
        <div class="panel">
          <div class="empty">FastAPI 尚未成功啟動，已停止即時連線重試。請查看啟動錯誤訊息。</div>
        </div>
      `;
    }
    return;
  }

  await initializeSourceSettings();
  backendBootstrapReady = true;
  console.info("[BACKEND READY GATE] IPC ready before realtime bootstrap", initialBackendGate);

  // Keep Futu startup diagnostics symmetric with Shioaji without changing the
  // underlying Futu data architecture: local watch-page config and durable
  // market-cache bootstrap are two separately visible startup units.
  runOptionalRendererStartupUnit(
    "moomoo_products",
    {
      detail: "讀取本機 Futu 自選商品頁設定",
      timeoutMs: 1800,
      timeoutDetail: "Futu 自選商品頁背景讀取中",
    },
    loadFutuWatchPagesStartup,
  );
  runOptionalRendererStartupUnit(
    "futu_product_cache",
    {
      detail: "讀取 Futu durable product state / quote cache",
      timeoutMs: 5000,
      timeoutDetail: "Futu 行情快取背景載入中",
    },
    bootstrapMoomooProducts,
  );

  // This step is the renderer's direct Market Runtime connection (its /live WebSocket, realtime.js); FastAPI serves
  // no realtime WebSocket.
  await reportRendererStartupStep("realtime_ws", "start", "等待 Market Runtime 就緒");
  let realtimeStartupSettled = false;
  let realtimeStartupDeadline = null;

  subscribeRealtimeConnectionState(({ state, connected }) => {
    realtimeConnected = Boolean(connected);
    setWebSocketOnline(realtimeConnected);
    if (realtimeConnected && !realtimeStartupSettled) {
      realtimeStartupSettled = true;
      window.clearTimeout(realtimeStartupDeadline);
      void reportRendererStartupStep("realtime_ws", "complete");
    }
    scheduleStatusPoll({ immediate: state !== REALTIME_CONNECTION_STATE.CONNECTED });
  });
  // The page closing ends the live socket cleanly (code 1000) and every transport timer.
  window.addEventListener("pagehide", () => stopRealtimeStream("page_unload"), { once: true });

  // No batch callback any more. Every payload is applied by RealtimeViewStore as it is parsed,
  // and the two things this callback still did have owners of their own:
  //
  //   * connection state -- the subscribeRealtimeConnectionState() handler above already calls
  //     setWebSocketOnline(); the batch was a redundant second path for one fact.
  //   * first_meaningful_render -- reported by the analysis row's own apply path, which is the
  //     state it was measuring.
  //
  // The `ui_render` / `renderer_paint` samples are gone rather than relocated: they timed the
  // application of a batch, and with no batch there is no such boundary to time. Reporting them
  // from an arbitrary other point would be inventing a measurement.
  realtimeBootstrapStarted = true;
  // The socket opens once Health says Market Runtime serves (the startup order): the APIs are up before A has
  // replayed its WAL, and connecting then only failed and retried. The page mounts meanwhile; its views wait for the
  // socket. A start that failed is shown as such; Health's watch restarts A (recorded) and the socket's own reconnect,
  // recorded too, follows it.
  void (async () => {
    let marketRuntime = null;
    try {
      marketRuntime = await window.desktopAPI?.waitForMarketRuntime?.();
    } catch (error) {
      console.warn("[waiting for Market Runtime READY] failed", error);
    }
    if (marketRuntime && marketRuntime.status !== "ready") {
      void reportRendererStartupStep("realtime_ws", "degraded", `Market Runtime 未就緒：${marketRuntime.detail || marketRuntime.status}`);
    } else {
      void reportRendererStartupStep("realtime_ws", "start", "建立 Market Runtime WebSocket 連線");
      realtimeStartupDeadline = window.setTimeout(() => {
        if (realtimeStartupSettled) return;
        realtimeStartupSettled = true;
        void reportRendererStartupStep("realtime_ws", "degraded", "WebSocket 背景持續重連，不阻塞主介面");
      }, 6000);
    }
    startRealtimeStream();
  })();

  try {
    if (LAYOUT_EDITOR_WINDOW) {
      await navigateTo("layouts");
      initialRealtimeMounted = true;
      startAutoRefresh({ immediate: false });
      return;
    }
    await navigateTo("realtime", { startupFastPath: true });
    initialRealtimeMounted = true;
    runPostStartupTask("realtime authoritative hydration", async () => {
      navigationTrace("SNAPSHOT_REQUEST", { reason: "POST_STARTUP_REFRESH" });
      await refreshCurrentPage("realtime");
      navigationTrace("SNAPSHOT_APPLY", { reason: "POST_STARTUP_REFRESH" });
      schedulePageContentFit("realtime");
    });
  } catch (error) {
    console.error("[REALTIME STARTUP] unit failure", error);
    throw error;
  }
  // The backend was already explicitly validated during startup and the WS
  // connection state schedules recovery probes on its own. Avoid an immediate
  // heavy /api/status call competing with the first visible realtime paint.
  startAutoRefresh({ immediate: false });
});
