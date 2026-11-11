"use strict";
// Node side of the var/ layout contract. config/var_layout.json is the ONE description of the layout; this module and
// service/platform/project_root.py (Python) both resolve paths from it with identical rules, and
// tests/var_layout_parity_contract.cjs proves they agree. Native/Rust receives explicit --data-dir arguments.
//
//   VAR_ROOT   = $STOCK_MONITOR_VAR_ROOT, else <projectRoot>/var   (the launcher exports it once; packaged builds point it
//                                                                   at <userData>/var because the install directory is read-only)
//   <child>    = first set env override of that child, else VAR_ROOT/<dir>
//   AUTH_ROOT  = $STOCK_MONITOR_AUTH_ROOT, else %LOCALAPPDATA%/<flavor auth_dir> -- NOT under VAR_ROOT: local IPC tokens only
//                (broker credentials are in Windows Credential Manager). The flavor ($STOCK_MONITOR_INSTALL_FLAVOR: source,
//                the default, or installed -- set once by the launcher) gives a source checkout and an installed app their own
//                per-user directories: StockMonitorTwse/auth and StockMonitor/auth; userData likewise (userDataDir()).
//
// The layout file is located relative to THIS module (config/js/../var_layout.json), so it resolves the same way from a
// source checkout and from app.asar.unpacked, independent of which project root the caller passes.
const fs = require("fs");
const os = require("os");
const path = require("path");

const LAYOUT_PATH = path.join(__dirname, "..", "var_layout.json");
const SOURCE_PROJECT_ROOT = path.resolve(__dirname, "..", "..");   // default only; packaged launches export STOCK_MONITOR_VAR_ROOT
let _layout = null;

function loadVarLayout() {
  if (!_layout) _layout = JSON.parse(fs.readFileSync(LAYOUT_PATH, "utf8"));
  return _layout;
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return path.resolve(value.replace(/^~(?=[\\/]|$)/, os.homedir()));   // same "~" expansion as Python expanduser()
  }
  return "";
}

function resolveVarRoot({ projectRoot = SOURCE_PROJECT_ROOT, env = process.env } = {}) {
  const spec = loadVarLayout();
  return firstEnv(env, [spec.root_env]) || path.resolve(projectRoot, spec.default_root);
}

/** "source" or "installed": which per-user directories this process uses (config/var_layout.json "flavors"). */
function installFlavor(env = process.env) {
  const layout = loadVarLayout();
  const value = String(env[layout.flavor_env] || "").trim().toLowerCase() || "source";
  if (!layout.flavors[value]) throw new Error(`${layout.flavor_env}=${value} is not a known flavor (${Object.keys(layout.flavors).join(", ")})`);
  return value;
}

function resolveAuthRoot({ env = process.env } = {}) {
  const layout = loadVarLayout();
  const spec = layout.auth_root;
  const explicit = firstEnv(env, spec.env);
  if (explicit) return explicit;
  const base = String(env[spec.base_env] || "").trim();
  const basePath = base ? path.resolve(base.replace(/^~(?=[\/]|$)/, os.homedir())) : path.resolve(os.homedir(), ...spec.base_fallback);
  return path.join(basePath, ...layout.flavors[installFlavor(env)][spec.dir_from_flavor]);
}

/** The Electron userData directory of a flavor (Windows: %APPDATA%/<user_data_dir>), for Electron and for Health. */
function userDataDir({ flavor = null, env = process.env } = {}) {
  const name = loadVarLayout().flavors[flavor || installFlavor(env)].user_data_dir;
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), name);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", name);
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), name);
}

// config/var_layout.json "retired_env": a retired name is refused, never ignored -- an ignored data-root override
// would put that run's data somewhere it does not expect. Same rule as project_root.py refuse_retired_env().
function refuseRetiredEnv(env = process.env) {
  const retired = loadVarLayout().retired_env?.names || {};
  const found = Object.keys(retired).filter((name) => String(env[name] || "").trim()).sort();
  if (found.length) {
    const error = new Error(`retired environment variable(s) set: ${found.map((name) => `${name} (use ${retired[name]})`).join(", ")}`);
    error.code = "RETIRED_ENV";
    throw error;
  }
}

function resolveVarPaths({ projectRoot = SOURCE_PROJECT_ROOT, env = process.env } = {}) {
  const layout = loadVarLayout();
  refuseRetiredEnv(env);
  const varRoot = resolveVarRoot({ projectRoot, env });
  const at = (name) => firstEnv(env, layout.children[name].env) || path.join(varRoot, layout.children[name].dir);
  return {
    varRoot,
    data: at("data"),
    output: at("output"),
    state: at("state"),
    logs: at("logs"),
    temp: at("temp"),
    config: at("config"),
    authRoot: resolveAuthRoot({ env }),
  };
}

// config/var_layout.json "storage": what lives under the user's storage location (the active one comes from
// config/js/storage_settings.js). The root itself holds the raw-history partitions; the children grow without bound.
// Same rules as project_root.py storage_default_root() / storage_paths() / storage_owned_entry().
function storageDefaultRoot(dataRoot) {
  return path.join(dataRoot, loadVarLayout().storage.default_dir);
}

function storagePaths(storageRoot) {
  const out = { root: storageRoot };
  for (const [name, rel] of Object.entries(loadVarLayout().storage.children)) out[name] = path.join(storageRoot, ...rel.split("/"));
  return out;
}

function isOwnedStorageEntry(name) {
  const spec = loadVarLayout().storage;
  return spec.root_prefixes.some((prefix) => name.startsWith(prefix))
    || Object.values(spec.children).some((rel) => rel.split("/")[0] === name);
}

module.exports = { loadVarLayout, storageDefaultRoot, storagePaths, isOwnedStorageEntry, refuseRetiredEnv, resolveVarRoot, resolveAuthRoot, resolveVarPaths, installFlavor, userDataDir, SOURCE_PROJECT_ROOT };
