"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { isReloadInput, installReloadInputGuard } = require("../ui/main/reload_input_guard");

for (const input of [
  { type: "keyDown", key: "F5" },
  { type: "keyDown", key: "r", control: true },
  { type: "keyDown", key: "R", control: true, shift: true },
  { type: "keyDown", code: "KeyR", meta: true },
]) assert.equal(isReloadInput(input), true, JSON.stringify(input));

for (const input of [
  { type: "keyUp", key: "F5" },
  { type: "keyDown", key: "r" },
  { type: "keyDown", key: "F6" },
  { type: "keyDown", key: "p", control: true },
]) assert.equal(isReloadInput(input), false, JSON.stringify(input));

const app = new EventEmitter();
const contents = new EventEmitter();
installReloadInputGuard(app);
app.emit("web-contents-created", {}, contents);

function dispatch(input) {
  let prevented = 0;
  contents.emit("before-input-event", { preventDefault: () => { prevented += 1; } }, input);
  return prevented;
}

assert.equal(dispatch({ type: "keyDown", key: "F5" }), 1);
assert.equal(dispatch({ type: "keyDown", key: "r", control: true }), 1);
assert.equal(dispatch({ type: "keyDown", key: "p", control: true }), 0);

console.log("global Electron reload input guard contract passed");
