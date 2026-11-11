const { makeTempDir } = require("./support/temp_dirs.cjs");
// Electron's watch_page_store.js must resolve the data root override
// identically to Python's service/platform/project_root.py -- one env name
// (STOCK_MONITOR_DATA_ROOT), the same default, and the retired names refused
// on both sides.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createWatchPageStore } = require('../ui/main/watch_page_store');

const { pythonExe } = require('./support/native_binaries.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ALIASES = ['STOCK_MONITOR_DATA_ROOT', 'STOCKMONITOR_DATA_ROOT', 'SHIOAJI_DATA_ROOT'];  // the current name and the retired ones, cleared around each case

function withEnv(env, fn) {
  const saved = Object.fromEntries(ALIASES.map((k) => [k, process.env[k]]));
  ALIASES.forEach((k) => delete process.env[k]);
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    ALIASES.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  }
}

function jsDataRoot(env) {
  return withEnv(env, () => {
    const store = createWatchPageStore(PROJECT_ROOT, { catalog: { withMetadata: (pages) => ({ revision: null, pages }) } });
    const storage = store.load().storage;
    // storage === dataRoot/preferences/watch_pages.csv.
    return path.dirname(path.dirname(storage));
  });
}

function pythonDataRoot(env) {
  const pythonBin = pythonExe();
  const childEnv = { ...process.env };
  ALIASES.forEach((k) => delete childEnv[k]);
  Object.assign(childEnv, env);
  const result = spawnSync(pythonBin, ['-c', 'import sys; sys.path.insert(0,r"' + PROJECT_ROOT + '"); from service.platform.project_root import DATA_ROOT; print(DATA_ROOT)'], { cwd: PROJECT_ROOT, env: childEnv, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`python resolution failed: ${result.stderr}`);
  return result.stdout.trim();
}

// --- 1. No override -> both sides fall back to <project root>/var/data (config/var_layout.json) ---
{
  const jsRoot = jsDataRoot({});
  assert.equal(jsRoot, path.join(PROJECT_ROOT, 'var', 'data'));
  const pyRoot = pythonDataRoot({});
  assert.equal(jsRoot, pyRoot, 'A06: default data root must match Python exactly');
}

// --- 2. The one override, cross-checked against Python ---
const scratch = makeTempDir('a06-parity-');
try {
  const target = path.join(scratch, 'canonical');
  const jsRoot = jsDataRoot({ STOCK_MONITOR_DATA_ROOT: target });
  assert.equal(jsRoot, path.resolve(target), 'STOCK_MONITOR_DATA_ROOT must be honored');
  const pyRoot = pythonDataRoot({ STOCK_MONITOR_DATA_ROOT: target });
  assert.equal(jsRoot, pyRoot, 'STOCK_MONITOR_DATA_ROOT must resolve identically on both sides');

  // --- 3. A retired name is refused on both sides, never ignored ---
  const { resolveVarPaths } = require('../config/js/var_paths');
  for (const retired of ['STOCKMONITOR_DATA_ROOT', 'SHIOAJI_DATA_ROOT']) {
    const env = { STOCK_MONITOR_DATA_ROOT: target, [retired]: path.join(scratch, 'retired') };
    assert.throws(() => resolveVarPaths({ projectRoot: PROJECT_ROOT, env }), (error) => error.code === 'RETIRED_ENV'
      && error.message.includes(retired), `${retired} must be refused`);
    assert.throws(() => pythonDataRoot(env), /retired environment variable/, `${retired} must be refused by Python too`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('PASS A06 (Electron/Python data-root parity: default, each alias, precedence)');
