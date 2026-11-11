// The 歷史回放 page (pages/history.js and features/history/*) in node, on its REAL modules: a document of the few
// elements a test reads by id, frames a test runs itself, and a fetch the test answers (route(url) -> JSON body, or a
// promise of one).
//
//   const page = await startHistoryPage({ route: (url) => ({ ok: true }) });
//   const history = await import("../ui/renderer/js/pages/history.js");
import { rendererNetworkManifest } from "./renderer_network_manifest.mjs";

export async function startHistoryPage({ route = () => ({ ok: true }), date = "" } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: "", textContent: "", className: "", dataset: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, getContext: () => null,
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
      addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
    return elements.get(id);
  };
  element("historyDateSelect").value = date;
  const frames = new Map();
  let nextFrame = 1;
  Object.assign(globalThis, {
    // The renderer's endpoints and enabled sources, as Electron main hands them over.
    window: { desktopAPI: { networkManifest: rendererNetworkManifest(), sourceSettings: { enabled_sources: ["shioaji", "futu"], sources: {} } },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: (id) => element(id), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}, createElement: () => element(`created-${nextFrame++}`) },
    requestAnimationFrame: (fn) => { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  Object.assign(globalThis.window, { requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame });
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const body = await route(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    element, requests,
    /** Runs the frames queued so far. */
    runFrames() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(performance.now()); } },
    settle: async (turns = 20) => { for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve)); },
  };
}
