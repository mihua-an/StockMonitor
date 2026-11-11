import assert from "node:assert/strict";
import fs from "node:fs";
import { readRendererCss } from "./lib/renderer_css.mjs";

// Each of these primitives has one owner: a spinner, a date menu, a stepper, a filter pill and a status badge are
// drawn by the shared class, and the pages only place them.
const css = readRendererCss().replace(/\/\*[\s\S]*?\*\//g, "");
const read = (path) => fs.readFileSync(new URL(`../ui/renderer/${path}`, import.meta.url), "utf8");
const bodyOf = (selector) => {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim() === selector);
  assert.equal(found.length, 1, `one rule for ${selector}`);
  return found[0][2];
};

// The spinner: one rule, the 資料抓取中 colours, one speed, one keyframes.
const spinner = bodyOf(".loading-spinner");
assert.match(spinner, /border:\s*2px solid var\(--sky-200x-a28\)/);
assert.match(spinner, /border-top-color:\s*var\(--sky-400\)/);
assert.match(spinner, /animation:\s*loading-spin \.8s linear infinite/);
assert.equal([...css.matchAll(/@keyframes\s+[\w-]*spin[\w-]*/g)].length, 1, "one spin keyframes");
assert.ok(!/trend-loading-spinner|pair-replay-spinner|history-product-loading-spin/.test(css), "no spinner of a page's own");

// The date menu: event-feed.css owns the look (歷史回放's values); 歷史回放 only places it.
const option = bodyOf(".event-feed-date-option");
assert.match(option, /height:\s*27px/);
assert.match(option, /font-variant-numeric:\s*tabular-nums/);
assert.ok(!/font-family/.test(option), "the app's font");
assert.match(bodyOf(".event-feed-date-option:hover"), /var\(--surface-tab-active\)/);
assert.match(bodyOf(".event-feed-date-option.active"), /var\(--sky-800x-7\)[\s\S]*font-weight:\s*800/);
assert.ok(!/history-sidebar-date-option/.test(css), "no second option style");
assert.match(read("js/features/history/date_picker.js"), /class="event-feed-date-option/);

// The stepper, its row and the buttons under it are order-ticket's; 模擬帳務's 刪改 card uses them as 下單 does.
assert.ok(!/paper-ledger-step\b|paper-ledger-amount|paper-ledger-link|paper-ledger-actions/.test(css), "no second stepper or button row");
assert.match(read("js/features/realtime/components/paper_ledger_component.js"), /<div class="order-ticket-field">[\s\S]*?<div class="order-ticket-stepper">[\s\S]*?data-ledger-step=/);

// 委託紀錄's filters are the settings pill.
assert.ok(!/account-orders-chip\b/.test(css));
assert.match(read("js/features/account/paper_order_history_view.js"), /class="settings-pill\$\{current === id \? " is-active" : ""\}"/);

// A status badge is settings-badge with a tone, every tone at the same share of its colour.
assert.ok(!/\.dc-status/.test(css), "no status capsule of the data center's own");
for (const tone of ["pass", "warn", "info", "fail"]) {
  assert.match(bodyOf(`.settings-badge.is-${tone}`), /color-mix\(in srgb, var\(--[\w-]+\) 16%, transparent\)/, tone);
}

console.log("renderer shared primitive owners contract passed");
