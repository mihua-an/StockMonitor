import assert from "node:assert/strict";

// 技術分析's candle service is one factory for the page and the detached window: the key waits for a trading date, the
// view subscribed is the trend and day channels, a cached view draws once at once, and later changes draw once a frame.
globalThis.window = globalThis.window || { desktopAPI: null, addEventListener() {}, removeEventListener() {} };
const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.cancelAnimationFrame = () => { frames.length = 0; };
const { technicalViewService } = await import("../ui/renderer/js/features/realtime/technical_window_service.js");

let tradingDate = "";
let cached = null;
const subscriptions = [];
let released = 0;
const gateway = {
  snapshot: () => cached,
  subscribe(spec, onChange, options) { subscriptions.push({ spec, onChange, options }); return () => { released += 1; }; },
};
const keyListeners = new Set();
const service = technicalViewService({
  gateway,
  baseSpec: (code) => ({ code, market: "STK", session: "DAY", trading_date: tradingDate, channels: ["summary"] }),
  sessionDate: () => tradingDate,
  onKeyChange(listener) { keyListeners.add(listener); return () => keyListeners.delete(listener); },
});

assert.equal(service.key("2330"), "", "no trading date yet: no view");
assert.equal(service.subscribe("2330", () => {}), null);
assert.equal(subscriptions.length, 0);

tradingDate = "2026-11-10";
assert.equal(service.key("2330"), "2330|2026-11-10");
assert.equal(service.sessionDate(), "2026-11-10");
const unsubscribeKey = service.onKeyChange(() => {});
assert.equal(keyListeners.size, 1);
unsubscribeKey();
assert.equal(keyListeners.size, 0);

const seen = [];
cached = { trend: [1] };
const unsubscribe = service.subscribe("2330", (view) => seen.push(view));
assert.deepEqual(subscriptions[0].spec.channels, ["trend", "day"]);
assert.equal(subscriptions[0].options.replayCached, false);
assert.deepEqual(seen, [{ trend: [1] }], "the cached view draws once at once");

cached = { trend: [1, 2] };
subscriptions[0].onChange();
subscriptions[0].onChange();
assert.equal(frames.length, 1, "changes within a frame draw once");
frames.shift()();
assert.deepEqual(seen.at(-1), { trend: [1, 2] });

unsubscribe();
assert.equal(released, 1);
console.log("renderer technical view service contract passed");
