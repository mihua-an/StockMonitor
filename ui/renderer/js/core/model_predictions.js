// Model predictions ride a symbol's signals as `model_predictions`, keyed "<minutes>m_<up|down>" (Rust B writes them;
// the live page and the replay read them the same way). Only an OK entry carries a number; any other status shows
// "--" with its reason; DISABLED -- a horizon the current config no longer enables -- is not shown at all; TEST_ONLY
// is marked. Returns { metrics: { up5m: 0.61, ... }, notes: { up5m: { status, reason, testOnly, asof, model } } }.
export function modelPredictionMetrics(signals) {
  const entries = signals && typeof signals.model_predictions === "object" && signals.model_predictions
    ? signals.model_predictions : {};
  const metrics = {};
  const notes = {};
  for (const [key, entry] of Object.entries(entries)) {
    const match = /^(\d+)m_(up|down)$/.exec(key);
    if (!match || !entry || typeof entry !== "object" || entry.status === "DISABLED") continue;
    const field = `${match[2]}${match[1]}m`;
    const ok = entry.status === "OK" && entry.probability !== null && Number.isFinite(Number(entry.probability));
    metrics[field] = ok ? Number(entry.probability) : null;
    notes[field] = {
      status: String(entry.status || ""),
      reason: entry.reason ?? null,
      testOnly: entry.test_only === true,
      asof: entry.asof ?? null,
      model: entry.model_id ? `${entry.model_id}@${entry.model_version ?? "?"}` : null,
    };
  }
  return { metrics, notes };
}
