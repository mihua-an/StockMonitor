"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareRendererAssets, CSP_PLACEHOLDER } = require("../ui/main/renderer_assets");
const root = makeTempDir("renderer-assets-contract-");
const source = path.join(root, "source"), cache = path.join(root, "cache");
fs.mkdirSync(path.join(source, "js"), { recursive: true });
fs.writeFileSync(path.join(source, "index.html"), '<script type="module" src="./js/app.js"></script>');
fs.writeFileSync(path.join(source, "js/app.js"), 'export const revision = "old";');
const old = prepareRendererAssets(source, cache);
assert.equal(prepareRendererAssets(source, cache), old);
fs.writeFileSync(path.join(source, "js/app.js"), 'export const revision = "new";');
const fresh = prepareRendererAssets(source, cache);
assert.notEqual(old, fresh, "Child module updates change the whole entry URL");
assert.match(fs.readFileSync(path.join(old, "js/app.js"), "utf8"), /old/);
assert.match(fs.readFileSync(path.join(fresh, "js/app.js"), "utf8"), /new/);
assert.equal(fs.readFileSync(path.join(old, "index.html"), "utf8"), fs.readFileSync(path.join(fresh, "index.html"), "utf8"));
fs.writeFileSync(path.join(fresh, "js/app.js"), "corrupted");
assert.throws(() => prepareRendererAssets(source, cache), /incomplete or modified/);

// A capture that never finished (no completion marker) is written again, never served and never a directory rename.
fs.rmSync(path.join(fresh, ".release-complete"));
fs.rmSync(path.join(fresh, "index.html"));
assert.equal(prepareRendererAssets(source, cache), fresh);
assert.match(fs.readFileSync(path.join(fresh, "js/app.js"), "utf8"), /new/);
assert.ok(fs.existsSync(path.join(fresh, "index.html")) && fs.existsSync(path.join(fresh, ".release-complete")));
assert.ok(!fs.readdirSync(cache).some((name) => name.startsWith(".prepare-")), "no staging tree is made");

// CSP connect-src follows the effective endpoints exactly (AGENTS.md section 5).
const cspSource = path.join(root, "csp-source"), cspCache = path.join(root, "csp-cache");
fs.mkdirSync(cspSource, { recursive: true });
fs.writeFileSync(path.join(cspSource, "index.html"),
  `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' file: ${CSP_PLACEHOLDER};">`);
const a = prepareRendererAssets(cspSource, cspCache, { connectSources: ["http://127.0.0.1:8000", "ws://127.0.0.1:8010"] });
assert.match(fs.readFileSync(path.join(a, "index.html"), "utf8"), /connect-src 'self' file: http:\/\/127\.0\.0\.1:8000 ws:\/\/127\.0\.0\.1:8010;/);
const b = prepareRendererAssets(cspSource, cspCache, { connectSources: ["http://127.0.0.1:28000", "ws://127.0.0.1:28010"] });
assert.notEqual(a, b, "a port change is a new release, never a stale CSP");
assert.match(fs.readFileSync(path.join(b, "index.html"), "utf8"), /28000 ws:\/\/127\.0\.0\.1:28010;/);
assert.throws(() => prepareRendererAssets(cspSource, cspCache, { connectSources: ["http://*:*"] }), /non-loopback/);
assert.throws(() => prepareRendererAssets(cspSource, cspCache, { connectSources: ["http://192.168.1.5:8000"] }), /non-loopback/);
console.log("renderer complete-release cache, reuse, corruption and CSP contracts passed");
