// 分析資料重建中 (B's rebuild from the durable stream, decisions.md「B 重建期間的畫面」): Market Runtime's
// `analysis.state` reaches every subscriber of the window's socket (a late one gets the current state at once); the
// shared notice's markup says 分析資料重建中 with the percent only while B is CATCHING_UP; exactly the panes whose data is
// Rust B's are registered `analysisSourced`; and the live windows hand ComponentHost the state.
import assert from "node:assert/strict";
import fs from "node:fs";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

// --- the transport ------------------------------------------------------------------------------
const live = installRealtimeHarness();
const realtime = await import("../ui/renderer/js/market_data/realtime.js");
assert.equal(typeof realtime.subscribeRealtimeAnalysisState, "function", "realtime.js publishes B's state");
realtime.startRealtimeStream();
const socket = live.sockets[0];
socket.open();
const seen = [];
realtime.subscribeRealtimeAnalysisState((state) => seen.push(state));
socket.frame({ type: "analysis.state", payload: { state: "CATCHING_UP", progress: 0.25, cursor: 25, head: 100, catch_up_from: 0 } });
assert.deepEqual(seen.map((s) => s.progress), [0.25]);
const late = [];
realtime.subscribeRealtimeAnalysisState((state) => late.push(state));
assert.equal(late[0]?.state, "CATCHING_UP", "a pane mounted later hears the current state at once");
socket.frame({ type: "analysis.state", payload: { state: "LIVE", progress: null } });
assert.equal(seen.at(-1).state, "LIVE");
assert.equal(late.at(-1).state, "LIVE");

// --- the markup -----------------------------------------------------------------------------------
const { analysisRebuildHtml } = await import("../ui/renderer/js/core/analysis_rebuild_notice.js");
const catching = analysisRebuildHtml({ state: "CATCHING_UP", progress: 0.426 });
assert.match(catching, /分析資料重建中/);
assert.match(catching, />42%</, "the percent is the completed share, rounded down");
assert.match(catching, /width:42\.6%/);
assert.match(catching, /role="status"/);
assert.doesNotMatch(catching, /\stitle=/, "no title tooltips in the App");
assert.doesNotMatch(analysisRebuildHtml({ state: "CATCHING_UP", progress: null }), /%|analysis-rebuild-bar/, "no guessed progress");
for (const state of ["LIVE", "OFFLINE", "INCOMPATIBLE", undefined]) assert.equal(analysisRebuildHtml({ state }), "", `${state}: nothing shown`);
assert.equal(analysisRebuildHtml(null), "");

// --- which panes ----------------------------------------------------------------------------------
const read = (file) => fs.readFileSync(new URL(`../ui/renderer/${file}`, import.meta.url), "utf8");
const registry = read("js/dashboard_components.js");
const flagged = new Set();
for (const block of registry.split("componentRegistry.register(").slice(1)) {
  const body = block.slice(0, block.indexOf("create:"));
  if (/analysisSourced:\s*true/.test(body)) flagged.add(body.match(/id:\s*"([^"]+)"/)?.[1] || "<loop>");
}
const loop = registry.match(/for \(const \[id, title, variant, chooser\] of \[([\s\S]*?)\]\) \{/);
assert.ok(loop && /analysisSourced:\s*true/.test(registry.slice(loop.index, registry.indexOf("create:", loop.index))),
  "加權走勢、期貨走勢、個股走勢 (the loop) are B's");
flagged.delete("<loop>");
assert.deepEqual([...flagged].sort(), ["industryIndexTrend", "priceFlow", "stockTrendA", "technicalAnalysis", "tradeFlow", "trendChart",
  "workspaceTrendChart"].sort(), "exactly the panes whose data is Rust B's projection");

// --- the live windows give ComponentHost the state; replay contexts do not ------------------------------------------
assert.match(read("js/pages/realtime.js"), /services\.analysisState = \{ subscribe: subscribeRealtimeAnalysisState \}/);
assert.match(read("workspace_view.js"), /services: \{ analysisState: \{ subscribe: subscribeRealtimeAnalysisState \}/);
assert.doesNotMatch(read("js/pages/history.js"), /analysisState/);
console.log("analysis rebuild notice contract passed");
