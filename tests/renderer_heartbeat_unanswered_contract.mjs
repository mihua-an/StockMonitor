import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 2026-10-13: whenever no market data flowed, the live socket was closed and reopened every two minutes all night.
// The watchdog measured "time since the last frame", and in a hidden window Chromium runs its timers about once a
// minute, so a healthy socket whose heartbeats were all answered looked dead. Dead now means a heartbeat that went
// unanswered for HEARTBEAT_TIMEOUT_MS.
const source = readFileSync(new URL("../ui/renderer/js/market_data/realtime.js", import.meta.url), "utf8");

assert.match(source, /let heartbeatPendingSince = 0;/);
assert.match(source, /socket\.send\(JSON\.stringify\(\{ type: "health"[^\n]*\r?\n\s*if \(!heartbeatPendingSince\) heartbeatPendingSince = Date\.now\(\);/,
  "sending a heartbeat starts the wait for its answer (the oldest unanswered one counts)");
assert.match(source, /lastWebSocketFrameAt = Date\.now\(\);\r?\n\s*heartbeatPendingSince = 0;/, "any frame answers it (the link is alive)");
// The diagnostics' 上次 heartbeat 回覆 is the health reply itself, with its round trip -- not any frame.
assert.match(source, /type === "health"\) \{\r?\n\s*lastHeartbeatAckAt = Date\.now\(\);\r?\n\s*if \(lastHeartbeatSentAt\) heartbeatRoundTripMs = lastHeartbeatAckAt - lastHeartbeatSentAt;/);
assert.match(source, /if \(!heartbeatPendingSince \|\| Date\.now\(\) - heartbeatPendingSince <= HEARTBEAT_TIMEOUT_MS\) return;/,
  "only an unanswered heartbeat closes the socket");
assert.doesNotMatch(source, /if \(Date\.now\(\) - lastHeartbeatAckAt <= HEARTBEAT_TIMEOUT_MS\) return;/,
  "time since the last frame is not liveness");

console.log("renderer heartbeat unanswered contract passed");
