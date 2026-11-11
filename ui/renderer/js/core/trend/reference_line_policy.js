export class ReferenceLinePolicy {
  resolve(referencePrice, { referenceAvailable = true, referenceType = "reference", referenceSource = null } = {}) {
    const value = Number(referencePrice);
    // Price reference must be a real absolute market price. 0/null placeholders
    // are missing data, not a legitimate center line.
    const available = Boolean(referenceAvailable) && Number.isFinite(value) && value > 0;
    return {
      available,
      value: available ? value : null,
      type: referenceType || "reference",
      source: available ? (referenceSource || referenceType || "reference") : null,
    };
  }
}
export const DEFAULT_REFERENCE_LINE_POLICY = new ReferenceLinePolicy();
