// TradeEditor finds everything under its own host: two forms with the same id prefix in one document are isolated
// (each reads and writes its own fields and fill rows), and dispose() removes the listeners a form bound.
// Drawn in Chromium (run with Electron).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-trade-editor-")));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const { TradeEditor } = await import(`${base}js/features/account/trade_editor_form.js`);
  const page = document.getElementById("pageContainer");
  page.innerHTML = '<div data-host="a"></div><div data-host="b"></div>';
  const closes = [];
  const adapter = (name) => ({
    defaultMarket: () => "台股", knownName: () => "", onTitle() {}, submit: async () => {}, remove: async () => {},
    close: () => closes.push(name), reportError() {},
  });
  const frames = [];
  const a = new TradeEditor({ host: page.querySelector('[data-host="a"]'), idPrefix: "dup", adapter: adapter("a"), requestFrame: (fn) => frames.push(fn) });
  const b = new TradeEditor({ host: page.querySelector('[data-host="b"]'), idPrefix: "dup", adapter: adapter("b"), requestFrame: (fn) => frames.push(fn) });
  a.el("Code").value = "2330";
  b.el("Code").value = "2317";
  a.addFillRow();
  const result = {
    ownCode: a.el("Code").value === "2330" && b.el("Code").value === "2317",
    ownHosts: page.querySelector('[data-host="a"]').contains(a.el("Code")) && page.querySelector('[data-host="b"]').contains(b.el("Code")),
    fillRows: [a.fillRows().length, b.fillRows().length],
    focusThroughInjectedFrame: frames.length > 0,
  };
  b.el("CancelBtn").click();
  a.dispose();
  a.el("CancelBtn")?.click();
  page.querySelector('[data-host="a"] [id="dupCancelBtn"]').click();
  result.closes = closes;
  return result;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  try {
    const r = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    check(r.ownCode, "each form reads and writes its own 股號");
    check(r.ownHosts, "each form's elements are under its own host");
    check(JSON.stringify(r.fillRows) === "[2,1]", `each form has its own fill rows (${r.fillRows})`);
    check(r.focusThroughInjectedFrame, "focus goes through the injected frame scheduler");
    check(JSON.stringify(r.closes) === '["b"]', `a disposed form no longer answers its buttons (${r.closes})`);
    if (problems.length) throw new Error(`\n  ${problems.join("\n  ")}`);
    console.log("renderer trade editor isolation ui passed");
    app.exit(0);
  } catch (error) {
    console.error("renderer trade editor isolation ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
