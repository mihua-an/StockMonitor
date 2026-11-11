// A page's workspace as draggable panes (歷史回放's lower row). pane_layout.js holds the rules; this renders the layout,
// keeps one TabbedComponentHost per pane, takes drops, resizes with splitters and persists the layout.
//
// Data is not this file's business: a component subscribes to its data source when it mounts and lets go when it is
// destroyed, whichever pane it is in. Moving a tab only destroys it in one pane and mounts it in another; the page's
// market subscriptions follow the selected symbol, never the panes. A change re-renders only the panes it touched.
import { TabbedComponentHost } from "./tabbed_component_host.js";
import {
  normalizeLayout, storedLayoutUsable, moveTab, splitPane, addRow, setPaneTabs, resize, findPane, paneOfComponent, pixelExtents,
} from "./pane_layout.js";
import { tabDragSession } from "./tab_drag_session.js";
import { layoutStateStore } from "./layout_state_store.js";
import { beginSplitterDrag, splitPair } from "./splitter_drag.js";
import { discardTrendSurfaces } from "./trend_surface_state.js";

const GAP = 8;               // the space between panes and between rows (the splitters live in it)
const MIN_PANE_PX = 160;
const MIN_ROW_PX = 150;
const EDGE_SHARE = 0.22;     // a drop in a pane's outer 22% opens a new pane on that side
const ROW_EDGE_PX = 26;      // a drop this close to the workspace's top/bottom opens a new row

// A pane's measured extent: inline, so it is the one owner of the size (no stylesheet sets a pane's width or height).
function setExtent(element, prop, px) {
  element.style.setProperty(prop, `${px}px`);
}

export class PaneWorkspace {
  // `rows`: how many rows of panes the workspace has (歷史回放's one row).
  // `fixedTabs`: its features are fixed -- tabs move between panes but are never closed, and none is added.
  constructor({ pageId, element, context, registry, storageKey, defaultLayout, rows, fixedTabs = false }) {
    this.pageId = String(pageId);
    this.element = element;
    this.context = context;
    this.registry = registry;
    this.storageKey = storageKey;
    if (!Number.isInteger(rows) || rows < 1) throw new Error(`PaneWorkspace needs a row count: ${rows}`);
    this.rows = rows;
    this.fixedTabs = Boolean(fixedTabs);
    this.defaultLayout = defaultLayout;     // () => raw layout, used when nothing usable is stored
    this.panes = new Map();                 // pane id -> { element, host }
    this.rowElements = new Map();           // row id -> element
    this.cleanup = [];
    this.layout = null;
    this.indicator = null;
    this.activeResize = null;               // the splitter drag in progress: { cancel } from beginSplitterDrag
    this.destroyed = false;
  }

  get hosts() {
    return new Map([...this.panes.entries()].map(([id, pane]) => [id, pane.host]));
  }

  _options() {
    return { keepRows: this.rows };
  }

  _isKnown(componentId) {
    return Boolean(this.registry.get(componentId)) && this.registry.supports(componentId, { mode: this.context?.mode, slotId: "workspacePane", hostType: "inline" });
  }

  mount() {
    // The page markup ships the default panes with their initial content (hydrated by the components); they are
    // adopted by id, and any pane the layout no longer has is simply not placed.
    this.staticPanes = new Map([...this.element.querySelectorAll("[data-component-slot]")].map((node) => [node.dataset.componentSlot, node]));
    const stored = layoutStateStore.read(this.storageKey, null);
    const raw = storedLayoutUsable(stored) ? stored : this.defaultLayout();
    this.layout = normalizeLayout(raw, { isKnown: (id) => this._isKnown(id) });
    this.element.classList.add("pane-mode");
    this.indicator = document.createElement("div");
    this.indicator.className = "pane-drop-indicator";
    this.indicator.hidden = true;
    this._render(null);
    this._persist();
    this._bindDrops();
    const observer = new ResizeObserver(() => this._applyGeometry());
    observer.observe(this.element);
    this.cleanup.push(() => observer.disconnect());
    this.cleanup.push(tabDragSession.subscribe((drag) => {
      this.element.classList.toggle("pane-dragging", Boolean(drag && drag.pageId === this.pageId));
      if (!drag) this._hideIndicator();
    }));
    return this;
  }

  /** Make `next` the layout: persist it, then re-render what changed. */
  apply(next) {
    if (this.destroyed || !next || next === this.layout) return;
    const previous = this.layout;
    this.layout = next;
    this._persist();
    this._render(previous);
    globalThis.window?.dispatchEvent?.(new Event("resize"));
  }

  _persist() {
    layoutStateStore.write(this.storageKey, { ...this.layout, savedAt: Date.now() });
  }

  // ---------------------------------------------------------------------------------------------------- rendering

  _render(previous) {
    const wanted = new Map();
    for (const row of this.layout.rows) for (const pane of row.panes) wanted.set(pane.id, pane);
    // 1. Panes that are gone: their components let go first.
    for (const [id, entry] of [...this.panes.entries()]) {
      if (wanted.has(id)) continue;
      entry.host.destroy();
      entry.element.remove();
      this.panes.delete(id);
      discardTrendSurfaces(id);
    }
    // 2. Panes that lost a tab before panes that gained one: a moved component is destroyed before it mounts again.
    const before = (id) => (previous ? findPane(previous, id)?.pane?.componentIds || [] : []);
    const losing = [], gaining = [];
    for (const [id, entry] of this.panes.entries()) {
      const pane = wanted.get(id);
      (before(id).some((componentId) => !pane.componentIds.includes(componentId)) ? losing : gaining).push([entry, pane]);
    }
    for (const [entry, pane] of [...losing, ...gaining]) entry.host.setTabs(pane.componentIds, pane.activeComponentId);
    // 3. New panes. Their components mount only after step 4 has put the pane in the document: a component that
    // measures or upgrades its markup while detached (DataGrid treats a disconnected shell as stale and tears it
    // down) would come up broken.
    const fresh = [];
    for (const [id, pane] of wanted.entries()) {
      if (this.panes.has(id)) continue;
      const element = this.staticPanes.get(id) || this._newPaneElement(id);
      this.staticPanes.delete(id);
      element.dataset.componentSlot = id;
      element.dataset.paneId = id;
      const host = new TabbedComponentHost({
        host: element, hostId: `${this.pageId}:${id}`, pageId: this.pageId, slotId: id, context: this.context, registry: this.registry,
        config: { componentIds: pane.componentIds, activeComponentId: pane.activeComponentId },
        onConfigChange: (config) => queueMicrotask(() => this._paneChanged(id, config)),
        onExternalTabDrop: (componentId, index) => this.apply(moveTab(this.layout, componentId, id, index, this._options())),
        fixedTabs: this.fixedTabs,
        isPlacedElsewhere: (componentId) => {
          const holder = paneOfComponent(this.layout, componentId);
          return Boolean(holder && holder.id !== id);
        },
      });
      this.panes.set(id, { element, host });
      fresh.push(host);
    }
    // 4. Structure: rows of panes with a splitter between neighbours.
    const rows = this.layout.rows.map((row, rowIndex) => {
      const rowElement = this.rowElements.get(row.id) || Object.assign(document.createElement("div"), { className: "pane-row" });
      rowElement.dataset.rowId = row.id;
      this.rowElements.set(row.id, rowElement);
      const children = [];
      row.panes.forEach((pane, paneIndex) => {
        if (paneIndex) children.push(this._splitter("col", row.id, paneIndex - 1));
        children.push(this.panes.get(pane.id).element);
      });
      rowElement.replaceChildren(...children);
      return rowIndex ? [this._splitter("row", null, rowIndex - 1), rowElement] : [rowElement];
    }).flat();
    for (const id of [...this.rowElements.keys()]) if (!this.layout.rows.some((row) => row.id === id)) this.rowElements.delete(id);
    this.element.replaceChildren(...rows, this.indicator);
    this._applyGeometry();
    for (const host of fresh) host.mount();
  }

  _newPaneElement(id) {
    const element = document.createElement("div");
    element.className = "dashboard-card";
    element.dataset.componentSlot = id;
    return element;
  }

  _paneChanged(id, config) {
    if (this.destroyed || !findPane(this.layout, id)) return;
    this.apply(setPaneTabs(this.layout, id, config.componentIds || [], config.activeComponentId || "", this._options()));
  }

  /** Whole-pixel extents for every row and pane (a half-pixel edge renders as a blurred, lighter frame line). */
  _applyGeometry() {
    if (this.destroyed || !this.layout) return;
    const width = this.element.clientWidth, height = this.element.clientHeight;
    if (!(width > 0 && height > 0)) return;
    const heights = pixelExtents(this.layout.rows.map((row) => row.size), height, GAP);
    this.layout.rows.forEach((row, index) => {
      const rowElement = this.rowElements.get(row.id);
      if (!rowElement) return;
      setExtent(rowElement, "height", heights[index]);
      const widths = pixelExtents(row.panes.map((pane) => pane.size), width, GAP);
      row.panes.forEach((pane, paneIndex) => {
        const element = this.panes.get(pane.id)?.element;
        if (element) setExtent(element, "width", widths[paneIndex]);
      });
    });
  }

  // ---------------------------------------------------------------------------------------------------- splitters

  _splitter(kind, rowId, index) {
    const splitter = document.createElement("div");
    splitter.className = `pane-splitter pane-splitter-${kind}`;
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", kind === "col" ? "vertical" : "horizontal");
    splitter.addEventListener("pointerdown", (event) => this._beginResize(event, splitter, kind, rowId, index));
    return splitter;
  }

  // The drag itself is the shared one (core/splitter_drag.js); the panes' sizes are the extents this workspace writes.
  _beginResize(event, splitter, kind, rowId, index) {
    const items = kind === "col"
      ? this.layout.rows.find((row) => row.id === rowId).panes.map((pane) => this.panes.get(pane.id).element)
      : this.layout.rows.map((row) => this.rowElements.get(row.id));
    const prop = kind === "col" ? "width" : "height";
    const start = items.map((item) => item.getBoundingClientRect()[prop]);
    const min = kind === "col" ? MIN_PANE_PX : MIN_ROW_PX;
    let sizes = null;
    this.activeResize?.cancel();
    const drag = beginSplitterDrag(event, splitter, {
      axis: kind === "col" ? "x" : "y",
      onMove: (delta) => {
        const [first, second] = splitPair(start, index, delta, min);
        setExtent(items[index], prop, first);
        setExtent(items[index + 1], prop, second);
        sizes = start.map((value, i) => (i === index ? first : i === index + 1 ? second : value));
      },
      onEnd: ({ cancelled }) => {
        if (this.activeResize === drag) this.activeResize = null;
        // A cancelled drag puts the panes back where the layout has them.
        if (cancelled) { if (sizes) this._applyGeometry(); return; }
        if (!sizes || sizes[index] === start[index]) return;
        this.layout = resize(this.layout, kind === "col" ? rowId : null, sizes);
        this._persist();
        this._applyGeometry();
        globalThis.window?.dispatchEvent?.(new Event("resize"));
      },
    });
    this.activeResize = drag;
  }

  // ---------------------------------------------------------------------------------------------------- drops

  /** Where a drop at (x, y) would go, or null: a new row at the top/bottom, a new pane beside one, or a pane's tabs. */
  _dropTarget(event) {
    const drag = tabDragSession.current();
    if (!drag || drag.pageId !== this.pageId) return null;
    if (event.target?.closest?.(".tab-strip-slot")) return null;     // the tab rail takes its own drops
    const box = this.element.getBoundingClientRect();
    const rowsFull = this.layout.rows.length >= this.rows;
    if (!rowsFull && event.clientY - box.top < ROW_EDGE_PX) return { kind: "row", position: "top", rect: { left: box.left, top: box.top, width: box.width, height: ROW_EDGE_PX * 2 } };
    if (!rowsFull && box.bottom - event.clientY < ROW_EDGE_PX) return { kind: "row", position: "bottom", rect: { left: box.left, top: box.bottom - ROW_EDGE_PX * 2, width: box.width, height: ROW_EDGE_PX * 2 } };
    const paneElement = event.target?.closest?.("[data-pane-id]");
    const paneId = paneElement?.dataset?.paneId;
    if (!paneId || !this.panes.has(paneId)) return null;
    const rect = paneElement.getBoundingClientRect();
    const share = (event.clientX - rect.left) / Math.max(1, rect.width);
    const source = paneOfComponent(this.layout, drag.componentId);
    if (share < EDGE_SHARE || share > 1 - EDGE_SHARE) {
      if (source?.id === paneId && source.componentIds.length === 1) return null;   // nothing to split off
      const side = share < EDGE_SHARE ? "left" : "right";
      return { kind: "split", paneId, side, rect: { left: side === "left" ? rect.left : rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height } };
    }
    if (source?.id === paneId) return null;
    return { kind: "join", paneId, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
  }

  _bindDrops() {
    const over = (event) => {
      const target = this._dropTarget(event);
      if (!target) { this._hideIndicator(); return; }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      this._showIndicator(target);
    };
    const drop = (event) => {
      const target = this._dropTarget(event);
      this._hideIndicator();
      if (!target) return;
      event.preventDefault();
      const componentId = tabDragSession.current().componentId;
      tabDragSession.end();
      const options = this._options();
      if (target.kind === "row") this.apply(addRow(this.layout, componentId, target.position, { ...options, maxRows: this.rows }));
      else if (target.kind === "split") this.apply(splitPane(this.layout, componentId, target.paneId, target.side, options));
      else this.apply(moveTab(this.layout, componentId, target.paneId, null, options));
    };
    const leave = (event) => { if (!this.element.contains(event.relatedTarget)) this._hideIndicator(); };
    this.element.addEventListener("dragover", over);
    this.element.addEventListener("drop", drop);
    this.element.addEventListener("dragleave", leave);
    this.cleanup.push(() => {
      this.element.removeEventListener("dragover", over);
      this.element.removeEventListener("drop", drop);
      this.element.removeEventListener("dragleave", leave);
    });
  }

  _showIndicator(target) {
    const box = this.element.getBoundingClientRect();
    Object.assign(this.indicator.style, {
      left: `${Math.round(target.rect.left - box.left)}px`, top: `${Math.round(target.rect.top - box.top)}px`,
      width: `${Math.round(target.rect.width)}px`, height: `${Math.round(target.rect.height)}px`,
    });
    this.indicator.dataset.kind = target.kind;
    this.indicator.hidden = false;
  }

  _hideIndicator() {
    if (this.indicator) this.indicator.hidden = true;
  }

  // ---------------------------------------------------------------------------------------------------- lookup / life

  hostOf(componentId) {
    const pane = paneOfComponent(this.layout, componentId);
    return pane ? this.panes.get(pane.id)?.host || null : null;
  }

  resize() {
    this._applyGeometry();
    for (const { host } of this.panes.values()) host.resize();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // A drag still in progress lets go of its document listeners, pointer capture and the body's resize class.
    this.activeResize?.cancel();
    this.activeResize = null;
    for (const fn of this.cleanup.splice(0)) try { fn(); } catch (error) { console.warn("[pane workspace: cleanup] failed", error); }
    for (const { host } of this.panes.values()) host.destroy();
    this.panes.clear();
  }
}

/**
 * A pane layout from rows of slot ids, each slot's tabs, and the widths/heights of all but the last pane of a row /
 * row (px of rowWidth/workspaceHeight, or % of the row): a page's default arrangement written the way its slots read.
 */
export function layoutFromSlots({ rows, tabbedSlots, widths = [], heights = [], rowWidth = 0, workspaceHeight = 0 }) {
  const share = (value, total) => {
    const match = String(value || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)(px|%)$/);
    if (!match) return null;
    const number = Number(match[1]);
    return match[2] === "%" ? number / 100 : total > 0 ? number / total : null;
  };
  const sizesFor = (count, saved, total) => {
    const known = saved.slice(0, count - 1).map((value) => share(value, total));
    if (known.length !== count - 1 || known.some((value) => !(value > 0))) return Array(count).fill(1 / count);
    const rest = 1 - known.reduce((a, b) => a + b, 0);
    return rest > 0.05 ? [...known, rest] : Array(count).fill(1 / count);
  };
  const top = share(heights[0], workspaceHeight);
  const rowSizes = rows.length === 2 && top > 0.1 && top < 0.9 ? [top, 1 - top] : rows.map(() => 1 / rows.length);
  return {
    rows: rows.map((slotIds, rowIndex) => {
      const sizes = sizesFor(slotIds.length, widths[rowIndex] || [], rowWidth);
      return {
        id: `row-${rowIndex}`,
        size: rowSizes[rowIndex],
        panes: slotIds.map((slotId, index) => ({
          id: slotId, size: sizes[index],
          componentIds: [...(tabbedSlots?.[slotId]?.componentIds || [])],
          activeComponentId: tabbedSlots?.[slotId]?.activeComponentId || "",
        })),
      };
    }),
  };
}
