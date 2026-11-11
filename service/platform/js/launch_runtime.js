"use strict";

// Launch-environment probing for Electron main and Health (AGENTS.md section 3: separated from the pure
// configuration rules in config/js/runtime_contract.js). This is the part that looks at the machine: where the
// installed runtime is, whether a usable Python exists (it runs `python --version`), the per-user profile path,
// and the one-time export of VAR_ROOT / log session into the launching process env so every child inherits the
// same roots. Never requires "electron" -- callers pass isPackaged/resourcesPath/userDataPath in.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadNetworkRuntime } = require("../../../config/js/runtime_config");
const { loadVarLayout, resolveVarPaths } = require("../../../config/js/var_paths");
const { loadRuntimeContract, resolveLaunchVarRoot, RuntimeConfigurationError } = require("../../../config/js/runtime_contract");
const { loadVarLayout: loadLayoutFile, userDataDir } = require("../../../config/js/var_paths.js");
const { logSessionId } = require("./log_session.js");

// The per-user directories of a source checkout and of an installed app are two flavors of config/var_layout.json
// (userData, AUTH_ROOT): an installed app never shares the developer checkout's window layout, data or IPC tokens, and
// its uninstaller removes only its own. Electron (ui/main/main.js) and the standalone Health resolve userData with the
// same userDataDir(), never from Electron's app name.
function flavorOf(isPackaged) {
  return isPackaged ? "installed" : "source";
}

// service/platform/js/launch_runtime.js -> project root (three levels up). Kept as a standalone, self-contained function (only `path`) so
// it can be resolved before anything else in the process needs a path.
function getProjectRoot({ isPackaged = false, resourcesPath } = {}) {
  // An ASAR/packaged layout is not a backend distribution by itself. Do not
  // fall back to an unrelated parent directory or launch a host Python
  // against missing files.
  if (isPackaged) {
    if (!resourcesPath) {
      throw new Error(
        "PACKAGING_CONTRACT_INCOMPLETE: installed runtime is unavailable; the packaged process did not "
        + "report a resources path. Use the source distribution.",
      );
    }
    // The exact staged layout package.json's build.extraResources
    // produces under app-runtime/ (main.py, backend/, service/, config/,
    // and the redistributable interpreter itself at
    // python/python.exe -- see scripts/tooling/stage_python_runtime.py).
    // Every one of these must genuinely exist; this is a real structural
    // check, not a marker file, matching audit_packaging.cjs's own standard.
    const packagedRoot = path.join(resourcesPath, "app-runtime");
    const requiredMarkers = [
      "main.py", "service", "config", "backend",
      path.join("python", "python.exe"),
    ];
    const missing = requiredMarkers.filter((marker) => !fs.existsSync(path.join(packagedRoot, marker)));
    if (missing.length) {
      throw new Error(
        "PACKAGING_CONTRACT_INCOMPLETE: installed runtime is unavailable; Python/native dependencies "
        + `and writable data roots require a validated staging contract. Missing under ${packagedRoot}: `
        + `${missing.join(", ")}. Use the source distribution.`,
      );
    }
    return packagedRoot;
  }
  return path.resolve(__dirname, "..", "..", "..");
}

function resolvePythonExecutable(projectRoot, { env = process.env, spawnSyncImpl } = {}) {
  const explicit = String(env.STOCK_MONITOR_PYTHON_EXECUTABLE || "").trim();
  const bundled = path.join(projectRoot, "python", "python.exe");
  const candidate = explicit || (fs.existsSync(bundled) ? bundled : "python");
  const spawnSync = spawnSyncImpl || require("child_process").spawnSync;
  const probe = spawnSync(candidate, ["--version"], {
    cwd: projectRoot, windowsHide: true, encoding: "utf8", timeout: 5000,
  });
  if (probe.error || probe.status !== 0) {
    const detail = String(probe.error?.message || probe.stderr || probe.stdout || "找不到可用的 Python").trim();
    throw new RuntimeConfigurationError(
      `Python 執行環境不可用（${candidate}）：${detail}。請設定 STOCK_MONITOR_PYTHON_EXECUTABLE 或安裝相容的 Python。`,
      { cause: probe.error },
    );
  }
  return candidate;
}

// The interpreter stage_python_runtime.py staged into the installer (app-runtime/python/python.exe), as opposed to
// a developer's own Python or an explicit STOCK_MONITOR_PYTHON_EXECUTABLE pointing elsewhere.
function isBundledInterpreter(projectRoot, pythonExecutable) {
  return path.resolve(String(pythonExecutable || "")).toLowerCase()
    === path.resolve(projectRoot, "python", "python.exe").toLowerCase();
}

// Single structured runtime description for a process: where the project
// lives, which provider policy this launch uses, the compatible versions
// every backend/daemon must report, and where they listen. Callers receive
// this once and never re-derive any of it themselves.
//
// `isPackaged`/`resourcesPath`/`userDataPath` are supplied by the entry
// point (ui/main/main.js passes Electron's app.isPackaged /
// process.resourcesPath / app.getPath("userData"); health/main.js
// computes its own packaged flag from STOCK_MONITOR_RESOURCES_PATH and
// resolveElectronCompatibleUserDataPath() above) so this module itself
// never touches Electron.
function loadRuntime({ env = process.env, isPackaged = false, resourcesPath, userDataPath } = {}) {
  const projectRoot = getProjectRoot({ isPackaged, resourcesPath });
  // Decided here, from whether this is the installed app, and inherited by every child (Health, the APIs, the
  // daemons): userData, VAR_ROOT and AUTH_ROOT all follow this one value. An inherited value that disagrees
  // (an installed app started from a source checkout's shell) is replaced, never kept -- it would put AUTH_ROOT in the
  // other flavor's directory and share its tokens.
  const flavorEnv = loadLayoutFile().flavor_env;
  const flavor = flavorOf(isPackaged);
  const inherited = String(env[flavorEnv] || "").trim();
  if (inherited && inherited !== flavor) {
    console.warn(`[RUNTIME] ${flavorEnv}=${inherited} inherited, but this is the ${flavor} app: using ${flavor}`);
  }
  env[flavorEnv] = flavor;
  userDataPath = userDataPath || (isPackaged ? userDataDir({ env }) : undefined);
  const contract = loadRuntimeContract(projectRoot);
  const pythonExecutable = resolvePythonExecutable(projectRoot, { env });
  // Every Python process spawned from the Controller (gateway, both daemons,
  // startup diagnostics) inherits `env` via its own
  // `...process.env` spread, so setting VAR_ROOT once here -- rather than in
  // each separate spawn call site -- is the single point that keeps them all
  // pointed at the same writable root. An explicit STOCK_MONITOR_VAR_ROOT (or
  // any per-child / data-root override service/platform/project_root.py itself
  // recognizes) is always respected, never clobbered.
  const layout = loadVarLayout();
  if (!String(env[layout.root_env] || "").trim()) {
    env[layout.root_env] = resolveLaunchVarRoot(projectRoot, { isPackaged, userDataPath, env });
  }
  const varPaths = resolveVarPaths({ projectRoot, env });
  // The bundled interpreter must see only what the installer staged plus the user's provider-sdk directory
  // (its sitecustomize.py). Without this, `import site` in its ._pth also adds the machine's per-user
  // %APPDATA%\Python\Python314\site-packages -- someone else's packages, and their .pth code, ahead of the SDK
  // directory. Same single point as VAR_ROOT: every Python child inherits it. A source checkout keeps the user
  // site: the developer's own interpreter may hold the broker SDKs there.
  if (isBundledInterpreter(projectRoot, pythonExecutable)) env.PYTHONNOUSERSITE = "1";

  return {
    projectRoot,
    varPaths,
    // One log directory per App run, shared by every process this run spawns. Minted here
    // because both entry points go through loadRuntime(): Electron (ui/main/main.js) reaches it
    // first and exports the id into its own process.env, so Health -- and every service Health
    // spawns with { ...process.env } -- inherits the same directory. A standalone Health run
    // mints its own. See service/platform/js/log_session.js and service/platform/log_session.py.
    logSession: logSessionId(env),
    pythonExecutable,
    // Resolved here, after flavor and VAR_ROOT are set in `env`, from this install's own manifest and config root.
    network: loadNetworkRuntime({ env, projectRoot, configRoot: varPaths.config }),
    backend: {
      architecture: String(contract.backend.architecture),
      runtimeVersion: String(contract.backend.runtime_version),
      rendererProtocolVersion: Number(contract.backend.renderer_protocol_version),
    },
    marketDaemon: {
      identity: String(contract.market_daemon.identity),
      protocolVersion: Number(contract.market_daemon.protocol_version),
      runtimeVersion: String(contract.market_daemon.runtime_version),
    },
    moomooDaemon: {
      identity: String(contract.moomoo_daemon.identity),
      protocolVersion: Number(contract.moomoo_daemon.protocol_version),
      runtimeVersion: String(contract.moomoo_daemon.runtime_version),
    },
  };
}

module.exports = {
  loadRuntime, resolvePythonExecutable, isBundledInterpreter, getProjectRoot,
  flavorOf,
};
