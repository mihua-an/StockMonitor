// The unsaved state both subscription screens share (subscription_draft.js): only what this window changed becomes
// operations, and another window's save is laid under them (rebase, with applyPageOps applying the page operations
// as settings_api does -- the same cases as tests/test_subscription_ops.py).
import assert from "node:assert/strict";

const d = await import("../ui/renderer/js/features/subscriptions/subscription_draft.js");
const { applyPageOps } = await import("../ui/renderer/js/features/watch_pages/watch_page_ops.js");

// ---- applyPageOps: settings_api's semantics
const pages = [{ id: "p1", name: "台股", source: "shioaji", items: [{ code: "2330" }, { code: "2317" }] }];
const a = applyPageOps(pages, [{ op: "item.add", page_id: "p1", code: "2454", after_code: "2317" }, { op: "item.add", page_id: "p1", code: "2603", after_code: "2454" }]);
const b = applyPageOps(a, [{ op: "item.add", page_id: "p1", code: "2603", after_code: "2317" }, { op: "item.add", page_id: "p1", code: "3008", after_code: "2603" }]);
assert.deepEqual(b[0].items.map((i) => i.code), ["2330", "2317", "2454", "2603", "3008"], "two windows adding both keep their items");
assert.deepEqual(applyPageOps([{ id: "p", source: "shioaji", items: ["A", "B", "N", "C"].map((code) => ({ code })) }],
  [{ op: "item.order", page_id: "p", codes: ["C", "B", "A", "GONE"] }])[0].items.map((i) => i.code), ["C", "B", "N", "A"]);
assert.deepEqual(applyPageOps(pages, [{ op: "item.remove", page_id: "missing", code: "2330" }, { op: "page.rename", page_id: "p1", name: "x" }])[0].name, "x");
assert.deepEqual(pages[0].items.length, 2, "the input is not changed");

// ---- a snapshot and this window's changes as operations
const snapshot = (pagesNow, extra = {}) => ({
  pages: pagesNow,
  preferences: { instruments: [], taiex: true, txf: true, sector: { enabled: true, scope: "related" }, batches: [] },
  instruments: [
    { source: "shioaji", market: "STK", code: "2317", name: "鴻海", pages: ["p1"], owners: ["watchlist"], trade: true, orderbook: true },
    { source: "shioaji", market: "STK", code: "2330", name: "台積電", pages: ["p1"], owners: ["watchlist"], trade: true, orderbook: true,
      futures: { on: false, trade: true, orderbook: true, months: [], category: "CDF", months_listed: ["202611", "202612", "202703"] } },
    { source: "shioaji", market: "FUT", code: "TXF", name: "台指期", pages: ["p1"], owners: ["watchlist"], trade: true, orderbook: true,
      index_futures: { months: [], months_listed: ["202611", "202612", "202701"] } },
    ...(extra.instruments || []),
  ],
  quota: {},
});
const draft = d.createDraft(snapshot(pages));
assert.deepEqual(d.draftOpsOf(draft), [], "nothing changed");
const [r2317, r2330, rTxf] = d.rows(draft);
assert.deepEqual([d.laneOf(draft, rTxf).futures.on, d.laneOf(draft, rTxf).futures.months_listed], [true, ["202611", "202612", "202701"]],
  "an index future's months are its own futures setting, always on");
d.setLane(draft, r2317, "orderbook", false);
d.setFutures(draft, r2330, "on", true);
d.toggleMonth(draft, r2330, "202612");
d.setFutures(draft, r2330, "orderbook", false);
d.setLane(draft, rTxf, "orderbook", false);
d.toggleMonth(draft, rTxf, "202612");
d.setContext(draft, "txf", false);
d.setSector(draft, { enabled: true, scope: "all" });
draft.pages = applyPageOps(draft.pages, [{ op: "item.add", page_id: "p1", code: "2454", after_code: "2317" }]);
// What this window shows of the item it added: the catalog's name from its search. The operation sent carries the
// code only (a product's name is the catalog's, never written with the pages).
draft.pages = draft.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.code === "2454" ? { ...item, name: "聯發科" } : item)) }));
assert.deepEqual(d.laneOf(draft, r2330).futures.months, new Set(["202612"]));
assert.deepEqual(d.draftOpsOf(draft), [
  { op: "item.add", page_id: "p1", code: "2454", after_code: "2317" },
  { op: "instrument.set", source: "shioaji", market: "STK", code: "2317", field: "orderbook", value: false },
  { op: "instrument.set", source: "shioaji", market: "STK", code: "2330", field: "futures", value: true },
  { op: "instrument.set", source: "shioaji", market: "STK", code: "2330", field: "futures_orderbook", value: false },
  { op: "instrument.month", code: "2330", month: "202612", on: true },
  { op: "instrument.set", source: "shioaji", market: "FUT", code: "TXF", field: "orderbook", value: false },
  { op: "instrument.month", code: "TXF", month: "202612", on: true },
  { op: "context.set", field: "txf", value: false },
  { op: "sector.set", enabled: true, scope: "all" },
]);
d.setLane(draft, r2317, "orderbook", true);
assert.ok(!d.draftOpsOf(draft).some((op) => op.code === "2317"), "switched back: nothing to send for it");

// ---- another window saved: its pages under this window's changes; a change it already made is dropped
const others = [{ id: "p1", name: "台股", source: "shioaji", items: [{ code: "2330" }, { code: "2317" }, { code: "2603" }] }];
const theirs = snapshot(others, { instruments: [{ source: "shioaji", market: "STK", code: "2603", name: "長榮", pages: ["p1"], owners: ["watchlist"], trade: true, orderbook: true }] });
theirs.instruments[1] = { ...theirs.instruments[1], futures: { ...theirs.instruments[1].futures, on: true } };
const rebased = d.rebase(draft, theirs);
assert.deepEqual(rebased.pages[0].items.map((i) => i.code), ["2330", "2317", "2454", "2603"], "their 2603 and my 2454");
assert.equal(rebased.pages[0].items.find((i) => i.code === "2454").name, "聯發科", "my unsaved item still shows its name");
const ops = d.draftOpsOf(rebased).map((op) => `${op.op}:${op.code || op.field || ""}:${op.field || ""}`);
assert.ok(!ops.includes("instrument.set:2330:futures"), "期貨 on is already theirs: dropped");
assert.ok(ops.includes("instrument.set:2330:futures_orderbook") && ops.includes("instrument.month:2330:"), "my other changes stay");
console.log("renderer subscription draft contract passed");
