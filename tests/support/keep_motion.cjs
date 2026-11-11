"use strict";
// For a UI test whose subject is a motion. A machine with Windows' animation effects off (Windows Server, so CI) reports
// prefers-reduced-motion, the page then skips the motion, and the test would check nothing the user sees.
function keepMotion(app) {
  app.commandLine.appendSwitch("force-prefers-no-reduced-motion");
}

module.exports = { keepMotion };
