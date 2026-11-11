import assert from "node:assert/strict";
import { ComponentHost } from "../ui/renderer/js/core/component_host.js";

// An unsupported component id (it comes from the saved layout) and a mount exception's text
// are shown escaped, never interpreted as markup.
const payload = `<img src=x onerror="alert(1)">`;
const host = { innerHTML: "", dataset: {}, replaceChildren() { this.innerHTML = ""; } };
const context = { id: "c", mode: "live", supports: () => true };

const unsupported = new ComponentHost({ host, hostId: "h1", context, registry: { get: () => null, supports: () => false } });
assert.equal(unsupported.mount(payload), null);
assert.doesNotMatch(host.innerHTML, /<img/, "an unknown component id must not become markup");
assert.match(host.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.match(host.innerHTML, /^<div class="dashboard-slot-state"><div class="empty">/, "the frame itself is still markup");

const originalError = console.error;
console.error = () => {};
try {
  const failing = new ComponentHost({ host, hostId: "h2", context, registry: {
    get: () => ({ create: () => ({ mount() { throw new Error(payload); } }) }), supports: () => true } });
  assert.equal(failing.mount("trend"), null);
  assert.doesNotMatch(host.innerHTML, /<img/, "an exception message must not become markup");
  assert.match(host.innerHTML, /Component failed：&lt;img/);
} finally {
  console.error = originalError;
}

// A plain message still reads the same.
const plain = new ComponentHost({ host, hostId: "h3", context: { ...context, supports: () => false }, registry: {
  get: () => ({ requiredCapabilities: ["trend"], create: () => ({}) }), supports: () => true } });
assert.equal(plain.mount("trend"), null);
assert.match(host.innerHTML, /缺少資料能力：trend/);
console.log("component host escape contract passed");
