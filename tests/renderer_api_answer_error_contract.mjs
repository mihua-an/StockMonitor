import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// An answered failure (`ok: false`, any HTTP status) reaches a page's error path as an ApiAnswerError carrying the
// server's code and message; a success, with or without an `ok` field, passes through unchanged.
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { desktopAPI: { networkManifest: rendererNetworkManifest() }, dispatchEvent() {} };
const { requireOk, ApiAnswerError } = await import("../ui/renderer/js/core/api.js");

const success = { ok: true, items: [] };
assert.equal(requireOk(success, "GET /x"), success);
const plain = { dates: [] };
assert.equal(requireOk(plain, "GET /x"), plain, "a success without an ok field is data");
assert.throws(() => requireOk({ ok: false, error: "REVISION_CONFLICT", message: "其他視窗已保存" }, "GET /api/config/network"), (error) => {
  assert.ok(error instanceof ApiAnswerError);
  assert.equal(error.code, "REVISION_CONFLICT");
  assert.equal(error.userMessage, "其他視窗已保存");
  assert.match(error.message, /^GET \/api\/config\/network answered ok: false \(REVISION_CONFLICT\)/);
  return true;
});
assert.throws(() => requireOk({ ok: false }, "GET /y"), (error) => error.code === "failed" && error.userMessage === undefined);

// Every page read named in the review goes through the strict read (no `result?.ok` check left to forget).
const read = (name) => readFileSync(new URL(`../ui/renderer/js/pages/${name}`, import.meta.url), "utf8");
for (const [name, path] of [["settings_capital.js", "ledger.path"], ["settings_system.js", '"/api/config/network"'],
  ["data_center.js", '"/api/data-center/dates"'], ["training.js", '"/api/training/models"']]) {
  assert.ok(read(name).includes(`apiGetOk(${path}`), `${name} reads ${path} with apiGetOk`);
}
assert.match(read("history.js"), /apiGetOk\(`\/api\/monitor\/events\?/);
console.log("renderer api answer error contract passed");
