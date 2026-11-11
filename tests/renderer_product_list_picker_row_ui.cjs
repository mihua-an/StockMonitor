// A product row's 現／月份 picker is read after the rows are drawn (product_sides.js). It must not make its row taller
// than the pitch the list scrolls by: 76 rows on 11-09 ended 91 px off, the first and last visible rows cut in half.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-product-picker-row-ui-")));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { enableSharedProductListScroll, productListShellMarkup, renderProductListRows } = await import(`${base}js/features/realtime/product_list.js`);
  const { cell } = await import(`${base}js/core/cell_patch.js`);
  const host = document.createElement("div");
  host.style.cssText = "width:700px;height:370px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  host.innerHTML = productListShellMarkup({ provider: "shioaji" });
  const body = host.querySelector('[data-role="product-list-body"]');
  const head = host.querySelector("thead tr");
  head.setAttribute("data-canonical-title-row", "");
  head.innerHTML = "<th>股號</th><th>量變</th><th>現價</th><th>昨收</th><th>開盤</th><th>漲幅</th>";
  const rows = Array.from({ length: 76 }, (_, i) => ({ code: String(2300 + i), hasFutures: i % 3 !== 1 }));
  const cellsOf = (sidesRead) => (row) => [
    sidesRead && row.hasFutures
      ? cell(row.code, "has-picker", { picker: { options: [["spot", "現"], ["m0", "11月"]], current: "spot", hint: ["m0", "期"] } })
      : cell(row.code),
    cell("+1.0%"), cell("40.00"), cell("40.00"), cell("40.00"), cell("1.00%"),
  ];
  const draw = (sidesRead) => renderProductListRows({ body, rows, columnCount: 6, cellsOf: cellsOf(sidesRead), codeOf: (row) => row.code });
  draw(false);
  const { rowSnap, viewport } = enableSharedProductListScroll(host);
  await wait(120);
  draw(true);
  await wait(120);
  const all = [...viewport.querySelectorAll("tbody tr")];
  const pitch = rowSnap.metrics().rowHeight;
  const off = all.map((row) => row.getBoundingClientRect().height).filter((height) => Math.abs(height - pitch) > 1.6);
  if (off.length) throw new Error(`${off.length} rows are not at the list's pitch ${pitch}: e.g. ${off[0]}`);
  rowSnap.scrollToIndex(all.length);
  await wait(100);
  const box = viewport.getBoundingClientRect();
  const first = all.find((row) => row.getBoundingClientRect().bottom > box.top + 1.5).getBoundingClientRect();
  const last = all.at(-1).getBoundingClientRect();
  if (Math.abs(first.top - box.top) > 1) throw new Error(`at the end the first visible row is ${first.top - box.top} px off the top`);
  if (Math.abs(last.bottom - box.bottom) > 1.5) throw new Error(`at the end the last row's bottom is ${last.bottom - box.bottom} px off the viewport's`);
}

app.whenReady().then(async () => {
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    for (const zoom of [1, 1.5]) {
      const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false, backgroundThrottling: false } });
      await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
      win.webContents.setZoomFactor(zoom);
      await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
      win.destroy();
    }
    console.log("product list picker row ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("product list picker row ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
