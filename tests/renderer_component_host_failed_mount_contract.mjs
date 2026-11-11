import assert from "node:assert/strict";
import { ComponentHost } from "../ui/renderer/js/core/component_host.js";

// A mount that subscribes and then throws must not leave the subscription behind: the instance is never stored, so
// only the failure path itself can reach it (host.destroy() cannot).
const listeners = new Set();
let destroyCalls = 0;
const registry = {
  get: () => ({
    create: () => ({
      mount() { listeners.add("footer"); throw new Error("DOM not ready"); },
      destroy() { destroyCalls += 1; listeners.delete("footer"); },
    }),
  }),
  supports: () => true,
};
const host = { innerHTML: "", dataset: {}, replaceChildren() { this.innerHTML = ""; } };
const originalError = console.error;
console.error = () => {};
try {
  const componentHost = new ComponentHost({ host, hostId: "h", registry, context: { id: "c", mode: "live", supports: () => true } });
  assert.equal(componentHost.mount("trend"), null);
  assert.equal(destroyCalls, 1, "the partially mounted instance is destroyed");
  assert.equal(listeners.size, 0, "nothing it acquired is left behind");
  assert.match(host.innerHTML, /Component failed/);
} finally {
  console.error = originalError;
}
console.log("component host failed-mount contract passed");
