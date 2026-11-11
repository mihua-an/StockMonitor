// A view's recorded recoveries and remediation events (Health's ledger through core/remediation.js).
//
// A recovery -- a resync, or a re-subscribe after a reconnect, a timeout or an error -- is one recorded remediation:
// started at the first try, each later try an attempt of it, ended once by the snapshot that re-baselines the view
// (succeeded), or by the view going away / being re-subscribed (abandoned). The open ones live on the entry
// (`entry.recoveries`: kind -> { handle, attempts }) so describe() can show them.
export function createViewRecovery({ remediation, connectionId = () => "" }) {
  const identity = (entry) => {
    const spec = entry?.spec || {};
    return { source: spec.source, market: spec.market, code: spec.code, session: spec.session,
      trading_date: spec.trading_date || entry?.state?.session_key?.trading_date || "", view_id: entry?.key,
      subscription_id: entry?.subscription_id || "", connection_id: connectionId() || "" };
  };

  return {
    identity,

    begin(entry, kind, mechanismId, triggerReason, detail = {}) {
      const open = entry.recoveries.get(kind);
      if (open) { open.attempts += 1; return; }
      try {
        const handle = remediation.begin({ component: "realtime_view_store", mechanismId, triggerReason,
          identity: identity(entry), detail });
        entry.recoveries.set(kind, { handle, attempts: 1 });
      } catch (error) { console.warn("[view store: recording a recovery start] failed", error); }
    },

    // Ends the entry's open recoveries (only `kinds` when given) with one outcome.
    end(entry, outcome, detail = {}, kinds = null) {
      for (const [kind, open] of [...entry.recoveries]) {
        if (kinds && !kinds.includes(kind)) continue;
        entry.recoveries.delete(kind);
        try { open.handle.finish(outcome, { attempt: open.attempts, detail }); } catch (error) { console.warn("[view store: recording a recovery end] failed", error); }
      }
    },

    // One finished remediation event. `eventIdentity` names a view nobody here holds (an orphan subscription).
    record(entry, mechanismId, triggerReason, outcome, detail = {}, eventIdentity = null) {
      try {
        remediation.emit({ component: "realtime_view_store", mechanismId, triggerReason,
          identity: eventIdentity || (entry ? identity(entry) : { connection_id: connectionId() || "" }), outcome, detail });
      } catch (error) { console.warn("[view store: recording a remediation event] failed", error); }
    },
  };
}
