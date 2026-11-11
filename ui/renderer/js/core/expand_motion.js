// Opening and closing a block under a row (decisions.md「展開與收起的動畫」): Apple's fast-in slow-out curve, 0.38 s
// open and 0.26 s close, height and vertical padding 0 <-> their own, the content fading in and dropping a little;
// not played when the system asks for reduced motion.
//
// The state changes when the toggle is pressed; this only animates the picture. While a block is animating, its
// toggle is ignored (`start` answers false), so fast clicks cannot tangle it. The owner draws a block while it is open
// or still closing (`closing`), calls `play` after every draw, and is asked to draw again when a close has finished
// (`redraw`): a draw in the middle of a close finds the new element and shows it closed. A block drawn with
// morphInto carries its own data-morph-key, so it is a new element exactly when it appears.
//
// The rows under a block move with it, frame by frame, both ways:
// - A block's size is its own laid-out height (its content's, or a fixed one such as a row high). Content that arrives
//   after the block opened (a detail read when it is opened shows 正在讀取 first) grows the block from the height on
//   screen to its new one, whether it is written into the open block (seen by a ResizeObserver) or the owner draws a
//   new element (seen by `play`) -- while it is still opening too: the motion carries on from where it is to the new
//   height. An opening block's height is held by its animation and cannot be measured, so its target moves by as much
//   as its content's extent changed: a block of fixed height whose content keeps its size keeps its target.
// - A table row (資料中心's 日盤／夜盤 under 期貨指數) cannot change height itself: each of its cells' content is put in
//   a block for the motion (.expand-cell-motion), the cells' own height let go, and the row follows its cells.
//
// An opening block that would not fit in its scroll area brings itself into view while it grows (reveal_scroll.js):
// `reveal(key)` names the region to show -- usually the clicked row through the block -- and the band its scroll
// areas keep clear at the top.

import { SETTINGS_EASE, SETTINGS_EASE_POINTS, reducedMotion } from "./settings_ui.js";
import { revealRegion } from "./reveal_scroll.js";

const OPEN_MS = 380;
const CLOSE_MS = 260;
const MOTION_STYLES = ["height", "paddingTop", "paddingBottom", "opacity", "overflow"];
const CELL_WRAP = "expand-cell-motion";

const isRow = (node) => node?.tagName === "TR";

// Takes a motion's animation off an element once its time is up. The motion is timed (a hidden window's animations
// do not advance, so they cannot be waited for), and an animation starts on the next frame, later on a busy page: when
// the timer fires its last frames may still be running. It is finished, not cancelled -- it ends where it was going,
// as a motion that ran its course -- and then removed, with any end state it was holding (fill: forwards).
function endAnimation(animation) {
  const own = !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition);
  if (own && animation.playState === "running") animation.finish();
  animation.cancel();
}

// The curve's progress at time fraction `t` (SETTINGS_EASE): where a motion is on screen when its element was
// replaced by a new draw and can no longer be measured.
function easeAt(t) {
  const [x1, y1, x2, y2] = SETTINGS_EASE_POINTS;
  const bezier = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (bezier(x1, x2, mid) < t) lo = mid; else hi = mid;
  }
  return bezier(y1, y2, (lo + hi) / 2);
}

// A row's cells, each with its content in one motion block (made once, undone by unwrapCells). The content sits in a
// plain block inside it, laid out as it was in the cell (its text-align, a badge's own width); the motion block only
// centres that vertically.
function wrapCells(row) {
  return [...row.cells].map((cell) => {
    const first = cell.firstElementChild;
    if (first?.classList.contains(CELL_WRAP) && first === cell.lastChild) return first;
    const wrap = document.createElement("div");
    const inner = document.createElement("div");
    wrap.className = CELL_WRAP;
    inner.append(...cell.childNodes);
    wrap.append(inner);
    cell.append(wrap);
    return wrap;
  });
}

function unwrapCells(row) {
  for (const cell of row.cells) {
    const wrap = cell.firstElementChild;
    if (wrap?.classList.contains(CELL_WRAP)) {
      wrap.getAnimations().forEach(endAnimation);
      cell.append(...(wrap.firstElementChild?.childNodes || []));
      wrap.remove();
    }
    cell.style.height = "";
  }
}

// What a block's content takes now (its own vertical padding `pad` added): the extent of its children, measured
// whatever height the block itself is animated to.
function contentHeight(node, pad) {
  const kids = [...node.children];
  if (!kids.length) return pad;
  const first = kids[0].getBoundingClientRect(), last = kids[kids.length - 1].getBoundingClientRect();
  const margins = parseFloat(getComputedStyle(kids[0]).marginTop) + parseFloat(getComputedStyle(kids[kids.length - 1]).marginBottom);
  return Math.max(0, last.bottom - first.top) + margins + pad;
}

/**
 * @param {(key: string) => Element | null} find   the block for `key` as it is in the page now
 * @param {() => void} redraw                       draws the owner again (a closed block is left out or hidden)
 * @param {(key: string, node: Element) => ({ first: Element, last?: Element, insetTop?: (scroller: Element) => number } | null)} [reveal]
 *   the region an opening block brings into view (`last` defaults to the block)
 */
export function createExpandMotion({ find, redraw, reveal = null }) {
  const motions = new Map();   // key -> { open, started, node, from, to, content, at, duration, pad, timer }
  const shown = new Map();     // key -> { node, height, pad }: an open block at rest
  const watched = new Map();   // content element -> key
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    const keys = new Set(entries.map((entry) => watched.get(entry.target)).filter((key) => key != null));
    keys.forEach((key) => follow(key));
  }) : null;

  function watch(key, node) {
    if (!observer || !node) return;
    for (const child of node.children) {
      if (watched.has(child)) continue;
      watched.set(child, key);
      observer.observe(child);
    }
  }

  function unwatch(key) {
    if (!observer) return;
    for (const [child, owner] of watched) {
      if (owner !== key) continue;
      observer.unobserve(child);
      watched.delete(child);
    }
  }

  function shut(node) {
    if (isRow(node)) {
      wrapCells(node).forEach((wrap) => Object.assign(wrap.style, { height: "0px", opacity: "0" }));
      [...node.cells].forEach((cell) => { cell.style.height = "0px"; });
      return;
    }
    Object.assign(node.style, { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: "0", overflow: "hidden" });
  }

  function clean(node) {
    if (!node) return;
    if (isRow(node)) { unwrapCells(node); return; }
    // A block that stays in the page (shown and hidden) is measured afresh next time: its animations and the styles
    // they left are removed.
    [node, ...node.children].forEach((element) => element.getAnimations().forEach(endAnimation));
    MOTION_STYLES.forEach((name) => { node.style[name] = ""; });
  }

  function settle(key, motion) {
    motions.delete(key);
    const now = find(key);
    clean(now);
    if (!motion.open) {
      shown.delete(key);
      unwatch(key);
      redraw();
      return;
    }
    if (now && !isRow(now)) {
      // Content that changed size as the motion ended grows on from where the motion left it.
      const height = now.getBoundingClientRect().height;
      if (motion.duration && Math.abs(height - motion.to) >= 1 && !reducedMotion()) {
        grow(now, motion.to, height, OPEN_MS, motion.pad);
        setTimeout(() => { if (!motions.has(key)) clean(find(key)); }, OPEN_MS);
      }
      shown.set(key, { node: now, height, pad: motion.pad });
      watch(key, now);
    }
  }

  // Animates `node` (a block) from `from` to `to` px on screen (its vertical padding `pad` included) over `duration`:
  // the height only, its content already shown.
  function grow(node, from, to, duration, pad) {
    node.getAnimations().forEach((animation) => animation.cancel());
    node.style.overflow = "hidden";
    const inner = (px) => `${Math.max(0, px - pad)}px`;
    if (duration) node.animate([{ height: inner(from) }, { height: inner(to) }], { duration, easing: SETTINGS_EASE });
  }

  // `key`'s content changed size: an opening block carries on to its new height, an open one grows or shrinks to it.
  function follow(key) {
    const still = reducedMotion();
    const motion = motions.get(key);
    if (motion) {
      if (!motion.open || !motion.started || isRow(motion.node)) return;
      const node = motion.node;
      const content = contentHeight(node, motion.pad);
      const to = motion.to + content - motion.content;
      if (Math.abs(to - motion.to) < 1) return;
      // It still ends when it was going to: settle grows any size left over.
      const left = still ? 0 : motion.end - performance.now();
      if (left <= 0) return;
      const from = node.getBoundingClientRect().height;
      grow(node, from, to, left, motion.pad);
      Object.assign(motion, { from, to, content, at: performance.now(), duration: left });
      return;
    }
    const rest = shown.get(key);
    if (!rest) return;
    const node = find(key);
    if (!node || node.getAnimations().length) return;
    if (node !== rest.node) {
      // A new element for an open block: the old one's watch goes with it.
      unwatch(key);
      watch(key, node);
    }
    const to = node.getBoundingClientRect().height;
    if (Math.abs(to - rest.height) >= 1 && !still) {
      grow(node, rest.height, to, OPEN_MS, rest.pad);
      setTimeout(() => { if (!motions.has(key)) clean(find(key)); }, OPEN_MS);
    }
    shown.set(key, { node, height: to, pad: rest.pad });
  }

  function begin(key, motion, node) {
    const still = reducedMotion();
    motion.started = true;
    motion.node = node;
    const duration = still || !node ? 0 : motion.open ? OPEN_MS : CLOSE_MS;
    // Measured before the block is shut for its animation: the page is laid out with it at its full height.
    const region = motion.open && node && reveal ? reveal(key, node) : null;
    if (region?.first) revealRegion(region.first, region.last || node, { insetTop: region.insetTop, duration });
    const options = { duration, easing: SETTINGS_EASE, fill: motion.open ? "none" : "forwards" };
    if (node && duration && isRow(node)) {
      const full = node.getBoundingClientRect().height;
      const wraps = wrapCells(node);
      [...node.cells].forEach((cell) => { cell.style.height = "0px"; });
      const frames = [{ height: "0px", opacity: 0 }, { height: `${full}px`, opacity: 1 }];
      // Held at its end (both ways) until settle puts the cells back: the cells' own height is let go, so a block back
      // at its content's height for a frame would pull the row up before it is put back.
      wraps.forEach((wrap) => wrap.animate(motion.open ? frames : [...frames].reverse(), { ...options, fill: "forwards" }));
      Object.assign(motion, { from: motion.open ? 0 : full, to: motion.open ? full : 0, at: performance.now(), duration, pad: 0 });
    } else if (node && duration) {
      const style = getComputedStyle(node);
      const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const height = parseFloat(style.height) + pad;
      const closed = { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0 };
      const full = { height: style.height, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, opacity: 1 };
      const fall = [{ transform: "translateY(-6px)", opacity: 0 }, { transform: "none", opacity: 1 }];
      const content = contentHeight(node, pad);
      node.style.overflow = "hidden";
      node.animate(motion.open ? [closed, full] : [full, closed], options);
      [...node.children].forEach((child) => child.animate(motion.open ? fall : [...fall].reverse(), options));
      Object.assign(motion, { from: motion.open ? 0 : height, to: motion.open ? height : 0, content, at: performance.now(), duration, pad });
      if (motion.open) watch(key, node);
    } else {
      Object.assign(motion, { from: 0, to: 0, at: performance.now(), duration: 0, pad: 0 });
    }
    motion.end = performance.now() + duration;
    motion.timer = setTimeout(() => settle(key, motion), duration);
  }

  return {
    busy: (key) => motions.has(key),
    closing: (key) => motions.get(key)?.open === false,
    /** Start opening or closing `key`; false while it is still moving (the click is ignored). */
    start(key, open) {
      if (motions.has(key)) return false;
      if (!open) { shown.delete(key); unwatch(key); }
      motions.set(key, { open, started: false });
      return true;
    },
    play() {
      for (const [key, motion] of motions) {
        const node = find(key);
        if (!motion.started) { begin(key, motion, node); continue; }
        if (!node || node === motion.node) continue;
        // Redrawn while moving: a closing block's new element is drawn closed; an opening one carries on from where
        // it is on screen to its new element's height.
        if (!motion.open) {
          if (!node.getAnimations().length) shut(node);
          motion.node = node;
          continue;
        }
        motion.node = node;
        if (isRow(node)) continue;
        const elapsed = performance.now() - motion.at;
        const progress = motion.duration ? Math.min(1, elapsed / motion.duration) : 1;
        const from = motion.from + (motion.to - motion.from) * easeAt(progress);
        const to = node.getBoundingClientRect().height;
        const content = contentHeight(node, motion.pad);
        // It still ends when it was going to (a page drawn again and again while it reads must not hold it open).
        const left = reducedMotion() ? 0 : motion.end - performance.now();
        if (left > 0) grow(node, from, to, left, motion.pad);
        Object.assign(motion, { from, to, content, at: performance.now(), duration: Math.max(0, left) });
        watch(key, node);
      }
      // Open blocks at rest drawn again: a new size grows from the one on screen.
      for (const key of [...shown.keys()]) follow(key);
    },
  };
}
