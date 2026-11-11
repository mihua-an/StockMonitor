"use strict";

// electron-builder invokes this even when called directly, bypassing npm dist.
// This is still a fail-closed gate -- it MUST throw PACKAGING_CONTRACT_INCOMPLETE
// whenever any `required_present`/`required_missing` category in
// staging_allowlist.json is not actually satisfied on disk, exactly like the
// single-message version this replaces. What changed: the verdict is now a
// deterministic, itemized inventory (see inventory()) instead of one opaque
// message, so a future pass can see exactly which categories still block a
// real installer instead of re-deriving the list from scratch. A marker file
// or copying the entire repository cannot satisfy this contract -- categories
// are checked by real, structural evidence (lockfiles, evidence JSON content,
// electron-builder manifest content), not by presence of a directory alone.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const allowlistPath = path.join(__dirname, "staging_allowlist.json");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function pathsExist(paths) {
  return paths.every((p) => fs.existsSync(path.join(projectRoot, p)));
}

// Category-specific checks beyond plain path existence. Anything not listed
// here falls back to pathsExist(category.paths) (true for an
// external_prerequisite/required_missing category with an empty paths list,
// which is intentional -- those are judged by their explicit `status`, not by
// a filesystem probe).
const CATEGORY_CHECKS = {
  python_dependency_lock(category) {
    if (!pathsExist(category.paths)) return { ok: false, detail: "one or more lockfiles missing" };
    for (const p of category.paths) {
      const text = fs.readFileSync(path.join(projectRoot, p), "utf8");
      if (!text.trim() || !/==/.test(text)) return { ok: false, detail: `${p} exists but has no pinned entries` };
    }
    return { ok: true };
  },
  python_environment_evidence(category) {
    if (!pathsExist(category.paths)) return { ok: false, detail: "evidence file missing" };
    const evidence = readJson(category.paths[0]);
    if (!evidence.packages || !Object.keys(evidence.packages).length) {
      return { ok: false, detail: "evidence file has no package entries" };
    }
    return { ok: true };
  },
  market_runtime_binaries(category) {
    const missing = category.paths.filter((rel) => !fs.existsSync(path.join(projectRoot, rel)));
    if (missing.length) return { ok: false, detail: `missing Market Runtime build output: ${missing.join(", ")} (run cargo build --release in native/market_runtime)` };
    return { ok: true };
  },
  // Every tool the evidence records is compared with its current pin: Electron with package.json devDependencies, Node
  // with package.json engines.node, rustc and cargo with both crates' rust-toolchain.toml channel.
  toolchain_evidence_current(category) {
    if (!pathsExist(category.paths)) return { ok: false, detail: "toolchain-evidence.json missing" };
    const stale = toolchainEvidenceProblems(readJson(category.paths[0]), currentToolchainPins());
    return stale.length ? { ok: false, detail: `stale: ${stale.join("; ")}` } : { ok: true };
  },
  // The staged runtime is checked by the one checker build_release.py also runs before reusing it
  // (stage_python_runtime.py --check: bootstrap pins, every lock digest, each bundled package's version, the provider
  // requirement lists, the executables), and the packaged interpreter path is checked by calling the resolver itself.
  redistributable_python_interpreter(category) {
    if (!pathsExist(category.paths)) {
      return { ok: false, detail: "packaging/python/python.exe missing -- run scripts/tooling/stage_python_runtime.py" };
    }
    const check = spawnSync(process.env.STOCK_MONITOR_BUILD_PYTHON || "python",
      [path.join(projectRoot, "scripts", "tooling", "stage_python_runtime.py"), "--check"],
      { cwd: projectRoot, encoding: "utf8", windowsHide: true });
    if (check.error || check.status !== 0) {
      return { ok: false, detail: `stage_python_runtime.py --check failed: ${String(check.error?.message || check.stderr || check.stdout).trim()}` };
    }
    const resolved = bundledInterpreterResolution();
    if (!resolved.ok) return resolved;
    return { ok: true, detail: path.join(projectRoot, "packaging", "python") };
  },
  packaged_resource_manifest(category) {
    const pkg = readJson(category.paths[0]);
    const extraResources = pkg.build?.extraResources;
    const hasWritableRootConfig = Boolean(pkg.build?.directories?.output) && Array.isArray(extraResources) && extraResources.length > 0;
    if (!hasWritableRootConfig) {
      return { ok: false, detail: "build.extraResources is not configured -- no readonly-resource/writable-data-root split declared" };
    }
    return { ok: true };
  },
};

function rustToolchainChannel(crate) {
  const file = path.join(projectRoot, "native", crate, "rust-toolchain.toml");
  const match = fs.readFileSync(file, "utf8").match(/^\s*channel\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`${file} names no toolchain channel`);
  return match[1];
}

function currentToolchainPins() {
  const pkg = readJson("package.json");
  const channels = ["market_runtime", "analysis_runtime"].map(rustToolchainChannel);
  return { electron: String(pkg.devDependencies?.electron || ""), node: String(pkg.engines?.node || ""), rust: channels };
}

// One problem per evidence field that does not match its pin (a version string "1.97.1 (hash date)" matches by its
// leading version).
function toolchainEvidenceProblems(evidence, pins) {
  const problems = [];
  const lead = (value) => String(value || "").trim().split(/\s+/)[0];
  if (!pins.electron || lead(evidence.electron) !== pins.electron) problems.push(`electron evidence ${evidence.electron} != package.json ${pins.electron}`);
  if (!pins.node || lead(evidence.node) !== pins.node) problems.push(`node evidence ${evidence.node} != package.json engines.node ${pins.node}`);
  if (new Set(pins.rust).size !== 1) problems.push(`the two crates pin different Rust toolchains: ${pins.rust.join(", ")}`);
  for (const tool of ["rustc", "cargo"]) {
    if (lead(evidence[tool]) !== pins.rust[0]) problems.push(`${tool} evidence ${evidence[tool]} != rust-toolchain.toml ${pins.rust[0]}`);
  }
  return problems;
}

// What launch_runtime.js resolves in a synthetic packaged layout: the project root is resources/app-runtime and the
// interpreter is its python/python.exe -- the resolver itself is called, its source is never read.
function bundledInterpreterResolution() {
  const { getProjectRoot, resolvePythonExecutable, isBundledInterpreter } = require(path.join(projectRoot, "service", "platform", "js", "launch_runtime.js"));
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-packaged-layout-"));
  try {
    const runtimeRoot = path.join(resourcesPath, "app-runtime");
    for (const dir of ["service", "config", "backend", "python"]) fs.mkdirSync(path.join(runtimeRoot, dir), { recursive: true });
    for (const file of ["main.py", path.join("python", "python.exe")]) fs.writeFileSync(path.join(runtimeRoot, file), "");
    const root = getProjectRoot({ isPackaged: true, resourcesPath });
    if (path.resolve(root) !== path.resolve(runtimeRoot)) return { ok: false, detail: `the packaged project root resolves to ${root}, not ${runtimeRoot}` };
    const probed = [];
    const python = resolvePythonExecutable(root, { env: {}, spawnSyncImpl: (command) => { probed.push(command); return { status: 0 }; } });
    if (!isBundledInterpreter(root, python)) return { ok: false, detail: `the packaged interpreter resolves to ${python}, not the bundled python/python.exe` };
    return { ok: true };
  } finally {
    fs.rmSync(resourcesPath, { recursive: true, force: true });
  }
}

function checkCategory(category) {
  const specific = CATEGORY_CHECKS[category.id];
  const result = specific ? specific(category) : { ok: pathsExist(category.paths) };
  const satisfied = category.status === "required_present" ? result.ok
    : category.status === "required_missing" ? false // always fails closed; existing on disk would be a pleasant surprise worth re-reviewing, not silently accepted
    : category.status === "external_prerequisite" ? true // judged as a runtime check, not a build-time staging gap
    : false;
  return { ...category, satisfied, detail: result.detail || "" };
}

function inventory() {
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  const results = allowlist.categories.map(checkCategory);
  const blocking = results.filter((r) => !r.satisfied);
  return { results, blocking, complete: blocking.length === 0 };
}

module.exports = async function auditPackaging() {
  const { results, blocking, complete } = inventory();
  if (!complete) {
    const lines = blocking.map((b) => `  - [${b.id}] ${b.label}${b.detail ? `: ${b.detail}` : ""} (${b.status})`);
    throw new Error(
      `PACKAGING_CONTRACT_INCOMPLETE: standalone installers are blocked. ${blocking.length} of ${results.length} staging categories are not satisfied:\n${lines.join("\n")}\n` +
      "See scripts/tooling/staging_allowlist.json for the full itemized inventory and docs/development/build_and_release.md for context. " +
      "Do not satisfy this by adding a marker file or copying the repository; each category above requires real staged evidence.",
    );
  }
};

module.exports.inventory = inventory;
module.exports.toolchainEvidenceProblems = toolchainEvidenceProblems;
module.exports.bundledInterpreterResolution = bundledInterpreterResolution;

if (require.main === module) {
  module.exports().then(() => {
    console.log("PACKAGING_CONTRACT_COMPLETE");
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
