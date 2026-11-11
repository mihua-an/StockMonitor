// 紅綠調色工具: the real stylesheet and the real 買賣報價 / 成交明細 / 價量 / 商品列 components with
// sample data (limit-up and limit-down included), every red / green token of styles/tokens.css adjustable, and the result
// printed for the user to paste back. A local developer tool: it reads files of this repository only.
//
//   node_modules\electron\dist\electron.exe scripts\tooling\color_tuner\main.cjs
"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1680, height: 1000, title: "紅綠調色工具", backgroundColor: "#07111f",
    // Trusted local page that reads the stylesheets with fs to list where each token is used.
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
