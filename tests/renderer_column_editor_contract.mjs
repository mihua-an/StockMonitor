import assert from 'node:assert/strict';

// The shared column settings panel (core/components/column_settings_editor.js): one per window, held by every page and
// component that shows a ⚙. Minimal event surfaces, not an HTML parser; real markup, bubbling and drag geometry are
// covered by the Chromium fixtures (renderer_shioaji_product_list_tools_ui.cjs, renderer_tick_details_columns_ui.cjs).
class Surface extends EventTarget {
  dataset = {}; hidden = true; innerHTML = ''; parent = null; textContent = '';
  queries = new Map(); selectors = new Set();
  querySelector(selector) { return this.queries.get(selector) || null; }
  querySelectorAll() { return []; }
  closest(selector) { return this.selectors.has(selector) ? this : this.parent?.closest(selector); }
  contains(node) { return node === this || node?.parent === this; }
}
const ids = new Map(), saved = new Map();
const overlay = new Surface(), host = new Surface(), title = new Surface();
ids.set('quoteColumnSettingsOverlay', overlay);
for (const selector of ['[data-column-settings-close]', '#quoteColumnCancelBtn', '#quoteColumnDoneBtn']) overlay.queries.set(selector, new Surface());
overlay.queries.set('#quoteColumnSettingsList', host);
overlay.queries.set('.product-list-column-settings-head b', title);
globalThis.document = new Surface();
document.getElementById = id => ids.get(id) || null;
globalThis.window = new Surface();
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail; } };

const { retainColumnSettingsEditor, openColumnSettings, columnSettingsEditorDiagnostics } = await import('../ui/renderer/js/core/components/column_settings_editor.js');
const { getRealtimeQuoteColumnSettings, PRODUCT_COLUMN_PROFILE } = await import('../ui/renderer/js/features/market/quote_presentation.js');
const ticks = await import('../ui/renderer/js/core/tick_details_columns.js');

const emit = (surface, type, target = surface, fields = {}) => {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  Object.assign(event, fields);
  surface.dispatchEvent(event);
};
const open = (profile = PRODUCT_COLUMN_PROFILE) => openColumnSettings(profile);
const cancel = () => emit(overlay.querySelector('#quoteColumnCancelBtn'), 'click');
const done = () => emit(overlay.querySelector('#quoteColumnDoneBtn'), 'click');
// Drags `fromKey`'s grip onto `toKey`'s row, dropped on its upper or lower half.
const dragTo = (fromKey, toKey, after) => {
  const row = new Surface(); row.parent = host; row.selectors.add('.product-list-column-setting-row');
  row.dataset.columnKey = toKey; row.classList = { add() {}, remove() {} }; row.getBoundingClientRect = () => ({ top: 0, height: 10 });
  const grip = new Surface(); grip.parent = host; grip.selectors.add('[data-column-drag]'); grip.dataset.columnDrag = fromKey;
  emit(host, 'dragstart', grip); emit(host, 'dragover', row); emit(host, 'drop', row, { clientY: after ? 9 : 1 });
};
const toggleOf = (key, checked) => { const t = new Surface(); t.parent = host; t.selectors.add('[data-column-toggle]'); t.dataset.columnToggle = key; t.checked = checked; return t; };
let notifications = 0;
window.addEventListener('realtime-product-columns-changed', () => notifications++);

// Importing binds nothing and saves nothing.
assert.equal(columnSettingsEditorDiagnostics().disposables, 0, 'import must not bind DOM');
assert.equal(saved.size, 0, 'import must not persist preferences');

// The page and a 成交明細 on it both hold the panel: it is bound once.
const releasePage = retainColumnSettingsEditor();
const bound = columnSettingsEditorDiagnostics().disposables;
const releaseTicks = retainColumnSettingsEditor();
assert.equal(columnSettingsEditorDiagnostics().disposables, bound, 'a second holder must not bind again');
open(); assert.equal(overlay.hidden, false, 'one open event opens the panel once');
assert.equal(title.textContent, '商品列表欄位');

const original = getRealtimeQuoteColumnSettings();
for (let i = 0; i < 100; i++) i % 2 ? dragTo(original.order[0], original.order[1], false) : dragTo(original.order[0], original.order.at(-1), true);
dragTo(original.order[0], original.order.at(-1), true);
assert.equal(columnSettingsEditorDiagnostics().disposables, bound, 'reordering must not retain discarded rows');
assert.equal(saved.size, 0, 'draft must not persist until Done');
done();
let current = getRealtimeQuoteColumnSettings();
assert.equal(current.order.at(-1), original.order[0]);
assert.deepEqual(current.visible, original.visible);
assert.equal(notifications, 1, 'Done saves once (not once per holder)');

const key = original.order.find((k) => k !== 'name' && k !== 'code');
const toggle = toggleOf(key, !current.visible[key]);
open(); emit(host, 'change', toggle); cancel();
assert.deepEqual(getRealtimeQuoteColumnSettings(), current, 'cancel must discard checkbox changes');
open(); emit(host, 'change', toggle); emit(document, 'keydown', document, { key: 'Escape' });
assert.deepEqual(getRealtimeQuoteColumnSettings(), current, 'Escape must discard checkbox changes');
open(); toggle.parent = null; emit(host, 'change', toggle); done();
assert.deepEqual(getRealtimeQuoteColumnSettings(), current, 'detached row must not modify a newer draft');
open(); toggle.parent = host; emit(host, 'change', toggle); done();
current = getRealtimeQuoteColumnSettings();
assert.equal(current.visible[key], toggle.checked, 'current checkbox must save');
assert.equal(notifications, 3);

// 成交明細: its own list per source, titled as such; at least one column stays ticked.
const tickChanges = [];
window.addEventListener(ticks.TICK_DETAILS_COLUMNS_CHANGED, (event) => tickChanges.push(event.detail.scope));
open(ticks.tickDetailsColumnProfile('shioaji'));
assert.equal(title.textContent, '成交明細欄位');
const rowOf = (k) => host.innerHTML.split('<label class="product-list-column-setting-row').find((row) => row.includes(`data-column-key="${k}"`)) || '';
assert.deepEqual(ticks.tickDetailsColumnSettings('shioaji').order, ['time', 'trade', 'change', 'change_pct', 'volume', 'total_volume']);
for (const k of ['time', 'change', 'change_pct', 'volume', 'total_volume']) emit(host, 'change', toggleOf(k, false));
assert.match(rowOf('trade'), /data-column-locked="1"[\s\S]*data-column-toggle="trade" checked\s+disabled/, 'the last ticked column cannot be unticked');
emit(host, 'change', toggleOf('total_volume', true));
assert.doesNotMatch(rowOf('trade'), /disabled/, 'a second ticked column unlocks it');
dragTo('total_volume', 'time', false);
done();
assert.deepEqual(tickChanges, ['shioaji']);
assert.deepEqual(ticks.tickDetailsVisibleColumns('shioaji').map((c) => c.id), ['total_volume', 'trade'], 'order and visibility as saved');
assert.ok(saved.has('tickDetailsColumns:shioaji'));
assert.deepEqual(ticks.tickDetailsVisibleColumns('futu').map((c) => c.id), ['time', 'trade', 'change', 'change_pct', 'volume'], 'each source keeps its own list; Futu never shows 總量');

// Futu: 總量 is listed greyed out and cannot be ticked; a draft that ticks it still saves it hidden.
open(ticks.tickDetailsColumnProfile('futu'));
assert.match(rowOf('total_volume'), /^ disabled"/, 'the row is greyed out');
assert.match(rowOf('total_volume'), /data-column-toggle="total_volume" \s+disabled/, 'unticked and disabled');
assert.match(rowOf('total_volume'), />無資料</, 'marked 無資料');
assert.doesNotMatch(host.innerHTML, /title=/, 'no hint text beyond 無資料');
emit(host, 'change', toggleOf('total_volume', true));
done();
assert.equal(ticks.tickDetailsColumnSettings('futu').visible.total_volume, false);
// A stored record that shows nothing (written by hand) still shows 成交.
saved.set('tickDetailsColumns:futu', JSON.stringify({ schema_version: 2, order: ['time', 'trade'], visible: {} }));
assert.deepEqual(ticks.tickDetailsVisibleColumns('futu').map((c) => c.id), ['trade']);

// One holder released: still bound for the other. The last release unbinds and closes it.
open(); releaseTicks(); releaseTicks();
assert.equal(overlay.hidden, false); assert.equal(columnSettingsEditorDiagnostics().disposables, bound);
releasePage();
assert.equal(columnSettingsEditorDiagnostics().disposables, 0);
assert.equal(overlay.hidden, true);
open(); done();
assert.equal(overlay.hidden, true, 'an unheld panel does not open');
assert.equal(notifications, 3);
for (let cycle = 0; cycle < 10; cycle++) {
  const release = retainColumnSettingsEditor(); open(); assert.equal(overlay.hidden, false);
  assert.equal(columnSettingsEditorDiagnostics().disposables, bound);
  done(); release();
  assert.equal(columnSettingsEditorDiagnostics().disposables, 0);
}
assert.equal(notifications, 13); assert.deepEqual(getRealtimeQuoteColumnSettings(), current);
console.log('column editor: shared holders, single save, cancel, detached events, 成交明細 at-least-one and Futu 總量 passed');
