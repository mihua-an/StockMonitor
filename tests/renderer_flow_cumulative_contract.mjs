import assert from "node:assert/strict";
import fs from "node:fs";

// 大單流向 累計 has one calculator, Rust B: every minuteSeries row carries the running total through it
// (projection.rs flow_wire `cumulative`). The 累計 chart, the crosshair's 查價 and the summary read it; none of them
// sums the minutes itself (a sum of its own diverged whenever the series held a minute the chart's axis left out).
const { renderUnifiedBigOrderInOut, flowMinuteDetail } = await import("../ui/renderer/js/core/big_order_flow.js");

const side = (buy, sell, net) => ({ buy, sell, net });
// The first row continues a total from before the axis (a joined previous partition): its cumulative is not its own
// net, so a prefix sum over the shown rows gives another number than B's.
const flow = {
  market: "STK",
  // The session Rust B names: the chart's frame.
  session_open_minute: 540, session_close_minute: 810,
  cumulative: { large: side(260, 100, 160), small: side(5, 25, -20) },
  minuteSeries: [
    { minute: 540, time: "09:00", large: side(10, 0, 10), small: side(5, 0, 5), cumulative: { large: side(110, 0, 110), small: side(5, 0, 5) } },
    { minute: 541, time: "09:01", large: side(0, 0, 0), small: side(0, 25, -25), cumulative: { large: side(110, 0, 110), small: side(5, 25, -20) } },
    { minute: 543, time: "09:03", large: side(150, 100, 50), small: side(0, 0, 0), cumulative: { large: side(260, 100, 160), small: side(5, 25, -20) } },
  ],
};

// The 累計 chart's y axis spans B's totals (110 .. 160), not the shown nets' prefix sums (10 .. 60).
const html = renderUnifiedBigOrderInOut(flow);
const largeAxis = html.split('data-flow-size="large"')[1].split("flow-chart-plot")[0];
assert.match(largeAxis, />160</, "the top of the 累計 axis is B's running total");
assert.doesNotMatch(largeAxis, />60</);
assert.match(html, /大單累計買超<\/span><b class="price-up">\+160</, "the summary is B's total");

// The crosshair at a minute reads that minute's B total; at a minute without a trade, the last one before it.
const at = flowMinuteDetail(flow, 543);
assert.deepEqual([at.time, at.large, at.small], ["09:03", { buy: 150, sell: 100, net: 50, cumulative: 160 }, { buy: 0, sell: 0, net: 0, cumulative: -20 }]);
const quiet = flowMinuteDetail(flow, 542);
assert.deepEqual([quiet.large, quiet.small], [{ buy: 0, sell: 0, net: 0, cumulative: 110 }, { buy: 0, sell: 0, net: 0, cumulative: -20 }]);
assert.equal(flowMinuteDetail(flow, 539), null, "before the first traded minute there is nothing to read");
assert.equal(flowMinuteDetail(flow, 544), null);

const source = fs.readFileSync(new URL("../ui/renderer/js/core/big_order_flow.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /running \+=|\.cumulative \+=/, "no prefix sum of its own");
console.log("renderer flow cumulative contract passed");
