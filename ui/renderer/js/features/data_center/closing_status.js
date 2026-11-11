// Presentation only: the materialization ledger (service/market/shared/materialization_ledger.py) owns scheduling,
// retries and the attempt limit. This turns one session's ledger state (a category's `materialization` in
// /api/data-center/date) into its 收盤整理 cell: done reads 完成, a failure waiting for its retry reads only the retry
// time in the warning colour (user 10-28), a failure that stopped retrying reads 失敗. Times from the ledger are epoch
// seconds.

const pad = (n) => String(n).padStart(2, "0");

function retryText(nextAttemptAt) {
  const seconds = Number(nextAttemptAt);
  if (nextAttemptAt === null || nextAttemptAt === "" || !Number.isFinite(seconds) || seconds <= 0) return "等待重試";
  const at = new Date(seconds * 1000);
  return `${pad(at.getHours())}:${pad(at.getMinutes())} 重試`;
}

// 物化結果 (user 11-06): while the session is being materialized (or its job failed), the ledger's state; once it is
// done, what its partitions are -- 完整 (every one complete), 已修復 (prints filled from the broker's history, the
// book of the gap lost: not complete), 不完整 (a gap) -- with the counts when they differ. `completeness` is the
// category's {complete, repaired, gap_detected} partition counts (/api/data-center/date).
export function resultView(item) {
  const ledger = closingStatusView(item?.materialization);
  const counts = item?.completeness || {};
  const n = (key) => Math.max(0, Number(counts[key]) || 0);
  const total = n("complete") + n("repaired") + n("gap_detected");
  const settled = ["none", "succeeded"].includes(String(item?.materialization?.state || "none"));
  if (!settled || !total) return ledger;
  const parts = [["gap_detected", "不完整"], ["repaired", "已修復"], ["complete", "完整"]].filter(([key]) => n(key) > 0);
  if (parts.length === 1) {
    const [key, label] = parts[0];
    return { text: label, tone: key === "complete" ? "pass" : key === "repaired" ? "info" : "warn" };
  }
  return { text: parts.map(([key, label]) => `${label} ${n(key)}`).join("・"), tone: n("gap_detected") ? "warn" : "info" };
}

// A category made of sessions (期貨指數's 日盤／夜盤): their partitions together, or the ledger state of one still
// being materialized.
export function combinedResultView(items = []) {
  const busy = items.find((s) => !["none", "succeeded"].includes(String(s?.materialization?.state || "none")));
  if (busy) return resultView(busy);
  const completeness = {};
  for (const s of items) {
    for (const [key, value] of Object.entries(s?.completeness || {})) completeness[key] = (completeness[key] || 0) + (Number(value) || 0);
  }
  // Every session done is the category done (完成 while no partition counts are known), as for a one-session category.
  const done = items.length > 0 && items.every((s) => String(s?.materialization?.state || "none") === "succeeded");
  return resultView({ materialization: done ? { state: "succeeded" } : null, completeness });
}

// { text, tone } -- tone is a .settings-badge state ("pass" / "warn" / "info" / "fail", drawn as is-<tone>) or "" for a plain state.
export function closingStatusView(item) {
  const state = String(item?.state || "none");
  if (state === "succeeded") return { text: "完成", tone: "pass" };
  if (state === "failed_retryable") return { text: retryText(item.next_attempt_at), tone: "warn" };
  if (state === "failed_terminal") return { text: "失敗", tone: "fail" };
  if (state === "intent_pending" || state === "pending" || state === "running") return { text: "整理中", tone: "" };
  if (state === "no_input") return { text: "沒有資料", tone: "" };
  return { text: "—", tone: "" };
}

