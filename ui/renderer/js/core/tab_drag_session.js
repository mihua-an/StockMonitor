// The one tab being dragged on a page, for drops that land outside its own tab rail (another pane's rail, a pane's
// edge, the workspace's top/bottom edge). HTML5 drag data cannot be read during dragover, so the rails and the pane
// workspace share this instead. Listeners hear begin/end so the workspace can show and clear its drop targets.
let current = null;
const listeners = new Set();

function emit() {
  for (const listener of [...listeners]) {
    try { listener(current); } catch (error) { console.warn("[tab drag] listener failed", error); }
  }
}

export const tabDragSession = Object.freeze({
  begin({ pageId, paneId, componentId }) {
    current = Object.freeze({ pageId: String(pageId || ""), paneId: String(paneId || ""), componentId: String(componentId || "") });
    emit();
  },
  end() {
    if (!current) return;
    current = null;
    emit();
  },
  current() {
    return current;
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});
