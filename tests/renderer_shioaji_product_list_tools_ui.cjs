const { makeTempDir } = require("./support/temp_dirs.cjs");
// The Shioaji product list's ✎ and ⚙ in a real Chromium (run with Electron), user 11-05: both did nothing. The list
// component binds its own two buttons on every mount (product_list_tools.js), so they work when the list
// is mounted after the page (its pane tab opened later) and when it is mounted again with its parked nodes. Checked:
//   * ✎ opens the watch-page editor window once per press;
//   * ⚙ opens the page's column editor on the list of the page shown: the ordinary list, or 實際庫存's own;
//   * after destroy + mount (the same nodes come back) each press still acts exactly once, and a destroyed list's
//     buttons do nothing.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-shioaji-product-tools-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  let editorOpens = 0;
  window.desktopAPI = {
    networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } },
    openWatchPageEditor: async () => { editorOpens += 1; },
  };
  window.fetch = async (input) => new Response(JSON.stringify({ ok: false, error: `not served: ${String(input?.url || input)}` }),
    { status: 404, headers: { "Content-Type": "application/json" } });
  const { retainColumnSettingsEditor } = await import(`${base}js/core/components/column_settings_editor.js`);
  const { UnifiedProductListComponent } = await import(`${base}js/features/realtime/components/futu/product_list_components.js`);
  const { publishTaiwanProductPages } = await import(`${base}js/features/realtime/taiwan_product_list_store.js`);

  // The page is mounted first (its column editor listens), the list later.
  const disposeEditor = retainColumnSettingsEditor();
  const page = document.getElementById("pageContainer");
  page.innerHTML = `<div id="productSlot" style="position:absolute;left:0;top:0;width:600px;height:400px"></div>`;
  const slot = document.getElementById("productSlot");
  publishTaiwanProductPages({ overview: { id: "overview", name: "總覽", codes: [] }, pages: [], activePageId: "overview" });
  let list = new UnifiedProductListComponent();
  list.mount({ host: slot });

  const press = (role) => {
    const button = slot.querySelector(`[data-role="${role}"][data-provider="shioaji"]`);
    if (!button) fail(`the list has its ${role} button`);
    button.click();
  };
  const overlay = () => document.getElementById("quoteColumnSettingsOverlay");
  const title = () => overlay()?.querySelector(".product-list-column-settings-head b")?.textContent || "";
  const closeColumns = () => document.getElementById("quoteColumnCancelBtn").click();

  press("product-page-edit");
  await Promise.resolve();
  if (editorOpens !== 1) fail(`✎ opens the watch-page editor once: ${editorOpens}`);
  press("product-column-settings");
  if (overlay()?.hidden !== false) fail("⚙ opens the column editor");
  if (title() !== "商品列表欄位") fail(`⚙ on an ordinary page edits the ordinary list: ${title()}`);
  closeColumns();

  publishTaiwanProductPages({ overview: { id: "overview", name: "總覽", codes: [] }, pages: [], activePageId: "system-actual-holdings-tw" });
  press("product-column-settings");
  if (overlay()?.hidden !== false || title() !== "實際庫存欄位") fail(`⚙ on 實際庫存 edits the holdings list: ${title()}`);
  closeColumns();

  // Parked and mounted again: the same nodes come back, bound once.
  const nodeBefore = slot.querySelector('[data-role="product-page-edit"]');
  list.destroy();
  list = new UnifiedProductListComponent();
  list.mount({ host: slot });
  if (slot.querySelector('[data-role="product-page-edit"]') !== nodeBefore) fail("the parked list's nodes came back");
  press("product-page-edit");
  await Promise.resolve();
  if (editorOpens !== 2) fail(`✎ after a remount opens the editor exactly once: ${editorOpens}`);
  press("product-column-settings");
  if (overlay()?.hidden !== false || title() !== "實際庫存欄位") fail(`⚙ after a remount: ${title()} hidden=${overlay()?.hidden}`);
  closeColumns();

  // A destroyed list's buttons (parked out of the slot) are not bound to anything any more.
  list.destroy();
  if (slot.childNodes.length) fail("the destroyed list left nodes in the slot");

  // In a dashboard slot (user 11-11): ⚙ and ✎ sit in the slot's own tab row, as every component's controls do, and
  // nothing is left at the end of the page tabs. ComponentHost empties the row before destroy; the next mount brings
  // the same buttons back to it, each press acting once.
  const actions = document.createElement("div");
  page.prepend(actions);
  const pressIn = (where, role) => {
    const button = where.querySelector(`[data-role="${role}"]`);
    if (!button) fail(`${role} is in the slot's tab row`);
    button.click();
  };
  list = new UnifiedProductListComponent();
  list.mount({ host: slot, actionsHost: actions });
  if (slot.querySelector('[data-role="product-list-tools"]')) fail("the list's own header keeps no tool buttons in a slot");
  if (actions.querySelectorAll('[data-role="product-column-settings"], [data-role="product-page-edit"]').length !== 2) fail("⚙ and ✎ are in the slot's tab row");
  pressIn(actions, "product-page-edit");
  await Promise.resolve();
  if (editorOpens !== 3) fail(`✎ in the tab row opens the editor once: ${editorOpens}`);
  pressIn(actions, "product-column-settings");
  if (overlay()?.hidden !== false || title() !== "實際庫存欄位") fail(`⚙ in the tab row opens the column settings: ${title()}`);
  closeColumns();
  actions.replaceChildren();
  list.destroy();
  list = new UnifiedProductListComponent();
  list.mount({ host: slot, actionsHost: actions });
  pressIn(actions, "product-page-edit");
  await Promise.resolve();
  if (editorOpens !== 4) fail(`✎ after a remount in a slot opens the editor exactly once: ${editorOpens}`);
  actions.replaceChildren();
  list.destroy();
  disposeEditor();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: false, backgroundThrottling: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("shioaji product list tools ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("shioaji product list tools ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
