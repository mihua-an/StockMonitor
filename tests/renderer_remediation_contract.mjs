// A window's remediation events (ui/renderer/js/core/remediation.js), the live socket's
// reconnect remediation (market_data/realtime.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installRealtimeHarness } from "./support/realtime_socket_harness.mjs";

const require = createRequire(import.meta.url);
const contract = require("../config/js/remediation_contract.js");
const registry = contract.loadRegistry();

globalThis.performance = { now: () => 0 };
const reported = [];
const pageListeners = {};
const live = installRealtimeHarness({ health: () => null, enabledSources: [],
  window: { addEventListener(name, fn) { pageListeners[name] = fn; } },
  desktopAPI: { reportRemediation: (payload) => reported.push(payload) } });
const { sockets, timers } = live;

// The event a renderer hands to main, once main adds `process`, satisfies the writer's contract.
const asWritten = ({ page_instance_id: page, ...fields }) => ({ ...fields, process: { service_id: "renderer:index.html", instance_id: page, pid: 1, runtime: "renderer" } });

const { IDENTITY_FIELDS, beginRemediation, emitRemediation } = await import("../ui/renderer/js/core/remediation.js");
assert.deepEqual([...IDENTITY_FIELDS], registry.identity_fields);
const one = emitRemediation({ component: "t", mechanismId: "renderer.live_ws_reconnect", triggerReason: "remote_close",
  identity: { view_id: "v1", code: "" }, outcome: "suppressed", detail: { nested: { a: 1 }, n: 2 } });
assert.equal(contract.validateEvent(asWritten(reported.at(-1))), null);
assert.equal(one.identity.view_id, "v1");
assert.equal(one.identity.code, null);
assert.equal(typeof one.detail.nested, "string");
const op = beginRemediation({ component: "t", mechanismId: "renderer.live_ws_reconnect", triggerReason: "socket_error" });
op.finish("succeeded", { attempt: 2 });
op.finish("failed");
assert.equal(reported.length, 3, "one started, one terminal");
assert.equal(reported[2].related_upstream_event_id, reported[1].event_id);
assert.equal(contract.validateEvent(asWritten(reported[1])), null);
assert.equal(contract.validateEvent(asWritten(reported[2])), null);
assert.equal(new Set(reported.map((e) => e.page_instance_id)).size, 1, "one instance per page load");

// An unexpected close starts the remediation; the next open ends it, with the attempts it took.
reported.length = 0;
const realtime = await import("../ui/renderer/js/market_data/realtime.js");
realtime.startRealtimeStream(() => {});
sockets[0].open();
assert.equal(reported.length, 0, "the first connect is not a remediation");
sockets[0].drop(1006);
assert.equal(reported.length, 1);
assert.equal(reported[0].mechanism_id, "renderer.live_ws_reconnect");
assert.equal(reported[0].outcome, "started");
assert.equal(reported[0].trigger_reason, "remote_close");
const fire = (delay) => { const entry = [...timers.entries()].reverse().find(([, t]) => t.delay === delay); timers.delete(entry[0]); entry[1].fn(); };
fire(1000);
sockets[1].drop(1006);
assert.equal(reported.length, 1, "a failed retry is not a second remediation");
fire(2000);
sockets[2].open();
assert.equal(reported.length, 2);
assert.equal(reported[1].outcome, "succeeded");
assert.equal(reported[1].attempt, 2);
assert.equal(reported[1].operation_id, reported[0].operation_id);
for (const event of reported) assert.equal(contract.validateEvent(asWritten(event)), null);

// A remediation still open when the page goes away is abandoned, not silent.
sockets[2].drop(1006);
assert.equal(reported.at(-1).outcome, "started");
pageListeners.pagehide();
assert.equal(reported.at(-1).outcome, "abandoned");

// The diagnostics panel has no 補救事件 card (user 10-20): the events stay in Health's ledger and var/logs.
const diagnostics = await import("../ui/renderer/js/core/diagnostics_panel.js");
assert.ok(!("remediationModel" in diagnostics) && !("remediationRowsHtml" in diagnostics));
console.log("renderer remediation contract passed");
