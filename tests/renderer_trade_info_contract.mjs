// trade_info ("數量@價格" tokens joined by "_") has one reader: each token keeps its raw text, numbers and errors; the
// day table draws the valid fills, the editor shows every token as stored, and both apply the same validity rule.
import assert from "node:assert/strict";

globalThis.window ??= { addEventListener() {}, desktopAPI: {} };
globalThis.document ??= { getElementById: () => null, addEventListener() {}, querySelector: () => null };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const { parseTradeInfo, parseTradeFill, formatTradeInfo } = await import("../ui/renderer/js/features/account/trade_info.js");
const { tradeInfoToFillRows } = await import("../ui/renderer/js/features/account/trade_editor_form.js");
const { tradeFillItems } = await import("../ui/renderer/js/features/account/daily_pairs_view.js");

const parsed = parseTradeInfo(" 1000@52.3_500@52.40 _abc@1_200@_@3_7@8@9_");
assert.equal(parsed.valid, false);
assert.deepEqual(parsed.fills.map((f) => [f.raw, f.qty, f.price, f.errors]), [
  ["1000@52.3", 1000, 52.3, []],
  ["500@52.40", 500, 52.4, []],
  ["abc@1", null, 1, ["qty"]],
  ["200@", 200, null, ["price"]],
  ["@3", null, 3, ["qty"]],
  ["7@8@9", 7, 8, ["format"]],
]);
assert.equal(parseTradeInfo("1000@52.3").valid, true);
assert.deepEqual(parseTradeInfo("").fills, []);
assert.deepEqual(parseTradeFill("0", "5").errors, ["qty"]);
assert.deepEqual(parseTradeFill("1e3", "5").errors, ["qty"], "only plain decimals are a quantity");

// The editor shows every token as it was stored (valid or not); the day table draws only the valid ones.
assert.deepEqual(tradeInfoToFillRows("1000@52.3_abc@1_200@"), [
  { qty: "1000", price: "52.3" }, { qty: "abc", price: "1" }, { qty: "200", price: "" },
]);
assert.deepEqual(tradeFillItems({ trade_info: "1000@52.3_abc@1_200@" }), [{ qty: 1000, price: 52.3, amount: 52300 }]);
assert.deepEqual(tradeFillItems({ fills: [{ qty: 1, price: 2, amount: 2 }], trade_info: "9@9" }), [{ qty: 1, price: 2, amount: 2 }]);

assert.equal(formatTradeInfo([{ qtyText: "1000", priceText: "52.3" }, { qtyText: "500", priceText: "52.40" }]), "1000@52.3_500@52.40");

console.log("renderer trade info contract passed");
