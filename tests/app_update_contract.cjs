"use strict";
// 新版提示, Electron main's side (ui/main/app_update.js): the installed App asks GitHub for its repository's newest
// release, a minute after start and daily after that, and says so when that release is newer than itself. Checked:
// versions and repository read the same way GitHub and package.json write them; a newer release is offered with its
// page, the same or an older one is not; a repository without a public release (404) or a failed request offers
// nothing and is logged; the App run from source never asks; only this repository's release page on github.com is
// ever handed to the browser; the first check waits a minute and the next comes a day later.
const assert = require("node:assert/strict");
const { createAppUpdate, parseVersion, isNewer, repositorySlug, releasePage, CHECK_DELAY_MS, CHECK_EVERY_MS } = require("../ui/main/app_update");

assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
assert.deepEqual(parseVersion("0.10.0"), [0, 10, 0]);
assert.equal(parseVersion("v1.2.3-beta.1"), null, "a pre-release tag is not offered");
assert.equal(parseVersion(""), null);
assert.equal(isNewer([0, 10, 0], [0, 9, 9]), true, "compared as numbers, not text");
assert.equal(isNewer([0, 1, 0], [0, 1, 0]), false);
assert.equal(isNewer([0, 0, 9], [0, 1, 0]), false);
assert.equal(repositorySlug({ type: "git", url: "https://github.com/mihua-an/StockMonitor.git" }), "mihua-an/StockMonitor");
assert.equal(repositorySlug("git@github.com:owner/repo.git"), "owner/repo");
assert.equal(repositorySlug({ url: "https://gitlab.com/owner/repo" }), null);
const slug = "mihua-an/StockMonitor";
assert.equal(releasePage("https://github.com/mihua-an/StockMonitor/releases/tag/v0.2.0", slug), "https://github.com/mihua-an/StockMonitor/releases/tag/v0.2.0");
for (const bad of ["http://github.com/mihua-an/StockMonitor/releases/tag/v0.2.0", "https://github.com/other/repo/releases/tag/v1.0.0",
  "https://evil.example/mihua-an/StockMonitor/releases/", "https://user:pw@github.com/mihua-an/StockMonitor/releases/", "javascript:alert(1)", "not a url"]) {
  assert.equal(releasePage(bad, slug), null, `refused: ${bad}`);
}

const repository = { type: "git", url: "https://github.com/mihua-an/StockMonitor.git" };
const logs = [];
const logger = { warn: (...args) => logs.push(args.map(String).join(" ")), log: () => {} };
const answer = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const release = (tag) => ({ tag_name: tag, html_url: `https://github.com/${slug}/releases/tag/${tag}`, name: `StockMonitor ${tag}`, body: "更新說明", published_at: "2026-11-12T00:00:00Z" });

(async () => {
  // A newer release: offered with its page, the main window told once.
  const told = [];
  let asked = null;
  const newer = createAppUpdate({ enabled: true, currentVersion: "0.1.0", repository, logger, onChange: (s) => told.push(s),
    fetchImpl: async (url, options) => { asked = { url, options }; return answer(200, release("v0.2.0"))(); } });
  const state = await newer.check();
  assert.equal(asked.url, "https://api.github.com/repos/mihua-an/StockMonitor/releases/latest");
  assert.equal(asked.options.headers["User-Agent"], "StockMonitor-update-check", "a generic client name, nothing of the user");
  assert.equal(state.available, true);
  assert.equal(state.latest, "0.2.0");
  assert.equal(newer.pageToOpen(), `https://github.com/${slug}/releases/tag/v0.2.0`);
  assert.equal(told.length, 1, "the main window is told when a newer release appears");
  await newer.check();
  assert.equal(told.length, 1, "and not again for the same release");

  // The same version, or an older one: nothing offered, no page.
  for (const tag of ["v0.1.0", "v0.0.9"]) {
    const same = createAppUpdate({ enabled: true, currentVersion: "0.1.0", repository, logger, fetchImpl: answer(200, release(tag)) });
    assert.equal((await same.check()).available, false, `${tag} is not newer than 0.1.0`);
    assert.equal(same.pageToOpen(), null);
  }

  // No public release (404) and a failed request: nothing offered, each logged.
  logs.length = 0;
  const none = createAppUpdate({ enabled: true, currentVersion: "0.1.0", repository, logger, fetchImpl: answer(404, {}) });
  assert.equal((await none.check()).error, "no_release");
  const down = createAppUpdate({ enabled: true, currentVersion: "0.1.0", repository, logger, fetchImpl: async () => { throw new Error("offline"); } });
  const failed = await down.check();
  assert.equal(failed.available, false);
  assert.match(failed.error, /offline/);
  assert.equal(logs.length, 2, "both are in the log");
  // A release whose page is not this repository's: never offered.
  const odd = createAppUpdate({ enabled: true, currentVersion: "0.1.0", repository, logger,
    fetchImpl: answer(200, { ...release("v9.0.0"), html_url: "https://evil.example/download" }) });
  assert.equal((await odd.check()).available, false);
  assert.equal(odd.pageToOpen(), null);

  // The App run from source: never asks.
  let sourceAsked = false;
  const source = createAppUpdate({ enabled: false, currentVersion: "0.1.0", repository, logger, fetchImpl: async () => { sourceAsked = true; return answer(200, release("v9.0.0"))(); } });
  source.start();
  assert.equal((await source.check()).enabled, false);
  assert.equal(sourceAsked, false);

  // The schedule: the first check a minute after start, the next a day later.
  const timers = [];
  const scheduled = createAppUpdate({ enabled: true, currentVersion: "0.1.0", repository, logger, fetchImpl: answer(200, release("v0.1.0")),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimer: () => {} });
  scheduled.start();
  scheduled.start();
  assert.deepEqual(timers.map((t) => t.ms), [CHECK_DELAY_MS], "one timer, a minute");
  timers[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(timers.map((t) => t.ms), [CHECK_DELAY_MS, CHECK_EVERY_MS], "then daily");
  console.log("app update contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
