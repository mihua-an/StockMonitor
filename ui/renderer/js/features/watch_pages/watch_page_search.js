// The watch pages editor's catalog search: the newest query wins. Each run captures what it was asked under (the
// query and the editor context: source, market filter, page); its answer is used only while that is still what the
// editor shows, and a superseded failure is still recorded.

export function createWatchPageSearch({ fetchItems, debounceMs = 220, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout }) {
  let generation = 0;
  let timer = null;

  return {
    /** Forgets any query in flight or scheduled (the input changed, the source or filter switched). */
    invalidate() {
      generation += 1;
      clearTimer(timer);
      timer = null;
    },

    /** Runs `run()` after the debounce (typing). */
    schedule(run) {
      clearTimer(timer);
      timer = setTimer(run, debounceMs);
    },

    /**
     * Asks the catalog for `query` under `context()`; answers { items } when the answer is still current, null when it
     * was superseded. A failure of a current query throws; a superseded one is recorded and answers null.
     */
    async query(query, context) {
      clearTimer(timer);
      timer = null;
      const mine = ++generation;
      const askedUnder = JSON.stringify(context());
      const isCurrent = () => mine === generation && JSON.stringify(context()) === askedUnder;
      try {
        const data = await fetchItems(query);
        if (!isCurrent()) return null;
        return { items: Array.isArray(data?.items) ? data.items : [] };
      } catch (error) {
        if (!isCurrent()) {
          console.warn(`[watch pages: search "${query}" (superseded)] failed`, error);
          return null;
        }
        throw error;
      }
    },
  };
}
