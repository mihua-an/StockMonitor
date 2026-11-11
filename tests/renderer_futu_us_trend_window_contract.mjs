import assert from 'node:assert/strict';
import { installRealtimeHarness } from './support/realtime_socket_harness.mjs';

// The Futu US session the screens read is Rust A's (session.current `us`, native/market_runtime/src/us_session.rs,
// where the weekday, holiday and half-day rules are tested): ui/renderer/js/features/realtime/futu_us_market_session.js
// keeps the newest one A sent and the tabs take their windows from it; nothing in the renderer reads a weekday or a
// clock (user 11-10, decisions.md 美股假日).

const live = installRealtimeHarness({ enabledSources: ['futu'] });
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, items: [] }) });

const realtime = await import('../ui/renderer/js/market_data/realtime.js');
const { subscribeUsMarketSession, usMarketSession } = await import('../ui/renderer/js/features/realtime/futu_us_market_session.js');
const { rowsInUsTrendWindow, usTrendPartitionDates, usTrendWindow } =
  await import('../ui/renderer/js/features/realtime/futu_us_trend_window.js');
const { currentUsSession, usDayNote, usTrendTab } = await import('../ui/renderer/js/features/realtime/components/futu/us_session_policy.js');

const part = (trading_date, from, to) => ({ trading_date, from, to });
// Thanksgiving 2026-11-26 10:00 New York as A sends it: closed all day, every tab on Wednesday 11-25's session.
const THANKSGIVING = { trading_date: '2026-11-25', phase: 'closed', market_day: 'closed', windows: {
  day: [part('2026-11-25', 240, 1200)],
  overnight: [part('2026-11-24', 1200, 1440), part('2026-11-25', 0, 240)],
  full: [part('2026-11-24', 1200, 1440), part('2026-11-25', 0, 1200)] } };
// Thursday 20:30: Friday's overnight session opened in the 11-26 partition.
const THANKSGIVING_EVENING = { trading_date: '2026-11-27', phase: 'overnight', market_day: 'closed', windows: {
  day: [part('2026-11-25', 240, 1200)],
  overnight: [part('2026-11-26', 1200, 1440), part('2026-11-27', 0, 240)],
  full: [part('2026-11-26', 1200, 1440), part('2026-11-27', 0, 1200)] } };
const HALF_DAY_AFTER_CLOSE = { ...THANKSGIVING_EVENING, trading_date: '2026-11-27', phase: 'closed', market_day: 'half' };

// Before A has said anything: no window, no session.
assert.equal(usMarketSession(), null);
assert.deepEqual(usTrendWindow('day', null).parts, []);
assert.equal(currentUsSession(null), 'closed');
assert.equal(usDayNote(null), '');

// The windows are A's, verbatim.
const parts = (tab, us) => usTrendWindow(tab, us).parts.map((p) => `${p.trading_date}:${p.from}-${p.to}`);
assert.deepEqual(parts('day', THANKSGIVING), ['2026-11-25:240-1200'], '日盤 on a holiday: the trading day before it');
assert.deepEqual(parts('full', THANKSGIVING_EVENING), ['2026-11-26:1200-1440', '2026-11-27:0-1200']);
assert.deepEqual(usTrendPartitionDates(THANKSGIVING_EVENING), ['2026-11-25', '2026-11-26', '2026-11-27']);
assert.notEqual(usTrendWindow('full', THANKSGIVING).key, usTrendWindow('full', THANKSGIVING_EVENING).key, 'a moved window has a new key');

// The 日盤 note (user 11-10): the part of the day, 休市 on a day the market does not open, 收盤 after a trading day's
// last session (a half day's 17:00), nothing in the overnight session.
const note = (phase, market_day = 'whole') => usDayNote({ ...THANKSGIVING, phase, market_day });
assert.deepEqual(['pre', 'regular', 'after'].map((phase) => note(phase)), ['盤前', '盤中', '盤後']);
assert.equal(note('regular', 'half'), '盤中', 'a half day before 13:00');
assert.equal(note('after', 'half'), '盤後', 'a half day 13:00-17:00');
assert.equal(usDayNote(HALF_DAY_AFTER_CLOSE), '收盤', 'a half day from 17:00');
assert.equal(usDayNote(THANKSGIVING), '休市');
assert.equal(usDayNote(THANKSGIVING_EVENING), '', 'the overnight session');
assert.equal(usTrendTab(currentUsSession(THANKSGIVING)), 'full', 'a closed market opens on 全日');

// Rows: by partition and minute, in window order.
const rows = [
  { trading_date: '2026-11-25', minute: 1290 }, { trading_date: '2026-11-25', minute: 30 },
  { trading_date: '2026-11-24', minute: 1230 }, { trading_date: '2026-11-25', minute: 600 },
];
assert.deepEqual(rowsInUsTrendWindow(rows, usTrendWindow('full', THANKSGIVING)).map((r) => `${r.trading_date}:${r.minute}`),
  ['2026-11-24:1230', '2026-11-25:30', '2026-11-25:600']);

// The store follows session.current and session.rollover; a subscriber hears only a changed US session.
realtime.startRealtimeStream();
const socket = live.sockets[0];
socket.ready();
const heard = [];
const release = subscribeUsMarketSession((us) => heard.push(us?.phase));
socket.frame({ type: 'session.current', payload: { equity: null, us: THANKSGIVING } });
socket.frame({ type: 'session.current', payload: { equity: null, us: THANKSGIVING } });
socket.frame({ type: 'session.rollover', payload: { rolled: {}, cleared: {}, session: { equity: null, us: THANKSGIVING_EVENING } } });
assert.deepEqual(heard, ['closed', 'overnight'], 'the same session twice is one notice');
assert.equal(usMarketSession().trading_date, '2026-11-27');
assert.equal(currentUsSession(), 'overnight');
release();

console.log('renderer_futu_us_trend_window_contract: ok');
