import assert from "node:assert/strict";
import { rendererNetworkManifest } from "./support/renderer_network_manifest.mjs";

// The 歷史 modules call back into the page through named hooks the page installs as one complete set: before the
// install a call names the hook it needed, and an install that leaves one out (or names one that does not exist)
// fails at load instead of somewhere later.
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { desktopAPI: { networkManifest: rendererNetworkManifest() }, dispatchEvent() {}, addEventListener() {} };
const { historyHooks, installHistoryPageHooks } = await import("../ui/renderer/js/features/history/history_state.js");

assert.throws(() => historyHooks.updatePlayButton(), /history page hook updatePlayButton is not installed/);
const names = ["invalidateReplayComponents", "rerenderHistoryCurrentChart", "updateHistoryTimeLabel", "updatePlayButton",
  "setHistoryChartLoading"];
const calls = [];
const hooks = Object.fromEntries(names.map((name) => [name, () => calls.push(name)]));
const { setHistoryChartLoading: _left, ...missingOne } = hooks;
assert.throws(() => installHistoryPageHooks(missingOne), /missing setHistoryChartLoading/);
assert.throws(() => installHistoryPageHooks({ ...hooks, renderTypo: () => {} }), /unknown hooks renderTypo/);
assert.throws(() => historyHooks.updatePlayButton(), /not installed/, "a refused install changes nothing");
installHistoryPageHooks(hooks);
historyHooks.updatePlayButton();
assert.deepEqual(calls, ["updatePlayButton"]);
assert.throws(() => { historyHooks.somethingNew = () => {}; }, TypeError, "the set of hooks is fixed");
console.log("renderer history page hooks contract passed");
