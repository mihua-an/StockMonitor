"use strict";

// Shared by BOTH ui/main (Electron, for its direct-to-daemon
// trade-detail read path) and health/ (the Service Controller,
// which owns daemon lifecycle and needs the same bearer token to talk to
// them). The token file itself is already process-identity-agnostic --
// first writer wins, any process may read it -- so moving this here is a
// pure location change with no behavior change.

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

function createDaemonAuthentication({ fs, path, processRef = process }) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: authTokenFile({ path, processRef }, "STOCK_MONITOR_DAEMON_TOKEN_FILE", "daemon_auth_token") });
}

// The Service Controller's own loopback HTTP control API needs its own
// bearer token so an arbitrary local process cannot call ensure/stop/restart/
// shutdown on it. Electron reads the same file to authenticate as a client
// (see ui/main/controller_client.js); only the Controller ever writes it.
function createControllerAuthentication({ fs, path, processRef = process }) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: authTokenFile({ path, processRef }, "STOCK_MONITOR_CONTROLLER_TOKEN_FILE", "controller_auth_token") });
}

// Electron-side helper: read (never create) the Controller's token so a
// missing Controller process produces a clear "not running yet" error
// instead of Electron accidentally minting a second token file.
function readControllerToken({ fs, path, processRef = process }) {
  return readTokenFile(fs, authTokenFile({ path, processRef }, "STOCK_MONITOR_CONTROLLER_TOKEN_FILE", "controller_auth_token"));
}

// The FastAPI backend's own per-launch client token (api/client_auth.py's
// ClientAuthenticationMiddleware, STOCK_MONITOR_CLIENT_TOKEN). The backend is spawned
// by the Controller, not by Electron, so this cannot be a token Electron mints for
// itself in its own process: the Controller's separate process tree could not reach
// it, the spawned backend's STOCK_MONITOR_CLIENT_TOKEN would be empty and the
// middleware would reject every authenticated request. Both the Controller
// (when it spawns/injects env for the backend) and Electron (when it talks
// to the backend, and when it asks the Controller to reuse an
// already-running backend from an earlier session) must resolve the exact
// same value, so this uses the same first-writer-wins token-file mechanism
// as the daemon and Controller tokens above.
function createClientAuthentication({ fs, path, processRef = process }) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: authTokenFile({ path, processRef }, "STOCK_MONITOR_CLIENT_TOKEN_FILE", "client_auth_token") });
}

// Health's own credential toward the processes it manages: the business APIs' /api/service/* routes
// (identity, prepare-shutdown, stop) and a provider daemon's /v1/control/stop. Only Health holds the token; the
// APIs and daemons receive its digest. With the daemon token instead, any API (which holds the
// daemon token to read market data) could stop another API, and the daemons could stop the APIs.
function createManagementAuthentication({ fs, path, processRef = process }) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: authTokenFile({ path, processRef }, "STOCK_MONITOR_MANAGEMENT_TOKEN_FILE", "management_auth_token") });
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
  createDaemonAuthentication, createControllerAuthentication, readControllerToken, createClientAuthentication,
  createManagementAuthentication, tokenDigest, providerClientFetch, loadOrCreateLocalToken, readTokenFile,
};
