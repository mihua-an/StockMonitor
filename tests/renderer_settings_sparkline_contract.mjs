import assert from "node:assert/strict";
import fs from "node:fs";

// The CPU trend line is one component (core/diagnostics_cards.js trendHtml): 連線診斷's 系統 CPU / 記憶體 cards and
// 設定's 系統負載 per-service CPU draw it. A path that began with "L" when the first samples were null (warming up) was
// "<path> attribute d: Expected moveto" every refresh in error.log.
// The page module reads a few browser globals when it loads.
globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
const { trendHtml } = await import("../ui/renderer/js/core/diagnostics_cards.js");
const { cpuTrendHtml } = await import("../ui/renderer/js/pages/settings_system.js");

const at = (values, stepMs = 2000) => values.map((v, i) => ({ t: 1_000_000 + i * stepMs, v }));
const line = (html) => html.match(/class="dg-spark-line" d="([^"]*)"/)[1];
const trend = (values, stepMs) => {
  const points = at(values, stepMs);
  return trendHtml({ points, from: points[0].t, to: points.at(-1).t }, { fromZero: true });
};

assert.match(line(trend([null, null, 2, 3, 4])), /^M/, "every run starts with a moveto");
const pens = (html) => line(html).split(" ").filter((s) => /^[ML]/.test(s)).map((s) => s[0]).join("");
assert.equal(pens(trend([1, 2, 3])), "MLL");
assert.equal(pens(trend([1, 2, null, 3, 4])), "MLML", "a point with no sample starts a new segment");
// Placed by time: Health samples every 10 s with no page open, every 2 s with one -- the x follows the time.
const xs = (html) => line(html).split(" ").filter((s) => /^[ML]/.test(s)).map((s) => Number(s.slice(1)));
const placed = [{ t: 0, v: 1 }, { t: 10_000, v: 1 }, { t: 12_000, v: 1 }];
assert.deepEqual(xs(trendHtml({ points: placed, from: 0, to: 12_000 }, { fromZero: true })), [0, 133.3, 160]);
assert.equal(trend([null, 1]), "", "fewer than two samples draws nothing");

// 設定's service row: the same line, placed by its own class; a point Health sent without a value is a gap.
const row = cpuTrendHtml(at([undefined, 1, 2, 3]));
assert.match(row, /^<svg class="settings-spark"/);
assert.equal(pens(row), "ML" + "L");
assert.match(cpuTrendHtml([]), /muted/, "no line yet: the cell says so");
assert.match(cpuTrendHtml(at([null, 1])), /muted/);

// The page keeps only Health's trend points (core/monitoring_trend.js) and no line of its own.
const page = fs.readFileSync(new URL("../ui/renderer/js/pages/settings_system.js", import.meta.url), "utf8");
assert.doesNotMatch(page, /MAX_BRIDGED_GAP/);
assert.doesNotMatch(page, /export function sparkline/, "no second sparkline");
assert.doesNotMatch(page, /trend\.push\(/, "the page never adds a trend point");
assert.match(page, /getMonitoringSnapshot\?\.\(\{ trendSince: trend\.since\(\) \}\)/, "it asks Health for the points after its last one");
console.log("renderer settings sparkline contract passed");
