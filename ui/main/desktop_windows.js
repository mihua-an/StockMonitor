"use strict";

const path = require("path");
const { clamp } = require("./numbers");
const { createRendererReleaseManager, reloadWindowPages } = require("./renderer_release_manager");
const { WindowRegistry } = require("./window_registry");
const { createWindowLoadFailure } = require("./window_load_failure");
const { createSecondaryWindowFactory } = require("./secondary_window_factory");
const {
  calculateUiScaleForDisplay, scaledWindowSize, minimumSizeFor, readWindowState, writeWindowState, resolveInitialWindowState,
} = require("./main_window_state");

// The full-close overlay painted over the main page while services stop.
function showShutdownOverlay(window, message) {
  if (typeof window.webContents?.executeJavaScript !== "function") return;
  const safeMessage = JSON.stringify(String(message));
  void Promise.resolve(window.webContents.executeJavaScript(`(() => {
    let overlay = document.getElementById('appShutdownOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'appShutdownOverlay';
      overlay.className = 'app-shutdown-overlay';
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-live', 'polite');
      // Styled by layout/app-shell.css (.app-shutdown-*), which every window loads.
      overlay.innerHTML = '<div class="app-shutdown-box">'
        + '<div class="app-shutdown-title">正在完整關閉 Stock Monitor</div>'
        + '<div class="app-shutdown-message" data-shutdown-message></div>'
        + '<div class="app-shutdown-bar"></div></div>';
      document.documentElement.appendChild(overlay);
    }
    overlay.querySelector('[data-shutdown-message]').textContent = ${safeMessage};
    return true;
  })()`, true)).catch((error) => console.warn(`[APP UI] shutdown overlay unavailable: ${error?.message || error}`));
}

// Window ownership only: process startup, recovery and shutdown remain in main. This facade owns the main window
// (its scale, minimum size, geometry and shutdown state) and composes the rest -- the renderer release
// (renderer_release_manager.js), the secondary windows (secondary_window_factory.js, in a WindowRegistry) and the
// load-failure page (window_load_failure.js).
function createDesktopWindows({ app, BrowserWindow, screen, uiMainDir, getProjectRoot,
  onMainWindowCreated, connectSources }) {
  let mainWindow = null;
  const release = createRendererReleaseManager({ app, BrowserWindow, uiMainDir, connectSources });
  const registry = new WindowRegistry();
  const loadFailure = createWindowLoadFailure({ BrowserWindow, release, registry });

  let currentUiScaleFactor = 1;
  let currentUiDisplayId = null;
  let pageMinimumMode = "normal";
  // 由 renderer 回報監控頁真正的 CSS 最小內容寬度，讓 BrowserWindow 與內頁同時停止縮小。
  let realtimeRendererMinimumCssWidth = null;
  let shutdownPreviousTitle = "";

  function showShutdownState(message = "正在安全關閉服務，請稍候…") {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    try {
      shutdownPreviousTitle = typeof mainWindow.getTitle === "function" ? mainWindow.getTitle() : "";
      mainWindow.setTitle?.("Stock Monitor｜正在完整關閉…");
      mainWindow.setProgressBar?.(2, { mode: "indeterminate" });
      mainWindow.setClosable?.(false);
      mainWindow.show?.();
      mainWindow.focus?.();
      showShutdownOverlay(mainWindow, message);
      return true;
    } catch (error) {
      console.warn(`[APP UI] shutdown state unavailable: ${error?.message || error}`);
      return false;
    }
  }

  function getDisplayForWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return screen.getPrimaryDisplay();
    }
    return screen.getDisplayMatching(mainWindow.getBounds());
  }

  function applyWindowMinimumSize() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const minimum = scaledWindowSize(minimumSizeFor(pageMinimumMode), currentUiScaleFactor);

    // 監控頁的 CSS grid 有自己的真正最小寬度。
    // 不能只用固定 REALTIME_MIN_WINDOW_SIZE，否則在不同 zoom / DPI 下會出現
    // 「內頁已經停止縮小，但 Electron 外框還能繼續縮」的空窗區。
    if (pageMinimumMode === "realtime" && Number.isFinite(realtimeRendererMinimumCssWidth)) {
      const currentBounds = mainWindow.getBounds();
      const contentBounds = mainWindow.getContentBounds();
      const frameWidth = Math.max(0, currentBounds.width - contentBounds.width);
      const rendererMinimumWidth = Math.ceil(
        realtimeRendererMinimumCssWidth * currentUiScaleFactor + frameWidth
      );
      minimum.width = Math.max(minimum.width, rendererMinimumWidth);
    }

    mainWindow.setMinimumSize(minimum.width, minimum.height);
  }

  function releasePageContentWidthLock() {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    pageMinimumMode = "normal";
    const display = getDisplayForWindow();
    const workArea = display?.workArea || {};
    // 只把舊版本曾經設定過的 max-width 解開；目前所有頁面都允許使用者自由放大。
    mainWindow.setMaximumSize(
      Number(workArea.width) || 100000,
      Number(workArea.height) || 100000
    );
    applyWindowMinimumSize();
    return true;
  }

  // `target`: the window the scale is for -- a debounced call names the window that scheduled it.
  function applyAdaptiveUiScale(force = false, target = mainWindow) {
    if (!target || target !== mainWindow || target.isDestroyed()) return currentUiScaleFactor;

    const display = getDisplayForWindow();
    const nextScale = calculateUiScaleForDisplay(display);
    const displayChanged = display?.id !== currentUiDisplayId;
    const scaleChanged = Math.abs(nextScale - currentUiScaleFactor) > 0.001;

    if (!force && !displayChanged && !scaleChanged) {
      return currentUiScaleFactor;
    }

    currentUiScaleFactor = nextScale;
    currentUiDisplayId = display?.id ?? null;

    // Electron page zoom 比 CSS transform 安全：vh/vw、sticky、fixed、canvas 與滑動區仍使用正常 layout。
    target.webContents.setZoomFactor(currentUiScaleFactor);
    applyWindowMinimumSize();

    const area = display?.workAreaSize || display?.workArea || {};
    console.log(
      `[UI SCALE] display=${display?.id ?? "unknown"} ` +
      `workArea=${area.width || "?"}x${area.height || "?"} ` +
      `dpiScale=${display?.scaleFactor || 1} ` +
      `uiScale=${currentUiScaleFactor.toFixed(2)}`
    );

    return currentUiScaleFactor;
  }

  const windowStatePath = () => path.join(app.getPath("userData"), "window-state.json");
  // `target`: the window whose bounds are saved -- a debounced call names the window that scheduled it.
  function saveWindowState(target = mainWindow) {
    writeWindowState(windowStatePath(), target);
  }

  const secondary = createSecondaryWindowFactory({ BrowserWindow, screen, uiMainDir, release, registry, loadFailure,
    workAreaNearMain: () => getDisplayForWindow()?.workArea || screen.getPrimaryDisplay().workArea });

  function fitWindowToRendererContent(payload = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: "window_not_ready" };
    }

    const mode = String(payload.mode || "");
    if (mode.startsWith("realtime")) {
      pageMinimumMode = "realtime";
      const reportedMinimumCssWidth = Number(payload.minimumCssWidth);
      if (Number.isFinite(reportedMinimumCssWidth) && reportedMinimumCssWidth > 0) {
        realtimeRendererMinimumCssWidth = reportedMinimumCssWidth;
      }
      applyWindowMinimumSize();
    } else if (mode.startsWith("history")) {
      pageMinimumMode = "history";
      applyWindowMinimumSize();
    }

    const currentBounds = mainWindow.getBounds();
    const contentBounds = mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(currentBounds);
    const workArea = display.workArea;
    const [minimumWidth, minimumHeight] = mainWindow.getMinimumSize();

    const viewportCssWidth = Number(payload.viewportCssWidth);
    const viewportCssHeight = Number(payload.viewportCssHeight);
    const targetCssWidth = Number(payload.targetCssWidth);
    const targetCssHeight = Number(payload.targetCssHeight);

    const cssToDipX = Number.isFinite(viewportCssWidth) && viewportCssWidth > 0
      ? contentBounds.width / viewportCssWidth
      : currentUiScaleFactor;
    const cssToDipY = Number.isFinite(viewportCssHeight) && viewportCssHeight > 0
      ? contentBounds.height / viewportCssHeight
      : currentUiScaleFactor;

    const frameWidth = Math.max(0, currentBounds.width - contentBounds.width);
    const frameHeight = Math.max(0, currentBounds.height - contentBounds.height);

    let nextWidth = currentBounds.width;
    let nextHeight = currentBounds.height;

    if (payload.fitWidth && Number.isFinite(targetCssWidth) && targetCssWidth > 0) {
      const desiredContentWidth = Math.ceil(targetCssWidth * cssToDipX);
      nextWidth = desiredContentWidth + frameWidth;
    }

    if (payload.fitHeight && Number.isFinite(targetCssHeight) && targetCssHeight > 0) {
      const desiredContentHeight = Math.ceil(targetCssHeight * cssToDipY);
      nextHeight = desiredContentHeight + frameHeight;
    }

    nextWidth = clamp(
      Math.round(nextWidth),
      Math.min(minimumWidth, workArea.width),
      workArea.width
    );
    nextHeight = clamp(
      Math.round(nextHeight),
      Math.min(minimumHeight, workArea.height),
      workArea.height
    );

    // 縮視窗時固定左上角，讓右邊 / 下邊直接往內容邊緣靠攏；
    // 只有超出目前螢幕工作區時才修正 x / y。
    const nextX = clamp(
      currentBounds.x,
      workArea.x,
      workArea.x + Math.max(0, workArea.width - nextWidth)
    );
    const nextY = clamp(
      currentBounds.y,
      workArea.y,
      workArea.y + Math.max(0, workArea.height - nextHeight)
    );

    const changed =
      Math.abs(nextWidth - currentBounds.width) > 1 ||
      Math.abs(nextHeight - currentBounds.height) > 1 ||
      nextX !== currentBounds.x ||
      nextY !== currentBounds.y;

    if (changed) {
      mainWindow.setBounds(
        { x: nextX, y: nextY, width: nextWidth, height: nextHeight },
        true
      );
    }

    return {
      ok: true,
      changed,
      width: nextWidth,
      height: nextHeight,
      mode: String(payload.mode || "")
    };
  }

  // Bounds are saved and the UI scale re-derived shortly after the window stops moving/resizing. Both are for this
  // window only: the timers end with it, so a quickly reopened main window is never saved or scaled by them.
  function bindMainWindowGeometry(window) {
    let windowStateTimer = null;
    let uiScaleTimer = null;
    const scheduleWindowStateSave = () => {
      clearTimeout(windowStateTimer);
      windowStateTimer = setTimeout(() => saveWindowState(window), 250);
    };
    const scheduleUiScaleRefresh = () => {
      clearTimeout(uiScaleTimer);
      uiScaleTimer = setTimeout(() => applyAdaptiveUiScale(false, window), 120);
    };
    window.on("closed", () => {
      clearTimeout(windowStateTimer);
      clearTimeout(uiScaleTimer);
    });

    window.on("resize", () => {
      scheduleWindowStateSave();
      scheduleUiScaleRefresh();
    });
    window.on("move", () => {
      scheduleWindowStateSave();
      scheduleUiScaleRefresh();
    });
    window.on("maximize", () => {
      scheduleWindowStateSave();
      scheduleUiScaleRefresh();
    });
    window.on("unmaximize", () => {
      scheduleWindowStateSave();
      scheduleUiScaleRefresh();
    });
    window.on("close", () => saveWindowState(window));
  }

  // index.html, or the startup error page when the main page cannot load at all.
  function loadMainRenderer(window) {
    let rendererFailurePageActive = false;
    const showRendererFailurePage = (detail) => {
      if (rendererFailurePageActive || !window || window.isDestroyed()) return;
      rendererFailurePageActive = true;
      console.error(`[APP UI] main renderer failed to load: ${detail}`);
      void Promise.resolve(window.loadFile(release.rendererFile("startup_error.html"), {
        hash: encodeURIComponent(String(detail || "unknown renderer load failure").slice(0, 500)),
      })).catch((error) => console.error(`[APP UI] fallback page failed to load: ${error?.message || error}`));
    };
    window.webContents.on?.("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false || rendererFailurePageActive) return;
      showRendererFailurePage(`ERR ${errorCode}: ${errorDescription || "load failed"} (${validatedURL || "local page"})`);
    });
    void Promise.resolve(window.loadFile(release.rendererFile("index.html")))
      .catch((error) => showRendererFailurePage(error?.message || error));
  }

  function createWindow() {
    const initial = resolveInitialWindowState(screen, readWindowState(windowStatePath()));

    currentUiScaleFactor = initial.scale;
    currentUiDisplayId = initial.display?.id ?? null;

    mainWindow = new BrowserWindow({
      ...initial.bounds,
      minWidth: initial.minimum.width,
      minHeight: initial.minimum.height,
      backgroundColor: "#111827",
      title: "StockMonitor",
      autoHideMenuBar: true,
      webPreferences: release.webPreferences(),
    });

    onMainWindowCreated(mainWindow);

    // 在 HTML 載入前就先套用比例，避免先以 100% 閃一下再縮小。
    mainWindow.webContents.setZoomFactor(currentUiScaleFactor);
    loadMainRenderer(mainWindow);

    // Shioaji 版以最大化工作區為標準啟動方式；不是 kiosk，仍保留 Windows 標題列與最小化。
    mainWindow.once("ready-to-show", () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.maximize();
    });

    // No "session-end" handling here: Windows' shutdown/logoff is owned by Rust A, which has Health run the full
    // shutdown; Health's exit then ends the UI (health_bootstrap.js onHealthEndedApp).
    bindMainWindowGeometry(mainWindow);

    // DevTools materially delays first paint and reduces the usable dashboard
    // width.  Keep it available for explicit diagnostics without imposing that
    // cost on every normal launch.
    if (String(process.env.STOCK_MONITOR_DEVTOOLS || "").trim() === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    const createdWindow = mainWindow;
    mainWindow.on("closed", () => {
      mainWindow = null;
      secondary.closeAll();
    });
    return createdWindow;
  }

  // Main-window ownership lives here; other controllers read/write through
  // these instead of keeping their own copy of the reference in sync.
  function getMainWindow() {
    return mainWindow;
  }

  function setMainWindow(window) {
    mainWindow = window;
  }

  return {
    trustedRendererPage: release.trustedRendererPage, reloadForEndpointChange: release.reloadForEndpointChange,
    createWindow, saveWindowState, applyAdaptiveUiScale, fitWindowToRendererContent, releasePageContentWidthLock,
    createOrShowTradeWindow: secondary.createOrShowTradeWindow, fitTradeWindowToContent: secondary.fitTradeWindowToContent,
    createOrShowWatchPageEditor: secondary.createOrShowWatchPageEditor, createOrShowWorkspaceWindow: secondary.createOrShowWorkspaceWindow,
    createOrShowLayoutEditor: secondary.createOrShowLayoutEditor,
    getDetachedViewManager: secondary.getDetachedViewManager, closeTradeWindow: secondary.closeTradeWindow,
    getMainWindow, setMainWindow, showShutdownState,
  };
}

module.exports = { createDesktopWindows, reloadWindowPages, calculateUiScaleForDisplay };
