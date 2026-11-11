import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// What this pins: the renderer must decide "is market data available" from the DAEMON'S
// projection of the link, not from the broker-LOGIN flag.
//
// The bug this replaces: `available` required `broker.shioaji_connected`, which is the broker
// login flag and is legitimately false whenever the daemon's authoritative callback source is
// not the broker SDK. A captured session (var/isolated/audit-r4/electron-ui-state.json) shows
// the consequence: shioajiRows 74 / shioajiPricedRows 74 / tickRows 200 / orderbookRows 15,
// every row priced, ticks and book populated -- and the banner reading
// 「WebSocket 已連線（資料未同步）」.
//
// It also pins the removal of the `broker.authority !== "persistent_market_daemon"` escape
// branch. api/source_diagnostics.py returns that authority unconditionally and correctly -- the
// daemon owns this truth in BOTH modes -- so that branch was unreachable, and re-arming it would
// silently reintroduce a second truth model.
//
// This executes the REAL decision (features/realtime/session_state.js marketDataAvailableFromStatus, which
// applyRealtimeStatus reads), rather than asserting on its text: a regex contract would pass with the logic reverted,
// which is exactly how the previous generation of this project's renderer contracts went blind.

globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {} };
const { marketDataAvailableFromStatus: availabilityFromStatus } = await import(
  '../ui/renderer/js/features/realtime/session_state.js');
const controller = readFileSync(new URL('../ui/renderer/js/features/realtime/session_controller.js', import.meta.url), 'utf8');
assert.match(controller, /const available = marketDataAvailableFromStatus\(status\);/,
  'applyRealtimeStatus must take availability from the one decision');

assert.ok(
  !/authority\s*!==/.test(String(availabilityFromStatus)),
  'the broker.authority escape branch must stay removed: it is unreachable and re-arming it '
  + 'restores a second truth model',
);

const availability = (broker) => availabilityFromStatus({ broker_status: broker });

const AUTHORITY = 'persistent_market_daemon';

// Shapes mirror api/source_diagnostics.py's broker_status() payload.
const liveBrokerUp = {
  authority: AUTHORITY, daemon_reachable: true, shioaji_connected: true,
  readiness: { connected: true, market_data_ready: true },
};
const liveBrokerDown = {
  authority: AUTHORITY, daemon_reachable: true, shioaji_connected: false,
  readiness: { connected: false, market_data_ready: false },
};
const isolatedDelivering = {
  authority: AUTHORITY, daemon_reachable: true, shioaji_connected: false,
  readiness: { connected: true, market_data_ready: true },
};
const isolatedNothingYet = {
  authority: AUTHORITY, daemon_reachable: true, shioaji_connected: false,
  readiness: { connected: false, market_data_ready: false },
};

assert.equal(availability(liveBrokerUp), true, 'live with the broker up stays available');
assert.equal(availability(liveBrokerDown), false, 'live with the broker down stays unavailable');
assert.equal(
  availability(isolatedDelivering), true,
  'a daemon whose callback source is up and delivering must NOT be reported as 資料未同步 just '
  + 'because the broker login flag is false',
);
assert.equal(
  availability(isolatedNothingYet), false,
  'a daemon that has delivered nothing is still unavailable',
);

// market_data_ready remains an independent veto: CONNECTED_WAITING_SESSION / STARTING must not
// keep yesterday's trades, book or chart on screen.
assert.equal(
  availability({
    authority: AUTHORITY, daemon_reachable: true, shioaji_connected: true,
    readiness: { connected: true, market_data_ready: false },
  }),
  false,
  'market_data_ready=false must still veto availability',
);

// An unreachable daemon is unavailable no matter what the last readiness said.
assert.equal(
  availability({
    authority: AUTHORITY, daemon_reachable: false, shioaji_connected: true,
    readiness: { connected: true, market_data_ready: true },
  }),
  false,
  'an unreachable daemon is never available',
);

// Back-compat: a daemon too old to publish readiness.connected falls back to the login flag
// rather than going dark.
assert.equal(
  availability({
    authority: AUTHORITY, daemon_reachable: true, shioaji_connected: true,
    readiness: { market_data_ready: true },
  }),
  true,
  'without readiness.connected the login flag is the fallback',
);

// A status payload with no broker block at all must NOT suppress the UI. This is what the old
// `broker.authority !== "persistent_market_daemon"` branch actually did -- it was never dead code,
// because `broker` is `status.broker_status || {}`. Removing it outright made a partial status
// blank the screen, which the page-lifecycle contract caught.
assert.equal(
  availabilityFromStatus({ market_sessions: {} }), true,
  'a status carrying no broker_status must leave data available: nobody has claimed the '
  + 'authority, so there is nothing to suppress on',
);
assert.equal(
  availabilityFromStatus({}), true,
  'an empty status must not blank the screen either',
);

console.log('renderer link authority contract passed');
