"use strict";

// Found running the installed build: the bundled interpreter's ._pth has `import site`, which also adds the
// machine's per-user %APPDATA%\Python\Python314\site-packages -- foreign packages (and their .pth code) ahead of the
// user's provider-sdk directory. A packaged launch sets PYTHONNOUSERSITE=1 for every Python child; a source checkout
// does not (the developer's broker SDKs may live in the user site).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isBundledInterpreter } = require("../service/platform/js/launch_runtime");
const { childEnv } = require("../service/platform/js/child_env");

const root = "C:\\Program Files\\StockMonitor\\resources\\app-runtime";
assert.equal(isBundledInterpreter(root, path.join(root, "python", "python.exe")), true);
assert.equal(isBundledInterpreter(root, "c:\\program files\\stockmonitor\\resources\\app-runtime\\python\\python.exe"), true,
  "Windows paths compare case-insensitively");
assert.equal(isBundledInterpreter(root, "python"), false, "a PATH python is a developer's own interpreter");
// A machine-wide interpreter (a path that must not exist here: the offline-snapshot scanner treats real paths as inputs).
assert.equal(isBundledInterpreter(root, "C:\\SomeMachinePython\\python.exe"), false);
assert.equal(isBundledInterpreter("C:\\repo", "C:\\repo\\.venv\\Scripts\\python.exe"), false);

// The switch reaches every child through the allowlist; code-loading Python variables still do not.
const env = childEnv({ PYTHONNOUSERSITE: "1", PYTHONPATH: "C:\\evil", PYTHONSTARTUP: "C:\\evil.py", SystemRoot: "C:\\Windows" });
assert.equal(env.PYTHONNOUSERSITE, "1");
assert.equal(env.PYTHONPATH, undefined);
assert.equal(env.PYTHONSTARTUP, undefined);

// loadRuntime applies it at the same single point as VAR_ROOT, only for the bundled interpreter.
const source = fs.readFileSync(path.join(__dirname, "..", "service", "platform", "js", "launch_runtime.js"), "utf8");
assert.match(source, /if \(isBundledInterpreter\(projectRoot, pythonExecutable\)\) env\.PYTHONNOUSERSITE = "1";/);

// The SDK installer runs the same interpreter's pip; it must not read the user site either.
const installer = fs.readFileSync(path.join(__dirname, "..", "packaging", "install_provider_sdk.ps1"), "utf8");
assert.match(installer, /\$env:PYTHONNOUSERSITE = "1"/);

console.log("packaged_python_user_site_contract: ok");
