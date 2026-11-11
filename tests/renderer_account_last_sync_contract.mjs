// Contract: the settings page shows the last complete sync, and mentions a newer attempt only when it
// failed or did not finish.
import assert from "node:assert/strict";
import { formatLastSync } from "../ui/renderer/js/features/account/last_sync_format.js";

assert.equal(formatLastSync({}), "尚未成功同步");
assert.equal(
  formatLastSync({ last_sync_success_at: "2026-10-06T09:00:00", last_sync_attempt_at: "2026-10-06T09:00:00", last_sync_attempt_status: "ok" }),
  "最後成功同步：2026-10-06 09:00:00",
);
assert.equal(
  formatLastSync({ last_sync_success_at: "2026-10-06T09:00:00", last_sync_attempt_at: "2026-10-06T10:00:00", last_sync_attempt_status: "failed" }),
  "最後成功同步：2026-10-06 09:00:00（2026-10-06 10:00:00 的同步失敗）",
);
assert.equal(
  formatLastSync({ last_sync_attempt_at: "2026-10-06T10:00:00", last_sync_attempt_status: "incomplete" }),
  "尚未成功同步（2026-10-06 10:00:00 的同步未完成）",
);
// A running attempt is not reported as a failure.
assert.equal(
  formatLastSync({ last_sync_success_at: "2026-10-06T09:00:00", last_sync_attempt_at: "2026-10-06T10:00:00", last_sync_attempt_status: "running" }),
  "最後成功同步：2026-10-06 09:00:00",
);
console.log("renderer_account_last_sync_contract: ok");
