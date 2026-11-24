import { componentRegistry } from "./component_registry.js";
import { TreeWorkspace } from "./tree_workspace.js";

const mountedPages = new Map();

/**
 * A page's dashboard: the pane workspace (tree_workspace.js) in the element at `selector`. `workspace`: the workspace's
 * own options -- its first tree, who keeps its changes, its pinned elements.
 */
export function mountDashboardPage({ pageId, root = document, context, selector, workspace: options = {} }) {
  destroyDashboardPage(pageId);
  const element = root.querySelector(selector);
  if (!element) throw new Error(`the ${pageId} page has no ${selector}`);
  const workspace = new TreeWorkspace({ pageId: String(pageId), element, context, registry: componentRegistry, ...options });
  const mounted = {
    pageId: String(pageId), context, workspace,
    get layout() { return workspace.layout; }, get hosts() { return workspace.hosts; },
  };
  mountedPages.set(String(pageId), mounted);
  workspace.mount();
  return mounted;
}

/** Bring `componentId` to the front wherever it is placed on the page; false when it is not on the page. */
export function selectDashboardComponent(pageId, componentId, options = {}) {
  const mounted = mountedPages.get(String(pageId));
  if (!mounted) return false;
  const host = mounted.workspace.hostOf(String(componentId));
  return host ? host.select(componentId, options) : false;
}

/**
 * The mounted instance of `componentId` on the page: the component a pane is showing right now, so a page reaches
 * a component's own nodes (個股走勢's canvas) through it instead of a document id. null when it is not showing.
 */
export function mountedDashboardComponent(pageId, componentId) {
  const mounted = mountedPages.get(String(pageId));
  if (!mounted) return null;
  const id = String(componentId);
  const content = mounted.workspace.hostOf(id)?.componentHost;
  return content?.componentId === id ? content.component : null;
}

export function selectDashboardTab(pageId, paneId, componentId, options = {}) {
  return mountedPages.get(String(pageId))?.hosts.get(String(paneId))?.select(componentId, options) ?? false;
}

export function resizeDashboardPage(pageId) {
  mountedPages.get(String(pageId))?.workspace.resize();
}

/** The page's mounted workspace, or null. */
export function dashboardWorkspace(pageId) {
  return mountedPages.get(String(pageId))?.workspace || null;
}

export function destroyDashboardPage(pageId) {
  const key = String(pageId);
  const mounted = mountedPages.get(key);
  if (!mounted) return;
  mounted.workspace.destroy();
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
    diagnostics: getDashboardDiagnostics,
    paneLayout: (pageId) => mountedPages.get(String(pageId))?.workspace?.layout || null,
  });
}
