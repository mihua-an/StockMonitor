// The two product lists (Shioaji and Futu) each own their sort: clicking one list's header redraws that list at
// once in the new order and leaves the other list's order alone (a module-wide sort state re-sorted both and only
// re-drew the Shioaji list). Drawn through the real product list shell and DataGrid in Chromium (run with Electron).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-quote-sort-")));
app.on("window-all-closed", () => {});

async function setup(base) {
  const { productListShellMarkup } = await import(`${base}js/features/realtime/product_list.js`);
  const { renderExternalRealtimeQuoteTable } = await import(`${base}js/features/realtime/components/realtime_quote_table.js`);
  // Rows as the product lists hand them over: through the data boundary, carrying their read model.
  const { withProductRead } = await import(`${base}js/core/market_read_adapters.js`);
  localStorage.clear();
  const page = document.getElementById("pageContainer");
  page.style.cssText = "position:absolute;left:0;top:0;width:900px;height:600px;display:flex;flex-direction:column";
  page.innerHTML = '<div data-list="tw" style="height:280px;display:flex;flex-direction:column"></div><div data-list="us" style="height:280px;display:flex;flex-direction:column"></div>';
  const tw = page.querySelector('[data-list="tw"]');
  const us = page.querySelector('[data-list="us"]');
  tw.innerHTML = productListShellMarkup({ provider: "shioaji" });
  us.innerHTML = productListShellMarkup({ provider: "futu" });
  renderExternalRealtimeQuoteTable({ root: tw, market: "tw", onSelect: () => {}, rows: [
    { code: "2330", name: "台積電", prev_close: 1000, current: 1010, total_volume: 10 },
    { code: "2317", name: "鴻海", prev_close: 200, current: 201, total_volume: 900 },
  ].map((row) => withProductRead(row, "shioaji")) });
  renderExternalRealtimeQuoteTable({ root: us, market: "us", onSelect: () => {}, rows: [
    { code: "AAPL", name: "Apple", prev_close: 100, current: 101, total_volume: 5 },
    { code: "MSFT", name: "Microsoft", prev_close: 300, current: 301, total_volume: 700 },
  ].map((row) => withProductRead(row, "futu")) });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
}

function order(list) {
  return [...document.querySelectorAll(`[data-list="${list}"] [data-role="product-list-body"] tr[data-realtime-code]`)]
    .map((row) => row.dataset.realtimeCode).join(",");
}

function clickHeader(list, columnId) {
  const th = document.querySelector(`[data-list="${list}"] thead th[data-column-id="${columnId}"]`);
  if (!th) return false;
  th.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return true;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 700, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const js = (code) => win.webContents.executeJavaScript(code);
  const orderOf = (list) => js(`(${order.toString()})(${JSON.stringify(list)})`);
  const click = (list, column) => js(`(${clickHeader.toString()})(${JSON.stringify(list)}, ${JSON.stringify(column)})`);
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  try {
    await js(`(${setup.toString()})(${JSON.stringify(base)})`);
    check(await orderOf("tw") === "2330,2317", `tw starts unsorted (${await orderOf("tw")})`);
    check(await orderOf("us") === "AAPL,MSFT", `us starts unsorted (${await orderOf("us")})`);

    // Futu: 現價 ascending then descending, redrawn at the click.
    check(await click("us", "current"), "us has a 現價 header");
    check(await orderOf("us") === "AAPL,MSFT", `us 現價 ascending (${await orderOf("us")})`);
    check(await click("us", "current"), "us 現價 header again");
    check(await orderOf("us") === "MSFT,AAPL", `us 現價 descending is drawn at the click (${await orderOf("us")})`);
    check(await orderOf("tw") === "2330,2317", `sorting us leaves tw alone (${await orderOf("tw")})`);

    // Shioaji: its own sort, starting from ascending (not continuing the Futu list's direction).
    check(await click("tw", "current"), "tw has a 現價 header");
    check(await orderOf("tw") === "2317,2330", `tw 現價 ascending (${await orderOf("tw")})`);
    check(await orderOf("us") === "MSFT,AAPL", `sorting tw leaves us descending (${await orderOf("us")})`);

    if (problems.length) throw new Error(`\n  ${problems.join("\n  ")}`);
    console.log("renderer quote table sort ui passed");
    app.exit(0);
  } catch (error) {
    console.error("renderer quote table sort ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
