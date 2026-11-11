import { escapeHtml } from "../../core/utility.js";
import { morphInto } from "../../core/dom_morph.js";

/**
 * 資金 cards of the 帳務 首頁 and 庫存 views, for the market shown: 本金 (settled: a trade moves it only on its
 * settlement date, 台股 T+2 / 美股 T+1; paper ledger only), 待交割 by date, 交割後本金 (paper only), and 今日已用額度 (what
 * today's trades used, over the limit when one is set). The numbers are the ledger's
 * (dashboard.capital, service/account/capital.py). The paper ledger keeps a principal and enforces its limit: number
 * tiles with a usage bar. The actual ledger's money is the broker's and its limit is only shown: one row each.
 */
export function renderCapital(host, capital, options = {}) {
  if (host) morphInto(host, capitalMarkup(capital, options));
}

/** The cards' markup ("" when the ledger has no block for the market). */
export function capitalMarkup(capital, { market, formatMoney, profitClass, isPaper = false } = {}) {
  const view = capital?.[market];
  if (!view) return "";
  const money = (value) => formatMoney(value, market);
  const pending = Array.isArray(view.pending) ? view.pending : [];
  const pendingLines = pending.length
    ? pending.map((row) => `<span class="${profitClass(row.amount)}">${escapeHtml(String(row.settlement_date).slice(5).replace("-", "/"))} ${escapeHtml(money(row.amount))}</span>`).join("")
    : `<span>無待交割</span>`;
  const limit = Number(view.daily_limit) || 0;
  const limitValue = limit > 0 ? `${money(view.used_today)} / ${money(limit)}` : money(view.used_today);
  const limitNote = limit > 0
    ? `剩 ${money(view.remaining_today)}${isPaper ? "，超過不能再交易" : "（實際交易只顯示）"}`
    : "未設定額度（設定 → 資金）";
  // 本金 only for a ledger that keeps one (the paper ledger; the actual ledger's money is the broker's).
  const hasPrincipal = view.principal !== undefined;
  const principalNote = Number(view.initial_principal) > 0
    ? `起始 ${money(view.initial_principal)}，交割日才進出`
    : "未設定起始本金（設定 → 資金）";
  const pendingLabel = `待交割（T+${Number(view.settlement_days) || 2}）`;
  const usedLabel = `今日已用額度（${escapeHtml(String(view.today || "").slice(5).replace("-", "/"))}）`;
  const title = `<div class="settings-group-title"><span>資金</span></div>`;
  if (!hasPrincipal) {
    const row = (label, value, note, valueClass = "") => `<div class="settings-item"><span class="settings-item-main"><b>${label}</b></span>`
      + `<span class="account-item-number ${valueClass}">${escapeHtml(value)}</span><span class="account-capital-note">${note}</span></div>`;
    return title + `<div class="settings-group" aria-label="資金">`
      + row(pendingLabel, money(view.pending_total), pendingLines, profitClass(view.pending_total))
      + row(usedLabel, limitValue, escapeHtml(limitNote))
      + `</div>`;
  }
  const cell = (label, value, note, valueClass = "", extra = "") => `<div class="settings-tile"><div class="settings-tile-label">${label}</div>`
    + `<div class="settings-tile-value ${valueClass}">${escapeHtml(value)}</div>${extra}<div class="settings-tile-note account-capital-note">${note}</div></div>`;
  const used = Number(view.used_today) || 0;
  const meter = limit > 0
    ? `<div class="settings-meter"><div class="settings-meter-fill" style="width:${Math.min(100, Math.max(0, (used / limit) * 100)).toFixed(1)}%"></div></div>`
    : "";
  return title + `<div class="settings-tiles" aria-label="資金">`
    + cell("本金", money(view.principal), escapeHtml(principalNote))
    + cell(pendingLabel, money(view.pending_total), pendingLines, profitClass(view.pending_total))
    + cell("交割後本金", money(view.principal_after_settlement), "待交割全部交割後")
    + cell(usedLabel, limitValue, escapeHtml(limitNote), "", meter)
    + `</div>`;
}
