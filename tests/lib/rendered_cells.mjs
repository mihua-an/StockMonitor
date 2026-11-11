// What a row of cell models (ui/renderer/js/core/cell_patch.js) puts on screen: the real buildCellRow writes them into
// the shared mini DOM and the row's markup is read back, serialized the way Chromium does. Contracts state a cell as
// `<td class="price-up">20,000</td>` without a second copy of the cell renderer.
import { buildCellRow } from "../../ui/renderer/js/core/cell_patch.js";
import { createDocument } from "./mini_dom.mjs";

export function renderedCells(cells) {
  return buildCellRow([].concat(cells), { document: createDocument() }).innerHTML;
}
