import assert from "node:assert/strict";
import fs from "node:fs";

// The 系統負載 CPU sparkline began its path with "L" when a service's first samples were null (still warming up):
// "<path> attribute d: Expected moveto" every refresh in error.log.
// The page module reads a few browser globals when it loads.
globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
const { sparkline } = await import("../ui/renderer/js/pages/settings_system.js");
const at = (values, stepMs = 2000) => values.map((v, i) => ({ t: 1_000_000 + i * stepMs, v }));
const d = (html) => html.match(/ d="([^"]*)"/)[1];
assert.match(d(sparkline(at([null, null, 2, 3, 4]))), /^M/);
const pens = (points) => d(sparkline(points)).split(" ").map((s) => s[0]).join("");
// Every point is one Health sampled (D06-05): a point without a value (the service down or warming up) breaks the line.
// There are no empty slots of the page's own to bridge any more.
assert.equal(pens(at([1, 2, 3])), "MLL");
assert.equal(pens(at([1, 2, null, 3, 4])), "MLML", "a point with no sample starts a new segment");
// Placed by time: Health samples every 10 s with no page open, every 2 s with one -- the x follows the time.
const xs = (points) => d(sparkline(points)).split(" ").map((s) => Number(s.slice(1).split(",")[0]));
assert.deepEqual(xs([{ t: 0, v: 1 }, { t: 10_000, v: 1 }, { t: 12_000, v: 1 }]), [0, 75, 90]);
assert.match(sparkline(at([null, 1])), /muted/, "fewer than two samples draws nothing");

// The page keeps only Health's trend points (core/monitoring_trend.js): no point of its own per snapshot, no length of
// its own, no bridging of gaps it made itself.
const page = fs.readFileSync(new URL("../ui/renderer/js/pages/settings_system.js", import.meta.url), "utf8");
assert.doesNotMatch(page, /MAX_BRIDGED_GAP/);
assert.doesNotMatch(page, /trend\.push\(/, "the page never adds a trend point");
assert.match(page, /getMonitoringSnapshot\?\.\(\{ trendSince: trend\.since\(\) \}\)/, "it asks Health for the points after its last one");
console.log("renderer settings sparkline contract passed");
