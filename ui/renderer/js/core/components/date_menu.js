// The date dropdown (日期 button + listbox of dates) shared by 歷史事件 and the 歷史回放 sidebar: one open/close,
// outside-click, Escape and selection behaviour, one option markup (.event-feed-date-*). Escape closes only an open
// menu -- both pickers listen on the document, so one that reacted to every Escape stole focus from the other.
import { escapeHtml } from "../utility.js";

// The listed dates, the active one marked. `attribute` is the data-* the menu reads the picked date from.
export function dateOptionsHtml(dates, current, attribute) {
  return dates.map((value) => {
    const date = String(value);
    const active = date === current;
    return `<button type="button" role="option" data-morph-key="${escapeHtml(date)}" data-${attribute}="${escapeHtml(date)}" class="event-feed-date-option${active ? " active" : ""}" aria-selected="${active ? "true" : "false"}">${escapeHtml(date)}</button>`;
  }).join("");
}

// A portalled menu under (or, when there is no room, above) its button, kept inside the window.
function positionPortal(menu, button) {
  if (!menu || !button || menu.hidden || menu.parentElement !== document.body) return;
  const rect = button.getBoundingClientRect();
  const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
  const width = Math.max(132, Math.round(rect.width || 0));
  const left = Math.max(4, Math.min(Math.round(rect.right - width), Math.max(4, viewportWidth - width - 4)));
  menu.style.setProperty("--event-feed-date-menu-width", `${width}px`);
  menu.style.setProperty("--event-feed-date-menu-left", `${left}px`);
  menu.style.setProperty("--event-feed-date-menu-top", `${Math.round(rect.bottom + 1)}px`);
  const menuHeight = Math.max(1, Math.ceil(menu.getBoundingClientRect().height || 0));
  const below = Math.max(0, viewportHeight - rect.bottom - 4);
  const above = Math.max(0, rect.top - 4);
  if (menuHeight > below && above > below) {
    menu.style.setProperty("--event-feed-date-menu-top", `${Math.max(4, Math.round(rect.top - menuHeight - 1))}px`);
  }
}

/**
 * Binds one date menu. `attribute`: the options' data-* (dateOptionsHtml). `portal`: move the open menu to <body>
 * (a menu inside an overflow:hidden card would be clipped). `onOpen` runs before the menu shows (refresh the list);
 * `onSelect(date)` gets the picked date. Returns { close, reposition, destroy }.
 */
export function bindDateMenu({ picker, button, menu, list, attribute, portal = false, onOpen = null, onSelect }) {
  const optionSelector = `button[data-${attribute}]`;
  const datasetKey = attribute.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  const restoreHome = () => {
    if (!portal || !menu || !picker || menu.parentElement === picker) return;
    menu.classList.remove("event-feed-date-menu-portal");
    menu.removeAttribute("style");
    picker.appendChild(menu);
  };
  const setOpen = (open) => {
    const visible = Boolean(open) && !picker?.hidden;
    if (visible && menu) {
      onOpen?.();
      if (portal) {
        if (menu.parentElement !== document.body) document.body.appendChild(menu);
        menu.classList.add("event-feed-date-menu-portal");
      }
      menu.hidden = false;
      positionPortal(menu, button);
    } else if (menu) {
      menu.hidden = true;
      restoreHome();
    }
    button?.setAttribute?.("aria-expanded", visible ? "true" : "false");
    picker?.classList?.toggle("open", visible);
  };
  const isOpen = () => Boolean(menu && !menu.hidden);
  const onButtonClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(!isOpen());
  };
  const onListClick = (event) => {
    const option = event.target?.closest?.(optionSelector);
    if (!option || !list?.contains?.(option)) return;
    setOpen(false);
    const value = String(option.dataset[datasetKey] || "");
    if (value) onSelect?.(value);
  };
  const onDocumentPointerDown = (event) => {
    if (isOpen() && !picker?.contains?.(event.target) && !menu?.contains?.(event.target)) setOpen(false);
  };
  const onDocumentKeyDown = (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    setOpen(false);
    button?.focus?.();
  };
  const reposition = () => { if (isOpen()) positionPortal(menu, button); };
  button?.addEventListener?.("click", onButtonClick);
  list?.addEventListener?.("click", onListClick);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  if (portal) {
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
  }
  return {
    close: () => setOpen(false),
    reposition,
    destroy: () => {
      button?.removeEventListener?.("click", onButtonClick);
      list?.removeEventListener?.("click", onListClick);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      if (portal) {
        window.removeEventListener("resize", reposition);
        window.removeEventListener("scroll", reposition, true);
      }
      setOpen(false);
    },
  };
}
