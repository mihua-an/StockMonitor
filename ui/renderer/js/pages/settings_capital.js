// 設定 → 資金: each ledger's settings per market. The account domain keeps them (/api/actual-account/capital,
// /api/paper-wallet/capital; service/account/capital.py CapitalScope, which these lists follow): the actual ledger
// has only 每日交易額度 (台股 TWD, 美股 USD) and only shows it; the paper ledger is 台股 only, with 起始本金 and
// 每日交易額度, and refuses a trade past its limit. One group per ledger, each with its own 儲存, built from the same
// markup.
//
// Amounts are shown and typed in 萬 (decisions.md「資金金額以萬為單位」): whole numbers only -- a digit is the only
// key that goes in, a pasted "1,000" loses its separators -- and the setting stays the full amount (50 萬 is saved as
// 500000), so whatever reads it is unchanged. A saved amount that is not whole 萬 is shown as it is (1.2345), marked,
// and its group cannot be saved until it is.

import { apiGetOk, apiJsonPost } from "../core/api.js";
import { $, escapeHtml } from "../core/utility.js";
import { inFlight, runSingleFlight, userFacingMessage } from "../core/user_action.js";
import { setNote, showToast } from "../core/settings_ui.js";

const WAN = 10000;
const NOT_WHOLE = "金額要是整數萬，請改掉小數";
const TW = { id: "台股", currency: "TWD" };
const US = { id: "美股", currency: "USD" };
// [field, label, unit (萬 + the market's currency when absent), placeholder]
const PRINCIPAL = ["initial_principal", "起始本金"];
const LIMIT = ["daily_limit", "每日交易額度"];
// The paper ledger's 手續費 折數 of the list rate 0.1425% (service/account/capital.py fee_rate); 0 = the actual account's 2.8 折.
const FEE = ["fee_discount", "手續費折扣", "折", "0 = 2.8 折"];
const LEDGERS = [
  { id: "actual", label: "實際帳務", path: "/api/actual-account/capital", markets: [TW, US], fields: [LIMIT] },
  { id: "paper", label: "模擬帳務", path: "/api/paper-wallet/capital", markets: [TW], fields: [PRINCIPAL, LIMIT, FEE] },
];

let generation = 0;

const isMoney = (field) => field !== FEE[0];
const isWhole = (text) => /^[0-9]*$/.test(text);

function itemMarkup(market, [field, label, unit, placeholder]) {
  const money = isMoney(field);
  const input = money
    ? `<input class="settings-input is-short" type="text" inputmode="numeric" data-capital-field="${field}" data-capital-market="${escapeHtml(market.id)}" placeholder="${escapeHtml(placeholder || "未設定")}" />`
    : `<input class="settings-input is-short" type="number" min="0" step="any" inputmode="decimal" data-capital-field="${field}" data-capital-market="${escapeHtml(market.id)}" placeholder="${escapeHtml(placeholder || "未設定")}" />`;
  return `<label class="settings-item"><span class="settings-item-main"><b>${escapeHtml(market.id)}${escapeHtml(label)}</b></span>`
    + `${input}<span class="settings-item-code">${escapeHtml(unit || `萬 ${market.currency}`)}</span></label>`;
}

function groupMarkup(ledger) {
  const items = ledger.markets.map((market) => ledger.fields.map((field) => itemMarkup(market, field)).join("")).join("");
  return `<div class="settings-group-title"><span>${escapeHtml(ledger.label)}</span></div>
    <div class="settings-group" data-capital-ledger="${ledger.id}">${items}</div>
    <div class="settings-actions" data-capital-actions="${ledger.id}"><span class="settings-actions-note" data-capital-message></span><button class="btn is-compact primary" type="button" data-capital-save>儲存</button></div>`;
}

const group = (ledger) => document.querySelector(`[data-capital-ledger="${ledger.id}"]`);
const actions = (ledger) => document.querySelector(`[data-capital-actions="${ledger.id}"]`);
const inputs = (ledger) => [...(group(ledger)?.querySelectorAll("[data-capital-field]") || [])];

function setMessage(ledger, text, isError = false) {
  setNote(actions(ledger)?.querySelector("[data-capital-message]"), text, isError);
}

const notWhole = (ledger) => inputs(ledger).filter((input) => isMoney(input.dataset.capitalField) && !isWhole(input.value));

// A group's 儲存 has this one writer: usable while every amount is whole 萬 and no save of the group is out.
function syncSave(ledger) {
  const button = actions(ledger)?.querySelector("[data-capital-save]");
  if (button) button.disabled = notWhole(ledger).length > 0 || inFlight(button);
}

// A group with an amount that is not whole 萬 is marked, says why left of its 儲存, and cannot be saved.
function checkWhole(ledger) {
  const bad = notWhole(ledger);
  for (const input of inputs(ledger)) input.classList.toggle("is-invalid", bad.includes(input));
  syncSave(ledger);
  const note = actions(ledger)?.querySelector("[data-capital-message]");
  if (bad.length) setMessage(ledger, NOT_WHOLE, true);
  else if (note?.textContent === NOT_WHOLE) setMessage(ledger, "");
}

// Typing: anything but a digit does not go in. Pasting: separators go, digits stay; a decimal point already there
// (an old amount) stays for the user to remove.
function bindAmount(ledger, input) {
  input.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertText" && /[^0-9]/.test(event.data || "")) event.preventDefault();
  });
  input.addEventListener("input", () => {
    const [whole, ...rest] = input.value.replace(/[^0-9.]/g, "").split(".");
    const text = (whole.replace(/^0+(?=\d)/, "") || (rest.length ? "0" : "")) + (rest.length ? `.${rest.join("")}` : "");
    if (text !== input.value) input.value = text;
    checkWhole(ledger);
  });
}

function fill(ledger, payload) {
  for (const input of inputs(ledger)) {
    const value = Number(payload?.markets?.[input.dataset.capitalMarket]?.[input.dataset.capitalField] || 0);
    input.value = value > 0 ? String(isMoney(input.dataset.capitalField) ? value / WAN : value) : "";
  }
  checkWhole(ledger);
}

async function load(ledger, at) {
  try {
    const payload = await apiGetOk(ledger.path);
    if (at === generation) fill(ledger, payload);
  } catch (error) {
    console.warn(`[settings/capital: reading GET ${ledger.path}] failed`, error);
    if (at === generation) setMessage(ledger, userFacingMessage(error, "讀取資金設定失敗", { context: "SETTINGS_CAPITAL_LOAD" }), true);
  }
}

async function save(ledger) {
  const markets = {};
  for (const input of inputs(ledger)) {
    const text = input.value.trim();
    const value = !text ? "0" : isMoney(input.dataset.capitalField) ? String(Number(text) * WAN) : text;
    (markets[input.dataset.capitalMarket] ??= {})[input.dataset.capitalField] = value;
  }
  const result = await apiJsonPost(ledger.path, { markets });
  if (!result?.ok) throw new Error(result?.error || "儲存失敗");
  fill(ledger, result);
  showToast(`${ledger.label}資金設定已儲存`);
}

export function initCapitalSettings() {
  const host = $("settingsCapitalGroups");
  if (!host) return;
  generation += 1;
  const at = generation;
  host.innerHTML = LEDGERS.map(groupMarkup).join("");
  for (const ledger of LEDGERS) {
    for (const input of inputs(ledger)) if (isMoney(input.dataset.capitalField)) bindAmount(ledger, input);
    const button = actions(ledger)?.querySelector("[data-capital-save]");
    button?.addEventListener("click", () => {
      setMessage(ledger, "");
      const flight = runSingleFlight(button, () => save(ledger));
      syncSave(ledger);
      flight.catch((error) => {
        console.warn(`[settings/capital: saving POST ${ledger.path}] failed`, error);
        setMessage(ledger, userFacingMessage(error, "儲存資金設定失敗，請確認數字後再試", { context: "SETTINGS_CAPITAL_SAVE" }), true);
      }).then(() => syncSave(ledger));
    });
    void load(ledger, at);
  }
}

export function disposeCapitalSettings() {
  generation += 1;
}
