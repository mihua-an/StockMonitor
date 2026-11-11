// A pane workspace of any shape (畫面配置): renders a pane tree (pane_tree.js), keeps one TabbedComponentHost per pane,
// takes tab drops on the four edges of a pane and resizes with splitters. The layout is its owner's to store: every
// change is handed to `onChange`.
//
// Data is not this file's business, as in pane_workspace.js: a component subscribes when it mounts and lets go when it
// is destroyed, whichever pane it is in. A change re-renders only the panes it touched.
import { TabbedComponentHost } from "./tabbed_component_host.js";
import { normalizeTree, treePanes, findTreePane, paneOfTreeComponent, moveTreeTab, splitTreePane, setTreePaneTabs, resizeTreeSplit } from "./pane_tree.js";
import { pixelExtents } from "./pane_layout.js";
import { tabDragSession } from "./tab_drag_session.js";
import { beginSplitterDrag, splitPair } from "./splitter_drag.js";
import { discardTrendSurfaces } from "./trend_surface_state.js";

const GAP = 8;               // the space between panes (the splitters live in it)
const MIN_PANE_PX = 160;
const MIN_ROW_PX = 150;
const EDGE_SHARE = 0.22;     // a drop in a pane's outer 22% opens a new pane on that side

function setExtent(element, prop, px) {
  element.style.setProperty(prop, `${px}px`);
}

export class TreeWorkspace {
  // `decoratePane(element, pane)`: the page's own marks on a pane, after every change of its tabs.
  constructor({ pageId, element, context, registry, initialTree, onChange = null, decoratePane = null }) {
    this.pageId = String(pageId);
    this.element = element;
    this.context = context;
    this.registry = registry;
    this.initialTree = initialTree;
    this.onChange = onChange;
    this.decoratePane = decoratePane;
    this.panes = new Map();                 // pane id -> { element, host }
    this.splits = new Map();                // split id -> element
    this.cleanup = [];
    this.layout = null;
    this.indicator = null;
    this.activeResize = null;
    this.destroyed = false;
  }

  get hosts() {
    return new Map([...this.panes.entries()].map(([id, pane]) => [id, pane.host]));
  }

  _isKnown(componentId) {
    return Boolean(this.registry.get(componentId)) && this.registry.supports(componentId, { mode: this.context?.mode, slotId: "workspacePane", hostType: "inline" });
  }

  _normalize(raw) {
    return normalizeTree(raw, { isKnown: (id) => this._isKnown(id) });
  }

  mount() {
    this.layout = this._normalize(this.initialTree);
    this.element.classList.add("pane-mode");
    this.indicator = document.createElement("div");
    this.indicator.className = "pane-drop-indicator";
    this.indicator.hidden = true;
    this._render(null);
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

  /** Show another saved layout. It is the owner's already: nothing is reported back. */
  show(raw) {
    this._change(this._normalize(raw), { report: false });
  }

  _change(next, { report = true } = {}) {
    if (this.destroyed || !next || next === this.layout) return;
    const previous = this.layout;
    this.layout = next;
    if (report) this.onChange?.(next);
    this._render(previous);
    globalThis.window?.dispatchEvent?.(new Event("resize"));
  }

  _render(previous) {
    const wanted = new Map(treePanes(this.layout).map((pane) => [pane.id, pane]));
    // 1. Panes that are gone: their components let go first.
    for (const [id, entry] of [...this.panes.entries()]) {
      if (wanted.has(id)) continue;
      entry.host.destroy();
      entry.element.remove();
      this.panes.delete(id);
      discardTrendSurfaces(id);
    }
    // 2. Panes that lost a tab before panes that gained one: a moved component is destroyed before it mounts again.
    const before = (id) => (previous ? findTreePane(previous, id)?.componentIds || [] : []);
    const losing = [], gaining = [];
    for (const [id, entry] of this.panes.entries()) {
      const pane = wanted.get(id);
      (before(id).some((componentId) => !pane.componentIds.includes(componentId)) ? losing : gaining).push([entry, pane]);
    }
    for (const [entry, pane] of [...losing, ...gaining]) entry.host.setTabs(pane.componentIds, pane.activeComponentId);
    // 3. New panes; their components mount only once the pane is in the document (step 4).
    const fresh = [];
    for (const [id, pane] of wanted.entries()) {
      if (this.panes.has(id)) continue;
      const element = document.createElement("div");
      element.className = "dashboard-card";
      element.dataset.componentSlot = id;
      element.dataset.paneId = id;
      const host = new TabbedComponentHost({
        host: element, hostId: `${this.pageId}:${id}`, pageId: this.pageId, slotId: id, context: this.context, registry: this.registry,
        config: { componentIds: pane.componentIds, activeComponentId: pane.activeComponentId },
        onConfigChange: (config) => queueMicrotask(() => this._paneChanged(id, config)),
        onExternalTabDrop: (componentId, index) => this._change(moveTreeTab(this.layout, componentId, id, index)),
        isPlacedElsewhere: (componentId) => {
          const holder = paneOfTreeComponent(this.layout, componentId);
          return Boolean(holder && holder.id !== id);
        },
      });
      this.panes.set(id, { element, host });
      fresh.push(host);
    }
    // 4. Structure.
    const used = new Set();
    this.element.replaceChildren(this._nodeElement(this.layout, used), this.indicator);
    for (const id of [...this.splits.keys()]) if (!used.has(id)) this.splits.delete(id);
    this._applyGeometry();
    for (const [id, pane] of wanted.entries()) this.decoratePane?.(this.panes.get(id).element, pane);
    for (const host of fresh) host.mount();
  }

  _nodeElement(node, used) {
    if (node.kind === "pane") return this.panes.get(node.id).element;
    used.add(node.id);
    const element = this.splits.get(node.id) || Object.assign(document.createElement("div"), { className: "pane-tree-split" });
    element.dataset.dir = node.dir;
    this.splits.set(node.id, element);
    const children = [];
    node.children.forEach((child, index) => {
      if (index) children.push(this._splitter(node.id, node.dir, index - 1));
      children.push(this._nodeElement(child, used));
    });
    element.replaceChildren(...children);
    return element;
  }

  _paneChanged(id, config) {
    if (this.destroyed || !findTreePane(this.layout, id)) return;
    this._change(setTreePaneTabs(this.layout, id, config.componentIds || [], config.activeComponentId || ""));
  }

  _elementOf(node) {
    return node.kind === "pane" ? this.panes.get(node.id)?.element : this.splits.get(node.id);
  }

  /** Whole-pixel extents for every split and pane (a half-pixel edge renders as a blurred, lighter frame line). */
  _applyGeometry() {
    if (this.destroyed || !this.layout) return;
    const width = this.element.clientWidth, height = this.element.clientHeight;
    if (!(width > 0 && height > 0)) return;
    const place = (node, w, h) => {
      const element = this._elementOf(node);
      if (!element) return;
      setExtent(element, "width", w);
      setExtent(element, "height", h);
      if (node.kind !== "split") return;
      const extents = pixelExtents(node.children.map((child) => child.size), node.dir === "row" ? w : h, GAP);
      node.children.forEach((child, index) => place(child, node.dir === "row" ? extents[index] : w, node.dir === "row" ? h : extents[index]));
    };
    place(this.layout, width, height);
  }

  _splitter(splitId, dir, index) {
    const kind = dir === "row" ? "col" : "row";
    const splitter = document.createElement("div");
    splitter.className = `pane-splitter pane-splitter-${kind}`;
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", kind === "col" ? "vertical" : "horizontal");
    splitter.addEventListener("pointerdown", (event) => this._beginResize(event, splitter, splitId, dir, index));
    return splitter;
  }

  _findSplit(node, id) {
    if (node.kind !== "split") return null;
    return node.id === id ? node : node.children.map((child) => this._findSplit(child, id)).find(Boolean) || null;
  }

  _beginResize(event, splitter, splitId, dir, index) {
    const split = this._findSplit(this.layout, splitId);
    if (!split) return;
    const items = split.children.map((child) => this._elementOf(child));
    const prop = dir === "row" ? "width" : "height";
    const start = items.map((item) => item.getBoundingClientRect()[prop]);
    let sizes = null;
    this.activeResize?.cancel();
    const drag = beginSplitterDrag(event, splitter, {
      axis: dir === "row" ? "x" : "y",
      onMove: (delta) => {
        const [first, second] = splitPair(start, index, delta, dir === "row" ? MIN_PANE_PX : MIN_ROW_PX);
        sizes = start.map((value, i) => (i === index ? first : i === index + 1 ? second : value));
        const next = resizeTreeSplit(this.layout, splitId, sizes);
        this.layout = next;
        this._applyGeometry();
      },
      onEnd: ({ cancelled }) => {
        if (this.activeResize === drag) this.activeResize = null;
        if (cancelled) {
          if (sizes) { this.layout = resizeTreeSplit(this.layout, splitId, start); this._applyGeometry(); }
          return;
        }
        if (!sizes || sizes[index] === start[index]) return;
        this.onChange?.(this.layout);
        globalThis.window?.dispatchEvent?.(new Event("resize"));
      },
    });
    this.activeResize = drag;
  }

  /** Where a drop at (x, y) would go, or null: a new pane on an edge of a pane, or that pane's tabs. */
  _dropTarget(event) {
    const drag = tabDragSession.current();
    if (!drag || drag.pageId !== this.pageId) return null;
    if (event.target?.closest?.(".tab-strip-slot")) return null;     // the tab rail takes its own drops
    const paneElement = event.target?.closest?.("[data-pane-id]");
    const paneId = paneElement?.dataset?.paneId;
    if (!paneId || !this.panes.has(paneId)) return null;
    const rect = paneElement.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width), y = (event.clientY - rect.top) / Math.max(1, rect.height);
    const source = paneOfTreeComponent(this.layout, drag.componentId);
    const edge = x < EDGE_SHARE ? "left" : x > 1 - EDGE_SHARE ? "right" : y < EDGE_SHARE ? "top" : y > 1 - EDGE_SHARE ? "bottom" : "";
    if (edge) {
      if (source?.id === paneId && source.componentIds.length === 1) return null;   // nothing to split off
      const across = edge === "left" || edge === "right";
      return { kind: "split", paneId, edge, rect: {
        left: edge === "right" ? rect.left + rect.width / 2 : rect.left, top: edge === "bottom" ? rect.top + rect.height / 2 : rect.top,
        width: across ? rect.width / 2 : rect.width, height: across ? rect.height : rect.height / 2,
      } };
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
      this._change(target.kind === "split" ? splitTreePane(this.layout, componentId, target.paneId, target.edge) : moveTreeTab(this.layout, componentId, target.paneId));
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

  hostOf(componentId) {
    const pane = paneOfTreeComponent(this.layout, componentId);
    return pane ? this.panes.get(pane.id)?.host || null : null;
  }

  resize() {
    this._applyGeometry();
    for (const { host } of this.panes.values()) host.resize();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.activeResize?.cancel();
    this.activeResize = null;
    for (const fn of this.cleanup.splice(0)) try { fn(); } catch (error) { console.warn("[tree workspace: cleanup] failed", error); }
    for (const { host } of this.panes.values()) host.destroy();
    this.panes.clear();
    this.splits.clear();
  }
}
