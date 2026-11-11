// Bringing a block that just opened into view (user 11-01): the scroll areas around it move only when the block does
// not fit in what they show, and only as far as it needs to fit -- never "the clicked row to the top". A block taller
// than the view puts its first row at the top. The inner scroll area moves first, then the ones around it.
//
// `duration` steps the scroll on the expand motion's own curve and time, so it moves together with the block that is
// growing: the area's scroll range grows on the same curve, so every step is within it. Without a duration the
// browser scrolls smoothly; with reduced motion it jumps.

import { SETTINGS_EASE_POINTS, reducedMotion } from "./settings_ui.js";

function scrollsVertically(element) {
  const overflowY = getComputedStyle(element).overflowY;
  return (overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1;
}

// The cubic-bezier timing function: progress for time fraction t (Newton's method on x, then y).
function easeAt(t, [x1, y1, x2, y2] = SETTINGS_EASE_POINTS) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const coord = (s, a, b) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const slope = (s, a, b) => 3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  let s = t;
  for (let i = 0; i < 8; i += 1) {
    const d = slope(s, x1, x2);
    if (Math.abs(d) < 1e-6) break;
    s -= (coord(s, x1, x2) - t) / d;
    s = Math.min(1, Math.max(0, s));
  }
  return coord(s, y1, y2);
}

/**
 * How far each scroll area around `first`..`last` moves so the region fits: [{ scroller, from, to }], inner first.
 * Measured on the page as it is now, so call it with the opened block at its full height.
 * `insetTop(scroller)` is the band at the top of a scroll area that its content passes under (a sticky header).
 */
export function revealPlan(first, last, { insetTop = () => 0 } = {}) {
  if (!first?.isConnected || !last?.isConnected) return [];
  let top = first.getBoundingClientRect().top;
  let bottom = last.getBoundingClientRect().bottom;
  const plan = [];
  for (let scroller = last.parentElement; scroller && scroller !== document.documentElement; scroller = scroller.parentElement) {
    if (!scrollsVertically(scroller)) continue;
    const box = scroller.getBoundingClientRect();
    const viewTop = box.top + scroller.clientTop + Math.max(0, Number(insetTop(scroller)) || 0);
    const viewBottom = box.top + scroller.clientTop + scroller.clientHeight;
    let delta = 0;
    if (bottom > viewBottom) delta = Math.min(bottom - viewBottom, top - viewTop);
    else if (top < viewTop) delta = top - viewTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const from = scroller.scrollTop;
    const to = Math.min(max, Math.max(0, from + delta));
    if (Math.round(to) !== Math.round(from)) plan.push({ scroller, from, to });
    // What this area shows of the region is what the areas around it have to show.
    top = Math.max(top - (to - from), viewTop);
    bottom = Math.min(bottom - (to - from), viewBottom);
    if (bottom <= top) break;
  }
  return plan;
}

/** Scroll `first`..`last` into view (see the file comment); `duration` in ms, 0 for the browser's smooth scroll. */
export function revealRegion(first, last, { insetTop, duration = 0 } = {}) {
  const plan = revealPlan(first, last, { insetTop });
  if (!plan.length) return;
  // Every step is written "instant": a scroll area styled `scroll-behavior: smooth` would otherwise start a smooth
  // scroll of its own on each step.
  if (reducedMotion()) {
    plan.forEach(({ scroller, to }) => scroller.scrollTo({ top: to, behavior: "instant" }));
    return;
  }
  if (!duration) {
    plan.forEach(({ scroller, to }) => scroller.scrollTo({ top: to, behavior: "smooth" }));
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const progress = easeAt((now - start) / duration);
    plan.forEach(({ scroller, from, to }) => scroller.scrollTo({ top: from + (to - from) * progress, behavior: "instant" }));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
