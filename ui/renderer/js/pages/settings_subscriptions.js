// 設定 → 訂閱管理: what Shioaji and Futu keep subscribed -- 大盤 (加權指數, 台指期's TXFR1 Quote), every product of the
// product pages and holdings with its 明細／五檔／期貨 and months (台指期、小台指 are products with only months), the 產業指數, and the Futu products -- with the
// quota they take. The same pages and 訂閱偏好 as the 商品頁設定 window (decisions.md 訂閱清單在兩個地方管理):
// settings_api is their one writer (POST /api/subscriptions/ops), this page sends only what it changed, and every
// row, quota and sector list it draws is the server's (GET /api/subscriptions, or the answer to the last change). A
// change takes effect when it is made: it shows at once and is sent at once, one at a time in the order they were made,
// so each is laid over the answer to the one before; a refused change goes back to what the server has.

import { apiGet, apiJsonPost } from "../core/api.js";
import { escapeHtml } from "../core/utility.js";
import { morphInto } from "../core/dom_morph.js";
import { setNote, showToast } from "../core/settings_ui.js";
import { createExpandMotion } from "../core/expand_motion.js";
import { addOrMergeItem, normalizeItem } from "../features/watch_pages/watch_page_draft.js";
import { opsBatch } from "../features/watch_pages/watch_page_ops.js";
import {
  contextOf, createDraft, draftOpsOf, laneOf, rowKey, rows, sectorOf, setContext, setFutures, setLane,
  setSector, toggleMonth,
} from "../features/subscriptions/subscription_draft.js";

const $ = (id) => document.getElementById(id);
const OWNER_NAME = { holdings: "庫存", paper_holdings: "模擬庫存", paper_orders: "模擬掛單" };

let generation = 0;
let draft = null;
let work = Promise.resolve(); // every change and reload, in order
let pendingAdd = null;      // { source, item }: 加入 pressed, waiting for the page to add to
let pendingRemove = null;   // { key, pages: Set }: ✕ pressed, waiting for the pages to remove from
const searchResults = { shioaji: [], futu: [] };
const searchGeneration = { shioaji: 0, futu: 0 };
let unsubscribe = null;

function recordFailure(operation, target, detail) {
  console.warn(`[settings/subscriptions: ${operation} ${target}] failed`, detail);
}

function setMessage(text, isError = false) {
  setNote($("subMessage"), text, isError);
}

/** Runs `step` after everything before it has finished. */
function enqueue(operation, target, step) {
  work = work.then(step).catch((error) => {
    recordFailure(operation, target, error);
    setMessage(`${operation === "reading" ? "讀取" : "變更"}失敗：${error?.message || error}`, true);
  });
}

const monthLabel = (m) => `${m.slice(0, 4)}/${m.slice(4)}`;

// The months under each stock with 期貨 on open and close with the shared motion.
const motion = createExpandMotion({
  find: (key) => document.querySelector(`[data-settings-panel="subscription"] [data-sub-key="${CSS.escape(key)}"]`),
  redraw: () => render(),
});

// ---------------------------------------------------------------- drawing
function bar(node, parts, cap) {
  const total = Math.max(cap, Object.values(parts).reduce((a, b) => a + b, 0), 1);
  morphInto(node, Object.entries(parts).filter(([, n]) => n > 0)
    .map(([part, n]) => `<div class="settings-quota-part is-${part}" style="width:${(n / total) * 100}%"></div>`).join(""));
}

function renderQuota() {
  const quota = draft.view.quota;
  const s = quota.shioaji;
  $("subShioajiUsed").textContent = s.used;
  $("subShioajiLimit").textContent = s.limit;
  bar($("subShioajiBar"), { trade: s.trade, orderbook: s.orderbook, index: s.index, futures: s.futures }, s.limit);
  // Shioaji fills a connection before it opens the next (session.py _pick_connection).
  let left = s.used;
  const conns = Array.from({ length: s.connections }, () => { const n = Math.max(0, Math.min(s.per_connection, left)); left -= n; return n; });
  morphInto($("subShioajiConns"), conns.map((n, i) => `<span class="${n ? "is-on" : ""}"><i class="settings-quota-dot"></i>連線 ${i + 1}${n ? `　${n}` : ""}</span>`).join(""));
  // Futu against the background share of OpenD's quota, as OpenD said it (unknown while OpenD is not connected);
  // 退訂中 is what OpenD still holds outside the plan until its one-minute minimum is over.
  const f = quota.futu;
  $("subFutuUsed").textContent = f.used;
  $("subFutuLimit").textContent = f.known ? f.limit : "—";
  $("subFutuNote").textContent = !f.known ? "OpenD 未連線，額度未知"
    : `OpenD 額度 ${f.streams}${f.used_by_others ? `（其他連線用 ${f.used_by_others}）` : ""}${f.draining ? `・退訂中 ${f.draining}` : ""}`;
  bar($("subFutuBar"), { base: f.base, trade: f.trade, orderbook: f.orderbook, draining: f.draining }, f.known ? f.limit : f.used);
}

// Futu codes OpenD still holds a type of although the plan dropped it (關掉或移除後，滿 1 分鐘才能退訂).
const drainingCodes = () => new Set((draft.view.quota.futu.draining_pairs || []).map((p) => p.code));

function monthPills(key, months, chosen) {
  return months.map((m, i) => (i === 0
    ? `<span class="settings-pill is-accent is-active is-locked">近月 ${monthLabel(m)}</span>`
    : `<button type="button" class="settings-pill is-accent${chosen.has(m) ? " is-active" : ""}" data-sub-month="${escapeHtml(key)}" data-month="${m}" aria-pressed="${chosen.has(m)}">${monthLabel(m)}</button>`)).join("");
}

function lanePills(attrs, lane, locked = false) {
  const lock = locked ? " disabled" : "";
  return `<button type="button" class="settings-pill${lane.trade ? " is-active" : ""}" ${attrs} data-lane="trade" aria-pressed="${lane.trade}"${lock}>明細</button>`
    + `<button type="button" class="settings-pill${lane.orderbook ? " is-active" : ""}" ${attrs} data-lane="orderbook" aria-pressed="${lane.orderbook}"${lock}>五檔</button>`;
}

function renderContext() {
  const context = contextOf(draft);
  $("subTaiex").checked = context.taiex;
  $("subTxf").checked = context.txf;
}

// The pages a row is on as this window has them (the draft's pages, not only the server's).
function pagesWith(row) {
  return draft.pages.filter((p) => p.source === row.source && p.items.some((i) => i.code === row.code));
}

function removePicker(row) {
  if (pendingRemove?.key !== rowKey(row)) return "";
  const stays = row.owners.filter((o) => o !== "watchlist").map((o) => OWNER_NAME[o] || o).join("、");
  return `<div class="settings-item-sub" data-morph-key="remove:${escapeHtml(rowKey(row))}"><span class="settings-sub-label">從</span>`
    + pagesWith(row).map((p) => `<button type="button" class="settings-pill${pendingRemove.pages.has(String(p.id)) ? " is-active" : ""}" data-remove-page="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join("")
    + `<span class="settings-sub-label">移除${stays ? `（${escapeHtml(stays)}中，會繼續訂閱）` : ""}</span>`
    + `<span class="settings-sub-actions"><button type="button" class="btn secondary small-btn" data-cancel-pending>取消</button>`
    + `<button type="button" class="btn small-btn is-danger" data-confirm-remove${pendingRemove.pages.size ? "" : " disabled"}>移除</button></span></div>`;
}

function rowHtml(row) {
  const key = rowKey(row);
  const lane = laneOf(draft, row);
  const futu = row.source === "futu";
  const fut = lane.futures;
  // An index future (台指期、小台指): the product is its months, always shown; its 明細／五檔 are the row's own.
  const indexFuture = Boolean(row.index_futures);
  const onPages = pagesWith(row).length;
  const unsubscribed = !lane.trade && !lane.orderbook && !lane.locked && !futu;
  const futButton = fut && !indexFuture
    ? `<button type="button" class="settings-pill is-accent${fut.on ? " is-active" : ""}" data-row="${escapeHtml(key)}" data-futures="on" aria-pressed="${fut.on}">期貨</button>` : "";
  let html = `<div class="settings-item" data-morph-key="row:${escapeHtml(key)}">`
    + `<span class="settings-item-main"><span class="settings-item-code">${escapeHtml(row.code)}</span><b>${escapeHtml(row.name)}</b>`
    + (unsubscribed ? `<span class="settings-item-value">未訂閱</span>` : "")
    + (futu && drainingCodes().has(row.code) ? `<span class="settings-item-value">1 分鐘後退訂</span>` : "") + `</span>`
    + `<span class="settings-pills">${futButton}${lanePills(`data-row="${escapeHtml(key)}"`, lane, lane.locked)}</span>`
    + `<button type="button" class="settings-icon-btn is-danger" data-remove-row="${escapeHtml(key)}" ${onPages ? 'aria-label="從商品頁移除"' : "disabled"}>✕</button></div>`;
  if (fut && (fut.on || motion.closing(key))) {
    html += `<div class="settings-item-sub" data-sub-key="${escapeHtml(key)}" data-morph-key="sub:${escapeHtml(key)}">`
      + monthPills(key, fut.months_listed || [], fut.months)
      + (indexFuture ? "" : `<span class="settings-sub-actions">${lanePills(`data-row="${escapeHtml(key)}" data-futures-lane="1"`, fut)}</span>`)
      + `</div>`;
  }
  return html + removePicker(row);
}

function addPicker(source, item) {
  if (pendingAdd?.source !== source || pendingAdd.item.code !== item.code) return "";
  const pages = draft.pages.filter((p) => p.source === source);
  return `<div class="settings-item-sub" data-morph-key="add:${escapeHtml(item.code)}"><span class="settings-sub-label">加到</span>`
    + (pages.length ? pages.map((p) => `<button type="button" class="settings-pill" data-add-to="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join("")
      : `<span class="settings-sub-label">還沒有${source === "futu" ? "富途" : "永豐"}商品頁，請先在商品頁設定新增</span>`)
    + `<span class="settings-sub-actions"><button type="button" class="btn secondary small-btn" data-cancel-pending>取消</button></span></div>`;
}

function renderList(source) {
  const futu = source === "futu";
  const filter = $(futu ? "subFutuFilter" : "subStockFilter").value.trim();
  const q = filter.toUpperCase();
  const list = rows(draft, source).filter((row) => !q || row.code.toUpperCase().includes(q) || row.name.includes(filter));
  const listed = new Set(rows(draft, source).map((row) => row.code));
  // A removed Futu product OpenD still holds stays in the list until it is unsubscribed.
  const leaving = futu ? [...drainingCodes()].filter((code) => !listed.has(code) && (!q || code.includes(q))).sort() : [];
  morphInto($(futu ? "subFutuRows" : "subStockRows"), (list.map(rowHtml).join("")
    + leaving.map((code) => `<div class="settings-item" data-morph-key="leaving:${escapeHtml(code)}">`
      + `<span class="settings-item-main"><span class="settings-item-code">${escapeHtml(code)}</span><span class="settings-item-value">1 分鐘後退訂</span></span></div>`).join(""))
    || `<div class="settings-item" data-morph-key="empty"><span class="settings-item-value">${q ? "清單裡沒有符合的商品" : "清單是空的"}</span></div>`);
  const adds = q ? searchResults[source].filter((item) => !listed.has(item.code)).slice(0, 8) : [];
  $(futu ? "subFutuAddTitle" : "subStockAddTitle").hidden = !adds.length;
  const host = $(futu ? "subFutuAdd" : "subStockAdd");
  host.hidden = !adds.length;
  morphInto(host, adds.map((item) => `<div class="settings-item" data-morph-key="add-row:${escapeHtml(item.code)}">`
    + `<span class="settings-item-main"><span class="settings-item-code">${escapeHtml(item.code)}</span><b>${escapeHtml(item.name)}</b></span>`
    + `<span class="settings-item-value">${escapeHtml(item.industry_name || "")}</span>`
    + `<button type="button" class="btn primary small-btn" data-add="${escapeHtml(item.code)}" data-source="${source}">加入</button></div>`
    + addPicker(source, item)).join(""));
}

function renderSector() {
  const sector = sectorOf(draft);
  const counts = draft.view.sector_indexes;
  $("subSector").checked = sector.enabled;
  const choice = (scope, label, n) => `<button type="button" class="settings-item settings-choice" data-morph-key="scope:${scope}" data-sector-scope="${scope}">`
    + `<span class="settings-item-main"><b>${label}</b></span><span class="settings-item-value">${n} 個</span>`
    + `<span class="settings-checkmark">${sector.scope === scope ? "✓" : ""}</span></button>`;
  morphInto($("subSectorScope"), sector.enabled ? choice("related", "已訂個股所屬的產業", counts.related) + choice("all", "全部產業", counts.all) : "");
  const listed = counts.listed || [];
  $("subSectorListTitle").hidden = $("subSectorList").hidden = !listed.length;
  morphInto($("subSectorListTitle"), `<span>已訂 ${listed.length} 個</span>`);
  morphInto($("subSectorList"), listed.map((i) => `<div class="settings-item" data-morph-key="idx:${escapeHtml(i.code)}">`
    + `<span class="settings-item-main"><span class="settings-item-code">${escapeHtml(i.code)}</span><b>${escapeHtml(i.name)}</b></span></div>`).join(""));
}

function render() {
  if (!draft) return;
  renderQuota();
  renderContext();
  renderList("shioaji");
  renderList("futu");
  renderSector();
  motion.play();
}

// ---------------------------------------------------------------- the server
async function load(gen = generation) {
  const snapshot = await apiGet("/api/subscriptions");
  if (gen !== generation) return;
  if (!snapshot || snapshot.ok === false) throw new Error(snapshot?.message || snapshot?.error || "設定服務沒有回應");
  draft = createDraft(snapshot);
  render();
}

/** What the screen has changed, applied now; the answer is the new state. A refused change is taken back. */
async function applyChanges() {
  const ops = draftOpsOf(draft);
  if (!ops.length) return;
  const takeBack = (detail, message) => {
    recordFailure("saving", "POST /api/subscriptions/ops", detail);
    draft = createDraft(draft.base);
    render();
    setMessage(message, true);
  };
  let result;
  try {
    result = await apiJsonPost("/api/subscriptions/ops", opsBatch(ops, "settings_subscriptions"));
  } catch (error) {
    takeBack(error, `變更失敗：${error?.message || error}`);
    return;
  }
  if (!result || result.ok === false) {
    takeBack(result, result?.error === "QUOTA_EXCEEDED"
      ? `${result.message}，這個變更沒有生效`
      : `變更失敗：${result?.message || result?.error || "設定服務沒有回應"}`);
    return;
  }
  draft = createDraft(result);
  render();
  setMessage("");
  window.desktopAPI?.notifyWatchPagesChanged?.({ kind: "saved" });
  if (result.skipped?.length) showToast(`${result.skipped.length} 項已不存在、略過`);
}

function edited() {
  render();
  return applyChanges();
}

async function searchCatalog(source) {
  const input = $(source === "futu" ? "subFutuFilter" : "subStockFilter");
  const q = input.value.trim();
  const mine = ++searchGeneration[source];
  if (!q) {
    searchResults[source] = [];
    render();
    return;
  }
  try {
    const data = await window.desktopAPI?.searchProductCatalogLocal?.(source, q, "", 20);
    if (mine !== searchGeneration[source]) return;
    if (!data || data.ok === false) throw new Error(data?.error || "本機商品目錄查詢失敗");
    searchResults[source] = (data.items || []).map(normalizeItem).filter(Boolean);
  } catch (error) {
    recordFailure("searching", `the ${source} catalog for "${q}"`, error);
    // A newer search is on its way: only the current one's failure is shown.
    if (mine !== searchGeneration[source]) return;
    searchResults[source] = [];
    setMessage(`商品查詢失敗：${error?.message || error}`, true);
  }
  render();
}

// ---------------------------------------------------------------- events
function rowByKey(key) {
  return rows(draft).find((row) => rowKey(row) === key);
}

function onClick(event) {
  const target = event.target.closest("button");
  if (!target || target.disabled) return;
  const pressed = { id: target.id, d: { ...target.dataset } };
  enqueue("saving", "POST /api/subscriptions/ops", () => applyClick(pressed));
}

function applyClick({ id, d }) {
  if (!draft) return undefined;
  if (d.lane && d.row) {
    const row = rowByKey(d.row);
    const lane = laneOf(draft, row);
    if (d.futuresLane) setFutures(draft, row, d.lane, !lane.futures[d.lane]);
    else setLane(draft, row, d.lane, !lane[d.lane]);
  } else if (d.futures) {
    const row = rowByKey(d.row);
    const on = !laneOf(draft, row).futures.on;
    if (!motion.start(d.row, on)) return undefined;
    setFutures(draft, row, "on", on);
  } else if (d.subMonth) {
    toggleMonth(draft, rowByKey(d.subMonth), d.month);
  } else if (d.removeRow) {
    const row = rowByKey(d.removeRow);
    pendingAdd = null;
    pendingRemove = { key: d.removeRow, pages: new Set(pagesWith(row).map((p) => String(p.id))) };
  } else if (d.removePage) {
    if (pendingRemove.pages.has(d.removePage)) pendingRemove.pages.delete(d.removePage); else pendingRemove.pages.add(d.removePage);
  } else if (d.confirmRemove !== undefined) {
    const row = rowByKey(pendingRemove.key);
    draft.pages = draft.pages.map((p) => (pendingRemove.pages.has(String(p.id)) ? { ...p, items: p.items.filter((i) => i.code !== row.code) } : p));
    pendingRemove = null;
  } else if (d.cancelPending !== undefined) {
    pendingAdd = pendingRemove = null;
  } else if (d.add) {
    const item = searchResults[d.source].find((i) => i.code === d.add);
    pendingRemove = null;
    pendingAdd = item ? { source: d.source, item } : null;
  } else if (d.addTo) {
    draft.pages = draft.pages.map((p) => (String(p.id) === d.addTo ? addOrMergeItem(p, { ...pendingAdd.item, source: p.source }).page : p));
    pendingAdd = null;
  } else if (d.sectorScope) {
    setSector(draft, { enabled: true, scope: d.sectorScope });
  } else if (id === "subStockAllOn") {
    for (const row of rows(draft, "shioaji")) {
      if (row.market !== "STK") continue;
      setLane(draft, row, "trade", true);
      setLane(draft, row, "orderbook", true);
    }
  } else return undefined;
  return edited();
}

function onChange(event) {
  const { id, checked } = event.target;
  if (!["subTaiex", "subTxf", "subSector"].includes(id)) return;
  enqueue("saving", "POST /api/subscriptions/ops", () => {
    if (!draft) return undefined;
    if (id === "subTaiex") setContext(draft, "taiex", checked);
    else if (id === "subTxf") setContext(draft, "txf", checked);
    else setSector(draft, { ...sectorOf(draft), enabled: checked });
    return edited();
  });
}

export function initSubscriptionSettings() {
  generation += 1;
  const panel = document.querySelector('[data-settings-panel="subscription"]');
  if (!panel) return;
  panel.addEventListener("click", onClick);
  panel.addEventListener("change", onChange);
  for (const [id, source] of [["subStockFilter", "shioaji"], ["subFutuFilter", "futu"]]) {
    $(id)?.addEventListener("input", () => { render(); void searchCatalog(source); });
  }
  // Another window saved the pages or the 訂閱偏好: read again, after any change of this page still on its way.
  unsubscribe = window.desktopAPI?.onWatchPagesChanged?.(() => {
    enqueue("reading", "GET /api/subscriptions (after another window saved)", () => load());
  }) || null;
  enqueue("reading", "GET /api/subscriptions", () => load());
}

export function disposeSubscriptionSettings() {
  generation += 1;
  unsubscribe?.();
  unsubscribe = null;
}
