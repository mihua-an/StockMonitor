"use strict";

// The one place a secondary window's reference lives: one window per kind, dropped from here when it closes, so no
// caller keeps a reference to a closed window and every kind is closed together with the main window.
class WindowRegistry {
  constructor() { this.windows = new Map(); }

  /** The live window of `kind`, or null. */
  get(kind) {
    const win = this.windows.get(kind);
    return win && !win.isDestroyed() ? win : null;
  }

  /** Registers `win` as the window of `kind`; it is forgotten when it closes. `onClosed` runs then too. */
  add(kind, win, onClosed = null) {
    this.windows.set(kind, win);
    win.on("closed", () => {
      if (this.windows.get(kind) === win) this.windows.delete(kind);
      onClosed?.();
    });
    return win;
  }

  /** Shows and focuses the live window of `kind`; false when there is none. */
  bringForward(kind) {
    const win = this.get(kind);
    if (!win) return false;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }

  closeAll() {
    for (const win of [...this.windows.values()]) if (!win.isDestroyed()) win.close();
    this.windows.clear();
  }
}

module.exports = { WindowRegistry };
