import { tradeRowTimestamp, tradeRowSequence } from "../../core/trade_row_order.js";
import { numberOrNull } from "../../core/numbers.js";

export function materializedTradeToLiveTick(row = {}, code = "") {
  const stamp = tradeRowTimestamp(row);
  const clock = String(stamp).match(/(?:T|\s)(\d{2}:\d{2}:\d{2})(?:[.Z+\-]|$)/)?.[1]
    || (String(stamp).match(/^(\d{2}:\d{2}:\d{2})(?:[.Z+\-]|$)/)?.[1] || "");
  return {
    ...row, code, datetime: stamp, timestamp: stamp,
    time: clock || String(stamp).slice(-8),
    price: numberOrNull(row?.price), volume: numberOrNull(row?.volume), tick_type: Number(row?.tick_type || 0),
    ingest_sequence: tradeRowSequence(row), trade_origin: row?.trade_origin || "TRADE_DETAIL_MATERIALIZED",
  };
}
