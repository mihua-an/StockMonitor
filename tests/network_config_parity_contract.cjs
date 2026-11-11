"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// The Node resolver must agree with the Python one on every shared case (CFG-01) and the two revision stores must
// read each other's files (Health reads what settings_api wrote).
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CASES_PATH = path.join(__dirname, "fixtures", "network_config", "cases.json");
const nc = require("../config/js/network_config.js");
const { ConfigRevisionStore, RevisionConflict } = require("../config/js/config_revisions.js");
const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
const manifest = nc.loadManifest();
const python = process.env.PYTHON || "python";

function summarize(effective) {
  const services = effective.services;
  const map = (fn) => Object.fromEntries(Object.entries(services).map(([sid, e]) => [sid, fn(e)]));
  return {
    listener_count: nc.listeners(effective).length,
    problem_codes: [...new Set(effective.problems.map((p) => p.code))].sort(),
    ports: map((e) => e.port), hosts: map((e) => e.host), sources: map((e) => e.source),
    override_ids: effective.overrides.map((o) => o.service_id).sort(),
    revision: effective.revision,
  };
}

function runPython(lines, ...args) {
  return spawnSync(python, ["-c", lines.join("\n"), ROOT, ...args], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" } });
}

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : (v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v));

for (const item of cases.resolve) {
  test(`resolve: ${item.name}`, () => {
    const got = summarize(nc.resolve(manifest, { saved: item.saved, env: item.env }));
    for (const [key, expected] of Object.entries(item.expect)) {
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        for (const [sub, value] of Object.entries(expected)) assert.deepEqual(got[key][sub], value, `${key}.${sub}`);
      } else assert.deepEqual(got[key], expected, key);
    }
  });
}

for (const item of cases.validate) {
  test(`validate: ${item.name}`, () => {
    const codes = [...new Set(nc.validateValues(manifest, item.values).map((p) => p.code))].sort();
    assert.deepEqual(codes, item.expect_codes);
  });
}

// The shipped manifest with a shared case's edits: [service_id or "$", field, value or {"$delete": true}].
function editedManifest(edits) {
  const edited = JSON.parse(JSON.stringify(manifest));
  for (const [target, field, value] of edits) {
    const node = target === "$" ? edited : edited.services.find((s) => s.service_id === target);
    if (value && typeof value === "object" && value.$delete) delete node[field];
    else node[field] = value;
  }
  return edited;
}

for (const item of cases.manifest) {
  test(`manifest: ${item.name}`, () => {
    assert.deepEqual(nc.manifestProblems(editedManifest(item.edits)), item.expect);
  });
}

test("Python and Node produce identical effective documents for every case", () => {
  const result = runPython([
    "import json,sys", "sys.path.insert(0, sys.argv[1])", "from config import network_config as nc",
    "cases=json.load(open(sys.argv[2],encoding='utf-8'))", "m=nc.load_manifest()",
    "print(json.dumps([nc.resolve(m, saved=c['saved'], env=c['env']) for c in cases['resolve']], sort_keys=True))",
  ], CASES_PATH);
  assert.equal(result.status, 0, result.stderr);
  const nodeDocs = cases.resolve.map((c) => nc.resolve(manifest, { saved: c.saved, env: c.env }));
  assert.deepEqual(sortKeys(nodeDocs), sortKeys(JSON.parse(result.stdout)));
});

test("stores interoperate: Python saves, Node activates, Python resolves the active revision", async () => {
  const root = makeTempDir("cfg-rev-");
  const save = runPython([
    "import sys", "sys.path.insert(0, sys.argv[1])", "from config.config_revisions import ConfigRevisionStore",
    "s=ConfigRevisionStore(sys.argv[2],'network')",
    "s.save({'services':{'realtime_api':{'port':18000}}}, expected_revision=None, source='settings_api')",
  ], root);
  assert.equal(save.status, 0, save.stderr);
  const store = new ConfigRevisionStore(root, "network");
  assert.equal(store.latest().revision, 1);
  assert.equal(store.active(), null);
  await assert.rejects(() => store.save({ services: {} }, { expectedRevision: null, source: "x" }), RevisionConflict);
  await store.setActive(1, { verified: true });
  assert.equal(nc.effectiveFromDisk({ env: {}, configRoot: root }).services.realtime_api.port, 18000);
  const resolved = runPython([
    "import sys", "from pathlib import Path", "sys.path.insert(0, sys.argv[1])", "from config import network_config as nc",
    "print(nc.effective_from_disk(env={}, config_root=Path(sys.argv[2]))['services']['realtime_api']['port'])",
  ], root);
  assert.equal(resolved.stdout.trim(), "18000", resolved.stderr);
});

test("system contract is one file for all languages", () => {
  const { contract } = require("../config/js/system_contract.js");
  const c = contract();
  assert.deepEqual(c.windows_minutes, [1, 3, 5, 15, 30, 60]);
  assert.deepEqual(c.fixed_kbar_minutes, [3, 5, 15, 30, 60]);
  assert.equal(c.model_default_horizons_minutes, undefined, "model horizons live in config/prediction_horizons.json only");
  assert.ok(!c.market_runtime_roles.viewer.includes("event.ingest"));
  assert.ok(!c.market_runtime_roles.viewer.includes("shutdown"));
  assert.ok(!c.role_ingest_kinds.provider.includes("analysis_signals"));
  const py = runPython(["import sys,json", "sys.path.insert(0, sys.argv[1])", "from config.system_contract import contract",
    "print(json.dumps(contract(), sort_keys=True))"]);
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(sortKeys(JSON.parse(py.stdout)), sortKeys(c));
});
