const { makeTempDir } = require("./support/temp_dirs.cjs");
// 即時報價's 產業指數 pages (BACKLOG 1v) in a real Chromium (run with Electron, like renderer_paper_ledger_ui.cjs):
// 「產業指數」 (the shared trend surface, variant "sector") beside 「Shioaji產業指數」, both on one fake current-index store.
// Checked: the list shows 上市 then 上櫃 as buttons that fit their pane, a click makes that index current and marks it,
// 「產業指數」 draws the index's line with its own name, code and constituents' breadth (never the exchange's), and a
// stock without an index shows 無對應產業指數 with "--" counts and no line left from the last index.
// INDUSTRY_INDEX_SCREENSHOT=<path.png> saves a picture of both pages (after a pick).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-industry-index-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  const { createIndustryIndexStore } = await import(`${base}js/features/realtime/industry_index_store.js`);
  const { industryIndexTrendViewModel } = await import(`${base}js/features/realtime/industry_index_view_model.js`);
  const { IndustryIndexListComponent } = await import(`${base}js/features/realtime/components/industry_index_list_component.js`);
  const { TrendChartComponent } = await import(`${base}js/core/components/trend_chart_component.js`);
  const { setMarketBreadthReader, notifyMarketBreadthChanged } = await import(`${base}js/core/market_breadth_store.js`);

  const indexes = [
    ["IX0010", "水泥類指數", "tse"], ["IX0011", "食品類指數", "tse"], ["IX0012", "塑膠類指數", "tse"], ["IX0028", "半導體類指數", "tse"],
    ["IX0029", "電腦及週邊設備類指數", "tse"], ["IX0030", "光電類指數", "tse"], ["IX0053", "櫃買半導體類指數", "otc"],
    ["IX0054", "櫃買電腦及週邊類指數", "otc"], ["IX0055", "櫃買光電業類指數", "otc"],
  ].map(([code, name, market]) => ({ code, name, market }));
  const fetchJson = async (url) => {
    if (url.endsWith("/industry-indexes")) return { ok: true, items: indexes, count: indexes.length };
    if (url.endsWith("/stock/0050")) return { ok: true, code: "0050", found: true, industry_code: "00", market: "tse", index: null };
    return { ok: true, code: "2330", found: true, industry_code: "24", market: "tse", index: indexes[3] };
  };
  const store = createIndustryIndexStore({ fetchJson, storage: null });

  // The exchange-wide breadth is set: 「產業指數」 must not show it.
  setMarketBreadthReader(() => ({ trading_date: "2026-10-20", advance_count: 411, decline_count: 391, limit_up_count: 7, limit_down_count: 3, flat_count: 72 }));
  notifyMarketBreadthChanged();

  // One 5-second QuoteIdxV1 day of IX0028 (10-20), as minute points.
  const start = Date.parse("2026-10-20T09:00:00+08:00");
  const trend = Array.from({ length: 170 }, (_, i) => ({
    minute_timestamp: new Date(start + (i + 1) * 60000).toISOString(),
    close: Number((1552.16 - 3 + Math.sin(i / 14) * 7 - i * 0.04).toFixed(2)),
  }));
  const state = { summary: { trading_date: "2026-10-20", current: trend.at(-1).close, prev_close: 1552.16, reference_price: 1552.16, open: 1550.06, high: 1554.55,
    low: 1537.84, advance_count: 50, decline_count: 37, flat_count: 8, limit_up_count: 1, limit_down_count: 0 }, trend };

  const main = document.querySelector("main");
  main.innerHTML = `<div style="display:flex;gap:6px;width:1180px;height:440px">
    <div id="trendPane" style="flex:0 0 640px;height:100%;display:flex;flex-direction:column"></div>
    <div id="listPane" style="flex:1 1 auto;height:100%"></div></div>`;
  const trendHost = document.getElementById("trendPane"), listHost = document.getElementById("listPane");
  const context = {
    mode: "live", services: {},
    dataSource: { subscribe: () => () => {}, invalidate: () => {} },
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    currentTimestamp: { subscribe: () => () => {} },
  };
  const surface = new TrendChartComponent({ dataKey: "industryIndexTrend", variant: "sector" });
  surface.mount({ host: trendHost, context, hydrate: false, slotId: "pane-ii" });
  const list = new IndustryIndexListComponent({ store });
  list.mount({ host: listHost, hydrate: false });
  // The page redraws 「產業指數」 when the current index changes (realtime.js industryIndexStore.subscribe).
  const draw = () => surface.update(industryIndexTrendViewModel({ current: store.snapshot(), state: store.snapshot().status === "index" ? state : {} }));
  store.subscribe(draw);
  draw();
  await store.loadCatalog();
  await settle();

  const roles = ["breadth-up", "breadth-down", "breadth-flat", "breadth-limit-up", "breadth-limit-down"];
  const counts = () => roles.map((role) => trendHost.querySelector(`[data-role="${role}"]`)?.textContent.trim()).join(",");
  const name = () => trendHost.querySelector('[data-role="product-name"]')?.textContent.trim();
  if (counts() !== "--,--,--,--,--") fail(`no index yet: the exchange's counts must not show (${counts()})`);

  // The list: 上市 then 上櫃, every button inside its pane.
  const titles = [...listHost.querySelectorAll(".industry-index-list-group-title")].map((node) => node.textContent);
  if (titles.join() !== "上市,上櫃") fail(`groups: ${titles}`);
  const buttons = [...listHost.querySelectorAll("[data-industry-index]")];
  if (buttons.length !== indexes.length) fail(`buttons: ${buttons.length}`);
  const pane = listHost.getBoundingClientRect();
  for (const button of buttons) {
    const box = button.getBoundingClientRect();
    if (box.width < 100 || box.left < pane.left || box.right > pane.right + 0.5) fail(`${button.dataset.industryIndex} is outside its pane`);
    const label = button.querySelector(".industry-index-list-name");
    if (label.scrollWidth > label.clientWidth + 1) fail(`${button.dataset.industryIndex}'s name is cut: ${label.textContent}`);
  }

  // A pick on the list: current, marked, and drawn with its own name, code, line and breadth.
  buttons[3].querySelector(".industry-index-list-name").click();
  await settle();
  if (store.snapshot().index?.code !== "IX0028") fail(`the click picks IX0028: ${JSON.stringify(store.snapshot())}`);
  const marked = [...listHost.querySelectorAll("[data-industry-index].current")].map((node) => node.dataset.industryIndex);
  if (marked.join() !== "IX0028") fail(`marked: ${marked}`);
  if (name() !== "半導體類指數") fail(`header: ${name()}`);
  // Names only, no IX code anywhere (使用者 10-22).
  if (/IX\d{4}/.test(listHost.innerText + trendHost.querySelector(".trend-titlebar").innerText)) fail("an IX code is shown");
  if (counts() !== "50,37,8,1,0") fail(`the index's own breadth: ${counts()}`);
  const canvas = trendHost.querySelector("canvas");
  if (!canvas || canvas.width < 200 || canvas.height < 100) fail(`the trend canvas: ${canvas?.width}x${canvas?.height}`);
  window.__industry = { store, surface, list, trendHost, counts, name };
  return { ok: true };
}

// After the picture: a stock without an index.
async function finish() {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fail = (message) => { throw new Error(message); };
  const { store, counts, name, list, surface } = window.__industry;
  await store.followStock("0050");
  await settle();
  if (name() !== "0050 無對應產業指數" || counts() !== "--,--,--,--,--") fail(`0050: ${name()} ${counts()}`);
  if (!/無對應產業指數/.test(document.getElementById("listPane").textContent)) fail("the list's line says 無對應產業指數");
  if (document.querySelector("#listPane [data-industry-index].current")) fail("no index stays marked");
  list.destroy();
  surface.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1220, height: 520, webPreferences: { sandbox: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    if (process.env.INDUSTRY_INDEX_SCREENSHOT) {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.INDUSTRY_INDEX_SCREENSHOT, image.toPNG());
    }
    await win.webContents.executeJavaScript(`(${finish.toString()})().then((r) => r.ok)`);
    console.log("industry index ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("industry index ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
