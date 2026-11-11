"use strict";

// The one clamp for Electron main (window geometry and timeouts). When the bounds cross -- a window wider
// than the work area -- the upper bound wins, so the window stays anchored inside the screen's far edge.
function clamp(value, minValue, maxValue) {
  return Math.min(maxValue, Math.max(minValue, value));
}

module.exports = { clamp };
