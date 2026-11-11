import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_TIME_LABEL_POLICY } from "../ui/renderer/js/core/trend/time_label_policy.js";
import { TimeAxisPolicy, EQUITY_TIME_AXIS, createFuturesTimeAxis } from "../ui/renderer/js/core/trend/time_axis_policy.js";
import { readRendererCss } from "./lib/renderer_css.mjs";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";

const labels = (axis) => DEFAULT_TIME_LABEL_POLICY.candidates(axis).map((tick) => tick.label);
assert.deepEqual(labels(EQUITY_TIME_AXIS), ["09", "10", "11", "12", "13"], "stock chart shows its whole-hour 09 open and omits the 13:30 close");
assert.deepEqual(labels(createFuturesTimeAxis("day")), ["09", "10", "11", "12", "13"], "TXF starts labels at the first whole hour, not 08:45");
// Expiry shortens only the DAY session; the night it rolls into stays on the axis.
assert.deepEqual(createFuturesTimeAxis("night").segments.length, 1, "the NIGHT tab is one segment");
assert.deepEqual(createFuturesTimeAxis("full").segments.map((s) => s.name), ["night", "day"]);
const us = new TimeAxisPolicy({ id: "workspace-us-full", segments: [
  { start: "04:00", end: "09:30" },
  { start: "09:30", end: "16:00" },
] });
const usLabels = labels(us);
assert.ok(usLabels.includes("10"), "US regular session shows 10 as its first whole-hour label");
assert.ok(usLabels.includes("16"), "a whole-hour US close boundary remains visible");
assert.ok(usLabels.every((label) => /^\d{2}$/.test(label)), "all shared time labels use HH without minutes");

const view = fs.readFileSync(new URL("../ui/renderer/workspace_view.js", import.meta.url), "utf8");
const shioaji = fs.readFileSync(new URL("../ui/renderer/js/features/workspace/workspace_column_runtime.js", import.meta.url), "utf8");
const trades = fs.readFileSync(new URL("../ui/renderer/js/features/workspace/workspace_trades_component.js", import.meta.url), "utf8");
const futuComponents = readFutuComponentSources();
const css = readRendererCss();

// The column's chart hides its info rows through the component (infoLines: false); the window touches neither the
// chart's DOM nor its canvas.
assert.doesNotMatch(view, /trend-info-lines|getContext|trend-frame-drawn/, "the workspace reaches into no chart internals");
const engine = fs.readFileSync(new URL("../ui/renderer/js/core/trend/canvas_engine.js", import.meta.url), "utf8");
assert.doesNotMatch(`${shioaji}${engine}`, /openPriceLabel|drawOpenPriceLabel/, "the axis shows no extra open price");
for (const source of [shioaji]) {
  assert.doesNotMatch(source, /stockInfo:\s*\{/, "workspace trend VM must not transmit removed stock-info data");
  assert.doesNotMatch(source, /metrics:\s*\{(?![^}]*\bchange: quote\.change, changePct: quote\.changePct \})/, "workspace trend VM must not transmit removed metric-row data");
}
assert.match(trades, /WORKSPACE_TRADE_LIMIT = 100/, "workspace keeps exactly the most recent 100 trades");
assert.doesNotMatch(trades, /renderColumnHeaderHtml|PageRailController|applyColumnSchema/, "workspace trades create no Title splitter or page rail");
assert.doesNotMatch(css.match(/\.workspace-trades-root\s*\{[^}]*\}/)[0], /border(-radius)?\s*:/, "workspace trades sit inside their column's one card");
// Colours are global tokens (the :root market palette in styles/tokens.css), never literals in the rule.
// A token is a hex or another token (var(--x)); follow it to the colour.
const token = (name) => {
  const value = css.match(new RegExp(`${name.replace(/-/g, "\\-")}:\\s*([^;]+);`))?.[1]?.trim() || "";
  const next = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
  return next ? token(next) : value.toLowerCase();
};
const barColor = (side) => css.match(new RegExp(`\\.orderbook \\.orderbook-total-bar\\.${side}\\s*\\{[^}]*?background[^;]*?var\\((--[a-z0-9-]+)\\)`))?.[1];
assert.equal(token(barColor("bid")), "#e11919", "shared bid cumulative bar is the one market red");
assert.equal(token(barColor("ask")), "#00993d", "shared ask cumulative bar is the one market green");
assert.doesNotMatch(css, /\.workspace-panel-orderbook \.orderbook-total-(?:bar|label)/, "workspace has no provider-specific depth-total color override");
assert.match(futuComponents, /new OrderBookComponent\(\{[\s\S]*?showDepthTotals:true/, "Futu uses the shared orderbook component and shared depth-total row");
assert.match(css, /\.orderbook \.pv-imbalance\s*\{[\s\S]*?flex-basis:\s*62px/, "shared price-volume region retains 80 percent of its original height");

console.log("workspace UI scope contract passed");
