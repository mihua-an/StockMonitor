import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readRendererCss } from "./lib/renderer_css.mjs";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";
import { orderbookSource } from "./lib/orderbook_sources.mjs";
import { trendSurfaceSource } from "./lib/trend_surface_sources.mjs";

// 個股走勢 / 買賣報價 / Futu 個股走勢 / Futu 買賣報價 must present ONE product row
// (股名/股號 · 股價 · 漲跌). This proves three things a reader cannot check by eye:
// the four panels all call the same shell, the monitor page hand-writes no second
// copy of that markup, and no panel-scoped rule is allowed to change its geometry.
const url = (relative) => new URL(relative, import.meta.url);
const css = readRendererCss();
const realtimeHtml = readFileSync(url("../ui/renderer/pages/realtime.html"), "utf8");
const shell = readFileSync(url("../ui/renderer/js/core/components/product_quote_header.js"), "utf8");
const panels = {
  "個股走勢": trendSurfaceSource(),
  "買賣報價 / Futu 買賣報價": orderbookSource(),
  // Futu 個股走勢 mounts the trend component's own "us-stock" surface (its header comes from the same shell).
  "Futu 個股走勢": readFutuComponentSources(),
};

for (const [panel, source] of Object.entries(panels)) {
  if (panel === "Futu 個股走勢") {
    assert.match(source, /new TrendChartComponent\(\{manual:true,variant:"us-stock"\}\)/, `${panel} must mount the trend's us-stock surface`);
    continue;
  }
  assert.match(source, /productQuoteHeaderShell\(/, `${panel} must build its product row with the shared shell`);
}

// The shell is the only place the row's markup exists.
for (const marker of ["product-quote-identity", "product-quote-price-box"]) {
  const inShell = (shell.match(new RegExp(marker, "g")) || []).length;
  assert.ok(inShell > 0, `the shell must define ${marker}`);
  for (const [panel, source] of Object.entries(panels)) {
    assert.doesNotMatch(source, new RegExp(`<div[^>]*class="[^"]*${marker}`),
      `${panel} must not hand-write ${marker}; call the shell instead`);
  }
}

// The 即時報價 page carries no component markup at all: its panes are empty slots and every component (the
// product header included) builds its own markup on mount.
assert.doesNotMatch(realtimeHtml, /class="[^"]*(product-quote|orderbook|trend-chart|event-feed|product-list)/,
  "realtime.html must not hand-write any component's markup");
assert.equal((realtimeHtml.match(/data-component-slot="[^"]+"[^>]*><\/div>/g) || []).length,
  (realtimeHtml.match(/data-component-slot=/g) || []).length, "every pane of realtime.html is an empty slot");

// One geometry, declared once. A panel-scoped rule may position or colour the
// row, but must never give it its own height.
const canonical = css.slice(css.indexOf("THE PRODUCT HEADER"));
assert.ok(canonical, "the canonical product header block must exist");
// The height is one token in the app's single :root block, declared exactly once.
const rootBlock = css.match(/:root\s*\{[^}]*\}/)?.[0] || "";
assert.match(rootBlock, /--product-quote-header-height:\s*\d+px/, "the shared height must be a single token");
assert.equal((css.match(/--product-quote-header-height:/g) || []).length, 1, "declared once");
assert.match(canonical, /\.product-quote-header,\s*\n\.product-quote-header\.compact\s*\{[^}]*height:\s*var\(--product-quote-header-height\)/,
  "every product header, compact or not, must take the shared height");
for (const scoped of css.match(/^[^@\n}]*\.product-quote-header[^{\n]*\{[^}]*\}/gm) || []) {
  if (scoped.includes("--product-quote-header-height")) continue;
  assert.doesNotMatch(scoped, /(^|[\s;])(min-)?height:/,
    `a panel-scoped rule must not set its own product header height:\n${scoped}`);
}
assert.doesNotMatch(css, /\.trend-titlebar\{[^}]*min-height/,
  "the trend titlebar must not keep a private height");

console.log("product header parity contract passed");
