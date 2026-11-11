import assert from "node:assert/strict";

// 歷史回放 技術分析 reads what live 技術分析 reads, from Market Runtime's replay: its minute trend and Rust B's fixed K at
// the replay time (no candles rebuilt on the page). Every subscriber is told even when another one throws.
globalThis.window ??= { desktopAPI: null, addEventListener() {}, removeEventListener() {} };
const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
const { historyPage, historyState } = await import("../ui/renderer/js/features/history/history_state.js");
const technical = await import("../ui/renderer/js/features/history/replay_technical.js");

assert.equal("replayTechnicalListeners" in technical, false, "the listener sets are not exported");
assert.equal("replayTechnicalKeyListeners" in technical, false);

assert.deepEqual(technical.replayTechnicalState(), { trend: [], day: { fixed_k: {} } }, "no replay open: nothing to draw");
const trend = [{ minute: 540, open: 100, high: 101, low: 99, close: 101 }];
const day = { fixed_k: { k3: [{ start_minute: 540, end_minute: 542, open: 100, high: 101, low: 99, close: 101, volume: 3 }] } };
historyPage.engine = { active: true, state: () => ({ trend, day }) };
assert.deepEqual(technical.replayTechnicalState(), { trend, day }, "the replay's own trend and fixed K");

Object.assign(historyState, { selectedCode: "2330", selectedDate: "2026-09-29" });
assert.equal(technical.replayTechnicalService.key("2330"), "2330|2026-09-29");
assert.equal(technical.replayTechnicalService.key("2303"), "", "another stock is not the replay's");
assert.equal(technical.replayTechnicalService.sessionDate("2330"), "2026-09-29", "history is what came before the replayed day");
assert.equal(typeof technical.replayTechnicalService.history, "function");

const told = [];
const quiet = console.warn;
console.warn = () => {};
try {
  technical.replayTechnicalService.subscribe("2330", () => { throw new Error("broken panel"); });
  technical.replayTechnicalService.subscribe("2330", (state) => told.push(state.trend.length));
  assert.equal(told.length, 1, "the first notice reaches a subscriber after one that threw");
  technical.scheduleReplayTechnicalNotify();
  frames.shift()();
  assert.equal(told.length, 2, "a frame's notice reaches every subscriber");
  const keyTold = [];
  technical.replayTechnicalService.onKeyChange(() => { throw new Error("broken"); });
  technical.replayTechnicalService.onKeyChange(() => keyTold.push(true));
  technical.notifyReplayTechnicalKeyChange();
  assert.equal(keyTold.length, 1);
} finally {
  console.warn = quiet;
  historyPage.engine = null;
}
console.log("renderer replay technical contract passed");
