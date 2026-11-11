import assert from "node:assert/strict";
import { canonicalTradeTimestamp, tradeRowDisplayTime, tradeRowTimestamp } from "../ui/renderer/js/core/trade_row_order.js";

assert.equal(
  tradeRowDisplayTime({ datetime: "2026-09-04T09:14:03.123456" }),
  "09:14:03",
);
assert.equal(
  tradeRowDisplayTime({ exchange_time: "09:15:04", datetime: "2026-09-04T09:14:03" }),
  "09:15:04",
);
assert.equal(tradeRowDisplayTime({ time: "09:16:05.9" }), "09:16:05");
// 2026-09-10 09:00:07 Asia/Taipei, represented as real Unix epoch ns.
assert.equal(tradeRowDisplayTime({ exchange_ts_ns: 1789002007000000000 }), "09:00:07");
assert.equal(tradeRowTimestamp({ exchange_ts_ns: 1789002007000000000 }), "2026-09-10 09:00:07.000");
// Native rows may still contain a stale UTC text field; exchange epoch is
// authoritative and must render in Asia/Taipei.
assert.equal(
  tradeRowDisplayTime({ source: "shioaji+rust", exchange: "tse", exchange_ts_ns: 1789002007000000000, time: "01:00:07" }),
  "09:00:07",
);
assert.equal(
  tradeRowTimestamp({ source: "shioaji+rust", exchange: "tse", exchange_ts_ns: 1789002007000000000, datetime: "2026-09-10 01:00:07" }),
  "2026-09-10 09:00:07.000",
);
assert.equal(
  tradeRowDisplayTime({ code: "2344", exchange_ts_ns: 1789002007000000000, datetime: "2026-09-10 01:00:07" }),
  "09:00:07",
);
assert.equal(canonicalTradeTimestamp({ trade_timestamp: "2026-09-04 09:14:03.1" }), "2026-09-04T09:14:03.100000");

console.log("renderer timestamp contract tests passed");
