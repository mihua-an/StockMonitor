// The ledger keeps the last attempt and the last complete success apart; the screen shows the success and
// only mentions the attempt when it is newer and did not finish.
export function formatLastSync(status) {
  const success = String(status?.last_sync_success_at || "");
  const attempt = String(status?.last_sync_attempt_at || "");
  const attemptStatus = String(status?.last_sync_attempt_status || "");
  const text = (value) => value.replace("T", " ");
  let line = success ? `最後成功同步：${text(success)}` : "尚未成功同步";
  if (attempt && attempt > success && (attemptStatus === "failed" || attemptStatus === "incomplete")) {
    line += `（${text(attempt)} 的同步${attemptStatus === "failed" ? "失敗" : "未完成"}）`;
  }
  return line;
}
