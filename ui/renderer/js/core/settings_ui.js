// The settings-style controls' behaviour (styles/components/settings.css): the floating message, the note left of an
// action bar, the status dot, and the small markup builders the pages share. 設定 and the windows built the same way
// use these, so a message or a status looks and behaves the same everywhere.
//
// Messages (user 11-01): an error stays left of its group's buttons until the next action there; a success floats
// at the top for about 2.5 s (5 s when it offers 復原) and takes no room; successes at the same time stack.

import { escapeHtml } from "./utility.js";

/** Apple's fast-in slow-out curve's control points (x1, y1, x2, y2), for code that steps the curve itself. */
export const SETTINGS_EASE_POINTS = [0.32, 0.72, 0, 1];
export const SETTINGS_EASE = `cubic-bezier(${SETTINGS_EASE_POINTS.join(", ")})`;
const TOAST_MS = 2500;
const TOAST_UNDO_MS = 5000;

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- floating messages: each success is a capsule of its own in the window's #settingsToast stack and goes by itself
// after its own time, so actions that finish together all show theirs -- a later message never replaces an earlier one.
// The stack is hidden while it holds none.
function toastStack() {
  return document.getElementById("settingsToast");
}

function removeToast(stack, toast) {
  toast.remove();
  if (!stack.children.length) stack.hidden = true;
}

function hideToast(stack, toast) {
  if (!toast.isConnected || toast.dataset.leaving) return;
  toast.dataset.leaving = "true";
  clearTimeout(Number(toast.dataset.timer));
  if (reducedMotion()) { removeToast(stack, toast); return; }
  toast.animate([{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-12px)" }],
    { duration: 220, easing: SETTINGS_EASE }).finished.then(
    () => removeToast(stack, toast),
    () => removeToast(stack, toast), // not an error: the leave motion is cancelled when the window drops the message first
  );
}

/** Float `text` at the top of the window, under any message still showing; `undo` (a function) adds 復原 and keeps it
 * 5 s. */
export function showToast(text, { undo = null } = {}) {
  const stack = toastStack();
  if (!stack) {
    console.warn("[settings: a floating message] failed", `no #settingsToast in this window for: ${text}`);
    return;
  }
  const toast = document.createElement("div");
  toast.className = "settings-toast";
  const words = document.createElement("span");
  words.className = "settings-toast-text";
  words.textContent = text;
  toast.append(words);
  if (undo) {
    const button = document.createElement("button");
    button.className = "settings-link";
    button.type = "button";
    button.textContent = "復原";
    button.addEventListener("click", () => { hideToast(stack, toast); undo(); });
    toast.append(button);
  }
  stack.append(toast);
  stack.hidden = false;
  if (!reducedMotion()) {
    toast.animate([{ opacity: 0, transform: "translateY(-12px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: 320, easing: SETTINGS_EASE });
  }
  toast.dataset.timer = String(setTimeout(() => hideToast(stack, toast), undo ? TOAST_UNDO_MS : TOAST_MS));
}

// ---- the note left of an action bar: an error (red) stays until the group's next action clears it; a running
// action's progress is the plain kind.
export function setNote(node, text, isError = false) {
  if (!node) return;
  node.textContent = text || "";
  node.className = `settings-actions-note${isError && text ? " is-error" : ""}`;
}

// ---- status: a dot and a word. kind: "ok" | "warn" | "error" | "" (neutral).
export function setStatus(node, text, kind = "") {
  if (!node) return;
  node.textContent = text;
  node.className = `settings-status${kind ? ` is-${kind}` : ""}`;
}

/** A status in a fixed column: its words are cut with … when they do not fit. */
export function fittedStatusHtml(text, kind = "") {
  return `<span class="settings-status is-fitted${kind ? ` is-${kind}` : ""}"><span class="settings-status-text">${escapeHtml(text)}</span></span>`;
}

/** A segmented choice (.settings-seg): its sliding background goes under the button marked .is-active. Called after
 *  the choice changes and when the choice is shown (a hidden one has no size to measure). */
export function syncSegmented(seg) {
  if (!seg) return;
  let thumb = seg.querySelector(":scope > .settings-seg-thumb");
  if (!thumb) {
    thumb = document.createElement("span");
    thumb.className = "settings-seg-thumb";
    thumb.setAttribute("aria-hidden", "true");
    thumb.setAttribute("data-morph-keep", "");
    seg.prepend(thumb);
  }
  const active = seg.querySelector(":scope > .settings-seg-btn.is-active:not([hidden])");
  thumb.hidden = !active;
  if (!active) return;
  thumb.style.setProperty("--settings-seg-left", `${active.offsetLeft}px`);
  thumb.style.setProperty("--settings-seg-width", `${active.offsetWidth}px`);
}

/** A long path keeps its start and its end: "D:\\StockMonitor\\…\\history". */
export function middleEllipsis(text, max = 44) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, 18)}…${value.slice(-(max - 19))}`;
}
