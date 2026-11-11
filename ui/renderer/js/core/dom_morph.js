// Bring a container's DOM to the markup a renderer produced, touching only what differs: an element that is
// already there keeps its identity (its listeners, focus, an open <select>, scroll position, SVG nodes), and only
// changed attributes, text and children are written. A component that builds its markup as one string uses this
// instead of innerHTML, so a data update redraws the data and never rebuilds the controls around it.
//
// Children are matched by `data-morph-key` when they carry one (a list whose rows move), otherwise by position and
// tag. A child the component added itself and marked `data-morph-keep` (an overlay painted after the render) is left
// in place.

function sameKind(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
}

function morphKey(node) {
  return node.nodeType === 1 ? node.getAttribute("data-morph-key") : null;
}

function syncAttributes(target, source) {
  for (const attr of [...target.attributes]) {
    if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  }
  for (const attr of source.attributes) {
    if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  }
}

// Form state lives in properties, not attributes: the rendered `selected` / `value` / `checked` is the state.
function syncFormState(target, source) {
  if (target.nodeName === "OPTION") target.selected = source.hasAttribute("selected");
  else if (target.nodeName === "INPUT") {
    if ("checked" in target) target.checked = source.hasAttribute("checked");
    const value = source.getAttribute("value");
    if (value !== null && target.value !== value && target !== target.ownerDocument?.activeElement) target.value = value;
  }
}

function morphNode(target, source) {
  if (target.nodeType === 3 || target.nodeType === 8) {
    if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
    return;
  }
  syncAttributes(target, source);
  morphChildren(target, source);
  syncFormState(target, source);
  if (target.nodeName === "SELECT") {
    const chosen = [...source.options].findIndex((option) => option.hasAttribute("selected"));
    if (chosen >= 0 && target.selectedIndex !== chosen) target.selectedIndex = chosen;
  }
}

/** Make `target`'s children match `source`'s (a node whose children are the wanted markup). */
export function morphChildren(target, source) {
  const wanted = [...source.childNodes];
  const current = [...target.childNodes].filter((node) => !(node.nodeType === 1 && node.hasAttribute("data-morph-keep")));
  const keyed = new Map();
  for (const node of current) {
    const key = morphKey(node);
    if (key !== null) keyed.set(key, node);
  }
  const unkeyed = current.filter((node) => morphKey(node) === null);
  let unkeyedIndex = 0;
  const used = new Set();
  let cursor = target.firstChild;
  const skipKept = () => { while (cursor && cursor.nodeType === 1 && cursor.hasAttribute("data-morph-keep")) cursor = cursor.nextSibling; };
  for (const fresh of wanted) {
    const key = morphKey(fresh);
    let match = null;
    if (key !== null) {
      const candidate = keyed.get(key);
      if (candidate && sameKind(candidate, fresh)) match = candidate;
    } else {
      while (unkeyedIndex < unkeyed.length && used.has(unkeyed[unkeyedIndex])) unkeyedIndex += 1;
      const candidate = unkeyed[unkeyedIndex];
      if (candidate && sameKind(candidate, fresh)) { match = candidate; unkeyedIndex += 1; }
    }
    skipKept();
    if (match) {
      used.add(match);
      morphNode(match, fresh);
      if (match !== cursor) target.insertBefore(match, cursor);
      else cursor = cursor.nextSibling;
    } else {
      target.insertBefore(fresh.cloneNode(true), cursor);
    }
  }
  for (const node of current) if (!used.has(node)) node.remove();
}

/** Make `container`'s content the given markup. Returns false when nothing at all changed (same markup as last time). */
export function morphInto(container, html) {
  if (container.__morphMarkup === html) return false;
  const template = container.ownerDocument.createElement("template");
  template.innerHTML = html;
  morphChildren(container, template.content);
  container.__morphMarkup = html;
  return true;
}

/** Forget the markup `container` was last morphed to: something else has written it since (a retained-DOM renderer). */
export function morphReset(container) {
  if (container) delete container.__morphMarkup;
}
