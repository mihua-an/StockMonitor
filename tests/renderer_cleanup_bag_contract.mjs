import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// A component's mounted resources are released together, newest first; one release that throws is logged with the
// owner and the rest still run.
const warnings = [];
console.warn = (...args) => warnings.push(String(args[0]));
const frames = new Map();
let nextFrame = 1;
globalThis.requestAnimationFrame = (fn) => { frames.set(nextFrame, fn); return nextFrame++; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
const { CleanupBag } = await import("../ui/renderer/js/core/cleanup_bag.js");

const order = [];
const target = { listeners: new Set(), addEventListener(type, fn) { this.listeners.add(fn); }, removeEventListener(type, fn) { this.listeners.delete(fn); } };
const bag = new CleanupBag("test panel");
bag.push(() => order.push("first"), undefined, null);
bag.listen(target, "click", () => {});
const observer = bag.observe({ disconnect: () => order.push("observer") });
bag.frame(() => order.push("frame ran"));
bag.child({ destroy() { order.push("child"); } });
bag.push(() => { throw new Error("boom"); });
bag.push(() => order.push("last"));
assert.equal(target.listeners.size, 1);
assert.ok(observer.disconnect);
assert.equal(bag.size, 7, "a missing release is not registered");
bag.release();
assert.deepEqual(order, ["last", "child", "observer", "first"], "newest first; the throwing one does not stop the rest");
assert.equal(target.listeners.size, 0, "the listener is removed");
assert.equal(frames.size, 0, "the pending frame is cancelled");
assert.deepEqual(warnings, ["[test panel: cleanup] failed"]);
assert.equal(bag.size, 0);
bag.release();
assert.equal(order.length, 4, "a second release runs nothing again");

// The components use it: no cleanup array and try/catch loop of their own.
const dir = new URL("../ui/renderer/js/core/components/", import.meta.url);
for (const name of readdirSync(dir).filter((file) => file.endsWith(".js"))) {
  const source = readFileSync(new URL(name, dir), "utf8");
  assert.doesNotMatch(source, /this\.cleanup\s*=\s*\[\]|this\.cleanup\.splice\(/, `${name} keeps its resources in a CleanupBag`);
}
console.log("renderer cleanup bag contract passed");
