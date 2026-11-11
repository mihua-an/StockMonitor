import { escapeHtml } from "../utility.js";

// A component's own title bar (components/tabs.css): one active title tab, and an actions slot on the right for the
// badges and buttons the component puts there (`actions` is markup the component builds). Every component card
// that names itself uses this one bar; a host whose tab already names the component hides it with
// data-component-title="hidden".
export function titleBarMarkup({ title = "", actions = "" } = {}) {
  const slot = actions ? `<div class="tab-strip-actions">${actions}</div>` : "";
  return `<div class="tab-strip tab-strip-title"><div class="tab-list"><button class="tab-title active" type="button" data-role="component-title">${escapeHtml(title)}</button></div>${slot}</div>`;
}
