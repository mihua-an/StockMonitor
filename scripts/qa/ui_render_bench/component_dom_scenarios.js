// Scenarios for component_dom_diff.cjs: each mounts one component of the tree at `base`, applies a fixed sequence of
// view models, and records the host's markup after each step (style attributes included).
const level = (price, volume, extra = {}) => ({ price, volume, quoteState: "PRICE", ...extra });

// What the host shows, canonically: elements with their attributes sorted, every style as the browser reads it (an
// authored "width:50.00%" and a written "width: 50%;" are the same style), an empty class or title attribute dropped
// (the same as none), and
// whitespace-only text between elements left out (markup templates carry it; it renders nothing in these tables).
// Attributes a refactor adds on purpose, left out of the comparison: "name" or "name=value" (STOCKMONITOR_DOM_IGNORE).
let ignoredAttributes = [];
const ignored = (attr) => ignoredAttributes.some((spec) => spec === attr.name || spec === `${attr.name}=${attr.value}`);
function markup(host) {
  const walk = (node) => {
    if (node.nodeType === 3) return /^\s*$/.test(node.data) ? "" : node.data;
    if (node.nodeType !== 1) return "";
    const attrs = [...node.attributes]
      .filter((attr) => !((attr.name === "class" || attr.name === "title") && !attr.value.trim()) && !ignored(attr))
      .map((attr) => [attr.name, attr.name === "style" ? node.style.cssText : attr.name === "class" ? attr.value.trim().split(/\s+/).join(" ") : attr.value])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ` ${name}="${value}"`).join("");
    const tag = node.tagName.toLowerCase();
    return `<${tag}${attrs}>${[...node.childNodes].map(walk).join("")}</${tag}>`;
  };
  return [...host.childNodes].map(walk).join("");
}

async function orderbook(base) {
  const { OrderBookComponent } = await import(`${base}js/core/components/orderbook_component.js`);
  const host = document.createElement("div");
  host.style.cssText = "width:420px;height:520px;position:relative";
  document.body.appendChild(host);
  const component = new OrderBookComponent({ manual: true });
  component.mount({ host, context: { mode: "live", services: {} }, hydrate: false });
  const book = (shift, extra = {}) => ({
    availability: "AVAILABLE", code: "2330", titlePrimary: "台積電", titleSecondary: "2330", lastPrice: 100 + shift, prevClose: 100,
    priceReference: 100, dayHigh: 102, dayLow: 98, limitUp: 110, limitDown: 90, lastTradeTime: "10:00:00",
    outsideTradeVolume: 300 + shift, insideTradeVolume: 200, neutralTradeVolume: 10, unknownTradeVolume: shift > 1 ? 5 : 0,
    bidLevels: [0, 1, 2, 3, 4].map((i) => level(100 + shift - 0.5 * (i + 1), 10 + i * 3 + shift, { delta: i === 0 ? 2 : null })),
    askLevels: [0, 1, 2, 3, 4].map((i) => level(100 + shift + 0.5 * (i + 1), 12 + i * 2, { delta: i === 1 ? -3 : null })),
    priceVolumeRows: [0, 1, 2, 3, 4, 5].map((i) => ({ price: 98 + i, out: 10 + i + shift, in: 5 + i, unknown: i === 2 ? 1 : 0 })),
    ...extra,
  });
  const steps = [];
  const record = () => steps.push(markup(host));
  const vms = [
    book(0, { diffRenderable: true, diffEventToken: "a" }),
    book(0, { diffRenderable: true, diffEventToken: "a" }),
    book(0.5, { diffRenderable: true, diffEventToken: "b" }),
    book(1, { diffRenderable: false, diffEventToken: "c", priceVolumeRows: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ price: 98 + i, out: 3 * i, in: 2, unknown: 0 })) }),
    book(2, { suspended: true, indicative: true }),
    { availability: "UNAVAILABLE", code: "2330", message: "尚無買賣報價" },
    book(-1, { bidLevels: [level(99, 5), { quoteState: "EMPTY" }, level(98, 0)], askLevels: [{ quoteState: "MARKET", price: 0, volume: 7 }] }),
    book(-1, { reviewPnl: { active: true, inside: true, estimated: 1234.4, title: "review" } }),
  ];
  for (const [index, vm] of vms.entries()) { component.update({ ...vm, presentationRevision: index + 1 }); record(); }
  component.destroy();
  host.remove();
  return steps;
}

const trade = (n, extra = {}) => ({ ingestSequence: n, time: `10:00:${String(n % 60).padStart(2, "0")}`, price: 100 + (n % 7) * 0.5,
  volume: n % 9 + 1, tradeSide: n % 2 ? "BUY" : "SELL", isLarge: n % 11 === 0, ...extra });
const tape = (top, count, extra) => Array.from({ length: count }, (_, i) => trade(top - i, extra));

async function tickDetails(base) {
  const { TickDetailsComponent } = await import(`${base}js/core/components/tick_details_component.js`);
  const host = document.createElement("div");
  host.style.cssText = "width:360px;height:500px;position:relative;display:flex";
  document.body.appendChild(host);
  const component = new TickDetailsComponent({ manual: true });
  component.mount({ host, context: { mode: "live", services: {} }, hydrate: false });
  const vm = (rows, extra = {}) => ({ code: "2330", logicalCode: "2330", page: 1, pageSize: 100, rows, referencePrice: 100, limitUp: 103, limitDown: 97, ...extra });
  const steps = [];
  const vms = [vm([], { loading: true }), vm(tape(40, 30)), vm(tape(41, 30)), vm(tape(43, 30)), vm(tape(43, 30), { referencePrice: 101 }),
    vm(tape(43, 30).map((r, i) => (i === 3 ? { ...r, price: 0 } : r))), vm(tape(10, 5), { code: "2317", logicalCode: "2317" }), vm([], { emptyText: "等待即時成交" })];
  // Highlight delays depend on time: freeze performance.now for a deterministic wash offset.
  const realNow = performance.now.bind(performance);
  let clock = 1000;
  performance.now = () => clock;
  try {
    for (const [index, model] of vms.entries()) { clock += 100; component.update({ ...model, presentationRevision: index + 1 }); steps.push(markup(host.querySelector("[data-role='tick-body']") || host)); }
  } finally { performance.now = realNow; }
  component.destroy();
  host.remove();
  return steps;
}

async function workspaceTrades(base) {
  const { WorkspaceTradesComponent } = await import(`${base}js/features/workspace/workspace_trades_component.js`);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const component = new WorkspaceTradesComponent();
  component.mount({ host, context: { dataSource: { subscribe: () => () => {}, invalidate: () => {} }, symbolStore: { getSelectedSymbol: () => "2330" } } });
  const realNow = performance.now.bind(performance);
  let clock = 1000;
  performance.now = () => clock;
  const steps = [];
  try {
    for (const [index, model] of [{ rows: tape(20, 10), referencePrice: 100, logicalCode: "2330" }, { rows: tape(22, 10), referencePrice: 100, logicalCode: "2330" },
      { rows: tape(22, 10), referencePrice: 104, logicalCode: "2330", limitUp: 101 }, { rows: [], emptyText: "休市" }, { rows: tape(5, 3), logicalCode: "2317" }].entries()) {
      clock += 100; component.update(model); steps.push(markup(host)); void index;
    }
  } finally { performance.now = realNow; }
  component.destroy();
  host.remove();
  return steps;
}

async function productList(base) {
  const { productListShellMarkup } = await import(`${base}js/features/realtime/product_list.js`);
  const table = await import(`${base}js/features/realtime/components/realtime_quote_table.js`);
  const host = document.createElement("div");
  host.innerHTML = productListShellMarkup({ provider: "shioaji" });
  document.body.appendChild(host);
  const row = (code, shift, extra = {}) => ({ code, name: `n${code}`, current: 50 + shift, prev_close: 50, open: 49.5, high: 51, low: 49, total_volume: 1000 + shift * 10,
    chg_1m: shift / 10, chg_3m: -shift / 10, chg_5m: 0, volume_change_pct_vs_baseline: shift * 3 - 5, ...extra });
  const steps = [];
  const pages = [
    [row("2330", 1), row("2317", -1), row("1101", 0)],
    [row("2330", 2), row("2317", -1), row("1101", 0)],
    [row("2330", 2), row("2317", -1), row("1101", 0, { status: "simtrade", indicative_price: 52, current: null })],
    [row("2317", -2), row("2330", 2)],
    [],
  ];
  for (const [index, rows] of pages.entries()) {
    table.renderExternalRealtimeQuoteTable({ rows, selectedCode: "2317", root: host, changedCodes: index === 1 ? new Set(["2330"]) : null,
      topologyChanged: index === 3, market: "tw" });
    steps.push(markup(host.querySelector('[data-role="product-list-body"]')));
  }
  table.renderExternalRealtimeQuoteTable({ rows: pages[0], selectedCode: "2330", root: host, holdings: [{ code: "2330", position_qty: 1000, avg_cost: 45 }], market: "tw" });
  steps.push(markup(host.querySelector('[data-role="product-list-body"]')));
  host.remove();
  return steps;
}

async function priceFlow(base) {
  const { PriceFlowComponent } = await import(`${base}js/core/components/price_flow_component.js`);
  const host = document.createElement("div");
  host.style.cssText = "width:520px;height:420px;position:relative;display:flex;flex-direction:column";
  document.body.appendChild(host);
  const component = new PriceFlowComponent();
  component.mount({ host, context: { dataSource: { subscribe: () => () => {}, invalidate: () => {} }, symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} } }, hydrate: false });
  const FIELDS = ["large_buy", "large_sell", "small_buy", "small_sell", "unclassified_buy", "unclassified_sell"];
  const pv = (prices, shift = 0) => ({ flow_fields: FIELDS,
    buckets: prices.map((price, i) => ({ price, out: 10 + i, in: 5, flow: [i % 3 ? 20 + shift : 0, 15 + i, 30 - i, 12 + shift, i === 1 ? 7 : 0, 0] })) });
  const vms = [
    { code: "2330", message: "等待逐價大小單資料" },
    { code: "2330", identity: "2330", priceVolume: pv([101, 100.5, 100, 99.5]), currentPrice: 100, referencePrice: 100 },
    { code: "2330", identity: "2330", priceVolume: pv([101, 100.5, 100, 99.5], 3), currentPrice: 100.5, referencePrice: 100 },
    { code: "2330", identity: "2330", priceVolume: pv([101.5, 101, 100.5, 100, 99.5], 3), currentPrice: 101.5, referencePrice: 100 },
    { code: "2330", identity: "2330", priceVolume: { flow_fields: null, buckets: [{ price: 100, out: 1, in: 1 }] } },
    { code: "2330", identity: "2330", priceVolume: pv([100, 99.5]), currentPrice: 99.5, referencePrice: 100 },
  ];
  const steps = [];
  for (const vm of vms) { component.update(vm); steps.push(markup(host)); }
  component.destroy();
  host.remove();
  return steps;
}

async function trend(base) {
  const { TrendChartComponent } = await import(`${base}js/core/components/trend_chart_component.js`);
  const steps = [];
  for (const variant of ["stock", "futures"]) {
    const host = document.createElement("div");
    host.style.cssText = "width:700px;height:420px;position:relative;display:flex;flex-direction:column";
    document.body.appendChild(host);
    const component = new TrendChartComponent({ manual: false, variant, dataKey: `${variant}Trend` });
    component.mount({ host, context: { mode: "live", services: {}, dataSource: { subscribe: () => () => {}, invalidate: () => {} },
      symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} } }, hydrate: false, slotId: `bench-${variant}` });
    const point = (m, price) => ({ minute_timestamp: `2026-10-14T09:${String(m).padStart(2, "0")}:00+08:00`, price, close: price, total_volume: m * 10 });
    const vm = (price, extra = {}) => ({ code: "2330", symbol: "2330", displayCode: variant === "futures" ? "TXFR1" : "2330", displayName: "台積電",
      currentPrice: price, prevClose: 100, openPrice: 99.5, points: [point(1, 99.5), point(2, price)],
      metrics: { limitUp: 110, limitDown: 90, change: price - 100, changePct: (price - 100), amplitude: 1.5, up3m: 0.61, down3m: 0.2 },
      stockInfo: { open: 99.5, high: 101, low: 99, prevClose: 100 }, breadth: { up_count: 1200, down_count: 800, flat_count: 50, limit_up_count: 3, limit_down_count: 1, trading_date: "2026-10-14" },
      ...extra });
    const vms = [vm(100.5), vm(100.5), vm(110, { indicative: true }), vm(99), vm(90)];
    for (const [index, model] of vms.entries()) {
      component.update({ ...model, presentationRevision: index + 1 });
      const copy = host.cloneNode(true);
      copy.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
      steps.push(markup(copy));
    }
    component.destroy();
    host.remove();
  }
  return steps;
}

async function positions(base) {
  const { renderPositions } = await import(`${base}js/features/account/positions_view.js`);
  const host = document.createElement("div");
  host.innerHTML = '<table><tbody id="actualHoldingsBody"></tbody></table><span id="actualHoldingCountText"></span><span id="actualHoldingsTitle"></span><span id="actualHoldingNote"></span>';
  document.body.appendChild(host);
  const opts = { market: "台股", isPaper: false, formatQty: String, formatMoney: (v) => String(v), formatSignedMoney: (v) => `${v > 0 ? "+" : ""}${v}`,
    formatSignedPercent: (v) => `${v.toFixed(2)}%`, profitClass: (v) => (v > 0 ? "account-profit-positive" : v < 0 ? "account-profit-negative" : "account-profit-flat") };
  const item = (code, pnl, extra = {}) => ({ code, name: `n${code}`, market: "台股", qty: 1000, avg_cost: 50, cost_amount: 50000, mark_price_available: true, unrealized_pnl: pnl, unrealized_pnl_pct: pnl / 500, ...extra });
  const steps = [];
  for (const items of [[], [item("2330", 100), item("2317", -50)], [item("2330", 120), item("2317", -50)], [item("2317", 0, { mark_price_available: false }), item("1101", 5)], [item("9999", 1, { market: "美股" })]]) {
    renderPositions(items, opts);
    steps.push(markup(host));
  }
  host.remove();
  return steps;
}

// Each component's shell as mounted (no data): what a page slot shows before the first update.
async function shells(base) {
  const ctx = (mode) => ({ mode, services: {}, dataSource: { subscribe: () => () => {}, invalidate: () => {} },
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} }, currentTimestamp: { get: () => null, subscribe: () => () => {} } });
  const mods = {
    event: (await import(`${base}js/core/components/event_feed_component.js`)).EventFeedComponent,
    trade: (await import(`${base}js/core/components/trade_details_component.js`)).TradeDetailsComponent,
    flow: (await import(`${base}js/core/components/trade_flow_component.js`)).TradeFlowComponent,
    tick: (await import(`${base}js/core/components/tick_details_component.js`)).TickDetailsComponent,
    book: (await import(`${base}js/core/components/orderbook_component.js`)).OrderBookComponent,
  };
  const steps = [];
  for (const [name, mode] of [["event", "live"], ["event", "replay"], ["trade", "replay"], ["flow", "live"], ["tick", "live"], ["tick", "replay"], ["book", "live"]]) {
    const host = document.createElement("div");
    host.style.cssText = "width:500px;height:400px;position:relative;display:flex;flex-direction:column";
    document.body.appendChild(host);
    const component = new mods[name](name === "book" || name === "tick" ? { manual: true } : undefined);
    component.mount({ host, context: ctx(mode), hydrate: false });
    steps.push(markup(host));
    component.destroy();
    host.remove();
  }
  return steps;
}

// A trend surface switched between 個股走勢 / 期貨走勢 / 加權走勢 in place (the "trend-chart" reuse group).
async function trendReconfigure(base) {
  const { TrendChartComponent } = await import(`${base}js/core/components/trend_chart_component.js`);
  const host = document.createElement("div");
  host.style.cssText = "width:700px;height:420px;position:relative;display:flex;flex-direction:column";
  document.body.appendChild(host);
  const component = new TrendChartComponent({ variant: "stock", dataKey: "stockTrend" });
  component.mount({ host, context: { mode: "live", services: {}, dataSource: { subscribe: () => () => {}, invalidate: () => {} },
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} } }, hydrate: false, slotId: "bench-reconfigure" });
  const steps = [];
  const record = () => { const copy = host.cloneNode(true); copy.querySelectorAll("canvas").forEach((c) => c.remove()); steps.push(markup(copy)); };
  record();
  for (const [dataKey, variant] of [["futuresTrend", "futures"], ["stockTrend", "stock"], ["marketTrend", "auto"], ["futuresTrend", "futures"]]) {
    try { component.reconfigure({ dataKey, variant }); } catch (error) { steps.push(`THREW ${error?.message}`); }
    record();
  }
  component.destroy();
  host.remove();
  return steps;
}

// Futu 個股走勢: the surface MoomooTrendComponent shows.
async function usTrend(base) {
  const { MoomooTrendComponent } = await import(`${base}js/features/realtime/components/moomoo_components.js`);
  const host = document.createElement("div");
  host.style.cssText = "width:700px;height:420px;position:relative;display:flex;flex-direction:column";
  document.body.appendChild(host);
  const component = new MoomooTrendComponent();
  component.host = host;
  component.renderShell();
  const copy = host.cloneNode(true);
  copy.querySelectorAll("canvas").forEach((c) => c.remove());
  const steps = [markup(copy)];
  component.sharedTrend?.destroy?.();
  host.remove();
  return steps;
}

const SCENARIOS = { orderbook, tickDetails, workspaceTrades, productList, priceFlow, trend, positions, shells, trendReconfigure, usTrend };

export async function run(base, only = "", ignore = []) {
  ignoredAttributes = ignore;
  const out = {};
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (only && only !== name) continue;
    out[name] = await scenario(base);
  }
  return out;
}
