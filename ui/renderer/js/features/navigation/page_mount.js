// Mounting a page module on its freshly inserted HTML: the page binds its DOM, then its first data read starts.
// The read is the page's own -- each page drops an answer that arrives after it was left or mounted again (its own
// generation / dispose) -- so mounting never waits for it: navigations run one at a time (navigation_coordinator.js),
// and a slow read (資料中心's date list on a cold disk) held every page clicked after it.
// 即時報價 is not here: its mount (initRealtimePage) and its read (refreshRealtimePage) live in app.js's realtime path.

const PAGE_HOOKS = Object.freeze({
  // 版型編輯 is the live page on another workspace: its mount is the live page's.
  layouts: { mount: "initLayoutsPage", load: (mod) => mod.layoutsPageStarted() },
  training: { mount: "bindTrainingEvents", load: (mod) => mod.refreshTrainingStatus?.() },
  datacenter: { mount: "initDataCenterPage", load: (mod) => mod.refreshDataCenter?.() },
  history: { mount: "bindHistoryEvents", load: (mod) => mod.refreshHistoryPage?.() },
  account: { mount: "initAccountLedgerPage", load: (mod) => mod.refreshAccountLedgerPage?.(true) },
  settings: { mount: "initSettingsPage", load: (mod) => mod.refreshSettingsPage?.() },
});

/** Whether `page` is mounted through this module. */
export function isModulePage(page) {
  return Object.hasOwn(PAGE_HOOKS, page);
}

/** The page's data read, as a promise; it starts synchronously (a page may record the read it started). */
export function loadPageData(page, mod) {
  const hooks = PAGE_HOOKS[page];
  if (!hooks || !mod) return Promise.resolve();
  try {
    return Promise.resolve(hooks.load(mod));
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Mounts the page and starts its first read; returns at once with `{ loaded }`, the read's promise. */
export function mountPageModule(page, mod) {
  const hooks = PAGE_HOOKS[page];
  if (!hooks) throw new Error(`unknown page module: ${page}`);
  mod?.[hooks.mount]?.();
  return { loaded: loadPageData(page, mod) };
}
