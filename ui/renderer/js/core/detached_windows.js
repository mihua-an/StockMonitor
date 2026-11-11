// The components a detached window can host, with their window sizes: ui/main/detached_windows.json, which preload
// hands every page as desktopAPI.detachedWindows (ui/main/ipc_contract.js checks detached-view:open against the same
// list). A page outside Electron has no detached windows.
export function detachedWindowFor(componentId) {
  const windows = globalThis.window?.desktopAPI?.detachedWindows;
  const id = String(componentId || "");
  return windows && Object.hasOwn(windows, id) ? windows[id] : null;
}
