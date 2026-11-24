// A full page's frame (styles/components/page-frame.css): the side nav, the title row over the scrolling content, and the
// tabs fixed at the content's top right. 帳務中心 and 資料中心 are drawn from here: a page's HTML gives only its own parts,
//
//   <div data-page-frame="帳務中心">          the page's name, over its nav
//     <div data-frame-part="nav">            its nav's buttons; an <hr> between groups
//     <div data-frame-part="foot">           what stands at the nav's bottom
//     <div data-frame-part="head">           its title row: the title, a subtitle, the actions
//     <div data-frame-part="tabs">           the tabs fixed over the content (資料｜事件｜回放)
//     <div data-frame-part="banner">         a line between the title row and the content
//     <div data-frame-part="body" id=...>    the scrolling content: its views, one shown at a time
//     <div data-frame-part="stage">          a view that fills the whole content area, without the title row
//   </div>
//
// and everything else in it (a modal) stays as it is. The parts' nodes are moved, never rebuilt.

function part(root, name, className) {
  const node = root.querySelector(`:scope > [data-frame-part="${name}"]`);
  if (node) node.className = `${className} ${node.className}`.trim();
  return node;
}

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children.filter(Boolean));
  return node;
}

function buildPageFrame(root) {
  const name = root.dataset.pageFrame;
  const items = part(root, "nav", "page-frame-items");
  for (const item of items.children) {
    if (item.tagName === "HR") { item.className = "page-frame-separator"; continue; }
    if (item.tagName !== "BUTTON") continue;
    item.className = `settings-nav-item ${item.className}`.trim();
    item.type = "button";
  }
  const title = document.createElement("h2");
  title.textContent = name;
  const nav = element("nav", "settings-nav", title, items, part(root, "foot", "page-frame-foot"));
  nav.setAttribute("aria-label", `${name}目錄`);
  const main = element("main", "page-frame-main", part(root, "head", "settings-page-head page-frame-head"),
    part(root, "banner", "page-frame-banner"), part(root, "body", "page-frame-scroll"), part(root, "stage", "page-frame-stage"), part(root, "tabs", "page-frame-tabs"));
  root.classList.add("page-frame");
  root.prepend(element("div", "settings-layout", nav, main));
}

/** Builds the frame of every [data-page-frame] in `container` that has none yet. */
export function hydratePageFrames(container) {
  container.querySelectorAll("[data-page-frame]:not(.page-frame)").forEach(buildPageFrame);
}

/** Shows one of a frame's nav items as the chosen one(s). */
export function markPageFrameItems(root, isActive) {
  root.querySelectorAll(".settings-nav-item").forEach((item) => {
    const active = Boolean(isActive(item));
    if (item.classList.contains("is-active") !== active) item.classList.toggle("is-active", active);
  });
}

/** Shows one view of a frame's body; `null` shows none (a stage is shown instead). */
export function showPageFrameView(root, attribute, value) {
  root.querySelectorAll(`.page-frame-view[${attribute}]`).forEach((view) => {
    const active = view.getAttribute(attribute) === value;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
}
