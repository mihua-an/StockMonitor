// 交易編輯 form: the one add / edit trade form, shared by the 帳務 page's modal (features/account/trade_editor.js) and
// the standalone trade window (trade_window.js). A host injects only its id prefix, its variant ("modal" | "window")
// and an adapter -- what the form's data is read from and what saving / deleting / closing does. The markup, the
// fill rows (成交 股數@價格), the time rule, validation, Enter navigation and the submit lock are this module's.
// Styles: the account-trade-* rules (pages/account.css) and the trade-window-* variant rules (windows/trade.css).
import { escapeHtml } from "../../core/utility.js";
import { formatTradeInfo, parseTradeFill, parseTradeInfo } from "./trade_info.js";

const EMPTY_FILL = Object.freeze({ qty: "", price: "" });

/** 成交 rows from a stored trade_info ("1000@52.3_500@52.4"), as the strings they were stored with (valid or not). */
export function tradeInfoToFillRows(text) {
  return parseTradeInfo(text).fills
    .map((fill) => ({ qty: fill.qtyText, price: fill.priceText }))
    .filter((fill) => fill.qty || fill.price);
}

/** HH:MM out of four digits, H:MM, or a stored HH:MM:SS (the form keeps minutes); "" stays "". */
export function normalizeTradeTimeText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const colonMatch = /^(\d{1,2}):(\d{2})/.exec(text);
  const digits = colonMatch ? `${String(colonMatch[1]).padStart(2, "0")}${colonMatch[2]}` : text.replace(/\D/g, "");
  if (digits.length !== 4) throw new Error("交易時間請輸入 4 個數字，例如 2211");
  const hour = Number(digits.slice(0, 2)), minute = Number(digits.slice(2, 4));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error("交易時間不是有效時間，例如最晚為 23:59");
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

/** A YYYY-MM-DD that is a real date. */
export function normalizeTradeDateText(value) {
  const text = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error("交易日期格式必須是 YYYY-MM-DD，例如 2026-08-07");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error("交易日期不是有效日期");
  return text;
}

// A market's own calendar date: a US trade entered at 02:00 Saturday Taipei time happened on Friday in New York.
const MARKET_DATE_FORMATS = {
  台股: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }),
  美股: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }),
};

/** Today's date (YYYY-MM-DD) in `market`'s time zone. */
export function marketDateText(market, now = new Date()) {
  const format = MARKET_DATE_FORMATS[market] || MARKET_DATE_FORMATS["台股"];
  const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The form's markup for `variant`; every id starts with `idPrefix`. */
export function tradeEditorMarkup({ idPrefix, variant = "modal" }) {
  const id = (name) => `${idPrefix}${name}`;
  const windowed = variant === "window";
  const header = windowed ? "" : `<div class="account-trade-modal-header">
        <div><h3 id="${id("EditorTitle")}">新增交易</h3></div>
        <button id="${id("CloseBtn")}" class="account-trade-modal-close" type="button" aria-label="關閉">×</button>
      </div>`;
  const dialogAttrs = windowed
    ? 'class="account-trade-modal-dialog trade-window-dialog"'
    : `class="account-trade-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="${id("EditorTitle")}"`;
  const backdrop = windowed ? "" : '<div class="account-trade-modal-backdrop" data-trade-editor-close></div>';
  return `${backdrop}<section ${dialogAttrs}>
      ${header}
      <div class="account-trade-modal-body${windowed ? " trade-window-content" : ""}">
        <input id="${id("Id")}" type="hidden" />
        <div class="finance-form-grid account-trade-form-grid${windowed ? " trade-window-form-grid" : ""}">
          <label class="finance-field"><span>交易日期</span><input id="${id("Date")}" class="search" type="date" /></label>
          <label class="finance-field"><span>市場</span><select id="${id("Market")}" class="search"><option value="台股">台股</option><option value="美股">美股</option></select></label>
          <label class="finance-field"><span>交易類型</span><select id="${id("Action")}" class="search"><option value="買進">買進</option><option value="賣出">賣出</option></select></label>
          <label class="finance-field"><span>股號</span><input id="${id("Code")}" class="search" type="text" placeholder="例如 2337 / NVDA" autocomplete="off" /></label>
        </div>

        <div class="account-trade-fills-section${windowed ? " trade-window-fills-section" : ""}">
          <div class="account-trade-fills-heading">
            <span id="${id("QtyHeading")}">買進股數</span>
            <span>價格</span>
            <button id="${id("AddFillBtn")}" class="account-trade-add-fill-btn" type="button" aria-label="新增成交價">＋</button>
          </div>
          <div id="${id("FillRows")}" class="account-trade-fill-rows"></div>
        </div>

        <label class="finance-field account-trade-time-field"><span>交易時間（台灣時間）</span><input id="${id("Time")}" class="search" type="text" inputmode="numeric" maxlength="5" placeholder="HHMM" autocomplete="off" /></label>
        ${windowed ? `<div id="${id("Message")}" class="trade-window-global-message muted trade-window-message"></div>` : ""}
      </div>

      <div class="account-trade-modal-footer${windowed ? " trade-window-footer" : ""}">
        <button id="${id("DeleteBtn")}" class="btn danger" type="button" hidden>刪除</button>
        <div class="account-trade-modal-footer-right">
          <button id="${id("ResetBtn")}" class="btn secondary" type="button">清空</button>
          <button id="${id("CancelBtn")}" class="btn secondary" type="button">${windowed ? "關閉" : "取消"}</button>
          <button id="${id("SubmitBtn")}" class="btn primary account-trade-submit-btn" type="button">送出</button>
        </div>
      </div>
    </section>`;
}

function fillRowMarkup(fill, index) {
  return `<div class="account-trade-fill-row" data-trade-fill-row="${index}">
      <input class="search" data-trade-fill-qty type="number" min="0" step="1" inputmode="decimal" value="${escapeHtml(fill.qty ?? "")}" placeholder="股數" />
      <input class="search" data-trade-fill-price type="number" min="0" step="0.0001" inputmode="decimal" value="${escapeHtml(fill.price ?? "")}" placeholder="價格" />
      ${index > 0 ? '<button class="account-trade-remove-fill-btn" type="button" data-trade-remove-fill aria-label="移除這筆成交">×</button>' : '<span class="account-trade-fill-row-spacer"></span>'}
    </div>`;
}

/**
 * The form, mounted into `host`. The adapter:
 *   defaultMarket()           the market a new trade starts with
 *   markets()                 optional: the markets the ledger trades (default 台股 and 美股)
 *   knownName(code)           a name for the code, "" when none is known
 *   onTitle({ mode, code, name, action })  the host shows its title (the modal's header, the window's title)
 *   submit(body, { mode })    saves; throws on failure
 *   remove(tradeId)           deletes; throws on failure; resolves false when the user declined
 *   close()                   the host closes the form
 *   reportError(error, kind)  shows a failure ("save" | "delete")
 *   beforeSubmit()            optional: false (or a promise of false) stops the submit (an earlier uncertain submission)
 *   layoutChanged()           optional: the form's size may have changed
 * Every element is found under `host` (never the global document), so instances are isolated; the frame scheduler is
 * injectable (`requestFrame`), and dispose() removes every listener the form bound.
 */
export class TradeEditor {
  constructor({ host, idPrefix, variant = "modal", adapter, requestFrame = (fn) => globalThis.requestAnimationFrame(fn) }) {
    this.idPrefix = idPrefix;
    this.requestFrame = requestFrame;
    this.listeners = new AbortController();
    this.elements = new Map();
    this.variant = variant;
    this.adapter = adapter;
    this.mode = "add";
    this.trade = null;
    this.knownName = "";
    this.submitInFlight = false;
    this.addAction = "";
    this.host = host;
    host.innerHTML = tradeEditorMarkup({ idPrefix, variant });
    this.#bind();
    this.renderFillRows([EMPTY_FILL]);
  }

  /** One of the form's fixed elements (built once with the markup), found under the host and kept. */
  el(name) {
    if (!this.elements.has(name)) this.elements.set(name, this.host.querySelector(`[id="${this.idPrefix}${name}"]`));
    return this.elements.get(name);
  }

  /** Removes every listener the form bound (its markup stays until the host is cleared). */
  dispose() {
    this.listeners.abort();
    this.elements.clear();
  }

  #on(element, type, handler) {
    element?.addEventListener(type, handler, { signal: this.listeners.signal });
  }

  /** The form's message line (the window variant has one), "" clears it. */
  setMessage(text = "", isError = false) {
    const node = this.el("Message");
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("error", Boolean(text) && isError);
    node.classList.toggle("success", Boolean(text) && !isError);
    this.adapter.layoutChanged?.();
  }

  // ---- fill rows

  fillRows() { return [...(this.el("FillRows")?.querySelectorAll(".account-trade-fill-row") ?? [])]; }

  #qtyInputs() { return [...(this.el("FillRows")?.querySelectorAll("[data-trade-fill-qty]") ?? [])]; }

  #fillValues() {
    return this.fillRows().map((row) => ({
      qty: row.querySelector("[data-trade-fill-qty]")?.value || "",
      price: row.querySelector("[data-trade-fill-price]")?.value || "",
    }));
  }

  /** Every complete fill; with allowIncomplete, rows missing a value are skipped, else one makes it null. */
  collectFills({ allowIncomplete = false } = {}) {
    const fills = [];
    for (const row of this.fillRows()) {
      const fill = parseTradeFill(row.querySelector("[data-trade-fill-qty]")?.value, row.querySelector("[data-trade-fill-price]")?.value);
      if (!fill.qtyText && !fill.priceText && allowIncomplete) continue;
      if (fill.errors.length) {
        if (allowIncomplete) continue;
        return null;
      }
      fills.push({ qty: fill.qty, price: fill.price, qtyText: fill.qtyText, priceText: fill.priceText });
    }
    return fills.length ? fills : (allowIncomplete ? [] : null);
  }

  renderFillRows(fills) {
    const box = this.el("FillRows");
    if (!box) return;
    const list = Array.isArray(fills) && fills.length ? fills : [EMPTY_FILL];
    box.innerHTML = list.map(fillRowMarkup).join("");
    box.querySelectorAll("input").forEach((input) => this.#on(input, "input", () => this.syncTimeAvailability()));
    box.querySelectorAll(".account-trade-fill-row").forEach((row) => this.#bindFillEnter(row));
    box.querySelectorAll("[data-trade-remove-fill]").forEach((button) => this.#on(button, "click", () => {
      const rows = this.#fillValues();
      const index = Number(button.closest(".account-trade-fill-row")?.dataset.tradeFillRow ?? -1);
      if (index >= 0) rows.splice(index, 1);
      this.renderFillRows(rows);
    }));
    this.#syncFillSteps();
    this.syncTimeAvailability();
    this.adapter.layoutChanged?.();
  }

  addFillRow() {
    this.renderFillRows([...this.#fillValues(), EMPTY_FILL]);
    this.#focus(this.#qtyInputs().at(-1));
  }

  // ---- derived state

  #syncFillSteps() {
    const step = this.el("Market")?.value === "台股" ? "1" : "0.0001";
    this.#qtyInputs().forEach((input) => { input.step = step; });
  }

  // 交易時間: a US trade keeps the Taiwan time the user typed; a Taiwan trade has one only for whole lots (>= 1000 股).
  syncTimeAvailability() {
    const time = this.el("Time");
    if (!time) return;
    const market = this.el("Market")?.value || "台股";
    const totalQty = (this.collectFills({ allowIncomplete: true }) || []).reduce((sum, fill) => sum + Number(fill.qty || 0), 0);
    const enabled = market === "美股" || (market === "台股" && totalQty >= 1000);
    time.disabled = !enabled;
    time.classList.toggle("disabled", !enabled);
    if (!enabled) time.value = "";
  }

  #syncQtyHeading() {
    const heading = this.el("QtyHeading");
    if (heading) heading.textContent = this.el("Action")?.value === "賣出" ? "賣出股數" : "買進股數";
  }

  syncTitle() {
    const code = this.el("Code")?.value?.trim().toUpperCase() || "";
    const name = this.knownName || (code ? this.adapter.knownName?.(code) || "" : "");
    this.adapter.onTitle?.({ mode: this.mode, code, name, action: this.el("Action")?.value || "買進" });
  }

  #formatTimeInput() {
    const input = this.el("Time");
    if (!input) return;
    const digits = String(input.value || "").replace(/\D/g, "").slice(0, 4);
    input.value = digits.length === 4 ? `${digits.slice(0, 2)}:${digits.slice(2, 4)}` : digits;
  }

  // ---- modes

  /** A new trade. preserveDateMarket keeps the date and market just used (the next trade of a batch). */
  reset({ preserveDateMarket = false, action = "" } = {}) {
    this.addAction = action;
    const oldDate = this.el("Date")?.value || "";
    const oldMarket = this.el("Market")?.value || "";
    this.mode = "add";
    this.trade = null;
    this.knownName = "";
    this.el("Id").value = "";
    // The markets the ledger trades (the paper ledger is 台股 only), then the market, then that market's date.
    const markets = this.adapter.markets?.() || ["台股", "美股"];
    for (const option of Array.from(this.el("Market")?.options ?? [])) option.hidden = option.disabled = !markets.includes(option.value);
    this.el("Market").value = preserveDateMarket && oldMarket ? oldMarket : this.adapter.defaultMarket();
    this.el("Date").value = preserveDateMarket && oldDate ? oldDate : marketDateText(this.el("Market").value);
    this.el("Action").value = action === "賣出" ? "賣出" : "買進";
    this.el("Code").value = "";
    this.el("Time").value = "";
    this.el("DeleteBtn").hidden = true;
    this.el("SubmitBtn").textContent = "送出";
    this.renderFillRows([EMPTY_FILL]);
    this.#syncQtyHeading();
    this.syncTitle();
    this.setMessage("");
  }

  /** An existing trade, for editing. */
  load(trade = {}) {
    this.mode = "edit";
    this.trade = trade;
    this.knownName = String(trade.name || "");
    this.el("Id").value = trade.trade_id || "";
    this.el("Date").value = trade.date || "";
    this.el("Market").value = trade.market === "美股" ? "美股" : "台股";
    this.el("Action").value = trade.action === "賣出" ? "賣出" : "買進";
    this.el("Code").value = trade.code || "";
    this.el("DeleteBtn").hidden = false;
    this.el("SubmitBtn").textContent = "儲存";
    const fills = Array.isArray(trade.fills) && trade.fills.length ? trade.fills : tradeInfoToFillRows(trade.trade_info);
    this.renderFillRows(fills.length ? fills : [{ qty: trade.qty || "", price: trade.avg_price || "" }]);
    // After the rows: they decide whether this trade's market and size have a time.
    if (!this.el("Time").disabled) this.el("Time").value = trade.time ? normalizeTradeTimeText(trade.time) : "";
    this.#syncQtyHeading();
    this.syncTitle();
    this.setMessage("");
  }

  /** Clear: a new trade starts over (keeping the date and market), an edit goes back to the stored trade. */
  revert() {
    if (this.mode === "edit") this.load(this.trade || {});
    else this.reset({ preserveDateMarket: true, action: this.addAction });
  }

  focusFirst(field = this.mode === "edit" ? "Code" : "Date") { this.#focus(this.el(field)); }

  // ---- submit / delete

  /** The request body for the form's trade; throws a message when something is missing or invalid. */
  buildBody() {
    const fills = this.collectFills();
    if (!fills?.length) throw new Error("請完整填寫每一筆成交的股數與價格");
    const time = this.el("Time");
    const body = {
      trade_id: this.el("Id")?.value?.trim() || null,
      trade_date: normalizeTradeDateText(this.el("Date")?.value || ""),
      market: this.el("Market")?.value === "美股" ? "美股" : "台股",
      action: this.el("Action")?.value === "賣出" ? "賣出" : "買進",
      code: this.el("Code")?.value?.trim().toUpperCase() || "",
      trade_info: formatTradeInfo(fills),
      trade_time: time?.disabled ? "" : normalizeTradeTimeText(time?.value || ""),
    };
    if (!body.code) throw new Error("交易日期、股號、成交股數與價格不可空白");
    return body;
  }

  async submit() {
    if (this.submitInFlight) return;
    // Held across beforeSubmit's question too, so a second click while it is open sends nothing.
    this.submitInFlight = true;
    const button = this.el("SubmitBtn");
    const mode = this.mode;
    try {
      if (this.adapter.beforeSubmit && !(await this.adapter.beforeSubmit())) return;
      const body = this.buildBody();
      button.disabled = true;
      button.textContent = mode === "edit" ? "儲存中…" : "送出中…";
      await this.adapter.submit(body, { mode });
    } catch (error) {
      this.adapter.reportError(error, "save");
    } finally {
      this.submitInFlight = false;
      button.disabled = false;
      button.textContent = this.mode === "edit" ? "儲存" : "送出";
    }
  }

  async remove() {
    const tradeId = this.el("Id")?.value?.trim() || "";
    if (!tradeId) return;
    try { await this.adapter.remove(tradeId); }
    catch (error) { this.adapter.reportError(error, "delete"); }
  }

  // ---- events

  #focus(element) {
    if (!element || element.disabled) return;
    this.requestFrame(() => {
      element.focus();
      if (element.tagName === "INPUT" && element.type !== "date") {
        try { element.select(); } catch (error) { console.warn("[trade editor: selecting the input] failed", error); }
      }
    });
  }

  #bindEnter(element, handler) {
    if (!element || element.dataset.tradeEnterBound === "1") return;
    element.dataset.tradeEnterBound = "1";
    this.#on(element, "keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      handler();
    });
  }

  // Enter moves 股數 -> 價格 -> the next row's 股數; after the last row, to 交易時間 or (without one) submits.
  #bindFillEnter(row) {
    const qty = row.querySelector("[data-trade-fill-qty]");
    const price = row.querySelector("[data-trade-fill-price]");
    this.#bindEnter(qty, () => this.#focus(price));
    this.#bindEnter(price, () => {
      const rows = this.fillRows();
      const index = rows.indexOf(row);
      if (index >= 0 && index < rows.length - 1) { this.#focus(rows[index + 1].querySelector("[data-trade-fill-qty]")); return; }
      this.syncTimeAvailability();
      if (!this.el("Time")?.disabled) this.#focus(this.el("Time"));
      else void this.submit();
    });
  }

  #bind() {
    this.#on(this.el("AddFillBtn"), "click", () => this.addFillRow());
    this.#on(this.el("SubmitBtn"), "click", () => void this.submit());
    this.#on(this.el("DeleteBtn"), "click", () => void this.remove());
    this.#on(this.el("CancelBtn"), "click", () => this.adapter.close());
    this.#on(this.el("CloseBtn"), "click", () => this.adapter.close());
    this.#on(this.host.querySelector("[data-trade-editor-close]"), "click", () => this.adapter.close());
    this.#on(this.el("ResetBtn"), "click", () => this.revert());
    this.#on(this.el("Action"), "change", () => { this.#syncQtyHeading(); this.syncTitle(); });
    this.#on(this.el("Market"), "change", () => { this.#syncFillSteps(); this.syncTimeAvailability(); });
    this.#on(this.el("Code"), "input", () => { this.knownName = ""; this.syncTitle(); });
    this.#on(this.el("Time"), "input", () => this.#formatTimeInput());
    this.#on(this.el("Time"), "paste", () => this.requestFrame(() => this.#formatTimeInput()));
    this.#bindEnter(this.el("Date"), () => this.#focus(this.el("Market")));
    this.#bindEnter(this.el("Market"), () => this.#focus(this.el("Action")));
    this.#bindEnter(this.el("Action"), () => this.#focus(this.el("Code")));
    this.#bindEnter(this.el("Code"), () => this.#focus(this.#qtyInputs()[0]));
    this.#bindEnter(this.el("Time"), () => { this.#formatTimeInput(); void this.submit(); });
  }
}
