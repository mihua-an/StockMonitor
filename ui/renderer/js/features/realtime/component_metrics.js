// Futu components remain transport-agnostic. Their render/paint timings cross
// this renderer event boundary and are sent through the same metric channel as
// Taiwan components.
export function createComponentMetricsBinder({ viewResources, sendRealtimeClientMetric }) {
  return {
    bind() {
      viewResources.listen(window, "stock-monitor:market-render-latency", (event) => {
        const detail = event?.detail || {};
        sendRealtimeClientMetric("market_render_latency", Number(detail.frame_latest_ms ?? detail.update_latest_ms) || 0, detail);
      });
      viewResources.listen(window, "stock-monitor:moomoo-component-render", (event) => {
        const detail = event?.detail || {};
        sendRealtimeClientMetric("component_render", Number(detail.render_ms) || 0, detail);
      });
      viewResources.listen(window, "stock-monitor:moomoo-component-paint", (event) => {
        const detail = event?.detail || {};
        sendRealtimeClientMetric("component_paint", Number(detail.paint_ms) || 0, detail);
      });
    },
  };
}
