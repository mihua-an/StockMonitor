import { escapeHtml } from "../utility.js";
import { userFacingMessage } from "../user_action.js";

/**
 * The code box in every product header (個股走勢 / 買賣報價 / 技術分析 / Futu / 歷史回放).
 *
 * The box shows the code the panel is displaying and doubles as its search: typing lists matching products
 * underneath (as the 商品新增 search does), ↑/↓ pick, Enter queries, Esc or leaving the box puts the displayed
 * code back. What a query does belongs to the page, so each header names a provider
 * (data-product-search="shioaji" | "futu" | "history") and the page registers it:
 *
 *   registerProductQuoteSearchProvider("shioaji", { suggest: async (text) => items, submit: async (item) => result })
 *
 * The header's code node stays the single place panels write the code into; the box mirrors it.
 */

const SUGGEST_DELAY_MS = 120;
const providers = new Map();
const observers = new WeakMap();
let delegated = false;

export function registerProductQuoteSearchProvider(name, provider) {
  providers.set(String(name), provider);
  return () => { if (providers.get(String(name)) === provider) providers.delete(String(name)); };
}

/** The box; `wide` is the variant that stands alone in a title row (模擬帳務's 委託): wider, its list opening leftwards.
 * `opensUp`: its list opens above it (a box at the bottom of a window). */
export function productQuoteSearchHtml(provider = "", { wide = false, opensUp = false, placeholder = "" } = {}) {
  if (!provider) return "";
  return `<div class="product-quote-search${wide ? " wide" : ""}${opensUp ? " product-quote-search-opens-up" : ""}" data-product-search="${escapeHtml(provider)}">`
    + `<input type="text" class="product-quote-code-input" data-role="product-search-input" autocomplete="off" spellcheck="false" aria-label="輸入代號查詢"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""}>`
    + `<div class="product-quote-search-results" data-role="product-search-results" hidden></div></div>`;
}

function codeNodeOf(header) {
  return header?.querySelector?.(".product-quote-code") || null;
}

function displayedCode(header) {
  const node = codeNodeOf(header);
  return String(node?.dataset?.code || node?.textContent || "").trim().replace(/^-+$/, "");
}

function syncInput(header) {
  const input = header?.querySelector?.(".product-quote-code-input");
  if (!input || header.ownerDocument?.activeElement === input) return;
  const code = displayedCode(header);
  if (input.value !== code) input.value = code;
}

/** Mirror the header's code into its box from now on. Idempotent; call after a header is (re)built. */
export function bindProductQuoteHeaders(root) {
  installDelegation(root?.ownerDocument || globalThis.document);
  const headers = root?.matches?.(".product-quote-header") ? [root] : [...(root?.querySelectorAll?.(".product-quote-header") || [])];
  for (const header of headers) {
    if (!header?.querySelector?.(".product-quote-search")) continue;
    const code = codeNodeOf(header);
    if (!code || observers.has(header) || typeof MutationObserver === "undefined") { syncInput(header); continue; }
    const observer = new MutationObserver(() => syncInput(header));
    observer.observe(code, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["data-code"] });
    observers.set(header, observer);
    syncInput(header);
  }
}

function resultsOf(input) { return input?.closest?.(".product-quote-search")?.querySelector?.('[data-role="product-search-results"]') || null; }

function hideResults(input) {
  const results = resultsOf(input);
  if (results) { results.hidden = true; results.replaceChildren(); }
}

function showMessage(input, message) {
  const results = resultsOf(input);
  if (!results) return;
  results.innerHTML = `<div class="product-quote-search-empty">${escapeHtml(message)}</div>`;
  results.hidden = false;
}

function renderResults(input, items) {
  const results = resultsOf(input);
  if (!results) return;
  if (!items.length) { showMessage(input, "找不到符合的商品"); return; }
  results.innerHTML = items.slice(0, 12).map((item, index) => `<button type="button" class="product-quote-search-result${index === 0 ? " active" : ""}"`
    + ` data-code="${escapeHtml(item.code)}" data-name="${escapeHtml(item.name || "")}" data-market="${escapeHtml(item.market || "")}">`
    + `<b>${escapeHtml(item.code)}</b><span>${escapeHtml(item.name || "")}</span>${item.note ? `<em>${escapeHtml(item.note)}</em>` : ""}</button>`).join("");
  results.hidden = false;
}

function providerOf(input) {
  return providers.get(String(input?.closest?.(".product-quote-search")?.dataset?.productSearch || "")) || null;
}

const timers = new WeakMap();
const sequences = new WeakMap();
const inflight = new WeakMap();

// Every keystroke supersedes the query before it AT ONCE: the sequence moves and the request in flight is aborted
// here, not when the debounce fires 120 ms later -- in that window the previous text's answer rendered for the new
// text.
function supersede(input) {
  const sequence = (sequences.get(input) || 0) + 1;
  sequences.set(input, sequence);
  inflight.get(input)?.abort();
  inflight.delete(input);
  return sequence;
}

function scheduleSuggest(input) {
  clearTimeout(timers.get(input));
  const sequence = supersede(input);
  const text = String(input.value || "").trim();
  if (!text) { hideResults(input); return; }
  timers.set(input, setTimeout(async () => {
    const provider = providerOf(input);
    if (!provider?.suggest || sequences.get(input) !== sequence) return;
    const controller = new AbortController();
    inflight.set(input, controller);
    try {
      const items = await provider.suggest(text, { signal: controller.signal });
      if (sequences.get(input) !== sequence || input.ownerDocument?.activeElement !== input) return;
      renderResults(input, Array.isArray(items) ? items : []);
    } catch (error) { console.warn("[searching products] failed", error);
      if (sequences.get(input) === sequence && !controller.signal.aborted) showMessage(input, "查詢失敗，請稍後再試");
    } finally {
      if (inflight.get(input) === controller) inflight.delete(input);
    }
  }, SUGGEST_DELAY_MS));
}

async function submit(input, item) {
  const provider = providerOf(input);
  const code = String(item?.code || "").trim().toUpperCase();
  if (!provider?.submit || !code) return;
  clearTimeout(timers.get(input));
  supersede(input);
  try {
    const result = await provider.submit({ ...item, code });
    if (result && result.ok === false) { showMessage(input, result.message || "無法查詢此商品"); return; }
    hideResults(input);
    input.blur();
  } catch (error) {
    const name = String(input?.closest?.(".product-quote-search")?.dataset?.productSearch || "");
    showMessage(input, userFacingMessage(error, "查詢失敗，請稍後再試", { context: `product search: submitting ${code} to ${name}` }));
  }
}

function moveActive(input, step) {
  const buttons = [...(resultsOf(input)?.querySelectorAll?.(".product-quote-search-result") || [])];
  if (!buttons.length) return;
  const current = buttons.findIndex((button) => button.classList.contains("active"));
  const next = (current + step + buttons.length) % buttons.length;
  buttons.forEach((button, index) => button.classList.toggle("active", index === next));
  // Scroll the list only: scrollIntoView would also scroll the (overflow:hidden) panel around it.
  const list = resultsOf(input), row = buttons[next];
  if (list && row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  else if (list && row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
}

function itemOf(button) {
  return { code: String(button?.dataset?.code || ""), name: String(button?.dataset?.name || ""), market: String(button?.dataset?.market || "") };
}

function installDelegation(doc) {
  if (delegated || !doc?.addEventListener) return;
  delegated = true;
  doc.addEventListener("focusin", (event) => {
    const input = event.target?.closest?.(".product-quote-code-input");
    if (input) { try { input.select(); } catch (error) { console.warn("[product search: selecting the code input] failed", error); } }
  });
  doc.addEventListener("input", (event) => {
    const input = event.target?.closest?.(".product-quote-code-input");
    if (input) scheduleSuggest(input);
  });
  doc.addEventListener("keydown", (event) => {
    const input = event.target?.closest?.(".product-quote-code-input");
    if (!input) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveActive(input, event.key === "ArrowDown" ? 1 : -1); return; }
    if (event.key === "Escape") { hideResults(input); input.blur(); return; }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const active = resultsOf(input)?.querySelector?.(".product-quote-search-result.active");
    void submit(input, active ? itemOf(active) : { code: input.value });
  });
  // mousedown, not click: the box would lose focus (and revert) before a click lands.
  doc.addEventListener("mousedown", (event) => {
    const button = event.target?.closest?.(".product-quote-search-result");
    if (!button) return;
    event.preventDefault();
    const input = button.closest(".product-quote-search")?.querySelector?.(".product-quote-code-input");
    if (input) void submit(input, itemOf(button));
  });
  doc.addEventListener("focusout", (event) => {
    const input = event.target?.closest?.(".product-quote-code-input");
    if (!input) return;
    // Leaving the box ends the query in flight too: only the debounce was cancelled, so an answer for the text
    // typed before leaving could still fill the list after the box was focused again.
    clearTimeout(timers.get(input));
    supersede(input);
    hideResults(input);
    const header = input.closest(".product-quote-header");
    setTimeout(() => syncInput(header), 0);
  });
}
