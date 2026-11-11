// A 商品頁設定 window sends only what it changed (watch_page_ops.js -> POST /api/subscriptions/ops): the operations
// from the pages it loaded to its draft, never the whole list.
import assert from "node:assert/strict";

const { draftOps, opsBatch } = await import("../ui/renderer/js/features/watch_pages/watch_page_ops.js");
const { normalizePages } = await import("../ui/renderer/js/features/watch_pages/watch_page_draft.js");

const base = normalizePages([
  { id: "p1", name: "台股", source: "shioaji", items: [{ code: "2330" }, { code: "2317" }, { code: "2454", upper_alert: "1500" }] },
  { id: "p2", name: "美股", source: "futu", items: [{ code: "US.AAPL" }] },
]);
assert.deepEqual(draftOps(base, base), [], "nothing changed: nothing sent");

const draft = normalizePages([
  { id: "p2", name: "美股2", source: "futu", items: [{ code: "US.AAPL" }] },
  { id: "p1", name: "台股", source: "shioaji", items: [{ code: "2454", upper_alert: "1600" }, { code: "2330" }, { code: "2603", name: "長榮" }] },
  { id: "p3", name: "新頁", source: "shioaji", items: [{ code: "1101", lower_alert: "30" }] },
]);
assert.deepEqual(draftOps(base, draft), [
  { op: "page.rename", page_id: "p2", name: "美股2" },
  { op: "item.remove", page_id: "p1", code: "2317" },
  // Only the code: a product's name is the catalog's, never sent to be written with the pages (D03-05).
  { op: "item.add", page_id: "p1", code: "2603", after_code: "2330" },
  { op: "item.order", page_id: "p1", codes: ["2454", "2330", "2603"] },
  { op: "item.alert", page_id: "p1", code: "2454", lower: "", upper: "1600" },
  { op: "page.add", page_id: "p3", name: "新頁", source: "shioaji", after: "p1" },
  { op: "item.add", page_id: "p3", code: "1101", after_code: "" },
  { op: "item.alert", page_id: "p3", code: "1101", lower: "30", upper: "" },
  { op: "page.order", page_ids: ["p2", "p1", "p3"] },
]);

// A removed page is one operation; an item added at the end with no reorder sends no order.
const fewer = normalizePages([{ id: "p1", name: "台股", source: "shioaji", items: [...base[0].items, { code: "2882" }] }]);
assert.deepEqual(draftOps(base, fewer), [
  { op: "page.remove", page_id: "p2" },
  { op: "item.add", page_id: "p1", code: "2882", after_code: "2454" },
]);

const one = opsBatch([{ op: "page.remove", page_id: "p2" }]);
const two = opsBatch([{ op: "page.remove", page_id: "p2" }]);
assert.ok(one.batch_id && one.batch_id !== two.batch_id && one.client === "watch_pages_window");
console.log("renderer watch page ops contract passed");
