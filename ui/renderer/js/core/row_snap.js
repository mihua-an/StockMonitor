// One list scrolled one whole row at a time (wheel, touchpad, thumb, keys): RowSnapController owns the list's row
// pitch and scroll position, and is registered per viewport so the discrete scrollbar reads the same geometry
// (sharedRowController). Row arithmetic is row_metrics.js.
import { clamp } from "./utility.js";
import { completeRowViewportMetrics, distributedRowViewportMetrics, finite, rowIndexFromScrollOffset, rowStopSettle, rowStopStep } from "./row_metrics.js";

const ROW_SCROLL_RUNTIME_KEY = Symbol.for("shioaji.renderer.sharedRowScrollRuntime.v1");
const ROW_SCROLL_RUNTIME = globalThis[ROW_SCROLL_RUNTIME_KEY] || (
  globalThis[ROW_SCROLL_RUNTIME_KEY] = {
    controllers: new WeakMap(),
  }
);

export function sharedRowController(viewport) {
  return viewport ? ROW_SCROLL_RUNTIME.controllers.get(viewport) || null : null;
}

function renderedRowPitch(viewport, rowSelector) {
  if (!viewport) return 0;
  const allRows = [...(viewport.querySelectorAll?.(rowSelector) || [])];
  // Placeholder rows use .empty with intentionally large padding and are not a
  // valid row-height sample. Measuring them would poison the cached intrinsic
  // pitch before the first real Tick/Event arrives.
  const rows = allRows.filter((row) => !row.querySelector?.("td.empty, th.empty"));
  if (!rows.length) return 0;

  // IMPORTANT: table row rect.height is not necessarily the real scroll unit.
  // With collapsed borders / fractional DPI, rect.height may include a shared
  // border while the next row actually starts 1px earlier/later.
  // The canonical scroll unit is therefore row[n+1].top - row[n].top. The first row has no collapsed border above it
  // and lays out half a border shorter than every row after it, so the unit is the largest step among the first rows,
  // never the first step alone (taking it let adaptive rows be fitted below what the later rows need, and the list
  // drifted off its row grid by that half border per row).
  if (rows.length >= 2) {
    const tops = rows.slice(0, 6).map((row) => finite(row?.getBoundingClientRect?.().top));
    let pitch = 0;
    for (let index = 1; index < tops.length; index += 1) pitch = Math.max(pitch, Math.abs(tops[index] - tops[index - 1]));
    if (pitch > 1) return pitch;
  }

  return rows[0]?.getBoundingClientRect?.().height || 0;
}

// The behaviour a RowSnapController runs with, named once from its options and fixed for its life:
//   scroll:    "row"    -- every resting position is a whole row (wheel, touchpad, thumb and keys move by rows);
//              "smooth" -- settles on a row with a smooth scroll; "free" -- settles on a row without animating.
//   pitch:     "measured" -- the rendered row pitch wins over the CSS row height; "css" -- the CSS height unless
//              there is none.
//   fit:       "none" -- the viewport keeps its height; "whole-rows" -- it shows only whole rows (a tail spacer
//              fills the rest); "distributed" -- whole rows, with the leftover pixels spread over the rows' heights.
//   remainder: "masked" -- a partial last row is covered; "shown".
//   observe:   whether this controller watches the viewport's size itself (false when its owner already does).
// A combination that has no meaning (a smooth row-unit list) is refused here, not resolved somewhere in the code.
export function rowSnapPolicy({ smooth = false, rowUnit = false, measureActualRow = false, fitViewportRows = false,
  distributeRemainder = false, maskRemainder = true, observeResize = true } = {}) {
  if (rowUnit && smooth) throw new Error("RowSnapController: a row-unit list does not scroll smoothly (rowUnit with smooth)");
  if (distributeRemainder && !fitViewportRows) {
    throw new Error("RowSnapController: distributing the remainder needs whole-row fitting (distributeRemainder without fitViewportRows)");
  }
  return Object.freeze({
    scroll: rowUnit ? "row" : smooth ? "smooth" : "free",
    pitch: measureActualRow ? "measured" : "css",
    fit: distributeRemainder ? "distributed" : fitViewportRows ? "whole-rows" : "none",
    remainder: maskRemainder ? "masked" : "shown",
    observe: Boolean(observeResize),
  });
}

export class RowSnapController {
  constructor({
    viewport,
    rowSelector = "tbody tr",
    rowHeightVar = "--row-height-trade-detail",
    smooth = false,
    maskRemainder = true,
    onMetric = null,
    rowUnit = false,
    wheelStepRows = 1,
    measureActualRow = false,
    fitViewportRows = false,
    distributeRemainder = false,
    minRowHeightVar = "",
    maxRowHeightVar = "",
    observeResize = true,
  } = {}) {
    this.viewport = viewport || null;
    this.rowSelector = rowSelector;
    this.rowHeightVar = rowHeightVar;
    this.policy = rowSnapPolicy({ smooth, rowUnit, measureActualRow, fitViewportRows, distributeRemainder, maskRemainder, observeResize });
    this.onMetric = typeof onMetric === "function" ? onMetric : null;
    // Row-unit mode is the canonical interaction for live product/event/trade
    // lists.  Wheel/touchpad/native-thumb movement may express intent in pixels,
    // but the viewport itself is only allowed to settle on whole row boundaries.
    this.wheelStepRows = Math.max(1, Math.trunc(finite(wheelStepRows, 1)));
    this.minRowHeightVar = String(minRowHeightVar || `${rowHeightVar}-min`);
    this.maxRowHeightVar = String(maxRowHeightVar || `${rowHeightVar}-max`);
    this.rowHeight = 0; // canonical rendered row pitch (nextRow.top - currentRow.top)
    this.topRowIndex = 0;
    this.visibleRows = 1;
    this.remainder = 0;
    this.wheelAccumulator = 0;
    this.lastWheelAt = 0;
    this.measureFrame = 0;
    this.cleanup = [];
    this.resizeObserver = null;
    this.rowResizeObserver = null;
    this.observedRow = null;
    this.lastDomRowCount = -1;
    this.lastNativeMaxScroll = 0;
    this.lastAppliedRowPitch = 0;
    this.intrinsicRowPitch = 0;
    this.extentFrame = 0;
    this.mask = null;
    this.tailSpacer = null;
    // A list that draws only the rows around the viewport (setVirtualWindow): its row count and the logical index of
    // its first drawn row, which a head spacer places at that row's offset. Null for a list that draws every row.
    this.virtualWindow = null;
    this.headSpacer = null;
    // Told after every measure (the rows the viewport holds, its row count): a scrollbar drawn from these metrics
    // redraws then, not on its own resize callback that may run before the measure (使用者 10-22: 價量's thumb kept
    // the height it had before the panel was resized).
    this.measuredListeners = new Set();
  }

  // Calls fn after every measure; returns the function that stops it.
  onMeasured(fn) {
    if (typeof fn !== "function") return () => {};
    this.measuredListeners.add(fn);
    return () => this.measuredListeners.delete(fn);
  }

  mount() {
    const viewport = this.viewport;
    if (!viewport) return this;
    viewport.classList.add("row-snap-viewport");
    viewport.classList.toggle("row-snap-fit-complete-rows", this.policy.fit !== "none");
    viewport.classList.toggle("row-snap-distribute-remainder", this.policy.fit === "distributed");
    viewport.tabIndex = viewport.tabIndex >= 0 ? viewport.tabIndex : 0;
    ROW_SCROLL_RUNTIME.controllers.set(viewport, this);
    this._mountDecorations();
    const wheel = (event) => this._onWheel(event);
    const keydown = (event) => this._onKeydown(event);
    viewport.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("keydown", keydown);
    this.cleanup.push(
      () => viewport.removeEventListener("wheel", wheel),
      () => viewport.removeEventListener("keydown", keydown),
    );
    this._bindScrollSettle();
    this._observeResize();
    this._syncObservedRow();
    this.measure();
    return this;
  }

  // The remainder mask and the tail spacer a complete-rows viewport draws over / after its rows.
  _mountDecorations() {
    const decoration = (className) => {
      const node = document.createElement("div");
      node.className = className;
      node.setAttribute("aria-hidden", "true");
      this.viewport.appendChild(node);
      return node;
    };
    if (this.policy.remainder === "masked") this.mask = decoration("row-snap-remainder-mask");
    if (this.policy.fit !== "none") this.tailSpacer = decoration("row-snap-tail-spacer");
  }

  _onWheel(event) {
    if (!event.deltaY) return;
    // Never let a partial wheel/touchpad delta move the native viewport by a
    // pixel. Convert physical input into logical row intent first.
    event.preventDefault();
    if (!this.rowHeight) this.measure(false);
    const now = performance.now();
    const rawDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * this.rowHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? event.deltaY * Math.max(this.rowHeight, this.viewport.clientHeight)
        : event.deltaY;
    if (now - this.lastWheelAt > 180 || (this.wheelAccumulator && Math.sign(rawDelta) !== Math.sign(this.wheelAccumulator))) {
      this.wheelAccumulator = 0;
    }
    this.lastWheelAt = now;
    if (this.policy.scroll === "row") {
      this._wheelByRowUnit(event, rawDelta);
      return;
    }
    // A non-row-unit list accumulates pixel deltas into whole rows.
    this.wheelAccumulator += rawDelta;
    const threshold = Math.max(10, this.rowHeight * 0.72);
    const rows = Math.trunc(this.wheelAccumulator / threshold);
    if (!rows) return;
    const boundedRows = clamp(rows, -6, 6);
    this.wheelAccumulator -= boundedRows * threshold;
    this.scrollByRows(boundedRows);
  }

  // A mouse wheel moves wheelStepRows per detent, however many detents one event carries: Chromium coalesces the
  // wheel events a busy main thread has not taken yet, and one Windows wheel message can hold several detents.
  // Chromium reports detents as wheelDeltaY = -120 x detents, independent of the Windows "lines per scroll" setting
  // (deltaY = detents x lines x 100/3 px); a mouse detent is a whole multiple of 120, a precision touchpad or a
  // smooth-scrolling wheel sends fractions of it. PAGE mode ("one screen per detent" in Windows) moves a screen of
  // rows per detent. Fractional input accumulates pixels and moves every whole row it adds up to.
  _wheelByRowUnit(event, rawDelta) {
    if (!Math.sign(rawDelta)) return;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      this.wheelAccumulator = 0;
      this.scrollByRows(Math.trunc(event.deltaY) * this.visibleRows);
      return;
    }
    const detents = -finite(event.wheelDeltaY, 0) / 120;
    if (detents && Number.isInteger(detents)) {
      this.wheelAccumulator = 0;
      this.scrollByRows(detents * this.wheelStepRows);
      return;
    }
    this.wheelAccumulator += rawDelta;
    const threshold = Math.max(10, this.rowHeight * 0.72);
    const rows = Math.trunc(this.wheelAccumulator / threshold);
    if (!rows) return;
    this.wheelAccumulator -= rows * threshold;
    this.scrollByRows(rows * this.wheelStepRows);
  }

  _onKeydown(event) {
    let rows = 0;
    if (event.key === "ArrowDown") rows = 1;
    else if (event.key === "ArrowUp") rows = -1;
    else if (event.key === "PageDown") rows = this.visibleRows;
    else if (event.key === "PageUp") rows = -this.visibleRows;
    else if (event.key === "Home") { event.preventDefault(); this.scrollToIndex(0); return; }
    else if (event.key === "End") { event.preventDefault(); this.viewport.scrollTop = this.viewport.scrollHeight; this.snap(); return; }
    else return;
    event.preventDefault();
    this.scrollByRows(rows);
  }

  // Wheel/keyboard input is already converted to exact row indices before reaching native scrolling. Native
  // scrollbar/thumb/touch scrolling must NOT be fought on every animation frame: doing so makes Chromium bounce
  // between the pointer's pixel position and our row boundary. Let the physical gesture finish, then quantize once.
  _bindScrollSettle() {
    const viewport = this.viewport;
    let settleTimer = null;
    const settleSnap = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      this.snap(false);
      requestAnimationFrame(() => this._recordMisalignedRest());
    };
    const scheduleSnap = () => {
      if (this.rowHeight) {
        const alignedIndex = rowIndexFromScrollOffset(viewport.scrollTop, this.rowHeight);
        this.topRowIndex = alignedIndex;
        if (Math.abs(viewport.scrollTop - alignedIndex * this.rowHeight) < 0.25) return;
      }
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(settleSnap, this.policy.scroll === "row" ? 110 : 80);
    };
    const onScrollEnd = () => {
      if (this.policy.scroll !== "row") return;
      settleSnap();
    };
    viewport.addEventListener("scroll", scheduleSnap, { passive: true });
    viewport.addEventListener("scrollend", onScrollEnd, { passive: true });
    this.cleanup.push(
      () => viewport.removeEventListener("scroll", scheduleSnap),
      () => viewport.removeEventListener("scrollend", onScrollEnd),
      () => { if (settleTimer) clearTimeout(settleTimer); },
    );
  }

  // A complete-row list at rest shows its first row flush with the viewport top. When it does not, the row pitch the
  // controller scrolls by and the pitch the rows are laid out at disagree; record both (once per list) so the cause
  // can be read from error.log.
  _recordMisalignedRest() {
    const viewport = this.viewport;
    if (!viewport || this.misalignedRestRecorded || this.policy.fit === "none") return;
    const rows = [...viewport.querySelectorAll(this.rowSelector)];
    if (rows.length < 2) return;
    const top = viewport.getBoundingClientRect().top;
    const first = rows.find((row) => row.getBoundingClientRect().bottom > top + 0.5);
    const offset = first ? first.getBoundingClientRect().top - top : 0;
    if (Math.abs(offset) <= 1) return;
    this.misalignedRestRecorded = true;
    const rowTop = (row) => row.getBoundingClientRect().top;
    const metrics = this.metrics();
    console.warn("[row snap] list at rest is not row-aligned", {
      list: String(viewport.parentElement?.className || viewport.className).slice(0, 80),
      offset: +offset.toFixed(2),
      controllerPitch: metrics.rowHeight,
      renderedPitch: +(rowTop(rows[1]) - rowTop(rows[0])).toFixed(4),
      renderedMeanPitch: +((rowTop(rows[rows.length - 1]) - rowTop(rows[0])) / (rows.length - 1)).toFixed(4),
      rowVar: viewport.style.getPropertyValue(this.rowHeightVar),
      intrinsicRowPitch: this.intrinsicRowPitch,
      scrollTop: viewport.scrollTop,
      topRowIndex: metrics.topRowIndex,
      maxIndex: metrics.maxIndex,
      visibleRows: metrics.visibleRows,
      logicalRows: metrics.logicalRows,
      domRows: rows.length,
      remainder: this.remainder,
      clientHeight: viewport.clientHeight,
      offsetHeight: viewport.offsetHeight,
      scrollHeight: viewport.scrollHeight,
      devicePixelRatio: window.devicePixelRatio,
    });
  }

  _observeResize() {
    if (typeof ResizeObserver !== "function") return;
    // StandardDataGrid already owns the wrapper/body ResizeObserver and calls
    // scheduleMeasure() for real geometry changes. Avoid a second observer on
    // the same viewport when DataGrid is the owner.
    if (this.policy.observe) {
      this.resizeObserver = new ResizeObserver(() => this.scheduleMeasure());
      this.resizeObserver.observe(this.viewport);
    }
    // Adaptive rows deliberately do NOT observe their own rendered row. We
    // write --row-height-* ourselves; observing that row creates a feedback
    // loop (write row height -> ResizeObserver -> remeasure -> write again).
    // Static CSS/padding changes are picked up on mount or the next real panel
    // resize. A fixed-pitch (non-adaptive) list observes its row.
    if (this.policy.fit !== "distributed") {
      this.rowResizeObserver = new ResizeObserver(() => this.scheduleMeasure());
    }
  }

  scheduleMeasure() {
    if (this.measureFrame) return;
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = 0;
      this.measure();
    });
  }

  _configuredPitch(varName, fallback = 0) {
    const viewport = this.viewport;
    if (!viewport) return Math.max(0, finite(fallback, 0));
    // Read from the parent, not the viewport: adaptive mode writes a temporary
    // per-viewport override of rowHeightVar and must never feed that value back
    // in as the next preferred size.
    const source = viewport.parentElement || viewport;
    const value = parseFloat(getComputedStyle(source).getPropertyValue(varName));
    return value > 0 ? value : Math.max(0, finite(fallback, 0));
  }

  _hasRealDataRow() {
    if (!this.viewport) return false;
    return [...(this.viewport.querySelectorAll?.(this.rowSelector) || [])]
      .some((row) => !row.querySelector?.("td.empty, th.empty"));
  }

  _measureIntrinsicRowPitch() {
    const viewport = this.viewport;
    if (!viewport) return 0;
    const rows = viewport.querySelectorAll?.(this.rowSelector);
    if (!rows?.length) return 0;

    // Adaptive mode writes the computed row pitch as an inline CSS variable on
    // the viewport. To learn the table's real minimum row pitch (font + padding
    // + border), briefly remove only that adaptive override, measure one pair of
    // rows, then restore it before the browser paints. This happens only on mount
    // or row-topology replacement, never in wheel/scroll handlers.
    const inlineValue = viewport.style.getPropertyValue(this.rowHeightVar);
    const inlinePriority = viewport.style.getPropertyPriority(this.rowHeightVar);
    if (inlineValue) viewport.style.removeProperty(this.rowHeightVar);
    const pitch = renderedRowPitch(viewport, this.rowSelector);
    if (inlineValue) viewport.style.setProperty(this.rowHeightVar, inlineValue, inlinePriority);
    return Math.max(0, finite(pitch, 0));
  }

  _scrollFrameMetrics() {
    const viewport = this.viewport;
    if (!viewport) return { frameHeight: 0, horizontalScrollbarHeight: 0, availableHeight: 0 };
    const style = getComputedStyle(viewport);
    const borderY = Math.max(0, finite(parseFloat(style.borderTopWidth), 0) + finite(parseFloat(style.borderBottomWidth), 0));
    const frameHeight = Math.max(0, finite(viewport.offsetHeight, 0) - borderY);
    // clientHeight excludes the native horizontal scrollbar. Taking the
    // difference from the borderless frame gives the real painted scrollbar
    // lane (0 for hidden/overlay scrollbars) without hard-coding 6px.
    const horizontalScrollbarHeight = Math.max(0, frameHeight - finite(viewport.clientHeight, 0));
    return {
      frameHeight,
      horizontalScrollbarHeight,
      availableHeight: Math.max(0, frameHeight - horizontalScrollbarHeight),
    };
  }

  _availableViewportHeight() {
    const viewport = this.viewport;
    if (!viewport) return 0;
    if (this.policy.fit === "distributed") return this._scrollFrameMetrics().availableHeight;
    if (this.policy.fit === "none") return Math.max(0, viewport.clientHeight || 0);
    const grid = viewport.parentElement?.classList?.contains("standard-data-grid")
      ? viewport.parentElement
      : null;
    if (!grid) return Math.max(0, viewport.clientHeight || 0);
    const headerBand = grid.querySelector?.(":scope > .standard-data-grid-header-band");
    return Math.max(0, (grid.clientHeight || 0) - (headerBand?.getBoundingClientRect?.().height || 0));
  }

  _fitViewportHeight(rowPitch, logicalRows) {
    const viewport = this.viewport;
    if (!viewport || this.policy.fit === "none") return null;

    if (this.policy.fit === "distributed") {
      const frame = this._scrollFrameMetrics();
      if (!(frame.availableHeight > 0)) return null;
      const configuredPreferred = this._configuredPitch(this.rowHeightVar, rowPitch || this.rowHeight || 28) || 28;
      const intrinsicFloor = Math.max(0, this.intrinsicRowPitch || 0);
      const preferred = Math.max(configuredPreferred, intrinsicFloor);
      const minPitch = Math.max(this._configuredPitch(this.minRowHeightVar, configuredPreferred) || configuredPreferred, intrinsicFloor);
      const configuredMax = this._configuredPitch(this.maxRowHeightVar, Math.max(minPitch, configuredPreferred + 6)) || Math.max(minPitch, configuredPreferred + 6);
      const maxPitch = Math.max(minPitch, configuredMax);
      const metrics = distributedRowViewportMetrics({
        frameHeight: frame.frameHeight,
        horizontalScrollbarHeight: frame.horizontalScrollbarHeight,
        preferredRowPitch: preferred,
        minRowPitch: minPitch,
        maxRowPitch: maxPitch,
        logicalRows,
      });
      if (Math.abs(this.lastAppliedRowPitch - metrics.rowPitch) > 0.01) {
        viewport.style.setProperty(this.rowHeightVar, `${metrics.rowPitch}px`);
        this.lastAppliedRowPitch = metrics.rowPitch;
      }
      viewport.style.setProperty("--row-snap-aligned-height", `${metrics.frameHeight}px`);
      viewport.style.setProperty("--row-snap-panel-remainder", `${metrics.remainder}px`);
      viewport.style.setProperty("--row-snap-horizontal-scrollbar-height", `${metrics.horizontalScrollbarHeight}px`);
      return metrics;
    }

    const available = this._availableViewportHeight();
    if (!(available > 0) || !(rowPitch > 0)) return null;
    const metrics = completeRowViewportMetrics(available, rowPitch, logicalRows);
    viewport.style.setProperty("--row-snap-aligned-height", `${metrics.alignedHeight}px`);
    viewport.style.setProperty("--row-snap-panel-remainder", `${metrics.remainder}px`);
    return metrics;
  }

  _syncObservedRow() {
    if (!this.rowResizeObserver || !this.viewport) return;
    const next = this.viewport.querySelector?.(this.rowSelector) || null;
    if (next === this.observedRow) return;
    if (this.observedRow) this.rowResizeObserver.unobserve?.(this.observedRow);
    this.observedRow = next;
    if (this.policy.fit === "distributed") this.intrinsicRowPitch = 0;
    if (next) this.rowResizeObserver.observe(next);
  }

  _syncTailSpacer(logicalRows, rowPitch) {
    const viewport = this.viewport;
    const spacer = this.tailSpacer;
    if (!viewport || !spacer || this.policy.fit === "none") return;
    // This spacer is fully owned by the controller; its inline height is the
    // source of truth. Avoid a synchronous layout read here.
    const previousSpacer = Math.max(0, parseFloat(spacer.style.height) || 0);
    const contentWithoutSpacer = Math.max(0, viewport.scrollHeight - previousSpacer);
    const desiredContentHeight = Math.max(viewport.clientHeight, Math.max(0, logicalRows) * rowPitch);
    const needed = Math.max(0, desiredContentHeight - contentWithoutSpacer);
    if (Math.abs(previousSpacer - needed) > 0.25) spacer.style.height = `${needed}px`;
  }

  _syncCachedExtent() {
    const viewport = this.viewport;
    if (!viewport || this.policy.fit === "none" || !(this.rowHeight > 0)) return;
    const logicalRows = Math.max(0, this.lastDomRowCount);
    this._syncTailSpacer(logicalRows, this.rowHeight);
    const canonicalMaxScroll = Math.max(0, logicalRows - this.visibleRows) * this.rowHeight;
    let nativeMaxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (nativeMaxScroll + 0.5 < canonicalMaxScroll && this.tailSpacer) {
      const shortfall = canonicalMaxScroll - nativeMaxScroll;
      const currentSpacer = Math.max(0, parseFloat(this.tailSpacer.style.height) || 0);
      this.tailSpacer.style.height = `${currentSpacer + shortfall}px`;
      nativeMaxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    }
    this.lastNativeMaxScroll = nativeMaxScroll;
    const maxIndex = Math.max(0, logicalRows - this.visibleRows);
    if (this.topRowIndex > maxIndex) this.scrollToIndex(maxIndex);
  }

  _scheduleExtentSync() {
    if (this.extentFrame || !this.viewport) return;
    this.extentFrame = requestAnimationFrame(() => {
      this.extentFrame = 0;
      this._syncCachedExtent();
    });
  }

  // A list that draws only some of its rows says which: `logicalRows` is the list's length (the scroll extent and the
  // scrollbar follow it), `firstRow` the index of its first drawn row. A head spacer before the rows holds the
  // undrawn rows above; the tail spacer the ones below.
  setVirtualWindow({ firstRow = 0, logicalRows = 0 } = {}) {
    const viewport = this.viewport;
    if (!viewport) return;
    const rows = Math.max(0, Math.trunc(finite(logicalRows, 0)));
    this.virtualWindow = { firstRow: clamp(Math.trunc(finite(firstRow, 0)), 0, rows), logicalRows: rows };
    this.lastDomRowCount = rows;
    if (!this.headSpacer) {
      this.headSpacer = document.createElement("div");
      this.headSpacer.className = "row-snap-head-spacer";
      this.headSpacer.setAttribute("aria-hidden", "true");
      viewport.insertBefore(this.headSpacer, viewport.firstChild);
    }
    if (!this.rowHeight) { this.scheduleMeasure(); return; }
    this._syncHeadSpacer();
    this._syncCachedExtent();
  }

  _syncHeadSpacer() {
    if (!this.headSpacer || !this.virtualWindow) return;
    const height = this.virtualWindow.firstRow * this.rowHeight;
    if (Math.abs((parseFloat(this.headSpacer.style.height) || 0) - height) > 0.01) this.headSpacer.style.height = `${height}px`;
  }

  measure(shouldSnap = true) {
    const viewport = this.viewport;
    if (!viewport) return;

    const previousPitch = this.rowHeight || 0;
    const previousIndex = previousPitch > 0
      ? rowIndexFromScrollOffset(viewport.scrollTop, previousPitch)
      : Math.max(0, this.topRowIndex || 0);

    const domRows = this.virtualWindow
      ? this.virtualWindow.logicalRows
      : Math.max(0, viewport.querySelectorAll?.(this.rowSelector)?.length || 0);
    this.lastDomRowCount = domRows;
    this._syncObservedRow();

    const { nextPitch, fitted } = this._resolveRowPitch(previousPitch, domRows);
    this.rowHeight = nextPitch;
    const maxIndex = this._applyVisibleRows(fitted, domRows);
    this._syncHeadSpacer();
    this._syncNativeExtent(domRows, maxIndex);

    // ResizeObserver fires continuously while splitters move. If only viewport
    // height changed, do not write scrollTop/snap on every frame. Only re-project
    // the logical row when the actual row pitch itself changed.
    const pitchChanged = previousPitch > 0 && Math.abs(previousPitch - nextPitch) > 0.05;
    if (pitchChanged) {
      const targetIndex = clamp(previousIndex, 0, maxIndex);
      const target = targetIndex * nextPitch;
      if (Math.abs(viewport.scrollTop - target) > 0.25) viewport.scrollTop = target;
      this.topRowIndex = targetIndex;
    } else if (shouldSnap && !document.body.classList.contains("workspace-resizing")) {
      this.snap(false);
    }

    this.onMetric?.({
      rowHeight: this.rowHeight,
      rowPitch: this.rowHeight,
      topRowIndex: this.topRowIndex,
      visibleRows: this.visibleRows,
      remainder: this.remainder,
      alignedHeight: fitted?.alignedHeight ?? viewport.clientHeight,
      panelRemainder: fitted?.remainder ?? this.remainder,
      horizontalScrollbarHeight: fitted?.horizontalScrollbarHeight ?? 0,
    });
    for (const fn of [...this.measuredListeners]) {
      try { fn(); } catch (error) { console.warn("[row snap: after-measure listener] failed", error); }
    }
  }

  // The row pitch: fitted to the viewport (adaptive rows), else the rendered or configured row height.
  _resolveRowPitch(previousPitch, domRows) {
    const viewport = this.viewport;
    const source = viewport.parentElement || viewport;
    const configured = parseFloat(getComputedStyle(source).getPropertyValue(this.rowHeightVar));
    let nextPitch = Math.max(1, configured || previousPitch || 28);
    if (this.policy.fit === "distributed") {
      // Learn the intrinsic floor once per mounted row topology. The result is
      // cached across viewport resizes, so splitter dragging and quote repainting
      // remain arithmetic-only and never measure DOM rows on the scroll hot path.
      if (!(this.intrinsicRowPitch > 0) && domRows > 0) {
        this.intrinsicRowPitch = this._measureIntrinsicRowPitch();
      }
      const fitted = this._fitViewportHeight(nextPitch, domRows);
      if (fitted?.rowPitch > 0) nextPitch = fitted.rowPitch;
      return { nextPitch, fitted };
    }
    const measuredPitch = (this.policy.pitch === "measured" || !(configured > 0))
      ? renderedRowPitch(viewport, this.rowSelector)
      : 0;
    nextPitch = Math.max(
      1,
      (this.policy.pitch === "measured" && measuredPitch > 0)
        ? measuredPitch
        : (configured || measuredPitch || previousPitch || 28),
    );
    return { nextPitch, fitted: this._fitViewportHeight(nextPitch, domRows) };
  }

  // How many whole rows fit and the remainder below them, published to CSS. Returns the last valid top-row index.
  _applyVisibleRows(fitted, domRows) {
    const viewport = this.viewport;
    // Every viewport holds rows only: StandardDataGrid's bodyScroll has no thead, the history product list none.
    const usable = fitted
      ? fitted.availableHeight ?? fitted.alignedHeight
      : Math.max(0, viewport.clientHeight);
    this.visibleRows = fitted
      ? fitted.visibleRows
      : Math.max(1, Math.floor((usable + 0.01) / this.rowHeight));
    this.remainder = fitted
      ? Math.max(0, fitted.remainder || 0)
      : Math.max(0, usable - this.visibleRows * this.rowHeight);
    const maxIndex = Math.max(0, domRows - this.visibleRows);
    this.topRowIndex = rowIndexFromScrollOffset(viewport.scrollTop, this.rowHeight, maxIndex);

    viewport.style.setProperty("--row-snap-remainder", `${this.remainder}px`);
    viewport.style.setProperty("--row-snap-measured-height", `${this.rowHeight}px`);
    viewport.style.setProperty("--row-snap-measured-pitch", `${this.rowHeight}px`);
    viewport.dataset.visibleRows = String(this.visibleRows);
    if (this.mask) this.mask.style.height = `${this.remainder}px`;
    return maxIndex;
  }

  _syncNativeExtent(domRows, maxIndex) {
    const viewport = this.viewport;
    if (this.policy.fit === "none") {
      this.lastNativeMaxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      return;
    }
    // Force the native scroll extent to be able to reach the canonical last
    // first-row index. Collapsed table borders can otherwise leave the final
    // scrollTop one pixel short and cause a visible second "settle" motion.
    this._syncTailSpacer(domRows, this.rowHeight);
    // Measure the real native extent only in this low-frequency geometry pass.
    // It must be at least the canonical logical max; the tail spacer supplies
    // any shortfall caused by collapsed borders/fractional DPI.
    const canonicalMaxScroll = maxIndex * this.rowHeight;
    let nativeMaxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (nativeMaxScroll + 0.5 < canonicalMaxScroll && this.tailSpacer) {
      const shortfall = canonicalMaxScroll - nativeMaxScroll;
      const currentSpacer = Math.max(0, parseFloat(this.tailSpacer.style.height) || 0);
      this.tailSpacer.style.height = `${currentSpacer + shortfall}px`;
      nativeMaxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    }
    this.lastNativeMaxScroll = nativeMaxScroll;
  }

  metrics(logicalRowCount = 0) {
    const viewport = this.viewport;
    if (!viewport) {
      return {
        rowHeight: Math.max(1, this.rowHeight || 28),
        rowPitch: Math.max(1, this.rowHeight || 28),
        topRowIndex: Math.max(0, this.topRowIndex || 0),
        visibleRows: Math.max(1, this.visibleRows || 1),
        logicalRows: 0,
        maxIndex: 0,
        maxScroll: 0,
        nativeMaxScroll: 0,
      };
    }
    if (!this.rowHeight) this.measure(false);
    const rowHeight = Math.max(1, this.rowHeight || 28);
    const visibleRows = Math.max(1, this.visibleRows || Math.floor(viewport.clientHeight / rowHeight));
    const suppliedRows = Math.max(0, Math.trunc(finite(logicalRowCount, 0)));

    // Complete-row grids cache row count + scroll extent during the low-frequency
    // measure phase. Wheel/trackpad/keyboard scrolling therefore stays pure row
    // arithmetic and does not read scrollHeight/query the DOM on every gesture.
    const domRows = this.policy.fit !== "none"
      ? Math.max(0, this.lastDomRowCount)
      : Math.max(0, viewport.querySelectorAll?.(this.rowSelector)?.length || 0);
    const logicalRows = Math.max(suppliedRows, domRows);
    const nativeMaxScroll = this.policy.fit !== "none"
      ? Math.max(0, this.lastNativeMaxScroll)
      : Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const nativeMaxIndex = Math.max(0, Math.round(nativeMaxScroll / rowHeight));
    const logicalMaxIndex = Math.max(0, logicalRows - visibleRows);
    const maxIndex = this.policy.fit !== "none" ? logicalMaxIndex : Math.max(nativeMaxIndex, logicalMaxIndex);
    const maxScroll = this.policy.fit !== "none" ? logicalMaxIndex * rowHeight : Math.max(nativeMaxScroll, logicalMaxIndex * rowHeight);
    this.topRowIndex = rowIndexFromScrollOffset(viewport.scrollTop, rowHeight, maxIndex);
    return {
      rowHeight,
      rowPitch: rowHeight,
      topRowIndex: this.topRowIndex,
      visibleRows,
      logicalRows,
      maxIndex,
      maxScroll,
      nativeMaxScroll,
    };
  }

  snap(smooth = this.policy.scroll === "smooth") {
    const viewport = this.viewport;
    if (!viewport || !this.rowHeight) return;
    const metrics = this.metrics();
    const nextIndex = rowIndexFromScrollOffset(viewport.scrollTop, metrics.rowHeight, metrics.maxIndex);
    const target = nextIndex * metrics.rowHeight;
    this.topRowIndex = nextIndex;
    if (Math.abs(target - viewport.scrollTop) < 0.5) return;
    viewport.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
  }

  scrollToIndex(index) {
    const viewport = this.viewport;
    if (!viewport) return;
    const metrics = this.metrics();
    const nextIndex = clamp(Math.trunc(index), 0, metrics.maxIndex);
    this.topRowIndex = nextIndex;
    const top = nextIndex * metrics.rowHeight;
    if (Math.abs(viewport.scrollTop - top) < 0.25) return;
    viewport.scrollTo({ top, behavior: this.policy.scroll === "smooth" ? "smooth" : "auto" });
  }

  scrollByRows(rows) {
    if (!this.viewport) return;
    const metrics = this.metrics();
    this.scrollToIndex(metrics.topRowIndex + Math.trunc(rows));
  }

  refreshContent({ topologyChanged = true, logicalRows = null, forceGeometry = false } = {}) {
    // Data changes and geometry changes are separate concerns. Live quote/tick
    // rendering may replace <tr> nodes dozens of times per second, but fixed-row
    // geometry does not change. Keep row count as cheap logical state and only
    // remeasure when the controller is uninitialised or a caller explicitly says
    // the CSS/layout contract changed.
    const hasLogicalRows = logicalRows !== null && logicalRows !== undefined && logicalRows !== "";
    const supplied = hasLogicalRows ? Number(logicalRows) : Number.NaN;
    const hasSuppliedCount = Number.isFinite(supplied) && supplied >= 0;
    // A windowed list's row count is the one its owner set, never the rows drawn now.
    const count = this.virtualWindow
      ? this.virtualWindow.logicalRows
      : hasSuppliedCount
        ? Math.max(0, Math.trunc(supplied))
        : (topologyChanged ? Math.max(0, this.viewport?.querySelectorAll?.(this.rowSelector)?.length || 0) : this.lastDomRowCount);
    const countChanged = count !== this.lastDomRowCount;
    if (count >= 0) this.lastDomRowCount = count;

    if (!this.rowHeight || forceGeometry) {
      this._syncObservedRow();
      this.scheduleMeasure();
      return;
    }

    if (this.policy.fit === "distributed") {
      // If mount happened while only a large-padding placeholder existed, learn
      // the real physical floor exactly once when the first genuine data row
      // appears. This is a one-time topology transition, not a per-Tick measure.
      if (!(this.intrinsicRowPitch > 0) && count > 0 && this._hasRealDataRow()) {
        this.scheduleMeasure();
        return;
      }
      // In adaptive complete-row mode rowPitch depends only on viewport/CSS, not
      // on how many live rows currently exist. A row-count change only needs the
      // native scroll extent/tail spacer refreshed; no getComputedStyle/rect
      // measurement is allowed on the market-data hot path.
      if (countChanged) this._scheduleExtentSync();
      return;
    }

    if (!topologyChanged) return;
    this._syncObservedRow();
    if (countChanged) this.scheduleMeasure();
  }

  ensureRowVisible(index) {
    if (!this.viewport) return;
    this.measure();
    const metrics = this.metrics();
    const current = metrics.topRowIndex;
    const end = current + metrics.visibleRows - 1;
    if (index < current) this.scrollToIndex(index);
    else if (index > end) this.scrollToIndex(index - this.visibleRows + 1);
  }

  destroy() {
    if (this.measureFrame) cancelAnimationFrame(this.measureFrame);
    if (this.extentFrame) cancelAnimationFrame(this.extentFrame);
    this.measureFrame = 0;
    this.extentFrame = 0;
    this.resizeObserver?.disconnect?.();
    this.resizeObserver = null;
    this.rowResizeObserver?.disconnect?.();
    this.rowResizeObserver = null;
    this.observedRow = null;
    for (const fn of this.cleanup.splice(0)) { try { fn(); } catch (error) { console.warn("[paged list: cleanup] failed", error); } }
    this.mask?.remove?.();
    this.mask = null;
    this.tailSpacer?.remove?.();
    this.tailSpacer = null;
    this.headSpacer?.remove?.();
    this.headSpacer = null;
    this.virtualWindow = null;
    this.viewport?.classList?.remove?.("row-snap-fit-complete-rows");
    this.viewport?.classList?.remove?.("row-snap-distribute-remainder");
    this.viewport?.style?.removeProperty?.("--row-snap-aligned-height");
    if (this.viewport && this.policy.fit === "distributed") this.viewport.style.removeProperty(this.rowHeightVar);
    this.viewport?.style?.removeProperty?.("--row-snap-panel-remainder");
    if (this.viewport && sharedRowController(this.viewport) === this) {
      ROW_SCROLL_RUNTIME.controllers.delete(this.viewport);
    }
    this.viewport?.classList?.remove?.("row-snap-viewport");
    this.viewport = null;
  }
}

// Shared public helper for lists whose semantic scroll unit is one complete row.
// Consumers only provide their row-height contract; wheel/touchpad/thumb/keyboard
// behavior stays centralized here instead of being reimplemented per screen.
export function enableRowUnitScroll(options = {}) {
  return new RowSnapController({
    ...(options || {}),
    rowUnit: true,
    wheelStepRows: Math.max(1, Math.trunc(finite(options?.wheelStepRows, 1))),
    smooth: false,
  }).mount();
}

// A list whose rows are not one height scrolled one row at a time (帳務's 個股數據 / 每日明細 / 配對明細: an open row's
// detail is a row of its own, user 11-01 -- one step rests on the detail's top, the next on the next row). Every
// resting position is a shown row's top: the wheel, touchpad and arrow keys move one row, a dragged scrollbar settles
// on the nearest row's top when it stops. The last rows that fit below the maximum scroll share that last position.
export class RowStopController {
  constructor({ viewport, rowSelector = ":scope > table > tbody > tr" } = {}) {
    this.viewport = viewport || null;
    this.rowSelector = rowSelector;
    this.wheelAccumulator = 0;
    this.lastWheelAt = 0;
    this.cleanup = [];
  }

  mount() {
    const viewport = this.viewport;
    if (!viewport) return this;
    viewport.tabIndex = viewport.tabIndex >= 0 ? viewport.tabIndex : 0;
    const on = (type, handler, options) => {
      viewport.addEventListener(type, handler, options);
      this.cleanup.push(() => viewport.removeEventListener(type, handler, options));
    };
    on("wheel", (event) => this._onWheel(event), { passive: false });
    on("keydown", (event) => this._onKeydown(event));
    on("scrollend", () => this._settle());
    return this;
  }

  /** The shown rows' tops in the list (`stops`, ascending, within its maximum scroll) and, for a row taller than the
   * view, the span it scrolls through freely (`ranges`, row_metrics.js): its top to where its bottom meets the view's
   * bottom, which is a stop too. */
  layout() {
    const viewport = this.viewport;
    const origin = viewport.getBoundingClientRect().top - viewport.scrollTop;
    const view = viewport.clientHeight;
    const max = Math.max(0, viewport.scrollHeight - view);
    const within = (value) => Math.min(max, Math.max(0, Math.round(value)));
    const tops = [];
    const ranges = [];
    for (const row of viewport.querySelectorAll(this.rowSelector)) {
      if (row.hidden || !row.getClientRects().length) continue;
      const box = row.getBoundingClientRect();
      const from = within(box.top - origin);
      tops.push(from);
      if (box.height > view) {
        const to = within(box.bottom - origin - view);
        if (to > from) { tops.push(to); ranges.push({ from, to }); }
      }
    }
    return { stops: [...new Set(tops)].sort((a, b) => a - b), ranges };
  }

  scrollByRows(rows) {
    const { stops, ranges } = this.layout();
    const target = rowStopStep(stops, ranges, this.viewport.scrollTop, rows);
    if (target !== this.viewport.scrollTop) this.viewport.scrollTop = target;
  }

  // A mouse wheel detent is about 100 px of delta (several when Chromium coalesces them into one event); a touchpad
  // sends small deltas, gathered until they make one row.
  _onWheel(event) {
    if (!event.deltaY || event.shiftKey) return;
    event.preventDefault();
    const now = performance.now();
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : Math.sign(event.deltaY) * 100;
    if (now - this.lastWheelAt > 180 || Math.sign(delta) !== Math.sign(this.wheelAccumulator)) this.wheelAccumulator = 0;
    this.lastWheelAt = now;
    this.wheelAccumulator += delta;
    const gathered = Math.abs(this.wheelAccumulator);
    if (gathered < 50) return;
    const rows = Math.sign(this.wheelAccumulator) * Math.max(1, Math.round(gathered / 100));
    this.wheelAccumulator = 0;
    this.scrollByRows(clamp(rows, -6, 6));
  }

  _onKeydown(event) {
    const rows = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[event.key];
    if (!rows || event.target !== this.viewport) return;
    event.preventDefault();
    this.scrollByRows(rows);
  }

  _settle() {
    const { stops, ranges } = this.layout();
    if (!stops.length) return;
    const target = rowStopSettle(stops, ranges, this.viewport.scrollTop);
    if (Math.abs(target - this.viewport.scrollTop) > 0.5) this.viewport.scrollTop = target;
  }

  destroy() {
    this.cleanup.splice(0).forEach((stop) => stop());
    this.viewport = null;
  }
}
