"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
// getProjectRoot() is launch-environment probing (it checks the installed runtime), so it lives in the platform
// module, not in config/ (AGENTS.md section 3).
const desktopShared = path.join(root, "service", "platform", "js");
const runtimeSource = fs.readFileSync(path.join(desktopShared, "launch_runtime.js"), "utf8");
const applicationSource = fs.readFileSync(path.join(root, "ui", "main", "desktop_application.js"), "utf8");
const backendSource = fs.readFileSync(path.join(root, "health", "services", "python_service_host.js"), "utf8");
const shioajiHostSource = fs.readFileSync(path.join(root, "health", "services", "shioaji_daemon_host.js"), "utf8");
const futuHostSource = fs.readFileSync(path.join(root, "health", "services", "futu_daemon_host.js"), "utf8");
const providerHostSource = fs.readFileSync(path.join(root, "health", "services", "provider_daemon_host.js"), "utf8");
const definition = runtimeSource.slice(
  runtimeSource.indexOf("function getProjectRoot("),
  runtimeSource.indexOf("function resolvePythonExecutable("),
).trim();
assert.ok(definition.startsWith("function getProjectRoot("), "getProjectRoot definition must be found");
const context = {
  path,
  __dirname: desktopShared,
};
vm.runInNewContext(definition + "\nthis.root = getProjectRoot({ electronVersion: '44.4.3', isPackaged: false });", context);
assert.equal(context.root, root);

// Packaged mode with genuinely incomplete/absent staged resources: still
// fail-closed, still without touching global process/require (resourcesPath
// is supplied explicitly here, exactly like isPackaged already is above).
const fsMod = require("node:fs");
const os = require("node:os");
const incompleteResources = makeTempDir("stockmonitor-packaging-incomplete-");
assert.throws(
  () => vm.runInNewContext(
    definition + `\ngetProjectRoot({ electronVersion: '44.4.3', isPackaged: true, resourcesPath: ${JSON.stringify(incompleteResources)} });`,
    { path, fs: fsMod, __dirname: desktopShared, require: (name) => name === "fs" ? fsMod : require(name) },
  ),
  /PACKAGING_CONTRACT_INCOMPLETE/,
  "packaged mode must remain fail-closed when app-runtime/ staging is genuinely incomplete",
);
fsMod.rmSync(incompleteResources, { recursive: true, force: true });

// Packaged mode with a fully staged app-runtime/ (every marker present)
// must succeed and return the packaged resources path, not throw.
const completeResources = makeTempDir("stockmonitor-packaging-complete-");
const appRuntime = path.join(completeResources, "app-runtime");
for (const entry of ["main.py", "service", "config", "backend", "python"]) {
  fsMod.mkdirSync(path.join(appRuntime, entry), { recursive: true });
}
fsMod.rmSync(path.join(appRuntime, "main.py"), { recursive: true, force: true });
fsMod.writeFileSync(path.join(appRuntime, "main.py"), "");
fsMod.writeFileSync(path.join(appRuntime, "python", "python.exe"), "");
const completeContext = { path, fs: fsMod, __dirname: desktopShared, require: (name) => name === "fs" ? fsMod : require(name) };
vm.runInNewContext(
  definition + `\nthis.root = getProjectRoot({ electronVersion: '44.4.3', isPackaged: true, resourcesPath: ${JSON.stringify(completeResources)} });`,
  completeContext,
);
assert.equal(completeContext.root, appRuntime, "a fully staged app-runtime/ must resolve, not fail-closed");
fsMod.rmSync(completeResources, { recursive: true, force: true });
for (const entry of ["main.py", "config/runtime_contract.json", "backend/shioaji/run_shioaji_daemon.py", "backend/futu/run_futu_daemon.py"]) {
  assert.ok(fs.existsSync(path.join(context.root, entry)), entry);
}
// The runtime module resolves the canonical root exactly once...
assert.match(runtimeSource, /const projectRoot = getProjectRoot\(\{ isPackaged, resourcesPath \}\)/);
// ...and every process owner receives that same resolved value as its cwd.
assert.match(applicationSource, /getProjectRoot: \(\) => runtime\.projectRoot/);
assert.match(backendSource, /cwd: this\.projectRoot/);
// Both provider daemons are spawned by the shared provider host.
assert.match(providerHostSource, /cwd: this\.projectRoot/);
assert.match(shioajiHostSource, /require\("\.\/provider_daemon_host"\)/);
assert.match(futuHostSource, /require\("\.\/provider_daemon_host"\)/);
console.log("relocated Electron project root contract passed");
