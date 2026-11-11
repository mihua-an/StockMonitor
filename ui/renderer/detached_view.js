// First: every later warning and error is recorded as text (js/core/console_relay.js).
import "./js/core/console_relay.js";
import "./js/dashboard_components.js";
import { ComponentHost } from "./js/core/component_host.js";
import { componentRegistry } from "./js/core/component_registry.js";
import { createDashboardContext, realtimeContext } from "./js/core/dashboard_context.js";
import { notifyBackendReadyForRealtime } from "./js/market_data/realtime.js";
import { installSecondaryWindowRealtime } from "./js/market_data/secondary_window_realtime.js";
import { createTechnicalWindowService } from "./js/features/realtime/technical_window_service.js";
import { liveEventFeedViewModel, startMonitorEventTape } from "./js/features/realtime/live_monitor_events.js";

let activeHost = null;
let activeContext = null;
let removeDescriptorListener = null;

function destroyDetachedHost() {
  activeHost?.destroy?.();
  activeHost = null;
  activeContext?.destroy?.();
  activeContext = null;
}

// 即時資訊 reads this window's own event tape, which publishes to realtimeContext (live_monitor_events.js). The window
// has no 商品頁 or selected stock, so its only filter is the whole tape.
function eventFeedContext() {
  realtimeContext.dataSource.setResolver("eventFeed", () => liveEventFeedViewModel({ watchPages: [] }));
  startMonitorEventTape();
  notifyBackendReadyForRealtime();
  return realtimeContext;
}

function technicalWindowContext(descriptor, capabilities) {
  const context = createDashboardContext({ id: String(descriptor?.contextId || "live:detached"), mode: "live", capabilities });
  context.symbolStore.setSelectedSymbol(String(descriptor?.symbol || ""));
  notifyBackendReadyForRealtime();
  context.services.technicalAnalysis = createTechnicalWindowService();
  return context;
}

function mountDescriptor(descriptor) {
  destroyDetachedHost();
  const root = document.getElementById("detachedComponentHost");
  if (!root) return;
  const componentId = String(descriptor?.componentId || "");
  const definition = componentRegistry.get(componentId);
  if (!definition?.supportsDetachedWindow) {
    root.innerHTML = '<div class="dashboard-slot-state"><div class="empty">此 Component 不支援獨立視窗</div></div>';
    return;
  }
  const contextMode = String(descriptor?.contextMode || "live");
  // The window's own title names the component, so the component's title bar is not shown again inside it.
  document.title = definition.titleByMode?.[contextMode] ?? definition.title;
  root.dataset.componentTitle = "hidden";
  const capabilities = [
    ...(definition.requiredCapabilities || []),
    ...(definition.requiredCapabilitiesByMode?.[contextMode] || []),
  ];
  activeContext = componentId === "eventFeed" ? eventFeedContext() : technicalWindowContext(descriptor, capabilities);
  activeHost = new ComponentHost({
    host: root,
    hostId: `detached:${componentId}`,
    hostType: "detached",
    pageId: "detached",
    slotId: "detached",
    context: activeContext,
    registry: componentRegistry,
    hydrate: false,
  });
  activeHost.mount(componentId);
}

removeDescriptorListener = window.desktopAPI?.onDetachedViewDescriptor?.(mountDescriptor) || null;
window.addEventListener("resize", () => activeHost?.resize?.());
installSecondaryWindowRealtime({
  reason: "detached_window_closed",
  release: () => {
    removeDescriptorListener?.();
    removeDescriptorListener = null;
    destroyDetachedHost();
  },
});
