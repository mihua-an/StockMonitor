/** Shared latest-wins scheduler for high-frequency market-data rendering. */
class RealtimeRenderScheduler {
  constructor({ windowRef = globalThis, defaultDelayMs = 100 } = {}) {
    this.windowRef = windowRef;
    this.defaultDelayMs = Math.max(0, Number(defaultDelayMs) || 0);
    this.pending = new Map();
  }

  schedule(key, callback, { delayMs = this.defaultDelayMs, force = false } = {}) {
    const normalizedKey = String(key || "");
    if (!normalizedKey || typeof callback !== "function") return false;
    const existing = this.pending.get(normalizedKey);
    // Keep the first deadline: a continuous feed must not postpone rendering.
    if (existing && !force && Number(delayMs) > 0) {
      existing.callback = callback;
      return true;
    }
    if (existing?.timer != null) this.#cancelEntry(existing);
    const entry = { callback, timer: null, kind: "timeout" };
    this.pending.set(normalizedKey, entry);
    const run = () => {
      const current = this.pending.get(normalizedKey);
      if (current !== entry) return;
      this.pending.delete(normalizedKey);
      try { current.callback(); } catch (error) { queueMicrotask(() => { throw error; }); }
    };
    if (force || Number(delayMs) <= 0) {
      run();
      return true;
    }
    entry.timer = this.windowRef.setTimeout(run, Math.max(0, Number(delayMs) || 0));
    return true;
  }

  scheduleFrame(key, callback, { force = false } = {}) {
    const normalizedKey = String(key || "");
    if (!normalizedKey || typeof callback !== "function") return false;
    const existing = this.pending.get(normalizedKey);
    if (existing && !force) {
      existing.callback = callback;
      return true;
    }
    if (existing?.timer != null) this.#cancelEntry(existing);
    const entry = { callback, timer: null, kind: "frame" };
    this.pending.set(normalizedKey, entry);
    const run = () => {
      const current = this.pending.get(normalizedKey);
      if (current !== entry) return;
      this.pending.delete(normalizedKey);
      try { current.callback(); } catch (error) { queueMicrotask(() => { throw error; }); }
    };
    if (force) {
      run();
      return true;
    }
    const requestFrame = this.windowRef.requestAnimationFrame?.bind(this.windowRef);
    if (requestFrame) entry.timer = requestFrame(run);
    else {
      entry.kind = "timeout";
      entry.timer = this.windowRef.setTimeout(run, 0);
    }
    return true;
  }

  #cancelEntry(entry) {
    if (entry?.timer == null) return;
    if (entry.kind === "frame" && this.windowRef.cancelAnimationFrame) this.windowRef.cancelAnimationFrame(entry.timer);
    else this.windowRef.clearTimeout(entry.timer);
  }

  cancel(key) {
    const normalizedKey = String(key || "");
    const entry = this.pending.get(normalizedKey);
    if (!entry) return false;
    if (entry.timer != null) this.#cancelEntry(entry);
    this.pending.delete(normalizedKey);
    return true;
  }

  clear() { for (const key of this.pending.keys()) this.cancel(key); }
  pendingCount() { return this.pending.size; }
}

export { RealtimeRenderScheduler };
export const realtimeRenderScheduler = new RealtimeRenderScheduler({ defaultDelayMs: 100 });
