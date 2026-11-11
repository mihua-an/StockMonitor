"use strict";
// What a renderer logs reaches error.log through Electron main's record(): the renderer turns each console argument
// into text (console_text.js) and main, the log's owner, masks secrets in every line (config/js/secret_scrub.js).
// The secrets sit at the places a logged value carries them -- a URL query, an Authorization header, a quoted field of
// a nested object, an array item, an object with a circular reference, an error's message -- and the error keeps where
// it was thrown (the first frames of its stack), its code and its cause.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { makeTempDir } = require("./support/temp_dirs.cjs");
const { createRendererHealthRegistry } = require("../ui/main/renderer_health.js");

const SECRETS = ["q-token-111", "hdr-bearer-222", "nested-pass-333", "array-key-444", "loop-secret-555", "err-token-666", "main-pass-777"];

function throwDeep() {
  const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  throw Object.assign(new Error("request https://host/api?access_token=err-token-666 failed", { cause }), { code: "E_FETCH" });
}

async function main() {
  const { consoleArgumentText, errorFields } = await import("../ui/renderer/js/core/console_text.js");
  const dir = makeTempDir("renderer-error-scrub-");
  try {
    const errorLog = path.join(dir, "logs", "error.log");
    fs.mkdirSync(path.dirname(errorLog), { recursive: true });
    const registry = createRendererHealthRegistry({ fs, path, outputDir: path.join(dir, "out"), electronPid: 1, errorLogPath: errorLog });
    const contents = Object.assign(new EventEmitter(), { id: 7, getURL: () => "file:///app/index.html" });
    registry.observe(contents);
    const log = (...args) => contents.emit("console-message", { level: "error", message: args.map(consoleArgumentText).join(" "), lineNumber: 1, sourceId: "app.js" });

    log("[FETCH] failed", "https://host/live?token=q-token-111&page=2");
    log("[HTTP]", { headers: { Authorization: "Bearer hdr-bearer-222" } });
    log("[CFG]", { outer: { inner: { password: "nested-pass-333", keep: "visible-value" } } });
    log("[LIST]", ["plain", "api_key=array-key-444"]);
    const loop = { secret: "loop-secret-555" };
    loop.self = loop;
    log("[LOOP]", loop);
    let thrown;
    try { throwDeep(); } catch (error) { thrown = error; }
    log("[THROW]", thrown);
    log("[WRAPPED]", { during: "refresh", error: thrown });
    registry.reportMain("error", ["[MAIN]", { password: "main-pass-777", ok: 1 }]);
    await registry.close();

    const text = fs.readFileSync(errorLog, "utf8");
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} must not reach error.log:\n${text}`);
    assert.match(text, /\[redacted\]/);
    assert.match(text, /visible-value/, "what is not a secret is kept");
    assert.match(text, /page=2/, "the rest of a URL is kept");
    const throwLine = text.split("\n").find((line) => line.includes("[THROW]"));
    assert.match(throwLine, /Error: request https:\/\/host\/api\?access_token=\[redacted\] failed/);
    assert.match(throwLine, /\(code E_FETCH\)/, "the error's code is kept");
    assert.match(throwLine, /at throwDeep \(.*renderer_error_log_scrub_contract\.cjs:\d+:\d+\)/, "the place it was thrown is kept");
    assert.match(throwLine, /caused by: Error: socket hang up \(code ECONNRESET\)/, "its cause is kept");
    const wrappedLine = text.split("\n").find((line) => line.includes("[WRAPPED]"));
    assert.match(wrappedLine, /"name":"Error".*"code":"E_FETCH".*"stack":"at throwDeep/, "an error inside an object keeps its fields");

    // The stack is capped: a deep recursion keeps its first frames, not hundreds.
    let deep;
    const recurse = (n) => { if (n === 0) throw new Error("deep"); recurse(n - 1); };
    try { recurse(200); } catch (error) { deep = error; }
    const fields = errorFields(deep);
    assert.ok(fields.stack.split(" < ").length <= 6 && fields.stack.length <= 901, fields.stack);
    // A cause chain is cut after a few levels instead of following a cycle.
    const a = new Error("a"); const b = new Error("b", { cause: a }); a.cause = b;
    assert.doesNotThrow(() => consoleArgumentText(a));
    assert.equal((consoleArgumentText(a).match(/caused by: /g) || []).length, 3, consoleArgumentText(a));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("renderer error log scrub contract passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
