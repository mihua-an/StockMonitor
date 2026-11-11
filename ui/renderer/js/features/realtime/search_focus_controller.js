import { LatestIntentGate } from "../../market_data/latest_intent_gate.js";
import { beginSelection, selectionMark } from "../../core/selection_latency_trace.js";

// SEARCH_FOCUS selection: a product picked in a header's code box (product_quote_search.js, realtime.js) that is not
// in a watch page. Selection is entirely local (renderer state + the Rust live view the page subscribes); there is no
// request to wait for or cancel. The newest intent wins: onIntent switches the page at once, and onSelect runs only
// when no newer pick arrived while onIntent was running. The code box owns its own input and messages -- this
// controller has no DOM.

// The client subscription ID spans component remounts; its generations must too.
let lastSelectionGeneration = 0;

export class SearchFocusController {
  constructor({ onIntent = null, onSelect = null, onClear = null } = {}) {
    this.onIntent = onIntent;
    this.onSelect = onSelect;
    this.onClear = onClear;
    this.activeCode = "";
    this.activeItem = null;
    this.intentGate = new LatestIntentGate();
    this.destroyed = false;
  }

  syncActiveSymbol(code = "", item = null) {
    this.activeCode = String(code || "").trim().toUpperCase();
    if (item) this.activeItem = item;
  }

  #nextGeneration(code = this.activeCode) {
    this.intentGate.generation = Math.max(this.intentGate.generation, lastSelectionGeneration);
    const issued = this.intentGate.issue(code);
    lastSelectionGeneration = issued.generation;
    return issued.generation;
  }

  /** Picks `item`. Answers { ok, code, generation }, with stale: true when a newer pick superseded it. */
  async select(item) {
    if (this.destroyed) return null;
    const code = String(item?.code || "").trim().toUpperCase();
    if (!code) return null;
    const selection = beginSelection(code, this.activeCode);
    const generation = this.#nextGeneration(code);

    // The user's intent applies immediately.
    this.activeCode = code;
    this.activeItem = item;
    selectionMark(code, "search_focus_started", selection);
    if (typeof this.onIntent === "function") await this.onIntent(item, { generation });
    if (this.destroyed || !this.intentGate.acceptOrStale(generation, code)) return { ok: false, code, generation, stale: true };

    if (typeof this.onSelect === "function") await this.onSelect(item, { generation });
    selectionMark(code, "search_focus_completed", selection);
    return { ok: true, code, generation };
  }

  async clear({ notify = true } = {}) {
    const generation = this.#nextGeneration("");
    if (this.destroyed || !this.intentGate.isCurrent(generation, "")) return { ok: false, code: "", generation, stale: true };
    this.activeCode = "";
    this.activeItem = null;
    if (notify && typeof this.onClear === "function") await this.onClear();
    return { ok: true, code: "", generation };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.#nextGeneration(this.activeCode);
  }
}
