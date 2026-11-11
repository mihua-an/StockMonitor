const { makeTempDir } = require("./support/temp_dirs.cjs");
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
app.setPath('userData', makeTempDir('stockmonitor-ui-test-'));
app.on('window-all-closed', () => {});

async function scenario(base, realtimeHtml) {
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // A pane workspace (pane_workspace.js) of two rows: whole-pixel panes, and a splitter drag moves only its own edge.
  const { PaneWorkspace, layoutFromSlots } = await import(`${base}js/core/pane_workspace.js`);
  document.querySelector('main').innerHTML = realtimeHtml;
  const workspaceElement = document.querySelector('.realtime-workspace');
  workspaceElement.style.width = '1900px'; workspaceElement.style.height = '720px';
  // No components: the geometry is the workspace's alone (every pane shows the add-feature page).
  const registry = { list: () => [], get: () => null, supports: () => false, titleFor: () => '', chooserRows: () => [] };
  const workspace = new PaneWorkspace({
    pageId: 'realtime', element: workspaceElement, context: { mode: 'live' }, registry, storageKey: 'geometryTestPanes',
    rows: 2,
    defaultLayout: () => layoutFromSlots({
      rows: [['productList', 'topAuxiliary', 'liveInfo'], ['analysisPrimary', 'analysisSecondary', 'analysisTertiary', 'analysisQuaternary', 'auxiliary', 'analysisQuinary']],
      tabbedSlots: {}, widths: [['50%', '25%'], ['22%', '18%', '15%', '15%', '15%']], heights: ['36%'],
    }),
  }).mount();
  await settle();
  const rows = [...workspaceElement.querySelectorAll('.pane-row')];
  if (rows.length !== 2) throw new Error(`expected 2 pane rows, got ${rows.length}`);
  const fractional = [...workspaceElement.querySelectorAll('[data-pane-id]')].map((pane) => pane.getBoundingClientRect())
    .filter((r) => [r.left, r.top, r.width, r.height].some((value) => Math.abs(value - Math.round(value)) > 0.01));
  if (fractional.length) throw new Error(`panes on half pixels: ${JSON.stringify(fractional)}`);
  const dragChecks = [];
  let maxDrift = 0;
  for (const row of rows) {
    const rails = [...row.querySelectorAll('.pane-splitter-col')];
    const positions = () => rails.map((rail) => rail.getBoundingClientRect().left);
    for (let index = 0; index < rails.length; index++) {
      for (const delta of [0, 15, -15, 15, -15]) {
        const rail = rails[index]; const start = rail.getBoundingClientRect().left;
        const old = positions(); rail.setPointerCapture = () => {};
        rail.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: start }));
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: start + delta }));
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: start + delta }));
        await settle();
        const next = positions();
        next.forEach((position, other) => {
          const expected = other === index ? old[other] + delta : old[other];
          maxDrift = Math.max(maxDrift, Math.abs(position - expected));
          if (Math.abs(position - expected) > 1.01) throw new Error(`rail ${other} at ${position}, expected ${expected} after dragging ${index} by ${delta}`);
        });
        dragChecks.push({ index, delta });
      }
    }
  }
  const grid = workspaceElement;
  workspace.destroy();

  const { TickDetailsComponent } = await import(`${base}js/core/components/tick_details_component.js`);
  const { createDashboardContext } = await import(`${base}js/core/dashboard_context.js`);
  const host = grid.querySelector('[data-component-slot="analysisTertiary"]');
  const context = createDashboardContext({ id: 'test', mode: 'live' });
  // The page's trade details view, through the data boundary (it carries its read model).
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  const vm = withMarketRead({ logicalCode: '2344', referencePrice: 180, rows: Array.from({ length: 100 }, (_, i) => ({ ingest_sequence: 100 - i, datetime: '2026-10-02T10:04:41+08:00', price: 179, volume: i + 1, trade_side: 'SELL' })) });
  const inspectTick = async hydrate => {
    const tick = new TickDetailsComponent({ manual: true });
    tick.mount({ host, context, hydrate }); tick.update(vm); await settle();
    const scroll = host.querySelector('[data-role="tick-scroll"]');
    const body = scroll.querySelector('.standard-data-grid-body-scroll');
    const header = scroll.querySelector('.standard-data-grid-header-band');
    const rail = scroll.querySelector('[data-role="tick-page-rail"]');
    const tops = () => ({ header: header?.getBoundingClientRect().top, rail: rail?.getBoundingClientRect().top });
    const initial = tops();
    (body || scroll).scrollTop = 150;
    await settle();
    const result = { grid: scroll.classList.contains('standard-data-grid'), header: Boolean(header), body: Boolean(body), wrapScroll: scroll.scrollTop, bodyScroll: body?.scrollTop, initial, scrolled: tops(), rows: host.querySelectorAll('[data-role="tick-body"] tr').length };
    if (!result.grid || !result.header || !result.body || result.bodyScroll <= 0 || result.wrapScroll !== 0 || result.initial.header !== result.scrolled.header || result.initial.rail !== result.scrolled.rail || result.rows !== 100) throw new Error('Trade detail header/body/rail scroll contract failed');
    tick.destroy(); return result;
  };
  const initialTick = await inspectTick(false);
  const resumedTick = await inspectTick(true);
  for (let i = 0; i < 3; i++) await inspectTick(true);
  context.destroy();

  // A column-resize drag belongs to the pointer that started it. A second pointer on another boundary ends
  // the first drag; the first pointer's later moves change nothing, and only the second pointer's own up ends its drag.
  const { applyColumnSchema, defineColumnSchema, destroyColumnTitle } = await import(`${base}js/core/column_title.js`);
  const tableHost = document.createElement('div');
  tableHost.style.width = '600px';
  tableHost.innerHTML = '<table style="width:600px;table-layout:fixed"><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>';
  document.body.appendChild(tableHost);
  const table = tableHost.querySelector('table');
  const columns = defineColumnSchema([
    { id: 'a', title: 'A', width: 200, minWidth: 40, resizable: true },
    { id: 'b', title: 'B', width: 200, minWidth: 40, resizable: true },
    { id: 'c', title: 'C', width: 200, minWidth: 40 },
  ], { schemaId: 'geometryPointerTest' });
  applyColumnSchema(table, columns, { schemaId: 'geometryPointerTest', resize: { storageKey: '' } });
  await settle();
  const boundaries = [...table.querySelectorAll('.canonical-column-boundary.is-resizable')];
  if (boundaries.length !== 2) throw new Error(`expected 2 resizable boundaries, got ${boundaries.length}`);
  const widthsNow = () => [...table.querySelectorAll('col')].map((col) => Math.round(parseFloat(col.style.width) || col.getBoundingClientRect().width));
  const pointer = (type, target, pointerId, clientX) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, clientX }));
  boundaries.forEach((b) => { b.setPointerCapture = () => {}; });
  const x0 = boundaries[0].getBoundingClientRect().left;
  const x1 = boundaries[1].getBoundingClientRect().left;
  pointer('pointerdown', boundaries[0], 1, x0);
  pointer('pointermove', document, 1, x0 + 20);
  await settle();
  const afterFirst = widthsNow();
  pointer('pointerdown', boundaries[1], 2, x1);        // second finger: the first drag ends here
  pointer('pointermove', document, 1, x0 + 60);        // the first pointer keeps moving: ignored
  await settle();
  if (JSON.stringify(widthsNow()) !== JSON.stringify(afterFirst)) throw new Error(`the ended drag still moved columns: ${widthsNow()} vs ${afterFirst}`);
  pointer('pointerup', document, 1, x0 + 60);          // the first pointer's up does not end the second drag
  pointer('pointermove', document, 2, x1 - 30);
  await settle();
  const afterSecond = widthsNow();
  if (afterSecond[0] !== afterFirst[0] || afterSecond[1] >= afterFirst[1]) throw new Error(`the second drag did not move only its boundary: ${afterSecond} vs ${afterFirst}`);
  pointer('pointerup', document, 2, x1 - 30);
  pointer('pointermove', document, 2, x1 - 80);        // after its own up the drag is over
  await settle();
  if (JSON.stringify(widthsNow()) !== JSON.stringify(afterSecond)) throw new Error('a finished drag kept listening');
  destroyColumnTitle(table);
  tableHost.remove();
  return { maxDrift, dragChecks: dragChecks.length, initialTick, resumedTick, pointerResize: { afterFirst, afterSecond } };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1920, height: 1000, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, 'fixtures/renderer_ui_geometry.html'));
    const base = pathToFileURL(path.join(__dirname, '../ui/renderer/')).href;
    const realtimeHtml = fs.readFileSync(path.join(__dirname, '../ui/renderer/pages/realtime.html'), 'utf8');
    if (!process.argv.includes('--resume-only')) {
      const result = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)},${JSON.stringify(realtimeHtml)})`);
      console.log('Splitter and fixed-header geometry:', JSON.stringify(result));
    }
    win.destroy();
    const second = new BrowserWindow({ show: false, width: 1920, height: 1000, webPreferences: { backgroundThrottling: false } });
    second.webContents.on('console-message', event => { if (event.level === 'error') console.error('fixture:', event.message); });
    await second.loadFile(path.join(__dirname, 'fixtures/renderer_ui_geometry.html'));
    const historyHtml = fs.readFileSync(path.join(__dirname, '../ui/renderer/pages/history.html'), 'utf8');
    const moduleUrl = pathToFileURL(path.join(__dirname, 'renderer_ui_resume_browser.js')).href;
    for (const [selected, watchCodes] of [['', ['2344', '2330']], ['2344', ['2344', '2330']], ['', ['2330']]]) {
      await second.loadFile(path.join(__dirname, 'fixtures/renderer_ui_geometry.html'));
      const resumed = await second.webContents.executeJavaScript(`import(${JSON.stringify(moduleUrl)}).then(m => m.checkResume(${JSON.stringify(base)},${JSON.stringify(realtimeHtml)},${JSON.stringify(historyHtml)},${JSON.stringify(selected)},${JSON.stringify(watchCodes)}))`);
      // No saved selection: the page's first product is selected when the product pages load (user 10-13).
      const expected = selected || watchCodes[0];
      if (expected !== '2344') {
        // The fixture only feeds 2344's prices; for another first product check the selection and that no panel is
        // left on the prompt.
        const NO_SELECTION = '請先在商品列表選擇商品';
        for (const state of [resumed.initial, ...resumed.cycles]) {
          assert.equal(state.selected, expected);
          assert.notEqual(state.bookMessage, NO_SELECTION); assert.notEqual(state.flowMessage, NO_SELECTION);
          assert.notEqual(state.stockName, NO_SELECTION);
        }
        console.log(`Resume (default ${expected}, watch ${watchCodes.join(',')}), 3 cache-eviction cycles: the first product stays selected`);
        continue;
      }
      assert.equal(resumed.initial.stockReference, 180);
      assert.match(resumed.initial.stockTitle, /price-down/);
      assert.match(resumed.initial.bookTitle, /price-down/);
      resumed.cycles.forEach((cycle, i) => {
        assert.equal(cycle.selected, expected);
        assert.equal(cycle.stockReference, 180); assert.equal(cycle.bookReference, 180);
        assert.equal(cycle.stockPrevClose, '180.00'); assert.equal(cycle.flowAvailable, true);
        assert.equal(cycle.flowSamples, (i + 2) * 10);
        assert.match(cycle.stockTitle, /price-up/); assert.match(cycle.bookTitle, /price-up/);
        assert.equal(cycle.bookPrices.filter(price => price.text !== '--').length, 2);
        assert.ok(cycle.bookPrices.filter(price => price.text !== '--').every(price => price.color.includes('price-up')));
        assert.deepEqual(cycle.summary.windows, [i + 2, i + 3, i + 4]);
        if (watchCodes.includes('2344')) assert.match(cycle.productRow, new RegExp(`${(i + 2).toFixed(2)}%`));
        assert.deepEqual(cycle.subscribedStocks, ['2330', '2344']); assert.equal(cycle.grid, true);
        assert.ok(cycle.flowText.includes(`+${(i + 2) * 30}`));
      });
      console.log(`Resume (${selected || `default ${expected}`}, watch ${watchCodes.join(',')}), 3 cache-eviction cycles: prices, colors, flow, 1m/3m/5m and fixed trade header passed`);
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
