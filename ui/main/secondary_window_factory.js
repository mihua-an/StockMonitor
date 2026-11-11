"use strict";

const path = require("path");
const { DetachedViewManager } = require("./detached_view_manager");

// The 新增／修改交易 form's width: the trade window's content width, which its page fills (styles/windows/trade.css).
const TRADE_WINDOW_CONTENT_WIDTH = 504;

// The four secondary windows: the trade editor, the product-page editor, the multi-symbol workspace and the detached
// single-component views. Each lives in the registry (one per kind); a page that fails to load goes through
// window_load_failure.js. `workAreaNearMain()` is the work area of the display the main window is on.
function createSecondaryWindowFactory({ BrowserWindow, screen, uiMainDir, release, registry, loadFailure, workAreaNearMain }) {
  let pendingTradeWindowPayload = null;
  let detachedViewManager = null;

  function normalizeTradeWindowPayload(payload = {}) {
    const raw = payload && typeof payload === "object" ? payload : {};
    const mode = raw.mode === "edit" ? "edit" : "add";
    const trade = raw.trade && typeof raw.trade === "object"
      ? JSON.parse(JSON.stringify(raw.trade))
      : null;
    return {
      mode,
      trade,
      action: raw.action === "賣出" ? "賣出" : "買進",
      // A new trade's market, decided by the main window from Rust A's US session (trade_entry.js).
      market: raw.market === "美股" ? "美股" : "台股",
    };
  }

  function sendTradeWindowPayload() {
    const tradeWindow = registry.get("trade");
    if (!tradeWindow || !pendingTradeWindowPayload) return;
    tradeWindow.webContents.send("trade-window:payload", pendingTradeWindowPayload);
  }

  function createOrShowTradeWindow(payload = {}) {
    pendingTradeWindowPayload = normalizeTradeWindowPayload(payload);

    if (registry.bringForward("trade")) {
      sendTradeWindowPayload();
      return true;
    }

    const workArea = workAreaNearMain();
    // The form's width is this window's content width (the page fills it); the height starts near the form's and is
    // fitted to the content once the DOM is laid out (fitTradeWindowToContent).
    const width = Math.min(TRADE_WINDOW_CONTENT_WIDTH, workArea.width);
    const height = Math.min(520, workArea.height);
    const x = Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2));
    const y = Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2));

    // 交易編輯器是真正獨立 BrowserWindow，不設定 parent / modal。
    // 因此主監控 App 最小化後，新增 / 修改交易視窗仍會留在桌面。
    const tradeWindow = registry.add("trade", new BrowserWindow({
      x, y, width, height,
      useContentSize: true,
      minWidth: Math.min(TRADE_WINDOW_CONTENT_WIDTH, workArea.width),
      minHeight: 420,
      resizable: false,
      backgroundColor: "#07101f",
      title: pendingTradeWindowPayload.mode === "edit" ? "修改交易" : "新增交易",
      autoHideMenuBar: true,
      show: false,
      webPreferences: release.webPreferences(),
    }), () => { pendingTradeWindowPayload = null; });

    loadFailure.loadSecondaryWindow(tradeWindow, "trade", "trade_window.html");
    // Every load, not once: an endpoint change reloads the window (reloadForEndpointChange) and a payload sent
    // only on the first load left the reloaded editor empty.
    let shown = false;
    tradeWindow.webContents.on("did-finish-load", () => {
      sendTradeWindowPayload();
      if (!shown && !tradeWindow.isDestroyed()) {
        shown = true;
        tradeWindow.show();
        tradeWindow.focus();
      }
    });
    return true;
  }

  function closeTradeWindow(event) {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const tradeWindow = registry.get("trade");
    if (senderWindow && senderWindow === tradeWindow) senderWindow.close();
    return true;
  }

  function fitTradeWindowToContent(event, payload = {}) {
    const tradeWindow = registry.get("trade");
    if (!tradeWindow) return false;
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow !== tradeWindow) return false;

    const rawWidth = Number(payload.width);
    const rawHeight = Number(payload.height);
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) return false;

    const display = screen.getDisplayMatching(tradeWindow.getBounds());
    const workArea = display?.workArea || screen.getPrimaryDisplay().workArea;
    const outer = tradeWindow.getBounds();
    const content = tradeWindow.getContentBounds();
    const frameWidth = Math.max(0, outer.width - content.width);
    const frameHeight = Math.max(0, outer.height - content.height);

    // 內容本身不留額外 padding；只保留 native Windows title bar / frame 所需空間。
    const maxContentWidth = Math.max(320, workArea.width - frameWidth);
    const maxContentHeight = Math.max(320, workArea.height - frameHeight);
    const width = Math.min(maxContentWidth, Math.max(460, Math.ceil(rawWidth)));
    const height = Math.min(maxContentHeight, Math.max(360, Math.ceil(rawHeight)));

    tradeWindow.setContentSize(width, height, false);
    return { ok: true, width, height };
  }

  function createOrShowWatchPageEditor() {
    if (registry.bringForward("watch_pages_editor")) return true;
    const workArea = workAreaNearMain();
    // 商品頁編輯器依目前螢幕工作區縮放，內容不靠查詢結果把視窗撐開。
    const width = Math.min(workArea.width, Math.min(1380, Math.max(1120, Math.floor(workArea.width * 0.88))));
    const height = Math.min(workArea.height, Math.min(820, Math.max(620, Math.floor(workArea.height * 0.82))));
    const editor = registry.add("watch_pages_editor", new BrowserWindow({
      width, height,
      minWidth: Math.min(1040, workArea.width),
      minHeight: Math.min(600, workArea.height),
      backgroundColor: "#07101f",
      title: "商品頁設定",
      autoHideMenuBar: true,
      show: false,
      webPreferences: release.webPreferences(),
    }));
    loadFailure.loadSecondaryWindow(editor, "watch pages editor", "watch_pages_window.html");
    editor.once("ready-to-show", () => {
      if (editor.isDestroyed()) return;
      editor.show();
      editor.focus();
    });
    return true;
  }

  function createOrShowWorkspaceWindow(seedSymbol = "") {
    // A single window for up to 6 symbol columns -- not one BrowserWindow per symbol (that is the detached view
    // manager's per-(component, symbol) keying used for single-component pop-outs below). Reopening while already
    // open just focuses it; the seed symbol is only applied on first creation (workspace_view.js never re-syncs to
    // the main page's later selection changes afterward).
    if (registry.bringForward("workspace")) return true;
    const workArea = workAreaNearMain();
    const width = Math.min(workArea.width, Math.max(1400, Math.floor(workArea.width * 0.92)));
    const height = Math.min(workArea.height, Math.max(800, Math.floor(workArea.height * 0.88)));
    const workspace = registry.add("workspace", new BrowserWindow({
      width, height,
      minWidth: Math.min(1000, workArea.width),
      minHeight: Math.min(600, workArea.height),
      backgroundColor: "#0f172a",
      title: "多股即時 Workspace",
      autoHideMenuBar: true,
      show: false,
      webPreferences: release.webPreferences(),
    }));
    const normalizedSeed = String(seedSymbol || "").trim().toUpperCase();
    loadFailure.loadSecondaryWindow(workspace, "workspace", "workspace_view.html");
    // Same push-after-load pattern as DetachedViewManager's descriptor send, on every load (see the trade window).
    workspace.webContents.on("did-finish-load", () => {
      if (normalizedSeed && !workspace.isDestroyed()) workspace.webContents.send("workspace-view:seed", normalizedSeed);
    });
    workspace.once("ready-to-show", () => {
      if (workspace.isDestroyed()) return;
      workspace.show();
      workspace.focus();
    });
    return true;
  }

  // 即時報價's screens with their real components: the main page started as the editor (app.js LAYOUT_EDITOR_WINDOW).
  function createOrShowLayoutEditor() {
    if (registry.bringForward("layout_editor")) return true;
    const workArea = workAreaNearMain();
    const editor = registry.add("layout_editor", new BrowserWindow({
      width: Math.min(workArea.width, Math.max(1100, Math.floor(workArea.width * 0.92))),
      height: Math.min(workArea.height, Math.max(640, Math.floor(workArea.height * 0.9))),
      minWidth: Math.min(900, workArea.width),
      minHeight: Math.min(560, workArea.height),
      backgroundColor: "#111827",
      title: "即時報價版型編輯",
      autoHideMenuBar: true,
      show: false,
      webPreferences: release.webPreferences(),
    }));
    loadFailure.loadSecondaryWindow(editor, "layout editor", "index.html", { hash: "layout-editor" });
    editor.once("ready-to-show", () => {
      if (editor.isDestroyed()) return;
      editor.show();
      editor.focus();
    });
    return true;
  }

  function getDetachedViewManager() {
    if (detachedViewManager) return detachedViewManager;
    detachedViewManager = new DetachedViewManager({
      BrowserWindow,
      preloadPath: path.join(uiMainDir, "preload.js"),
      rendererPath: release.rendererFile("detached_view.html"),
      onLoadFailure: loadFailure.secondaryLoadFailed,
    });
    return detachedViewManager;
  }

  // 主 App 真正關閉時才一併關閉次要視窗；最小化不受影響。
  function closeAll() {
    registry.closeAll();
    detachedViewManager?.closeAll?.();
    detachedViewManager = null;
  }

  return {
    createOrShowTradeWindow, closeTradeWindow, fitTradeWindowToContent, createOrShowWatchPageEditor,
    createOrShowWorkspaceWindow, createOrShowLayoutEditor, getDetachedViewManager, closeAll,
  };
}

module.exports = { createSecondaryWindowFactory };
