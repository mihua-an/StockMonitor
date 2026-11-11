import { ComponentHost } from "./component_host.js";
import { renderPanelTabs } from "./panel_tabs.js";
import { escapeHtml } from "./utility.js";
import { tabDragSession } from "./tab_drag_session.js";

const BLANK_TAB_ID = "__dashboard_blank_tab__";

function unique(items = []) {
  return [...new Set((Array.isArray(items) ? items : []).map(String).filter(Boolean))];
}

function chooserLabel(title = "") {
  return String(title || "").replace(/^(?:Shioaji|Futu)\s+/i, "").trim();
}

export class TabbedComponentHost {
  constructor({ host, hostId, pageId, slotId, context, registry, config, onConfigChange, onExternalTabDrop = null, isPlacedElsewhere = null,
    fixedTabs = false }) {
    if (!host) throw new Error("TabbedComponentHost requires host element");
    this.host = host;
    this.hostId = hostId;
    this.pageId = pageId;
    this.slotId = slotId;
    this.context = context;
    this.registry = registry;
    this.onConfigChange = onConfigChange;
    // Pane workspace hooks (即時報價): a tab dropped here from another pane, and features already placed in
    // another pane (the add-feature page offers each feature once per page).
    this.onExternalTabDrop = onExternalTabDrop;
    this.isPlacedElsewhere = isPlacedElsewhere;
    // A page whose features are fixed (歷史回放): its tabs move but are never closed, and no feature is added.
    this.fixedTabs = Boolean(fixedTabs);
    this.componentIds = unique(config?.componentIds);
    this.activeComponentId = this.componentIds.includes(String(config?.activeComponentId || ""))
      ? String(config.activeComponentId)
      : this.componentIds[0] || "";
    this.blankOpen = this.componentIds.length === 0;
    this.destroyed = false;

    const originalNodes = [...host.childNodes];
    this.header = document.createElement("div");
    this.header.className = "tab-strip tab-strip-slot";
    // The actions box on the right of the tabs: the active component's title-bar controls go here, since its own
    // title strip is hidden in a slot (ComponentHost hands it over as actionsHost).
    this.header.innerHTML = `<div class="tab-list panel-tabs-slot" data-role="panel-tabs-slot" role="tablist"></div><div class="tab-strip-actions" data-role="slot-actions"></div>`;
    this.content = document.createElement("div");
    this.content.className = "dashboard-slot-content";
    this.content.dataset.role = "dashboard-slot-content";
    // The slot's tab is the component's title: a component's own title strip stays hidden in here.
    this.content.dataset.componentTitle = "hidden";
    originalNodes.forEach((node) => this.content.appendChild(node));
    host.replaceChildren(this.header, this.content);
    host.classList.add("dashboard-tabbed-slot");

    this.componentHost = new ComponentHost({
      host: this.content,
      actionsHost: this.header.querySelector('[data-role="slot-actions"]'),
      hostId: `${hostId}:content`,
      hostType: "inline",
      pageId,
      slotId,
      context,
      registry,
      hydrate: true,
    });
  }

  get componentId() {
    return this.blankOpen ? "" : this.activeComponentId;
  }

  mount() {
    this._renderTabs();
    if (this.blankOpen || !this.activeComponentId) this._showChooser();
    else {
      this.componentHost.mount(this.activeComponentId);
      this._notifyActivation(this.activeComponentId);
    }
    return this;
  }

  _supportedDefinitions() {
    return this.registry.list().filter((definition) => definition.availableInSlotEditor !== false
      && this.registry.supports(definition.id, {
        mode: this.context?.mode,
        slotId: this.slotId,
        hostType: "inline",
      }));
  }

  _tabItems() {
    const items = this.componentIds.map((id) => this.registry.get(id)).filter(Boolean);
    if (this.blankOpen) items.push({ id: BLANK_TAB_ID, title: "空白分頁", provider: "" });
    return items;
  }

  _renderTabs() {
    const tabsHost = this.header.querySelector('[data-role="panel-tabs-slot"]');
    renderPanelTabs(tabsHost, {
      tabs: this._tabItems(),
      activeKey: this.blankOpen ? BLANK_TAB_ID : this.activeComponentId,
      keyOf: (definition) => definition.id,
      labelOf: (definition) => definition.id === BLANK_TAB_ID
        ? "空白分頁"
        : this.registry.tabTitleFor(definition.id, this.context?.mode),
      closableOf: () => !this.fixedTabs,
      draggableOf: (definition) => definition.id !== BLANK_TAB_ID,
      onSelect: (componentId) => {
        if (componentId === BLANK_TAB_ID) this._showChooser();
        else this.select(componentId);
      },
      onClose: (componentId) => this._closeTab(componentId),
      onAdd: this.fixedTabs ? null : () => this._openBlankTab(),
      onReorder: (sourceId, targetId, placement) => this._reorder(sourceId, targetId, placement),
      onDragStartTab: this.onExternalTabDrop ? (componentId) => tabDragSession.begin({ pageId: this.pageId, paneId: this.slotId, componentId }) : null,
      onDragEndTab: this.onExternalTabDrop ? () => tabDragSession.end() : null,
      acceptsExternal: () => {
        const drag = tabDragSession.current();
        return Boolean(this.onExternalTabDrop && drag && drag.pageId === this.pageId && drag.paneId !== this.slotId);
      },
      onExternalDrop: (targetId, placement) => {
        const drag = tabDragSession.current();
        if (!drag) return;
        const at = targetId ? this.componentIds.indexOf(targetId) + (placement === "after" ? 1 : 0) : this.componentIds.length;
        tabDragSession.end();
        this.onExternalTabDrop(drag.componentId, Math.max(0, at));
      },
    });
  }

  /** The workspace changed this pane's tabs (a tab moved in or out): show them, switching content only if needed. */
  setTabs(componentIds, activeComponentId) {
    const ids = [...new Set((componentIds || []).map(String).filter(Boolean))];
    const active = ids.includes(String(activeComponentId || "")) ? String(activeComponentId) : ids[0] || "";
    const sameList = ids.length === this.componentIds.length && ids.every((id, index) => id === this.componentIds[index]);
    if (sameList && active === this.activeComponentId && !this.blankOpen) return false;
    const contentChanged = this.blankOpen || active !== this.activeComponentId;
    this.componentIds = ids;
    this.activeComponentId = active;
    if (!ids.length) {
      this.blankOpen = true;
      this._renderTabs();
      this._showChooser();
      return true;
    }
    this.blankOpen = false;
    this._renderTabs();
    if (contentChanged) {
      this.componentHost.switchComponent(active);
      this._notifyActivation(active);
    }
    return true;
  }

  _persist() {
    const next = {
      componentIds: [...this.componentIds],
      activeComponentId: this.activeComponentId,
    };
    this.onConfigChange?.(next);
    return next;
  }

  _notifyActivation(componentId) {
    try {
      const result = this.context?.services?.dashboard?.onComponentActivate?.({
        componentId,
        pageId: this.pageId,
        slotId: this.slotId,
      });
      result?.catch?.((error) => console.warn("[TabbedComponentHost] activation failed", error));
    } catch (error) {
      console.warn("[TabbedComponentHost] activation failed", error);
    }
  }

  _openBlankTab() {
    this.blankOpen = true;
    this._renderTabs();
    this._showChooser();
  }

  _showChooser() {
    this.blankOpen = true;
    this.componentHost.clear();
    const supported = new Map(this._supportedDefinitions().map((definition) => [definition.id, definition]));

    const renderButtons = (ids = []) => {
      const items = ids.map((id) => supported.get(id)).filter(Boolean);
      if (!items.length) return '<span class="dashboard-add-cell-empty" aria-hidden="true"></span>';
      return items.map((definition) => {
        const alreadyAdded = this.componentIds.includes(definition.id) || Boolean(this.isPlacedElsewhere?.(definition.id));
        const title = chooserLabel(this.registry.titleFor(definition.id, this.context?.mode));
        return `<button type="button" class="dashboard-add-feature-btn${alreadyAdded ? " is-added" : ""}"
          data-dashboard-add-component="${escapeHtml(definition.id)}" ${alreadyAdded ? "disabled" : ""}>
          <span class="dashboard-add-feature-label">${escapeHtml(title)}</span>${alreadyAdded ? '<span class="dashboard-add-feature-state" aria-hidden="true">✓</span>' : ""}
        </button>`;
      }).join("");
    };

    const rows = this.registry.chooserRows().map((row) => `<div class="dashboard-add-row">
      <div class="dashboard-add-cell" data-provider="shioaji">${renderButtons(row.shioaji)}</div>
      <div class="dashboard-add-cell" data-provider="futu">${renderButtons(row.futu)}</div>
    </div>`).join("");

    this.content.innerHTML = `<div class="dashboard-add-page" data-role="dashboard-add-page">
      <div class="dashboard-add-title">新增功能頁</div>
      <div class="dashboard-add-matrix">
        <div class="dashboard-add-header dashboard-add-cell">Shioaji</div>
        <div class="dashboard-add-header dashboard-add-cell">Futu</div>
        ${rows}
      </div>
    </div>`;

    this.content.querySelectorAll("[data-dashboard-add-component]").forEach((button) => {
      button.addEventListener("click", () => this._chooseBlankComponent(button.dataset.dashboardAddComponent));
    });
  }

  _chooseBlankComponent(componentId) {
    const nextId = String(componentId || "");
    if (!nextId || this.componentIds.includes(nextId) || this.isPlacedElsewhere?.(nextId)) return false;
    if (!this.registry.supports(nextId, {
      mode: this.context?.mode,
      slotId: this.slotId,
      hostType: "inline",
    })) return false;

    this.componentIds.push(nextId);
    this.activeComponentId = nextId;
    this.blankOpen = false;
    this._persist();
    this._renderTabs();
    this.componentHost.switchComponent(nextId);
    this._notifyActivation(nextId);
    return true;
  }

  select(componentId, { persist = true, notify = true } = {}) {
    const nextId = String(componentId || "");
    if (!this.componentIds.includes(nextId)) return false;
    const changed = this.activeComponentId !== nextId || this.blankOpen;
    // A stock-symbol change can assert the already-active stock trend tab.
    // Treat that as a real no-op: rebuilding the tab strip here forces layout
    // across the whole dashboard even though neither tabs nor content changed.
    if (!changed) return false;
    this.blankOpen = false;
    this.activeComponentId = nextId;
    if (persist) this._persist();
    this._renderTabs();
    this.componentHost.switchComponent(nextId);
    if (notify) this._notifyActivation(nextId);
    return true;
  }

  switchComponent(componentId) {
    const nextId = String(componentId || "");
    if (!this.registry.supports(nextId, {
      mode: this.context?.mode,
      slotId: this.slotId,
      hostType: "inline",
    })) return null;
    if (!this.componentIds.includes(nextId)) this.componentIds.push(nextId);
    this.blankOpen = false;
    this.activeComponentId = nextId;
    this._persist();
    this._renderTabs();
    const component = this.componentHost.switchComponent(nextId);
    this._notifyActivation(nextId);
    return component;
  }

  _closeTab(componentId) {
    const id = String(componentId || "");
    if (id === BLANK_TAB_ID) {
      this.blankOpen = false;
      this._renderTabs();
      if (this.activeComponentId && this.componentIds.includes(this.activeComponentId)) {
        this.componentHost.switchComponent(this.activeComponentId);
        this._notifyActivation(this.activeComponentId);
      } else if (this.componentIds.length) {
        this.activeComponentId = this.componentIds[0];
        this._persist();
        this.componentHost.switchComponent(this.activeComponentId);
        this._notifyActivation(this.activeComponentId);
      } else {
        this.blankOpen = true;
        this._renderTabs();
        this._showChooser();
      }
      return true;
    }

    const index = this.componentIds.indexOf(id);
    if (index < 0) return false;
    const wasActive = !this.blankOpen && this.activeComponentId === id;
    this.componentIds.splice(index, 1);

    if (!this.componentIds.length) {
      this.activeComponentId = "";
      this.blankOpen = true;
      this._persist();
      this._renderTabs();
      this._showChooser();
      return true;
    }

    if (wasActive || !this.componentIds.includes(this.activeComponentId)) {
      this.activeComponentId = this.componentIds[Math.min(index, this.componentIds.length - 1)];
    }
    this._persist();
    this._renderTabs();
    if (!this.blankOpen) {
      this.componentHost.switchComponent(this.activeComponentId);
      this._notifyActivation(this.activeComponentId);
    } else {
      this._showChooser();
    }
    return true;
  }

  _reorder(sourceId, targetId, placement = "before") {
    const source = String(sourceId || "");
    const target = String(targetId || "");
    if (!source || !target || source === target) return false;
    const from = this.componentIds.indexOf(source);
    const targetBeforeRemoval = this.componentIds.indexOf(target);
    if (from < 0 || targetBeforeRemoval < 0) return false;

    const next = [...this.componentIds];
    next.splice(from, 1);
    let targetIndex = next.indexOf(target);
    if (targetIndex < 0) return false;
    if (placement === "after") targetIndex += 1;
    next.splice(targetIndex, 0, source);
    if (next.every((id, index) => id === this.componentIds[index])) return false;

    this.componentIds = next;
    this._persist();
    this._renderTabs();
    return true;
  }

  resize() {
    this.componentHost.resize();
  }

  destroy() {
    if (this.destroyed) return;
    this.componentHost.destroy();
    // Retain only the component DOM for the next page mount, not this host's
    // tab chrome. Otherwise every resume nests another header/content shell.
    this.host.replaceChildren(...this.content.childNodes);
    this.host.classList.remove("dashboard-tabbed-slot");
    this.destroyed = true;
  }
}
