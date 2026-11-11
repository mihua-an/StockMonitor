import { apiGet } from "../../core/api.js";

// The server's bound for one Google Sheet sync is `sync_deadline_s` of /api/actual-account/config (its GAS requests
// each sent once): a sync is waited for that long, not the 20 s every other request gets -- a slow Apps Script
// would end it on the page as a failure while the server was still running it (自動同步失敗).
/** The least the page waits, in seconds: never below the 20 s every other request gets. */
export const SYNC_DEADLINE_FLOOR_S = 20;
/** Added to the server's bound, in ms: the server's answer still has to travel back after its own deadline. */
export const SYNC_DEADLINE_GRACE_MS = 15000;

/** The page's wait for a sync whose server bound is `serverDeadlineS` seconds (missing/invalid: the floor). */
export function syncDeadlineMsFor(serverDeadlineS) {
  return Math.max(SYNC_DEADLINE_FLOOR_S, Number(serverDeadlineS) || 0) * 1000 + SYNC_DEADLINE_GRACE_MS;
}

export async function accountSyncDeadlineMs(config = null) {
  const known = config ?? await apiGet("/api/actual-account/config");
  return syncDeadlineMsFor(known?.sync_deadline_s);
}
