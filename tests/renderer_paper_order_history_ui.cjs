const { makeTempDir } = require("./support/temp_dirs.cjs");
// 帳務 → 模擬帳務 → 委託紀錄 in a real Chromium (run with Electron): the view mounted on a fake app_api and a fake
// paper-orders stream. Checked: it reads the last 7 days, 歷史委託 groups by day newest first, 股名 keeps its side colour
// on a finished order, the state / 類型 chips and the stock box filter, a row opens on its fills and 經過 and stays open
// through a re-read, 歷史成交 lists the trades with their 類型 and filters them (no state row there), a new date range
// is read from app_api, a new orders revision reads again, and hidden it stops listening.
// PAPER_HISTORY_SCREENSHOT=<path.png> saves a picture of it.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
require("./support/keep_motion.cjs").keepMotion(app);
app.setPath("userData", makeTempDir("stockmonitor-paper-history-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  const { createPaperOrderHistoryView, matchesState, taipeiDate } = await import(`${base}js/features/account/paper_order_history_view.js`);

  const now = Date.parse("2026-10-17T02:00:00Z");   // 10:00 Taipei
  if (taipeiDate(0, now) !== "2026-10-17" || taipeiDate(7, now) !== "2026-10-10") fail("the default range is the last 7 days in Taipei");
  if (!matchesState({ final: true, state: "cancelled", filled: 1000, qty: 3000 }, "partial")) fail("a cancelled order with fills is 部分成交 too");

  const order = (id, day, extra) => ({ order_id: id, trading_date: day, created_at: "09:30:00", code: "2330", name: "台積電", side: "買進", lot: "whole",
    price_type: "limit", price: 1040, tif: "ROD", qty: 3000, filled: 1000, unfilled: 2000, avg_price: 1040, state: "working", state_label: "部分成交",
    reason: "", price_changes: [], final: false, kind: "現股",
    fills: [{ fill_id: `${id}-F1`, qty: 1000, price: 1040, reason: "排隊輪到", time: "09:31:05" }],
    steps: [{ time: "09:30:00.000", text: "委託 3 張 @1040 ROD" }, { time: "09:30:00.150", text: "進入撮合" }, { time: "09:31:05.000", text: "成交 1 張 @1040（排隊輪到）" }], ...extra });
  let orders = [
    order("PO-20261017-0001", "2026-10-17"),
    order("PO-20261016-0002", "2026-10-16", { code: "2603", name: "長榮", price: 198, qty: 1000, filled: 0, avg_price: null, state: "expired", state_label: "已失效",
      reason: "收盤未成交", final: true, fills: [], steps: [{ time: "13:10:00.000", text: "委託 1 張 @198 ROD" }, { time: "13:31:00.000", text: "已失效：收盤未成交" }] }),
    order("PO-20261016-0001", "2026-10-16", { code: "2317", name: "鴻海", side: "賣出", price: 212.5, qty: 2000, filled: 2000, state: "filled", state_label: "全部成交", final: true, kind: "當沖" }),
  ];
  const fill = (id, day, extra) => ({ trade_id: id, date: day, time: "09:31:05", code: "2330", name: "台積電", action: "買進", qty: 1000, avg_price: 1040,
    gross_amount: 1040000, fee: 415, tax: 0, cash: -1040415, kind: "現股", origin: "撮合", order_id: "PO-20261017-0001", fill_reason: "排隊輪到", ...extra });
  const fills = [fill("PO-20261017-0001-F1", "2026-10-17"),
    fill("M2", "2026-10-16", { time: "10:00:00", code: "2317", name: "鴻海", action: "賣出", qty: 2000, avg_price: 212.5, cash: 423572, kind: "當沖", origin: "手動", order_id: "" }),
    fill("M4", "2026-10-16", { time: "09:20:00", code: "0050", name: "元大台灣50", qty: 300, avg_price: 198, cash: -59424, kind: "零股", origin: "手動", order_id: "" })];
  const gets = [];
  const get = async (url) => { gets.push(url); return { ok: true, orders, fills }; };
  let listener = null;
  let unsubscribed = 0;
  const subscribeOrders = (fn) => { listener = fn; fn({ revision: 1 }); return () => { listener = null; unsubscribed += 1; }; };

  const main = document.querySelector("main");
  main.innerHTML = '<section id="history" class="account-view account-orders-view" style="width:1100px"></section>';
  const host = document.getElementById("history");
  const view = createPaperOrderHistoryView({ host, get, subscribeOrders, now: () => now });
  view.show();
  await wait(30);
  if (gets[0] !== "/api/paper-wallet/orders/history?start=2026-10-10&end=2026-10-17") fail(`first read: ${gets}`);
  const rows = () => [...host.querySelectorAll(".account-orders-row")];
  const days = () => [...host.querySelectorAll(".account-orders-day")].map((r) => r.textContent.trim());
  if (days().join("|") !== "10/17（1 筆）|10/16（2 筆）") fail(`day groups: ${days()}`);
  if (rows().length !== 3 || host.querySelector("[data-orders-count]").textContent !== "3 筆委託") fail("three orders listed");
  const colour = (row) => getComputedStyle(row.cells[1].firstElementChild).color;
  if (colour(rows()[0]) !== "rgb(225, 25, 25)" || colour(rows()[2]) !== "rgb(0, 153, 61)") fail(`股名 colours: ${rows().map(colour)}`);
  if (!rows()[1].classList.contains("done") || getComputedStyle(rows()[1].cells[8]).color !== "rgb(156, 163, 175)") fail("a finished order's other cells are grey");
  if (rows()[1].cells[9].textContent !== "收盤未成交" || rows()[2].cells[7].textContent !== "當沖") fail(`原因 / 類型: ${rows()[1].cells[9].textContent}`);
  // The shared expandable row: the caret is the first cell's, the header comes from the column schema (one column per cell).
  if (!rows()[0].cells[0].querySelector(".record-expand-caret") || !rows()[0].classList.contains("record-expand-row")) fail("a row uses the shared expand cell");
  if (host.querySelectorAll("[data-orders-table] thead th").length !== rows()[0].cells.length) fail("the header has one title per cell");
  host.querySelector('[data-orders-kind="當沖"]').click();
  if (rows().length !== 1 || rows()[0].dataset.ordersId !== "PO-20261016-0001") fail("類型 當沖 shows the day-trade order only");
  host.querySelector('[data-orders-kind="all"]').click();
  // Filters: a chip, then the stock box.
  host.querySelector('[data-orders-state="expired"]').click();
  if (rows().length !== 1 || rows()[0].dataset.ordersId !== "PO-20261016-0002") fail("已失效 shows the expired order only");
  host.querySelector('[data-orders-state="all"]').click();
  const stock = host.querySelector("[data-orders-stock]");
  stock.value = "鴻"; stock.dispatchEvent(new Event("input", { bubbles: true }));
  if (rows().length !== 1 || rows()[0].dataset.ordersId !== "PO-20261016-0001") fail("the stock box finds 鴻海 by name");
  stock.value = ""; stock.dispatchEvent(new Event("input", { bubbles: true }));
  // A row opens on its fills and 經過, and stays open when the orders are read again.
  rows()[0].click();
  const detail = () => host.querySelector("[data-orders-detail]");
  if (!detail() || !detail().textContent.includes("進入撮合") || !detail().textContent.includes("排隊輪到")) fail("the opened row shows its 經過 and fills");
  if (!rows()[0].classList.contains("expanded") || !detail().matches(".record-expand-detail")) fail("the open row is the shared expanded row with the shared detail row");
  if (!detail().querySelector(".record-expand-body").getAnimations().length) fail("an opening row grows with the expand motion");
  orders = orders.map((o) => (o.order_id === "PO-20261017-0001" ? { ...o, steps: [...o.steps, { time: "09:40:00.000", text: "送出刪單" }] } : o));
  listener({ revision: 2 });
  await wait(30);
  if (gets.length !== 2) fail(`a new revision reads again: ${gets.length}`);
  if (!detail()?.textContent.includes("送出刪單")) fail("the open row stays open with the new step");
  // 歷史成交: the trades with their 類型, filtered the same way; the state row is the orders' only.
  host.querySelector('[data-orders-tab="fills"]').click();
  // 歷史成交's trades: the list body's rows other than a day's group row.
  const fillRows = () => [...host.querySelectorAll("[data-orders-body] > tr[data-morph-key]:not(.account-orders-day)")];
  if (fillRows().length !== 3 || !host.querySelector("[data-orders-states]").hidden) fail("歷史成交 lists 3 trades without the state row");
  if (fillRows().map((r) => r.cells[8].textContent).join(",") !== "現股,當沖,零股") fail(`類型: ${fillRows().map((r) => r.cells[8].textContent)}`);
  if (getComputedStyle(fillRows()[1].cells[1].firstElementChild).color !== "rgb(0, 153, 61)") fail("a sell trade's 股名 is green");
  host.querySelector('[data-orders-kind="零股"]').click();
  if (fillRows().length !== 1 || fillRows()[0].dataset.morphKey !== "M4") fail("類型 零股 shows the odd lot only");
  if (host.querySelector("[data-orders-count]").textContent !== "1 筆成交") fail("the count names 成交");
  host.querySelector('[data-orders-kind="all"]').click();
  host.querySelector('[data-orders-tab="orders"]').click();
  if (rows().length !== 3) fail("back to 歷史委託");
  // A new range is read from app_api.
  const start = host.querySelector("[data-orders-start]");
  start.value = "2026-10-01"; start.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(30);
  if (gets.at(-1) !== "/api/paper-wallet/orders/history?start=2026-10-01&end=2026-10-17") fail(`new range: ${gets.at(-1)}`);
  // A newer read aborts the one in flight (its late answer never lands); a failure is shown as the sanitized message,
  // never the raw error text.
  {
    const other = document.createElement("div");
    document.body.appendChild(other);
    const signals = [];
    let answer = 0;
    const flaky = (url, { signal } = {}) => {
      signals.push(signal);
      answer += 1;
      if (answer === 1) return new Promise((resolve) => setTimeout(() => resolve({ ok: true, orders: [{ order_id: "OLD" }], fills: [] }), 40));
      if (answer === 2) return Promise.resolve({ ok: true, orders, fills });
      return Promise.reject(new Error("Traceback: internal detail"));
    };
    const second = createPaperOrderHistoryView({ host: other, get: flaky, subscribeOrders: () => () => {}, now: () => now });
    const quiet = console.error;
    console.error = () => {};
    try {
      second.show();
      const otherStart = other.querySelector("[data-orders-start]");
      otherStart.value = "2026-10-02"; otherStart.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(80);
      if (!signals[0]?.aborted) fail("the newer read aborts the one in flight");
      if (other.querySelector('[data-orders-id="OLD"]')) fail("the aborted read's late answer never lands");
      otherStart.value = "2026-10-03"; otherStart.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(30);
    } finally {
      console.error = quiet;
    }
    const shownError = other.querySelector("[data-orders-message]").textContent;
    if (shownError.includes("Traceback") || !shownError.includes("讀取委託紀錄失敗")) fail(`the failure is shown sanitized: ${shownError}`);
    second.hide();
    other.remove();
  }
  return { ok: true, finish: true, unsubscribedBefore: unsubscribed, hide: (() => { view.hide(); return unsubscribed; })() };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1140, height: 640, webPreferences: { sandbox: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    const result = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    if (result.unsubscribedBefore !== 0 || result.hide !== 1) throw new Error(`hidden, it stops listening: ${JSON.stringify(result)}`);
    if (process.env.PAPER_HISTORY_SCREENSHOT) {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.PAPER_HISTORY_SCREENSHOT, image.toPNG());
    }
    console.log("paper order history ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("paper order history ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
