import assert from "node:assert/strict";
import fs from "node:fs";

// DOM colours followed the 紅漲 / 綠漲 setting through CSS variables, canvas colours were literals.
const vars = { "--price-up-color": "#ff4d4f", "--price-down-color": "#22c55e", "--price-flat-color": "#ffffff" };
globalThis.document = { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => vars[name] || "" });
const { marketPalette, withAlpha } = await import("../ui/renderer/js/core/market_palette.js");
const { eventMarkerColor } = await import("../ui/renderer/js/core/event_markers.js");

assert.deepEqual(marketPalette(), { up: "#ff4d4f", down: "#22c55e", flat: "#ffffff" });
assert.equal(eventMarkerColor({ direction: "up" }), "#ff4d4f");
Object.assign(vars, { "--price-up-color": "#22c55e", "--price-down-color": "#ff4d4f" });   // 綠漲紅跌
assert.equal(marketPalette().up, "#22c55e", "the setting is read at draw time");
assert.equal(eventMarkerColor({ direction: "up" }), "#22c55e", "an up event follows it");
assert.equal(withAlpha("#22c55e", 0.45), "rgba(34, 197, 94, 0.45)");

for (const file of ["core/trend/canvas_engine.js", "core/trend/kline_chart.js", "core/trend/replay_style_policy.js",
  "core/event_markers.js", "features/history/engine_controller.js"]) {
  const source = fs.readFileSync(new URL(`../ui/renderer/js/${file}`, import.meta.url), "utf8");
  assert.ok(source.includes("marketPalette("), `${file} reads the palette`);
  assert.ok(!/#ff3344|#00d26a|#00c853/.test(source), `${file} hard-codes no market colour`);
}
// Modules that draw no market colour of their own still must not hard-code one (帳務 配對回放 colours through the
// price classes, which read the same setting).
for (const file of ["pages/account.js", "pages/history.js", "features/account/pair_replay_model.js", "features/account/pair_replay_view.js"]) {
  const source = fs.readFileSync(new URL(`../ui/renderer/js/${file}`, import.meta.url), "utf8");
  assert.ok(!/#ff3344|#00d26a|#00c853/.test(source), `${file} hard-codes no market colour`);
}
console.log("renderer market palette contract passed");
