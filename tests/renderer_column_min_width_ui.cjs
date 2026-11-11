const { makeTempDir } = require("./support/temp_dirs.cjs");
// The product lists' minimum column widths are what the values shown need (使用者 10-20: a minimum sized for the
// widest value a column could ever hold gave short numbers far more room than they needed). Drawn through the real
// product list (renderExternalRealtimeQuoteTable, the DataGrid shell) in a real Chromium with the app's CSS (run
// with Electron, like renderer_ui_geometry.cjs), in a pane narrower than the columns so each sits at its minimum:
// no value or title is cut, no column is wider than its widest value needs, a longer value widens its column at
// once, a shorter one narrows it only when the rows change -- never while prices tick. 股名 is as wide as the names
// need up to five characters, then "…", and stays so in a wide pane (使用者 10-20).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-column-min-width-"));
app.on("window-all-closed", () => {});

async function setup(base) {
  const { productListShellMarkup, enableSharedProductListScroll } = await import(`${base}js/features/realtime/product_list.js`);
  const { renderExternalRealtimeQuoteTable } = await import(`${base}js/features/realtime/components/realtime_quote_table.js`);
  // Rows as the product list hands them over: through the data boundary, carrying their read model.
  const { withProductRead } = await import(`${base}js/core/market_read_adapters.js`);
  localStorage.clear();
  const host = document.getElementById("pageContainer");
  host.style.cssText = "position:absolute;left:0;top:0;width:420px;height:400px;display:flex;flex-direction:column";
  host.innerHTML = productListShellMarkup({ provider: "shioaji" });
  // 2330 at its limit-up (the heaviest style, white on red, bold), 00631L with a long name and a loss.
  const rows = (price) => [
    { code: "2330", name: "台積電", prev_close: 1000, open: 1005, current: price, limit_up: 1100, limit_down: 900 },
    { code: "00631L", name: "元大台灣50正2", prev_close: 250.5, open: 249, current: 248.35, limit_up: 275.55, limit_down: 225.45 },
  ].map((row) => withProductRead(row, "shioaji"));
  // Ledger rows as the account API serves them: 損益 is net of closing costs, so it needs cost_amount and the
  // ledger's closing_terms (台股 at 2.8 折, an ordinary sell; see renderer_account_live_marks_contract.mjs).
  const terms = { amount_rounding: "floor", fee_rate: "0.000399", min_fee: "1", fee_rounding: "ceil", sell_tax_rate: "0.003", tax_rounding: "floor" };
  const holdings = (qty) => [{ code: "2330", qty, avg_cost: 980, cost_amount: 980 * qty, closing_terms: terms },
    { code: "00631L", qty: 2000, avg_cost: 260.1, cost_amount: 520200, closing_terms: terms }];
  window.__list = {
    // `changed`: the codes a Tick changed (the list then writes and measures only those rows).
    draw(price, qty, topologyChanged = false, changed = null) {
      renderExternalRealtimeQuoteTable({ rows: rows(price), market: "tw", root: host, holdings: holdings(qty), topologyChanged,
        changedCodes: changed ? new Set(changed) : null });
    },
  };
  window.__list.draw(1100, 1000, true);
  enableSharedProductListScroll(host);
  window.__list.draw(1100, 1000, true);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
}

// Each column: its width now, and what its widest cell's text (or its title) needs, measured from the DOM.
function measure() {
  const header = document.querySelector('[data-role="product-list-table"]');
  const body = document.querySelector('[data-role="product-list-body"]');
  const ths = [...header.querySelectorAll("thead th")];
  const textOf = (node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().width; };
  const box = (node) => { const cs = getComputedStyle(node); return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth); };
  return ths.map((th, index) => {
    const label = th.querySelector(".canonical-title-label");
    const mark = th.querySelector(".canonical-sort-mark");
    const markCs = mark ? getComputedStyle(mark) : null;
    let needed = textOf(label) + box(th) + (mark ? Math.max(parseFloat(markCs.minWidth) || 0, 7) + parseFloat(markCs.marginLeft) : 0);
    const cells = [...body.rows].map((tr) => tr.cells[index]).filter(Boolean);
    const cut = [];
    // A text's width in a cell's font, from a measuring element of its own outside the table.
    const textIn = (td, text) => {
      const cs = getComputedStyle(td);
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      for (const name of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariantNumeric", "fontFeatureSettings", "letterSpacing"]) probe.style[name] = cs[name];
      probe.textContent = text;
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };
    const ellipsis = [];
    for (const td of cells) {
      const chars = Array.from(td.textContent);
      if (th.dataset.columnId === "name") {
        // 股名 has room for five characters and the ellipsis the cell draws after them: a longer name is cut by the
        // cell itself (text-overflow: ellipsis on one line), never overflowing into the next column.
        const cs = getComputedStyle(td);
        const truncates = cs.textOverflow === "ellipsis" && cs.overflowX === "hidden" && cs.whiteSpace === "nowrap";
        const shown = chars.length > 5 ? `${chars.slice(0, 5).join("")}…` : td.textContent;
        needed = Math.max(needed, textIn(td, shown) + box(td));
        const content = td.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        if (chars.length > 5) {
          if (!truncates) ellipsis.push(`${td.textContent}: not cut by the cell (${cs.textOverflow}/${cs.overflowX}/${cs.whiteSpace})`);
          if (!(td.scrollWidth > td.clientWidth)) ellipsis.push(`${td.textContent}: shown whole (${td.scrollWidth}/${td.clientWidth})`);
          if (content + 0.5 < textIn(td, `${chars.slice(0, 5).join("")}…`)) ellipsis.push(`${td.textContent}: less room than five characters and …`);
          if (content >= textIn(td, `${chars.slice(0, 6).join("")}…`)) ellipsis.push(`${td.textContent}: room for six characters`);
        } else if (td.scrollWidth > td.clientWidth) cut.push(td.textContent);
        continue;
      }
      needed = Math.max(needed, textOf(td) + box(td));
      if (td.scrollWidth > td.clientWidth) cut.push(td.textContent);
    }
    const thCs = getComputedStyle(th);
    const room = th.getBoundingClientRect().right - parseFloat(thCs.paddingRight) - parseFloat(thCs.borderRightWidth);
    if ((mark || label).getBoundingClientRect().right > room + 0.5) cut.push(`title ${label.textContent}`);
    return { id: th.dataset.columnId, width: Math.round(th.getBoundingClientRect().width), needed: Math.ceil(needed), cut, ellipsis,
      texts: cells.map((td) => td.textContent) };
  });
}

async function measureCost(base) {
  const { measureColumnContent } = await import(`${base}js/core/column_content_width.js`);
  const { buildCellRow, cell } = await import(`${base}js/core/cell_patch.js`);
  const table = document.createElement("table");
  const columns = 12, count = 2000, changed = 5;
  table.innerHTML = `<thead><tr>${Array.from({ length: columns }, (_, i) => `<th><span class="canonical-title-label">c${i}</span></th>`).join("")}</tr></thead>`;
  const body = document.createElement("tbody");
  for (let r = 0; r < count; r += 1) body.appendChild(buildCellRow(Array.from({ length: columns }, (_, i) => cell(`${r}.${i}`))));
  table.appendChild(body);
  document.body.appendChild(table);
  const time = (fn, times) => { const start = performance.now(); for (let i = 0; i < times; i += 1) fn(); return (performance.now() - start) / times; };
  const fullMs = time(() => measureColumnContent(table, body, []), 20);
  const rows = [...body.rows].slice(0, changed);
  const partialMs = time(() => measureColumnContent(table, body, [], { rows }), 200);
  // A row no Tick wrote gets a much longer text: the next Tick's measure does not see it, a full measure does.
  const last = body.rows[count - 1].cells[0];
  last._cell = cell("W".repeat(60));
  last.textContent = last._cell.text;
  const untouchedWidth = measureColumnContent(table, body, [], { rows })[0];
  const fullWidth = measureColumnContent(table, body, [])[0];
  table.remove();
  return { rows: count, changed, fullMs, partialMs, untouchedWidth, fullWidth, untouchedNotRead: untouchedWidth < fullWidth, fullSeesIt: fullWidth > 200 };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 600, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const js = (code) => win.webContents.executeJavaScript(code);
  const settle = () => js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const snapshot = async () => { await settle(); return js(`(${measure.toString()})()`); };
  const report = (label, columns) => {
    if (process.env.COLUMN_WIDTH_REPORT) for (const c of columns) console.log(`${label.padEnd(10)} ${c.id.padEnd(22)} width ${c.width} needs ${c.needed}  ${c.texts.join(" / ")}`);
  };
  const fits = (label, columns) => {
    for (const c of columns) {
      check(!c.cut.length, `${label}: ${c.id} cuts ${c.cut.join(", ")}`);
      check(!c.ellipsis.length, `${label}: ${c.id} ${c.ellipsis.join("; ")}`);
      check(c.width >= c.needed - 1, `${label}: ${c.id} is ${c.width}px, its values need ${c.needed}`);
      check(c.width <= c.needed + 3, `${label}: ${c.id} is ${c.width}px, wider than its values need (${c.needed})`);
    }
  };
  try {
    await js(`(${setup.toString()})(${JSON.stringify(base)})`);
    const first = await snapshot();
    report("first", first);
    fits("first draw", first);
    const pnl = (columns) => columns.find((c) => c.id === "position_pnl");

    // A price tick that makes 損益 longer (+120,000 -> +9,020,000) widens it at once.
    await js("window.__list.draw(10000, 1000)");
    const longer = await snapshot();
    report("longer", longer);
    check(pnl(longer).width > pnl(first).width, `a longer 損益 widens its column (${pnl(first).width} -> ${pnl(longer).width})`);
    fits("longer value", longer);

    // A tick back to the shorter value keeps the width (no column moves while prices tick)...
    await js("window.__list.draw(1100, 1000)");
    const ticked = await snapshot();
    check(pnl(ticked).width === pnl(longer).width, `a shorter tick keeps 損益's width (${pnl(longer).width} -> ${pnl(ticked).width})`);
    // ...until the rows change.
    await js("window.__list.draw(1100, 1000, true)");
    const redrawn = await snapshot();
    check(Math.abs(pnl(redrawn).width - pnl(first).width) <= 1, `rows redrawn: 損益 back to ${pnl(first).width} (got ${pnl(redrawn).width})`);
    fits("rows redrawn", redrawn);

    // A wide pane: the other columns share the room, 股名 keeps its five characters.
    await js(`document.getElementById("pageContainer").style.width = "1400px"`);
    const wide = await snapshot();
    report("wide", wide);
    const name = (columns) => columns.find((c) => c.id === "name");
    check(Math.abs(name(wide).width - name(redrawn).width) <= 1, `a wide pane leaves 股名 at ${name(redrawn).width} (got ${name(wide).width})`);
    check(wide.reduce((sum, c) => sum + c.width, 0) >= 1400 - wide.length - 20, `the columns fill the wide pane (${wide.map((c) => c.width)})`);

    // The same through a Tick that names its changed code, which writes and measures that row only: a longer value
    // still widens the column at once, a shorter one keeps it.
    await js(`document.getElementById("pageContainer").style.width = "420px"`);
    await js("window.__list.draw(1100, 1000, true)");
    const reset = await snapshot();
    await js('window.__list.draw(10000, 1000, false, ["2330"])');
    const tickLong = await snapshot();
    check(Math.abs(pnl(tickLong).width - pnl(longer).width) <= 1, `a changed-code tick with a longer 損益 widens it to ${pnl(longer).width} (got ${pnl(tickLong).width})`);
    fits("changed-code tick", tickLong);
    await js('window.__list.draw(1100, 1000, false, ["2330"])');
    const tickBack = await snapshot();
    check(pnl(tickBack).width === pnl(tickLong).width, `a changed-code tick back keeps 損益's width (${pnl(tickLong).width} -> ${pnl(tickBack).width})`);
    check(pnl(tickLong).width > pnl(reset).width, "the changed-code ticks started from the narrow width");

    // Many products ticking: a Tick measures the rows it wrote, not every row. A cell no Tick wrote is not read (a
    // text changed behind the list's back stays unmeasured until the next full measure), and measuring a few rows
    // costs a small part of the full measure.
    const cost = await js(`(${measureCost.toString()})(${JSON.stringify(base)})`);
    if (process.env.COLUMN_WIDTH_REPORT) console.log("measure cost", cost);
    check(cost.untouchedNotRead, `a Tick read a row it did not write (${cost.untouchedWidth} vs ${cost.fullWidth})`);
    check(cost.fullSeesIt, "a full measure reads every row");
    check(cost.partialMs * 20 < cost.fullMs, `measuring ${cost.changed} of ${cost.rows} rows took ${cost.partialMs.toFixed(3)} ms, the full measure ${cost.fullMs.toFixed(3)} ms`);

    if (problems.length) throw new Error(`\n  ${problems.join("\n  ")}`);
    console.log(`renderer column min width ui passed (${first.length} columns)`);
    app.exit(0);
  } catch (error) {
    console.error("renderer column min width ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
