// 帳務 資金: 首頁 and 庫存 show the ledger's principal (settled), what is still to settle by date, the principal once
// it has, and the day's limit use, for the market shown; 設定 → 資金 keeps both ledgers' settings in the account
// domain's own routes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { capitalMarkup } from "../ui/renderer/js/features/account/capital_view.js";

const fmt = (value) => Number(value).toLocaleString("en-US");
const cls = (value) => (value > 0 ? "price-up" : value < 0 ? "price-down" : "price-flat");
const capital = { 台股: { today: "2026-10-16", initial_principal: 100000, principal: 100000, pending: [{ settlement_date: "2026-10-19", amount: -50020 }],
  pending_total: -50020, principal_after_settlement: 49980, daily_limit: 0, used_today: 50000, remaining_today: null, settlement_days: 2 } };
const html = capitalMarkup(capital, { market: "台股", formatMoney: fmt, profitClass: cls, isPaper: true });
assert.match(html, />本金<\/div><div class="settings-tile-value ">100,000</);
assert.match(html, /待交割（T\+2）/);
assert.match(html, /10\/19 -50,020/);
assert.match(html, />49,980</);
assert.match(html, /未設定額度（設定 → 資金）/);
// The big number is what today's trades used, so the card says so: titled 今日額度 it read as the limit (10-19).
assert.match(html, /今日已用額度（10\/16）<\/div><div class="settings-tile-value ">50,000</);
assert.equal(capitalMarkup(capital, { market: "美股", formatMoney: fmt, profitClass: cls }), "", "a market the ledger has no block for shows nothing");
// The actual ledger keeps no 起始本金: no 本金 / 交割後本金 cards, only 待交割 and 今日已用額度.
const { initial_principal: _a, principal: _b, principal_after_settlement: _c, ...actualTw } = capital.台股;
const actualHtml = capitalMarkup({ 台股: actualTw }, { market: "台股", formatMoney: fmt, profitClass: cls });
assert.doesNotMatch(actualHtml, />本金<|交割後本金/);
assert.match(actualHtml, /待交割（T\+2）/);
assert.match(actualHtml, /今日已用額度/);
// The actual ledger's lines are one row each (settings-item); the paper ledger's are number tiles.
assert.match(actualHtml, /class="settings-group"/);
assert.doesNotMatch(actualHtml, /settings-tile/);
assert.match(html, /class="settings-tiles"/);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
assert.equal((read("ui/renderer/pages/account.html").match(/data-account-capital/g) || []).length, 2, "首頁 and 庫存");
const settings = read("ui/renderer/js/pages/settings_capital.js");
assert.match(settings, /\/api\/actual-account\/capital/);
assert.match(settings, /\/api\/paper-wallet\/capital/);
// Each ledger's card follows its scope (service/account/capital.py ACTUAL_SCOPE / PAPER_SCOPE).
assert.match(settings, /id: "actual"[^}]*markets: \[TW, US\], fields: \[LIMIT\]/);
assert.match(settings, /id: "paper"[^}]*markets: \[TW\], fields: \[PRINCIPAL, LIMIT, FEE, ODD_LOT\]/);
console.log("renderer account capital contract passed");
