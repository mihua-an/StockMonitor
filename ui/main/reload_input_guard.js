"use strict";

function isReloadInput(input = {}) {
  if (String(input.type || "").toLowerCase() !== "keydown") return false;
  const key = String(input.key || "").toLowerCase();
  const code = String(input.code || "").toLowerCase();
  if (key === "f5" || code === "f5") return true;
  const command = Boolean(input.control || input.meta);
  return command && (key === "r" || code === "keyr");
}

function installReloadInputGuard(app) {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("before-input-event", (event, input) => {
      if (isReloadInput(input)) event.preventDefault();
    });
  });
}

module.exports = { isReloadInput, installReloadInputGuard };

