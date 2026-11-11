/**
 * A page's lifetime: the disposables, timers and frames it owns, and a generation token that tells a late callback
 * whether the page that scheduled it is still the one mounted. Only disposables and lifetime tokens; no application
 * or data context.
 *
 * @typedef {object} ViewClock  The timer and frame functions (globalThis by default; a test passes its own).
 * @property {(callback: () => void, delay: number) => number} setTimeout
 * @property {(id: number) => void} clearTimeout
 * @property {(callback: (time: number) => void) => number} requestAnimationFrame
 * @property {(id: number) => void} cancelAnimationFrame
 *
 * @typedef {number} LifetimeToken  The generation a callback was scheduled in (token()); current(token) checks it.
 * @typedef {() => void} Release    Ends one owned resource now; calling it again does nothing.
 */

/** @param {ViewClock} clock */
export function createViewResources(clock = globalThis) {
  let active = true;
  let generation = 0;
  const cleanup = new Set();
  const timers = new Set();
  const frames = new Set();

  /** Owns `dispose` until the page is disposed or the returned release runs; while inactive it runs at once. */
  function own(dispose) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      cleanup.delete(release);
      dispose();
    };
    if (active) cleanup.add(release);
    else release();
    return release;
  }

  return {
    own,
    get active() { return active; },
    /** @returns {LifetimeToken} */
    token: () => generation,
    current: (token) => active && token === generation,

    activate() {
      if (active) return;
      active = true;
      generation += 1;
    },

    listen(target, type, callback, options) {
      if (!target || !active) return () => {};
      target.addEventListener(type, callback, options);
      return own(() => target.removeEventListener(type, callback, options));
    },

    mark(target, key) {
      target.dataset[key] = "1";
      own(() => { delete target.dataset[key]; });
    },

    /** A timeout that runs only while the generation that scheduled it is still current. */
    timeout(callback, delay) {
      if (!active) return null;
      const token = generation;
      const id = clock.setTimeout(() => {
        timers.delete(id);
        if (active && token === generation) callback();
      }, delay);
      timers.add(id);
      return id;
    },

    clearTimeout(id) {
      timers.delete(id);
      clock.clearTimeout(id);
    },

    /** Resolves true after `ms`, or false at once if the page is disposed first (inactive: false now). */
    delay(ms) {
      if (!active) return Promise.resolve(false);
      return new Promise((resolve) => {
        let timer;
        const release = own(() => {
          timers.delete(timer);
          clock.clearTimeout(timer);
          resolve(false);
        });
        timer = clock.setTimeout(() => {
          resolve(true);
          release();
        }, ms);
        timers.add(timer);
      });
    },

    /** An animation frame that runs only while the generation that scheduled it is still current. */
    frame(callback) {
      if (!active) return null;
      const token = generation;
      const id = clock.requestAnimationFrame((time) => {
        frames.delete(id);
        if (active && token === generation) callback(time);
      });
      frames.add(id);
      return id;
    },

    cancelFrame(id) {
      frames.delete(id);
      clock.cancelAnimationFrame(id);
    },

    /** Ends the page: timers and frames are cancelled first, then the disposables run newest first. */
    dispose() {
      if (!active) return;
      active = false;
      generation += 1;
      for (const id of timers) clock.clearTimeout(id);
      timers.clear();
      for (const id of frames) clock.cancelAnimationFrame(id);
      frames.clear();
      for (const dispose of [...cleanup].reverse()) {
        try {
          dispose();
        } catch (error) {
          console.error("[Page cleanup]", error);
        }
      }
      cleanup.clear();
    },

    diagnostics: () => ({ active, timers: timers.size, frames: frames.size, disposables: cleanup.size }),
  };
}
