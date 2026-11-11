const { makeTempDir } = require("./support/temp_dirs.cjs");
const { fixViewport } = require("./support/fixed_viewport.cjs");
// 模擬帳務 in a real Chromium (run with Electron, like renderer_ui_geometry.cjs): the component mounted on a fake page
// context whose paper-orders store, paper holdings, live prices and 買賣報價 are fakes. Checked: the four tiles, 委託・成交
// (one row per order and per trade typed in by hand: 股名 coloured by side, a working order's state and 刪改, a filled
// one's 成交均價 / 股數 / time and its 買進 / 賣出, a cancelled one grey at the bottom; a row opens to its 委託 and 成交
// lines), the 已實現 tab (a pair opens to 買入 / 賣出 × 時間, 單價, 價金 with fee and tax, 報酬率), the lists' scrollbar
// under their column titles, 未實現 rows (unsigned) and the figures at the bottom (a holding without a price leaves them
// "-"), and 刪改: it selects the order's stock, swaps 未實現 for the panel, 刪單
// defaults to everything left and sends cancel or reduce, 改價 steps by the 升降單位 and stops at 漲停 / 跌停, the digits
// take 昨收's side, a 買賣報價 price fills it, 確認改價 sends replace and 未實現 comes back. 下單: 委託's search box (at the
// end of its title row) opens the 下單 panel of the stock found in place of 未實現 -- its 買賣報價 (5 levels, 價格 / 漲跌 row)
// fills 價格, the steppers set 價格 / 數量, 買進 / 賣出 open a detail (委託, 價格, 預估金額) that any change closes, and
// 確認 places a limit ROD, or a market IOC with the limit price it reserves, then 未實現 comes back.
// PAPER_LEDGER_SCREENSHOT=<path.png> saves a picture of it (with the 刪改 panel open).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-paper-ledger-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base, pricePolicy) {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  // The product catalog (Electron main's copy) names each code's instrument kind; the renderer never guesses one.
  window.desktopAPI = { searchProductCatalogLocal: async (_source, query) => ({ ok: true,
    items: [{ code: String(query), type: String(query).startsWith("00") ? "etf" : "stock" }] }) };
  const { createPaperOrdersStore } = await import(`${base}js/core/paper_orders_store.js`);
  const { PaperLedgerComponent, unrealizedRows } = await import(`${base}js/features/realtime/components/paper_ledger_component.js`);
  // The ledger's closing terms (AccountingCore.closing_terms at 2.8 折): stock and ETF 證交稅.
  const terms = (tax) => ({ amount_rounding: "floor", fee_rate: "0.000399", min_fee: "1", fee_rounding: "ceil", sell_tax_rate: tax, tax_rounding: "floor" });
  const stock = terms("0.003"), etf = terms("0.001");
  // A holding without a live price: its P&L and the totals are null ("-" on screen), never 0; the cost still adds up.
  const partial = unrealizedRows([{ code: "2330", position_qty: 1000, avg_cost: 1000, cost_amount: 1000000, closing_terms: stock },
    { code: "2317", position_qty: 2000, avg_cost: 200, cost_amount: 400000, closing_terms: stock }],
    (code) => (code === "2330" ? 1010 : null));
  if (partial.rows[1].pnl !== null || partial.totals.pnl !== null || partial.totals.value !== null || partial.totals.cost !== 1400000
    || partial.missing.join() !== "2317") fail(`a missing price: ${JSON.stringify(partial)}`);
  // A short (qty < 0): 成本 is what the sell brought in, closing is buying back -- 480,000 + fee 192 against 489,830.
  const short = unrealizedRows([{ code: "4958", position_qty: -1000, avg_cost: 489.83, cost_amount: 489830, closing_terms: stock }], () => 480);
  if (short.rows[0].pnl !== 9638 || short.rows[0].qty !== -1000 || short.totals.cost !== 489830 || short.totals.value !== 499468)
    fail(`a short: ${JSON.stringify(short)}`);

  const order = (id, extra) => ({ order_id: id, trading_date: "2026-10-16", created_at: "09:30:00", code: "2330", name: "台積電", side: "買進",
    lot: "whole", price_type: "limit", price: 1040, tif: "ROD", qty: 3000, filled: 1000, unfilled: 2000, avg_price: 1040, state: "working",
    state_label: "部分成交", reason: "", messages: [], price_changes: [], matcher_silent: false, final: false, fills: [], ...extra });
  const orders = [
    order("PO-20261016-0003", { code: "2603", name: "長榮", price: 198, qty: 1000, filled: 0, unfilled: 0, state: "cancelled", state_label: "已取消", final: true }),
    order("PO-20261016-0002", { code: "2317", name: "鴻海", side: "賣出", created_at: "09:20:00", price: 212.5, qty: 2000, filled: 0, unfilled: 2000, state_label: "委託中" }),
    // Placed at 1,045 and changed to 1,040 (改價 keeps the order: one row, its price the new one).
    order("PO-20261016-0001", { fills: [{ fill_id: "F1", qty: 1000, price: 1040, reason: "", time: "09:31:05" }],
      price_changes: [{ time: "09:30:40", from: 1045, to: 1040 }] }),
    order("PO-20261016-0004", { code: "2454", name: "聯發科", side: "賣出", created_at: "09:12:30", price: 1310, qty: 1000, filled: 1000, unfilled: 0,
      avg_price: 1315, state: "filled", state_label: "全部成交", final: true, fills: [{ fill_id: "F2", qty: 1000, price: 1315, reason: "", time: "09:12:40" }] }),
  ];
  const posts = [];
  const get = async (url) => {
    if (url.endsWith("/funds")) return { ok: true, capital: { remaining_with_orders: 1642300, principal: 3000000, pending: [{ settlement_date: "2026-10-20", amount: -1358000 }],
      trade_terms: { stock, etf }, price_policy: pricePolicy } };
    if (url.startsWith("/api/paper-wallet/day")) return { ok: true, market: "台股", date: "2026-10-16", trades: [], pairs: [
      { id: 7, realized_date: "2026-10-16", market: "台股", code: "2344", name: "華邦電", trade_type: "當沖", direction: "空", qty: 2000,
        buy_price: 142, sell_price: 144, buy_amount: 284000, sell_amount: 288000, buy_fee: 162, sell_fee: 164, tax: 432, fee: 326,
        profit: 3242, roi: 0.0114, buy_ref: "09:33", sell_ref: "09:05" }] };
    if (url.includes("/fills")) return { ok: true, fills: [
      { trade_id: "T1", time: "09:05:12", code: "0050", name: "元大台灣50", action: "買進", avg_price: 198.35, qty: 300, origin: "撮合" },
      { trade_id: "T2", time: "09:31:05", code: "2330", name: "台積電", action: "買進", avg_price: 1040, qty: 1000, origin: "撮合" },
      { trade_id: "T3", time: "09:40:10", code: "2603", name: "長榮", action: "買進", avg_price: 199, qty: 2000, origin: "手動" }] };
    return { ok: true, trading_date: "2026-10-16", orders, revision: 1, matcher: {} };
  };
  const post = async (url, body) => { posts.push({ url, body }); return { ok: true, order: {}, new_order: { order_id: "PO-20261016-0004" } }; };
  const store = createPaperOrdersStore({ get, post, postEmpty: post, urlOf: (p) => p, stream: () => () => {} });

  let positions = [{ code: "2330", name: "台積電", position_qty: 1000, avg_cost: 1030.58, cost_amount: 1030580, closing_terms: stock },
    { code: "0050", name: "元大台灣50", position_qty: 300, avg_cost: 197.65, cost_amount: 59295, closing_terms: etf }];
  const holdingListeners = new Set();
  const pages = () => ({ tw: { items: positions }, us: { items: [] }, revision: 1 });
  const paperHoldings = { subscribe: (fn) => { holdingListeners.add(fn); return () => holdingListeners.delete(fn); }, refresh: async () => pages() };
  const prices = { "2330": 1040, "0050": 198.35 };
  const positionMarks = {
    subscribeView: (spec, cb) => { if (prices[spec.code]) setTimeout(() => cb({ type: "snapshot", state: { summary: { last_price: prices[spec.code] } } }), 0); return () => {}; },
    subscribeSession: (cb) => { setTimeout(() => cb({ equity: { trading_date: "2026-10-16" } }), 0); return () => {}; },
  };
  const levels = (start, step, side) => Array.from({ length: 10 }, (_, i) => ({ price: Number((start + side * i * step).toFixed(2)), volume: 100 + i * 10, quoteState: "PRICE" }));
  // The page's order book view, through the data boundary (it carries its read model).
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  const books = {
    // 漲停 / 跌停 are the provider's official ones in the book (Market Runtime's summary), never derived from 昨收.
    "2317": withMarketRead({ code: "2317", displayCode: "2317", displayName: "鴻海", availability: "AVAILABLE", currentPrice: 212, prevClose: 213,
      limitUp: 234, limitDown: 192, bidLevels: levels(212, 0.5, -1), askLevels: levels(212.5, 0.5, 1) }),
    "2303": withMarketRead({ code: "2303", displayCode: "2303", displayName: "聯電", availability: "AVAILABLE", currentPrice: 48.6, lastPrice: 48.6, prevClose: 48.15,
      limitUp: 52.9, limitDown: 43.35, bidLevels: levels(48.6, 0.05, -1), askLevels: levels(48.65, 0.05, 1) }),
  };
  const selected = [];
  const bookListeners = [];
  let symbol = "2330";
  // The page's selection service hands the reason to the market panel state (realtime.js persistSelectedSymbol), which
  // throws on a reason it does not know: 刪改 once sent one (10-19 error.log), so the fake goes through the real check.
  const { createMarketPanelUiState } = await import(`${base}js/features/realtime/market_panel_ui_state.js`);
  const panelState = createMarketPanelUiState({ storage: null });
  const select = (code, meta = {}) => { panelState.setSelectedSymbol(code, meta); selected.push(code); symbol = code; };
  // The page's product search: the stock found is selected, as the product headers' search does.
  const searched = [];
  const productSearch = {
    suggest: async (q) => [{ code: "2303", name: "聯電", market: "tse", note: "TSE" }].filter((item) => item.code.startsWith(q) || item.name.includes(q)),
    submit: async (item) => { searched.push(item.code); symbol = item.code; return { ok: true }; },
  };
  window.__ledgerSearched = searched;
  window.__ledgerBooks = books;
  window.__ledgerPushBook = (vm) => bookListeners.forEach((fn) => fn(vm));
  const context = { mode: "live", services: { paperOrders: store, paperHoldings, positionMarks, selection: { select }, productSearch },
    symbolStore: { getSelectedSymbol: () => symbol, subscribe: () => () => {} },
    dataSource: { subscribe: (name, fn) => { if (name === "orderbook") bookListeners.push(fn); return () => {}; },
      invalidate: (name, { symbol: code } = {}) => setTimeout(() => books[code] && bookListeners.forEach((fn) => fn(books[code])), 0) } };

  const main = document.querySelector("main");
  main.innerHTML = '<div id="ledger" style="width:1100px;height:560px"></div>';
  const host = document.getElementById("ledger");
  const ledger = new PaperLedgerComponent();
  window.__ledger = ledger;
  ledger.mount({ host, context, hydrate: false });
  await wait(60);
  await settle();
  const $ = (sel) => host.querySelector(sel);
  const text = (sel) => $(sel)?.textContent.trim();
  const posRowsOf = () => [...host.querySelectorAll('[data-role="ledger-positions"] tr')];

  // Tiles: title and number only.
  if (text('[data-card="limit"] [data-card-value]') !== "1,642,300") fail(`今日額度剩餘: ${text('[data-card="limit"]')}`);
  if (text('[data-card="principal"] [data-card-value]') !== "3,000,000") fail(`模擬庫存餘額: ${text('[data-card="principal"]')}`);
  if (text('[data-card="due"] [data-card-label]') !== "10/20 淨收付" || text('[data-card="due"] [data-card-value]') !== "1,358,000") fail(`淨收付: ${text('[data-card="due"]')}`);
  if (!$('[data-card="due"] [data-card-value]').classList.contains("price-down")) fail("a payment is green");
  if ([...host.querySelectorAll(".paper-ledger-tiles .settings-tile")].some((c) => c.children.length !== 2)) fail("a tile has a line beyond its title and number");

  // 委託・成交: working ones and filled ones newest first by their time, then the cancelled one (使用者 11-04).
  const orderRows = [...host.querySelectorAll('[data-role="ledger-orders"] tr[data-row-key]')];
  const keys = orderRows.map((r) => r.dataset.rowKey).join();
  if (keys !== "t:T3,o:PO-20261016-0001,o:PO-20261016-0002,o:PO-20261016-0004,o:PO-20261016-0003") fail(`委託・成交 rows: ${keys}`);
  const byId = (id) => orderRows.find((r) => r.dataset.rowKey === `o:${id}`);
  const buy = byId("PO-20261016-0001"), sell = byId("PO-20261016-0002"), done = byId("PO-20261016-0003"), filled = byId("PO-20261016-0004");
  const manual = orderRows.find((r) => r.dataset.rowKey === "t:T3");
  const cellsOf = (row) => [...row.cells].map((c) => c.textContent.trim()).join("|");
  // The colour that shows (a data-table cell has its own): the market red / green from the tokens.
  const colour = (node) => getComputedStyle(node).color;
  const red = "rgb(225, 25, 25)", green = "rgb(0, 153, 61)", grey = "rgb(156, 163, 175)";
  if (buy.cells[0].textContent !== "台積電" || colour(buy.cells[0].firstElementChild) !== red) fail(`buy name: ${buy.cells[0].outerHTML}`);
  if (sell.cells[0].textContent !== "鴻海" || colour(sell.cells[0].firstElementChild) !== green) fail(`sell name: ${sell.cells[0].outerHTML}`);
  // A working order: 委託價, 成交／委託, its state, 刪改.
  if (cellsOf(buy) !== "台積電|1,040|1／3 張|部分成交|刪改" || !buy.cells[4].querySelector("[data-ledger-edit]")) fail(`a working order: ${cellsOf(buy)}`);
  // A filled one: 成交均價, 股數, its last fill's time, its side in 刪改's place (text, coloured; 使用者 11-04).
  if (cellsOf(filled) !== "聯發科|1,315|1,000 股|09:12:40|賣出" || filled.querySelector("button") || colour(filled.cells[4].firstElementChild) !== green)
    fail(`a filled order: ${cellsOf(filled)}`);
  if (colour(filled.cells[1]) !== grey) fail("a filled order is grey");
  // A cancelled one: grey, its state, no side, no 刪改.
  if (cellsOf(done) !== "長榮|198|0／1 張|已取消|" || done.querySelector("button") || done.cells[0].firstElementChild || colour(done.cells[0]) !== grey)
    fail(`a cancelled order: ${cellsOf(done)}`);
  // A trade typed in by hand is a filled row too.
  if (cellsOf(manual) !== "長榮|199|2,000 股|09:40:10|買進") fail(`a trade by hand: ${cellsOf(manual)}`);
  // Opened: its lines under the same columns -- the order (委託時間 to the minute, the price it was placed at, 股數),
  // then each 改價 (the new price) and each fill, in time order (使用者 11-11: 改價 is the same order).
  buy.click();
  await wait(450);
  const detail = $('tr[data-detail-key="o:PO-20261016-0001"]');
  const lines = detail ? [...detail.querySelectorAll(".paper-ledger-lines tr")].map((r) => [...r.cells].map((c) => c.textContent).join("|")) : [];
  if (lines.join(";") !== "09:30|1,045|3,000 股||委託;09:30|1,040|||改價;09:31|1,040|1,000 股||成交") fail(`the opened order: ${lines.join(";")}`);
  if (!buy.classList.contains("expanded")) fail("the opened row is marked");
  const lineCells = [...detail.querySelector(".paper-ledger-lines tr").cells].map((c) => Math.round(c.getBoundingClientRect().left));
  const rowCells = [...buy.cells].map((c) => Math.round(c.getBoundingClientRect().left));
  // The grid gives the rows whole-pixel columns, the lines keep the shares: at most a pixel apart.
  if (lineCells.some((x, i) => Math.abs(x - rowCells[i]) > 1)) fail(`the lines sit under the columns: ${lineCells} vs ${rowCells}`);
  buy.click();
  await wait(400);
  if ($('tr[data-detail-key="o:PO-20261016-0001"]') || buy.classList.contains("expanded")) fail("a second click closes it");
  // The scrollbar is under the column titles (decisions.md「捲軸的位置」): the titles are a table outside the scrolling body.
  const ordersWrap = $('[data-role="ledger-orders-wrap"]');
  const headBand = ordersWrap.querySelector(".standard-data-grid-header-band"), bodyScroll = ordersWrap.querySelector(".standard-data-grid-body-scroll");
  if (!headBand || !bodyScroll || bodyScroll.contains(headBand) || bodyScroll.getBoundingClientRect().top < headBand.getBoundingClientRect().bottom - 0.5)
    fail("委託・成交's titles stay above its scrolling body");

  // 已實現: the second tab; a pair opens to 買入 / 賣出 × 時間, 單價, 價金 (with fee and tax), 報酬率.
  $('[data-ledger-tab="realized"]').click();
  await settle();
  if (!$('[data-role="ledger-orders-view"]').hidden || $('[data-role="ledger-realized-view"]').hidden) fail("已實現 replaces 委託・成交");
  if ($('[data-ledger-tab="realized"]').textContent !== "已實現") fail("the tab carries no amount");
  const pair = $('[data-role="ledger-realized"] tr[data-row-key="r:7"]');
  if (cellsOf(pair) !== "華邦電|2,000|142|144|3,242" || colour(pair.cells[4].firstElementChild) !== red) fail(`a pair: ${cellsOf(pair)}`);
  pair.click();
  await wait(450);
  const pairRows = [...host.querySelectorAll('tr[data-detail-key="r:7"] .paper-ledger-pair tr')].map((r) => [...r.cells].map((c) => c.textContent).join("|"));
  if (pairRows.join(";") !== "|買入|賣出;時間|09:33|09:05;單價|142|144;價金|284,162|287,404;報酬率|1.14%") fail(`the opened pair: ${pairRows.join(";")}`);
  $('[data-ledger-tab="orders"]').click();
  await settle();

  // 未實現, net of selling (使用者 10-17): 2330 sells 1,040,000 − fee 415 − tax 3,120 = 1,036,465 against 1,030,580
  // paid; 0050 (an ETF) 59,505 − 24 − 59 = 59,422 against 59,295. 總損益 has no sign, only its colour (使用者 11-04).
  const posRows = posRowsOf();
  if (colour(posRows[0].cells[2].firstElementChild) !== red) fail("未實現 profit is red");
  if (posRows.map((r) => r.cells[2].textContent).join(",") !== "5,885,127") fail(`未實現 P&L: ${posRows.map((r) => r.cells[2].textContent)}`);
  if (posRows.some((r) => r.cells.length !== 3) || host.querySelectorAll('[data-role="ledger-unrealized"] th').length !== 3) fail("未實現 has three columns, no 交易別");
  if (text('[data-role="unrealized-total"]') !== "6,012") fail(`未實現's total: ${text('[data-role="unrealized-total"]')}`);
  if (text('[data-sum="pnl"]') !== "6,012" || text('[data-sum="cost"]') !== "1,089,875" || text('[data-sum="value"]') !== "1,095,887" || text('[data-sum="roi"]') !== "0.55%")
    fail(`totals: ${["pnl", "roi", "value", "cost"].map((k) => text(`[data-sum="${k}"]`))}`);
  if (text('[data-card="pnl"] [data-card-value]') !== "6,012") fail("the tile is 未實現總損益");
  // A 未實現 row opens to 均價 / 市價 over 成本 / 現值 (使用者 11-11); 現值 = 成本 + 損益. A second click closes it.
  const tsmc = $('[data-role="ledger-positions"] tr[data-row-key="p:2330"]');
  tsmc.click();
  await wait(450);
  const figures = [...host.querySelectorAll('tr[data-detail-key="p:2330"] .paper-ledger-figure')].map((f) => [...f.children].map((c) => c.textContent).join("|"));
  if (figures.join(";") !== "均價|1,030.58;市價|1,040;成本|1,030,580;現值|1,036,465") fail(`the opened holding: ${figures.join(";")}`);
  const [avgBox, markBox, costBox] = [...host.querySelectorAll('tr[data-detail-key="p:2330"] .paper-ledger-figure')].map((f) => f.getBoundingClientRect());
  if (!(Math.abs(avgBox.top - markBox.top) < 1 && markBox.left > avgBox.left && costBox.top > avgBox.top && Math.abs(costBox.left - avgBox.left) < 1)) fail("均價 市價 on the first line, 成本 現值 under them");
  if (!tsmc.classList.contains("expanded")) fail("the opened holding is marked");
  tsmc.click();
  await wait(450);
  if ($('tr[data-detail-key="p:2330"]')) fail("a second click closes the holding");
  // 收益 and 報酬率 at the bottom take the up / down colour like the tile above (a rule for the figures hid it).
  if (colour($('[data-sum="pnl"]')) !== red || colour($('[data-sum="roi"]')) !== red) fail(`收益 / 報酬率 are red: ${colour($('[data-sum="pnl"]'))} ${colour($('[data-sum="roi"]'))}`);
  const sumLabels = [...host.querySelectorAll(".paper-ledger-sums .settings-tile-label")].map((n) => n.textContent).join();
  if (sumLabels !== "收益,報酬率,現值,成本") fail(`the figures at the bottom: ${sumLabels}`);
  const sums = $('[data-role="ledger-summary"]').getBoundingClientRect(), root = $(".paper-ledger").getBoundingClientRect();
  if (Math.abs(sums.bottom - (root.bottom - 8)) > 1) fail(`the figures sit at the bottom: ${sums.bottom} vs ${root.bottom}`);

  // 刪改 on the sell: the stock is selected, the panel replaces 未實現, 刪單 by default with everything left.
  sell.querySelector("[data-ledger-edit]").click();
  await wait(30);
  await settle();
  if (selected.join() !== "2317") fail(`刪改 selects the order's stock: ${selected}`);
  if (!$('[data-role="ledger-unrealized"]').hidden || $('[data-role="ledger-edit"]').hidden) fail("the panel replaces 未實現");
  const amount = $('[data-role="ledger-amount"]');
  const plus = $('[data-ledger-step="1"]'), minus = $('[data-ledger-step="-1"]');
  if (amount.value !== "2" || !plus.disabled || minus.disabled) fail(`刪單 starts at all 2 lots: ${amount.value} +${plus.disabled} -${minus.disabled}`);
  if (host.querySelectorAll('[data-role="ledger-book"] tr[data-orderbook-level]').length !== 5) fail("the 買賣報價 shows 5 levels");
  if (!$('[data-role="ledger-book"] tr[data-orderbook-level="0"]').textContent.includes("212.5")) fail(`the 買賣報價 shows the order's stock: ${$('[data-role="ledger-book"] tr[data-orderbook-level="0"]').textContent}`);
  if ($('[data-role="ledger-book"]').textContent.includes("價量")) fail("no 價量 tab in the 刪改 panel");
  // The shared 買賣報價 fits all 10 rows in its wrap: the rows' borders are part of the height it shares out.
  const wrap = $('[data-role="ledger-book"] .orderbook-table-wrap');
  if (wrap.scrollHeight > wrap.clientHeight + 1) fail(`the 10 levels overflow the book: ${wrap.scrollHeight} > ${wrap.clientHeight}`);
  const titleStrip = $('[data-role="ledger-book"] .tab-strip-title');
  if (titleStrip && getComputedStyle(titleStrip).display !== "none") fail("no 買賣報價 title strip in the 刪改 panel");
  const lastRow = $('[data-role="ledger-book"] tr[data-orderbook-level="4"]').getBoundingClientRect();
  const confirmBox = $('[data-ledger-action="confirm"]').getBoundingClientRect();
  if (lastRow.bottom > $('[data-role="ledger-book"]').getBoundingClientRect().bottom + 1 || confirmBox.bottom > host.getBoundingClientRect().bottom + 1)
    fail(`the 5 levels and 確認 fit: row ${lastRow.bottom}, confirm ${confirmBox.bottom}, host ${host.getBoundingClientRect().bottom}`);
  if ($('[data-role="ledger-book"] .orderbook-io-ratio')) fail("no 內外盤比");
  // Laid out as 下單 (使用者 11-11, E1): the 買賣報價 first, then 刪單 / 改價, the row (張數 · 剩 2 張), 取消 / 確認 and
  // the order as it stands; the card has 下單's look.
  const editTop = (sel) => $(`[data-role="ledger-edit"] ${sel}`).getBoundingClientRect().top;
  if (!(editTop('[data-role="ledger-book"]') < editTop(".paper-ledger-modes") && editTop(".paper-ledger-modes") < editTop('[data-role="ledger-amount"]')
    && editTop('[data-role="ledger-amount"]') < editTop('[data-ledger-action="confirm"]'))) fail("刪改 runs 買賣報價, 刪單 / 改價, the row, 確認 from the top");
  if (text('[data-role="ledger-amount-label"]') !== "張數" || text('[data-role="ledger-amount-note"]') !== "剩 2 張") fail(`the row's name: ${text('[data-role="ledger-amount-label"]')} ${text('[data-role="ledger-amount-note"]')}`);
  if ($('[data-role="ledger-edit"] .order-ticket-facts')) fail("no line under 取消 / 確認 (使用者 11-11)");
  if (getComputedStyle($('[data-role="ledger-edit"] .paper-ledger-card')).backgroundColor !== getComputedStyle($('[data-role="ledger-order"] .paper-ledger-card')).backgroundColor) fail("刪改's card has 下單's look");
  // 刪單 / 改價 and 委託・成交 / 已實現 are 28px, the title row's height and the search box's (使用者 11-11).
  for (const [sel, what] of [[".paper-ledger-modes", "刪單 / 改價"], ['[data-role="ledger-tabs"]', "委託・成交 / 已實現"], [".paper-ledger-head .product-quote-code-input", "the search box"]]) {
    const height = $(sel).getBoundingClientRect().height;
    if (Math.abs(height - 28) > 0.5) fail(`${what} is 28px: ${height}`);
  }
  if ($('[data-ledger-action="confirm"]').getBoundingClientRect().height !== $('[data-ledger-action="close"]').getBoundingClientRect().height) fail("取消 and 確認 are one button size");
  minus.click();
  if (amount.value !== "1" || !minus.disabled) fail(`刪單 stops at 1: ${amount.value}`);
  $('[data-ledger-action="confirm"]').click();
  await wait(30);
  if (!posts.some((p) => p.url.endsWith("PO-20261016-0002/reduce") && p.body.qty === 1000)) fail(`刪 1 of 2 lots is a reduce: ${JSON.stringify(posts)}`);
  if ($('[data-role="ledger-unrealized"]').hidden) fail("confirm brings 未實現 back");

  // 改價: steps stop at 漲停 234 / 跌停 192 (昨收 213), the digits take 昨收's side, a book price fills it.
  host.querySelector('[data-row-key="o:PO-20261016-0002"] [data-ledger-edit]').click();
  await wait(30);
  $('[data-ledger-mode="price"]').click();
  if (amount.value !== "212.5" || $('[data-ledger-action="confirm"]').textContent !== "確認改價") fail(`改價 starts at the order's price: ${amount.value}`);
  if (text('[data-role="ledger-amount-label"]') !== "價格" || text('[data-role="ledger-amount-note"]') !== "原 212.5") fail(`改價's row: ${text('[data-role="ledger-amount-label"]')} ${text('[data-role="ledger-amount-note"]')}`);
  if (getComputedStyle(amount).color !== green) fail("212.5 under 昨收 213 is green");
  amount.value = "233.5"; amount.dispatchEvent(new Event("input", { bubbles: true }));
  plus.click();
  if (amount.value !== "234" || !plus.disabled || getComputedStyle(amount).color !== red) fail(`stops at 漲停 234: ${amount.value} ${plus.disabled}`);
  plus.click();
  if (amount.value !== "234") fail("no step past 漲停");
  amount.value = "192.5"; amount.dispatchEvent(new Event("input", { bubbles: true }));
  minus.click();
  if (amount.value !== "192" || !minus.disabled) fail(`stops at 跌停 192: ${amount.value}`);
  host.querySelector('[data-role="ledger-book"] tr[data-orderbook-level="2"] .orderbook-price-cell.ask').click();
  if (amount.value !== "213.5") fail(`a book price fills 改價: ${amount.value}`);
  await settle();
  // A short shows its 股數 without a sign, as a long does (使用者 11-04): 2344 sold 2 張 with no holding.
  positions = [...positions, { code: "2344", name: "華邦電", position_qty: -2000, avg_cost: 143.51, cost_amount: 287021, closing_terms: stock }];
  holdingListeners.forEach((fn) => fn(pages()));
  await settle();
  const shortRow = posRowsOf().find((r) => r.dataset.rowKey === "p:2344");
  if (shortRow?.cells[1].textContent !== "2,000") fail(`a short's 股數 is unsigned: ${shortRow?.cells[1].textContent}`);
  window.__ledgerPosts = posts;
  return { ok: true };
}

// After the picture: 確認改價, a whole 刪單, 取消.
async function finish() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  const host = document.getElementById("ledger");
  const posts = window.__ledgerPosts;
  const $ = (sel) => host.querySelector(sel);
  $('[data-ledger-action="confirm"]').click();
  await wait(30);
  if (!posts.some((p) => p.url.endsWith("PO-20261016-0002/replace") && p.body.price === 213.5)) fail(`確認改價 sends replace: ${JSON.stringify(posts)}`);
  if ($('[data-role="ledger-unrealized"]').hidden) fail("確認改價 brings 未實現 back");
  // 刪單 of everything left is a cancel; 取消 just closes.
  host.querySelector('[data-row-key="o:PO-20261016-0002"] [data-ledger-edit]').click();
  await wait(30);
  // A double click sends one cancel: the confirm button is single-flight (R04-11).
  $('[data-ledger-action="confirm"]').click();
  if (!$('[data-ledger-action="confirm"]').disabled) fail("確認 is locked while the cancel is in flight");
  await Promise.resolve();
  if (!$('[data-role="ledger-amount"]').readOnly) fail("the value is locked while the cancel is in flight");
  $('[data-ledger-action="confirm"]').click();
  await wait(30);
  if (posts.filter((p) => p.url.endsWith("PO-20261016-0002/cancel")).length !== 1) fail(`刪 all that is left is one cancel: ${JSON.stringify(posts)}`);
  host.querySelector('[data-row-key="o:PO-20261016-0001"] [data-ledger-edit]').click();
  await wait(30);
  $('[data-ledger-action="close"]').click();
  if ($('[data-role="ledger-unrealized"]').hidden) fail("取消 brings 未實現 back");
  return { ok: true };
}

// 下單 from 委託's search box.
async function orderFlow(base) {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  const { buyCost } = await import(`${base}js/core/trade_costs.js`);
  const stock = { amount_rounding: "floor", fee_rate: "0.000399", min_fee: "1", fee_rounding: "ceil", sell_tax_rate: "0.003", tax_rounding: "floor" };
  const host = document.getElementById("ledger");
  const posts = window.__ledgerPosts;
  const $ = (sel) => host.querySelector(sel);
  const text = (sel) => $(sel)?.textContent.trim();
  const input = $(".paper-ledger-head .product-quote-code-input");
  if (!input) fail("委託's title row holds the search box");
  const search = async (q) => {
    input.focus();
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(250);
    if (!$(".product-quote-search-result")) fail(`the search lists ${q}`);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(60);
    await settle();
  };
  const head = input.closest(".paper-ledger-head").getBoundingClientRect(), box = input.getBoundingClientRect();
  if (head.right - box.right > 12 || box.width < 120) fail(`the box sits wide at the row's end: ${box.right} of ${head.right}, ${box.width} px`);
  // The first book of a stock may carry no price yet (10-27 live: 價格 stayed empty): 價格 fills from the next one.
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  const priced = window.__ledgerBooks["2303"];
  window.__ledgerBooks["2303"] = withMarketRead({ code: "2303", displayCode: "2303", displayName: "聯電", availability: "AVAILABLE", prevClose: 48.15,
    bidLevels: priced.bidLevels, askLevels: priced.askLevels });
  await search("2303");
  if ($('[data-ticket="price"]').value !== "") fail(`no price before the book has one: ${$('[data-ticket="price"]').value}`);
  window.__ledgerBooks["2303"] = priced;
  window.__ledgerPushBook(priced);
  await settle();
  if (window.__ledgerSearched.join() !== "2303") fail(`the stock found is selected: ${window.__ledgerSearched}`);
  if (!$('[data-role="ledger-unrealized"]').hidden || $('[data-role="ledger-order"]').hidden) fail("下單 replaces 未實現");
  if (input.value !== "") fail(`the box empties: ${input.value}`);
  if (host.querySelectorAll('[data-role="order-book"] tr[data-orderbook-level]').length !== 5) fail("the 下單 買賣報價 shows 5 levels");
  // The product row shows 價格 and 漲跌 only (user 10-27): the panel's title names the stock.
  const identity = $('[data-role="order-book"] .product-quote-identity');
  if (getComputedStyle(identity).display !== "none" || !$('[data-role="order-book"] .product-quote-price-box').getBoundingClientRect().width) fail("the product row is 價格 and 漲跌 only");
  // 委託・成交's column titles are as tall as 下單's product row beside them (user 10-27).
  const productRow = $('[data-role="order-book"] .product-quote-header').getBoundingClientRect().height;
  const heads = [...host.querySelectorAll(".paper-ledger-table > thead > tr")].filter((tr) => tr.getClientRects().length).map((tr) => tr.getBoundingClientRect().height);
  if (heads.length !== 1 || heads.some((h) => Math.abs(h - productRow) > 0.5)) fail(`the column titles are ${heads} px, the product row ${productRow} px`);
  if (!text('[data-role="order-title"]').includes("2303 聯電")) fail(`the title names the stock: ${text('[data-role="order-title"]')}`);
  const price = $('[data-ticket="price"]'), qty = $('[data-ticket="qty"]');
  if (price.value !== "48.6" || qty.value !== "1") fail(`下單 opens at the last price, 1 張: ${price.value} ${qty.value}`);
  if (!price.classList.contains("up")) fail("48.6 over 昨收 48.15 is red");
  host.querySelector('[data-role="order-book"] tr[data-orderbook-level="2"] .orderbook-price-cell.ask').click();
  if (price.value !== "48.75") fail(`a book price fills 價格: ${price.value}`);
  $('[data-ticket-step="qty:1"]').click();
  $('[data-ticket-side="buy"]').click();
  const confirm = $('[data-role="order-confirm"]');
  if (confirm.hidden) fail("買進 opens the detail");
  const amount = Math.round(buyCost(stock, 2000, 48.75)).toLocaleString("zh-TW");
  if (text('[data-role="order-confirm-qty"]') !== "2 張" || text('[data-role="order-confirm-price"]') !== "48.75" || text('[data-role="order-confirm-amount"]') !== `≈ ${amount}`)
    fail(`the detail: ${confirm.textContent}`);
  const c = confirm.getBoundingClientRect(), side = $('[data-ticket-side="buy"]').getBoundingClientRect(), panel = $('[data-role="ledger-order"]').getBoundingClientRect();
  if (c.bottom > side.top || c.left < panel.left || c.right > panel.right) fail(`the detail sits over 買進 inside the panel: ${JSON.stringify(c)}`);
  // Nothing of the 買賣報價 paints over it (its 委買／委賣 totals bar once covered 委託價格 and 預估金額).
  for (const role of ["order-confirm-price", "order-confirm-amount"]) {
    const r = $(`[data-role="${role}"]`).getBoundingClientRect();
    if (!confirm.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))) fail(`the detail's ${role} is covered`);
  }
  // Edge to edge (user 10-27): the 買賣報價, 價格 / 數量 and 買進 / 賣出 take the panel's whole width.
  for (const sel of ['[data-role="order-book"]', ".order-ticket-fields", ".order-ticket-sides"]) {
    const r = $(`[data-role="ledger-order"] ${sel}`).getBoundingClientRect();
    if (Math.abs(r.left - panel.left) > 1 || Math.abs(r.right - panel.right) > 1) fail(`${sel} spans the panel: ${r.left}-${r.right} of ${panel.left}-${panel.right}`);
  }
  const fields = [...host.querySelectorAll('[data-role="ledger-order"] .order-ticket-stepper *')];
  if (fields.some((n) => n.getBoundingClientRect().right > panel.right + 0.5)) fail("價格 / 數量 stay inside the panel");
  const facts = $(".order-ticket-facts").getBoundingClientRect();
  if (facts.bottom > panel.bottom + 1) fail(`the panel fits: facts ${facts.bottom} > ${panel.bottom}`);
  $('[data-ticket-step="qty:1"]').click();
  if (!confirm.hidden) fail("a change closes the detail");
  $('[data-ticket-side="buy"]').click();
  $('[data-order-action="confirm"]').click();
  await wait(30);
  const placed = posts.filter((p) => p.url === "/api/paper-wallet/orders");
  if (placed.length !== 1 || JSON.stringify(placed[0].body) !== JSON.stringify({ code: "2303", side: "買進", qty: 3000, price_type: "limit", tif: "ROD", price: 48.75 }))
    fail(`確認 places a limit ROD: ${JSON.stringify(placed)}`);
  if ($('[data-role="ledger-unrealized"]').hidden || !$('[data-role="ledger-order"]').hidden) fail("確認 brings 未實現 back");
  // The order shows up in 委託・成交 by itself: no message (使用者 11-04).
  if (text('[data-role="ledger-message"]') !== "") fail(`the message: ${text('[data-role="ledger-message"]')}`);
  // 零股 at 市價, sold: IOC with 跌停 reserved.
  await search("聯電");
  $('[data-ticket-action="lot"]').click();
  qty.value = "250";
  qty.dispatchEvent(new Event("input", { bubbles: true }));
  if (text('[data-ticket="qty-label"]') !== "股數" || text('[data-ticket="amount"]') === "--") fail(`零股 shows its amount: ${text('[data-ticket="amount"]')}`);
  $('[data-ticket-action="market"]').click();
  if (price.value !== "市價" || !price.readOnly) fail("市價 in 價格");
  $('[data-ticket-side="sell"]').click();
  if (!confirm.classList.contains("sell") || text('[data-role="order-confirm-qty"]') !== "250 股" || text('[data-role="order-confirm-price"]') !== "市價") fail(`the sell detail: ${confirm.textContent}`);
  $('[data-order-action="confirm"]').click();
  await wait(30);
  const market = posts.filter((p) => p.url === "/api/paper-wallet/orders")[1];
  if (JSON.stringify(market?.body) !== JSON.stringify({ code: "2303", side: "賣出", qty: 250, price_type: "market", tif: "IOC", reserve_price: 43.35 }))
    fail(`a market sell is IOC with 跌停 reserved: ${JSON.stringify(market)}`);
  // A 買賣報價 price clicked elsewhere on the page (paper_order_entry.js): the panel opens on that stock at that price.
  window.__ledger.openOrderAt({ code: "2303", name: "聯電", price: 48.5 });
  await wait(30);
  await settle();
  if ($('[data-role="ledger-order"]').hidden || price.value !== "48.5" || qty.value !== "1") fail(`openOrderAt opens 下單 at the price: ${price.value}`);
  // 回到未實現 closes the panel without an order.
  await search("2303");
  $('[data-order-action="close"]').click();
  if ($('[data-role="ledger-unrealized"]').hidden) fail("回到未實現");
  // In a pane as narrow as the App's 模擬帳務 (512px), the search box narrows with 委託's column and stays out of 未實現's.
  const wide = host.style.width;
  host.style.width = "512px";
  await settle();
  const searchBox = input.getBoundingClientRect();
  const leftColumn = $(".paper-ledger-left").getBoundingClientRect();
  if (searchBox.right > leftColumn.right + 0.5) fail(`the search box (right ${searchBox.right}) runs past 委託's column (right ${leftColumn.right})`);
  host.style.width = wide;
  await settle();
  window.__ledgerSearch = search;
  return { ok: true };
}

// The picture: 下單 open with 買進's detail.
async function orderPicture() {
  await window.__ledgerSearch("2303");
  document.getElementById("ledger").querySelector('[data-ticket-side="buy"]').click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1140, height: 640, webPreferences: { sandbox: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  await fixViewport(win, 1140, 640);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  // What the paper desk serves with its funds (twse_price_policy.price_policy_projection): the policy file's tables.
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "twse_price_policy.json"), "utf8"));
  const served = JSON.stringify({ tick_tables: policy.tick_tables, tick_table_of_kind: policy.tick_table_of_kind });
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${served}).then((r) => (window.__ledgerScenario = r, r.ok))`);
    if (process.env.PAPER_LEDGER_SCREENSHOT) {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.PAPER_LEDGER_SCREENSHOT, image.toPNG());
    }
    await win.webContents.executeJavaScript(`(${finish.toString()})().then((r) => r.ok)`);
    await win.webContents.executeJavaScript(`(${orderFlow.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    if (process.env.PAPER_LEDGER_ORDER_SCREENSHOT) {
      await win.webContents.executeJavaScript(`(${orderPicture.toString()})()`);
      fs.writeFileSync(process.env.PAPER_LEDGER_ORDER_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    }
    console.log("paper ledger ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("paper ledger ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
