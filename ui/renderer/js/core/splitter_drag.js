// Splitter dragging, shared by every resizable layout (the pane workspaces: tree_workspace.js).
//
// beginSplitterDrag: one drag. The pointer is captured, the whole window shows the resize cursor and selects no text
// while it lasts (layout/workspace.css: body.workspace-resizing, body[data-resize-cursor]), and the move / end
// listeners exist only for the drag, and follow the pointer that began it only (another finger or pen moving or lifting
// does not touch it). onMove gets the pointer's distance from where the drag began; onEnd gets { cancelled }: true when
// the browser cancelled the pointer (pointercancel) or the page ended the drag itself (e.g. on teardown) -- the
// caller then puts back the sizes it had at the start and saves nothing.
//
// splitPair: the sizes of two neighbours after their common boundary moved, in whole px: the pair keeps its total
// (rounded to a whole px), each side at least `min`; a pair too small to give both sides `min` does not move. Sizes are measured from what the layout itself sizes, never from a
// child's border box: a child wider than what it was given (a border outside width: 100%) would add those px on every
// drag, and the panels would creep.

export function beginSplitterDrag(event, splitter, { axis = "x", onMove, onEnd, documentRef = globalThis.document } = {}) {
  event.preventDefault();
  event.stopPropagation();
  const coordinate = (pointer) => (axis === "x" ? pointer.clientX : pointer.clientY);
  const origin = coordinate(event);
  const body = documentRef?.body;
  splitter.setPointerCapture?.(event.pointerId);
  body?.classList.add("workspace-resizing");
  if (body) body.dataset.resizeCursor = axis === "x" ? "col-resize" : "row-resize";

  let ended = false;
  const pointerId = event.pointerId;
  const ours = (pointer) => pointerId === undefined || pointer.pointerId === pointerId;
  const move = (next) => {
    if (!ours(next)) return;
    next.preventDefault();
    onMove?.(coordinate(next) - origin);
  };
  const finish = (cancelled) => {
    if (ended) return;
    ended = true;
    documentRef.removeEventListener("pointermove", move, true);
    documentRef.removeEventListener("pointerup", release, true);
    documentRef.removeEventListener("pointercancel", cancel, true);
    try { splitter.releasePointerCapture?.(event.pointerId); } catch (_error) { /* not an error: the pointer is already released */ }
    body?.classList.remove("workspace-resizing");
    if (body) delete body.dataset.resizeCursor;
    onEnd?.({ cancelled });
  };
  const release = (pointer) => { if (ours(pointer)) finish(false); };
  const cancel = (pointer) => { if (ours(pointer)) finish(true); };
  documentRef.addEventListener("pointermove", move, true);
  documentRef.addEventListener("pointerup", release, true);
  documentRef.addEventListener("pointercancel", cancel, true);
  return { cancel: () => finish(true) };
}

export function splitPair(starts, index, delta, min) {
  const pair = Math.round(starts[index] + starts[index + 1]);
  const start = Math.min(pair, Math.round(starts[index]));
  if (pair < 2 * min) return [start, pair - start];
  const first = Math.round(Math.max(min, Math.min(pair - min, starts[index] + delta)));
  return [first, pair - first];
}
