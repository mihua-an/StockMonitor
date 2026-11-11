import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The history page's splitters bind listeners on the page and, while dragging, on the document. The page's
// teardown (disposeHistoryPage) now ends both -- a drag in progress included -- instead of leaving them behind.
globalThis.Event = globalThis.Event || class { constructor(type) { this.type = type; } };
const { createHistoryWorkspaceLayoutController } = await import("../ui/renderer/js/features/history/workspace_layout.js");

function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn, options) {
      const signal = options && typeof options === "object" ? options.signal : null;
      if (signal?.aborted) return;
      listeners.set(`${type}:${fn.name || listeners.size}`, fn);
      const key = [...listeners.keys()].at(-1);
      signal?.addEventListener("abort", () => listeners.delete(key));
    },
    removeEventListener(type, fn) {
      for (const [key, value] of listeners) if (value === fn && key.startsWith(`${type}:`)) listeners.delete(key);
    },
    count(type) { return [...listeners.keys()].filter((key) => key.startsWith(`${type}:`)).length; },
  };
}

const splitter = Object.assign(target(), { getBoundingClientRect: () => ({ height: 6, width: 6, left: 0 }), setPointerCapture() {}, releasePointerCapture() {} });
const page = Object.assign(target(), {
  dataset: {}, classList: { add() {}, remove() {} },
  style: Object.assign(new Map(), {
    setProperty(key, value) { this.set(key, value); }, getPropertyValue(key) { return this.get(key) || ""; }, removeProperty(key) { this.delete(key); },
  }),
  querySelector: (selector) => ({
    ".history-dashboard": { getBoundingClientRect: () => ({ height: 900 }) },
    ".history-top-workspace": { getBoundingClientRect: () => ({ height: 400, width: 1200, left: 0 }) },
    ".history-bottom-tools": { children: [] },
    '[data-history-workspace-splitter="horizontal"]': splitter,
  }[selector] || null),
  querySelectorAll: () => [],
});
const documentRef = Object.assign(target(), { body: { dataset: {}, classList: { add() {}, remove() {} } }, querySelector: (s) => (s === ".history-replay-layout" ? page : null) });
const controller = createHistoryWorkspaceLayoutController({ documentRef, windowRef: { dispatchEvent() {} }, layoutStore: { read: () => null, write() {} } });

assert.equal(controller.bind(), true);
assert.equal(splitter.count("pointerdown"), 1);
// Start a drag: the document now holds move/up/cancel listeners.
[...splitter.listeners.values()][0]({ preventDefault() {}, stopPropagation() {}, currentTarget: splitter, clientY: 100, pointerId: 1 });
assert.equal(documentRef.count("pointermove"), 1);
controller.dispose();
assert.equal(documentRef.count("pointermove") + documentRef.count("pointerup") + documentRef.count("pointercancel"), 0,
  "a drag in progress is ended by the teardown");
assert.equal(splitter.count("pointerdown"), 0, "the splitter listeners are removed");
assert.equal(page.dataset.workspaceSplitReady, undefined, "a rebuilt page binds again");
assert.equal(controller.bind(), true);
controller.dispose();

// The real controller's drag: a click (down, up) stores nothing; a drag that moved stores the layout once.
const writes = [];
const saving = createHistoryWorkspaceLayoutController({ documentRef, windowRef: { dispatchEvent() {} }, layoutStore: { read: () => null, write: (...args) => writes.push(args) } });
assert.equal(saving.bind(), true);
const down = (clientY) => [...splitter.listeners.values()][0]({ preventDefault() {}, stopPropagation() {}, currentTarget: splitter, clientY, pointerId: 1 });
const documentHandler = (type) => [...documentRef.listeners.entries()].find(([key]) => key.startsWith(`${type}:`))?.[1];
down(100);
documentHandler("pointerup")({ pointerId: 1 });
assert.equal(writes.length, 0, "a click-only splitter interaction stores nothing");
down(100);
documentHandler("pointermove")({ preventDefault() {}, clientY: 400, pointerId: 1 });
documentHandler("pointerup")({ pointerId: 1 });
assert.equal(writes.length, 1, "a drag that moved the boundary stores the layout once");
assert.equal(documentRef.count("pointermove"), 0, "the drag's document listeners end with it");
// A cancelled pointer after a move: the layout's variables go back to what they were when the drag began, and
// nothing is stored.
assert.ok(page.style.getPropertyValue("--history-work-top-height"), "the stored drag set the top height");
const height = "300px";   // (no grid in this test: every move lands on the 250 px minimum)
page.style.setProperty("--history-work-top-height", height);
down(100);
documentHandler("pointermove")({ preventDefault() {}, clientY: 200, pointerId: 1 });
assert.notEqual(page.style.getPropertyValue("--history-work-top-height"), height, "the drag moved it");
documentHandler("pointercancel")({ pointerId: 1 });
assert.equal(page.style.getPropertyValue("--history-work-top-height"), height, "a cancelled drag restores it");
assert.equal(writes.length, 1, "and stores nothing");
page.style.removeProperty("--history-work-top-height");
down(100);
documentHandler("pointermove")({ preventDefault() {}, clientY: 300, pointerId: 1 });
saving.dispose();
assert.equal(page.style.getPropertyValue("--history-work-top-height"), "", "a teardown mid-drag removes a variable the drag set");
assert.equal(writes.length, 1);

const history = readFileSync(new URL("../ui/renderer/js/pages/history.js", import.meta.url), "utf8");
assert.match(history, /export function disposeHistoryPage\(\) \{\s*historyWorkspaceLayoutController\.dispose\(\);/,
  "the page's teardown ends the layout controller");
const dispose = history.slice(history.indexOf("export function disposeHistoryPage()"));
assert.match(dispose.slice(0, dispose.search(/\r?\n\}\r?\n/)), /cancelAnimationFrame\(historyState\.replayTimeFrame\);/,
  "the teardown cancels the deferred replay-time repaint");
assert.match(dispose.slice(0, dispose.search(/\r?\n\}\r?\n/)),
  /historyPage\.reloadOnApiOnline\?\.\(\);\s*historyPage\.reloadOnApiOnline = null;/,
  "leaving the page ends the wait for FastAPI to come back");
// Leaving while a stock loads: its load is fenced out (the generation moves on and its answer is dropped), so the
// loading mark goes with it -- historyState outlives the page, and the next visit drew that row spinning for good.
assert.match(dispose, /historyPage\.productRequestGeneration \+= 1;\s*historyState\.loadingCode = "";/,
  "the teardown that fences out the product load also clears its loading mark");
const stockList = readFileSync(new URL("../ui/renderer/js/features/history/stock_list.js", import.meta.url), "utf8");
assert.match(stockList, /loadingCode: historyState\.loadingCode/, "the list reads the mark from that state");
assert.match(stockList, /code === state\.loadingCode \? " history-stock-item-loading"/, "the list draws the mark from that state only");
console.log("renderer history workspace layout dispose contract passed");
