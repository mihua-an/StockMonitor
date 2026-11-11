"use strict";

// 開機自動啟動 (off by default, a switch in 設定). Windows' own per-user login item (the Run key),
// pointing at the same launcher the user's shortcut uses -- never Electron alone, which would start without Health:
//   installed : powershell -File <resources>\launch_stock_monitor.ps1   (what the installer's shortcuts run)
//   source    : wscript <checkout parent>\stock_monitor_hidden.vbs       (the source checkout's launcher)
// The login item itself is the state (no second copy in a settings file); status() reads it back from Windows.

const fs = require("fs");
const path = require("path");

function launcherFor({ isPackaged, resourcesPath, projectRoot, env = process.env }) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  if (isPackaged) {
    const script = path.join(resourcesPath || "", "launch_stock_monitor.ps1");
    return { path: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), script,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script] };
  }
  const script = path.resolve(projectRoot, "..", "stock_monitor_hidden.vbs");
  return { path: path.join(systemRoot, "System32", "wscript.exe"), script, args: [script] };
}

function createAutostart({ app, isPackaged, resourcesPath, projectRoot, fsImpl = fs, platform = process.platform, env = process.env }) {
  const launcher = launcherFor({ isPackaged, resourcesPath, projectRoot, env });
  const query = () => ({ path: launcher.path, args: launcher.args });

  function status() {
    if (platform !== "win32") return { available: false, enabled: false, reason: "只支援 Windows" };
    if (!fsImpl.existsSync(launcher.script)) {
      return { available: false, enabled: false, reason: `找不到啟動器 ${launcher.script}` };
    }
    const settings = app.getLoginItemSettings(query());
    return { available: true, enabled: Boolean(settings.openAtLogin), launcher: launcher.script };
  }

  function set(enabled) {
    const before = status();
    if (!before.available) throw new Error(`開機自動啟動無法設定：${before.reason}`);
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), ...query() });
    const after = status();
    if (after.enabled !== Boolean(enabled)) throw new Error("Windows 沒有套用開機自動啟動的設定");
    return after;
  }

  return { status, set, launcher };
}

module.exports = { createAutostart, launcherFor };
