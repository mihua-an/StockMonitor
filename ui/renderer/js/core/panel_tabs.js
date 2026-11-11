import { escapeHtml } from "./utility.js";

function defaultKey(tab) {
  return String(tab?.key ?? tab?.id ?? "");
}

function defaultLabel(tab) {
  return String(tab?.label ?? tab?.name ?? tab?.key ?? tab?.id ?? "");
}

function panelTabMarkup(tab, { normalizedActiveKey, keyOf, labelOf, titleOf, countOf, closableOf, draggableOf }) {
  const key = String(keyOf(tab) ?? "");
  const label = String(labelOf(tab) ?? key);
  const active = key === normalizedActiveKey;
  const closable = Boolean(closableOf?.(tab));
  const draggable = Boolean(draggableOf?.(tab));
  const title = String(titleOf ? (titleOf(tab) ?? "") : label);
  const countValue = countOf ? countOf(tab) : null;
  const countMarkup = countValue === null || countValue === undefined || countValue === ""
    ? ""
    : ` <span class="panel-tab-count">${escapeHtml(countValue)}</span>`;

  return `
    <div class="panel-tab${active ? " active" : ""}${closable ? " closable" : ""}${draggable ? " reorderable" : ""}"
      role="presentation" data-panel-tab-wrapper-key="${escapeHtml(key)}"
      ${draggable ? 'draggable="true"' : ""}>
      <button type="button" class="panel-tab-main" data-panel-tab-key="${escapeHtml(key)}" role="tab" aria-selected="${active ? "true" : "false"}">${escapeHtml(label)}${countMarkup}</button>
      ${closable ? `<button type="button" class="panel-tab-close" data-panel-tab-close-key="${escapeHtml(key)}" aria-label="關閉 ${escapeHtml(label)}">×</button>` : ""}
    </div>
  `;
}

function bindTabButtons(host, { onSelect, onClose, onAdd }) {
  host.querySelectorAll("[data-panel-tab-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = String(button.dataset.panelTabKey || "");
      if (key && typeof onSelect === "function") onSelect(key, button);
    });
  });

  host.querySelectorAll("[data-panel-tab-close-key]").forEach((button) => {
    button.draggable = false;
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = String(button.dataset.panelTabCloseKey || "");
      if (key && typeof onClose === "function") onClose(key, button);
    });
  });

  host.querySelector("[data-panel-tab-add]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onAdd?.(event.currentTarget);
  });
}

// Drag a tab: within this rail (reorder) or, when the rail accepts it, from another rail. `drag.key` is this rail's
// own tab being dragged ("" otherwise).
function bindTabDrag(host, drag, { onReorder, onDragStartTab, onDragEndTab, acceptsExternal, onExternalDrop }) {
  host.querySelectorAll('[data-panel-tab-wrapper-key][draggable="true"]').forEach((wrapper) => {
    wrapper.addEventListener("dragstart", (event) => {
      if (event.target?.closest?.("[data-panel-tab-close-key]")) {
        event.preventDefault();
        return;
      }
      drag.key = String(wrapper.dataset.panelTabWrapperKey || "");
      wrapper.classList.add("dragging");
      event.dataTransfer?.setData?.("text/plain", drag.key);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      onDragStartTab?.(drag.key);
    });
    wrapper.addEventListener("dragend", () => {
      wrapper.classList.remove("dragging");
      host.querySelectorAll(".panel-tab.panel-tab-drop-before, .panel-tab.panel-tab-drop-after")
        .forEach((item) => item.classList.remove("panel-tab-drop-before", "panel-tab-drop-after"));
      drag.key = "";
      onDragEndTab?.();
    });
  });
  // Every tab is a drop target: for this rail's own drag (reorder) or, when accepted, another rail's tab.
  host.querySelectorAll("[data-panel-tab-wrapper-key]").forEach((wrapper) => {
    wrapper.addEventListener("dragover", (event) => {
      const external = !drag.key && acceptsExternal();
      if (!external && (!drag.key || drag.key === String(wrapper.dataset.panelTabWrapperKey || ""))) return;
      event.preventDefault();
      const rect = wrapper.getBoundingClientRect();
      const placement = event.clientX >= rect.left + rect.width / 2 ? "after" : "before";
      wrapper.classList.toggle("panel-tab-drop-before", placement === "before");
      wrapper.classList.toggle("panel-tab-drop-after", placement === "after");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    wrapper.addEventListener("dragleave", () => {
      wrapper.classList.remove("panel-tab-drop-before", "panel-tab-drop-after");
    });
    wrapper.addEventListener("drop", (event) => {
      event.preventDefault();
      const targetKey = String(wrapper.dataset.panelTabWrapperKey || "");
      const sourceKey = drag.key || String(event.dataTransfer?.getData?.("text/plain") || "");
      const rect = wrapper.getBoundingClientRect();
      const placement = event.clientX >= rect.left + rect.width / 2 ? "after" : "before";
      wrapper.classList.remove("panel-tab-drop-before", "panel-tab-drop-after");
      if (!drag.key && acceptsExternal()) {
        event.stopPropagation();
        onExternalDrop?.(targetKey, placement);
        return;
      }
      if (sourceKey && targetKey && sourceKey !== targetKey && typeof onReorder === "function") {
        onReorder(sourceKey, targetKey, placement, wrapper);
      }
    });
  });
}

// The rail beside the tabs: another rail's tab dropped there is appended. Bound once per host; it calls the
// callbacks the latest render installed.
function bindRailDrop(host) {
  if (host.dataset.panelTabsExternalBound) return;
  host.dataset.panelTabsExternalBound = "1";
  host.addEventListener("dragover", (event) => {
    if (!host.__panelTabsAcceptsExternal?.() || event.target?.closest?.("[data-panel-tab-wrapper-key]")) return;
    event.preventDefault();
    host.classList.add("panel-tabs-drop-rail");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  host.addEventListener("dragleave", (event) => {
    if (!host.contains(event.relatedTarget)) host.classList.remove("panel-tabs-drop-rail");
  });
  host.addEventListener("drop", (event) => {
    host.classList.remove("panel-tabs-drop-rail");
    if (!host.__panelTabsAcceptsExternal?.() || event.target?.closest?.("[data-panel-tab-wrapper-key]")) return;
    event.preventDefault();
    host.__panelTabsExternalDrop?.(null, "after");
  });
}

/**
 * Shared compact panel-tab renderer.
 *
 * Contract:
 * - The tab rail itself is the only horizontally scrollable region.
 * - Sibling right-side controls live outside this host and therefore never scroll.
 * - Tabs are edge-flush and separated by a divider; no extra pill/frame wrapper.
 * - Optional close controls are part of the same visual tab, not a second button box.
 * - Optional add/reorder behavior is opt-in; existing read-only tab rails are unchanged.
 * - Cross-rail moves are opt-in too: onDragStartTab / onDragEndTab announce a drag to whoever coordinates the rails
 *   (the 即時報價 pane workspace), and a rail that `acceptsExternal()` takes a tab dropped from another rail through
 *   onExternalDrop(targetKey | null, placement) -- null when dropped on the rail beside the tabs (append).
 */
export function renderPanelTabs(host, {
  tabs = [],
  activeKey = "",
  keyOf = defaultKey,
  labelOf = defaultLabel,
  titleOf = null,
  countOf = null,
  closableOf = (tab) => Boolean(tab?.closable),
  draggableOf = () => false,
  align = "start",
  onSelect = null,
  onClose = null,
  onAdd = null,
  onReorder = null,
  onDragStartTab = null,
  onDragEndTab = null,
  acceptsExternal = () => false,
  onExternalDrop = null,
  scrollActive = true,
} = {}) {
  if (!host) return;

  const normalizedActiveKey = String(activeKey ?? "");
  host.classList.add("panel-tabs");
  host.classList.toggle("panel-tabs-end", align === "end");
  const tabMarkup = (Array.isArray(tabs) ? tabs : []).map((tab) => panelTabMarkup(tab,
    { normalizedActiveKey, keyOf, labelOf, titleOf, countOf, closableOf, draggableOf })).join("");
  const addMarkup = typeof onAdd === "function"
    ? '<button type="button" class="panel-tab-add" data-panel-tab-add aria-label="新增功能頁">+</button>'
    : "";
  host.innerHTML = tabMarkup + addMarkup;

  bindTabButtons(host, { onSelect, onClose, onAdd });
  const drag = { key: "" };
  bindTabDrag(host, drag, { onReorder, onDragStartTab, onDragEndTab, acceptsExternal, onExternalDrop });
  bindRailDrop(host);
  // Rebinding replaces the callbacks the rail-level listeners call (they are bound once per host).
  host.__panelTabsAcceptsExternal = () => !drag.key && acceptsExternal();
  host.__panelTabsExternalDrop = (targetKey, placement) => onExternalDrop?.(targetKey, placement);

  if (scrollActive) {
    requestAnimationFrame(() => {
      host.querySelector(".panel-tab.active")?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    });
  }
}
