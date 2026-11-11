"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createDaemonAuthentication } = require("../service/platform/js/daemon_auth");

(async () => {
  const root = makeTempDir("daemon-auth-contract-");
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: new Headers(options.headers).get("Authorization") });
    return { ok: true };
  };
  try {
    const processRef = { env: { STOCK_MONITOR_AUTH_ROOT: root }, cwd: () => root };
    const first = createDaemonAuthentication({ fs, path, processRef });
    await first.fetch("http://127.0.0.1:8010/v1/client/attach");
    const second = createDaemonAuthentication({ fs, path, processRef: { env: { STOCK_MONITOR_AUTH_ROOT: root }, cwd: () => root } });
    assert.equal(calls[0].authorization, `Bearer ${fs.readFileSync(first.tokenFile, "ascii")}`);
    assert.equal(first.tokenFile, second.tokenFile, "persistent daemon restarts must reuse the daemon-lifetime capability");
  } finally { globalThis.fetch = originalFetch; }
  console.log("Daemon authentication desktop contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
