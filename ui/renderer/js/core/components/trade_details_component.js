import { CleanupBag } from "../cleanup_bag.js";
import { renderPanelTabs } from "../panel_tabs.js";
import { escapeHtml, formatPrice, byRole as role } from "../utility.js";
import { applyColumnSchema, destroyColumnTitle, renderColumnHeaderHtml } from "../column_title.js";
import { TRADE_DETAILS_COLUMNS } from "../column_schemas.js";
import { destroyStandardDataGrid, enableCompleteRowDataGridScroll } from "../data_grid.js";
import { mountShell } from "../component_shell.js";
import { titleBarMarkup } from "./title_bar.js";
import { signedValueClass } from "../market_color_policy.js";

function profitText(v) { const n = Number(v); return Number.isFinite(n) ? Math.abs(Math.round(n)).toLocaleString("zh-TW") : "--"; }

function shell() {
  return `<div class="record-panel">
    ${titleBarMarkup({ title: "交易明細" })}
    <div class="record-panel-filter-row trade-details-filter-row">
      <div data-role="trade-filter-tabs" class="tab-list"></div>
      <div data-role="trade-pagination" class="trade-details-pagination" aria-label="交易明細頁碼">
        <button type="button" data-page-action="first">第一頁</button>
        <button type="button" data-page-action="prev">上一頁</button>
        <input data-role="trade-page-input" type="number" min="1" value="1" inputmode="numeric" aria-label="交易明細頁碼" />
        <span class="trade-details-page-total">/ <span data-role="trade-total-pages">1</span></span>
        <button type="button" data-page-action="next">下一頁</button>
        <button type="button" data-page-action="last">最後一頁</button>
      </div>
    </div>
    <div data-role="trade-scroll" class="trade-details-table-wrap" data-grid-x="hidden">
      <table data-role="trade-table" class="record-table trade-details-table">
        ${renderColumnHeaderHtml(TRADE_DETAILS_COLUMNS)}
        <tbody data-role="trade-body"><tr><td colspan="9" class="empty">尚無交易明細</td></tr></tbody>
      </table>
    </div>
  </div>`;
}

export class TradeDetailsComponent {
  constructor() {
    this.host = null;
    this.context = null;
    this.cleanup = new CleanupBag("trade details");
    this.vm = {};
    this.rowSnap = null;
  }

  mount({ host, context, hydrate }) {
    this.host = host;
    this.context = context;
    mountShell(host, shell(), { hydrate });
    applyColumnSchema(role(host, "trade-table"), TRADE_DETAILS_COLUMNS, {
      schemaId: "tradeDetails",
      resize: { storageKey: "historyTradeRecordsColumnWidthsV1", defaultMinWidth: 48, floorWidth: 36, fitToAvailable: true },
    });

    const refresh = () => context?.dataSource?.invalidate("tradeDetails", {
      symbol: context?.symbolStore?.getSelectedSymbol?.(),
      timestamp: context?.currentTimestamp?.get?.(),
    });
    this.cleanup.push(context?.symbolStore?.subscribe?.(refresh) || (() => {}));
    this.cleanup.push(context?.dataSource?.subscribe?.("tradeDetails", (vm) => this.update(vm)) || (() => {}));

    const body = role(host, "trade-body");
    const rowClick = (event) => {
      const row = event.target?.closest?.("tr[data-trade-id]");
      if (!row || !body?.contains?.(row)) return;
      const id = String(row.dataset.tradeId || "");
      const item = (Array.isArray(this.vm?.rows) ? this.vm.rows : []).find((x) => String(x?.id ?? "") === id);
      if (item) this.context?.services?.tradeDetails?.onRowSelect?.(item);
    };
    body?.addEventListener?.("click", rowClick);
    this.cleanup.push(() => body?.removeEventListener?.("click", rowClick));

    const pagination = role(host, "trade-pagination");
    const pageClick = (event) => {
      const button = event.target?.closest?.("button[data-page-action]");
      if (!button || !pagination?.contains?.(button) || button.disabled) return;
      this._requestPage(String(button.dataset.pageAction || ""));
    };
    pagination?.addEventListener?.("click", pageClick);
    this.cleanup.push(() => pagination?.removeEventListener?.("click", pageClick));

    const pageInput = role(host, "trade-page-input");
    const jump = () => {
      const total = Math.max(1, Number(this.vm?.totalPages) || 1);
      const page = Math.max(1, Math.min(total, Math.trunc(Number(pageInput?.value) || 1)));
      if (pageInput) pageInput.value = String(page);
      if (page !== Number(this.vm?.page || 1)) this.context?.services?.tradeDetails?.onPageRequest?.({ direction: "jump", page });
    };
    const keydown = (event) => { if (event.key === "Enter") { event.preventDefault(); jump(); pageInput?.blur?.(); } };
    pageInput?.addEventListener?.("keydown", keydown);
    pageInput?.addEventListener?.("change", jump);
    this.cleanup.push(() => pageInput?.removeEventListener?.("keydown", keydown), () => pageInput?.removeEventListener?.("change", jump));

    this.rowSnap = enableCompleteRowDataGridScroll(role(host, "trade-scroll"), {
      rowHeightVar: "--row-height-trade-record",
      wheelStepRows: 1,
      discreteRail: true,
    }).rowSnap;
    refresh();
  }

  _tabs(vm) {
    const symbol = String(vm?.selectedSymbol || "").trim();
    const name = String(vm?.selectedName || "").trim();
    const date = String(vm?.selectedDate || "").slice(0, 10);
    return [
      { id: "OVERVIEW", name: "總覽", title: "全部歷史已配對交易", closable: false },
      { id: "TODAY", name: "今日", title: `${date || "目前日期"}－所有已配對交易`, closable: false },
      { id: "SYMBOL", name: symbol || "個股", title: `${symbol || "目前個股"}${name ? ` ${name}` : ""}－所有歷史已配對交易`, closable: false },
    ];
  }

  _renderTabs(vm) {
    const host = role(this.host, "trade-filter-tabs");
    if (!host) return;
    const tabs = this._tabs(vm);
    const scope = String(vm?.scope || "overview");
    const activeKey = scope === "today" ? "TODAY" : scope === "symbol" ? "SYMBOL" : "OVERVIEW";
    renderPanelTabs(host, {
      tabs,
      activeKey,
      keyOf: (tab) => String(tab.id || ""),
      labelOf: (tab) => tab.name || tab.id || "",
      titleOf: (tab) => tab.title || tab.name || tab.id || "",
      closableOf: () => false,
      onSelect: (key) => {
        const nextScope = String(key) === "TODAY" ? "today" : String(key) === "SYMBOL" ? "symbol" : "overview";
        if (nextScope !== String(this.vm?.scope || "overview")) this.context?.services?.tradeDetails?.onScopeChange?.(nextScope);
      },
    });
  }

  _requestPage(action) {
    const page = Math.max(1, Number(this.vm?.page) || 1);
    const totalPages = Math.max(1, Number(this.vm?.totalPages) || 1);
    const request = { direction: action, page };
    if (action === "first") request.page = 1;
    else if (action === "prev") { request.page = Math.max(1, page - 1); request.cursor = String(this.vm?.prevCursor || ""); }
    else if (action === "next") { request.page = Math.min(totalPages, page + 1); request.cursor = String(this.vm?.nextCursor || ""); }
    else if (action === "last") request.page = totalPages;
    else return;
    this.context?.services?.tradeDetails?.onPageRequest?.(request);
  }

  _renderPagination(vm) {
    const page = Math.max(1, Number(vm?.page) || 1);
    const totalPages = Math.max(1, Number(vm?.totalPages) || 1);
    const input = role(this.host, "trade-page-input");
    const total = role(this.host, "trade-total-pages");
    const pagination = role(this.host, "trade-pagination");
    if (input) { input.value = String(page); input.max = String(totalPages); input.disabled = Boolean(vm?.loading); }
    if (total) total.textContent = String(totalPages);
    pagination?.querySelectorAll?.("button[data-page-action]").forEach((button) => {
      const action = String(button.dataset.pageAction || "");
      if (action === "first" || action === "prev") button.disabled = Boolean(vm?.loading) || !Boolean(vm?.hasPrev);
      else if (action === "next" || action === "last") button.disabled = Boolean(vm?.loading) || !Boolean(vm?.hasNext);
    });
  }

  _renderRows(vm) {
    const body = role(this.host, "trade-body");
    if (!body) return;
    const rows = Array.isArray(vm?.rows) ? vm.rows : [];
    if (vm?.loading && !rows.length) {
      body.innerHTML = `<tr><td colspan="9" class="empty">交易明細載入中…</td></tr>`;
      return;
    }
    if (!rows.length) {
      const symbol = String(vm?.selectedSymbol || "");
      const scope = String(vm?.scope || "overview");
      const fallback = scope === "symbol" && symbol
        ? `${symbol} 尚無歷史已配對交易`
        : scope === "today"
          ? "此日期尚無已配對交易"
          : "尚無歷史已配對交易";
      body.innerHTML = `<tr><td colspan="9" class="empty">${escapeHtml(vm?.emptyText || fallback)}</td></tr>`;
      return;
    }
    const selectedDate = String(vm?.selectedDate || "").slice(0, 10);
    const selectedId = String(vm?.selectedTradeId || "");
    body.innerHTML = rows.map((item) => {
      const date = String(item?.realized_date || "").slice(0, 10);
      const dateClass = date === selectedDate ? " trade-details-current-date" : "";
      const selectedClass = String(item?.id ?? "") === selectedId ? " trade-details-selected-row" : "";
      const direction = String(item?.direction || "");
      const directionClass = direction === "多" ? "price-up" : direction === "空" ? "price-down" : "price-flat";
      return `<tr class="trade-details-row${dateClass}${selectedClass}" data-trade-id="${escapeHtml(String(item?.id ?? ""))}" data-history-daytrade-date="${escapeHtml(date)}">
        <td>${escapeHtml(date || "--")}</td><td>${escapeHtml(item?.code || "")}</td><td class="trade-details-name">${escapeHtml(item?.name || "")}</td>
        <td class="trade-details-direction ${directionClass}">${escapeHtml(direction || "--")}</td><td>${escapeHtml(item?.entry_ref || "--")}</td>
        <td>${escapeHtml(item?.exit_ref || "--")}</td><td>${Number.isFinite(Number(item?.buy_price)) ? formatPrice(item.buy_price) : "--"}</td>
        <td>${Number.isFinite(Number(item?.sell_price)) ? formatPrice(item.sell_price) : "--"}</td><td class="${signedValueClass(item?.profit)}">${escapeHtml(profitText(item?.profit))}</td>
      </tr>`;
    }).join("");
  }

  update(vm = {}) {
    this.vm = vm || {};
    this._renderTabs(this.vm);
    this._renderPagination(this.vm);
    this._renderRows(this.vm);
    this.rowSnap?.refreshContent?.({
      topologyChanged: false,
      logicalRows: Array.isArray(this.vm?.rows) ? this.vm.rows.length : 0,
    });
  }

  resize() { this.rowSnap?.scheduleMeasure?.(); }

  destroy() {
    destroyColumnTitle(role(this.host, "trade-table"));
    destroyStandardDataGrid(role(this.host, "trade-scroll"));
    this.rowSnap = null;
    this.cleanup.release();
    this.host = null;
    this.context = null;
    this.vm = {};
  }
}
