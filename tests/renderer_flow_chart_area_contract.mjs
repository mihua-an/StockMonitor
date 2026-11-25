// 大單流向 進出: one bar a minute, each a full minute wide with no gap to its neighbour, alternating two tones; 累計
// holds its total through a minute without a trade. Each chart has its own 累計／分時; 0 gives way to a close extreme.
import assert from "node:assert/strict";
import { flowModeChoice, renderUnifiedBigOrderInOut } from "../ui/renderer/js/core/big_order_flow.js";

// B's rows carry their minute on the session's axis; the frame is the session B names (09:00-13:30 here).
const row = (time, large, small = 0) => ({ minute: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), time, large: { net: large }, small: { net: small } });
const stk = (minuteSeries) => ({ market: "STK", session_open_minute: 540, session_close_minute: 810, minuteSeries, cumulative: {} });
// B's series: every row also carries the running total through it (projection.rs flow_wire).
const series = (...rows) => {
  const total = { large: 0, small: 0 };
  return rows.map((r) => {
    total.large += r.large.net; total.small += r.small.net;
    return { ...r, cumulative: { large: { net: total.large }, small: { net: total.small } } };
  });
};
const bars = (html, size) => {
  const section = html.split('data-flow-size="').find((part) => part.startsWith(size) && part.includes("flow-chart-plot"));
  return [...section.matchAll(/<path class="flow-chart-bar (buy|sell)( flow-chart-bar-odd)?" d="([^"]+)"\/>/g)]
    .flatMap(([, side, tone, d]) => [...d.matchAll(/M([\d.]+) [\d.]+V[\d.]+H([\d.]+)V[\d.]+Z/g)].map(([, from, to]) => ({ side, tone: tone ? "odd" : "even", from: Number(from), to: Number(to) })))
    .sort((a, b) => a.from - b.from);
};

// 累計: +5 at 09:00, nothing 09:01-09:04, +3 at 09:05: six bars, each starting where the one before ends.
const html = renderUnifiedBigOrderInOut(stk(series(row("09:00", 5), row("09:05", 3))));
const large = bars(html, "large");
assert.equal(large.length, 6, "the quiet minutes keep the total, one bar each");
assert.ok(large.every((bar, i) => i === 0 || bar.from === large[i - 1].to), "no gap between neighbours");
assert.deepEqual(large.map((bar) => bar.tone), ["even", "odd", "even", "odd", "even", "odd"]);
const minute = 1000 / 271;  // 09:00 through the end of 13:30
assert.ok(Math.abs(large.at(-1).to - 6 * minute) < 0.02, "the last bar ends at the end of 09:05");
assert.deepEqual(bars(renderUnifiedBigOrderInOut(stk(series(row("09:00", 5), row("09:01", -9)))), "large").map((bar) => bar.side), ["buy", "sell"]);

// A futures night (15:00-05:00) has a fraction of a pixel a minute: the tone changes every three minutes.
const night = renderUnifiedBigOrderInOut({ ...stk(series(...Array.from({ length: 6 }, (_, i) => row(`15:0${i}`, 1)))), session_open_minute: 900, session_close_minute: 1740 });
assert.deepEqual(bars(night, "large").map((bar) => bar.tone), ["even", "even", "even", "odd", "odd", "odd"]);

// 分時 of the large chart alone: a minute without a trade has no bar, and the small chart stays 累計.
const minuteHtml = renderUnifiedBigOrderInOut(stk(series(row("09:00", 2, 1), row("09:01", 4, 1), row("09:03", 1, 1))), { displayModes: { large: "minute", small: "cumulative" } });
assert.equal(bars(minuteHtml, "large").length, 3);
assert.equal(bars(minuteHtml, "small").length, 4, "the small chart still holds its total through 09:02");
const button = (size, mode) => ({ closest: () => ({ dataset: { flowDisplayMode: mode, flowModeSize: size } }) });
assert.deepEqual(flowModeChoice(button("small", "minute")), { size: "small", mode: "minute" });
assert.equal(flowModeChoice({ closest: () => null }), null);

// The closing minute (13:30) keeps a full minute's width.
const [closing] = bars(renderUnifiedBigOrderInOut(stk(series(row("13:30", 7)))), "large");
assert.ok(closing.to - closing.from > minute - 0.02, "13:30 is as wide as any other minute");

// 0 between two extremes says how far (percent of the plot) the nearer one is; on a one-sided day it is an end of the axis.
const uneven = renderUnifiedBigOrderInOut(stk(series(row("09:00", 10), row("09:01", -1010))));
const gap = Number(uneven.match(/flow-chart-y-label-zero" style="[^"]*--flow-label-gap:([\d.]+)"/)[1]);
assert.ok(Math.abs(gap - 10 / 1010 * 88) < 0.02, String(gap));
assert.doesNotMatch(html.split('data-flow-size="large"').at(-1).split("flow-chart-plot")[0], /flow-chart-y-label-zero/);

// The title says what the chart draws: the running total in 累計, one minute's own net in 分時.
assert.match(html, /<span>大單累計買超<\/span>/);
assert.match(minuteHtml, /<span>大單分時買超<\/span><b class="price-up">\+1</, "09:03's net, not the 7 of the day");
const sold = renderUnifiedBigOrderInOut(stk(series(row("09:00", 9), row("09:01", -2))), { displayModes: { large: "minute" } });
assert.match(sold, /<span>大單分時賣超<\/span><b class="price-down">-2</, "the direction is the newest minute's too");
// Once B says the session is over: each class's last minute that traded, not the closing auction's 0.
const traded = (minute, large, small) => ({ minute, large, small });
const over = { ...stk([traded(802, { buy: 3, sell: 10, net: -7 }, { buy: 1, sell: 1, net: 0 }), traded(804, { buy: 0, sell: 0, net: 0 }, { buy: 4, sell: 1, net: 3 }),
  traded(810, { buy: 0, sell: 0, net: 0 }, { buy: 0, sell: 0, net: 0 })]), session_closed: true };
const bothMinute = { displayModes: { large: "minute", small: "minute" } };
const overHtml = renderUnifiedBigOrderInOut(over, bothMinute);
assert.match(overHtml, /<span>大單分時賣超<\/span><b class="price-down">-7</);
assert.match(overHtml, /<span>小單分時買超<\/span><b class="price-up">\+3</);
assert.match(renderUnifiedBigOrderInOut({ ...over, session_closed: false }, bothMinute), /<span>大單分時買超<\/span><b class="price-flat">0</, "a running session shows its newest minute");
assert.match(minuteHtml, /<span>小單累計買超<\/span>/);
console.log("renderer flow chart bar contract passed");
