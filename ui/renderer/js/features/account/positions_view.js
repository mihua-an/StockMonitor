import { $ } from "../../core/utility.js";
import { cell, patchKeyedRows } from "../../core/cell_patch.js";

const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };

/**
 * Renders the actual/paper account holdings (庫存) table.
 *
 * Reads no owned module-level state. Market/paper-mode and the money/qty
 * formatters are page-owned and must be passed in explicitly.
 *
 * unrealized_pnl/unrealized_pnl_pct/mark_price_available are computed on the
 * screen from Market Runtime's price (live_position_marks.js) -- mark_price
 * missing means genuinely unavailable (unsupported market, quote not yet
 * available), never a fabricated 0. That unavailable
 * state must render as "-", the same convention formatSignedMoney/
 * formatSignedPercent already use for a null/non-finite value.
 */
export function renderPositions(items, {
  market, isPaper, formatQty, formatMoney, formatSignedMoney, formatSignedPercent, profitClass,
} = {}) {
  const body = $("actualHoldingsBody");
  const count = $("actualHoldingCountText");
  const title = $("actualHoldingsTitle");
  const note = $("actualHoldingNote");
  const filtered = Array.isArray(items) ? items.filter((item) => item.market === market) : [];
  // A live price moves only its row's 未實現損益 cells: the title lines and the other rows stay as they are.
  setText(count, `${filtered.length} 檔`);
  setText(title, `${market}${isPaper ? "模擬庫存" : "實際庫存"}`);
  setText(note, "平均成本以先進先出計算");
  if (!body) return;
  // Rows kept by code: a live price writes only that holding's 未實現損益 cells (core/cell_patch.js).
  patchKeyedRows(body, filtered, {
    keyOf: (item) => item.code, keyAttribute: "data-morph-key", columnCount: 7, emptyText: `目前沒有${market}庫存`,
    cellsOf: (item) => {
      const available = item.mark_price_available === true;
      const pnlClass = available ? profitClass(item.unrealized_pnl) : "price-flat";
      return [
        cell(item.code), cell(item.name || ""), cell(formatQty(item.qty)),
        cell(formatMoney(item.avg_cost, item.market)), cell(formatMoney(item.cost_amount, item.market)),
        cell(available ? formatSignedMoney(item.unrealized_pnl, item.market) : "-", pnlClass),
        cell(available ? formatSignedPercent(item.unrealized_pnl_pct) : "-", pnlClass),
      ];
    },
  });
}
