"use strict";

// The environment a launcher hands to a child process: an allowlist, never
// `{ ...process.env }`. A child receives
//   - the operating-system variables a Windows/Python/Rust process needs to run at all (exact names below),
//   - the application variables a child reads, a closed list (config/child_env_names.json) and every name
//     config/var_layout.json resolves a location from,
//   - network proxy / CA settings (a corporate proxy must keep working for the GAS sync and the brokers),
// minus anything that looks like a credential, and then exactly the credentials its role was granted (`grant`).
// Whatever else the launcher was started with -- a third-party API key, a cloud token, NODE_OPTIONS, PYTHONPATH,
// PYTHONSTARTUP -- does not reach the child.
//
// Names are matched case-insensitively (Windows environment names are), and the child receives the parent's spelling.

const OS_NAMES = [
  // Windows
  "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "USERNAME",
  "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "PUBLIC", "ALLUSERSPROFILE",
  "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION", "OS",
  // POSIX / locale / time zone
  "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "XDG_CONFIG_HOME",
  "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  // Python runtime behavior (never PYTHONPATH/PYTHONHOME/PYTHONSTARTUP: those load code into the child).
  // PYTHONOPTIMIZE passes on purpose: service/platform/interpreter_guard.py must still see it and refuse to start.
  // PYTHONNOUSERSITE only narrows sys.path; the packaged launch sets it (launch_runtime.js loadRuntime).
  "PYTHONUTF8", "PYTHONIOENCODING", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE", "PYTHONOPTIMIZE", "PYTHONNOUSERSITE",
  // numeric libraries' thread pools
  "OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS",
  // Rust diagnostics
  "RUST_BACKTRACE", "RUST_LOG",
  // network: proxy and certificate trust
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
];

// The application variables a child reads, one by one (tests/child_env_names_contract.cjs fails when the code reads
// one that is not listed); an unlisted STOCK_MONITOR_* name stays with the launcher.
const APP_NAMES = require("../../../config/child_env_names.json").inherit;

// Never inherited, even when listed; a role gets these only through `grant`. A token FILE path is withheld like the
// token itself, and so is any other secret-looking name -- a `_DIR`/`_ROOT` ending does not make one safe.
const SECRET_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY|COOKIE|SESSION_?KEY)/i;
// The secret-looking names that are directories a child must resolve, listed one by one: the var_layout.json locations
// (layoutNames: STOCK_MONITOR_AUTH_ROOT ...) and the broker credential directory (service/platform/runtime_credentials.py).
const SECRET_LOOKING_PATHS = ["STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR"];

// Every variable config/var_layout.json resolves a location from (the flavor, VAR_ROOT, AUTH_ROOT and its base
// directory and each child's overrides): a child must resolve exactly the paths its
// launcher did. The retired names pass too, so a child refuses them as its launcher does instead of never seeing them.
function layoutNames() {
  const layout = require("../../../config/js/var_paths").loadVarLayout();
  return [layout.flavor_env, layout.root_env, ...(layout.auth_root?.env || []), layout.auth_root?.base_env,
    ...Object.values(layout.children || {}).flatMap((child) => child.env || []),
    ...Object.keys(layout.retired_env?.names || {})].filter(Boolean);
}

const OS_LOOKUP = new Set([...OS_NAMES, ...layoutNames(), ...APP_NAMES].map((name) => name.toUpperCase()));
const PATH_LOOKUP = new Set([...layoutNames(), ...SECRET_LOOKING_PATHS].map((name) => name.toUpperCase()));

function isSecretName(name) {
  return SECRET_PATTERN.test(name) && !PATH_LOOKUP.has(String(name).toUpperCase());
}

function inheritable(name) {
  const upper = String(name).toUpperCase();
  if (isSecretName(upper)) return false;
  return OS_LOOKUP.has(upper);
}

// parentEnv: the launcher's environment. grant: the credentials (or digests) this child's role needs, plus any
// per-child settings; a grant value of undefined/null is omitted.
function childEnv(parentEnv, grant = {}) {
  const env = {};
  for (const [name, value] of Object.entries(parentEnv || {})) {
    if (value !== undefined && value !== null && inheritable(name)) env[name] = String(value);
  }
  for (const [name, value] of Object.entries(grant || {})) {
    if (value === undefined || value === null) continue;
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
    env[name] = String(value);
  }
  return env;
}

// The long-running Python services (APIs, provider daemons) do no matrix work, but `import numpy` (also pulled in by
// pyarrow/pandas) makes OpenBLAS commit one buffer per core: +363 MB per process on a 12-core machine, +9 MB with one
// thread (measured 2026-11-06). A value the launcher was started with still wins.
function pythonServiceThreadDefaults(parentEnv) {
  const set = Object.keys(parentEnv || {}).some((name) => name.toUpperCase() === "OPENBLAS_NUM_THREADS");
  return set ? {} : { OPENBLAS_NUM_THREADS: "1" };
}

module.exports = { childEnv, inheritable, isSecretName, pythonServiceThreadDefaults, OS_NAMES, APP_NAMES, layoutNames };
