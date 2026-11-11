// The market colours as the user set them (設定 → 紅漲綠跌 / 綠漲紅跌). Preload writes the preference onto the document
// as --price-up-color / --price-down-color / --price-flat-color and updates them live; DOM rules read those
// variables, and canvas drawing reads them here at draw time: literal canvas colours would leave every chart
// red-up after switching to 綠漲.

// = styles/tokens.css --market-red / --market-green, the one red and green of the app.
const FALLBACK = Object.freeze({ up: "#e11919", down: "#00993d", flat: "#ffffff" });

/** { up, down, flat } as CSS colour strings; the defaults when no document / variable is available. */
export function marketPalette() {
  try {
    const style = globalThis.getComputedStyle?.(globalThis.document?.documentElement);
    if (!style) return { ...FALLBACK };
    const read = (name, fallback) => String(style.getPropertyValue(name) || "").trim() || fallback;
    return {
      up: read("--price-up-color", FALLBACK.up),
      down: read("--price-down-color", FALLBACK.down),
      flat: read("--price-flat-color", FALLBACK.flat),
    };
  } catch (error) {
    console.warn("[market palette] reading the colour variables failed; using the built-in palette", error);
    return { ...FALLBACK };
  }
}

const themeColors = new Map();
const missingColors = new Set();

/** A colour token of styles/tokens.css (e.g. "--chart-grid") as the document computes it, read once per document; ""
 * without a document (node). Canvas drawing reads its colours here, so tokens.css stays the only place they are. */
export function themeColor(name) {
  const doc = globalThis.document;
  if (!doc?.documentElement || typeof globalThis.getComputedStyle !== "function") return "";
  const cached = themeColors.get(name);
  if (cached !== undefined && cached.doc === doc) return cached.value;
  let value = "";
  try {
    value = String(globalThis.getComputedStyle(doc.documentElement).getPropertyValue(name) || "").trim();
  } catch (error) {
    console.warn(`[market palette] reading ${name} failed`, error);
  }
  // Not cached while empty: a canvas drawn before the stylesheet applied reads it again on its next frame.
  if (value) themeColors.set(name, { doc, value });
  else if (!missingColors.has(name)) { missingColors.add(name); console.warn(`[market palette] ${name} is not defined in tokens.css`); }
  return value;
}

/** A #rrggbb colour with an alpha, for translucent fills (volume bars). Other forms are returned as they are. */
export function withAlpha(color, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(color || "").trim());
  if (!match) return color;
  const value = parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
