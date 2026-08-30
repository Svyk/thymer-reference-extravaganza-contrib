'use strict';

// v4.45.0 — media renders inside refs/embeds. Executable behavior tests: real
// row builders, the real inline-media lane (fake blobs only at the SDK
// boundary), and a fake IntersectionObserver at the browser boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeElement {
  constructor(tag = 'div', text = '') {
    this.tagName = String(tag).toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.childNodes = this.children;
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    this.dataset = {};
    this._attrs = {};
    this._listeners = {};
    this._classes = new Set();
    this._text = String(text || '');
    this._connected = false;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.title = '';
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      toggle: (name, force) => {
        const on = force == null ? !this._classes.has(name) : !!force;
        if (on) this._classes.add(name); else this._classes.delete(name);
        return on;
      },
      contains: (name) => this._classes.has(name),
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map((child) => child.textContent || '').join(''); }
  set textContent(value) {
    for (const child of this.children) { child.parentNode = null; child._setConnected?.(false); }
    this.children.length = 0;
    this._text = String(value == null ? '' : value);
  }
  get isConnected() { return this._connected; }
  get parentElement() { return this.parentNode; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i >= 0 ? this.parentNode.children[i + 1] || null : null;
  }
  _setConnected(value) { this._connected = !!value; for (const child of this.children) child._setConnected?.(value); }
  append(...children) {
    for (let child of children) {
      if (child == null) continue;
      if (!(child instanceof FakeElement)) child = new FakeElement('#text', String(child));
      if (child.parentNode) child.remove();
      child.parentNode = this; this.children.push(child); child._setConnected(this.isConnected);
    }
  }
  appendChild(child) { this.append(child); return child; }
  insertBefore(child, before) {
    if (child.parentNode) child.remove();
    const index = before ? this.children.indexOf(before) : -1;
    child.parentNode = this;
    if (index >= 0) this.children.splice(index, 0, child); else this.children.push(child);
    child._setConnected(this.isConnected); return child;
  }
  replaceChildren(...children) { this.textContent = ''; this.append(...children); }
  after(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    let anchor = this;
    for (const node of nodes) {
      if (node == null) continue;
      parent.insertBefore(node, anchor.nextSibling);
      anchor = node;
    }
  }
  remove() {
    if (this.parentNode) {
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
    }
    this.parentNode = null; this._setConnected(false);
  }
  contains(node) { for (let p = node; p; p = p.parentNode) if (p === this) return true; return false; }
  setAttribute(name, value) { this._attrs[name] = String(value); if (name === 'class') this.className = value; }
  getAttribute(name) { if (name === 'class') return this.className; return this._attrs[name] ?? null; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((x) => x !== fn); }
  dispatchEvent(event) {
    event = event || {};
    event.type ||= '';
    event.target ||= this; event.currentTarget = this;
    event.preventDefault ||= function () { this.defaultPrevented = true; };
    event.stopPropagation ||= function () { this.propagationStopped = true; };
    for (const fn of [...(this._listeners[event.type] || [])]) fn(event);
    return !event.defaultPrevented;
  }
  click() { return this.dispatchEvent({ type: 'click' }); }
  matches(selector) {
    selector = selector.trim();
    if (!selector) return false;
    // [attr] / [attr="value"] — dataset assignments (dataset.fooBar) reflect as
    // data-foo-bar the way the real DOM reflects them.
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const m = selector.slice(1, -1).match(/^([a-zA-Z0-9_-]+)(?:=(?:["']([^"']*)["']|([^\]]+)))?$/);
      if (!m) return false;
      const name = m[1];
      const expected = m[2] ?? m[3];
      let actual = this.getAttribute(name);
      if (actual == null && name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_x, c) => c.toUpperCase());
        actual = this.dataset ? this.dataset[key] : null;
      }
      if (actual == null) return false;
      return expected === undefined || String(actual) === String(expected);
    }
    let tag = '', cls = '';
    if (selector.startsWith('.')) cls = selector.slice(1);
    else if (selector.includes('.')) [tag, cls] = selector.split('.', 2);
    else tag = selector;
    if (tag && tag !== '*' && this.tagName !== tag.toUpperCase()) return false;
    if (cls && !this.classList.contains(cls)) return false;
    return true;
  }
  querySelectorAll(selector) {
    const selectors = String(selector).split(',').map((x) => x.trim()).filter(Boolean);
    const scoped = selectors
      .filter((sel) => /^:scope\s*>/.test(sel))
      .map((sel) => sel.replace(/^:scope\s*>\s*/, ''));
    const descendant = selectors.filter((sel) => !/^:scope\s*>/.test(sel));
    const out = [];
    for (const child of this.children) {
      if (scoped.some((sel) => child.matches(sel))) out.push(child);
    }
    if (descendant.length) {
      const walk = (node) => {
        for (const child of node.children) {
          if (descendant.some((sel) => child.matches(sel))) out.push(child);
          walk(child);
        }
      };
      walk(this);
    }
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let n = this; n; n = n.parentNode) if (n.matches?.(selector)) return n; return null; }
}

class FakeIntersectionObserver {
  static instances = [];
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = new Set();
    this.disconnected = false;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el) { this.observed.add(el); }
  unobserve(el) { this.observed.delete(el); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
  fire(el) { this.callback([{ target: el, isIntersecting: true }]); }
  fireAll() { for (const el of [...this.observed]) this.fire(el); }
}

function harness(options = {}) {
  FakeIntersectionObserver.instances = [];
  const body = new FakeElement('body'); body._setConnected(true);
  const head = new FakeElement('head'); head._setConnected(true);
  const docListeners = new Map();
  const document = {
    hidden: false, body, head, activeElement: null,
    documentElement: new FakeElement('html'),
    createElement: (tag) => {
      const el = new FakeElement(tag);
      // v4.45.2: images carry a decode() the way real <img> elements do.
      // Default settles immediately; manualDecode lets a test hold the decode
      // open and prove the skeleton is never released early.
      if (String(tag).toLowerCase() === 'img') {
        if (options.manualDecode) el.decode = () => new Promise((resolve) => { el._resolveDecode = resolve; });
        else el.decode = () => Promise.resolve();
      }
      return el;
    },
    createTextNode: (text) => new FakeElement('#text', text),
    querySelector: (selector) => body.querySelector(selector) || head.querySelector(selector),
    querySelectorAll: (selector) => [...body.querySelectorAll(selector), ...head.querySelectorAll(selector)],
    addEventListener: (type, fn) => { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn); },
    removeEventListener: (type, fn) => { docListeners.set(type, (docListeners.get(type) || []).filter((x) => x !== fn)); },
  };
  document.documentElement._setConnected(true);

  let urlSeq = 0;
  const revokedUrls = [];
  class FakeBlob {
    constructor(parts = [], options = {}) {
      this.parts = parts;
      this.type = options.type || '';
      this.size = parts.reduce((total, part) => total + Number(part?.byteLength ?? part?.size ?? String(part ?? '').length), 0);
    }
  }
  const records = new Map();
  const window = {
    CSS: { escape: String }, innerWidth: 1400, innerHeight: 900,
    g_universe: { itemsByGuid: {}, listviews: [], workspace: { guid: 'WS_V445' } },
    addEventListener() {}, removeEventListener() {},
  };
  const context = {
    AppPlugin: class {}, console, Promise, Date, Math, Map, Set, WeakMap, WeakSet,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    performance, CSS: window.CSS, document, window,
    Element: FakeElement, MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: FakeIntersectionObserver,
    Blob: FakeBlob,
    URL: {
      createObjectURL: () => 'blob:v445-' + (++urlSeq),
      revokeObjectURL: (url) => { revokedUrls.push(url); },
    },
    navigator: { platform: 'MacIntel', clipboard: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail || null; } },
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  const plugin = new context.PluginUnderTest();
  plugin._unloaded = false;
  plugin.data = {
    getRecord: (guid) => records.get(guid) || null,
    getAllCollections: async () => [],
    searchByQuery: async () => ({ records: [], lines: [] }),
  };
  plugin.ui = { getPanels: () => [], addCommandPaletteCommand: () => ({ remove() {} }), addStatusBarItem: () => ({ remove() {} }) };
  plugin.events = { on: () => 'evt', off: () => {} };
  plugin.getConfiguration = () => ({ custom: {} });
  plugin._toast = () => {};
  plugin._initInlineMediaRuntime();
  return { plugin, context, document, window, records, revokedUrls };
}

// A real blob-capable line handle at the SDK boundary. getBlob/download are
// the only fakes — everything between the row and this handle is production code.
function blobLine(guid, fileName, extra = {}) {
  const bytes = extra.bytes || new Uint8Array(64);
  const line = {
    guid,
    type: extra.type || 'image',
    props: { fileName, fileSize: bytes.byteLength, ...(extra.props || {}) },
    record: extra.record || null,
    getBlobCalls: 0,
    async getBlob() {
      line.getBlobCalls++;
      if (extra.throwBlob) throw new Error('blob backend down');
      return {
        contentType: extra.contentType || 'image/png',
        fileName,
        fileSize: bytes.byteLength,
        download: async () => bytes,
      };
    },
  };
  return line;
}

function click(el) {
  el.dispatchEvent({ type: 'click' });
}

// ─────────────────────────────────────────────────────────────────────────

test('linked-reference row built from a cold media stub: toggle rehydrates by guid and paints', async () => {
  const h = harness();
  const real = blobLine('IMG_COLD', 'diagram.png', {
    record: { guid: 'SRC' },
    props: { width: 800, height: 600 },
  });
  h.records.set('SRC', { guid: 'SRC', getLineItems: async () => [real] });
  const stub = { guid: 'IMG_COLD', type: 'image', props: { fileName: 'diagram.png', width: 800, height: 600 }, record: { guid: 'SRC' } };

  const built = h.plugin._buildRefContextRow(stub, { rowClass: 'refx-inline-refs-row' });
  h.document.body.append(built.rowEl);

  const card = built.rowEl.querySelector('.refx-preview-media-card');
  assert.ok(card, 'media line renders a card, not dead text');
  const toggle = built.rowEl.querySelector('.refx-preview-media-action');
  assert.equal(toggle.textContent, 'Show image', 'RefX preview toggle replaces the native dead button');
  const host = built.rowEl.querySelector('.refx-preview-media-host');
  assert.equal(host.classList.contains('is-pending'), true, 'skeleton reserves the box before any load');
  assert.equal(host.style['aspect-ratio'], '800 / 600', 'declared dims pin the reserved box from first paint');

  // Viewport-gated: registered, but zero blob work before the row is seen.
  assert.equal(h.plugin._inlineMediaStats.viewportQueued, 1);
  assert.equal(real.getBlobCalls, 0, 'no fetch storm: nothing downloads before viewport entry');

  click(toggle);
  await tick(50);
  assert.equal(real.getBlobCalls, 1, 'cold row rehydrated to the blob-capable line via the owner tree');
  assert.equal(built.rowEl.querySelectorAll('.refx-preview-media-image').length, 1);
  assert.equal(host.classList.contains('is-pending'), false, 'skeleton released after the decode settled');
  assert.equal(host.style['aspect-ratio'], '800 / 600', 'settled geometry identical to the skeleton geometry');
  assert.equal(h.plugin._inlineMediaStats.loads, 1);
  assert.equal(h.window.__REFX_MEDIA_STATS, h.plugin._inlineMediaStats);
  assert.equal(toggle.textContent, 'Hide image');
});

test('viewport gate: fast scroll past a row queues nothing; entry settles the load', async () => {
  const h = harness();
  const real = blobLine('IMG_GATE', 'gate.png');
  h.window.g_universe.itemsByGuid['IMG_GATE'] = { guid: 'IMG_GATE', lineItem: real, rguid: 'SRC' };
  const stub = { guid: 'IMG_GATE', type: 'image', props: { fileName: 'gate.png' }, record: { guid: 'SRC' } };

  const built = h.plugin._buildRefContextRow(stub, {});
  h.document.body.append(built.rowEl);
  await tick(200);
  assert.equal(real.getBlobCalls, 0, 'no intersection → no download, no matter how long it sits');
  assert.equal(h.plugin._inlineMediaStats.viewportFired, 0);

  const observer = FakeIntersectionObserver.instances[0];
  assert.ok(observer, 'shared observer exists');
  assert.equal(observer.observed.size, 1);
  observer.fireAll();
  await tick(200);
  assert.equal(h.plugin._inlineMediaStats.viewportFired, 1);
  assert.equal(real.getBlobCalls, 1);
  assert.equal(built.rowEl.querySelectorAll('.refx-preview-media-image').length, 1);
  assert.equal(observer.observed.size, 0, 'card unobserved after the one-shot load');
});

test('linked-ref subtree child rows render a working preview through the live-state ladder', async () => {
  const h = harness();
  const real = blobLine('IMG_CHILD', 'child.png');
  h.window.g_universe.itemsByGuid['IMG_CHILD'] = { guid: 'IMG_CHILD', lineItem: real, rguid: 'SRC' };
  const childStub = { guid: 'IMG_CHILD', type: 'image', props: { fileName: 'child.png' }, children: [] };
  const target = {
    guid: 'REF_LINE', record: { guid: 'SRC' },
    segments: [{ type: 'text', text: 'referencing line' }],
    children: [childStub],
  };
  const ctx = { onJump() {}, canEdit: false, hostLineGuid: null, alive: () => true };

  const tree = h.plugin._buildRefChildTree(target, ctx);
  h.document.body.append(tree);
  const toggle = tree.querySelector('.refx-preview-media-action');
  assert.ok(toggle, 'subtree child media row keeps the preview toggle');

  click(toggle);
  await tick(50);
  assert.equal(real.getBlobCalls, 1, 'child resolved through live state to the blob line');
  assert.equal(tree.querySelectorAll('.refx-preview-media-image').length, 1);
});

test('chain rows: image hop renders a media card, text hop stays text, subtree marker kept', async () => {
  const h = harness();
  const real = blobLine('HOP_IMG', 'pasted-2026.png');
  h.window.g_universe.itemsByGuid['HOP_IMG'] = {
    guid: 'HOP_IMG', type: 'image', props: { fileName: 'pasted-2026.png' }, lineItem: real, rguid: 'OWNER',
  };
  const chain = [
    { guid: 'HOP_IMG', isLine: true, title: 'pasted-2026.png', ownerRecord: { guid: 'OWNER' }, text: 'pasted-2026.png', depth: 1, via: 'subtree' },
    { guid: 'HOP_TXT', isLine: true, title: 'a text block', ownerRecord: { guid: 'OWNER' }, text: 'a text block', depth: 2, via: 'inline' },
  ];
  const body = new FakeElement('div');
  h.document.body.append(body);

  h.plugin._appendRefChainSection(body, 'ROOT_GUID', chain);

  const rows = body.querySelectorAll('.refx-ref-chain-row');
  assert.equal(rows.length, 2);
  const card = rows[0].querySelector('.refx-preview-media-card');
  assert.ok(card, 'image hop renders a preview card');
  assert.ok(rows[0].querySelector('.refx-ref-chain-via'), 'subtree via marker preserved on media rows');
  assert.equal(rows[1].querySelector('.refx-preview-media-card'), null, 'text hop never grows a card');
  assert.match(rows[1].textContent, /a text block/);

  const toggle = rows[0].querySelector('.refx-preview-media-action');
  click(toggle);
  await tick(50);
  assert.equal(real.getBlobCalls, 1);
  assert.equal(rows[0].querySelectorAll('.refx-preview-media-image').length, 1, 'chain row paints the image inline');
});

test('chain row for a target no client has seen fails closed to the text row', () => {
  const h = harness();
  const chain = [
    { guid: 'HOP_COLD', isLine: true, title: 'cold block', ownerRecord: null, text: 'cold block', depth: 1, via: 'inline' },
  ];
  const body = new FakeElement('div');
  h.document.body.append(body);

  h.plugin._appendRefChainSection(body, 'ROOT_GUID', chain);
  const rows = body.querySelectorAll('.refx-ref-chain-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.refx-preview-media-card'), null);
  assert.match(rows[0].textContent, /cold block/);
  assert.equal(h.plugin._inlineMediaStats.viewportQueued, 0, 'no speculative media work for unresolvable hops');
});

test('hover popup: image target gets a lazy thumbnail under the title from state alone', async () => {
  const h = harness();
  const real = blobLine('IMG_TARGET', 'pasted-2026-07-27.png');
  h.window.g_universe.itemsByGuid['IMG_TARGET'] = {
    guid: 'IMG_TARGET', type: 'image', props: { fileName: 'pasted-2026-07-27.png' },
    lineItem: real, rguid: null, // cold owner: no record resolve — thumbnail must still render
  };
  const pop = new FakeElement('div');
  pop.className = 'refalias-pop refx-hoverpop';
  h.document.body.append(pop);

  h.plugin._fillHoverPop(pop, 'IMG_TARGET', () => true, {});
  await tick(20);

  const native = pop.children[0];
  assert.ok(native.classList.contains('refx-popup-native'));
  assert.equal(native.children[0].classList.contains('refx-hoverpop-title'), true);
  assert.equal(native.children[0].textContent, 'pasted-2026-07-27.png', 'title stays the honest filename');
  const thumb = native.children[1];
  assert.equal(thumb.classList.contains('refx-hoverpop-thumb'), true, 'thumbnail sits directly under the title');
  assert.ok(thumb.querySelector('.refx-preview-media-thumb'), 'thumb-sized card variant');
  assert.equal(real.getBlobCalls, 0, 'thumbnail is lazy — nothing fetched before viewport entry');

  FakeIntersectionObserver.instances[0].fireAll();
  await tick(200);
  assert.equal(real.getBlobCalls, 1);
  assert.equal(thumb.querySelectorAll('.refx-preview-media-image').length, 1);
});

test('hover popup: text target renders no media surface at all', async () => {
  const h = harness();
  h.window.g_universe.itemsByGuid['TEXT_TARGET'] = {
    guid: 'TEXT_TARGET', text_segments: ['text', 'plain block text'], rguid: null,
  };
  const pop = new FakeElement('div');
  h.document.body.append(pop);

  h.plugin._fillHoverPop(pop, 'TEXT_TARGET', () => true, {});
  await tick(20);

  assert.equal(pop.querySelector('.refx-hoverpop-thumb'), null);
  assert.equal(pop.querySelector('.refx-preview-media-card'), null);
  assert.equal(h.plugin._inlineMediaStats.viewportQueued, 0, 'text lines are untouched by the media path');
  assert.equal(h.plugin._inlineMediaStats.hoverMediaSweeps, 0, 'no DOM sweep for an ordinary text chip');
  const title = pop.querySelector('.refx-hoverpop-title');
  assert.equal(title.textContent, 'plain block text');
});

test('block-context outline renders image children as compact lazy media, text target untouched', async () => {
  const h = harness();
  const imgChild = blobLine('CTX_IMG', 'context-child.png');
  imgChild.parent_guid = 'CTX_TARGET';
  imgChild.children = [];
  const target = {
    guid: 'CTX_TARGET', segments: [{ type: 'text', text: 'context target' }],
    children: [imgChild],
  };
  const pop = new FakeElement('div');
  const body = new FakeElement('div');
  body.className = 'refx-line-context-body';
  pop.append(body);
  h.document.body.append(pop);

  const rendered = h.plugin._renderLineRefContext(pop, 'CTX_TARGET', [target], 'Owner Page', null, null, { surface: 'popover', chain: [] });
  assert.equal(rendered, true);

  const compact = body.querySelectorAll('.refx-preview-media-card-compact');
  assert.equal(compact.length, 1, 'child media row renders a compact card instead of "…"');
  assert.equal(body.querySelectorAll('.refx-preview-target-text').length, 1, 'text target keeps its text row');
  assert.equal(imgChild.getBlobCalls, 0, 'context outline is lazy');
  assert.equal(h.plugin._inlineMediaStats.viewportQueued, 1);

  FakeIntersectionObserver.instances[0].fireAll();
  await tick(200);
  assert.equal(imgChild.getBlobCalls, 1);
  assert.equal(compact[0].querySelectorAll('.refx-preview-media-image').length, 1);
});

test('media resolve failure records __REFX_LAST_ERROR and fails closed', async () => {
  const h = harness();
  const broken = blobLine('IMG_BROKEN', 'broken.png', { throwBlob: true });
  // The cold stub row rehydrates to this handle through live state; the blob
  // backend then throws, which is the failure under test.
  h.window.g_universe.itemsByGuid['IMG_BROKEN'] = { guid: 'IMG_BROKEN', lineItem: broken, rguid: 'SRC' };
  const built = h.plugin._buildRefContextRow(
    { guid: 'IMG_BROKEN', type: 'image', props: { fileName: 'broken.png' } },
    { rowClass: 'refx-inline-refs-row' }
  );
  h.document.body.append(built.rowEl);
  const toggle = built.rowEl.querySelector('.refx-preview-media-action');

  click(toggle);
  await tick(50);
  assert.equal(h.plugin._inlineMediaStats.failures, 1);
  assert.match(String(h.window.__REFX_LAST_ERROR || ''), /inline media asset IMG_BROKEN/);
  assert.equal(built.rowEl.querySelectorAll('.refx-preview-media-image').length, 0, 'no partial paint on failure');
  assert.equal(toggle.textContent, 'Preview unavailable', 'fail-closed label, never a silent drop');
  const host = built.rowEl.querySelector('.refx-preview-media-host');
  assert.equal(host.classList.contains('is-pending'), false, 'skeleton released on failure');
});

test('resolveLine rejection is recorded and the card fails closed', async () => {
  const h = harness();
  const container = new FakeElement('div');
  h.document.body.append(container);
  h.plugin._renderPreviewLineItem(container, {
    guid: 'IMG_REJECT', type: 'image', props: { fileName: 'reject.png' },
  }, {
    autoLoadImage: false,
    openSource: false,
    resolveLine: async () => { throw new Error('owner tree exploded'); },
  });
  const toggle = container.querySelector('.refx-preview-media-action');
  click(toggle);
  await tick(50);
  assert.match(String(h.window.__REFX_LAST_ERROR || ''), /media resolveLine IMG_REJECT/);
  assert.equal(toggle.textContent, 'Preview unavailable');
});

test('viewport queue refuses past 200: visible rows keep their loads, refused row keeps its skeleton', async () => {
  const h = harness();
  const cards = [];
  const fired = [];
  for (let i = 0; i < 201; i++) {
    const card = new FakeElement('span');
    card.className = 'refx-preview-media-card';
    h.document.body.append(card);
    cards.push(card);
    const idx = i;
    h.plugin._gateMediaViewportLoad(card, () => fired.push(idx), 10, () => card.classList.add('cancelled'));
  }
  assert.equal(h.plugin._mediaViewportPending.size, 200, 'queue hard-bounded');
  assert.equal(h.plugin._inlineMediaStats.viewportDropped, 1, 'the 201st registration is refused');
  const observer = FakeIntersectionObserver.instances[0];
  assert.equal(observer.observed.has(cards[200]), false, 'refused card is never observed');
  assert.equal(observer.observed.has(cards[0]), true, 'the TOP (visible) row keeps its slot');
  assert.equal(cards[200].classList.contains('cancelled'), false,
    'refusal never cancels: the reserved box and manual toggle stay intact');

  // The visible rows all load when the observer fires — zero collapse events.
  for (let i = 0; i < 20; i++) observer.fire(cards[i]);
  await tick(50);
  assert.deepEqual(fired, Array.from({ length: 20 }, (_, i) => i), 'first 20 (visible) rows load');
  assert.equal(h.plugin._inlineMediaStats.viewportFired, 20);
  assert.equal(cards.filter((card) => card.classList.contains('cancelled')).length, 0,
    'no card anywhere was collapsed by queue management');
});

test('dispose tears down the observer, pending loads, and window mirrors', () => {
  const h = harness();
  const card = new FakeElement('span');
  h.document.body.append(card);
  h.plugin._gateMediaViewportLoad(card, () => {}, 120);
  assert.equal(h.plugin._mediaViewportPending.size, 1);

  h.plugin._disposeInlineMediaRuntime();
  const observer = FakeIntersectionObserver.instances[0];
  assert.equal(observer.disconnected, true, 'observer disconnected with the runtime');
  assert.equal(h.plugin._mediaViewportPending.size, 0);
  assert.equal(h.window.__REFX_MEDIA_STATS, null, 'stats mirror released');
  assert.equal(h.window.__refxInlineMediaUrls, null, 'url set mirror released');
});

test('byte-cap eviction and decline paths advance the forensic counters', async () => {
  const h = harness();
  h.plugin._inlineMediaBytes = 48 * 1024 * 1024 - 10; // one 64B image over the cap
  const first = blobLine('IMG_EVICT_OLD', 'old.png');
  await h.plugin._resolveInlineMediaAsset(first);
  assert.equal(h.plugin._inlineMediaStats.evictions >= 1, false, 'cache was empty — no eviction yet');
  assert.equal(h.plugin._inlineMediaStats.loads, 1);

  // Pin the cached URL as active so the next over-cap load must DECLINE.
  const cachedUrl = [...h.plugin._inlineMediaUrls][0];
  const img = new FakeElement('img');
  img.className = 'refx-preview-media-image';
  img.src = cachedUrl;
  Object.defineProperty(img, 'currentSrc', { get: () => cachedUrl });
  h.document.body.append(img);

  const second = blobLine('IMG_EVICT_NEW', 'new.png');
  const asset = await h.plugin._resolveInlineMediaAsset(second);
  assert.equal(asset, null, 'all-pinned cache declines the new load');
  assert.equal(h.plugin._inlineMediaStats.byteCapDrops, 1);
  assert.equal(h.plugin._inlineMediaStats.loads, 1, 'declined load is not counted as a load');
});

// ─────────────────────────────────────────────────────────────────────────
// v4.45.2 — media review hardening.

test('zero layout shift: skeleton holds through decode and keeps identical geometry', async () => {
  const h = harness({ manualDecode: true });
  const real = blobLine('IMG_SHIFT', 'shift.png');
  h.window.g_universe.itemsByGuid['IMG_SHIFT'] = { guid: 'IMG_SHIFT', lineItem: real, rguid: 'SRC' };
  const stub = {
    guid: 'IMG_SHIFT', type: 'image',
    props: { fileName: 'shift.png', width: 800, height: 600 }, record: { guid: 'SRC' },
  };
  const built = h.plugin._buildRefContextRow(stub, { rowClass: 'refx-inline-refs-row' });
  h.document.body.append(built.rowEl);
  const host = built.rowEl.querySelector('.refx-preview-media-host');
  assert.equal(host.classList.contains('is-pending'), true);
  assert.equal(host.style['aspect-ratio'], '800 / 600', 'skeleton pinned to declared dims before any fetch');

  const toggle = built.rowEl.querySelector('.refx-preview-media-action');
  click(toggle);
  await tick(50);
  const img = built.rowEl.querySelector('.refx-preview-media-image');
  assert.ok(img, 'image node appended');
  assert.equal(host.classList.contains('is-pending'), true,
    'skeleton HELD while the blob image is still undecoded — no collapse to zero');

  img.naturalWidth = 800;
  img.naturalHeight = 600;
  img._resolveDecode();
  await tick(20);
  assert.equal(host.classList.contains('is-pending'), false, 'skeleton released only after decode settled');
  assert.equal(host.style['aspect-ratio'], '800 / 600', 'settled geometry identical to skeleton geometry');
});

test('zero layout shift without declared dims: decode pins the ratio from natural size', async () => {
  const h = harness({ manualDecode: true });
  const real = blobLine('IMG_NODIMS', 'nodims.png');
  h.window.g_universe.itemsByGuid['IMG_NODIMS'] = { guid: 'IMG_NODIMS', lineItem: real, rguid: 'SRC' };
  const built = h.plugin._buildRefContextRow(
    { guid: 'IMG_NODIMS', type: 'image', props: { fileName: 'nodims.png' }, record: { guid: 'SRC' } },
    { rowClass: 'refx-inline-refs-row' }
  );
  h.document.body.append(built.rowEl);
  const host = built.rowEl.querySelector('.refx-preview-media-host');
  assert.equal(host.style['aspect-ratio'], undefined, 'no dims anywhere → no speculative pin');

  click(built.rowEl.querySelector('.refx-preview-media-action'));
  await tick(50);
  const img = built.rowEl.querySelector('.refx-preview-media-image');
  assert.equal(host.classList.contains('is-pending'), true, 'box kept until decode when dims unavailable');
  img.naturalWidth = 1024;
  img.naturalHeight = 512;
  img._resolveDecode();
  await tick(20);
  assert.equal(host.classList.contains('is-pending'), false);
  assert.equal(host.style['aspect-ratio'], '1024 / 512', 'decode pins the ratio before the swap');
});

test('hover media fallback sweeps only for state-less plausibly-media targets', async () => {
  const h = harness();
  // State-absent target: no text evidence anywhere → the gated sweep runs once.
  const pop = new FakeElement('div');
  h.document.body.append(pop);
  h.plugin._fillHoverPop(pop, 'COLD_UNKNOWN', () => true, {});
  await tick(20);
  assert.equal(h.plugin._inlineMediaStats.hoverMediaSweeps, 1, 'plausibly-media cold target earns one sweep');
  assert.equal(pop.querySelector('.refx-hoverpop-thumb'), null, 'nothing invented when the sweep finds nothing');

  // State-present text chip: the fallback must never sweep.
  h.window.g_universe.itemsByGuid['TEXT_CHIP'] = {
    guid: 'TEXT_CHIP', text_segments: ['text', 'ordinary text chip'], rguid: null,
  };
  const pop2 = new FakeElement('div');
  h.document.body.append(pop2);
  h.plugin._fillHoverPop(pop2, 'TEXT_CHIP', () => true, {});
  await tick(20);
  assert.equal(h.plugin._inlineMediaStats.hoverMediaSweeps, 1, 'text-chip hover adds zero sweeps');
});

test('mid-load attachment removal clears the skeleton and renders the unavailable state once', async () => {
  const h = harness();
  const container = new FakeElement('div');
  h.document.body.append(container);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const real = blobLine('IMG_DIED', 'died.png');
  h.plugin._renderPreviewLineItem(container, {
    guid: 'IMG_DIED', type: 'image', props: { fileName: 'died.png' },
  }, { autoLoadImage: false, openSource: false, resolveLine: () => gate });
  const toggle = container.querySelector('.refx-preview-media-action');
  const host = container.querySelector('.refx-preview-media-host');

  click(toggle);
  await tick(10);
  assert.equal(host.classList.contains('is-pending'), true, 'in-flight load holds the skeleton');

  h.plugin._retireInlineMediaConsumers('IMG_DIED'); // attachment deleted mid-load
  assert.equal(host.classList.contains('is-pending'), false, 'retire clears the pending box');
  assert.equal(host.querySelectorAll('.refx-preview-media-unavailable').length, 1,
    'unavailable state renders in place of the box');
  assert.equal(toggle.disabled, true);

  release(real);
  await tick(30);
  assert.equal(host.classList.contains('is-pending'), false, 'the !available() early-return keeps the box cleared');
  assert.equal(host.querySelectorAll('.refx-preview-media-unavailable').length, 1,
    'early-return path does not double-render the unavailable state');
  assert.equal(container.querySelectorAll('.refx-preview-media-image').length, 0, 'no paint after death');
});

test('viewport queue reaps disconnected cards on registration and on fire', async () => {
  const h = harness();
  const dead = new FakeElement('span'); // never appended → isConnected false
  const live = new FakeElement('span');
  h.document.body.append(live);
  h.plugin._gateMediaViewportLoad(dead, () => {}, 10);
  assert.equal(h.plugin._mediaViewportPending.size, 1);
  h.plugin._gateMediaViewportLoad(live, () => {}, 10);
  assert.equal(h.plugin._mediaViewportPending.size, 1, 'dead card reaped when the live one registered');
  assert.equal(h.plugin._mediaViewportPending.has(live), true);
  const observer = FakeIntersectionObserver.instances[0];
  assert.equal(observer.observed.has(dead), false, 'reaped card unobserved');

  // Fire-time reap: a card disconnected AFTER registration is dropped by the callback.
  const dead2 = new FakeElement('span');
  h.document.body.append(dead2);
  let dead2Kicked = 0;
  h.plugin._gateMediaViewportLoad(dead2, () => dead2Kicked++, 10);
  assert.equal(h.plugin._mediaViewportPending.size, 2);
  dead2.remove();
  observer.fire(live);
  assert.equal(h.plugin._mediaViewportPending.has(dead2), false, 'fire-time reap drops disconnected cards');
  await tick(30);
  assert.equal(dead2Kicked, 0, 'reaped card never loads');
});

test('observer constructor failure latches with a counter; re-init resets the latch', async () => {
  const h = harness();
  const ThrowingIO = class { constructor() { throw new Error('transient IO failure'); } };
  h.context.IntersectionObserver = ThrowingIO;
  const card = new FakeElement('span');
  h.document.body.append(card);
  let kicked = 0;
  const result = h.plugin._gateMediaViewportLoad(card, () => kicked++, 10);
  assert.equal(result, false, 'falls back to the bounded timer');
  assert.equal(h.plugin._mediaViewportObserverFailed, true, 'latched');
  assert.equal(h.plugin._inlineMediaStats.observerFailures, 1, 'trip counted for forensics');
  await tick(30);
  assert.equal(kicked, 1, 'timer fallback still loads the row');

  h.context.IntersectionObserver = FakeIntersectionObserver;
  h.plugin._initInlineMediaRuntime();
  assert.equal(h.plugin._mediaViewportObserverFailed, false, 'init resets the one-shot latch');
  const card2 = new FakeElement('span');
  h.document.body.append(card2);
  assert.equal(h.plugin._gateMediaViewportLoad(card2, () => {}, 10), true, 'viewport gating restored');
  // Dispose also clears the latch for the next runtime generation.
  h.context.IntersectionObserver = ThrowingIO;
  h.plugin._mediaViewportObserverInstance = null; // force reconstruction with the throwing class
  const card3 = new FakeElement('span');
  h.document.body.append(card3);
  h.plugin._gateMediaViewportLoad(card3, () => {}, 10);
  assert.equal(h.plugin._mediaViewportObserverFailed, true);
  h.plugin._disposeInlineMediaRuntime();
  assert.equal(h.plugin._mediaViewportObserverFailed, false, 'dispose resets the latch');
});

test('post-dispose and post-unload gates refuse resurrection', () => {
  const h = harness();
  h.plugin._disposeInlineMediaRuntime();
  FakeIntersectionObserver.instances = [];
  const card = new FakeElement('span');
  h.document.body.append(card);
  let kicked = 0;
  const result = h.plugin._gateMediaViewportLoad(card, () => kicked++, 10);
  assert.equal(result, null, 'disposed runtime refuses registration outright');
  assert.equal(FakeIntersectionObserver.instances.length, 0, 'no resurrected observer');
  assert.equal(h.plugin._mediaViewportPending.size, 0);
  assert.equal(kicked, 0, 'no timer fallback after dispose');

  const h2 = harness();
  h2.plugin._unloaded = true;
  const card2 = new FakeElement('span');
  h2.document.body.append(card2);
  assert.equal(h2.plugin._gateMediaViewportLoad(card2, () => {}, 10), null, 'unloaded plugin refuses too');
  assert.equal(FakeIntersectionObserver.instances.length, 0, 'still no observer constructed');
});

test('cold media resolve miss bumps failures and records the target guid', async () => {
  const h = harness();
  const before = h.plugin._inlineMediaStats.failures;
  const result = await h.plugin._resolveMediaLineByGuid('IMG_NEVER_SEEN');
  assert.equal(result, null);
  assert.equal(h.plugin._inlineMediaStats.failures, before + 1, 'silent miss now counted');
  assert.match(String(h.window.__REFX_LAST_ERROR || ''), /media resolve miss IMG_NEVER_SEEN/);
});
