import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function source(page) { return fs.readFileSync(new URL(`../ui/renderer/js/pages/${page}.js`, import.meta.url), "utf8"); }
function declaration(text, name) {
  const start = text.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const tail = text.slice(start), end = tail.indexOf("\n}") + 2;
  assert.ok(end > 1, name);
  return tail.slice(0, end).replace(/^export /, "");
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
for (const spec of [
  { page: "data_center", name: "refreshDataCenter", generation: "dataCenterGeneration", render: "renderDailyOverview", payload: value => ({items: [value], count: 1}) },
  { page: "training", name: "loadConsole", generation: "trainingGeneration", render: "renderAll", payload: value => value },
]) {
  const pending = [], rendered = [];
  const context = vm.createContext({
    [spec.generation]: 0, dailySummaries: [], reloadOnEnter: false, selectedDirection: "long", selectedMinutes: 3,
    apiGet: () => { const d = deferred(); pending.push(d); return d.promise; },
    // The pages read through the strict reader (api.js apiGetOk); the same deferred answers stand in for it.
    apiGetOk: () => { const d = deferred(); pending.push(d); return d.promise; },
    [spec.render]: value => rendered.push(value), $: () => null, fmt: String, nextJobRead: () => 0,
  });
  vm.runInContext(declaration(source(spec.page), spec.name), context);
  const run = () => spec.page === "settings"
    ? (context.settingsGeneration++, context[spec.name]())
    : context[spec.name]({reloadDates: true});
  const first = run(), second = run();
  assert.equal(pending.length, 2);
  pending[1].resolve(spec.payload("new")); await second;
  pending[0].resolve(spec.payload("old")); await first;
  assert.equal(rendered.length, 1, `${spec.page}: reversed responses`);
  assert.deepEqual(rendered[0], spec.page === "data_center" ? ["new"] : spec.payload("new"));
  const disposed = run();
  context[spec.generation]++;
  pending[2].resolve(spec.payload("disposed")); await disposed;
  assert.equal(rendered.length, 1, `${spec.page}: disposed response`);
  const remounted = run();
  pending[3].resolve(spec.payload("remounted")); await remounted;
  assert.equal(rendered.length, 2, `${spec.page}: remount accepts fresh data`);
}
// A stale failure (superseded by a newer read) touches nothing; and the model center's requests never write the dock's
// FASTAPI light -- /api/status is its only writer (core/status.js refreshStatus).
const pending = [], touched = [];
const context = vm.createContext({trainingGeneration: 0, selectedDirection: "long", selectedMinutes: 3,
  apiGet: () => { const d = deferred(); pending.push(d); return d.promise; },
  apiGetOk: () => { const d = deferred(); pending.push(d); return d.promise; },
  renderAll: () => {}, nextJobRead: () => 0, $: id => { touched.push(id); return null; },
  console: {error() {}}, userFacingMessage: String,
});
for (const name of ["loadConsole", "refreshTrainingStatus"]) vm.runInContext(declaration(source("training"), name), context);
const old = context.refreshTrainingStatus(), latest = context.refreshTrainingStatus();
pending[1].resolve({}); await latest;
pending[0].reject(new Error("old failure")); assert.equal(await old, null);
assert.deepEqual(touched, [], "the superseded failure shows no warning");
assert.doesNotMatch(source("training"), /setApiOnline/, "the model center never writes the FASTAPI light");
const accountPending = [], accountRendered = [];
const account = vm.createContext({account: {generation: 0, initialized: true, currentView: "home"},
  configureAccountMode() {}, loadConfig: async () => ({}),
  accountApiPath: value => value, apiGet: () => { const d = deferred(); accountPending.push(d); return d.promise; },
  resolveDashboardLoadOutcome: () => ({accepted: true}), renderDashboard: data => accountRendered.push(data),
  showAccountView() {}, isPaperWalletMode: () => false,
});
vm.runInContext(declaration(source("account"), "refreshAccountPage"), account);
const accountOld = account.refreshAccountPage("actual", false);
const accountNew = account.refreshAccountPage("actual", false);
accountPending[1].resolve("new"); await accountNew;
accountPending[0].resolve("old"); await accountOld;
assert.deepEqual(accountRendered, ["new"]);
const accountDisposed = account.refreshAccountPage("actual", false);
account.account.generation++;
accountPending[2].resolve("disposed"); await accountDisposed;
assert.deepEqual(accountRendered, ["new"]);
console.log("page generation: reversed responses, dispose/remount and stale failure passed");

// 資料中心 re-entered: the module keeps its last summaries while the page DOM is rebuilt. Entering draws them at
// once and always fetches the current list -- it used to do neither, leaving an empty table until 重新整理.
{
  const pending = [], rendered = [];
  const context = vm.createContext({
    dataCenterGeneration: 0, dailySummaries: ["kept"], reloadOnEnter: true,
    apiGet: () => { const d = deferred(); pending.push(d); return d.promise; },
    // The pages read through the strict reader (api.js apiGetOk); the same deferred answers stand in for it.
    apiGetOk: () => { const d = deferred(); pending.push(d); return d.promise; },
    renderDailyOverview: (value) => rendered.push(value), $: () => null, fmt: String,
  });
  vm.runInContext(`${declaration(source("data_center"), "refreshDataCenter")}; this.refreshDataCenter = refreshDataCenter;`, context);
  const entering = context.refreshDataCenter();
  assert.deepEqual(rendered, [["kept"]], "the known list is drawn on entry");
  assert.equal(pending.length, 1, "and the current list is fetched");
  pending[0].resolve({ items: ["fresh"], count: 1 }); await entering;
  assert.deepEqual(rendered.at(-1), ["fresh"]);
  console.log("data center entry: draws the known list and fetches the current one");
}
