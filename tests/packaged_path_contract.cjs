"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// Packaged vs source-checkout path contract.
//
// Same LOGICAL contract, different physical writable root: an installed app's program directory
// is read-only, so VAR_ROOT moves to <userData>/var while AUTH_ROOT (local IPC tokens) stays in
// the same per-user location for both modes. What must never happen is the installer carrying
// runtime data, tokens or logs.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const { resolveVarPaths, resolveAuthRoot, loadVarLayout } = require(path.join(projectRoot, "config", "js", "var_paths.js"));
const { logSessionDir, logSessionId, newLogSessionId } = require(path.join(projectRoot, "service", "platform", "js", "log_session.js"));
const { resolveLaunchVarRoot } = require(path.join(projectRoot, "config", "js", "runtime_contract.js"));

const scratch = makeTempDir("packaged-path-");
const layout = loadVarLayout();
const localAppData = path.join(scratch, "Local");
const userData = path.join(scratch, "userData");

// --- 1. each flavor has its own writable root and its own auth root -----------------------------
const sourceEnv = { LOCALAPPDATA: localAppData };
const installedEnv = { ...sourceEnv, [layout.flavor_env]: "installed" };
const source = resolveVarPaths({ projectRoot, env: sourceEnv });
const packagedVarRoot = resolveLaunchVarRoot(projectRoot, { isPackaged: true, userDataPath: userData, env: installedEnv });
const packaged = resolveVarPaths({ projectRoot, env: { ...installedEnv, [layout.root_env]: packagedVarRoot } });

assert.equal(source.varRoot, path.join(projectRoot, "var"), "source checkout writes beside the code");
assert.equal(packaged.varRoot, path.join(userData, "var"), "an installed app writes under userData, never the install dir");
assert.notEqual(source.varRoot, packaged.varRoot);
assert.notEqual(source.authRoot, packaged.authRoot, "an installed app never shares the source checkout's IPC tokens");
assert.equal(packaged.authRoot, resolveAuthRoot({ env: installedEnv }));
assert.ok(!packaged.authRoot.startsWith(packaged.varRoot), "IPC tokens never live inside VAR_ROOT");
assert.ok(!packaged.authRoot.startsWith(projectRoot), "IPC tokens never live inside the repository");

// --- 2. every child keeps the same logical name under either root -------------------------------
for (const child of Object.keys(layout.children)) {
  assert.equal(path.basename(source[child]), layout.children[child].dir);
  assert.equal(path.basename(packaged[child]), layout.children[child].dir);
  assert.equal(path.relative(source.varRoot, source[child]), path.relative(packaged.varRoot, packaged[child]),
    `${child} must have the same position under both roots`);
}

// --- 3. first start creates what it needs, under the packaged root only -------------------------
const runEnv = { ...sourceEnv, [layout.root_env]: packagedVarRoot, STOCK_MONITOR_LOG_SESSION: newLogSessionId() };
assert.ok(!fs.existsSync(packaged.logs), "nothing exists before first start");
const runDir = logSessionDir({ env: runEnv });
assert.ok(fs.existsSync(runDir), "the run log directory is created on demand");
assert.equal(path.dirname(runDir), packaged.logs);
assert.equal(path.basename(runDir), logSessionId(runEnv));
assert.ok(runDir.startsWith(userData), "first start wrote only under the packaged writable root");
assert.ok(!fs.existsSync(path.join(projectRoot, "var", "logs", path.basename(runDir))),
  "a packaged run must not create anything in the source checkout");

// --- 4. the installer never carries runtime data, tokens or logs --------------------------------
const build = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).build;
const shipped = [
  ...build.files.filter((entry) => !entry.startsWith("!")),
  ...build.extraResources.map((entry) => entry.from),
  ...build.asarUnpack,
];
for (const entry of shipped) {
  const head = entry.replace(/\\/g, "/").split("/")[0];
  assert.ok(!["var", "dist", "out", "node_modules"].includes(head),
    `packaging must never ship ${entry}: runtime data, tokens and logs are not build inputs`);
}
// The layout file itself must ship (both resolvers read it) but the directories it names must not.
// config/*.json covers it together with the other contracts the Node resolvers read (network manifest, system contract).
assert.ok(build.files.includes("config/*.json"), "the layout contract must be packaged");
assert.ok(build.asarUnpack.includes("config/*.json"), "and readable outside the asar");
assert.ok(build.files.includes("service/platform/js/**/*") && build.asarUnpack.includes("service/platform/js/**/*"),
  "the Node platform modules Health and Electron main require must ship unpacked");

fs.rmSync(scratch, { recursive: true, force: true });
console.log("packaged path contract passed (writable root, auth root, first-start creation, installer inputs)");
