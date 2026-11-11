import { readFileSync } from "node:fs";

// The 即時報價 page's controllers: the modules split out of pages/realtime.js under features/realtime/ (the page file
// only assembles them). Other features/realtime modules are components of their own and are not listed.
export const REALTIME_PAGE_MODULES = [
  "live_page_state",
  "session_state",
  "product_pages",
  "live_redraw",
  "canonical_view_owner",
  "live_view_models",
  "selection_controller",
  "session_controller",
  "startup_diagnostics",
];

/** One controller module's source, e.g. realtimeModuleSource("canonical_view_owner"). */
export function realtimeModuleSource(name) {
  return readFileSync(new URL(`../../ui/renderer/js/features/realtime/${name}.js`, import.meta.url), "utf8");
}

// The page and its controllers as one text: a contract that says "nothing on the page may ..." searches this, so it
// holds wherever a function now lives.
export function realtimePageSource() {
  return realtimePageSources().join("\n");
}

// The same files one text each (a parser reads one module at a time: joined, their declarations collide).
export function realtimePageSources() {
  return [
    readFileSync(new URL("../../ui/renderer/js/pages/realtime.js", import.meta.url), "utf8"),
    ...REALTIME_PAGE_MODULES.map(realtimeModuleSource),
  ];
}
