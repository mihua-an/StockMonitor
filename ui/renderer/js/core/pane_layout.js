// The 即時報價 workspace as rows of panes, each pane a strip of tabs (user design):
//   - a tab dragged onto another pane's tab strip joins that pane;
//   - a tab dragged onto a pane's left/right edge opens a new pane on that side, taking half of the target's width;
//   - a tab dragged onto the workspace's top/bottom edge opens a new row, up to the user's row limit (設定, default 2);
//   - a pane whose last tab is closed or dragged away disappears and its neighbour takes its width -- except the last
//     pane of a row: every row keeps at least one pane (it then offers the add-feature page). A row beyond the
//     default two disappears when its last pane is emptied.
// Pure functions over a plain object; the workspace (pane_workspace.js) renders it and persists it.
//
//   layout = { version, rows: [{ id, size, extra, panes: [{ id, size, componentIds: [...], activeComponentId }] }] }
//   size: the row's share of the height / the pane's share of its row's width (each list sums to 1).
//   extra: a row a tab opened (addRow), at the top or the bottom; it goes when emptied. The default rows stay.

// 2: every row carries `extra`. A layout of an earlier version cannot say which rows were added, and is
// rebuilt from the defaults rather than guessed from row positions (no migration of old stored data).
export const PANE_LAYOUT_VERSION = 2;

/** A stored layout this version can read as it is: the current version, every row saying whether it was added. */
export function storedLayoutUsable(stored) {
  return Boolean(stored) && stored.version === PANE_LAYOUT_VERSION && Array.isArray(stored.rows)
    && stored.rows.every((row) => typeof row?.extra === "boolean");
}
export const DEFAULT_ROW_COUNT = 2;

const EPSILON = 1e-6;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

let paneSequence = 0;
export function newPaneId(now = Date.now()) {
  paneSequence = (paneSequence + 1) % 1e6;
  return `pane-${now.toString(36)}-${paneSequence.toString(36)}`;
}

function newRowId(now = Date.now()) {
  paneSequence = (paneSequence + 1) % 1e6;
  return `row-${now.toString(36)}-${paneSequence.toString(36)}`;
}

function normalizeSizes(items) {
  const positive = items.map((item) => (Number.isFinite(Number(item.size)) && Number(item.size) > 0 ? Number(item.size) : 0));
  const total = positive.reduce((sum, value) => sum + value, 0);
  items.forEach((item, index) => {
    item.size = total > EPSILON ? positive[index] / total : 1 / items.length;
  });
}

/** Repair anything a stored layout or an edit left inconsistent: every component once, sizes that sum to 1,
 *  an active tab that is one of the pane's tabs, at least one row and one pane per row. */
export function normalizeLayout(raw, { isKnown = () => true } = {}) {
  const layout = { version: PANE_LAYOUT_VERSION, rows: [] };
  const seen = new Set();
  for (const rawRow of Array.isArray(raw?.rows) ? raw.rows : []) {
    // A row says whether a tab added it; one that does not (a default layout) is a default row.
    const extra = rawRow?.extra === true;
    const row = { id: String(rawRow?.id || newRowId()), size: Number(rawRow?.size) || 0, extra, panes: [] };
    for (const rawPane of Array.isArray(rawRow?.panes) ? rawRow.panes : []) {
      const componentIds = [];
      for (const id of Array.isArray(rawPane?.componentIds) ? rawPane.componentIds : []) {
        const key = String(id || "");
        if (!key || seen.has(key) || !isKnown(key)) continue;
        seen.add(key);
        componentIds.push(key);
      }
      const active = componentIds.includes(String(rawPane?.activeComponentId || "")) ? String(rawPane.activeComponentId) : componentIds[0] || "";
      row.panes.push({ id: String(rawPane?.id || newPaneId()), size: Number(rawPane?.size) || 0, componentIds, activeComponentId: active });
    }
    if (!row.panes.length) row.panes.push({ id: newPaneId(), size: 1, componentIds: [], activeComponentId: "" });
    normalizeSizes(row.panes);
    layout.rows.push(row);
  }
  if (!layout.rows.length) layout.rows.push({ id: newRowId(), size: 1, extra: false, panes: [{ id: newPaneId(), size: 1, componentIds: [], activeComponentId: "" }] });
  normalizeSizes(layout.rows);
  return layout;
}

export function findPane(layout, paneId) {
  for (const [rowIndex, row] of layout.rows.entries()) {
    const paneIndex = row.panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex >= 0) return { row, rowIndex, pane: row.panes[paneIndex], paneIndex };
  }
  return null;
}

export function paneOfComponent(layout, componentId) {
  for (const row of layout.rows) {
    for (const pane of row.panes) if (pane.componentIds.includes(componentId)) return pane;
  }
  return null;
}

function detach(layout, componentId) {
  const pane = paneOfComponent(layout, componentId);
  if (!pane) return null;
  const index = pane.componentIds.indexOf(componentId);
  pane.componentIds.splice(index, 1);
  if (pane.activeComponentId === componentId) pane.activeComponentId = pane.componentIds[Math.min(index, pane.componentIds.length - 1)] || "";
  return pane;
}

/** Remove emptied panes (their width to the neighbour on the left, else the right) -- never a row's last pane --
 *  and emptied rows a tab added (`extra`, wherever they sit: one added at the top is row 0), their height to the row
 *  above, else below. `keepRows` is accepted for callers' options; which rows go is the rows' own identity. */
export function prune(layout, { keepRows: _keepRows = DEFAULT_ROW_COUNT } = {}) {
  for (const row of layout.rows) {
    for (let index = row.panes.length - 1; index >= 0 && row.panes.length > 1; index -= 1) {
      const pane = row.panes[index];
      if (pane.componentIds.length) continue;
      const heir = row.panes[index - 1] || row.panes[index + 1];
      heir.size += pane.size;
      row.panes.splice(index, 1);
    }
  }
  for (let index = layout.rows.length - 1; index >= 0 && layout.rows.length > 1; index -= 1) {
    const row = layout.rows[index];
    if (!row.extra || row.panes.length !== 1 || row.panes[0].componentIds.length) continue;
    const heir = layout.rows[index - 1] || layout.rows[index + 1];
    heir.size += row.size;
    layout.rows.splice(index, 1);
  }
  return layout;
}

/** A tab joins pane `paneId` at `index` (end when omitted) and becomes its active tab. */
export function moveTab(input, componentId, paneId, index = null, options = {}) {
  const layout = clone(input);
  const target = findPane(layout, paneId);
  if (!target) return input;
  const source = paneOfComponent(layout, componentId);
  if (source === target.pane) {
    const from = source.componentIds.indexOf(componentId);
    source.componentIds.splice(from, 1);
    const at = index == null ? source.componentIds.length : Math.max(0, Math.min(source.componentIds.length, index > from ? index - 1 : index));
    source.componentIds.splice(at, 0, componentId);
    source.activeComponentId = componentId;
    return layout;
  }
  detach(layout, componentId);
  const at = index == null ? target.pane.componentIds.length : Math.max(0, Math.min(target.pane.componentIds.length, index));
  target.pane.componentIds.splice(at, 0, componentId);
  target.pane.activeComponentId = componentId;
  return prune(layout, options);
}

/** A tab opens a new pane beside `paneId` (`side` "left" | "right"), taking half of that pane's width. */
export function splitPane(input, componentId, paneId, side, options = {}) {
  const layout = clone(input);
  const target = findPane(layout, paneId);
  if (!target) return input;
  const source = paneOfComponent(layout, componentId);
  if (source === target.pane && source.componentIds.length === 1) return input;   // a pane cannot split off its only tab
  detach(layout, componentId);
  const half = target.pane.size / 2;
  target.pane.size = half;
  const pane = { id: options.paneId || newPaneId(), size: half, componentIds: [componentId], activeComponentId: componentId };
  const at = target.row.panes.indexOf(target.pane) + (side === "right" ? 1 : 0);
  target.row.panes.splice(at, 0, pane);
  return prune(layout, options);
}

/** A tab opens a new row at the top or bottom of the workspace; refused at the row limit. */
export function addRow(input, componentId, position, { maxRows = DEFAULT_ROW_COUNT, keepRows = DEFAULT_ROW_COUNT, paneId = null } = {}) {
  if (input.rows.length >= maxRows) return input;
  const layout = clone(input);
  if (!paneOfComponent(layout, componentId)) return input;
  detach(layout, componentId);
  const share = 1 / (layout.rows.length + 1);
  layout.rows.forEach((row) => { row.size *= 1 - share; });
  const row = { id: newRowId(), size: share, extra: true, panes: [{ id: paneId || newPaneId(), size: 1, componentIds: [componentId], activeComponentId: componentId }] };
  if (position === "top") layout.rows.unshift(row); else layout.rows.push(row);
  return prune(layout, { keepRows });
}

/** A pane's tab list changed in place (closed, reordered, added from its own chooser, activated). */
export function setPaneTabs(input, paneId, componentIds, activeComponentId, options = {}) {
  const layout = clone(input);
  const target = findPane(layout, paneId);
  if (!target) return input;
  target.pane.componentIds = [...componentIds];
  target.pane.activeComponentId = componentIds.includes(activeComponentId) ? activeComponentId : componentIds[0] || "";
  return prune(layout, options);
}

/** New shares for the panes of one row, or for the rows (`rowId` null). */
export function resize(input, rowId, sizes) {
  const layout = clone(input);
  const items = rowId == null ? layout.rows : (layout.rows.find((row) => row.id === rowId)?.panes || null);
  if (!items || items.length !== sizes.length) return input;
  items.forEach((item, index) => { item.size = sizes[index]; });
  normalizeSizes(items);
  return layout;
}

/** Integer pixel extents for shares of `total` pixels minus the gaps: cumulative rounding, so every edge lands on a
 *  whole pixel (a half-pixel edge renders as a blurred, lighter frame line) and the extents sum to the space exactly. */
export function pixelExtents(sizes, total, gap = 0) {
  const space = Math.max(0, Math.floor(total) - gap * Math.max(0, sizes.length - 1));
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  let acc = 0, prev = 0;
  return sizes.map((size) => {
    acc += size / sum;
    const edge = Math.round(acc * space);
    const extent = edge - prev;
    prev = edge;
    return extent;
  });
}
