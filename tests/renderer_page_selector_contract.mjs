// 成交明細 page selector (user 10-16): 頁碼 with current / total pages, a slider, and « ‹ [page] › » (five pages / one;
// Enter in the box jumps) -- no quick marks, no 跳轉 button. Kept in document.body
// so a narrow list never clips it. The rail's ▲ / page / ▼ always show, even with one page (user 10-16).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const source = read("ui/renderer/js/core/page_rail.js");
const rail = source.slice(source.indexOf("export class PageRailController"));
assert.match(rail, /doc\.body\.appendChild\(this\.popup\)/, "the selector lives in document.body");
assert.match(rail, /this\.popup\?\.remove\(\)/, "and leaves with the controller");
assert.doesNotMatch(rail, /stack\.hidden|data-page-rail-stack hidden/, "the page controls are never hidden");
assert.match(rail, /<span>頁碼<\/span><b data-page-selector-summary>1 \/ 1<\/b>/, "the title shows current / total pages");
assert.match(rail, /summary\.textContent = `\$\{page\} \/ \$\{totalPages\}`/);
assert.match(rail, /type="range"/, "the original slider");
assert.match(read("ui/renderer/styles/components/data-grid.css"), /\.page-selector-popup \{\s*position: fixed;/);
assert.match(rail, /range\?\.addEventListener\("input", rangeInput\)/, "dragging the slider shows the page it is on");
assert.match(rail, /summary\.textContent = `\$\{value\} \/ \$\{this\.vm\.totalPages\}`/, "dragging shows the page under the slider of the total");
for (const move of ["-5", "-1", "1", "5"]) assert.match(rail, new RegExp(`data-page-move="${move}"`));
assert.doesNotMatch(rail, /data-page-mark|data-page-selector-go|跳轉/, "no quick marks, no 跳轉 button");
assert.match(rail, /if \(move\) this\.request\(this\.vm\.page \+ move\)/, "past either end, request() clamps to the first / last page");
assert.match(rail, /event\.key === "Enter"/, "Enter in the box jumps");
assert.match(rail, /const popupWidth = Math\.max\(POPUP_MIN_WIDTH, Math\.round\(list\.width - 2 \* gap\)\)/, "the selector is as wide as the list");
console.log("renderer page selector contract passed");
