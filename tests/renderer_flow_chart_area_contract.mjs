// 大單流向 進出: each minute is a full minute wide and consecutive minutes on one side of zero are one outline, so
// the chart has no stripes; 累計 holds its total through a minute without a trade.
import assert from "node:assert/strict";
import { renderUnifiedBigOrderInOut } from "../ui/renderer/js/core/big_order_flow.js";

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
const paths = (html, size) => {
  const section = html.split('data-flow-size="').find((part) => part.startsWith(size));
  return [...section.matchAll(/<path class="flow-chart-area (buy|sell)" d="([^"]+)"\/>/g)].map(([, side, d]) => ({ side, d }));
};

// 累計: +5 at 09:00, nothing 09:01-09:04, +3 at 09:05: one buy outline from 09:00 to the end of 09:05.
const html = renderUnifiedBigOrderInOut(stk(series(row("09:00", 5), row("09:05", 3))));
const large = paths(html, "large");
assert.equal(large.length, 1, "one shape, no gaps");
assert.equal(large[0].side, "buy");
const subpaths = large[0].d.split("M").filter(Boolean);
assert.equal(subpaths.length, 1, "the quiet minutes keep the total: one outline");
const xs = [...large[0].d.matchAll(/H([\d.]+)/g)].map(([, x]) => Number(x));
const minute = 1000 / 271;  // 09:00 through the end of 13:30
assert.ok(Math.abs(Math.max(...xs) - 6 * minute) < 0.02, "the outline ends at the end of 09:05 (six minutes wide)");

// A change of side starts a new outline on the other side; no <rect> bars remain.
const flip = renderUnifiedBigOrderInOut(stk(series(row("09:00", 5), row("09:01", -9))));
assert.deepEqual(paths(flip, "large").map((p) => p.side), ["buy", "sell"]);
assert.doesNotMatch(flip, /<rect/);

// 分時: a minute without a trade is empty, neighbours on one side still touch.
const minuteHtml = renderUnifiedBigOrderInOut(stk(series(row("09:00", 2), row("09:01", 4), row("09:03", 1))), { displayMode: "minute" });
assert.equal(paths(minuteHtml, "large")[0].d.split("M").filter(Boolean).length, 2, "09:00-09:01 one outline, 09:03 another");

// The closing minute (13:30) keeps a full minute's width.
const closing = renderUnifiedBigOrderInOut(stk(series(row("13:30", 7))));
const closingXs = [...paths(closing, "large")[0].d.matchAll(/[MH]([\d.]+)/g)].map(([, x]) => Number(x));
assert.ok(Math.max(...closingXs) - Math.min(...closingXs) > minute - 0.02, "13:30 is as wide as any other minute");

// The title says what the chart draws: the running total in 累計, each minute's net in 分時 (10-19: 分時 still read
// 累計賣超); the number is the day's net in both.
assert.match(html, /<span>大單累計買超<\/span>/);
assert.match(minuteHtml, /<span>大單每分鐘買賣超｜全日買超<\/span>/);
assert.doesNotMatch(minuteHtml, /flow-net-summary"><span>[^<]*累計/, "no 分時 title says 累計");
console.log("renderer flow chart area contract passed");
