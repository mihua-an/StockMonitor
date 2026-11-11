"use strict";

function focusExistingWindow(windowRef) {
  if (!windowRef || (typeof windowRef.isDestroyed === "function" && windowRef.isDestroyed())) {
    return false;
  }
  if (typeof windowRef.isMinimized === "function" && windowRef.isMinimized()) {
    windowRef.restore();
  }
  if (typeof windowRef.isVisible === "function" && !windowRef.isVisible()) {
    windowRef.show();
  }
  if (typeof windowRef.focus === "function") {
    windowRef.focus();
  }
  return true;
}

function createAppSingleInstanceController({
  app,
  getMainWindow,
  reopenMainWindow = null,
  isShuttingDown = () => false,
  onLaunchDuringShutdown = null,
  logger = console,
}) {
  if (!app || typeof app.on !== "function") {
    throw new Error("Electron app event emitter is required");
  }
  if (typeof getMainWindow !== "function") {
    throw new Error("getMainWindow callback is required");
  }

  let registeredPrimary = false;
  let primaryLockReleased = false;
  let pendingSecondInstanceFocus = false;
  let duplicateLaunchCount = 0;

  function handleSecondInstance() {
    duplicateLaunchCount += 1;
    if (isShuttingDown()) {
      onLaunchDuringShutdown?.();
      logger.log?.("[APP SINGLETON] launch requested during shutdown; relaunch scheduled after durable teardown");
      return { focused: false, pending: false, relaunchScheduled: true };
    }
    const windowRef = getMainWindow();
    if (focusExistingWindow(windowRef)) {
      logger.log?.("[APP UI] launch request focused the existing window");
      return { focused: true, pending: false };
    }

    if (typeof reopenMainWindow === "function") {
      const reopened = reopenMainWindow();
      if (focusExistingWindow(reopened || getMainWindow())) {
        logger.log?.("[APP UI] launch request reopened the window during backend idle grace");
        return { focused: true, pending: false, reopened: true };
      }
    }

    // Primary still owns the Electron lock. Never create another BrowserWindow
    // as a response to the secondary process; the normal primary startup path
    // will create exactly one startup/main window and consume this flag.
    pendingSecondInstanceFocus = true;
    logger.log?.("[APP SINGLETON] duplicate launch while starting; no second window created");
    return { focused: false, pending: true };
  }

  function registerPrimary() {
    if (registeredPrimary) return false;
    registeredPrimary = true;
    primaryLockReleased = false;
    logger.log?.("[APP SINGLETON] primary instance acquired");
    app.on("second-instance", handleSecondInstance);
    return true;
  }

  function releasePrimary() {
    if (!registeredPrimary || primaryLockReleased) return false;
    primaryLockReleased = true;
    registeredPrimary = false;
    if (typeof app.removeListener === "function") {
      app.removeListener("second-instance", handleSecondInstance);
    }
    if (typeof app.releaseSingleInstanceLock === "function") {
      app.releaseSingleInstanceLock();
    }
    logger.log?.("[APP SINGLETON] UI instance lock released; backend handoff may continue");
    return true;
  }

  function rejectSecondary() {
    logger.log?.("[APP UI] reopen request forwarded; no duplicate window created");
  }

  function onMainWindowCreated(windowRef) {
    if (!pendingSecondInstanceFocus) return false;
    pendingSecondInstanceFocus = false;
    return focusExistingWindow(windowRef);
  }

  function status() {
    return {
      registered_primary: registeredPrimary,
      primary_lock_released: primaryLockReleased,
      pending_second_instance_focus: pendingSecondInstanceFocus,
      duplicate_launch_count: duplicateLaunchCount,
    };
  }

  return {
    registerPrimary,
    releasePrimary,
    rejectSecondary,
    handleSecondInstance,
    onMainWindowCreated,
    status,
  };
}

module.exports = {
  createAppSingleInstanceController,
  focusExistingWindow,
};
