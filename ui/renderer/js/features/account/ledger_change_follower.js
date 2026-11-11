// A ledger written from outside this page (模擬下單's fills: the paper desk writes them) reaches the open 帳務 page
// through the holdings owner's push (ledger_holdings.js), the one 即時報價's 模擬庫存 reads. Changes that come while a
// read is running are served by one more read after it, so the page ends on the newest ledger.

/** Follows `subscribe`; each change runs `read` and hands a usable result to `apply`. Returns the stop. */
export function followLedgerChanges({ subscribe, read, apply }) {
  let stopped = false;
  let reading = false;
  let again = false;

  async function pump() {
    if (reading) { again = true; return; }
    reading = true;
    do {
      again = false;
      try {
        const result = await read();
        if (!stopped) apply(result);
      } catch (error) {
        console.warn("[account ledger: re-reading after a pushed change] failed", error);
      }
    } while (again && !stopped);
    reading = false;
  }

  const unsubscribe = subscribe(() => { if (!stopped) void pump(); });
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}
