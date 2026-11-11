// An element's rendered size, kept current by one shared ResizeObserver and read without touching layout.
// Reading getBoundingClientRect() while the page has pending DOM writes forces a synchronous layout; a component
// that needs its size on every data update (a trend canvas) reads it here instead. The first read measures once.
//
// Several owners may watch one element (a trend canvas: its component redraws on a resize, the hover card follows
// it). Each holds a lease -- onElementResize() or holdElementSize() -- and the element is watched until the last
// lease is released; no owner can stop another's.

const records = new WeakMap();
let observer = null;

function observe(element, record) {
  if (typeof ResizeObserver === "undefined") return;
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const current = records.get(entry.target);
      if (!current) continue;
      const box = entry.borderBoxSize?.[0];
      const width = box ? box.inlineSize : entry.contentRect.width;
      const height = box ? box.blockSize : entry.contentRect.height;
      if (width === current.width && height === current.height) continue;
      current.width = width;
      current.height = height;
      for (const listener of [...current.listeners]) {
        try { listener(current); } catch (error) { console.error("[element size] resize listener failed", error); }
      }
    }
  });
  observer.observe(element);
  record.observed = true;
}

function recordOf(element) {
  let record = records.get(element);
  if (!record) {
    const rect = element.getBoundingClientRect();
    record = { width: rect.width, height: rect.height, listeners: new Set(), leases: 0, observed: false };
    records.set(element, record);
    observe(element, record);
  }
  return record;
}

/** { width, height } in CSS pixels (border box), as getBoundingClientRect() would report without a transform. */
export function elementSize(element) {
  if (!element) return { width: 0, height: 0 };
  const { width, height } = recordOf(element);
  return { width, height };
}

// A lease on the element's record; its release (once, however often it is called) stops watching the element when it
// was the last one.
function lease(element, record, listener = null) {
  record.leases += 1;
  if (listener) record.listeners.add(listener);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (listener) record.listeners.delete(listener);
    record.leases -= 1;
    if (record.leases > 0 || records.get(element) !== record) return;
    if (record.observed) observer?.unobserve(element);
    records.delete(element);
  };
}

/** Calls `listener` after layout whenever the element's size changes. Returns the release of this subscription. */
export function onElementResize(element, listener) {
  if (!element || typeof listener !== "function") return () => {};
  return lease(element, recordOf(element), listener);
}

/** Keeps the element's size current for elementSize() reads without a listener. Returns the release. */
export function holdElementSize(element) {
  if (!element) return () => {};
  return lease(element, recordOf(element));
}
