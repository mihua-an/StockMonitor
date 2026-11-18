import assert from "node:assert/strict";

// The 歷史回放 page holds two date menus at once (the sidebar's and 歷史事件's), both listening for Escape on the
// document. Escape belongs to the open one: a closed menu does not take focus, so pressing Escape anywhere on the
// page leaves focus where it was (歷史事件's menu used to pull it to its own date button every time).
const docListeners = new Map();
const focused = [];
function element(name) {
  const classes = new Set();
  return {
    name, hidden: true, parentElement: null, attributes: {}, dataset: {}, style: { setProperty() {} },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    getBoundingClientRect: () => ({ top: 0, bottom: 20, right: 100, width: 100, height: 20 }),
    addEventListener() {}, removeEventListener() {},
    contains(node) { return node === this; },
    appendChild(child) { child.parentElement = this; },
    focus() { focused.push(name); },
  };
}
globalThis.document = {
  body: element("body"), documentElement: { clientWidth: 800, clientHeight: 600 },
  addEventListener: (type, fn) => docListeners.set(fn, type),
  removeEventListener: (type, fn) => docListeners.delete(fn),
};
globalThis.window = { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} };
const press = (key) => { for (const [fn, type] of docListeners) if (type === "keydown") fn({ key }); };

const { bindDateMenu, dateOptionsHtml } = await import("../ui/renderer/js/core/components/date_menu.js");

function menuParts(prefix) {
  const picker = element(`${prefix}-picker`);
  const menu = element(`${prefix}-menu`);
  menu.parentElement = picker;
  return { picker, button: element(`${prefix}-button`), menu, list: element(`${prefix}-list`) };
}
const sidebar = menuParts("sidebar");
const events = menuParts("events");
picked: {
  const sidebarMenu = bindDateMenu({ ...sidebar, attribute: "history-date", onSelect() {} });
  const eventsMenu = bindDateMenu({ ...events, attribute: "event-date", portal: true, onSelect() {} });

  press("Escape");
  assert.deepEqual(focused, [], "Escape with no menu open moves focus nowhere");

  sidebar.menu.hidden = false;           // the sidebar's menu is open, 歷史事件's closed
  press("Escape");
  assert.equal(sidebar.menu.hidden, true, "the open menu closes");
  assert.deepEqual(focused, ["sidebar-button"], "focus returns to the menu that was open, and only to it");

  sidebarMenu.destroy();
  eventsMenu.destroy();
  assert.equal(docListeners.size, 0, "destroy removes the document listeners");
  break picked;
}

// One option markup for both menus; the picked date travels in the menu's own data-* attribute.
const html = dateOptionsHtml(["2026-11-14", "2026-11-13"], "2026-11-13", "history-date");
assert.match(html, /data-history-date="2026-11-14" class="event-feed-date-option" aria-selected="false"/);
assert.match(html, /data-history-date="2026-11-13" class="event-feed-date-option active" aria-selected="true"/);
console.log("renderer date menu contract passed");
