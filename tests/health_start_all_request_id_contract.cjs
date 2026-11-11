"use strict";
// A UI attaching to a running Health retries a start-all whose answer it did not get, with the same request id. Health
// answers a repeat of a request id with the attempt the first request began -- a retry whose first answer was lost
// never begins a second attempt.
const assert = require("node:assert/strict");
const { createControllerHttpApi } = require("../health/control_api");

(async () => {
  const token = "t".repeat(64);
  let generation = 0;
  const supervisor = { status: () => ({}), stopping: false, attempt: null,
    startAll() { generation += 1; this.attempt = { generation }; return Promise.resolve({}); } };
  const api = createControllerHttpApi({ host: "127.0.0.1", port: 0, token, identity: () => ({ instance_id: "health-x" }), supervisor,
    collector: {}, performShutdown: async () => ({}), logger: { error() {}, log() {}, warn() {} } });
  await api.listen();
  const { port } = api.server.address();
  const startAll = (body) => fetch(`http://127.0.0.1:${port}/control/start-all`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const first = await startAll({ request_id: "attach-1" });
    assert.equal(first.status, 202);
    assert.deepEqual(first.body.attempt, { generation: 1, health_instance: "health-x" });
    const repeat = await startAll({ request_id: "attach-1" });
    assert.equal(repeat.body.repeated, true);
    assert.deepEqual(repeat.body.attempt, first.body.attempt, "the attempt the first request began");
    assert.equal(generation, 1, "no second start-all");
    const other = await startAll({ request_id: "attach-2" });
    assert.equal(other.body.attempt.generation, 2, "another request id is another attempt");
    const anonymous = await startAll();
    assert.equal(anonymous.body.attempt.generation, 3, "a request without an id begins its own attempt");
    // The memory is bounded: after 32 newer ids the oldest is forgotten.
    for (let i = 0; i < 32; i += 1) await startAll({ request_id: `filler-${i}` });
    assert.equal((await startAll({ request_id: "attach-1" })).body.repeated, undefined);
  } finally { await api.close(); }
  console.log("health start-all request id contract ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
