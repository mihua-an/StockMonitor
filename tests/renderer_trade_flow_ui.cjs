const { makeTempDir } = require("./support/temp_dirs.cjs");
// 大單流向 in a real Chromium (run with Electron), the component on a fake data source: each 進出 chart has its own
// 累計／分時; the axis hides 0 only where its label would overlap an extreme's (which stays), and shows it again when
// the panel is tall enough; 買賣比's rows and 分時's 單別 and buckets answer a click; no part overflows the panel.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-trade-flow-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const frames = (n = 4) => new Promise((resolve) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : resolve()); step(n); });
  const { TradeFlowComponent } = await import(`${base}js/core/components/trade_flow_component.js`);
  let push = null;
  const context = {
    mode: "live",
    symbolStore: { getSelectedSymbol: () => "2337", subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: (_name, fn) => { push = fn; return () => {}; } },
    services: {},
  };
  const host = document.createElement("section");
  host.style.cssText = "width:386px;height:520px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  new TradeFlowComponent().mount({ host, context });

  // 大單: +300 at 09:00, then down to -6000; 小單: one-sided.
  const minuteSeries = Array.from({ length: 271 }, (_, i) => ({ minute: 540 + i, time: "", large: { buy: 0, sell: 0, net: i % 3 ? 0 : -60 }, small: { buy: 0, sell: 10, net: -10 },
    cumulative: { large: { net: i < 5 ? 300 : -i * 22 }, small: { net: -10 * (i + 1) } } }));
  const side = (buy, sell) => ({ buy, sell, net: buy - sell, total: buy + sell, buy_ratio: buy / (buy + sell), sell_ratio: sell / (buy + sell) });
  const period = (a, b, c, d) => ({ large: side(a, b), small: side(c, d), buy: a + c, sell: b + d, net: a + c - b - d });
  const bucket = (key, from, to, buy, sell) => ({ key, from_minute: from, to_minute: to, opens_session: from === 540, closes_session: to === 810,
    large: side(buy, sell), total: 1000, buy_ratio: buy / 1000, sell_ratio: sell / 1000 });
  const flow = { available: true, market: "STK", session_open_minute: 540, session_close_minute: 810, minuteSeries,
    cumulative: { large: { net: -5940 }, small: { net: -2710 } },
    totals: { ...period(100, 200, 300, 400), control: { side: "SMALL", large_ratio: 0.3, small_ratio: 0.7 } },
    windows: { "300s": period(5, 6, 7, 8) },
    hourSeries: [bucket("all", 540, 810, 2, 400), bucket("m540", 540, 599, 1, 300), bucket("m780", 780, 810, 1, 100)],
    largeOrders: [{ time: "13:01:00", minute: 781, price: 61.2, volume: 50, side: "SELL" }, { time: "13:00:00", minute: 780, price: 61.3, volume: 60, side: "BUY" }] };
  push({ availability: "AVAILABLE", flow, flowSource: [flow] });
  await frames();

  const $ = (selector) => host.querySelector(selector);
  const all = (selector) => [...host.querySelectorAll(selector)];
  const chart = (size) => $(`.flow-chart[data-flow-size="${size}"]`);
  const labelText = (size) => [...chart(size).querySelectorAll(".flow-chart-y-label")].filter((el) => el.getBoundingClientRect().height > 1).map((el) => el.textContent);
  const inside = (when) => {
    const box = $('[data-role="flow-content"]');
    if (box.scrollWidth > box.clientWidth) fail(`${when}: the content is wider than the panel (${box.scrollWidth} > ${box.clientWidth})`);
  };

  if ($(".flow-control-head").textContent !== "小單控盤70.0%") fail(`control: ${$(".flow-control-head").textContent}`);
  if (labelText("large").join() !== "300,-5,940") fail(`a close 0 gives way to the extremes: ${labelText("large")}`);
  if (labelText("small").join() !== "0,-2,710") fail(`a one-sided day keeps 0: ${labelText("small")}`);
  host.style.height = "1400px";
  await frames();
  if (labelText("large").join() !== "300,0,-5,940") fail(`a tall panel has room for 0 again: ${labelText("large")}`);
  host.style.height = "520px";
  await frames();
  inside("進出");

  const mode = (size) => all(`[data-flow-mode-size="${size}"].active`).map((el) => el.dataset.flowDisplayMode).join();
  $('[data-flow-mode-size="small"][data-flow-display-mode="minute"]').click();
  await frames();
  if (mode("small") !== "minute" || mode("large") !== "cumulative") fail(`each chart has its own switch: ${mode("large")} / ${mode("small")}`);

  $('[data-panel-tab-key="ratio"]').click();
  await frames();
  inside("買賣比");
  if (all(".flow-ratio-row").length !== 7) fail("買賣比 lists 開盤迄今 and six windows");
  $('[data-flow-window="300s"]').click();
  await frames();
  const cells = all(".flow-ratio-detail tbody tr").at(-1).textContent;
  if (cells !== "合計1214-2") fail(`the chosen period's volumes: ${cells}`);

  $('[data-panel-tab-key="price-volume"]').click();
  await frames();
  inside("分時");
  const order = all(".flow-hour-label").map((el) => el.textContent).join();
  if (order !== "開盤迄今,13:00~收盤,開盤~10:00") fail(`newest hour first: ${order}`);
  const barsFit = () => { for (const bar of all(".flow-split-bar")) {
    const box = bar.getBoundingClientRect();
    if ([...bar.querySelectorAll("b")].some((el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)")) fail("a share's number has no colour of its own behind it: the bar's width is the share");
    const [buy, sell] = [...bar.querySelectorAll("b")].map((el) => el.getBoundingClientRect());
    if (!buy) continue;  // 尚無方向
    if (buy.left < box.left || sell.right > box.right || buy.right > sell.left) fail("both shares are written inside the bar, apart");
  } };
  barsFit();
  $('[data-flow-side="BUY"]').click();
  $('[data-flow-bucket="m780"]').click();
  await frames();
  if (all(".flow-large-order-row").map((el) => el.firstElementChild.textContent).join() !== "13:00:00") fail("單別 filters the list");
  if ($(".flow-pv-net").textContent !== "大單賣超 -99 張") fail(`the bucket's net: ${$(".flow-pv-net").textContent}`);
  // The default layout's pane is narrow and short: 買賣比 still shows every row and its volumes, numbers apart.
  host.style.width = "288px";
  host.style.height = "425px";
  $('[data-panel-tab-key="ratio"]').click();
  await frames();
  const box = $('[data-role="flow-content"]');
  if (box.scrollHeight > box.clientHeight) fail(`買賣比 scrolls in the narrow pane (${box.scrollHeight} > ${box.clientHeight})`);
  inside("narrow 買賣比");
  barsFit();
  $('[data-panel-tab-key="price-volume"]').click();
  await frames();
  inside("narrow 分時");
  barsFit();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 1500, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("trade flow ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("trade flow ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
