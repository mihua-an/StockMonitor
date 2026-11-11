// Parked trend surfaces, keyed by the surface that was parked.
//
// Keyed, not ONE module-level fragment shared by every trend surface handed to whichever host asks
// first: then the 期貨走勢 slot could be
// handed the 個股走勢 slot's live DOM nodes -- carrying that surface's canvas id and its
// data-trend-view -- and, because the restore reported success, the adopting component skipped
// rebuilding its own shell: two canvases would share one canvas id and
// the 個股走勢 canvas would be labelled data-trend-view="futures" while drawing a stock.
//
// A surface now returns only to the identity it came from. Cross-slot adoption is refused, and the
// asking component rebuilds its own shell instead.
const parkedSurfaces = new Map();

function completeSurfaceCanvas(host) {
  // Identify the surface by its role, not by an id: every surface the shell builds carries the same
  // ids, which is precisely why an id cannot identify one.
  if (!host?.querySelector?.('[data-role="trend-canvas"]')
      || !host?.querySelector?.(".trend-titlebar")
      || !host?.querySelector?.(".trend-info-lines")
    ) return null;
  return host.querySelector('[data-role="trend-canvas"]');
}

/** The key a host's current surface is parked under: the identity the component stamped on its canvas. */
function trendSurfaceKey(host) {
  const canvas = completeSurfaceCanvas(host);
  return canvas ? String(canvas.dataset.trendSurface || "") : "";
}

/** Preserve only a complete Taiwan trend surface (title, canvas and info rows) that a component mounted. */
export function preserveTrendSurface(host) {
  const key = trendSurfaceKey(host);
  if (!key) return false;
  const fragment = document.createDocumentFragment();
  while (host.firstChild) fragment.appendChild(host.firstChild);
  parkedSurfaces.set(key, fragment);
  return true;
}

/**
 * Restore the exact live nodes so delayed data updates keep their bindings -- but only into the
 * identity they were parked from. `acceptKeys` is tried in order.
 */
export function restoreTrendSurface(host, ...acceptKeys) {
  if (!host) return false;
  for (const candidate of acceptKeys) {
    const key = String(candidate || "");
    const fragment = key ? parkedSurfaces.get(key) : null;
    if (!fragment?.childNodes?.length) continue;
    parkedSurfaces.delete(key);
    host.replaceChildren();
    host.appendChild(fragment);
    return true;
  }
  return false;
}

/**
 * Drop every surface parked by `slotId` (keys are `${slotId}:${variant}`): the slot is gone -- a pane closed in the
 * 即時報價 workspace -- so nothing can ask for them again, and their detached nodes and canvases are let go.
 */
export function discardTrendSurfaces(slotId) {
  const prefix = `${String(slotId || "")}:`;
  for (const key of [...parkedSurfaces.keys()]) if (key.startsWith(prefix)) parkedSurfaces.delete(key);
}

/** Test/diagnostic view of what is currently parked. */
export function parkedTrendSurfaceKeys() { return [...parkedSurfaces.keys()]; }
