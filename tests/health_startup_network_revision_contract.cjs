"use strict";
// A saved network revision that no longer validates made Health start every service on the default ports. It
// now starts on the store's last good revision (recorded by the caller), and refuses to start without one.
const assert = require("node:assert/strict");
const { resolveStartupNetwork, NoValidNetworkRevision } = require("../health/startup/network_revision.js");

const networkConfig = {
  resolve(_manifest, { saved }) {
    const valid = saved?.values?.ok === true;
    return valid ? { revision: saved.revision, problems: [], rejected: [] }
      : { revision: null, problems: [{ code: "BAD", revision: saved?.revision }], rejected: [{ layer: "saved", revision: saved?.revision }] };
  },
};
const revision = (n, ok) => ({ revision: n, values: { ok } });
const call = (saved, lastGood) => resolveStartupNetwork({ networkConfig, manifest: {}, env: {}, saved,
  store: { lastGood: () => lastGood } });

const fine = call(revision(3, true), revision(2, true));
assert.equal(fine.effective.revision, 3);
assert.equal(fine.fallback, null, "a valid saved revision is used as it is");

const fellBack = call(revision(4, false), revision(2, true));
assert.equal(fellBack.effective.revision, 2, "the last good revision, never the defaults");
assert.deepEqual([fellBack.fallback.invalid_revision, fellBack.fallback.started_on], [4, 2]);

assert.throws(() => call(revision(4, false), null), NoValidNetworkRevision, "no last good: Health does not start");
assert.throws(() => call(revision(4, false), revision(4, false)), NoValidNetworkRevision, "the invalid one is not its own fallback");
assert.throws(() => call(revision(5, false), revision(2, false)), NoValidNetworkRevision, "an invalid last good is no fallback");

console.log("health startup network revision contract passed");
