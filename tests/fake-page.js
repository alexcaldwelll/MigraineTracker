// Just enough of a page to drive real click handlers in Node. An element is made
// on first use; a test sets what its queries find with `found` and `parents`.
export class FakeElement {
  style = {}; dataset = {}; attrs = {}; found = {}; parents = {}; listeners = {};
  value = ""; textContent = ""; innerHTML = ""; hidden = false; disabled = false; open = false;
  classes = new Set();
  classList = {
    add: (name) => this.classes.add(name),
    remove: (name) => this.classes.delete(name),
    contains: (name) => this.classes.has(name),
    toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
  };
  addEventListener(type, fn) { this.listeners[type] = fn; }
  fire(type, event) { return this.listeners[type](event); }
  click() { return this.fire("click"); }
  querySelector(selector) { return this.found[selector] ?? null; }
  querySelectorAll(selector) { return this.found[selector] ?? []; }
  closest(selector) { return this.parents[selector] ?? null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

// Installs a fake document and returns its $ and a way to answer querySelectorAll.
export function fakePage(t) {
  const elements = new Map(), lists = new Map();
  globalThis.document = {
    activeElement: null,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    },
    querySelectorAll: (selector) => lists.get(selector) ?? [],
  };
  t.after(() => { delete globalThis.document; });
  return { $: globalThis.document.querySelector, list: (selector, nodes) => lists.set(selector, nodes) };
}
