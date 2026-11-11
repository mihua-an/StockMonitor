import assert from 'node:assert/strict';
import { classifyTradeSideFromTick, TRADE_SIDE } from '../ui/renderer/js/core/market_color_policy.js';

// Explicit side strings win, in every naming convention producers use today.
assert.equal(classifyTradeSideFromTick({ trade_side: 'BUY' }), TRADE_SIDE.BUY);
assert.equal(classifyTradeSideFromTick({ tradeSide: 'sell' }), TRADE_SIDE.SELL);
assert.equal(classifyTradeSideFromTick({ side: 'OUT' }), TRADE_SIDE.BUY);
assert.equal(classifyTradeSideFromTick({ side: 'in' }), TRADE_SIDE.SELL);
assert.equal(classifyTradeSideFromTick({ side: 'neutral' }), TRADE_SIDE.NEUTRAL);

// /api/trade-detail/page rows never carry an explicit side — tick_type is the
// only signal. 1 = aggressor buy, 2 = aggressor sell.
assert.equal(classifyTradeSideFromTick({ tick_type: 1 }), TRADE_SIDE.BUY);
assert.equal(classifyTradeSideFromTick({ tick_type: 2 }), TRADE_SIDE.SELL);
assert.equal(classifyTradeSideFromTick({ tick_type: 0 }), TRADE_SIDE.UNKNOWN);
assert.equal(classifyTradeSideFromTick({ tickType: 1 }), TRADE_SIDE.BUY);

// Explicit side beats tick_type when both are present (never let a stale
// tick_type override a resolved side string).
assert.equal(classifyTradeSideFromTick({ side: 'SELL', tick_type: 1 }), TRADE_SIDE.SELL);

// Missing/unrecognized input is UNKNOWN, not a thrown error.
assert.equal(classifyTradeSideFromTick({}), TRADE_SIDE.UNKNOWN);
assert.equal(classifyTradeSideFromTick(undefined), TRADE_SIDE.UNKNOWN);
assert.equal(classifyTradeSideFromTick({ side: 'bogus', tick_type: 99 }), TRADE_SIDE.UNKNOWN);

console.log('renderer trade side classification contract passed');
