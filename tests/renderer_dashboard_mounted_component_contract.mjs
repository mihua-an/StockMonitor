import assert from "node:assert/strict";
import { createDocument } from "./lib/mini_dom.mjs";

// mountedDashboardComponent() is how a page reaches a component's own nodes (個股走勢's canvas for the crosshair /
// 查價 pin) without a document id: it answers with the instance the slot is showing right now, and nothing once the
// slot shows another component or the page is gone.
const doc = createDocument();
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { componentRegistry } = await import("../ui/renderer/js/core/component_registry.js");
const { mountDashboardPage, switchDashboardSlot, destroyDashboardPage, mountedDashboardComponent } = await import("../ui/renderer/js/core/dashboard_runtime.js");

class Probe {
  constructor(name) { this.name = name; this.canvas = { probe: name }; }
  mount({ host }) { this.host = host; }
  destroy() { this.destroyed = true; }
}
// 歷史回放's replayEvent: a fixed, untabbed slot (its default is eventFeed).
for (const id of ["eventFeed", "tradeDetails"]) {
  componentRegistry.register({
    id, supportedHosts: ["inline"], supportedSlots: ["replayEvent"], supportedModes: ["replay"], create: () => new Probe(id),
  });
}

const slot = doc.createElement("div");
slot.dataset.componentSlot = "replayEvent";
doc.body.appendChild(slot);
const context = { id: "probe", mode: "replay", supports: () => true };
mountDashboardPage({ pageId: "history", root: doc.body, context });

const shown = mountedDashboardComponent("history", "eventFeed");
assert.equal(shown?.name, "eventFeed", "the slot's mounted instance is returned");
assert.deepEqual(shown.canvas, { probe: "eventFeed" }, "its own nodes are reached through the instance");
assert.equal(mountedDashboardComponent("history", "tradeDetails"), null, "a component the page is not showing has no instance");
assert.equal(mountedDashboardComponent("realtime", "eventFeed"), null, "another page's lookup does not see this page");

const originalWarn = console.warn;
console.warn = () => {};
try { switchDashboardSlot("history", "replayEvent", "tradeDetails"); } finally { console.warn = originalWarn; }
assert.ok(shown.destroyed, "switching the slot destroys the previous instance");
assert.equal(mountedDashboardComponent("history", "eventFeed"), null, "a replaced component is no longer answered for");
assert.equal(mountedDashboardComponent("history", "tradeDetails")?.name, "tradeDetails");

destroyDashboardPage("history");
assert.equal(mountedDashboardComponent("history", "tradeDetails"), null, "nothing is answered for a destroyed page");
console.log("dashboard mounted-component lookup contract passed");
