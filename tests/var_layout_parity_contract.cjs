"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The var/ layout is ONE contract (config/var_layout.json) resolved by two languages. This proves they agree on the physical
// path of every runtime location for the same environment, that Node writers land under var/, and that a packaged launch
// relocates the whole layout with a single variable.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const layout = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "config", "var_layout.json"), "utf8"));
const { resolveVarPaths } = require("../config/js/var_paths");
const { resolveDataRoot, resolveLaunchVarRoot } = require("../config/js/runtime_contract");
const { createDaemonAuthentication, createClientAuthentication, createControllerAuthentication } = require("../service/platform/js/daemon_auth");
const { createShutdownHandoffStore } = require("../service/platform/js/shutdown_handoff");

const pythonBin = process.env.PYTHON || "python";
const probe = spawnSync(pythonBin, ["--version"], { encoding: "utf8" });
const pythonAvailable = !probe.error && probe.status === 0;

const OVERRIDE_NAMES = new Set([layout.root_env, layout.auth_root.base_env, ...layout.auth_root.env,
  ...Object.values(layout.children).flatMap((c) => c.env)]);
function pythonPaths(env) {
  const childEnv = { ...process.env };
  for (const name of OVERRIDE_NAMES) delete childEnv[name];
  for (const [key, value] of Object.entries(env)) { if (value === null) delete childEnv[key]; else childEnv[key] = value; }
  childEnv.PYTHONUTF8 = "1";
  const code = "import json,sys; sys.path.insert(0, sys.argv[1]); from service.platform import project_root as p; "
    + "print(json.dumps({'varRoot': str(p.VAR_ROOT), 'data': str(p.DATA_ROOT), 'output': str(p.OUTPUT_ROOT), "
    + "'state': str(p.STATE_ROOT), 'logs': str(p.LOG_ROOT), 'temp': str(p.TEMP_ROOT), 'config': str(p.CONFIG_ROOT), 'authRoot': str(p.AUTH_ROOT)}))";
  const result = spawnSync(pythonBin, ["-c", code, PROJECT_ROOT], { cwd: PROJECT_ROOT, env: childEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`python resolution failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

const scratch = makeTempDir("var-layout-parity-");
const scenarios = {
  "default (source checkout)": {},
  "explicit var root": { [layout.root_env]: path.join(scratch, "var-a") },
  "var root + per-child overrides": {
    [layout.root_env]: path.join(scratch, "var-b"),
    STOCK_MONITOR_OUTPUT_ROOT: path.join(scratch, "out"), STOCK_MONITOR_STATE_ROOT: path.join(scratch, "state"),
    STOCK_MONITOR_LOG_ROOT: path.join(scratch, "log"),
    STOCK_MONITOR_TEMP_ROOT: path.join(scratch, "tmp"),
  },
  "data root override": { STOCK_MONITOR_DATA_ROOT: path.join(scratch, "d1") },
  "home expansion": { STOCK_MONITOR_DATA_ROOT: "~/stockmonitor-parity-data" },
  "blank values are ignored": { [layout.root_env]: "   ", STOCK_MONITOR_DATA_ROOT: "" },
  "auth root: explicit override": { STOCK_MONITOR_AUTH_ROOT: path.join(scratch, "explicit-auth") },
  "auth root: independent of var root": { [layout.root_env]: path.join(scratch, "var-c"), LOCALAPPDATA: path.join(scratch, "Local2") },
  "auth root: no LOCALAPPDATA falls back to the home directory": { LOCALAPPDATA: null },
  "auth root: blank override ignored": { STOCK_MONITOR_AUTH_ROOT: "  " },
  "installed flavor: its own AUTH_ROOT": {
    [layout.flavor_env]: "installed",
  },
};
// Both languages read the same process environment: pin LOCALAPPDATA to a scratch directory unless a scenario sets it.
const scenarioEnv = (env) => ({ LOCALAPPDATA: path.join(scratch, "Local"), ...env });
const nodeEnv = (env) => Object.fromEntries(Object.entries(scenarioEnv(env)).filter(([, v]) => v !== null));

if (!pythonAvailable) {
  console.log("SKIP cross-language parity: no Python interpreter");
} else {
  for (const [name, env] of Object.entries(scenarios)) {
    const js = resolveVarPaths({ projectRoot: PROJECT_ROOT, env: nodeEnv(env) });
    assert.deepEqual(js, pythonPaths(scenarioEnv(env)), `Node and Python must resolve the same paths: ${name}`);
  }
  console.log(`PASS: Node and Python agree on ${Object.keys(scenarios).length} environments`);
}

// config/var_layout.json "retired_env": a retired name is refused by both languages, never ignored.
for (const retired of Object.keys(layout.retired_env.names)) {
  const env = { LOCALAPPDATA: path.join(scratch, "Local"), [retired]: path.join(scratch, "retired") };
  assert.throws(() => resolveVarPaths({ projectRoot: PROJECT_ROOT, env }), (error) => error.code === "RETIRED_ENV", retired);
  if (pythonAvailable) assert.throws(() => pythonPaths(env), /retired environment variable/, `${retired} (Python)`);
}

// default layout = <project>/var/<child>
{
  const paths = resolveVarPaths({ projectRoot: PROJECT_ROOT, env: { LOCALAPPDATA: path.join(scratch, "Local") } });
  assert.equal(paths.varRoot, path.join(PROJECT_ROOT, "var"));
  for (const [key, child] of [["data", "data"], ["output", "output"], ["state", "state"], ["logs", "logs"], ["temp", "temp"]]) {
    assert.equal(paths[key], path.join(PROJECT_ROOT, "var", layout.children[child].dir));
  }
  assert.equal(paths.authRoot, path.join(scratch, "Local", "StockMonitorTwse", "auth"));
}

// A source checkout and an installed app are two flavors with their own per-user directories:
// neither shares the other's AUTH_ROOT or userData, and AUTH_ROOT is never inside VAR_ROOT / the project / userData.
{
  const { installFlavor, userDataDir } = require(path.join(PROJECT_ROOT, "config", "js", "var_paths.js"));
  const local = path.join(scratch, "Local");
  const roaming = path.join(scratch, "AppData", "Roaming");
  const userData = userDataDir({ flavor: "installed", env: { APPDATA: roaming } });
  assert.equal(installFlavor({}), "source", "a process without the flavor is a source checkout");
  assert.throws(() => installFlavor({ [layout.flavor_env]: "portable" }), /not a known flavor/);
  assert.equal(userDataDir({ flavor: "source", env: { APPDATA: roaming } }), path.join(roaming, "stock-monitor-shioaji-desktop"));
  assert.equal(userData, path.join(roaming, "StockMonitor"));
  const source = resolveVarPaths({ projectRoot: PROJECT_ROOT, env: { LOCALAPPDATA: local } });
  const installedEnv = { LOCALAPPDATA: local, [layout.flavor_env]: "installed" };
  const packagedVar = resolveLaunchVarRoot(PROJECT_ROOT, { isPackaged: true, userDataPath: userData, env: installedEnv });
  const packaged = resolveVarPaths({ projectRoot: PROJECT_ROOT, env: { ...installedEnv, [layout.root_env]: packagedVar } });
  assert.equal(source.authRoot, path.join(local, "StockMonitorTwse", "auth"), "the source checkout keeps its existing AUTH_ROOT");
  assert.equal(packaged.authRoot, path.join(local, "StockMonitor", "auth"), "an installed app has its own");
  assert.equal(packaged.varRoot, path.join(userData, "var"));
  for (const p of [source, packaged]) {
    assert.ok(!p.authRoot.startsWith(p.varRoot + path.sep), "AUTH_ROOT is not under VAR_ROOT");
    assert.ok(!p.authRoot.startsWith(PROJECT_ROOT + path.sep), "AUTH_ROOT is not under the project / install directory");
  }
  assert.ok(!packaged.authRoot.startsWith(userData + path.sep), "AUTH_ROOT is not under Electron userData");
  console.log("PASS: source and installed flavors have their own AUTH_ROOT and userData, separate from VAR_ROOT");
}

// packaged launch: the install directory is read-only, so ONE variable moves the whole layout to <userData>/var
{
  const userData = path.join(scratch, "AppData", "Roaming", "StockMonitor");
  assert.equal(resolveLaunchVarRoot(PROJECT_ROOT, { isPackaged: true, userDataPath: userData, env: {} }), path.join(userData, "var"));
  assert.equal(resolveDataRoot(PROJECT_ROOT, { isPackaged: true, userDataPath: userData, env: {} }), path.join(userData, "var", "data"));
  assert.equal(resolveLaunchVarRoot(PROJECT_ROOT, { isPackaged: false, env: {} }), path.join(PROJECT_ROOT, "var"));
  const explicit = path.join(scratch, "explicit");
  assert.equal(resolveLaunchVarRoot(PROJECT_ROOT, { isPackaged: true, userDataPath: userData, env: { [layout.root_env]: explicit } }), explicit,
    "an explicit STOCK_MONITOR_VAR_ROOT always wins, packaged or not");
  console.log("PASS: source checkout -> <project>/var, packaged -> <userData>/var, explicit variable wins");
}

// Node writers: tokens -> AUTH_ROOT only, shutdown handoff -> var/output; nothing under the project root
{
  const varRoot = path.join(scratch, "writers", "var");
  const authRoot = path.join(scratch, "writers", "auth");
  const env = { [layout.root_env]: varRoot, STOCK_MONITOR_AUTH_ROOT: authRoot };
  const processRef = { env, cwd: () => scratch };
  const daemon = createDaemonAuthentication({ fs, path, processRef });
  const client = createClientAuthentication({ fs, path, processRef: { env: { ...env }, cwd: () => scratch } });
  const controller = createControllerAuthentication({ fs, path, processRef: { env: { ...env }, cwd: () => scratch } });
  assert.equal(daemon.tokenFile, path.join(authRoot, "daemon_auth_token"));
  assert.equal(client.tokenFile, path.join(authRoot, "client_auth_token"));
  assert.equal(controller.tokenFile, path.join(authRoot, "controller_auth_token"));
  assert.ok(fs.existsSync(daemon.tokenFile) && fs.existsSync(client.tokenFile) && fs.existsSync(controller.tokenFile));
  assert.ok(!fs.existsSync(varRoot), "token creation must not create anything under VAR_ROOT");

  const previous = process.env[layout.root_env];
  process.env[layout.root_env] = varRoot;
  try {
    const handoff = createShutdownHandoffStore(PROJECT_ROOT, { logger: { error() {} } });
    assert.equal(handoff.persist({ scope: "test" }), true);
    assert.ok(fs.existsSync(path.join(varRoot, "output", "app_shutdown_handoff.json")));
  } finally {
    if (previous === undefined) delete process.env[layout.root_env]; else process.env[layout.root_env] = previous;
  }
  assert.ok(!fs.existsSync(path.join(scratch, "StockMonitorTwse")), "no cwd fallback directory");
  console.log("PASS: Node token writers land under AUTH_ROOT, the shutdown handoff under var/output");
}
// config/var_layout.json "storage": both languages put the same children under a storage location, the same default
// location under a data root, and call the same top-level entries StockMonitor's (what a location change moves).
{
  const { storageDefaultRoot, storagePaths, isOwnedStorageEntry } = require("../config/js/var_paths");
  const root = path.join(scratch, "storage-root");
  const names = ["source=shioaji", "source=futu", "analysis-events", "model", "notes.txt", "sources", ".stock-monitor-historical.json"];
  const node = { defaultRoot: storageDefaultRoot(path.join(scratch, "data")), paths: storagePaths(root), owned: names.filter(isOwnedStorageEntry) };
  assert.deepEqual(node.owned, ["source=shioaji", "source=futu", "analysis-events", "model"]);
  assert.equal(node.paths.analysis_events, path.join(root, "analysis-events"));
  assert.equal(node.paths.model_registry, path.join(root, "model", "online_registry"));
  if (pythonAvailable) {
    const code = "import json,sys,dataclasses; sys.path.insert(0, sys.argv[1]); from pathlib import Path; from service.platform import project_root as p; "
      + "names=json.loads(sys.argv[4]); print(json.dumps({'defaultRoot': str(p.storage_default_root(Path(sys.argv[3]))), "
      + "'paths': {k: str(v) for k, v in dataclasses.asdict(p.storage_paths(Path(sys.argv[2]))).items()}, 'owned': [n for n in names if p.storage_owned_entry(n)]}))";
    const result = spawnSync(pythonBin, ["-c", code, PROJECT_ROOT, root, path.join(scratch, "data"), JSON.stringify(names)], { cwd: PROJECT_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).pop()), node);
    console.log("PASS: Python and Node agree on the storage location's children and owned entries");
  }
}
console.log("var layout parity contract passed");
