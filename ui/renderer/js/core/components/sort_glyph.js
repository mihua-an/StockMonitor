// The markup of a sort glyph (styles/components/sort-glyph.css): "drag" (拖曳), "top" (置頂) or "bottom" (置底).
export function sortGlyphHtml(kind) {
  if (kind === "drag") return '<span class="sort-glyph drag"><span></span></span>';
  return `<span class="sort-glyph edge ${kind === "bottom" ? "bottom" : "top"}"></span>`;
}
