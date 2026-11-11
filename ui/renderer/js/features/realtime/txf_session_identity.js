// TXFR1 display identity: the one place the renderer reconciles two different session
// vocabularies for the same instrument.
//
//   * Market Runtime / WAL identity  -- source + market + code + trading_date + session. A Shioaji FUT
//     partition is a business session, DAY or NIGHT (a NIGHT dated by the day it opened); Market Runtime holds no
//     FULL partition for TXFR1 (an older layout kept one FULL partition per calendar day). 全日 is composed from the
//     night before and the day (txfSessionPartitions).
//   * Display identity -- the 日盤 / 夜盤 / 全日 tabs, which are business windows with their own
//     business trading_date. NIGHT's trading_date is the NEXT business day, so for a night
//     session it deliberately differs from the calendar day its events carry.
//
// Comparing those two field-by-field would make the 日盤 and 夜盤 tabs impossible to fill: a NIGHT
// candidate's calendar date is not the tab's business date. So staleness checking is not loosened --
// like is compared with like: a candidate carrying the WAL session is the canonical form for this instrument and is accepted
// for any tab as long as its calendar day falls inside that tab's window. Narrowing a FULL
// stream down to the DAY or NIGHT portion is what txfTickMatchesDisplayWindow() already does,
// per event, from window_start/window_end.

export const TXF_IDENTITY_SOURCE_RANK = Object.freeze({
  FALLBACK: 0,
  REST: 1,
  CANONICAL: 2,
  STATUS: 3,
  ROLLOVER: 4,
});

// The 全日 tab's session, and the session an older-layout FUT partition carried. A candidate carrying it, like one
// carrying DAY / NIGHT, names a partition, not a business window, and is never compared against a business date.
export const TXF_WAL_SESSION = "full";

export function normalizeTxfDisplayIdentity(raw = {}, session = "full", source = "FALLBACK") {
  const normalizedSession = String(raw?.session || session || "full").trim().toLowerCase();
  const tradingDate = String(raw?.trading_date || raw?.tradingDate || "").slice(0, 10);
  const actualContract = String(
    raw?.actual_contract
    || raw?.actualContract
    || raw?.contract_code
    || raw?.contractCode
    || "",
  ).trim().toUpperCase();
  return {
    market: "FUT",
    logical_code: "TXFR1",
    trading_date: tradingDate,
    // The calendar day this business session is filed under -- the WAL partition. It is NOT
    // derivable from the other fields: NIGHT's business trading_date is the next business day,
    // and FULL's window OPENS on the previous calendar day, so neither the date nor the window
    // start identifies the partition on its own.
    display_date: String(raw?.display_date || raw?.displayDate || "").slice(0, 10),
    session: normalizedSession,
    actual_contract: actualContract,
    contract_code: actualContract,
    window_start: raw?.window_start || raw?.windowStart || raw?.session_window?.start || null,
    window_end: raw?.window_end || raw?.windowEnd || raw?.session_window?.end || null,
    // The WAL partitions this tab reads, as the session owner resolved them (session.current): never derived here.
    partitions: Array.isArray(raw?.partitions)
      ? raw.partitions.map((p) => ({ trading_date: calendarDay(p?.trading_date), session: String(p?.session || "").toUpperCase() }))
        .filter((p) => p.trading_date && (p.session === "DAY" || p.session === "NIGHT"))
      : [],
    live: typeof raw?.live === "boolean" ? raw.live : null,
    source: String(source || "FALLBACK").toUpperCase(),
    source_rank: Number(TXF_IDENTITY_SOURCE_RANK[String(source || "FALLBACK").toUpperCase()] || 0),
  };
}

export function txfDisplayIdentityKey(identity = {}) {
  return [
    "FUT",
    "TXFR1",
    String(identity?.trading_date || "").slice(0, 10),
    String(identity?.session || "").toUpperCase(),
    String(identity?.actual_contract || identity?.contract_code || "").toUpperCase(),
    (Array.isArray(identity?.partitions) ? identity.partitions : []).map((p) => `${p.trading_date}:${p.session}`).join(","),
  ].join("|");
}

function calendarDay(value) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

/** Calendar days a display window spans, e.g. NIGHT 09-25T15:00 -> 09-26T05:00 is 09-25..09-26. */
export function windowCalendarSpan(identity = {}) {
  const start = calendarDay(identity?.window_start);
  const end = calendarDay(identity?.window_end);
  if (!start || !end) return null;
  return { start, end };
}

/**
 * Does a WAL/canonical identity belong to the session currently being displayed?
 * `current` is the display identity for the active tab; `candidate` is whatever arrived.
 */
/**
 * The Market Runtime partitions a tab reads (FUT is stored per business session): exactly the list the session
 * owner resolved (Market Runtime's session.current `futures.*.partitions`, native/market_runtime/src/rollover.rs
 * futures_sessions). An identity that does not carry them reads nothing yet --
 * the renderer never rebuilds them from dates (a weekday rule names the wrong night after a
 * holiday).
 */
export function txfSessionPartitions(identity = {}) {
  return Array.isArray(identity?.partitions) ? identity.partitions.map((p) => ({ ...p })) : [];
}

export function txfIdentityMatchesDisplay(current = {}, candidate = {}) {
  // Nothing is being displayed until a tab identity names its session, so there is nothing for a
  // candidate to match. (txfDisplayIdentityKey() alone cannot answer this: it always returns a
  // non-empty "FUT|TXFR1|..." string, even for an empty identity.)
  if (!String(current?.session || "").trim()) return false;

  if (current.actual_contract && candidate.actual_contract
      && current.actual_contract !== candidate.actual_contract) {
    return false;
  }

  const candidateSession = String(candidate.session || "").toLowerCase();
  const currentSession = String(current.session || "").toLowerCase();

  // A per-session partition (DAY/NIGHT) belongs to the tab when it is one of the partitions the tab reads.
  if ((candidateSession === "day" || candidateSession === "night") && candidateSession !== currentSession
      || (candidateSession === "night" && currentSession === "night")) {
    const day = calendarDay(candidate.trading_date);
    const parts = txfSessionPartitions(current);
    if (!day || !parts.length) return true;
    return parts.some((part) => part.session.toLowerCase() === candidateSession && part.trading_date === day);
  }

  // The 全日 tab is named like the WAL session but is a business window too (15:00 -> the next day): with a window
  // it is bounded the same way, not by a calendar date its partitions never share.
  const currentIsWindowed = Boolean(String(current.window_start || "").trim() && String(current.window_end || "").trim());
  if (candidateSession === TXF_WAL_SESSION && (currentSession !== TXF_WAL_SESSION || currentIsWindowed)) {
    // WAL identity against a business tab: bound it by the tab's own window instead of by a
    // business date it can never carry. Without a window there is nothing to contradict, so
    // accept -- the per-event window filter still applies downstream.
    const span = windowCalendarSpan(current);
    const day = calendarDay(candidate.trading_date);
    if (!span || !day) return true;
    return day >= span.start && day <= span.end;
  }

  // Same vocabulary on both sides: a concrete conflicting date or session is stale.
  if (current.trading_date && candidate.trading_date && current.trading_date !== candidate.trading_date) {
    return false;
  }
  return currentSession === candidateSession;
}

/**
 * The Market Runtime / WAL state key a display identity must be read under.
 *
 * Kept here, beside the vocabulary reconciliation it belongs to, and pure so the rule is
 * regression-testable: a canonical view is addressed by source+market+code+calendar-day+WAL
 * session, so FUT is ALWAYS FULL. Asking for session DAY or NIGHT names a state key that cannot
 * exist and the subscription binds to nothing -- which is exactly how the 日盤 and 夜盤 tabs came
 * to render zero points while 全日 worked. NIGHT's business trading_date is the next business
 * day, so the calendar day its window OPENS on is the partition that holds its events.
 */
export function txfCanonicalStateKey(identity = {}) {
  // The tab's own partition: 日盤 and 全日 bind the DAY of their trading date (全日 also reads the night before it,
  // see txfSessionPartitions), 夜盤 binds its NIGHT partition.
  const parts = txfSessionPartitions(identity);
  const primary = parts[parts.length - 1] || null;
  return {
    session: primary ? primary.session : "DAY",
    trading_date: primary ? primary.trading_date : String(identity?.trading_date || "").slice(0, 10),
  };
}

/** One event against the displayed window. FULL displays everything; DAY/NIGHT narrow it. */
export function txfTickMatchesDisplayWindow(row = {}, identity = {}, eventEpochMs = () => NaN) {
  const rowSession = String(row?.session || "").trim().toUpperCase();
  const expectedSession = String(identity?.session || "").trim().toUpperCase();
  const rowTradingDate = calendarDay(row?.trading_date || row?.tradingDate);
  const expectedTradingDate = calendarDay(identity?.trading_date);

  // A FULL row is the canonical form: its calendar date is not the business date a DAY/NIGHT tab
  // carries, so the window below -- not the date -- is what narrows it.
  // A canonical row names its partition (FULL in the older layout, DAY/NIGHT now): its date is the partition's,
  // not the tab's business date, so only the window below decides.
  const rowIsWalSession = ["FULL", "DAY", "NIGHT"].includes(rowSession);
  if (!rowIsWalSession && rowTradingDate && expectedTradingDate && rowTradingDate !== expectedTradingDate) return false;
  if (rowSession && expectedSession && expectedSession !== "FULL" && !rowIsWalSession && rowSession !== expectedSession) return false;

  const eventTime = eventEpochMs(row);
  const windowStart = Date.parse(String(identity?.window_start || ""));
  const windowEnd = Date.parse(String(identity?.window_end || ""));
  if (Number.isFinite(eventTime) && Number.isFinite(windowStart) && eventTime < windowStart) return false;
  if (Number.isFinite(eventTime) && Number.isFinite(windowEnd) && eventTime > windowEnd) return false;
  return true;
}

/** The futures partition trading now, read from a session payload ({ futures: { DAY, NIGHT, FULL } }): the NIGHT one while
 * the night session is live, else the DAY one. A window with no committed identities of its own (Workspace) reads this. */
export function futuresLivePartitionOf(session = {}) {
  const of = (name) => normalizeTxfDisplayIdentity(session?.futures?.[name.toUpperCase()] || {}, name, "FALLBACK");
  const night = of("night");
  return txfCanonicalStateKey(night.live === true ? night : of("day"));
}
