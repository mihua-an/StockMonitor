import assert from "node:assert/strict";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";
import { orderbookSource } from "./lib/orderbook_sources.mjs";

// User report: Futu 買賣報價's code box showed "US.NOK" while Futu 個股走勢 showed "NOK". The shared order
// book mirrored vm.code (the identity) into its box; the Futu adapter now passes the display code as `inputCode`, the
// form its trend header and product list show. Shioaji / TXF pass none, so their box keeps vm.code.
const book = orderbookSource();
assert.match(book, /const code = String\(vm\.inputCode \|\| vm\.code \|\| secondary \|\| ""\)\.trim\(\);\s*if \(secondaryElement\.dataset\.code !== code\) secondaryElement\.dataset\.code = code;/);
const futu = readFutuComponentSources();
assert.match(futu, /update\(\{\.\.\.normalizedBook,inputCode:formatMoomooDisplaySymbol\(code\)\}\)/, "data render");
assert.match(futu, /inputCode:formatMoomooDisplaySymbol\(code\),code,prevClose/, "empty render");
const { formatMoomooDisplaySymbol } = await import("../ui/renderer/js/market_data/moomoo_symbol.js");
assert.equal(formatMoomooDisplaySymbol("US.NOK"), "NOK");
console.log("futu orderbook input code contract passed");
