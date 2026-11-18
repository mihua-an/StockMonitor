// The 新增交易 window draws the shared form's window variant (features/account/trade_editor_form.js) on index.css and
// windows/trade.css, in Chromium (run with Electron) at the window's content width (504 px,
// ui/main/secondary_window_factory.js). The window variant carries its own classes, never the modal's: trade.css used
// to put the modal's dialog, body and footer back with rules of the same weight. Checked: no modal class in the
// window, and the window's layout -- a flat full-width sheet, two field columns, the footer's padding, the message.
// TRADE_WINDOW_LAYOUT_JSON=<file> writes the measured layout (for comparing two versions); TRADE_WINDOW_SHOT=<png> a picture.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-trade-window-layout-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  for (const sheet of ["index.css", "windows/trade.css"]) {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = `${base}styles/${sheet}`;
    document.head.appendChild(link);
    await new Promise((resolve) => { link.onload = link.onerror = resolve; });
  }
  document.body.className = "trade-window-body";
  document.body.innerHTML = '<main class="trade-window-shell"></main>';
  const { tradeEditorMarkup } = await import(`${base}js/features/account/trade_editor_form.js`);
  const shell = document.querySelector(".trade-window-shell");
  shell.innerHTML = tradeEditorMarkup({ idPrefix: "tw", variant: "window" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const measure = (node) => {
    const s = getComputedStyle(node), b = node.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), position: s.position,
      padding: s.padding, margin: s.margin, border: `${s.borderTopWidth} ${s.borderRightWidth} ${s.borderBottomWidth} ${s.borderLeftWidth}`,
      radius: s.borderRadius, background: s.backgroundColor, shadow: s.boxShadow, overflow: s.overflow, columns: s.gridTemplateColumns,
      display: s.display, color: s.color, zIndex: s.zIndex, maxHeight: s.maxHeight };
  };
  const dialog = shell.querySelector("section");
  const body = dialog.children[0];
  const grid = shell.querySelector("[class*=form-grid]");
  const footer = dialog.lastElementChild;
  const message = document.getElementById("twMessage");
  const layout = { dialog: measure(dialog), body: measure(body), grid: measure(grid), footer: measure(footer),
    fills: measure(shell.querySelector("[class*=fills-section]")), messageEmpty: measure(message) };
  message.textContent = "儲存失敗";
  message.classList.add("error");
  layout.messageError = measure(message);
  message.classList.remove("error");
  message.classList.add("success");
  layout.messageSuccess = measure(message);
  message.classList.remove("success");
  message.textContent = "";
  const classes = [...shell.querySelectorAll("[class]")].flatMap((node) => [...node.classList]);
  return { layout, modalClasses: [...new Set(classes.filter((name) => name.startsWith("account-trade-modal")))] };
}

app.whenReady().then(async () => {
  const shot = process.env.TRADE_WINDOW_SHOT || "";
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 504, height: 520, webPreferences: { sandbox: false, offscreen: Boolean(shot) } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    const seen = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    if (process.env.TRADE_WINDOW_LAYOUT_JSON) fs.writeFileSync(process.env.TRADE_WINDOW_LAYOUT_JSON, JSON.stringify(seen.layout, null, 2));
    if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
    const { dialog, body, grid, footer, messageError } = seen.layout;
    const problems = [];
    if (seen.modalClasses.length) problems.push(`the window carries the modal's classes: ${seen.modalClasses}`);
    if (dialog.w !== 504 || dialog.x !== 0 || dialog.position !== "static") problems.push(`the sheet fills the window: ${JSON.stringify(dialog)}`);
    if (dialog.border !== "0px 0px 0px 0px" || dialog.radius !== "0px" || dialog.shadow !== "none") problems.push(`a flat sheet, no card: ${JSON.stringify(dialog)}`);
    if (dialog.maxHeight !== "none" || dialog.overflow !== "visible") problems.push(`the sheet is not a scrolled dialog: ${JSON.stringify(dialog)}`);
    if (body.padding !== "16px 18px 14px") problems.push(`the content padding: ${body.padding}`);
    if (grid.columns.split(" ").length !== 2) problems.push(`two field columns at 504 px: ${grid.columns}`);
    if (footer.padding !== "0px 18px 16px" || footer.border !== "0px 0px 0px 0px" || footer.display !== "flex") problems.push(`the footer: ${JSON.stringify(footer)}`);
    if (messageError.padding !== "7px 9px") problems.push(`the message: ${JSON.stringify(messageError)}`);
    if (problems.length) throw new Error(problems.join("; "));
    console.log("trade window form layout ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error(`trade window form layout ui contract FAILED: ${error?.message || error}`);
    app.exit(1);
  }
});
