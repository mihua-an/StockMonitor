import assert from "node:assert/strict";
import { orderbookSource } from "./lib/orderbook_sources.mjs";

// 買賣報價 font: the fit measured the element's current width. A quantity's box fills its cell, so the
// "fit" was the current size, and drawing at 80% of it shrank the book on every layout until the 8 px floor. The
// text is now measured at a fixed 20 px: the result must not depend on the size it is shown at.
const source = orderbookSource();

const fonts = [];
const context = { font: "", measureText(text) { fonts.push(this.font); return { width: text.length * 10 }; } };
const shownAt = (px) => ({ textContent: "3,116", scrollWidth: 999, style: { fontSize: `${px}px`, fontFamily: "Consolas", fontWeight: "700", letterSpacing: "normal" } });
// The page's measuring canvas and computed style: the node's own font.
globalThis.getComputedStyle = (node) => node.style;
globalThis.document = { createElement: () => ({ getContext: () => context }) };
const { orderbookTextWidthAt20: measure } = await import("../ui/renderer/js/core/components/orderbook_layout.js");
const small = measure(shownAt(8));
const large = measure(shownAt(16));
assert.equal(small, 50, "the text's own width at 20 px, not the element's box (scrollWidth 999)");
assert.equal(small, large, "independent of the size it is shown at: no shrinking feedback");
assert.ok(fonts.every((f) => f.includes(" 20px ") && f.includes("Consolas")), "measured in the node's own font at 20 px");

// The layout from the text: columns sized from the text, the edge columns holding the H/L marker only
// (the diff badge floats over it and the quantity's end), the largest font that fits, and the rest of the
// width to the quantity (its bar) -- never to anything overlapping price.
const { solveOrderBookLayout } = await import("../ui/renderer/js/core/components/orderbook_layout.js");
const base = { rowHeight: 62, price20: 66, qty20: 57, edge20: 12, edgePad: 4, pricePad: 4, qtyPad: 6 };
const at305 = solveOrderBookLayout({ ...base, width: 296 });
const at420 = solveOrderBookLayout({ ...base, width: 411 });
const total = (l) => 2 * (l.columns.edge + l.columns.price + l.columns.qty);
assert.ok(at305.font > 13 && at305.font < at420.font, `a wider book gets larger text: ${at305.font} < ${at420.font}`);
assert.ok(Math.abs(total(at305) - 296) < 0.5, "the columns fill the width exactly");
assert.ok(Math.abs(at305.columns.edge - (12 * 0.86 * at305.font / 20 + 4 + 2)) < 1e-9, "the edge column holds the H/L marker at its font");
// A 260 px book (a user report): reserving a "+999" badge per side (~33 px) cost about 18% of the font.
const at260 = solveOrderBookLayout({ ...base, width: 260 });
const reserved = (260 - (2 * (4 + 4) + 2 * (6 + 4) + 2 * (33 + 2))) / ((2 * 66 + 2 * 57) / 20);
assert.ok(at260.font > reserved * 1.15, `the prices and quantities keep their size on a 260 px book: ${at260.font} vs ${reserved}`);
assert.ok(!source.includes("+999") && !source.includes("measureDiffBadge"), "no width is reserved for the diff badge");
assert.ok(at305.columns.price >= 66 * at305.font / 20 + 4, "the price fits its column");
assert.ok(at305.columns.qty >= 57 * at305.font / 20 + 6, "the quantity fits its column");
assert.equal(solveOrderBookLayout({ ...base, width: 2000 }).font, 28, "never above the cap");
assert.equal(solveOrderBookLayout({ ...base, width: 2000, rowHeight: 30 }).font, 15, "nor above half the row height");
const noEdges = solveOrderBookLayout({ ...base, width: 296, edges: false });
assert.ok(noEdges.font > at305.font && noEdges.columns.edge === 0, "a book without edge columns uses their room");
console.log("renderer orderbook fit font contract ok");
