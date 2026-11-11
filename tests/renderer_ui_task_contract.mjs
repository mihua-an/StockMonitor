import assert from "node:assert/strict";

// runUiTask ends every promise a handler starts: a rejection or a synchronous throw is logged with the task's name
// and shown through `show` while the task is current; a superseded task's failure is logged and not shown.
const logged = [];
console.error = (...args) => logged.push(String(args[0]));
const { runUiTask } = await import("../ui/renderer/js/core/ui_task.js");

const shown = [];
assert.equal(await runUiTask("T_REJECT", async () => { throw new Error("boom"); }, { fallback: "失敗", show: (text) => shown.push(text) }), undefined);
assert.equal(await runUiTask("T_THROW", () => { throw Object.assign(new Error("x"), { userMessage: "說明" }); }, { show: (text) => shown.push(text) }), undefined);
await runUiTask("T_STALE", Promise.reject(new Error("late")), { show: (text) => shown.push(text), isCurrent: () => false });
assert.deepEqual(shown, ["失敗", "說明"]);
assert.deepEqual(logged.map((line) => line.split("]")[0]), ["[T_REJECT", "[T_THROW", "[T_STALE"]);
assert.equal(await runUiTask("T_OK", async () => 7), 7);
console.log("renderer ui task contract passed");
