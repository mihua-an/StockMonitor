const { makeTempDir } = require("./support/temp_dirs.cjs");
// A table redrawn with a row gone from the middle moves no other row (user 11-11: the live page dropped frames). Rows
// that leave are taken out before the rest are placed; left in place until after, each one put every row below it one
// slot off and every one of those was taken out and put back -- 成交明細 did that on every trade (7,307 row moves in
// 10 s of the render bench). Checked for the shared keyed rows (cell_patch.patchKeyedRows) and 成交明細's own rows,
// in a real Chromium (run with Electron): the rows that stay keep their elements and are never re-inserted.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-keyed-rows-moves-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const frames = (n) => new Promise((resolve) => { const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve()); step(n); });
  // Every insertBefore on `body`, counted while `run` draws.
  const movesWhile = (body, run) => {
    let moves = 0;
    const original = body.insertBefore;
    body.insertBefore = function insertBefore(child, ref) { if (child.isConnected) moves += 1; return original.call(this, child, ref); };
    try { run(); } finally { delete body.insertBefore; }
    return moves;
  };

  // The shared keyed rows: 100 rows, then the same with the 40th gone and a new one on top.
  const { patchKeyedRows } = await import(`${base}js/core/cell_patch.js`);
  const table = document.createElement("table");
  const body = table.createTBody();
  document.querySelector("main").appendChild(table);
  const draw = (keys) => patchKeyedRows(body, keys, { keyOf: (k) => k, cellsOf: (k) => [{ text: String(k) }] });
  const first = Array.from({ length: 100 }, (_, i) => 1000 - i);
  draw(first);
  const kept = [...body.rows].filter((_, i) => i !== 39);
  const next = [1001, ...first.filter((_, i) => i !== 39)];
  const sharedMoves = movesWhile(body, () => draw(next));
  if (body.rows.length !== 100 || [...body.rows].map((r) => Number(r.textContent)).join() !== next.join()) fail("the keyed rows show the new list in order");
  if (sharedMoves) fail(`a row gone from the middle moved ${sharedMoves} other keyed row(s)`);
  if (kept.some((row) => !row.isConnected)) fail("the keyed rows that stay keep their elements");

  // 成交明細 (live page 1): a print gone from the middle of the page and a new one on top.
  const { EngineReplay } = await import(`${base}js/features/history/engine_replay.js`);
  const { TickDetailsComponent } = await import(`${base}js/core/components/tick_details_component.js`);
  const print = (sequence) => ({ price: 115.5, volume: 1, tick_type: 2, ingest_sequence: sequence, durable_sequence: sequence,
    exchange_ts_ns: String(BigInt(Date.UTC(2026, 9, 29, 1, 52, 18)) * 1_000_000n + BigInt(sequence) * 1000n) });
  let trades = Array.from({ length: 60 }, (_, i) => print(100 + i));
  const engine = new EngineReplay();
  engine.code = "2303";
  engine.replayId = "replay-1";
  engine.spec = { source: "shioaji", market: "STK", code: "2303", trading_date: "2026-10-29", session: "DAY", replay_id: "replay-1" };
  engine.state = () => ({ summary: { prev_close: 128 }, trades });
  let push = null;
  const context = { mode: "replay", symbolStore: { getSelectedSymbol: () => "2303", subscribe: () => () => {} },
    currentTimestamp: { get: () => null, subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: (_name, fn) => { push = fn; return () => {}; } }, services: {} };
  const host = document.createElement("section");
  host.style.cssText = "width:420px;height:360px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  const tape = new TickDetailsComponent();
  tape.mount({ host, context });
  await frames(2);
  push(engine.tickDetailsViewModel());
  await frames(2);
  const tickBody = host.querySelector('[data-role="tick-body"]');
  const before = [...tickBody.rows];
  if (before.length !== 60) fail(`60 prints listed: ${before.length}`);
  trades = [...trades.filter((t) => t.ingest_sequence !== 130), print(160)];
  const tickMoves = movesWhile(tickBody, () => push(engine.tickDetailsViewModel()));
  if (tickBody.rows.length !== 60) fail(`still 60 rows: ${tickBody.rows.length}`);
  if (tickMoves) fail(`a print gone from the middle moved ${tickMoves} other trade row(s)`);
  if (before.filter((row) => row.isConnected).length !== 59) fail("the 59 trade rows that stay keep their elements");
  tape.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 500, webPreferences: { sandbox: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("keyed rows moves ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("keyed rows moves ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
