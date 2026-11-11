"use strict";

// Pure launch-configuration rules shared by Electron main and Health (AGENTS.md section 3): the internal
// runtime contract (process identities and protocol versions) and the rule that places VAR_ROOT/DATA_ROOT. No
// process spawning, no machine probing, no env mutation -- that is service/platform/js/launch_runtime.js. Never
// requires "electron".

const fs = require("fs");
const path = require("path");
const { loadVarLayout, resolveVarRoot, resolveVarPaths } = require("./var_paths");

class RuntimeConfigurationError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "RuntimeConfigurationError";
    this.code = "RUNTIME_CONFIGURATION_INVALID";
  }
}

// Packaged resources are (or should be treated as) read-only, reinstallable
// application files -- never a place to write live market data, SQLite
// databases, or logs. The logical VAR_ROOT (config/var_layout.json) therefore has
// a physical location that depends on how the app was launched:
//   * $STOCK_MONITOR_VAR_ROOT, when set, always wins;
//   * source checkout / dev: <projectRoot>/var;
//   * packaged: <Electron userData>/var  (the install directory is not writable).
// The launcher computes it ONCE (loadRuntime) and exports it, so every child
// process (Python gateway, daemons, Health) resolves the same
// physical root from the same env variable.
function resolveLaunchVarRoot(projectRoot, { isPackaged = false, userDataPath, env = process.env } = {}) {
  const layout = loadVarLayout();
  if (String(env[layout.root_env] || "").trim()) return resolveVarRoot({ projectRoot, env });
  if (isPackaged) {
    // The caller knows where the per-user profile is (Electron's userData); this module never probes the machine.
    if (!userDataPath) throw new RuntimeConfigurationError("a packaged launch needs userDataPath to place VAR_ROOT");
    return path.join(userDataPath, layout.default_root);
  }
  return resolveVarRoot({ projectRoot, env });
}

// The data root a launch would use (explicit data-root env aliases still win, as in service/platform/project_root.py).
function resolveDataRoot(projectRoot, { isPackaged = false, userDataPath, env = process.env } = {}) {
  const layout = loadVarLayout();
  const varRoot = resolveLaunchVarRoot(projectRoot, { isPackaged, userDataPath, env });
  return resolveVarPaths({ projectRoot, env: { ...env, [layout.root_env]: varRoot } }).data;
}

// Every field a consumer reads, with its type: the same table as service/platform/runtime_contract.py REQUIRED_FIELDS,
// so a damaged file is refused at load by both languages with the same problems (tests/fixtures/runtime_contract_cases.json).
const REQUIRED_FIELDS = [
  ["backend.architecture", "string"],
  ["backend.runtime_version", "string"],
  ["backend.renderer_protocol_version", "integer"],
  ["backend.canonical_frame_protocol_version", "integer"],
  ["market_daemon.identity", "string"],
  ["market_daemon.protocol_version", "integer"],
  ["market_daemon.runtime_version", "string"],
  ["moomoo_daemon.identity", "string"],
  ["moomoo_daemon.protocol_version", "integer"],
  ["moomoo_daemon.runtime_version", "string"],
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function contractProblems(contract) {
  if (!isObject(contract)) return ["contract must be a JSON object"];
  const problems = [];
  for (const [field, kind] of REQUIRED_FIELDS) {
    const [section, key] = field.split(".");
    const value = isObject(contract[section]) ? contract[section][key] : undefined;
    if (kind === "string" && !(typeof value === "string" && value)) problems.push(`${field} must be a non-empty string`);
    else if (kind === "integer" && !(Number.isInteger(value) && value >= 1)) problems.push(`${field} must be a positive integer`);
  }
  return problems;
}

function loadRuntimeContract(projectRoot) {
  const contractPath = path.join(projectRoot, "config", "runtime_contract.json");
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (error) {
    throw new RuntimeConfigurationError(
      `無法讀取啟動設定 ${contractPath}。請修復或重新安裝 StockMonitor。`,
      { cause: error },
    );
  }
  const problems = contractProblems(contract);
  if (problems.length) {
    throw new RuntimeConfigurationError(`啟動設定 ${contractPath} 不正確：${problems.join("; ")}`);
  }
  return contract;
}

module.exports = { loadRuntimeContract, contractProblems, REQUIRED_FIELDS, resolveLaunchVarRoot, resolveDataRoot, RuntimeConfigurationError };
