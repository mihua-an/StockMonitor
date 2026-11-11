// The Futu 成交明細 page count, read once per key (product + trading date + session): a read in flight or answered is not asked again for the same key; a
// refusal (`ok: false`) is an answer for that key; a read that failed (FastAPI not reached) leaves the key unread, so
// the caller's next frame asks again. Every failure and refusal is recorded with the list's label and key.
export function createPageCountReader({ apiGet, label, onCount }) {
  let key = "";
  let status = "idle";   // "idle" | "reading" | "answered"
  let asked = 0;

  return {
    /** Ask for `nextKey`'s count at `path` unless that key is already being read or was answered. */
    request(nextKey, path) {
      if (!nextKey || (nextKey === key && status !== "idle")) return;
      key = nextKey;
      status = "reading";
      const request = ++asked;
      const current = () => request === asked;
      let reading;
      try { reading = Promise.resolve(apiGet(path)); } catch (error) { reading = Promise.reject(error); }
      reading.then((result) => {
        if (!current()) return;
        status = "answered";
        if (!result?.ok) {
          console.warn(`[${label}: page count] refused`, { key: nextKey, error: result?.error ?? result });
          return;
        }
        onCount(result);
      }).catch((error) => {
        if (current()) status = "idle";
        console.warn(`[${label}: page count] failed`, { key: nextKey }, error);
      });
    },
    /** Forget the key: the list moved to another product or session, or was disposed. */
    reset() {
      key = "";
      status = "idle";
      asked += 1;
    },
    get key() { return key; },
    get status() { return status; },
  };
}
