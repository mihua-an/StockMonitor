// 歷史回放's 交易明細: every 當沖 pair of the ledger, or one date's (總覽｜今日), narrowed by the code or name typed. A row is
// 模擬帳務's 已實現 row (ledger_list.js) with its 股數 in the side's colour (多 up, 空 down); it opens to 買入 / 賣出, and opening it
// replays that trade.
import { CleanupBag } from "../cleanup_bag.js";
import { byRole as role } from "../utility.js";
import { morphInto } from "../dom_morph.js";
import { PAPER_LEDGER_REALIZED_COLUMNS } from "../column_schemas.js";
import { destroyStandardDataGrid, recordExpandBody, upgradeStandardDataGrid } from "../data_grid.js";
import { createExpandMotion } from "../expand_motion.js";
import { syncSegmented } from "../settings_ui.js";
import { mountShell } from "../component_shell.js";
import { titleBarMarkup } from "./title_bar.js";
import { bindDateMenu, dateOptionsHtml } from "./date_menu.js";
import { ledgerMessageHtml, ledgerPairRowHtml, ledgerTableHtml } from "./ledger_list.js";

const COLSPAN = PAPER_LEDGER_REALIZED_COLUMNS.length;
const SIDE_CLASS = { 多: "price-up", 空: "price-down" };
const keyOf = (item) => `t:${item.id}`;

function shell() {
  return `<div class="record-panel">
    ${titleBarMarkup({ title: "交易明細" })}
    <div class="ledger-head">
      <div class="ledger-search-slot"><div class="product-quote-search wide"><input type="text" class="product-quote-code-input" data-role="trade-query" autocomplete="off" spellcheck="false" aria-label="輸入代號或名稱篩選" placeholder="代號或名稱"></div></div>
      <div class="settings-seg is-row ledger-tabs" data-role="trade-scope" role="tablist">
        <button class="settings-seg-btn" type="button" data-trade-scope="overview">總覽</button><button class="settings-seg-btn" type="button" data-trade-scope="today">今日</button>
      </div>
      <div class="ledger-head-end">
        <div data-role="trade-date-picker" class="event-feed-date-picker">
          <button data-role="trade-date-button" class="event-feed-date-button" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="交易日期"><span data-role="trade-date-label">----</span><span class="event-feed-date-caret" aria-hidden="true">▾</span></button>
          <div data-role="trade-date-menu" class="event-feed-date-menu" hidden><div data-role="trade-date-list" class="event-feed-date-list" role="listbox" aria-label="交易日期清單"></div></div>
        </div>
      </div>
    </div>
    <div class="ledger-card">${ledgerTableHtml({ role: "trade-body", wrapRole: "trade-scroll", columns: PAPER_LEDGER_REALIZED_COLUMNS, empty: "交易明細載入中…" })}</div>
  </div>`;
}

export class TradeDetailsComponent {
  constructor() {
    this.host = null;
    this.context = null;
    this.cleanup = new CleanupBag("trade details");
    this.vm = {};
    this.open = new Set();
    this.motion = null;
    this.dateMenu = null;
  }

  mount({ host, context, hydrate }) {
    this.host = host;
    this.context = context;
    mountShell(host, shell(), { hydrate });
    upgradeStandardDataGrid(role(host, "trade-scroll"), { x: "hidden", width: "fill" });
    // A row's detail opens and closes with the shared motion; a closed one is drawn again without it.
    this.motion = createExpandMotion({
      find: (key) => recordExpandBody(this.host?.querySelector(`tr[data-detail-key="${CSS.escape(key)}"]`)),
      redraw: () => this._renderRows(),
    });
    this._bind(host);
    const refresh = () => context?.dataSource?.invalidate("tradeDetails", {
      symbol: context?.symbolStore?.getSelectedSymbol?.(),
      timestamp: context?.currentTimestamp?.get?.(),
    });
    this.cleanup.push(context?.dataSource?.subscribe?.("tradeDetails", (vm) => this.update(vm)) || (() => {}));
    refresh();
  }

  _bind(host) {
    const service = () => this.context?.services?.tradeDetails;
    const on = (node, type, fn) => { node.addEventListener(type, fn); this.cleanup.push(() => node.removeEventListener(type, fn)); };
    on(role(host, "trade-query"), "input", (event) => service()?.onQueryChange?.(event.target.value));
    on(role(host, "trade-scope"), "click", (event) => {
      const button = event.target.closest("[data-trade-scope]");
      if (button && button.dataset.tradeScope !== this.vm?.scope) service()?.onScopeChange?.(button.dataset.tradeScope);
    });
    on(role(host, "trade-body"), "click", (event) => {
      const row = event.target.closest("tr[data-row-key]");
      if (row) this._toggle(row.dataset.rowKey);
    });
    // The card clips what it holds, so the open menu goes to <body>; its nodes are kept here.
    const picker = role(host, "trade-date-picker"), list = role(host, "trade-date-list"), label = role(host, "trade-date-label");
    const menu = bindDateMenu({
      picker, button: role(host, "trade-date-button"), menu: role(host, "trade-date-menu"), list, attribute: "trade-date", portal: true,
      onSelect: (value) => service()?.onDateSelect?.(value),
    });
    this.dateMenu = { list, label, reposition: menu.reposition };
    this.cleanup.push(() => menu.destroy(), () => { this.dateMenu = null; });
  }

  // Opening a row also replays its trade; a click while it moves is ignored (expand_motion.js).
  _toggle(key) {
    const opening = !this.open.has(key);
    if (!this.motion.start(key, opening)) return;
    if (opening) this.open.add(key); else this.open.delete(key);
    this._renderRows();
    const item = opening ? (this.vm?.rows || []).find((row) => keyOf(row) === key) : null;
    if (item) this.context?.services?.tradeDetails?.onRowSelect?.(item);
  }

  _renderHead() {
    const { scope, query = "", date = "", dates = [] } = this.vm;
    const seg = role(this.host, "trade-scope");
    seg.querySelectorAll("[data-trade-scope]").forEach((button) => button.classList.toggle("is-active", button.dataset.tradeScope === scope));
    syncSegmented(seg);
    const input = role(this.host, "trade-query");
    if (input.value !== query && input.ownerDocument.activeElement !== input) input.value = query;
    const { list, label, reposition } = this.dateMenu;
    label.textContent = date || "----";
    const signature = JSON.stringify([date, dates]);
    if (signature === this.datesSignature) return;
    this.datesSignature = signature;
    morphInto(list, dateOptionsHtml(dates, date, "trade-date"));
    reposition();
  }

  _renderRows() {
    const { rows = [], loading, loaded, error, scope, query, date, selectedTradeId } = this.vm;
    const body = role(this.host, "trade-body");
    if (!body) return;
    if (!rows.length) {
      const empty = error || (loading || !loaded ? "交易明細載入中…"
        : query ? "沒有符合的交易" : scope === "today" ? `${date || "這天"} 沒有已配對交易` : "尚無歷史已配對交易");
      morphInto(body, ledgerMessageHtml(COLSPAN, empty, error ? "danger-text" : "muted"));
      return;
    }
    morphInto(body, rows.map((item) => {
      const key = keyOf(item);
      return ledgerPairRowHtml(item, { key, open: this.open.has(key) || this.motion.closing(key),
        selected: String(item.id) === String(selectedTradeId ?? ""), qtyClass: SIDE_CLASS[item.direction] || "" });
    }).join(""));
    this.motion.play();
  }

  update(vm = {}) {
    this.vm = vm || {};
    this._renderHead();
    this._renderRows();
  }

  resize() {}

  destroy() {
    destroyStandardDataGrid(role(this.host, "trade-scroll"));
    this.cleanup.release();
    this.host = null;
    this.context = null;
    this.motion = null;
    this.vm = {};
  }
}
