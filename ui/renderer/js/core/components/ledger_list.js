// A ledger's list (styles/components/ledger-list.css): the table, a realized pair's row and what the row opens to. 模擬帳務's
// lists and 歷史回放's 交易明細 are drawn from here.
import { escapeHtml } from "../utility.js";
import { renderColumnGroupHtml, renderColumnHeaderHtml } from "../column_title.js";
import { expandDetailRowHtml } from "../data_grid.js";
import { signedValueClass } from "../market_color_policy.js";
import { ledgerMoney as money, ledgerSignedMoney as signed } from "../ledger_money.js";

/** A table's 股名 cell: the name only; the code when the ledger has no name for it. */
export const ledgerStockName = (code, name) => name || code;
/** Text in a coloured span: a data-table cell has a colour of its own, so the colour goes on the text it marks. */
export const ledgerTinted = (text, cls) => (cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
/** A pair leg's time: a 當沖's clock (HH:MM), an earlier day's date as MM/DD. */
const legTime = (ref) => (/^\d{4}-\d{2}-\d{2}/.test(String(ref || "")) ? String(ref).slice(5, 10).replace("-", "/") : String(ref || "--"));

export function ledgerTableHtml({ role, wrapRole, columns, empty }) {
  return `<div class="ledger-table-wrap" data-role="${wrapRole}" data-grid-x="hidden" data-grid-variant="card" data-row-stops="1">
      <table class="data-table ledger-table">${renderColumnGroupHtml(columns)}${renderColumnHeaderHtml(columns)}
        <tbody data-role="${role}">${ledgerMessageHtml(columns.length, empty)}</tbody></table></div>`;
}

/** The one row a list without rows shows. */
export const ledgerMessageHtml = (colspan, text, cls = "muted") => `<tr><td colspan="${colspan}" class="${cls}">${escapeHtml(text)}</td></tr>`;

/** An open row's detail; "" while it is closed. */
export function ledgerDetailRowHtml({ key, colspan, open, contentHtml }) {
  if (!open) return "";
  return expandDetailRowHtml({ colspan, className: "ledger-detail", contentHtml,
    attrs: `data-morph-key="${escapeHtml(`d:${key}`)}" data-detail-key="${escapeHtml(key)}"` });
}

// 價金 is what really moved: the buy's 價金 + 手續費, the sell's 價金 − 手續費 − 交易稅 (the ledger's amounts).
function pairDetailHtml(pair) {
  const buyNet = Number(pair.buy_amount) + Number(pair.buy_fee);
  const sellNet = Number(pair.sell_amount) - Number(pair.sell_fee) - Number(pair.tax);
  const roi = pair.roi === null || pair.roi === undefined ? "--" : ledgerTinted(`${Math.abs(pair.roi * 100).toFixed(2)}%`, signedValueClass(pair.roi));
  return `<table class="ledger-pair"><thead><tr><th></th><th>買入</th><th>賣出</th></tr></thead><tbody>
          <tr><th>時間</th><td>${escapeHtml(legTime(pair.buy_ref))}</td><td>${escapeHtml(legTime(pair.sell_ref))}</td></tr>
          <tr><th>單價</th><td>${money(pair.buy_price)}</td><td>${money(pair.sell_price)}</td></tr>
          <tr><th>價金</th><td>${money(Math.round(buyNet))}</td><td>${money(Math.round(sellNet))}</td></tr>
          <tr><th>報酬率</th><td colspan="2">${roi}</td></tr></tbody></table>`;
}

/** A realized pair: 股名, 股數 (`qtyClass`: its colour), 買價, 賣價, 損益, and 買入 / 賣出 under it while it is open. */
export function ledgerPairRowHtml(pair, { key, open, selected = false, qtyClass = "" }) {
  return `<tr class="ledger-row${open ? " expanded" : ""}${selected ? " selected" : ""}" data-morph-key="${escapeHtml(key)}" data-row-key="${escapeHtml(key)}">
          <td class="ledger-name">${escapeHtml(ledgerStockName(pair.code, pair.name))}</td><td>${ledgerTinted(money(pair.qty), qtyClass)}</td><td>${money(pair.buy_price)}</td>
          <td>${money(pair.sell_price)}</td><td>${ledgerTinted(signed(Math.round(pair.profit)), signedValueClass(pair.profit))}</td></tr>
        ${ledgerDetailRowHtml({ key, colspan: 5, open, contentHtml: pairDetailHtml(pair) })}`;
}
