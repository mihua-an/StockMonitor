import { escapeHtml } from "../utility.js";
import { signedValueClass } from "../market_color_policy.js";
import { viewLifecycleState } from "../view_lifecycle.js";
import { bindProductQuoteHeaders, productQuoteSearchHtml } from "./product_quote_search.js";

/**
 * Shared product header, ONE row: [code box] 股名 ... 價格 漲跌 (漲跌幅), as tall as the 成交明細 column
 * header. `search` names the code box's query provider (product_quote_search.js); without it the row shows
 * 股名 and the code as text (加權 / 期貨). The code node is kept either way: it is what panels write the code
 * into, and the box mirrors it.
 */
export function productQuoteHeaderShell({
  className = "", primary = "--", secondary = "----",
  primaryRole = "product-name", secondaryRole = "product-code",
  centerRole = "product-center", priceRole = "product-price",
  changeRole = "product-change", search = "",
} = {}) {
  const classes = ["product-quote-header", className].filter(Boolean).join(" ");
  return `<div class="${escapeHtml(classes)}" data-searchable="${search ? "true" : "false"}">
    <div class="product-quote-identity">
      ${productQuoteSearchHtml(search)}
      <div data-role="${escapeHtml(primaryRole)}" class="product-quote-name">${escapeHtml(primary)}</div>
      <div data-role="${escapeHtml(secondaryRole)}" class="product-quote-code">${escapeHtml(secondary)}</div>
    </div>
    <div data-role="${escapeHtml(centerRole)}" class="product-quote-center" hidden></div>
    <div class="product-quote-price-box">
      <div data-role="${escapeHtml(priceRole)}" class="quote-main-price product-quote-price price-flat">--</div>
      <div data-role="${escapeHtml(changeRole)}" class="quote-change product-quote-change price-flat">--</div>
    </div>
  </div>`;
}

/**
 * The header's 漲跌 cell: "漲跌 漲跌幅" (+0.58 +1.45%), "--" without a reference. Every product header and the replay
 * cards write it the same way; a change that rounds to zero is "0.00", never "-0.00".
 */
export function formatQuoteChange(diff, pct) {
  if (diff === null || diff === undefined || pct === null || pct === undefined) return "--";
  // The direction is the colour alone (user 11-09): no sign.
  const size = (value) => {
    const rounded = roundedChange(value);
    return Number.isFinite(rounded) ? Math.abs(rounded).toFixed(2) : "--";
  };
  return `${size(diff)}(${size(pct)}%)`;
}

/** A change rounded to the 2 decimals it is shown with; -0 becomes 0. */
export function roundedChange(value) {
  return Math.round(Number(value) * 100) / 100 || 0;
}

/**
 * The header's price / 漲跌 colour: the sign of Market Runtime's change as displayed (2 decimals), so a raw float
 * remainder such as -1e-12 is flat; no change yet is flat. Never derived from a price and a reference.
 */
export function quoteMoveClass(change) {
  const shown = change === null || change === undefined ? 0 : roundedChange(change);
  return signedValueClass(shown);
}

/**
 * Give an existing header (a static page surface, or one built before the box existed) its code box, then mirror
 * the displayed code into it. `provider` "" removes nothing: the row just shows the code as text.
 */
export function ensureProductQuoteSearch(header, provider = "") {
  if (!header?.querySelector) return;
  if (provider && !header.querySelector(".product-quote-search")) {
    header.querySelector(".product-quote-identity")?.insertAdjacentHTML?.("afterbegin", productQuoteSearchHtml(provider));
  }
  const box = header.querySelector(".product-quote-search");
  if (box?.dataset && provider) box.dataset.productSearch = provider;
  if (header.dataset) header.dataset.searchable = box && provider ? "true" : "false";
  bindProductQuoteHeaders(header);
}

/** Show or hide a header's code box (a trend surface switching between 個股 and 加權 / 期貨). */
export function setProductQuoteSearchable(header, searchable) {
  if (!header?.querySelector?.(".product-quote-search") || !header.dataset) return;
  header.dataset.searchable = searchable ? "true" : "false";
}

// Called on every order book / trend update, mostly with nothing to change: each property is written only when it
// differs, and the content only when what it shows changed.
export function setProductQuoteCenter(element, { html = "", text = "", active = false, className = "" } = {}) {
  if (!element) return;
  const header = element._quoteHeader ??= element.closest?.(".product-quote-header") || null;
  const centerActive = active ? "true" : "false";
  if (header && header.dataset.centerActive !== centerActive) header.dataset.centerActive = centerActive;
  if (element.hidden !== !active) element.hidden = !active;
  const classes = ["product-quote-center", className].filter(Boolean).join(" ");
  if (element.className !== classes) element.className = classes;
  const content = !active ? "" : html ? `html:${html}` : `text:${String(text || "")}`;
  if (element._centerContent === content) return;
  element._centerContent = content;
  if (!active) { element.replaceChildren(); return; }
  if (html) element.innerHTML = html;
  else element.textContent = String(text || "");
}

/** Keep transient lifecycle copy out of the quote row; only a hard load error
 * occupies its reserved centre cell. Returns true while the error owns it. */
export function syncProductQuoteFailure(element, vm = {}) {
  const failed = viewLifecycleState(vm) === "error";
  if (!failed) {
    setProductQuoteCenter(element);
    return false;
  }
  setProductQuoteCenter(element, {
    active: true,
    text: "載入失敗",
    className: "product-quote-status-error",
  });
  return true;
}
