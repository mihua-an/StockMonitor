const { makeTempDir } = require("./support/temp_dirs.cjs");
// 設定 → 資金 (pages/settings_capital.js) in a real Chromium (run with Electron) against a fake app_api: a group's 儲存
// has one writer, deciding from "every amount is whole 萬" and "a save of the group is out" (D08-11; the shared
// single-flight only dedupes and never writes the button). Checked: disabled while the save is out, also when an
// amount is edited meanwhile; a refused save with a not-whole amount typed meanwhile leaves 儲存 disabled (not put back
// as it was at the click); fixing the amount enables it; a double click is one POST.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-settings-capital-save-owner-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  const posts = [];
  let answerPost = null;
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input?.url || input));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/sources") return json({ source_settings: { enabled_sources: [], sources: {} } });
    if (url.pathname === "/api/actual-account/capital" && (init.method || "GET") === "GET") {
      return json({ ok: true, markets: { 台股: { daily_limit: "500000" }, 美股: { daily_limit: "0" } } });
    }
    if (url.pathname === "/api/actual-account/capital" && init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return new Promise((resolve) => { answerPost = (body, status) => resolve(json(body, status)); });
    }
    if (url.pathname === "/api/paper-wallet/capital") return json({ ok: true, markets: { 台股: {} } });
    return json({ ok: false, error: `unexpected ${url.pathname}` }, 404);
  };
  const host = document.createElement("div");
  host.id = "settingsCapitalGroups";
  document.getElementById("pageContainer").appendChild(host);
  const toast = document.createElement("div");
  toast.innerHTML = '<div id="settingsToast" class="settings-toast-stack" hidden></div>';
  document.body.appendChild(toast);
  const page = await import(`${base}js/pages/settings_capital.js`);
  page.initCapitalSettings();
  for (let i = 0; i < 50 && !document.querySelector('[data-capital-market="台股"][data-capital-field="daily_limit"]')?.value; i += 1) await wait(20);

  const group = '[data-capital-actions="actual"]';
  const save = () => document.querySelector(`${group} [data-capital-save]`);
  const amount = document.querySelector('[data-capital-ledger="actual"] [data-capital-market="台股"][data-capital-field="daily_limit"]');
  const type = (text) => { amount.value = text; amount.dispatchEvent(new Event("input")); };
  if (amount.value !== "50" || save().disabled) fail(`the saved amount in 萬, 儲存 usable: ${amount.value} ${save().disabled}`);

  type("60");
  save().click();
  save().click();
  if (!save().disabled) fail("儲存 is disabled while the save is out");
  await wait(50);
  if (posts.length !== 1) fail(`a double click is one POST: ${posts.length}`);
  type("70");
  if (!save().disabled) fail("an edit while the save is out leaves 儲存 disabled");
  type("7.5");
  answerPost({ ok: false, error: "refused" }, 422);
  await wait(100);
  if (!document.querySelector(`${group} [data-capital-message]`)?.textContent) fail("the refused save says so");
  if (!amount.classList.contains("is-invalid")) fail("the not-whole amount is marked");
  if (!save().disabled) fail("a not-whole amount typed during the save keeps 儲存 disabled once the save is answered");
  type("75");
  if (save().disabled) fail("a whole amount, nothing out: 儲存 usable");
  page.disposeCapitalSettings();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("settings capital save owner ui passed");
    app.exit(0);
  } catch (error) {
    console.error("settings capital save owner ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
