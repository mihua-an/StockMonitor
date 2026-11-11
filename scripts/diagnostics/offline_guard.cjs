"use strict";
// Deny by default. Contracts provide fake transports/windows, so no live connection or
// process launch is permitted unless STOCK_MONITOR_OFFLINE_ALLOW names an allowance.
// scripts/diagnostics/check_offline.py sets that variable per contract file, never globally,
// and strips any inherited STOCK_MONITOR_* so the host cannot widen the boundary.
const path = require("node:path");

const KNOWN_ALLOWANCES = new Set(["loopback", "subprocess"]);
const allowed = new Set(
  String(process.env.STOCK_MONITOR_OFFLINE_ALLOW || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const unknown = [...allowed].filter((value) => !KNOWN_ALLOWANCES.has(value));
if (unknown.length) {
  throw new Error(`Offline guard: unknown STOCK_MONITOR_OFFLINE_ALLOW value(s): ${unknown.join(", ")}`);
}

const deny = (what) => {
  throw new Error(`Offline contract forbids live network/process launch: ${what}`);
};

// ---------------------------------------------------------------- loopback

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]);

function isLoopbackHost(host) {
  if (typeof host !== "string" || !host) return false;
  const bare = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return LOOPBACK_HOSTS.has(bare) || /^127(\.\d{1,3}){3}$/.test(bare);
}

function loopbackPermitted(host) {
  return allowed.has("loopback") && isLoopbackHost(host);
}

const net = require("node:net");
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  // connect(options[, cb]) | connect(port[, host][, cb]) | connect(path[, cb])
  let host;
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    host = typeof first.path === "string" ? first.path : first.host === undefined ? "localhost" : first.host;
  } else if (typeof first === "string" && !/^\d+$/.test(first)) {
    host = first; // pipe / unix socket path: never a loopback host, so always denied
  } else {
    host = typeof args[1] === "string" ? args[1] : "localhost";
  }
  if (!loopbackPermitted(host)) deny(`net.Socket.connect ${String(host)}`);
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = function fetch(resource, options) {
  const raw = typeof resource === "string" ? resource
    : resource instanceof URL ? resource.href
    : resource && typeof resource.url === "string" ? resource.url
    : String(resource);
  let hostname = null;
  try {
    hostname = new URL(raw).hostname;
  } catch { /* not an error: a URL that cannot be parsed has no hostname and is denied below */ 
    hostname = null;
  }
  if (!loopbackPermitted(hostname)) deny(`fetch ${raw}`);
  return originalFetch.call(this, resource, options);
};

require("node:dgram").createSocket = () => deny("dgram.createSocket");
globalThis.WebSocket = class {
  constructor() {
    deny("WebSocket");
  }
};

// ------------------------------------------------------------- subprocess

// Only the interpreters the contracts legitimately re-enter: this Node binary and the
// exact Python that check_offline.py is running under (its sys.executable). Anything
// else -- npm, git, powershell, a packaged StockMonitor.exe -- stays blocked.
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const fs = require("node:fs");

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** "node", "python" or null: which allowed interpreter `file` is. */
function interpreterOf(file) {
  if (typeof file !== "string" || !file) return null;
  if (samePath(file, process.execPath)) return "node";
  const python = process.env.STOCK_MONITOR_OFFLINE_PYTHON;
  return python && samePath(file, python) ? "python" : null;
}

function insideProject(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  const resolved = path.resolve(PROJECT_ROOT, candidate);
  const root = PROJECT_ROOT.replace(/[\\/]+$/, "");
  return resolved === root || resolved.startsWith(root + path.sep);
}

// A module of the snapshot (-m a.b.c): a .py file or a package directory inside the project.
function projectModule(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(name)) return false;
  const base = path.join(PROJECT_ROOT, ...name.split("."));
  return insideProject(base) && (fs.existsSync(`${base}.py`) || fs.existsSync(path.join(base, "__init__.py")));
}

// Python's argv, read the way CPython reads it. The guard in the child is sitecustomize.py (offline_guard.py),
// which -S (no site), -I (isolated) and -E (ignore PYTHON* -- PYTHONPATH is where sitecustomize is found) would
// skip, so those are refused; -X/-W and anything else unknown are refused too. -c is allowed because the child is
// then guaranteed to load the guard (the flags above are refused and its environment is forced below).
const PYTHON_SAFE_LETTERS = new Set(["u", "B", "q", "s"]);
function allowedPythonArgv(args) {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--version" || token === "-V") return i === args.length - 1;
    if (token === "-c") return i + 1 < args.length;
    if (token === "-m") return projectModule(args[i + 1]);
    if (token.startsWith("--") || token === "-") return false;
    if (token.startsWith("-")) {
      if (![...token.slice(1)].every((letter) => PYTHON_SAFE_LETTERS.has(letter))) return false;
      continue;
    }
    return insideProject(token);
  }
  return false;
}

// Node's argv: a script of the snapshot first (or --version). -e/-p/--require and every other flag are refused:
// the child gets the guard through NODE_OPTIONS (forced below), which an inline flag must not be able to undo.
function allowedNodeArgv(args) {
  if (args.length === 1 && args[0] === "--version") return true;
  return !args[0].startsWith("-") && insideProject(args[0]);
}

// Constrained argv per interpreter. No shell, no non-string argv, never an empty argv.
function allowedArgv(interpreter, args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  if (!args.every((value) => typeof value === "string")) return false;
  return interpreter === "python" ? allowedPythonArgv(args) : allowedNodeArgv(args);
}

function usesShell(options) {
  return Boolean(options && typeof options === "object" && options.shell);
}

function subprocessPermitted(file, args, options) {
  const interpreter = interpreterOf(file);
  return allowed.has("subprocess") && !usesShell(options) && interpreter !== null && allowedArgv(interpreter, args);
}

// A permitted child always carries this boundary, whatever environment the contract hands it: the offline
// variables, the allowance, PYTHONPATH led by the snapshot (where sitecustomize.py is) and, for Node, this guard
// in NODE_OPTIONS. A contract can add variables but cannot drop these.
const GUARD_ENV_NAMES = ["STOCK_MONITOR_OFFLINE_CHECK", "STOCK_MONITOR_CHECK_ORIGINAL", "STOCK_MONITOR_CHECK_RUN",
  "STOCK_MONITOR_OFFLINE_ALLOW", "STOCK_MONITOR_OFFLINE_PYTHON"];
function guardedEnv(interpreter, env) {
  const out = { ...(env || process.env) };
  for (const name of GUARD_ENV_NAMES) {
    if (process.env[name] !== undefined) out[name] = process.env[name];
  }
  if (interpreter === "python") {
    const rest = String(out.PYTHONPATH || "").split(path.delimiter).filter((entry) => entry && !samePath(entry, PROJECT_ROOT));
    out.PYTHONPATH = [PROJECT_ROOT, ...rest].join(path.delimiter);
  } else {
    const guard = `--require ${JSON.stringify(__filename)}`;
    out.NODE_OPTIONS = String(out.NODE_OPTIONS || "").includes(__filename) ? out.NODE_OPTIONS : `${guard} ${out.NODE_OPTIONS || ""}`.trim();
  }
  return out;
}

const childProcess = require("node:child_process");
// exec/execSync route through a shell by definition: no allowance ever covers them.
for (const name of ["exec", "execSync"]) {
  const blocked = name;
  childProcess[name] = () => deny(`child_process.${blocked}`);
}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[name];
  const blocked = name;
  childProcess[name] = function guarded(file, args, options, ...rest) {
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    if (!subprocessPermitted(file, argv, opts)) deny(`child_process.${blocked} ${String(file)} ${argv.join(" ")}`);
    const callback = Array.isArray(args) ? rest : (typeof options === "function" ? [options, ...rest] : rest);
    const forced = { ...(opts && typeof opts === "object" ? opts : {}), env: guardedEnv(interpreterOf(file), opts?.env) };
    return original.call(this, file, argv, forced, ...callback);
  };
}
const originalFork = childProcess.fork;
childProcess.fork = function guardedFork(modulePath, args, options) {
  const argv = Array.isArray(args) ? args : [];
  const opts = Array.isArray(args) ? options : args;
  // fork always re-enters process.execPath; the constraint is the module it loads.
  if (!allowed.has("subprocess") || usesShell(opts) || !insideProject(modulePath)
      || !argv.every((value) => typeof value === "string") || (opts?.execArgv || []).length) {
    deny(`child_process.fork ${String(modulePath)}`);
  }
  return originalFork.call(this, modulePath, argv, { ...(opts || {}), env: guardedEnv("node", opts?.env) });
};
