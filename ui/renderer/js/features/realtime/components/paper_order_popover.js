// The 模擬下單 popover beside a 買賣報價 (docs/system-architecture/11 §3): where a price clicked opens an order when no
// 模擬帳務 is on the page (paper_order_entry.js). 模擬 and the stock, then the order ticket (order_ticket.js) at the price
// clicked, with 今日額度剩餘 and 庫存; 買進 / 賣出 place the order at once (the popover is itself the small detail). It
// stays open with what was sent, or why the desk refused it; Esc, × or a click outside closes it.
// One per window, in the document body above the panes; its data from the page: the paper-orders store (funds, place),
// the paper holdings and the order book feed (dataSource "orderbook", the clicked stock only).

import { orderBookReadView } from "../../../core/market_read_model.js";
import { inFlight, runSingleFlight } from "../../../core/user_action.js";
import { OrderTicket, orderTicketHtml } from "./order_ticket.js";

const GAP = 6;

export class PaperOrderPopover {
  constructor({ doc = globalThis.document, store = null, paperHoldings = null, dataSource = null } = {}) {
    this.doc = doc; this.store = store; this.paperHoldings = paperHoldings; this.dataSource = dataSource;
    this.cleanup = [];
    this.root = doc.createElement("div");
    this.root.className = "paper-order-popover";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "模擬下單");
    this.root.innerHTML = `<div class="paper-order-popover-head"><span class="paper-order-popover-tag">模擬</span>`
      + `<span class="paper-order-popover-title" data-role="popover-title"></span>`
      + `<button class="paper-order-popover-close" type="button" data-popover-action="close" aria-label="關閉">×</button></div>`
      + `<div data-role="popover-ticket">${orderTicketHtml({ quota: true })}</div>`
      + `<div class="paper-order-popover-message" data-role="popover-message" aria-live="polite"></div>`;
    doc.body.appendChild(this.root);
    this.ticket = new OrderTicket(this.root.querySelector('[data-role="popover-ticket"]'), {
      quota: true,
      onSide: (side) => this.#submit(side),
      onProblem: (text) => this.#message(text, true),
      onChange: () => this.#message(""),
    });
    const on = (node, type, fn, options) => { node.addEventListener(type, fn, options); this.cleanup.push(() => node.removeEventListener(type, fn, options)); };
    on(this.root, "click", (event) => {
      if (event.target.closest('[data-popover-action="close"]')) { this.close(); return; }
      this.ticket.handleClick(event);
    });
    // A press outside closes it; a press on a 買賣報價 price does not (that click reopens it at the new price).
    on(doc, "mousedown", (event) => {
      if (this.root.hidden || this.root.contains(event.target) || event.target.closest?.(".orderbook-price-cell")) return;
      this.close();
    }, true);
    on(doc, "keydown", (event) => { if (event.key === "Escape" && !this.root.hidden) this.close(); });
    if (paperHoldings) {
      this.cleanup.push(paperHoldings.subscribe((pages) => this.ticket.setPositions(this.#positions(pages))));
    }
    if (dataSource) {
      this.cleanup.push(dataSource.subscribe?.("orderbook", (raw) => {
        const vm = orderBookReadView(raw);
        const code = String(vm?.displayCode || vm?.code || "").toUpperCase();
        if (!this.root.hidden && vm && code === this.ticket.code) { this.ticket.setBook(vm); this.#title(); }
      }) || (() => {}));
    }
  }

  #positions(pages) { return (pages?.tw?.items || []).filter((p) => Number(p.position_qty)); }

  get isOpen() { return !this.root.hidden; }

  /** Open on `code` at `price`, beside `anchor` (the price cell clicked); `vm` is that book's view as it stands. */
  open({ code, name = "", price = null, anchor = null, vm = null } = {}) {
    this.ticket.open({ code, name, price });
    if (vm) this.ticket.setBook(vm);
    this.#message("");
    this.#title();
    this.root.hidden = false;
    this.#position(anchor);
    void this.#loadAccount();
    this.dataSource?.invalidate?.("orderbook", { symbol: this.ticket.code });
  }

  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.ticket.close();
  }

  #title() {
    const node = this.root.querySelector('[data-role="popover-title"]');
    const text = `${this.ticket.code}${this.ticket.name && this.ticket.name !== this.ticket.code ? ` ${this.ticket.name}` : ""}`;
    if (node.textContent !== text) node.textContent = text;
  }

  // Beside the 買賣報價 the price belongs to: to its right when the window has room, else to its left; level with the
  // row clicked, kept inside the window.
  #position(anchor) {
    const view = this.doc.defaultView;
    const book = anchor?.closest?.('[data-role="orderbook-root"]') || anchor;
    const box = this.root.getBoundingClientRect();
    if (!book) { this.root.style.left = `${GAP}px`; this.root.style.top = `${GAP}px`; return; }
    const area = book.getBoundingClientRect(), row = (anchor.closest?.("tr") || anchor).getBoundingClientRect();
    const right = area.right + GAP, left = area.left - GAP - box.width;
    const x = right + box.width <= view.innerWidth - GAP ? right : Math.max(GAP, left);
    const y = Math.min(Math.max(GAP, row.top - 40), view.innerHeight - GAP - box.height);
    this.root.style.left = `${Math.round(x)}px`;
    this.root.style.top = `${Math.round(Math.max(GAP, y))}px`;
  }

  async #loadAccount() {
    const code = this.ticket.code;
    try {
      const [funds, pages] = await Promise.all([this.store?.funds?.(), this.paperHoldings?.refresh?.()]);
      if (this.ticket.code !== code) return;
      if (funds?.ok === false) throw new Error(funds.error || "讀取資金失敗");
      this.ticket.setFunds(funds?.capital || null);
      if (pages) this.ticket.setPositions(this.#positions(pages));
    } catch (error) {
      console.warn("[paper order popover: reading the funds and holdings] failed", error);
      this.#message(`讀取額度與庫存失敗：${error?.message || error}`, true);
    }
  }

  // 買進 / 賣出 each send once: a second press of that side while its order is out joins it. The popover is the one
  // writer of the side buttons' `disabled`, which says just that.
  #submit(side) {
    const flight = runSingleFlight(this.ticket.sideButton(side), () => this.#place(side));
    this.#syncSideButtons();
    void flight.finally(() => this.#syncSideButtons());
  }

  #syncSideButtons() {
    for (const side of ["buy", "sell"]) {
      const button = this.ticket?.sideButton(side);
      if (button) button.disabled = inFlight(button);
    }
  }

  async #place(side) {
    if (!this.store) { this.#message("這個畫面沒有模擬下單服務", true); return; }
    const d = this.ticket.describe(side);
    try {
      await this.store.place(this.ticket.order(side));
      this.#message(`已送出${d.word} ${d.qty} @${d.price}`);
      void this.#loadAccount();
    } catch (error) {
      console.warn("[paper order popover: 下單] refused", error);
      this.#message(String(error?.message || error), true);
    }
  }

  #message(text, isError = false) {
    const node = this.root.querySelector('[data-role="popover-message"]');
    node.textContent = text || "";
    node.classList.toggle("error", Boolean(isError));
  }

  destroy() {
    for (const fn of this.cleanup.splice(0)) {
      try { fn(); } catch (error) { console.warn("[paper order popover: cleanup] failed", error); }
    }
    this.ticket?.destroy();
    this.root?.remove();
    this.ticket = null; this.root = null;
  }
}
