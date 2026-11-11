import { clamp } from "./utility.js";
import { finite } from "./row_metrics.js";
import { sharedRowController } from "./row_snap.js";

// Shared discrete scrollbar used by transaction details and live row-unit grids.
// The thumb maps directly to a logical first-row index; it never lets Chromium
// expose arbitrary pixel scrollTop values while the thumb is being dragged.
export class DiscreteRowScrollbarController {
  constructor({ host, viewport, getLogicalRowCount = null } = {}) {
    this.host = host || null;
    this.viewport = viewport || null;
    this.getLogicalRowCount = typeof getLogicalRowCount === "function" ? getLogicalRowCount : null;
    this.cleanup = [];
    this.syncScrollbar = null;
  }

  mount() {
    const host = this.host;
    const viewport = this.viewport;
    if (!host || !viewport) return this;
    if (!host.querySelector?.("[data-scroll-track]")) {
      host.innerHTML = `<div class="page-scrollbar" data-page-scrollbar aria-label="資料列捲軸">
        <button type="button" class="page-scroll-step" data-scroll-step="-1" aria-label="向上捲動">▲</button>
        <div class="page-scroll-track" data-scroll-track><i class="page-scroll-thumb" data-scroll-thumb></i></div>
        <button type="button" class="page-scroll-step" data-scroll-step="1" aria-label="向下捲動">▼</button>
      </div>`;
    }
    this.track = host.querySelector("[data-scroll-track]");
    this.thumb = host.querySelector("[data-scroll-thumb]");
    if (!this.track || !this.thumb) return this;
    this._rowController();
    // Geometry is cached by ResizeObserver. The scroll hot path performs only row-index arithmetic + one transform
    // write; it never reads scrollHeight/clientHeight/getBoundingClientRect while the user scrolls.
    this.cachedTrackHeight = Math.max(1, this.track.clientHeight || 1);
    this.lastThumbHeight = -1;
    this.stopThumbDrag = null;
    const sync = () => this._syncThumb();
    const click = (event) => this._onStepClick(event);
    const trackClick = (event) => this._onTrackClick(event);
    const thumbDown = (event) => this._onThumbDown(event);
    viewport.addEventListener("scroll", sync, { passive: true });
    host.addEventListener("click", click);
    this.track.addEventListener("click", trackClick);
    this.thumb.addEventListener("pointerdown", thumbDown);
    this.syncScrollbar = sync;
    this.cleanup.push(
      () => viewport.removeEventListener("scroll", sync),
      () => host.removeEventListener("click", click),
      () => this.track.removeEventListener("click", trackClick),
      () => this.thumb.removeEventListener("pointerdown", thumbDown),
      () => this.stopThumbDrag?.(),
    );
    this._observeGeometry(sync);
    const firstSync = requestAnimationFrame(sync);
    this.cleanup.push(() => cancelAnimationFrame(firstSync));
    return this;
  }

  // The viewport's RowSnapController is this scrollbar's one source of geometry (row pitch, rows, max scroll): every
  // consumer creates it first (enableRowUnitScroll / RowSnapController), and mount() refuses a viewport without one.
  _rowController() {
    const controller = sharedRowController(this.viewport);
    if (!controller) throw new Error("DiscreteRowScrollbarController: the viewport has no RowSnapController (create it before the scrollbar)");
    return controller;
  }

  _rowMetrics() {
    return this._rowController().metrics(Math.max(0, Math.trunc(finite(this.getLogicalRowCount?.(), 0))));
  }

  _scrollToIndex(index) {
    if (!this.viewport) return;
    this._rowController().scrollToIndex(clamp(Math.round(index), 0, this._rowMetrics().maxIndex));
  }

  _syncThumb() {
    // A frame or observer callback queued before destroy() finds the controller detached: nothing to draw.
    if (!this.viewport || !this.thumb) return;
    const { maxIndex, logicalRows, visibleRows, topRowIndex } = this._rowMetrics();
    const trackHeight = this.cachedTrackHeight;
    const viewportRows = Math.max(1, visibleRows || 1);
    const contentRows = Math.max(viewportRows, logicalRows || 0);
    const thumbHeight = maxIndex > 0
      ? Math.max(12, Math.round(trackHeight * viewportRows / contentRows))
      : trackHeight;
    const travel = Math.max(0, trackHeight - thumbHeight);
    const top = maxIndex > 0 ? Math.round(travel * topRowIndex / maxIndex) : 0;
    if (thumbHeight !== this.lastThumbHeight) {
      this.thumb.style.height = `${thumbHeight}px`;
      this.lastThumbHeight = thumbHeight;
    }
    this.thumb.style.transform = `translateY(${top}px)`;
    this.thumb.hidden = maxIndex <= 0;
    this.track.dataset.scrollable = maxIndex > 0 ? "1" : "0";
  }

  _onStepClick(event) {
    const step = Number(event.target?.closest?.("[data-scroll-step]")?.dataset?.scrollStep || 0);
    if (!step) return;
    this._scrollToIndex(this._rowMetrics().topRowIndex + step);
  }

  _onTrackClick(event) {
    if (event.target === this.thumb) return;
    const rect = this.track.getBoundingClientRect();
    const ratio = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    this._scrollToIndex(Math.round(ratio * this._rowMetrics().maxIndex));
  }

  // Dragging the thumb moves the first visible row index, one whole row at a time.
  _onThumbDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopThumbDrag?.();
    const { track, thumb } = this;
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const metrics = this._rowMetrics();
    const startIndex = metrics.topRowIndex;
    const travel = Math.max(1, track.clientHeight - thumb.getBoundingClientRect().height);
    let displayedIndex = startIndex;
    thumb.classList.add("is-dragging");
    // Capture can fail only for a pointer that is already gone; the window listeners below still end the drag.
    try { thumb.setPointerCapture?.(pointerId); } catch (_error) { /* not an error: capture fails only for a pointer that is already released; the window listeners still end the drag */ }
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const nextIndex = clamp(Math.round(startIndex + (moveEvent.clientY - startY) * metrics.maxIndex / travel), 0, metrics.maxIndex);
      if (nextIndex === displayedIndex) return;
      displayedIndex = nextIndex;
      this._scrollToIndex(nextIndex);
    };
    const finish = (finishEvent = null) => {
      if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      thumb.classList.remove("is-dragging");
      try { if (thumb.hasPointerCapture?.(pointerId)) thumb.releasePointerCapture?.(pointerId); } catch (_error) { /* not an error: the pointer is already released */ }
      this.stopThumbDrag = null;
    };
    this.stopThumbDrag = finish;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  }

  _observeGeometry(sync) {
    const viewport = this.viewport;
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        this.cachedTrackHeight = Math.max(1, this.track.clientHeight || 1);
        sync();
      });
      observer.observe(viewport);
      observer.observe(this.track);
      this.cleanup.push(() => observer.disconnect?.());
    }
    // The rows the viewport holds come from its row controller's measure, which runs after a resize: redraw then too.
    const stopMeasured = sharedRowController(viewport)?.onMeasured?.(sync);
    if (stopMeasured) this.cleanup.push(stopMeasured);
    // PageRail supplies rowCount directly on every VM update, so observing its
    // entire live Tick DOM would duplicate work. Keep the fallback observer only
    // for standalone discrete rails that have no logical-row supplier.
    if (!this.getLogicalRowCount && typeof MutationObserver === "function") {
      let contentFrame = 0;
      const contentObserver = new MutationObserver(() => {
        if (contentFrame) return;
        contentFrame = requestAnimationFrame(() => { contentFrame = 0; sync(); });
      });
      contentObserver.observe(viewport, { childList: true, subtree: true });
      this.cleanup.push(() => { if (contentFrame) cancelAnimationFrame(contentFrame); }, () => contentObserver.disconnect?.());
    }
  }

  sync() { this.syncScrollbar?.(); }

  destroy() {
    for (const fn of this.cleanup.splice(0)) { try { fn(); } catch (error) { console.warn("[paged list scrollbar: cleanup] failed", error); } }
    this.syncScrollbar = null;
    this.host = null;
    this.viewport = null;
  }
}
