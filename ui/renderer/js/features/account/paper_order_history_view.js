// 帳務 → 模擬帳務 → 委託紀錄 (docs/system-architecture/11 §12): one page, two lists of the same range of trading days --
// 歷史委託 (every 模擬下單 order, a row opens on its fills and its 經過) and 歷史成交 (every trade of the paper
// ledger, matched or typed in). Shared filters: the date range (read from app_api), a stock (股號或股名) and the 類型
// (現股／當沖／零股, the backend's trade_kind: 999 股以內 零股, a same-day pair the ledger matched 當沖, else 現股);
// 歷史委託 also filters by state. View only: 刪改 is the 模擬帳務 component's.
// The data come from GET /api/paper-wallet/orders/history; while the view is shown, a new revision of the orders
// (the page's paper-orders stream) reads the range again. Updates patch the DOM (dom_morph).

import { taipeiDateKey } from "../../market_data/taipei_time.js";
import { escapeHtml } from "../../core/utility.js";
import { morphInto } from "../../core/dom_morph.js";
import { userFacingMessage } from "../../core/user_action.js";
import { PAPER_HISTORY_FILL_COLUMNS, PAPER_HISTORY_ORDER_COLUMNS } from "../../core/column_schemas.js";
import { renderColumnHeaderHtml } from "../../core/column_title.js";
import { expandCellHtml, expandDetailRowHtml, recordExpandBody } from "../../core/data_grid.js";
import { createExpandMotion } from "../../core/expand_motion.js";
import { emptyStateRowHtml, loadStateRowHtml } from "../../core/load_state_view.js";
import { signedValueClass as signClass } from "../../core/market_color_policy.js";
import { paperMoney as money, paperOrderUnits, paperSideClass as sideClass, paperSignedMoney as signed } from "./read_views.js";

const DAY_MS = 86400000;
export const HISTORY_TABS = [["orders", "歷史委託"], ["fills", "歷史成交"]];
export const HISTORY_KINDS = [["all", "全部"], ["現股", "現股"], ["當沖", "當沖"], ["零股", "零股"]];
export const HISTORY_STATES = [
  ["all", "全部"], ["working", "委託中"], ["filled", "全部成交"], ["partial", "部分成交"], ["cancelled", "已取消"], ["expired", "已失效"], ["rejected", "拒絕"],
];

/** Today in Taipei as YYYY-MM-DD, and `days` before it. */
export function taipeiDate(offsetDays = 0, now = Date.now()) {
  return taipeiDateKey(now - offsetDays * DAY_MS);
}

/** Whether an order belongs under a state chip: 部分成交 is any order with some but not all of it filled. */
export function matchesState(order, state) {
  if (state === "all") return true;
  if (state === "working") return !order.final;
  if (state === "partial") return Number(order.filled) > 0 && Number(order.filled) < Number(order.qty);
  return order.state === state;
}

/** Whether a row matches the stock filter (股號 or 股名, any part, case-insensitive). */
export function matchesStock(row, text) {
  const needle = String(text || "").trim().toUpperCase();
  return !needle || String(row.code || "").toUpperCase().includes(needle) || String(row.name || "").toUpperCase().includes(needle);
}

const amount = (order, shares) => paperOrderUnits(order.lot, shares);
const stock = (row) => `<span class="${sideClass(row.side || row.action)}">${escapeHtml(`${row.code}${row.name ? ` ${row.name}` : ""}`)}</span>`;
// 原因: why it ended, else how many times its price was changed (the 經過 lists each 改價).
const note = (o) => o.reason || (o.price_changes.length ? `改價 ${o.price_changes.length} 次` : "");
const dayLabel = (day) => escapeHtml(String(day).slice(5).replace("-", "/"));

function chips(name, items, current) {
  return items.map(([id, label]) => `<button class="settings-pill${current === id ? " is-active" : ""}" type="button" data-orders-${name}="${escapeHtml(id)}">${label}</button>`).join("");
}

function shellMarkup(state) {
  const tabs = HISTORY_TABS.map(([id, label]) => `<button class="account-orders-tab${state.tab === id ? " active" : ""}" type="button" data-orders-tab="${id}">${label}</button>`).join("");
  return `<div class="account-orders-filters">
      <span class="account-orders-tabs" role="tablist">${tabs}</span>
      <label class="account-orders-field">日期 <input class="search account-orders-date" type="date" data-orders-start value="${escapeHtml(state.start)}" /></label>
      <span>～</span>
      <input class="search account-orders-date" type="date" data-orders-end value="${escapeHtml(state.end)}" />
      <input class="search account-orders-stock" type="search" placeholder="股號或股名" data-orders-stock value="${escapeHtml(state.stock)}" />
      <span class="account-orders-chips" role="group" aria-label="類型">${chips("kind", HISTORY_KINDS, state.kind)}</span>
      <span class="account-orders-count" data-orders-count></span>
    </div>
    <div class="account-orders-filters account-orders-states" data-orders-states>
      <span class="account-orders-field">狀態</span><span class="account-orders-chips" role="group" aria-label="狀態">${chips("state", HISTORY_STATES, state.filter)}</span>
    </div>
    <div class="account-orders-message" data-orders-message aria-live="polite"></div>
    <div class="table-wrap finance-table-wrap" data-grid-variant="page">
      <table class="data-table finance-table" data-orders-table></table>
    </div>`;
}

function dayGroups(rows, dayOf, colspan) {
  const perDay = new Map();
  for (const r of rows) perDay.set(dayOf(r), (perDay.get(dayOf(r)) || 0) + 1);
  let day = null;
  return (r) => {
    if (dayOf(r) === day) return "";
    day = dayOf(r);
    return `<tr class="account-orders-day" data-morph-key="day-${escapeHtml(day)}"><td colspan="${colspan}">${dayLabel(day)}（${perDay.get(day)} 筆）</td></tr>`;
  };
}

/** 歷史委託's body for `orders` (already filtered), grouped by day, with the fills and 經過 of the rows open or still closing. */
export function orderRowsMarkup(orders, open, closing = () => false) {
  const colspan = PAPER_HISTORY_ORDER_COLUMNS.length;
  if (!orders.length) return emptyStateRowHtml(colspan, "這段期間沒有符合的委託");
  const group = dayGroups(orders, (o) => o.trading_date, colspan);
  return orders.map((o) => {
    const isOpen = open.has(o.order_id) || closing(o.order_id);
    let html = group(o) + `<tr class="account-orders-row record-expand-row${o.final ? " done" : ""}${isOpen ? " expanded" : ""}" data-morph-key="${escapeHtml(o.order_id)}" data-orders-id="${escapeHtml(o.order_id)}">
      ${expandCellHtml(escapeHtml(o.created_at || ""))}<td>${stock(o)}</td>
      <td>${o.price == null ? "市價" : money(o.price)}</td><td>${amount(o, o.qty)}</td><td>${amount(o, o.filled)}</td>
      <td>${o.avg_price == null ? "--" : money(o.avg_price)}</td><td>${escapeHtml(o.tif || "")}</td><td>${escapeHtml(o.kind || "")}</td>
      <td>${escapeHtml(o.state_label || "")}</td><td class="muted">${escapeHtml(note(o))}</td>
    </tr>`;
    if (isOpen) {
      const fills = (o.fills || []).length
        ? o.fills.map((f) => `<tr><td>${escapeHtml(f.time || "")}</td><td>${amount(o, f.qty)}</td><td>${money(f.price)}</td><td class="muted">${escapeHtml(f.reason || "")}</td></tr>`).join("")
        : emptyStateRowHtml(4, "沒有成交");
      const steps = (o.steps || []).map((s) => `<tr><td>${escapeHtml(s.time || "")}</td><td>${escapeHtml(s.text)}</td></tr>`).join("") || emptyStateRowHtml(2, "沒有紀錄");
      html += expandDetailRowHtml({ colspan,
        attrs: `data-morph-key="${escapeHtml(o.order_id)}-detail" data-orders-detail="${escapeHtml(o.order_id)}"`,
        contentHtml: `<div class="account-orders-detail-box">
        <div><div class="account-orders-detail-title">成交</div><table class="account-orders-mini">${fills}</table></div>
        <div><div class="account-orders-detail-title">經過</div><table class="account-orders-mini">${steps}</table></div>
      </div>` });
    }
    return html;
  }).join("");
}

/** 歷史成交's body for `fills` (already filtered), grouped by day. */
export function fillRowsMarkup(fills) {
  const colspan = PAPER_HISTORY_FILL_COLUMNS.length;
  if (!fills.length) return emptyStateRowHtml(colspan, "這段期間沒有符合的成交");
  const group = dayGroups(fills, (f) => f.date, colspan);
  return fills.map((f) => group(f) + `<tr data-morph-key="${escapeHtml(f.trade_id)}">
      <td>${escapeHtml(f.time || "")}</td><td>${stock(f)}</td><td>${money(f.avg_price)}</td><td>${money(f.qty)}</td>
      <td>${money(f.gross_amount)}</td><td>${money(f.fee)}</td><td>${money(f.tax)}</td>
      <td><span class="${signClass(f.cash)}">${signed(f.cash)}</span></td><td>${escapeHtml(f.kind || "")}</td><td>${escapeHtml(f.origin || "")}</td>
    </tr>`).join("");
}

/**
 * The 委託紀錄 view in `host`. `get(path, { signal })` reads app_api; `subscribeOrders(listener)` is the page's paper-orders
 * stream (a listener gets the state on every new revision; returns the unsubscribe). Returns { show, hide }.
 */
export function createPaperOrderHistoryView({ host, get, subscribeOrders, now = () => Date.now() }) {
  const state = { tab: "orders", start: taipeiDate(7, now()), end: taipeiDate(0, now()), stock: "", kind: "all", filter: "all",
    orders: [], fills: [], loaded: false, error: "" };
  const open = new Set();
  let built = false;
  let stop = null;
  // The read in flight: a newer read (another range, a new revision) aborts it, so only the newest one lands.
  let reading = null;
  let lastRevision = null;
  const motion = createExpandMotion({
    find: (id) => recordExpandBody(host.querySelector(`tr[data-orders-detail="${CSS.escape(id)}"]`)),
    redraw: () => render(),
  });

  function render() {
    if (!built) return;
    const kindOk = (row) => state.kind === "all" || row.kind === state.kind;
    const orders = state.tab === "orders";
    const shown = orders
      ? state.orders.filter((o) => matchesState(o, state.filter) && matchesStock(o, state.stock) && kindOk(o))
      : state.fills.filter((f) => matchesStock(f, state.stock) && kindOk(f));
    const table = host.querySelector("[data-orders-table]");
    if (table.dataset.ordersShows !== state.tab) {
      // The other list: its own header and body (a new table structure, not a data update).
      table.dataset.ordersShows = state.tab;
      table.innerHTML = `${renderColumnHeaderHtml(orders ? PAPER_HISTORY_ORDER_COLUMNS : PAPER_HISTORY_FILL_COLUMNS)}<tbody data-orders-body></tbody>`;
    }
    const colspan = (orders ? PAPER_HISTORY_ORDER_COLUMNS : PAPER_HISTORY_FILL_COLUMNS).length;
    morphInto(table.querySelector("[data-orders-body]"), !state.loaded && !state.error
      ? loadStateRowHtml(colspan, "loading")
      : orders ? orderRowsMarkup(shown, open, motion.closing) : fillRowsMarkup(shown));
    if (orders) motion.play();
    const count = host.querySelector("[data-orders-count]");
    const text = state.loaded ? `${shown.length} 筆${orders ? "委託" : "成交"}` : "";
    if (count.textContent !== text) count.textContent = text;
    const message = host.querySelector("[data-orders-message]");
    if (message.textContent !== state.error) message.textContent = state.error;
    host.querySelector("[data-orders-states]").hidden = !orders;
    host.querySelectorAll("[data-orders-tab]").forEach((b) => b.classList.toggle("active", b.dataset.ordersTab === state.tab));
    host.querySelectorAll("[data-orders-kind]").forEach((b) => b.classList.toggle("is-active", b.dataset.ordersKind === state.kind));
    host.querySelectorAll("[data-orders-state]").forEach((b) => b.classList.toggle("is-active", b.dataset.ordersState === state.filter));
  }

  async function load() {
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    try {
      const result = await get(`/api/paper-wallet/orders/history?start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`,
        { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result?.ok === false) throw new Error(result.error || "讀取委託紀錄失敗");
      state.orders = Array.isArray(result?.orders) ? result.orders : [];
      state.fills = Array.isArray(result?.fills) ? result.fills : [];
      state.loaded = true;
      state.error = "";
    } catch (error) {
      // not an error: a read this view aborted itself (a newer read replaced it) has nothing to report
      if (controller.signal.aborted && error?.name === "AbortError") return;
      // Recorded in full by userFacingMessage; the screen shows the sanitized text.
      const message = userFacingMessage(error, "讀取委託紀錄失敗，請稍後再試", { context: "paper order history: reading the range" });
      if (controller.signal.aborted) return;
      state.error = message;
    } finally {
      if (reading === controller) reading = null;
    }
    render();
  }

  function build() {
    if (built) return;
    built = true;
    morphInto(host, shellMarkup(state));
    host.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-orders-tab]");
      if (tab) { state.tab = tab.dataset.ordersTab; render(); return; }
      const kind = event.target.closest("[data-orders-kind]");
      if (kind) { state.kind = kind.dataset.ordersKind; render(); return; }
      const chip = event.target.closest("[data-orders-state]");
      if (chip) { state.filter = chip.dataset.ordersState; render(); return; }
      const row = event.target.closest("[data-orders-id]");
      if (row) {
        const id = row.dataset.ordersId;
        const opening = !open.has(id);
        if (!motion.start(id, opening)) return;
        if (opening) open.add(id); else open.delete(id);
        render();
      }
    });
    host.addEventListener("change", (event) => {
      if (event.target.matches("[data-orders-start], [data-orders-end]")) {
        const start = host.querySelector("[data-orders-start]").value, end = host.querySelector("[data-orders-end]").value;
        if (!start || !end) return;
        state.start = start; state.end = end; state.loaded = false;
        render();
        void load();
      }
    });
    host.addEventListener("input", (event) => {
      if (event.target.matches("[data-orders-stock]")) { state.stock = event.target.value; render(); }
    });
  }

  return {
    show() {
      build();
      render();
      void load();
      // A new revision of the orders (a fill, a cancel, a new order) reads the range again while the view is shown.
      stop ??= subscribeOrders?.((orders) => {
        const revision = orders?.revision;
        if (revision === undefined || revision === lastRevision) return;
        const first = lastRevision === null;
        lastRevision = revision;
        if (!first) void load();
      }) || null;
    },
    hide() {
      stop?.();
      stop = null;
      lastRevision = null;
      reading?.abort();
      reading = null;
    },
  };
}
