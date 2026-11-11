// 成交明細 paging trace (developer only): the backend's latency_ms / parts_opened reach the trace, and the newest pages
// are kept, bounded, for the renderer health report (trade_pages_recent).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { logTradePagePerfTrace, logTradePagePerfFailure, tradePageTraceSnapshot } from "../ui/renderer/js/market_data/trade_detail/perf_trace.js";

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};
try {
  const now = performance.now();
  for (let page = 1; page <= 10; page += 1) {
    logTradePagePerfTrace({ target: "2330", identityKey: "k", page, rowsCount: 100,
      result: { total_rows: 1000, total_pages: 10, latency_ms: 12.5, parts_opened: 3 },
      perfStartedAt: now, perfApiDoneAt: now + 20, perfMapDoneAt: now + 21, perfInvalidateAt: now + 22, traceFrame: (fn) => fn() });
  }
  logTradePagePerfFailure({ target: "2330", page: 11, perfStartedAt: now, error: new Error("down") });
} finally {
  console.log = quiet.log;
  console.warn = quiet.warn;
}
const recent = tradePageTraceSnapshot();
assert.equal(recent.length, 8, "bounded");
assert.deepEqual(recent.slice(0, -1).map((e) => e.page), [4, 5, 6, 7, 8, 9, 10], "the newest pages");
assert.equal(recent.at(-2).backend_latency_ms, 12.5);
assert.equal(recent.at(-2).parts_opened, 3);
assert.equal(recent.at(-1).error, "down", "a failed page is part of the trace");
recent[0].page = -1;
assert.notEqual(tradePageTraceSnapshot()[0].page, -1, "a snapshot is a copy");

const health = readFileSync(new URL("../ui/renderer/js/core/renderer_runtime_health.js", import.meta.url), "utf8");
assert.match(health, /trade_pages_recent: tradePageTraceSnapshot\(\)/);
console.log("renderer trade page trace contract passed");
