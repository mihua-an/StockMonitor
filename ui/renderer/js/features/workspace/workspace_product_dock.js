// The Workspace window's bottom row: the watch list as the App's product cards (a day candle, price and change), one row
// that the wheel moves a card at a time and that shows only whole cards; beside it the box that adds a product by code
// and the 盤中事件 switch. A card is clicked or dragged up to add it (workspace_view.js owns where a drop lands).
import { eventMarkerToggleHtml } from "../../core/components/trend_surface_shell.js";
import { syncEventMarkerToggle } from "../../core/components/trend_header_presenter.js";
import { bindProductQuoteHeaders, productQuoteSearchHtml, registerProductQuoteSearchProvider } from "../../core/components/product_quote_search.js";
import { setStockTrendEventMarkersVisible, stockTrendEventMarkersVisible, subscribeStockTrendEventMarkers } from "../../core/event_markers.js";
import { displayInstrumentName, onInstrumentNamesLearned, requestInstrumentNames } from "../../core/instrument_names.js";
import { canonicalMoomooCode, formatMoomooDisplaySymbol } from "../../market_data/moomoo_symbol.js";
import { renderProductCards } from "../realtime/components/product_cards.js";
import { instrumentOf, loadProductSides, productMonths, productSides, setProductChoice, sidePickerOf, productChoice, subscribeProductSides } from "../realtime/product_sides.js";
import { suggestShioajiProducts } from "../realtime/product_search_api.js";

const SEARCH_PROVIDER = "workspace-add";
const CARD_MIN_WIDTH = 170;
const FULL_MESSAGE = "已滿六檔，請拖到要覆蓋的那一欄";

function isFutuPage(page) {
  return page?.source === "futu" || String(page?.market || "tw").toLowerCase() === "us";
}

/** The watch pages as one list of products, each once: Taiwan's, then Futu's. */
export function dockProductsOf(pages = []) {
  const seen = new Set();
  const items = [];
  const list = Array.isArray(pages) ? pages : [];
  for (const futu of [false, true]) {
    for (const page of list.filter((candidate) => isFutuPage(candidate) === futu)) {
      const names = new Map((Array.isArray(page?.items) ? page.items : []).map((item) => [String(item?.code || "").toUpperCase(), String(item?.name || "")]));
      for (const raw of Array.isArray(page?.codes) ? page.codes : []) {
        const written = String(raw || "").trim().toUpperCase();
        const code = futu ? canonicalMoomooCode(written) : written;
        if (!code || seen.has(code)) continue;
        seen.add(code);
        items.push({ code, name: names.get(written) || names.get(code) || "", futu });
      }
    }
  }
  return items;
}

export class WorkspaceProductDock {
  constructor({ host, service, isAdded, isFull, onAdd, dragType, onDrag, onDemandChanged }) {
    Object.assign(this, { host, service, isAdded, isFull, onAdd, dragType, onDrag, onDemandChanged });
    this.items = [];
    this.quoteViews = new Map();
    this.dirty = new Set();
    this.frame = 0;
    this.addedKey = "";
  }

  mount() {
    this.host.innerHTML = `<div data-role="product-list-cards" class="workspace-dock-cards" role="listbox" aria-label="商品"></div>
      <div class="workspace-dock-tools">
        ${productQuoteSearchHtml(SEARCH_PROVIDER, { wide: true, opensUp: true, placeholder: "新增商品" })}
        <div class="trend-control-row">${eventMarkerToggleHtml(stockTrendEventMarkersVisible(), { label: "盤中事件", wide: true })}</div>
      </div>`;
    this.cards = this.host.querySelector(".workspace-dock-cards");
    this.searchBox = this.host.querySelector(".product-quote-code-input");
    bindProductQuoteHeaders(this.host);
    registerProductQuoteSearchProvider(SEARCH_PROVIDER, { suggest: (text, options) => this.#suggest(text, options), submit: (item) => this.#submit(item) });

    const eventSwitch = this.host.querySelector('[data-role="event-marker-toggle"]');
    eventSwitch.addEventListener("click", () => setStockTrendEventMarkersVisible(!stockTrendEventMarkersVisible()));
    subscribeStockTrendEventMarkers((visible) => syncEventMarkerToggle(this.host, visible, eventSwitch));

    this.cards.addEventListener("wheel", (event) => this.#wheel(event), { passive: false });
    this.cards.addEventListener("dragstart", (event) => this.#dragStart(event));
    this.cards.addEventListener("dragend", () => this.onDrag(""));
    new ResizeObserver(() => this.#fitCards()).observe(this.cards);

    subscribeProductSides(() => this.#rebind());
    onInstrumentNamesLearned(() => this.#draw(null));
    void this.#load();
  }

  async #load() {
    try {
      const [pages] = await Promise.all([this.service.watchPages(), loadProductSides()]);
      this.items = dockProductsOf(pages?.pages);
      requestInstrumentNames("shioaji", this.items.filter((item) => !item.futu).map((item) => item.code));
    } catch (error) {
      console.warn("[workspace dock: reading the watch list] failed", error);
      this.items = [];
    }
    this.#rebind();
  }

  // The instrument a card adds: a Futu code as it is, a Taiwan product the side and month its card shows.
  #instrument(item) {
    return item.futu ? item.code : instrumentOf(item.code);
  }

  #itemOf(code) {
    return this.items.find((item) => item.code === code) || null;
  }

  /** The Taiwan instruments the cards show: this window's subscription demand beside its columns. */
  demand() {
    return this.items.filter((item) => !item.futu).map((item) => this.#instrument(item));
  }

  /** The session moved (a new day, or 日盤 to 夜盤): every card's view is another one. */
  sessionChanged() {
    this.#releaseViews();
    this.#rebind();
  }

  /** The columns changed: which cards are grey. */
  markAddedChanged() {
    this.#draw(null);
  }

  #releaseViews() {
    for (const off of this.quoteViews.values()) off?.();
    this.quoteViews.clear();
  }

  #rebind() {
    const wanted = new Set(this.items.map((item) => this.#instrument(item)));
    for (const [code, off] of this.quoteViews) if (!wanted.has(code)) { off?.(); this.quoteViews.delete(code); }
    for (const code of wanted) {
      if (this.quoteViews.get(code)) continue;
      const off = this.service.subscribeQuote(code, () => this.#mark(code));
      if (off) this.quoteViews.set(code, off);
    }
    this.onDemandChanged();
    this.#draw(null);
  }

  #mark(instrument) {
    const item = this.items.find((candidate) => this.#instrument(candidate) === instrument);
    if (!item) return;
    this.dirty.add(item.code);
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; const changed = this.dirty; this.dirty = new Set(); this.#draw(changed); });
  }

  #row(item) {
    const instrument = this.#instrument(item);
    return {
      ...this.service.quoteFields(instrument), code: item.code, name: displayInstrumentName(item.futu ? "futu" : "shioaji", item.code, item.name),
      display_code: item.futu ? formatMoomooDisplaySymbol(item.code) : item.code,
      marketRead: this.service.quoteRead(instrument), side_picker: item.futu ? null : sidePickerOf(item.code),
    };
  }

  #draw(changed) {
    if (!this.cards) return;
    renderProductCards({ root: this.host, rows: this.items.map((item) => this.#row(item)), emptyText: "尚無自選商品", changedCodes: changed,
      draggableCards: true, dimmedCodes: new Set(this.items.filter((item) => this.isAdded(this.#instrument(item))).map((item) => item.code)),
      onSelect: (code) => this.#add(code), onPick: (code, pick) => this.#pick(code, pick) });
  }

  #add(code) {
    const item = this.#itemOf(code);
    if (!item || this.isFull() || this.isAdded(this.#instrument(item))) return;
    this.onAdd(this.#instrument(item));
  }

  // A card's 現／月份 picker: "spot", or "m<i>" -- the i-th listed month.
  #pick(code, pick) {
    const month = /^m(\d+)$/.exec(pick);
    setProductChoice(code, month ? "fut" : "spot", month ? Number(month[1]) : productChoice(code).month);
  }

  #dragStart(event) {
    const card = event.target.closest?.("[data-card-code]");
    const item = card && this.#itemOf(card.dataset.cardCode);
    if (!item) return;
    const instrument = this.#instrument(item);
    event.dataTransfer.setData(this.dragType, instrument);
    event.dataTransfer.effectAllowed = "copy";
    this.onDrag(instrument);
  }

  #wheel(event) {
    if (!event.deltaY) return;
    event.preventDefault();
    const step = this.cards.querySelector("[data-card-code]")?.getBoundingClientRect().width || 0;
    if (step) this.cards.scrollLeft = (Math.round(this.cards.scrollLeft / step) + Math.sign(event.deltaY)) * step;
  }

  // Whole cards only: as many as fit, the leftover width shared among them.
  #fitCards() {
    const width = this.cards.clientWidth;
    if (width > 0) this.cards.style.setProperty("--history-stock-item-width", `${width / Math.max(1, Math.floor(width / CARD_MIN_WIDTH))}px`);
  }

  async #suggest(text, options) {
    const query = String(text || "").trim().toUpperCase();
    if (query.includes(".")) return [{ code: query, name: "", note: "FUTU" }];
    const stocks = await suggestShioajiProducts(text, { ...options, listed: new Set(this.items.map((item) => item.code)) });
    return [...stocks, ...this.#futuresMatching(query)];
  }

  // The months of the listed products that have futures, by the product's code, name or futures category.
  #futuresMatching(query) {
    const found = [];
    for (const item of this.items) {
      if (item.futu) continue;
      const name = displayInstrumentName("shioaji", item.code, item.name);
      const fut = productSides(item.code).fut;
      if (!fut || !(item.code.includes(query) || name.includes(query) || fut.category.includes(query))) continue;
      for (const month of productMonths(item.code)) found.push({ code: `${fut.category}${month}`, name: `${name} ${month.slice(4)}月`, note: "期貨" });
    }
    return found;
  }

  async #submit(item) {
    if (this.isFull()) return { ok: false, message: FULL_MESSAGE };
    const result = this.onAdd(item.code);
    if (!result.ok) return { ok: false, message: result.error };
    this.searchBox.value = "";
    return { ok: true };
  }
}
