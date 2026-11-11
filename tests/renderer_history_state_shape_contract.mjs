// 歷史回放 state has one declared shape: the factory names every field, the live objects are sealed (a field nobody
// declared throws where it is written), and every field the renderer reads or writes is declared.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window ??= { addEventListener() {}, desktopAPI: {} };
globalThis.document ??= { getElementById: () => null, addEventListener() {} };
const { createHistoryState, historyState, historyPage } = await import("../ui/renderer/js/features/history/history_state.js");

assert.ok(Object.isSealed(historyState) && Object.isSealed(historyPage));
assert.throws(() => { historyState.engineReplayUnavailable = true; }, TypeError);
assert.throws(() => { historyPage.somethingNew = 1; }, TypeError);
const fresh = createHistoryState();
assert.notEqual(fresh, historyState);
assert.deepEqual(Object.keys(fresh).sort(), Object.keys(historyState).sort());

// Every historyState.<field> / historyPage.<field> in the renderer is declared.
const root = fileURLToPath(new URL("../ui/renderer/js/", import.meta.url));
const files = fs.readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".js"));
const used = { historyState: new Set(), historyPage: new Set() };
for (const name of files) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  for (const [, owner, field] of text.matchAll(/\b(historyState|historyPage)\.([A-Za-z_]\w*)/g)) used[owner].add(field);
}
const missingState = [...used.historyState].filter((field) => !(field in historyState));
const missingPage = [...used.historyPage].filter((field) => !(field in historyPage));
assert.ok(used.historyState.size > 20, "the renderer sources were read");
assert.deepEqual(missingState, [], "historyState fields used but not declared in createHistoryState()");
assert.deepEqual(missingPage, [], "historyPage fields used but not declared");

console.log("renderer history state shape contract passed");
