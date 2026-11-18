"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
const assert = require("node:assert/strict");
const { createClientAuthentication } = require("../ui/main/client_auth");
// Every launch resolves its tokens under STOCK_MONITOR_AUTH_ROOT: keep this test out of the real AUTH_ROOT.
const authRoot = makeTempDir("client-auth-contract-");
const env = { STOCK_MONITOR_AUTH_ROOT: authRoot };
const fsMod = require("node:fs"), pathMod = require("node:path");
const daemonAuth = require("../service/platform/js/daemon_auth");
const processRef = { env, cwd: () => process.cwd() };
const tokenOf = (root) => fsMod.readFileSync(pathMod.join(root, "client_auth_token"), "ascii");
const calls = [];
// The token goes to exactly the business API origins in effect (seven services), never to another port or host.
let origins = ["http://127.0.0.1:8000", "http://127.0.0.1:8006"];
const auth = createClientAuthentication({ apiOrigins: () => origins, env,
  fetchImpl: async (...args) => { calls.push(args); return { ok: true }; } });
(async () => {
  // Electron never mints the token: before Health created it, nothing is attached and no file appears.
  await auth.fetch("http://127.0.0.1:8000/api/status");
  assert.equal(calls[0][1].headers.get("Authorization"), null, "no token before Health minted one");
  assert.equal(fsMod.existsSync(pathMod.join(authRoot, "client_auth_token")), false, "Electron does not create the token");
  calls.length = 0;
  daemonAuth.createClientAuthentication({ fs: fsMod, path: pathMod, processRef });   // Health mints it
  await auth.fetch("http://127.0.0.1:8000/api/settings/shioaji/credentials", { method: "DELETE" });
  assert.match(calls[0][1].headers.get("Authorization"), /^Bearer [a-f0-9]{64}$/);
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(new URL(calls[0][0]).search, "");
  await auth.fetch("http://127.0.0.1:8006/api/config/network");
  assert.match(calls.at(-1)[1].headers.get("Authorization"), /^Bearer /, "every business API origin gets the token");
  for (const url of ["https://example.invalid/", "http://127.0.0.1:8009/", "http://127.0.0.1:8010/live", "http://127.0.0.1.evil.invalid:8000/"]) {
    await auth.fetch(url);
    assert.equal(calls.at(-1)[1].headers, undefined);
  }
  let handler;
  const session = { webRequest: { onBeforeSendHeaders(_filter, callback) { handler = callback; } } };
  auth.secureSession(session, (details) => details.frame === "trusted-main-frame");
  function invoke(url, frame) {
    let result;
    handler({ url, frame, requestHeaders: { authorization: "untrusted", "Content-Type": "application/json" } }, (value) => { result = value; });
    return result.requestHeaders;
  }
  assert.equal(invoke("http://127.0.0.1:8000/api/settings", "untrusted").Authorization, undefined);
  assert.equal(invoke("http://127.0.0.1:8000/api/settings", "untrusted").authorization, undefined);
  assert.match(invoke("ws://127.0.0.1:8000/ws", "trusted-main-frame").Authorization, /^Bearer /);
  assert.equal(invoke("https://example.invalid/", "trusted-main-frame").Authorization, undefined);
  // An applied port change moves an origin: the old one stops receiving the token at once.
  origins = ["http://127.0.0.1:28000", "http://127.0.0.1:8006"];
  assert.equal(invoke("http://127.0.0.1:8000/api/status", "trusted-main-frame").Authorization, undefined);
  assert.match(invoke("http://127.0.0.1:28000/api/status", "trusted-main-frame").Authorization, /^Bearer /);
  // Health's full start renews the token while Electron runs: the next request carries the new one, the old is gone.
  const before = tokenOf(authRoot);
  daemonAuth.renewRoleTokens({ fs: fsMod, path: pathMod, processRef });
  const after = tokenOf(authRoot);
  assert.notEqual(after, before, "the full start renewed the token");
  await auth.fetch("http://127.0.0.1:8006/api/config/network");
  assert.equal(calls.at(-1)[1].headers.get("Authorization"), `Bearer ${after}`, "the request after a renewal carries the new token");
  assert.equal(invoke("http://127.0.0.1:28000/api/status", "trusted-main-frame").Authorization, `Bearer ${after}`, "renderer requests too");
  // The token is never exported into the environment (every child Electron starts would inherit it).
  assert.equal(env.STOCK_MONITOR_CLIENT_TOKEN, undefined);
  console.log("A02 client authentication header, scope, frame, redirect and renewal checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
