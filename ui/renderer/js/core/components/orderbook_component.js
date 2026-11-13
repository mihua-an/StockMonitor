import { CleanupBag } from "../cleanup_bag.js";
import { mountShell } from "../component_shell.js";
import { PresentationRevisionGate } from "../display_frame_gate.js";
import { orderBookReadView } from "../market_read_model.js";
import { componentUpdated } from "../market_render_trace.js";
import { resolveOrderBookDepthTotal } from "../orderbook_normalization.js";
import { syncClass, syncText } from "../utility.js";
import { syncViewLifecycle } from "../view_lifecycle.js";
import { patchIoRatio } from "./io_ratio.js";
import { ensureProductQuoteSearch, formatQuoteChange, quoteMoveClass, setProductQuoteCenter, syncProductQuoteFailure } from "./product_quote_header.js";
import { BookChangeBadges, QUOTE_STATES, availabilityMessage, buildLevelRow, extremeModel, limitPriceClass, normalizedQuoteState, patchExtreme, patchPrice, patchQty, priceModel, qtyModel } from "./orderbook_depth_table.js";
import { genericShell, orderbookNodes, quoteChange, renderDepthTotals, renderOrderbookTitle, renderReviewCenter, renderTradeSideRatio } from "./orderbook_header.js";
import { DepthLayoutController } from "./orderbook_layout.js";
import { renderPriceVolume } from "./orderbook_price_volume.js";

// What one 買賣報價 shows, named and checked where it is made: a depth of 1-10 levels (or, with dynamicDepth, the
// levels the source has between minDepth and maxDepth), and which parts are drawn. A combination without a meaning
// (a depth range on a fixed-depth book, a range upside down) is refused here instead of being clamped into another book.
export function orderBookVariant({ manual = false, depth = 5, minDepth = null, maxDepth = null, dynamicDepth = false, title = "買賣報價",
  showInsideOutside = true, showPriceVolume = true, showDepthTotals = true, showExtremeMarkers = true, search = "shioaji",
  productHeader = true, productIdentity = true } = {}) {
  const levels = (value, name) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new RangeError(`OrderBookComponent: ${name} must be 1-10 levels (got ${value})`);
    return n;
  };
  const fixed = levels(depth, "depth");
  const low = minDepth == null ? fixed : levels(minDepth, "minDepth");
  const high = maxDepth == null ? fixed : levels(maxDepth, "maxDepth");
  if (low > high) throw new RangeError(`OrderBookComponent: minDepth ${low} is above maxDepth ${high}`);
  if (!dynamicDepth && (low !== fixed || high !== fixed)) {
    throw new RangeError("OrderBookComponent: minDepth / maxDepth only apply to a dynamicDepth book");
  }
  return Object.freeze({
    manual: Boolean(manual), depth: fixed, minDepth: low, maxDepth: high, dynamicDepth: Boolean(dynamicDepth),
    title: String(title || "買賣報價"), search: String(search || ""), productHeader: Boolean(productHeader),
    productIdentity: Boolean(productIdentity),
    showInsideOutside: Boolean(showInsideOutside), showPriceVolume: Boolean(showPriceVolume),
    showDepthTotals: Boolean(showDepthTotals), showExtremeMarkers: Boolean(showExtremeMarkers),
  });
}

// The 零股／整張 switch: the shared pill switch (core/trend_session_control.js) with one button.
function oddLotSwitchMarkup() {
  return '<span class="pill-switch" data-role="odd-lot-switch" hidden><button type="button" class="pill-switch-btn" data-role="odd-lot-toggle" aria-pressed="false">零股</button></span>';
}

export class OrderBookComponent {
  constructor(options = {}) {
    this.variant = orderBookVariant(options);
    this.cleanup = new CleanupBag("order book");
    this.host = null;
    this.context = null;
    this.root = null;
    this.lastVm = null;
    this.lastDiffEventToken = "";
    this.depthLayout = null;
    this.displayFrameGate = null;
    // The levels' change badges (by side and price) and the one timer that redraws the marker cells when a badge
    // starts to fade or goes; `badgeFrame` is what that redraw needs of the last render.
    this.badges = new BookChangeBadges();
    this.badgeTimer = null;
    this.badgeDue = 0;
    this.badgeFrame = null;
  }

  #resolveRenderDepth(vm = {}, bidLevels = [], askLevels = []) {
    if (!this.variant.dynamicDepth) return this.variant.depth;
    const declared = Number(vm.bookDepth ?? vm.displayDepth ?? vm.depth);
    const available = Math.max(
      Array.isArray(bidLevels) ? bidLevels.length : 0,
      Array.isArray(askLevels) ? askLevels.length : 0,
      Number.isFinite(declared) ? declared : 0,
    );
    return Math.max(this.variant.minDepth, Math.min(this.variant.maxDepth, available || this.variant.minDepth));
  }

  mount({ host, context, hydrate, actionsHost = null }) {
    this.host = host; this.context = context;
    this.displayFrameGate = new PresentationRevisionGate();
    // 零股／整張 (docs/decisions.md 零股行情的顯示) where the page offers it (即時報價: services.oddLot).
    const oddLot = !this.variant.manual && context?.services?.oddLot ? oddLotSwitchMarkup() : "";
    mountShell(host, genericShell({
      title: this.variant.title, depth: this.variant.depth, showInsideOutside: this.variant.showInsideOutside,
      showPriceVolume: this.variant.showPriceVolume, showDepthTotals: this.variant.showDepthTotals,
      showExtremeMarkers: this.variant.showExtremeMarkers, actions: oddLot,
    }), { hydrate });
    this.root = host;
    this.#mountOddLotSwitch(host, actionsHost);
    // Without its product header (the workspace column's trend titlebar names the product): a variant of the root.
    if (!this.variant.productHeader) host.querySelector('[data-role="orderbook-root"]')?.setAttribute("data-product-header", "hidden");
    // A product row of 價格 and 漲跌 only, where something around the book already names the product.
    if (!this.variant.productIdentity) host.querySelector(".product-quote-header")?.setAttribute("data-identity", "hidden");
    ensureProductQuoteSearch(host.querySelector(".product-quote-header"),
      context?.services?.productSearchProvider ?? (context?.mode === "replay" ? "history" : this.variant.search));
    this.depthLayout?.destroy();
    this.depthLayout = new DepthLayoutController(host);
    this.depthLayout.observe(this.root?.querySelector?.(".orderbook-table-wrap"));
    this.depthLayout.schedule();
    if (!this.variant.manual) {
      const refresh = () => this.context?.dataSource?.invalidate("orderbook", { symbol: this.context?.symbolStore?.getSelectedSymbol?.() });
      this.cleanup.push(this.context?.symbolStore?.subscribe?.(refresh) || (() => {}));
      this.cleanup.push(this.context?.dataSource?.subscribe?.("orderbook", (vm) => this.update(vm)) || (() => {}));
      refresh();
      // A price clicked opens a 模擬 order at it, where the page offers one (即時報價: paper_order_entry.js).
      const entry = this.context?.services?.paperOrderEntry;
      if (entry) {
        const onClick = (event) => {
          const cell = event.target.closest?.(".orderbook-price-cell");
          const row = cell?.closest("tr[data-orderbook-level]");
          if (!cell || !row || !this.lastLevels) return;
          const level = (cell.classList.contains("bid") ? this.lastLevels.bids : this.lastLevels.asks)[Number(row.dataset.orderbookLevel)];
          entry.open({ code: this.lastLevels.code, name: this.lastVm?.displayName || "", price: Number(level?.price),
            market: this.lastVm?.marketRead?.identity?.market || "", anchor: cell, vm: this.lastVm });
        };
        host.addEventListener("click", onClick);
        this.cleanup.push(() => host.removeEventListener("click", onClick));
      }
    }
  }

  // The switch is found once and (in a slot, whose own tab names this book) moved into the slot's actions box. Its
  // text is what a press switches to: 零股 while the book is the stock's, 整張 while it is its 盤中零股.
  #mountOddLotSwitch(host, actionsHost) {
    const control = host.querySelector('[data-role="odd-lot-switch"]');
    this.oddLotSwitch = control;
    if (!control) return;
    const button = control.querySelector('[data-role="odd-lot-toggle"]');
    const onClick = () => {
      Promise.resolve(this.context?.services?.oddLot?.toggle?.())
        .catch((error) => console.warn("[orderbook: switching 零股／整張] failed", error));
    };
    button.addEventListener("click", onClick);
    this.cleanup.push(() => button.removeEventListener("click", onClick));
    if (actionsHost) actionsHost.replaceChildren(control);
  }

  #syncOddLotSwitch(oddLot) {
    const control = this.oddLotSwitch;
    if (!control) return;
    const available = oddLot?.available === true;
    if (control.hidden !== !available) control.hidden = !available;
    const button = control.firstElementChild;
    syncText(button, oddLot?.shown ? "整張" : "零股");
    const pressed = oddLot?.shown ? "true" : "false";
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
  }

  update(vm = {}) {
    vm = orderBookReadView(vm);
    if (!vm) return;
    if (this.displayFrameGate && !this.displayFrameGate.accept(vm)) return;
    syncViewLifecycle(this.host, vm);
    this.lastVm = vm || {};
    this.#syncOddLotSwitch(vm.oddLot);
    const root = this.root; if (!root) return;
    // The card's nodes do not change after mount: looked up once (they were ~16 queries per update).
    const nodes = this.nodes ??= orderbookNodes(root);
    const body = nodes.body; if (!body) return;
    const headerFailed = syncProductQuoteFailure(nodes.center, vm);
    const totalsHidden = this.variant.showDepthTotals === false || vm.showDepthTotals === false;
    if (nodes.totals && nodes.totals.hidden !== totalsHidden) nodes.totals.hidden = totalsHidden;

    const availability = String(vm.availability || "UNAVAILABLE").toUpperCase();
    const hasRenderableDepth = [...(Array.isArray(vm.bidLevels) ? vm.bidLevels : []), ...(Array.isArray(vm.askLevels) ? vm.askLevels : [])]
      .some((level) => Number.isFinite(Number(level?.price)));
    // PARTIAL describes session coverage, not an empty payload.  Render the
    // known levels while the replay coverage banner explains the missing span.
    const available = availability === "AVAILABLE" || (availability === "PARTIAL" && hasRenderableDepth);
    if (!available) {
      this.#renderUnavailable(root, body, nodes, vm, availability, headerFailed);
      return;
    }

    const quote = quoteChange(vm);
    this.#renderSummary(nodes, vm, quote);
    renderReviewCenter(nodes.center, vm, headerFailed);
    const bidLevels = Array.isArray(vm.bidLevels) ? vm.bidLevels : [], askLevels = Array.isArray(vm.askLevels) ? vm.askLevels : [];
    const renderDepth = this.#resolveRenderDepth(vm, bidLevels, askLevels);
    renderDepthTotals(nodes, resolveOrderBookDepthTotal(vm.depthBidTotal, bidLevels), resolveOrderBookDepthTotal(vm.depthAskTotal, askLevels));
    this.#renderLevels(body, vm, bidLevels, askLevels, renderDepth, quote);
    renderTradeSideRatio(nodes.ratio, vm);
    if (this.variant.showPriceVolume) renderPriceVolume(root, vm.priceVolumeRows || [], vm.priceVolumeEmptyText || "等待逐價內外盤資料", quote.current, vm);
    const widthSignature = [...bidLevels.slice(0, renderDepth), ...askLevels.slice(0, renderDepth)]
      .reduce((result, level) => `${result}:${String(level?.price ?? "").length}:${String(level?.volume ?? "").length}`, `${renderDepth}`);
    this.depthLayout?.scheduleFor(widthSignature);
    componentUpdated("orderbook",vm,this.root);
  }

  // No depth to show (none selected, or a closed session fetched from the broker's prints): the reason in the table
  // and empty depth totals. The price, 內外盤 and 價量 are the product's own, not the book's, and are shown when known.
  #renderUnavailable(root, body, nodes, vm, availability, headerFailed) {
    const { center, ratio, bidTotal, askTotal, bidBar, askBar } = nodes;
    const message = String(vm?.message || availabilityMessage(vm));
    if (this.emptyMessage !== message || body.children.length !== 1) {
      const row = body.ownerDocument.createElement("tr");
      const cell = body.ownerDocument.createElement("td");
      cell.colSpan = this.variant.showExtremeMarkers ? 6 : 4;
      cell.className = "empty";
      cell.textContent = message;
      row.appendChild(cell);
      body.replaceChildren(row);
      this.emptyMessage = message;
    }
    const quote = quoteChange(vm);
    this.#renderSummary(nodes, vm, quote);
    if (!headerFailed) setProductQuoteCenter(center);
    if (vm.outsideTradeVolume == null && vm.insideTradeVolume == null) patchIoRatio(ratio, null);
    else renderTradeSideRatio(ratio, vm);
    if (bidTotal) bidTotal.textContent = "--"; if (askTotal) askTotal.textContent = "--";
    bidBar?.style.setProperty("--bar-share", "0"); askBar?.style.setProperty("--bar-share", "0");
    if (this.variant.showPriceVolume) renderPriceVolume(root, vm.priceVolumeRows || [], vm.priceVolumeEmptyText || "尚無逐價內外盤資料", quote.current, vm);
    this.depthLayout?.scheduleFor(`empty:${availability}`);
  }

  #renderSummary({ code, price, change }, vm, { current, diff, pct }) {
    // The colour is Market Runtime's 漲跌 as shown, as on every product header: not a broker change type, not the
    // price against a reference.
    const move = quoteMoveClass(diff);
    if (code) renderOrderbookTitle(code, vm);
    if (price) {
      // 試撮 (盤前 / 緩漲緩跌 / 尾盤): the indicative price, marked "#".
      syncText(price, current != null ? `${vm.indicative ? "#" : ""}${current.toFixed(2)}` : "--");
      const source = current != null ? "tick" : "none";
      if (price.dataset.priceSource !== source) price.dataset.priceSource = source;
      syncClass(price, `quote-main-price product-quote-price orderbook-summary-price ${move}${limitPriceClass(current, vm.limitUp, vm.limitDown) ? ` ${limitPriceClass(current, vm.limitUp, vm.limitDown)}` : ""}`);
    }
    if (change) {
      syncText(change, formatQuoteChange(diff, pct));
      syncClass(change, `quote-change product-quote-change orderbook-summary-change ${move}`);
    }
  }

  #reportLevelsWithoutQuoteState(vm, bids, asks) {
    const missing = [...bids, ...asks].filter((level) => level && !QUOTE_STATES.has(level.quoteState));
    if (!missing.length) return;
    console.warn(`[orderbook] ${String(vm.displayCode || vm.code || "--")}: ${missing.length} level(s) without quoteState refused (shown empty)`,
      { source: vm.source ?? null, firstLevel: missing[0] });
  }

  // The depth rows, patched cell by cell when the row structure is unchanged. A level's live diff starts (or adds to)
  // its badge only for a new diff event (a snapshot/hydration is static state); a badge then shows for its own time
  // whatever else redraws the book (a trade's summary, the next book), see BookChangeBadges.
  #renderLevels(body, vm, bidLevels, askLevels, renderDepth, { current, reference }) {
    // diffRenderable (boolean, set by every adapter): whether this book's level changes may be drawn. Each diff
    // event token is drawn once; a snapshot/hydration is static state and only marks its token consumed.
    const diffEventToken = String(vm.diffEventToken ?? "");
    const renderLiveDiff = vm.diffRenderable === true && Boolean(diffEventToken) && diffEventToken !== this.lastDiffEventToken;
    if (diffEventToken) this.lastDiffEventToken = diffEventToken;
    const now = performance.now();
    this.badges.forCode(String(vm.displayCode || vm.code || "").toUpperCase());
    if (renderLiveDiff && this.variant.showExtremeMarkers) {
      this.badges.add("bid", bidLevels.slice(0, renderDepth), now);
      this.badges.add("ask", askLevels.slice(0, renderDepth), now);
    }
    this.#reportLevelsWithoutQuoteState(vm, bidLevels.slice(0, renderDepth), askLevels.slice(0, renderDepth));
    const allVol = [...bidLevels,...askLevels].slice(0, renderDepth * 2).filter((x)=>normalizedQuoteState(x)!=="EMPTY").map(x=>Number(x?.volume)||0), maxVolume=Math.max(0,...allVol);
    // The rows are this component's: rebuilt only when the depth or the row structure changed (or the table held
    // something else -- the static shell, the unavailable message), else patched cell by cell.
    const rowsReady = body.children.length === renderDepth && body.firstElementChild?._level
      && Boolean(body.firstElementChild._level.bidExtreme) === this.variant.showExtremeMarkers;
    if (!rowsReady) {
      body.replaceChildren(...Array.from({ length: renderDepth }, (_, i) => buildLevelRow(body.ownerDocument, i, this.variant.showExtremeMarkers)));
      this.emptyMessage = null;
    }
    for (let i = 0; i < renderDepth; i += 1) {
      const refs = body.children[i]._level;
      const b=bidLevels[i]||{quoteState:"EMPTY"}, a=askLevels[i]||{quoteState:"EMPTY"}; const bv=Number(b.volume)||0,av=Number(a.volume)||0;
      patchQty(refs.bidQty, qtyModel(b, maxVolume ? bv/maxVolume : 0));
      patchPrice(refs.bidPrice, priceModel(b, reference, vm.limitUp, vm.limitDown, current));
      patchPrice(refs.askPrice, priceModel(a, reference, vm.limitUp, vm.limitDown, current));
      patchQty(refs.askQty, qtyModel(a, maxVolume ? av/maxVolume : 0));
    }
    if (this.variant.showExtremeMarkers) {
      this.badgeFrame = { body, bids: bidLevels, asks: askLevels, renderDepth, high: vm.dayHigh, low: vm.dayLow, reference };
      this.#patchExtremes(now);
    }
    this.lastLevels = { code: String(vm.displayCode || vm.code || "").toUpperCase(), bids: bidLevels.slice(0, renderDepth), asks: askLevels.slice(0, renderDepth) };
  }

  // The H/L marker cells with the badges as they are at `now`, and the timer for the next time one fades or goes
  // (the only redraw a badge needs when no data comes).
  #patchExtremes(now) {
    const frame = this.badgeFrame;
    if (!frame) return;
    const next = this.badges.prune(now);
    for (let i = 0; i < frame.renderDepth; i += 1) {
      const refs = frame.body.children[i]?._level;
      if (!refs?.bidExtreme) continue;
      const b = frame.bids[i] || {}, a = frame.asks[i] || {};
      patchExtreme(refs.bidExtreme, extremeModel(b.price, frame.high, frame.low, frame.reference, "bid", this.badges.at("bid", b.price, now)));
      patchExtreme(refs.askExtreme, extremeModel(a.price, frame.high, frame.low, frame.reference, "ask", this.badges.at("ask", a.price, now)));
    }
    // One timer, moved only when a badge is due sooner than it fires (a book redrawn many times a second keeps it).
    if (next === null || (this.badgeTimer !== null && this.badgeDue <= next)) return;
    clearTimeout(this.badgeTimer);
    this.badgeDue = next;
    this.badgeTimer = setTimeout(() => { this.badgeTimer = null; this.#patchExtremes(performance.now()); }, Math.max(0, next - now) + 1);
  }

  resize() {
    this.depthLayout?.schedule();
    this.host?.dispatchEvent?.(new CustomEvent("component:resize", { bubbles: false }));
  }
  destroy() {
    this.displayFrameGate?.reset?.();
    this.displayFrameGate = null;
    this.cleanup.release();
    this.depthLayout?.destroy();
    this.depthLayout = null;
    this.lastDiffEventToken = "";
    clearTimeout(this.badgeTimer);
    this.badgeTimer = null;
    this.badgeFrame = null;
    this.badges = new BookChangeBadges();
    this.nodes = null;
    this.oddLotSwitch?.remove();
    this.oddLotSwitch = null;
    this.lastLevels = null;
    this.emptyMessage = null;
    this.host=null; this.root=null; this.context=null;
  }
}
