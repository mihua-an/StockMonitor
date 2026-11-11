// Log arguments as text for the error log (console_relay.js installs it in every window). Electron main's
// console-message relay (ui/main/renderer_health.js) receives Chromium's own text of a console call: a plain object
// arrives as "[object Object]", a DOMException (a request deadline, an abort) as "[object DOMException]".

const MAX_TEXT = 2000;
// An error keeps the first frames of its stack (where it was thrown, not only where it was logged) and a short cause
// chain; both are capped so one error stays well inside a record.
const STACK_FRAMES = 6;
const STACK_TEXT = 900;
const CAUSE_DEPTH = 3;

// What an error is, as text: its name and message ("TimeoutError: signal timed out").
export function describeError(error) {
  if (error == null) return String(error);
  const name = String(error?.name || "").trim();
  const message = String(error?.message ?? error).trim();
  return name && !message.startsWith(name) ? `${name}: ${message}` : message;
}

function isErrorLike(value) {
  return value instanceof Error || (typeof DOMException !== "undefined" && value instanceof DOMException);
}

// The frames of an error's stack, without the "Name: message" header V8 puts first, capped.
function stackFrames(error) {
  const lines = String(error?.stack || "").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("at "));
  const text = lines.slice(0, STACK_FRAMES).join(" < ");
  return text.length > STACK_TEXT ? `${text.slice(0, STACK_TEXT)}…` : text;
}

// An error as the fields the error log keeps: name, message, code, the first frames of the stack and its cause.
export function errorFields(error, depth = 0) {
  const fields = { name: String(error?.name || "Error"), message: String(error?.message ?? "") };
  // A DOMException's numeric code is the legacy number of its name, which says nothing more.
  const isDomException = typeof DOMException !== "undefined" && error instanceof DOMException;
  if (!isDomException && error?.code !== undefined && error?.code !== null) fields.code = String(error.code);
  const stack = stackFrames(error);
  if (stack) fields.stack = stack;
  const cause = error?.cause;
  if (cause !== undefined) {
    fields.cause = isErrorLike(cause) ? (depth + 1 < CAUSE_DEPTH ? errorFields(cause, depth + 1) : describeError(cause))
      : typeof cause === "object" && cause !== null ? "[object cause]" : String(cause);
  }
  return fields;
}

// An error as one line of text: "Name: message (code X) at <frames> caused by: <cause>".
function errorText(error) {
  const fields = errorFields(error);
  const line = (item) => {
    if (typeof item !== "object") return item;
    const head = describeError(item);
    return `${head}${item.code ? ` (code ${item.code})` : ""}${item.stack ? ` ${item.stack}` : ""}${item.cause !== undefined ? ` caused by: ${line(item.cause)}` : ""}`;
  };
  return line(fields);
}

// One logged argument as the text the error log keeps. Strings, numbers and the like are left to Chromium (it prints
// them as they are); errors become their name, message, code, the first frames of their stack and their cause;
// objects and arrays become JSON, errors inside them as those fields. Secrets are masked by the log's owner
// (Electron main), which sees every record.
export function consoleArgumentText(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object" && typeof value !== "function") return value;
  if (isErrorLike(value)) return capped(errorText(value));
  const seen = new WeakSet();
  let text;
  try {
    text = JSON.stringify(value, (_key, item) => {
      if (isErrorLike(item)) return errorFields(item);
      if (typeof item === "bigint") return String(item);
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
  } catch (error) {
    // not an error: this text is what gets logged -- the argument is recorded by its constructor and why it could not
    // be serialised (a getter that throws, say).
    text = `[${value?.constructor?.name || "object"}: not serialisable (${describeError(error)})]`;
  }
  if (text === undefined) return String(value);
  return capped(text);
}

function capped(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…(${text.length} chars)` : text;
}

// Where a stack frame points, as a path inside the renderer ("js/market_data/trade_detail/perf_trace.js:19"): the
// windows load from a copied snapshot (renderer-assets/<hash>/) or from ui/renderer/, and the rest of the URL says nothing.
export function rendererFrameLocation(frame) {
  const match = String(frame || "").match(/((?:file|https?):\/\/[^\s()]+?):(\d+):\d+\)?\s*$/);
  if (!match) return "";
  const path = match[1].replace(/^.*?\/renderer-assets\/[^/]+\//, "").replace(/^.*?\/ui\/renderer\//, "");
  return `${path}:${match[2]}`;
}

export function installConsoleRelayText(target = globalThis.console) {
  if (!target || target.__consoleRelayText) return;
  for (const level of ["warn", "error"]) {
    const original = target[level];
    if (typeof original !== "function") continue;
    // Electron main records the place of the console call, which is now this function: the code that logged is the
    // frame below it, and its place goes at the end of the record.
    target[level] = function relayText(...args) {
      const caller = rendererFrameLocation(String(new Error().stack || "").split("\n")[2]);
      const text = args.map(consoleArgumentText);
      return original.apply(this, caller ? [...text, `@ ${caller}`] : text);
    };
  }
  Object.defineProperty(target, "__consoleRelayText", { value: true });
}

