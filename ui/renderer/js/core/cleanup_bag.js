// What a component holds while it is mounted -- listeners, observers, animation frames, subscriptions, child
// controllers -- registered in one place and released together, newest first, by release(). Each release runs on its
// own: one that throws is logged with the owner's name and the rest still run. A component keeps no cleanup array of
// its own and writes no try/catch loop in destroy().
export class CleanupBag {
  constructor(owner) {
    this.owner = String(owner || "component");
    this.releases = [];
  }

  /** Register release functions (anything else -- a missing unsubscribe -- is ignored). */
  push(...releases) {
    for (const release of releases) if (typeof release === "function") this.releases.push(release);
    return this;
  }

  /** addEventListener now, removeEventListener on release. */
  listen(target, type, handler, options) {
    if (!target?.addEventListener) return this;
    target.addEventListener(type, handler, options);
    return this.push(() => target.removeEventListener?.(type, handler, options));
  }

  /** An observer (ResizeObserver, MutationObserver, ...) disconnected on release; returns it. */
  observe(observer) {
    if (observer) this.push(() => observer.disconnect?.());
    return observer;
  }

  /** requestAnimationFrame now, cancelled on release if it has not run; returns the frame id. */
  frame(callback) {
    const id = requestAnimationFrame(callback);
    this.push(() => cancelAnimationFrame(id));
    return id;
  }

  /** A child controller destroyed (or disposed) on release; returns it. */
  child(controller) {
    if (controller) this.push(() => (controller.destroy ?? controller.dispose)?.call(controller));
    return controller;
  }

  get size() { return this.releases.length; }

  /** Run every release, newest first; the bag is empty afterwards and can be filled again. */
  release() {
    const releases = this.releases.splice(0).reverse();
    for (const release of releases) {
      try { release(); } catch (error) { console.warn(`[${this.owner}: cleanup] failed`, error); }
    }
  }
}
