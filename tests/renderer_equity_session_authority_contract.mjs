// The renderer keeps no wall-clock session, and the code box searches any listed stock whatever the session
// (decisions.md 收盤後看任何商品都要有資料): a closed session's prints come from the broker.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const controller = readFileSync(new URL("../ui/renderer/js/features/realtime/selection_controller.js", import.meta.url), "utf8");
assert.doesNotMatch(controller, /盤後不訂閱|equitySessionIsLive/, "a search after the close goes through like one during the session");

const source = readFileSync(new URL("../ui/renderer/js/features/realtime/session_state.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /taiwan_session_clock|isTaiwanEquitySession|new Date\(/, "session_state keeps no wall-clock session");
assert.equal(existsSync(new URL("../ui/renderer/js/core/taiwan_session_clock.js", import.meta.url)), false,
  "the renderer wall-clock session is gone");
console.log("renderer equity session authority contract ok");
