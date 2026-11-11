const { makeTempDir } = require("./support/temp_dirs.cjs");
// What Electron main's console-message relay (ui/main/renderer_health.js, into error.log) receives from a renderer that
// imported js/core/console_relay.js: the detail of an object or a DOMException argument, not "[object Object]".
// Run with Electron. Without the relay the same calls arrive as "[object Object]" -- checked first, as the control.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-console-relay-"));
app.on("window-all-closed", () => {});

const CALLS = `console.warn("[TRADE PAGE COUNT]", { outcome: "dropped", page: 3 });
  console.error("[request] failed", new DOMException("signal timed out", "TimeoutError"));
  console.warn("[host] destroy failed", { componentId: "orderbook", error: new Error("gone") });`;

async function relayed(win, setup) {
  const messages = [];
  const listener = (event) => messages.push(event.message);
  win.webContents.on("console-message", listener);
  await win.webContents.executeJavaScript(`${setup}.then(() => { ${CALLS} return true; })`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  win.webContents.off("console-message", listener);
  return messages.filter((message) => message.startsWith("["));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const relay = pathToFileURL(path.join(__dirname, "..", "ui", "renderer", "js", "core", "console_relay.js")).href;
  try {
    const before = await relayed(win, "Promise.resolve()");
    if (!before.some((message) => message.includes("[object Object]"))) throw new Error(`control: Chromium's own text should lose the object: ${before.join(" | ")}`);
    const after = await relayed(win, `import(${JSON.stringify(relay)})`);
    const expected = [
      '[TRADE PAGE COUNT] {"outcome":"dropped","page":3}',
      "[request] failed TimeoutError: signal timed out",
      // An error inside an object keeps its fields, the first frames of its stack among them.
      '[host] destroy failed {"componentId":"orderbook","error":{"name":"Error","message":"gone","stack":"at <anonymous>:3:76"}}',
    ];
    if (JSON.stringify(after) !== JSON.stringify(expected)) throw new Error(`relayed: ${JSON.stringify(after)}`);
    // Electron main's own source of a call is now the wrapper; the record ends with the place of the code that logged.
    const caller = pathToFileURL(path.join(__dirname, "fixtures", "console_relay_caller.js")).href;
    const fromModule = [];
    const listener = (event) => { if (event.message.startsWith("[fixture]")) fromModule.push(event.message); };
    win.webContents.on("console-message", listener);
    await win.webContents.executeJavaScript(`import(${JSON.stringify(caller)}).then((m) => { m.logFromModule(); return true; })`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    win.webContents.off("console-message", listener);
    if (fromModule[0] !== `[fixture] logged from a module {"line":3} @ ${caller}:3`) throw new Error(`caller place: ${JSON.stringify(fromModule)}`);
    console.log("renderer console relay ui passed");
    app.exit(0);
  } catch (error) {
    console.error("renderer console relay ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
