"use strict";
// For a UI test whose checks depend on the page's size. Windows keeps a window within the screen, so on a small display
// (CI's) the page is laid out narrower than the BrowserWindow asked for, however wide the test opened it.
async function fixViewport(win, width, height) {
  win.webContents.enableDeviceEmulation({
    screenPosition: "desktop", screenSize: { width, height }, viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 1, viewSize: { width, height }, scale: 1,
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    const size = await win.webContents.executeJavaScript("[window.innerWidth, window.innerHeight]");
    if (size[0] === width && size[1] === height) return;
    if (Date.now() > deadline) throw new Error(`the page stayed at ${size.join("x")}, not ${width}x${height}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

module.exports = { fixViewport };
