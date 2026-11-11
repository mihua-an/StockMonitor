"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// An operation id names a file under <config>/operations and can never reach outside it,
// through the operations store or through Health's control API; a 500 from the control API carries no exception text.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { NetworkOperations, validOperationId } = require("../health/operations");
const { createControllerHttpApi } = require("../health/control_api");

const configRoot = makeTempDir("w6-operation-id-");
fs.mkdirSync(path.join(configRoot, "operations"), { recursive: true });
fs.writeFileSync(path.join(configRoot, "secret.json"), JSON.stringify({ secret: "outside" }));
fs.writeFileSync(path.join(configRoot, "operations", "op-1.json"), JSON.stringify({ operation_id: "op-1", state: "APPLIED" }));

for (const id of ["op-1", "op-1759740000000-a1b2c3d4", "A.b_c-9"]) assert.equal(validOperationId(id), true, id);
for (const id of ["../secret", "..\\secret", "..", ".", "active", "a/b", "a\\b", "x..y", "", "a".repeat(81), "op 1", "op%2f", null, undefined]) {
  assert.equal(validOperationId(id), false, String(id));
}

const operations = new NetworkOperations({ configRoot, manifest: {}, supervisor: {}, entries: {}, effectiveRef: () => ({ services: {} }),
  hosts: {}, restartHealth: () => {}, logger: { log() {}, warn() {}, error() {} } });
assert.equal(operations.get("op-1").state, "APPLIED", "a valid id still reads its record");
assert.equal(operations.get("../secret"), null, "an id cannot read outside the operations directory");
assert.throws(() => operations.file("../secret"), /INVALID_OPERATION_ID/);

(async () => {
  await assert.rejects(() => NetworkOperations.markCandidateFailed(configRoot, { operation_id: "../secret" }, "x"), /INVALID_OPERATION_ID/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configRoot, "secret.json"), "utf8")), { secret: "outside" }, "nothing outside was written");
  const refused = await operations.apply({ operation_id: "../evil", candidate_revision: 2 });
  assert.deepEqual(refused, { ok: false, http: 400, error: "INVALID_OPERATION_ID" });
  assert.equal(fs.existsSync(path.join(configRoot, "evil.json")), false);

  // Through the control API: a traversal id is 404, an unexpected exception is a fixed message plus an id.
  const token = "t".repeat(64);
  const logged = [];
  const api = createControllerHttpApi({ host: "127.0.0.1", port: 0, token, identity: () => ({}), supervisor: { status: () => ({}), stopping: false },
    collector: {}, performShutdown: async () => ({}), operations, logger: { error: (line) => logged.push(line), log() {}, warn() {} } });
  await api.listen();
  const { port } = api.server.address();
  const get = (pathname) => fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    assert.equal((await get("/operations/op-1")).status, 200);
    for (const pathname of ["/operations/..%2fsecret", "/operations/%2e%2e%2fsecret", "/operations/..%5Csecret"]) {
      const result = await get(pathname);
      assert.equal(result.status, 404, pathname);
      assert.doesNotMatch(JSON.stringify(result.body), /outside/);
    }
    const broken = await get("/operations/%E0%A4%A");          // malformed escape: decodeURIComponent throws
    assert.equal(broken.status, 500);
    assert.equal(broken.body.error, "INTERNAL_ERROR");
    assert.match(broken.body.error_id, /^[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(broken.body), /URI|malformed/i, "no exception text reaches the caller");
    assert.ok(logged.some((line) => line.includes(broken.body.error_id) && /URI/i.test(line)), "the full error is in the log under that id");
  } finally { await api.close(); }
  console.log("W6 operation id containment and control API error contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
