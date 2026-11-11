import { readFileSync } from "node:fs";

// The trend surface's source: trend_chart_component.js and the modules split out of it (shell markup, header
// presenter, overlay state, canvas frames), one text each -- a parser reads one module at a time.
const FILES = ["trend_chart_component.js", "trend_surface_shell.js", "trend_header_presenter.js", "trend_overlay_state.js", "trend_canvas_frames.js", "trend_surface_variant.js"];

export function trendSurfaceSources() {
  return FILES.map((name) => readFileSync(new URL(`../../ui/renderer/js/core/components/${name}`, import.meta.url), "utf8"));
}

/** All of it as one text, for contracts that search the source. */
export function trendSurfaceSource() {
  return trendSurfaceSources().join("\n");
}
