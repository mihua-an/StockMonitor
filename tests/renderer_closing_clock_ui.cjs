const { makeTempDir } = require("./support/temp_dirs.cjs");
// 資料中心 收盤整理's figures (#dataCenterClosingNext) have one writer, the closing clock (features/data_center/
// closing_clock.js). Run with Electron. Checked: the page hands the node to the clock and never writes it itself (its
// poll only replaces the clock's input); the clock draws an answer at once, moves the countdown on its own tick from
// that same answer, draws a newer answer at once, and after dispose neither ticks nor draws.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-closing-clock-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const { createClosingClock } = await import(`${base}js/features/data_center/closing_clock.js`);
  const { renderClosingNext } = await import(`${base}js/features/data_center/closing_progress_view.js`);
  let now = Date.parse("2026-11-05T05:00:00Z");
  const ticks = new Map();
  let nextId = 1;
  const timers = {
    setInterval: (fn, ms) => { if (ms !== 1000) fail(`a 1 s tick, got ${ms}`); ticks.set(nextId, fn); return nextId++; },
    clearInterval: (id) => { ticks.delete(id); },
  };
  const tick = () => { now += 1000; for (const fn of ticks.values()) fn(); };
  const node = document.createElement("div");
  document.body.appendChild(node);
  const answer = (dueInSeconds, id = "FUT:NIGHT") => ({ ok: true, stage: "waiting",
    next: { id, trading_date: "2026-11-05", seal_due_at: new Date(now + dueInSeconds * 1000).toISOString() } });

  const clock = createClosingClock(node, { now: () => now, timers });
  if (ticks.size !== 1) fail("the clock runs its own tick");
  tick();
  if (node.innerHTML !== "") fail("nothing is drawn before the first answer");
  const first = answer(65);
  clock.setInput(first);
  if (!node.textContent.includes("1 分 5 秒") || !node.textContent.includes("期貨夜盤")) fail(`the answer is drawn at once: ${node.textContent}`);
  const figure = node.firstElementChild;
  tick();
  if (!node.textContent.includes("1 分 4 秒")) fail(`the countdown moves on the tick: ${node.textContent}`);
  if (node.firstElementChild !== figure) fail("a tick morphs the figures, it does not rebuild them");
  const probe = document.createElement("div");
  probe.innerHTML = renderClosingNext(first, now);
  if (node.textContent !== probe.textContent) fail("the tick draws the same answer at the clock's time");
  clock.setInput(answer(3600 * 2, "STK:DAY"));
  if (!node.textContent.includes("台股") || !node.textContent.includes("2 小時 0 分")) fail(`a newer answer is drawn at once: ${node.textContent}`);
  clock.dispose();
  if (ticks.size) fail("dispose stops the tick");
  const drawn = node.innerHTML;
  clock.setInput(answer(10));
  if (node.innerHTML !== drawn) fail("a disposed clock draws nothing");
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const renderer = path.join(__dirname, "..", "ui", "renderer");
  const base = pathToFileURL(renderer + path.sep).href;
  try {
    // The page itself: the node is the clock's, the poll's answer goes to the clock, the page has no tick of its own.
    const page = fs.readFileSync(path.join(renderer, "js", "pages", "data_center.js"), "utf8");
    const uses = page.match(/dataCenterClosingNext/g) || [];
    if (uses.length !== 1 || !/createClosingClock\(\$\("dataCenterClosingNext"\)\)/.test(page)) throw new Error("data_center.js hands #dataCenterClosingNext to the clock and names it nowhere else");
    if (/renderClosingNext/.test(page) || /setInterval/.test(page)) throw new Error("data_center.js neither draws the figures nor ticks");
    if (!/closingClock\?\.setInput\(payload\)/.test(page)) throw new Error("the poll's answer replaces the clock's input");
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("closing clock ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("closing clock ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
