import assert from "node:assert/strict";

let fetchCount = 0;
globalThis.window = { desktopAPI: { sourceSettings: { enabled_sources: ["shioaji"], sources: {} } }, dispatchEvent() {} };
globalThis.CustomEvent = class {};
globalThis.fetch = async () => { fetchCount += 1; throw new Error("selection must not call Python"); };
const { SearchFocusController } = await import("../ui/renderer/js/features/realtime/search_focus_controller.js");

const selected = [];
let releaseFirst;
const firstIntent = new Promise((resolve) => { releaseFirst = resolve; });
const controller = new SearchFocusController({
  onIntent: async (item) => { if (item.code === "2330") await firstIntent; },
  onSelect: (item) => selected.push(item.code),
});
const first = controller.select({ code: "2330" });
const second = controller.select({ code: "2344" });
releaseFirst();
const [firstResult] = await Promise.all([first, second]);
assert.equal(firstResult.stale, true, "the superseded selection answers stale");
assert.equal(controller.activeCode, "2344");
assert.deepEqual(selected, ["2344"], "only the newest selection may update the UI");
await controller.clear({ notify: false });
assert.equal(controller.activeCode, "");
assert.equal(fetchCount, 0, "selection and clear stay off the Python REST hot path");
controller.destroy();
assert.equal(await controller.select({ code: "2330" }), null, "a destroyed controller selects nothing");
console.log("search focus uses last-intent-wins without Python live REST");
