// 技術分析's detached window: one row with the code box, name, price and change; the timeframe buttons with the focused
// bar's date and 開高低收量; the candles; and the watch list as cards on the right, a click changing the window's product.
// The candles are technical_candles.js; the header, the code box and the cards the shared ones.
import { bindProductQuoteHeaders, registerProductQuoteSearchProvider } from "../../../core/components/product_quote_search.js";
import { formatQuoteChange, productQuoteHeaderShell, quoteMoveClass } from "../../../core/components/product_quote_header.js";
import { displayInstrumentName, onInstrumentNamesLearned, requestInstrumentNames } from "../../../core/instrument_names.js";
import { syncText } from "../../../core/utility.js";
import { replaceRealtimeWorkspace } from "../../../market_data/realtime.js";
import { overviewPage, setWatchPages } from "../product_pages.js";
import { suggestShioajiProducts } from "../product_search_api.js";
import { candleStageHtml, TechnicalCandles } from "../technical_candles.js";
import { TECHNICAL_TIMEFRAMES } from "../technical_series.js";
import { productQuoteFigures, renderProductCards } from "./product_cards.js";

const SEARCH_PROVIDER = "technical-window";
// 日、週、月 first, as a chart's own timeframe row reads.
const TIMEFRAME_BUTTONS = [...TECHNICAL_TIMEFRAMES.slice(6), ...TECHNICAL_TIMEFRAMES.slice(0, 6)];

function timeframeButtons(current) {
  return TIMEFRAME_BUTTONS.map(([key, label]) => `<button type="button" class="${key === current ? "is-active" : ""}" data-pick="${key}" aria-pressed="${key === current}">${label}</button>`).join("");
}

export class TechnicalWindowComponent {
  constructor() { this.cleanup = []; this.quoteViews = new Map(); this.items = []; this.dirty = new Set(); this.frame = 0; this.code = ""; }

  mount({ host, context }) {
    this.host = host; this.context = context; this.service = context?.services?.technicalAnalysis;
    host.innerHTML = `<div class="technical-window">
      <div class="technical-window-main">
        ${productQuoteHeaderShell({ className: "technical-window-header", search: SEARCH_PROVIDER })}
        <div class="technical-window-toolbar">
          <div class="technical-window-timeframes" data-role="ta-timeframe" role="group" aria-label="K 棒時間尺度"></div>
          <div class="technical-analysis-ohlcv" data-role="ta-ohlcv"></div>
        </div>
        <div class="technical-window-stage" data-role="ta-stage">${candleStageHtml()}</div>
      </div>
      <aside class="technical-window-list product-list" data-list-view="cards">
        <div data-role="product-list-cards" class="product-list-cards" role="listbox" aria-label="自選商品"></div>
      </aside>
    </div>`;
    const root = host.querySelector(".technical-window");
    this.root = root;
    const stage = root.querySelector('[data-role="ta-stage"]');
    this.candles = new TechnicalCandles({ root, stage, service: this.service, showDate: true, smaPeriods: [] });
    root.querySelector('[data-role="ta-timeframe"]').innerHTML = timeframeButtons(this.candles.timeframe);
    bindProductQuoteHeaders(root);
    this.cleanup.push(registerProductQuoteSearchProvider(SEARCH_PROVIDER, {
      suggest: (text, options) => suggestShioajiProducts(text, { ...options, listed: new Set(this.items.map((item) => item.code)) }),
      submit: async (item) => { this.select(item.code); return { ok: true }; },
    }));
    this.cleanup.push(this.service?.onKeyChange?.(() => this.#rebind()) || (() => {}));
    this.cleanup.push(onInstrumentNamesLearned?.(() => this.#drawAll()) || (() => {}));
    this.cleanup.push(() => this.#releaseViews());
    this.select(String(context?.symbolStore?.getSelectedSymbol?.() || "").trim().toUpperCase());
    void this.#loadList();
  }

  async #loadList() {
    try {
      const data = await this.service.watchPages();
      if (!this.host) return;
      setWatchPages(Array.isArray(data?.pages) ? data.pages : [], "");
      this.items = overviewPage().codes.map((code) => ({ code: String(code).toUpperCase(), name: overviewPage().items.find((item) => item.code === code)?.name || "" }));
      requestInstrumentNames("shioaji", this.items.map((item) => item.code));
    } catch (error) {
      console.warn("[technical window: reading the watch list] failed", error);
      this.items = [];
    }
    this.#rebind();
  }

  select(code) {
    this.code = String(code || "").toUpperCase();
    this.context?.symbolStore?.setSelectedSymbol?.(this.code);
    if (this.code) requestInstrumentNames("shioaji", [this.code]);
    document.title = this.code ? `技術分析 ${this.code}` : "技術分析";
    this.#rebind();
  }

  // The window's views: one summary per product of the list and the product on screen, and the transport's workspace.
  #rebind() {
    this.candles?.follow(this.code);
    const codes = [...new Set([...this.items.map((item) => item.code), this.code].filter(Boolean))];
    for (const [code, off] of this.quoteViews) if (!codes.includes(code)) { off?.(); this.quoteViews.delete(code); }
    for (const code of codes) {
      if (this.quoteViews.get(code)) continue;
      const off = this.service?.subscribeQuote?.(code, () => this.#mark(code));
      if (off) this.quoteViews.set(code, off);
    }
    replaceRealtimeWorkspace(codes);
    this.#drawAll();
  }

  #releaseViews() {
    for (const off of this.quoteViews.values()) off?.();
    this.quoteViews.clear();
  }

  #mark(code) {
    this.dirty.add(code);
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.#draw(this.dirty); this.dirty = new Set(); });
  }

  #row(item) {
    return { ...this.service?.quoteFields?.(item.code), code: item.code, name: this.#name(item.code, item.name), marketRead: this.service?.quoteRead?.(item.code) };
  }

  #name(code, candidate = "") { return displayInstrumentName("shioaji", code, candidate); }

  #drawAll() { this.#draw(null); }

  #draw(changed) {
    if (!this.root) return;
    if (!changed || changed.has(this.code)) this.#drawHeader();
    const rows = this.items.filter((item) => this.service?.quoteRead?.(item.code)).map((item) => this.#row(item));
    renderProductCards({ root: this.root, rows, selectedCode: this.code, emptyText: "尚無自選商品", changedCodes: changed,
      onSelect: (code) => this.select(code) });
  }

  #drawHeader() {
    const listed = this.items.find((item) => item.code === this.code);
    const figures = this.code ? productQuoteFigures(this.#row(listed || { code: this.code, name: "" })) : null;
    const header = this.root.querySelector(".product-quote-header");
    const set = (role, text) => { const node = header.querySelector(`[data-role="${role}"]`); syncText(node, text); return node; };
    set("product-name", this.code ? (figures?.name || this.code) : "--");
    set("product-code", this.code || "----");
    const tone = quoteMoveClass(figures?.change ?? null);
    const price = set("product-price", figures?.priceText ?? "--");
    const change = set("product-change", formatQuoteChange(figures?.change ?? null, figures?.changePct ?? null));
    for (const node of [price, change]) if (node) for (const name of ["price-up", "price-down", "price-flat"]) node.classList.toggle(name, name === tone);
  }

  update() {}
  resize() { this.candles?.resize(); }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const fn of this.cleanup.splice(0)) try { fn(); } catch (error) { console.warn("[technical window: cleanup] failed", error); }
    this.candles?.destroy(); this.candles = null;
    this.service?.dispose?.();
    this.root = null; this.host = null; this.context = null;
  }
}
