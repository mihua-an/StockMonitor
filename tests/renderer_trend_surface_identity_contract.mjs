import { withMarketRead } from "../ui/renderer/js/core/market_read_adapters.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDocument } from './lib/mini_dom.mjs';

// Trend surface identity -- BEHAVIOURAL.
//
// TrendChartComponent builds every Taiwan trend surface, 歷史回放's included (its replay surface in
// history.html's empty replayPrimary slot; layout_config.js DEFAULT_LAYOUTS.history.replayPrimary = "trendChart").
// Every defect this file guards was a surface being given the wrong identity or the wrong nodes:
//   * two canvases sharing one canvas id, and a 個股走勢 canvas labelled
//     data-trend-view="futures" while drawing a stock (the shared parking store);
//   * 歷史回放's 漲停/漲跌/振幅/1分·3分·5分上漲下跌 tape left permanently at "--" because this
//     component is its only writer and resolves those nodes by data-role;
//   * 歷史回放's 加權／期貨 toolbar removed at mount (only live surfaces had controls);
//   * 個股走勢 losing the exchange breadth counters that 加權走勢 / 期貨走勢 show, when the
//     product requirement is that all three Shioaji trends share ONE breadth snapshot.
//
// Asserting those from source text is worthless: stubbing any one of the fixes leaves a regex
// suite green. So this file parses the REAL shipped markup of both pages, mounts the REAL
// component into the REAL slots, and asserts which DOM nodes actually end up written.

// --- the shared DOM, holding each page's real markup -------------------------------------------
let liveDocument = createDocument();
function parseDocument(file) {
  const doc = createDocument();
  doc.body.innerHTML = readFileSync(new URL(file, import.meta.url), 'utf8');
  return doc.body;
}

// --- globals the renderer modules expect ------------------------------------------------------
const storage = new Map();
globalThis.document = {
  createElement: (tag) => liveDocument.createElement(tag),
  createDocumentFragment: () => liveDocument.createDocumentFragment(),
  getElementById: (id) => liveDocument.getElementById(id),
  querySelector: (selector) => liveDocument.querySelector(selector),
};
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => storage.set(String(key), String(value)),
};
// Never fire: the canvas painter is out of scope here, and letting it run would need a 2D context.
globalThis.window = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, devicePixelRatio: 1 };

const { TrendChartComponent } = await import('../ui/renderer/js/core/components/trend_chart_component.js');
const { setMarketBreadthReader, notifyMarketBreadthChanged } = await import('../ui/renderer/js/core/market_breadth_store.js');
const { parkedTrendSurfaceKeys } = await import('../ui/renderer/js/core/trend_surface_state.js');

const liveContext = () => ({
  mode: 'live',
  services: {},
  dataSource: { subscribe: () => () => {}, invalidate: () => {} },
  symbolStore: { getSelectedSymbol: () => '2330', subscribe: () => () => {} },
  currentTimestamp: { subscribe: () => () => {} },
});
const replayContext = () => ({ ...liveContext(), mode: 'replay' });

const text = (host, roleName) => host.querySelector(`[data-role="${roleName}"]`)?.textContent ?? null;
const BREADTH_ROLES = ['breadth-up', 'breadth-down', 'breadth-limit-up', 'breadth-limit-down', 'breadth-flat'];
// The four fixed tape roles, then the model-prediction cells, which are built from the horizons the
// view model carries (3m/5m here) -- there is no fixed 1/3/5-minute list any more.
const PREDICTION_ROLES = [
  'metric-limit-up', 'metric-change', 'metric-limit-down', 'metric-amplitude',
  'metric-up-3m', 'metric-down-3m', 'metric-up-5m', 'metric-down-5m',
];
const note = { status: 'OK', reason: null, testOnly: false, asof: null, model: 'm@1' };
const metricsVm = {
  points: [],
  displayName: '台積電', displayCode: '2330', symbol: '2330',
  currentPrice: 1105, prevClose: 1090, openPrice: 1092,
  stockInfo: { open: 1092, high: 1110, low: 1088, prevClose: 1090, totalVolume: 41234 },
  metrics: { limitUp: 1199, limitDown: 981, change: 15, changePct: 15 / 1090 * 100, amplitude: 2.02, up3m: 0.58, down3m: 0.42, up5m: 0.55, down5m: 0.45,
    predictionNotes: { up3m: note, down3m: note, up5m: note, down5m: note } },
};

// One exchange-wide breadth snapshot (the TAIEX view's summary), readable before anything mounts: subscribeMarketBreadth()
// hands it to each new subscriber, so a surface that owns breadth nodes fills them at mount.
setMarketBreadthReader(() => ({ trading_date: '2026-09-25', advance_count: 411, decline_count: 391, limit_up_count: 7, limit_down_count: 3, flat_count: 72 }));
notifyMarketBreadthChanged();

// =============================================================================================
// 1. Monitor page, analysisPrimary: the slot that owns the canonical document ids.
// =============================================================================================
const realtimeDocument = parseDocument('../ui/renderer/pages/realtime.html');
liveDocument = realtimeDocument.ownerDocument;
const realtimeHost = realtimeDocument.querySelector('[data-component-slot="analysisPrimary"]');
assert.ok(realtimeHost, 'realtime.html must still ship a static analysisPrimary trend surface');

const stockSurface = new TrendChartComponent({ dataKey: 'stockTrend', variant: 'stock' });
stockSurface.mount({ host: realtimeHost, context: liveContext(), hydrate: true, slotId: 'analysisPrimary' });

assert.equal(realtimeHost.querySelector('[data-role="trend-canvas"]').id, 'trendCanvas-analysisPrimary-stock',
  '個股走勢 carries a slot-scoped id like every surface: the page reaches its canvas through the mounted component');
assert.equal(realtimeHost.querySelector('[data-role="trend-canvas"]').dataset.trendLookupDock, 'realtime-orderbook',
  "個股走勢's crosshair card docks on the 即時報價 order book");

// 個股走勢: prediction row, its own session facts, then the shared exchange breadth.
assert.deepEqual(
  realtimeHost.querySelectorAll('[data-secondary-row]').map((row) => row.dataset.secondaryRow),
  ['prediction', 'stock', 'market'],
  '個股走勢 shows the predictions, 昨收/最高/漲幅/漲停 + 開盤/最低/振幅/跌停, AND the exchange breadth tape',
);
// Its controls sit in their own row above the chart, not on the chart.
const realtimeControls = realtimeHost.querySelector('[data-role="trend-control-row"]');
assert.ok(realtimeControls?.querySelector('[data-role="event-marker-toggle"]'), '盤中事件 lives in the control row');
assert.equal(realtimeHost.querySelector('.trend-chart-stage')?.querySelector('[data-role="event-marker-toggle"]'), null,
  'nothing is drawn on top of the chart any more');
// Breadth arrives from the store subscription at mount, before any view model.
assert.deepEqual(BREADTH_ROLES.map((role) => text(realtimeHost, role)), ['411', '391', '7', '3', '72'],
  '個股走勢 must show the same breadth snapshot as 加權走勢 / 期貨走勢');

stockSurface.update(withMarketRead(metricsVm));
assert.deepEqual(
  ['stock-open', 'stock-high', 'stock-low', 'stock-prev-close'].map((role) => text(realtimeHost, role)),
  ['1092.00', '1110.00', '1088.00', '1090.00'],
  '個股走勢 keeps its own 開盤/最高/最低/昨收 (總量 moved to 成交明細)',
);
assert.deepEqual(PREDICTION_ROLES.map((role) => text(realtimeHost, role)),
  ['1199.00', '1.38%', '981.00', '2.02%', '58.0%', '42.0%', '55.0%', '45.0%']);
assert.deepEqual(BREADTH_ROLES.map((role) => text(realtimeHost, role)), ['411', '391', '7', '3', '72'],
  'a stock frame leaves the counters the breadth store filled');
// The exchange breadth's one writer is the store: a frame carrying other counts does not reach the row, a store change does.
stockSurface.update(withMarketRead({ ...metricsVm, breadth: { trading_date: '2026-09-25', up_count: 1, down_count: 1, limit_up_count: 1, limit_down_count: 1, flat_count: 1 } }));
assert.deepEqual(BREADTH_ROLES.map((role) => text(realtimeHost, role)), ['411', '391', '7', '3', '72'],
  'a 個股走勢 frame never writes the exchange breadth');
setMarketBreadthReader(() => ({ trading_date: '2026-09-25', up_count: 412, down_count: 390, limit_up_count: 8, limit_down_count: 4, flat_count: 71 }));
notifyMarketBreadthChanged();
assert.deepEqual(BREADTH_ROLES.map((role) => text(realtimeHost, role)), ['412', '390', '8', '4', '71'],
  'the breadth store reaches the counters');
setMarketBreadthReader(() => ({ trading_date: '2026-09-25', advance_count: 411, decline_count: 391, limit_up_count: 7, limit_down_count: 3, flat_count: 72 }));
notifyMarketBreadthChanged();

// Only the canvas has a document id; the header, tape and breadth nodes are reached by role and carry none.
for (const roleName of ['product-name', 'metric-change', 'breadth-up', 'txf-session-control']) {
  const node = realtimeHost.querySelector(`[data-role="${roleName}"]`);
  assert.ok(!node || !node.id, `${roleName} carries no document id`);
}

// =============================================================================================
// 2. A second monitor slot: same shell, different identity. No id may be handed out twice.
// =============================================================================================
const secondSlot = document.createElement('div');
secondSlot.setAttribute('data-component-slot', 'analysisQuinary');
realtimeDocument.appendChild(secondSlot);
const futuresSurface = new TrendChartComponent({ dataKey: 'futuresTrend', variant: 'futures' });
futuresSurface.mount({ host: secondSlot, context: liveContext(), hydrate: false, slotId: 'analysisQuinary' });

assert.equal(secondSlot.querySelector('[data-role="trend-canvas"]').id, 'trendCanvas-analysisQuinary-futures');
assert.equal(secondSlot.querySelector('[data-role="trend-canvas"]').dataset.trendLookupDock, undefined,
  'only 個股走勢 docks its card on the order book');
assert.equal(realtimeDocument.querySelectorAll('#metricChange').length, 0, 'tape nodes carry no document id on any surface');
assert.deepEqual(secondSlot.querySelectorAll('[data-secondary-row]').map((row) => row.dataset.secondaryRow), ['session', 'market'],
  '期貨走勢 carries its facts without 漲停 / 跌停 and the breadth -- no N分上漲／N分下跌 row (2026-10-16)');
assert.equal(secondSlot.querySelector('[data-role="prediction-cell"]'), null, '期貨走勢 shows no model predictions');
assert.equal(secondSlot.querySelector('[data-role="metric-limit-up"]'), null, '期貨走勢 shows no 漲停');
assert.deepEqual(BREADTH_ROLES.map((role) => text(secondSlot, role)), ['411', '391', '7', '3', '72']);
assert.equal(text(secondSlot, 'stock-open'), '--', 'the 期貨 surface has the facts row, empty until a view model arrives');
assert.ok(secondSlot.querySelector('[data-role="trend-control-row"]')?.querySelector('[data-role="txf-session-control"]'),
  '日盤 / 夜盤 / 全日 live in the control row');

// reconfigure() changes which view a surface IS without remounting it.
futuresSurface.reconfigure({ dataKey: 'stockTrend', variant: 'stock' });
assert.equal(secondSlot.querySelector('[data-role="trend-canvas"]').id, 'trendCanvas-analysisQuinary-stock',
  'a slot-scoped canvas id follows the variant through reconfigure()');
assert.deepEqual(secondSlot.querySelectorAll('[data-secondary-row]').map((row) => row.dataset.secondaryRow), ['prediction', 'stock', 'market']);
assert.equal(secondSlot.querySelector('[data-role="txf-session-control"]'), null, 'the 期貨 session switch leaves with the variant');
assert.ok(secondSlot.querySelector('[data-role="trend-control-row"]')?.querySelector('[data-role="event-marker-toggle"]'),
  'and the 個股 control row takes its place');
assert.deepEqual(BREADTH_ROLES.map((role) => text(secondSlot, role)), ['411', '391', '7', '3', '72'],
  'breadth survives the row swap: the counters are exchange-wide, not per variant');
futuresSurface.update(withMarketRead(metricsVm));
assert.equal(text(secondSlot, 'stock-open'), '1092.00');

// A parked surface returns only to the identity it came from. Tag the exact nodes so an adoption
// is detectable even though the adopting component would immediately re-stamp id and rows.
secondSlot.querySelector('[data-role="trend-canvas"]').dataset.parkedProof = 'analysisQuinary';
futuresSurface.destroy();
assert.deepEqual(parkedTrendSurfaceKeys(), ['analysisQuinary:stock']);
const foreignSlot = document.createElement('div');
foreignSlot.setAttribute('data-component-slot', 'auxiliary');
realtimeDocument.appendChild(foreignSlot);
const foreignSurface = new TrendChartComponent({ dataKey: 'marketTrend', variant: 'market' });
foreignSurface.mount({ host: foreignSlot, context: liveContext(), hydrate: true, slotId: 'auxiliary' });
assert.equal(foreignSlot.querySelector('[data-role="trend-canvas"]').dataset.parkedProof, undefined,
  'another slot must be given a freshly built surface, never the nodes parked by a different slot');
assert.deepEqual(parkedTrendSurfaceKeys(), ['analysisQuinary:stock'], 'a refused restore consumes nothing');
assert.equal(foreignSlot.querySelector('[data-role="trend-canvas"]').id, 'trendCanvas-auxiliary-market');
// 加權走勢: 昨收 最高 漲幅 / 開盤 最低 振幅 over the breadth tape, no predictions (2026-10-16).
assert.deepEqual(foreignSlot.querySelectorAll('[data-secondary-row]').map((row) => row.dataset.secondaryRow), ['session', 'market']);
foreignSurface.update(withMarketRead({ ...metricsVm, metrics: {}, stockInfo: { prevClose: 1090, open: 1092, high: 1110, low: 1088 } }));
assert.deepEqual(['stock-prev-close', 'stock-high', 'stock-open', 'stock-low'].map((role) => text(foreignSlot, role)),
  ['1090.00', '1110.00', '1092.00', '1088.00'], '加權走勢 fills its session facts');
foreignSurface.destroy();
assert.deepEqual(parkedTrendSurfaceKeys().sort(), ['analysisQuinary:stock', 'auxiliary:market'],
  'two slots park separately instead of overwriting one shared fragment');

// Where the controls sit (user 10-16): 個股走勢's in the slot's tab bar, 期貨走勢's in its header between the name and
// the price (instead of the contract code), 加權走勢 none; a surface leaving the slot takes its controls back.
{
  const slot = document.createElement('div');
  slot.setAttribute('data-component-slot', 'analysisSecondary');
  const actions = document.createElement('div');
  realtimeDocument.appendChild(slot);
  const surface = new TrendChartComponent({ dataKey: 'stockTrend', variant: 'stock' });
  surface.mount({ host: slot, context: liveContext(), hydrate: false, slotId: 'analysisSecondary', actionsHost: actions });
  const row = () => actions.querySelector('[data-role="trend-control-row"]') || slot.querySelector('[data-role="trend-control-row"]');
  assert.equal(row().parentNode, actions, '個股走勢: 盤中事件 + 疊圖 in the tab bar');
  assert.equal(row().dataset.placement, 'tabs');
  assert.ok(actions.querySelector('[data-role="event-marker-toggle"]') && actions.querySelector('[data-role="trend-overlay-toolbar"]'));
  surface.reconfigure({ dataKey: 'futuresTrend', variant: 'futures' });
  assert.equal(actions.children.length, 0, 'the tab bar is left empty');
  assert.ok(row().parentNode.classList.contains('product-quote-header'), '期貨走勢: in its header');
  assert.equal(row().dataset.placement, 'header');
  assert.equal(slot.querySelector('.product-quote-code').hidden, true, 'the buttons take the place of the contract code');
  surface.reconfigure({ dataKey: 'marketTrend', variant: 'market' });
  assert.equal(row(), null, '加權走勢 has no controls');
  assert.equal(slot.querySelector('.product-quote-code').hidden, false);
  surface.reconfigure({ dataKey: 'stockTrend', variant: 'stock' });
  assert.equal(row().parentNode, actions);
  surface.destroy();
  assert.equal(actions.querySelector('[data-role="trend-control-row"]'), null, 'destroy takes the controls back into the parked surface');
  const parkedCanvas = [...slot.childNodes].length ? null : 'parked';
  const again = new TrendChartComponent({ dataKey: 'stockTrend', variant: 'stock' });
  const canvasBefore = parkedCanvas;
  again.mount({ host: slot, context: liveContext(), hydrate: true, slotId: 'analysisSecondary', actionsHost: actions });
  assert.equal(canvasBefore, 'parked');
  assert.equal(row().parentNode, actions, 'a restored surface puts its controls in the tab bar again');
  assert.equal(slot.querySelectorAll('[data-role="trend-control-row"]').length, 0);
  again.destroy();
}


// =============================================================================================
// 3. 歷史回放: the SECOND place this component is mounted (layout_config.js replayPrimary).
// =============================================================================================
const historyDocument = parseDocument('../ui/renderer/pages/history.html');
liveDocument = historyDocument.ownerDocument;
const replayHost = historyDocument.querySelector('[data-component-slot="replayPrimary"]');
assert.ok(replayHost, 'history.html must ship the replayPrimary slot');
assert.equal(replayHost.children.length, 0, 'the page ships the slot empty: the component builds the replay surface');

const replaySurface = new TrendChartComponent();
replaySurface.mount({ host: replayHost, context: replayContext(), hydrate: true, slotId: 'replayPrimary' });

// R1. The replay surface, laid out as 個股走勢: header (its code box queries the replayed day), the canvas and the
// loading veil; its controls -- 交易時段事件 / 盤中時段事件 and the 加權／期貨 toolbar -- in the control row (here, a slot
// without a tab bar, its own row above the chart), never on the chart.
for (const roleName of ['trend-canvas', 'trend-loading']) {
  assert.ok(replayHost.querySelector(`[data-role="${roleName}"]`), `the replay surface must have its ${roleName}`);
}
const replayControls = replayHost.querySelector('[data-role="trend-control-row"]');
assert.equal(replayControls?.dataset.trendControls, 'replay', 'the replay surface has its own control row');
for (const roleName of ['history-trade-event-toggle', 'history-all-event-toggle', 'trend-overlay-toolbar']) {
  assert.ok(replayControls.querySelector(`[data-role="${roleName}"]`), `the replay control row holds ${roleName}`);
}
const replayStage = replayHost.querySelector('.trend-chart-stage');
for (const roleName of ['history-trade-event-toggle', 'history-all-event-toggle', 'trend-overlay-toolbar']) {
  assert.equal(replayStage.querySelector(`[data-role="${roleName}"]`), null, `${roleName} is not drawn on top of the chart`);
}
assert.equal(replayHost.querySelector('[data-role="trend-page-row"]'), null, 'the replay coverage row is gone');
assert.ok(replayHost.querySelector('.product-quote-header.product-quote-replay'), 'the replay header is the shared one, replay variant');
assert.equal(replayHost.querySelector('[data-role="trend-canvas"]').id, 'trendCanvas-replayPrimary-auto',
  'the replay canvas is named by its slot like every other non-realtime surface');

// R2. 個股走勢's prediction and stock rows, without the exchange breadth (a replay is one stock's recorded day; the
// breadth store holds today's live counts).
assert.deepEqual(replayHost.querySelectorAll('[data-secondary-row]').map((row) => row.dataset.secondaryRow), ['prediction', 'stock'],
  'the replay surface shows 個股走勢 rows: predictions, then 昨收/最高/漲幅/漲停 + 開盤/最低/振幅/跌停');
assert.deepEqual(PREDICTION_ROLES.map((role) => text(replayHost, role)), Array(8).fill('--'),
  'precondition: the replay rows start empty; their cells are fixed, so the horizons are there showing "--"');
assert.deepEqual(BREADTH_ROLES.map((role) => replayHost.querySelector(`[data-role="${role}"]`)), Array(5).fill(null),
  "no breadth row: today's live counts are not the replayed day's");
replaySurface.update(withMarketRead(metricsVm));
assert.deepEqual(PREDICTION_ROLES.map((role) => text(replayHost, role)),
  ['1199.00', '1.38%', '981.00', '2.02%', '58.0%', '42.0%', '55.0%', '45.0%'],
  '漲停/漲幅/振幅 and the 3分·5分上漲下跌 must reach the replay rows');
assert.deepEqual(['stock-open', 'stock-high', 'stock-low', 'stock-prev-close'].map((role) => text(replayHost, role)),
  ['1092.00', '1110.00', '1088.00', '1090.00'], "the replay rows show the day's 開盤/最高/最低/昨收 as 個股走勢 does");
replaySurface.destroy();

// R3. 歷史回放's 技術分析 wraps a 個股走勢 surface in replay mode: its rows have no exchange breadth either.
const technicalHost = liveDocument.createElement('div');
const technicalSurface = new TrendChartComponent({ dataKey: 'trendChart', variant: 'stock', lineChart: false });
technicalSurface.mount({ host: technicalHost, context: replayContext(), hydrate: false, slotId: 'replayTechnical' });
assert.deepEqual(technicalHost.querySelectorAll('[data-secondary-row]').map((row) => row.dataset.secondaryRow), ['prediction', 'stock'],
  "a 個股走勢 surface in replay mode drops the breadth row (the store's counts are today's live ones)");
technicalSurface.destroy();

// =============================================================================================
// 4. The producer half -- ONE breadth snapshot for all three Shioaji trends -- is the page's own view models:
// renderer_live_trend_view_model_contract.mjs.
// =============================================================================================

// The 日盤 / 夜盤 / 全日 buttons show the tab the user chose, not the session of the data last drawn
// (after a click the old 全日 data re-rendered first and put the buttons back on 全日).
{
  let chosen = 'night';
  const choiceSlot = document.createElement('div');
  choiceSlot.setAttribute('data-component-slot', 'analysisChoice');
  realtimeDocument.appendChild(choiceSlot);
  const surface = new TrendChartComponent({ dataKey: 'futuresTrend', variant: 'futures' });
  surface.mount({ host: choiceSlot, context: { ...liveContext(), services: { futuresSession: { selected: () => chosen } } },
    hydrate: false, slotId: 'analysisChoice' });
  surface.update(withMarketRead({ ...metricsVm, session: 'full' }));
  const control = choiceSlot.querySelector('[data-role="txf-session-control"]');
  assert.equal(control.dataset.activeSession, 'night', 'the chosen tab, while the 全日 data is still on screen');
  chosen = 'day';
  surface.update(withMarketRead({ ...metricsVm, session: 'full' }));
  assert.equal(control.dataset.activeSession, 'day');
}
console.log('trend surface identity: monitor ids, slot scoping, parking, replay canvas id + prediction tape');
