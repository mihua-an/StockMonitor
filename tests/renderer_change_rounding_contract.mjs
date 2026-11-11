import assert from "node:assert/strict";
import { roundedChange } from "../ui/renderer/js/core/components/product_quote_header.js";

// A float remainder (current - reference = -1e-12) printed a green "-0.00%".
const raw = 10.1 - 10.100000000001;
assert.ok(raw < 0 && raw.toFixed(2) === "-0.00", "the bug's own input");
assert.equal(Object.is(roundedChange(raw), 0), true, "rounds to +0, so colour is flat and the sign is +");
assert.equal(roundedChange(-0.004), 0);
assert.equal(roundedChange(-0.006), -0.01);
assert.equal(roundedChange(1.234), 1.23);
console.log("change rounding contract passed");
