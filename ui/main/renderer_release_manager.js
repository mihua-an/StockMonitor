"use strict";

const path = require("path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { prepareRendererAssets, pruneRendererAssets } = require("./renderer_assets");

const TRUSTED_PAGES = Object.freeze(["index.html", "startup_error.html", "trade_window.html", "watch_pages_window.html",
  "detached_view.html", "workspace_view.html"]);

// Loads each [window, page] from `fileFor(page)` and waits for every load: a rejected load is logged and named in
// the result, never counted as reloaded.
async function reloadWindowPages(pages, fileFor) {
  const results = await Promise.allSettled(pages.map(([win, page]) => Promise.resolve().then(() => win.loadFile(fileFor(page)))));
  const failed = [];
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const [win, page] = pages[index];
    const error = String(result.reason?.message || result.reason);
    console.error(`[WINDOWS] reload of ${page} (window ${win.id}) failed: ${error}`);
    failed.push({ page, window_id: win.id, error: error.slice(0, 300) });
  });
  return { windows: pages.length, reloaded: pages.length - failed.length, failed };
}

// The captured renderer release every window loads from, which page a URL is, and the one set of web preferences.
function createRendererReleaseManager({ app, BrowserWindow, uiMainDir, connectSources }) {
  let rendererReleaseDir = null;

  // Every renderer window: isolated, sandboxed, no Node, the one preload.
  function webPreferences() {
    return { preload: path.join(uiMainDir, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };
  }

  function trustedRendererPage(url) {
    if (!rendererReleaseDir) return null;
    try {
      const value = new URL(url);
      if (value.protocol !== "file:" || value.host || value.search) return null;
      const resolved = path.resolve(fileURLToPath(value));
      const page = path.basename(resolved);
      if (!TRUSTED_PAGES.includes(page)) return null;
      return resolved === path.join(rendererReleaseDir, page) ? page : null;
    } catch { /* not an error: an unparsable URL is not a trusted renderer page */ return null; }
  }

  function releaseInUse(releaseDir) {
    if (typeof BrowserWindow?.getAllWindows !== "function") return true;
    const prefix = pathToFileURL(releaseDir).href.toLowerCase() + "/";
    return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed?.()
      && String(win.webContents?.getURL?.() || "").toLowerCase().startsWith(prefix));
  }

  function rendererFile(name) {
    // Windows that are open TOGETHER stay on the same captured release. Once no window shows it any more
    // (僅關閉介面), the next window re-captures: the Electron main process outlives its windows, so a release captured
    // once per process meant a renderer update could only arrive through a full app restart.
    // "Shows it" is what a window has loaded, not that the window exists: every caller creates its window first and
    // asks for the file second, so "every window destroyed" never holds here and the release would never be re-captured.
    // The packaged asar mirrors the repo layout, so ui/renderer sits next to ui/main.
    const rendererSourceDir = path.join(uiMainDir, "..", "renderer");
    if (rendererReleaseDir && !releaseInUse(rendererReleaseDir)) rendererReleaseDir = null;
    if (!rendererReleaseDir) {
      const cacheDir = path.join(app.getPath("userData"), "renderer-assets");
      rendererReleaseDir = prepareRendererAssets(rendererSourceDir, cacheDir, { connectSources: connectSources() });
      // A new capture is the moment the cache can shrink: keep what windows show and the newest few.
      try { pruneRendererAssets(cacheDir, { keep: [rendererReleaseDir] }); } catch (error) { console.warn(`[APP UI] renderer asset prune failed: ${error?.message || error}`); }
    }
    return path.join(rendererReleaseDir, name);
  }

  // The effective endpoints changed (a network apply, a Health bootstrap restart): capture a new release (its CSP
  // names the new addresses) and reload every open renderer window on the same page of that release. Each load is
  // awaited (loadFile() reports a failure by rejecting, which a try/catch around `void` never sees, and the
  // window would be counted as reloaded while it still ran the old CSP and endpoints): the result names every window
  // that failed, for the rediscovery record.
  async function reloadForEndpointChange() {
    const pages = BrowserWindow.getAllWindows().filter((win) => win && !win.isDestroyed())
      .map((win) => [win, trustedRendererPage(win.webContents.getURL())]).filter(([, page]) => page);
    rendererReleaseDir = null;
    return reloadWindowPages(pages, rendererFile);
  }

  return { webPreferences, trustedRendererPage, rendererFile, reloadForEndpointChange };
}

module.exports = { createRendererReleaseManager, reloadWindowPages, TRUSTED_PAGES };
