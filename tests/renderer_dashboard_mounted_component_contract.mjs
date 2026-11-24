import assert from "node:assert/strict";
import { createDocument } from "./lib/mini_dom.mjs";

// mountedDashboardComponent() is how a page reaches a component's own nodes (個股走勢's canvas for the crosshair /
// 查價 pin) without a document id: it answers with the instance a pane is showing right now, and nothing once the
// pane shows another component or the page is gone.
const doc = createDocument();
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

const { componentRegistry } = await import("../ui/renderer/js/core/component_registry.js");
const { mountDashboardPage, selectDashboardComponent, destroyDashboardPage, mountedDashboardComponent } = await import("../ui/renderer/js/core/dashboard_runtime.js");

class Probe {
  constructor(name) { this.name = name; this.canvas = { probe: name }; }
  mount({ host }) { this.host = host; }
  destroy() { this.destroyed = true; }
}
for (const id of ["eventFeed", "tradeDetails"]) {
  componentRegistry.register({
    id, supportedHosts: ["inline"], supportedSlots: ["replayEvent", "workspacePane"], supportedModes: ["replay"], create: () => new Probe(id),
  });
}

const element = doc.createElement("div");
element.className = "history-workspace";
doc.body.appendChild(element);
const context = { id: "probe", mode: "replay", supports: () => true };
mountDashboardPage({ pageId: "history", root: doc.body, context, selector: ".history-workspace",
  workspace: { initialTree: { kind: "pane", id: "replayEvent", size: 1, componentIds: ["eventFeed", "tradeDetails"], activeComponentId: "eventFeed" } } });

const shown = mountedDashboardComponent("history", "eventFeed");
assert.equal(shown?.name, "eventFeed", "the pane's mounted instance is returned");
assert.deepEqual(shown.canvas, { probe: "eventFeed" }, "its own nodes are reached through the instance");
assert.equal(mountedDashboardComponent("history", "tradeDetails"), null, "a component the page is not showing has no instance");
assert.equal(mountedDashboardComponent("realtime", "eventFeed"), null, "another page's lookup does not see this page");

assert.equal(selectDashboardComponent("history", "tradeDetails"), true);
assert.ok(shown.destroyed, "switching the tab destroys the previous instance");
assert.equal(mountedDashboardComponent("history", "eventFeed"), null, "a replaced component is no longer answered for");
assert.equal(mountedDashboardComponent("history", "tradeDetails")?.name, "tradeDetails");

destroyDashboardPage("history");
assert.equal(mountedDashboardComponent("history", "tradeDetails"), null, "nothing is answered for a destroyed page");
assert.throws(() => mountDashboardPage({ pageId: "history", root: doc.body, context, selector: ".missing" }), /has no .missing/);
console.log("dashboard mounted-component lookup contract passed");
