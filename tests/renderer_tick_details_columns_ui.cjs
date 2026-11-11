const { makeTempDir } = require("./support/temp_dirs.cjs");
// 成交明細's ⚙ (user 11-11) in a real Chromium (run with Electron): the small round button in the list's title bar opens
// the product list's column settings panel on this list's own columns. Checked:
//   * the button is small and round, in the title bar's actions;
//   * the panel lists 時間、成交、漲跌、漲跌幅、單量、總量; the order and the ticks saved there are the header's and every
//     row's cells (the DataGrid body keeps one col per shown column), and a list mounted again reads them back;
//   * the last ticked column cannot be unticked;
//   * Shioaji's 總量 shows each print's cumulative volume; Futu's list never shows 總量 and lists it greyed out.
// TICK_COLUMNS_UI_SHOT=<folder> also saves pictures of the button and both panels (an offscreen window: a hidden one's
// capturePage returns a stale frame).
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-tick-columns-ui-"));
app.on("window-all-closed", () => {});
const SHOT_DIR = process.env.TICK_COLUMNS_UI_SHOT || "";

async function scenario(base) {
  const frames = (n) => new Promise((resolve) => { const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve()); step(n); });
  const fail = (message) => { throw new Error(message); };
  localStorage.clear();
  const { EngineReplay } = await import(`${base}js/features/history/engine_replay.js`);
  const { TickDetailsComponent } = await import(`${base}js/core/components/tick_details_component.js`);

  // Market Runtime's tape rows: each Shioaji print carries the cumulative volume through it.
  const print = (sequence, volume, total) => ({ price: 115.5, volume, total_volume: total, change: 1.5, change_pct: 1.32, tick_type: 2,
    ingest_sequence: sequence, durable_sequence: sequence, exchange_ts_ns: String(BigInt(Date.UTC(2026, 10, 10, 1, 52, 18)) * 1_000_000n + BigInt(sequence) * 1000n) });
  const engine = new EngineReplay();
  engine.code = "2303";
  engine.replayId = "replay-1";
  engine.spec = { source: "shioaji", market: "STK", code: "2303", trading_date: "2026-11-10", session: "DAY", replay_id: "replay-1" };
  engine.state = () => ({ summary: { prev_close: 114 }, trades: [print(100, 10018, 10018), print(101, 3, 10021), print(102, 5, 10026)] });

  const main = document.querySelector("main");
  main.style.cssText = "display:flex;gap:12px;padding:12px;background:var(--surface-app)";
  const mountList = (widthScope) => {
    let push = null;
    const context = {
      mode: "replay",
      symbolStore: { getSelectedSymbol: () => "2303", subscribe: () => () => {} },
      currentTimestamp: { get: () => null, subscribe: () => () => {} },
      dataSource: { invalidate: () => {}, subscribe: (_name, fn) => { push = fn; return () => {}; } },
      services: {},
    };
    const host = document.createElement("section");
    host.style.cssText = "width:430px;height:300px;display:flex;flex-direction:column";
    main.appendChild(host);
    const list = new TickDetailsComponent({ widthScope });
    list.mount({ host, context });
    push(engine.tickDetailsViewModel());
    return { host, list };
  };
  let shioaji = mountList("shioaji");
  const futu = mountList("futu");
  await frames(3);

  const headers = (host) => [...host.querySelectorAll('[data-role="tick-table"] > thead th')].map((th) => th.textContent.trim());
  const firstRow = (host) => [...(host.querySelector('[data-role="tick-body"] tr')?.cells || [])].map((td) => td.textContent.trim());
  const bodyCols = (host) => host.querySelectorAll(".standard-data-grid-body-table > colgroup > col").length;
  const overlay = () => document.getElementById("quoteColumnSettingsOverlay");
  const panelRows = () => [...overlay().querySelectorAll("[data-column-key]")];
  const toggle = (key) => overlay().querySelector(`[data-column-toggle="${key}"]`);
  const all = ["時間", "成交", "漲跌", "漲跌幅", "單量", "總量"];

  // The button: in the title bar, small and round.
  const button = shioaji.host.querySelector('[data-role="tick-column-settings"]');
  if (!button || !button.closest(".tab-strip-title")) fail("⚙ sits in the list's title bar");
  const box = button.getBoundingClientRect(), style = getComputedStyle(button);
  if (box.width > 24 || box.height > 24 || parseFloat(style.borderRadius) < box.height / 2 - 1) fail(`⚙ is small and round: ${box.width}x${box.height} r=${style.borderRadius}`);

  // 商品列表's ⚙ and ✎ are the same button as 成交明細's ⚙ (one markup, one style).
  const { productListShellMarkup } = await import(`${base}js/features/realtime/product_list.js`);
  const toolbar = document.createElement("section");
  toolbar.style.cssText = "position:fixed;left:12px;bottom:12px;width:430px;height:40px;display:flex;flex-direction:column";
  toolbar.innerHTML = productListShellMarkup({ provider: "shioaji" });
  document.body.appendChild(toolbar);
  await frames(2);
  const looks = (node) => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return [node.className, Math.round(r.width), Math.round(r.height), s.borderRadius, s.backgroundColor, s.color, s.fontSize].join("|"); };
  const tools = [...toolbar.querySelectorAll(".product-list-tools button")];
  if (tools.length !== 2 || tools.some((tool) => looks(tool) !== looks(button))) fail(`the product list's ⚙ and ✎ look like 成交明細's ⚙: ${tools.map(looks)} vs ${looks(button)}`);

  // Default: every column, and Shioaji's 總量 is each print's cumulative volume.
  if (headers(shioaji.host).join() !== all.join()) fail(`default columns: ${headers(shioaji.host)}`);
  if (firstRow(shioaji.host)[5] !== "10,026") fail(`總量 is the newest print's cumulative volume: ${firstRow(shioaji.host)}`);
  if (headers(futu.host).includes("總量")) fail(`Futu never shows 總量: ${headers(futu.host)}`);
  const shots = {};
  shots.button = button.closest(".tab-strip-title").getBoundingClientRect().toJSON();

  button.click();
  await frames(2);
  if (overlay()?.hidden !== false) fail("⚙ opens the column settings panel");
  if (overlay().querySelector(".product-list-column-settings-head b").textContent !== "成交明細欄位") fail("the panel is titled 成交明細欄位");
  if (panelRows().map((row) => row.textContent.trim()).join() !== all.join()) fail(`the panel lists the six columns: ${panelRows().map((r) => r.textContent.trim())}`);
  // Beside the list whose ⚙ opened it: on its right (there is room), top-aligned with it.
  const panelBox = () => overlay().querySelector(".product-list-column-settings-panel").getBoundingClientRect();
  const besideRight = (host) => { const p = panelBox(), h = host.getBoundingClientRect(); return p.left >= h.right && p.left - h.right <= 9 && Math.abs(p.top - h.top) <= 1; };
  const besideLeft = (host) => { const p = panelBox(), h = host.getBoundingClientRect(); return p.right <= h.left && h.left - p.right <= 9 && Math.abs(p.top - h.top) <= 1; };
  if (!besideRight(shioaji.host)) fail(`the panel opens beside the list: panel ${JSON.stringify(panelBox())} list ${JSON.stringify(shioaji.host.getBoundingClientRect())}`);
  shots.shioajiPanel = panelBox().toJSON();
  window.__shotReady = "shioajiPanel";
  await new Promise((resolve) => { window.__shotTaken = resolve; if (!window.__wantShots) resolve(); });

  // Untick all but 成交: the last ticked box is locked.
  for (const key of ["time", "change", "change_pct", "volume", "total_volume"]) toggle(key).click();
  if (!toggle("trade").disabled || !toggle("trade").checked) fail("the last ticked column cannot be unticked");
  toggle("total_volume").click(); toggle("volume").click();
  if (toggle("trade").disabled) fail("with others ticked 成交 can be unticked again");
  // 總量 dragged by its grip onto the top half of the first row.
  const transfer = new DataTransfer(), firstPanelRow = panelRows()[0];
  overlay().querySelector('[data-column-drag="total_volume"]').dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
  firstPanelRow.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  firstPanelRow.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: firstPanelRow.getBoundingClientRect().top + 1 }));
  if (panelRows()[0].dataset.columnKey !== "total_volume") fail("the grip drags a column to the top");
  // The whole row ticks: a click on the row's name toggles it; a click on the grip does not.
  overlay().querySelector('[data-column-key="volume"] .product-list-column-label').click();
  if (toggle("volume").checked) fail("a click on the row unticks it");
  overlay().querySelector('[data-column-key="volume"] .product-list-column-label').click();
  overlay().querySelector('[data-column-drag="volume"]').click();
  if (!toggle("volume").checked) fail("the row ticks again, and the grip does not toggle it");
  if (!overlay().querySelector('[data-column-key="volume"]').classList.contains("selected")) fail("a shown column's row is tinted");
  document.getElementById("quoteColumnDoneBtn").click();
  await frames(3);
  const shown = ["總量", "成交", "單量"];
  if (headers(shioaji.host).join() !== shown.join()) fail(`the header follows the saved order and ticks: ${headers(shioaji.host)}`);
  if (firstRow(shioaji.host).join() !== "10,026,115.50,5") fail(`each row's cells follow the header: ${firstRow(shioaji.host)}`);
  if (bodyCols(shioaji.host) !== 3) fail(`the DataGrid body keeps one col per shown column: ${bodyCols(shioaji.host)}`);
  if (headers(futu.host).length !== 5) fail(`Futu's list keeps its own columns: ${headers(futu.host)}`);

  // Mounted again (a window reopened): the saved columns come back.
  shioaji.list.destroy(); shioaji.host.remove();
  shioaji = mountList("shioaji");
  await frames(3);
  if (headers(shioaji.host).join() !== shown.join()) fail(`a list mounted again reads the saved columns: ${headers(shioaji.host)}`);

  // The list is now the right one, with no room on its right: the panel opens on its left.
  shioaji.host.querySelector('[data-role="tick-column-settings"]').click();
  await frames(2);
  if (!besideLeft(shioaji.host)) fail(`no room on the right: the panel opens on the list's left: ${JSON.stringify(panelBox())}`);
  shots.leftPanel = panelBox().toJSON();
  window.__shotReady = "leftPanel";
  await new Promise((resolve) => { window.__shotTaken = resolve; if (!window.__wantShots) resolve(); });
  document.getElementById("quoteColumnCancelBtn").click();

  // Futu: 總量 listed greyed out, unticked and locked.
  futu.host.querySelector('[data-role="tick-column-settings"]').click();
  await frames(2);
  const futuTotal = overlay().querySelector('[data-column-key="total_volume"]');
  if (!futuTotal?.classList.contains("disabled") || !toggle("total_volume").disabled || toggle("total_volume").checked) fail("Futu's 總量 is greyed out and cannot be ticked");
  const grey = getComputedStyle(futuTotal.querySelector(".product-list-column-label")).color;
  const plain = getComputedStyle(overlay().querySelector('[data-column-key="time"] .product-list-column-label')).color;
  if (grey === plain) fail(`the unavailable column reads greyed out: ${grey}`);
  shots.futuPanel = overlay().querySelector(".product-list-column-settings-panel").getBoundingClientRect().toJSON();
  window.__shotReady = "futuPanel";
  await new Promise((resolve) => { window.__shotTaken = resolve; if (!window.__wantShots) resolve(); });
  document.getElementById("quoteColumnCancelBtn").click();

  shioaji.list.destroy(); futu.list.destroy(); engine.dispose();
  if (document.getElementById("quoteColumnSettingsOverlay") && !overlay().hidden) fail("the panel closes when nothing holds it");
  return { ok: true, shots };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 640, webPreferences: { sandbox: false, backgroundThrottling: false, offscreen: Boolean(SHOT_DIR) } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  let poll = null;
  try {
    if (SHOT_DIR) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await win.webContents.executeJavaScript("window.__wantShots = true");
      // Each time the scenario pauses at a picture, the whole window is saved, then the scenario goes on.
      poll = setInterval(async () => {
        const name = await win.webContents.executeJavaScript("window.__shotReady || ''").catch(() => "");
        if (!name) return;
        await win.webContents.executeJavaScript("window.__shotReady = ''");
        await new Promise((resolve) => setTimeout(resolve, 150));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), image.toPNG());
        await win.webContents.executeJavaScript("window.__shotTaken && window.__shotTaken()");
      }, 50);
    }
    const result = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    if (SHOT_DIR) fs.writeFileSync(path.join(SHOT_DIR, "regions.json"), JSON.stringify(result.shots, null, 2));
    console.log("tick details columns ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("tick details columns ui contract FAILED:", error?.message || error);
    app.exit(1);
  } finally {
    if (poll) clearInterval(poll);
  }
});
