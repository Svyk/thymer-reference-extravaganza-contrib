'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function makeDom() {
  let document = null;
  let layoutReads = 0;
  const observers = [];

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
      this.placeholder = '';
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
    get innerHTML() { return this.textContent; }
    set innerHTML(value) { this.textContent = value; }
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
    get nextElementSibling() { return this.nextSibling; }
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
    before(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      for (const node of nodes) { if (node != null) parent.insertBefore(node, this); }
    }
    insertAdjacentElement(where, el) {
      if (where === 'beforeend') { this.append(el); return el; }
      if (where === 'afterbegin') { return this.insertBefore(el, this.children[0] || null); }
      const parent = this.parentNode;
      if (!parent) return null;
      const index = parent.children.indexOf(this);
      const before = where === 'afterend' ? parent.children[index + 1] || null : this;
      return parent.insertBefore(el, before);
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
    hasAttribute(name) { return name === 'class' ? !!this.className : Object.hasOwn(this._attrs, name); }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((x) => x !== fn); }
    dispatchEvent(event) {
      event = event || {};
      event.type ||= '';
      event.target ||= this; event.currentTarget = this;
      event.preventDefault ||= function () { this.defaultPrevented = true; };
      event.stopPropagation ||= function () { this.propagationStopped = true; };
      event.stopImmediatePropagation ||= function () { this.immediateStopped = true; };
      for (const fn of [...(this._listeners[event.type] || [])]) fn(event);
      return !event.defaultPrevented;
    }
    click() { return this.dispatchEvent({ type: 'click' }); }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    getBoundingClientRect() { layoutReads++; return { top: 30, left: 30, right: 180, bottom: 50, width: 150, height: 20 }; }
    matches(selector) {
      selector = selector.trim();
      if (!selector) return false;
      const notDisabled = selector.endsWith(':not([disabled])');
      if (notDisabled) { if (this.disabled) return false; selector = selector.slice(0, -16); }
      const attr = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attr) {
        selector = selector.slice(0, attr.index);
        const got = this.getAttribute(attr[1]);
        if (got == null || (attr[2] != null && got !== attr[2])) return false;
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
      // `:scope > .x` matches DIRECT children only. The reference-row machinery
      // relies on it to find a row's own fulltext span without reaching into a
      // nested row, so a stub that ignored it would silently exercise the
      // defensive fallback path instead of the real one.
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

  const body = new FakeElement('body'); body._setConnected(true);
  const head = new FakeElement('head'); head._setConnected(true);
  const docListeners = new Map();
  document = {
    hidden: false, body, head, activeElement: null,
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeElement('#text', text),
    querySelector: (selector) => body.querySelector(selector) || head.querySelector(selector),
    querySelectorAll: (selector) => [...body.querySelectorAll(selector), ...head.querySelectorAll(selector)],
    getElementById: (id) => [...body.querySelectorAll('*'), ...head.querySelectorAll('*')].find((node) => node.id === id) || null,
    getElementsByClassName: (name) => body.querySelectorAll('.' + name),
    contains: (node) => !!node?.isConnected,
    addEventListener: (type, fn) => { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn); },
    removeEventListener: (type, fn) => { docListeners.set(type, (docListeners.get(type) || []).filter((x) => x !== fn)); },
    dispatchEvent: (event) => { for (const fn of docListeners.get(event.type) || []) fn(event); return true; },
  };
  document.documentElement._setConnected(true);

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }

  return { document, FakeElement, FakeMutationObserver, observers, layoutReads: () => layoutReads };
}

function loadHarness(options = {}) {
  const dom = makeDom();
  const storage = options.storage || new Map();
  const commands = [];
  const records = new Map();
  const eventHandlers = new Map();
  let eventSequence = 0;
  const winListeners = new Map();
  const add = (map, type, fn) => { if (!map.has(type)) map.set(type, []); map.get(type).push(fn); };
  const remove = (map, type, fn) => map.set(type, (map.get(type) || []).filter((x) => x !== fn));
  const window = {
    CSS: { escape: String }, innerWidth: 1400, innerHeight: 900,
    g_universe: { itemsByGuid: {}, listviews: [], workspace: { guid: 'WS_A2' } },
    addEventListener: (type, fn) => add(winListeners, type, fn),
    removeEventListener: (type, fn) => remove(winListeners, type, fn),
    dispatchEvent: (event) => { for (const fn of winListeners.get(event.type) || []) fn(event); return true; },
  };
  const context = {
    AppPlugin: class {}, console, Promise, Date, Math, Map, Set, WeakMap, WeakSet,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false }), 0), cancelIdleCallback: clearTimeout,
    performance, CSS: window.CSS, document: dom.document, window,
    Element: dom.FakeElement, MutationObserver: dom.FakeMutationObserver, DateTime: undefined,
    navigator: { platform: 'MacIntel', userAgent: 'Mac', clipboard: { writeText: async () => {}, readText: async () => '' } },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail || null; } },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  };
  context.globalThis = context; Object.assign(context, window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });

  const plugin = new context.PluginUnderTest();
  plugin._unloaded = false; plugin.workspaceGuid = 'WS_A2';
  plugin.data = {
    getRecord: (guid) => records.get(guid) || null,
    getAllCollections: async () => [], getAllRecords: () => [...records.values()],
    searchByQuery: async () => ({ records: [], lines: [] }), getAllGlobalPlugins: async () => [],
  };
  plugin.events = {
    on: (name, callback) => {
      const id = name + ':' + (++eventSequence);
      if (!eventHandlers.has(name)) eventHandlers.set(name, []);
      eventHandlers.get(name).push({ id, callback });
      return id;
    },
    off: (id) => {
      for (const entries of eventHandlers.values()) {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index >= 0) entries.splice(index, 1);
      }
    },
  };
  plugin.ui = {
    addCommandPaletteCommand: (command) => { commands.push(command); return { remove() {} }; },
    addStatusBarItem: () => ({ remove() {} }), getPanels: () => [], getActivePanel: () => null,
  };
  plugin.getConfiguration = () => ({ custom: { aliasChips: true } });
  plugin.refreshAllPanels = () => {};
  plugin._toast = () => {};
  plugin._refocusEditor = () => {};
  return { ...dom, context, plugin, records, commands, storage, window, winListeners, eventHandlers };
}

function event(type, extra = {}) {
  return {
    type, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {}, stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    ...extra,
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function expandCtxStrip(strip) {
  const twist = strip?.querySelector?.('.refx-ctxstrip-twist');
  if (twist && twist.getAttribute('aria-expanded') === 'false') {
    twist.dispatchEvent(event('click', {}));
    await tick(10);
  }
}

function lineRefClickHarness(custom = {}) {
  const h = loadHarness();
  h.plugin.getConfiguration = () => ({ custom: { aliasChips: false, lineRefClickMenu: true, ...custom } });
  for (const name of ['_beginAutoTitleGeneration', '_injectStyle', '_ensureThemeObserver', '_counterInit', '_rehydrate', '_wbLiveInit', '_r6MigrateExistingPins', '_scheduleRecordNameIndex', '_r4RegisterCommands', '_r10Init', '_wbSyncStatusIcon']) h.plugin[name] = () => {};
  h.plugin._buildFieldTypes = async () => {};
  h.plugin.onLoad();

  const root = h.document.createElement('div'); root.className = 'listview-items'; root.setAttribute('data-guid', 'PAGE_CLICK');
  const line = h.document.createElement('div'); line.className = 'listitem'; line.setAttribute('data-guid', 'LINE_CLICK');
  const chip = h.document.createElement('span'); chip.className = 'lineitem-ref refx-lineref-chip'; chip.setAttribute('data-guid', 'TARGET_CLICK');
  root.append(line); line.append(chip); h.document.body.append(root);
  return { ...h, root, line, chip };
}

// ── v4.41.0: Remarks in Block Context + collapsible strip ────────────────────

const REMARKS_COL = '1ZG05C7ST1T13EWAF5S2M4VNQR';

// Real badge plumbing, same as the v4.40 context tests: a count badge inside a
// host line, routed through the production _routeBadgeClick.
function badgeHarness(targetGuid, custom = {}) {
  const h = lineRefClickHarness(custom);
  h.plugin.ensureRuntimeState();
  // _counterInit is stubbed in this harness; mirror its lineRefProperties
  // normalization (false/[] → [], absent → ['Source Line']) so remark chips
  // read the same configured list the production config loader would set.
  h.plugin._lineRefPropsConfigured = h.plugin.normalizeLineRefProps(
    custom.lineRefProperties != null ? custom.lineRefProperties : ['Source Line']
  );
  h.plugin._isPinned = () => false;
  h.plugin._paintPinButton = () => {};
  h.plugin._ensureCardObserver = () => {};
  h.plugin._hasEmbedOpen = () => null;
  h.plugin._fillInlineRefs = async () => {};
  h.plugin._inlineRefsPersistCollapse = false;
  const host = h.document.createElement('div');
  host.className = 'listitem';
  host.setAttribute('data-guid', 'BADGE_HOST');
  const wrap = h.document.createElement('span');
  wrap.className = 'trc-refcount-badge-wrap';
  wrap.dataset.guid = targetGuid;
  host.append(wrap);
  h.root.append(host);
  return { ...h, host, wrap };
}

function badgeOwner(h, ownerGuid, targetGuid, label) {
  let reads = 0;
  h.records.set(ownerGuid, {
    guid: ownerGuid,
    getName: () => label + ' owner',
    getLineItems: async () => {
      reads++;
      return [{
        guid: 'BADGE_ROOT', parent_guid: ownerGuid, type: 'ulist',
        segments: [{ type: 'text', text: label + ' root' }],
        children: [{
          guid: targetGuid, parent_guid: 'BADGE_ROOT', type: 'ulist',
          segments: [{ type: 'text', text: label + ' target' }],
          children: [{
            guid: 'BADGE_CHILD', parent_guid: targetGuid, type: 'ulist',
            segments: [{ type: 'text', text: label + ' child' }], children: [],
          }],
        }],
      }];
    },
  });
  h.plugin._lineOwnerHints.set(targetGuid, ownerGuid);
  return () => reads;
}

// A fake Remarks collection whose records carry "Source Line" (+ optional
// "Excerpt") properties, mirroring the live org-remark record shape. Records
// are also registered in the records map so event patches re-resolve them.
function remarksFixture(h, remarks) {
  const store = new Map();
  for (const r of remarks) {
    const rec = {
      guid: r.guid,
      getName: () => 'Highlight — ' + r.guid,
      getAllProperties: () => [
        { name: 'Source Line', values: () => [r.sourceLine] },
        ...(r.excerpt != null ? [{ name: 'Excerpt', values: () => [r.excerpt] }] : []),
      ],
      getLineItems: async () => {
        r.reads = (r.reads || 0) + 1;
        return r.body ? [{ guid: r.guid + '_BODY', segments: [{ type: 'text', text: r.body }] }] : [];
      },
      _fixture: r,
    };
    store.set(r.guid, rec);
    h.records.set(r.guid, rec);
  }
  h.plugin.data.getAllCollections = async () => [{
    guid: REMARKS_COL,
    getName: () => 'Remarks',
    getAllRecords: async () => [...store.values()],
  }];
  return store;
}

test('v4.41.0 a remark on the context line renders a pen chip with its first body line', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', excerpt: '@ →', body: 'doing this tonight.' }]);
  const opens = [];
  h.plugin._openRecord = (guid) => opens.push(guid);

  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  const strip = h.document.querySelector('.refx-inline-refs-context');
  assert.ok(strip, 'the strip rendered');
  await expandCtxStrip(strip);
  const chipsWrap = strip.querySelector('.refx-remark-chips');
  assert.ok(chipsWrap, 'the Reference row carries a remark chips wrap');
  assert.equal(chipsWrap.getAttribute('data-refx-remark-line'), 'BADGE_TARGET');
  const refNode = strip.querySelector('.refx-ref-outline-refnode');
  assert.equal(chipsWrap.parentElement, refNode, 'the wrap lives inside the Reference row node');
  assert.equal(refNode.children[1], chipsWrap, 'between the Reference row itself and its children');
  const chip = chipsWrap.querySelector('.refx-remark-chip');
  assert.ok(chip.querySelector('.refx-remark-chip-pen'), 'pen-colored chip marker');
  await tick(10);
  assert.equal(chip.querySelector('.refx-remark-chip-text').textContent, 'doing this tonight.');
  chip.dispatchEvent(event('click', {}));
  assert.deepEqual(opens, ['REMARK_1'], 'click opens the remark record through the record-open convention');
  h.plugin.onUnload();
});

test('v4.41.0 the remark map builds lazily on first context render, never at onLoad', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'doing this tonight.' }]);
  let colRecordReads = 0;
  const base = h.plugin.data.getAllCollections;
  h.plugin.data.getAllCollections = async () => {
    const cols = await base();
    for (const col of cols) {
      const inner = col.getAllRecords;
      col.getAllRecords = async () => { colRecordReads++; return inner(); };
    }
    return cols;
  };

  // The laziness proof is the index itself: nothing built it during onLoad.
  assert.equal(h.plugin._remarksIndex, null, 'onLoad built no remarks index');

  // Concurrent attaches share ONE in-flight build (async-method return values
  // are fresh wrappers; the shared job is the promise the index caches).
  const p1 = h.plugin._ensureRemarksIndex();
  const shared = h.plugin._remarksIndexPromise;
  assert.ok(shared, 'a build is in flight');
  const p2 = h.plugin._ensureRemarksIndex();
  assert.equal(h.plugin._remarksIndexPromise, shared, 'concurrent context renders share one build');
  await Promise.all([p1, p2]);
  assert.ok(h.plugin._remarksIndex);
  assert.equal(colRecordReads, 1, 'the Remarks collection was read exactly once');
  assert.deepEqual([...h.plugin._remarksIndex.bySourceLine.keys()], ['BADGE_TARGET']);
  assert.deepEqual([...h.plugin._remarksIndex.byRecord.keys()], ['REMARK_1']);

  // A later render is served by the cached map object itself — no rebuild.
  // (colRecordReads is NOT asserted past here: the badge route legitimately
  // kicks the broker's own background hydration, which enumerates collections
  // on its own account. The remarks map's identity is the pin.)
  const warmIdx = h.plugin._remarksIndex;
  assert.equal(await h.plugin._ensureRemarksIndex(), warmIdx);
  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  await expandCtxStrip(h.document.querySelector('.refx-inline-refs-context'));
  assert.ok(h.document.querySelector('.refx-remark-chips'), 'chips render from the warm map');
  assert.equal(h.plugin._remarksIndex, warmIdx, 'the render was served by the cached map, not a rebuild');
  h.plugin.onUnload();
});

test('v4.41.0 a sibling line carrying a remark shows the same chip in the sibling list', async () => {
  const h = badgeHarness('BADGE_TARGET');
  h.records.set('BADGE_OWNER', {
    guid: 'BADGE_OWNER',
    getName: () => 'Badge owner',
    getLineItems: async () => [{
      guid: 'BADGE_ROOT', parent_guid: 'BADGE_OWNER', type: 'ulist',
      segments: [{ type: 'text', text: 'Badge root' }],
      children: [
        { guid: 'BADGE_TARGET', parent_guid: 'BADGE_ROOT', type: 'ulist',
          segments: [{ type: 'text', text: 'Badge target' }], children: [] },
        { guid: 'BADGE_SIBLING', parent_guid: 'BADGE_ROOT', type: 'ulist',
          segments: [{ type: 'text', text: 'Badge sibling' }], children: [] },
      ],
    }],
  });
  h.plugin._lineOwnerHints.set('BADGE_TARGET', 'BADGE_OWNER');
  remarksFixture(h, [{ guid: 'REMARK_SIB', sourceLine: 'BADGE_SIBLING', body: 'sibling remark body' }]);

  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  const strip = h.document.querySelector('.refx-inline-refs-context');
  await expandCtxStrip(strip);
  const siblingRow = [...strip.querySelectorAll('.refx-ref-sibling-row')]
    .find((row) => row.textContent.includes('Badge sibling'));
  assert.ok(siblingRow, 'the sibling list renders the sibling line');
  const chips = siblingRow.querySelector('.refx-remark-chips');
  assert.ok(chips, 'the sibling row carries the remark chip');
  assert.equal(chips.getAttribute('data-refx-remark-line'), 'BADGE_SIBLING');
  await tick(10);
  assert.equal(chips.textContent.includes('sibling remark body'), true);
  const refNode = strip.querySelector('.refx-ref-outline-refnode');
  assert.equal(refNode.querySelector('.refx-remark-chips'), null, 'the context line itself has no remark');
  h.plugin.onUnload();
});

test('v4.41.0 remarks record events patch the map and live-rendered chips, payload-filtered', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'first remark' }]);

  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  const strip = h.document.querySelector('.refx-inline-refs-context');
  await expandCtxStrip(strip);
  assert.equal(strip.querySelectorAll('.refx-remark-chip').length, 1);

  // A record.created from a DIFFERENT collection is payload-filtered out.
  h.records.set('OTHER_1', {
    guid: 'OTHER_1', getName: () => 'x',
    getAllProperties: () => [{ name: 'Source Line', values: () => ['BADGE_TARGET'] }],
    getLineItems: async () => [],
  });
  h.plugin._onRecordCreated({ eventName: 'record.created', recordGuid: 'OTHER_1', collectionGuid: 'OTHER_COL' });
  await tick();
  assert.equal(h.plugin._remarksIndex.byRecord.has('OTHER_1'), false, 'foreign-collection event ignored');
  assert.equal(strip.querySelectorAll('.refx-remark-chip').length, 1);

  // record.created inside the Remarks collection patches the map + open wrap.
  h.records.set('REMARK_2', {
    guid: 'REMARK_2', getName: () => 'Highlight 2',
    getAllProperties: () => [{ name: 'Source Line', values: () => ['BADGE_TARGET'] }],
    getLineItems: async () => [{ guid: 'R2B', segments: [{ type: 'text', text: 'second remark' }] }],
  });
  h.plugin._onRecordCreated({ eventName: 'record.created', recordGuid: 'REMARK_2', collectionGuid: REMARKS_COL });
  await tick();
  assert.equal(h.plugin._remarksIndex.byRecord.has('REMARK_2'), true);
  assert.equal(strip.querySelectorAll('.refx-remark-chip').length, 2, 'the open wrap gained the new chip');
  assert.equal(strip.querySelectorAll('.refx-remark-chips').length, 1, 're-filled in place, not duplicated');

  // record.updated with trashed removes it from map and screen.
  h.plugin._onRecordUpdated({ eventName: 'record.updated', recordGuid: 'REMARK_2', collectionGuid: REMARKS_COL, trashed: true });
  await tick();
  assert.equal(h.plugin._remarksIndex.byRecord.has('REMARK_2'), false);
  assert.equal(strip.querySelectorAll('.refx-remark-chip').length, 1);
  h.plugin.onUnload();
});

test('v4.41.0 record.moved is payload-filtered by destination collection', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'first remark' }]);

  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  const strip = h.document.querySelector('.refx-inline-refs-context');
  await expandCtxStrip(strip);
  assert.equal(strip.querySelectorAll('.refx-remark-chip').length, 1);

  // Moved OUT of Remarks: unscoped event, non-Remarks destination → remove.
  h.plugin._onRecordMoved({ eventName: 'record.moved', recordGuid: 'REMARK_1', collectionGuid: 'OTHER_COL' });
  await tick();
  assert.equal(h.plugin._remarksIndex.byRecord.has('REMARK_1'), false);
  assert.equal(strip.querySelector('.refx-remark-chips'), null, 'a line whose remarks vanished loses its wrap');

  // Moved back IN: destination is Remarks → re-read and re-map.
  h.plugin._onRecordMoved({ eventName: 'record.moved', recordGuid: 'REMARK_1', collectionGuid: REMARKS_COL });
  await tick();
  assert.equal(h.plugin._remarksIndex.byRecord.has('REMARK_1'), true);
  assert.deepEqual([...h.plugin._remarksIndex.bySourceLine.keys()], ['BADGE_TARGET']);
  h.plugin.onUnload();
});

test('v4.41.0 remark body reads are per-rendered-remark, cached, and dropped on update', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, []);
  let bodyReads = 0;
  h.records.set('REMARK_1', {
    guid: 'REMARK_1', getName: () => 'Highlight',
    getAllProperties: () => [{ name: 'Source Line', values: () => ['BADGE_TARGET'] }],
    getLineItems: async () => { bodyReads++; return [{ guid: 'RB', segments: [{ type: 'text', text: 'cached body' }] }]; },
  });

  assert.equal(await h.plugin._remarkFirstBodyLine('REMARK_1'), 'cached body');
  assert.equal(await h.plugin._remarkFirstBodyLine('REMARK_1'), 'cached body');
  assert.equal(bodyReads, 1, 'the second read is served from the cache');

  h.plugin._remarksIndex = { builtAt: Date.now(), bySourceLine: new Map(), byRecord: new Map() };
  h.plugin._onRecordUpdated({ eventName: 'record.updated', recordGuid: 'REMARK_1', collectionGuid: REMARKS_COL });
  await tick();
  assert.equal(await h.plugin._remarkFirstBodyLine('REMARK_1'), 'cached body');
  assert.equal(bodyReads, 2, 'an update dropped the cached first line');
  h.plugin.onUnload();
});

test('v4.41.0 metadata reload drops the remark map and body cache for a lazy rebuild', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'first remark' }]);

  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  await expandCtxStrip(h.document.querySelector('.refx-inline-refs-context'));
  assert.ok(h.plugin._remarksIndex);
  h.plugin._onMetadataReload();
  assert.equal(h.plugin._remarksIndex, null);
  assert.equal(h.plugin._remarksIndexPromise, null);
  assert.equal(h.plugin._remarkBodyCache.size, 0);
  h.plugin.onUnload();
});

test('v4.41.0 perf gates: zero timers, lazy build, no workspace-wide record scan', () => {
  const start = source.indexOf('_remarkLineRefPropNames()');
  const end = source.indexOf('_siblingRenderPlan(total, rendered)');
  assert.ok(start > 0 && end > start, 'the remarks block sits before the sibling renderer');
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /setTimeout|setInterval|requestAnimationFrame/, 'the remarks machinery owns zero timers');
  assert.doesNotMatch(block, /data\.getAllRecords/, 'the map never enumerates every workspace record');
  assert.match(block, /col\.getAllRecords\?\.\(\)/, 'it reads only the Remarks collection');
  // Refresh is event-driven off the existing host handlers — no new subscription.
  assert.match(source, /_onRecordCreated\(ev\) \{[\s\S]*?_remarksRecordEvent\(recordGuid, ev, 'created'\)/);
  assert.match(source, /_onRecordUpdated\(ev\) \{[\s\S]*?_remarksRecordEvent\(g, ev, 'updated'\)/);
  assert.match(source, /_onRecordMoved\(ev\) \{[\s\S]*?_remarksRecordEvent\(recordGuid, ev, 'moved', collectionGuid\)/);
  // The Reference row mounts chips between the row and its children.
  assert.match(source,
    /refNode\.append\(fullEl\);[\s\S]{0,500}?_attachRemarkChips\(refNode, childBox \|\| null, lineGuid, ctx\);[\s\S]{0,200}?if \(childBox\) refNode\.append\(childBox\);/);
});

test('v4.49.3 the Block Context strip starts collapsed by default and the twisty does not persist', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');

  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  const strip = h.document.querySelector('.refx-inline-refs-context');
  const labelRow = strip.querySelector('.refx-inline-refs-context-label-row');
  assert.ok(labelRow, 'the label sits in a row with the twisty');
  const twist = strip.querySelector('.refx-ctxstrip-twist');
  assert.ok(twist, 'a fold twisty renders beside the label');
  assert.equal(labelRow.children[0], twist, 'the twisty precedes the label');
  assert.equal(strip.querySelector('.refx-inline-refs-context-label').textContent, 'Block context');
  const rows = strip.querySelector('.refx-inline-refs-context-rows');
  assert.equal(rows.classList.contains('refx-hidden'), true, 'default collapsed');
  assert.equal(twist.getAttribute('aria-expanded'), 'false');
  assert.equal(twist.textContent, '▸');

  twist.dispatchEvent(event('click', {}));
  await tick(10);
  assert.equal(rows.classList.contains('refx-hidden'), false, 'click expands the rows container');
  assert.equal(twist.textContent, '▾');
  assert.equal(twist.getAttribute('aria-expanded'), 'true');
  assert.equal(h.storage.has('refx_ctx_start_collapsed_v1'), false, 'twisty does not persist fold state');

  twist.dispatchEvent(event('click', {}));
  assert.equal(rows.classList.contains('refx-hidden'), true);
  assert.equal(twist.textContent, '▸');
  assert.equal(h.storage.has('refx_ctx_start_collapsed_v1'), false, 'still no persist after both clicks');
  h.plugin.onUnload();
});

test('v4.49.3 collapsed strips seed on both surfaces and defer hydration until first expand', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'late body' }]);

  // The popover surface builds through the same shared builder.
  const popStrip = h.plugin._buildRefRowContextStrip('trc-ref-popover-context');
  assert.equal(
    popStrip.querySelector('.trc-ref-popover-context-rows').classList.contains('refx-hidden'),
    true,
    'the popover strip seeds collapsed'
  );
  assert.equal(popStrip.querySelector('.refx-ctxstrip-twist').getAttribute('aria-expanded'), 'false');

  // The inline surface builds collapsed and pays NOTHING while collapsed —
  // no owner resolution, no tree reads, no remarks build.
  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  const strip = h.document.querySelector('.refx-inline-refs-context');
  const rows = strip.querySelector('.refx-inline-refs-context-rows');
  assert.equal(rows.classList.contains('refx-hidden'), true);
  assert.equal(rows.querySelector('.refx-ref-outline'), null, 'collapsed strips do NOT hydrate');
  assert.equal(h.plugin._remarksIndex, null, 'no remarks build fires while collapsed');

  // The first expand runs the deferred hydration: rows fill, chips attach.
  strip.querySelector('.refx-ctxstrip-twist').dispatchEvent(event('click', {}));
  await tick(10);
  assert.equal(rows.classList.contains('refx-hidden'), false);
  assert.ok(rows.querySelector('.refx-ref-outline'), 'the first expand hydrates the rows');
  assert.ok(h.plugin._remarksIndex, 'the remarks map builds on expand-hydration');
  assert.ok(rows.querySelector('.refx-remark-chips'), 'chips attach after the expand hydration');

  h.plugin._removeInlineRefs('BADGE_HOST›BADGE_TARGET');
  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  const strip2 = h.document.querySelector('.refx-inline-refs-context');
  const rows2 = strip2.querySelector('.refx-inline-refs-context-rows');
  assert.equal(rows2.classList.contains('refx-hidden'), true, 'a fresh open is collapsed again even after the first was expanded');
  h.plugin.onUnload();
});

test('v4.41.0 strips stay elastic — the twisty adds no sizing reservation', () => {
  for (const surface of ['.refx-inline-refs-context', '.trc-ref-popover-context']) {
    assert.match(
      source,
      new RegExp(surface.replace(/[.]/g, '\\.') + '-rows \\{\\s*padding: 0;'),
      surface + ' rows still declare no padding of their own'
    );
  }
  assert.match(source, /\.refx-ctxstrip-twist \{[^}]*font-size: 9px;/, 'the twisty reuses the outline twisty pattern');
  assert.doesNotMatch(source, /\.refx-ctxstrip-twist \{[^}]*(min-height|[^-]height\s*:)/, 'no height reservation');
});

test('v4.41.0 collection-less foreign record events fail closed — zero record/property reads', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'x' }]);

  h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
  await tick(10);
  await expandCtxStrip(h.document.querySelector('.refx-inline-refs-context'));
  assert.ok(h.plugin._remarksIndex, 'the warm map exists');

  let recordReads = 0;
  let propReads = 0;
  const baseGetRecord = h.plugin.data.getRecord;
  h.plugin.data.getRecord = (guid) => { recordReads++; return baseGetRecord(guid); };
  for (let i = 0; i < 100; i++) {
    const guid = 'FOREIGN_' + i;
    h.records.set(guid, {
      guid, getName: () => 'foreign',
      getAllProperties: () => { propReads++; return [{ name: 'Source Line', values: () => ['BADGE_TARGET'] }]; },
      getLineItems: async () => [],
    });
    // The payload shape with no collectionGuid at all — exactly what streams
    // per keystroke workspace-wide. Must cost nothing.
    h.plugin._onRecordUpdated({ eventName: 'record.updated', recordGuid: guid });
  }
  await tick();
  assert.equal(recordReads, 0, 'collection-less foreign events cost zero getRecord calls');
  assert.equal(propReads, 0, 'collection-less foreign events cost zero property reads');
  assert.equal(h.plugin._remarksIndex.byRecord.size, 1, 'no foreign record entered the map');
  h.plugin.onUnload();
});

test('v4.41.0 a build in flight across a metadata reload cannot resurrect the remark map', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'x' }]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = h.plugin.data.getAllCollections;
  h.plugin.data.getAllCollections = async () => { await gate; return base(); };

  const p = h.plugin._ensureRemarksIndex();
  assert.ok(h.plugin._remarksIndexPromise, 'the build is in flight');
  h.plugin._onMetadataReload();
  assert.equal(h.plugin._remarksIndex, null);
  release();
  await p;
  await tick();
  assert.equal(h.plugin._remarksIndex, null, 'the fenced build could not write past the reload');
  assert.equal(h.plugin._remarksIndexPromise, null, 'the in-flight slot cleared');

  // The next render rebuilds lazily from post-reload truth.
  const idx = await h.plugin._ensureRemarksIndex();
  assert.ok(idx && idx.bySourceLine.has('BADGE_TARGET'), 'a fresh build still works after the fence');
  h.plugin.onUnload();
});

test('v4.41.0 popover Block Context rows carry chips; a chip click closes the popover before opening the remark', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'pop body' }]);

  // Same strip + hydrate call the popover route makes, with the popover live.
  const strip = h.plugin._buildRefRowContextStrip('trc-ref-popover-context');
  const pop = h.document.createElement('div');
  pop.className = 'trc-ref-popover';
  pop.append(strip);
  h.document.body.append(pop);
  h.plugin._popoverEl = pop;
  await expandCtxStrip(strip);
  const order = [];
  const realClose = h.plugin.closeRefPopover.bind(h.plugin);
  h.plugin.closeRefPopover = () => { order.push('close'); realClose(); };
  h.plugin._openRecord = (guid) => order.push('open:' + guid);

  await h.plugin._hydrateRefRowContext(strip, 'BADGE_TARGET', {
    rowsClass: 'trc-ref-popover-context-rows',
    alive: () => true,
    hostLineGuid: null,
    canEdit: false,
    onEmbed: null,
    actionsFor: () => [],
  });
  await tick(10);
  const popRows = strip.querySelector('.trc-ref-popover-context-rows');
  const chip = popRows.querySelector('.refx-remark-chip');
  assert.ok(chip, 'the popover Reference row carries the remark chip');
  chip.dispatchEvent(event('click', {}));
  assert.deepEqual(order, ['close', 'open:REMARK_1'], 'the popover closes before the remark opens');
  assert.equal(pop.isConnected, false, 'the popover was removed from the DOM');
  h.plugin.onUnload();
});

test('v4.41.0 lineRefProperties=false/[] makes remark chips fully inert (zero-cost kill switch)', async () => {
  for (const off of [false, []]) {
    const h = badgeHarness('BADGE_TARGET', { lineRefProperties: off });
    badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
    remarksFixture(h, [{ guid: 'REMARK_1', sourceLine: 'BADGE_TARGET', body: 'x' }]);
    assert.equal(h.plugin._remarkLineRefPropNames().size, 0, JSON.stringify(off) + ' → empty property set');

    // Direct build: the kill switch skips even the one-per-session
    // collection enumeration (the documented zero-cost promise).
    let collectionReads = 0;
    h.plugin.data.getAllCollections = async () => { collectionReads++; return []; };
    const idx = await h.plugin._ensureRemarksIndex();
    assert.equal(collectionReads, 0, 'the kill switch skips the collection enumeration');
    assert.ok(idx, 'the inert empty map is still cached');
    assert.equal(idx.bySourceLine.size, 0);

    // Routed render: the strip hydrates normally but no chips attach.
    h.plugin._routeBadgeClick(event('click', { target: h.wrap, button: 0 }), null, h.wrap);
    await tick(10);
    const strip = h.document.querySelector('.refx-inline-refs-context');
    await expandCtxStrip(strip);
    assert.ok(strip && strip.querySelector('.refx-ref-outline'), 'the Reference row still hydrates');
    assert.equal(strip.querySelector('.refx-remark-chips'), null, 'no remark chips with the kill switch off');
    h.plugin.onUnload();
  }

  // Control: the default configured list keeps chips on.
  const on = badgeHarness('BADGE_TARGET');
  assert.deepEqual([...on.plugin._remarkLineRefPropNames()], ['source line'], 'default → Source Line');
  on.plugin.onUnload();
});

test('v4.41.0 a transient body-read failure caches nothing — the next render retries', async () => {
  const h = badgeHarness('BADGE_TARGET');
  badgeOwner(h, 'BADGE_OWNER', 'BADGE_TARGET', 'Badge');
  remarksFixture(h, []);
  let calls = 0;
  let fail = true;
  h.records.set('REMARK_1', {
    guid: 'REMARK_1', getName: () => 'Highlight',
    getAllProperties: () => [{ name: 'Source Line', values: () => ['BADGE_TARGET'] }],
    getLineItems: async () => {
      calls++;
      if (fail) throw new Error('transient');
      return [{ guid: 'RB', segments: [{ type: 'text', text: 'recovered body' }] }];
    },
  });

  assert.equal(await h.plugin._remarkFirstBodyLine('REMARK_1'), '', 'the failed read resolves empty');
  assert.equal(h.plugin._remarkBodyCache.has('REMARK_1'), false, 'a transient failure caches nothing');
  fail = false;
  assert.equal(await h.plugin._remarkFirstBodyLine('REMARK_1'), 'recovered body', 'the next render retries and succeeds');
  assert.equal(calls, 2);
  h.plugin.onUnload();
});
