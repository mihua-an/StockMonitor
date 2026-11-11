"use strict";
// Loaded into an Electron UI test (NODE_OPTIONS=--require) to give it the CI machine as this one cannot be:
// GitHub's windows runner has Windows' animation effects off, so Chromium reports prefers-reduced-motion, and a
// 1024x768 screen, so Windows keeps every window within it however large the test opened it. A test that depends on
// either and does not pin it (tests/support/keep_motion.cjs, tests/support/fixed_viewport.cjs) fails here as on CI.
// scripts/tooling/run_ci_locally.py loads it for the Node contract tests.
const Module = require("node:module");

const SCREEN = { width: 1024, height: 768 };
const TASKBAR = 40;   // the work area Windows keeps windows within is the screen less its taskbar

const load = Module._load;
let patched = null;
Module._load = function loadWithCiMachine(request, parent, isMain) {
  const exported = load.call(this, request, parent, isMain);
  if (request !== "electron" || !exported?.BrowserWindow || !exported.app) return exported;
  if (patched) return patched;
  const { BrowserWindow, app } = exported;
  const askedNoReduce = new Set();
  const appendSwitch = app.commandLine.appendSwitch.bind(app.commandLine);
  // keep_motion.cjs asks for motion whatever the machine says: then the machine's setting is not added.
  app.commandLine.appendSwitch = (name, value) => {
    askedNoReduce.add(name);
    return value === undefined ? appendSwitch(name) : appendSwitch(name, value);
  };
  app.on("will-finish-launching", () => {
    if (!askedNoReduce.has("force-prefers-no-reduced-motion")) appendSwitch("force-prefers-reduced-motion");
  });
  class CiSizedWindow extends BrowserWindow {
    constructor(options = {}) {
      const width = Math.min(options.width ?? 800, SCREEN.width);
      const height = Math.min(options.height ?? 600, SCREEN.height - TASKBAR);
      super({ ...options, width, height });
    }
  }
  patched = new Proxy(exported, { get: (target, key) => (key === "BrowserWindow" ? CiSizedWindow : target[key]) });
  return patched;
};
