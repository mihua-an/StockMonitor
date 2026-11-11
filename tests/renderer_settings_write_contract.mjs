// A versioned settings write (core/settings_write.js): one request shape, the failure recorded once, one wording for a
// conflict and a refusal, and a failed request answered instead of thrown.
import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {
  desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
  dispatchEvent() {},
};
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
console.warn = () => {};

const { describeSettingsProblems, saveVersionedSetting } = await import("../ui/renderer/js/core/settings_write.js");

let reply = null;
const sent = [];
globalThis.fetch = async (_url, options = {}) => {
  sent.push(JSON.parse(options.body));
  if (reply instanceof Error) throw reply;
  return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
};

const records = [];
const save = (label = "") => saveVersionedSetting({ path: "/api/config/x", expectedRevision: undefined, values: { a: 1 }, label,
  recordFailure: (...args) => records.push(args) });

reply = { status: 200, body: { ok: true, revision: { revision: 7 } } };
const saved = await save();
assert.deepEqual(sent.at(-1), { expected_revision: null, values: { a: 1 }, summary: "settings page" });
assert.equal(saved.ok, true);
assert.equal(saved.result.revision.revision, 7);
assert.equal(records.length, 0, "a save that went through records nothing");

reply = { status: 409, body: { ok: false, error: "REVISION_CONFLICT" } };
const conflict = await save("保存天數");
assert.equal(conflict.ok, false);
assert.equal(conflict.conflict, true);
assert.equal(conflict.text, "保存天數保存衝突：其他視窗已保存新版本，已重新載入，請確認後再保存");
assert.deepEqual(records.at(-1), ["saving", "PUT /api/config/x", reply.body]);

reply = { status: 422, body: { ok: false, error: "INVALID", problems: [{ code: "PORT_IN_USE", service_id: "health" }, { message: "太大" }] } };
const refused = await save();
assert.equal(refused.conflict, false);
assert.equal(refused.text, "保存失敗：PORT_IN_USE (health)；太大");

reply = { status: 422, body: { ok: false, error: "INVALID" } };
assert.equal((await save()).text, "保存失敗：INVALID", "without problems: the error code");

reply = new Error("connection refused");
const failed = await save();
assert.equal(failed.ok, false);
assert.equal(failed.conflict, false);
assert.match(failed.text, /^保存失敗：.*connection refused/);
assert.equal(records.at(-1)[2], reply, "a failed request is recorded with its error");

assert.equal(describeSettingsProblems(null), "");
console.log("renderer settings write contract passed");
