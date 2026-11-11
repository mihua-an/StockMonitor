import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { WorkspaceStore, WORKSPACE_MAX_SYMBOLS, isFutuWorkspaceCode } from '../ui/renderer/js/features/workspace/workspace_store.js';

class Node {
  dataset = {}; children = []; listeners = {}; classList = { toggle() {}, add() {}, remove() {} };
  set innerHTML(value) { this.html = value; }
  setAttribute() {}
  contains() { return false; }
  querySelector(selector) { return (this.nodes ??= {})[selector] ??= new Node(); }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() { const siblings = this.parent?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
  appendChild(child) { child.remove(); this.children.push(child); child.parent = this; }
  insertBefore(child, anchor) { child.remove(); const at = anchor ? this.children.indexOf(anchor) : this.children.length; this.children.splice(at, 0, child); child.parent = this; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
const nodes = new Map();
let seed, connectionListener, pushSession, rebinds = 0;
const mounted = [];
class Column { constructor(options) { Object.assign(this, options); mounted.push(this); } dispose() {} setSession(session) { this.tradingDate = session.tradingDate; this.futuresPartition = session.futuresPartition; } refreshFreshness() { this.refreshed = true; } refreshTrend() {} }
class Dock { mount() {} demand() { return []; } markAddedChanged() {} sessionChanged() { this.sessions = (this.sessions || 0) + 1; } }
const context = vm.createContext({
  WorkspaceStore, WORKSPACE_MAX_SYMBOLS, isFutuWorkspaceCode,
  MarketDataGateway: class {}, WorkspaceProductDock: Dock, createTechnicalWindowService: () => ({}),
  futuresLivePartitionOf: () => ({ trading_date: '2026-09-19', session: 'DAY' }), shioajiMarketOf: () => 'STK',
  realtimeContext: { dataSource: { setResolver() {}, subscribe() {} } }, startMonitorEventTape() {}, getLiveMonitorEvents: () => [],
  liveEventMarkers: () => [], stockTrendEventMarkersVisible: () => true, subscribeStockTrendEventMarkers() {},
  createWorkspaceBenchmarkSource: () => ({ rebind() { rebinds += 1; } }), subscribeRealtimeView() {}, getRealtimeViewSnapshot() {},
  createDashboardContext: () => ({ dataSource: { invalidate() {} } }), WorkspaceColumn: Column, FutuWorkspaceColumn: Column,
  WorkspaceTradesComponent: class { mount() {} destroy() {} }, formatChartPrice: value => String(value),
  ComponentHost: class { mount() {} destroy() {} }, componentRegistry: {}, formatMoomooDisplaySymbol: x => x,
  document: { createElement: () => new Node(), getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, querySelectorAll: () => [] },
  window: { desktopAPI: { onWorkspaceSeed(callback) { seed = callback; } }, addEventListener() {}, prompt: () => '6505' },
  // The trading date is Market Runtime's session pushed over the WS, not FastAPI's display-session.
  apiGet: async () => { throw new Error('the workspace must not read the session over REST'); }, apiJsonPut: async () => ({}),
  subscribeRealtimeSession(callback) { pushSession = callback; return () => {}; },
  subscribeRealtimeAnalysisState: () => () => {},
  startRealtimeStream() {}, notifyBackendReadyForRealtime() {}, installSecondaryWindowRealtime() { return () => {}; },
  subscribeRealtimeConnectionState(callback) { connectionListener = callback; },
  setTimeout: () => 1, clearTimeout() {}, console, setInterval: () => 1,
  requestInstrumentNames() {}, onInstrumentNamesLearned: () => () => {},
});
const source = fs.readFileSync(new URL('../ui/renderer/workspace_view.js', import.meta.url), 'utf8').replace(/^import\s+[\s\S]*?;\s*$/gm, '');
// The workspace set is held by the transport (realtime.js keeps the desired set and sends it again on every
// (re)connect), so this window neither retries on a timer nor re-pushes on reconnect. It used to
// pin a 2 s retry timer and a connection-state re-push here.
assert.doesNotMatch(source, /scheduleWorkspaceSubscriptionRetry|workspaceRetryTimer/,
  'no timer retry: the transport owns the desired workspace');
assert.doesNotMatch(source, /winerror|10061/i,
  'delivery failure must not be detected by matching a platform error string again');
const transport = fs.readFileSync(new URL('../ui/renderer/js/market_data/realtime.js', import.meta.url), 'utf8');
assert.match(transport, /desiredWorkspace = \[/, 'replaceRealtimeWorkspace records the desired set');
assert.match(transport, /realtimeViewStore\.onConnected\(activeConnectionId\);[\s\S]{0,200}sendDesiredWorkspace\(\);/,
  'every (re)connect sends the desired workspace again');
// Comments stripped: these two pin what the module DOES, and both removals are explained in
// prose right where they happened, which a raw source match would keep tripping over.
const code = source.replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(code, /batch\s*[.?]/,
  'the transport batch is gone; reading it again would be a listener that never fires');
vm.runInContext(source, context);
assert.equal(typeof seed, 'function', 'R02: listener must exist while session API is pending');
seed('2330');
pushSession({ equity: { trading_date: '2026-09-19' } });
for (let i = 0; i < 5; i++) await Promise.resolve();
assert.equal(vm.runInContext('store.list()[0]', context), '2330');
vm.runInContext('store.add("2317"); store.add("2454"); store.remove("2330"); store.replace(0, "6505")', context);
assert.equal(vm.runInContext('JSON.stringify(store.list())', context), '["6505","2454"]', 'A05: replace keeps the column\'s place');
assert.doesNotMatch(source, /window\.prompt/, 'Electron has no prompt: a column is replaced by dropping a product on it');
assert.deepEqual(nodes.get('workspaceColumns').children.map(n => n.dataset.workspaceColumn), ['6505', '2454']);
vm.runInContext('store.reorder(0, 1)', context);
assert.deepEqual(nodes.get('workspaceColumns').children.map(n => n.dataset.workspaceColumn), ['2454', '6505']);
for (const bad of ['<B>INJECTED</B>', '2330" onclick="x', "2330'", '2330&x', '2330 x']) {
  const store = new WorkspaceStore({ initial: [bad] });
  assert.deepEqual(store.list(), [], 'A08: constructor validation');
  assert.equal(store.add(bad).ok, false);
  store.add('2330'); assert.equal(store.replace(0, bad).ok, false);
}
assert.ok(!nodes.get('workspaceColumns').children[0].html.includes('2454'), 'symbol must not enter HTML markup');
const html = fs.readFileSync(new URL('../ui/renderer/workspace_view.html', import.meta.url), 'utf8');
assert.match(html, /Content-Security-Policy/);
assert.match(html, /script-src 'self'/);
// No rollover dispatch is asserted here: `batch.sessionRollover` would need a rollover frame,
// and none reaches a renderer: the Shioaji daemon publishes
// `market.session.rollover` nowhere (the daemon stream has no analytics fanout),
// and this socket has no branch for it. Feeding the frame from the test
// would prove nothing about production.
assert.doesNotMatch(code, /sessionRollover/,
  'the rollover branch must not be reintroduced without a producer that actually emits it');

assert.equal(typeof connectionListener, 'function',
  'the workspace must subscribe to connection state, which is what replaces the batch');
connectionListener({ connected: false });
assert.equal(vm.runInContext('[...entries.values()].every(e => e.column.refreshed)', context), true,
  'a disconnect must refresh the freshness indicator on every column');
// A rollover to a new trading day moves every stock column AND the TAIEX/TXF benchmarks. The session
// is pushed by Market Runtime (on each connection and with each rollover): nothing is read.
assert.doesNotMatch(source, /requestRealtimeSessionCurrent/, 'the workspace never reads the session itself');
pushSession({ equity: { trading_date: '2026-09-22' } });
assert.equal(vm.runInContext('[...entries.values()].every(e => e.column.tradingDate === "2026-09-22")', context), true,
  'every column moves to the new trading day');
assert.equal(rebinds, 1, 'the benchmarks are subscribed again on the new day');
pushSession({ equity: { trading_date: '2026-09-22' } });
assert.equal(rebinds, 1, 'a session that keeps the same trading day rebinds nothing');
console.log('workspace audit UI contract passed (A05, A08, delayed seed R02; R03 retired -- no rollover producer)');
