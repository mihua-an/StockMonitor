import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trendSurfaceSource } from "./lib/trend_surface_sources.mjs";

// The renderer half of model predictions. Runs the REAL functions:
//   core/model_predictions modelPredictionMetrics()  -- signals.model_predictions -> metrics + notes
//   trend_chart_component  syncPredictionCells()     -- the footer's four fixed prediction cells
//
// Invoked with a path argument, it reads a `signals` object captured from a REAL Market Runtime
// view.snapshot (native/analysis_runtime/tests/b_end_to_end.rs does this) and prints what the footer
// would show. This is renderer LOGIC evidence -- not an Electron screen or UI-latency acceptance.

const chart = trendSurfaceSource();

const { modelPredictionMetrics: metricsFn } = await import('../ui/renderer/js/core/model_predictions.js');
// The footer's four prediction cells (fixed positions; the two horizons come from settings).
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
const { syncPredictionCells } = await import('../ui/renderer/js/core/components/trend_header_presenter.js');
const { setTrendFooterHorizons } = await import('../ui/renderer/js/core/trend_footer_horizons.js');

function fakeCell(slot, direction) {
  const label = { textContent: '' };
  const name = { title: '' };
  const value = { textContent: '--', title: '', dataset: {} };
  return { dataset: { slot: String(slot), direction }, label, name, value,
    querySelector: (selector) => (selector.includes('prediction-label') ? label : selector.includes('prediction-name') ? name : value) };
}

function renderFooter(signals) {
  const { metrics, notes } = metricsFn(signals);
  const list = [fakeCell(0, 'up'), fakeCell(1, 'up'), fakeCell(0, 'down'), fakeCell(1, 'down')];
  const percent = (v) => (v == null ? '--' : `${(Number(v) * 100).toFixed(1)}%`);
  syncPredictionCells({ querySelectorAll: () => list }, { ...metrics, predictionNotes: notes }, percent);
  const cells = {};
  for (const cell of list) {
    cells[cell.value.dataset.role] = { label: cell.label.textContent, name: cell.name.title, title: cell.value.title,
      status: cell.value.dataset.predictionStatus, testOnly: cell.value.dataset.predictionTestOnly, text: cell.value.textContent };
  }
  return { order: Object.keys(cells), cells };
}

const capturedPath = process.argv[2];
if (capturedPath) {
  process.stdout.write(JSON.stringify(renderFooter(JSON.parse(readFileSync(capturedPath, 'utf8')))));
} else {
  const shown = renderFooter({
    chg_1m: 0.3,
    model_predictions: {
      '10m_up': { probability: 0.2, status: 'OK', test_only: false, model_id: 'm10', model_version: '1' },
      '3m_up': { probability: 0.6123, status: 'OK', test_only: true, model_id: 'builtin-test-only', model_version: 'test-2', asof: '09:31:00' },
      '3m_down': { probability: null, status: 'UNAVAILABLE', reason: 'WORKER_EXITED: code 3', test_only: true },
      '5m_up': { probability: 0.4, status: 'OK', test_only: false, model_id: 'm', model_version: '7' },
      '5m_down': { probability: 0.9, status: 'FAILED', reason: 'boom' },
      '15m_up': { probability: null, status: 'DISABLED', reason: 'horizon not enabled by the current config' },
    },
  });
  const { cells, order } = shown;
  assert.deepEqual(order, ['metric-up-3m', 'metric-up-5m', 'metric-down-3m', 'metric-down-5m'],
    'four fixed cells: A/B 上漲 on the first row, A/B 下跌 on the second (default horizons 3 and 5)');
  assert.equal(cells['metric-up-3m'].label, '3', 'the label is the minutes; a trend glyph follows it');
  assert.equal(cells['metric-up-3m'].name, '', 'the label has no hover text');
  assert.equal(cells['metric-down-3m'].name, '');
  assert.equal(cells['metric-up-3m'].text, '61.2% 測試', 'a TEST_ONLY number is labelled on screen');
  // No hover text: the model, its status and its time are not hidden in a title (user 10-20).
  assert.ok(Object.values(cells).every((c) => !c.title), 'no hover text on any cell');
  assert.equal(cells['metric-up-3m'].testOnly, '1');
  assert.equal(cells['metric-down-3m'].text, '--', 'a cleared entry shows no number');
  assert.equal(cells['metric-up-5m'].text, '40.0%', 'a formal-model number carries no TEST label');
  assert.equal(cells['metric-down-5m'].text, '--', 'FAILED never shows its stale probability');

  // The settings choice moves the cells to other horizons without any other change.
  setTrendFooterHorizons([10, 15]);
  const moved = renderFooter({ model_predictions: {
    '10m_up': { probability: 0.2, status: 'OK', test_only: false, model_id: 'm10', model_version: '1' },
    '15m_up': { probability: null, status: 'DISABLED', reason: 'horizon not enabled by the current config' } } });
  assert.deepEqual(moved.order, ['metric-up-10m', 'metric-up-15m', 'metric-down-10m', 'metric-down-15m']);
  assert.equal(moved.cells['metric-up-10m'].label, '10');
  assert.equal(moved.cells['metric-up-10m'].name, '');
  assert.equal(moved.cells['metric-up-10m'].text, '20.0%');
  assert.equal(moved.cells['metric-up-15m'].text, '--', 'a DISABLED horizon keeps its cell and shows "--"');
  assert.equal(moved.cells['metric-down-10m'].text, '--', 'an absent prediction shows --');
  setTrendFooterHorizons([3, 5]);

  const hostile = renderFooter({ model_predictions: { '3m_up': { status: 'FAILED', reason: '<img src=x onerror=1>' } } });
  assert.equal(hostile.cells['metric-up-3m'].text, '--', 'a reason is text on hover, never markup in the cell');
  console.log('renderer_model_prediction_contract: ok');
}
