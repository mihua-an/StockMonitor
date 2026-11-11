import assert from 'node:assert/strict';

// Futu 個股走勢 session tab -- BEHAVIOURAL.
//
// Defect: MoomooTrendComponent.renderData() forced the tab back to 全日 on EVERY data frame in which
// the chosen session (盤前／盤中／盤後／夜盤) had no priced row -- 盤後 before 16:00 ET, 夜盤 before
// 20:00 ET, or any momentarily partial frame -- so a tab the user clicked "randomly" jumped to 全日.
// The empty-session fallback belongs only to the opening tab of a newly shown product.
// Since 10-16 the tabs are 日盤 (盤前 + 盤中 + 盤後) / 夜盤 / 全日; each is a trading window over New York date
// partitions (futu_us_trend_window.js), so the rows carry their partition date and minute.

globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (fn) => setTimeout(fn, 0) };
globalThis.document = globalThis.document || {
  querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
  addEventListener() {}, removeEventListener() {},
};

const { MoomooTrendComponent } = await import('../ui/renderer/js/features/realtime/components/moomoo_components.js');

// Monday 2026-10-19, 12:00 New York unless a case moves the clock. The windows are Rust A's (session.current `us`,
// native/market_runtime/src/us_session.rs, where the weekday and holiday rules are tested).
const MONDAY = '2026-10-19';
const SUNDAY = '2026-10-18';
const TUESDAY = '2026-10-20';
const part = (trading_date, from, to) => ({ trading_date, from, to });
const MONDAY_NOON = { trading_date: MONDAY, phase: 'regular', market_day: 'whole', windows: {
  day: [part(MONDAY, 240, 1200)],
  overnight: [part(SUNDAY, 1200, 1440), part(MONDAY, 0, 240)],
  full: [part(SUNDAY, 1200, 1440), part(MONDAY, 0, 1200)] } };
const MONDAY_EVENING = { trading_date: TUESDAY, phase: 'overnight', market_day: 'whole', windows: {
  day: [part(MONDAY, 240, 1200)],
  overnight: [part(MONDAY, 1200, 1440), part(TUESDAY, 0, 240)],
  full: [part(MONDAY, 1200, 1440), part(TUESDAY, 0, 1200)] } };
const row = (date, hhmm, price) => {
  const [h, m] = hhmm.split(':').map(Number);
  return { trading_date: date, minute: h * 60 + m, time: `${date}T${hhmm}:00`, price, volume: 1 };
};
const times = (rows) => rows.map((r) => r.time);

function harness(us = MONDAY_NOON) {
  const component = new MoomooTrendComponent();
  component.usSession = () => us;
  const drawn = [];
  let onSelect = null;
  component.renderSessionControl = () => {};
  component.updateSummary = () => {};
  component.draw = (rows) => drawn.push({ session: component.activeSession, rows });
  component.select = (key) => {
    // The control's onSelect, as wired in renderSessionControl.
    if (!key || key === component.activeSession) return;
    component.activeSession = key;
    component.sessionBootstrapPending = false;
    localStorage.setItem('moomooTrendSessionV1', key);
  };
  return { component, drawn, select: (key) => component.select(key), get onSelect() { return onSelect; } };
}

// Regular-session minutes only: 夜盤 has no priced row yet.
const regularOnly = [row(MONDAY, '09:30', 100), row(MONDAY, '09:31', 101)];

// 1. Opening tab with no prints falls back to 全日 once (bootstrap).
{
  const { component, drawn } = harness();
  component.renderData({ items: regularOnly }, 'US.AAPL');
  // currentUsSession() decides the opening tab; whatever it is, the result is a session with prints or 全日.
  assert.ok(['day', 'full'].includes(component.activeSession), `bootstrap tab ${component.activeSession}`);
  assert.equal(component.sessionBootstrapPending, false);
  assert.ok(drawn.at(-1).rows.length > 0);
}

// 2. A tab the user chose stays chosen across frames in which it has no priced row.
for (const chosen of ['overnight', 'day']) {
  const { component, drawn, select } = harness();
  component.renderData({ items: regularOnly }, 'US.AAPL');
  select(chosen);
  for (let frame = 0; frame < 5; frame += 1) component.renderData({ items: regularOnly }, 'US.AAPL');
  assert.equal(component.activeSession, chosen, `${chosen} must not jump back to 全日`);
  assert.equal(localStorage.getItem('moomooTrendSessionV1'), chosen);
  assert.equal(drawn.at(-1).session, chosen);
}

// 2b. 開盤 and 昨收 go by the phase: a phase that moves with no print arriving (16:00) redraws, the same phase does not.
{
  const { component, drawn } = harness();
  component.renderData({ items: regularOnly }, 'US.AAPL');
  component.host = {};
  component.viewCode = 'US.AAPL';
  let us = MONDAY_NOON;
  component.usSession = () => us;
  component.partitionViewSpecs('US.AAPL');
  component.filteredRows();
  component.followUsSession();
  const settled = drawn.length;
  component.followUsSession();
  assert.equal(drawn.length, settled, 'the same phase draws nothing');
  us = { ...MONDAY_NOON, phase: 'after' };
  component.followUsSession();
  assert.equal(drawn.length, settled + 1, '16:00 redraws');
}

// 3. 夜盤 chosen, then a momentarily empty / partial frame, then data again: still 夜盤.
{
  const { component, select } = harness();
  component.renderData({ items: regularOnly }, 'US.AAPL');
  select('overnight');
  component.renderData({ items: [row(MONDAY, '16:05', 102)] }, 'US.AAPL');
  component.renderData({ items: [] }, 'US.AAPL');
  component.renderData({ items: regularOnly }, 'US.AAPL');
  assert.equal(component.activeSession, 'overnight');
}

// 3b. 日盤 holds 盤前 + 盤中 + 盤後; 夜盤 only the night. A tab saved before 10-16 (盤前) opens as 日盤.
{
  const { component, select } = harness(MONDAY_EVENING);
  const day = [row(MONDAY, '05:00', 99), ...regularOnly, row(MONDAY, '17:00', 102), row(MONDAY, '21:00', 103)];
  component.renderData({ items: day }, 'US.AAPL');
  select('day');
  assert.deepEqual(times(component.filteredRows()), ['05:00', '09:30', '09:31', '17:00'].map((t) => `${MONDAY}T${t}:00`));
  select('overnight');
  assert.deepEqual(times(component.filteredRows()), [`${MONDAY}T21:00:00`]);
  localStorage.setItem('moomooTrendSessionV1', 'pre');
  assert.equal(new MoomooTrendComponent().activeSession, 'day');
}

// 3c. 夜盤 and 全日 never mix two sessions: Monday's partition holds the tail of Sunday's night (00:00-04:00) and
// the head of Monday's (from 20:00); Monday 21:40 drew both as one night.
{
  const items = [row(SUNDAY, '20:30', 95), row(MONDAY, '00:30', 94), row(MONDAY, '03:59', 93), row(MONDAY, '10:00', 92),
    row(MONDAY, '20:00', 91), row(MONDAY, '21:30', 90)];
  const evening = harness(MONDAY_EVENING);
  evening.component.renderData({ items }, 'US.NOK');
  evening.select('overnight');
  assert.deepEqual(times(evening.component.filteredRows()), [`${MONDAY}T20:00:00`, `${MONDAY}T21:30:00`]);
  evening.select('full');
  assert.deepEqual(times(evening.component.filteredRows()), [`${MONDAY}T20:00:00`, `${MONDAY}T21:30:00`], '全日 is Tuesday from 20:00');
  evening.select('day');
  assert.deepEqual(times(evening.component.filteredRows()), [`${MONDAY}T10:00:00`]);
  // Monday noon: 夜盤 is Sunday's night through 04:00, 全日 Monday's trading date from Sunday 20:00.
  const noon = harness(MONDAY_NOON);
  noon.component.renderData({ items }, 'US.NOK');
  noon.select('overnight');
  assert.deepEqual(times(noon.component.filteredRows()), [`${SUNDAY}T20:30:00`, `${MONDAY}T00:30:00`, `${MONDAY}T03:59:00`]);
  noon.select('full');
  assert.deepEqual(times(noon.component.filteredRows()), [`${SUNDAY}T20:30:00`, `${MONDAY}T00:30:00`, `${MONDAY}T03:59:00`, `${MONDAY}T10:00:00`]);
}

// 4. Switching product re-arms the bootstrap; the new product's first priced frame may fall back once.
{
  const { component, select } = harness();
  component.renderData({ items: regularOnly }, 'US.AAPL');
  select('overnight');
  component.renderData({ items: [] }, 'US.MSFT');
  assert.equal(component.sessionBootstrapPending, true, 'empty frame keeps bootstrap pending');
  component.renderData({ items: regularOnly }, 'US.MSFT');
  assert.equal(component.sessionBootstrapPending, false);
  assert.ok(['day', 'full'].includes(component.activeSession));
}

console.log('renderer_futu_trend_session_tab_contract: ok');
