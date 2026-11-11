/**
 * History replay workspace layout controller.
 *
 * Layout persistence is intentionally isolated from replay data/state. The
 * page remains the single owner of replay selection and only passes the
 * shared layout store into this controller.
 */
import { beginSplitterDrag, gridTrackSizes } from "../../core/splitter_drag.js";

export const HISTORY_WORKSPACE_LAYOUT_KEY = "historyReplayWorkspaceLayout";

// The top half's height and its chart's width. The lower row is a pane workspace with a layout of its own
// (pane_defaults.js), which takes the widths last saved here as its first.
const LAYOUT_KEYS = Object.freeze([
  "--history-work-top-height",
  "--history-work-top-left",
]);

export function createHistoryWorkspaceLayoutController({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  layoutStore,
} = {}) {
  function restore(workspace) {
    if (!workspace || !layoutStore) return;
    const saved = layoutStore.read(HISTORY_WORKSPACE_LAYOUT_KEY, null);
    if (!saved || typeof saved !== "object") return;
    for (const [key, value] of Object.entries(saved)) {
      if (!LAYOUT_KEYS.includes(key)) continue;
      const text = String(value || "").trim();
      const match = text.match(/^([0-9]+(?:\.[0-9]+)?)(px|%)$/);
      if (!match || Number(match[1]) <= 0) continue;
      workspace.style.setProperty(key, text);
    }
  }

  function save(workspace) {
    if (!workspace || !layoutStore) return;
    const data = {};
    for (const key of LAYOUT_KEYS) {
      const value = workspace.style.getPropertyValue(key);
      if (value) data[key] = value;
    }
    layoutStore.write(HISTORY_WORKSPACE_LAYOUT_KEY, data);
  }

  // What bind() attached, so the page's teardown ends it -- including a drag in progress, whose document-level
  // pointer listeners would otherwise outlive the page.
  let controller = null;
  let endActiveDrag = null;
  let boundPage = null;

  function dispose() {
    endActiveDrag?.();
    controller?.abort();
    controller = null;
    if (boundPage) delete boundPage.dataset.workspaceSplitReady;
    boundPage = null;
  }

  function bind() {
    const page = documentRef?.querySelector?.(".history-replay-layout");
    const dashboard = page?.querySelector?.(".history-dashboard");
    const topWorkspace = page?.querySelector?.(".history-top-workspace");
    if (!page || !dashboard || !topWorkspace || page.dataset.workspaceSplitReady === "1") return false;
    page.dataset.workspaceSplitReady = "1";
    controller = new AbortController();
    boundPage = page;
    const { signal } = controller;
    restore(page);

    // Every splitter here is one shared drag (core/splitter_drag.js); a page teardown or a cancelled pointer in the
    // middle of one cancels it, and the layout's variables go back to what they were when it began.
    const drag = (splitter, event, axis, onMove, onDone) => {
      const before = LAYOUT_KEYS.map((key) => [key, page.style.getPropertyValue(key)]);
      endActiveDrag = beginSplitterDrag(event, splitter, {
        axis, documentRef, onMove,
        onEnd: ({ cancelled }) => {
          endActiveDrag = null;
          if (!cancelled) { onDone(); return; }
          for (const [key, value] of before) {
            if (value) page.style.setProperty(key, value);
            else page.style.removeProperty(key);
          }
          resize();
        },
      }).cancel;
    };
    const resize = () => windowRef?.dispatchEvent?.(new Event("resize"));

    // The tracks are read from the grids themselves (the variables size tracks, not the panels inside them).
    page.querySelector('[data-history-workspace-splitter="horizontal"]')?.addEventListener("pointerdown", (event) => {
      const [startTop = 0, , startBottom = 0] = gridTrackSizes(dashboard, "y");
      const topMin = 250, bottomMin = 230;
      const maxTop = Math.max(topMin, startTop + startBottom - bottomMin);
      let changed = false;
      drag(event.currentTarget, event, "y", (delta) => {
        const px = Math.round(Math.max(topMin, Math.min(maxTop, startTop + delta)));
        if (px === Math.round(startTop) && !changed) return;
        page.style.setProperty("--history-work-top-height", `${px}px`); changed = true; resize();
      }, () => { if (changed) { save(page); resize(); } });
    }, { signal });

    page.querySelector('[data-history-workspace-splitter="top"]')?.addEventListener("pointerdown", (event) => {
      const [startLeft = 0, , startRight = 0] = gridTrackSizes(topWorkspace, "x");
      const leftMin = 420, rightMin = 340;
      const maxLeft = Math.max(leftMin, startLeft + startRight - rightMin);
      let changed = false;
      drag(event.currentTarget, event, "x", (delta) => {
        const px = Math.round(Math.max(leftMin, Math.min(maxLeft, startLeft + delta)));
        if (px === Math.round(startLeft) && !changed) return;
        page.style.setProperty("--history-work-top-left", `${px}px`); changed = true; resize();
      }, () => { if (changed) { save(page); resize(); } });
    }, { signal });

    return true;
  }

  return { bind, dispose, restore, save, diagnostics: () => ({ key: HISTORY_WORKSPACE_LAYOUT_KEY }) };
}
