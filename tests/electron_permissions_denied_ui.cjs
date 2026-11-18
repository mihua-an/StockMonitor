"use strict";
// Every App session refuses every page permission: Electron's default grants whatever a page asks for (camera,
// microphone, notifications, clipboard, devices ...), and no App page uses a permission-gated API. Run with
// node_modules/electron/dist/electron.exe; a real page asks, and the answer must be "denied".
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const { makeTempDir } = require("./support/temp_dirs.cjs");
const { secureWebContents } = require("../ui/main/desktop_application");

app.commandLine.appendSwitch("disable-gpu");
app.whenReady().then(async () => {
  secureWebContents({
    app, BrowserWindow,
    desktopWindows: { trustedRendererPage: () => null },
    clientAuthentication: { secureSession: () => {} },
  });
  const window = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition("permissions-test") } });
  // A file: page, as the App's own pages are (a data: URL is not a secure context and has no mediaDevices).
  const page = path.join(makeTempDir("stockmonitor-permissions-"), "page.html");
  fs.writeFileSync(page, "<!doctype html><title>t</title>");
  await window.loadFile(page);
  const answers = await window.webContents.executeJavaScript(`(async () => ({
    notification: await Notification.requestPermission(),
    query: (await navigator.permissions.query({ name: "notifications" })).state,
    camera: await navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", (e) => e.name),
    geolocation: (await navigator.permissions.query({ name: "geolocation" })).state,
  }))()`);
  assert.equal(answers.notification, "denied", JSON.stringify(answers));
  assert.equal(answers.query, "denied", JSON.stringify(answers));
  assert.notEqual(answers.camera, "granted", JSON.stringify(answers));
  assert.equal(answers.geolocation, "denied", JSON.stringify(answers));
  // A second window on the same session does not install the handlers again (they are per session).
  const again = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition("permissions-test") } });
  await again.loadFile(page);
  assert.equal(await again.webContents.executeJavaScript("Notification.requestPermission()"), "denied");
  console.log("electron permissions denied contract passed", JSON.stringify(answers));
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
