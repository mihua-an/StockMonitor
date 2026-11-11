"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Health starts every child from an allowlisted environment and grants each
// role only its own credentials; no helper exports a token into process.env. Both directions: what a role needs
// arrives, everything else does not.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { childEnv, isSecretName } = require("../service/platform/js/child_env");
const auth = require("../service/platform/js/daemon_auth");
const { PythonServiceHost } = require("../health/services/python_service_host");

const parent = {
  SystemRoot: "C:\\Windows", Path: "C:\\bin", TEMP: "C:\\tmp", LOCALAPPDATA: "C:\\L", PYTHONUTF8: "1",
  STOCK_MONITOR_VAR_ROOT: "C:\\var", STOCK_MONITOR_SOURCES: "shioaji,futu", STOCK_MONITOR_AUTH_ROOT: "C:\\auth",
  STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR: "C:\\cred", SJ_LOG_PATH: "C:/logs/sj.log", MOOMOO_POLL_SECONDS: "0.2", HTTPS_PROXY: "http://proxy:8080",
  // must never be inherited
  STOCK_MONITOR_DAEMON_TOKEN: "x".repeat(64), STOCK_MONITOR_CLIENT_TOKEN: "y".repeat(64), STOCK_MONITOR_CONTROLLER_TOKEN: "z".repeat(64),
  STOCK_MONITOR_DAEMON_TOKEN_FILE: "C:\\auth\\daemon_auth_token",
  SJ_API_KEY: "broker-key", SHIOAJI_SECRET_KEY: "broker-secret", OPENAI_API_KEY: "sk-3rd-party", AWS_SECRET_ACCESS_KEY: "aws",
  GITHUB_TOKEN: "gh", NODE_OPTIONS: "--require evil.js", PYTHONPATH: "C:\\evil", PYTHONSTARTUP: "C:\\evil.py",
  ELECTRON_RUN_AS_NODE: "1", RANDOM_TOOL_SETTING: "1",
};

// 1. The allowlist itself.
const base = childEnv(parent);
for (const name of ["SystemRoot", "Path", "TEMP", "LOCALAPPDATA", "PYTHONUTF8", "STOCK_MONITOR_VAR_ROOT", "STOCK_MONITOR_SOURCES",
  "STOCK_MONITOR_AUTH_ROOT", "STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR", "SJ_LOG_PATH", "MOOMOO_POLL_SECONDS", "HTTPS_PROXY"]) {
  assert.equal(base[name], parent[name], `${name} must reach the child`);
}
for (const name of ["STOCK_MONITOR_DAEMON_TOKEN", "STOCK_MONITOR_CLIENT_TOKEN", "STOCK_MONITOR_CONTROLLER_TOKEN",
  "STOCK_MONITOR_DAEMON_TOKEN_FILE", "SJ_API_KEY", "SHIOAJI_SECRET_KEY", "OPENAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "ELECTRON_RUN_AS_NODE", "RANDOM_TOOL_SETTING"]) {
  assert.equal(base[name], undefined, `${name} must not reach the child`);
}
assert.equal(isSecretName("STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR"), false, "a listed directory path is not a credential");
// A _DIR/_ROOT ending does not make an unlisted secret-looking name safe (R15-04).
const unlisted = childEnv({ STOCK_MONITOR_TOKEN_ROOT: "t", STOCK_MONITOR_API_KEY_DIR: "k", SJ_SECRET_ROOT: "s", STOCK_MONITOR_AUTH_ROOT: "C:\\auth" });
assert.deepEqual(Object.keys(unlisted), ["STOCK_MONITOR_AUTH_ROOT"], "only the listed secret-looking paths reach a child");
// Every location override of config/var_layout.json passes.
const { layoutNames } = require("../service/platform/js/child_env");
const layoutEnv = Object.fromEntries(layoutNames().map((name) => [name, `C:\\${name}`]));
const passed = childEnv(layoutEnv);
for (const name of layoutNames()) assert.equal(passed[name], layoutEnv[name], `${name} (var_layout.json) must reach the child`);
// A retired name reaches the child too, so the child refuses it as its launcher does instead of never seeing it.
assert.ok(layoutNames().includes("STOCK_MONITOR_DATA_ROOT") && layoutNames().includes("STOCKMONITOR_DATA_ROOT"));
assert.ok(layoutNames().includes("STOCK_MONITOR_INSTALL_FLAVOR"), "a child resolves the same flavor as its launcher");
// A grant adds exactly what the role needs and replaces a differently-cased inherited name.
const granted = childEnv({ ...parent, stock_monitor_sources: "futu" }, { STOCK_MONITOR_SOURCES: "shioaji", STOCK_MONITOR_DAEMON_TOKEN: "g".repeat(64), SKIP: undefined });
assert.equal(granted.STOCK_MONITOR_DAEMON_TOKEN, "g".repeat(64));
assert.equal(Object.keys(granted).filter((k) => k.toUpperCase() === "STOCK_MONITOR_SOURCES").length, 1);
assert.equal("SKIP" in granted, false);

(async () => {
  // 2. No helper exports a token into the environment it was handed.
  const root = makeTempDir("w6-child-env-");
  const processRef = { env: { STOCK_MONITOR_AUTH_ROOT: root } };
  const daemonAuth = auth.createDaemonAuthentication({ fs, path, processRef });
  const managementAuth = auth.createManagementAuthentication({ fs, path, processRef });
  const clientAuth = auth.createClientAuthentication({ fs, path, processRef });
  auth.createControllerAuthentication({ fs, path, processRef });
  assert.deepEqual(Object.keys(processRef.env), ["STOCK_MONITOR_AUTH_ROOT"], "tokens must not be written into env");
  assert.notEqual(daemonAuth.token, managementAuth.token, "management is its own credential, not the daemon one");
  assert.equal(managementAuth.digest, require("node:crypto").createHash("sha256").update(managementAuth.token).digest("hex"));
  assert.equal(auth.createManagementAuthentication({ fs, path, processRef }).token, managementAuth.token, "first writer wins");

  // 3. Health's client toward a provider daemon: stop carries the management credential, everything else the daemon one.
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { seen.push([String(url), new Headers(options.headers).get("Authorization")]); return { ok: true }; };
  try {
    const providerFetch = auth.providerClientFetch({ daemonAuth, managementAuth });
    await providerFetch("http://127.0.0.1:8020/v1/control/stop?reason=x", { method: "POST" });
    await providerFetch("http://127.0.0.1:8020/v1/session/status");
    await providerFetch("http://127.0.0.1:8020/v1/shioaji/reconnect", { method: "POST" });
  } finally { globalThis.fetch = original; }
  assert.equal(seen[0][1], `Bearer ${managementAuth.token}`);
  assert.equal(seen[1][1], `Bearer ${daemonAuth.token}`);
  assert.equal(seen[2][1], `Bearer ${daemonAuth.token}`);

  // 4. A business API is spawned with its role's grant and nothing else from the launcher.
  const spawned = [];
  const effective = { revision: null, services: { app_api: { host: "127.0.0.1", port: 59999 } } };
  const host = new PythonServiceHost({
    serviceId: "app_api", effective, pythonExecutable: "python", projectRoot: root, logDir: path.join(root, "logs"),
    managementToken: managementAuth.token, fs, path,
    env: () => childEnv(parent, { STOCK_MONITOR_DAEMON_TOKEN: daemonAuth.token, STOCK_MONITOR_CLIENT_TOKEN_SHA256: clientAuth.digest,
      STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256: managementAuth.digest }),
    fetchImpl: async () => { throw new Error("nothing listening"); },
    execFileImpl: (_file, _args, _options, callback) => { (typeof _options === "function" ? _options : callback)?.(null, "", ""); },
    spawnImpl: (_exe, _args, options) => {
      spawned.push(options.env);
      const { EventEmitter } = require("node:events");
      const child = new EventEmitter(); child.pid = 4242; child.exitCode = null; child.stdout = null; child.stderr = null; child.kill = () => {};
      // Exit at once: this test only inspects the spawn environment, and must never wait for or kill a real pid.
      setImmediate(() => { child.exitCode = 1; child.emit("exit", 1, null); });
      return child;
    },
  });
  await host.ensure().catch(() => {});
  assert.equal(spawned.length, 1, "the API was spawned");
  const env = spawned[0];
  assert.equal(env.STOCK_MONITOR_DAEMON_TOKEN, daemonAuth.token, "an API calls the daemons");
  assert.equal(env.STOCK_MONITOR_CLIENT_TOKEN_SHA256, clientAuth.digest);
  assert.equal(env.STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256, managementAuth.digest);
  assert.equal(env.STOCK_MONITOR_MANAGED_BY_HEALTH, "1");
  assert.equal(env.STOCK_MONITOR_SERVICE_ID, "app_api");
  for (const name of ["STOCK_MONITOR_CLIENT_TOKEN", "STOCK_MONITOR_CONTROLLER_TOKEN", "OPENAI_API_KEY",
    "SJ_API_KEY", "NODE_OPTIONS", "PYTHONPATH"]) assert.equal(env[name], undefined, `${name} must not reach an API`);
  assert.ok(!Object.values(env).includes(managementAuth.token), "the management token itself never leaves Health");
  assert.ok(!Object.values(env).includes(clientAuth.token), "an API verifies the client token by digest only");

  // 5. health/main.js grants per role exactly as documented (source-level: main.js cannot run in a test).
  const main = fs.readFileSync(path.join(__dirname, "..", "health", "main.js"), "utf8");
  const roles = main.slice(main.indexOf("const roleEnv = {"), main.indexOf("const providerFetch"));
  assert.match(roles, /api: \(\) => childEnv\(process\.env, \{ STOCK_MONITOR_DAEMON_TOKEN: daemonAuth\.token,\s+STOCK_MONITOR_CLIENT_TOKEN_SHA256: clientAuth\.digest, STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256: managementAuth\.digest,\s+\.\.\.pythonServiceThreadDefaults\(process\.env\) \}\)/);
  assert.match(roles, /provider: \(\) => childEnv\(process\.env, \{ STOCK_MONITOR_DAEMON_TOKEN_SHA256: daemonAuth\.digest,\s+STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256: managementAuth\.digest, \.\.\.pythonServiceThreadDefaults\(process\.env\) \}\)/);
  assert.match(roles, /plain: \(\) => childEnv\(process\.env\)/);

  // 6. The long-running Python services get one OpenBLAS thread (numpy commits a buffer per core otherwise); a value
  // the launcher already has wins, whatever its spelling.
  const { pythonServiceThreadDefaults } = require("../service/platform/js/child_env.js");
  assert.deepEqual(pythonServiceThreadDefaults({ PATH: "C:\\bin" }), { OPENBLAS_NUM_THREADS: "1" });
  assert.deepEqual(pythonServiceThreadDefaults({ openblas_num_threads: "4" }), {});
  assert.equal(childEnv({ OPENBLAS_NUM_THREADS: "4" }, pythonServiceThreadDefaults({ OPENBLAS_NUM_THREADS: "4" })).OPENBLAS_NUM_THREADS, "4");
  assert.equal(childEnv({}, pythonServiceThreadDefaults({})).OPENBLAS_NUM_THREADS, "1");
  assert.doesNotMatch(main, /\.\.\.process\.env/, "Health never spreads its whole environment into a child");
  for (const file of ["services/market_runtime_host.js", "services/analysis_runtime_host.js", "services/provider_daemon_host.js",
    "services/python_service_host.js", "materializer_job_runner.js", "training_job_runner.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "health", file), "utf8");
    assert.doesNotMatch(source, /\.\.\.(process|processRef)\.env\b/, `${file} spreads the launcher environment`);
    assert.match(source, /childEnv/, `${file} must build its child environment from the allowlist`);
  }
  const bootstrap = fs.readFileSync(path.join(__dirname, "..", "ui", "main", "health_bootstrap.js"), "utf8");
  assert.match(bootstrap, /env: healthEnv\(\)/, "Electron starts Health from the allowlist too");
  console.log("W6 child environment and role credential contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
