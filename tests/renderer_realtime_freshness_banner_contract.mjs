import assert from "node:assert/strict";
import {
  computeFreshnessBanner,
  createFreshnessBannerDebouncer,
  recordFreshnessTransitions,
  FRESHNESS_TONE,
} from "../ui/renderer/js/core/realtime_freshness_banner.js";

// AA-01 minimal fix regression coverage. computeFreshnessBanner() is pure
// (no DOM, no timers) and createFreshnessBannerDebouncer() takes an injected
// schedule/cancel pair, so this whole file runs deterministically against a
// fake clock -- no real setTimeout, no DOM, no real WebSocket.

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    schedule(fn, delay) {
      const id = nextId++;
      tasks.set(id, { at: now + delay, fn });
      return id;
    },
    cancel(id) { tasks.delete(id); },
    advance(ms) {
      now += ms;
      // Fire in scheduling order among tasks due at/at-before `now`.
      const due = [...tasks.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[0] - b[0]);
      for (const [id] of due) {
        const task = tasks.get(id);
        if (!task) continue; // may have been cancelled by an earlier callback in this batch
        tasks.delete(id);
        task.fn();
      }
    },
    pendingCount() { return tasks.size; },
  };
}

function createRecorder() {
  const applied = [];
  return { applied, apply: (state) => applied.push(state) };
}

// --- 1. connected -> disconnected ---
{
  const ready = computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "ready" });
  assert.equal(ready.visible, false, "connected + fresh data must not show the banner");

  const disconnected = computeFreshnessBanner({ connectionState: "DISCONNECTED", marketDataAvailable: true, focusedPresentationState: "ready" });
  assert.equal(disconnected.visible, true);
  assert.equal(disconnected.tone, FRESHNESS_TONE.DISCONNECTED);
  assert.ok(disconnected.text.length > 0, "must have a real visible message, not just a console log");
}

// --- 2. stale timeout (two independent triggers: backend-reported
// unavailable, and the focused view's own RealtimeViewStore presentation
// state going stale/resyncing/error while the transport itself is nominally
// connected) ---
{
  const backendStale = computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: false, focusedPresentationState: "ready" });
  assert.equal(backendStale.visible, true);
  assert.equal(backendStale.tone, FRESHNESS_TONE.STALE);

  for (const focusedPresentationState of ["stale", "resyncing", "error"]) {
    const viewStale = computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState });
    assert.equal(viewStale.visible, true, `presentation_state=${focusedPresentationState} must show the banner`);
    assert.equal(viewStale.tone, FRESHNESS_TONE.STALE);
  }

  const viewErrorOnly = computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "ready", focusedViewError: "SUBSCRIBE_FAILED" });
  assert.equal(viewErrorOnly.visible, true, "a live view_error must show the banner even if presentation_state itself reads ready");
}

// --- 3. reconnecting ---
{
  const reconnecting = computeFreshnessBanner({ connectionState: "RECONNECTING", marketDataAvailable: true, focusedPresentationState: "ready" });
  assert.equal(reconnecting.visible, true);
  assert.equal(reconnecting.tone, FRESHNESS_TONE.RECONNECTING);
  assert.notEqual(reconnecting.text, computeFreshnessBanner({ connectionState: "DISCONNECTED" }).text, "reconnecting must read differently from a flat disconnect, not just the same generic text");
}

// --- 4. reconnect + fresh tick: banner must appear on disconnect and then
// auto-clear once the connection AND the focused view both recover, without
// requiring any extra manual "clear" call from the page. ---
{
  const clock = createFakeClock();
  const rec = createRecorder();
  const debouncer = createFreshnessBannerDebouncer({ apply: rec.apply, delayMs: 1500, schedule: clock.schedule, cancel: clock.cancel });

  debouncer.update(computeFreshnessBanner({ connectionState: "DISCONNECTED" }));
  clock.advance(1500);
  assert.equal(rec.applied.length, 1);
  assert.equal(rec.applied[0].visible, true);
  assert.equal(rec.applied[0].tone, FRESHNESS_TONE.DISCONNECTED);

  // Reconnected, but the focused view hasn't produced a fresh snapshot yet
  // (RealtimeViewStore.onConnected() sets SUBSCRIBING -> presentation_state
  // "stale" until the first snapshot/delta lands) -- banner must stay up.
  debouncer.update(computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "stale" }));
  clock.advance(1500);
  assert.equal(rec.applied.length, 2);
  assert.equal(rec.applied[1].visible, true, "must not clear on bare reconnect before real data arrives");
  assert.equal(rec.applied[1].tone, FRESHNESS_TONE.STALE);

  // A fresh tick lands -- the focused view's presentation_state flips to ready.
  debouncer.update(computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "ready" }));
  clock.advance(1500);
  assert.equal(rec.applied.length, 3);
  assert.equal(rec.applied[2].visible, false, "must auto-clear once connected and the focused view is fresh again");
}

// --- 5. repeated/rapid disconnect+reconnect must not flicker the UI ---
{
  const clock = createFakeClock();
  const rec = createRecorder();
  const debouncer = createFreshnessBannerDebouncer({ apply: rec.apply, delayMs: 1500, schedule: clock.schedule, cancel: clock.cancel });

  // A blip well inside the debounce window: disconnect, reconnect-with-fresh-data
  // 300ms later, never letting either state actually get painted.
  debouncer.update(computeFreshnessBanner({ connectionState: "DISCONNECTED" }));
  clock.advance(300);
  debouncer.update(computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "ready" }));
  clock.advance(5000);
  assert.equal(rec.applied.length, 0, "a disconnect/reconnect blip shorter than the debounce window must never paint anything");
  assert.equal(clock.pendingCount(), 0, "no dangling timers left behind after the state settled back to hidden");

  // Now repeat the blip pattern several times in a row (simulating a flapping
  // connection) -- still nothing should ever show as long as each blip stays
  // under the debounce window.
  for (let i = 0; i < 5; i++) {
    debouncer.update(computeFreshnessBanner({ connectionState: "RECONNECTING" }));
    clock.advance(200);
    debouncer.update(computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "ready" }));
    clock.advance(200);
  }
  assert.equal(rec.applied.length, 0, "repeated fast reconnect cycling must never leave a stale banner painted");

  // A real, sustained outage (longer than the debounce window) must still show.
  debouncer.update(computeFreshnessBanner({ connectionState: "DISCONNECTED" }));
  clock.advance(1500);
  assert.equal(rec.applied.length, 1, "a genuine sustained disconnect must still show, not be permanently suppressed");
  assert.equal(rec.applied[0].visible, true);
}

// --- 5b. the anti-flicker delay belongs to showing: data being good again clears the notice at once ---
{
  const clock = createFakeClock();
  const rec = createRecorder();
  const debouncer = createFreshnessBannerDebouncer({ apply: rec.apply, delayMs: 1500, schedule: clock.schedule, cancel: clock.cancel });
  const stale = computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: false, focusedPresentationState: "ready" });
  const ready = computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "ready" });

  debouncer.update(stale);
  assert.equal(rec.applied.length, 0, "showing still waits out the delay");
  clock.advance(1500);
  assert.equal(rec.applied.at(-1).visible, true);

  debouncer.update(ready);
  assert.equal(rec.applied.at(-1).visible, false, "hiding is applied in the same call, with no time passing");
  assert.equal(clock.pendingCount(), 0, "and leaves no timer behind");
  assert.equal(debouncer.getApplied().visible, false);

  // A notice changing its wording is still showing: it keeps the delay.
  debouncer.update(stale);
  clock.advance(1500);
  const count = rec.applied.length;
  debouncer.update(computeFreshnessBanner({ connectionState: "RECONNECTING" }));
  assert.equal(rec.applied.length, count, "a change between two shown states waits out the delay");
  clock.advance(1500);
  assert.equal(rec.applied.at(-1).tone, FRESHNESS_TONE.RECONNECTING);

  // A hide that arrives while a change of wording is pending wins and cancels it.
  debouncer.update(stale);
  debouncer.update(ready);
  assert.equal(rec.applied.at(-1).visible, false);
  clock.advance(5000);
  assert.equal(rec.applied.at(-1).visible, false, "the cancelled change never paints");
}

// --- 6. switching symbols must not inherit the previous symbol's stale state ---
{
  // computeFreshnessBanner() is pure and stateless -- there is nothing to
  // reset when the symbol changes; the caller (pages/realtime.js) always
  // passes the CURRENTLY selected symbol's CURRENT presentation_state, never
  // a cached value. Demonstrate that directly: a stale reading for the old
  // symbol followed by a fresh reading for a newly-selected symbol never
  // carries the "stale" verdict forward.
  const oldSymbolStale = computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "stale" });
  assert.equal(oldSymbolStale.visible, true);
  const newSymbolLoading = computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "loading" });
  assert.equal(newSymbolLoading.visible, false, "a freshly-subscribed symbol (state=loading, not yet stale) must not show the banner just because the previous symbol was stale");

  // Same proof through the debouncer/clock, as the real page would drive it:
  // user is looking at a stale symbol (banner showing), then clicks a
  // different, healthy symbol -- recomputeFreshnessBanner() is called
  // immediately on selection change in the real page, which is modeled here
  // as an update() call with zero elapsed time before the debounce completes.
  const clock = createFakeClock();
  const rec = createRecorder();
  const debouncer = createFreshnessBannerDebouncer({ apply: rec.apply, delayMs: 1500, schedule: clock.schedule, cancel: clock.cancel });
  debouncer.update(computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "stale" }));
  clock.advance(1500);
  assert.equal(rec.applied.at(-1).visible, true, "sanity: old symbol's stale banner is showing");

  debouncer.update(computeFreshnessBanner({ connectionState: "CONNECTED", marketDataAvailable: true, focusedPresentationState: "loading" }));
  clock.advance(1500);
  assert.equal(rec.applied.at(-1).visible, false, "switching to a freshly-loading symbol must clear the banner, not keep showing the old symbol's staleness");
}

// Every shown state and its clearing leave a record with the cause (10-19 19:15: 資料停滯 for a few seconds, no record of
// why). Only what was applied is recorded -- a blip the debouncer swallowed never reaches apply().
{
  const records = [];
  const applied = [];
  let t = 1000;
  let cause = { connection: "CONNECTED", market_data_available: true, symbol: "2330", view_status: "SUBSCRIBING", presentation_state: "stale" };
  const recorded = recordFreshnessTransitions((next) => applied.push(next), { cause: () => cause, log: (...args) => records.push(args), now: () => t });
  recorded({ visible: false, tone: null, text: "" });
  assert.deepEqual(records, [], "a hidden state with nothing shown before is not recorded");
  recorded({ visible: true, tone: FRESHNESS_TONE.STALE, text: "x" });
  t += 2400;
  cause = { ...cause, view_status: "LIVE", presentation_state: "ready" };
  recorded({ visible: false, tone: null, text: "" });
  assert.deepEqual(records, [
    ["[realtime freshness] stale shown", { connection: "CONNECTED", market_data_available: true, symbol: "2330", view_status: "SUBSCRIBING", presentation_state: "stale" }],
    ["[realtime freshness] cleared after 2400 ms", { connection: "CONNECTED", market_data_available: true, symbol: "2330", view_status: "LIVE", presentation_state: "ready" }],
  ]);
  assert.equal(applied.length, 3, "every state still reaches the dock");
}

// A cause that cannot be read or a record that cannot be written never keeps the state off the dock; each failure is
// itself recorded, and the shown/cleared bookkeeping stays right.
{
  const applied = [];
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    let t = 0;
    let causeFails = true, logFails = false;
    const records = [];
    const recorded = recordFreshnessTransitions((next) => applied.push(next), {
      cause: () => { if (causeFails) throw new Error("view store gone"); return { ok: true }; },
      log: (...args) => { if (logFails) throw new Error("log down"); records.push(args); },
      now: () => t,
    });
    recorded({ visible: true, tone: FRESHNESS_TONE.DISCONNECTED, text: "x" });
    assert.equal(applied.length, 1, "a cause that throws does not stop the state");
    assert.deepEqual(records, [["[realtime freshness] disconnected shown", { cause_unreadable: "view store gone" }]]);
    assert.ok(warnings.some(([message]) => message === "[realtime freshness] reading the cause failed"), "the failed read is recorded");
    causeFails = false; logFails = true;
    t += 500;
    recorded({ visible: false, tone: null, text: "" });
    assert.equal(applied.length, 2, "a log that throws does not stop the state");
    assert.ok(warnings.some(([message, what]) => message === "[realtime freshness] writing the record failed" && what === "[realtime freshness] cleared after 500 ms"));
    logFails = false;
    recorded({ visible: false, tone: null, text: "" });
    assert.equal(records.length, 1, "after the clear nothing is shown, so another hidden state is not recorded");
    // An apply that throws is the dock's own failure: it propagates, and no transition is recorded for a state
    // that never reached the screen.
    const failing = recordFreshnessTransitions(() => { throw new Error("dock gone"); }, { log: (...args) => records.push(args), now: () => t });
    assert.throws(() => failing({ visible: true, tone: FRESHNESS_TONE.STALE, text: "x" }), /dock gone/);
    assert.equal(records.length, 1);
  } finally {
    console.warn = realWarn;
  }
}

console.log("AA-01 realtime freshness banner contract passed: disconnect, stale timeout, reconnecting, reconnect+fresh-tick recovery, flicker suppression, symbol-switch reset");
