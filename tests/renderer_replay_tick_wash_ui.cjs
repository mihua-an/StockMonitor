const { makeTempDir } = require("./support/temp_dirs.cjs");
// 歷史回放's 成交明細 lists the replay's prints newest first and washes a print new to the replay like the live page, in
// a real Chromium (run with Electron). The list reads the read model's trades channel: the replay engine puts its own
// newest-first rows there, each its print's durable sequence, so a print with the same second, price, volume and side
// as one already listed is still a new row.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
require("./support/keep_motion.cjs").keepMotion(app);
app.setPath("userData", makeTempDir("stockmonitor-replay-tick-wash-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const frames = (n) => new Promise((resolve) => { const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve()); step(n); });
  const fail = (message) => { throw new Error(message); };
  const { EngineReplay } = await import(`${base}js/features/history/engine_replay.js`);
  const { TickDetailsComponent } = await import(`${base}js/core/components/tick_details_component.js`);

  // The replay view's trades as Market Runtime holds them, oldest first: 1-lot prints at 115.5 in the same second.
  const print = (sequence, volume = 1) => ({ price: 115.5, volume, tick_type: 2, ingest_sequence: sequence, durable_sequence: sequence,
    exchange_ts_ns: String(BigInt(Date.UTC(2026, 9, 29, 1, 52, 18)) * 1_000_000n + BigInt(sequence) * 1000n) });
  let trades = [print(100, 10018), print(101), print(102)];
  const engine = new EngineReplay();
  engine.code = "2303";
  engine.replayId = "replay-1";
  engine.spec = { source: "shioaji", market: "STK", code: "2303", trading_date: "2026-10-29", session: "DAY", replay_id: "replay-1" };
  engine.state = () => ({ summary: { prev_close: 128 }, trades });

  let push = null;
  const context = {
    mode: "replay",
    symbolStore: { getSelectedSymbol: () => "2303", subscribe: () => () => {} },
    currentTimestamp: { get: () => null, subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: (_name, fn) => { push = fn; return () => {}; } },
    services: {},
  };
  const host = document.createElement("section");
  host.style.cssText = "width:420px;height:360px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  const tape = new TickDetailsComponent();
  tape.mount({ host, context });
  await frames(2);

  const rows = () => [...host.querySelectorAll('[data-role="tick-body"] tr')];
  const volumes = () => rows().map((row) => row.cells[4]?.textContent.trim()).join(","); // 單量: 時間, 成交, 漲跌, 漲跌幅, 單量, 總量
  const washed = () => rows().filter((row) => row.classList.contains("row-wash")).length;
  push(engine.tickDetailsViewModel());
  await frames(2);
  if (rows().length !== 3 || washed()) fail(`the first fill lists three prints and washes none (${rows().length} rows, ${washed()} washed)`);
  if (!volumes().endsWith("10,018")) fail(`newest first: the opening print is the last row: ${volumes()}`);

  trades = [print(100, 10018), print(101), print(102), print(103), print(104)];
  push(engine.tickDetailsViewModel());
  if (rows().length !== 5) fail(`two more prints of the same second, price and volume are two more rows: ${rows().length}`);
  const marks = rows().map((row) => row.classList.contains("row-wash") ? "new" : "-").join(",");
  if (marks !== "new,new,-,-,-") fail(`the two new prints top the list and wash, the listed ones do not: ${marks}`);

  // The live tape's rules: the closing auction's 試撮 prints (13:25-13:30, `simtrade`) are not listed, and a print
  // Rust B lists among the view's large prints carries the 大單 badge.
  const tradeflow = { cumulative: {}, minute_series: [], large_orders: [{ durable_sequence: 100, trade_id: "" }], thresholds: { volume_cutoff: 499 } };
  trades = [print(100, 10018), print(101), print(102), print(103), print(104), { ...print(105, 7), simtrade: true }];
  engine.state = () => ({ summary: { prev_close: 128 }, trades, tradeflow });
  const vm = engine.tickDetailsViewModel();
  push(vm);
  await frames(2);
  if (rows().length !== 5 || volumes().startsWith("7")) fail(`a 試撮 print is not listed: ${volumes()}`);
  const badges = rows().map((row) => row.querySelector(".tick-details-large-badge") ? "大" : "-").join(",");
  if (badges !== "-,-,-,-,大") fail(`only Rust B's large print carries the badge: ${badges}`);
  if (vm.largeOrderDefinition?.threshold !== 499) fail(`the badge threshold is the view's tradeflow's: ${JSON.stringify(vm.largeOrderDefinition)}`);
  tape.destroy();
  engine.dispose();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: false, backgroundThrottling: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("replay tick wash ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("replay tick wash ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
