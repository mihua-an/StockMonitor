"use strict";

// Drives the storage location's background work (config/js/storage_settings.js advanceBackgroundMove) for as long as this
// Health runs: each step reads the journal and the saved folder, so a folder saved in 設定 → 資料儲存 begins copying
// within one poll, without a restart. Steps never overlap. A revision that failed is not begun again by this Health;
// the next start, or saving a folder again, tries anew.

const POLL_MS = 15_000;

function startStorageBackgroundMove({ advance, pollMs = POLL_MS, logger = console }) {
  let stopped = false, timer = null, failedRevision = null, running = null;
  async function step() {
    try {
      const result = await advance({ shouldStop: () => stopped, failedRevision });
      if (result?.status === "failed") failedRevision = result.revision;
    } catch (error) { logger.error?.(`[HEALTH] storage location background step failed: ${error?.message || error}`); }
    if (stopped) return;
    timer = setTimeout(() => { running = step(); }, pollMs);
  }
  running = step();
  return {
    /** Ends the loop; a copy in progress stops at its next file and resumes at the next Health's first step. */
    stop() { stopped = true; if (timer) clearTimeout(timer); return running; },
  };
}

module.exports = { startStorageBackgroundMove, POLL_MS };
