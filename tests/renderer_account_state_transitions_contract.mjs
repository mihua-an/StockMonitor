import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A new market or ledger is one transition in account_state.js: every row a view had opened and the 當沖 selections
// go with it, the same for each path that changes them (market switch, entering 當沖 from 美股, ledger tabs).
globalThis.localStorage = { getItem: () => null, setItem() {} };
const state = await import("../ui/renderer/js/features/account/account_state.js");
const opened = [state.actualAccountExpandedDays, state.actualAccountExpandedPairDays, state.actualAccountExpandedStockStats,
  state.actualAccountOpenStockTradeDetails];
const open = () => {
  opened.forEach((set) => set.add("x"));
  state.actualAccountStockTradeModes.set("2330", "pairs");
  state.account.daytradeBucketSelection = { kind: "hold", index: 2 };
  state.account.daytradeWeekdaySelection = 3;
  state.account.daytradeMode = "detail";
  state.account.dashboard = { ok: true };
  state.account.autoSyncAttempted = true;
};
const allClosed = () => opened.every((set) => set.size === 0) && state.actualAccountStockTradeModes.size === 0
  && state.account.daytradeBucketSelection.kind === "" && state.account.daytradeWeekdaySelection === null;

open();
state.changeAccountMarket("美股");
assert.equal(state.account.market, "美股");
assert.ok(allClosed(), "a new market closes every opened row and the 當沖 selections");
assert.equal(state.account.daytradeMode, "detail", "the 當沖 mode is the user's, kept across markets");
assert.deepEqual(state.account.dashboard, { ok: true }, "a market switch keeps the ledger's dashboard");

open();
state.changeAccountLedger("paper");
assert.equal(state.account.mode, "paper");
assert.ok(allClosed(), "a new ledger closes the same rows and selections");
assert.equal(state.account.dashboard, null);
assert.equal(state.account.autoSyncAttempted, true, "the auto-sync is once per App run: a ledger switch does not re-arm it");
assert.equal(state.account.daytradeMode, "overview");

const page = readFileSync(new URL("../ui/renderer/js/pages/account.js", import.meta.url), "utf8");
// Once per App run (user 11-05): entering 帳務 again must not re-arm the auto-sync either.
assert.doesNotMatch(page, /autoSyncAttempted\s*=\s*false/, "nothing in the page re-arms the once-per-run auto-sync");
assert.doesNotMatch(page, /actualAccount(Expanded\w+|OpenStockTradeDetails|StockTradeModes)\.clear\(\)/, "the page clears no Set itself");
// Leaving 帳務 from 委託紀錄 ends that view's paper-orders subscription.
const dispose = page.slice(page.indexOf("export function disposeAccountPage()"));
assert.match(dispose.slice(0, dispose.search(/\r?\n\}\r?\n/)), /paperOrderHistory\?\.view\.hide\(\);\s*paperOrderHistory = null;/);
console.log("renderer account state transitions contract passed");
