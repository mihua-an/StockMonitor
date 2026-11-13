const { makeTempDir } = require("./support/temp_dirs.cjs");
// 商品頁設定 in a real Chromium (run with Electron): the real watch_pages_window.html and its modules against a fake
// settings_api (GET /api/subscriptions, POST /api/subscriptions/preview and /ops). Checked:
//  * three columns of cards with their tops aligned; the pages of the chosen source; the page's products as rows of
//    one height, each with 低價／高價 and 期貨 (a stock with 個股期貨 only)／現貨 (明細＋五檔 as one switch);
//  * 期貨 opens the months under the row (one row high) with the motion, the near month locked;
//  * a removed product floats 復原 and 復原 puts it back where it was; no confirmation;
//  * a product added from the search, a renamed page, a switch: one save sends only those operations;
//  * a double click is one save, an edit made while it is in flight stays; a failed save keeps the draft and says so;
//  * another window's save (watch-pages-window:changed) is laid under this window's unsaved changes.
// With WATCH_UI_SHOTS=<folder> the window is also saved as PNGs there.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-watch-ui-"));
app.on("window-all-closed", () => {});

// Runs in the page before its scripts (contextIsolation off): the fake desktopAPI and settings_api.
function fakeBackend() {
  const calls = [];
  window.__calls = calls;
  window.__listeners = [];
  window.__saveAnswer = null;
  const row = (code, name, extra = {}) => ({ source: "shioaji", market: "STK", code, name, pages: ["p1"], owners: ["watchlist"], trade: true, orderbook: true, listed: true, locked: false, ...extra });
  const snapshot = (pages) => ({
    ok: true, revision: 5, background: [], pages,
    preferences: { instruments: [], taiex: true, txf: { on: true, trade: false, orderbook: false, months: [] }, sector: { enabled: true, scope: "related" }, batches: [] },
    instruments: [
      row("2317", "鴻海"),
      row("2330", "台積電", { futures: { on: false, trade: true, orderbook: true, months: [], category: "CDF", name: "台積電期", months_listed: ["202611", "202612", "202703"] } }),
      { source: "futu", market: "US", code: "US.AAPL", name: "蘋果", pages: ["p3"], owners: ["watchlist"], trade: true, orderbook: false, listed: true, locked: false },
    ],
    sector_indexes: { listed: [], related: 0, all: 54 },
    quota: { shioaji: { trade: 2, orderbook: 2, index: 1, futures: 1, used: 6, limit: 480, connections: 3, per_connection: 200 }, futu: { base: 2, trade: 1, orderbook: 0, used: 3 } },
    futures: { categories: { CDF: { name: "台積電期", underlying_code: "2330", months: ["202611", "202612", "202703"] } }, stocks: { 2330: ["CDF"] } },
    txf_months: ["202611", "202612", "202701"],
  });
  window.__pages = [
    { id: "p1", name: "台股", source: "shioaji", items: [{ code: "2330", name: "台積電", upper_alert: "1100" }, { code: "2317", name: "鴻海" }] },
    { id: "p2", name: "觀察", source: "shioaji", items: [] },
    { id: "p3", name: "美股", source: "futu", items: [{ code: "US.AAPL", name: "蘋果" }] },
  ];
  window.__snapshot = snapshot;
  window.desktopAPI = {
    networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } },
    sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} },
    colorPreferences: {},
    onColorPreferencesChanged: () => () => {},
    // The 永豐 list holds products; the Futu one was never fetched (listed 0: OpenD has not connected yet).
    searchProductCatalogLocal: async (source, q) => (source === "futu" ? { ok: true, items: [], listed: 0 }
      : { ok: true, items: q ? [{ code: "2454", name: "聯發科", industry_name: "半導體" }] : [], listed: 2 }),
    notifyWatchPagesChanged: async (payload) => { calls.push({ method: "IPC", path: "notify", body: payload }); return true; },
    onWatchPagesChanged: (callback) => { window.__listeners.push(callback); return () => {}; },
  };
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input?.url || input));
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/subscriptions") return json(snapshot(window.__pages));
    if (url.pathname === "/api/subscriptions/preview") return json({ ...snapshot(window.__pages), preview: true });
    if (url.pathname === "/api/subscriptions/ops") {
      const answer = window.__saveAnswer;
      if (answer) return answer instanceof Promise ? answer.then((a) => json(a, a.ok === false ? 422 : 200)) : json(answer, answer.ok === false ? 422 : 200);
      return json({ ...snapshot(window.__pages), revision: 6, skipped: [] });
    }
    return json({ ok: false, error: `unexpected ${url.pathname}` }, 404);
  };
  window.__reduce = false;
  const realMatch = window.matchMedia.bind(window);
  window.matchMedia = (query) => (query.includes("reduced-motion") ? { matches: window.__reduce, media: query, addEventListener() {}, removeEventListener() {} } : realMatch(query));
}

async function checks() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  const $ = (id) => document.getElementById(id);
  const ops = () => window.__calls.filter((c) => c.path === "/api/subscriptions/ops");
  await wait(300);

  // ---- three cards, tops aligned; the pages of 永豐; the page's products
  const tops = [...document.querySelectorAll(".watch-card")].map((card) => Math.round(card.getBoundingClientRect().top));
  if (tops.length !== 3 || new Set(tops).size !== 1) fail(`three cards with their tops aligned: ${tops}`);
  const pageNames = [...$("watchPageList").querySelectorAll(".watch-list-name")].map((n) => n.textContent);
  if (pageNames.join(",") !== "台股,觀察") fail(`the 永豐 pages: ${pageNames}`);
  const items = () => [...$("watchPageItems").querySelectorAll(".watch-item")];
  if (items().map((r) => r.querySelector(".watch-cell-code").textContent).join(",") !== "2330,2317") fail("the page's products");
  if (items().some((r) => Math.round(r.getBoundingClientRect().height) !== 44)) fail("every product row is one height");
  if (!items()[0].querySelector('[data-futures="on"]') || items()[1].querySelector('[data-futures="on"]')) fail("期貨 only for a stock with 個股期貨");
  if (document.querySelector("#watchPageItems [data-lane]") || items().some((r) => r.querySelector("[data-spot]")?.textContent !== "現貨")) fail("one 現貨 per product, no 明細／五檔");
  const heads = [...$("watchPageItems").querySelectorAll(".watch-row-head .watch-cell-center")].map((c) => c.textContent).join(",");
  if (heads !== "期貨,現貨") fail(`the switch columns: ${heads}`);
  if (items()[0].querySelector('[data-edit-alert="upper_alert"]').textContent !== "1100") fail("高價 shown");
  if (!$("saveWatchPagesBtn").disabled) fail("nothing changed: nothing to save");

  // ---- 期貨 opens the months with the motion
  items()[0].querySelector('[data-futures="on"]').click();
  const months = $("watchPageItems").querySelector(".watch-row-months");
  if (!months || !months.getAnimations().length) fail("期貨 opens the months with the motion");
  if (months.querySelectorAll(".is-locked").length !== 1 || months.querySelectorAll("[data-month]").length !== 2) fail("near month locked, others pressable");
  if (months.querySelector("[data-spot], [data-futures]")) fail("the months have no switches of their own");
  // One motion straight to one row high: the opening animation is not cancelled and restarted on the way.
  const opened = await months.getAnimations()[0].finished.then(() => true, () => false);
  if (!opened) fail("the months open in one motion");
  if (Math.round(months.getBoundingClientRect().height) !== 44) fail("the months row is one row high");

  // ---- remove with 復原, no confirmation
  items()[1].querySelector("[data-remove-index]").click();
  const undoToast = [...$("settingsToast").querySelectorAll(".settings-toast")].find((t) => t.textContent.includes("鴻海"));
  if (items().length !== 1 || $("settingsToast").hidden || !undoToast) fail("removed at once, 復原 floats");
  undoToast.querySelector("button").click();
  if (items().map((r) => r.querySelector(".watch-cell-code").textContent).join(",") !== "2330,2317") fail("復原 puts it back where it was");

  // ---- add from the search, rename, a switch: one save of those operations
  $("watchPageSearchInput").value = "2454";
  $("watchPageSearchInput").dispatchEvent(new Event("input"));
  await wait(400);
  $("watchPageSearchResults").querySelector('[data-add-code="2454"]').click();
  if (items().length !== 3) fail("added from the search");
  document.querySelector("[data-edit-name]").click();
  const nameInput = $("watchPageNameHead").querySelector("input");
  nameInput.value = "台股主力";
  nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  if (!$("watchPageNameHead").textContent.includes("台股主力")) fail("renamed in place");
  items()[1].querySelector("[data-spot]").click();
  await wait(300);
  if ($("saveWatchPagesBtn").disabled) fail("changes can be saved");
  $("saveWatchPagesBtn").click();
  $("saveWatchPagesBtn").click();
  await wait(200);
  if (ops().length !== 1) fail(`a double click is one save (${ops().length})`);
  const sent = ops()[0].body.ops.map((o) => [o.op, o.code || o.page_id, o.field, o.value].filter((x) => x !== undefined).join(" ")).join(" | ");
  if (sent !== "page.rename p1 | item.add 2454 | instrument.set 2330 futures true | instrument.set 2317 trade false | instrument.set 2317 orderbook false") fail(`only the changes are sent: ${sent}`);
  if (!$("settingsToast").textContent.includes("商品頁設定已儲存")) fail("a save floats its message");
  // 儲存設定 is decided by its owner from "changes" and "a save is out" (D08-11), never put back as it was at the click.
  if (!$("saveWatchPagesBtn").disabled) fail("saved and nothing left to save: 儲存設定 is disabled");

  // ---- an edit while a save is in flight stays; a failed save keeps the draft
  let answer;
  window.__saveAnswer = new Promise((resolve) => { answer = resolve; });
  items()[1].querySelector("[data-spot]").click();
  $("saveWatchPagesBtn").click();
  await wait(50);
  items()[0].querySelector("[data-spot]").click();
  if (!$("saveWatchPagesBtn").disabled) fail("an edit while a save is out leaves 儲存設定 disabled");
  answer({ ...window.__snapshot(window.__pages), revision: 7, skipped: [] });
  await wait(150);
  if ($("saveWatchPagesBtn").disabled) fail("the edit made while saving can be saved once the save is answered");
  if (items()[0].querySelector("[data-spot]").classList.contains("is-active")) fail("the edit made while saving stays");
  if (!$("watchPagesStatus").textContent.includes("之後的修改尚未儲存")) fail("and says it is not saved yet");
  window.__saveAnswer = { ok: false, error: "QUOTA_EXCEEDED", message: "永豐訂閱會用到 500 個，背景清單上限 480 個" };
  $("saveWatchPagesBtn").click();
  await wait(150);
  if (!$("watchPagesStatus").classList.contains("is-error") || !$("watchPagesStatus").textContent.includes("480")) fail(`a refused save says why: ${$("watchPagesStatus").textContent}`);
  if (items()[0].querySelector("[data-spot]").classList.contains("is-active")) fail("a refused save keeps the draft");
  window.__saveAnswer = null;

  // ---- another window saved: its change is shown, this window's unsaved change stays
  window.__pages = window.__pages.map((p) => (p.id === "p1" ? { ...p, items: [...p.items, { code: "2603", name: "長榮" }] } : p));
  window.__listeners.forEach((listener) => listener({ kind: "saved" }));
  await wait(200);
  const codes = items().map((r) => r.querySelector(".watch-cell-code").textContent).join(",");
  if (!codes.includes("2603")) fail(`another window's product shows: ${codes}`);
  if (items()[0].querySelector("[data-spot]").classList.contains("is-active")) fail("this window's unsaved switch stays");

  // ---- 富途
  document.querySelector('[data-watch-source="futu"]').click();
  if ($("futuMarketRow").hidden || items().length !== 1 || items()[0].querySelector('[data-futures="on"]')) fail("富途: its pages, its market filter, no 期貨");
  // A new install before OpenD first connected: the catalog lists no Futu product, and a search says why (user 11-12).
  $("watchPageSearchInput").value = "AAPL";
  $("watchPageSearchInput").dispatchEvent(new Event("input"));
  await wait(400);
  if (!$("watchPageSearchResults").textContent.includes("還沒有 Futu 商品清單：請開啟並登入 moomoo OpenD")) {
    fail(`a search over no Futu list says why: ${$("watchPageSearchResults").textContent}`);
  }
  return { ok: true };
}

async function capture(win, dir, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
}

app.whenReady().then(async () => {
  const preload = path.join(makeTempDir("stockmonitor-watch-ui-preload-"), "preload.js");
  fs.writeFileSync(preload, `(${fakeBackend.toString()})();`);
  const win = new BrowserWindow({ show: false, width: 1380, height: 820, webPreferences: {
    preload, contextIsolation: false, sandbox: false, offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadURL(pathToFileURL(path.join(__dirname, "..", "ui", "renderer", "watch_pages_window.html")).href);
    const shots = process.env.WATCH_UI_SHOTS;
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await capture(win, shots, "watch-window");
      await win.webContents.executeJavaScript(`window.__reduce = true; document.querySelector('[data-futures="on"]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await capture(win, shots, "watch-window-futures");
      await win.webContents.executeJavaScript(`document.querySelector('[data-futures="on"]').click(); window.__reduce = false`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await win.webContents.executeJavaScript(`window.__calls.length = 0`);
    }
    await win.webContents.executeJavaScript(`(${checks.toString()})()`);
    console.log("watch pages window ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("watch pages window ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
