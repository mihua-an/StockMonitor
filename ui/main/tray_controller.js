"use strict";

// The system-tray icon (user decision). Closing the window (X) only closes the window: Health, the market
// services and the recording keep running. The tray icon is how the App is reached while no window is open, and the
// one place that closes more than the window:
//   開啟 Stock Monitor               -- a window again (also a double click on the icon)
//   關閉介面與 FastAPI               -- the window and both API processes; market data and model signals keep running
//   完整關閉（含行情服務）           -- everything, including the market daemons, Rust A / B and Health
// Closing the window raises no notification (user decision): the icon's tooltip says the App keeps recording.

class TrayController {
  constructor({ electron, iconPath, onOpen, onCloseUiAndBackend, onFullShutdown, logger = console }) {
    Object.assign(this, { electron, iconPath, onOpen, onCloseUiAndBackend, onFullShutdown, logger });
    this.tray = null;
  }

  start() {
    if (this.tray) return this.tray;
    const { Tray, Menu, nativeImage } = this.electron;
    const image = nativeImage.createFromPath(this.iconPath);
    if (image.isEmpty()) this.logger.warn?.(`[TRAY] icon ${this.iconPath} could not be read; the tray shows a blank icon`);
    this.tray = new Tray(image);
    this.tray.setToolTip("Stock Monitor");
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "開啟 Stock Monitor", click: () => this.onOpen() },
      { type: "separator" },
      { label: "關閉介面與 FastAPI", click: () => this.onCloseUiAndBackend() },
      { label: "完整關閉（含行情服務）", click: () => this.onFullShutdown() },
    ]));
    this.tray.on("double-click", () => this.onOpen());
    return this.tray;
  }

  /** The window was closed and the services keep running: the tray icon's tooltip says so, no notification. */
  windowClosed() {
    this.tray?.setToolTip("Stock Monitor（背景錄行情中）");
  }

  windowOpened() {
    this.tray?.setToolTip("Stock Monitor");
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { TrayController };
