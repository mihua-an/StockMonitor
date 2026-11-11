"use strict";

// The one terminal path of a desktop startup that cannot finish. Health may already be running (it outlives the UI by
// design), but this process holds the singleton lock and may have no window: without an end, the next launch only
// focuses a primary that shows nothing. The failure is written to the error log (the early sink tees console.error),
// shown once, the singleton lock is released and the process exits with a failure code. app.exit, not app.quit: quit
// would run the graceful full shutdown of an application that never finished starting.
//
// The same handler takes an unhandled rejection while the startup runs; after the startup has handed over to the
// application, an unhandled rejection is recorded in the error log and the application keeps running.

function createFatalStartup({ app, dialog, logger = console, processRef = process }) {
  let startupDone = false;
  let failed = false;

  function fail(stage, error) {
    logger.error(`[STARTUP] ${stage} failed; the desktop process ends`, error);
    if (failed) return;
    failed = true;
    try {
      dialog.showErrorBox("StockMonitor 無法啟動", `${stage}：${String(error?.message || error)}`);
    } catch (dialogError) {
      logger.error("[STARTUP] the startup error dialog could not be shown", dialogError);
    }
    try { app.releaseSingleInstanceLock(); } catch (lockError) { logger.error("[STARTUP] releasing the singleton lock failed", lockError); }
    app.exit(1);
  }

  processRef.on("unhandledRejection", (reason) => {
    if (!startupDone) { fail("啟動中未處理的錯誤", reason); return; }
    logger.error("[MAIN] unhandled promise rejection", reason);
  });

  return {
    fail,
    /**
     * Runs the startup; any rejection or synchronous throw ends the process through fail(), named by the stage the
     * task last entered (task receives enter(stage)).
     */
    async run(task) {
      let stage = "啟動";
      try {
        await task((name) => { stage = name; });
        startupDone = true;
      } catch (error) {
        fail(stage, error);
      }
    },
  };
}

module.exports = { createFatalStartup };
