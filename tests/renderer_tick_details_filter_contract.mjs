// 成交明細 過濾: trades below N (the instrument's own unit) are hidden from the page on screen and the title bar says
// how many; in a dashboard slot the controls sit in the slot's actions box (the component's own title strip is hidden
// there), and the box is emptied when the component goes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ComponentHost } from "../ui/renderer/js/core/component_host.js";
import { TickDetailsComponent } from "../ui/renderer/js/core/components/tick_details_component.js";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";

const ticks = [{ volume: 3 }, { volume: 15 }, { volume: 50 }, { volume: "20" }];
const component = new TickDetailsComponent();
assert.deepEqual(component._filterRows(ticks), { rows: ticks, hidden: 0 }, "no filter: every trade");
component.minVolume = 15;
const filtered = component._filterRows(ticks);
assert.deepEqual(filtered.rows.map((tick) => Number(tick.volume)), [15, 50, 20]);
assert.equal(filtered.hidden, 1);

// The slot's actions box reaches the component and is emptied when it goes.
let mountedWith = null;
const actionsHost = { children: ["controls"], replaceChildren(...nodes) { this.children = nodes; } };
const registry = { get: () => ({ create: () => ({ mount(args) { mountedWith = args; }, destroy() {} }) }), supports: () => true };
const host = { innerHTML: "", dataset: {}, replaceChildren() {} };
const componentHost = new ComponentHost({ host, hostId: "h", registry, actionsHost, context: { id: "c", mode: "live", supports: () => true } });
componentHost.mount("tickDetails");
assert.equal(mountedWith.actionsHost, actionsHost);
componentHost.switchComponent("orderbook");
assert.deepEqual(actionsHost.children, [], "the previous component's controls leave with it");
// A mount that moved its controls there and then failed leaves nothing behind either.
const failing = { get: () => ({ create: () => ({ mount({ actionsHost: box }) { box.replaceChildren("filter"); throw new Error("refresh failed"); }, destroy() {} }) }), supports: () => true };
const failedHost = new ComponentHost({ host: { innerHTML: "", dataset: {}, replaceChildren() {} }, hostId: "f", registry: failing, actionsHost,
  context: { id: "c", mode: "live", supports: () => true } });
const quiet = console.error; console.error = () => {};
try { failedHost.mount("tickDetails"); } finally { console.error = quiet; }
assert.deepEqual(actionsHost.children, [], "a failed mount's controls are removed");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
assert.match(read("ui/renderer/js/core/tabbed_component_host.js"), /actionsHost: this\.header\.querySelector\('\[data-role="slot-actions"\]'\)/);
assert.match(readFutuComponentSources(), /actionsHost:this\.actionsHost/, "the Futu list gets the box too");

console.log("renderer tick details filter contract passed");
