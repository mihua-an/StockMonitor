// The error log keeps what the renderer logged (10-19: 15 records of "[TRADE PAGE COUNT] [object Object]"). Electron
// main's console-message relay gets Chromium's text of a console call, so console_text.js turns each argument of
// console.warn / console.error into text first, and every window's entry module installs it before anything else.
// The end-to-end check, in Chromium: renderer_console_relay_ui.cjs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { consoleArgumentText, describeError, installConsoleRelayText, rendererFrameLocation } from "../ui/renderer/js/core/console_text.js";

assert.equal(consoleArgumentText("plain"), "plain");
assert.equal(consoleArgumentText(42), 42);
assert.equal(consoleArgumentText(null), null);
assert.equal(consoleArgumentText(undefined), undefined);
// An error keeps where it was thrown: its name and message, then the first frames of its stack.
assert.match(consoleArgumentText(new TypeError("boom")), /^TypeError: boom at .*renderer_console_relay_contract\.mjs:\d+:\d+/);
const timeout = new DOMException("signal timed out", "TimeoutError");
assert.ok(consoleArgumentText(timeout).startsWith("TimeoutError: signal timed out"));
assert.equal(consoleArgumentText({ outcome: "dropped", page: 3 }), '{"outcome":"dropped","page":3}');
assert.match(consoleArgumentText({ componentId: "x", error: new Error("inner") }), /^\{"componentId":"x","error":\{"name":"Error","message":"inner","stack":"at /);
assert.equal(consoleArgumentText([1, { a: 2 }]), '[1,{"a":2}]');
const loop = { name: "loop" };
loop.self = loop;
assert.equal(consoleArgumentText(loop), '{"name":"loop","self":"[circular]"}');
const long = consoleArgumentText({ text: "x".repeat(5000) });
assert.ok(long.length < 2100 && long.endsWith("chars)"), "a long argument is cut and says how long it was");
assert.match(consoleArgumentText({ get bad() { throw new Error("no"); } }), /^\[Object: not serialisable \(Error: no\)\]$/);
assert.equal(describeError("text"), "text");

// The record names the code that logged, not the wrapper (Electron main's own source of the call is now the wrapper).
assert.equal(rendererFrameLocation("    at recordPageCountRead (file:///C:/Users/x/AppData/Roaming/app/renderer-assets/dd55bfa1/js/market_data/trade_detail/perf_trace.js:19:47)"),
  "js/market_data/trade_detail/perf_trace.js:19");
assert.equal(rendererFrameLocation("    at file:///C:/repo/ui/renderer/js/pages/realtime.js:981:13"), "js/pages/realtime.js:981");
assert.equal(rendererFrameLocation("    at <anonymous>:1:9"), "", "code without a file (an eval) has no place to add");

const calls = [];
const fake = { warn: (...args) => calls.push(["warn", ...args]), error: (...args) => calls.push(["error", ...args]), log: (...args) => calls.push(["log", ...args]) };
installConsoleRelayText(fake);
installConsoleRelayText(fake);
fake.warn("[TRADE PAGE COUNT]", { outcome: "dropped" }); const warnLine = Number(new Error().stack.split("\n")[1].match(/:(\d+):\d+\)?$/)[1]);
const aborted = new DOMException("aborted", "AbortError");
fake.error("[x] failed", aborted);
const logged = { kept: true };
fake.log("log is not relayed", logged);
const here = new URL(import.meta.url).href;
assert.deepEqual(calls, [
  ["warn", "[TRADE PAGE COUNT]", '{"outcome":"dropped"}', `@ ${here}:${warnLine}`],
  ["error", "[x] failed", consoleArgumentText(aborted), `@ ${here}:${warnLine + 2}`],
  ["log", "log is not relayed", logged],
]);

// Every window's entry module installs it first, so even what its other imports log while loading is recorded.
const rendererDir = new URL("../ui/renderer/", import.meta.url);
const entries = readdirSync(rendererDir).filter((name) => name.endsWith(".html"))
  .flatMap((name) => [...readFileSync(new URL(name, rendererDir), "utf8").matchAll(/<script type="module" src="(?:\.\/)?([^"]+)"/g)].map((m) => m[1]));
assert.ok(entries.length >= 5, `found the windows' entry modules: ${entries.join(", ")}`);
for (const entry of entries) {
  const source = readFileSync(new URL(entry, rendererDir), "utf8");
  const firstImport = source.match(/^import\s+(?:[^"']*from\s+)?["']([^"']+)["']/m)?.[1];
  assert.equal(firstImport, "./js/core/console_relay.js", `${entry}: the console relay is its first import`);
}
console.log("renderer console relay contract passed");
