// The 帳務 page's hooks for its split-out views fail loudly until the page installs them: a saved trade whose page
// never refreshes, or a replay that is never drawn, must be an error, not a silent no-op.
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { addEventListener() {}, desktopAPI: {} };
globalThis.document ??= { getElementById: () => null, addEventListener() {}, querySelector: () => null };

const { accountHooks, installAccountPageHooks } = await import("../ui/renderer/js/features/account/account_state.js");
await assert.rejects(() => accountHooks.refreshAfterChange(), /not installed/);
assert.throws(() => installAccountPageHooks({}), TypeError);
let refreshed = 0;
installAccountPageHooks({ refreshAfterChange: async () => { refreshed += 1; } });
await accountHooks.refreshAfterChange();
assert.equal(refreshed, 1);

const { replayHooks, installPairReplayOrigin } = await import("../ui/renderer/js/features/account/pair_replay.js");
assert.throws(() => replayHooks.renderOrigin(), /not installed/);
assert.throws(() => installPairReplayOrigin(null), TypeError);
let drawn = 0;
installPairReplayOrigin(() => { drawn += 1; });
replayHooks.renderOrigin();
assert.equal(drawn, 1);

console.log("renderer account hooks contract passed");
