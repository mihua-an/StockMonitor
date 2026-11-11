// 11-06 11:44 the 即時報價 「行情資料未同步」 notice stayed 21.5 s after a restart. Two parts of that are the renderer's:
// the dock's /api/status poll -- the read that also clears the notice -- went from 1 s to 5 s as soon as the broker was
// connected, though its market data was not ready yet; and the freshness record said only
// `market_data_available: false`, not which status fact held it false, so the cause could not be read afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = fs.readFileSync(path.join(root, "ui", "renderer", "app.js"), "utf8");
const match = app.match(/function brokerSettledIn\(status\) \{[\s\S]*?\n\}/);
assert.ok(match, "app.js defines brokerSettledIn");
// eslint-disable-next-line no-new-func
const brokerSettledIn = new Function(`${match[0]}; return brokerSettledIn;`)();
const status = (readiness, enabled = true) => ({ sources: { shioaji: { enabled } }, broker_status: { readiness } });

assert.equal(brokerSettledIn(status({ connected: true, market_data_ready: false })), false,
  "a logged-in broker whose data is not ready keeps the 1 s cadence");
assert.equal(brokerSettledIn(status({ connected: true, market_data_ready: true })), true, "data ready: 5 s");
assert.equal(brokerSettledIn(status({ connected: false, market_data_ready: false })), false);
assert.equal(brokerSettledIn(status({}, false)), true, "a source that is off is settled");

globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {} };
const { marketDataFactsFromStatus } = await import(new URL("../ui/renderer/js/features/realtime/session_state.js", import.meta.url));
assert.deepEqual(marketDataFactsFromStatus({ broker_status: { state: "CONNECTED_WAITING_SESSION", daemon_reachable: true, callback_age_seconds: 1.5,
  readiness: { connected: true, market_data_ready: false, canonical_ready: true, state: "STARTING", reason: null } } }), {
  state: "CONNECTED_WAITING_SESSION", daemon_reachable: true, connected: true, market_data_ready: false, canonical_ready: true,
  readiness_state: "STARTING", reason: null, callback_age_seconds: 1.5 }, "the record names each fact the availability is read from");

const sessionState = fs.readFileSync(path.join(root, "ui", "renderer", "js", "features", "realtime", "session_state.js"), "utf8");
assert.match(sessionState, /function freshnessCause\(\) \{[\s\S]*market_data: marketDataFacts/, "the freshness record carries them");
const controller = fs.readFileSync(path.join(root, "ui", "renderer", "js", "features", "realtime", "session_controller.js"), "utf8");
assert.match(controller, /const available = marketDataAvailableFromStatus\(status\);\s*setMarketDataFacts\(marketDataFactsFromStatus\(status\)\);/,
  "set from the same status the availability is read from");
console.log("renderer status poll until market data contract: ok");
