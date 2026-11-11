// X closes the window only and the App keeps recording; the tray icon reopens it or closes more;
// 開機自動啟動 is off by default, a switch backed by Windows' own login item pointing at the flavor's launcher.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { TrayController } = require("../ui/main/tray_controller.js");
const { createAutostart, launcherFor } = require("../ui/main/autostart.js");

// ---- tray
{
  const made = [];
  class FakeTray {
    constructor(image) { this.image = image; this.handlers = {}; this.tips = []; this.balloons = []; made.push(this); }
    setToolTip(text) { this.tips.push(text); }
    setContextMenu(menu) { this.menu = menu; }
    on(name, fn) { this.handlers[name] = fn; }
    displayBalloon(options) { this.balloons.push(options); }
    isDestroyed() { return false; }
    destroy() {}
  }
  const electron = {
    Tray: FakeTray,
    Menu: { buildFromTemplate: (items) => items },
    nativeImage: { createFromPath: (p) => ({ path: p, isEmpty: () => false }) },
  };
  const calls = [];
  const tray = new TrayController({ electron, iconPath: path.join(__dirname, "..", "ui", "main", "assets", "tray.png"),
    onOpen: () => calls.push("open"), onCloseUiAndBackend: () => calls.push("ui+backend"), onFullShutdown: () => calls.push("full") });
  tray.start();
  assert.equal(made.length, 1);
  const labels = made[0].menu.filter((item) => item.label).map((item) => item.label);
  assert.deepEqual(labels, ["開啟 Stock Monitor", "關閉介面與 FastAPI", "完整關閉（含行情服務）"]);
  for (const item of made[0].menu.filter((i) => i.click)) item.click();
  made[0].handlers["double-click"]();
  assert.deepEqual(calls, ["open", "ui+backend", "full", "open"]);
  tray.windowClosed();
  tray.windowClosed();
  assert.equal(made[0].balloons.length, 0, "closing the window raises no notification");
  assert.match(made[0].tips.at(-1), /背景錄行情中/);
  tray.windowOpened();
  assert.equal(made[0].tips.at(-1), "Stock Monitor");
}

// ---- autostart
{
  const env = { SystemRoot: "C:\\Windows" };
  const installed = launcherFor({ isPackaged: true, resourcesPath: "C:\\Apps\\StockMonitor\\resources", projectRoot: "x", env });
  assert.match(installed.path, /powershell\.exe$/);
  assert.deepEqual(installed.args.slice(-2), ["-File", "C:\\Apps\\StockMonitor\\resources\\launch_stock_monitor.ps1"]);
  const source = launcherFor({ isPackaged: false, projectRoot: "C:\\Dev\\STKMonitor\\StockMonitor", env });
  assert.match(source.path, /wscript\.exe$/);
  assert.equal(source.script, path.resolve("C:\\Dev\\STKMonitor\\StockMonitor", "..", "stock_monitor_hidden.vbs"));

  let item = { openAtLogin: false };
  const app = { getLoginItemSettings: () => ({ ...item }), setLoginItemSettings: (s) => { item = s; } };
  const fsImpl = { existsSync: () => true };
  const auto = createAutostart({ app, isPackaged: false, projectRoot: "C:\\Dev\\STKMonitor\\StockMonitor", fsImpl, platform: "win32", env });
  assert.deepEqual(auto.status(), { available: true, enabled: false, launcher: source.script }, "off by default");
  assert.equal(auto.set(true).enabled, true);
  assert.equal(item.path, source.path, "the login item runs the launcher, never Electron alone");
  assert.deepEqual(item.args, source.args);
  assert.equal(auto.set(false).enabled, false);
  const missing = createAutostart({ app, isPackaged: false, projectRoot: "C:\\Dev", fsImpl: { existsSync: () => false }, platform: "win32", env });
  assert.equal(missing.status().available, false);
  assert.throws(() => missing.set(true), /無法設定/);
  const stubborn = createAutostart({ app: { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {} },
    isPackaged: false, projectRoot: "C:\\Dev", fsImpl, platform: "win32", env });
  assert.throws(() => stubborn.set(true), /沒有套用/, "a change Windows did not take is an error, not a success");
}
console.log("tray and autostart contract ok");
