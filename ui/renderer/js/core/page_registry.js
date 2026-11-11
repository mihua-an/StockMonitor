// Active renderer pages and their lazy page modules.
// Only user-reachable pages belong here; retired legacy/live-info compatibility pages
// are intentionally excluded so they cannot accumulate hidden runtime code.

const PAGE_DEFINITIONS = Object.freeze({
  realtime: { file: "./pages/realtime.html" },
  layouts: { file: "./pages/layouts.html", loader: () => import("../pages/layouts.js") },
  history: { file: "./pages/history.html", loader: () => import("../pages/history.js") },
  training: { file: "./pages/training.html", loader: () => import("../pages/training.js") },
  datacenter: { file: "./pages/data_center.html", loader: () => import("../pages/data_center.js") },
  // 帳務: one page for the actual ledger and the paper wallet (its tabs switch the ledger).
  account: { file: "./pages/account.html", loader: () => import("../pages/account.js") },
  settings: { file: "./pages/settings.html", loader: () => import("../pages/settings.js") },
});

const moduleCache = new Map();

export function resolvePage(page) {
  return PAGE_DEFINITIONS[page] || PAGE_DEFINITIONS.realtime;
}

export async function loadPageModule(page) {
  const definition = PAGE_DEFINITIONS[page];
  if (!definition?.loader) return null;
  if (!moduleCache.has(page)) moduleCache.set(page, definition.loader());
  return moduleCache.get(page);
}
