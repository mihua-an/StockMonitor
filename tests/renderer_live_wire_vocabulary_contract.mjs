import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// CROSS-SOURCE INVARIANT, and labelled as one: it reads two files and compares vocabularies
// rather than executing a transport. That is the right shape here, because the defect is
// precisely that a branch NEVER executes -- no behavioural test can observe code that never runs,
// and asserting "nothing happened" would pass just as well with the branch present.
//
// The renderer's live transport (ui/renderer/js/market_data/realtime.js) is fed by exactly
// one socket, the Market Runtime live engine. Two branches claimed message types that engine does
// not emit, so they had never run in any build:
//   * account.positions.changed -- dispatched stock-monitor:actual-positions-changed. Actual
//     holdings are in fact refreshed by the ledger_holdings.js stores -> GET
//     /api/actual-account/positions, so nothing was lost by removing it.
//   * signal.event -- the ONLY writer of pending.monitorEvents, which ui/renderer/app.js still
//     reads. So the monitor event feed has no producer on this transport. Removing the branch did
//     not create that gap; it stopped hiding it.
//
// Wiring that looks connected and is not is worse than an obvious gap: it survives review, it
// survives acceptance, and it sends the next person looking in the wrong direction.

// Market Runtime's frames are spelled across its server/wire/projection modules, so the vocabulary is
// read from every source file of the crate, submodule directories included.
const RUNTIME_DIR = new URL('../native/market_runtime/src/', import.meta.url);
const RUNTIME_SOURCE = readdirSync(RUNTIME_DIR, { recursive: true })
  .filter((name) => name.endsWith('.rs'))
  .map((name) => readFileSync(new URL(name.replaceAll('\\', '/'), RUNTIME_DIR), 'utf8')).join('\n');
const RENDERER_SOURCE = readFileSync(
  new URL('../ui/renderer/js/market_data/realtime.js', import.meta.url), 'utf8',
);

// What Market Runtime can actually put on the wire.
const emitted = new Set(
  [...RUNTIME_SOURCE.matchAll(/"type"\s*:\s*"([a-z][a-z0-9._]*)"/g)].map((match) => match[1]),
);
assert.ok(
  emitted.size >= 10 && emitted.has('view.delta') && emitted.has('view.snapshot'),
  `failed to read Market Runtime's wire vocabulary (found ${emitted.size} types) -- if the daemon `
  + 'stopped spelling its frames this way, this contract needs rewriting, not deleting',
);

// What the renderer's decoded-message handler claims to handle.
const handlerStart = RENDERER_SOURCE.indexOf('function handleDecodedMessage(');
assert.notEqual(handlerStart, -1, 'handleDecodedMessage must still exist in the live transport');
const handler = RENDERER_SOURCE.slice(handlerStart);
const handled = new Set(
  [...handler.matchAll(/type\s*===\s*"([a-z][a-z0-9._]*)"/g)].map((match) => match[1]),
);
assert.ok(handled.size > 0, 'failed to read the handled message types');

// The two this round removed. Pinned by name AND by the reason they are wrong, so a future
// re-add has to argue with the daemon's own vocabulary rather than with a bare string match.
for (const type of ['account.positions.changed', 'signal.event']) {
  assert.ok(
    !emitted.has(type),
    `Market Runtime now emits ${type}: this contract is stale and the branch may be legitimate `
    + 'again -- re-check before re-adding, and update this test deliberately',
  );
  assert.ok(
    !handled.has(type),
    `the live transport handles ${type}, which Market Runtime never emits. It is fed by exactly `
    + 'one socket, so that branch cannot run. Wire it to a source that emits it, or leave it out',
  );
}

// Guard the direction of travel: whatever else the handler still claims, it must not grow NEW
// branches for types the engine does not emit. The known-dead remainder is listed explicitly so
// the list can only shrink, and so nobody mistakes it for a clean bill of health.
// Empty, and that is the point: each removed branch had a verified
// replacement producer (the signals ones -- market.signals.snapshot / market.signal.delta /
// market.signals.delta_batch -- once the analysis projection got a real one).
// It now publishes onto Market Runtime's own live event path and reaches the renderer as the
// `signals` and `events` channels of the ordinary per-symbol view, so it inherits that path's
// sequence space, gap detection, resync, session identity and bounded queue rather than needing
// a second transport of its own.
//
// The handler must now claim ONLY what the engine emits. A new entry here means someone wired a
// branch to a message that cannot arrive -- which is how the last set survived review for months.
const KNOWN_DEAD_PENDING_DECISION = new Set([]);
const unexpectedDead = [...handled].filter(
  (type) => !emitted.has(type) && !KNOWN_DEAD_PENDING_DECISION.has(type),
);
assert.deepEqual(
  unexpectedDead, [],
  `new branches for message types Market Runtime does not emit: ${unexpectedDead.join(', ')}`,
);

// And the known-dead list must stay honest: an entry the engine has started emitting is no longer
// dead and should come off this list.
const staleEntries = [...KNOWN_DEAD_PENDING_DECISION].filter((type) => emitted.has(type));
assert.deepEqual(
  staleEntries, [],
  `these are no longer dead and must be removed from KNOWN_DEAD_PENDING_DECISION: ${staleEntries.join(', ')}`,
);

console.log(
  `renderer live-wire vocabulary contract passed `
  + `(engine emits ${emitted.size} types, handler claims ${handled.size}, `
  + `${KNOWN_DEAD_PENDING_DECISION.size} known-dead awaiting a decision)`,
);
