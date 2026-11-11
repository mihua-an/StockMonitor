// A print that sets no last sale (an odd lot, an average-price print; Market Runtime's Engine::classify_print) stays
// in the 成交明細 but without a 內外盤 colour: Market Runtime sends it with side NEUTRAL / tick_type 0 (its live tape
// frame, its stored trade pages and the history tape alike), and the tape takes the side it is given -- it never
// reads the source's direction or condition itself.
import assert from "node:assert/strict";
import { isTapePrint, tapeRow } from "../ui/renderer/js/market_data/trade_detail/tape_rows.js";
import { TradeSideColorPolicy } from "../ui/renderer/js/core/market_color_policy.js";

// As wire::trade / trade_pages::trade_row send them for US.TSM 11-06 07:36 (an odd lot at 昨收) and a regular print.
const odd = { durable_sequence: 7, exchange_ts_ns: "1794054960000000000", price: 353.1, volume: 0.25,
  side: "NEUTRAL", tick_type: 0, no_last_sale: true, trade_id: "7" };
const regular = { durable_sequence: 8, exchange_ts_ns: "1794054961000000000", price: 354.0, volume: 100,
  side: "BUY", tick_type: 1, no_last_sale: false, trade_id: "8" };

assert.equal(isTapePrint(odd), true, "the odd lot is listed");
assert.equal(TradeSideColorPolicy.volumeCssClass(tapeRow(odd, false).tradeSide), TradeSideColorPolicy.volumeCssClass("NEUTRAL"));
assert.equal(TradeSideColorPolicy.cssClass(tapeRow(odd, false).tradeSide), "price-flat", "no 外盤 colour");
assert.equal(TradeSideColorPolicy.cssClass(tapeRow(regular, false).tradeSide), "price-up");

console.log("renderer no-last-sale tape contract passed");
