"use strict";

const path = require("path");
const { SecondaryWindowManager } = require("./secondary_window_manager");
const { DETACHED_WINDOWS, viewDescriptorErrors } = require("./ipc_contract");

// The descriptor's one rule is ipc_contract.js viewDescriptorErrors (the same one detached-view:open is authorized
// by); the windows a component opens with are its detached_windows.json entry.
function checkedDescriptor(raw) {
  const errors = viewDescriptorErrors(raw);
  if (errors.length) return { ok: false, errors, descriptor: null };
  const descriptor = { version: raw.version, componentId: raw.componentId, contextMode: raw.contextMode,
    contextId: raw.contextId.trim(), symbolMode: raw.symbolMode, symbol: String(raw.symbol || "").trim() };
  return { ok: true, errors, descriptor };
}

function descriptorKey(descriptor) {
  const pin = descriptor.symbolMode === "pinned" ? descriptor.symbol : "follow";
  return `${descriptor.contextId}:${descriptor.componentId}:${pin}`;
}

// A view window whose page did not load: recorded and closed, never left as a blank window. The window owner
// (desktop_windows.js) passes its own handler, which also shows the load-failure page.
function closeFailedWindow(win, kind, page, error) {
  console.error(`[WINDOWS] ${kind} window failed to load ${page}: ${error?.message || error}`);
  if (!win.isDestroyed?.()) win.close?.();
}

class DetachedViewManager {
  constructor({ BrowserWindow, preloadPath, rendererPath, onLoadFailure = closeFailedWindow }) {
    if (!BrowserWindow) throw new Error("DetachedViewManager requires BrowserWindow");
    this.BrowserWindow = BrowserWindow;
    this.preloadPath = preloadPath;
    this.rendererPath = rendererPath;
    this.onLoadFailure = onLoadFailure;
    this.secondary = new SecondaryWindowManager();
    this.descriptors = new Map();
  }

  _windowOptions(descriptor) {
    const size = DETACHED_WINDOWS[descriptor.componentId];
    return {
      width: Math.max(size.defaultWidth, size.minWidth),
      height: Math.max(size.defaultHeight, size.minHeight),
      minWidth: size.minWidth,
      minHeight: size.minHeight,
      show: false,
      backgroundColor: "#07111f",
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
  }

  open(rawDescriptor) {
    const result = checkedDescriptor(rawDescriptor);
    if (!result.ok) {
      console.warn(`[DETACHED VIEW] descriptor refused (${result.errors.join(", ")})`, rawDescriptor);
      return result;
    }
    const descriptor = result.descriptor;
    const key = descriptorKey(descriptor);
    const opened = this.secondary.openOrFocus(key, () => {
      const win = new this.BrowserWindow(this._windowOptions(descriptor));
      this.descriptors.set(key, descriptor);
      // loadFile() reports a failure only by rejecting.
      void Promise.resolve(win.loadFile(this.rendererPath))
        .catch((error) => this.onLoadFailure(win, `detached view ${descriptor.componentId}`, path.basename(String(this.rendererPath)), error));
      // Every load, not once: an endpoint change reloads the window and a descriptor sent only on the first load
      // left the reloaded view blank.
      win.webContents?.on?.("did-finish-load", () => {
        if (!win.isDestroyed?.()) win.webContents.send("detached-view:descriptor", descriptor);
      });
      win.once?.("ready-to-show", () => { win.show?.(); win.focus?.(); });
      win.once?.("closed", () => this.descriptors.delete(key));
      return win;
    });
    return { ok: true, created: opened.created, key, descriptor };
  }

  close(rawDescriptor) {
    const result = checkedDescriptor(rawDescriptor);
    if (!result.ok) return result;
    return { ok: this.secondary.close(descriptorKey(result.descriptor)) };
  }

  closeAll() {
    this.secondary.closeAll();
    this.descriptors.clear();
  }

  diagnostics() {
    return { openWindows: this.secondary.size(), descriptors: [...this.descriptors.values()] };
  }
}

module.exports = { descriptorKey, DetachedViewManager };
