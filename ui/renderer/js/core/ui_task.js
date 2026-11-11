// The one end of a promise an event handler or a fire-and-forget call starts: a listener stays synchronous and hands
// its work here, so every failure is logged (with what the task was) and, when the task has a place to say so,
// shown as a recoverable message -- never an unhandled rejection. `isCurrent` (optional) fences out a task the page
// has moved past (another date, a page left): its failure is still logged, but not shown.
import { userFacingMessage } from "./user_action.js";

export function runUiTask(context, task, { fallback = "操作失敗，請稍後再試", show = null, isCurrent = null } = {}) {
  let promise;
  try {
    promise = Promise.resolve(typeof task === "function" ? task() : task);
  } catch (error) {
    promise = Promise.reject(error);
  }
  return promise.catch((error) => {
    const text = userFacingMessage(error, fallback, { context });
    if (show && (!isCurrent || isCurrent())) {
      try { show(text, error); } catch (showError) { console.error(`[${context}: showing the failure] failed`, showError); }
    }
    return undefined;
  });
}
