"use strict";
// Electron main's remediation delivery (Health's control API, POST /control/remediation): a batch Health could not
// settle within its deadline, or a request Health never answered, is kept and sent again after a backoff -- never
// counted as delivered, never lost; what Health settled is dropped from the queue in order.
const assert = require("node:assert/strict");
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
const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  const ackMs = contract.loadRegistry().limits.client_ack_timeout_ms;
  assert.ok(Number.isInteger(ackMs) && ackMs > 0);
  const posts = [];
  const answers = [];      // what each post resolves (a number) or rejects with (an Error), in order
  const post = (events, timeoutMs) => {
    posts.push({ events, timeoutMs });
    const answer = answers.shift();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  const client = createRemediationClient({ process: { service_id: "t", instance_id: "t-1", pid: 1, runtime: "node" },
    post, setTimer, clearTimer, logger: { warn() {} } });
  const emit = () => client.emit({ component: "c", mechanismId: "sink.client_loss", triggerReason: "queue_full", identity: {}, outcome: "failed" });

  // ---- Health takes the batch but settles only the first of two within its deadline
  answers.push(1, 0);
  emit(); emit();
  await tick(); await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[0].events.length, 1, "the first event went out on its own");
  assert.ok(posts[0].timeoutMs > ackMs, "the request outlasts Health's own deadline");
  // The second emit queued behind the first request and went out once it was answered.
  assert.equal(posts[1].events.length, 1);
  let status = client.status();
  assert.equal(status.delivered, 1);
  assert.equal(status.ack_timeouts, 1);
  assert.equal(status.queued, 1, "the unsettled event is kept to send again");
  assert.match(status.last_error, /settled 0 of 1/);

  // ---- the retry: Health is gone (no answer), then back
  answers.push(new Error("connect ECONNREFUSED"));
  fire(500);
  await tick(); await tick();
  status = client.status();
  assert.equal(status.connected, false);
  assert.equal(status.reconnects, 1);
  assert.equal(status.queued, 1);
  answers.push(1);
  fire(1000);
  await tick(); await tick();
  status = client.status();
  assert.equal(status.delivered, 2);
  assert.equal(status.queued, 0);
  assert.equal(status.inflight, 0);
  assert.ok(status.last_ack_at);
  assert.equal(posts.at(-1).events[0].event_id, posts[1].events[0].event_id, "the same event, sent again");
  assert.equal(await client.flush(10), true);
  client.close();
  console.log("remediation ack deadline contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
