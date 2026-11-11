// A US fractional-share print (0.25 shares) showed 0 in the 成交明細. Volumes are decimal quantities end
// to end; every renderer path that shows one keeps its significant decimals, hides binary noise, keeps whole lots
// compact, and names the unit of the instrument.
import assert from "node:assert/strict";
import { formatQuantity, volumeUnitLabel } from "../ui/renderer/js/core/utility.js";
import { flowQuoteHtml, renderBigOrderSignedCell, renderUnifiedBigOrderInOut } from "../ui/renderer/js/core/big_order_flow.js";

// The formatter every volume cell uses (成交明細, 五檔, 商品列表 總量, 走勢查價, 技術分析, 大單).
assert.equal(formatQuantity(0.25), "0.25", "a fractional share is never 0");
assert.equal(formatQuantity(0.0001), "0.0001");
assert.equal(formatQuantity(0.1), "0.1", "significant decimals only, no 0.10 padding");
assert.equal(formatQuantity(0.1 + 0.2), "0.3", "binary noise of a sum is not shown");
assert.equal(formatQuantity(5371), "5,371", "whole lots exactly as before");
assert.equal(formatQuantity(48_971_788.25), "48,971,788", "whole units, the fraction cut");
assert.equal(formatQuantity(219_989.9305), "219,989", "cut, not rounded");
assert.equal(formatQuantity(0), "0");
assert.equal(formatQuantity(null), "--");
assert.equal(formatQuantity(Number.NaN), "--");

// Units are explicit per instrument.
assert.equal(volumeUnitLabel("lot"), "張");
assert.equal(volumeUnitLabel("contract"), "口");
assert.equal(volumeUnitLabel("share"), "股");
assert.equal(volumeUnitLabel("coin"), "顆");
assert.equal(volumeUnitLabel("US"), "股", "a payload without volume_unit falls back to its market");
assert.equal(volumeUnitLabel("FUT"), "口");
assert.equal(volumeUnitLabel("", "張"), "張");

// 大單 panels: no rounding to whole lots, the instrument's unit.
assert.match(renderBigOrderSignedCell(0.25), />\+0\.25</);
const flow = { market: "US", cumulative: { large: { buy: 0.5, sell: 0.25, net: 0.25 }, small: { buy: 0.1, sell: 0.2, net: -0.1 } },
  totals: { large: { total: 0.75, class_ratio: 0.5 }, small: { total: 0.3, class_ratio: 0.2 } }, minuteSeries: [] };
const html = renderUnifiedBigOrderInOut(flow);
assert.match(html, /<span class="flow-control-large">大單 0\.75<\/span>/, html);
assert.match(html, /<span class="flow-control-small">小單 0\.3<\/span>/);
// 大單控盤 is B's class_ratio (its denominator includes unclassified volume), not large / (large + small).
assert.match(html, /大單控盤<\/span><b>50\.0%<\/b>/);
assert.match(renderUnifiedBigOrderInOut({ market: "STK", cumulative: {}, minuteSeries: [] }), /大單控盤<\/span><b>–<\/b>/, "nothing traded: no share");
assert.match(html, /\+0\.25<\/b><span class="flow-net-unit">股</);
const quote = flowQuoteHtml({ time: "10:00", market: "US", large: { cumulative: 0.25, net: 0.25 }, small: { cumulative: -0.5, net: 0 } });
assert.match(quote, /0\.25<\/b>.*股/s, "查價: the cumulative is not rounded to 0");
const tw = renderUnifiedBigOrderInOut({ market: "STK", cumulative: { large: { buy: 150, sell: 0, net: 150 }, small: {} }, minuteSeries: [] });
assert.match(tw, /\+150<\/b><span class="flow-net-unit">張</);
console.log("renderer decimal volume contract passed");
