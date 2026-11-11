import { numberOrNull } from "../../core/numbers.js";
import { parseExchangeClock } from "../../market_data/taipei_time.js";
// Pure helpers of the account page's views; no API, mode, storage or DOM owner. The 當沖 statistics are the
// backend's (`<ledger>/daytrade-analysis`, AccountAnalyticsService.get_daytrade_analysis): none is computed here.

export function replayClockSeconds(value) {
  return parseExchangeClock(value)?.secondsOfDay ?? null;
}

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

// No value (null: no winning / losing trade to time) is "-", never 0m.
export function daytradeFormatHoldMinutes(value) {
  const minute = numberOrNull(value);
  if (minute === null) return "-";
  const rounded = Math.max(0, Math.round(minute));
  if (rounded < 60) return `${rounded}m`;
  return `${Math.floor(rounded / 60)}h ${String(rounded % 60).padStart(2, "0")}m`;
}
