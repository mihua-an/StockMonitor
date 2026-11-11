// A 日內交易 marker request that is no longer the newest one -- the user moved to
// another date or symbol -- changes nothing when it finally fails; it used to clear the markers the current request
// had drawn.
import assert from "node:assert/strict";
import fs from "node:fs";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

const elements = { historyDateSelect: { value: "2026-10-07" } };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { getElementById: (id) => elements[id] || null, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji"], sources: {} } },
  dispatchEvent() {}, addEventListener() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };

const pending = [];
globalThis.fetch = (url) => new Promise((resolve, reject) => pending.push({ url: String(url), resolve, reject }));

const { loadHistoryDaytradeMarkerRows } = await import("../ui/renderer/js/features/history/trade_pages.js");
const { historyState, historyHooks } = await import("../ui/renderer/js/features/history/history_state.js");
let rerenders = 0;
historyHooks.rerenderHistoryCurrentChart = () => { rerenders += 1; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const realWarn = console.warn;
console.warn = () => {};

try {
  // Date A asked first, then the user switches to date B, whose answer arrives first.
  historyState.selectedCode = "2330";
  const first = loadHistoryDaytradeMarkerRows();
  await flush();
  elements.historyDateSelect.value = "2026-10-08";
  const second = loadHistoryDaytradeMarkerRows();
  await flush();
  assert.equal(pending.length, 2);
  pending[1].resolve({ ok: true, json: async () => ({ items: [{ time: "09:01:00" }] }) });
  await second;
  assert.deepEqual(historyState.daytradeMarkerRows, [{ time: "09:01:00" }]);
  const drawn = rerenders;

  // Date A's request fails late: B's markers stay, nothing is redrawn.
  pending[0].reject(new Error("timeout"));
  await first;
  assert.deepEqual(historyState.daytradeMarkerRows, [{ time: "09:01:00" }], "a stale failure does not clear the current markers");
  assert.equal(rerenders, drawn);

  // The current request's own failure still clears (and says so by redrawing).
  const third = loadHistoryDaytradeMarkerRows({ force: true });
  await flush();
  pending[2].reject(new Error("offline"));
  await third;
  assert.deepEqual(historyState.daytradeMarkerRows, []);
  assert.equal(rerenders, drawn + 1);
} finally {
  console.warn = realWarn;
}

// A product's replay that opens after the user chose another product changes nothing on the page.
const page = fs.readFileSync(new URL("../ui/renderer/js/pages/history.js", import.meta.url), "utf8");
const body = page.slice(page.indexOf("async function openHistoryProduct"), page.indexOf("function updateHistoryTimeLabel"));
assert.match(body, /opened = await openHistoryEngine\([\s\S]*?if \(requestGeneration !== historyPage\.productRequestGeneration\) return false;/);
console.log("history marker request fence contract passed (CX-118/CX-119)");
process.exit(0);
