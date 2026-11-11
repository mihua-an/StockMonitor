// A list that never shows a row cut in half: the list's height is its header plus a whole number of rows, and the
// height left over goes to `flex`, the part next to it that may grow (the 內外盤比 bars of 價量). The pool they share
// is the frame -- their common parent -- less its other children, so it follows the pane: a splitter that makes the
// pane shorter shrinks the list by whole rows instead of pushing its bottom out of sight (watching only the list
// and the flex part missed that: the list's height is fixed and the flex part was already at its minimum, so neither
// changed size). Measured again whenever something the split depends on changes: the frame's size, the frame's other
// children (a note that arrives under the list with a later answer) and the flex part's own rows (minFlex is their
// height: a bucket row that grew after the first measurement pushed the list's last row out of sight, 10-19) --
// each one's size, and which ones there are. The list and the flex part's box are not watched: the fit writes them,
// and the split it computes does not depend on them.
// CSS: the list takes `flex: 0 0 var(--whole-rows-height)` while it carries [data-whole-rows].

import { onElementResize } from "./element_size.js";

function contentHeight(frame) {
  const style = getComputedStyle(frame);
  return frame.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
}

// What the frame's other children (a toolbar, a column header, a note) take: the pool is what they leave.
function othersHeight(frame, flex, list) {
  let total = 0;
  for (const child of frame.children) {
    if (child === flex || child === list || child.hidden) continue;
    const style = getComputedStyle(child);
    if (style.position === "absolute" || style.position === "fixed" || style.display === "none") continue;
    total += child.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  }
  return total;
}

export function fitWholeRows({ flex, list, frame = flex?.parentElement, rowPitch, headerHeight = () => 0, minFlex = () => 0 }) {
  if (!flex || !list || !frame) return { refresh() {}, destroy() {} };
  let applied = -1;
  const refresh = () => {
    if (!frame.isConnected || !list.isConnected) return;
    const pitch = Math.max(1, Number(rowPitch()) || 0);
    const header = Math.max(0, Number(headerHeight()) || 0);
    const pool = contentHeight(frame) - othersHeight(frame, flex, list);
    const rows = Math.max(1, Math.floor((pool - Math.max(0, Number(minFlex()) || 0) - header + 0.01) / pitch));
    const height = Math.round(header + rows * pitch);
    if (height === applied) return;
    applied = height;
    list.style.setProperty("--whole-rows-height", `${height}px`);
    list.dataset.wholeRows = String(rows);
  };
  // A resize is answered in the next frame: writing the list's height inside the ResizeObserver callback would resize
  // an observed element's subtree in the same delivery ("ResizeObserver loop completed with undelivered notifications").
  let pending = 0;
  const schedule = () => {
    if (pending || typeof requestAnimationFrame !== "function") { if (!pending) refresh(); return; }
    pending = requestAnimationFrame(() => { pending = 0; refresh(); });
  };
  const off = onElementResize(frame, schedule);
  // The frame's other children and the flex part's rows: each one's size is watched, and the set is taken again when
  // children come and go.
  let watched = new Map();
  const watchOthers = () => {
    const next = new Map();
    for (const child of [...frame.children, ...flex.children]) {
      if (child === flex || child === list) continue;
      next.set(child, watched.get(child) || onElementResize(child, schedule));
    }
    for (const [child, stop] of watched) {
      if (!next.has(child)) stop();
    }
    watched = next;
  };
  watchOthers();
  const children = typeof MutationObserver === "function"
    ? new MutationObserver(() => { watchOthers(); schedule(); })
    : null;
  children?.observe(frame, { childList: true });
  children?.observe(flex, { childList: true });
  refresh();
  return {
    refresh,
    destroy() {
      if (pending) cancelAnimationFrame(pending);
      pending = 0;
      off();
      children?.disconnect();
      for (const stop of watched.values()) stop();
      watched = new Map();
      list.style.removeProperty("--whole-rows-height");
      delete list.dataset.wholeRows;
    },
  };
}
