// The 成交明細 tape's rules, one copy for every page that lists a view's prints (即時報價 and 歷史回放): which prints
// are listed, which carry the 大單 badge and what one row holds. The pages differ only in where the prints come from.
import { canonicalTradeSide, isSimtradeTick, tickTime, tickVolume } from "../realtime_market_math.js";
import { numberOrNull, positiveNumberOrNull } from "../../core/numbers.js";
import { compareTradeRowsNewestFirst, tradeRowKey, tradeRowSequence } from "../../core/trade_row_order.js";

function tapePrice(tick) {
  return tick?.price ?? tick?.current ?? tick?.close;
}

// A listed print: priced, with volume, and not a 試撮 indicative match (Market Runtime keeps the closing auction's
// 13:25–13:30 indicative prints in the view's trades with `simtrade`; they are not trades).
export function isTapePrint(tick) {
  return !isSimtradeTick(tick) && positiveNumberOrNull(tapePrice(tick)) != null && Number(tickVolume(tick) || 0) > 0;
}

/**
 * 成交明細's page 1: the stored newest page and the live view's prints, one row per print (tradeRowKey), newest first,
 * at most `limit`. A live row wins field by field over the stored one (the newest fields at once, the stored identity
 * kept). Only listed prints (isTapePrint); `keep(row)` narrows both further (the TXF display window).
 */
export function mergeFirstPage(pageRows, liveRows, { limit, keep = () => true } = {}) {
  const merged = new Map();
  for (const row of pageRows || []) if (isTapePrint(row) && keep(row)) merged.set(tradeRowKey(row), row);
  for (const row of liveRows || []) {
    if (!isTapePrint(row) || !keep(row)) continue;
    const key = tradeRowKey(row);
    merged.set(key, { ...(merged.get(key) || {}), ...row });
  }
  return [...merged.values()].sort(compareTradeRowsNewestFirst).slice(0, limit);
}

// Rust B lists the large prints of a view's tradeflow; a tape row carries the badge when it is one of them. Both
// sides are keyed by tradeRowKey, the one print identity (the source trade id alone is not unique: Shioaji reuses it
// within a session -- 1802 on 11-06: ids 7350/7353 of 09:46's 499-lot prints came back on 1-lot and 5-lot prints).
export function largePrintMatcher(flow) {
  const rows = Array.isArray(flow?.largeOrders) ? flow.largeOrders : [];
  const large = new Set(rows.map(tradeRowKey));
  return (tick) => large.has(tradeRowKey(tick));
}

// One listed row. It keeps the print's identity fields, so the tape keys it with tradeRowKey like the view does.
export function tapeRow(tick, isLarge) {
  return {
    time: tickTime(tick),
    price: numberOrNull(tapePrice(tick)), volume: Number(tickVolume(tick) || 0), tradeSide: canonicalTradeSide(tick),
    change: numberOrNull(tick?.change), change_pct: numberOrNull(tick?.change_pct), total_volume: numberOrNull(tick?.total_volume),
    isLarge: Boolean(isLarge),
    ingestSequence: tradeRowSequence(tick),
    durable_sequence: tick?.durable_sequence ?? tick?.ingest_sequence ?? null,
    exchange_ts_ns: tick?.exchange_ts_ns ?? null,
    trade_id: tick?.trade_id ?? null,
  };
}

// The threshold the badges follow: the same flow's, so the tape and the 大單流向 panel cannot disagree.
export function largeOrderDefinition(flow) {
  const threshold = numberOrNull(flow?.thresholds?.volume_cutoff);
  return {
    available: threshold != null,
    threshold,
    version: String(flow?.definition_version || "pending-large-order-definition"),
  };
}
