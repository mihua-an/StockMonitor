// 帳務 配對回放: replays one closed trade pair on its day with Market Runtime's replay (as 歷史回放 does, a second at a
// time) in a panel of its own cards under the pair's row.
// The parts, one responsibility each:
//   pair_replay_model.js    pure: entry / exit, whether a pair can be replayed, what each card shows at a time
//   pair_replay_session.js  which pair is open, its replay and the day's indexes, open / close / play / seek
//   pair_replay_view.js     the panel's six cards and play bar, a frame at the replay time
// This module is what the 帳務 views import.
export { replayEntryRef, replayExitRef, replayPeriodClockText } from "./pair_replay_model.js";
export { closePairReplay, installPairReplayOrigin, openPairReplay, pairReplayAvailable, replayHooks } from "./pair_replay_session.js";
export { actualReplayRowSelector, bindPairReplayControls, replayPanelHtml } from "./pair_replay_view.js";
