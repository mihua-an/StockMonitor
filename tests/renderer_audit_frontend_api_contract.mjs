import assert from 'node:assert/strict';
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";
import { getEventListeners } from 'node:events';
globalThis.localStorage = { getItem: () => null };
globalThis.window = { desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ['shioaji', 'futu'], sources: {} } }, dispatchEvent() {} };
globalThis.CustomEvent = class {};
const api = await import('../ui/renderer/js/core/api.js');
const timers = new Set();
globalThis.setTimeout = fn => { timers.add(fn); return fn; };
globalThis.clearTimeout = fn => timers.delete(fn);
const flush = () => new Promise(resolve => setImmediate(resolve));
const caller = new AbortController();
const helpers = ['apiGet', 'apiPost', 'apiJsonPost', 'apiJsonPut', 'apiDelete'];
for (const name of helpers) {
  const call = (signal = caller.signal) => name.startsWith('apiJson')
    ? api[name]('/api/market-daemon/audit', {}, { signal }) : api[name]('/api/market-daemon/audit', { signal });
  for (const ok of [true, false]) {
    let signal;
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return { ok, status: 503, json: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }) };
    };
    const pending = call();
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await flush();
    assert.equal(timers.size, 1, `${name}: body remains timed`);
    for (const fire of timers) fire();
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  }
  for (let i = 0; i < 25; i++) {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    assert.deepEqual(await call(), { ok: true });
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  }
  for (const alreadyAborted of [false, true]) {
    const cancel = new AbortController();
    globalThis.fetch = async (_url, { signal }) => {
      if (signal.aborted) throw signal.reason;
      return { ok: true, json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }) };
    };
    if (alreadyAborted) cancel.abort();
    const rejected = assert.rejects(call(cancel.signal), { name: 'AbortError' });
    await flush();
    if (!alreadyAborted) cancel.abort();
    await rejected;
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(cancel.signal, 'abort').length, 0);
  }
  for (const ok of [true, false]) {
    globalThis.fetch = async () => ({ ok, status: 500, json: async () => { throw new SyntaxError('bad JSON'); } });
    await assert.rejects(call());
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  }
}
console.log('A03/A10 PASS: all five helpers, stalled success/error bodies, 125 reused-signal completions, JSON failures');
