"use strict";
// Role-token renewal (docs/decisions.md 角色 token 的更換): Health's full start replaces every role token and the digest
// file market_runtime starts with; a Health restarted while its children still run keeps them. The readers outside
// Health (Electron main, the web gateway) read at each use and so carry the renewed token on their next request.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path");
const { makeTempDir } = require("./support/temp_dirs.cjs");
const { prepareRoleCredentials } = require("../health/startup/role_credentials");
const runtimeCredentials = require("../service/platform/js/runtime_credentials");
const daemonAuth = require("../service/platform/js/daemon_auth");
const { createStorageUserRegistry } = require("../health/startup/storage_users");

const root = makeTempDir("role-credentials-");
const env = { STOCK_MONITOR_AUTH_ROOT: root, STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR: path.join(root, "market_runtime") };
const processRef = { env, cwd: () => process.cwd() };
const sha = (token) => crypto.createHash("sha256").update(token, "ascii").digest("hex");

function snapshot() {
  const files = Object.fromEntries(Object.keys(daemonAuth.ROLE_TOKEN_FILES)
    .map((role) => [role, fs.readFileSync(daemonAuth.roleTokenFile({ path, processRef }, role), "ascii")]));
  for (const role of runtimeCredentials.ROLES) files[`runtime:${role}`] = runtimeCredentials.readToken(role, env);
  return files;
}

// 1. The first start creates every token and the digest file.
const first = prepareRoleCredentials({ fs, path, processRef, authRoot: root, renew: false });
const created = snapshot();
for (const [role, token] of Object.entries(created)) assert.match(token, /^[a-f0-9]{64}$/, `${role} token created`);
const digests = () => JSON.parse(fs.readFileSync(first.credentialsFile, "utf8")).roles;
for (const role of runtimeCredentials.ROLES) assert.equal(digests()[role], sha(created[`runtime:${role}`]), `${role} digest matches its token`);

// 2. A Health restarted while its children run (renew: false) keeps every token: the children hold or verify them.
const kept = prepareRoleCredentials({ fs, path, processRef, authRoot: root, renew: false });
assert.deepEqual(snapshot(), created, "a restart without a full start changes no token");
assert.equal(kept.daemonAuth.token, first.daemonAuth.token);

// 3. A full start renews every one, and the digest file and the grants follow.
const renewed = prepareRoleCredentials({ fs, path, processRef, authRoot: root, renew: true });
const after = snapshot();
for (const role of Object.keys(created)) assert.notEqual(after[role], created[role], `${role} renewed on a full start`);
for (const role of runtimeCredentials.ROLES) assert.equal(digests()[role], sha(after[`runtime:${role}`]), `${role} digest follows the renewal`);
assert.equal(renewed.daemonAuth.token, after.daemon);
assert.equal(renewed.managementAuth.token, after.management);
assert.equal(renewed.controllerAuth.token, after.controller);
assert.equal(renewed.clientAuth.digest, sha(after.client));
assert.equal(renewed.runtimeControllerToken, after["runtime:controller"]);
assert.equal(renewed.roleEnv.api("realtime_api")()[runtimeCredentials.grantEnv("viewer")], after["runtime:viewer"]);
assert.equal(renewed.roleEnv.provider("futu")()[runtimeCredentials.grantEnv("provider:futu")], after["runtime:provider:futu"]);
assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");

// 4. Electron's readers: the controller and client tokens are read (never created) at each use, so a renewal reaches them.
assert.equal(daemonAuth.readControllerToken({ fs, path, processRef }), after.controller);
assert.equal(daemonAuth.readClientToken({ fs, path, processRef }), after.client);
const emptyRef = { env: { STOCK_MONITOR_AUTH_ROOT: makeTempDir("role-credentials-empty-") }, cwd: () => process.cwd() };
assert.equal(daemonAuth.readClientToken({ fs, path, processRef: emptyRef }), null);
assert.deepEqual(fs.readdirSync(emptyRef.env.STOCK_MONITOR_AUTH_ROOT), [], "a reader never creates a token");

// 5. The grant variable names are one rule in Node and Python (service/platform/runtime_credentials.py grant_env).
assert.equal(runtimeCredentials.grantEnv("viewer"), "STOCK_MONITOR_RUNTIME_TOKEN_VIEWER");
assert.equal(runtimeCredentials.grantEnv("provider:shioaji"), "STOCK_MONITOR_RUNTIME_TOKEN_PROVIDER_SHIOAJI");
assert.throws(() => runtimeCredentials.grantEnv("nobody"), /unknown market_runtime role/);

// 6. What decides a full start: the storage-users registry of every token holder Health spawned. Nothing alive -> renew;
// a live process, or a registry that cannot be read, keeps the tokens.
const registryRoot = makeTempDir("role-credentials-registry-");
const registryFile = path.join(registryRoot, "storage_users.json");
const quiet = { error() {} };
const none = createStorageUserRegistry({ file: registryFile, alive: () => false, created: () => new Map(), logger: quiet });
none.spawned("market_runtime", 4242);
assert.deepEqual(none.alive(), [], "every recorded process is gone: a full start");
const live = createStorageUserRegistry({ file: registryFile, alive: () => true, now: () => 1_000_000, created: (pids) => new Map(pids.map((pid) => [pid, 1_000_000])), logger: quiet });
live.spawned("realtime_api", 5151);
assert.equal(live.alive().length, 1, "a process of the earlier Health still runs: no renewal");
fs.writeFileSync(registryFile, "{damaged");
assert.equal(createStorageUserRegistry({ file: registryFile, logger: quiet }).alive().length, 1, "an unreadable registry keeps the tokens");
const main = fs.readFileSync(path.join(__dirname, "..", "health", "main.js"), "utf8");
assert.match(main, /const earlierProcesses = timeline\.stage\("earlier_processes", \(\) => storageUsersRegistry\.alive\(\)/);
assert.match(main, /const renewCredentials = earlierProcesses\.length === 0;/);
assert.match(main, /prepareRoleCredentials\(\{ fs, path, processRef: process, authRoot: varPaths\.authRoot, renew: renewCredentials \}\)/);
assert.ok(main.indexOf("prepareRoleCredentials({") < main.indexOf("api.listen()"), "decided before the control API answers anyone");
console.log("health role credentials renewal contract passed");
