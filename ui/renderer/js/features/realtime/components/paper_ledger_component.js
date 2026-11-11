// 模擬帳務 (docs/system-architecture/11 §11), in the settings look (設定頁／帳務中心: number tiles, a title above each
// card, rounded cards, the segmented choice). Top: four tiles (今日額度剩餘, 模擬庫存餘額, 未實現總損益, the next
// settlement's 淨收付). Left card, two tabs:
// - 委託・成交: one row per order of the day (and a trade typed in by hand). A working or cancelled order shows its
//   委託價, 成交／委託 and its state; a filled one what it did: 成交均價, 股數 and its last fill's time, its side
//   (買進 / 賣出) where a working order has 刪改. Cancelled orders go below the others; each part newest first. A row
//   opens to its lines under the same columns: 時間 (to the minute), 價格, 股數 and 委託 / 成交.
// - 已實現: the day's realized pairs; one opens to a small table: 買入 / 賣出 × 時間, 單價, 價金 (with fee and tax) and
//   報酬率.
// Right card: 未實現 (股數 unsigned, 總損益 coloured without a sign); 「刪改」 swaps it for the 刪改 card (刪單 or
// 改價, − / ＋, the shared 買賣報價 of that stock, whose prices fill 改價) and the search box (or a 買賣報價 price clicked
// elsewhere, openOrderAt) for the 下單 card (買賣報價 and the order ticket, order_ticket.js). Bottom: 未實現's figures
// (收益, 報酬率, 現值, 成本). A line under the tiles says only what went wrong.
// Every list is a standard data grid (core/data_grid.js): the column titles stay put and the scrollbar is under them
// (decisions.md「捲軸的位置」); rows open and close with the shared expand motion.
// Data, all from the page's services: paperOrders (core/paper_orders_store.js: orders, fills, funds, the ledger's day),
// paperHoldings (ledger_holdings.js), positionMarks (live prices, live_position_marks.js) and productSearch.
// Updates patch the DOM (dom_morph); tiles, titles, tabs and the 刪改 card's controls are built once.

import { escapeHtml } from "../../../core/utility.js";
import { morphInto } from "../../../core/dom_morph.js";
import { inFlight, runSingleFlight } from "../../../core/user_action.js";
import { mountShell } from "../../../core/component_shell.js";
import { renderColumnGroupHtml, renderColumnHeaderHtml } from "../../../core/column_title.js";
import { PAPER_LEDGER_ORDER_COLUMNS, PAPER_LEDGER_POSITION_COLUMNS, PAPER_LEDGER_REALIZED_COLUMNS } from "../../../core/column_schemas.js";
import { destroyStandardDataGrid, expandDetailRowHtml, recordExpandBody, upgradeStandardDataGrid } from "../../../core/data_grid.js";
import { createExpandMotion } from "../../../core/expand_motion.js";
import { syncSegmented } from "../../../core/settings_ui.js";
import { bindProductQuoteHeaders, productQuoteSearchHtml, registerProductQuoteSearchProvider } from "../../../core/components/product_quote_search.js";
import { orderBookReadView } from "../../../core/market_read_model.js";
import { OrderBookComponent } from "../../../core/components/orderbook_component.js";
import { createPositionMarkTracker, positionUnrealizedPnl } from "../../account/live_position_marks.js";
import { stepPrice, tickTable } from "../../../market_data/tw_stock_rules.js";
import { lookupInstrumentKind } from "../../../market_data/instrument_kind.js";
import { OrderTicket, orderTicketHtml } from "./order_ticket.js";
import { signedValueClass as signClass } from "../../../core/market_color_policy.js";
import { numberOrNull as num } from "../../../core/numbers.js";
import { PAPER_LOT_SHARES as LOT, paperMoney as money, paperOrderUnitCount, paperSideClass as sideClass, paperSignedMoney as signed } from "../../account/read_views.js";

let searchSeq = 0;

const stockText = (code, name) => `${code}${name && name !== code ? ` ${name}` : ""}`;
/** A table's 股名 cell: the name only; the code when the ledger has no name for it. */
const stockName = (code, name) => name || code;
/** Text in a coloured span: a data-table cell has a colour of its own, so the colour goes on the text it marks. */
const tinted = (text, cls) => (cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
const toMinute = (time) => String(time || "").slice(0, 5);
/** A pair leg's time: a 當沖's clock (HH:MM), an earlier day's date as MM/DD. */
const legTime = (ref) => (/^\d{4}-\d{2}-\d{2}/.test(String(ref || "")) ? String(ref).slice(5, 10).replace("-", "/") : String(ref || "--"));

/** The 未實現 rows and their totals: each holding's net P&L is the 庫存 page's (live_position_marks.js, at the live
 * price). 成本 is cost_amount (a long's paid with the buy fee, a short's brought in after fee and tax); the totals add
 * 成本 as money put in either way; 現值 = 成本 + 損益. A holding without a live price is "-" and leaves the totals "-"
 * (never 0). */
export function unrealizedRows(positions, markOf) {
  const rows = positions.map((p) => {
    const qty = Number(p.position_qty) || 0;
    const cost = Number(p.cost_amount) || 0;
    const mark = markOf(p.code);
    const pnl = positionUnrealizedPnl(p, mark).unrealized_pnl;
    return { code: p.code, name: p.name, qty, avgCost: num(p.avg_cost), mark: mark > 0 ? mark : null, cost,
      value: pnl === null ? null : cost + pnl, pnl, priced: mark > 0 };
  });
  const missing = rows.filter((r) => !r.priced).map((r) => r.code);
  const cost = rows.reduce((sum, r) => sum + r.cost, 0);
  const pnl = rows.some((r) => r.pnl === null) ? null : rows.reduce((sum, r) => sum + r.pnl, 0);
  const value = pnl === null ? null : cost + pnl;
  return { rows, missing, totals: { cost, value, pnl, roi: pnl === null || !(cost > 0) ? null : (pnl / cost) * 100 } };
}

/** 委託・成交's rows: the day's orders and the trades typed in by hand (no order of their own). A working or cancelled
 * order sorts by when it was placed, a filled one or a trade by its last fill; cancelled ones (and any other order
 * that ended without filling all of it: 已失效, 拒絕) go below the rest, each part newest first. */
export function orderRows(orders, fills) {
  const rows = (orders || []).map((o) => {
    const cancelled = o.final && o.state !== "filled";
    const filled = o.final && o.state === "filled";
    const lastFill = (o.fills || []).at(-1);
    return { key: `o:${o.order_id}`, order: o, cancelled, filled, sortTime: filled && lastFill?.time ? lastFill.time : o.created_at || "" };
  });
  for (const f of fills || []) {
    if (f.origin !== "手動") continue;
    rows.push({ key: `t:${f.trade_id}`, trade: f, cancelled: false, filled: true, sortTime: f.time || "" });
  }
  const byTime = (a, b) => String(b.sortTime).localeCompare(String(a.sortTime));
  return [...rows.filter((r) => !r.cancelled).sort(byTime), ...rows.filter((r) => r.cancelled).sort(byTime)];
}

function tableHtml({ role, wrapRole, columns, empty }) {
  return `<div class="paper-ledger-table-wrap" data-role="${wrapRole}" data-grid-x="hidden" data-grid-variant="card" data-row-stops="1">
      <table class="data-table paper-ledger-table">${renderColumnGroupHtml(columns)}${renderColumnHeaderHtml(columns)}
        <tbody data-role="${role}"><tr><td colspan="${columns.length}" class="muted">${empty}</td></tr></tbody></table></div>`;
}

function shell(search) {
  const tile = (key, label, attr) => `<div class="settings-tile" ${attr}="${key}"><div class="settings-tile-label" data-card-label>${label}</div><div class="settings-tile-value is-mid" data-card-value>--</div></div>`;
  return `<div class="paper-ledger">
    <div class="settings-tiles is-compact paper-ledger-tiles">${tile("limit", "今日額度剩餘", "data-card")}${tile("principal", "模擬庫存餘額", "data-card")}${tile("pnl", "未實現總損益", "data-card")}${tile("due", "淨收付", "data-card")}</div>
    <div class="paper-ledger-message" data-role="ledger-message" aria-live="polite"></div>
    <div class="paper-ledger-grid">
      <div class="paper-ledger-left">
        <div class="paper-ledger-head">
          <div class="settings-seg is-row paper-ledger-tabs" data-role="ledger-tabs" role="tablist">
            <button class="settings-seg-btn is-active" type="button" data-ledger-tab="orders">委託・成交</button><button class="settings-seg-btn" type="button" data-ledger-tab="realized">已實現</button>
          </div>
          <div class="paper-ledger-head-end paper-ledger-search-slot">${search}</div>
        </div>
        <div class="paper-ledger-card" data-role="ledger-orders-view">${tableHtml({ role: "ledger-orders", wrapRole: "ledger-orders-wrap", columns: PAPER_LEDGER_ORDER_COLUMNS, empty: "讀取委託中…" })}</div>
        <div class="paper-ledger-card" data-role="ledger-realized-view" hidden>${tableHtml({ role: "ledger-realized", wrapRole: "ledger-realized-wrap", columns: PAPER_LEDGER_REALIZED_COLUMNS, empty: "讀取已實現中…" })}</div>
      </div>
      <div class="paper-ledger-right">
        <section class="paper-ledger-section" data-role="ledger-unrealized">
          <div class="paper-ledger-head">未實現<span class="paper-ledger-head-end" data-role="unrealized-total">--</span></div>
          <div class="paper-ledger-card">${tableHtml({ role: "ledger-positions", wrapRole: "ledger-positions-wrap", columns: PAPER_LEDGER_POSITION_COLUMNS, empty: "沒有模擬庫存" })}</div>
        </section>
        <section class="paper-ledger-section" data-role="ledger-edit" hidden>
          <div class="paper-ledger-head" data-role="ledger-edit-title"></div>
          <div class="paper-ledger-card paper-ledger-order-card">
            <div class="paper-ledger-book paper-ledger-order-book" data-role="ledger-book" data-component-title="hidden"></div>
            <div class="paper-ledger-edit">
              <div class="settings-seg is-row is-fill paper-ledger-modes" role="group" aria-label="刪改">
                <button class="settings-seg-btn" type="button" data-ledger-mode="cancel">刪單</button><button class="settings-seg-btn" type="button" data-ledger-mode="price">改價</button>
              </div>
              <div class="order-ticket-field">
                <div class="order-ticket-field-head"><span data-role="ledger-amount-label"></span><span class="order-ticket-field-note" data-role="ledger-amount-note"></span></div>
                <div class="order-ticket-stepper">
                  <button class="order-ticket-step" type="button" data-ledger-step="-1" aria-label="減">−</button>
                  <input class="order-ticket-input" data-role="ledger-amount" inputmode="decimal" autocomplete="off" />
                  <button class="order-ticket-step" type="button" data-ledger-step="1" aria-label="加">＋</button>
                </div>
              </div>
              <div class="order-ticket-sides">
                <button class="order-ticket-side neutral" type="button" data-ledger-action="close">取消</button><button class="order-ticket-side" type="button" data-ledger-action="confirm"></button>
              </div>
            </div>
          </div>
        </section>
        <section class="paper-ledger-section" data-role="ledger-order" hidden>
          <div class="paper-ledger-head"><span data-role="order-title"></span><div class="paper-ledger-head-end"><button class="order-ticket-link" type="button" data-order-action="close">回到未實現</button></div></div>
          <div class="paper-ledger-card paper-ledger-order-card">
            <div class="paper-ledger-book paper-ledger-order-book" data-role="order-book" data-component-title="hidden"></div>
            <div class="paper-ledger-ticket" data-role="order-ticket-frame">
              ${orderTicketHtml()}
              <div class="paper-ledger-confirm" data-role="order-confirm" role="dialog" aria-label="確認委託" hidden>
                <div class="paper-ledger-confirm-title" data-role="order-confirm-title"></div>
                <div class="paper-ledger-confirm-row"><span class="muted">委託</span><span data-role="order-confirm-qty"></span></div>
                <div class="paper-ledger-confirm-row"><span class="muted">委託價格</span><span data-role="order-confirm-price"></span></div>
                <div class="paper-ledger-confirm-row"><span class="muted">預估金額</span><span data-role="order-confirm-amount"></span></div>
                <div class="paper-ledger-confirm-actions">
                  <button class="paper-ledger-confirm-button" type="button" data-order-action="cancel">取消</button>
                  <button class="paper-ledger-confirm-button" type="button" data-order-action="confirm"></button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
    <div class="settings-tiles is-inline paper-ledger-sums" data-role="ledger-summary">
      ${["pnl:收益", "roi:報酬率", "value:現值", "cost:成本"].map((s) => { const [key, label] = s.split(":"); return `<div class="settings-tile"><div class="settings-tile-label">${label}</div><b data-sum="${key}">--</b></div>`; }).join("")}
    </div>
  </div>`;
}

/** An opened row's lines, under the table's own columns (the same shares of its width). */
function linesHtml(columns, lines) {
  return `<table class="paper-ledger-lines">${renderColumnGroupHtml(columns)}<tbody>${lines.map((cells) =>
    `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export class PaperLedgerComponent {
  constructor() {
    this.host = null; this.context = null; this.cleanup = [];
    this.orders = { orders: [], loaded: false }; this.fills = null; this.funds = null; this.positions = []; this.pairs = null;
    this.edit = null; this.bookVm = null; this.submitting = false; this.loads = { busy: false, again: false };
    this.ordering = false; this.side = null; this.searchName = ""; this.tab = "orders";
    this.open = new Set();
  }

  mount({ host, context, hydrate }) {
    this.host = host; this.context = context;
    const services = context?.services || {};
    this.store = services.paperOrders || null;
    // Its own provider name: two 模擬帳務 panes each open their own 下單 panel.
    this.searchName = this.store && services.productSearch ? `paper-ledger-${++searchSeq}` : "";
    mountShell(host, shell(productQuoteSearchHtml(this.searchName, { wide: true, placeholder: "代號或名稱" })), { hydrate });
    this.root = host.querySelector(".paper-ledger");
    this.$ = (role) => this.root.querySelector(`[data-role="${role}"]`);
    // The lists: split data grids, never sideways (each column a fixed share of the width).
    this.grids = ["ledger-orders-wrap", "ledger-realized-wrap", "ledger-positions-wrap"].map((role) => this.$(role));
    this.grids.forEach((wrap) => upgradeStandardDataGrid(wrap, { x: "hidden", width: "fill" }));
    syncSegmented(this.$("ledger-tabs"));
    // An opened row's lines open and close with the shared motion; a closed one is drawn again without them.
    this.motion = createExpandMotion({
      find: (key) => recordExpandBody(this.root?.querySelector(`tr[data-detail-key="${CSS.escape(key)}"]`)),
      redraw: () => { this.#renderOrders(); this.#renderRealized(); this.#renderHoldings(); },
    });
    // The search box's typing, ↑/↓, Enter and list clicks are handled once per document (product_quote_search.js).
    if (this.searchName) bindProductQuoteHeaders(this.root);
    this.#bind();
    // The 刪改 panel's 買賣報價: the shared component fed by hand with the order's stock only, as 下單's below -- its
    // 價格 / 漲跌 row over the 5 levels, no 內外盤比 or 價量.
    this.book = new OrderBookComponent({ manual: true, depth: 5, search: "", productIdentity: false, showInsideOutside: false, showPriceVolume: false });
    this.book.mount({ host: this.$("ledger-book"), context: { mode: "live", services: {} }, hydrate: false });
    // The 下單 panel's 買賣報價: the same component, 5 levels, its product row only 價格 and 漲跌 (the title names the stock).
    this.orderBook = new OrderBookComponent({ manual: true, depth: 5, search: "", productIdentity: false, showInsideOutside: false, showPriceVolume: false });
    this.orderBook.mount({ host: this.$("order-book"), context: { mode: "live", services: {} }, hydrate: false });
    // A change to 價格 or 數量 closes the detail: it no longer shows what 確認 would send.
    this.ticket = new OrderTicket(this.$("order-ticket-frame"), {
      onSide: (side) => this.#askConfirm(side), onProblem: (text) => this.#message(text, true), onChange: () => this.#hideConfirm() });
    if (this.searchName) {
      this.cleanup.push(registerProductQuoteSearchProvider(this.searchName, {
        suggest: (text, options) => services.productSearch.suggest(text, options),
        // The page selects the stock (its 買賣報價 then comes through the order book feed), then the panel opens.
        submit: async (item) => {
          const result = await services.productSearch.submit(item);
          if (result?.ok !== false) {
            this.#openOrder(item);
            const input = this.root?.querySelector(".product-quote-code-input");
            if (input) input.value = "";
          }
          return result;
        },
      }));
    }
    this.cleanup.push(context?.dataSource?.subscribe?.("orderbook", (vm) => this.#onBook(vm)) || (() => {}));
    if (services.positionMarks) {
      this.marks = createPositionMarkTracker({ ...services.positionMarks, onChange: () => this.#renderHoldings() });
      this.cleanup.push(() => this.marks?.dispose());
    }
    if (services.paperHoldings) {
      this.cleanup.push(services.paperHoldings.subscribe((pages) => this.#onPositions(pages)));
      services.paperHoldings.refresh({ force: true }).then((pages) => this.#onPositions(pages))
        .catch((error) => this.#fail("讀取模擬庫存", error));
    }
    if (this.store) this.cleanup.push(this.store.subscribe((state) => this.#onOrders(state)));
    else this.#message("這個畫面沒有模擬下單服務", true);
    this.#renderHoldings();
    void this.#load();
  }

  #bind() {
    const on = (node, type, fn) => { node?.addEventListener(type, fn); this.cleanup.push(() => node?.removeEventListener(type, fn)); };
    on(this.root, "click", (event) => {
      const tab = event.target.closest("[data-ledger-tab]");
      if (tab) { this.#setTab(tab.dataset.ledgerTab); return; }
      // While a 刪單／改價 is in flight its order, mode and value stay as sent: nothing in the panel changes them.
      if (this.submitting) return;
      if (this.#orderClick(event)) return;
      const open = event.target.closest("[data-ledger-edit]");
      if (open) { this.#toggleEdit(open.dataset.ledgerEdit); return; }
      const row = event.target.closest("tr[data-row-key]");
      if (row && !event.target.closest("button")) { this.#toggleRow(row.dataset.rowKey); return; }
      const mode = event.target.closest("[data-ledger-mode]");
      if (mode && !mode.disabled) { this.#setMode(mode.dataset.ledgerMode); return; }
      const step = event.target.closest("[data-ledger-step]");
      if (step && !step.disabled) { this.#step(Number(step.dataset.ledgerStep)); return; }
      const action = event.target.closest("[data-ledger-action]");
      if (action?.dataset.ledgerAction === "close") { this.#closeEdit(); return; }
      if (action?.dataset.ledgerAction === "confirm") { this.#submit(action, () => this.#confirm()); return; }
      // A price of the 買賣報價: 改價 at that price.
      const cell = event.target.closest(".orderbook-price-cell");
      const level = cell?.closest("tr[data-orderbook-level]");
      if (cell && level && this.edit && this.book?.lastLevels && this.$("ledger-book").contains(cell)) {
        const side = (cell.classList.contains("bid") ? this.book.lastLevels.bids : this.book.lastLevels.asks)[Number(level.dataset.orderbookLevel)];
        const price = Number(side?.price);
        if (price > 0 && this.#order()?.price_type === "limit") { this.#setMode("price"); this.$("ledger-amount").value = String(price); this.#syncStepper(); }
      }
    });
    on(this.$("ledger-amount"), "input", () => this.#syncStepper());
    on(this.root, "keydown", (event) => {
      if (event.key !== "Escape" || !this.ordering || event.target.closest(".product-quote-search")) return;
      if (!this.$("order-confirm").hidden) this.#hideConfirm(); else this.#closeOrder();
    });
  }

  #setTab(tab) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.root.querySelectorAll("[data-ledger-tab]").forEach((b) => b.classList.toggle("is-active", b.dataset.ledgerTab === tab));
    syncSegmented(this.$("ledger-tabs"));
    this.$("ledger-orders-view").hidden = tab !== "orders";
    this.$("ledger-realized-view").hidden = tab !== "realized";
  }

  // One row's lines open or close; a click while they move is ignored (expand_motion.js).
  #toggleRow(key) {
    const opening = !this.open.has(key);
    if (!this.motion.start(key, opening)) return;
    if (opening) this.open.add(key); else this.open.delete(key);
    this.#renderOrders();
    this.#renderRealized();
    this.#renderHoldings();
  }

  #detailRow(key, colspan, contentHtml) {
    if (!this.open.has(key) && !this.motion.closing(key)) return "";
    return expandDetailRowHtml({ colspan, className: "paper-ledger-detail", contentHtml,
      attrs: `data-morph-key="${escapeHtml(`d:${key}`)}" data-detail-key="${escapeHtml(key)}"` });
  }

  // ------------------------------------------------------------------ data
  #onOrders(state) {
    const before = this.orders.revision;
    this.orders = state;
    this.#renderOrders();
    if (this.edit) {
      const order = this.#order();
      if (!order || order.final) this.#closeEdit();
      else this.#renderEditTitle();
    }
    // A new revision (a fill, a cancel ...) moves the trades, the pairs and the money: read them again.
    if (state.loaded && state.revision !== before) void this.#load();
  }

  #onPositions(pages) {
    this.positions = (pages?.tw?.items || []).filter((p) => Number(p.position_qty));
    this.marks?.sync(this.positions.map((p) => ({ market: "台股", code: p.code, qty: p.position_qty })));
    this.#renderHoldings();
    this.ticket?.setPositions(this.positions);
    void this.#load();
  }

  // The trades typed in by hand, the funds and the day's realized pairs, read again after any change; a change during
  // a read reads once more after it.
  async #load() {
    if (!this.store) return;
    if (this.loads.busy) { this.loads.again = true; return; }
    this.loads.busy = true;
    try {
      const date = this.orders.tradingDate || "";
      const [fills, funds, day] = await Promise.all([this.store.fills(), this.store.funds(), date ? this.store.day(date) : null]);
      if (fills?.ok === false) throw new Error(fills.error || "讀取成交失敗");
      if (funds?.ok === false) throw new Error(funds.error || "讀取資金失敗");
      if (day?.ok === false) throw new Error(day.error || "讀取已實現失敗");
      this.fills = fills?.fills || [];
      this.funds = funds?.capital || null;
      if (day) this.pairs = day.pairs || [];
    } catch (error) {
      this.#fail("讀取成交、已實現與資金", error);
    } finally {
      this.loads.busy = false;
    }
    if (!this.root) return;
    this.#renderOrders();
    this.#renderRealized();
    this.#renderCards();
    this.#renderHoldings();
    this.ticket?.setFunds(this.funds);
    if (this.loads.again) { this.loads.again = false; void this.#load(); }
  }

  #onBook(raw) {
    const vm = orderBookReadView(raw);
    if (!vm) return;
    const code = String(vm.displayCode || vm.code || "").toUpperCase();
    if (this.ordering && code === this.ticket.code) {
      this.orderBook.update(raw);
      this.ticket.setBook(vm);
      this.#renderOrderTitle();
    }
    if (!this.edit || code !== this.edit.code) return;
    this.bookVm = vm;
    this.book.update(raw);
    this.#syncStepper();
  }

  // ------------------------------------------------------------------ render
  #renderCards() {
    const c = this.funds || {};
    const setCard = (key, value, cls = "", label = null) => {
      const card = this.root.querySelector(`[data-card="${key}"]`);
      const node = card.querySelector("[data-card-value]");
      if (node.textContent !== value) node.textContent = value;
      const want = `settings-tile-value is-mid ${cls}`.trim();
      if (node.className !== want) node.className = want;
      if (label !== null && card.querySelector("[data-card-label]").textContent !== label) card.querySelector("[data-card-label]").textContent = label;
    };
    setCard("limit", c.remaining_with_orders == null ? (this.funds ? "未設定" : "--") : money(c.remaining_with_orders), c.remaining_with_orders < 0 ? "price-down" : "");
    setCard("principal", money(c.principal));
    const due = (c.pending || [])[0];
    setCard("due", due ? signed(due.amount) : "--", due ? signClass(due.amount) : "", due ? `${due.settlement_date.slice(5).replace("-", "/")} 淨收付` : "淨收付");
  }

  #renderOrders() {
    const body = this.$("ledger-orders");
    const state = this.orders;
    if (!state.loaded) { morphInto(body, '<tr><td colspan="5" class="muted">讀取委託中…</td></tr>'); return; }
    if (state.error) { morphInto(body, `<tr><td colspan="5" class="danger-text">${escapeHtml(state.error)}</td></tr>`); return; }
    const rows = orderRows(state.orders, this.fills);
    if (!rows.length) { morphInto(body, '<tr><td colspan="5" class="muted">今天沒有委託</td></tr>'); return; }
    morphInto(body, rows.map((row) => this.#orderRowHtml(row)).join(""));
    this.motion.play();
  }

  #orderRowHtml(row) {
    const open = this.open.has(row.key) || this.motion.closing(row.key);
    if (row.trade) {
      // A trade typed in by hand: filled, no order behind it.
      const f = row.trade;
      const lines = [[escapeHtml(toMinute(f.time)), money(f.avg_price), `${money(f.qty)} 股`, "", "成交"]];
      return `<tr class="paper-ledger-row paper-ledger-done${open ? " expanded" : ""}" data-morph-key="${escapeHtml(row.key)}" data-row-key="${escapeHtml(row.key)}">
          <td class="paper-ledger-name">${tinted(stockName(f.code, f.name), "")}</td><td>${money(f.avg_price)}</td><td>${money(f.qty)} 股</td>
          <td>${escapeHtml(f.time || "")}</td><td>${tinted(f.action, sideClass(f.action))}</td></tr>
        ${this.#detailRow(row.key, 5, linesHtml(PAPER_LEDGER_ORDER_COLUMNS, lines))}`;
    }
    const o = row.order;
    const units = (shares) => money(paperOrderUnitCount(o.lot, shares));
    const unit = o.lot === "odd" ? "股" : "張";
    const priceText = o.price == null ? "市價" : money(o.price);
    const working = !o.final;
    const lastFill = (o.fills || []).at(-1);
    // A working or cancelled order keeps its state; a filled one shows what it did.
    const cells = row.filled
      ? [money(o.avg_price), `${money(o.filled)} 股`, escapeHtml(lastFill?.time || "")]
      : [priceText, `${units(o.filled)}／${units(o.qty)} ${unit}`,
        working ? `<span class="settings-badge">${escapeHtml(o.state_label)}</span>${(o.messages || []).length ? `<span class="paper-ledger-notice">${escapeHtml(o.messages.at(-1))}</span>` : ""}` : escapeHtml(o.state_label)];
    const op = working
      ? `<button class="settings-row-btn" type="button" data-ledger-edit="${escapeHtml(o.order_id)}">刪改</button>`
      : row.filled ? tinted(o.side, sideClass(o.side)) : "";
    // 委託 at the price it was placed at, then each 改價 (the same order at its new price) and 成交 in time order.
    const changes = o.price_changes;
    const placedAt = changes.length ? changes[0].from : o.price;
    const later = [...changes.map((c) => ({ time: c.time, cells: [money(c.to), "", "", "改價"] })),
      ...(o.fills || []).map((f) => ({ time: f.time, cells: [money(f.price), `${money(f.qty)} 股`, "", "成交"] }))]
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const lines = [[escapeHtml(toMinute(o.created_at)), placedAt == null ? "市價" : money(placedAt), `${money(o.qty)} 股`, "", "委託"],
      ...later.map((line) => [escapeHtml(toMinute(line.time)), ...line.cells])];
    const selected = this.edit?.orderId === o.order_id;
    return `<tr class="paper-ledger-row${o.final ? " paper-ledger-done" : ""}${open ? " expanded" : ""}${selected ? " selected" : ""}" data-morph-key="${escapeHtml(row.key)}" data-row-key="${escapeHtml(row.key)}">
        <td class="paper-ledger-name">${tinted(stockName(o.code, o.name), o.final ? "" : sideClass(o.side))}</td>
        ${cells.map((cell) => `<td>${cell}</td>`).join("")}<td>${op}</td></tr>
      ${this.#detailRow(row.key, 5, linesHtml(PAPER_LEDGER_ORDER_COLUMNS, lines))}`;
  }

  #renderRealized() {
    const body = this.$("ledger-realized");
    if (this.pairs === null) { morphInto(body, '<tr><td colspan="5" class="muted">讀取已實現中…</td></tr>'); return; }
    if (!this.pairs.length) { morphInto(body, '<tr><td colspan="5" class="muted">今天還沒有已實現</td></tr>'); return; }
    morphInto(body, this.pairs.map((p) => {
      const key = `r:${p.id}`;
      const open = this.open.has(key) || this.motion.closing(key);
      // 價金 is what really moved: the buy's 價金 + 手續費, the sell's 價金 − 手續費 − 交易稅 (the ledger's amounts).
      const buyNet = Number(p.buy_amount) + Number(p.buy_fee);
      const sellNet = Number(p.sell_amount) - Number(p.sell_fee) - Number(p.tax);
      const roi = p.roi === null || p.roi === undefined ? "--" : tinted(`${Math.abs(p.roi * 100).toFixed(2)}%`, signClass(p.roi));
      const detail = `<table class="paper-ledger-pair"><thead><tr><th></th><th>買入</th><th>賣出</th></tr></thead><tbody>
          <tr><th>時間</th><td>${escapeHtml(legTime(p.buy_ref))}</td><td>${escapeHtml(legTime(p.sell_ref))}</td></tr>
          <tr><th>單價</th><td>${money(p.buy_price)}</td><td>${money(p.sell_price)}</td></tr>
          <tr><th>價金</th><td>${money(Math.round(buyNet))}</td><td>${money(Math.round(sellNet))}</td></tr>
          <tr><th>報酬率</th><td colspan="2">${roi}</td></tr></tbody></table>`;
      return `<tr class="paper-ledger-row${open ? " expanded" : ""}" data-morph-key="${escapeHtml(key)}" data-row-key="${escapeHtml(key)}">
          <td class="paper-ledger-name">${escapeHtml(stockName(p.code, p.name))}</td><td>${money(p.qty)}</td><td>${money(p.buy_price)}</td>
          <td>${money(p.sell_price)}</td><td>${tinted(signed(Math.round(p.profit)), signClass(p.profit))}</td></tr>
        ${this.#detailRow(key, 5, detail)}`;
    }).join(""));
    this.motion.play();
  }

  #renderHoldings() {
    if (!this.root) return;
    const { rows, totals } = unrealizedRows(this.positions, (code) => this.marks?.mark(code) ?? null);
    // 股數 and 總損益 carry no sign (使用者 11-04): the colour says which way it went. A row opens to 均價 / 市價 over
    // 成本 / 現值 (使用者 11-11), 市價 and 現值 "-" until the stock has a live price.
    const figure = (label, value) => `<div class="paper-ledger-figure"><span>${label}</span><b>${value}</b></div>`;
    morphInto(this.$("ledger-positions"), rows.length ? rows.map((r) => {
      const key = `p:${r.code}`;
      const open = this.open.has(key) || this.motion.closing(key);
      const detail = `<div class="paper-ledger-figures">${figure("均價", r.avgCost === null ? "-" : money(Math.round(r.avgCost * 100) / 100))}${figure("市價", r.mark === null ? "-" : money(r.mark))}
        ${figure("成本", money(Math.round(r.cost)))}${figure("現值", r.value === null ? "-" : money(Math.round(r.value)))}</div>`;
      return `<tr class="paper-ledger-row${open ? " expanded" : ""}" data-morph-key="${escapeHtml(key)}" data-row-key="${escapeHtml(key)}">
      <td class="paper-ledger-name">${escapeHtml(stockName(r.code, r.name))}</td><td>${money(Math.abs(r.qty))}</td>
      <td>${r.pnl === null ? "-" : tinted(money(Math.abs(Math.round(r.pnl))), signClass(r.pnl))}</td>
    </tr>${this.#detailRow(key, 3, detail)}`;
    }).join("") : '<tr><td colspan="3" class="muted">沒有模擬庫存</td></tr>');
    this.motion.play();
    const set = (node, text, cls = "") => {
      if (node.textContent !== text) node.textContent = text;
      if (node.className !== cls) node.className = cls;
    };
    const pnl = totals.pnl === null ? "-" : signed(Math.round(totals.pnl));
    const pnlClass = totals.pnl === null ? "" : signClass(totals.pnl);
    const sum = (key) => this.root.querySelector(`[data-sum="${key}"]`);
    set(sum("pnl"), pnl, pnlClass);
    set(sum("roi"), totals.roi === null ? "-" : `${Math.abs(totals.roi).toFixed(2)}%`, totals.roi === null ? "" : signClass(totals.roi));
    set(sum("value"), totals.value === null ? "-" : money(Math.round(totals.value)));
    set(sum("cost"), money(Math.round(totals.cost)));
    set(this.$("unrealized-total"), pnl, `paper-ledger-head-end ${pnlClass}`.trim());
    set(this.root.querySelector('[data-card="pnl"] [data-card-value]'), pnl, `settings-tile-value is-mid ${pnlClass}`.trim());
  }

  // 未實現 and its figures at the bottom are shown unless the 刪改 or 下單 card is in its place (which then takes the
  // figures' height too).
  #showUnrealized() {
    const replaced = Boolean(this.edit) || this.ordering;
    this.$("ledger-unrealized").hidden = replaced;
    this.$("ledger-summary").hidden = replaced;
  }

  // ------------------------------------------------------------------ 刪改
  #order() { return (this.orders.orders || []).find((o) => o.order_id === this.edit?.orderId) || null; }
  #units(order) { return paperOrderUnitCount(order.lot, order.unfilled); }
  /** The day's official 漲停 / 跌停 from the order's book, or null while the provider has published none. */
  #limits() {
    const up = num(this.bookVm?.limitUp), down = num(this.bookVm?.limitDown);
    return up > 0 && down > 0 ? { up, down } : null;
  }

  #toggleEdit(orderId) {
    if (this.edit?.orderId === orderId) { this.#closeEdit(); return; }
    const order = (this.orders.orders || []).find((o) => o.order_id === orderId);
    if (!order || order.final) return;
    this.#closeOrder();
    this.edit = { orderId, code: String(order.code).toUpperCase(), mode: "cancel", kind: null };
    // 改價 steps on the 升降單位 of the order's instrument kind (the product catalog's).
    lookupInstrumentKind(this.edit.code).then((kind) => {
      if (this.edit?.orderId === orderId) this.edit.kind = kind || null;
    }, (error) => console.warn(`[paper ledger: looking up the instrument kind of ${order.code}] failed`, error));
    this.bookVm = null;
    this.$("ledger-edit").hidden = false;
    this.#showUnrealized();
    this.root.querySelector('[data-ledger-mode="price"]').disabled = order.price_type !== "limit";
    this.#renderEditTitle();
    this.#setMode("cancel");
    this.#renderOrders();
    // The 買賣報價 follows the page's selected stock: 刪改 selects the order's stock. Pressing 刪改 is the user's click;
    // the market panel accepts only its own reasons (market_panel_ui_state.js), the source says where it came from.
    const selected = String(this.context?.symbolStore?.getSelectedSymbol?.() || "").toUpperCase();
    if (selected !== this.edit.code) {
      this.context?.services?.selection?.select?.(this.edit.code, { reason: "USER_CLICK", source: "paper_ledger", trigger: "ledger_edit" });
    }
    this.context?.dataSource?.invalidate?.("orderbook", { symbol: this.edit.code });
  }

  #closeEdit() {
    this.edit = null;
    this.bookVm = null;
    if (!this.root) return;
    this.$("ledger-edit").hidden = true;
    this.#showUnrealized();
    this.#renderOrders();
  }

  #renderEditTitle() {
    const o = this.#order();
    if (!o) return;
    const html = `刪改 ${escapeHtml(stockText(o.code, o.name))} ${tinted(o.side, sideClass(o.side))} ${o.price == null ? "市價" : money(o.price)}`;
    const node = this.$("ledger-edit-title");
    if (node.innerHTML !== html) node.innerHTML = html;
    if (this.edit?.mode) this.#renderAmountHead(o);
  }

  // The row's name and the line under it: 刪單 張數 (股數 for 零股) with what is left, 改價 價格 with the order's price.
  #renderAmountHead(order) {
    const cancel = this.edit.mode === "cancel";
    const unit = order.lot === "odd" ? "股" : "張";
    const label = cancel ? (order.lot === "odd" ? "股數" : "張數") : "價格";
    const note = cancel ? `剩 ${money(this.#units(order))} ${unit}` : `原 ${order.price == null ? "市價" : money(order.price)}`;
    const labelNode = this.$("ledger-amount-label"), noteNode = this.$("ledger-amount-note");
    if (labelNode.textContent !== label) labelNode.textContent = label;
    if (noteNode.textContent !== note) noteNode.textContent = note;
  }

  #setMode(mode) {
    const order = this.#order();
    if (!order) return;
    this.edit.mode = mode;
    this.root.querySelectorAll("[data-ledger-mode]").forEach((b) => b.classList.toggle("is-active", b.dataset.ledgerMode === mode));
    syncSegmented(this.root.querySelector(".paper-ledger-modes"));
    this.$("ledger-amount").value = mode === "cancel" ? String(this.#units(order)) : String(order.price ?? "");
    this.#renderAmountHead(order);
    const confirm = this.root.querySelector('[data-ledger-action="confirm"]');
    confirm.textContent = mode === "cancel" ? "確認刪單" : "確認改價";
    confirm.classList.toggle("danger", mode === "cancel");
    confirm.classList.toggle("primary", mode === "price");
    this.#syncStepper();
  }

  // − / ＋ stop at the edge: 刪單 1 … what is left, 改價 跌停 … 漲停. The 改價 digits take the colour of 昨收's side.
  #syncStepper() {
    const order = this.#order();
    const input = this.$("ledger-amount");
    if (!order || !input) return;
    const value = Number(String(input.value).replace(/,/g, ""));
    let lo = 1, hi = this.#units(order);
    if (this.edit.mode === "price") { const limits = this.#limits(); lo = limits?.down ?? -Infinity; hi = limits?.up ?? Infinity; }
    this.root.querySelector('[data-ledger-step="-1"]').disabled = Number.isFinite(value) && value <= lo;
    this.root.querySelector('[data-ledger-step="1"]').disabled = Number.isFinite(value) && value >= hi;
    const ref = num(this.bookVm?.prevClose);
    const cls = this.edit.mode !== "price" || !(ref > 0) || !(value > 0) ? "" : value > ref ? "up" : value < ref ? "down" : "flat";
    const want = `order-ticket-input ${cls}`.trim();
    if (input.className !== want) input.className = want;
  }

  #step(direction) {
    const order = this.#order();
    if (!order) return;
    const input = this.$("ledger-amount");
    const value = Number(String(input.value).replace(/,/g, "")) || 0;
    if (this.edit.mode === "cancel") {
      input.value = String(Math.min(this.#units(order), Math.max(1, Math.round(value) + direction)));
    } else {
      const limits = this.#limits();
      const base = value > 0 ? value : Number(order.price) || 0;
      let next = stepPrice(base, direction, tickTable(this.funds?.price_policy, this.edit.kind));
      if (limits) next = Math.min(limits.up, Math.max(limits.down, next));
      input.value = String(next);
    }
    this.#syncStepper();
  }

  // A 確認 (刪改's or 下單's) sends once: a second press while it is out joins it. This component is the one writer of
  // the two buttons' `disabled`, which says just that.
  #submit(button, send) {
    const flight = runSingleFlight(button, send);
    this.#syncSubmitButtons();
    void flight.finally(() => this.#syncSubmitButtons());
  }

  #syncSubmitButtons() {
    if (!this.root) return;
    for (const button of this.root.querySelectorAll('[data-ledger-action="confirm"], [data-order-action="confirm"]')) {
      button.disabled = inFlight(button);
    }
  }

  async #confirm() {
    const order = this.#order();
    if (!order) { this.#closeEdit(); return; }
    const input = this.$("ledger-amount");
    const value = Number(String(input.value).replace(/,/g, ""));
    const mode = this.edit.mode;
    this.submitting = true;
    input.readOnly = true;
    try {
      if (mode === "cancel") {
        const left = this.#units(order);
        if (!Number.isInteger(value) || value < 1 || value > left) throw new Error(`刪單數量要在 1～${left} ${order.lot === "odd" ? "股" : "張"}之間`);
        if (value === left) await this.store.cancel(order.order_id);
        else await this.store.reduce(order.order_id, order.lot === "odd" ? value : value * LOT);
      } else {
        const limits = this.#limits();
        if (!(value > 0)) throw new Error("請輸入價格");
        if (limits && (value > limits.up || value < limits.down)) throw new Error(`價格要在跌停 ${money(limits.down)}～漲停 ${money(limits.up)} 之間`);
        await this.store.replace(order.order_id, value);
      }
      this.#message("");
      this.#closeEdit();
    } catch (error) {
      console.warn("[paper ledger: 刪改] refused", error);
      this.#message(String(error?.message || error), true);
    } finally {
      this.submitting = false;
      input.readOnly = false;
    }
  }

  // ------------------------------------------------------------------ 下單
  /** Open the 下單 panel on `code` at `price` (a 買賣報價 price clicked on the page, paper_order_entry.js). */
  openOrderAt({ code, name = "", price = null } = {}) { this.#openOrder({ code, name }, price); }

  #openOrder(item, price = null) {
    const code = String(item?.code || "").trim().toUpperCase();
    if (!code || !this.root) return;
    if (this.edit) this.#closeEdit();
    this.ticket.open({ code, name: item?.name, price });
    this.ordering = true;
    this.#hideConfirm();
    this.ticket.setFunds(this.funds);
    this.ticket.setPositions(this.positions);
    this.#renderOrderTitle();
    this.$("ledger-order").hidden = false;
    this.#showUnrealized();
    this.context?.dataSource?.invalidate?.("orderbook", { symbol: code });
  }

  #closeOrder() {
    if (!this.ordering) return;
    this.ordering = false;
    this.ticket.close();
    if (!this.root) return;
    this.#hideConfirm();
    this.$("ledger-order").hidden = true;
    this.#showUnrealized();
  }

  #renderOrderTitle() {
    const text = `下單 ${this.ticket.code}${this.ticket.name && this.ticket.name !== this.ticket.code ? ` ${this.ticket.name}` : ""}`;
    const node = this.$("order-title");
    if (node.textContent !== text) node.textContent = text;
  }

  /** The 下單 panel's own clicks (the ticket's, 回到未實現, the detail's, a 買賣報價 price); true when it was one. */
  #orderClick(event) {
    if (!this.ordering || !this.$("ledger-order").contains(event.target)) return false;
    const button = event.target.closest("[data-order-action]");
    const action = button?.dataset.orderAction;
    if (action === "close") { this.#closeOrder(); return true; }
    if (action === "cancel") { this.#hideConfirm(); return true; }
    if (action === "confirm") { this.#submit(button, () => this.#placeOrder()); return true; }
    if (this.ticket.handleClick(event)) return true;
    // A price of the 買賣報價: 價格 at that price.
    const cell = event.target.closest(".orderbook-price-cell");
    const row = cell?.closest("tr[data-orderbook-level]");
    if (cell && row && this.orderBook?.lastLevels) {
      const level = (cell.classList.contains("bid") ? this.orderBook.lastLevels.bids : this.orderBook.lastLevels.asks)[Number(row.dataset.orderbookLevel)];
      this.ticket.setPrice(Number(level?.price));
      return true;
    }
    return false;
  }

  // The detail over the button pressed: what 確認 sends.
  #askConfirm(side) {
    this.#message("");
    this.side = side;
    const d = this.ticket.describe(side);
    this.$("order-confirm-title").innerHTML = `${tinted(d.word, side === "buy" ? "price-up" : "price-down")} ${escapeHtml(d.stock)}`;
    this.$("order-confirm-qty").textContent = d.qty;
    const price = this.$("order-confirm-price");
    price.textContent = d.price;
    price.className = d.priceClass;
    this.$("order-confirm-amount").textContent = d.amount;
    const ok = this.root.querySelector('[data-order-action="confirm"]');
    ok.textContent = `確認${d.word}`;
    ok.classList.toggle("buy", side === "buy");
    ok.classList.toggle("sell", side === "sell");
    const box = this.$("order-confirm");
    box.classList.toggle("sell", side === "sell");
    // Over the button pressed: its top, measured in the ticket's frame (geometry, not a style override).
    const frame = this.$("order-ticket-frame").getBoundingClientRect();
    box.style.bottom = `${frame.bottom - this.ticket.sideButton(side).getBoundingClientRect().top + 6}px`;
    box.hidden = false;
    ok.focus();
  }

  #hideConfirm() {
    const box = this.root && this.$("order-confirm");
    if (box && !box.hidden) box.hidden = true;
  }

  // An order placed shows up in 委託・成交 by itself: only what went wrong is said (使用者 11-04).
  async #placeOrder() {
    if (!this.ordering || !this.side || !this.store) return;
    const problem = this.ticket.problem();
    if (problem) { this.#message(problem, true); this.#hideConfirm(); return; }
    this.submitting = true;
    try {
      await this.store.place(this.ticket.order(this.side));
      this.#message("");
      this.#closeOrder();
    } catch (error) {
      console.warn("[paper ledger: 下單] refused", error);
      this.#message(String(error?.message || error), true);
      this.#hideConfirm();
    } finally {
      this.submitting = false;
    }
  }

  // ------------------------------------------------------------------ messages
  #fail(what, error) {
    console.warn(`[paper ledger: ${what}] failed`, error);
    this.#message(`${what}失敗：${error?.message || error}`, true);
  }

  /** The line under the tiles: what went wrong, or nothing. */
  #message(text, isError = false) {
    const node = this.root && this.$("ledger-message");
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("error", Boolean(isError));
  }

  resize() {}

  destroy() {
    for (const fn of this.cleanup.splice(0)) try { fn(); } catch (error) { console.warn("[paper ledger: cleanup] failed", error); }
    for (const wrap of this.grids || []) try { destroyStandardDataGrid(wrap); } catch (error) { console.warn("[paper ledger: releasing a list's grid] failed", error); }
    try { this.book?.destroy?.(); } catch (error) { console.warn("[paper ledger: destroying the 買賣報價] failed", error); }
    try { this.orderBook?.destroy?.(); } catch (error) { console.warn("[paper ledger: destroying the 下單 買賣報價] failed", error); }
    try { this.ticket?.destroy(); } catch (error) { console.warn("[paper ledger: destroying the order ticket] failed", error); }
    this.book = null; this.orderBook = null; this.ticket = null; this.marks = null; this.grids = null; this.motion = null;
    this.host = null; this.root = null; this.context = null;
  }
}
