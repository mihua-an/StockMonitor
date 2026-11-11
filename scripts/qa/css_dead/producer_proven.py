"""Dead declarations proven by the producers: an element carrying class C is always inside ancestor A (read from the
only code that produces C), so a rule `A C...` (more specific) setting the same property always beats `C...`.

Evidence (producer -> structure), 2026-10-18:
  orderbook_component.js:225-233  every orderbook-* (but orderbook-price-cell, also produced by
                                  paper_ledger_component.js) and pv-imbalance sit inside div.orderbook
  orderbook_component.js:230,387  pv-chart / pv-bars / pv-level / pv-stack / pv-in / pv-out inside .pv-imbalance
  product_quote_header.js:18-20   product-quote-identity inside .product-quote-header (its only producer)
  tick_details_component.js:19-22 tick-table-wrap inside .tick-details (its only producer)
  trade_rows.js:54,92             tick-details-large-badge appended in the price cell (a td)
  price_flow_component.js:20-21   price-flow-scroll a direct child of .price-flow-body; price_flow_ladder.js builds
                                  price-flow-table into that body (its only user)
  product_list.js:243-245         product-list-pages / product-list-tools direct children of .product-list-header
  pages/data_center.html:1        section.data-center-page is the page root; data_center.js renders
                                  only into nodes of that page (no body-level nodes)
  pages/account.html:1            div.account-page is the page root; account.js and features/account/* (capital_view,
                                  daytrade_view: imported by account.js only) append nothing to body
  pages/settings.html:1           div.settings-page; settings-card-header produced by settings.html / settings_capital.js
Usage: python producer_proven.py <worktree> [--write]
"""
import re
import sys
from pathlib import Path

W = Path(sys.argv[1])
sys.path.insert(0, str(W / "scripts" / "qa"))
import css_dedupe as d  # noqa: E402

ORDERBOOK = ["orderbook-book-change", "orderbook-qty-bar", "orderbook-qty-text", "orderbook-qty-wrap", "orderbook-table",
             "orderbook-table-wrap", "orderbook-total-bar-wrap", "orderbook-total-bar", "orderbook-total-label",
             "orderbook-total-labels", "orderbook-total-section", "pv-imbalance", "pv-bars", "pv-level", "pv-stack",
             "pv-in", "pv-out"]
DESCENDANT = {c: [".orderbook"] for c in ORDERBOOK}
for c in ["pv-bars", "pv-level", "pv-stack", "pv-in", "pv-out"]:
    DESCENDANT[c] = [".orderbook", ".pv-imbalance"]
DESCENDANT.update({"product-quote-identity": [".product-quote-header"], "tick-table-wrap": [".tick-details"],
                   "tick-details-large-badge": ["td"], "price-flow-table": [".price-flow-body"]})
DESCENDANT.update({c: [".data-center-page"] for c in ["data-center-controls", "data-center-header", "data-center-panel",
    "dc-daily-overview", "dc-daily-overview-wrap", "dc-date-overview-section"]})
DESCENDANT.update({c: [".account-page"] for c in ["account-daily-table", "account-daily-table-wrap",
    "account-daytrade-period-table", "account-daytrade-tabs", "account-home-kpi-card", "account-page-header",
    "account-pair-table", "account-pair-table-wrap", "account-trades-wrap", "finance-section-card", "finance-summary-card",
    "finance-summary-grid", "finance-summary-label", "finance-summary-value"]})
DESCENDANT["settings-card-header"] = [".settings-page"]
CHILD = {"price-flow-scroll": [".price-flow-body"], "product-list-pages": [".product-list-header"],
         "product-list-tools": [".product-list-header"]}

texts, rules, dead0, _ = d.analyse(d.cascade_files())
assert not any(dead0.values()), "run css_dedupe --write first"
parts = lambda r: [p.strip() for p in d._split_top(r.selector, ",") if p.strip()]  # noqa: E731
setters = {}
for r in rules:
    for q in parts(r):
        for x in r.decls:
            setters.setdefault((q, x.prop), []).append(r)


def applies(later, earlier):
    return later.media == earlier.media or (not later.media and not any(m.startswith("@layer") for m in earlier.media))


def beaten(p, prop, r):
    if not re.fullmatch(r"[\w.\-]+(::?[\w-]+)?", p):
        return False                       # one compound only: what it matches is decided by its own classes
    classes = re.findall(r"\.([\w-]+)", p)
    forms = []
    for c in classes:
        forms += [f"{a} {p}" for a in DESCENDANT.get(c, [])] + [f"{a} > {p}" for a in CHILD.get(c, [])]
        forms += [f"{a} {p}" for a in CHILD.get(c, [])]
    return any(applies(x, r) for q in forms for x in setters.get((q, prop), []))


dead = {}
for r in rules:
    ps = parts(r)
    for k, dcl in enumerate(r.decls):
        if ps and all(beaten(p, dcl.prop, r) for p in ps):
            dead.setdefault(r.order, set()).add(k)
report = [(rules[o].file.relative_to(d.STYLES).as_posix(), rules[o].selector, rules[o].decls[k].prop) for o, ks in dead.items() for k in ks]
for f, s, p in report:
    print(f"{f} | {s} | {p}")
print(len(report), "producer-proven dead declarations")
if "--write" in sys.argv:
    new = d.apply(texts, rules, dead, [])
    for f, text in new.items():
        if text != texts[f]:
            f.write_text(text, encoding="utf-8")
    print("written")
