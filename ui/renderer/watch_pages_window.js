// First: every later warning and error is recorded as text (js/core/console_relay.js).
import "./js/core/console_relay.js";
import { formatMoomooDisplaySymbol } from "./js/market_data/moomoo_symbol.js";
import { apiGet, apiJsonPost } from "./js/core/api.js";
import { inFlight, runSingleFlight, userFacingMessage } from "./js/core/user_action.js";
import { escapeHtml as esc } from "./js/core/utility.js";
import { morphInto } from "./js/core/dom_morph.js";
import { showToast, syncSegmented } from "./js/core/settings_ui.js";
import { createExpandMotion } from "./js/core/expand_motion.js";
import { enableRowUnitScroll } from "./js/core/row_snap.js";
import { DiscreteRowScrollbarController } from "./js/core/discrete_row_scrollbar.js";
import {
  addOrMergeItem, canonicalSource, enrichPage, moveInList, moveItem as moveDraftItem, normalizeItem,
  removeItemAt, setAlert,
} from "./js/features/watch_pages/watch_page_draft.js";
import { createWatchPageSearch } from "./js/features/watch_pages/watch_page_search.js";
import { opsBatch } from "./js/features/watch_pages/watch_page_ops.js";
import {
  changed, createDraft, draftOpsOf, keyOf, laneOf, rebase, rows, setFutures, setLane, toggleMonth,
} from "./js/features/subscriptions/subscription_draft.js";

// The 商品頁設定 window: the product pages (left), the page's products with their 低價／高價 and 期貨／明細／五檔
// (middle), 加入商品 (right). The same pages and 訂閱偏好 as 設定 → 訂閱管理: settings_api is their one writer
// (POST /api/subscriptions/ops) and this window sends only what it changed (subscription_draft.js); another window's
// save is laid under this window's own changes (rebase).

// The draft: the snapshot settings_api answered and this window's changes over it (subscription_draft.js).
let draft = null;
let pages = [];   // draft.pages: the pages as edited here (replaced, never mutated in place)
let activeId = "";
let editorSource = "shioaji";
let futuMarketFilter = "all";
let searchItems = [];
// How many products the searched source lists in the catalog (the last answer's `listed`); 0 means its list was never
// fetched, which a search with no result says instead of "no match".
let searchListed = null;
let draggedItemIndex = null;
let draggedPageId = "";
let editing = null;   // { kind: "name" } or { kind: "alert", code, field }: the cell being edited in place
// Every edit of the draft bumps the generation. A save's reply replaces the draft only when no edit was made after the
// save was sent; otherwise the reply becomes the base and the newer edits stay over it.
let draftGeneration = 0;
let previewTimer = null;
let previewGeneration = 0;
const PREVIEW_DELAY_MS = 150;

const $ = (id) => document.getElementById(id);

function markDraftEdited() {
  draftGeneration += 1;
  if (draft) draft.pages = pages;
  schedulePreview();
}

function current() {
  const active = pages.find((p) => String(p.id) === String(activeId));
  if (active && pageSource(active) === editorSource) return active;
  return pages.find((p) => pageSource(p) === editorSource) || null;
}

function pageSource(page = current()) { return canonicalSource(page?.source); }
function displayCode(code, page = current()) { return pageSource(page) === "futu" ? formatMoomooDisplaySymbol(code) : String(code || ""); }
// A Futu code names its market; a Shioaji product is a stock, or an index future (台指期、小台指: the server's
// `index_futures`, a product with only months).
const indexFutureOf = (code) => draft?.view?.index_futures?.[code] || null;
const marketOf = (source, code) => (source === "futu" ? String(code).split(".", 1)[0].toUpperCase() : indexFutureOf(code) ? "FUT" : "STK");
const monthLabel = (m) => `${m.slice(0, 4)}/${m.slice(4)}`;

/** Replaces the current page in the draft with `next` (a new page object). */
function replaceCurrentPage(next) {
  pages = pages.map((page) => (page.id === next.id ? next : page));
  markDraftEdited();
}

function setStatus(message = "", isError = false) {
  const status = $("watchPagesStatus");
  if (status) {
    status.textContent = message;
    status.classList.toggle("is-error", Boolean(message) && isError);
  }
  if (message) console.info(`[WatchPages] ${message}`);
}

// ---------------------------------------------------------------- rows and switches
/** The server's row of a product (its switches, its futures); a product added here that the server has not answered
 *  yet starts from the defaults its owner would give it. */
function rowFor(source, code) {
  const market = marketOf(source, code);
  const found = draft && rows(draft).find((row) => row.source === source && row.code === code);
  if (found) return found;
  const category = draft?.view?.futures?.stocks?.[code]?.[0];
  const listed = category ? draft.view.futures.categories[category] : null;
  const indexFuture = source === "shioaji" ? indexFutureOf(code) : null;
  return {
    source, market, code, name: "", pages: [], owners: ["watchlist"], listed: false, locked: false,
    trade: true, orderbook: source === "shioaji",
    ...(listed ? { futures: { on: false, trade: true, orderbook: true, months: [], category, name: listed.name, months_listed: listed.months } } : {}),
    ...(indexFuture ? { index_futures: { months: [], months_listed: indexFuture.months } } : {}),
  };
}

// The futures months under a stock with 期貨 on open and close with the shared motion.
const motion = createExpandMotion({
  find: (key) => document.querySelector(`#watchPageItems [data-sub-key="${CSS.escape(key)}"]`),
  redraw: () => renderItems(),
});

// ---------------------------------------------------------------- loading and the server
// settings_api is the one writer of watch_pages.csv (POST /api/subscriptions/ops): read from it, saved through it.
async function load() {
  const d = await apiGet("/api/subscriptions");
  if (!d || d.ok === false || !Array.isArray(d.pages)) throw new Error(d?.message || d?.error || "讀取商品頁失敗");
  draft = draft && changed(draft) ? rebase(draft, d) : createDraft(d);
  pages = draft.pages;
  const initial = pages.find((p) => String(p.id) === String(activeId)) || pages.find((p) => pageSource(p) === editorSource) || pages[0] || null;
  if (!pages.some((p) => pageSource(p) === editorSource)) editorSource = initial ? pageSource(initial) : "shioaji";
  activeId = String(initial?.id || "");
  render();
}

// After every change: the server's rows for this window's changes (a product added here gets its real switches).
function schedulePreview() {
  clearTimeout(previewTimer);
  if (!draft) return;
  previewTimer = setTimeout(async () => {
    const mine = ++previewGeneration;
    const ops = draftOpsOf(draft);
    if (!ops.length) { draft.view = draft.base; render(); return; }
    try {
      const view = await apiJsonPost("/api/subscriptions/preview", { ops });
      if (mine !== previewGeneration || !draft) return;
      if (!view || view.ok === false) throw new Error(view?.message || view?.error || "預覽失敗");
      draft.view = view;
      render();
    } catch (error) {
      console.warn(`[watch pages: previewing the unsaved changes${mine === previewGeneration ? "" : " (superseded)"}] failed`, error);
    }
  }, PREVIEW_DELAY_MS);
}

/** One batch to settings_api; the answer (the pages and preferences as they are now), or an error with its message. */
async function sendOps(ops) {
  const result = await apiJsonPost("/api/subscriptions/ops", opsBatch(ops));
  if (!result || result.ok === false || !Array.isArray(result.pages)) {
    const error = new Error(result?.message || result?.error || "儲存商品頁失敗");
    if (result?.message) error.userMessage = result.message;
    throw error;
  }
  return result;
}

// ---------------------------------------------------------------- drawing
let listScroll = null;
let itemsScroll = null;
let searchScroll = null;

function render() {
  document.querySelectorAll("[data-watch-source]").forEach((button) => button.classList.toggle("is-active", button.dataset.watchSource === editorSource));
  syncSegmented($("watchSourceSeg"));
  $("futuMarketRow").hidden = editorSource !== "futu";
  $("futuMarketFilter").value = futuMarketFilter;
  const page = current();
  if (page && String(page.id) !== String(activeId)) activeId = String(page.id);
  $("deletePageBtn").disabled = !page;
  $("watchPageSearchInput").placeholder = editorSource === "futu" ? "Futu 商品代碼或名稱，例如 AAPL / BTC" : "股號或股名";
  renderPageList();
  renderNameHead();
  renderItems();
  renderSearch();
  syncSaveButton();
  $("cancelWatchPagesBtn").disabled = false;
  for (const scroll of [listScroll, itemsScroll, searchScroll]) scroll?.sync?.();
}

function renderPageList() {
  const visible = pages.filter((p) => pageSource(p) === editorSource);
  morphInto($("watchPageList"), visible.map((p) => `<div class="watch-list-row is-clickable${String(p.id) === String(activeId) ? " is-selected" : ""}" data-morph-key="page:${esc(p.id)}" data-page="${esc(p.id)}">`
    + `<button type="button" class="settings-icon-btn" draggable="true" data-page-drag="${esc(p.id)}" aria-label="拖曳排序">≡</button>`
    + `<span class="watch-list-name">${esc(p.name)}</span><span class="watch-list-count">${p.items.length}</span></div>`).join("")
    || `<div class="watch-empty" data-morph-key="empty">尚無商品頁</div>`);
}

function renderNameHead() {
  const page = current();
  morphInto($("watchPageNameHead"), editing?.kind === "name" && page
    ? `<input class="watch-name-input" data-edit-input="name" maxlength="24" value="${esc(page.name)}" aria-label="商品頁名稱" />`
    : `<span class="watch-col-page-name" data-edit-name>${esc(page?.name || "—")}</span>`
      + `<button type="button" class="settings-icon-btn" data-edit-name aria-label="更名"${page ? "" : " disabled"}>✎</button>`
      + `<span class="watch-col-count">${page ? `${page.items.length} 檔` : ""}</span>`);
  focusEditor();
}

function alertCell(item, field) {
  const label = field === "lower_alert" ? "低價" : "高價";
  const extra = field === "upper_alert" ? " watch-cell-high" : "";
  if (editing?.kind === "alert" && editing.code === item.code && editing.field === field) {
    return `<span class="watch-cell${extra}"><input class="watch-num-input" type="number" step="0.01" data-edit-input="alert" value="${esc(item[field] || "")}" aria-label="${label}提醒" /></span>`;
  }
  return `<span class="watch-cell${extra}"><span class="watch-num${item[field] ? "" : " is-empty"}" data-edit-alert="${field}" data-code="${esc(item.code)}">${item[field] ? esc(item[field]) : "—"}</span></span>`;
}

function itemRow(item, index, page) {
  const source = pageSource(page);
  const row = rowFor(source, item.code);
  const lane = laneOf(draft, row);
  const key = keyOf(row.source, row.market, row.code);
  const lock = lane.locked ? " disabled" : "";
  const fut = lane.futures;
  // An index future: its months are the product, always listed; its 明細／五檔 are the row's own switches.
  const indexFuture = Boolean(row.index_futures);
  const pill = (attrs, on, label, accent = false) => `<button type="button" class="settings-pill watch-cell-pill${accent ? " is-accent" : ""}${on ? " is-active" : ""}" ${attrs} aria-pressed="${on}">${label}</button>`;
  let html = `<div class="watch-row watch-item" data-morph-key="item:${esc(item.code)}" data-item-index="${index}">`
    + `<button type="button" class="settings-icon-btn" draggable="true" data-item-drag="${index}" aria-label="拖曳排序">≡</button>`
    + `<span class="watch-cell watch-cell-code">${esc(displayCode(item.code, page))}</span>`
    + `<span class="watch-cell watch-cell-name">${esc(item.name || row.name)}</span>`
    + alertCell(item, "lower_alert") + alertCell(item, "upper_alert")
    // 期貨: only a Shioaji stock with 個股期貨; on subscribes the near month and opens the months under the row.
    + (fut && !indexFuture ? pill(`data-key="${esc(key)}" data-futures="on"`, fut.on, "期貨", true) : `<span></span>`)
    + `<button type="button" class="settings-pill watch-cell-pill${lane.trade ? " is-active" : ""}" data-key="${esc(key)}" data-lane="trade" aria-pressed="${lane.trade}"${lock}>明細</button>`
    + `<button type="button" class="settings-pill watch-cell-pill${lane.orderbook ? " is-active" : ""}" data-key="${esc(key)}" data-lane="orderbook" aria-pressed="${lane.orderbook}"${lock}>五檔</button>`
    + `<button type="button" class="settings-icon-btn is-danger" data-remove-index="${index}" aria-label="從這個商品頁刪除">✕</button></div>`;
  if (fut && (fut.on || motion.closing(key))) {
    const months = fut.months_listed || [];
    html += `<div class="watch-row-months" data-sub-key="${esc(key)}" data-morph-key="months:${esc(item.code)}">`
      + `<span class="watch-months-code">${esc(indexFuture ? row.code : fut.category)}</span>`
      + months.map((m, i) => (i === 0
        ? `<span class="settings-pill is-accent is-active is-locked">近月 ${monthLabel(m)}</span>`
        : `<button type="button" class="settings-pill is-accent${fut.months.has(m) ? " is-active" : ""}" data-key="${esc(key)}" data-month="${m}" aria-pressed="${fut.months.has(m)}">${monthLabel(m)}</button>`)).join("")
      + (indexFuture ? "" : `<span class="watch-months-lanes">`
        + `<button type="button" class="settings-pill${fut.trade ? " is-active" : ""}" data-key="${esc(key)}" data-futures="trade" aria-pressed="${fut.trade}">明細</button>`
        + `<button type="button" class="settings-pill${fut.orderbook ? " is-active" : ""}" data-key="${esc(key)}" data-futures="orderbook" aria-pressed="${fut.orderbook}">五檔</button>`
        + `</span>`)
      + `</div>`;
  }
  return html;
}

function renderItems() {
  const page = current();
  const head = `<div class="watch-row watch-row-head" data-morph-key="head"><span></span><span class="watch-cell">代號</span><span class="watch-cell">名稱</span>`
    + `<span class="watch-cell watch-cell-num">低價</span><span class="watch-cell watch-cell-num watch-cell-high">高價</span>`
    + `<span class="watch-cell watch-cell-center">期貨</span><span class="watch-cell watch-cell-center">明細</span><span class="watch-cell watch-cell-center">五檔</span><span></span></div>`;
  const items = page?.items || [];
  morphInto($("watchPageItems"), items.length && draft
    ? head + items.map((item, index) => itemRow(item, index, page)).join("")
    : `<div class="watch-empty" data-morph-key="empty">${page ? "在右邊搜尋並加入商品" : "先新增一個商品頁"}</div>`);
  motion.play();
  focusEditor();
}

// A search with no result: no match, or the source has no product list yet (a new install before its broker connects).
function noMatchText() {
  if (searchListed !== 0) return "找不到符合的商品";
  return editorSource === "futu"
    ? "還沒有 Futu 商品清單：請開啟並登入 moomoo OpenD，連上後會自動下載（約 1 分鐘）"
    : "還沒有永豐商品清單：請先在「設定 → 券商帳號」登入永豐，連上後會自動下載";
}

function renderSearch() {
  const page = current();
  const inPage = new Set((page?.items || []).map((item) => item.code));
  const q = $("watchPageSearchInput").value.trim();
  morphInto($("watchPageSearchResults"), searchItems.map((raw) => {
    const item = normalizeItem(raw);
    if (!item) return "";
    const added = inPage.has(item.code);
    return `<div class="watch-list-row" data-morph-key="result:${esc(item.code)}"><span class="watch-list-name">${esc(item.name || item.code)}`
      + `<span class="watch-list-detail">${esc(displayCode(item.code, page))}${item.industry_name ? `・${esc(item.industry_name)}` : ""}</span></span>`
      + `<button type="button" class="btn ${added ? "secondary" : "primary"} small-btn" data-add-code="${esc(item.code)}"${added || !page ? " disabled" : ""}>${added ? "已加入" : "加入"}</button></div>`;
  }).join("") || `<div class="watch-empty" data-morph-key="empty">${q ? esc(noMatchText()) : editorSource === "futu" ? "搜尋 Futu 商品" : "搜尋股號或股名"}</div>`);
}

function focusEditor() {
  const input = document.querySelector("[data-edit-input]");
  if (input && document.activeElement !== input) { input.focus(); input.select?.(); }
}

// ---------------------------------------------------------------- editing
function renameCurrentPage(name) {
  const page = current();
  const next = String(name ?? "").trim();
  if (!page || !next || next === page.name) return false;
  replaceCurrentPage({ ...page, name: next });
  return true;
}

function commitEdit(input, keep) {
  const page = current();
  if (keep && page) {
    if (input.dataset.editInput === "name") renameCurrentPage(input.value);
    else {
      const value = input.value.trim();
      if (value !== "" && !Number.isFinite(Number(value))) {
        setStatus(`${displayCode(editing.code, page)} 的${editing.field === "lower_alert" ? "低價" : "高價"}不是數字`, true);
      } else {
        const next = setAlert([page], editing.code, editing.field, value)[0];
        if (next !== page) replaceCurrentPage(next);
      }
    }
  }
  editing = null;
  render();
}

function removeItem(index) {
  const page = current();
  const item = page?.items[index];
  if (!item) return;
  replaceCurrentPage(removeItemAt(page, index));
  render();
  // No confirmation: 復原 for 5 s puts it back where it was (decisions.md 訂閱清單在兩個地方管理).
  showToast(`已從〈${page.name}〉刪除〈${item.name || displayCode(item.code, page)}〉`, { undo: () => {
    const now = pages.find((p) => p.id === page.id);
    if (!now || now.items.some((i) => i.code === item.code)) return;
    const items = [...now.items];
    items.splice(Math.min(index, items.length), 0, item);
    pages = pages.map((p) => (p.id === now.id ? { ...now, items } : p));
    markDraftEdited();
    render();
  } });
}

function addFromSearch(code) {
  const page = current();
  const item = normalizeItem(searchItems.find((x) => String(x.code || "").trim().toUpperCase() === code));
  if (!page || !item) return false;
  const { page: next, added } = addOrMergeItem(page, item);
  if (!added) { setStatus(`${displayCode(item.code, page)} 已在目前商品頁`); return false; }
  replaceCurrentPage(next);
  render();
  return true;
}

// The page order is saved at once: only the order (page.order), so a page another window added keeps its place.
async function persistPageOrderImmediately() {
  const ids = pages.map((p) => String(p.id || "")).filter((id) => draft?.base.pages.some((page) => String(page.id) === id));
  if (!ids.length) return true;
  try {
    const result = await sendOps([{ op: "page.order", page_ids: ids }]);
    // The new base; this window's other edits stay over it.
    draft = rebase(draft, result);
    pages = draft.pages;
    window.desktopAPI?.notifyWatchPagesChanged?.({ kind: "page-order" });
    setStatus("商品頁順序已直接儲存");
    render();
    return true;
  } catch (error) {
    setStatus(userFacingMessage(error, "商品頁排序儲存失敗，變更尚未儲存", { context: "WATCH_PAGE_ORDER_SAVE" }), true);
    return false;
  }
}

async function movePage(from, to) {
  const next = moveInList(pages, from, to);
  if (next === pages) return;
  pages = next;
  markDraftEdited();
  renderPageList();
  await persistPageOrderImmediately();
}

function switchEditorSource(value) {
  const nextSource = canonicalSource(value);
  if (nextSource === editorSource) return;
  catalogSearch.invalidate();
  editorSource = nextSource;
  activeId = String(pages.find((page) => pageSource(page) === editorSource)?.id || "");
  searchItems = [];
  $("watchPageSearchInput").value = "";
  editing = null;
  render();
}

// 儲存設定's one writer of `disabled`: usable while the draft has changes and no save is out.
function syncSaveButton() {
  const button = $("saveWatchPagesBtn");
  button.disabled = !(Boolean(draft) && changed(draft)) || inFlight(button);
}

// One save at a time: a second click while a save is in flight joins it (the button is disabled meanwhile).
function savePagesOnly() {
  const flight = runSingleFlight($("saveWatchPagesBtn"), writeDraft);
  syncSaveButton();
  return flight.finally(syncSaveButton);
}

async function writeDraft() {
  pages = pages.map((page) => enrichPage(page, searchItems));
  draft.pages = pages;
  const sentGeneration = draftGeneration;
  try {
    // Only what this window changed, applied by settings_api to the list as it is now (another window's edits
    // stay; the same field changed by both is the later save's): docs/system-architecture/06 section 2.
    const ops = draftOpsOf(draft);
    if (!ops.length) {
      setStatus("沒有要儲存的修改");
      return true;
    }
    const d = await sendOps(ops);
    window.desktopAPI?.notifyWatchPagesChanged?.({ kind: "saved" });
    // Edited while the save was in flight: the reply is the older draft's saved state, and the newer edits stay.
    const editedSince = sentGeneration !== draftGeneration;
    // The saved changes are in the answer; laid over it again they change nothing, and the newer ones stay.
    draft = editedSince ? rebase(draft, d) : createDraft(d);
    pages = draft.pages;
    if (!pages.some((p) => String(p.id) === String(activeId) && pageSource(p) === editorSource)) {
      activeId = String(pages.find((p) => pageSource(p) === editorSource)?.id || "");
    }
    const skipped = d.skipped?.length ? `；${d.skipped.length} 項已不存在、略過` : "";
    if (editedSince) setStatus("已儲存送出時的設定；之後的修改尚未儲存，請再按儲存設定");
    else {
      setStatus("");
      showToast(`商品頁設定已儲存${skipped}`);
    }
    render();
    return true;
  } catch (error) {
    setStatus(userFacingMessage(error, "儲存失敗，草稿尚未儲存", { context: "WATCH_PAGE_SAVE" }), true);
    return false;
  }
}

// ---------------------------------------------------------------- search
async function fetchSearchItems(q) {
  if (!window.desktopAPI?.searchProductCatalogLocal) {
    throw new Error("本機 Product Catalog 查詢介面不可用");
  }
  const market = editorSource === "futu" && futuMarketFilter !== "all" ? futuMarketFilter : "";
  const data = await window.desktopAPI.searchProductCatalogLocal(editorSource, q, market, 50);
  if (!data || data.ok === false) throw new Error(data?.error || "本機商品目錄查詢失敗");
  return data;
}

const catalogSearch = createWatchPageSearch({ fetchItems: fetchSearchItems });
// What a search answer must still match to be shown.
const searchContext = () => ({ q: $("watchPageSearchInput").value.trim(), source: editorSource, market: futuMarketFilter, page: activeId });

async function search({ addOnEnter = false } = {}) {
  const q = $("watchPageSearchInput").value.trim();
  if (!q) {
    catalogSearch.invalidate();
    searchItems = [];
    renderSearch();
    setStatus("");
    return false;
  }
  try {
    const answer = await catalogSearch.query(q, searchContext);
    if (!answer) return false;
    searchItems = answer.items;
    searchListed = answer.listed;
    renderSearch();
    if (addOnEnter && searchItems.length) return addFromSearch(String(searchItems[0].code || "").trim().toUpperCase());
    setStatus(searchItems.length ? "" : noMatchText());
    return false;
  } catch (error) {
    searchItems = [];
    renderSearch();
    setStatus(userFacingMessage(error, "商品查詢失敗，請稍後再試", { context: "WATCH_PAGE_SEARCH" }), true);
    return false;
  }
}

// ---------------------------------------------------------------- events
function rowByKey(key) {
  const [source, , ...code] = key.split(":");
  return rowFor(source, code.join(":"));
}

function onItemsClick(event) {
  const target = event.target.closest("button, [data-edit-alert]");
  if (!target || target.disabled || !draft) return;
  const d = target.dataset;
  if (d.removeIndex !== undefined) { removeItem(Number(d.removeIndex)); return; }
  if (d.editAlert) { editing = { kind: "alert", code: d.code, field: d.editAlert }; renderItems(); return; }
  if (!d.key) return;
  const row = rowByKey(d.key);
  const lane = laneOf(draft, row);
  if (d.lane) setLane(draft, row, d.lane, !lane[d.lane]);
  else if (d.futures === "on") {
    if (!motion.start(d.key, !lane.futures.on)) return;
    setFutures(draft, row, "on", !lane.futures.on);
  } else if (d.futures) setFutures(draft, row, d.futures, !lane.futures[d.futures]);
  else if (d.month) toggleMonth(draft, row, d.month);
  else return;
  markDraftEdited();
  render();
}

function onEditKey(event) {
  const input = event.target.closest("[data-edit-input]");
  if (!input) return;
  if (event.key === "Enter") { event.preventDefault(); commitEdit(input, true); }
  else if (event.key === "Escape") { event.preventDefault(); commitEdit(input, false); }
}

function onEditBlur(event) {
  const input = event.target.closest?.("[data-edit-input]");
  if (input && editing) commitEdit(input, true);
}

function wireDrag() {
  const list = $("watchPageList");
  list.addEventListener("click", (event) => {
    const row = event.target.closest("[data-page]");
    if (!row || event.target.closest("[data-page-drag]")) return;
    activeId = row.dataset.page || "";
    editing = null;
    render();
  });
  list.addEventListener("dragstart", (event) => {
    const handle = event.target.closest("[data-page-drag]");
    if (!handle) return;
    draggedPageId = String(handle.dataset.pageDrag || "");
    event.dataTransfer?.setData("text/plain", draggedPageId);
  });
  list.addEventListener("dragover", (event) => {
    const row = event.target.closest("[data-page]");
    if (!row || !draggedPageId) return;
    event.preventDefault();
    list.querySelectorAll(".is-drag-over").forEach((node) => node.classList.remove("is-drag-over"));
    row.classList.add("is-drag-over");
  });
  list.addEventListener("drop", async (event) => {
    const row = event.target.closest("[data-page]");
    if (!row || !draggedPageId) return;
    event.preventDefault();
    const from = pages.findIndex((p) => String(p.id) === draggedPageId);
    const to = pages.findIndex((p) => String(p.id) === row.dataset.page);
    draggedPageId = "";
    await movePage(from, to);
  });
  list.addEventListener("dragend", () => {
    draggedPageId = "";
    list.querySelectorAll(".is-drag-over").forEach((node) => node.classList.remove("is-drag-over"));
  });

  const items = $("watchPageItems");
  items.addEventListener("dragstart", (event) => {
    const handle = event.target.closest("[data-item-drag]");
    if (!handle) return;
    draggedItemIndex = Number(handle.dataset.itemDrag);
    event.dataTransfer?.setData("text/plain", String(draggedItemIndex));
  });
  items.addEventListener("dragover", (event) => {
    const row = event.target.closest("[data-item-index]");
    if (!row || draggedItemIndex === null) return;
    event.preventDefault();
    items.querySelectorAll(".is-drag-over").forEach((node) => node.classList.remove("is-drag-over"));
    row.classList.add("is-drag-over");
  });
  items.addEventListener("drop", (event) => {
    const row = event.target.closest("[data-item-index]");
    const page = current();
    if (!row || draggedItemIndex === null || !page) return;
    event.preventDefault();
    const next = moveDraftItem(page, draggedItemIndex, Number(row.dataset.itemIndex));
    draggedItemIndex = null;
    if (next !== page) { replaceCurrentPage(next); render(); }
  });
  items.addEventListener("dragend", () => {
    draggedItemIndex = null;
    items.querySelectorAll(".is-drag-over").forEach((node) => node.classList.remove("is-drag-over"));
  });
}

// Whole-row scrolling for the three lists, with the shared discrete rail over each card's edge (below a list's
// sticky header row).
function mountRowScroll(viewportId, railId, rowSelector) {
  const viewport = $(viewportId);
  const rail = $(railId);
  if (!viewport || !rail) return null;
  const snap = enableRowUnitScroll({ viewport, rowSelector, rowHeightVar: "--row-height-watch-editor", maskRemainder: false, measureActualRow: true });
  const scrollbar = new DiscreteRowScrollbarController({ host: rail, viewport }).mount();
  const place = () => {
    const head = viewport.querySelector(".watch-row-head");
    rail.style.top = `${viewport.offsetTop + (head ? head.offsetHeight : 0)}px`;
    rail.style.bottom = `${Math.max(0, viewport.parentElement.clientHeight - viewport.offsetTop - viewport.clientHeight)}px`;
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
  observer?.observe?.(viewport.parentElement);
  place();
  // After a draw: the rows changed, so the row geometry and the thumb are measured again.
  const sync = () => { place(); snap.refreshContent?.(); scrollbar.syncScrollbar?.(); };
  return { snap, scrollbar, sync };
}

document.querySelectorAll("[data-watch-source]").forEach((button) => {
  button.addEventListener("click", () => switchEditorSource(button.dataset.watchSource));
});
$("futuMarketFilter").addEventListener("change", (event) => {
  futuMarketFilter = event.target.value || "all";
  catalogSearch.invalidate();
  void search();
});
$("watchPageSearchInput").addEventListener("input", () => {
  catalogSearch.invalidate();
  if (!$("watchPageSearchInput").value.trim()) { searchItems = []; renderSearch(); return; }
  catalogSearch.schedule(() => { void search(); });
});
$("watchPageSearchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); void search({ addOnEnter: true }); }
});
$("watchPageSearchResults").addEventListener("click", (event) => {
  const button = event.target.closest("[data-add-code]");
  if (button && !button.disabled) addFromSearch(button.dataset.addCode);
});
$("watchPageItems").addEventListener("click", onItemsClick);
$("watchPageNameHead").addEventListener("click", (event) => {
  if (!event.target.closest("[data-edit-name]") || !current()) return;
  editing = { kind: "name" };
  renderNameHead();
});
for (const host of [$("watchPageItems"), $("watchPageNameHead")]) {
  host.addEventListener("keydown", onEditKey);
  host.addEventListener("focusout", onEditBlur);
}
$("addWatchPageBtn").onclick = () => {
  const source = editorSource;
  const id = `page_${Date.now().toString(36)}`;
  const count = pages.filter((p) => pageSource(p) === source).length;
  pages = [...pages, { id, name: `${source === "futu" ? "Futu" : "Shioaji"}自選${count + 1}`, source, market: source === "futu" ? "us" : "tw", items: [] }];
  markDraftEdited();
  activeId = id;
  editing = { kind: "name" };
  render();
};
$("deletePageBtn").onclick = () => {
  const visible = pages.filter((page) => pageSource(page) === editorSource);
  const at = visible.findIndex((page) => String(page.id) === String(activeId));
  if (at < 0) return;
  pages = pages.filter((page) => String(page.id) !== String(activeId));
  markDraftEdited();
  const rest = pages.filter((page) => pageSource(page) === editorSource);
  activeId = String(rest[Math.max(0, Math.min(at - 1, rest.length - 1))]?.id || "");
  render();
};
$("saveWatchPagesBtn").onclick = savePagesOnly;
$("cancelWatchPagesBtn").onclick = () => window.close();
wireDrag();
listScroll = mountRowScroll("watchPageList", "watchPageListRail", ".watch-list-row");
itemsScroll = mountRowScroll("watchPageItems", "watchPageItemsRail", ".watch-item, .watch-row-months");
searchScroll = mountRowScroll("watchPageSearchResults", "watchPageSearchRail", ".watch-list-row");
// Another window saved the pages or the 訂閱偏好 (設定 → 訂閱管理, another 商品頁設定): read again, this window's own
// changes laid over.
window.desktopAPI?.onWatchPagesChanged?.(() => {
  load().catch((error) => console.warn("[watch pages: reading the pages after another window saved] failed", error));
});

load().catch((error) => setStatus(userFacingMessage(error, "商品頁載入失敗，請重新開啟後再試", { context: "WATCH_PAGE_LOAD" }), true));
