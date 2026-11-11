import { tradesReadView } from "../../core/market_read_model.js";
import { buildTradeRow, emptyTradeRow, patchTradeRow, tradeRowModel } from "../../core/trade_rows.js";
import { syncViewLifecycle } from "../../core/view_lifecycle.js";
import { ROW_WASH_MS, washRow } from "../../core/row_wash.js";
import { RowSnapController } from "../../core/row_snap.js";

const WORKSPACE_TRADE_LIMIT = 100;
// New prints get the main 成交明細's row wash.
const HIGHLIGHT_MS = ROW_WASH_MS;

// A row is its print's durable sequence (as tradeRowKey in trade_row_order.js); `sequence` is not one number space.
function rowIdentity(row = {}) {
  const durable = Number(row?.ingestSequence ?? row?.ingest_sequence);
  if (Number.isFinite(durable) && durable > 0) return `seq:${durable}`;
  return [row?.time ?? row?.datetime ?? row?.timestamp ?? "", row?.price ?? "", row?.volume ?? ""].join("|");
}

export class WorkspaceTradesComponent {
  constructor() {
    this.host = null;
    this.context = null;
    this.cleanup = [];
    this.body = null;
    this.emptyText = null;
    this.symbol = "";
    this.renderedIds = new Set();
    this.highlightStartedAt = new Map();
    // id -> <tr> of the rows on screen; this component is their only writer.
    this.rowNodes = new Map();
    this.rowSnap = null;
  }

  mount({ host, context }) {
    this.host = host;
    this.context = context;
    host.innerHTML = `<div class="workspace-trades-root">
      <div class="workspace-trades-scroll">
        <table class="tick-table workspace-trades-table lined-rows"><tbody data-role="workspace-trades-body"><tr><td colspan="3" class="empty">等待即時成交</td></tr></tbody></table>
      </div>
    </div>`;
    // Whole rows only, as the main 成交明細: the leftover height is shared among the rows and a wheel detent moves one.
    this.rowSnap = new RowSnapController({ viewport: host.querySelector(".workspace-trades-scroll"), rowSelector: "tbody tr",
      rowHeightVar: "--row-height-trade-detail", rowUnit: true, measureActualRow: true, fitViewportRows: true, distributeRemainder: true }).mount();
    this.cleanup.push(context?.dataSource?.subscribe?.("tickDetails", (vm) => this.update(vm)) || (() => {}));
    context?.dataSource?.invalidate?.("tickDetails", { symbol: context?.symbolStore?.getSelectedSymbol?.() });
  }

  update(input = {}) {
    const vm = tradesReadView(input);
    if (!vm) return;
    syncViewLifecycle(this.host, vm);
    const body = this.body || this.host?.querySelector?.('[data-role="workspace-trades-body"]');
    if (!body) return;
    this.body = body;
    const rows = (Array.isArray(vm?.rows) ? vm.rows : []).slice(0, WORKSPACE_TRADE_LIMIT);
    const doc = body.ownerDocument;
    if (!rows.length) {
      const text = vm?.loading ? "成交明細載入中…" : String(vm?.emptyText || "等待即時成交");
      if (this.emptyText !== text || this.rowNodes.size) {
        body.replaceChildren(emptyTradeRow(doc, text));
        this.rowNodes.clear();
        this.emptyText = text;
      }
      return;
    }
    this.emptyText = null;
    // Only rows arriving on top of an already-rendered list flash; the first page and a symbol change do not.
    const now = performance.now();
    const ids = rows.map(rowIdentity);
    const symbol = String(vm?.logicalCode ?? "");
    if (symbol !== this.symbol) { this.symbol = symbol; this.renderedIds.clear(); this.highlightStartedAt.clear(); }
    if (this.renderedIds.size) {
      for (const id of ids) if (!this.renderedIds.has(id) && !this.highlightStartedAt.has(id)) this.highlightStartedAt.set(id, now);
    }
    for (const [id, startedAt] of this.highlightStartedAt) {
      if (now - startedAt >= HIGHLIGHT_MS) this.highlightStartedAt.delete(id);
    }
    this.renderedIds = new Set(ids);
    // A new print moves the list down by one: the rows already drawn keep their elements and only what they show
    // differently is written (a new reference price recolours the prices in place); new prints are built.
    const next = new Map();
    let anchor = body.firstElementChild;
    if (!this.rowNodes.size) { body.replaceChildren(); anchor = null; }
    rows.forEach((row, i) => {
      const id = ids[i];
      const model = tradeRowModel(row, vm, id, { anchored: false });
      let node = next.has(id) ? null : this.rowNodes.get(id);
      if (node) patchTradeRow(node, model);
      else {
        node = buildTradeRow(doc, model, { identityAttribute: "data-workspace-trade", sideAttributes: false });
        const startedAt = this.highlightStartedAt.get(id);
        if (startedAt != null) washRow(node, startedAt);
      }
      if (node !== anchor) body.insertBefore(node, anchor);
      else anchor = anchor.nextElementSibling;
      next.set(next.has(id) ? `${id}\u0000${i}` : id, node);
    });
    for (const [id, node] of this.rowNodes) if (next.get(id) !== node) node.remove();
    while (anchor) { const stale = anchor; anchor = anchor.nextElementSibling; if (stale.parentNode === body) stale.remove(); }
    this.rowNodes = next;
    this.rowSnap?.refreshContent({ topologyChanged: true });
  }

  resize() {}

  destroy() {
    for (const cleanup of this.cleanup.splice(0)) {
      try { cleanup(); } catch (error) { console.warn("[workspace trades: cleanup] failed", error); }
    }
    this.rowSnap?.destroy();
    this.rowSnap = null;
    this.host = null;
    this.context = null;
    this.body = null;
    this.emptyText = null;
    this.renderedIds.clear();
    this.highlightStartedAt.clear();
    this.rowNodes = new Map();
  }
}

export { WORKSPACE_TRADE_LIMIT };
