// The one small DOM for node contracts of renderer components: element trees, attributes, dataset, classList, style
// properties, text, simple selectors, and innerHTML parsed from / serialized to markup with the browser's escaping
// (HTML "serializing an HTML fragment": text escapes & < > and U+00A0, attribute values & " < > and U+00A0;
// character references are decoded on parse). It counts element creation so a contract can state "only the new row
// was built". Layout, real events and CSS stay in the Electron contracts.

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const NAMED_REFERENCES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

export function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}
export function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}
function decodeReferences(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return NAMED_REFERENCES[name.toLowerCase()] ?? whole;
  });
}

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get nextSibling() { const list = this.parentNode?.childNodes || []; return list[list.indexOf(this) + 1] || null; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument?.documentElement || node === this.ownerDocument; }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.nodeName = "#text"; this.data = String(data); }
  get nodeValue() { return this.data; }
  set nodeValue(value) { this.data = String(value); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  get outerHTML() { return escapeText(this.data); }
  cloneNode() { return new Text(this.ownerDocument, this.data); }
}

class ClassList {
  constructor(element) { this.element = element; }
  get items() { return this.element.className ? this.element.className.split(/\s+/).filter(Boolean) : []; }
  contains(name) { return this.items.includes(name); }
  add(...names) { const items = this.items; for (const n of names) if (!items.includes(n)) items.push(n); this.element.className = items.join(" "); }
  remove(...names) { this.element.className = this.items.filter((n) => !names.includes(n)).join(" "); }
  toggle(name, force) { const on = force ?? !this.contains(name); if (on) this.add(name); else this.remove(name); return on; }
}

const dataName = (key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const dataKey = (name) => name.slice(5).replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());

class ParentNode extends Node {
  _detach(node) { if (node.parentNode) node.parentNode.removeChild(node); }
  appendChild(node) {
    if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.appendChild(child); return node; }
    this._detach(node); node.parentNode = this; this.childNodes.push(node); return node;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === "string" ? new Text(this.ownerDocument, n) : n); }
  insertBefore(node, anchor) {
    if (!anchor) return this.appendChild(node);
    if (node === anchor) return node;
    if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.insertBefore(child, anchor); return node; }
    this._detach(node);
    const at = this.childNodes.indexOf(anchor);
    node.parentNode = this;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
    return node;
  }
  removeChild(node) { const at = this.childNodes.indexOf(node); if (at >= 0) this.childNodes.splice(at, 1); node.parentNode = null; return node; }
  replaceChildren(...nodes) { for (const n of [...this.childNodes]) this.removeChild(n); this.append(...nodes); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); if (String(value) !== "") this.appendChild(new Text(this.ownerDocument, value)); }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); walk(child); } };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
}

class DocumentFragment extends ParentNode {
  constructor(doc) { super(doc); this.nodeType = 11; this.nodeName = "#document-fragment"; }
}

class Element extends ParentNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = this.nodeName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.classList = new ClassList(this);
    this.listeners = [];
    const styles = new Map();
    this.style = {
      setProperty: (name, value) => styles.set(name, String(value)),
      removeProperty: (name) => styles.delete(name),
      getPropertyValue: (name) => styles.get(name) ?? "",
      entries: () => [...styles],
    };
    const element = this;
    this.dataset = new Proxy({}, {
      get: (_t, key) => (typeof key === "string" ? element.getAttribute(dataName(key)) ?? undefined : undefined),
      set: (_t, key, value) => { element.setAttribute(dataName(key), value); return true; },
      deleteProperty: (_t, key) => { element.removeAttribute(dataName(key)); return true; },
      has: (_t, key) => typeof key === "string" && element.hasAttribute(dataName(key)),
      ownKeys: () => [...element.attrs.keys()].filter((n) => n.startsWith("data-")).map(dataKey),
      getOwnPropertyDescriptor: (_t, key) => (typeof key === "string" && element.hasAttribute(dataName(key))
        ? { enumerable: true, configurable: true, writable: true, value: element.getAttribute(dataName(key)) } : undefined),
    });
  }
  get id() { return this.attrs.get("id") ?? ""; }
  set id(value) { this.attrs.set("id", String(value)); }
  get className() { return this.attrs.get("class") ?? ""; }
  set className(value) { this.attrs.set("class", String(value)); }
  get title() { return this.attrs.get("title") ?? ""; }
  set title(value) { this.attrs.set("title", String(value)); }
  get colSpan() { return Number(this.attrs.get("colspan") ?? 1); }
  set colSpan(value) { this.attrs.set("colspan", String(value)); }
  get hidden() { return this.attrs.has("hidden"); }
  set hidden(value) { if (value) this.attrs.set("hidden", ""); else this.attrs.delete("hidden"); }
  setAttribute(name, value) { this.attrs.set(String(name), String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get nextElementSibling() { const list = this.parentNode?.children || []; return list[list.indexOf(this) + 1] || null; }
  get cells() { return this.children.filter((n) => n.tagName === "TD" || n.tagName === "TH"); }
  get rows() { return this.children.filter((n) => n.tagName === "TR"); }
  get outerHTML() {
    const tag = this.tagName.toLowerCase();
    const attrs = [...this.attrs].map(([n, v]) => ` ${n}="${escapeAttribute(v)}"`).join("");
    return VOID_TAGS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
  get innerHTML() { return this.childNodes.map((n) => n.outerHTML).join(""); }
  set innerHTML(html) { this.replaceChildren(...parseHtml(this.ownerDocument, String(html))); }
  // A <template>'s parsed markup (core/dom_morph.js morphs from it): its own children.
  get content() { return this.tagName === "TEMPLATE" ? this : undefined; }
  cloneNode(deep = false) {
    const copy = this.ownerDocument.createElement(this.tagName.toLowerCase());
    for (const [name, value] of this.attrs) copy.setAttribute(name, value);
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  addEventListener(type, handler) { this.listeners.push([type, handler]); }
  removeEventListener(type, handler) { this.listeners = this.listeners.filter(([t, h]) => t !== type || h !== handler); }
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
  getContext() { return null; }
  matches(selector) { return String(selector).split(",").some((part) => matchesSimple(this, part.trim())); }
  closest(selector) { for (let node = this; node?.nodeType === 1; node = node.parentNode) if (node.matches(selector)) return node; return null; }
}

// Compound selectors only (tag, .class, #id, [attr], [attr="value"]); anything else throws rather than guessing.
function matchesSimple(element, selector) {
  if (!selector) return false;
  const parts = selector.match(/^[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) || [];
  if (parts.join("") !== selector) throw new Error(`mini_dom: unsupported selector "${selector}"`);
  return parts.every((part) => {
    if (part.startsWith(".")) return element.classList.contains(part.slice(1));
    if (part.startsWith("#")) return element.id === part.slice(1);
    if (part.startsWith("[")) {
      const attr = part.slice(1, -1).match(/^([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^"'\s]*)))?$/);
      if (!attr) throw new Error(`mini_dom: unsupported attribute selector "${part}"`);
      const value = element.getAttribute(attr[1]);
      const wanted = attr[2] ?? attr[3] ?? attr[4];
      return wanted === undefined ? value !== null : value === wanted;
    }
    return element.tagName === part.toUpperCase();
  });
}

// Markup to nodes: elements, attributes (quoted or not), text with character references decoded, comments and
// doctypes skipped, void elements never opened, a close tag closing up to its open element.
function parseHtml(doc, html) {
  const root = doc.createDocumentFragment();
  const stack = [root];
  const push = (node) => stack.at(-1).appendChild(node);
  const pushText = (text) => { if (text) push(doc.createTextNode(decodeReferences(text))); };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) { pushText(html.slice(index)); break; }
    pushText(html.slice(index, open));
    if (html.startsWith("<!--", open)) { const end = html.indexOf("-->", open); index = end < 0 ? html.length : end + 3; continue; }
    if (html.startsWith("<!", open)) { const end = html.indexOf(">", open); index = end < 0 ? html.length : end + 1; continue; }
    let end = open + 1, quote = "";
    while (end < html.length) {
      const char = html[end];
      if (quote) { if (char === quote) quote = ""; } else if (char === "\"" || char === "'") quote = char; else if (char === ">") break;
      end += 1;
    }
    const raw = html.slice(open + 1, end);
    index = end + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toUpperCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) if (stack[depth].tagName === name) { stack.length = depth; break; }
      continue;
    }
    const selfClosing = raw.trimEnd().endsWith("/");
    const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw;
    const nameMatch = body.match(/^([\w:-]+)/);
    if (!nameMatch) { pushText(`<${raw}>`); continue; }
    const element = doc.createElement(nameMatch[1]);
    const attrPattern = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    attrPattern.lastIndex = nameMatch[1].length;
    for (let attr; (attr = attrPattern.exec(body));) element.setAttribute(attr[1].toLowerCase(), decodeReferences(attr[2] ?? attr[3] ?? attr[4] ?? ""));
    push(element);
    if (!selfClosing && !VOID_TAGS.has(element.tagName.toLowerCase())) stack.push(element);
  }
  return [...root.childNodes];
}

export function createDocument() {
  const doc = { created: 0 };
  doc.createElement = (tag) => { doc.created += 1; return new Element(doc, tag); };
  doc.createTextNode = (data) => new Text(doc, data);
  doc.createDocumentFragment = () => new DocumentFragment(doc);
  doc.documentElement = new Element(doc, "html");
  doc.body = doc.createElement("body");
  doc.documentElement.appendChild(doc.body);
  doc.getElementById = (id) => doc.documentElement.querySelector(`#${id}`);
  doc.querySelector = (selector) => doc.documentElement.querySelector(selector);
  doc.querySelectorAll = (selector) => doc.documentElement.querySelectorAll(selector);
  return doc;
}
