// Complete-row scrolling of the product list in a real Chromium (run with Electron). The table collapses its borders,
// so its first row lays out half a border shorter than every later row; the adaptive row pitch must still be one every
// row can keep. Checked across a range of pane heights: every row is laid out at the controller's pitch, and a list
// scrolled to its end rests with its first visible row flush with the viewport top.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-row-snap-pitch-ui-")));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { enableSharedProductListScroll } = await import(`${base}js/features/realtime/product_list.js`);

  const host = document.createElement("section");
  host.className = "product-list";
  document.querySelector("main").appendChild(host);
  const cells = (i) => `<td>名稱${i}</td><td>${2300 + i}</td><td><span class="volume-change neutral">--</span></td><td>40.00</td><td class="price-flat">40.00</td><td class="price-up">40.59</td>`;
  host.innerHTML = `<div class="product-list-table-wrap"><table class="product-list-table" data-role="product-list-table">
    <thead><tr data-canonical-title-row><th>股名</th><th>股號</th><th>量變</th><th>昨收</th><th>開盤</th><th>現價</th></tr></thead>
    <tbody>${Array.from({ length: 40 }, (_, i) => `<tr data-realtime-code="${2300 + i}">${cells(i)}</tr>`).join("")}</tbody></table></div>`;
  const { rowSnap, viewport } = enableSharedProductListScroll(host);
  if (!rowSnap || !viewport) throw new Error("the product list mounts its complete-row scrolling");

  const failures = [];
  for (let height = 200; height <= 280; height += 1) {
    host.style.cssText = `width:700px;height:${height}px;display:flex;flex-direction:column`;
    await frame();
    rowSnap.scheduleMeasure?.();
    rowSnap.measure?.();
    await frame();
    const rows = [...viewport.querySelectorAll("tbody tr")];
    const tops = rows.map((row) => row.getBoundingClientRect().top);
    const steps = tops.slice(1).map((top, i) => top - tops[i]);
    const pitch = rowSnap.metrics().rowHeight;
    const off = steps.find((step) => Math.abs(step - pitch) > 0.005);
    if (off !== undefined) failures.push(`height ${height}: a row is laid out at ${off.toFixed(3)} px, the controller scrolls by ${pitch.toFixed(3)}`);
    rowSnap.scrollToIndex(rows.length);
    await wait(30);
    await frame();
    const top = viewport.getBoundingClientRect().top;
    const first = rows.find((row) => row.getBoundingClientRect().bottom > top + 0.5);
    const offset = first ? first.getBoundingClientRect().top - top : 0;
    if (Math.abs(offset) > 0.6) failures.push(`height ${height}: at the end the first visible row is ${offset.toFixed(2)} px off the top`);
  }
  if (failures.length) throw new Error(`${failures.length} pane heights off the row grid, e.g. ${failures.slice(0, 3).join("; ")}`);
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("row snap pitch ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("row snap pitch ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
