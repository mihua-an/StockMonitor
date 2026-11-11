// Wheel input on a complete-row list in a real Chromium (run with Electron), sent through Chromium's input pipeline
// (webContents.sendInputEvent) so the page sees the deltaY / wheelDeltaY Chromium derives from wheel ticks. A mouse
// detent moves one row however many detents one wheel event carries (Chromium coalesces the events a busy main thread
// has not taken, and one Windows wheel message can hold several detents); fractional touchpad input moves every whole
// row it adds up to.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-row-snap-wheel-ui-")));
app.on("window-all-closed", () => {});

async function mount(base) {
  const { enableSharedProductListScroll } = await import(`${base}js/features/realtime/product_list.js`);
  const host = document.createElement("section");
  host.className = "product-list";
  host.style.cssText = "width:700px;height:300px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  const cells = (i) => `<td>名稱${i}</td><td>${2300 + i}</td><td>--</td><td>40.00</td><td>40.00</td><td>40.59</td>`;
  host.innerHTML = `<div class="product-list-table-wrap"><table class="product-list-table" data-role="product-list-table">
    <thead><tr data-canonical-title-row><th>股名</th><th>股號</th><th>量變</th><th>昨收</th><th>開盤</th><th>現價</th></tr></thead>
    <tbody>${Array.from({ length: 80 }, (_, i) => `<tr data-realtime-code="${2300 + i}">${cells(i)}</tr>`).join("")}</tbody></table></div>`;
  const { rowSnap, viewport } = enableSharedProductListScroll(host);
  if (!rowSnap || !viewport) throw new Error("the product list mounts its complete-row scrolling");
  await new Promise((resolve) => setTimeout(resolve, 80));
  rowSnap.measure();
  window.__rowSnap = rowSnap;
  const box = viewport.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, x: -4000, y: -4000, width: 1000, height: 800, skipTaskbar: true, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const failures = [];
  try {
    await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
    const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
    const at = await win.webContents.executeJavaScript(`(${mount.toString()})(${JSON.stringify(base)})`);
    const top = () => win.webContents.executeJavaScript("window.__rowSnap.metrics().topRowIndex");
    const reset = async () => { await win.webContents.executeJavaScript("window.__rowSnap.scrollToIndex(0)"); await wait(250); };
    // sendInputEvent takes the native sign: a negative deltaY / wheelTicksY scrolls down.
    const wheel = (ticks, extra = {}) => win.webContents.sendInputEvent({ type: "mouseWheel", x: at.x, y: at.y, deltaY: -100 * ticks, wheelTicksY: -ticks, ...extra });
    const expect = async (label, rows) => { await wait(300); const got = await top(); if (got !== rows) failures.push(`${label}: top row ${got}, expected ${rows}`); };

    // Warm-up: the first wheel event after load can land before hit-testing is ready.
    wheel(1); await wait(300); await reset();

    wheel(1);
    await expect("one detent", 1);
    await reset();
    wheel(5);
    await expect("five detents in one wheel event", 5);
    await reset();
    for (let i = 0; i < 5; i += 1) { wheel(1); await wait(220); }
    await expect("five separate detents", 5);
    wheel(-2);
    await expect("two detents up in one event", 3);
    await reset();
    // Windows "lines per scroll" = 1: deltaY is 33.3 px per detent, still one detent per row.
    win.webContents.sendInputEvent({ type: "mouseWheel", x: at.x, y: at.y, deltaY: -100 / 3, wheelTicksY: -1 });
    await expect("one detent at one line per scroll", 1);
    await reset();
    // Precision touchpad: fractional ticks, small pixel deltas that add up to rows.
    const pitch = await win.webContents.executeJavaScript("window.__rowSnap.metrics().rowHeight");
    const threshold = Math.max(10, pitch * 0.72);
    const step = threshold / 3 + 0.01;
    for (let i = 0; i < 6; i += 1) {
      win.webContents.sendInputEvent({ type: "mouseWheel", x: at.x, y: at.y, deltaY: -step, wheelTicksY: -step / 100, hasPreciseScrollingDeltas: true });
      await wait(20);
    }
    await expect("touchpad deltas worth two rows", 2);
    await reset();
    const big = threshold * 4 + 1;
    win.webContents.sendInputEvent({ type: "mouseWheel", x: at.x, y: at.y, deltaY: -big, wheelTicksY: -big / 100, hasPreciseScrollingDeltas: true });
    await expect("one touchpad event worth four rows", 4);

    if (failures.length) throw new Error(failures.join("; "));
    console.log("row snap wheel ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("row snap wheel ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
