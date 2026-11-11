import assert from "node:assert/strict";
import { RealtimeRenderScheduler } from "../ui/renderer/js/features/realtime/realtime_render_scheduler.js";

const scheduler = new RealtimeRenderScheduler({ windowRef: globalThis, defaultDelayMs: 5 });
const rendered = [];

scheduler.schedule("trades", () => rendered.push("trades"));
scheduler.schedule("orderbook", () => rendered.push("orderbook"));
scheduler.schedule("trend", () => rendered.push("trend-old"));
scheduler.schedule("trend", () => rendered.push("trend-new"));

await new Promise((resolve) => setTimeout(resolve, 25));

assert.deepEqual(rendered.sort(), ["orderbook", "trades", "trend-new"].sort());
assert.equal(scheduler.pendingCount(), 0);

let cancelledRuns = 0;
scheduler.schedule("destroyed-component", () => { cancelledRuns += 1; }, { delayMs: 20 });
assert.equal(scheduler.cancel("destroyed-component"), true);
assert.equal(scheduler.cancel("destroyed-component"), false);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(cancelledRuns, 0);

let reboundRuns = 0;
scheduler.schedule("rebound-component", () => { reboundRuns += 1; }, { delayMs: 20 });
scheduler.cancel("rebound-component");
scheduler.schedule("rebound-component", () => { reboundRuns += 10; }, { delayMs: 0 });
assert.equal(reboundRuns, 10);
assert.equal(scheduler.pendingCount(), 0);

// Deterministic clock, deliberately beginning with timer id zero.
class Clock {
  now = 0;
  next = 0;
  timers = new Map();
  setTimeout(fn, delay) { const id = this.next++; this.timers.set(id, { fn, at: this.now + delay }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  requestAnimationFrame(fn) { return this.setTimeout(fn, 16); }
  cancelAnimationFrame(id) { this.clearTimeout(id); }
  advance(ms) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].fn();
    }
    this.now = end;
  }
}
const clock = new Clock();
const fixed = new RealtimeRenderScheduler({ windowRef: clock, defaultDelayMs: 80 });
const paintFrames=[];
fixed.scheduleFrame('paint',()=>paintFrames.push('old'));
fixed.scheduleFrame('paint',()=>paintFrames.push('latest'));
clock.advance(15);assert.equal(paintFrames.length,0);
clock.advance(1);assert.deepEqual(paintFrames,['latest']);
fixed.scheduleFrame('cancelled-paint',()=>assert.fail('cancelled paint ran'));
assert.equal(fixed.cancel('cancelled-paint'),true);
clock.advance(16);
fixed.schedule('zero', () => assert.fail('cancelled timer zero ran'));
fixed.cancel('zero');
assert.equal(clock.timers.size, 0);
const frames = [];
for (let seq = 1; seq <= 12000; seq++) {
  fixed.schedule('continuous', () => frames.push({ seq, at: clock.now }));
  clock.advance(5);
}
assert.equal(frames.length, 750, '200Hz for 60s must render every 80ms');
assert.equal(frames[0].seq, 16, 'render latest callback, not first callback');
assert.equal(frames.at(-1).seq, 12000);
fixed.schedule('stale', () => assert.fail('stale callback ran'));
const stale = [...clock.timers.values()][0].fn;
fixed.cancel('stale');
let newRuns = 0;
fixed.schedule('stale', () => newRuns++);
stale();
assert.equal(newRuns, 0);
clock.advance(80);
assert.equal(newRuns, 1);
fixed.schedule('force', () => assert.fail('replaced callback ran'));
fixed.schedule('force', () => newRuns++, { force: true });
clock.advance(80);
assert.equal(newRuns, 2);
fixed.schedule('reentrant', () => fixed.schedule('reentrant', () => newRuns++));
clock.advance(80);
assert.equal(fixed.pendingCount(), 1);
clock.advance(80);
assert.equal(newRuns, 3);
fixed.schedule('a', () => assert.fail('cleared callback ran'));
fixed.schedule('b', () => assert.fail('cleared callback ran'));
fixed.clear(); clock.advance(80);
assert.equal(fixed.pendingCount(), 0);
console.log("renderer scheduler contract tests passed");
