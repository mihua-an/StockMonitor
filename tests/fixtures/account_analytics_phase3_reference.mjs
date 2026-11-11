// Pure projections copied from the account page; no API, mode, storage or DOM owner. The 當沖 statistics are the
// ledger's (tests/test_daytrade_analysis.py), so only what the page computes itself is here.

export function buildCumulativeRealizedByDate(items, dateKey = "date") {
  const cumulative = new Map();
  let normalTotal = 0;
  let daytradeTotal = 0;

  [...(Array.isArray(items) ? items : [])]
    .sort((a, b) => String(a?.[dateKey] || "").localeCompare(String(b?.[dateKey] || "")))
    .forEach((item) => {
      const date = String(item?.[dateKey] || "");
      if (!date) return;
      normalTotal += Number(item?.normal_profit) || 0;
      daytradeTotal += Number(item?.daytrade_profit) || 0;
      cumulative.set(date, {
        normal_profit: normalTotal,
        daytrade_profit: daytradeTotal,
      });
    });

  return cumulative;
}


export function daytradeFormatHoldMinutes(value) {
  const minute = Number(value);
  if (!Number.isFinite(minute)) return "-";
  const rounded = Math.max(0, Math.round(minute));
  if (rounded < 60) return `${rounded}m`;
  return `${Math.floor(rounded / 60)}h ${String(rounded % 60).padStart(2, "0")}m`;
}
