import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The startup-acceptance contract, pinned so it cannot drift back.
//
// `realtime_info` (monitor ALERT events) was a mandatory member of the readiness aggregate.
// MonitorEventStore.capture only writes when an alert condition fires, so on a quiet session
// startupAcceptance().ok stayed false and the surface was useless as an acceptance signal. "No alert fired" is a legitimate business
// state, so the condition belongs outside readiness. This asserts the split survives.
const source = readFileSync(new URL('../ui/renderer/js/features/realtime/startup_diagnostics.js', import.meta.url), 'utf8');

function objectLiteralAfter(marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${marker}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated object literal after ${marker}`);
}

const checksBlock = objectLiteralAfter('function startupAcceptanceChecks(m) {');
const keysOf = (block) => [...block.matchAll(/^\s{4}([a-z_]+):/gm)].map((match) => match[1]);
const mandatory = keysOf(checksBlock);

// The six requirements of the contract, as the renderer can observe them.
for (const required of [
  'renderer_ready',
  'realtime_ingress_ready',
  'canonical_state_ready',
  'health_ready',
  'product_rows',
  'futures_trend',
  'futures_trend_rendered',
]) {
  assert.ok(mandatory.includes(required), `${required} must be a mandatory readiness check`);
}

assert.ok(!mandatory.includes('realtime_info'),
  'realtime_info must NOT be a mandatory readiness check: an empty alert tape is a legitimate state');

// It still has to be measured and reported -- removing the gate must not remove the signal.
const advisoryBlock = objectLiteralAfter('advisory: {');
assert.ok(/realtime_info\s*:/.test(advisoryBlock),
  'realtime_info must still be reported, as advisory');

// `ok` is computed from `checks` alone, so nothing can promote an advisory signal by accident.
assert.ok(/ok:\s*Object\.values\(checks\)\.every\(Boolean\)/.test(source),
  'the readiness aggregate must be computed from `checks` only');

// The contract map has to name every one of the six requirements, and may only cite real checks.
const contractBlock = objectLiteralAfter('const STARTUP_ACCEPTANCE_CONTRACT = Object.freeze({');
for (const requirement of [
  'service_ready', 'realtime_ingress_ready', 'canonical_state_ready',
  'renderer_ready', 'market_panels_ready', 'health_ready',
]) {
  assert.ok(new RegExp(`${requirement}\\s*:`).test(contractBlock),
    `the contract map must name ${requirement}`);
}
for (const cited of [...contractBlock.matchAll(/"([a-z_]+)"/g)].map((match) => match[1])) {
  assert.ok(mandatory.includes(cited),
    `the contract map cites "${cited}", which is not a mandatory check`);
}

console.log(`startup acceptance contract passed (${mandatory.length} mandatory checks, realtime_info advisory)`);
