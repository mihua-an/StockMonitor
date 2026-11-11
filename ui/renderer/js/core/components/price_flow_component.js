import { CleanupBag } from "../cleanup_bag.js";
// 價量: the selected instrument's per-price 大單／小單 買賣量 (core/price_flow_ladder.js) -- 大單 and 小單 side by
// side around the price, each on its own scale; above it one 內外盤比 bar each for 大單 and 小單 below it (外盤 = their
// buying, 內盤 = their selling). Volume matched by a call auction (the open, the close, a 處置股, 緩漲緩跌) is
// neither and is not shown. The table shows whole rows only; the height left over goes to the two bars.
// Data: the page's "priceFlow" resolver (the Market Runtime view's price_volume channel, classified by Rust B).

import { escapeHtml, byRole as role } from "../utility.js";
import { buildPriceFlowRows, patchLargeSmallLadder, priceFlowTotals, releaseLargeSmallLadder } from "../price_flow_ladder.js";
import { componentUpdated } from "../market_render_trace.js";
import { morphInto } from "../dom_morph.js";
import { mountShell } from "../component_shell.js";
import { enableRowUnitScroll } from "../row_snap.js";
import { DiscreteRowScrollbarController } from "../discrete_row_scrollbar.js";
import { ioRatioMarkup, ioRatioNodes, patchIoRatio } from "./io_ratio.js";
import { fitWholeRows } from "../whole_row_fit.js";

const ROW_PITCH = 20;           // a price row (price-flow.css), also the sticky header's height
const SUMMARY_MIN_HEIGHT = 52;  // the two 內外盤比 bars at their natural height

function shell() {
  return `<div class="price-flow">
    <div class="price-flow-body">
      <div data-role="price-flow-scroll" class="price-flow-scroll"><div class="empty">等待逐價大小單資料</div></div>
      <aside data-role="price-flow-rail" class="shared-discrete-row-rail price-flow-rail" aria-label="價量捲軸"></aside>
    </div>
    <div data-role="price-flow-summary" class="price-flow-summary" hidden>${ioRatioMarkup({ label: "大單" })}${ioRatioMarkup({ label: "小單" })}</div>
  </div>`;
}

// The two bars' nodes: 大單 first, 小單 second.
function summaryBars(summary) {
  summary._bars ??= [...summary.querySelectorAll('[data-role="io-ratio"]')].map(ioRatioNodes);
  return summary._bars;
}

export class PriceFlowComponent {
  constructor() {
    this.host = null; this.context = null; this.cleanup = new CleanupBag("price flow"); this.vm = {}; this.identity = ""; this.rowSnap = null; this.scrollbar = null; this.rowCount = 0;
    // Following the current price (使用者 10-22): on while the current price row is on screen. A price that moves past
    // the edge scrolls the ladder just enough to show it again; scrolled away to read other prices, the ladder stays
    // where it was put until the current price is scrolled back into view.
    this.following = true;
  }

  mount({ host, context, hydrate }) {
    this.host = host; this.context = context;
    mountShell(host, shell(), { hydrate });
    // Same scrolling as 成交明細: a wheel detent, a touchpad swipe or an arrow key moves exactly one price row, and a
    // dragged scrollbar settles on a row boundary (row_snap.js RowSnapController, row-unit mode).
    this.rowSnap = enableRowUnitScroll({
      viewport: role(host, "price-flow-scroll"), rowSelector: "tbody tr", rowHeightVar: "--row-height-price-flow",
      maskRemainder: false, measureActualRow: true,
    });
    // The same ▲ / thumb / ▼ scrollbar as 成交明細 and the product lists (the native one is hidden).
    const viewport = role(host, "price-flow-scroll");
    const trackScroll = () => {
      this.scrollSeen = viewport.scrollTop;
      const shown = this._visibleRows(viewport);
      const index = this._currentIndex(viewport);
      if (shown && index >= 0) this.following = index >= shown.top && index <= shown.bottom;
    };
    viewport?.addEventListener?.("scroll", trackScroll, { passive: true });
    this.cleanup.push(() => viewport?.removeEventListener?.("scroll", trackScroll));
    this.scrollbar = new DiscreteRowScrollbarController({
      host: role(host, "price-flow-rail"), viewport: role(host, "price-flow-scroll"), getLogicalRowCount: () => this.rowCount,
    }).mount();
    // Whole rows: the table's height is its header plus whole price rows; the rest goes to the 內外盤比 bars.
    const summary = role(host, "price-flow-summary");
    this.fit = fitWholeRows({
      flex: summary, list: host.querySelector(".price-flow-body"),
      // The row height price-flow.css fixes; a measurement taken before the first rows arrived read the placeholder.
      rowPitch: () => ROW_PITCH,
      headerHeight: () => viewport?.querySelector?.("thead")?.getBoundingClientRect?.().height || ROW_PITCH,
      minFlex: () => (summary?.hidden ? 0 : SUMMARY_MIN_HEIGHT),
    });
    const refresh = () => context?.dataSource?.invalidate("priceFlow", { symbol: context?.symbolStore?.getSelectedSymbol?.() });
    this.cleanup.push(context?.symbolStore?.subscribe?.(refresh) || (() => {}));
    this.cleanup.push(context?.dataSource?.subscribe?.("priceFlow", (vm) => this.update(vm)) || (() => {}));
    refresh();
  }

  update(vm = {}) { this.vm = vm || {}; this.render(); }

  // The price rows wholly on screen, by index: the sticky header takes the first row's height.
  _visibleRows(scroll) {
    const pitch = this.rowSnap?.rowHeight || 0;
    if (!(pitch > 0) || !scroll?.clientHeight) return null;
    const top = Math.round(scroll.scrollTop / pitch);
    const visible = Math.max(1, Math.floor(scroll.clientHeight / pitch) - 1);
    return { top, bottom: top + visible - 1, visible };
  }

  _currentIndex(scroll) {
    const row = scroll?.querySelector?.("tbody tr.is-current");
    return row ? Array.prototype.indexOf.call(row.parentNode.children, row) : -1;
  }

  // While following, a current price anywhere on screen -- the top or bottom row too -- leaves the panel where it is;
  // one past the top or bottom row is scrolled back just onto that row, no room kept (使用者 10-22).
  _followCurrentPrice(scroll) {
    if (!this.following) return;
    const shown = this._visibleRows(scroll);
    const index = this._currentIndex(scroll);
    if (!shown || index < 0 || (index >= shown.top && index <= shown.bottom)) return;
    const top = index < shown.top ? index : index - shown.visible + 1;
    const target = Math.max(0, Math.min(top, this.rowCount - shown.visible));
    if (target === shown.top) return;
    if (this.rowSnap?.scrollToIndex) this.rowSnap.scrollToIndex(target);
    else scroll.scrollTop = target * (this.rowSnap?.rowHeight || 0);
  }

  render() {
    const scroll = role(this.host, "price-flow-scroll");
    if (!scroll) return;
    const vm = this.vm || {};
    const { rows, classified } = buildPriceFlowRows(vm.priceVolume);
    const summary = role(this.host, "price-flow-summary");
    const identity = String(vm.identity || vm.code || "");
    if (!rows.length || !classified) {
      if (summary && !summary.hidden) { summary.hidden = true; this.fit?.refresh?.(); }
      releaseLargeSmallLadder(scroll);
      const message = rows.length ? "此商品沒有大單規則，無法區分大小單" : (vm.message || "等待逐價大小單資料");
      morphInto(scroll, `<div class="empty">${escapeHtml(message)}</div>`);
      // No ladder: no rows, top of the panel, and the scrollbar says so (never the last instrument's).
      this.rowCount = 0;
      scroll.scrollTop = 0;
      this.scrollSeen = 0;
      this.rowSnap?.refreshContent?.({ logicalRows: 0 });
      this.scrollbar?.syncScrollbar?.();
      this.identity = identity;
      componentUpdated("priceflow", vm, this.host);
      return;
    }
    const totals = priceFlowTotals(vm.priceVolume);
    // Only what moved is written (the bars' shares, the table's rows kept by price).
    if (summary) {
      if (summary.hidden) { summary.hidden = false; this.fit?.refresh?.(); }
      const [large, small] = summaryBars(summary);
      patchIoRatio(large, { outside: totals.largeBuy, inside: totals.largeSell });
      patchIoRatio(small, { outside: totals.smallBuy, inside: totals.smallSell });
    }
    const context = { currentPrice: vm.currentPrice, referencePrice: vm.referencePrice };
    // Pushes update the ladder continuously: keep where the user scrolled, centre the current price when a different
    // instrument (or session) is shown, and while following keep the current price on screen. Rows updated in place
    // cannot move the scroll position, so it is put back only when rows were added or removed -- from the position the
    // scroll listener saw last (reading scrollTop here forced a layout on every update).
    const sameInstrument = identity === this.identity && this.scrollSeen !== undefined;
    const topologyChanged = patchLargeSmallLadder(scroll, rows, context);
    // The sticky header is one row tall, so it counts as a row: the last price can still be scrolled into view.
    this.rowCount = rows.length + 1;
    this.rowSnap?.refreshContent?.({ logicalRows: this.rowCount });
    if (sameInstrument) {
      if (topologyChanged) scroll.scrollTop = this.scrollSeen;
      this._followCurrentPrice(scroll);
    } else {
      this.following = true;
      // A new instrument: measure its rows, then put the current price mid-panel on a whole-row boundary.
      this.rowSnap?.measure?.(false);
      const all = [...scroll.querySelectorAll("tbody tr")];
      const index = all.findIndex((row) => row.classList.contains("is-current"));
      const pitch = this.rowSnap?.rowHeight || all[0]?.offsetHeight || 0;
      if (index >= 0 && pitch > 0 && scroll.clientHeight) {
        const visible = Math.max(1, Math.floor(scroll.clientHeight / pitch) - 1);
        if (this.rowSnap?.scrollToIndex) this.rowSnap.scrollToIndex(Math.max(0, index - Math.floor(visible / 2)));
        else scroll.scrollTop = Math.max(0, index - Math.floor(visible / 2)) * pitch;
      }
      this.scrollSeen = scroll.scrollTop;
    }
    this.identity = identity;
    componentUpdated("priceflow", vm, this.host);
  }

  destroy() {
    this.cleanup.release();
    this.scrollbar?.destroy?.();
    this.scrollbar = null;
    this.fit?.destroy?.();
    this.fit = null;
    this.rowSnap?.destroy?.();
    this.rowSnap = null;
    this.host = null; this.context = null;
  }
}
