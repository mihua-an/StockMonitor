import assert from "node:assert/strict";
import fs from "node:fs";

// A main-window task of 1-2 s was recorded with only Chromium's long-task attribution ("window"), which cannot say
// what ran. Each frame of 1 s or more is now recorded from the Long Animation Frames entry: the scripts that ran in
// it (file, function, time), and how much of the frame was style/layout and rendering.
globalThis.window ??= globalThis;
globalThis.document ??= { visibilityState: "visible", querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener ??= () => {};
globalThis.location ??= { search: "", href: "http://localhost/" };
const { longFrameRecord } = await import("../ui/renderer/js/core/renderer_runtime_health.js");

const snapshot = "file:///C:/Users/u/AppData/Roaming/stock-monitor-shioaji-desktop/renderer-assets/65446b9e053203a5";
const script = (sourceFunctionName, duration, extra = {}) => ({ invoker: `${sourceFunctionName}.callback`, invokerType: "user-callback",
  sourceURL: `${snapshot}/js/core/status.js`, sourceFunctionName, sourceCharPosition: 120, duration, forcedStyleAndLayoutDuration: 3, pauseDuration: 0, ...extra });
const entry = {
  startTime: 1000, duration: 2110, blockingDuration: 2060, renderStart: 2900, styleAndLayoutStart: 2950,
  scripts: [script("small", 40), script("refreshDiagnostics", 1500, { forcedStyleAndLayoutDuration: 600 }), ...Array.from({ length: 9 }, (_, i) => script(`s${i}`, 1))],
};
const record = longFrameRecord(entry, { timeOrigin: Date.parse("2026-10-27T14:54:41.865Z"), page: "index.html", visibility: "hidden" });

assert.equal(record.duration_ms, 2110);
assert.equal(record.started_at, "2026-10-27T14:54:42.865Z", "start = timeOrigin + startTime");
assert.equal(record.blocking_ms, 2060);
assert.equal(record.render_ms, 210, "from renderStart to the frame's end");
assert.equal(record.style_layout_ms, 160);
assert.equal(record.visibility, "hidden");
assert.equal(record.scripts_total, 11);
assert.equal(record.scripts.length, 8, "the longest scripts only, bounded");
assert.deepEqual(record.scripts[0], { invoker: "refreshDiagnostics.callback", invoker_type: "user-callback",
  source: "js/core/status.js refreshDiagnostics@120", duration_ms: 1500, forced_layout_ms: 600, pause_ms: 0 },
  "the longest script first, its file without the renderer-assets snapshot path");
assert.equal(record.scripts[1].source, "js/core/status.js small@120");

const bare = longFrameRecord({ startTime: 0, duration: 1200, scripts: [{ invokerType: "event-listener", sourceURL: "", sourceCharPosition: -1 }] },
  { timeOrigin: 0, page: "index.html", visibility: "visible" });
assert.equal(bare.render_ms, 0, "a frame without rendering has no render time");
assert.equal(bare.scripts[0].source, "", "a script with no known source says nothing rather than a guess");

// The per-frame record replaces the long-task one: one record per stall, not two.
const source = fs.readFileSync(new URL("../ui/renderer/js/core/renderer_runtime_health.js", import.meta.url), "utf8");
assert.ok(source.includes('"[RENDERER LONG FRAME]"'));
assert.ok(!source.includes("[RENDERER LONG TASK]"));
assert.ok(source.includes('type: "long-animation-frame"'));
console.log("renderer long frame record contract passed");
