// One shared ResizeObserver watches every element whose size the renderer reads (core/element_size.js). Several owners
// may watch one element -- a trend canvas: its component redraws on a resize, the hover card follows it -- so each
// holds a lease and the element is watched until the last one is released: one owner leaving never stops another.
import assert from "node:assert/strict";

const observed = new Set();
let deliver = null;
globalThis.ResizeObserver = class {
  constructor(callback) { deliver = callback; }
  observe(element) { observed.add(element); }
  unobserve(element) { observed.delete(element); }
};
const { elementSize, holdElementSize, onElementResize } = await import("../ui/renderer/js/core/element_size.js");

const element = (width, height) => ({ getBoundingClientRect: () => ({ width, height }) });
const resize = (target, width, height) => deliver([{ target, borderBoxSize: [{ inlineSize: width, blockSize: height }] }]);

const canvas = element(300, 200);
const component = [], card = [];
const stopComponent = onElementResize(canvas, (size) => component.push(size.width));
const stopCard = onElementResize(canvas, (size) => card.push(size.width));
assert.ok(observed.has(canvas));
resize(canvas, 320, 200);
assert.deepEqual([component, card], [[320], [320]]);

stopComponent();
stopComponent();   // releasing twice is one release
assert.ok(observed.has(canvas), "the other subscriber still holds the element");
resize(canvas, 340, 200);
assert.deepEqual([component, card], [[320], [320, 340]], "the remaining subscriber still hears resizes");
assert.equal(elementSize(canvas).width, 340);

const hold = holdElementSize(canvas);
stopCard();
assert.ok(observed.has(canvas), "a reader's hold keeps the size current");
resize(canvas, 360, 200);
assert.equal(elementSize(canvas).width, 360);
hold();
assert.ok(!observed.has(canvas), "the last lease released stops watching the element");

// A new owner after that starts from a fresh measure.
const again = onElementResize(canvas, () => {});
assert.ok(observed.has(canvas));
assert.equal(elementSize(canvas).width, 300, "measured again from the element");
again();
assert.ok(!observed.has(canvas));

// A listener that throws is recorded and does not stop the others.
const other = element(10, 10);
const heard = [];
const errors = [];
const realError = console.error;
console.error = (...args) => errors.push(args);
try {
  const a = onElementResize(other, () => { throw new Error("boom"); });
  const b = onElementResize(other, (size) => heard.push(size.width));
  resize(other, 20, 10);
  assert.deepEqual(heard, [20]);
  assert.equal(errors[0]?.[0], "[element size] resize listener failed");
  a(); b();
} finally {
  console.error = realError;
}
console.log("renderer element size lease contract passed");
