import { CleanupBag } from "../cleanup_bag.js";
import {
  normalizeBigOrderFlowView, renderBigOrderFlowViewTabs, renderUnifiedBigOrderInOut, renderUnifiedBigOrderRatios,
  renderUnifiedBigOrderMinuteVolume, bigOrderFlowBuckets, bigOrderBucketWindow, flowChartMinuteAt, flowChartMinutePercent,
  flowMinuteDetail, flowQuoteHtml,
} from "../big_order_flow.js";
import { componentUpdated } from "../market_render_trace.js";
import { enableRowUnitScroll } from "../row_snap.js";
import { DiscreteRowScrollbarController } from "../discrete_row_scrollbar.js";
import { PresentationRevisionGate } from "../display_frame_gate.js";
import { byRole as role, escapeHtml } from "../utility.js";
import { morphInto } from "../dom_morph.js";
import { mountShell } from "../component_shell.js";
import { titleBarMarkup } from "./title_bar.js";
import { fitWholeRows } from "../whole_row_fit.js";

// A bucket's list is asked again only when its large volume moved, and not more often than this; a failed answer
// (B unavailable, timeout) waits longer before the next try.
const WINDOW_REQUERY_MS = 2000;
const WINDOW_RETRY_AFTER_FAILURE_MS = 10000;

const LARGE_ORDER_ROW_PITCH = 26;  // a 分時 large-order row (trade-flow.css)
const DEFAULT_SCOPE_LABEL = "當日交易時段";

// The bucket rows' own height (their first top to their last bottom, plus the list's padding): the least the
// bucket list may be given before the large-order list takes the rest in whole rows.
function bucketListContentHeight(list) {
  const first = list?.firstElementChild, last = list?.lastElementChild;
  if (!first || !last) return 0;
  const style = getComputedStyle(list);
  return last.getBoundingClientRect().bottom - first.getBoundingClientRect().top + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
}

function shell() {
  return `<div class="trade-flow">${titleBarMarkup({ title: "大單流向" })}`
    + `<div data-role="flow-tabs" class="big-order-view-tabs panel-tabs-compact" role="tablist" aria-label="大單流向檢視"></div>`
    + `<div data-role="flow-content" class="big-order-content"></div></div>`;
}

export class TradeFlowComponent {
  constructor() {
    this.host = null;
    this.context = null;
    this.cleanup = new CleanupBag("trade flow");
    this.vm = {};
    this.activeKey = "inout";
    this.activeWindow = "300s";
    this.displayMode = "cumulative";
    this.sideFilter = "ALL";
    this.bucketKey = "all";
    this.renderedActiveKey = "";
    this.windowOrders = null;
    this.windowQuery = null;
    this.hoverMinute = null;
  }

  mount({ host, context, hydrate }) {
    this.host = host;
    this.context = context;
    // A selection-scoped live surface: the same presentation fence as 五檔/成交明細.
    this.displayFrameGate = new PresentationRevisionGate();
    mountShell(host, shell(), { hydrate });
    const refresh = () => context?.dataSource?.invalidate("tradeFlow", { symbol: context?.symbolStore?.getSelectedSymbol?.() });
    this.cleanup.push(context?.symbolStore?.subscribe?.(refresh));
    this.cleanup.push(context?.dataSource?.subscribe?.("tradeFlow", (vm) => this.update(vm)));
    this.bindCrosshair();
    this.bindControls();
    refresh();
  }

  renderTabs() {
    const tabs = role(this.host, "flow-tabs");
    if (!tabs || this.renderedActiveKey === this.activeKey) return;
    renderBigOrderFlowViewTabs(tabs, {
      activeKey: this.activeKey,
      onSelect: (key) => {
        this.activeKey = normalizeBigOrderFlowView(key);
        this.render();
      },
    });
    this.renderedActiveKey = this.activeKey;
  }

  // The view's controls (累計／分時, 時間區間, 單別, the 分時 buckets) are kept across renders (the content is morphed,
  // not rebuilt), so one delegated listener on the content serves them all.
  bindControls() {
    const content = role(this.host, "flow-content");
    if (!content?.addEventListener) return;
    this.cleanup.listen(content, "click", (event) => {
      const mode = event.target?.closest?.("[data-flow-display-mode]");
      if (mode) {
        this.displayMode = String(mode.dataset.flowDisplayMode || "minute") === "cumulative" ? "cumulative" : "minute";
        this.render();
        return;
      }
      const bucket = event.target?.closest?.("[data-flow-bucket]");
      if (bucket) {
        this.bucketKey = String(bucket.dataset.flowBucket || "all");
        this.render();
      }
    });
    this.cleanup.listen(content, "change", (event) => {
      const target = event.target;
      if (target?.matches?.("[data-flow-window-select]")) {
        this.activeWindow = String(target.value || "300s");
        this.render();
      } else if (target?.matches?.("[data-flow-side-filter]")) {
        this.sideFilter = String(target.value || "ALL").toUpperCase();
        this.render();
      }
    });
  }

  update(vm = {}) {
    if (this.displayFrameGate && !this.displayFrameGate.accept(vm)) return;
    this.vm = vm || {};
    if (vm.activeKey) this.activeKey = normalizeBigOrderFlowView(vm.activeKey);
    if (vm.activeWindow) this.activeWindow = String(vm.activeWindow);
    this.scheduleRender();
  }

  // Pushes arrive many times a second: they are drawn once per frame, and a frame whose markup is what is already on
  // screen touches no DOM (never rebuilding the whole chart HTML and re-binding its controls per push). The first push
  // of a frame is drawn at once -- the page delivers its updates from its own frame callback, and deferring that to
  // another requestAnimationFrame drew 大單流向 a frame after 五檔 and 價量 -- and later pushes of the same frame are
  // drawn once, at the next. A user's click still renders at once through render().
  scheduleRender() {
    if (typeof requestAnimationFrame !== "function") {
      this.render();
      return;
    }
    if (this.renderFrame) {
      this.renderPending = true;
      return;
    }
    this.renderAndHoldFrame();
  }

  renderAndHoldFrame() {
    if (this.host) this.render();
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      if (this.renderPending) {
        this.renderPending = false;
        this.renderAndHoldFrame();
      }
    });
  }

  // Only what changed is written: the charts' paths, the numbers, new list rows; the controls stay as they are.
  replaceContent(content, html) {
    const changed = morphInto(content, html);
    if (this.listScrollTarget && !content.contains(this.listScrollTarget)) this.releaseListScroll();
    if (content.dataset) content.dataset.flowRendered = "1";
    return changed;
  }

  // Everything the visible markup is built from: the UI choices and the immutable view-state objects the flow came
  // from (vm.flowSource). Unchanged -> the frame skips the chart/list builders entirely (a stable feed would
  // otherwise rebuild the whole markup every frame just to find it equal). A VM without flowSource always builds.
  renderInputs(vm) {
    if (!Array.isArray(vm.flowSource)) return null;
    return [this.activeKey, this.displayMode, this.activeWindow, this.sideFilter, this.bucketKey, this.windowOrders,
      vm.scopeLabel, vm.availability, ...vm.flowSource];
  }

  render() {
    this.renderTabs();
    const content = role(this.host, "flow-content");
    if (!content) return;
    const vm = this.vm || {};
    const flow = vm.flow || {};
    // The analysis is not there yet (a replay's step B has not built): said so, never an empty chart and a 0% that
    // read as data. The tabs stay.
    if (vm.pending) {
      this.renderedInputs = null;
      this.replaceContent(content, `<div class="empty">${escapeHtml(vm.message || "計算中")}</div>`);
      componentUpdated("tradeflow", vm, this.host);
      return;
    }
    const inputs = this.renderInputs(vm);
    const last = this.renderedInputs;
    const unchanged = inputs && last && content.dataset?.flowRendered === "1"
      && inputs.length === last.length && inputs.every((value, i) => value === last[i]);
    if (unchanged) {
      if (this.activeKey !== "inout" && this.activeKey !== "ratio") this.requestWindowOrders(vm, flow);
      componentUpdated("tradeflow", vm, this.host);
      return;
    }
    this.renderedInputs = inputs;
    // Data availability controls chart contents, never whether the component
    // shell/tabs are rendered. Empty projections keep the same surface.
    if (this.activeKey === "inout") {
      const html = renderUnifiedBigOrderInOut(flow, { displayMode: this.displayMode });
      if (this.replaceContent(content, html)) this.paintCrosshair();
    } else if (this.activeKey === "ratio") {
      this.replaceContent(content, renderUnifiedBigOrderRatios(flow, { activeWindow: this.activeWindow }));
    } else {
      this.renderMinuteVolume(content, vm, flow);
    }
    componentUpdated("tradeflow", vm, this.host);
  }

  // Flow pushes re-render this tab continuously; keep the large-order list where the user scrolled it. The morph
  // keeps the list element, so its position survives by itself; it is put back only on a new list, from the position
  // the list's scroll listener saw (reading scrollTop before each morph forced a layout).
  renderMinuteVolume(content, vm, flow) {
    const previousList = this.listScrollTarget;
    const scrollTop = this.listScrollTop || 0;
    this.requestWindowOrders(vm, flow);
    // Only an answer for THIS instrument partition: one asked before a symbol/session switch is never shown.
    const identity = vm.largeOrderIdentity || vm.logicalCode || "";
    const windowOrders = this.windowOrders && this.windowOrders.identity === identity ? this.windowOrders : null;
    const html = renderUnifiedBigOrderMinuteVolume(flow, {
      scopeLabel: vm.scopeLabel || DEFAULT_SCOPE_LABEL, sideFilter: this.sideFilter, bucketKey: this.bucketKey, windowOrders,
    });
    if (!this.replaceContent(content, html)) return;
    const list = content.querySelector?.("[data-flow-large-order-list]");
    if (list && scrollTop && list !== previousList) list.scrollTop = scrollTop;
    this.mountListScroll(content, list);
  }

  // 分時's list scrolls like 成交明細: one row per wheel detent / arrow key, the shared ▲ thumb ▼ scrollbar. The list
  // is re-rendered on every push, so the two controllers are re-mounted on the new list each time.
  mountListScroll(content, list) {
    const rail = content.querySelector?.("[data-flow-large-order-rail]");
    if (!list || !rail) {
      this.releaseListScroll();
      return;
    }
    const rows = () => list.querySelectorAll(".flow-large-order-row").length;
    if (this.listScrollTarget !== list || this.listScrollRail !== rail) {
      this.releaseListScroll();
      this.listScrollTarget = list;
      this.listScrollRail = rail;
      const track = () => { this.listScrollTop = list.scrollTop; };
      list.addEventListener?.("scroll", track, { passive: true });
      this.listScrollUntrack = () => list.removeEventListener?.("scroll", track);
      this.listRowSnap = enableRowUnitScroll({
        viewport: list, rowSelector: ".flow-large-order-row", rowHeightVar: "--row-height-flow-large-order",
        maskRemainder: false, measureActualRow: true,
      });
      this.listScrollbar = new DiscreteRowScrollbarController({ host: rail, viewport: list, getLogicalRowCount: rows }).mount();
      // Whole rows only: the list's height is a whole number of rows; the height left over goes to the bucket rows.
      const buckets = content.querySelector?.(".flow-hour-share-list");
      // A new bucket (the next hour) or a bucket row that changes height is measured again by the fit itself.
      this.listFit = fitWholeRows({
        flex: buckets, list: list.parentElement, rowPitch: () => LARGE_ORDER_ROW_PITCH, minFlex: () => bucketListContentHeight(buckets),
      });
    }
    this.listRowSnap?.refreshContent?.({ logicalRows: rows() });
  }

  releaseListScroll() {
    this.listScrollUntrack?.();
    this.listScrollUntrack = null;
    this.listScrollTarget = null;
    this.listScrollRail = null;
    this.listScrollbar?.destroy?.();
    this.listScrollbar = null;
    this.listRowSnap?.destroy?.();
    this.listRowSnap = null;
    this.listFit?.destroy?.();
    this.listFit = null;
  }

  // 分時: the selected bucket's complete list comes from Rust B (vm.queryLargeOrders); the flow alone holds only
  // the newest few hundred prints. One query in flight; asked again when the bucket or its large volume changes.
  requestWindowOrders(vm, flow) {
    if (typeof vm.queryLargeOrders !== "function" || this.windowQuery) return;
    const buckets = bigOrderFlowBuckets(flow);
    const bucket = buckets.find((b) => b.key === this.bucketKey) || buckets[0];
    if (!bucket) return;
    const identity = vm.largeOrderIdentity || vm.logicalCode || "";
    // The side filter is part of the query (Rust B filters before its limit), so it is part of the cache key.
    const side = this.sideFilter === "BUY" || this.sideFilter === "SELL" ? this.sideFilter : "ALL";
    const key = `${identity}|${bucket.key}|${side}`;
    const volume = side === "BUY" ? bucket.buy : side === "SELL" ? bucket.sell : bucket.buy + bucket.sell;
    const current = this.windowOrders;
    if (current && current.key === key) {
      const age = Date.now() - current.at;
      const fresh = current.ok ? current.volume === volume || age < WINDOW_REQUERY_MS : age < WINDOW_RETRY_AFTER_FAILURE_MS;
      if (fresh) return;
    }
    const asked = { key, identity, bucket, side, volume };
    const failure = (error) => ({ ok: false, error: error?.message || String(error) });
    let query = null;
    try {
      query = vm.queryLargeOrders({ ...bigOrderBucketWindow(bucket), side });
    } catch (error) {
      this.recordWindowQueryOutcome(asked, failure(error), error);
      return;
    }
    if (!query || typeof query.then !== "function") return;
    this.windowQuery = query;
    query.then(
      (result) => { if (this.windowQuery === query) this.recordWindowQueryOutcome(asked, result, null); },
      (error) => { if (this.windowQuery === query) this.recordWindowQueryOutcome(asked, failure(error), error); },
    );
  }

  // Every end of a bucket query -- a result, an answered failure, a rejection or a synchronous throw -- is kept with
  // its time under the query's key, so a failure waits WINDOW_RETRY_AFTER_FAILURE_MS before the same query is asked
  // again; every failure is logged with the bucket it was for.
  recordWindowQueryOutcome({ key, identity, bucket, side, volume }, result, error) {
    this.windowQuery = null;
    const ok = Boolean(result?.ok);
    const reason = ok ? "" : String(result?.reason || result?.error || "failed");
    if (!ok) console.warn(`[trade flow: large orders for ${identity} ${bucket.key} ${side}] failed: ${reason}`, error || result);
    if (!this.host) return;
    this.windowOrders = {
      key, identity, bucketKey: bucket.key, side, volume, at: Date.now(), ok, reason,
      rows: ok && Array.isArray(result?.rows) ? result.rows : [],
      truncated: ok && Boolean(result?.truncated),
    };
    this.render();
  }

  // 進出: one minute under the mouse, marked on both charts (大單 / 小單) with that minute's 買/賣/超 and the 累計超.
  // Pushes re-render the charts, so the hovered minute is kept and painted again after each render.
  bindCrosshair() {
    const content = role(this.host, "flow-content");
    if (!content?.addEventListener) return;
    this.cleanup.listen(content, "mousemove", (event) => {
      const svg = event.target?.closest?.(".flow-chart-plot")?.querySelector?.(".flow-chart-svg");
      const minute = svg ? flowChartMinuteAt(svg, event.clientX) : null;
      if (minute === this.hoverMinute) return;
      this.hoverMinute = minute;
      this.paintCrosshair();
    });
    this.cleanup.listen(content, "mouseleave", () => {
      if (this.hoverMinute == null) return;
      this.hoverMinute = null;
      this.paintCrosshair();
    });
  }

  paintCrosshair() {
    const content = role(this.host, "flow-content");
    if (!content) return;
    const detail = this.activeKey !== "inout" || this.hoverMinute == null
      ? null
      : flowMinuteDetail(this.vm?.flow || {}, this.hoverMinute);
    content.querySelectorAll?.(".flow-chart-plot").forEach((chart) => {
      let line = chart.querySelector(".flow-crosshair-line");
      if (!detail) {
        line?.remove();
        return;
      }
      if (!line) {
        line = document.createElement("i");
        line.className = "flow-crosshair-line";
        line.dataset.morphKeep = "1";
        chart.appendChild(line);
      }
      line.style.left = `${flowChartMinutePercent(chart.querySelector(".flow-chart-svg"), this.hoverMinute)}%`;
    });
    this.paintQuote(detail);
  }

  // One 查價 window for both charts. It floats beside the panel, over the neighbouring panel as in the broker's
  // layout (fixed, so the panel's own overflow cannot clip it), never over the charts being read.
  // ✕ hides it until the mouse next leaves and re-enters the charts.
  paintQuote(detail) {
    if (!detail || this.quoteClosed) {
      this.quote?.remove();
      this.quote = null;
      this.quoteMarkup = "";
      if (!detail) this.quoteClosed = false;
      return;
    }
    if (!this.quote) {
      this.quote = document.createElement("div");
      this.quote.className = "flow-quote-window";
      this.quote.addEventListener("click", (event) => {
        if (!event.target?.closest?.("[data-flow-quote-close]")) return;
        this.quoteClosed = true;
        this.paintQuote(detail);
      });
      document.body.appendChild(this.quote);
    }
    // Every mouse move over the charts calls this: the window's content is rewritten only when what it shows changed
    // (a new minute under the pointer); it is placed every time, since the panel may have moved meanwhile.
    const markup = flowQuoteHtml(detail);
    if (markup !== this.quoteMarkup) {
      this.quote.innerHTML = markup;
      this.quoteMarkup = markup;
    }
    const box = this.host?.getBoundingClientRect?.();
    if (!box) return;
    const width = this.quote.offsetWidth || 0;
    const gap = 4;
    // Never over the 大單流向 panel itself: its left side, else its right side; only a window too narrow for
    // either falls back to the screen edge.
    const viewWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const left = box.left - width - gap >= 0
      ? box.left - width - gap
      : box.right + gap + width <= viewWidth ? box.right + gap : Math.max(0, viewWidth - width);
    this.quote.style.left = `${Math.round(left)}px`;
    this.quote.style.top = `${Math.round(box.top + gap)}px`;
  }

  destroy() {
    if (this.renderFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.renderFrame);
    this.renderFrame = 0;
    this.renderPending = false;
    this.releaseListScroll();
    this.quote?.remove();
    this.quote = null;
    this.windowQuery = null;
    this.cleanup.release();
    this.displayFrameGate?.reset?.();
    this.displayFrameGate = null;
    this.host = null;
    this.context = null;
  }
}
