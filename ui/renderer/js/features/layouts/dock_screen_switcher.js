// The bottom dock's 標準／完整／專業／... picker: which screen 即時報價 shows. Closed it shows the current one; hovering opens the rest.
import { expandPickerHtml } from "../../core/components/expand_picker.js";
import { morphInto } from "../../core/dom_morph.js";
import { screenLayouts } from "./screen_layouts.js";

export function installDockScreenSwitcher(host) {
  if (!host) return;
  const screens = screenLayouts();
  const draw = () => {
    const options = screens.list().map((item) => [item.id, item.name.replace(/模式$/, "")]);
    morphInto(host, expandPickerHtml({ options, current: screens.active().id }));
  };
  host.addEventListener("click", (event) => {
    const id = event.target?.closest?.("[data-pick]")?.dataset?.pick;
    if (id) screens.select(id);
  });
  screens.subscribe(draw);
  draw();
}
