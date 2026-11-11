/**
 * The one classification contract for the account page's Chinese-literal
 * backend fields:
 *   - `action` ("買進" / "賣出") on individual trade records, used for
 *     buy/sell display styling.
 *   - `direction` ("多" / "空") on matched trade-pair / daytrade rows, used
 *     for long/short position logic. Every filter and aggregate over
 *     direction goes through `isLongDirection` / `isShortDirection`, so a row
 *     is never counted as short in one view and dropped from another.
 *
 * The ledger emits exactly "多" or "空". Any other value is a contract
 * violation: it is classified as neither side and logged once per distinct
 * value (console.error reaches the run's error.log through renderer_health),
 * rather than silently disappearing from the long/short totals.
 *
 * Reads no owned state.
 */
const LONG = "多";
const SHORT = "空";
const reportedUnknownDirections = new Set();

export function isBuyAction(action) {
  return String(action || "").trim() === "買進";
}

function directionSide(direction) {
  if (direction === LONG) return LONG;
  if (direction === SHORT) return SHORT;
  const key = JSON.stringify(direction ?? null);
  if (!reportedUnknownDirections.has(key)) {
    reportedUnknownDirections.add(key);
    console.error(`[account direction] unknown trade direction ${key}; expected "${LONG}" or "${SHORT}"`);
  }
  return null;
}

export function isLongDirection(direction) {
  return directionSide(direction) === LONG;
}

export function isShortDirection(direction) {
  return directionSide(direction) === SHORT;
}
