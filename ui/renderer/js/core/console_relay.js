// The renderer's warnings and errors reach var/logs/<run>/error.log through Electron main's console-message relay,
// which receives Chromium's own text of the call, so an object or a DOMException argument was recorded as
// "[object Object]" / "[object DOMException]". Every window's entry module imports this first: from then on each
// argument of console.warn / console.error is turned into text (console_text.js) before Chromium formats it.
import { installConsoleRelayText } from "./console_text.js";

installConsoleRelayText();
