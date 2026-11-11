"use strict";
// Every renderer page carries the same strict CSP -- no blanket `file:` source, and
// object-src / base-uri / frame-src 'none'. Verified in Electron: same-directory modules, CSS, images and
// fetch of local JSON still load under 'self' (Chromium matches file: documents' own files to 'self'); <object>,
// eval and any port outside the connect list are blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");

const dir = path.join(__dirname, "..", "ui", "renderer");
const pages = fs.readdirSync(dir).filter((name) => name.endsWith(".html"));
assert.deepEqual(pages.sort(), ["detached_view.html", "index.html", "startup_error.html", "trade_window.html", "watch_pages_window.html",
  "workspace_view.html"].sort(), "a new page must be added here with its CSP");

function policy(page) {
  const html = fs.readFileSync(path.join(dir, page), "utf8");
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(match, `${page} has no CSP`);
  return Object.fromEntries(match[1].split(";").map((part) => part.trim()).filter(Boolean)
    .map((part) => { const [name, ...values] = part.split(/\s+/); return [name, values]; }));
}

for (const page of pages) {
  const csp = policy(page);
  for (const [directive, values] of Object.entries(csp)) {
    assert.ok(!values.includes("file:"), `${page} ${directive} allows the whole file: scheme`);
    assert.ok(!values.includes("'unsafe-eval'") && !values.includes("*"), `${page} ${directive} is too broad`);
  }
  assert.deepEqual(csp["base-uri"], ["'none'"], `${page} base-uri`);
  assert.deepEqual(csp["script-src"], ["'self'"], `${page} script-src`);
  if (page === "startup_error.html") {
    assert.deepEqual(csp["default-src"], ["'none'"]);     // covers object-src and frame-src
    continue;
  }
  assert.deepEqual(csp["default-src"], ["'self'"], `${page} default-src`);
  assert.deepEqual(csp["connect-src"], ["'self'", "__STOCKMONITOR_CONNECT_SOURCES__"], `${page} connect-src`);
  assert.deepEqual(csp["object-src"], ["'none'"], `${page} object-src`);
  assert.deepEqual(csp["frame-src"], ["'none'"], `${page} frame-src`);
}
console.log(`renderer CSP contract passed (${pages.length} pages)`);
