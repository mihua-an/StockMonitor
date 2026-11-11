// 台股 升降單位 in the renderer: the price policy's tick table (config/twse_price_policy.json, which the paper desk
// serves with its funds as `price_policy`) for an instrument kind (the security master's, product catalog `type`),
// applied to a price. The numbers and the kind are their owners' data, checked against
// tests/fixtures/tw_stock_rules_cases.json; nothing here knows a band or a code rule. 漲停／跌停 are never derived:
// screens show and clamp to the official limits the provider publishes, or none.

/** The tick table of `instrumentKind` in a served price policy; null while either is not known. */
export function tickTable(pricePolicy, instrumentKind) {
  const name = pricePolicy?.tick_table_of_kind?.[String(instrumentKind || "")];
  const table = name ? pricePolicy?.tick_tables?.[name] : null;
  return Array.isArray(table) && table.length ? table : null;
}

/** 台股 升降單位 for a price on `table` ([[below, tick], ...], the last `below` null); null without a table or price. */
export function tickSize(price, table) {
  const p = Number(price);
  if (!Array.isArray(table) || !(p > 0)) return null;
  const row = table.find(([below]) => below === null || p < Number(below));
  return row ? Number(row[1]) : null;
}

/** One 升降單位 up or down from `price` (a step down at a band edge uses the lower band's tick); `price` unchanged
 * without a table. */
export function stepPrice(price, direction, table) {
  const p = Number(price);
  if (!(p > 0)) return p;
  const tick = direction > 0 ? tickSize(p, table) : tickSize(p - 1e-9, table);
  if (tick === null) return p;
  const next = direction > 0 ? Math.floor(p / tick + 1e-9) * tick + tick : Math.ceil(p / tick - 1e-9) * tick - tick;
  return Number(next.toFixed(2));
}
