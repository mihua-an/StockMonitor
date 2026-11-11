import assert from 'node:assert/strict';

// A view.snapshot naming a DIFFERENT session/market/date than the subscription asked for must be
// rejected, not adopted.
//
// handleSnapshot used to carry every transport gate (subscription id, stream id, daemon instance,
// session generation, watermark) but no identity gate, so it did `entry.state = clone(payload)`
// unconditionally. That is worse than a blank panel in two ways:
//   1. it is displayable WRONG data -- another session's prices under this session's label;
//   2. handleDelta's identity gate compares incoming deltas against entry.state.session_key, so a
//      foreign snapshot silently re-baselines that gate and the rest of that session's deltas pass
//      too. One bad snapshot disables the delta protection for the life of the entry.
const { RealtimeViewStore } = await import('../ui/renderer/js/market_data/realtime_view_store.js');

function boot(spec) {
  const sent = [];
  const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; } });
  store.onConnected();
  const release = store.subscribe(spec, () => {});
  const subscribeMessage = sent.find((message) => message.type === 'view.subscribe');
  assert.ok(subscribeMessage, 'subscribing must put a view.subscribe on the wire');
  const requestId = subscribeMessage.payload.request_id;
  store.handleAccepted({ request_id: requestId, subscription_id: 'sub-1', stream_id: 'stream-1', watermark: 0 });
  return { store, sent, requestId, release, key: subscribeMessage.payload };
}

const SPEC = { source: 'shioaji', market: 'FUT', code: 'TXFR1', session: 'FULL', trading_date: '2026-09-25' };

function snapshotPayload(overrides = {}) {
  return {
    subscription_id: 'sub-1', stream_id: 'stream-1', watermark: 10,
    session_key: { market: 'FUT', logical_code: 'TXFR1', contract_code: 'TXF202610',
      session: 'FULL', trading_date: '2026-09-25', ...(overrides.session_key || {}) },
    summary: { current: 249600 },
    ...overrides,
  };
}

// --- the foreign cases: each must be refused, and must leave no state behind -------------------
for (const [label, sessionKey] of [
  ['a different WAL session', { session: 'DAY' }],
  ['a different trading date', { trading_date: '2026-09-24' }],
  ['a different market', { market: 'STK' }],
  ['a different instrument', { logical_code: 'MXFR1' }],
]) {
  const { store } = boot(SPEC);
  const accepted = store.handleSnapshot(snapshotPayload({ session_key: sessionKey }));
  assert.equal(accepted, false, `a snapshot with ${label} must be refused`);
  const described = store.describe(store.entries.keys().next().value);
  assert.equal(described.last_reject_reason, 'WRONG_SESSION_IDENTITY',
    `${label} must be reported as an identity rejection, not silently dropped`);
  assert.equal(store.snapshot(store.entries.keys().next().value), null,
    `${label} must not become the entry's state`);
}

// --- the matching case still works -------------------------------------------------------------
{
  const { store } = boot(SPEC);
  assert.equal(store.handleSnapshot(snapshotPayload()), true, 'the subscription\'s own snapshot must apply');
  const key = store.entries.keys().next().value;
  assert.equal(store.snapshot(key)?.summary?.current, 249600);
}

// --- an unstated field is not a mismatch -------------------------------------------------------
// The Rust view protocol does not have to restate every identity field on every frame. A field the
// sender omitted is silence, not disagreement: treating it as a mismatch would reject legitimate
// snapshots -- which is exactly how a previous "fix" blanked the futures chart.
{
  const { store } = boot(SPEC);
  const partial = snapshotPayload();
  delete partial.session_key.session;
  delete partial.session_key.trading_date;
  assert.equal(store.handleSnapshot(partial), true,
    'a snapshot that simply does not restate session/date must still apply');
}

// --- a spec without an explicit date accepts whatever date the authority reports ----------------
{
  const { store } = boot({ source: 'shioaji', market: 'FUT', code: 'TXFR1', session: 'FULL' });
  assert.equal(store.handleSnapshot(snapshotPayload()), true,
    'an unbound trading_date in the spec must not reject the authority\'s date');
}

// --- the foreign snapshot must NOT re-baseline the delta gate ----------------------------------
// The regression this protects: refuse the snapshot but leave entry.state set from it, and every
// subsequent foreign delta is compared against the foreign baseline and passes.
{
  const { store } = boot(SPEC);
  store.handleSnapshot(snapshotPayload({ session_key: { session: 'DAY' } }));
  const foreignDelta = { subscription_id: 'sub-1', stream_id: 'stream-1', sequence: 11,
    delta_type: 'summary.updated', payload: { current: 111100 },
    session_key: { market: 'FUT', logical_code: 'TXFR1', session: 'DAY', trading_date: '2026-09-25' } };
  assert.equal(store.handleDelta(foreignDelta), false,
    'with no adopted baseline the foreign delta cannot be applied either');
  assert.equal(store.snapshot(store.entries.keys().next().value), null,
    'nothing from the foreign session may be visible');
}

console.log('renderer snapshot identity gate contract passed (foreign snapshots are refused, not adopted)');
