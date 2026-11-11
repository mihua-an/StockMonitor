// 模擬下單's ticket (docs/system-architecture/11 §3): 價格 and 數量 (each a − / ＋ stepper; 價格 can be 市價, 數量 張 or
// 零股), 買進 / 賣出, and what they come to. One piece for both places an order starts: 模擬帳務's 下單 panel and the
// popover beside a 買賣報價 (paper_order_popover.js). The holder supplies the stock's 買賣報價 view (setBook), the
// funds (setFunds: the fee rate, 今日額度剩餘) and the holdings (setPositions), and decides what 買進 / 賣出 do
// (onSide). Only 模擬, no 委託條件 to choose (user 10-27): a limit order is ROD, a market order IOC with the limit price
// it reserves, 漲停 for a buy and 跌停 for a sell. 漲停／跌停 are the book's official ones only; 升降單位 is the price
// policy's table (the funds' `price_policy`) of the code's instrument kind (the product catalog's).

import { stepPrice, tickTable } from "../../../market_data/tw_stock_rules.js";
import { lookupInstrumentKind } from "../../../market_data/instrument_kind.js";
import { buyCost, sellProceeds } from "../../../core/trade_costs.js";
import { MarketPriceColorPolicy } from "../../../core/market_color_policy.js";
import { numberOrNull as num } from "../../../core/numbers.js";
import { PAPER_LOT_SHARES as LOT, paperMoney as money } from "../../account/read_views.js";

const ODD_MAX = 999;

/** The ticket's markup, placed in its holder's element (that element is the ticket's root); `quota` adds 今日額度剩餘 beside 庫存 (the popover; 模擬帳務 has it on a card). */
export function orderTicketHtml({ quota = false } = {}) {
  const stepper = (what, input, labels) => `<div class="order-ticket-stepper">
      <button class="order-ticket-step" type="button" data-ticket-step="${what}:-1" aria-label="${labels[0]}">−</button>
      ${input}
      <button class="order-ticket-step" type="button" data-ticket-step="${what}:1" aria-label="${labels[1]}">＋</button>
    </div>`;
  return `<div class="order-ticket-fields">
      <div class="order-ticket-field">
        <div class="order-ticket-field-head"><span>價格</span><button class="order-ticket-link" type="button" data-ticket-action="market">市價</button></div>
        ${stepper("price", '<input class="order-ticket-input" data-ticket="price" inputmode="decimal" autocomplete="off" />', ["降一檔", "升一檔"])}
      </div>
      <div class="order-ticket-field">
        <div class="order-ticket-field-head"><span data-ticket="qty-label">張數</span><button class="order-ticket-link" type="button" data-ticket-action="lot">改零股</button></div>
        ${stepper("qty", '<input class="order-ticket-input" data-ticket="qty" inputmode="numeric" autocomplete="off" />', ["減", "加"])}
      </div>
    </div>
    <div class="order-ticket-sides">
      <button class="order-ticket-side buy" type="button" data-ticket-side="buy">買進</button><button class="order-ticket-side sell" type="button" data-ticket-side="sell">賣出</button>
    </div>
    <div class="order-ticket-facts"><span data-ticket="amount">--</span><span data-ticket="room">${quota ? "額度 -- · " : ""}庫存 --</span></div>`;
}

export class OrderTicket {
  /** `root` holds orderTicketHtml(); `onSide(side)` runs for 買進 / 賣出 once the ticket has nothing wrong with it,
   * `onProblem(text)` with what is wrong otherwise, `onChange()` after the user changes 價格 or 數量;
   * `instrumentKind(code)` resolves a code's kind (the product catalog's, by default). */
  constructor(root, { quota = false, onSide = () => {}, onProblem = () => {}, onChange = () => {}, instrumentKind = lookupInstrumentKind } = {}) {
    this.root = root;
    this.quota = quota;
    this.onSide = onSide; this.onProblem = onProblem; this.onChange = onChange;
    this.instrumentKind = instrumentKind;
    this.state = null; this.vm = null; this.funds = null; this.positions = []; this.kind = null;
    this.cleanup = [];
    const on = (node, type, fn) => { node.addEventListener(type, fn); this.cleanup.push(() => node.removeEventListener(type, fn)); };
    on(this.#node("price"), "input", () => { if (this.state) { this.state.market = false; this.state.price = this.#typed("price"); this.#changed(); } });
    on(this.#node("qty"), "input", () => { if (this.state) { this.state.qty = this.#typed("qty"); this.#changed(); } });
  }

  #node(name) { return this.root.querySelector(`[data-ticket="${name}"]`); }

  #typed(name) {
    const text = String(this.#node(name).value).replace(/,/g, "").trim();
    return text === "" ? NaN : Number(text);
  }

  #changed() {
    this.render();
    this.onChange();
  }

  /** A new ticket for `code`; `price` is where it starts (a 買賣報價 price clicked), else the last price once known. */
  open({ code, name = "", price = null }) {
    this.state = { code: String(code || "").trim().toUpperCase(), name: String(name || ""), price: num(price) > 0 ? num(price) : null,
      market: false, lot: "whole", qty: 1 };
    this.vm = null;
    this.kind = null;
    const opened = this.state.code;
    Promise.resolve(this.instrumentKind(opened)).then((kind) => {
      if (this.state?.code !== opened) return;
      this.kind = kind || null;
      this.render();
    }, (error) => console.warn(`[order ticket: looking up the instrument kind of ${opened}] failed`, error));
    this.render();
  }

  close() { this.state = null; this.vm = null; this.kind = null; }

  get code() { return this.state?.code || ""; }

  get name() { return this.state?.name || String(this.vm?.displayName || ""); }

  /** The stock's 買賣報價 view (orderBookReadView): 漲跌停, 昨收 and the last price. */
  setBook(vm) {
    if (!this.state) return;
    this.vm = vm;
    // 價格 starts at the last price as soon as a book carries one (the first may not); a price the user set stays.
    if (this.state.price === null && Number(vm?.lastPrice) > 0) this.state.price = Number(vm.lastPrice);
    this.render();
  }

  setFunds(funds) { this.funds = funds || null; this.render(); }

  setPositions(positions) { this.positions = Array.isArray(positions) ? positions : []; this.render(); }

  /** Set 價格 (a 買賣報價 price picked while the ticket is open). */
  setPrice(price) {
    if (!this.state || !(Number(price) > 0)) return;
    this.state.market = false;
    this.state.price = Number(price);
    this.#changed();
  }

  /** The day's official 漲停 / 跌停 from the book, or null while the provider has published none. */
  limits() {
    const up = num(this.vm?.limitUp), down = num(this.vm?.limitDown);
    return up > 0 && down > 0 ? { up, down } : null;
  }

  shares() { return this.state.lot === "odd" ? Number(this.state.qty) : Number(this.state.qty) * LOT; }

  /** What is wrong with the ticket as it stands, or "". The desk checks it again (升降單位, 時段, 額度, 庫存). */
  problem() {
    const t = this.state;
    if (!t) return "沒有下單的商品";
    const qty = Number(t.qty);
    if (!Number.isInteger(qty) || qty < 1) return "數量要是正整數";
    if (t.lot === "odd" && qty > ODD_MAX) return `零股是 1～${ODD_MAX} 股`;
    const limits = this.limits();
    if (t.market) return limits ? "" : "還沒有這檔的漲跌停價";
    if (!(t.price > 0)) return "請輸入價格";
    if (limits && (t.price > limits.up || t.price < limits.down)) return `價格要在跌停 ${money(limits.down)}～漲停 ${money(limits.up)} 之間`;
    return "";
  }

  /** 預估金額: a buy with its fee, a sell net of fee and tax; a market order at the last price. */
  estimate(side) {
    const t = this.state;
    const price = t?.market ? Number(this.vm?.lastPrice) : Number(t?.price);
    if (!t || !(price > 0) || this.problem()) return null;
    // The paper ledger's terms for a trade of the code's kind (AccountingCore.closing_terms); none yet: no estimate.
    const terms = this.kind ? this.funds?.trade_terms?.[this.kind] || null : null;
    const amount = side === "buy" ? buyCost(terms, this.shares(), price) : sellProceeds(terms, this.shares(), price);
    return amount === null ? null : Math.round(amount);
  }

  /** The order 確認 sends to the desk (POST /api/paper-wallet/orders). */
  order(side) {
    const t = this.state;
    const limits = this.limits();
    return { code: t.code, side: side === "buy" ? "買進" : "賣出", qty: this.shares(), price_type: t.market ? "market" : "limit", tif: t.market ? "IOC" : "ROD",
      ...(t.market ? { reserve_price: side === "buy" ? limits.up : limits.down } : { price: t.price }) };
  }

  /** The order in words: 委託, 價格 (with its colour against 昨收), 預估金額. */
  describe(side) {
    const t = this.state;
    const ref = num(this.vm?.prevClose);
    const amount = this.estimate(side);
    return {
      word: side === "buy" ? "買進" : "賣出",
      stock: `${t.code}${this.name && this.name !== t.code ? ` ${this.name}` : ""}`,
      qty: `${money(t.qty)} ${t.lot === "odd" ? "股" : "張"}`,
      price: t.market ? "市價" : money(t.price),
      priceClass: t.market ? "" : MarketPriceColorPolicy.cssClass(t.price, ref),
      amount: amount === null ? "--" : `≈ ${money(amount)}`,
    };
  }

  sideButton(side) { return this.root.querySelector(`[data-ticket-side="${side}"]`); }

  /** The ticket's clicks; true when the click was its own. */
  handleClick(event) {
    const t = this.state;
    if (!t || !this.root.contains(event.target)) return false;
    const action = event.target.closest("[data-ticket-action]")?.dataset.ticketAction;
    if (action === "market") { t.market = !t.market; this.#changed(); return true; }
    if (action === "lot") { t.lot = t.lot === "whole" ? "odd" : "whole"; this.#changed(); return true; }
    const step = event.target.closest("[data-ticket-step]");
    if (step) {
      if (step.disabled) return true;
      const [what, by] = step.dataset.ticketStep.split(":");
      if (what === "qty") t.qty = Math.min(t.lot === "odd" ? ODD_MAX : Infinity, Math.max(1, Math.round(Number(t.qty) || 0) + Number(by)));
      else this.#stepPrice(Number(by));
      this.#changed();
      return true;
    }
    const side = event.target.closest("[data-ticket-side]")?.dataset.ticketSide;
    if (side) {
      const problem = this.problem();
      if (problem) this.onProblem(problem);
      else this.onSide(side);
      return true;
    }
    return false;
  }

  #stepPrice(direction) {
    const t = this.state;
    const base = t.price > 0 ? t.price : Number(this.vm?.lastPrice) || 0;
    if (!(base > 0)) return;
    const limits = this.limits();
    let next = stepPrice(base, direction, tickTable(this.funds?.price_policy, this.kind));
    if (limits) next = Math.min(limits.up, Math.max(limits.down, next));
    t.market = false;
    t.price = next;
  }

  render() {
    const t = this.state;
    if (!t) return;
    const set = (name, text) => { const node = this.#node(name); if (node.textContent !== text) node.textContent = text; };
    const focused = this.root.ownerDocument.activeElement;
    const price = this.#node("price"), qty = this.#node("qty");
    const priceText = t.market ? "市價" : t.price > 0 ? String(t.price) : "";
    if (focused !== price && price.value !== priceText) price.value = priceText;
    price.readOnly = t.market;
    const qtyText = Number.isFinite(t.qty) ? String(t.qty) : "";
    if (focused !== qty && qty.value !== qtyText) qty.value = qtyText;
    // 價格's digits against 昨收: above red, below green, equal white (as 改價).
    const ref = num(this.vm?.prevClose);
    const tone = t.market || !(ref > 0) || !(t.price > 0) ? "" : t.price > ref ? "up" : t.price < ref ? "down" : "flat";
    const priceClass = `order-ticket-input ${tone}`.trim();
    if (price.className !== priceClass) price.className = priceClass;
    set("qty-label", t.lot === "odd" ? "股數" : "張數");
    this.root.querySelector('[data-ticket-action="market"]').classList.toggle("active", t.market);
    const lot = this.root.querySelector('[data-ticket-action="lot"]');
    const lotText = t.lot === "odd" ? "改整股" : "改零股";
    if (lot.textContent !== lotText) lot.textContent = lotText;
    const buy = this.estimate("buy"), sell = this.estimate("sell");
    set("amount", buy === null ? "--" : `買 ≈ ${money(buy)}　賣 ≈ ${money(sell)}`);
    const held = this.positions.find((p) => String(p.code).toUpperCase() === t.code);
    const room = this.funds?.remaining_with_orders;
    set("room", `${this.quota ? `額度 ${room == null ? "--" : money(room)} · ` : ""}庫存 ${held ? money(held.position_qty) : 0} 股`);
    const limits = this.limits();
    this.root.querySelector('[data-ticket-step="price:-1"]').disabled = !t.market && limits !== null && t.price <= limits.down;
    this.root.querySelector('[data-ticket-step="price:1"]').disabled = !t.market && limits !== null && t.price >= limits.up;
    this.root.querySelector('[data-ticket-step="qty:-1"]').disabled = !(Number(t.qty) > 1);
    this.root.querySelector('[data-ticket-step="qty:1"]').disabled = t.lot === "odd" && Number(t.qty) >= ODD_MAX;
  }

  destroy() {
    for (const fn of this.cleanup.splice(0)) fn();
    this.state = null; this.vm = null; this.root = null;
  }
}
