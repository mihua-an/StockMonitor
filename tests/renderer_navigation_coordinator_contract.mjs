// Page navigation runs one at a time and the newest wins: a running navigation learns it was superseded (so it stops
// before committing), queued superseded ones never run, and a failure reaches its own caller without breaking the next.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNavigationCoordinator } from "../ui/renderer/js/features/navigation/navigation_coordinator.js";

const ran = [];
const gates = new Map();
const committed = [];
const coordinator = createNavigationCoordinator(async (page, _options, isCurrent) => {
  ran.push(page);
  await new Promise((resolve) => gates.set(page, resolve));
  if (!isCurrent()) return { superseded: true };
  if (page === "broken") throw new Error("page failed");
  committed.push(page);
  return { page };
});

const a = coordinator.navigate("history");
await Promise.resolve();
const b = coordinator.navigate("account");
const c = coordinator.navigate("settings");
gates.get("history")();
assert.deepEqual(await a, { superseded: true }, "the running navigation was superseded before it committed");
assert.deepEqual(await b, { superseded: true }, "a queued superseded navigation never runs");
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(ran, ["history", "settings"]);
gates.get("settings")();
assert.deepEqual(await c, { page: "settings" });
assert.deepEqual(committed, ["settings"]);

const broken = coordinator.navigate("broken");
await new Promise((resolve) => setImmediate(resolve));
gates.get("broken")();
await assert.rejects(broken, /page failed/);
const after = coordinator.navigate("realtime");
await new Promise((resolve) => setImmediate(resolve));
gates.get("realtime")();
assert.deepEqual(await after, { page: "realtime" }, "a failed navigation does not block the next");

// app.js routes every navigation through the coordinator, and each event entry ends in a recorded catch.
const app = readFileSync(new URL("../ui/renderer/app.js", import.meta.url), "utf8");
assert.doesNotMatch(app, /[^.\w]switchPage\(button|await switchPage\("history"\)/);
assert.match(app, /void navigateTo\(button\.dataset\.page\)\.catch\(recordUiActionError\("navigate"/);
assert.match(app, /\}\)\(\)\.catch\(recordUiActionError\("open history replay"/);
console.log("renderer navigation coordinator contract passed");
