import assert from "node:assert/strict";

// The shared SSE owner tells breaks apart (HTTP failure, EOF, silence watchdog, transport error), records
// each outage once with the stream's last identity, finishes it only when a connection held for a heartbeat interval,
// and resets the backoff only then. Each break is its own event, recorded when it happens.
const { startSseStream } = await import("../ui/renderer/js/core/sse_stream.js");

// Like a real fetch body: a read waiting on a held connection rejects when the request is aborted.
function streamOf(chunks, { hang = false, signal = null } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  const held = () => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  return { ok: true, status: 200, body: { getReader: () => ({
    read: () => (index < chunks.length ? Promise.resolve({ value: encoder.encode(chunks[index++]), done: false })
      : hang ? held() : Promise.resolve({ value: undefined, done: true })),
  }) } };
}

let clock = 0;
const records = [];
const record = (start) => {
  const entry = { start, finished: null };
  records.push(entry);
  return { finish: (outcome, extra) => { entry.finished = { outcome, ...extra }; } };
};
const breakEvents = [];
const waits = [];
let calls = 0;
let identity = 0;
await new Promise((resolve) => {
  const stop = startSseStream({
    url: "http://x/events", name: "positions", silenceMs: 1_000_000, heartbeatMs: 20,
    lastIdentity: () => ({ revision: identity }),
    onBlock: (buffer) => { identity += 1; return ""; },
    now: () => clock,
    record,
    emit: (event) => breakEvents.push(event),
    wait: async (ms) => { waits.push(ms); },
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, body: null };   // HTTP failure
      if (calls === 2) { clock += 5; return streamOf(["a"]); }          // opens, delivers once, closes before a heartbeat: EOF
      clock += 100;                                                     // holds past the heartbeat interval
      setTimeout(() => { stop(); resolve(); }, 10);
      return streamOf(["b", "c"], { hang: true, signal });
    },
  });
});
assert.equal(records.length, 1, "one outage, recorded once");
assert.equal(records[0].start.triggerReason, "http_failure");
assert.equal(records[0].start.mechanismId, "renderer.sse_reconnect");
assert.equal(records[0].finished.outcome, "succeeded", "finished by the connection that held");
assert.equal(records[0].finished.detail.revision, 2, "with the identity the holding connection delivered");
assert.deepEqual(waits, [1000, 2000], "a connection that did not hold does not reset the backoff");
// Every break of the outage is its own event, with its own reason and the identity it had then; the outage's end counts them.
assert.deepEqual(breakEvents.map((e) => [e.mechanismId, e.triggerReason, e.attempt, e.detail.revision]),
  [["renderer.sse_break", "http_failure", 1, 0], ["renderer.sse_break", "eof", 2, 1]]);
assert.ok(breakEvents.every((e) => e.outcome === "failed" && Object.values(e.detail).every((v) => v === null || typeof v !== "object")));
assert.equal(records[0].finished.detail.breaks_http_failure, 1);
assert.equal(records[0].finished.detail.breaks_eof, 1);
// The App closing (Electron main, before the backend stops) is a deliberate stop: the stream ends, nothing is recorded.
{
  let closing = null;
  const closingRecords = [];
  let fetched = 0;
  await new Promise((resolve) => {
    startSseStream({
      url: "http://x/events", name: "positions", silenceMs: 1_000_000, heartbeatMs: 20, onBlock: () => "",
      record: (start) => { closingRecords.push(start); return { finish() {} }; }, emit: () => closingRecords.push("break"),
      wait: async () => {}, onAppClosing: (listener) => { closing = listener; return () => { closing = null; }; },
      fetchImpl: async (_url, { signal }) => {
        fetched += 1;
        if (fetched > 1) throw new Error("reconnected after the App began closing");
        setTimeout(() => { closing(); setTimeout(resolve, 20); }, 5);
        return streamOf([], { hang: true, signal });
      },
    });
  });
  assert.deepEqual([fetched, closingRecords.length, closing], [1, 0, null], "stopped once, no reconnect, no record, unsubscribed");
}
// stop() during a long backoff ends the wait at once: the runner winds down (outage recorded as abandoned) without
// waiting the backoff out, and stop.finished says when.
{
  const finished = [];
  let fetched = 0;
  const stop = startSseStream({
    url: "http://x/events", name: "positions", silenceMs: 1_000_000, heartbeatMs: 20, onBlock: () => "",
    initialBackoffMs: 60_000,
    record: () => ({ finish: (outcome) => finished.push(outcome) }), emit: () => {},
    onAppClosing: () => () => {},
    fetchImpl: async () => { fetched += 1; return { ok: false, status: 503, body: null }; },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = Date.now();
  stop();
  await stop.finished;
  assert.ok(Date.now() - started < 1000, "the backoff wait ends with stop()");
  assert.deepEqual([fetched, finished], [1, ["abandoned"]]);
}
console.log("renderer sse stream contract passed");
