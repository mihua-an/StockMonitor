"use strict";

// The role tokens under AUTH_ROOT. Health is their only minter in the App: it creates each one (first writer wins)
// and, on a full start -- no process of an earlier Health still running -- replaces every one (renewRoleTokens).
// Electron main and the web gateway only read, at each use, so they follow a renewal without being restarted. A
// process started by hand without Health (a developer tool, a test) still creates the file it needs.

const { createHash, randomBytes } = require("crypto");
const { resolveVarPaths } = require("../../../config/js/var_paths");

// AUTH_ROOT (%LOCALAPPDATA%/StockMonitorTwse/auth, or STOCK_MONITOR_AUTH_ROOT): the single directory for IPC tokens, the
// same for source checkout and packaged app and independent of VAR_ROOT. Tokens are the ONLY thing stored there.
function localAuthDir(processRef) {
  return resolveVarPaths({ env: processRef.env }).authRoot;
}

// The token in `tokenFile`, or null: absent, unreadable (warned) or too short to be one.
function readTokenFile(fs, tokenFile) {
  try {
    const token = String(fs.readFileSync(tokenFile, "ascii") || "").trim();
    return token.length >= 32 ? token : null;
  } catch (error) { /* absent is not an error: no token file yet */ if (error?.code !== "ENOENT") console.warn("[reading an auth token] failed", error); return null; }
}

// Where a role's token file is: its override variable, else its name under AUTH_ROOT.
function authTokenFile({ path, processRef }, overrideEnv, fileName) {
  return String(processRef.env[overrideEnv] || "").trim() || path.join(localAuthDir(processRef), fileName);
}

// First-writer-wins, any-process-may-read token file. Every role token uses this exact mechanism; they are
// deliberately separate files (separate trust boundaries), not one shared secret. The token is RETURNED, never
// written into processRef.env: an exported token would be inherited by every child the
// process started. Health hands each child only what its role needs (service/platform/js/child_env.js).
function loadOrCreateLocalToken({ fs, path, tokenFile }) {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  let token = readTokenFile(fs, tokenFile);
  if (!token) {
    const created = randomBytes(32).toString("hex");
    try { fs.writeFileSync(tokenFile, created, { encoding: "ascii", flag: "wx", mode: 0o600 }); token = created; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // not an error: another process created the token first; that one is used
      token = readTokenFile(fs, tokenFile);
    }
  }
  if (!token) throw new Error(`Authentication token at ${tokenFile} is invalid`);

  function fetch(input, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    return globalThis.fetch(input, { ...options, headers });
  }
  return { token, tokenFile, digest: tokenDigest(token), fetch };
}

// What a VERIFIER is given instead of the token: a process that only checks a credential holds its SHA-256,
// so it cannot present that credential to anyone else. Lowercase hex, the same as hashlib.sha256().hexdigest().
function tokenDigest(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

// A new token in place of the one in `tokenFile`: written beside it and renamed over it, so a reader sees either the
// old token or the new one, never an empty or half-written file.
function renewLocalToken({ fs, path, tokenFile }) {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const temp = `${tokenFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, randomBytes(32).toString("hex"), { encoding: "ascii", flag: "wx", mode: 0o600 });
  try { fs.renameSync(temp, tokenFile); } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch (cleanup) { console.warn("[removing a token temp file] failed", cleanup); }
    throw error;
  }
}

// The role token files of these helpers, in one place: Health renews exactly these (and the market_runtime role
// tokens, service/platform/js/runtime_credentials.js).
const ROLE_TOKEN_FILES = {
  daemon: ["STOCK_MONITOR_DAEMON_TOKEN_FILE", "daemon_auth_token"],
  management: ["STOCK_MONITOR_MANAGEMENT_TOKEN_FILE", "management_auth_token"],
  controller: ["STOCK_MONITOR_CONTROLLER_TOKEN_FILE", "controller_auth_token"],
  client: ["STOCK_MONITOR_CLIENT_TOKEN_FILE", "client_auth_token"],
};
function roleTokenFile({ path, processRef }, role) {
  const [overrideEnv, fileName] = ROLE_TOKEN_FILES[role];
  return authTokenFile({ path, processRef }, overrideEnv, fileName);
}
function renewRoleTokens({ fs, path, processRef = process }) {
  for (const role of Object.keys(ROLE_TOKEN_FILES)) renewLocalToken({ fs, path, tokenFile: roleTokenFile({ path, processRef }, role) });
}

function createDaemonAuthentication({ fs, path, processRef = process }) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: roleTokenFile({ path, processRef }, "daemon") });
}

// The Service Controller's own loopback HTTP control API needs its own
// bearer token so an arbitrary local process cannot call ensure/stop/restart/
// shutdown on it. Electron reads the same file at each call (ui/main/controller_client.js); only Health writes it.
function createControllerAuthentication({ fs, path, processRef = process }) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: roleTokenFile({ path, processRef }, "controller") });
}

// Electron-side helpers: read (never create) a token Health mints, at each use. A missing one means Health has not
// started yet (Electron minting it would make a token no API was given the digest of); a renewed one (Health's full
// start) is what the next use reads.
function readControllerToken({ fs, path, processRef = process }) {
  return readTokenFile(fs, roleTokenFile({ path, processRef }, "controller"));
}
function readClientToken({ fs, path, processRef = process }) {
  return readTokenFile(fs, roleTokenFile({ path, processRef }, "client"));
}

// The business APIs' client token (api/client_auth.py's ClientAuthenticationMiddleware checks its digest). Health
// mints it and hands each API only the digest; Electron main and the web gateway attach it (readClientToken).
function createClientAuthentication({ fs, path, processRef = process }) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: roleTokenFile({ path, processRef }, "client") });
}

// Health's own credential toward the processes it manages: the business APIs' /api/service/* routes
// (identity, prepare-shutdown, stop) and a provider daemon's /v1/control/stop. Only Health holds the token; the
// APIs and daemons receive its digest. With the daemon token instead, any API (which holds the
// daemon token to read market data) could stop another API, and the daemons could stop the APIs.
function createManagementAuthentication({ fs, path, processRef = process }) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: roleTokenFile({ path, processRef }, "management") });
}

// Health's client toward a provider daemon: stopping it is a management act (the daemon accepts only the management
// credential on /v1/control/stop, service/platform/daemon_auth.py MANAGEMENT_PATHS); everything else -- probe, attach,
// reconnect, diagnostics -- is an ordinary daemon client call.
const PROVIDER_MANAGEMENT_PATHS = new Set(["/v1/control/stop"]);
function providerClientFetch({ daemonAuth, managementAuth }) {
  return function providerFetch(input, options) {
    let pathname = "";
    try { pathname = new URL(String(input?.url ?? input)).pathname; } catch (_error) { /* not an error: not a URL: the daemon credential is used */ }
    return (PROVIDER_MANAGEMENT_PATHS.has(pathname) ? managementAuth : daemonAuth).fetch(input, options);
  };
}

module.exports = {
  createDaemonAuthentication, createControllerAuthentication, readControllerToken, readClientToken, createClientAuthentication,
  createManagementAuthentication, tokenDigest, providerClientFetch, loadOrCreateLocalToken, readTokenFile,
  renewLocalToken, renewRoleTokens, roleTokenFile, ROLE_TOKEN_FILES,
};
