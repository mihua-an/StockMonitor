// One listener's failure is recorded with its owner and event, and never stops the others or the publisher: every
// store that hands its state to screen listeners calls them through here.
export function notifyEach(listeners, label, ...args) {
  for (const listener of [...listeners]) callListener(listener, label, ...args);
}

/** Call one listener (a subscriber's first value); a throw is recorded and swallowed for the publisher's sake. */
export function callListener(listener, label, ...args) {
  try { listener(...args); } catch (error) { console.error(`[${label}] listener failed`, error); }
}
