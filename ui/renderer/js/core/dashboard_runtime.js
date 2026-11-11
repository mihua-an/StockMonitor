import { ComponentHost } from "./component_host.js";
import { TabbedComponentHost } from "./tabbed_component_host.js";
import { componentRegistry } from "./component_registry.js";
import { loadLayoutConfig, setSlotComponent, setTabbedSlot, DEFAULT_LAYOUTS } from "./layout_config.js";
import { PaneWorkspace } from "./pane_workspace.js";

const mountedPages = new Map();

/**
 * `panes`: { selector, storageKey, defaultLayout({ element, tabbedSlots }), rows } turns the element at
 * `selector` into a draggable pane workspace instead of fixed slots. The workspace's layout lives only under
 * `storageKey` (layout_state_store.js); defaultLayout builds the first one from the page's
 * default tabs (layout_config.js DEFAULT_LAYOUTS). `rows` and `fixedTabs` are the workspace's (pane_workspace.js): 歷史回放's
 * lower row is one row of panes whose features are fixed. The page's slots outside the workspace element are fixed
 * slots, read from the fixed-slot layout store as on a page without a workspace.
 */
export function mountDashboardPage({ pageId, root = document, context, panes = null }) {
  destroyDashboardPage(pageId);
  const workspaceElement = panes ? root.querySelector?.(panes.selector) : null;
  if (workspaceElement) {
    const defaultTabs = DEFAULT_LAYOUTS[String(pageId)]?.tabbedSlots || {};
    // `Workspace` + `workspaceOptions`: a workspace of another kind, whose layout its owner keeps (畫面配置).
    const workspace = panes.Workspace
      ? new panes.Workspace({ pageId: String(pageId), element: workspaceElement, context, registry: componentRegistry, ...panes.workspaceOptions })
      : new PaneWorkspace({
        pageId: String(pageId), element: workspaceElement, context, registry: componentRegistry, storageKey: panes.storageKey,
        defaultLayout: () => panes.defaultLayout({ element: null, tabbedSlots: defaultTabs }),
        rows: panes.rows, fixedTabs: Boolean(panes.fixedTabs),
      });
    // The page's fixed slots outside the workspace (歷史回放's top half) mount as on a page without one.
    const fixed = mountFixedSlots({ pageId, root, context, outside: workspaceElement, fixedTabs: Boolean(panes.fixedTabs) });
    const mounted = {
      pageId: String(pageId), context, workspace, fixedLayout: fixed.layout, fixedHosts: fixed.hosts,
      get layout() { return workspace.layout; }, get hosts() { return workspace.hosts; },
    };
    mountedPages.set(String(pageId), mounted);
    workspace.mount();
    return mounted;
  }
  const { layout, hosts } = mountFixedSlots({ pageId, root, context, outside: null, fixedTabs: false });
  mountedPages.set(String(pageId), { pageId: String(pageId), context, layout, hosts });
  return mountedPages.get(String(pageId));
}

// The page's slots its layout config names (a slot inside the pane workspace `outside` belongs to the workspace).
function mountFixedSlots({ pageId, root, context, outside, fixedTabs }) {
  const hosts = new Map();
  const elements = [...(root.querySelectorAll?.(`[data-component-slot]`) || [])].filter((element) => !outside?.contains?.(element));
  // A page that is all workspace (即時報價) has no fixed layout to read.
  if (outside && !elements.length) return { layout: null, hosts };
  const layout = loadLayoutConfig(pageId, componentRegistry);
  elements.forEach((element) => {
    const slotId = String(element.dataset.componentSlot || "");
    if (!slotId || !(slotId in layout.slots)) return;
    const tabbedConfig = layout.tabbedSlots?.[slotId];
    const host = tabbedConfig ? new TabbedComponentHost({
      host: element, hostId: `${pageId}:${slotId}`, pageId, slotId, context,
      registry: componentRegistry, config: tabbedConfig, fixedTabs,
      onConfigChange: (nextConfig) => {
        // A refused save is logged by layout_config / preferences; the tabs stay as the user set them for now.
        const result = setTabbedSlot(pageId, slotId, nextConfig, componentRegistry);
        const mounted = mountedPages.get(String(pageId));
        if (!result.ok || !mounted) return;
        if (mounted.workspace) mounted.fixedLayout = result.config;
        else mounted.layout = result.config;
      },
    }) : new ComponentHost({
      host: element, hostId: `${pageId}:${slotId}`, hostType: "inline", pageId, slotId,
      context, registry: componentRegistry, hydrate: element.dataset.componentHydrate !== "0",
    });
    if (tabbedConfig) host.mount(); else host.mount(layout.slots[slotId]);
    hosts.set(slotId, host);
  });
  return { layout, hosts };
}

// Show `componentId` in a fixed, untabbed slot and keep it as the page's layout. Nothing is stored unless the slot shows the
// component; a layout storage refused puts the slot back on what it showed, so screen and storage agree.
export function switchDashboardSlot(pageId, slotId, componentId) {
  const mounted = mountedPages.get(String(pageId));
  if (!mounted) return { ok: false, error: "page_not_mounted" };
  const host = mounted.workspace ? null : mounted.hosts.get(String(slotId));
  if (host instanceof TabbedComponentHost) return { ok: false, error: "slot_is_tabbed" };
  if (!(host instanceof ComponentHost)) return { ok: false, error: "slot_not_mounted" };
  if (!componentRegistry.supports(String(componentId), { mode: mounted.context?.mode, slotId: String(slotId), hostType: host.hostType })) {
    return { ok: false, error: "unsupported_component" };
  }
  const previousId = host.componentId;
  if (!host.switchComponent(componentId)) return { ok: false, error: "switch_failed" };
  const result = setSlotComponent(pageId, slotId, componentId, componentRegistry);
  if (!result.ok) {
    if (previousId) host.switchComponent(previousId);
    return result;
  }
  mounted.layout = result.config;
  return { ok: true, config: mounted.layout };
}

/** Bring `componentId` to the front wherever it is placed on the page; false when it is not on the page. */
export function selectDashboardComponent(pageId, componentId, options = {}) {
  const mounted = mountedPages.get(String(pageId));
  if (!mounted) return false;
  const host = mounted.workspace
    ? mounted.workspace.hostOf(String(componentId))
    : [...mounted.hosts.values()].find((item) => item instanceof TabbedComponentHost && item.componentIds.includes(String(componentId)));
  return host ? host.select(componentId, options) : false;
}

/**
 * The mounted instance of `componentId` on the page: the component a slot or pane is showing right now, so a page reaches
 * a component's own nodes (個股走勢's canvas) through it instead of a document id. null when it is not showing.
 */
export function mountedDashboardComponent(pageId, componentId) {
  const mounted = mountedPages.get(String(pageId));
  if (!mounted) return null;
  const id = String(componentId);
  const hosts = mounted.workspace ? [mounted.workspace.hostOf(id)].filter(Boolean) : [...mounted.hosts.values()];
  for (const host of hosts) {
    const content = host instanceof TabbedComponentHost ? host.componentHost : host;
    if (content?.componentId === id && content.component) return content.component;
  }
  return null;
}

export function selectDashboardTab(pageId, slotId, componentId, options = {}) {
  const mounted = mountedPages.get(String(pageId));
  if (!mounted) return false;
  const host = mounted.hosts.get(String(slotId));
  if (!(host instanceof TabbedComponentHost)) return false;
  return host.select(componentId, options);
}

export function resizeDashboardPage(pageId) {
  const mounted = mountedPages.get(String(pageId));
  if (mounted?.workspace) {
    mounted.workspace.resize();
    mounted.fixedHosts.forEach((host) => host.resize());
  } else mounted?.hosts?.forEach((host) => host.resize());
}

/** The page's mounted workspace, or null. */
export function dashboardWorkspace(pageId) {
  return mountedPages.get(String(pageId))?.workspace || null;
}

export function destroyDashboardPage(pageId) {
  const key = String(pageId);
  const mounted = mountedPages.get(key);
  if (!mounted) return;
  if (mounted.workspace) {
    mounted.workspace.destroy();
    mounted.fixedHosts.forEach((host) => host.destroy());
  } else mounted.hosts.forEach((host) => host.destroy());
  mountedPages.delete(key);
}

export function getDashboardDiagnostics(pageId = null) {
  const items = pageId == null ? [...mountedPages.values()] : [mountedPages.get(String(pageId))].filter(Boolean);
  return items.map((item) => ({
    pageId: item.pageId,
    contextId: item.context?.id || "",
    symbolListeners: item.context?.symbolStore?.listenerCount?.() || 0,
    dataListeners: item.context?.dataSource?.listenerCount?.() || 0,
    slots: [...item.hosts.entries()].map(([slotId, host]) => ({ slotId, componentId: host.componentId })),
  }));
}

if (typeof window !== "undefined") {
  window.__slotDashboard = Object.freeze({
    switchSlot: switchDashboardSlot,
    diagnostics: getDashboardDiagnostics,
    paneLayout: (pageId) => mountedPages.get(String(pageId))?.workspace?.layout || null,
  });
}
