// The trend glyphs: a rising or falling line with its arrow head, drawn in the user's 漲 / 跌 colour
// (components/direction-glyph.css). One set for every place a short label names a direction with an icon: 即時資訊's
// model titles ("3" + up) and 個股走勢's prediction cells ("10" + up). The text the glyph stands for stays on the
// element that owns the label (its tooltip), so the glyph itself is hidden from assistive technology.

const PATHS = Object.freeze({
  up: '<path d="M3 17l6-6 4 4 8-8"></path><path d="M14 7h7v7"></path>',
  down: '<path d="M3 7l6 6 4-4 8 8"></path><path d="M14 17h7v-7"></path>',
});

/** The glyph for "up" or "down" as HTML; "" for anything else. */
export function directionGlyphHtml(direction) {
  const paths = PATHS[direction];
  return paths
    ? `<span class="direction-glyph" data-direction="${direction}" aria-hidden="true"><svg viewBox="0 0 24 24">${paths}</svg></span>`
    : "";
}
