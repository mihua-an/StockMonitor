"use strict";

// Node twin of service/platform/runtime_credentials.py: one token per market_runtime role under
// AUTH_ROOT/market_runtime/, first writer wins. Health creates them all and writes the digest-only credential
// file market_runtime starts with; Electron main reads only the viewer token for the renderer.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveVarPaths } = require("../../../config/js/var_paths");
const { writeJsonAtomic } = require("./atomic_files");
const { loadOrCreateLocalToken, readTokenFile } = require("./daemon_auth");

const CREDENTIALS_SCHEMA = "market-runtime-credentials-v1";
const ROLES = ["viewer", "provider:shioaji", "provider:futu", "analysis_runtime", "signal_producer", "controller"];

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

module.exports = { CREDENTIALS_SCHEMA, ROLES, tokenPath, readToken, loadOrCreateToken, credentialsDocument, writeCredentialsFile };
