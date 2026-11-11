import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFutuComponentSources } from './lib/futu_component_sources.mjs';

// ONE canonical view per Futu instrument.
//
// Three call sites used to build their own Futu specs -- the quote store's hot view, the
// product-list row, and the focused trade panel -- with different channel sets, and two of them
// pinned session/trading_date while the other did not. `channels` and every identity field are
// part of the view store key, so a single instrument produced several entries: separate
// subscriptions, separate snapshots, separate sequence spaces, and a delta that updated one left
// the others silently stale. They now all resolve through futuCanonicalViewSpec().
//
// `source` is part of the key too. Market Runtime keys state on source:MARKET:CODE, so
// shioaji:US:X and futu:US:X are two different states; leaving source out collapsed them onto one
// renderer entry and whichever subscribed first decided what the other one read.

const { futuCanonicalViewSpec } = await import('../ui/renderer/js/market_data/moomoo_symbol.js');
const { RealtimeViewStore } = await import('../ui/renderer/js/market_data/realtime_view_store.js');
const { viewStateToMoomooProductFields } = await import(
  '../ui/renderer/js/features/realtime/moomoo_view_adapter.js');

const CODE = 'US.SPCX';
const COMPONENT_SOURCE = readFutuComponentSources();

function boot() {
  const sent = [];
  const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; } });
  store.onConnected();
  return { store, sent };
}
const subscribes = (sent) => sent.filter((m) => m.type === 'view.subscribe');
const unsubscribes = (sent) => sent.filter((m) => m.type === 'view.unsubscribe');

function acceptFirst(store, sent) {
  const accepted = subscribes(sent)[0].payload;
  store.handleAccepted({
    request_id: accepted.request_id, subscription_id: 'sub-1', stream_id: 's1', watermark: 0,
  });
  return accepted;
}
function deliverSnapshot(store, accepted, extra = {}) {
  store.handleSnapshot({
    subscription_id: 'sub-1', stream_id: 's1', request_id: accepted.request_id,
    sequence: 1, watermark: 1, source: 'futu', market: 'US', code: CODE,
    session: 'FULL', trading_date: '2026-09-25', summary: { current: 50 }, ...extra,
  });
}

// 1 -- one instrument, one wire subscription, and the REAL call site resolves to the shared spec.
{
  const { store, sent } = boot();
  store.subscribe({ ...futuCanonicalViewSpec(CODE), live_expected: true }, () => {});
  store.subscribe(futuCanonicalViewSpec(CODE), () => {});

  assert.equal(store.entries.size, 1, 'both Futu subscribers must share ONE view entry');
  assert.equal(
    subscribes(sent).length, 1,
    'one instrument must cost one view.subscribe on the wire, however many components want it',
  );

  // The product list opens no view of its own: the quote store holds the one subscription per code, through the
  // shared canonical spec (a component keeping its own spec is the state this contract exists to prevent).
  assert.doesNotMatch(COMPONENT_SOURCE, /rustSpec\(|syncHotViews/, 'the product list must not subscribe views beside the store');
  const storeSource = readFileSync(new URL('../ui/renderer/js/features/realtime/moomoo_quote_store.js', import.meta.url), 'utf8');
  assert.match(storeSource, /const spec = futuCanonicalViewSpec\(code\);/, 'the store subscribes the shared canonical spec');
}

// 2 -- every subscriber of the shared entry is notified.
{
  const { store, sent } = boot();
  const seen = { a: 0, b: 0 };
  store.subscribe({ ...futuCanonicalViewSpec(CODE), live_expected: true }, () => { seen.a += 1; });
  store.subscribe(futuCanonicalViewSpec(CODE), () => { seen.b += 1; });
  deliverSnapshot(store, acceptFirst(store, sent), { signals: { chg_1m: 0.42 } });

  assert.ok(seen.a > 0 && seen.b > 0, 'every subscriber of the shared entry must be notified');
}

// 3 -- one subscriber leaving must not remove the other one's demand.
{
  const { store, sent } = boot();
  const releaseFirst = store.subscribe({ ...futuCanonicalViewSpec(CODE), live_expected: true }, () => {});
  let secondSaw = 0;
  store.subscribe(futuCanonicalViewSpec(CODE), () => { secondSaw += 1; });
  const accepted = acceptFirst(store, sent);

  releaseFirst();
  assert.equal(store.entries.size, 1, 'one subscriber leaving must not remove the other one');
  assert.equal(unsubscribes(sent).length, 0, "the remaining subscriber's demand must stand");

  deliverSnapshot(store, accepted);
  assert.ok(secondSaw > 0, 'the surviving subscriber must keep receiving updates');
}

// 4 -- only the LAST subscriber leaving releases the view.
{
  const { store, sent } = boot();
  const releaseA = store.subscribe({ ...futuCanonicalViewSpec(CODE), live_expected: true }, () => {});
  const releaseB = store.subscribe(futuCanonicalViewSpec(CODE), () => {});
  acceptFirst(store, sent);

  releaseA();
  assert.equal(unsubscribes(sent).length, 0, 'not while someone still wants it');
  releaseB();
  assert.equal(unsubscribes(sent).length, 1, 'the LAST subscriber leaving releases the view');
}

// 5 -- a Futu signals frame actually reaches the product row.
{
  const spec = futuCanonicalViewSpec(CODE);
  assert.ok(spec.channels.includes('signals'),
    'the canonical Futu view must subscribe the analysis projection, or the row never arrives');
  assert.ok(!spec.channels.includes('events'),
    'events is deliberately NOT subscribed: there is no Futu alert UI and the alert policy is '
    + 'Taiwan-equity specific, so subscribing it would be wiring with nothing behind it');

  const fields = viewStateToMoomooProductFields({
    summary: { current: 50 },
    signals: { volume_change_pct: 12.5, update_time: '22:31:00', authority: 'analysis_projection' },
    windows: { windows: { 1: { change_pct: 0.42 }, 5: { change_pct: 1.1 } }, k: { 1: { change_pct: 0.2 } } },
  });
  assert.equal(fields.chg_1m, 0.42, "B's rolling windows must reach the Futu product row");
  assert.equal(fields.chg_5m, 1.1);
  assert.equal(fields.k_1m, 0.2);
  assert.equal(fields.volume_change_pct_vs_baseline, 12.5,
    '量變 must be remapped to the name the column reader looks for');
  assert.ok(!('authority' in fields), 'transport provenance is not a displayable row field');
  assert.equal(fields.update_time, '22:31:00',
    'the row keeps its exchange stamp: one projection for Shioaji and Futu rows (signal_row.js, BACKLOG R10b-14)');
}

// 6 -- the same market/code from two sources must NOT share an entry.
{
  const { store } = boot();
  store.subscribe(futuCanonicalViewSpec(CODE), () => {});
  // Identical in EVERY field except source. If the probe also differed by channels the entries
  // would separate for that reason and this would pass whether or not source is part of the key
  // -- which is exactly how it first slipped through.
  store.subscribe({ ...futuCanonicalViewSpec(CODE), source: 'shioaji' }, () => {});

  assert.equal(
    store.entries.size, 2,
    'shioaji:US:SPCX and futu:US:SPCX are two different Market Runtime states and must be two '
    + "renderer entries -- collapsing them let one provider read the other provider's state",
  );
}

// 7 -- a REAL signals.frame, all the way to the product row.
//
// Test 5 only proves the adapter can shape an object. This drives the actual path: subscribe
// with the canonical spec, accept it, apply a snapshot, push a `signals.frame` delta through
// RealtimeViewStore, then read the shared entry back the way the product list does.
{
  const { store, sent } = boot();
  store.subscribe(futuCanonicalViewSpec(CODE), () => {});
  const accepted = acceptFirst(store, sent);
  deliverSnapshot(store, accepted, { trend: [{ minute: 570, close: 49 }] });

  store.handleDelta({
    subscription_id: 'sub-1', stream_id: 's1', sequence: 2,
    source: 'futu', market: 'US', code: CODE, session: 'FULL', trading_date: '2026-09-25',
    delta_type: 'signals.frame', channels: ['signals'],
    payload: { signals: { volume_change_pct: 9.5, authority: 'analysis_projection' } },
  });
  store.handleDelta({
    subscription_id: 'sub-1', stream_id: 's1', sequence: 3,
    source: 'futu', market: 'US', code: CODE, session: 'FULL', trading_date: '2026-09-25',
    delta_type: 'windows.updated', channels: ['windows'],
    payload: {
      windows: { 1: { change_pct: 0.42 }, 3: { change_pct: 0.8 }, 5: { change_pct: 1.1 } },
      k: { 1: { change_pct: 0.2 }, 3: { change_pct: 0.3 }, 5: { change_pct: 0.4 } },
    },
  });

  const row = store.select(futuCanonicalViewSpec(CODE), viewStateToMoomooProductFields);
  assert.ok(row, 'the shared Futu entry must be readable after a signals.frame');
  assert.equal(row.chg_1m, 0.42, 'a windows.updated delta must reach the product row');
  assert.equal(row.chg_3m, 0.8);
  assert.equal(row.chg_5m, 1.1);
  assert.equal(row.k_1m, 0.2);
  assert.equal(row.volume_change_pct_vs_baseline, 9.5, 'a signals.frame delta must reach the product row');
}

// 8 -- the 1m/3m/5m columns have one owner: Rust B's windows. A minute trend long enough to derive a change must
// not produce a number, or Futu rows would go back to a definition the Shioaji rows do not use.
{
  const longTrend = [
    { minute: 563, close: 40 }, { minute: 565, close: 41 }, { minute: 567, close: 42 },
    { minute: 569, close: 43 }, { minute: 570, close: 50 },
  ];

  const fromB = viewStateToMoomooProductFields({
    summary: { current: 50 }, trend: longTrend, windows: { windows: { 1: { change_pct: 0.42 } } },
  });
  assert.equal(fromB.chg_1m, 0.42, "B's window is the value, whatever the local trend would give");

  const none = viewStateToMoomooProductFields({ summary: { current: 50 }, trend: longTrend });
  assert.equal(none.chg_1m, null, 'without a window there is no value: the renderer does not compute one');
}

console.log('renderer futu single view contract passed');
