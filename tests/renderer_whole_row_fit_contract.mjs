// Whole-row lists (價量, 大單分時) follow their pane: the fit watches the frame (their common parent) and takes the
// pool from it, so a splitter that shortens the pane shrinks the list by whole rows instead of hiding its bottom.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fit = read("ui/renderer/js/core/whole_row_fit.js");
assert.match(fit, /const off = onElementResize\(frame, schedule\)/, "the frame is what is watched");
assert.doesNotMatch(fit, /onElementResize\(flex|onElementResize\(list/, "not the list or the flex part (neither changes size when the pane shrinks)");
assert.match(fit, /const pool = contentHeight\(frame\) - othersHeight\(frame, flex, list\)/);
// What the split depends on besides the frame's size -- the frame's other children (a note that arrives under the list)
// and the flex part's rows (minFlex: a 大單分時 bucket row that grew after the first measurement cut the list's last
// row, 10-19) -- is watched too, each one's size and which ones there are.
assert.match(fit, /for \(const child of \[\.\.\.frame\.children, \.\.\.flex\.children\]\)/);
assert.match(fit, /next\.set\(child, watched\.get\(child\) \|\| onElementResize\(child, schedule\)\)/);
assert.match(fit, /children\?\.observe\(frame, \{ childList: true \}\)/);
assert.match(fit, /children\?\.observe\(flex, \{ childList: true \}\)/);
assert.doesNotMatch(read("ui/renderer/js/core/components/trade_flow_component.js"), /fittedBucketCount/, "no second refit path beside the fit's own");
assert.match(fit, /if \(child === flex \|\| child === list\) continue;/, "never the list or the flex part, whose heights the fit writes");
// Row pitches are the CSS row heights, not a measurement that may read the placeholder row.
assert.match(read("ui/renderer/js/core/components/price_flow_component.js"), /rowPitch: \(\) => ROW_PITCH,/);
assert.match(read("ui/renderer/js/core/components/trade_flow_component.js"), /rowPitch: \(\) => LARGE_ORDER_ROW_PITCH,/);
console.log("renderer whole row fit contract passed");
