// One trade form: the 帳務 modal and the standalone trade window are the same TradeEditor (features/account/
// trade_editor_form.js) with their own id prefix, variant and adapter; neither carries markup or a fill-row parser of
// its own. A new trade in the window starts in the market the main window sends, from Rust A's US session (user 11-10:
// 美股 only while the US regular session is open); the window reads no calendar or clock of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tradeEditorMarkup, tradeInfoToFillRows, normalizeTradeTimeText, marketDateText } from "../ui/renderer/js/features/account/trade_editor_form.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The two variants: the same fields, ids differ only by prefix.
const ids = (markup, prefix) => [...markup.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id.slice(prefix.length));
const modal = tradeEditorMarkup({ idPrefix: "actualTrade", variant: "modal" });
const windowed = tradeEditorMarkup({ idPrefix: "tradeWindow", variant: "window" });
const shared = ["Id", "Date", "Market", "Action", "Code", "QtyHeading", "AddFillBtn", "FillRows", "Time", "DeleteBtn", "ResetBtn", "CancelBtn", "SubmitBtn"];
for (const name of shared) {
  assert.ok(ids(modal, "actualTrade").includes(name), `modal has ${name}`);
  assert.ok(ids(windowed, "tradeWindow").includes(name), `window has ${name}`);
}
assert.deepEqual(ids(modal, "actualTrade").filter((name) => !shared.includes(name)).sort(), ["CloseBtn", "EditorTitle"], "only the modal has a header");
assert.deepEqual(ids(windowed, "tradeWindow").filter((name) => !shared.includes(name)), ["Message"], "only the window has a message line");
for (const markup of [modal, windowed]) {
  assert.match(markup, /placeholder="例如 2337 \/ NVDA" autocomplete="off"/, "one placeholder and autocomplete for 股號");
}

// The hosts build nothing of the form themselves.
for (const path of ["ui/renderer/js/features/account/trade_editor.js", "ui/renderer/trade_window.js", "ui/renderer/pages/account.html", "ui/renderer/trade_window.html"]) {
  const source = read(path);
  assert.doesNotMatch(source, /account-trade-fill-row|account-trade-form-grid|function tradeInfoToFillRows/, `${path} must not carry its own form markup or parser`);
}
assert.match(read("ui/renderer/js/features/account/trade_editor.js"), /new TradeEditor\(\{ host, idPrefix: "actualTrade", variant: "modal"/);
assert.match(read("ui/renderer/trade_window.js"), /new TradeEditor\(\{ host: document\.querySelector\("\.trade-window-shell"\), idPrefix: "tradeWindow", variant: "window"/);
assert.doesNotMatch(read("ui/renderer/trade_window.js"), /weekday|Mon", "Tue|trading-calendar|America\/New_York/, "the window does not guess the US session");
assert.match(read("ui/renderer/trade_window.js"), /defaultMarket: \(\) => currentPayload\.market/, "the market the opener sent");
assert.match(read("ui/renderer/js/features/account/trade_entry.js"), /usMarketSession\(\)\?\.phase === "regular" \? "美股" : "台股"/, "the opener reads A's US session");

// Parsers.
assert.deepEqual(tradeInfoToFillRows("1000@52.3_500@52.4"), [{ qty: "1000", price: "52.3" }, { qty: "500", price: "52.4" }]);
assert.deepEqual(tradeInfoToFillRows(""), []);
assert.equal(normalizeTradeTimeText("0930"), "09:30");
assert.equal(normalizeTradeTimeText("9:05:12"), "09:05");
assert.throws(() => normalizeTradeTimeText("2460"));

// A new trade's date is its market's date: Saturday 02:00 Taipei is Friday in New York.
assert.equal(marketDateText("美股", new Date("2026-10-16T18:00:00Z")), "2026-10-16");
assert.equal(marketDateText("台股", new Date("2026-10-16T18:00:00Z")), "2026-10-17");

console.log("trade editor contract passed");
