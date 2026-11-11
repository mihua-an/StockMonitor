import { layoutStateStore } from "./layout_state_store.js";
import { escapeHtml } from "./utility.js";   // the one HTML escape
import { directionGlyphHtml } from "./components/direction_glyph.js";
// Single canonical Title infrastructure for every Renderer data-column header.
//
// Responsibility boundary:
// - Tab controllers decide active content.
// - Hosts/DataGrid own rows, data, selection, scrolling and business sort execution.
// - This module owns Title DOM, column geometry presentation, divider boundaries,
//   resize interaction primitives, sort-intent UI, optional actions and lifecycle.
// - Pane/region splitters are deliberately unrelated to column resize boundaries.

const TITLE_STATE = new WeakMap();

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cssWidth(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return `${Math.max(0, value)}px`;
  return String(value);
}

function safeText(value) { return String(value ?? ""); }

// The icon a schema names with `icon` ("trend-up" / "trend-down": components/direction_glyph.js). A titled cell with
// `shortTitle` shows the short text and then the icon, and keeps its full title as the tooltip and accessible name.
function titleIconHtml(column) {
  const icon = String(column.icon || "");
  return icon.startsWith("trend-") ? directionGlyphHtml(icon.slice("trend-".length)) : "";
}

function shownTitle(column) {
  return column.shortTitle === undefined ? column.title : safeText(column.shortTitle);
}

/**
 * Pin an element's width: width, min-width and max-width in one place. The Title's table, the body table that
 * mirrors it and each mirrored column are pinned the same way, never by a triple of each module's own. A number is
 * px; a string is used as written ("100%", "none").
 */
export function pinWidth(el, width, { min = width, max = width } = {}) {
  if (!el) return;
  el.style.width = cssWidth(width);
  el.style.minWidth = cssWidth(min);
  el.style.maxWidth = cssWidth(max);
}

export function defineColumnSchema(columns, options = {}) {
  const list = Array.isArray(columns) ? columns : [];
  const ids = new Set();
  const normalized = list.map((column, index) => {
    const id = safeText(column?.id || column?.key || `column_${index}`).trim();
    if (!id) throw new Error(`Column schema contains an empty id at index ${index}`);
    if (ids.has(id)) throw new Error(`Column schema contains duplicate id: ${id}`);
    ids.add(id);
    const align = ["left", "center", "right"].includes(String(column?.align || "")) ? String(column.align) : "center";
    return Object.freeze({
      ...column,
      id,
      title: safeText(column?.title ?? column?.label ?? id),
      align,
      visible: column?.visible !== false,
      // These capabilities are independent and OFF unless declared.
      divider: column?.divider === true,
      sortable: column?.sortable === true,
      resizable: column?.resizable === true,
      sticky: column?.sticky === true,
      // Optional Title-cell action. A data column named "action" is not the same thing.
      action: column?.action && typeof column.action === "object" ? Object.freeze({ ...column.action }) : null,
      minWidth: Math.max(0, finite(column?.minWidth, 0)),
      hardMinWidth: Math.max(0, finite(column?.hardMinWidth, 0)),
      maxWidth: Math.max(0, finite(column?.maxWidth, 0)),
      flex: Math.max(0, finite(column?.flex, 1)),
    });
  }).filter((column) => column.visible);
  Object.defineProperty(normalized, "schemaId", {
    value: safeText(options?.id || "columns"), enumerable: false, configurable: false,
  });
  return Object.freeze(normalized);
}

export function visibleColumns(columns) {
  return (Array.isArray(columns) ? columns : []).filter((column) => column?.visible !== false);
}

function setColumnCellGeometry(cell, column, { header = false } = {}) {
  if (!cell || !column) return;
  cell.dataset.columnId = String(column.id || "");
  cell.dataset.columnAlign = String(column.align || "center");
  cell.dataset.columnDivider = column.divider ? "1" : "0";
  cell.dataset.columnSortable = column.sortable ? "1" : "0";
  cell.dataset.columnResizable = column.resizable ? "1" : "0";
  cell.classList.add(header ? "canonical-title-cell" : "canonical-column-cell");
  cell.classList.toggle("canonical-title-sortable", Boolean(header && column.sortable));
  if (column.className) String(column.className).split(/\s+/).filter(Boolean).forEach((name) => cell.classList.add(name));
  if (column.minWidth) cell.style.minWidth = `${column.minWidth}px`; else cell.style.removeProperty("min-width");
  if (column.maxWidth) cell.style.maxWidth = `${column.maxWidth}px`; else cell.style.removeProperty("max-width");
}

function normalizeSortState(state) {
  if (!state) return { columnId: "", direction: "" };
  const columnId = String(state.columnId ?? state.id ?? state.key ?? "");
  const direction = state.direction === "asc" || state.direction === "desc" ? state.direction : "";
  return { columnId, direction };
}

function nextSortDirection(sortState, column) {
  const current = normalizeSortState(sortState);
  const key = String(column.sortKey || column.id || "");
  return current.columnId === key && current.direction === "asc" ? "desc" : "asc";
}

function applySortPresentation(cell, column, sortState) {
  const mark = cell.querySelector(":scope > .canonical-sort-mark");
  if (!column.sortable) {
    if (mark) mark.textContent = "";
    return;
  }
  const state = normalizeSortState(sortState);
  const key = String(column.sortKey || column.id || "");
  const active = state.columnId === key && Boolean(state.direction);
  if (mark) mark.textContent = active ? (state.direction === "asc" ? "▲" : "▼") : "";
  cell.setAttribute("aria-sort", active ? (state.direction === "asc" ? "ascending" : "descending") : "none");
}

function cleanupTitleState(table) {
  const state = TITLE_STATE.get(table);
  if (!state) return;
  try { state.resizeObserver?.disconnect?.(); } catch (error) { console.warn("[column title: disconnecting the resize observer] failed", error); }
  for (const cleanup of state.cleanup || []) { try { cleanup(); } catch (error) { console.warn("[column title: cleanup] failed", error); } }
  try { state.activeResize?.(); } catch (error) { console.warn("[column title: ending the active resize] failed", error); }
  try { document.documentElement.classList.remove("canonical-column-resize-active"); } catch (error) { console.warn("[column title: clearing the resize class] failed", error); }
  TITLE_STATE.delete(table);
}

export function destroyColumnTitle(table) {
  if (!table) return;
  cleanupTitleState(table);
  table.querySelectorAll(":scope > thead [data-column-boundary]").forEach((node) => node.remove());
  delete table.dataset.canonicalTitleReady;
  delete table.dataset.canonicalColumnResizeReady;
}

export function applyColumnHeader(target, columns, options = {}) {
  const list = visibleColumns(columns);
  const table = target?.tagName === "TABLE" ? target : target?.closest?.("table");
  let thead;
  if (target?.tagName === "THEAD") thead = target;
  else if (table) {
    thead = table.querySelector(":scope > thead");
    if (!thead) {
      thead = document.createElement("thead");
      const before = table.querySelector(":scope > tbody, :scope > tfoot");
      if (before) table.insertBefore(thead, before); else table.appendChild(thead);
    }
  }
  if (!thead) return null;
  const schemaId = safeText(options.schemaId || columns?.schemaId || "columns");
  thead.dataset.columnSchema = schemaId;
  let row = thead.querySelector(":scope > tr[data-canonical-title-row]");
  if (!row || thead.children.length !== 1) {
    row = document.createElement("tr");
    row.dataset.canonicalTitleRow = "1";
    thead.replaceChildren(row);
  }
  while (row.children.length < list.length) row.appendChild(document.createElement("th"));
  while (row.children.length > list.length) row.lastElementChild?.remove();

  list.forEach((column, index) => {
    let cell = row.children[index];
    if (cell?.tagName !== "TH") {
      const replacement = document.createElement("th"); cell?.replaceWith?.(replacement); cell = replacement;
    }
    cell.className = "";
    cell.removeAttribute("style");
    cell.removeAttribute("aria-sort");
    cell.removeAttribute("tabindex");
    cell.removeAttribute("role");
    cell.removeAttribute("title");
    cell.removeAttribute("aria-label");
    cell.replaceChildren();
    cell.scope = "col";
    const label = document.createElement("span");
    label.className = "canonical-title-label";
    label.textContent = shownTitle(column);
    label.insertAdjacentHTML("beforeend", titleIconHtml(column));
    cell.appendChild(label);
    if (shownTitle(column) !== column.title) {
      cell.setAttribute("aria-label", column.title);
    }
    if (column.sortable) {
      const mark = document.createElement("span");
      mark.className = "canonical-sort-mark";
      mark.setAttribute("aria-hidden", "true");
      cell.appendChild(mark);
      cell.tabIndex = 0;
    }
    if (column.action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `canonical-title-action${column.action.className ? ` ${String(column.action.className)}` : ""}`;
      button.dataset.titleAction = String(column.action.id || column.id || "action");
      button.textContent = String(column.action.label || column.action.title || "操作");
      button.setAttribute("aria-label", String(column.action.ariaLabel || column.action.label || column.action.title || column.title || "操作"));
      cell.appendChild(button);
    }
    setColumnCellGeometry(cell, column, { header: true });
    if (typeof options.decorateCell === "function") options.decorateCell(cell, column, index);
    applySortPresentation(cell, column, options.sortState);
  });
  return row;
}

export function applyColumnGroup(table, columns, options = {}) {
  if (!table) return null;
  const list = visibleColumns(columns);
  const schemaId = safeText(options.schemaId || columns?.schemaId || "columns");
  const selector = `:scope > colgroup[data-column-schema-owner="${CSS.escape(schemaId)}"]`;
  let group = table.querySelector(selector);
  if (!group) {
    group = document.createElement("colgroup"); group.dataset.columnSchemaOwner = schemaId; table.insertBefore(group, table.firstChild);
  }
  while (group.children.length < list.length) group.appendChild(document.createElement("col"));
  while (group.children.length > list.length) group.lastElementChild?.remove();
  [...group.children].forEach((col, index) => {
    const column = list[index];
    col.removeAttribute("class");
    if (column.colClassName) String(column.colClassName).split(/\s+/).filter(Boolean).forEach((name) => col.classList.add(name));
    col.dataset.columnId = String(column.id || "");
    const width = cssWidth(column.width);
    if (width) col.style.width = width; else col.style.removeProperty("width");
  });
  return group;
}

function columnKey(column, index) {
  const key = String(column?.id || column?.key || "").trim();
  return key || `column-${index}`;
}

// A fitted table's widths are saved with the width they were fitted to (`available`), and read back scaled to the
// width the table has now: the user's proportions survive a pane / window resize instead of the extra or missing
// pixels being spread by the columns' default flex (商品列表 columns "jumping").
function readSavedWidths(storageKey, columns, availableNow = 0) {
  if (!storageKey) return null;
  const list = visibleColumns(columns);
  const saved = layoutStateStore.readColumnWidths(storageKey);
  if (!saved) return null;
  let found = false;
  const scale = saved.available > 0 && availableNow > 0 ? availableNow / saved.available : 1;
  const values = list.map((column, index) => {
    const value = Number(saved.columns[columnKey(column, index)]);
    if (Number.isFinite(value) && value > 0) { found = true; return value * scale; }
    return Number.NaN;
  });
  return found ? values : null;
}
// A drag commits the columns it moved (the others the fit nudged by a pixel are not the user's); the store merges
// them into the key that tables in other windows of other widths share. `shown` seeds the columns the key has no
// width for yet, so a first drag saves the whole layout the user saw.
function commitDraggedWidths(storageKey, startWidths, widths, columns, available, source) {
  if (!storageKey || !Array.isArray(widths)) return;
  const changed = {};
  const shown = {};
  visibleColumns(columns).forEach((column, index) => {
    const value = Number(widths[index]);
    if (!Number.isFinite(value) || value <= 0) return;
    shown[columnKey(column, index)] = value;
    if (Math.abs(value - Number(startWidths[index])) >= 1) changed[columnKey(column, index)] = value;
  });
  layoutStateStore.commitColumnWidths(storageKey, { changed, shown, available }, { source });
}

function columnResizeDiagnostic(payload = {}) {
  try {
    if (globalThis.localStorage?.getItem?.("marketDiagnostics") !== "1") return;
    console.debug("[ColumnResize]", payload);
  } catch (error) { console.warn("[column title: resize diagnostics] failed", error); }
}
function availableWidthFor(table) {
  const wrapper = table?.parentElement;
  const width = Math.floor(wrapper?.clientWidth || table?.getBoundingClientRect?.().width || table?.clientWidth || 0);
  return Math.max(1, width);
}
function measuredHeaderWidths(headers, minimums) {
  return headers.map((th, index) => Math.max(minimums[index], Math.round(th.getBoundingClientRect().width || minimums[index])));
}

// keepMinimums: no column goes below its minWidth -- columns that do not fit make the table wider than the space (its
// wrapper scrolls sideways) instead of every column being scaled down until numbers are cut.
// shrink: false keeps widths the user set -- they only grow to fill the space, a table they made wider than its space
// stays wider and scrolls; with keepMinimums only (a table that may not scroll always fits).
// minimums: each column's minimum when its owner knows better than the schema (the widths the values shown need).
export function fitColumnWidthsToAvailable(rawWidths, available, columns, { floorWidth = 24, keepMinimums = false, shrink = true, minimums: given = null } = {}) {
  const list = visibleColumns(columns);
  const minimums = list.map((column, index) => Math.max(floorWidth, Number(given?.[index]) || finite(column.minWidth, 0) || floorWidth));
  const hardMinimums = list.map((column) => Math.max(0, finite(column.hardMinWidth, 0)));
  // flex 0: the column takes none of the room left over (it keeps the width its content needs).
  const flexes = list.map((column) => Math.max(0, finite(column.flex, 1)));
  let widths = list.map((column, index) => {
    const value = Number(rawWidths?.[index]);
    if (Number.isFinite(value) && value > 0) return Math.max(minimums[index], value);
    const numericWidth = typeof column.width === "number" ? column.width : Number.parseFloat(String(column.width || ""));
    return Number.isFinite(numericWidth) && numericWidth > 0 ? Math.max(minimums[index], numericWidth) : minimums[index];
  });
  const target = Math.max(1, Number(available) || 1);
  let total = widths.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - target) <= 0.5) return widths;
  if (total < target) {
    const extra = target - total;
    const flexTotal = flexes.reduce((sum, value) => sum + value, 0);
    widths = widths.map((value, index) => value + extra * (flexTotal > 0 ? flexes[index] / flexTotal : 1 / list.length));
  } else if (shrink || !keepMinimums) {
    let overflow = total - target;
    for (let pass = 0; pass < 5 && overflow > 0.5; pass += 1) {
      const shrinkable = widths.map((value, index) => Math.max(0, value - minimums[index]));
      const shrinkTotal = shrinkable.reduce((sum, value) => sum + value, 0);
      if (shrinkTotal <= 0) break;
      widths = widths.map((value, index) => value - Math.min(shrinkable[index], overflow * (shrinkable[index] / shrinkTotal)));
      total = widths.reduce((sum, value) => sum + value, 0); overflow = total - target;
    }
    total = widths.reduce((sum, value) => sum + value, 0);
    if (total > target && target > 0 && !keepMinimums) {
      const scale = target / total; widths = widths.map((value) => Math.max(floorWidth, value * scale));
    }
  }
  hardMinimums.forEach((hardMin, hardIndex) => {
    if (!hardMin || widths[hardIndex] >= hardMin) return;
    const deficit = hardMin - widths[hardIndex];
    const donors = widths.map((value, index) => ({ index, room: index === hardIndex ? 0 : Math.max(0, value - floorWidth) })).filter((item) => item.room > 0);
    const donorRoom = donors.reduce((sum, item) => sum + item.room, 0);
    const takeTotal = Math.min(deficit, donorRoom);
    if (takeTotal > 0) donors.forEach((item) => { widths[item.index] -= takeTotal * (item.room / donorRoom); });
    // What the neighbours cannot give still goes to the column: a hard minimum is never undercut (the table is then
    // wider than its space).
    widths[hardIndex] = hardMin;
  });
  // Rounding left over: room still free goes to the last column; width still too much is taken only from columns
  // above their lower bound (the floor, or a column's hard minimum). Columns that are all at that bound and still do
  // not fit stay at it: the table is wider than its space and scrolls sideways, no column is pushed below its bound.
  const remainder = target - widths.reduce((sum, value) => sum + value, 0);
  if (widths.length && remainder > 0.5) widths[widths.length - 1] += remainder;
  else if (widths.length && remainder < -0.5 && !keepMinimums) {
    const lower = widths.map((_value, index) => Math.max(floorWidth, hardMinimums[index]));
    const room = widths.map((value, index) => Math.max(0, value - lower[index]));
    const roomTotal = room.reduce((sum, value) => sum + value, 0);
    const take = Math.min(-remainder, roomTotal);
    if (take > 0) widths = widths.map((value, index) => value - take * (room[index] / roomTotal));
  }
  return widths;
}

// The column-width owner of a resizable title: fitted <col> widths, restored from and persisted to layout state.
// Two sources of widths: the defaults (the header as the schema lays it out, fitted to the space) and the user's
// (dragged or saved). In a table that scrolls sideways (keepMinimums) the user's widths are never shrunk to fit.
function columnWidthController(table, list, options, resizeOptions, headers, columns) {
  const group = applyColumnGroup(table, list, { schemaId: options.schemaId || columns?.schemaId });
  const cols = [...group.querySelectorAll(":scope > col")];
  const floorWidth = Math.max(16, Number(resizeOptions.floorWidth) || 24);
  const fitToAvailable = resizeOptions.fitToAvailable !== false;
  const keepMinimums = resizeOptions.keepMinimums === true;
  const baseMinimums = list.map((column) => Math.max(floorWidth, Number(column.minWidth) || Number(resizeOptions.defaultMinWidth) || 48));
  // The minimums in force: the schema's, raised to what the values shown need (setContentMinimums). One array,
  // changed in place, so a drag in flight reads the same minimums the fit does.
  const minimums = [...baseMinimums];
  const currentWidths = () => measuredHeaderWidths(headers, minimums);
  // The defaults, the same at a first mount and after a double click whatever an earlier fit or drag left on the
  // table: the header measured in the schema's own layout (its <col> widths, automatic table layout, no pinned width).
  // defaultsFromSchema takes them from the schema instead -- each column's width, else its minimum -- and the fit
  // shares the space left by flex.
  const defaultsFromSchema = resizeOptions.defaultsFromSchema === true;
  const defaultWidths = () => {
    if (defaultsFromSchema) return list.map((column, index) => Math.max(minimums[index], finite(column.width, 0)));
    applyColumnGroup(table, list, { schemaId: options.schemaId || columns?.schemaId });
    table.classList.remove("canonical-fitted-table");
    pinWidth(table, "", { min: "", max: "" });
    return currentWidths();
  };
  const savedWidthsNow = () => readSavedWidths(String(resizeOptions.storageKey || ""), list,
    fitToAvailable ? availableWidthFor(table) : 0);
  const applyWidths = (rawWidths, { user = false } = {}) => {
    const fitted = fitToAvailable
      ? fitColumnWidthsToAvailable(rawWidths, availableWidthFor(table), list, { floorWidth, keepMinimums, shrink: !user, minimums })
      : list.map((_column, index) => Math.max(minimums[index], Number(rawWidths?.[index]) || minimums[index]));
    cols.forEach((col, index) => { col.style.width = `${Math.max(floorWidth, Math.round(fitted[index]))}px`; });
    table.classList.add("canonical-fitted-table");
    if (fitToAvailable) {
      const available = availableWidthFor(table);
      // Wider than the space only when keepMinimums kept columns at their minimums.
      const width = keepMinimums ? Math.max(available, Math.round(fitted.reduce((sum, value) => sum + value, 0))) : available;
      pinWidth(table, width, { min: 0 });
    }
    return fitted;
  };
  // This table's identity in the store's notices: its own commits are already on screen.
  const source = {};
  const commit = (startWidths, fitted) => commitDraggedWidths(String(resizeOptions.storageKey || ""), startWidths, fitted, list,
    fitToAvailable ? availableWidthFor(table) : 0, source);
  // The widths a mount, a refit or a pane resize lays out: the saved ones when there are, else the defaults. The
  // defaults are measured once and kept, so a refit fits them to the new space instead of re-fitting fitted widths.
  let defaults = null;
  const restore = () => {
    const saved = savedWidthsNow();
    if (saved) return applyWidths(saved, { user: true });
    defaults ||= defaultWidths();
    return applyWidths(defaults);
  };
  const resetToDefaults = () => {
    const key = String(resizeOptions.storageKey || ""); if (key) layoutStateStore.remove(key, { source });
    defaults = defaultWidths();
    return applyWidths(defaults);
  };
  // The px each column's values need now. `shrink: false` only raises a minimum: a column never narrows while its
  // rows tick, only when the rows themselves change (another page, a product added or removed). Whether anything changed.
  const setContentMinimums = (needed, { shrink = false } = {}) => {
    let changed = false;
    list.forEach((_column, index) => {
      const content = Number(needed?.[index]);
      if (!Number.isFinite(content)) return;
      const next = Math.max(baseMinimums[index], Math.round(content));
      const value = shrink ? next : Math.max(minimums[index], next);
      if (value !== minimums[index]) { minimums[index] = value; changed = true; }
    });
    return changed;
  };
  // Another table (this window or another) changed the key: lay out what it saved, or the defaults when it cleared it.
  const subscribe = (onChange) => layoutStateStore.subscribe(String(resizeOptions.storageKey || ""), (_value, { source: from }) => {
    if (from !== source) onChange();
  });
  return { minimums, keepMinimums, applyWidths, commit, subscribe, restore, resetToDefaults, setContentMinimums, available: () => availableWidthFor(table) };
}

function bindHeaderSort(cell, column, options, cleanup) {
  if (!column.sortable || options.interactions === false || typeof options.onSort !== "function") return;
  const activateSort = (event) => {
    if (event?.target?.closest?.("[data-column-boundary]")) return;
    if (event?.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    event?.preventDefault?.();
    const direction = nextSortDirection(options.sortState, column);
    options.onSort({ columnId: String(column.id), sortKey: String(column.sortKey || column.id), direction, column, event });
  };
  cell.addEventListener("click", activateSort);
  cell.addEventListener("keydown", activateSort);
  cleanup.push(() => cell.removeEventListener("click", activateSort), () => cell.removeEventListener("keydown", activateSort));
}

function bindHeaderAction(cell, column, options, cleanup) {
  const actionButton = cell.querySelector(":scope > .canonical-title-action");
  if (!column.action || !actionButton || options.interactions === false || typeof options.onAction !== "function") return;
  const activateAction = (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onAction({ actionId: String(column.action.id || column.id || "action"), columnId: String(column.id), column, event });
  };
  actionButton.addEventListener("click", activateAction);
  cleanup.push(() => actionButton.removeEventListener("click", activateAction));
}

// The boundary after column `index` (N columns have N-1 boundaries; never trailing): a divider and/or a resize handle.
function appendColumnBoundary(cell, list, index, options, resizeOptions) {
  const column = list[index];
  const divider = Boolean(column.divider);
  const resizable = Boolean(column.resizable && options.interactions !== false);
  if (!divider && !resizable) return null;
  const boundary = document.createElement("span");
  boundary.className = `canonical-column-boundary${divider ? " has-divider" : ""}${resizable ? " is-resizable" : ""}`;
  boundary.dataset.columnBoundary = `${column.id}|${list[index + 1].id}`;
  boundary.dataset.columnDivider = divider ? "1" : "0";
  boundary.dataset.columnResizable = resizable ? "1" : "0";
  cell.appendChild(boundary);
  return resizable ? boundary : null;
}

// Dragging a boundary resizes the column on its left; a double click restores the defaults.
// The column beside it on the right gives or takes the width, so a table that fills its space keeps filling it. In a
// table that scrolls sideways (keepMinimums) a column grows past what that neighbour can give -- the table gets wider
// -- and a table wider than its space gets narrower first when a column shrinks: with every column at its minimum
// (a list with more columns than its pane) a zero-sum drag between neighbours moved nothing.
export function boundaryDragWidths(startWidths, index, rawDelta, { minimums, keepMinimums = false, available = 0 } = {}) {
  const maxGrow = Math.max(0, startWidths[index + 1] - minimums[index + 1]);
  const maxShrink = Math.max(0, startWidths[index] - minimums[index]);
  const delta = Math.max(-maxShrink, keepMinimums ? rawDelta : Math.min(maxGrow, rawDelta));
  const next = [...startWidths];
  next[index] = startWidths[index] + delta;
  if (delta >= 0) next[index + 1] = startWidths[index + 1] - Math.min(delta, maxGrow);
  else {
    const total = startWidths.reduce((sum, value) => sum + value, 0);
    const tableGives = keepMinimums ? Math.min(-delta, Math.max(0, total - available)) : 0;
    next[index + 1] = startWidths[index + 1] + (-delta - tableGives);
  }
  return { delta, widths: next };
}

function bindBoundaryResize(boundary, index, { state, table, list, columns, options, widths, cleanup }) {
  const { minimums, keepMinimums, applyWidths, commit, resetToDefaults, available } = widths;
  const column = list[index];
  const onPointerDown = (event) => {
    event.preventDefault(); event.stopPropagation();
    // One drag at a time per table, bound to the pointer that started it: a second finger on another
    // boundary ends the first drag before its own begins, and moves/ups of any other pointer are ignored.
    state.activeResize?.();
    const pointerId = event.pointerId;
    const ours = (other) => pointerId === undefined || other.pointerId === undefined || other.pointerId === pointerId;
    try { boundary.setPointerCapture?.(pointerId); } catch { /* not an error: the pointer is already gone (released before capture) */ }
    // Mount/restore already fitted the columns. Pointer-down must not run
    // that fitting algorithm again: fitting can redistribute fractions and
    // visibly move columns before the user has dragged the boundary.
    const startX = event.clientX;
    const startWidths = [...state.widths];
    const space = available();
    let changed = false;
    boundary.classList.add("dragging"); document.documentElement.classList.add("canonical-column-resize-active");
    const onMove = (moveEvent) => {
      if (!ours(moveEvent)) return;
      const rawDelta = moveEvent.clientX - startX;
      if (rawDelta === 0) return;
      const { delta, widths: next } = boundaryDragWidths(startWidths, index, rawDelta, { minimums, keepMinimums, available: space });
      if (delta === 0) return;
      state.widths = applyWidths(next, { user: true });
      changed = true;
    };
    let finished = false;
    const finishResize = (endEvent) => {
      if (finished || (endEvent && !ours(endEvent))) return;
      finished = true;
      if (state.activeResize === finishResize) state.activeResize = null;
      boundary.classList.remove("dragging"); document.documentElement.classList.remove("canonical-column-resize-active");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
      // Minimums raised while the drag was held are fitted now.
      if (!changed) { state.refit?.(); return; }
      const before = startWidths[index];
      state.widths = applyWidths(state.widths, { user: true });
      commit(startWidths, state.widths);
      columnResizeDiagnostic({
        table_id: String(options.schemaId || columns?.schemaId || "columns"),
        column_key: columnKey(column, index),
        old_width: before,
        new_width: state.widths[index],
        persisted_width: state.widths[index],
        restore_source: "stable-column-key",
        render_generation: table.dataset.canonicalTitleReady || "",
        refresh_reason: "pointer-resize",
      });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    // One drag in flight at a time; it removes its own listeners when it ends, so no drag pushes closures into the
    // long-lived cleanup list, which would grow for the table's whole life.
    state.activeResize = finishResize;
  };
  const onDoubleClick = (event) => {
    event.preventDefault(); event.stopPropagation();
    state.activeResize?.();
    state.widths = resetToDefaults();
  };
  boundary.addEventListener("pointerdown", onPointerDown); boundary.addEventListener("dblclick", onDoubleClick);
  cleanup.push(() => boundary.removeEventListener("pointerdown", onPointerDown), () => boundary.removeEventListener("dblclick", onDoubleClick));
}

function installTitleCapabilities(table, columns, options = {}) {
  if (!table) return null;
  cleanupTitleState(table);
  const list = visibleColumns(columns);
  const headers = [...table.querySelectorAll(":scope > thead > tr:last-child > th")];
  if (headers.length !== list.length) return null;
  const cleanup = [];
  const state = { table, columns: list, headers, cleanup, resizeObserver: null, widths: null, activeResize: null, interactionsEnabled: options.interactions !== false };
  const resizeOptions = options.resize && typeof options.resize === "object" ? options.resize : {};
  const anyResizable = list.slice(0, -1).some((column) => column.resizable);
  const widths = anyResizable && options.interactions !== false
    ? columnWidthController(table, list, options, resizeOptions, headers, columns) : null;
  if (widths) {
    state.widths = widths.restore();
    state.setContentMinimums = widths.setContentMinimums;
    // A drag in flight owns the widths; it fits them to the space when it ends.
    state.refit = () => {
      if (!state.activeResize) state.widths = widths.restore();
      return state.widths;
    };
    // A title no longer in the document stops listening (a host dropped it without destroyColumnTitle).
    const unsubscribe = widths.subscribe(() => { if (table.isConnected) state.refit(); else unsubscribe(); });
    cleanup.push(unsubscribe);
  }

  headers.forEach((cell, index) => {
    const column = list[index];
    applySortPresentation(cell, column, options.sortState);
    bindHeaderSort(cell, column, options, cleanup);
    bindHeaderAction(cell, column, options, cleanup);
    if (index === list.length - 1) return;
    const resizeHandle = appendColumnBoundary(cell, list, index, options, resizeOptions);
    if (resizeHandle && widths) {
      bindBoundaryResize(resizeHandle, index, { state, table, list, columns, options, widths, cleanup });
    }
  });

  const wrapper = table.parentElement;
  if (widths && wrapper && resizeOptions.observeResize !== false && typeof ResizeObserver !== "undefined") {
    state.resizeObserver = new ResizeObserver(() => { state.refit(); });
    state.resizeObserver.observe(wrapper);
  }
  TITLE_STATE.set(table, state);
  table.dataset.canonicalTitleReady = String(options.schemaId || columns?.schemaId || "columns");
  if (anyResizable) table.dataset.canonicalColumnResizeReady = table.dataset.canonicalTitleReady;
  return state;
}

/**
 * Set a mounted title's minimums to the px its values need now (core/column_content_width.js) and refit when one
 * changed. `shrink: false` only raises them. A drag in flight keeps its widths; its end fits them to the new minimums.
 */
export function setColumnContentMinimums(table, needed, options = {}) {
  const state = table ? TITLE_STATE.get(table) : null;
  if (!state?.setContentMinimums?.(needed, options)) return false;
  state.refit?.();
  return true;
}

/** Refit a mounted canonical title after its dashboard slot changes size. */
export function refitColumnTitle(table) {
  const state = table ? TITLE_STATE.get(table) : null;
  return typeof state?.refit === "function" ? state.refit() : null;
}

function canonicalColumnIdentity(columns) {
  return visibleColumns(columns).map((column) => String(column.id || "")).join("\u001f");
}

/**
 * Data-only refreshes must never destroy an already mounted canonical Title.
 *
 * Product quote rows can refresh many times per second. Re-running
 * applyColumnSchema() during an active boundary drag destroys the old Title
 * listeners before pointerup, so the user's width never reaches persistence and
 * the next refresh appears to "snap" the columns back.
 *
 * Reuse the existing Title when schema id + visible column ids are unchanged.
 * A real schema/config change still falls through to the normal rebuild path.
 */
export function ensureColumnSchema(table, columns, options = {}) {
  if (!table) return null;
  const list = visibleColumns(columns);
  const schemaId = safeText(options.schemaId || columns?.schemaId || "columns");
  const identity = canonicalColumnIdentity(list);
  const state = TITLE_STATE.get(table);
  const headers = [...table.querySelectorAll(":scope > thead > tr:last-child > th")];
  const mountedIdentity = headers.map((cell) => String(cell.dataset.columnId || "")).join("\u001f");
  const reusable = Boolean(
    state
    && table.dataset.canonicalTitleReady === schemaId
    && table.dataset.columnSchema === schemaId
    && headers.length === list.length
    && mountedIdentity === identity
    && (options.interactions === false || state.interactionsEnabled === true)
  );
  if (!reusable) return applyColumnSchema(table, columns, options);

  // Data refresh may carry a new sort state, but geometry/listeners stay owned by
  // the already-mounted Title. This is intentionally presentation-only.
  headers.forEach((cell, index) => applySortPresentation(cell, list[index], options.sortState));
  const group = table.querySelector(`:scope > colgroup[data-column-schema-owner="${CSS.escape(schemaId)}"]`);
  return {
    header: table.querySelector(":scope > thead"),
    colgroup: group || null,
    interactions: state,
    reused: true,
  };
}

export function applyColumnSchema(table, columns, options = {}) {
  if (!table) return null;
  const header = options.header === false ? null : applyColumnHeader(table, columns, options);
  const colgroup = options.colgroup === false ? null : applyColumnGroup(table, columns, options);
  table.dataset.columnSchema = safeText(options.schemaId || columns?.schemaId || "columns");
  const interactions = header ? installTitleCapabilities(table, columns, options) : null;
  return { header, colgroup, interactions };
}

export function renderColumnHeaderHtml(columns, options = {}) {
  const list = visibleColumns(columns);
  const schemaId = escapeHtml(options.schemaId || columns?.schemaId || "columns");
  const cells = list.map((column, index) => {
    const classes = ["canonical-title-cell", column.sortable ? "canonical-title-sortable" : "", column.className || ""].filter(Boolean).join(" ");
    const min = column.minWidth ? `min-width:${column.minWidth}px;` : "";
    const max = column.maxWidth ? `max-width:${column.maxWidth}px;` : "";
    const mark = column.sortable ? '<span class="canonical-sort-mark" aria-hidden="true"></span>' : "";
    const action = column.action
      ? `<button type="button" class="canonical-title-action${column.action.className ? ` ${escapeHtml(column.action.className)}` : ""}" data-title-action="${escapeHtml(column.action.id || column.id || "action")}" aria-label="${escapeHtml(column.action.ariaLabel || column.action.label || column.action.title || column.title || "操作")}">${escapeHtml(column.action.label || column.action.title || "操作")}</button>`
      : "";
    const isLast = index === list.length - 1;
    const boundary = !isLast && (column.divider || column.resizable)
      ? `<span class="canonical-column-boundary${column.divider ? " has-divider" : ""}${column.resizable ? " is-resizable" : ""}" data-column-boundary="${escapeHtml(column.id)}|${escapeHtml(list[index + 1].id)}" data-column-divider="${column.divider ? 1 : 0}" data-column-resizable="${column.resizable ? 1 : 0}"></span>`
      : "";
    const named = shownTitle(column) !== column.title ? ` aria-label="${escapeHtml(column.title)}"` : "";
    return `<th scope="col" class="${escapeHtml(classes)}" data-column-id="${escapeHtml(column.id)}" data-column-align="${escapeHtml(column.align)}" data-column-divider="${column.divider ? 1 : 0}" data-column-sortable="${column.sortable ? 1 : 0}" data-column-resizable="${column.resizable ? 1 : 0}"${named} style="text-align:${escapeHtml(column.align)};${min}${max}"><span class="canonical-title-label">${escapeHtml(shownTitle(column))}${titleIconHtml(column)}</span>${mark}${action}${boundary}</th>`;
  }).join("");
  return `<thead data-column-schema="${schemaId}"><tr data-canonical-title-row="1">${cells}</tr></thead>`;
}

export function renderColumnGroupHtml(columns, options = {}) {
  const list = visibleColumns(columns);
  const schemaId = escapeHtml(options.schemaId || columns?.schemaId || "columns");
  const cols = list.map((column) => {
    const classes = String(column.colClassName || "").trim();
    const width = cssWidth(column.width);
    return `<col${classes ? ` class="${escapeHtml(classes)}"` : ""} data-column-id="${escapeHtml(column.id)}"${width ? ` style="width:${escapeHtml(width)}"` : ""}>`;
  }).join("");
  return `<colgroup data-column-schema-owner="${schemaId}">${cols}</colgroup>`;
}
