// The 成交明細 tape's rules, one copy for every page that lists a view's prints (即時報價 and 歷史回放): which prints
// are listed, which carry the 大單 badge and what one row holds. The pages differ only in where the prints come from.
import { canonicalTradeSide, isSimtradeTick, tickTime, tickVolume } from "../realtime_market_math.js";
import { numberOrNull, positiveNumberOrNull } from "../../core/numbers.js";
import { tradeRowSequence } from "../../core/trade_row_order.js";

function tapePrice(tick) {
  return tick?.price ?? tick?.current ?? tick?.close;
}

// A listed print: priced, with volume, and not a 試撮 indicative match (Market Runtime keeps the closing auction's
// 13:25–13:30 indicative prints in the view's trades with `simtrade`; they are not trades).
export function isTapePrint(tick) {
  return !isSimtradeTick(tick) && positiveNumberOrNull(tapePrice(tick)) != null && Number(tickVolume(tick) || 0) > 0;
}

// One print's identity, the same on Market Runtime's trade rows and Rust B's large-order rows: a stored print is its
// durable_sequence (unique in the stream); a print that is never stored (durable_sequence 0, the live lane) is its
// exchange time with the source trade id. The source trade id alone is not unique: Shioaji reuses it within a
// session (1802 on 11-06: ids 7350/7353 of 09:46's 499-lot prints came back on 1-lot and 5-lot prints at 10:42).
// exchange_ts_ns is compared as the string both rows carry (a nanosecond count is beyond a JS number's precision).
function printIdentity(row) {
  const durable = Number(row?.durable_sequence || 0);
  if (Number.isFinite(durable) && durable > 0) return `d:${durable}`;
  const ts = row?.exchange_ts_ns == null ? "" : String(row.exchange_ts_ns);
  return ts ? `l:${ts}|${row?.trade_id ?? ""}` : null;
}

// Rust B lists the large prints of a view's tradeflow; a tape row carries the badge when it is one of them.
export function largePrintMatcher(flow) {
  const rows = Array.isArray(flow?.largeOrders) ? flow.largeOrders : [];
  const large = new Set(rows.map(printIdentity).filter(Boolean));
  return (tick) => {
    const identity = printIdentity(tick);
    return identity != null && large.has(identity);
  };
}

export function tapeRow(tick, isLarge) {
  return {
    time: tickTime(tick),
    price: numberOrNull(tapePrice(tick)), volume: Number(tickVolume(tick) || 0), tradeSide: canonicalTradeSide(tick),
    change: numberOrNull(tick?.change), change_pct: numberOrNull(tick?.change_pct), total_volume: numberOrNull(tick?.total_volume),
    isLarge: Boolean(isLarge),
    ingestSequence: tradeRowSequence(tick),
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
