"use strict";
// A writer that takes the connection and then stops acknowledging used to leave the client "connected" forever: no
// reconnect, the queue filled and events were lost. Now an unacknowledged frame has a deadline; past it the socket
// is dropped, the frame goes back to the queue and is sent again on the next connection (R15-16).
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRemediationClient } = require("../service/platform/js/remediation_client.js");
const contract = require("../config/js/remediation_contract.js");

const timers = [];
const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
const clearTimer = (t) => { if (t) t.cleared = true; };
const fire = (ms) => {
  const t = timers.find((x) => !x.cleared && x.ms === ms);
  assert.ok(t, `a timer of ${ms} ms is armed`);
  t.cleared = true;
  t.fn();
};

const sockets = [];
function connect() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  socket.write = (frame) => { socket.written.push(frame); };
  socket.destroy = () => { socket.destroyed = true; setImmediate(() => socket.emit("close")); };
  socket.end = () => {};
  sockets.push(socket);
  setImmediate(() => socket.emit("connect"));
  return socket;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ack = (socket, n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); socket.emit("data", b); };

(async () => {
  const ackMs = contract.loadRegistry().limits.client_ack_timeout_ms;
  assert.ok(Number.isInteger(ackMs) && ackMs > 0);
  const client = createRemediationClient({ process: { service_id: "t", instance_id: "t-1", pid: 1, runtime: "node" },
    pipePath: "\\\\.\\pipe\\test", connect, setTimer, clearTimer, logger: { warn() {} } });
  client.emit({ component: "c", mechanismId: "sink.client_loss", triggerReason: "queue_full", identity: {}, outcome: "failed" });
  await tick();
  assert.equal(sockets[0].written.length, 1);
  assert.equal(client.status().inflight, 1);

  fire(ackMs);                                  // the writer took it and went silent
  await tick();
  let status = client.status();
  assert.equal(status.ack_timeouts, 1);
  assert.equal(status.connected, false);
  assert.equal(status.queued, 1, "the unacknowledged frame is kept to send again");
  assert.ok(sockets[0].destroyed);
  assert.match(status.last_error, /did not acknowledge/);
  assert.equal(status.last_ack_at, null);

  fire(500);                                    // reconnect
  await tick();
  assert.equal(sockets[1].written.length, 1, "sent again on the new connection");
  ack(sockets[1], 1);
  status = client.status();
  assert.equal(status.delivered, 1);
  assert.equal(status.inflight, 0);
  assert.ok(status.last_ack_at);
  assert.ok(timers.every((t) => t.cleared || t.ms !== ackMs), "no deadline armed with nothing in flight");
  client.close();
  console.log("remediation ack deadline contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
