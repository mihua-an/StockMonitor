const { makeTempDir } = require("./support/temp_dirs.cjs");
// Dragging a 商品列表 column boundary (the 實際庫存 columns; every product page shares the drag) with a real mouse, in a real Chromium with the app's CSS and the real product
// list shell (DataGrid split header, sideways rail). 10-20: since the lists keep each column's minimum and scroll
// sideways (column_title keepMinimums), a drag only moved width between the two columns beside the boundary; with
// the columns at their minimums neither could give any, so no boundary moved. Checked here: a boundary drag widens
// and narrows its left column in a pane wider and in one narrower than the columns, the body follows the header,
// the width is saved under the same key, and a double click restores the defaults.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-column-resize-drag-"));
app.on("window-all-closed", () => {});

const COLUMNS = ["name", "code", "current", "position_qty", "position_pnl", "position_pnl_pct", "position_avg_cost", "position_cost_amount"];

async function mount(base, columnIds, paneWidth) {
  const { productListShellMarkup, enableSharedProductListScroll } = await import(`${base}js/features/realtime/product_list.js`);
  const { ensureColumnSchema } = await import(`${base}js/core/column_title.js`);
  const { realtimeQuoteColumnsFor } = await import(`${base}js/core/column_schemas.js`);
  localStorage.clear();
  const host = document.getElementById("pageContainer");
  host.style.cssText = `position:absolute;left:0;top:0;width:${paneWidth}px;height:400px;display:flex;flex-direction:column`;
  host.innerHTML = productListShellMarkup({ provider: "shioaji" });
  const table = host.querySelector('[data-role="product-list-table"]');
  const columns = realtimeQuoteColumnsFor(columnIds, { holdings: true });
  const storageKey = `monitorQuoteColumnWidthsV2:shioaji:${columnIds.join(",")}`;
  window.__columnTest = { storageKey };
  // As the product list does: the header and rows are drawn, the grid shell is built, the next render keeps the header.
  const render = () => ensureColumnSchema(table, columns, {
    schemaId: "realtimeQuote",
    resize: { storageKey, defaultMinWidth: 48, floorWidth: 32, fitToAvailable: true, keepMinimums: true, defaultsFromSchema: true },
  });
  render();
  host.querySelector('[data-role="product-list-body"]').innerHTML = `<tr>${columns.map((c) => `<td>${c.id === "name" ? "台積電" : "1,234"}</td>`).join("")}</tr>`;
  enableSharedProductListScroll(host);
  render();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
}

function geometry() {
  const header = document.querySelector('[data-role="product-list-table"]');
  const wrap = header.closest(".product-list-table-wrap");
  const bodyTable = wrap.querySelector("table:not([data-role])") || [...wrap.querySelectorAll("table")].find((t) => t !== header);
  const ths = [...header.querySelectorAll("thead th")];
  const firstRow = bodyTable?.querySelector("tbody tr");
  const boundary = (index) => {
    const rect = ths[index].querySelector(".canonical-column-boundary.is-resizable")?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(window.__columnTest.storageKey) || "null"); } catch { saved = "unreadable"; }
  return {
    widths: ths.map((th) => Math.round(th.getBoundingClientRect().width)),
    bodyWidths: firstRow ? [...firstRow.cells].map((td) => Math.round(td.getBoundingClientRect().width)) : [],
    boundaries: ths.slice(0, -1).map((_th, index) => boundary(index)),
    available: wrap.clientWidth,
    storedKeys: Object.keys(localStorage),
    saved,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

async function drag(win, from, dx) {
  const send = (type, x, extra = {}) => win.webContents.sendInputEvent({ type, x, y: from.y, button: "left", clickCount: 1, ...extra });
  send("mouseMove", from.x);
  send("mouseDown", from.x);
  for (let step = 1; step <= 6; step += 1) { send("mouseMove", Math.round(from.x + dx * step / 6)); await new Promise((r) => setTimeout(r, 16)); }
  send("mouseUp", from.x + dx);
  await settle();
}

async function doubleClick(win, at) {
  for (const clickCount of [1, 2]) {
    win.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount });
    win.webContents.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount });
  }
  await settle();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 600, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const js = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`);
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  try {
    // A pane wider than the columns (they fill it) and one narrower (they keep their minimums and scroll sideways).
    for (const paneWidth of [1400, 300]) {
      await js(mount, base, COLUMNS, paneWidth);
      const before = await js(geometry);
      const label = `pane ${paneWidth}px`;
      if (process.env.COLUMN_WIDTH_REPORT) console.log(label, "default", before.widths.join(" "), "available", before.available);
      check(before.boundaries[0], `${label}: 股名 has no resize handle`);
      if (!before.boundaries[0]) continue;

      await drag(win, before.boundaries[0], 40);
      const wider = await js(geometry);
      check(wider.widths[0] >= before.widths[0] + 36, `${label}: dragging 股名's edge 40px right: ${before.widths[0]} -> ${wider.widths[0]}`);
      check(wider.widths.every((w, i) => Math.abs(w - wider.bodyWidths[i]) <= 1), `${label}: body follows header (${wider.widths} vs ${wider.bodyWidths})`);
      check(Number(wider.saved?.columns?.name) >= before.widths[0] + 36, `${label}: the new 股名 width is saved (${JSON.stringify(wider.saved)})`);
      check(wider.storedKeys.length === 1 && wider.storedKeys[0].endsWith(`monitorQuoteColumnWidthsV2:shioaji:${COLUMNS.join(",")}`),
        `${label}: saved under the existing key only (${wider.storedKeys})`);

      // 現價 (index 2, in view in both panes) widened, then narrowed in a second drag.
      await drag(win, wider.boundaries[2], 30);
      const priceWide = await js(geometry);
      check(priceWide.widths[2] >= wider.widths[2] + 26, `${label}: dragging 現價's edge 30px right: ${wider.widths[2]} -> ${priceWide.widths[2]}`);
      await drag(win, priceWide.boundaries[2], -20);
      const priceBack = await js(geometry);
      check(priceBack.widths[2] <= priceWide.widths[2] - 16, `${label}: dragging 現價's edge 20px left: ${priceWide.widths[2]} -> ${priceBack.widths[2]}`);
      check(priceBack.widths.reduce((a, b) => a + b, 0) >= priceBack.available - priceBack.widths.length, `${label}: the columns still fill the pane (${priceBack.widths})`);

      await doubleClick(win, priceBack.boundaries[0]);
      const restored = await js(geometry);
      check(restored.widths.every((w, i) => Math.abs(w - before.widths[i]) <= 1), `${label}: double click restores ${before.widths} (got ${restored.widths})`);
      check(restored.saved === null, `${label}: double click clears the saved widths`);
    }
    if (problems.length) throw new Error(`\n  ${problems.join("\n  ")}`);
    console.log("renderer column resize drag ui passed");
    app.exit(0);
  } catch (error) {
    console.error("renderer column resize drag ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
