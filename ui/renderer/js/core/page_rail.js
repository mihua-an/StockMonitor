import { clamp } from "./utility.js";
import { finite } from "./row_metrics.js";
import { DiscreteRowScrollbarController } from "./discrete_row_scrollbar.js";

// The selector follows the list's width; below this its « ‹ [page] › » row would not fit.
const POPUP_MIN_WIDTH = 150;

// The selector's move buttons: one chevron for a page, two for five (stroked in the button's colour).
const chevron = (points) => `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
const PAGE_MOVE_ICONS = Object.freeze({
  back5: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${chevron("8,3.5 3.5,8 8,12.5")}${chevron("12.5,3.5 8,8 12.5,12.5")}</svg>`,
  back1: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${chevron("10,3.5 5.5,8 10,12.5")}</svg>`,
  next1: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${chevron("6,3.5 10.5,8 6,12.5")}</svg>`,
  next5: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${chevron("3.5,3.5 8,8 3.5,12.5")}${chevron("8,3.5 12.5,8 8,12.5")}</svg>`,
});

// 成交明細's page controls: ▲ / page number / ▼ under the row scrollbar, and the page selector the number opens
// (頁碼 with current / total pages, a slider, and « ‹ [page] › »: one page or five; Enter in the box opens its page). The selector lives in document.body,
// placed beside the number and kept on screen: inside the list it was clipped as soon as the pane was narrow. The page
// controls always show, one page or many.
export class PageRailController {
  constructor({ host, viewport = null, onPageRequest = null } = {}) {
    this.host = host || null;
    this.viewport = viewport || null;
    this.onPageRequest = typeof onPageRequest === "function" ? onPageRequest : null;
    this.vm = { page: 1, totalPages: 1, loading: false, rowCount: 0, pageSize: 100 };
    this.cleanup = [];
    this.syncScrollbar = null;
    this.discreteScrollbar = null;
    this.syncFrame = 0;
    this.popup = null;
  }

  mount() {
    if (!this.host) return this;
    this.host.innerHTML = `<div class="page-scrollbar" data-page-scrollbar aria-label="成交明細捲軸">
      <button type="button" class="page-scroll-step" data-scroll-step="-1" aria-label="向上捲動">▲</button>
      <div class="page-scroll-track" data-scroll-track><i class="page-scroll-thumb" data-scroll-thumb></i></div>
      <button type="button" class="page-scroll-step" data-scroll-step="1" aria-label="向下捲動">▼</button>
    </div><div class="page-rail-stack" data-page-rail-stack>
      <button type="button" class="page-rail-step" data-page-step="prev" aria-label="上一頁">▲</button>
      <button type="button" class="page-rail-number" data-page-selector-open>1</button>
      <button type="button" class="page-rail-step" data-page-step="next" aria-label="下一頁">▼</button>
    </div>`;
    const doc = this.host.ownerDocument;
    this.popup = doc.createElement("div");
    this.popup.className = "page-selector-popup";
    this.popup.hidden = true;
    this.popup.setAttribute("role", "dialog");
    this.popup.setAttribute("aria-label", "成交明細頁碼");
    this.popup.innerHTML = `<div class="page-selector-title"><span>頁碼</span><b data-page-selector-summary>1 / 1</b></div>
      <input type="range" min="1" max="1" value="1" step="1" data-page-selector-range />
      <div class="page-selector-jump">
        <button type="button" data-page-move="-5" aria-label="往前 5 頁">${PAGE_MOVE_ICONS.back5}</button>
        <button type="button" data-page-move="-1" aria-label="上一頁">${PAGE_MOVE_ICONS.back1}</button>
        <input type="number" min="1" value="1" data-page-selector-input aria-label="頁數（按 Enter 跳頁）" />
        <button type="button" data-page-move="1" aria-label="下一頁">${PAGE_MOVE_ICONS.next1}</button>
        <button type="button" data-page-move="5" aria-label="往後 5 頁">${PAGE_MOVE_ICONS.next5}</button>
      </div>`;
    doc.body.appendChild(this.popup);
    const input = this.popup.querySelector("[data-page-selector-input]");
    const range = this.popup.querySelector("[data-page-selector-range]");
    const rangeChange = () => this.request(Number(range?.value || 1));
    // While the slider is dragged, the title and the box say which page it is on; letting go opens that page.
    const summary = this.popup.querySelector("[data-page-selector-summary]");
    const rangeInput = () => {
      const value = String(range?.value || 1);
      if (summary) summary.textContent = `${value} / ${this.vm.totalPages}`;
      if (input) input.value = value;
    };
    const click = (event) => {
      const step = event.target?.closest?.("[data-page-step]")?.dataset?.pageStep;
      if (step) { this.request(step === "prev" ? this.vm.page - 1 : this.vm.page + 1); return; }
      if (event.target?.closest?.("[data-page-selector-open]")) { this.togglePopup(); return; }
      // «  ‹  ›  »: five pages or one; past either end goes to the first / last page.
      const move = Number(event.target?.closest?.("[data-page-move]")?.dataset?.pageMove);
      if (move) this.request(this.vm.page + move);
    };
    const inputKey = (event) => { if (event.key === "Enter") { event.preventDefault(); this.request(Number(input?.value || 1)); } };
    const outside = (event) => { if (!this.host?.contains(event.target) && !this.popup?.contains(event.target)) this.closePopup(); };
    const keys = (event) => {
      if (!this.popup || this.popup.hidden) return;
      if (event.key === "Escape") this.closePopup();
      else if (event.key === "Home") { event.preventDefault(); this.request(1); }
      else if (event.key === "End") { event.preventDefault(); this.request(this.vm.totalPages); }
    };
    // The selector is placed against the page number: a window resized meanwhile closes it rather than leave it adrift.
    const resized = () => this.closePopup();
    const view = doc.defaultView;
    this.host.addEventListener("click", click);
    this.popup.addEventListener("click", click);
    input?.addEventListener("keydown", inputKey);
    range?.addEventListener("change", rangeChange);
    range?.addEventListener("input", rangeInput);
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", keys, true);
    view?.addEventListener?.("resize", resized);
    this.cleanup.push(
      () => this.host?.removeEventListener?.("click", click),
      () => this.popup?.removeEventListener?.("click", click),
      () => input?.removeEventListener?.("keydown", inputKey),
      () => range?.removeEventListener?.("change", rangeChange),
      () => range?.removeEventListener?.("input", rangeInput),
      () => doc.removeEventListener("pointerdown", outside, true),
      () => doc.removeEventListener("keydown", keys, true),
      () => view?.removeEventListener?.("resize", resized),
    );
    this._bindScrollbar();
    this._renderControls();
    return this;
  }

  togglePopup() {
    if (!this.popup) return;
    if (!this.popup.hidden) { this.closePopup(); return; }
    const anchor = this.host?.querySelector?.("[data-page-selector-open]");
    if (!anchor) return;
    // As wide as the list it pages (inset a little on both sides, never narrower than its controls need), over the
    // list's width with its bottom on the page number's; kept on screen.
    const list = (this.host.parentElement || this.host).getBoundingClientRect();
    const view = this.host.ownerDocument.defaultView, gap = 4;
    const popupWidth = Math.max(POPUP_MIN_WIDTH, Math.round(list.width - 2 * gap));
    this.popup.style.width = `${popupWidth}px`;
    this.popup.hidden = false;
    const box = anchor.getBoundingClientRect(), size = this.popup.getBoundingClientRect();
    const width = view?.innerWidth || size.width, height = view?.innerHeight || size.height;
    const left = Math.max(gap, Math.min(list.left + gap, width - size.width - gap));
    const top = Math.max(gap, Math.min(box.bottom - size.height, height - size.height - gap));
    this.popup.style.left = `${Math.round(left)}px`;
    this.popup.style.top = `${Math.round(top)}px`;
  }

  closePopup() { if (this.popup) this.popup.hidden = true; }

  _bindScrollbar() {
    const host = this.host?.querySelector?.("[data-page-scrollbar]")?.parentElement || this.host;
    if (!host || !this.viewport) return;
    // Reuse the same logical-row scrollbar used by live product/event grids.
    this.discreteScrollbar?.destroy?.();
    this.discreteScrollbar = new DiscreteRowScrollbarController({
      host,
      viewport: this.viewport,
      getLogicalRowCount: () => this.vm?.rowCount,
    }).mount();
    this.syncScrollbar = () => this.discreteScrollbar?.sync?.();
  }

  refreshScrollbar() {
    if (typeof this.syncScrollbar !== "function" || this.syncFrame) return;
    this.syncFrame = requestAnimationFrame(() => {
      this.syncFrame = 0;
      this.syncScrollbar?.();
    });
  }

  request(page) {
    if (this.vm.loading) return;
    const next = clamp(Math.trunc(finite(page, 1)), 1, Math.max(1, this.vm.totalPages));
    if (next === this.vm.page) return;
    this.closePopup();
    this.onPageRequest?.(next);
  }

  // The page number, the selector's summary, its page buttons and the step buttons, from this.vm.
  _renderControls() {
    if (!this.host) return;
    const { page, totalPages, loading } = this.vm;
    const pageButton = this.host.querySelector("[data-page-selector-open]");
    if (pageButton) {
      pageButton.textContent = String(page);
      pageButton.setAttribute("aria-label", `目前第 ${page} 頁，共 ${totalPages} 頁；點擊選擇頁碼`);
    }
    const popup = this.popup;
    if (popup) {
      const summary = popup.querySelector("[data-page-selector-summary]");
      if (summary) summary.textContent = `${page} / ${totalPages}`;
      const range = popup.querySelector("[data-page-selector-range]");
      if (range) { range.max = String(totalPages); range.value = String(page); range.disabled = loading; }
      const input = popup.querySelector("[data-page-selector-input]");
      if (input) { input.max = String(totalPages); input.value = String(page); input.disabled = loading; }
    }
    for (const root of [this.host, popup]) {
      root?.querySelectorAll?.("[data-page-step]").forEach((button) => {
        button.disabled = loading || (button.dataset.pageStep === "prev" ? page <= 1 : page >= totalPages);
      });
    }
    popup?.querySelectorAll?.("[data-page-move]").forEach((button) => {
      button.disabled = loading || (Number(button.dataset.pageMove) < 0 ? page <= 1 : page >= totalPages);
    });
  }

  update(vm = {}) {
    const previous = this.vm || {};
    const next = {
      page: Math.max(1, Math.trunc(finite(vm.page, 1))),
      totalPages: Math.max(1, Math.trunc(finite(vm.totalPages, 1))),
      loading: Boolean(vm.loading),
      rowCount: Math.max(0, Math.trunc(finite(vm.rowCount, previous?.rowCount || 0))),
      pageSize: Math.max(1, Math.trunc(finite(vm.pageSize, previous?.pageSize || 100))),
    };
    const controlsChanged = next.page !== previous.page
      || next.totalPages !== previous.totalPages
      || next.loading !== previous.loading;
    const rowCountChanged = next.rowCount !== previous.rowCount
      || next.pageSize !== previous.pageSize;
    this.vm = next;
    if (!this.host) return;
    // Live ticks usually leave page / total / rows unchanged: the controls are written only when they moved.
    if (controlsChanged) this._renderControls();
    if (rowCountChanged || controlsChanged) this.refreshScrollbar();
  }

  destroy() {
    if (this.syncFrame) cancelAnimationFrame(this.syncFrame);
    this.syncFrame = 0;
    this.discreteScrollbar?.destroy?.();
    this.discreteScrollbar = null;
    for (const fn of this.cleanup.splice(0)) { try { fn(); } catch (error) { console.warn("[paged list: cleanup] failed", error); } }
    this.popup?.remove();
    this.popup = null;
    if (this.host) this.host.innerHTML = "";
    this.host = null;
    this.viewport = null;
    this.syncScrollbar = null;
  }
}
