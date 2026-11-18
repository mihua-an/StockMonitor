"use strict";

// Node twin of service/platform/runtime_credentials.py: one token per market_runtime role under
// AUTH_ROOT/market_runtime/. Health creates them all (renewing every one on a full start) and writes the digest-only
// credential file market_runtime starts with. A Python service Health starts receives its role's token in the
// environment variable grantEnv(role) and never reads the files; Electron main reads only the viewer token, at each use.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveVarPaths } = require("../../../config/js/var_paths");
const { writeJsonAtomic } = require("./atomic_files");
const { loadOrCreateLocalToken, readTokenFile, renewLocalToken } = require("./daemon_auth");

const CREDENTIALS_SCHEMA = "market-runtime-credentials-v1";
const ROLES = ["viewer", "provider:shioaji", "provider:futu", "analysis_runtime", "signal_producer", "controller"];
// The environment variable a Python child is granted a role's token in (service/platform/runtime_credentials.py
// grant_env, the same rule): "provider:shioaji" -> STOCK_MONITOR_RUNTIME_TOKEN_PROVIDER_SHIOAJI.
const GRANT_ENV_PREFIX = "STOCK_MONITOR_RUNTIME_TOKEN_";

function grantEnv(role) {
  if (!ROLES.includes(role)) throw new Error(`unknown market_runtime role ${role}`);
  return `${GRANT_ENV_PREFIX}${role.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
}

function root(env = process.env) {
  const explicit = String(env.STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR || "").trim();
  return explicit || path.join(resolveVarPaths({ env }).authRoot, "market_runtime");
}

function tokenPath(role, env = process.env) {
  if (!ROLES.includes(role)) throw new Error(`unknown market_runtime role ${role}`);
  return path.join(root(env), `${role.replace(":", "-")}.token`);
}

function readToken(role, env = process.env) {
  return readTokenFile(fs, tokenPath(role, env));
}

function loadOrCreateToken(role, env = process.env) {
  return loadOrCreateLocalToken({ fs, path, tokenFile: tokenPath(role, env) }).token;
}

// Health's full start: every role gets a new token (the digest file is written from them afterwards).
function renewTokens(env = process.env, roles = ROLES) {
  for (const role of roles) renewLocalToken({ fs, path, tokenFile: tokenPath(role, env) });
}

function credentialsDocument(env = process.env, roles = ROLES) {
  return {
    schema: CREDENTIALS_SCHEMA,
    roles: Object.fromEntries(roles.map((role) => [role, crypto.createHash("sha256").update(loadOrCreateToken(role, env), "ascii").digest("hex")])),
  };
}

// The shared atomic writer: a unique temp name (two overlapping starts never write one temp file), removed when the
// write fails, fsynced before the rename (market_runtime starts from this file).
function writeCredentialsFile(file, env = process.env, roles = ROLES, { fsImpl = fs } = {}) {
  writeJsonAtomic(file, credentialsDocument(env, roles), { fsImpl, indent: 0, durable: true });
  return file;
}

module.exports = { CREDENTIALS_SCHEMA, ROLES, GRANT_ENV_PREFIX, grantEnv, tokenPath, readToken, loadOrCreateToken, renewTokens,
  credentialsDocument, writeCredentialsFile };
