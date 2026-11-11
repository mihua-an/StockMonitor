"use strict";

const { makeTempDir } = require("./support/temp_dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadRuntimeContract, contractProblems } = require("../config/js/runtime_contract");
const { resolvePythonExecutable } = require("../service/platform/js/launch_runtime");

function fixture(contents) {
  const root = makeTempDir("stock-monitor-runtime-contract-");
  fs.mkdirSync(path.join(root, "config"));
  if (contents !== undefined) fs.writeFileSync(path.join(root, "config", "runtime_contract.json"), contents);
  return root;
}

test("missing runtime contract becomes a user-actionable configuration error", () => {
  const root = fixture(undefined);
  try {
    assert.throws(() => loadRuntimeContract(root), (error) => {
      assert.equal(error.code, "RUNTIME_CONFIGURATION_INVALID");
      assert.match(error.message, /無法讀取啟動設定/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed JSON and incomplete schemas fail before application composition", () => {
  for (const contents of ["{not-json", JSON.stringify({ backend: {} })]) {
    const root = fixture(contents);
    try {
      assert.throws(() => loadRuntimeContract(root), (error) => {
        assert.equal(error.code, "RUNTIME_CONFIGURATION_INVALID");
        return true;
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the same damaged contracts are refused with the same problems as the Python loader", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "runtime_contract_cases.json"), "utf8"));
  for (const { name, contract, problems } of cases) assert.deepEqual(contractProblems(contract), problems, name);
});

test("desktop entrypoint shows a startup error and does not continue with a null runtime", () => {
  const source = fs.readFileSync(path.join(__dirname, "../ui/main/main.js"), "utf8");
  assert.match(source, /dialog\.showErrorBox\("StockMonitor 無法啟動"/);
  assert.match(source, /const isPrimaryInstance = runtime \?/);
  assert.match(source, /if \(!runtime\)/);
});

test("Python preflight honors an explicit executable and rejects a broken PATH alias", () => {
  let invocation = null;
  const selected = resolvePythonExecutable("C:/project", {
    env: { STOCK_MONITOR_PYTHON_EXECUTABLE: "C:/Runtime/python.exe" },
    spawnSyncImpl(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: "Python 3.14.1", stderr: "" };
    },
  });
  assert.equal(selected, "C:/Runtime/python.exe");
  assert.deepEqual(invocation.args, ["--version"]);
  assert.equal(invocation.options.timeout, 5000);

  assert.throws(() => resolvePythonExecutable("C:/project", {
    env: {},
    spawnSyncImpl: () => ({ status: 9009, stdout: "", stderr: "Python was not found" }),
  }), (error) => {
    assert.equal(error.code, "RUNTIME_CONFIGURATION_INVALID");
    assert.match(error.message, /Python 執行環境不可用/);
    return true;
  });
});
