// Behavioral replacement for the change-format half of
// test_frontend_display_authority.py::
//   test_futures_header_has_one_dom_writer_and_one_change_format
//
// Invariant under test: TrendChartComponent's single header writer
// (TrendHeaderPresenter.syncHeader) renders every product's price change, futures included,
// in ONE format "delta pct%" (product_quote_header.js formatQuoteChange: 價格 漲跌 漲跌幅, as the replay cards; no
// futures-only "delta / (pct%)" slash form, at the user's request) -- computed from real numbers
// by the real presenter, not asserted as a hardcoded template
// string.
import assert from "node:assert/strict";

// The real presenter (core/components/trend_header_presenter.js), attached to a host of fake nodes.
globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
const { TrendHeaderPresenter } = await import("../ui/renderer/js/core/components/trend_header_presenter.js");

function makeNode() {
  const classes = new Set();
  return {
    textContent: "",
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toggle: (n, on) => { if (on ?? !classes.has(n)) classes.add(n); else classes.delete(n); return classes.has(n); },
    },
  };
}

function renderChange(variant, current, reference) {
  const nodes = {
    ".product-quote-name": makeNode(), ".product-quote-code": makeNode(),
    ".quote-main-price": makeNode(), ".quote-change": makeNode(),
  };
  const presenter = new TrendHeaderPresenter();
  presenter.attach({ querySelector: (sel) => nodes[sel] || null }, { variant });
  // 漲跌 / 漲幅 arrive in the view model (Market Runtime's); the presenter formats them.
  const metrics = { change: current - reference, changePct: (current - reference) / reference * 100 };
  presenter.syncHeader({ currentPrice: current, prevClose: reference, metrics, symbol: variant === "futures" ? "TXFR1" : "2330" });
  return nodes[".quote-change"].textContent;
}

const futuresUp = renderChange("futures", 21050, 21000);
const futuresDown = renderChange("futures", 20950, 21000);
const stockUp = renderChange("stock", 105, 100);

// One format for every variant; the futures slash form is gone.
for (const [label, text] of [["futures up", futuresUp], ["futures down", futuresDown], ["stock up", stockUp]]) {
  assert.match(text, /^\d+\.\d{2}\(\d+\.\d{2}%\)$/, `${label}: 'delta pct%'`);
  assert.ok(!text.includes("/"), `${label}: no slash`);
}
assert.ok(![futuresUp, futuresDown, stockUp].some((text) => /[+-]/.test(text)), "the colour alone tells the direction");

console.log("futures header change-format contract passed");
