// The button that opens a component in a detached window (its look: components/tick-details.css .tick-details-popout).
export function popoutButtonHtml(role) {
  return `<button class="tick-details-popout" data-role="${role}" type="button" aria-label="開啟獨立視窗"><span class="tick-details-popout-icon" aria-hidden="true"></span></button>`;
}
