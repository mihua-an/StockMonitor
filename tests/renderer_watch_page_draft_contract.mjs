// The watch pages draft: items are the only shape (no stored code list), every operation returns new values without
// touching its input, and normalizing what the store sent records nothing for valid pages.
import assert from "node:assert/strict";

const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));
const d = await import("../ui/renderer/js/features/watch_pages/watch_page_draft.js");

const stored = [{ id: "p1", name: "A", source: "shioaji", codes: ["2330", "2317"], count: 2,
  items: [{ code: "2330", name: "台積電" }, { code: "2317", name: "鴻海" }, { code: "2330" }] }];
const pages = d.normalizePages(stored);
assert.deepEqual(Object.keys(pages[0]).sort(), ["id", "items", "market", "name", "source"], "no codes / count kept");
assert.deepEqual(d.pageCodes(pages[0]), ["2330", "2317"], "items deduplicated, codes derived");
for (let i = 0; i < 3; i += 1) d.normalizePages(d.normalizePages(stored));
assert.deepEqual(warnings, [], "re-normalizing its own pages refuses nothing");
d.normalizeItem("2330");
assert.equal(warnings.length, 1, "a bare code is refused and recorded");

const frozen = structuredClone(pages);
const moved = d.moveItem(pages[0], 0, 1);
assert.deepEqual(d.pageCodes(moved), ["2317", "2330"]);
assert.equal(d.moveItem(pages[0], 0, 5), pages[0], "an out-of-range move is no change");
assert.deepEqual(d.pageCodes(d.removeItemAt(pages[0], 0)), ["2317"]);
const { page: added, added: wasAdded } = d.addOrMergeItem(pages[0], d.normalizeItem({ code: "2454", name: "聯發科" }));
assert.equal(wasAdded, true);
assert.deepEqual(d.pageCodes(added), ["2330", "2317", "2454"]);
const withAlert = d.setAlert(pages, "2330", "upper_alert", "1100");
assert.equal(withAlert[0].items[0].upper_alert, "1100");
const merged = d.addOrMergeItem(withAlert[0], d.normalizeItem({ code: "2330", name: "TSMC", industry_name: "半導體", upper_alert: "1" }));
assert.equal(merged.added, false);
assert.equal(merged.page.items[0].industry_name, "半導體");
assert.equal(merged.page.items[0].upper_alert, "1100", "a merge keeps the page's own alert");
assert.equal(d.enrichPage(pages[0], [{ code: "2317", industry_name: "電子" }]).items[1].industry_name, "電子");
assert.deepEqual(d.moveInList([1, 2, 3], 2, 0), [3, 1, 2]);
assert.deepEqual(pages, frozen, "no operation changed its input");

console.log("renderer watch page draft contract passed");
