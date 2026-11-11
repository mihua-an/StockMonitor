import assert from "node:assert/strict";

// 設定 > 顯示 price colour scheme (D06-07): main's preferences:colors-changed broadcast is the only writer of the check
// marks and aria-pressed after a save; the invoke answer only says whether the save went through. Two windows save one
// after the other and this window's answer arrives last -- the page must keep showing the newer save from the broadcast.
const RED = "#e11919";
const GREEN = "#00993d";
const WHITE = "#ffffff";
const tokens = { "--market-red": RED, "--market-green": GREEN, "--white": WHITE };

const elements = new Map();
function element(id, scheme) {
  if (!elements.has(id)) {
    const mark = { textContent: "" };
    const attributes = {};
    const listeners = {};
    const node = {
      id, disabled: false, textContent: "", className: "", dataset: scheme ? { scheme } : {}, attributes, mark, listeners,
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute: (name, value) => { attributes[name] = value; },
      querySelector: (selector) => (selector === ".settings-checkmark" ? mark : null),
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    };
    elements.set(id, node);
  }
  return elements.get(id);
}
const redRow = element("priceColorSchemeRedUp", "red-up");
const greenRow = element("priceColorSchemeGreenUp", "green-up");
const click = (node) => { for (const fn of node.listeners.click || []) fn({ currentTarget: node }); };
const shown = () => ({ red: [redRow.attributes["aria-pressed"], redRow.mark.textContent],
  green: [greenRow.attributes["aria-pressed"], greenRow.mark.textContent] });
const RED_SHOWN = { red: ["true", "✓"], green: ["false", ""] };
const GREEN_SHOWN = { red: ["false", ""], green: ["true", "✓"] };

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
globalThis.document = {
  documentElement: {},
  getElementById: (id) => (elements.has(id) ? elements.get(id) : null),
  querySelectorAll: () => [],
};
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => tokens[name] || "" });

// The fake main: a save is stored and broadcast to every window at once (in save order), and its answer to the
// window that asked is held until the test releases it.
let broadcastListener = null;
let saveFails = false;
const answers = [];
const broadcast = (colors) => broadcastListener?.(colors);
globalThis.window = {
  dispatchEvent() {},
  addEventListener() {},
  matchMedia: () => ({ matches: true }),
  desktopAPI: {
    colorPreferences: { priceUpColor: RED, priceDownColor: GREEN, priceFlatColor: WHITE },
    // The answer carries the saved colours (the worst case: a page that drew from it would draw the older save).
    setColorPreferences: (payload) => {
      if (!saveFails) broadcast(payload);
      return new Promise((resolve, reject) => answers.push({ resolve: () => resolve(payload), reject }));
    },
    onColorPreferencesChanged: (callback) => { broadcastListener = callback; return () => { broadcastListener = null; }; },
  },
};

const { initDisplaySettings, disposeDisplaySettings } = await import("../ui/renderer/js/pages/settings_display.js");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

initDisplaySettings();
assert.deepEqual(shown(), RED_SHOWN, "the first load draws the saved scheme once from the bootstrap snapshot");

// This window chooses 綠漲; another window then chooses 紅漲; this window's answer arrives after both broadcasts.
click(greenRow);
await settle();
assert.equal(answers.length, 1, "the click saved once");
assert.deepEqual(shown(), GREEN_SHOWN, "this window's own save is drawn from its broadcast");
broadcast({ priceUpColor: RED, priceDownColor: GREEN, priceFlatColor: WHITE });
assert.deepEqual(shown(), RED_SHOWN, "the other window's newer save is drawn from its broadcast");
answers[0].resolve();
await settle();
assert.deepEqual(shown(), RED_SHOWN, "the late answer to the older save does not draw over the newer broadcast");

// A save main refuses is never broadcast: the marks stay on the saved scheme.
saveFails = true;
click(greenRow);
await settle();
answers[1].reject(new Error("disk full"));
await settle();
assert.deepEqual(shown(), RED_SHOWN, "a refused save changes nothing on the page");

disposeDisplaySettings();
assert.equal(broadcastListener, null, "dispose drops the broadcast subscription");
console.log("renderer settings color scheme contract: ok");
