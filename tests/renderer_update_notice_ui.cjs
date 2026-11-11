const { makeTempDir } = require("./support/temp_dirs.cjs");
// 新版提示 in the bottom dock (update_notice.js), in a real Chromium (run with Electron): no button while main knows of
// no newer release; 「新版本 vX.Y.Z」 left of 新增交易 once main says one exists (at start or pushed later); pressing it
// asks main to open the release page; gone again when main says there is none.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-update-notice-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  document.querySelector("main").innerHTML = '<footer class="bottom-dock"><div class="dock-right"><button id="globalAddTradeBtn">新增交易</button></div></footer>';
  let push = null;
  let opened = 0;
  window.desktopAPI = {
    getAppUpdate: async () => ({ enabled: true, current: "0.1.0", latest: "0.1.0", available: false }),
    onAppUpdateChanged: (fn) => { push = fn; return () => { push = null; }; },
    openAppUpdate: async () => { opened += 1; return { ok: true }; },
  };
  const { initUpdateNotice } = await import(`${base}js/features/app_update/update_notice.js`);
  initUpdateNotice();
  await settle();
  const button = () => document.getElementById("appUpdateNoticeBtn");
  if (button()) fail("no button while the App is up to date");
  push({ enabled: true, current: "0.1.0", latest: "0.2.0", available: true });
  if (button()?.textContent !== "新版本 v0.2.0") fail(`the button says the new version: ${button()?.textContent}`);
  if (button().nextElementSibling?.id !== "globalAddTradeBtn") fail("it sits left of 新增交易");
  if (button().hasAttribute("title")) fail("no hover hint (the App shows none)");
  button().click();
  await settle();
  if (opened !== 1) fail("pressing it asks main to open the release page");
  push({ enabled: true, current: "0.1.0", latest: "0.3.0", available: true });
  if (document.querySelectorAll("#appUpdateNoticeBtn").length !== 1 || button().textContent !== "新版本 v0.3.0") fail("one button, the newest version");
  push({ enabled: true, current: "0.3.0", latest: "0.3.0", available: false });
  if (button()) fail("gone once there is no newer release");
  // Main already knows of a newer release when the page starts.
  document.querySelector("main").innerHTML = '<footer class="bottom-dock"><div class="dock-right"><button id="globalAddTradeBtn">新增交易</button></div></footer>';
  window.desktopAPI.getAppUpdate = async () => ({ enabled: true, current: "0.1.0", latest: "0.2.0", available: true });
  initUpdateNotice();
  await settle();
  if (button()?.textContent !== "新版本 v0.2.0") fail("shown at start when main already knows");
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 400, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("update notice ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("update notice ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
