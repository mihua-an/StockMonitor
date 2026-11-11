// The new-row wash shared by 成交明細, 即時資訊 and the workspace trades: a new row's cells show the wash colour, held
// and then faded out over ROW_WASH_MS. One clock steps every washing row of every list, instead of a CSS animation
// per row: while any CSS animation runs, Chromium restyles and repaints every frame, and at a burst new rows keep
// arriving so that never stops. Stepping all rows together repaints only at the clock's steps (STEP_MS apart).
export const ROW_WASH_MS = 850;
const HOLD_MS = Math.round(ROW_WASH_MS * 0.32);
const STEP_MS = 100;
export const ROW_WASH_CLASS = "row-wash";

// element -> { startedAt, onEnd }; an element that has left the document ends its wash at the next step.
const washing = new Map();
let timer = 0;

// ease-out (cubic-bezier(0, 0, 0.58, 1)) from the hold to the end.
function easeOut(x) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i += 1) {
    const s = (lo + hi) / 2;
    const bx = 3 * (1 - s) * s * s * 0.58 + s * s * s;
    if (bx < x) lo = s; else hi = s;
  }
  const s = (lo + hi) / 2;
  return 3 * (1 - s) * s * s + s * s * s;
}

// The wash's strength (1 = the full colour, 0 = gone) `elapsed` ms after the row arrived.
export function rowWashLevel(elapsed) {
  if (elapsed < HOLD_MS) return 1;
  if (elapsed >= ROW_WASH_MS) return 0;
  return 1 - easeOut((elapsed - HOLD_MS) / (ROW_WASH_MS - HOLD_MS));
}

function reducedMotion() {
  return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function end(element, entry) {
  washing.delete(element);
  element.classList.remove(ROW_WASH_CLASS);
  element.style.removeProperty("--row-wash");
  entry.onEnd?.();
}

function paint(element, entry, now) {
  const level = rowWashLevel(now - entry.startedAt);
  if (level <= 0) { end(element, entry); return; }
  const value = level.toFixed(2);
  if (element.style.getPropertyValue("--row-wash") !== value) element.style.setProperty("--row-wash", value);
}

function step() {
  timer = 0;
  const now = performance.now();
  for (const [element, entry] of washing) {
    if (!element.isConnected) end(element, entry);
    else paint(element, entry, now);
  }
  schedule(now);
}

// The next step falls on the shared STEP_MS grid, so rows that arrived at different times change in the same frame.
function schedule(now) {
  if (timer || !washing.size) return;
  timer = setTimeout(step, STEP_MS - (now % STEP_MS) + 1);
}

// Washes `element` as a row that arrived at `startedAt` (performance.now() time); a row seen earlier, drawn again,
// continues its wash where it is. `onEnd` runs when the wash ends on its own or the row has left the document.
export function washRow(element, startedAt = performance.now(), onEnd = null) {
  const now = performance.now();
  if (reducedMotion() || now - startedAt >= ROW_WASH_MS) return false;
  const entry = { startedAt, onEnd };
  washing.set(element, entry);
  element.classList.add(ROW_WASH_CLASS);
  paint(element, entry, now);
  schedule(now);
  return true;
}

export function unwashRow(element) {
  if (!washing.delete(element)) return;
  element.classList.remove(ROW_WASH_CLASS);
  element.style.removeProperty("--row-wash");
}

export function isRowWashing(element) { return washing.has(element); }

// The class and style a row drawn from markup carries while it washes, so re-rendering its markup keeps the wash.
export function rowWashMarkup(element) {
  const entry = element && washing.get(element);
  if (!entry) return { className: "", style: "" };
  return { className: ` ${ROW_WASH_CLASS}`, style: ` style="--row-wash:${rowWashLevel(performance.now() - entry.startedAt).toFixed(2)}"` };
}
