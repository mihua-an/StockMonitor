// 資料中心's 收盤整理 cell (user 10-28): the materialization ledger's state of a category's session. Done reads 完成; a
// failure waiting for its retry reads only the retry time in the warning colour, never 失敗; 期貨指數 reads the session
// that is not done.
import assert from "node:assert/strict";
import { closingStatusView, combinedResultView, resultView } from "../ui/renderer/js/features/data_center/closing_status.js";

const at = (h, m) => new Date(2026, 9, 28, h, m).getTime() / 1000;
assert.deepEqual(closingStatusView({ state: "succeeded" }), { text: "完成", tone: "pass" });
assert.deepEqual(closingStatusView({ state: "failed_retryable", next_attempt_at: at(14, 52) }), { text: "14:52 重試", tone: "warn" });
assert.deepEqual(closingStatusView({ state: "failed_retryable", next_attempt_at: null }), { text: "等待重試", tone: "warn" });
assert.deepEqual(closingStatusView({ state: "failed_terminal" }), { text: "失敗", tone: "fail" });
assert.deepEqual(closingStatusView({ state: "running" }), { text: "整理中", tone: "" });
assert.deepEqual(closingStatusView({ state: "none" }), { text: "—", tone: "" });
assert.deepEqual(closingStatusView(null), { text: "—", tone: "" });

// 物化結果 (user 11-06): once materialized, what the partitions are; while it runs or failed, the ledger's state.
const done = (completeness, state = "succeeded") => ({ materialization: { state }, completeness });
assert.deepEqual(resultView(done({ complete: 54, repaired: 0, gap_detected: 0 })), { text: "完整", tone: "pass" });
assert.deepEqual(resultView(done({ complete: 0, repaired: 54, gap_detected: 0 })), { text: "已修復", tone: "info" });
assert.deepEqual(resultView(done({ complete: 0, repaired: 0, gap_detected: 3 })), { text: "不完整", tone: "warn" });
assert.deepEqual(resultView(done({ complete: 10, repaired: 39, gap_detected: 0 })), { text: "已修復 39・完整 10", tone: "info" });
assert.deepEqual(resultView(done({ complete: 1, repaired: 2, gap_detected: 3 })), { text: "不完整 3・已修復 2・完整 1", tone: "warn" });
assert.deepEqual(resultView(done({ complete: 5 }, "none")), { text: "完整", tone: "pass" }, "the ledger forgot an old session: its partitions say");
assert.deepEqual(resultView(done({ complete: 5 }, "running")), { text: "整理中", tone: "" }, "being materialized again: the ledger says");
assert.deepEqual(resultView(done({ complete: 5 }, "failed_retryable")).tone, "warn");
assert.deepEqual(resultView({ materialization: { state: "running" } }), { text: "整理中", tone: "" });
assert.deepEqual(combinedResultView([done({ repaired: 1 }), done({ gap_detected: 1 })]), { text: "不完整 1・已修復 1", tone: "warn" });
assert.deepEqual(combinedResultView([done({ complete: 1 }), done({ complete: 1 }, "running")]), { text: "整理中", tone: "" });
console.log("renderer closing status contract passed");
