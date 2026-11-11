// The 成交明細 大單 badge matches a print to Rust B's large-order rows by the print's identity, never by the source
// trade id alone. 11-06: Shioaji reused 1802's trade ids within the session -- 7350/7353 of 09:46:29's 499-lot prints
// came back on a 1-lot and a 5-lot print at 10:42:44, and 8323 of 09:47:27's 90-lot print on a 1-lot print at
// 10:44:36 -- and all three small prints carried the badge.
import assert from "node:assert/strict";
import { largePrintMatcher } from "../ui/renderer/js/market_data/trade_detail/tape_rows.js";

const flow = { largeOrders: [
  { durable_sequence: 152310104, trade_id: "7350", exchange_ts_ns: "1793929589493097984", volume: 499 },
  { durable_sequence: 152310107, trade_id: "7353", exchange_ts_ns: "1793929589493199104", volume: 499 },
  { durable_sequence: 152325139, trade_id: "8323", exchange_ts_ns: "1793929647586940160", volume: 90 },
  // A never-stored print (the live lane): no durable sequence.
  { durable_sequence: 0, trade_id: "9001", exchange_ts_ns: "1793933000000000001", volume: 60 },
] };
const isLarge = largePrintMatcher(flow);

assert.equal(isLarge({ durable_sequence: 152310104, trade_id: "7350" }), true, "the 499-lot print itself");
assert.equal(isLarge({ durable_sequence: 153505872, trade_id: "7350", volume: 1 }), false, "10:42:44 1 lot reusing id 7350");
assert.equal(isLarge({ durable_sequence: 153506009, trade_id: "7353", volume: 5 }), false, "10:42:44 5 lots reusing id 7353");
assert.equal(isLarge({ durable_sequence: 153545013, trade_id: "8323", volume: 1 }), false, "10:44:36 1 lot reusing id 8323");

assert.equal(isLarge({ durable_sequence: 0, trade_id: "9001", exchange_ts_ns: "1793933000000000001" }), true, "live-lane print: time + id");
assert.equal(isLarge({ durable_sequence: 0, trade_id: "9001", exchange_ts_ns: "1793933999000000000" }), false, "same id, other time");
assert.equal(isLarge({ durable_sequence: 0, trade_id: "9001" }), false, "no identity, no badge");

console.log("renderer large print identity contract passed");
