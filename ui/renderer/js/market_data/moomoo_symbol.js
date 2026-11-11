/**
 * UI-only formatter for Moomoo security identifiers.
 *
 * Moomoo/OpenD and every persisted/internal lookup keep the canonical code
 * (for example `US.NOK` or `CC.BTCUSD`). Presentation surfaces may drop
 * the provider market prefix because the Futu workspace already shows market
 * metadata where disambiguation matters.
 */
export function formatMoomooDisplaySymbol(code) {
  const raw = String(code ?? "").trim();
  return /^(?:US|CC)\./i.test(raw) ? raw.slice(3) : raw;
}


/**
 * Shape-only canonical form: trim/upper and supply the implicit `US.` market
 * prefix. It performs NO instrument substitution: a code is the security
 * master's code, and the consumer must subscribe exactly what the producer publishes.
 */
export function canonicalMoomooCode(code) {
  const raw = String(code ?? "").trim().toUpperCase();
  return raw.includes(".") ? raw : (raw ? `US.${raw}` : "");
}


/** The ONE canonical view identity for a Futu instrument.
 *
 * Both Futu subscribers -- the quote store's per-code hot view and the product-list row -- must
 * use this, byte for byte. `channels` and the identity fields are all part of the view store key,
 * so two specs of their own (different channel sets, one pinned session/trading_date) would give
 * the same instrument TWO entries, each with its own subscription, snapshot and sequence space:
 * one code, one canonical view.
 *
 * `signals` is included: it is the analysis projection's per-symbol row (量變 / 1m3m5m / K / AI),
 * which Market Runtime already writes for Futu instruments.
 *
 * `events` is deliberately NOT included. There is no Futu alert UI, and the monitor alert rules --
 * the 09:00 window, the price-limit semantics, the close handling -- are Taiwan-equity specific.
 * Subscribing a channel with no consumer and no policy behind it would be exactly the kind of
 * wiring that looks connected and is not.
 */
export function futuCanonicalViewSpec(code) {
  const canonical = canonicalMoomooCode(code);
  return {
    source: "futu",
    market: canonical.split(".", 1)[0],
    code: canonical,
    session: "FULL",
    trading_date: "",
    // Rust B keeps no 價量 ladder for Futu (user decision): its price_volume is the 買賣報價 內外盤 bar's totals alone.
    channels: ["summary", "trend", "trades", "orderbook", "price_volume", "signals"],
  };
}
