import assert from 'node:assert/strict';

// A canonical view spec that omits the session must default to the session the SOURCE actually
// writes under -- service/market/shared/session_identity_contract.py's _WAL_SESSIONS.
//
// The default used to be "FULL for FUT, DAY for everything else", which is only true for Shioaji.
// Every Futu instrument is written under FULL, so any Futu spec without an explicit session (the
// Futu quote store's) produced a second "US|<code>||DAY|..." subscription that could never bind:
// the Futu product list rows sat at "--" for the whole session while every Futu instrument
// registered its broker demand twice.
const { normalizeRealtimeViewSpec, realtimeViewSpecKey } =
  await import('../ui/renderer/js/market_data/realtime_view_store.js');

for (const [spec, expected, why] of [
  [{ source: 'shioaji', market: 'STK', code: '2330' }, 'DAY', 'Shioaji equities are written under DAY'],
  [{ source: 'shioaji', market: 'IDX', code: 'TAIEX' }, 'DAY', 'the TAIEX index is written under DAY'],
  [{ source: 'shioaji', market: 'FUT', code: 'TXFR1' }, 'DAY', 'FUT is stored per business session: a spec without one means the day'],
  [{ source: 'futu', market: 'US', code: 'US.SPCX' }, 'FULL', 'every Futu instrument is written under FULL'],
  [{ source: 'futu', market: 'HK', code: 'HK.700' }, 'FULL', 'an unlisted source/market pair defaults to FULL'],
]) {
  assert.equal(normalizeRealtimeViewSpec(spec).session, expected, why);
}

// An explicit session still wins -- the default only fills a gap.
assert.equal(normalizeRealtimeViewSpec({ source: 'futu', market: 'US', code: 'US.SPCX', session: 'day' }).session, 'DAY');

// The concrete regression: the Futu quote store's spec and the focused components' spec must be
// the SAME subscription, not two.
const quoteStoreSpec = { market: 'US', code: 'US.SPCX', source: 'futu', live_expected: true,
  channels: ['summary', 'trend', 'trades', 'orderbook', 'tradeflow', 'price_volume'] };
const focusedSpec = { source: 'futu', market: 'US', code: 'US.SPCX', session: 'FULL', trading_date: '',
  channels: ['summary', 'trend', 'trades', 'orderbook', 'tradeflow', 'price_volume'] };
assert.equal(realtimeViewSpecKey(quoteStoreSpec), realtimeViewSpecKey(focusedSpec),
  'one Futu instrument must resolve to one canonical view key');

// The Python WAL table is the authority for the markets with one WAL session; FUT is per-session there, so its DAY
// default is a display default only.
{
  const { readFileSync } = await import('node:fs');
  const python = readFileSync(new URL('../service/market/shared/session_identity_contract.py', import.meta.url), 'utf8');
  const walTable = python.match(/^_WAL_SESSIONS = \{(.*)\}$/m)?.[1] || '';
  const entries = [...walTable.matchAll(/\("(\w+)", "(\w+)"\): "(\w+)"/g)].map(([, source, market, session]) => [source, market, session]);
  assert.deepEqual(entries, [['shioaji', 'STK', 'DAY'], ['shioaji', 'IDX', 'DAY']], 'the Python WAL table');
  for (const [source, market, session] of entries) {
    assert.equal(normalizeRealtimeViewSpec({ source, market, code: 'X' }).session, session, `${source} ${market} follows the WAL table`);
  }
  assert.match(python, /^_SESSION_PARTITIONED = \{\("shioaji", "FUT"\)\}$/m, 'FUT has no single WAL session in Python');
  const store = readFileSync(new URL('../ui/renderer/js/market_data/view_identity.js', import.meta.url), 'utf8');
  assert.doesNotMatch(store, /\bWAL_SESSIONS\b/, 'the renderer table is not called a WAL table');
}

console.log('canonical view spec session contract passed (defaults follow the WAL session table)');

// A spec names its market: nothing guesses it from the code. TXFR1 is FUT and Quote-only in the one builder.
assert.throws(() => normalizeRealtimeViewSpec({ code: '2330' }), /needs its market/);
assert.throws(() => realtimeViewSpecKey({ code: 'TAIEX' }), /needs its market/);
const { stockCanonicalViewSpec } = await import('../ui/renderer/js/market_data/stock_view_spec.js');
const txf = stockCanonicalViewSpec('TXFR1', '2026-11-10', { trading_date: '2026-11-10', session: 'NIGHT' });
assert.deepEqual([txf.market, txf.trading_date, txf.session, [...txf.channels]], ['FUT', '2026-11-10', 'NIGHT', ['summary', 'trend']]);
assert.equal(stockCanonicalViewSpec('CDF202611', '', { trading_date: '2026-11-10', session: 'DAY' }).market, 'FUT');
assert.equal(stockCanonicalViewSpec('2330', '2026-11-10').market, 'STK');
