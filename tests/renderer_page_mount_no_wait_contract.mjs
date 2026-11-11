// A page's first data read never holds the next navigation (user 11-05: after entering 資料中心 the screen often
// stuck and no other page could be opened). Navigations run one at a time (navigation_coordinator.js); mounting a
// page module (page_mount.js) starts the page's read and returns at once, so a read that never answers -- 資料中心's
// date list on a cold disk -- leaves the next navigation free to run. The page drops the late answer itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNavigationCoordinator } from "../ui/renderer/js/features/navigation/navigation_coordinator.js";
import { isModulePage, loadPageData, mountPageModule } from "../ui/renderer/js/features/navigation/page_mount.js";

const calls = [];
let releaseDates;
const modules = {
  datacenter: {
    initDataCenterPage: () => calls.push("datacenter:mount"),
    // The date list that does not answer until released.
    refreshDataCenter: () => { calls.push("datacenter:load"); return new Promise((resolve) => { releaseDates = resolve; }); },
  },
  training: {
    bindTrainingEvents: () => calls.push("training:mount"),
    refreshTrainingStatus: async () => { calls.push("training:load"); },
  },
  history: {
    bindHistoryEvents: () => calls.push("history:mount"),
    // A page may record the read it started (history.js keeps it for a replay opened from elsewhere): it starts
    // synchronously, inside the mount.
    refreshHistoryPage: () => { calls.push("history:load"); return Promise.resolve(); },
  },
  account: {
    initAccountLedgerPage: () => calls.push("account:mount"),
    refreshAccountLedgerPage: async (allowAutoSync) => { calls.push(`account:load:${allowAutoSync}`); },
  },
  settings: {
    initSettingsPage: () => calls.push("settings:mount"),
    refreshSettingsPage: async () => { calls.push("settings:load"); },
  },
};

const navigation = createNavigationCoordinator(async (page, _options, isCurrent) => {
  await Promise.resolve();   // the page HTML / module load
  if (!isCurrent()) return { superseded: true };
  const mounted = mountPageModule(page, modules[page]);
  return { page, mounted };
});

const first = await navigation.navigate("datacenter");
assert.equal(first.page, "datacenter");
assert.deepEqual(calls, ["datacenter:mount", "datacenter:load"], "the read starts inside the mount");

// The date list has not answered; the next navigation runs at once.
const second = await Promise.race([
  navigation.navigate("training"),
  new Promise((resolve) => setTimeout(() => resolve("held"), 200)),
]);
assert.notEqual(second, "held", "a navigation asked for while the previous page's read is out was held behind it");
assert.equal(second.page, "training");
assert.deepEqual(calls.slice(2), ["training:mount", "training:load"]);

// The mount hands back the read for the window fit; it settles when the page's read does.
let settled = false;
first.mounted.loaded.then(() => { settled = true; });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(settled, false);
releaseDates({ items: [] });
await first.mounted.loaded;
assert.equal(settled, true);

calls.length = 0;
const history = mountPageModule("history", modules.history);
assert.deepEqual(calls, ["history:mount", "history:load"], "history's read is started before the mount returns");
await history.loaded;
await mountPageModule("account", modules.account).loaded;
await mountPageModule("settings", modules.settings).loaded;
assert.deepEqual(calls.slice(2), ["account:mount", "account:load:true", "settings:mount", "settings:load"]);

// A read that throws synchronously is the read's failure, not the mount's.
const broken = mountPageModule("training", { bindTrainingEvents() {}, refreshTrainingStatus() { throw new Error("read failed"); } });
await assert.rejects(broken.loaded, /read failed/);
assert.equal(isModulePage("realtime"), false);
assert.equal(isModulePage("datacenter"), true);
await loadPageData("datacenter", { refreshDataCenter: async () => "again" });

// app.js mounts through page_mount.js and never waits for the read inside the navigation.
const app = readFileSync(new URL("../ui/renderer/app.js", import.meta.url), "utf8");
const switchBody = app.slice(app.indexOf("async function switchPage("), app.indexOf("async function bindPageEvents("));
assert.ok(switchBody.length > 0, "switchPage is in app.js");
assert.doesNotMatch(switchBody, /await\s+refreshCurrentPage\(/, "switchPage awaits the page's read");
assert.doesNotMatch(switchBody, /await\s+pageLoad\b/, "switchPage awaits the page's read");
assert.match(switchBody, /followPageLoad\(page, pageLoad, isCurrent\)/);
assert.match(app, /return mountPageModule\(page, await loadPageModule\(page\)\)/);
console.log("renderer page mount no-wait contract passed");
