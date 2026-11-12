const { makeTempDir } = require("./support/temp_dirs.cjs");
// 設定 in a real Chromium (run with Electron): the real settings.html and its modules against a fake backend, every
// category drawn with the settings-style controls (styles/components/settings.css). Checked:
//  * every category opens, uses the shared group cards and rows, and keeps no old card / table markup;
//  * a disabled .btn is faded (base.css), app-wide;
//  * a success floats at the top and goes by itself; an error stays left of its group's buttons;
//  * 資金 shows amounts in 萬 and saves the full amount; a typed "." does not go in, a pasted "1,000" keeps its
//    digits; a saved amount that is not whole 萬 is shown as it is, marked, and its group cannot be saved;
//  * 清除金鑰 asks once more and sends nothing when the answer is no;
//  * 資料儲存's location is one row (long paths shortened in the middle, the whole path on hover) with a line under it
//    only while the chosen folder is not the one in use;
//  * 系統 lists each service once with its port (✓ when seen listening) and no 工作量; 編輯連接埠 adds the inputs, the
//    revision lines, and the steps; 完成 with an unsaved port asks first;
//  * the Google Form block opens with the expand motion and a second click while it moves is ignored;
//  * 訂閱管理 draws the server's rows and quota; a switch changes its pill at once, asks for a preview and saves only
//    that change; 期貨 opens the months under the row with the motion; an instrument only in a holding cannot be
//    removed from a page.
// With SETTINGS_UI_SHOTS=<folder> each category is also saved as a PNG there (for comparing with the sample).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-settings-ui-"));
app.on("window-all-closed", () => {});

async function setup(base, settingsHtml) {
  const calls = [];
  window.__calls = calls;
  window.__confirms = [];
  window.__confirmAnswer = true;
  const services = [
    { service_id: "app_api", display_name: "頁面 API", kind: "api", default_port: 8001, listener: true },
    { service_id: "market_runtime", display_name: "即時行情（Rust A）", kind: "runtime", default_port: 8010, listener: true },
    { service_id: "analysis_runtime", display_name: "累積計算（Rust B）", kind: "runtime", default_port: null, listener: false },
  ];
  const snapshotService = (sid, name, cpu, port) => ({ service_id: sid, display_name: name, state: "RUNNING", pid: 4100,
    resources: { availability: "OK", cpu_percent: cpu, memory_bytes: 146e6 },
    addresses: port ? { default: { port }, effective: { port, source: "default" }, observed: { port, verified: true } } : {},
    metrics: { availability: "OK", document: { metrics: [{ name: "http.requests_total", value: 3551 }] } } });
  const snapshot = { sampled_at: new Date().toISOString(), detail_collected: true, totals: { unique_pids: 3, cpu_percent_unique_pids: 3.4, memory_bytes_unique_pids: 1.62e9 },
    health: { collection_cost_ms: 18 }, config: { effective_revision: 3 },
    services: [snapshotService("app_api", "頁面 API", 0.9, 8001), snapshotService("market_runtime", "即時行情（Rust A）", 2.1, 8010),
      { ...snapshotService("analysis_runtime", "累積計算（Rust B）", 1.3, null), addresses: {} }],
    trend: Array.from({ length: 30 }, (_, i) => ({ t: i, services: { app_api: { cpu: 0.5 + (i % 5) / 10 }, market_runtime: { cpu: 2 + (i % 3) / 5 } } })) };
  const subs = {
    ok: true, revision: 5, background: [],
    pages: [{ id: "p1", name: "台股", source: "shioaji", items: [{ code: "2330", name: "台積電" }, { code: "2317", name: "鴻海" }] },
      { id: "p2", name: "美股", source: "futu", items: [{ code: "US.AAPL", name: "蘋果" }] }],
    preferences: { instruments: [], taiex: true, txf: true, sector: { enabled: true, scope: "related" }, batches: [] },
    instruments: [
      { source: "shioaji", market: "STK", code: "2317", name: "鴻海", pages: ["p1"], owners: ["watchlist"], trade: true, orderbook: true, listed: true, locked: false },
      { source: "shioaji", market: "STK", code: "2330", name: "台積電", pages: ["p1"], owners: ["watchlist", "holdings"], trade: true, orderbook: true, listed: true, locked: false,
        futures: { on: false, trade: true, orderbook: true, months: [], category: "CDF", name: "台積電期", months_listed: ["202611", "202612", "202703"] } },
      { source: "shioaji", market: "STK", code: "2603", name: "長榮", pages: [], owners: ["holdings"], trade: true, orderbook: true, listed: true, locked: false },
      { source: "futu", market: "US", code: "US.AAPL", name: "蘋果", pages: ["p2"], owners: ["watchlist"], trade: true, orderbook: false, listed: true, locked: false },
    ],
    sector_indexes: { listed: [{ code: "IX0028", name: "半導體類指數" }], related: 1, all: 54 },
    quota: { shioaji: { trade: 3, orderbook: 3, index: 2, futures: 1, used: 9, limit: 480, connections: 3, per_connection: 200 }, futu: { base: 2, trade: 1, orderbook: 0, used: 3,
      known: true, limit: 80, streams: 100, used_by_others: 0, draining: 2,
      draining_pairs: [{ code: "US.AAPL", lane: "ORDER_BOOK" }, { code: "US.TSLA", lane: "QUOTE" }] } },
    futures: { categories: { CDF: { name: "台積電期", underlying_code: "2330", months: ["202611", "202612", "202703"] } }, stocks: { 2330: ["CDF"] } },
  };
  const longRoot = "E:\\StockMonitor\\data\\history-and-models\\very-long-folder-name";
  const state = {
    capital: { actual: { 台股: { daily_limit: 500000 }, 美股: { daily_limit: 12345 } }, paper: { 台股: { initial_principal: 1000000, daily_limit: 300000, fee_discount: 0 } } },
  };
  window.desktopAPI = {
    // The question main asks (dialog:confirm); the page never calls window.confirm.
    confirm: async (text) => { window.__confirms.push(text); return window.__confirmAnswer; },
    networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } },
    sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} },
    colorPreferences: {},
    setColorPreferences: async (payload) => payload,
    onColorPreferencesChanged: () => () => {},
    getProviderSdkStatus: async () => ({ canInstall: true, providers: { shioaji: { installed: true }, futu: { installed: false } } }),
    onProviderSdkProgress: () => () => {},
    installProviderSdk: async () => ({ ok: true }),
    getAutostart: async () => ({ available: true, enabled: true }),
    setAutostart: async (enabled) => ({ enabled }),
    getMonitoringSnapshot: async () => ({ ok: true, snapshot }),
    requestMonitoringDetail: async () => ({}),
    getNetworkOperations: async () => ({ operations: [] }),
    previewNetworkApply: async () => ({ ok: true, plan: { affected: ["app_api"], self: [] } }),
    applyNetworkRevision: async () => ({ ok: true }),
    pickFolder: async () => longRoot,
  };
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input?.url || input));
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    const p = url.pathname;
    // The store the page reads back after every save or clear.
    if (p === "/api/settings/shioaji/credentials") {
      if (method === "DELETE") window.__shioajiStored = false;
      if (method === "PUT") window.__shioajiStored = true;
      return json({ ok: true, configured: window.__shioajiStored !== false, backend_available: true });
    }
    if (p === "/api/config/broker_connections") {
      if (method === "PUT") {
        await window.__brokerGate;
        return json({ ok: true, revision: 5 });
      }
      return json({ ok: true, pointer: { latest: 4 }, latest: { values: { shioaji: { connections: 3, per_connection_limit: 200 } } },
        choices: { defaults: { shioaji: { connections: 3, per_connection_limit: 200 } }, shioaji: { connections: { min: 1, max: 4 }, per_connection_limit: { options: [100, 200, 500] } } } });
    }
    if (p === "/api/shioaji/status") return json({ ok: true, shioaji_connected: true, subscription_connections: { open: [{ connection: 1, streams: 168, room: 200 }] }, active_subscription_count: 168 });
    if (p === "/api/actual-account/config") return json({ ok: true, gas_url: "https://script.google.com/macros/s/AKfy/exec", has_token: true, auto_sync_on_page_open: true });
    if (p === "/api/actual-account/status") return json({ ok: true, last_sync_success_at: "2026-11-01T09:12:00" });
    if (p === "/api/actual-account/bridge/status") return json({ ok: true, mobile_publish: { last_publish_at: "2026-11-01T09:12:00+08:00" } });
    if (p === "/api/actual-account/sync") {
      await window.__syncGate;
      return json({ ok: false, error: "GAS 沒有回應" });
    }
    if (p === "/api/actual-account/mobile-publish/now") return json({ ok: true, entry_count: 3 });
    if (p === "/api/actual-account/rebuild") {
      return json(window.__rebuildOk ? { ok: true, realized_matches: 7 } : { ok: false, error: "帳本計算失敗" });
    }
    if (p === "/api/actual-account/capital" || p === "/api/paper-wallet/capital") {
      const ledger = p.startsWith("/api/actual") ? "actual" : "paper";
      if (method === "POST") {
        state.capital[ledger] = Object.fromEntries(Object.entries(body.markets).map(([m, f]) => [m, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v)]))]));
      }
      return json({ ok: true, markets: state.capital[ledger] });
    }
    if (p === "/api/config/storage_retention") {
      return json({ ok: true, pointer: { latest: 2, active: 2 }, latest: { values: { sources: { shioaji: { persist: true, retention_days: 20 }, futu: { persist: false, retention_days: null } } } } });
    }
    if (p === "/api/config/training_data") return json({ ok: true, pointer: { latest: 1, active: 1 }, latest: { values: { retention_days: 250, window_trading_days: 20 } } });
    if (p === "/api/config/closing_data") return json({ ok: true, pointer: { latest: 1, active: 1 }, latest: { values: { url: "" } } });
    if (p === "/api/config/query_cache") return json({ ok: true, pointer: { latest: 1, active: 1 }, latest: { values: { retention_days: 7 } } });
    if (p === "/api/config/kbar_retention") return json({ ok: true, pointer: { latest: 1, active: 1 }, latest: { values: { months: { 1: 3, 5: 5, 15: 7, 30: 9, 60: 11 } } } });
    if (p === "/api/config/storage_location") {
      if (window.__storageLocation) return json(window.__storageLocation);
      return json({ ok: true, pointer: { latest: 1, active: 1 }, latest: { values: { historical_root: "D:\\LM_STK" } }, active: { values: { historical_root: "D:\\LM_STK" } } });
    }
    if (p === "/api/config/network") return json({ ok: true, pointer: { latest: 3, active: 3 }, manifest: { services }, latest: { values: { services: {} } } });
    if (p === "/api/subscriptions") return json(subs);
    if (p === "/api/subscriptions/ops") {
      if (window.__subsRefuse) return json({ ok: false, error: "QUOTA_EXCEEDED", message: "永豐超過上限" }, 409);
      // The fake server keeps what it is sent, as settings_api does.
      for (const op of body.ops) {
        const row = subs.instruments.find((r) => r.code === op.code);
        if (!row) continue;
        if (op.field === "futures") row.futures.on = op.value; else row[op.field] = op.value;
        if (op.field === "orderbook" && op.value === false) subs.quota.shioaji.used -= 1;
      }
      return json({ ...subs, revision: 6, skipped: [] });
    }
    if (p === "/api/config/network/validate") return json({ ok: true, impact: { changed_services: ["app_api"], effect_mode: "restart" } });
    return json({ ok: false, error: `unexpected ${p}` }, 404);
  };
  // Every category starts closed and the motion is not waited for: reduced motion only where a test says so.
  window.__reduce = false;
  const realMatch = window.matchMedia.bind(window);
  window.matchMedia = (query) => (query.includes("reduced-motion") ? { matches: window.__reduce, media: query } : realMatch(query));
  localStorage.clear();
  document.getElementById("pageContainer").innerHTML = settingsHtml;
  const page = await import(`${base}js/pages/settings.js`);
  page.initSettingsPage();
  await page.refreshSettingsPage();
  window.__page = page;
  window.__storagePage = await import(`${base}js/pages/settings_storage.js`);
}

async function checks() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (message) => { throw new Error(message); };
  const $ = (id) => document.getElementById(id);
  const show = (section) => { document.querySelector(`[data-settings-section="${section}"]`).click(); };
  const css = (node, name) => getComputedStyle(node)[name];
  const toastTexts = () => [...$("settingsToast").querySelectorAll(".settings-toast-text")].map((node) => node.textContent);
  await wait(300);

  // ---- the frame: every category, the shared controls, nothing of the old markup
  for (const section of ["display", "broker", "subscription", "account", "capital", "storage", "system"]) {
    show(section);
    const panel = document.querySelector(`[data-settings-panel="${section}"]`);
    if (panel.hidden) fail(`${section} opens`);
    if (!panel.querySelector(".settings-page-title") || !panel.querySelector(".settings-group")) fail(`${section} uses the page title and group cards`);
    if (panel.querySelector("table, .settings-card, .finance-status-pill")) fail(`${section} keeps old markup`);
  }
  if (document.querySelector(".settings-nav-item:disabled")) fail("every category is a page");
  const navOrder = [...document.querySelectorAll(".settings-nav-item")].map((b) => b.textContent.trim());
  if (navOrder.join(",") !== "顯示,券商帳號,訂閱管理,實際帳務,資金,資料儲存,系統") fail(`nav order ${navOrder}`);

  // ---- a disabled .btn is faded, a live one is not
  show("storage");
  const save = $("storageSaveBtn");
  if (!save.disabled || css(save, "opacity") !== "0.4") fail(`a disabled button is faded (${save.disabled}, ${css(save, "opacity")})`);
  // K 棒保存: one row for 1 and 3 minutes, one row per coarser timeframe, the daily bars forever and not editable.
  const kbarRows = [...$("kbarRetentionGroup").querySelectorAll(".settings-item")].map((row) => row.textContent);
  if (!kbarRows[0].startsWith("1、3 分 K") || kbarRows.length !== 6 || !kbarRows[5].includes("永久")) fail(`K 棒保存 rows: ${JSON.stringify(kbarRows)}`);
  if ($("kbarRetentionGroup").querySelector('[data-kbar-tier="1"]').value !== "3") fail("the saved months are selected");
  if ($("kbarRetentionGroup").querySelector('[data-kbar-tier="3"]')) fail("3 minutes shares 1 minute's row");
  if (css($("storageLocationPickBtn"), "opacity") !== "1") fail("a live button is not faded");

  // ---- 資料儲存: one row for the location, a line under it only while the chosen folder is not the one in use
  if ($("storageLocationPath").textContent !== "D:\\LM_STK" || !$("storageLocationPending").hidden) fail("the location in use, no line under it");
  $("storageLocationPickBtn").click();
  await wait(50);
  const shown = $("storageLocationPath").textContent;
  if (!shown.includes("…") || $("storageLocationPath").title !== "") fail(`a long path is shortened in the middle: ${shown}`);
  if ($("storageLocationPending").hidden || !$("storageLocationPending").textContent.includes("目前使用 D:\\LM_STK")) fail("a chosen folder says it is not in use yet");
  if (save.disabled) fail("a chosen folder can be saved");
  if (document.querySelector("#storageLocationInput, [data-settings-panel=storage] input[type=text]:not(#closingDataUrl)")) fail("no typed location");
  const persist = document.querySelectorAll('#storageRetentionGroup input.settings-switch');
  if (persist.length !== 2 || !persist[0].checked || persist[1].checked) fail("each source is a switch");
  if (document.querySelectorAll('#storageRetentionGroup select').length !== 1) fail("only a kept source has its 保存 row");
  // A saved folder on its way: the copy's progress under the row, followed without reopening the page.
  const onTheWay = (apply_operation, pointer = { latest: 2, active: 1 }) => ({ ok: true, pointer, latest: { values: { historical_root: "E:\\LM_STK" } },
    active: { values: { historical_root: "D:\\LM_STK" } }, apply_operation });
  const pendingLine = () => $("storageLocationPending").textContent;
  window.__storagePage.disposeStorageSettings();
  window.__storageLocation = onTheWay({ revision: 2, state: "copying", progress: { state: "copying", bytes_done: 1024 ** 3, bytes_total: 4 * 1024 ** 3 }, error: null });
  window.__storagePage.initStorageSettings();
  await wait(100);
  if (!pendingLine().includes("1.0 GB / 4.0 GB（25%）") || !pendingLine().includes("App 可照常使用")) fail(`copy progress: ${pendingLine()}`);
  window.__storageLocation = onTheWay({ revision: 2, state: "synced", error: null });
  await wait(2300);
  if (!pendingLine().includes("已複製完成") || !pendingLine().includes("目前使用 D:\\LM_STK")) fail(`the line follows the journal: ${pendingLine()}`);
  window.__storageLocation = onTheWay({ revision: 2, state: "rolled_back", error: "no space" });
  await wait(2300);
  if (!pendingLine().includes("no space") || !pendingLine().includes("舊資料未變動")) fail(`a failed copy says so: ${pendingLine()}`);
  window.__storageLocation = onTheWay({ revision: 2, state: "activated", error: null }, { latest: 2, active: 2 });
  await wait(2300);
  if (!pendingLine().includes("正在背景刪除舊資料夾")) fail(`the old folder's delete: ${pendingLine()}`);
  window.__storageLocation = onTheWay({ revision: 2, state: "done", error: null }, { latest: 2, active: 2 });
  await wait(2300);
  if (!$("storageLocationPending").hidden) fail("done: no line, and the polling stops");
  const reads = window.__calls.filter((c) => String(c.path ?? c.url ?? c).includes("storage_location")).length;
  await wait(2300);
  if (window.__calls.filter((c) => String(c.path ?? c.url ?? c).includes("storage_location")).length !== reads) fail("nothing under way: no polling");
  window.__storageLocation = null;

  // ---- 資金: 萬, whole numbers, the full amount saved
  show("capital");
  const amount = (ledger, market, field) => document.querySelector(`[data-capital-ledger="${ledger}"] [data-capital-market="${market}"][data-capital-field="${field}"]`);
  const twLimit = amount("actual", "台股", "daily_limit"), usLimit = amount("actual", "美股", "daily_limit");
  if (twLimit.value !== "50") fail(`500000 shows as 50 萬 (${twLimit.value})`);
  if (usLimit.value !== "1.2345" || !usLimit.classList.contains("is-invalid")) fail(`12345 shows as it is and is marked (${usLimit.value})`);
  const actualActions = document.querySelector('[data-capital-actions="actual"]');
  if (!actualActions.querySelector("[data-capital-save]").disabled) fail("a group with a part of 萬 cannot be saved");
  if (!actualActions.querySelector(".settings-actions-note").textContent.includes("整數萬")) fail("and says why left of 儲存");
  if (document.querySelector('[data-capital-actions="paper"] [data-capital-save]').disabled) fail("the other group is unaffected");
  const typed = new InputEvent("beforeinput", { inputType: "insertText", data: ".", cancelable: true });
  usLimit.dispatchEvent(typed);
  if (!typed.defaultPrevented) fail("a typed decimal point does not go in");
  usLimit.value = "1,000";
  usLimit.dispatchEvent(new Event("input"));
  if (usLimit.value !== "1000" || usLimit.classList.contains("is-invalid")) fail(`a pasted 1,000 keeps its digits (${usLimit.value})`);
  const capitalSave = actualActions.querySelector("[data-capital-save]");
  if (capitalSave.disabled) fail("whole 萬 can be saved");
  capitalSave.click();
  await wait(100);
  const posted = window.__calls.filter((c) => c.method === "POST" && c.path === "/api/actual-account/capital").pop();
  if (posted?.body?.markets?.美股?.daily_limit !== "10000000" || posted.body.markets.台股.daily_limit !== "500000") fail(`the full amount is saved: ${JSON.stringify(posted?.body)}`);
  if ($("settingsToast").hidden || !toastTexts().some((t) => t.includes("實際帳務資金設定已儲存"))) fail("a success floats");
  const toastBox = $("settingsToast").lastElementChild.getBoundingClientRect();
  if (toastBox.top > 40 || Math.abs(toastBox.left + toastBox.width / 2 - innerWidth / 2) > 2) fail(`the floating message is at the top centre (${JSON.stringify(toastBox)})`);

  // ---- 實際帳務: the three actions run at the same time, each with its own note left of the group's buttons; one
  // finishing or failing never clears or replaces another's that is still running.
  show("account");
  let releaseSync;
  window.__syncGate = new Promise((resolve) => { releaseSync = resolve; });
  const syncNote = $("actualAccountSyncMessage"), publishNote = $("actualAccountMobilePublishMessage"), rebuildNote = $("actualAccountRebuildMessage");
  $("actualAccountSettingsSyncBtn").click();
  await wait(50);
  if (syncNote.textContent !== "正在同步 Google Sheet…") fail(`a running sync says so (${syncNote.textContent})`);
  $("actualAccountMobilePublishBtn").click();
  $("actualAccountSettingsRebuildBtn").click();
  await wait(100);
  if (syncNote.textContent !== "正在同步 Google Sheet…") fail(`a finished publish and a failed rebuild keep the running sync's note (${syncNote.textContent})`);
  if (publishNote.textContent) fail(`a finished publish clears only its own note (${publishNote.textContent})`);
  if (!rebuildNote.classList.contains("is-error") || !rebuildNote.textContent) fail(`a failed rebuild stays in its own note (${rebuildNote.className} ${rebuildNote.textContent})`);
  if (!toastTexts().some((t) => t.includes("手機資料已上傳"))) fail("the finished publish floats its result");
  releaseSync();
  await wait(100);
  window.__syncGate = undefined;
  if (!syncNote.classList.contains("is-error") || !syncNote.textContent.includes("同步")) fail(`a failed sync stays beside its buttons (${syncNote.className} ${syncNote.textContent})`);
  if (!rebuildNote.classList.contains("is-error") || !rebuildNote.textContent) fail("the sync's failure does not replace the rebuild's");
  // Two actions that succeed together both float their result (D08-08): one never replaces the other. (Reduced motion
  // while the earlier messages leave: a hidden window runs their leave motion far slower than a shown one.)
  window.__reduce = true;
  await wait(2900);
  window.__reduce = false;
  if (!$("settingsToast").hidden) fail(`the earlier messages are gone (${toastTexts()})`);
  window.__rebuildOk = true;
  $("actualAccountMobilePublishBtn").click();
  $("actualAccountSettingsRebuildBtn").click();
  await wait(150);
  const both = toastTexts();
  if (!both.some((t) => t.includes("手機資料已上傳")) || !both.some((t) => t.includes("重新計算完成：7"))) fail(`both results float at once: ${both}`);
  const capsules = [...$("settingsToast").querySelectorAll(".settings-toast")].map((n) => n.getBoundingClientRect());
  if (capsules.length !== 2 || capsules[0].bottom > capsules[1].top) fail(`one capsule under the other (${JSON.stringify(capsules)})`);
  if (publishNote.textContent || rebuildNote.textContent) fail("a success leaves its note empty");
  window.__rebuildOk = false;
  const notes = syncNote.parentElement;
  if (notes.nextElementSibling !== $("actualAccountSettingsRebuildBtn") || notes.querySelectorAll(".settings-actions-note").length !== 4) fail("the notes are left of the buttons");
  const lines = [rebuildNote, syncNote].map((n) => n.getBoundingClientRect());
  if (lines[0].bottom > lines[1].top + 1 || Math.abs(lines[0].left - lines[1].left) > 1) fail(`each note is a line of its own (${JSON.stringify(lines)})`);
  // The Google Form block opens with the motion; a click while it moves is ignored.
  $("actualAccountSettingsFormToggle").click();
  const form = $("actualAccountSettingsFormGroup");
  if (form.hidden || !form.getAnimations().length) fail("Google Form opens with the expand motion");
  $("actualAccountSettingsFormToggle").click();
  if (form.hidden || $("actualAccountSettingsFormToggle").getAttribute("aria-expanded") !== "true") fail("a click while it moves is ignored");
  await wait(450);
  $("actualAccountSettingsFormToggle").click();
  if (form.hidden) fail("closing keeps it drawn while it closes");
  await wait(350);
  if (!form.hidden) fail("closed after the motion");

  // ---- 券商帳號: 清除金鑰 asks first
  show("broker");
  window.__confirmAnswer = false;
  const deletes = () => window.__calls.filter((c) => c.method === "DELETE").length;
  $("shioajiCredentialsClearBtn").click();
  await wait(50);
  if (window.__confirms.length !== 1 || deletes() !== 0) fail("清除金鑰 asks and a no sends nothing");
  window.__confirmAnswer = true;
  $("shioajiCredentialsClearBtn").click();
  await wait(100);
  if (deletes() !== 1 || $("shioajiCredentialsStatus").textContent !== "未設定") fail("a yes clears");
  const clear = $("shioajiCredentialsClearBtn");
  if (clear.nextElementSibling !== $("shioajiCredentialsSaveBtn") || css(clear, "boxShadow") === "none") fail("the danger action is outlined, left of the main one");
  if ($("brokerConnectionsUsage").textContent !== "1 條・168 個（第 1 條 168／200）") fail(`usage line: ${$("brokerConnectionsUsage").textContent}`);
  // 永豐行情連線's 儲存 (D08-11): disabled with nothing changed; a change enables it; while the save is out a change of
  // option leaves it disabled, and it comes back only from what is left to save once the save is answered.
  const brokerSave = $("brokerConnectionsSaveBtn");
  const pick = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event("change")); };
  if (!brokerSave.disabled) fail("永豐行情連線: nothing changed, nothing to save");
  pick("brokerConnectionsMax", "4");
  if (brokerSave.disabled) fail("永豐行情連線: a change can be saved");
  let releaseBroker;
  window.__brokerGate = new Promise((resolve) => { releaseBroker = resolve; });
  brokerSave.click();
  await wait(50);
  if (!brokerSave.disabled) fail("永豐行情連線: disabled while the save is out");
  pick("brokerConnectionsLimit", "500");
  await wait(50);
  if (!brokerSave.disabled || css(brokerSave, "opacity") !== "0.4") fail("永豐行情連線: a change of option while saving does not enable 儲存");
  releaseBroker();
  await wait(150);
  window.__brokerGate = undefined;
  if (!toastTexts().some((t) => t.includes("已儲存並生效"))) fail("永豐行情連線: the save floats its message");

  // ---- 訂閱管理: the server's rows and quota; a switch takes effect at once, only that change is sent; 期貨 and its months; a refused change goes back
  show("subscription");
  await wait(100);
  const subRows = () => [...$("subStockRows").querySelectorAll(":scope > .settings-item")];
  if (subRows().map((r) => r.querySelector(".settings-item-code").textContent).join(",") !== "2317,2330,2603") fail("the stocks of the pages and holdings");
  if ($("subShioajiUsed").textContent !== "9" || $("subShioajiLimit").textContent !== "480") fail("the quota");
  if ($("subShioajiConns").querySelectorAll("span").length !== 3) fail("one line per connection");
  // 富途: OpenD's quota by type (background share of 100), 退訂中 in the bar and on the rows OpenD still holds.
  if ($("subFutuUsed").textContent !== "3" || $("subFutuLimit").textContent !== "80") fail("the Futu quota of OpenD's");
  if (!$("subFutuNote").textContent.includes("OpenD 額度 100") || !$("subFutuNote").textContent.includes("退訂中 2")) fail(`Futu note: ${$("subFutuNote").textContent}`);
  if (!$("subFutuBar").querySelector(".is-draining")) fail("退訂中 is a part of the Futu bar");
  const futuRows = [...$("subFutuRows").querySelectorAll(":scope > .settings-item")];
  if (futuRows.map((r) => r.querySelector(".settings-item-code").textContent).join(",") !== "US.AAPL,US.TSLA") fail("a removed product OpenD still holds stays listed");
  if (!futuRows.every((r) => r.textContent.includes("1 分鐘後退訂"))) fail("each row OpenD still holds a type of says 1 分鐘後退訂");
  if (futuRows[1].querySelector("button")) fail("the leaving row has nothing to press");
  if (!subRows()[2].querySelector("[data-remove-row]").disabled) fail("a stock only in a holding cannot be removed from a page");
  if ($("subSaveBtn") || $("subResetBtn")) fail("no 儲存 or 還原: a change takes effect at once");
  const book = subRows()[0].querySelector('[data-lane="orderbook"]');
  book.click();
  await wait(0);
  if (book.classList.contains("is-active")) fail("the pill changes at once");
  await wait(150);
  const sent = () => window.__calls.filter((c) => c.path === "/api/subscriptions/ops");
  const opsOf = (call) => call?.body?.ops?.map((o) => `${o.code}.${o.field}=${o.value}`).join(",");
  if (window.__calls.some((c) => c.path === "/api/subscriptions/preview")) fail("no preview: the change itself is sent");
  if (sent().length !== 1 || opsOf(sent()[0]) !== "2317.orderbook=false" || !sent()[0].body.batch_id) fail(`one change, sent at once: ${opsOf(sent()[0])}`);
  if ($("subShioajiUsed").textContent !== "8" || subRows()[0].querySelector('[data-lane="orderbook"]').classList.contains("is-active")) fail("the answer is the new state");
  subRows()[1].querySelector('[data-futures="on"]').click();
  await wait(0);
  const months = $("subStockRows").querySelector('[data-sub-key="shioaji:STK:2330"]');
  if (!months || !months.getAnimations().length) fail("期貨 opens the months with the motion");
  if (months.querySelectorAll(".is-locked").length !== 1 || months.querySelectorAll("[data-sub-month]").length !== 2) fail("the near month locked, the other months pressable");
  await wait(450);
  if (sent().length !== 2 || opsOf(sent()[1]) !== "2330.futures=true") fail(`each change on its own, over the answer to the one before: ${opsOf(sent()[1])}`);
  window.__subsRefuse = true;
  subRows()[1].querySelector('[data-lane="trade"]').click();
  await wait(150);
  window.__subsRefuse = false;
  if (!subRows()[1].querySelector('[data-lane="trade"]').classList.contains("is-active")) fail("a refused change goes back");
  if (!$("subMessage").textContent.includes("沒有生效")) fail(`a refused change says so: ${$("subMessage").textContent}`);

  // ---- 系統: one row per service, the port, no 工作量; 編輯連接埠
  show("system");
  await wait(2300);
  const rows = () => [...$("systemServiceRows").querySelectorAll(":scope > .settings-item")];
  const names = rows().map((r) => r.querySelector("b").textContent);
  if (names.join(",") !== "頁面 API,即時行情（Rust A）,累積計算（Rust B）") fail(`services: ${names}`);
  if (!rows()[0].textContent.includes("8001 ✓") || !rows()[2].textContent.includes("本機程序／IPC")) fail("the port in use, ✓ when listening");
  if (/請求|工作量/.test($("systemServiceRows").textContent)) fail("no 工作量");
  // Every row's CPU and memory sit in the same columns -- the services' (CPU 3rd, memory 5th cell) and 總計's -- and
  // a wider state ("執行中但無法服務") moves nothing after it.
  const columnsAligned = (when) => {
    const edges = (node) => { const box = node.getBoundingClientRect(); return `${Math.round(box.left)}-${Math.round(box.right)}`; };
    const cells = [...rows().map((r) => [r.children[2], r.children[4], r.querySelector("b").textContent]), [$("systemTotalsCpu"), $("systemTotalsMemory"), "總計"]];
    const [cpu, memory] = [edges(cells[0][0]), edges(cells[0][1])];
    for (const [c, m, name] of cells) {
      if (edges(c) !== cpu || edges(m) !== memory) fail(`${when}: ${name}'s CPU ${edges(c)} / memory ${edges(m)} vs ${cpu} / ${memory}`);
    }
  };
  columnsAligned("not editing");
  if ($("systemPortsPendingPill").textContent !== "連接埠已同步" || !$("systemPortsEditInfo").hidden || !$("systemPortsActions").hidden) fail("not editing: the state only");
  window.__reduce = true;
  $("systemPortsEditToggle").click();
  await wait(50);
  if ($("systemPortsEditToggle").textContent !== "完成" || $("systemPortsEditInfo").hidden || $("systemPortsActions").hidden) fail("editing shows the revision lines and the steps");
  const input = $("systemServiceRows").querySelector('input[data-port-service="app_api"]');
  if (!input || input.placeholder !== "8001") fail("an editable service has its input, the default as placeholder");
  columnsAligned("editing");
  input.focus();
  input.value = "8101";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(2300);
  if (!input.isConnected || input.value !== "8101" || document.activeElement !== input) fail("a port being typed survives the 2 s redraw");
  if ($("systemPortsSaveBtn").disabled) fail("a changed port can be saved");
  window.__confirmAnswer = false;
  $("systemPortsEditToggle").click();
  await wait(50);
  if ($("systemPortsEditToggle").textContent !== "完成" || window.__confirms.length !== 3) fail("完成 with an unsaved port asks, and a no keeps editing");
  window.__confirmAnswer = true;
  $("systemPortsEditToggle").click();
  await wait(50);
  if ($("systemPortsEditToggle").textContent !== "編輯連接埠" || !$("systemPortsActions").hidden) fail("a yes discards and closes");
  window.__reduce = false;

  // ---- the floating message goes by itself
  await wait(2900);
  if (!$("settingsToast").hidden) fail("the floating message goes after about 2.5 s");
  return { ok: true };
}

async function capture(win, dir, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: false, backgroundThrottling: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const renderer = path.join(__dirname, "..", "ui", "renderer");
  const base = pathToFileURL(renderer + path.sep).href;
  const settingsHtml = fs.readFileSync(path.join(renderer, "pages", "settings.html"), "utf8");
  try {
    await win.webContents.executeJavaScript(`document.body.style.height = "100vh"; document.getElementById("pageContainer").style.height = "100vh";`);
    await win.webContents.executeJavaScript(`(${setup.toString()})(${JSON.stringify(base)}, ${JSON.stringify(settingsHtml)})`);
    const shots = process.env.SETTINGS_UI_SHOTS;
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      for (const section of ["display", "broker", "subscription", "account", "capital", "storage", "system"]) {
        await win.webContents.executeJavaScript(`document.querySelector('[data-settings-section="${section}"]').click()`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await capture(win, shots, `app-${section}`);
        if (section === "subscription") {
          // The rest of the page: a stock's futures months open, 產業指數, 富途 and the buttons.
          await win.webContents.executeJavaScript(`window.__reduce = true; document.querySelector('#subStockRows [data-futures="on"]').click();
            document.querySelector(".settings-page-scroll").scrollTop = 520; window.__reduce = false`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          await capture(win, shots, "app-subscription-lower");
          await win.webContents.executeJavaScript(`document.querySelector(".settings-page-scroll").scrollTop = 0`);
        }
      }
      await win.webContents.executeJavaScript(`window.__reduce = true; document.getElementById("systemPortsEditToggle").click()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await capture(win, shots, "app-system-editing");
      await win.webContents.executeJavaScript(`window.__confirmAnswer = true; document.getElementById("systemPortsEditToggle").click(); window.__reduce = false`);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    await win.webContents.executeJavaScript(`(${checks.toString()})()`);
    console.log("settings ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("settings ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
