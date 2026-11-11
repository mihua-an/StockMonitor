// 大單流向 進出: the chart's frame is the session Rust B names (flow `session_open_minute` / `session_close_minute`,
// projection.rs session_frame), on the axis its rows' `minute` is on. The renderer keeps no session table (STK
// 09:00-13:30, futures 08:45-13:45 / 15:00-05:00) and no guess at a night from the code or the minutes it sees.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderUnifiedBigOrderInOut, flowMinuteDetail } from "../ui/renderer/js/core/big_order_flow.js";

const side = (net) => ({ buy: Math.max(net, 0), sell: Math.max(-net, 0), net });
const row = (minute, time, large) => ({ minute, time, large: side(large), small: side(0),
  cumulative: { large: side(large), small: side(0) } });
const frame = (html) => {
  const svg = html.match(/data-flow-size="large".*?<svg[^>]*?(?: data-axis-start="(-?\d+)" data-axis-end="(-?\d+)")?>/s);
  const labels = [...html.split('data-flow-size="small"')[1].matchAll(/flow-chart-x-label[^>]*>([^<]*)</g)].map(([, label]) => label);
  return { start: svg[1] == null ? null : Number(svg[1]), end: svg[2] == null ? null : Number(svg[2]), labels };
};

// A Futu US regular session (09:30-15:59 New York): B's frame, not a stock table's 09:00-13:30.
const us = { market: "US", session: "REGULAR", session_open_minute: 570, session_close_minute: 959, cumulative: {},
  minuteSeries: [row(600, "10:00", 5)] };
assert.deepEqual(frame(renderUnifiedBigOrderInOut(us)), { start: 570, end: 959,
  labels: ["10", "11", "12", "13", "14", "15"] });

// The futures day (08:45-13:45) and a night (15:00 to 05:00, minutes past 1440): every other hour across the night.
assert.deepEqual(frame(renderUnifiedBigOrderInOut({ market: "FUT", session: "DAY", session_open_minute: 525, session_close_minute: 825,
  cumulative: {}, minuteSeries: [row(530, "08:50", 1)] })), { start: 525, end: 825, labels: ["09", "10", "11", "12", "13"] });
const night = { market: "FUT", session: "NIGHT", session_open_minute: 900, session_close_minute: 1740, cumulative: {},
  minuteSeries: [row(900, "15:00", 2), row(1470, "00:30", -3)] };
assert.deepEqual(frame(renderUnifiedBigOrderInOut(night)), { start: 900, end: 1740,
  labels: ["15", "17", "19", "21", "23", "01", "03", "05"] });
assert.equal(flowMinuteDetail(night, 1470).time, "00:30", "a minute past 1440 reads as the next morning's clock");

// A session continuing from the previous partition (Futu's overnight 20:00-03:59): it opens before this partition's 0.
const overnight = { market: "US", session: "OVERNIGHT", session_open_minute: -240, session_close_minute: 239, cumulative: {},
  minuteSeries: [row(-140, "21:40", 4), row(30, "00:30", 1)] };
assert.deepEqual(frame(renderUnifiedBigOrderInOut(overnight)), { start: -240, end: 239,
  labels: ["20", "21", "22", "23", "00", "01", "02", "03"] });
assert.equal(flowMinuteDetail(overnight, -140).time, "21:40");
assert.equal(flowMinuteDetail(overnight, -140).large.cumulative, 4, "the previous partition's minute is on the axis");

// No frame from B: nothing is drawn and nothing is read, never a frame of the renderer's own.
const unframed = renderUnifiedBigOrderInOut({ market: "STK", cumulative: {}, minuteSeries: [row(600, "10:00", 5)] });
assert.deepEqual(frame(unframed), { start: null, end: null, labels: [] });
assert.match(unframed, /尚無正式成交/);
assert.equal(flowMinuteDetail({ market: "STK", minuteSeries: [row(600, "10:00", 5)] }, 600), null);

const source = readFileSync(new URL("../ui/renderer/js/core/big_order_flow.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /13 \* 60 \+ 30|8 \* 60 \+ 45|13 \* 60 \+ 45|looksNight|29 \* 60/, "no session table of the renderer's own");
console.log("renderer flow session frame contract passed");
