import assert from "node:assert/strict";
import fs from "node:fs";

// Rules that selected nothing, repeated another rule or hard-wrote a token: each was one place the stylesheet said a
// thing that did not happen (an `.active` product row, an outline colour without an outline, a `disabled` class no
// rule reads), or one more place to change (a selector split in two or three, a colour or z-index written out).
const css = (file) => fs.readFileSync(new URL(`../ui/renderer/styles/${file}`, import.meta.url), "utf8");
const js = (file) => fs.readFileSync(new URL(`../ui/renderer/js/${file}`, import.meta.url), "utf8");
const count = (text, pattern) => (text.match(pattern) || []).length;

const productList = css("components/product-list.css");
assert.doesNotMatch(productList, /tbody tr\.active/, "product rows carry product-list-selected-row, never .active");
assert.doesNotMatch(productList, /product-list-selected-row td \{\s*outline-color/, "no outline colour on a cell without an outline");

const account = css("pages/account.css");
assert.doesNotMatch(account, /\.account-market-switch\.is-invisible/, "base.css .is-invisible already hides it");
assert.equal(count(account, /^\.account-daytrade-period-grid \{/gm), 1, "the period grid is one rule (outside its media query)");

assert.doesNotMatch(js("features/account/trade_editor_form.js"), /classList\.toggle\("disabled"/, "no class that no rule reads");
assert.match(css("components/paper-order-popover.css"), /\.paper-order-popover-message\.error \{\s*color: var\(--status-error\);/,
  "an error message is the status colour, not the market's up colour");

assert.match(css("tokens.css"), /--z-shutdown-overlay: 2147483647;/);
for (const file of ["layout/app-shell.css"]) assert.doesNotMatch(css(file), /z-index: 2147483647/, `${file} reads the z-index token`);
console.log("renderer css dead rules contract passed");
