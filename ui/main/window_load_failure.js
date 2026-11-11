"use strict";

// A secondary window whose page did not load (loadFile() reports that only by rejecting) is recorded with its kind
// and file, closed -- it was created hidden and would otherwise stay a blank window -- and one load-failure window
// (startup_error.html) says which window failed and why.
function createWindowLoadFailure({ BrowserWindow, release, registry }) {
  const KIND = "load_failure";

  function showLoadFailureWindow(detail) {
    if (!registry.bringForward(KIND)) {
      const created = registry.add(KIND, new BrowserWindow({
        width: 760, height: 460,
        backgroundColor: "#07111f",
        title: "Stock Monitor｜視窗載入失敗",
        autoHideMenuBar: true,
        show: false,
        webPreferences: release.webPreferences(),
      }));
      created.once("ready-to-show", () => { if (!created.isDestroyed()) { created.show(); created.focus(); } });
    }
    const target = registry.get(KIND);
    void Promise.resolve()
      .then(() => target.loadFile(release.rendererFile("startup_error.html"), { hash: encodeURIComponent(String(detail).slice(0, 500)) }))
      .catch((error) => console.error(`[WINDOWS] the load-failure page failed to load: ${error?.message || error}`));
  }

  function secondaryLoadFailed(win, kind, page, error) {
    const message = String(error?.message || error);
    if (!win || win.isDestroyed()) {
      // Closed while its page was still loading: the load ended with the window, nothing is left blank.
      console.warn(`[WINDOWS] ${kind} window closed before ${page} loaded: ${message}`);
      return;
    }
    console.error(`[WINDOWS] ${kind} window failed to load ${page}: ${message}`);
    win.close();
    showLoadFailureWindow(`${kind} window (${page}): ${message}`);
  }

  function loadSecondaryWindow(win, kind, page, options = undefined) {
    let loading;
    try {
      loading = win.loadFile(release.rendererFile(page), options);
    } catch (error) {
      loading = Promise.reject(error);  // a release that could not be captured fails the window the same way
    }
    void Promise.resolve(loading).catch((error) => secondaryLoadFailed(win, kind, page, error));
  }

  return { secondaryLoadFailed, loadSecondaryWindow };
}

module.exports = { createWindowLoadFailure };
