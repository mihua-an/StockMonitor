import assert from 'node:assert/strict';
import { readRendererCss } from "./lib/renderer_css.mjs";
import { signedValueClass } from "../ui/renderer/js/core/market_color_policy.js";
import { createAccountReadViewPresentation } from "../ui/renderer/js/features/account/read_views.js";

// User decision (11-10): a profit / loss, like every 漲跌 number, is base.css's shared .price-up / .price-down /
// .price-flat (the settings page's up / down colour at regular weight); the account page has no colour classes of
// its own and no fixed literals (some cards once had profit green and loss red, the opposite of the default 紅漲).
const css = readRendererCss().replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector, body }));

function colorRules(pattern) {
  return rules.filter(({ selector, body }) => pattern.test(selector) && /(?<![-\w])color\s*:/.test(body));
}

for (const [pattern, variable] of [[/^\s*\.price-up\s*$/, '--price-up-color'], [/^\s*\.price-down\s*$/, '--price-down-color'], [/^\s*\.price-flat\s*$/, '--price-flat-color']]) {
  const found = colorRules(pattern);
  assert.equal(found.length, 1, `one base rule for ${pattern}`);
  const { body } = found[0];
  assert.match(body.match(/(?<![-\w])color\s*:\s*([^;]+)/)[1], new RegExp(`var\\(${variable}`));
  assert.match(body, /font-weight\s*:\s*400/, `${pattern} is regular weight`);
}

assert.ok(!/account-profit-/.test(css), 'the account page has no profit colour classes of its own');

// The one sign rule: above 0 up, below 0 down, 0 or missing flat; the account's profitClass is that rule.
for (const [value, expected] of [[5, 'price-up'], ['-0.5', 'price-down'], [0, 'price-flat'], [null, 'price-flat'], ['', 'price-flat'], [true, 'price-flat']]) {
  assert.equal(signedValueClass(value), expected, `signedValueClass(${JSON.stringify(value)})`);
}
assert.equal(createAccountReadViewPresentation().profitClass, signedValueClass);
console.log('renderer pnl color contract passed');
