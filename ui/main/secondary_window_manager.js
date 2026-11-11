"use strict";

class SecondaryWindowManager {
  constructor() {
    this.windows = new Map();
  }

  get(key) {
    const normalized = String(key || "");
    const win = this.windows.get(normalized) || null;
    if (win && typeof win.isDestroyed === "function" && win.isDestroyed()) {
      this.windows.delete(normalized);
      return null;
    }
    return win;
  }

  openOrFocus(key, factory) {
    const normalized = String(key || "").trim();
    if (!normalized) throw new Error("secondary window key is required");
    const existing = this.get(normalized);
    if (existing) {
      if (typeof existing.isMinimized === "function" && existing.isMinimized()) existing.restore?.();
      existing.show?.();
      existing.focus?.();
      return { window: existing, created: false };
    }
    if (typeof factory !== "function") throw new Error("secondary window factory is required");
    const win = factory(normalized);
    if (!win) throw new Error("secondary window factory returned no window");
    this.windows.set(normalized, win);
    const cleanup = () => {
      if (this.windows.get(normalized) === win) this.windows.delete(normalized);
    };
    win.once?.("closed", cleanup);
    win.once?.("destroyed", cleanup);
    return { window: win, created: true };
  }

  close(key) {
    const win = this.get(key);
    if (!win) return false;
    win.close?.();
    return true;
  }

  closeAll() {
    for (const [key, win] of [...this.windows.entries()]) {
      try { if (!win?.isDestroyed?.()) win.close?.(); } catch (error) { console.warn("[WINDOWS close secondary window] failed", error); }
      this.windows.delete(key);
    }
  }

  size() {
    for (const key of [...this.windows.keys()]) this.get(key);
    return this.windows.size;
  }
}

module.exports = { SecondaryWindowManager };
