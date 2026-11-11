// A horizontal scrollbar for a viewport whose native scrollbars are hidden (the row-snap grids draw their own
// vertical rail): a track with a thumb that is dragged, or the track clicked to jump there. It follows the viewport's
// scrollLeft (wheel with Shift, touchpad, keyboard) and is hidden -- taking no room -- while nothing overflows.
// Styles: data-grid.css .shared-x-rail.

export function mountHorizontalRail({ viewport, host, before = null, observe = [] }) {
  if (!viewport || !host) return { sync() {}, destroy() {} };
  const doc = host.ownerDocument;
  const rail = doc.createElement("div");
  rail.className = "shared-x-rail";
  rail.hidden = true;
  rail.setAttribute("aria-hidden", "true");
  const thumb = doc.createElement("div");
  thumb.className = "shared-x-rail-thumb";
  rail.appendChild(thumb);
  host.insertBefore(rail, before);

  const controller = new AbortController();
  const { signal } = controller;
  const range = () => Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const geometry = () => {
    const track = rail.clientWidth;
    const width = Math.min(track, Math.max(24, track * viewport.clientWidth / Math.max(1, viewport.scrollWidth)));
    return { track, width, travel: Math.max(0, track - width) };
  };

  function sync() {
    const max = range();
    const show = max > 1;
    if (rail.hidden === show) rail.hidden = !show;
    if (!show) return;
    const { width, travel } = geometry();
    const left = travel * Math.min(1, viewport.scrollLeft / max);
    thumb.style.width = `${width}px`;
    thumb.style.transform = `translateX(${left}px)`;
  }

  viewport.addEventListener("scroll", sync, { passive: true, signal });
  // A size change is answered in the next frame: showing or hiding the rail inside the ResizeObserver callback resizes
  // the observed viewport in the same delivery ("ResizeObserver loop completed with undelivered notifications").
  let pending = 0;
  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; sync(); });
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  for (const element of [viewport, rail, ...observe]) if (element) observer?.observe(element);

  // Clicking the track puts the thumb's middle under the pointer.
  rail.addEventListener("pointerdown", (event) => {
    if (event.target === thumb) return;
    const { travel, width } = geometry();
    const rect = rail.getBoundingClientRect();
    if (travel <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - width / 2) / travel));
    viewport.scrollLeft = ratio * range();
  }, { signal });

  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = viewport.scrollLeft;
    thumb.setPointerCapture?.(event.pointerId);
    thumb.classList.add("dragging");
    const move = (moveEvent) => {
      const { travel } = geometry();
      if (travel > 0) viewport.scrollLeft = startLeft + (moveEvent.clientX - startX) * range() / travel;
    };
    const finish = () => {
      thumb.classList.remove("dragging");
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", finish);
      thumb.removeEventListener("pointercancel", finish);
    };
    thumb.addEventListener("pointermove", move, { signal });
    thumb.addEventListener("pointerup", finish, { signal });
    thumb.addEventListener("pointercancel", finish, { signal });
  }, { signal });

  sync();
  return {
    sync,
    destroy() {
      if (pending) cancelAnimationFrame(pending);
      pending = 0;
      controller.abort();
      observer?.disconnect();
      rail.remove();
    },
  };
}
