import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readRendererCss } from "./lib/renderer_css.mjs";

// The footer's horizon choices are a display preference over the ONE horizon authority, config/prediction_horizons.json.
const contract = JSON.parse(readFileSync(new URL("../config/prediction_horizons.json", import.meta.url), "utf8"));
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const events = [];
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const listeners = new Map();
globalThis.window = {
  dispatchEvent: (event) => { events.push(event); (listeners.get(event.type) || []).forEach((fn) => fn(event)); },
  addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
  removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)),
};
const prefs = await import("../ui/renderer/js/core/trend_footer_horizons.js");

assert.deepEqual([...prefs.MODEL_HORIZON_OPTIONS], contract.allowed_minutes, "options follow prediction_horizons.json");
assert.deepEqual([...prefs.DEFAULT_TREND_FOOTER_HORIZONS], contract.default_enabled_minutes, "default follows prediction_horizons.json");
assert.deepEqual(prefs.getTrendFooterHorizons(), [3, 5]);

let seen = null;
const stop = prefs.subscribeTrendFooterHorizons((pair) => { seen = pair; });
assert.deepEqual(prefs.setTrendFooterHorizons([10, 30]), [10, 30]);
assert.deepEqual(seen, [10, 30], "subscribers follow a change at once");
assert.deepEqual(prefs.getTrendFooterHorizons(), [10, 30], "the choice persists");
assert.throws(() => prefs.setTrendFooterHorizons([1, 5]), /two of/, "a horizon the models do not have is refused");
stop();

// Under the chart: the prediction row is four fixed cells, A上 A下 B上 B下, and the product's own facts
// are two lines of four: 昨收 最高 漲幅 漲停 / 開盤 最低 振幅 跌停.
const { predictionTapeHtml, stockInfoTapeHtml } = await import("../ui/renderer/js/core/components/trend_surface_shell.js");
const cellLabels = (html) => [...html.matchAll(/<div[^>]*>(?:<span[^>]*>)?([^<]+?)(?:<\/span>)? <b/g)].map((m) => m[1].trim());
// A prediction cell: its minutes, then the trend glyph of its direction.
const predictionNames = (html) => [...html.matchAll(/data-role="prediction-name"><span data-role="prediction-label">(\d+)<\/span><span class="direction-glyph" data-direction="(up|down)"/g)]
  .map((m) => `${m[1]}|${m[2]}`);
assert.deepEqual(predictionNames(predictionTapeHtml()), ["10|up", "10|down", "30|up", "30|down"]);
assert.deepEqual(cellLabels(stockInfoTapeHtml()), ["昨收", "最高", "漲幅", "漲停", "開盤", "最低", "振幅", "跌停"]);
// Both rows keep .trend-stock-metrics: the 漲停 / 跌停 chips (white on red / green) and the prediction colours are
// styled through it, and dropping it lost them.
for (const html of [predictionTapeHtml(), stockInfoTapeHtml()]) {
  assert.match(html, /class="[^"]*trend-stock-metrics[^"]*"/, "the info rows keep the class their colours hang on");
}
const css = readRendererCss();
assert.match(css, /\.trend-stock-metrics b\.metric-limit-up \{[^}]*--limit-up-bg/);
assert.match(css, /\.trend-stock-metrics b\.metric-limit-down \{[^}]*--limit-down-bg/);
console.log("trend footer horizons contract passed");
