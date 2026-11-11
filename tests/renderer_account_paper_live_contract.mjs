// 帳務 → 模擬庫存 follows the paper ledger while it is open: the holdings owner's push re-reads the page's dashboard,
// the same source 即時報價's 模擬庫存 is told by. Before this a new fill showed only after leaving the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { followLedgerChanges } = await import("../ui/renderer/js/features/account/ledger_change_follower.js");

function harness() {
  const listeners = new Set();
  const applied = [];
  const answers = [];
  let reads = 0;
  const stop = followLedgerChanges({
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    read: () => { reads += 1; return new Promise((resolve, reject) => answers.push({ resolve, reject })); },
    apply: (result) => applied.push(result),
  });
  return { stop, applied, answers, push: () => [...listeners].forEach((fn) => fn({})), reads: () => reads, listeners };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A pushed change re-reads and applies what was read.
{
  const h = harness();
  assert.equal(h.reads(), 0, "subscribing reads nothing: the page read its own on entering");
  h.push();
  h.answers[0].resolve("v1");
  await tick();
  assert.deepEqual(h.applied, ["v1"]);
}

// Changes during a read are one more read afterwards, and the newest is what stays.
{
  const h = harness();
  h.push();
  h.push();
  h.push();
  assert.equal(h.reads(), 1, "one read at a time");
  h.answers[0].resolve("old");
  await tick();
  assert.equal(h.reads(), 2, "the changes that came meanwhile are read once more");
  h.answers[1].resolve("new");
  await tick();
  assert.deepEqual(h.applied, ["old", "new"]);
  assert.equal(h.reads(), 2);
}

// A failed read keeps what is on screen and the next change still works.
{
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const h = harness();
    h.push();
    h.answers[0].reject(new Error("offline"));
    await tick();
    assert.deepEqual(h.applied, []);
    assert.equal(warnings.length, 1, "the failure is recorded");
    h.push();
    h.answers[1].resolve("back");
    await tick();
    assert.deepEqual(h.applied, ["back"]);
  } finally {
    console.warn = warn;
  }
}

// Leaving: no stream is kept, and a read still in flight writes nothing to a page that is gone.
{
  const h = harness();
  h.push();
  h.stop();
  assert.equal(h.listeners.size, 0);
  h.answers[0].resolve("late");
  await tick();
  assert.deepEqual(h.applied, []);
}

// The page wires it to the paper ledger, for the paper ledger only, and a push patches the holdings in place.
{
  const source = readFileSync(new URL("../ui/renderer/js/pages/account.js", import.meta.url), "utf8");
  assert.match(source, /followLedgerChanges\(\{\s*subscribe: \(listener\) => paperHoldings\.subscribe\(listener\)/);
  const follow = source.slice(source.indexOf("function syncPaperLedgerFollow"), source.indexOf("function bindAccountModeTabs"));
  assert.match(follow, /isPaperWalletMode\(\)/);
  assert.match(follow, /renderAccountViewContent\("holdings", true\)/, "the holdings table is patched by row (cell_patch)");
  assert.doesNotMatch(follow, /renderDashboard|refreshAccountPage|showAccountView/, "a push does not rebuild or re-show the page");
  assert.match(source.slice(source.indexOf("function applyAccountModeChrome")), /syncPaperLedgerFollow\(\)/);
  assert.match(source.slice(source.indexOf("export function disposeAccountPage")), /stopPaperLedgerFollow\(\)/);
}

console.log("account paper live contract passed");
