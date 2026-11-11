const { makeTempDir } = require("./support/temp_dirs.cjs");
// 買賣報價: a level's ±change badge lives its own time (user 11-11). It used to go at the very next redraw of the book
// -- the next book or a trade's summary -- so on a busy stock it vanished before it could be read. Now: a change shows
// in full for 0.5 s from when it appears, whatever redraws the book meanwhile; a second change at the same price while
// it shows adds to it on the SAME element (no new pop) without making it stay longer; then it fades and goes. A badge
// stays with its price when the book shifts, and another product starts with none. Run with Electron.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-orderbook-badge-life-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const { OrderBookComponent } = await import(`${base}js/core/components/orderbook_component.js`);
  const { BOOK_CHANGE_HOLD_MS, BOOK_CHANGE_FADE_MS } = await import(`${base}js/core/components/orderbook_depth_table.js`);
  const { withMarketRead } = await import(`${base}js/core/market_read_adapters.js`);
  const listeners = [];
  const dataSource = { subscribe: (name, fn) => { if (name === "orderbook") listeners.push(fn); return () => {}; }, invalidate: () => {} };
  const levels = (start, side, deltas) => Array.from({ length: 5 }, (_, i) => ({
    price: Number((start + side * i * 0.5).toFixed(2)), volume: 300 + i * 50, delta: deltas[i] ?? 0, quoteState: "PRICE" }));
  // `token` null: a redraw that is no new diff event (a trade's summary redraws the book with the same token).
  let lastToken = "t0";
  const feed = ({ code = "1815", token = null, bidStart = 130, bidDeltas = [], askDeltas = [] } = {}) => {
    if (token) lastToken = token;
    const vm = withMarketRead({ code, displayCode: code, displayName: code, market: "STK", availability: "AVAILABLE", currentPrice: 130,
      lastPrice: 130, prevClose: 129, diffRenderable: true, diffEventToken: lastToken,
      bidLevels: levels(bidStart, -1, bidDeltas), askLevels: levels(bidStart + 0.5, 1, askDeltas) });
    listeners.forEach((fn) => fn(vm));
  };
  document.querySelector("main").innerHTML = '<div id="book" style="position:absolute;left:20px;top:20px;width:300px;height:360px"></div>';
  const host = document.getElementById("book");
  const book = new OrderBookComponent({ depth: 5, showInsideOutside: false, showPriceVolume: false });
  book.mount({ host, context: { mode: "live", dataSource, symbolStore: { getSelectedSymbol: () => "1815", subscribe: () => () => {} } }, hydrate: false });
  const badges = () => [...host.querySelectorAll(".orderbook-book-change")];
  const badgeAt = (row, side) => host.querySelector(`tr[data-orderbook-level="${row}"] .orderbook-extreme-cell.${side} .orderbook-book-change`);

  feed({ token: "t0" });
  await frame();
  if (badges().length) fail("the first book (no change yet) shows no badge");

  // A change of +5 at bid 129.5 (row 1).
  const appeared = performance.now();
  feed({ token: "t1", bidDeltas: [0, 5] });
  await frame();
  const first = badgeAt(1, "bid");
  if (!first || first.textContent !== "+5") fail(`+5 shows on bid row 1: ${first?.textContent}`);
  const until = (ms) => wait(Math.max(0, appeared + ms - performance.now()));
  // A trade redraws the book (same token) and another book changes the ask: the bid badge stays.
  await until(100);
  feed();
  feed({ token: "t2", askDeltas: [0, 0, -3] });
  await frame();
  if (badgeAt(1, "bid") !== first) fail(`another redraw keeps the bid badge, the same element: now ${badgeAt(1, "bid")?.textContent} ${badgeAt(1, "bid")?.className}, first connected ${first.isConnected}, all ${badges().map((b) => b.textContent)}`);
  if (badgeAt(2, "ask")?.textContent !== "-3") fail("the ask change shows beside it");
  // A second change at 129.5 while it shows: added to it, on the same element.
  await until(250);
  feed({ token: "t3", bidDeltas: [0, 4] });
  await frame();
  if (badgeAt(1, "bid") !== first || first.textContent !== "+9") fail(`+5 then +4 at one price shows +9 on the same badge: ${badgeAt(1, "bid")?.textContent}`);
  // The book shifts down a tick: 129.5 is now row 0 and its badge goes with it.
  feed({ bidStart: 129.5 });
  await frame();
  if (badgeAt(0, "bid")?.textContent !== "+9" || badgeAt(1, "bid")) fail("the badge stays with its price when the book shifts");
  // 0.5 s from when it appeared it fades -- the +4 at 250 ms did not make it stay longer -- then goes, with no data.
  await until(BOOK_CHANGE_HOLD_MS - 80);
  if (!badgeAt(0, "bid") || badgeAt(0, "bid").classList.contains("leaving")) fail("still shown just before its time is up");
  await until(BOOK_CHANGE_HOLD_MS + 80);
  if (!badgeAt(0, "bid")?.classList.contains("leaving")) fail("fading 0.5 s after it appeared, not 0.5 s after the +4");
  await until(BOOK_CHANGE_HOLD_MS + BOOK_CHANGE_FADE_MS + 120);
  if (badges().length) fail(`all badges gone after their fade: ${badges().map((b) => b.textContent)}`);

  // Another product starts with none: a change of one stock never shows on another.
  feed({ token: "t4", bidDeltas: [7] });
  await frame();
  feed({ code: "2330", token: "t5" });
  await frame();
  if (badges().length) fail("another product shows no badge of the last one");
  book.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 460, webPreferences: { sandbox: false, offscreen: true } });
  win.webContents.setFrameRate(60);
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("orderbook change badge life ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("orderbook change badge life ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
