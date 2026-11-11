import assert from "node:assert/strict";
import { createWorkspaceBenchmarkSource } from "../ui/renderer/js/features/workspace/workspace_benchmark_source.js";

// Market Runtime may now deliver several deltas in one `batch` event. The workspace benchmark
// source used to read only `event.delta` (the LAST one), so a batch that closed two minutes lost
// the earlier minute from the 加權 / 期貨 overlay of every workspace column.
let listener = null;
const source = createWorkspaceBenchmarkSource({
  subscribeView: (_spec, callback) => { listener = callback; return () => {}; },
  tradingDate: () => "2026-09-28",
});
const ready = source.ensure("taiex");
listener({ type: "snapshot", state: { summary: { open: 24900 }, trend: [{ minute: 540, price: 24900 }] } });
await ready;
const frame = (minute, price) => ({ payload: { summary: { open: 24900, current: price }, trend: { point: { minute, price } } } });
listener({ type: "batch", deltas: [frame(541, 24910), frame(542, 24920)], delta: frame(542, 24920) });
assert.deepEqual(source.points("taiex").map((point) => point.minute), [540, 541, 542],
  "every minute a batch carries must reach the overlay, not only the batch's last delta");
listener({ type: "delta", delta: frame(543, 24930) });
assert.deepEqual(source.points("taiex").map((point) => point.minute), [540, 541, 542, 543]);
source.dispose();

// No deadline calls a slow source failed. A late snapshot settles the wait and is announced to the overlays;
// dispose rejects what still waits.
{
  let late = null;
  const quiet = createWorkspaceBenchmarkSource({ subscribeView: (_spec, callback) => { late = callback; return () => {}; }, tradingDate: () => "2026-09-28" });
  const announced = [];
  quiet.subscribe((kind) => announced.push(kind));
  const waiting = quiet.ensure("txf");
  await new Promise((resolve) => setTimeout(resolve, 30));
  late({ type: "snapshot", state: { summary: { open: 23000 }, trend: [{ minute: 540, price: 23000 }] } });
  await waiting;
  assert.deepEqual(announced, ["txf"], "the late arrival is announced");
  const pending = quiet.ensure("taiex");
  quiet.dispose();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(quiet.ensure("taiex"), /disposed/);
}
// A control event is not data: an error records why and keeps waiting for the snapshot, a gap changes nothing.
{
  let deliver = null;
  const failing = createWorkspaceBenchmarkSource({ subscribeView: (_spec, callback) => { deliver = callback; return () => {}; }, tradingDate: () => "2026-09-28" });
  let settled = false;
  const waiting = failing.ensure("taiex").then(() => { settled = true; });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    deliver({ type: "error", error: "subscription refused" });
    deliver({ type: "gap", expected_sequence: 3, received_sequence: 5 });
  } finally {
    console.error = originalError;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, "an error does not settle the wait as if data had arrived");
  assert.equal(failing.snapshot().taiex.loadedAt, 0, "an error is not a load");
  assert.equal(failing.snapshot().taiex.error, "subscription refused");
  assert.equal(errors.length, 1, "the error is recorded once");
  deliver({ type: "snapshot", state: { summary: { open: 1 }, trend: [] } });
  await waiting;
  assert.equal(failing.snapshot().taiex.error, null, "the snapshot after it clears the error");
  failing.dispose();
}
console.log("renderer workspace benchmark batch contract passed");
