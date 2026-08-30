'use strict';

// v4.27.0 Reference Navigator contracts.
//
// These tests deliberately exercise small public/internal seams instead of
// reproducing the panel implementation.  That keeps the scale, stale-work,
// safe-insertion, and media/privacy invariants testable without Thymer Desktop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeClassList {
  constructor(owner) { this.owner = owner; this.values = new Set(); }
  _sync() { this.owner._className = [...this.values].join(' '); }
  _fromString(value) {
    this.values = new Set(String(value || '').split(/\s+/).filter(Boolean));
    this._sync();
  }
  add(...names) { names.filter(Boolean).forEach((name) => this.values.add(name)); this._sync(); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); this._sync(); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name); else this.values.delete(name);
    this._sync();
    return next;
  }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { setProperty(name, value) { this[name] = String(value); } };
    this.dataset = {};
    this.attributes = new Map();
    this._listeners = new Map();
    this._text = '';
    this._html = '';
    this._className = '';
    this.classList = new FakeClassList(this);
    this.isConnected = true;
    this.value = '';
  }
  get className() { return this._className; }
  set className(value) { this.classList._fromString(value); }
  get textContent() {
    return this._text + this.children.map((child) => String(child?.textContent || '')).join('');
  }
  set textContent(value) {
    this._text = String(value == null ? '' : value);
    this._html = '';
    this.replaceChildren();
  }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = String(value == null ? '' : value);
    this._text = '';
    this.replaceChildren();
  }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index < 0 ? null : (this.parentNode.children[index + 1] || null);
  }
  append(...children) {
    for (const child of children.flat().filter(Boolean)) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  insertBefore(child, before) {
    child.parentNode = this;
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    this.isConnected = false;
    if (this.parentNode) {
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const fn of this._listeners.get(event.type) || []) fn(event);
    return true;
  }
  focus() { this.ownerDocument && (this.ownerDocument.activeElement = this); }
  scrollIntoView() {}
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child?.contains?.(node));
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const role = selector.match(/^\[role=["']?([^"'\]]+)["']?\]$/);
    if (role) return this.getAttribute('role') === role[1];
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches?.(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (child.matches?.(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() {
    return { left: 20, top: 20, right: 740, bottom: 620, width: 720, height: 600 };
  }
}

function makeHarness(options = {}) {
  const storage = new Map();
  const listeners = new Map();
  const createdUrls = [];
  const revokedUrls = [];
  const clipboardWrites = [];
  let urlSequence = 0;

  const document = {
    activeElement: null,
    createElement: (tag) => {
      const el = new FakeElement(tag);
      el.ownerDocument = document;
      return el;
    },
    createTextNode: (text) => ({ textContent: String(text), parentNode: null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener(type, fn) {
      if (!listeners.has('document:' + type)) listeners.set('document:' + type, new Set());
      listeners.get('document:' + type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get('document:' + type)?.delete(fn); },
    body: new FakeElement('body'),
    head: new FakeElement('head'),
    documentElement: { clientHeight: 900, clientWidth: 1440, style: {} },
  };
  document.body.ownerDocument = document;
  document.head.ownerDocument = document;

  const window = {
    innerWidth: 1440,
    innerHeight: 900,
    CSS: { escape: String },
    g_universe: { itemsByGuid: options.universe || {}, workspace: { guid: 'WS_V427' }, listviews: [] },
    addEventListener(type, fn) {
      if (!listeners.has('window:' + type)) listeners.set('window:' + type, new Set());
      listeners.get('window:' + type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get('window:' + type)?.delete(fn); },
    dispatchEvent(event) {
      for (const fn of listeners.get('window:' + event.type) || []) fn(event);
      return true;
    },
  };

  class TestBlob {
    constructor(parts = [], init = {}) {
      this.parts = parts;
      this.type = init.type || '';
      this.size = parts.reduce((sum, part) => sum + Number(part?.byteLength ?? part?.length ?? part?.size ?? 0), 0);
    }
  }

  const URL = {
    createObjectURL(blob) {
      const url = 'blob:v427-' + (++urlSequence);
      createdUrls.push({ url, blob });
      return url;
    },
    revokeObjectURL(url) { revokedUrls.push(url); },
  };

  const context = {
    AppPlugin: class {},
    console,
    Promise,
    Date,
    Math,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Uint8Array,
    ArrayBuffer,
    Blob: TestBlob,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 8 }), 0),
    cancelIdleCallback: clearTimeout,
    performance,
    CSS: window.CSS,
    document,
    window,
    Element: FakeElement,
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    DateTime: undefined,
    navigator: {
      platform: 'MacIntel',
      userAgent: 'Macintosh',
      clipboard: {
        async writeText(text) { clipboardWrites.push(String(text)); },
        async readText() { return ''; },
      },
    },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };
  context.globalThis = context;
  Object.assign(context, window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });

  const plugin = new context.PluginUnderTest();
  plugin.workspaceGuid = 'WS_V427';
  plugin._isUnloading = false;
  plugin._unloaded = false;
  plugin._enabled = true;
  plugin._r5SessionGen = 17;
  plugin._r5ScopeStack = [];
  plugin.data = {
    getRecord: () => null,
    searchByQuery: async () => ({ records: [], lines: [] }),
    getAllCollections: async () => [],
  };
  plugin.ui = {
    addCommandPaletteCommand: () => ({ remove() {} }),
    addStatusBarItem: () => ({ remove() {} }),
    registerCustomPanelType: () => ({ remove() {} }),
    createPanel: async () => null,
    getActivePanel: () => null,
    getPanels: () => [],
  };
  plugin.events = { on: () => '', off: () => {} };
  plugin.getConfiguration = () => ({
    custom: {
      navigator: {
        enabled: true,
        initialResults: 8,
        revealBatch: 8,
        mediaMode: 'selected',
        allowExternalImages: false,
        nativeContext: true,
      },
    },
  });
  plugin._toast = () => {};
  plugin.refreshAllPanels = () => {};

  return { plugin, context, window, document, storage, createdUrls, revokedUrls, clipboardWrites };
}

function keyEvent(key, extras = {}) {
  return {
    key,
    code: extras.code || (key === '9' ? 'Digit9' : ''),
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
    stopPropagation() { this.stopped = true; },
    ...extras,
  };
}

function rows(count, prefix = 'ROW') {
  return Array.from({ length: count }, (_, index) => ({
    guid: prefix + '_' + index,
    text: prefix + ' ' + index,
    realTitle: prefix + ' ' + index,
    page: '',
    score: count - index,
    rguid: null,
  }));
}

function segText(text) { return [{ type: 'text', text }]; }

test('progressive reveal keeps a complete ranked pool and reveals cached batches of eight', () => {
  const { plugin } = makeHarness();
  const pool = rows(25, 'PAGE');
  const link = { kind: 'record', results: [], sel: 3, userSelected: true };
  let reads = 0;
  plugin.data.getRecord = () => ({ getLineItems: async () => { reads++; return []; } });
  plugin.data.searchByQuery = async () => { reads++; return { records: [], lines: [] }; };

  plugin._resetLinkReveal(link, pool, pool.length, true);
  assert.equal(link.resultPool.length, 25);
  assert.equal(link.results.length, 8);
  assert.equal(link.visibleLimit, 8);
  assert.equal(link.resultsComplete, true);
  assert.equal(plugin._linkHasMoreResults(link), true);

  const selectedGuid = link.results[3].guid;
  plugin._revealMoreLinkResults(link);
  assert.equal(link.results.length, 16);
  assert.equal(link.results[link.sel].guid, selectedGuid, 'reveal must preserve the selected GUID');
  plugin._revealMoreLinkResults(link);
  assert.equal(link.results.length, 24);
  plugin._revealMoreLinkResults(link);
  assert.equal(link.results.length, 25);
  assert.equal(plugin._linkHasMoreResults(link), false);
  assert.equal(reads, 0, 'revealing an already-ranked pool must perform no SDK or body reads');
});

test('a new query resets the reveal window while retaining its new complete pool', () => {
  const { plugin } = makeHarness();
  const link = { kind: 'record', results: [], sel: 0, userSelected: false };
  plugin._resetLinkReveal(link, rows(21, 'OLD'), 21, true, 'old query');
  plugin._revealMoreLinkResults(link);
  assert.equal(link.results.length, 16);

  plugin._resetLinkReveal(link, rows(13, 'NEW'), 13, true, 'new query');
  assert.equal(link.visibleLimit, 8);
  assert.deepEqual(Array.from(link.results, (row) => row.guid), rows(8, 'NEW').map((row) => row.guid));
  assert.equal(plugin._linkHasMoreResults(link), true);
});

test('PageDown reveals cached picker results and never selects the non-selectable reveal action', () => {
  const { plugin } = makeHarness();
  const link = {
    kind: 'record', query: 'page', resultsQuery: 'page', searchTimer: null,
    results: [], resultPool: [], visibleLimit: 8, resultsComplete: true,
    sel: 2, userSelected: true,
  };
  plugin._resetLinkReveal(link, rows(19, 'PAGE'), 19, true);
  link.sel = 2;
  link.userSelected = true;
  plugin._link = link;
  plugin._renderLink = () => {};
  const event = keyEvent('PageDown');

  plugin._linkKey(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(link.results.length, 16);
  assert.equal(link.sel, 2);
});

test('rendered inline picker exposes a truthful Show 8 more action and a partial native status', () => {
  const { plugin, document } = makeHarness();
  const list = document.createElement('div');
  const link = {
    kind: 'line', query: 'protocol', resultsQuery: 'protocol', searchTimer: null,
    results: [], resultPool: [], visibleLimit: 8, resultsTotal: 48,
    resultsComplete: false, sel: 0, userSelected: true, list,
  };
  plugin._resetLinkReveal(link, rows(18, 'BLOCK').map((row) => ({ ...row, rguid: 'RECORD' })), 48, false);
  plugin._link = link;
  plugin._buildLinePickCrumb = () => '';
  plugin._updateLinkPreviewPane = () => {};
  plugin._scheduleLinkCounts = () => {};

  plugin._renderLink();

  assert.match(list.textContent, /Show 8 more/i);
  assert.match(list.textContent, /8 of 48 blocks returned/i);
  assert.match(list.textContent, /more may exist/i);
  const options = list.querySelectorAll('[role="option"]');
  assert.equal(options.length, 8, 'reveal/status rows must not be selectable listbox options');
});

test('reveal beyond forty visibly advances both bounded DOM windows while retaining an active option', () => {
  const { plugin, document } = makeHarness();
  plugin._navigatorConfig = Object.freeze({ ...plugin._navigatorConfig, mediaMode: 'off' });

  const navList = document.createElement('div');
  const nav = {
    generation: 1, results: rows(70, 'NAV'), selectedIndex: 0, selectedGuid: 'NAV_0',
    visibleLimit: 40, revealWindowStart: 0, revealWindowEnd: 40,
    resultsEl: navList, partial: false, searching: false,
  };
  plugin._navigator = nav;
  plugin._renderReferenceNavigator(nav);
  navList.querySelector('.refx-nav-reveal').dispatchEvent({ type: 'click' });
  assert.equal(nav.visibleLimit, 48);
  assert.equal(navList.querySelectorAll('[role="option"]').length, 40);
  assert.equal(navList.querySelectorAll('.is-selected').length, 1, 'the active option remains mounted for accessibility');
  assert.match(navList.textContent, /NAV 47/, 'newly revealed Navigator rows must actually enter the DOM');

  const inlineList = document.createElement('div');
  const pool = rows(70, 'BLOCK').map((row) => ({ ...row, rguid: 'OWNER' }));
  const link = {
    kind: 'line', query: 'block', resultsQuery: 'block', searchTimer: null,
    resultPool: pool, results: pool.slice(0, 40), visibleLimit: 40,
    revealWindowStart: 0, revealWindowEnd: 40, resultsPreSliceCount: 70,
    resultsComplete: false, sel: 0, userSelected: true, list: inlineList,
  };
  plugin._link = link;
  plugin._lineCreateOptions = () => [];
  plugin._buildLinePickCrumb = () => '';
  plugin._updateLinkPreviewPane = () => {};
  plugin._scheduleLinkCounts = () => {};
  plugin._renderLink();
  inlineList.querySelector('.refx-result-reveal').dispatchEvent({
    type: 'mousedown', preventDefault() {}, stopPropagation() {},
  });
  assert.equal(link.results.length, 48);
  assert.equal(inlineList.querySelectorAll('[role="option"]').length, 40);
  assert.equal(inlineList.querySelectorAll('.refalias-result-sel').length, 1);
  assert.ok(Array.from(inlineList.querySelectorAll('[role="option"]'), (row) => row.title).includes('BLOCK 47'),
    'newly revealed inline rows must actually enter the DOM');
});

test('navigator hierarchy is selected-target centric: breadcrumbs, Children, Nearby, References', () => {
  const { plugin } = makeHarness();
  const tree = [{
    guid: 'ROOT', segments: segText('Root'), children: [{
      guid: 'PARENT', parent_guid: 'ROOT', segments: segText('Parent'), children: [
        { guid: 'BEFORE', parent_guid: 'PARENT', segments: segText('Before') },
        {
          guid: 'TARGET', parent_guid: 'PARENT', segments: segText('Target'), children: [
            { guid: 'CHILD_1', parent_guid: 'TARGET', segments: segText('Child one') },
            { guid: 'CHILD_2', parent_guid: 'TARGET', segments: segText('Child two'), children: [
              { guid: 'TARGET', parent_guid: 'CHILD_2', segments: segText('cycle') },
            ] },
          ],
        },
        { guid: 'AFTER', parent_guid: 'PARENT', segments: segText('After') },
      ],
    }],
  }];

  const model = plugin._navigatorBuildSections('TARGET', tree);

  assert.deepEqual(Array.from(model.breadcrumbs, (row) => row.guid), ['ROOT', 'PARENT']);
  assert.deepEqual(
    { guid: model.parent.guid, depth: model.parent.depth, targetDepth: model.target.depth },
    { guid: 'PARENT', depth: 1, targetDepth: 2 },
    'the presentation model exposes the immediate parent and absolute outline depths'
  );
  assert.deepEqual(Array.from(model.sections, (section) => section.key), ['children', 'nearby', 'references']);
  assert.deepEqual(Array.from(model.sections[0].items, (row) => row.guid), ['CHILD_1', 'CHILD_2']);
  assert.deepEqual(Array.from(model.sections[0].items, (row) => row.outlineDepth), [3, 3]);
  assert.deepEqual(Array.from(model.sections[1].items, (row) => row.guid), ['BEFORE', 'AFTER']);
  assert.deepEqual(Array.from(model.sections[1].items, (row) => row.side), ['before', 'after']);
  assert.equal(model.sections[0].collapsed, false);
  assert.equal(model.sections[1].collapsed, true, 'Nearby starts collapsed when useful children exist');
  assert.equal(model.sections[2].collapsed, true, 'References remain lazy until explicitly expanded');
  assert.equal(model.sections.flatMap((section) => section.items).filter((row) => row.guid === 'TARGET').length, 0,
    'cycle detection must not re-add the selected target');
});

test('C5 picker snippets highlight matches, preserve near-start text, and expand the selected row fully', () => {
  const { plugin } = makeHarness();
  const nearStart = plugin._snippetHTML('Opening context has Celisse in the first sentence and a long tail '.repeat(4), 'celisse');
  assert.ok(!nearStart.startsWith('…'), 'a near-start match must preserve the sentence opening');
  assert.match(nearStart, /<mark class="refx-picker-match">Celisse<\/mark>/);

  const distant = plugin._snippetHTML('prefix '.repeat(30) + 'Celisse appears here ' + 'suffix '.repeat(30), 'celisse');
  assert.ok(distant.startsWith('…'), 'a distant match uses a centered context window');
  assert.match(distant, /Celisse/);

  const full = plugin._snippetHTML('start ' + 'middle '.repeat(50) + 'Celisse at the end', 'celisse', { full: true });
  assert.ok(!full.startsWith('…') && !full.endsWith('…'), 'selected rows render their complete text');
  assert.match(full, /<mark class="refx-picker-match">Celisse<\/mark>/);
});

test('C5 Alt+1/2/3 toggles preview sections while focus remains in the editor', () => {
  const { plugin, document } = makeHarness();
  const previewEl = document.createElement('div');
  const sections = ['children', 'nearby', 'references'].map((key) => {
    const details = document.createElement('details');
    details.className = 'refx-preview-section-' + key;
    details.open = false;
    previewEl.append(details);
    return details;
  });
  plugin._link = {
    previewEl, results: [], resultPool: [], query: '', kind: 'line',
    creating: false, aliasCreating: false, aliasChoose: null,
  };

  sections.forEach((details, index) => {
    const event = keyEvent(String(index + 1), { code: 'Digit' + (index + 1), altKey: true });
    plugin._linkKey(event);
    assert.equal(details.open, true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
  });
});

test('C5 preview renders one ordered document neighbourhood and keeps non-spatial summaries out of the pick path', async () => {
  const { plugin, document, context } = makeHarness();
  context.flowythymerGetState = () => ({
    colors: ['var(--depth-zero)', 'var(--depth-one)', 'var(--depth-two)'],
    indentLineWidth: 2,
    indentLineOpacity: 0.6,
    indentLinesEnabled: true,
  });
  const pane = document.createElement('div');
  const link = { previewEl: pane, token: 4, r5Session: 17, query: 'celisse', kind: 'line', r5ChildrenCache: new Map() };
  plugin._link = link;
  const refSeg = { type: 'ref', text: { guid: 'OUTBOUND', title: 'Outbound page' } };
  const children = Array.from({ length: 15 }, (_, index) => ({
    guid: 'CHILD_' + index,
    parent_guid: 'TARGET',
    type: index === 0 ? 'task' : 'text',
    getTaskStatus: () => index === 0 ? 'done' : null,
    segments: segText('Child Celisse ' + index),
    children: [],
  }));
  const target = {
    guid: 'TARGET', parent_guid: 'PARENT', type: 'task', getTaskStatus: () => 'none',
    segments: [{ type: 'text', text: 'Celisse target <!-- roam-page-uid: junk --> ' }, refSeg],
    children,
  };
  const items = [{
    guid: 'PARENT', segments: segText('Parent'), children: [
      { guid: 'BEFORE_0', parent_guid: 'PARENT', segments: segText('Before zero'), children: [] },
      { guid: 'BEFORE_1', parent_guid: 'PARENT', segments: segText('Before one'), children: [] },
      { guid: 'BEFORE_2', parent_guid: 'PARENT', segments: segText('Before two'), children: [] },
      target,
      { guid: 'AFTER_0', parent_guid: 'PARENT', segments: segText('After zero'), children: [] },
      { guid: 'AFTER_1', parent_guid: 'PARENT', segments: segText('After one'), children: [] },
      { guid: 'AFTER_2', parent_guid: 'PARENT', segments: segText('After two'), children: [] },
    ],
  }];
  const rec = { guid: 'OWNER', getName: () => 'Owner', getAllProperties: () => [] };
  plugin.data.getRecord = (guid) => guid === 'OWNER' ? rec : null;
  plugin.getOrLoadRecordName = () => 'Owner';
  plugin._recCardFields = () => [{ name: 'Status', value: 'Current', display: 'Current' }];
  plugin._liveSegs = (guid) => {
    const flat = [target, ...children];
    return flat.find((item) => item.guid === guid)?.segments || [];
  };
  plugin._r5HydrateRecordLines = async () => items;
  plugin._loadNavigatorReferences = async (_result, host) => { host.textContent = 'Loaded backlinks'; return []; };
  plugin._pickLink = () => { throw new Error('section presses must not pick'); };
  const result = { guid: 'TARGET', rguid: 'OWNER', text: 'Celisse target', matchQuery: 'celisse', task: { is: true, done: false } };

  for (let index = 0; index < 20; index++) plugin._fillLinkPreview(link, result);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pane._listeners.get('mousedown')?.size, 1, 'twenty fills must attach one pane listener');
  const summaries = pane.querySelectorAll('summary');
  assert.equal(summaries.length, 2, 'only Outbound and References remain separate sections');
  for (const summary of summaries) {
    let stopped = false;
    summary.dispatchEvent({ type: 'mousedown', stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, 'every summary stops pane-level mousedown');
  }
  assert.equal(pane.querySelectorAll('.refx-preview-section-children').length, 0);
  assert.equal(pane.querySelectorAll('.refx-preview-section-nearby').length, 0);
  const outlineRows = pane.querySelectorAll('.refx-preview-outline-row');
  assert.deepEqual(
    Array.from(outlineRows, (row) => [row.dataset.outlineRole, row.dataset.guid]),
    [
      ['parent', 'PARENT'],
      ['sibling', 'BEFORE_1'],
      ['sibling', 'BEFORE_2'],
      ['target', 'TARGET'],
      ['child', 'CHILD_0'],
      ['child', 'CHILD_1'],
      ['sibling', 'AFTER_0'],
      ['sibling', 'AFTER_1'],
    ],
    'outline order is parent → two before → target → direct children → two after'
  );
  const targetOutline = outlineRows.find((row) => row.dataset.outlineRole === 'target');
  assert.equal(targetOutline.style['--refx-outline-accent-color'], 'var(--depth-one)');
  assert.equal(targetOutline.querySelectorAll('.refx-preview-outline-rail').length, 1);
  assert.equal(outlineRows.find((row) => row.dataset.outlineRole === 'child')
    .querySelectorAll('.refx-preview-outline-rail').length, 2);
  assert.equal(pane.querySelectorAll('.refx-preview-task').length >= 2, true, 'target and child task checkboxes render');
  assert.equal(pane.querySelectorAll('.refx-preview-props').length, 1, 'owning record properties render');
  assert.equal(pane.querySelectorAll('.refx-preview-outbound').length, 1, 'outbound references render');
  assert.match(pane.querySelector('.refalias-preview-more').textContent, /\+13 more/);
  const html = pane.querySelectorAll('.refx-preview-target-text')
    .concat(pane.querySelectorAll('.refx-preview-context-text'))
    .map((node) => node.innerHTML).join(' ');
  assert.match(html, /refx-picker-match/, 'row query is highlighted in the preview');
  assert.doesNotMatch(html, /roam-page-uid/i, 'Roam comments are stripped at the preview boundary');

  const references = pane.querySelector('.refx-preview-section-references');
  assert.equal(references.open, false, 'References stays collapsed');
  references.open = true;
  references.dispatchEvent({ type: 'toggle' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(references.querySelector('.refalias-preview-loading').textContent, 'Loaded backlinks',
    'References still loads lazily on first expansion');
});

test('C5 outline model handles roots, edge siblings, childless targets, long text, and token-only fallback rails', () => {
  const { plugin, document } = makeHarness();
  const longText = 'A very long line '.repeat(80);
  const roots = [
    { guid: 'ROOT_TARGET', segments: segText(longText), children: [] },
    { guid: 'ROOT_AFTER_0', segments: segText('After zero'), children: [] },
    { guid: 'ROOT_AFTER_1', segments: segText('After one'), children: [] },
    { guid: 'ROOT_AFTER_2', segments: segText('After two'), children: [] },
  ];
  const rootModel = plugin._navigatorBuildSections('ROOT_TARGET', roots);
  assert.equal(rootModel.parent, null, 'root-level targets have no synthetic parent');
  assert.equal(rootModel.target.depth, 0);
  assert.equal(rootModel.target.text, longText.trim(), 'long text stays intact for title/highlight processing');
  assert.deepEqual(
    Array.from(rootModel.sections.find((section) => section.key === 'nearby').items, (row) => [row.guid, row.side]),
    [['ROOT_AFTER_0', 'after'], ['ROOT_AFTER_1', 'after']],
    'first siblings show only the two available rows after the target'
  );
  assert.equal(rootModel.sections.find((section) => section.key === 'children').items.length, 0,
    'childless targets render without a placeholder accordion');

  const lastModel = plugin._navigatorBuildSections('ROOT_AFTER_2', roots);
  assert.deepEqual(
    Array.from(lastModel.sections.find((section) => section.key === 'nearby').items, (row) => [row.guid, row.side]),
    [['ROOT_AFTER_0', 'before'], ['ROOT_AFTER_1', 'before']],
    'last siblings show only the two available rows before the target'
  );

  const row = document.createElement('div');
  plugin._appendPreviewOutlineRails(row, 2, plugin._previewOutlineFlowyStyle(), true);
  assert.equal(row.style['--refx-outline-accent-color'], 'var(--cards-border-color)',
    'without Indent Rainbow the target rail falls back to the theme border token');
  assert.match(source, /-webkit-line-clamp:\s*2/, 'two-line clamping keeps long preview rows compact');
});

test('Nearby starts expanded for a leaf block', () => {
  const { plugin } = makeHarness();
  const tree = [{ guid: 'PARENT', segments: segText('Parent'), children: [
    { guid: 'LEFT', parent_guid: 'PARENT', segments: segText('Left') },
    { guid: 'LEAF', parent_guid: 'PARENT', segments: segText('Leaf') },
    { guid: 'RIGHT', parent_guid: 'PARENT', segments: segText('Right') },
  ] }];
  const model = plugin._navigatorBuildSections('LEAF', tree);
  const nearby = model.sections.find((section) => section.key === 'nearby');
  assert.equal(nearby.collapsed, false);
  assert.deepEqual(Array.from(nearby.items, (row) => row.guid), ['LEFT', 'RIGHT']);
});

test('native handle context keeps top-level Nearby rows in record order', async () => {
  const { plugin } = makeHarness();
  const before = { guid: 'BEFORE', segments: segText('Before') };
  const target = {
    guid: 'TARGET', segments: segText('Target'), children: [], parent_guid: null,
    async getTreeContext() { return { ancestors: [], descendants: [] }; },
    async getParent() { return { guid: 'OWNER', getLineItems() {} }; },
  };
  const after = { guid: 'AFTER', segments: segText('After') };

  const context = await plugin._navigatorBuildHandleContext(
    { guid: 'TARGET', text: 'Target', rguid: 'OWNER', handle: target },
    [before, target, after],
    () => true,
  );

  assert.deepEqual(Array.from(context.sections.find((section) => section.key === 'nearby').items, (row) => row.guid), ['BEFORE', 'AFTER']);
});

test('cold context rows seed a blank page-scope drill even when absent from the UI registry', async () => {
  const { plugin } = makeHarness({ universe: {} });
  const nav = {
    generation: 1, mode: 'blocks', query: '', scope: 'page', pageScopeGuid: 'OWNER',
    results: [{ guid: 'CURRENT', text: 'Current', rguid: 'OWNER' }],
    selectedIndex: 0, selectedGuid: 'CURRENT', selectionRevision: 0, selectionActivatedGuid: null,
    searchGeneration: 0, contextGeneration: 0, visibleLimit: 8, revealKey: '',
    context: {
      target: { guid: 'CURRENT', text: 'Current' }, breadcrumbs: [],
      sections: [
        { key: 'children', items: [{ guid: 'COLD_CHILD', text: 'Cold child' }] },
        { key: 'nearby', items: [] }, { key: 'references', items: [] },
      ],
    },
    hierarchyCache: new Map(), hierarchyFetched: new Set(), contextCache: new Map(),
  };
  plugin._navigator = nav;
  plugin._renderReferenceNavigator = () => {};
  plugin._navigatorSelectionChanged = (state) => { state.selectionActivatedGuid = state.selectedGuid; };

  await plugin._runNavigatorSearch('', { targetGuid: 'COLD_CHILD' });

  assert.ok(nav.results.some((row) => row.guid === 'COLD_CHILD'));
  assert.equal(nav.selectedGuid, 'COLD_CHILD');
  assert.equal(nav.scopePartial, true, 'the UI must admit when only cached context—not a full owner tree—was available');
});

test('page scope scans an already-fetched owner tree beyond the 200-row context preview without another body read', async () => {
  const { plugin } = makeHarness({ universe: {} });
  const tree = rows(250, 'COLD').map((row) => ({ guid: row.guid, type: 'text', segments: segText(row.text), children: [] }));
  let bodyReads = 0;
  plugin.data.getRecord = () => ({ async getLineItems() { bodyReads++; return tree; } });
  const nav = {
    generation: 2, mode: 'blocks', query: '', scope: 'page', pageScopeGuid: 'OWNER',
    results: [{ guid: 'COLD_0', text: 'COLD 0', rguid: 'OWNER' }],
    selectedIndex: 0, selectedGuid: 'COLD_0', selectionRevision: 0, selectionActivatedGuid: null,
    searchGeneration: 0, contextGeneration: 0, visibleLimit: 8, revealKey: '',
    context: { target: { guid: 'COLD_0', text: 'COLD 0' }, breadcrumbs: [], sections: [
      { key: 'children', items: tree.slice(1, 201).map((item) => ({ guid: item.guid, text: plugin._navigatorContextText(item) })) },
      { key: 'nearby', items: [] }, { key: 'references', items: [] },
    ] },
    hierarchyCache: new Map([['OWNER', Promise.resolve(tree)]]), hierarchyFetched: new Set(['OWNER']), contextCache: new Map(),
  };
  plugin._navigator = nav;
  plugin._renderReferenceNavigator = () => {};
  plugin._navigatorSelectionChanged = (state) => { state.selectionActivatedGuid = state.selectedGuid; };

  await plugin._runNavigatorSearch('', { targetGuid: 'COLD_0' });

  assert.equal(nav.results.length, 250);
  assert.equal(bodyReads, 0, 'searching a cached scope must not call getLineItems again');
  assert.equal(nav.scopePartial, false);
});

test('an evicted owner reuses an indexed native handle instead of refetching its full body', async () => {
  const { plugin } = makeHarness();
  const parent = { guid: 'PARENT', segments: segText('Parent') };
  const child = { guid: 'CHILD', segments: segText('Child'), children: [] };
  const left = { guid: 'LEFT', segments: segText('Left') };
  const right = { guid: 'RIGHT', segments: segText('Right') };
  const handle = {
    guid: 'TARGET', type: 'text', parent_guid: 'PARENT', segments: segText('Target'),
    async getTreeContext() { return { ancestors: [parent], descendants: [child] }; },
    async getChildren() { return [child]; },
    async getParent() { return { guid: 'PARENT', children: [left, handle, right] }; },
    getRecord() { return { guid: 'OWNER_R' }; },
  };
  let bodyReads = 0;
  let nativeQueries = 0;
  plugin.data.getRecord = () => ({ async getLineItems() { bodyReads++; return []; } });
  plugin.data.searchByQuery = async () => { nativeQueries++; return { lines: [handle] }; };
  const nav = {
    generation: 3, contextGeneration: 1, selectedGuid: 'TARGET', selectedIndex: 0,
    results: [{ guid: 'TARGET', text: 'Target', rguid: 'OWNER_R', type: 'text' }],
    hierarchyCache: new Map(), hierarchyFetched: new Set(['OWNER_R']), hierarchyActive: null,
    contextCache: new Map(), mediaCandidateCache: new Map(), scope: 'workspace',
  };
  plugin._navigator = nav;
  plugin._renderNavigatorContext = () => {};

  await plugin._loadNavigatorContext(nav, nav.results[0]);

  assert.equal(bodyReads, 0, 'the one-fetch-per-owner guard must not refetch an evicted tree');
  assert.equal(nativeQueries, 1);
  assert.deepEqual(Array.from(nav.context.sections[0].items, (row) => row.guid), ['CHILD']);
  assert.deepEqual(Array.from(nav.context.sections[1].items, (row) => row.guid), ['LEFT', 'RIGHT']);
  assert.deepEqual(Array.from(nav.context.breadcrumbs, (row) => row.guid), ['PARENT']);
});

test('native block search uses public line metadata and rejects ownerless record-root pseudo-lines', async () => {
  const { plugin } = makeHarness({ universe: {} });
  const valid = {
    guid: 'VALID_LINE', type: 'text', segments: segText('needle valid'),
    getRecord() { return { guid: 'OWNER' }; },
    _getRow() { throw new Error('private API must not be touched'); },
  };
  const pseudo = {
    guid: 'RECORD_ROOT', type: 'document', segments: segText('needle root'),
    getRecord() { return null; },
    _getRow() { throw new Error('private API must not be touched'); },
  };
  plugin.data.searchByQuery = async () => ({ lines: [pseudo, valid] });
  const nav = {
    generation: 4, mode: 'blocks', query: 'needle', scope: 'workspace',
    results: [], selectedIndex: 0, selectedGuid: null, selectionRevision: 0,
    searchGeneration: 0, contextGeneration: 0, visibleLimit: 8, revealKey: '',
    hierarchyCache: new Map(), hierarchyFetched: new Set(), contextCache: new Map(),
  };
  plugin._navigator = nav;
  plugin._renderReferenceNavigator = () => {};
  plugin._navigatorSelectionChanged = (state) => { state.selectionActivatedGuid = state.selectedGuid; };

  await plugin._runNavigatorSearch('needle');

  assert.deepEqual(Array.from(nav.results, (row) => row.guid), ['VALID_LINE']);
  assert.equal(nav.results[0].rguid, 'OWNER');
});

test('a changed query never carries the old selected row into progressive paints', async () => {
  const { plugin } = makeHarness();
  plugin._recordNameIndex = new Map(Array.from({ length: 3000 }, (_, index) => [
    'NEW_' + index, 'New needle ' + String(index).padStart(4, '0'),
  ]));
  plugin._recordNameIndexBuiltAt = Date.now();
  const nav = {
    generation: 5, mode: 'pages', query: 'old', scope: 'workspace',
    results: [{ guid: 'OLD_SELECTED', text: 'Old unrelated result', type: 'record' }],
    selectedIndex: 0, selectedGuid: 'OLD_SELECTED', selectionRevision: 0,
    searchGeneration: 0, contextGeneration: 0, visibleLimit: 8,
    revealKey: 'pages|old|workspace||', hierarchyCache: new Map(), hierarchyFetched: new Set(), contextCache: new Map(),
  };
  plugin._navigator = nav;
  const paints = [];
  plugin._renderReferenceNavigator = (state) => paints.push(state.results.map((row) => row.guid));
  plugin._navigatorSelectionChanged = (state) => { state.selectionActivatedGuid = state.selectedGuid; };

  await plugin._runNavigatorSearch('new needle');

  assert.ok(paints.length > 1);
  assert.equal(paints.some((paint) => paint.includes('OLD_SELECTED')), false,
    'Enter must never be able to choose a nonmatching row retained from the prior query');
});

test('final progressive ranking preserves open references and gallery for an unchanged selected GUID', async () => {
  const { plugin } = makeHarness();
  plugin._recordNameIndex = new Map(Array.from({ length: 2500 }, (_, index) => [
    'REC_' + index, 'Needle record ' + String(index).padStart(4, '0'),
  ]));
  plugin._recordNameIndexBuiltAt = Date.now();
  const nav = {
    generation: 6, mode: 'pages', query: 'needle', scope: 'workspace',
    results: [{ guid: 'REC_0', text: 'Needle record 0000', type: 'record' }],
    selectedIndex: 0, selectedGuid: 'REC_0', selectionRevision: 2, selectionActivatedGuid: 'REC_0',
    referencesExpanded: true, galleryExpanded: true,
    searchGeneration: 0, contextGeneration: 3, visibleLimit: 8,
    revealKey: 'pages|needle|workspace||', hierarchyCache: new Map(), hierarchyFetched: new Set(), contextCache: new Map(),
  };
  plugin._navigator = nav;
  plugin._renderReferenceNavigator = () => {};
  let teardownCalls = 0;
  plugin._navigatorSelectionChanged = () => { teardownCalls++; };

  await plugin._runNavigatorSearch('needle');

  assert.equal(nav.selectedGuid, 'REC_0');
  assert.equal(teardownCalls, 0);
  assert.equal(nav.referencesExpanded, true);
  assert.equal(nav.galleryExpanded, true);
});

test('default navigator shortcuts accept Ctrl-Shift-9 and macOS Cmd-Shift-9', () => {
  const { plugin } = makeHarness();
  plugin._isMac = true;
  plugin._navigatorHotkeys = [
    plugin._parseShortcut('Ctrl+Shift+9'),
    plugin._parseShortcut('Mod+Shift+9'),
  ];
  assert.equal(plugin._navigatorShortcutMatches(keyEvent('9', { code: 'Digit9', ctrlKey: true, shiftKey: true })), true);
  assert.equal(plugin._navigatorShortcutMatches(keyEvent('9', { code: 'Digit9', metaKey: true, shiftKey: true })), true);
  assert.equal(plugin._navigatorShortcutMatches(keyEvent('9', { code: 'Digit9', shiftKey: true })), false);
});

test('an explicit custom drillShortcut replaces rather than augments the defaults', () => {
  const { plugin } = makeHarness();
  plugin._navigatorHotkeys = [plugin._parseShortcut('Alt+Shift+9')];
  assert.equal(plugin._navigatorShortcutMatches(keyEvent('9', { code: 'Digit9', altKey: true, shiftKey: true })), true);
  assert.equal(plugin._navigatorShortcutMatches(keyEvent('9', { code: 'Digit9', ctrlKey: true, shiftKey: true })), false);
  assert.equal(plugin._navigatorShortcutMatches(keyEvent('9', { code: 'Digit9', metaKey: true, shiftKey: true })), false);
});

test('Reference Navigator v1 is frozen and delegates metadata-only open, close, and status calls', async () => {
  const { plugin, window } = makeHarness();
  const calls = [];
  plugin._openReferenceNavigator = async (options) => { calls.push(['open', options]); return true; };
  plugin._closeReferenceNavigator = (reason) => { calls.push(['close', reason]); return true; };
  plugin._referenceNavigatorStatus = () => ({ state: 'open', mode: 'blocks', queryLength: 4, resultCount: 3 });

  const api = plugin._initReferenceNavigator();
  assert.equal(window.__thymerReferenceNavigatorV1, api);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), ['close', 'getStatus', 'open']);
  assert.equal(window.__refxNavigatorOwner, undefined, 'custom-panel routing must not publish the full plugin instance');
  assert.equal(typeof window.__refxNavigatorPanelRender, 'function');

  await api.open({ mode: 'blocks', query: 'food', targetGuid: 'TARGET', placement: 'focus' });
  assert.equal(calls[0][0], 'open');
  assert.equal(calls[0][1].query, 'food');
  await api.open({ mode: 'pages', origin: { lineGuid: 'FORGED', offset: 9, segmentHash: 'forged' } });
  assert.equal('origin' in calls[1][1], false, 'the public API must never accept a caller-forged write origin');
  await api.open({ mode: 'pages', origin: null });
  assert.equal(calls[2][1].origin, null, 'public callers may explicitly request browse-only mode');
  const status = api.getStatus();
  assert.deepEqual(JSON.parse(JSON.stringify(status)), { state: 'open', mode: 'blocks', queryLength: 4, resultCount: 3 });
  assert.equal('query' in status, false, 'status must not expose note/search text');
  api.close();
  assert.equal(calls[3][0], 'close');
});

test('navigator mounts eight initial results, then virtualizes an expanded result DOM to forty rows', () => {
  const { plugin, document } = makeHarness();
  plugin._navigatorConfig = Object.freeze({ ...plugin._navigatorConfig, mediaMode: 'off' });
  const rootEl = document.createElement('section');
  const nav = {
    generation: 2, origin: null, mode: 'pages', query: '', scope: 'workspace', placement: 'focus',
    results: rows(103, 'NAV'), selectedIndex: 3, selectedGuid: 'NAV_3', searching: false, partial: false,
    contextGeneration: 0, mediaToken: 0, context: null, history: [], historyIndex: -1,
    hierarchyCache: new Map(), root: rootEl,
  };
  plugin._navigator = nav;

  plugin._mountReferenceNavigator(nav, rootEl);
  let results = rootEl.querySelector('.refx-nav-results');
  assert.equal(results.querySelectorAll('[role="option"]').length, 8, 'the first paint stays at the configured eight rows');
  assert.equal(results.querySelectorAll('.is-selected').length, 1);

  nav.results = rows(103, 'NAV');
  nav.selectedIndex = 61;
  nav.selectedGuid = 'NAV_61';
  nav.visibleLimit = 103;
  nav.revealWindowStart = 0;
  nav.revealWindowEnd = 103;
  plugin._renderReferenceNavigator(nav);

  results = rootEl.querySelector('.refx-nav-results');
  const outline = rootEl.querySelector('.refx-nav-outline');
  const preview = rootEl.querySelector('.refx-nav-preview');
  assert.ok(results && outline && preview, 'results, outline, and preview regions must all mount');
  assert.equal(results.getAttribute('role'), 'listbox');
  assert.equal(outline.getAttribute('aria-label'), 'Selected outline');
  assert.equal(preview.getAttribute('aria-label'), 'Preview and references');
  assert.equal(results.querySelectorAll('[role="option"]').length, 40);
  assert.equal(results.querySelectorAll('.is-selected').length, 1);
  assert.match(preview.textContent, /Open/);
  assert.match(preview.textContent, /Copy reference/);
  assert.doesNotMatch(preview.textContent, /Insert reference/);
});

test('navigator keyboard routes selection, drill, history, insert, open, preview, and close', () => {
  const { plugin, document } = makeHarness();
  const calls = [];
  const nav = {
    generation: 4, origin: { lineGuid: 'HOST' }, input: document.createElement('input'),
    results: rows(3, 'KEY'), selectedIndex: 0, selectedGuid: 'KEY_0', galleryExpanded: false,
  };
  plugin._navigator = nav;
  plugin._navigatorSelectionChanged = (state) => { state.selectedGuid = state.results[state.selectedIndex]?.guid || null; calls.push('select'); };
  plugin._navigatorDrillSelected = () => { calls.push('drill'); return true; };
  plugin._navigatorHistoryMove = () => { calls.push('back'); return true; };
  plugin._navigatorCommit = (result) => { calls.push('insert:' + result.guid); return true; };
  plugin._navigatorOpenResult = (result, newPanel) => { calls.push('open:' + result.guid + ':' + newPanel); return true; };
  plugin._closeReferenceNavigator = () => { calls.push('close'); return true; };

  plugin._navigatorKeydown(keyEvent('ArrowDown'), nav);
  assert.equal(nav.selectedIndex, 1);
  plugin._navigatorKeydown(keyEvent('ArrowRight'), nav);
  plugin._navigatorKeydown(keyEvent('ArrowLeft'), nav);
  plugin._navigatorKeydown(keyEvent('Enter'), nav);
  plugin._navigatorKeydown(keyEvent('Enter', { shiftKey: true }), nav);
  plugin._navigatorKeydown(keyEvent(' ', { target: document.createElement('div') }), nav);
  plugin._navigatorKeydown(keyEvent('Escape'), nav);

  assert.deepEqual(calls, ['select', 'drill', 'back', 'insert:KEY_1', 'open:KEY_1:true', 'close']);
  assert.equal(nav.galleryExpanded, true);

  calls.length = 0;
  nav.origin = null;
  plugin._navigatorKeydown(keyEvent('Enter'), nav);
  assert.deepEqual(calls, ['open:KEY_1:false'], 'browse-only Enter opens and never invents an insertion origin');
});

test('the first drill records both sides of the trail and supports back then forward', () => {
  const { plugin, document } = makeHarness();
  const nav = {
    generation: 5, mode: 'pages', query: 'policy', scope: 'workspace',
    results: [{ guid: 'PAGE', text: 'Policy', type: 'record', rguid: null }],
    selectedIndex: 0, selectedGuid: 'PAGE', history: [], historyIndex: -1,
    context: { sections: [{ key: 'children', items: [{ guid: 'CHILD', text: 'Clause 1' }] }] },
    root: document.createElement('section'),
  };
  plugin._navigator = nav;
  plugin._mountReferenceNavigator = () => {};
  plugin._runNavigatorSearch = () => Promise.resolve([]);

  assert.equal(plugin._navigatorDrillSelected(nav), true);
  assert.equal(nav.history.length, 2);
  assert.equal(nav.historyIndex, 1);
  assert.equal(nav.history[0].mode, 'pages');
  assert.equal(nav.history[1].mode, 'blocks');
  assert.equal(plugin._navigatorHistoryMove(-1), true);
  assert.equal(nav.mode, 'pages');
  assert.equal(plugin._navigatorHistoryMove(1), true);
  assert.equal(nav.mode, 'blocks');
  assert.equal(nav.selectedGuid, 'PAGE');
});

test('Space keeps the current selection and explicitly expands its lazy media preview', () => {
  const { plugin, document } = makeHarness();
  const nav = {
    generation: 5, origin: null, input: document.createElement('input'),
    results: rows(1, 'SPACE'), selectedIndex: 0, selectedGuid: 'SPACE_0',
    galleryExpanded: false, contextGeneration: 0,
  };
  plugin._navigator = nav;
  plugin._renderNavigatorContext = () => {};
  plugin._loadNavigatorContext = () => {};

  const event = keyEvent(' ', { target: document.createElement('div') });
  plugin._navigatorKeydown(event, nav);

  assert.equal(event.defaultPrevented, true);
  assert.equal(nav.selectedGuid, 'SPACE_0');
  assert.equal(nav.galleryExpanded, true);
});

test('context remount restarts media on the new host and preserves an explicitly opened References section', () => {
  const { plugin, document } = makeHarness();
  const nav = {
    generation: 6, contextGeneration: 1, selectedGuid: 'TARGET', selectedIndex: 0,
    results: [{ guid: 'TARGET', text: 'Target', rguid: 'OWNER' }],
    context: { target: { guid: 'TARGET', text: 'Target' }, breadcrumbs: [], sections: [
      { key: 'children', label: 'Children', items: [], collapsed: false },
      { key: 'nearby', label: 'Nearby', items: [], collapsed: false },
      { key: 'references', label: 'References', items: [], collapsed: true },
    ] },
    referencesExpanded: true, galleryExpanded: false,
    outlineEl: document.createElement('div'), previewEl: document.createElement('div'),
  };
  plugin._navigator = nav;
  const mediaHosts = [];
  let referenceLoads = 0;
  plugin._navigatorLoadMedia = (_nav, _result, host) => { mediaHosts.push(host); return Promise.resolve([]); };
  plugin._loadNavigatorReferences = () => { referenceLoads++; return Promise.resolve([]); };

  plugin._renderNavigatorContext(nav);
  const firstHost = mediaHosts[0];
  plugin._renderNavigatorContext(nav);

  assert.equal(mediaHosts.length, 2);
  assert.notEqual(mediaHosts[1], firstHost, 'hydration remount must target the replacement media node');
  assert.equal(referenceLoads, 2, 'Pin/remount keeps a user-expanded References section open and reloads it lazily');
  assert.equal(nav.previewEl.querySelector('.refx-nav-references').open, true);
});

test('line References uses the established exact indexed path and never invents a line getBackReferences API', async () => {
  const { plugin, document } = makeHarness();
  const host = document.createElement('div');
  const calls = [];
  plugin._queryRefLines = async (guid) => {
    calls.push(guid);
    return [{ guid: 'SOURCE_LINE', segments: segText('Source mention'), getRecord: () => ({ guid: 'SOURCE_PAGE', getName: () => 'Source page' }) }];
  };
  const result = {
    guid: 'TARGET_LINE', text: 'Target', rguid: 'TARGET_PAGE',
    getBackReferences() { throw new Error('PluginLineItem has no such API'); },
  };

  const refs = await plugin._loadNavigatorReferences(result, host, () => true);

  assert.deepEqual(calls, ['TARGET_LINE']);
  assert.equal(refs.length, 1);
  assert.equal(host.querySelectorAll('.refx-nav-reference-row').length, 1);
  assert.match(host.textContent, /Source mention/);
});

test('record References preserves native and metadata-only property mentions', async () => {
  const { plugin, document } = makeHarness();
  const host = document.createElement('div');
  plugin.data.getRecord = (guid) => guid === 'TARGET_PAGE' ? { guid } : null;
  plugin._queryRefLines = async () => [{
    guid: 'SOURCE_LINE', segments: segText('Inline source'),
    getRecord: () => ({ guid: 'INLINE_PAGE', getName: () => 'Inline page' }),
  }];
  plugin._fetchBackrefs = async () => [{
    kind: 'property', propertyId: 'project',
    record: { guid: 'PROPERTY_PAGE', getName: () => 'Property page' },
  }];
  plugin.loadPropertyReferenceRecordCount = async () => ({ recordGuids: ['PROPERTY_PAGE', 'PLAIN_PROPERTY_PAGE'] });
  plugin.getOrLoadRecordName = (guid) => guid === 'PLAIN_PROPERTY_PAGE' ? 'Plain property page' : guid;

  const refs = await plugin._loadNavigatorReferences(
    { guid: 'TARGET_PAGE', text: 'Target page', type: 'record', rguid: null }, host, () => true,
  );

  assert.equal(refs.length, 3);
  assert.equal(host.querySelectorAll('.refx-nav-reference-row').length, 3);
  assert.equal(host.querySelectorAll('.refx-nav-property-reference').length, 2);
  assert.match(host.textContent, /Property mentions/);
  assert.match(host.textContent, /Property page/);
  assert.match(host.textContent, /Plain property page/);
});

test('Pin transfers the live session through the registered SDK custom panel route', async () => {
  const { plugin, document } = makeHarness();
  const backdrop = document.createElement('div');
  document.body.append(backdrop);
  const calls = [];
  const panel = {
    getId: () => 'PANEL_1',
    async navigateToCustomType(type) { calls.push(type); return true; },
  };
  plugin.ui.getActivePanel = () => ({ id: 'ACTIVE' });
  plugin.ui.createPanel = async () => panel;
  const nav = { generation: 7, placement: 'focus', backdrop, root: document.createElement('section') };
  plugin._navigator = nav;

  const pinned = await plugin._pinReferenceNavigator(nav);

  assert.equal(pinned, true);
  assert.equal(nav.placement, 'panel');
  assert.equal(backdrop.isConnected, false);
  assert.equal(plugin._navigatorPanelTargets.get('PANEL_1'), nav);
  assert.deepEqual(calls, [plugin._navigatorPanelType]);
});

test('a stale Pin promise cannot resurrect a closed session or leak its panel mapping', async () => {
  const { plugin } = makeHarness();
  const createGate = deferred();
  let closes = 0;
  const panel = {
    getId: () => 'STALE_PANEL',
    async navigateToCustomType() { return true; },
  };
  plugin.ui.createPanel = async () => createGate.promise;
  plugin.ui.getActivePanel = () => null;
  plugin.ui.closePanel = (target) => { assert.equal(target, panel); closes++; };
  const oldNav = { generation: 10, placement: 'focus' };
  plugin._navigator = oldNav;
  const pending = plugin._pinReferenceNavigator(oldNav);
  plugin._navigator = { generation: 11, placement: 'focus' };
  createGate.resolve(panel);

  assert.equal(await pending, false);
  assert.equal(closes, 1);
  assert.equal(plugin._navigatorPanelTargets.has('STALE_PANEL'), false);
});

test('Open awaits native highlighted navigation; browse-only Copy uses no record content', async () => {
  const { plugin, clipboardWrites } = makeHarness();
  const gate = deferred();
  const calls = [];
  const panel = {
    async navigateTo(options) { calls.push(options); return gate.promise; },
  };
  plugin.ui.getActivePanel = () => panel;
  const pending = plugin._navigatorOpenResult({ guid: 'TARGET_LINE', text: 'private body text' }, false);
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ itemGuid: 'TARGET_LINE', highlight: true }]);
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'navigation promise must be awaited');
  gate.resolve(true);
  assert.equal(await pending, true);

  assert.equal(await plugin._navigatorCopyReference({ guid: 'TARGET_LINE', text: 'private body text' }), true);
  assert.deepEqual(clipboardWrites, ['thymer-ref://TARGET_LINE']);
  assert.equal(clipboardWrites[0].includes('private body text'), false);
});

test('new-panel Open uses a real edit_panel route and keeps a cold line owner open', async () => {
  const { plugin } = makeHarness();
  const calls = [];
  let closes = 0;
  const panel = {
    navigateTo(options) {
      calls.push(options);
      if (options.itemGuid) return Promise.resolve(false);
      return undefined; // official direct-navigation contract
    },
  };
  plugin.ui.getActivePanel = () => ({ id: 'SOURCE_PANEL' });
  plugin.ui.createPanel = async () => panel;
  plugin.ui.closePanel = () => { closes++; };

  const opened = await plugin._navigatorOpenResult({
    guid: 'TARGET_LINE', text: 'Target line', type: 'text', rguid: 'TARGET_PAGE',
  }, true);

  assert.equal(opened, true);
  assert.equal(closes, 0, 'a successful owner route survives a temporarily unresolved line highlight');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      type: 'edit_panel', rootId: 'TARGET_PAGE', subId: null, workspaceGuid: 'WS_V427',
      state: { highlightLines: ['TARGET_LINE'] },
    },
    { itemGuid: 'TARGET_LINE', highlight: true },
  ]);
});

test('record Open treats void direct navigation as success', async () => {
  const { plugin } = makeHarness();
  const calls = [];
  plugin.data.getRecord = (guid) => guid === 'TARGET_PAGE' ? { guid } : null;
  plugin.ui.getActivePanel = () => ({ navigateTo(options) { calls.push(options); return undefined; } });

  assert.equal(await plugin._navigatorOpenResult({ guid: 'TARGET_PAGE', type: 'record' }, false), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    type: 'edit_panel', rootId: 'TARGET_PAGE', subId: null, workspaceGuid: 'WS_V427',
  }]);
});

test('failed navigation closes only a panel created for that Open action', async () => {
  const { plugin } = makeHarness();
  let closes = 0;
  const createdPanel = { async navigateTo() { return false; } };
  plugin.ui.createPanel = async () => createdPanel;
  plugin.ui.closePanel = (target) => { assert.equal(target, createdPanel); closes++; };
  plugin.ui.getActivePanel = () => ({ async navigateTo() { return false; } });

  assert.equal(await plugin._navigatorOpenResult({ guid: 'TARGET' }, true), false);
  assert.equal(closes, 1);
  assert.equal(await plugin._navigatorOpenResult({ guid: 'TARGET' }, false), false);
  assert.equal(closes, 1, 'a failed existing-active-panel navigation must not close the user panel');
});

test('closing the navigator cancels stale work, removes its shell, and revokes owned media', () => {
  const { plugin, document, revokedUrls } = makeHarness();
  const shell = document.createElement('div');
  document.body.append(shell);
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 25);
  plugin._previewBlobCache = new Map([
    ['A', { url: 'blob:a', bytes: 1024 }],
    ['B', { url: 'blob:b', bytes: 2048 }],
  ]);
  plugin._navigatorMediaBytes = 3072;
  plugin._navigator = {
    generation: 8,
    placement: 'focus', backdrop: shell, root: shell,
    searchTimer: timer, searchGeneration: 0, contextGeneration: 0, mediaToken: 0,
    ownedBlobUrls: new Set(['blob:a', 'blob:b']),
    origin: { lineGuid: 'HOST' },
  };
  let refocused = 0;
  plugin._refocusEditor = () => { refocused++; };

  plugin._closeReferenceNavigator('test');

  assert.equal(plugin._navigator, null);
  assert.equal(shell.isConnected, false);
  assert.equal(timerFired, false);
  assert.deepEqual(revokedUrls.sort(), ['blob:a', 'blob:b']);
  assert.equal(plugin._previewBlobCache.size, 0, 'closed panels must not retain revoked cache entries');
  assert.equal(plugin._navigatorMediaBytes, 0);
  assert.equal(refocused, 1);
});

test('navigator commit inserts at the captured grapheme offset without requiring literal [[ text', async () => {
  const { plugin } = makeHarness();
  let segments = segText('alpha beta');
  let writes = 0;
  const line = {
    guid: 'HOST_LINE',
    get segments() { return segments; },
    setSegments(next) { writes++; segments = next; return true; },
  };
  plugin._resolveLineItemByGuid = async () => line;
  plugin._liveSegs = () => segments;
  plugin._liveStateByGuid = () => null;
  plugin._queueImmediateRefPaint = () => {};
  plugin._navigator = {
    generation: 4,
    mode: 'pages',
    origin: {
      lineGuid: 'HOST_LINE', pageGuid: 'HOST_PAGE', offset: 5,
      segmentHash: plugin._referenceEditDigest(segments), generation: 4,
    },
  };

  const ok = await plugin._navigatorCommit({ guid: 'TARGET_PAGE', text: 'Target Page', rguid: null });

  assert.equal(ok, true);
  assert.equal(writes, 1);
  const ref = segments.find((segment) => segment.type === 'ref');
  assert.equal(ref.text.guid, 'TARGET_PAGE');
  assert.equal(segments.filter((segment) => segment.type === 'text').map((segment) => segment.text).join(''), 'alpha beta');
  assert.equal(segments.some((segment) => segment.type === 'text' && segment.text.includes('[[')), false);
});

test('grapheme offsets never split ZWJ emoji or combining-character clusters', () => {
  const { plugin } = makeHarness();
  const text = 'A👩‍👩‍👧‍👦e\u0301B';
  assert.deepEqual(Array.from(plugin._splitGraphemes(text)), ['A', '👩‍👩‍👧‍👦', 'e\u0301', 'B']);
  const inserted = plugin._insertAt(segText(text), 2, { type: 'ref', text: { guid: 'TARGET' } });
  assert.equal(inserted[0].text, 'A👩‍👩‍👧‍👦');
  assert.equal(inserted[1].type, 'ref');
  assert.equal(inserted[2].text, 'e\u0301B');
});

test('caret offsets split formatted SDK text runs and preserve their formatting', () => {
  const { plugin } = makeHarness();
  const ref = { type: 'ref', text: { guid: 'TARGET' } };
  const source = [
    { type: 'bold', text: 'AB' },
    { type: 'italic', text: 'CD' },
    { type: 'ref', text: '1LEGACYREF0000000000000000' },
    { type: 'code', text: 'EF' },
  ];

  assert.equal(plugin._splitGraphemes(plugin._lineText(source)).length, 7,
    'formatted text contributes its real grapheme length while the legacy ref stays atomic');
  const within = plugin._insertAt(source, 1, ref);
  assert.deepEqual(JSON.parse(JSON.stringify(within.slice(0, 3))), [
    { type: 'bold', text: 'A' }, ref, { type: 'bold', text: 'B' },
  ]);
  const boundary = plugin._insertAt(source, 2, ref);
  assert.deepEqual(JSON.parse(JSON.stringify(boundary.slice(0, 3))), [
    { type: 'bold', text: 'AB' }, ref, { type: 'italic', text: 'CD' },
  ]);
});

test('range replacement uses the same formatted-segment caret model', () => {
  const { plugin } = makeHarness();
  const ref = { type: 'ref', text: { guid: 'TARGET' } };
  const replaced = plugin._replaceRange([
    { type: 'bold', text: 'AB' },
    { type: 'text', text: '[[needle' },
  ], 2, 10, ref);

  assert.deepEqual(JSON.parse(JSON.stringify(replaced)), [
    { type: 'bold', text: 'AB' },
    ref,
  ]);
});

test('origin digest covers non-title segment payload fields', () => {
  const { plugin } = makeHarness();
  const first = [{ type: 'linkobj', text: { guid: 'LINK', title: 'Policy', url: 'https://one.example', meta: { revision: 1 } } }];
  const changedUrl = [{ type: 'linkobj', text: { guid: 'LINK', title: 'Policy', url: 'https://two.example', meta: { revision: 1 } } }];
  const changedNested = [{ type: 'linkobj', text: { guid: 'LINK', title: 'Policy', url: 'https://one.example', meta: { revision: 2 } } }];
  assert.notEqual(plugin._referenceEditDigest(first), plugin._referenceEditDigest(changedUrl));
  assert.notEqual(plugin._referenceEditDigest(first), plugin._referenceEditDigest(changedNested));
});

test('a successful delayed write is polled once and never duplicated while the live model catches up', async () => {
  const { plugin } = makeHarness();
  const original = segText('delayed model');
  let written = null;
  let reads = 0;
  let writes = 0;
  const line = {
    guid: 'HOST_DELAYED',
    get segments() {
      reads++;
      return written && reads >= 4 ? written : original;
    },
    setSegments(next) { writes++; written = next; return true; },
  };
  plugin._resolveLineItemByGuid = async () => line;
  plugin._liveStateByGuid = () => null;
  plugin._queueImmediateRefPaint = () => {};
  plugin._navigator = {
    generation: 21, mode: 'pages',
    origin: {
      lineGuid: 'HOST_DELAYED', pageGuid: 'PAGE', offset: 7,
      segmentHash: plugin._referenceEditDigest(original), generation: 21,
    },
  };

  const ok = await plugin._navigatorCommit({ guid: 'TARGET_DELAYED', text: 'Target delayed', type: 'record' });

  assert.equal(ok, true);
  assert.equal(writes, 1, 'verification lag must never cause a duplicate setSegments call');
  assert.equal(written.filter((segment) => segment.type === 'ref' && segment.text?.guid === 'TARGET_DELAYED').length, 1);
});

test('navigator commit fails closed when the origin line changed after opening', async () => {
  const { plugin } = makeHarness();
  const original = segText('alpha beta');
  let segments = segText('alpha beta changed elsewhere');
  let writes = 0;
  const line = {
    guid: 'HOST_LINE',
    get segments() { return segments; },
    setSegments(next) { writes++; segments = next; return true; },
  };
  plugin._resolveLineItemByGuid = async () => line;
  plugin._liveSegs = () => segments;
  plugin._liveStateByGuid = () => null;
  plugin._queueImmediateRefPaint = () => {};
  plugin._navigator = {
    generation: 9,
    mode: 'blocks',
    origin: {
      lineGuid: 'HOST_LINE', pageGuid: 'HOST_PAGE', offset: 5,
      segmentHash: plugin._referenceEditDigest(original), generation: 9,
    },
  };

  const ok = await plugin._navigatorCommit({ guid: 'TARGET_LINE', text: 'Target line', rguid: 'TARGET_PAGE' });

  assert.equal(ok, false);
  assert.equal(writes, 0, 'changed source text must never be overwritten');
  assert.deepEqual(JSON.parse(JSON.stringify(segments)), [{ type: 'text', text: 'alpha beta changed elsewhere' }]);
});

test('navigator caret insertion treats legacy string-valued refs as one atomic caret unit', async () => {
  const { plugin } = makeHarness();
  const legacyGuid = '1LEGACYREF0000000000000000';
  let segments = [
    { type: 'ref', text: legacyGuid },
    { type: 'text', text: ' tail' },
  ];
  const line = {
    guid: 'HOST_LINE',
    get segments() { return segments; },
    setSegments(next) { segments = next; return true; },
  };
  plugin._resolveLineItemByGuid = async () => line;
  plugin._liveSegs = () => segments;
  plugin._liveStateByGuid = () => null;
  plugin._queueImmediateRefPaint = () => {};
  plugin._navigator = {
    generation: 12,
    mode: 'blocks',
    origin: {
      lineGuid: 'HOST_LINE', pageGuid: 'HOST_PAGE', offset: 1,
      segmentHash: plugin._referenceEditDigest(segments), generation: 12,
    },
  };

  const ok = await plugin._navigatorCommit({ guid: 'NEW_TARGET', text: 'New target', rguid: 'TARGET_PAGE' });

  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(segments[0])), { type: 'ref', text: legacyGuid });
  assert.equal(segments[1].type, 'ref');
  assert.equal(segments[1].text.guid, 'NEW_TARGET');
  assert.equal(segments.slice(2).map((segment) => segment.text).join(''), ' tail');
});

test('a stale navigator generation cannot commit into a later session', async () => {
  const { plugin } = makeHarness();
  const segments = segText('unchanged');
  let writes = 0;
  plugin._resolveLineItemByGuid = async () => ({
    guid: 'HOST_LINE', segments,
    setSegments() { writes++; },
  });
  plugin._liveSegs = () => segments;
  plugin._navigator = {
    generation: 15,
    mode: 'pages',
    origin: {
      lineGuid: 'HOST_LINE', pageGuid: 'HOST_PAGE', offset: 0,
      segmentHash: plugin._referenceEditDigest(segments), generation: 14,
    },
  };

  const ok = await plugin._navigatorCommit({ guid: 'TARGET', text: 'Target' });

  assert.equal(ok, false);
  assert.equal(writes, 0);
});

test('Navigator search and commit both reject a reference to the originating line itself', async () => {
  const universe = {
    HOST: { guid: 'HOST', rguid: 'OWNER', type: 'text', text_segments: ['text', 'self needle'] },
    OTHER: { guid: 'OTHER', rguid: 'OWNER', type: 'text', text_segments: ['text', 'other needle'] },
  };
  const { plugin } = makeHarness({ universe });
  const original = segText('host text');
  let resolves = 0;
  plugin._resolveLineItemByGuid = async () => { resolves++; return null; };
  const nav = {
    generation: 16, mode: 'blocks', query: 'needle', scope: 'workspace',
    origin: { lineGuid: 'HOST', pageGuid: 'OWNER', offset: 0, segmentHash: plugin._referenceEditDigest(original), generation: 16 },
    results: [], selectedIndex: 0, selectedGuid: null, selectionRevision: 0,
    searchGeneration: 0, contextGeneration: 0, visibleLimit: 8, revealKey: '',
    hierarchyCache: new Map(), hierarchyFetched: new Set(), contextCache: new Map(),
  };
  plugin._navigator = nav;
  plugin._renderReferenceNavigator = () => {};
  plugin._navigatorSelectionChanged = (state) => { state.selectionActivatedGuid = state.selectedGuid; };
  await plugin._runNavigatorSearch('needle');
  assert.equal(nav.results.some((row) => row.guid === 'HOST'), false);
  assert.equal(await plugin._navigatorCommit({ guid: 'HOST', text: 'self needle', rguid: 'OWNER' }), false);
  assert.equal(resolves, 0, 'self-reference rejection happens before resolving or writing the origin');
});

test('property images use fileBlob and gallery expansion extends the cache with branch images', async () => {
  const { plugin } = makeHarness();
  const propertyBlobs = new Map(['Banner', 'Cover', 'Image'].map((label) => [label, {
    guid: 'PROP_' + label, fileName: label + '.png', fileSize: 100,
    contentType: 'image/png', async download() { return new Uint8Array(100); },
  }]));
  let rawDownloads = 0;
  let bodyReads = 0;
  const bodyImage = {
    guid: 'BODY_IMAGE', type: 'image', children: [],
    async getBlob() { return { contentType: 'image/jpeg', fileSize: 100, async download() { return new Uint8Array(100); } }; },
  };
  const target = { guid: 'TARGET', type: 'text', segments: segText('Target'), children: [bodyImage] };
  const record = {
    guid: 'OWNER',
    prop(label) {
      const pluginBlob = propertyBlobs.get(label) || null;
      return {
        async fileBlob() { return pluginBlob; },
        values() { return pluginBlob ? [{ async download() { rawDownloads++; } }] : []; },
      };
    },
    async getLineItems() { bodyReads++; return [target]; },
  };
  plugin.data.getRecord = () => record;
  const nav = {
    generation: 7, contextGeneration: 1, selectedGuid: 'TARGET', galleryExpanded: false,
    mediaCandidateCache: new Map(), hierarchyCache: new Map(), hierarchyFetched: new Set(), hierarchyActive: null,
    context: null,
  };
  const result = { guid: 'TARGET', text: 'Target', rguid: 'OWNER', type: 'text' };
  plugin._navigator = nav;

  const settled = await plugin._navigatorMediaCandidates(nav, result);
  assert.equal(settled.length, 3);
  assert.equal(bodyReads, 0, 'three property images satisfy settled preview without reading the body');
  nav.galleryExpanded = true;
  const gallery = await plugin._navigatorMediaCandidates(nav, result);
  assert.ok(gallery.some((candidate) => candidate.guid === 'BODY_IMAGE'));
  assert.equal(bodyReads, 1);
  assert.equal(rawDownloads, 0, 'raw property values are metadata, never blob handles');
});

test('property-only media candidates obey the fifty-target LRU bound', async () => {
  const { plugin } = makeHarness();
  plugin.data.getRecord = (guid) => ({
    guid,
    prop(label) {
      if (!['Banner', 'Cover', 'Image'].includes(label)) return { values: () => [] };
      return {
        async fileBlob() {
          return { guid: guid + '_' + label, fileName: label + '.png', fileSize: 100, contentType: 'image/png' };
        },
        values: () => [],
      };
    },
  });
  const nav = {
    galleryExpanded: false, selectedGuid: null,
    mediaCandidateCache: new Map(), hierarchyCache: new Map(), hierarchyFetched: new Set(),
  };
  plugin._navigator = nav;

  for (let index = 0; index < 55; index++) {
    const guid = 'MEDIA_RECORD_' + index;
    nav.selectedGuid = guid;
    const candidates = await plugin._navigatorMediaCandidates(nav, { guid, type: 'record', rguid: null });
    assert.equal(candidates.length, 3);
  }

  assert.equal(nav.mediaCandidateCache.size, 50);
  assert.equal(nav.mediaCandidateCache.has('MEDIA_RECORD_0'), false);
  assert.equal(nav.mediaCandidateCache.has('MEDIA_RECORD_4'), false);
  assert.equal(nav.mediaCandidateCache.has('MEDIA_RECORD_5'), true);
  assert.equal(nav.mediaCandidateCache.has('MEDIA_RECORD_54'), true);
});

test('gallery mode still loads only three settled images until the explicit gallery action', async () => {
  const { plugin, document } = makeHarness();
  plugin._navigatorConfig = Object.freeze({ ...plugin._navigatorConfig, mediaMode: 'gallery' });
  const host = document.createElement('div');
  const result = { guid: 'MEDIA_TARGET', type: 'record', rguid: null };
  const nav = {
    generation: 3, contextGeneration: 1, selectedGuid: result.guid,
    mediaToken: 0, mediaQueue: Promise.resolve(), mediaStableAt: performance.now() - 1,
    galleryExpanded: false, mediaCandidateCache: new Map(),
  };
  plugin._navigator = nav;
  plugin._navigatorMediaCandidates = async () => [0, 1, 2].map((index) => ({ guid: 'IMAGE_' + index }));
  plugin._resolveBlobUrl = async (candidate) => 'blob:' + candidate.guid;

  const urls = await plugin._navigatorLoadMedia(nav, result, host);

  assert.equal(urls.length, 3);
  assert.equal(host.querySelectorAll('.refx-nav-image').length, 3);
  const gallery = host.querySelector('.refx-nav-gallery');
  assert.ok(gallery, 'gallery mode must expose a deliberate lazy action');
  assert.equal(gallery.textContent, 'Open image gallery');
  assert.equal(nav.galleryExpanded, false);
});

test('blob resolver accepts bounded local raster images and rejects SVG, non-images, and >5 MiB payloads', async () => {
  const { plugin, createdUrls } = makeHarness();
  const blobLine = (guid, contentType, bytes) => ({
    guid,
    async getBlob() {
      return { contentType, size: bytes, async download() { return new Uint8Array(bytes); } };
    },
  });

  const png = await plugin._resolveBlobUrl(blobLine('PNG', 'image/png', 1024));
  const svg = await plugin._resolveBlobUrl(blobLine('SVG', 'image/svg+xml', 1024));
  const text = await plugin._resolveBlobUrl(blobLine('TEXT', 'text/plain', 1024));
  const huge = await plugin._resolveBlobUrl(blobLine('HUGE', 'image/jpeg', 5 * 1024 * 1024 + 1));
  let preflightDownloads = 0;
  const preflightHuge = await plugin._resolveBlobUrl({
    guid: 'PREFLIGHT_HUGE',
    async getBlob() {
      return {
        contentType: 'image/webp', fileSize: 5 * 1024 * 1024 + 1,
        async download() { preflightDownloads++; return new Uint8Array(1); },
      };
    },
  });

  assert.match(String(png), /^blob:v427-/);
  assert.equal(svg, null);
  assert.equal(text, null);
  assert.equal(huge, null);
  assert.equal(preflightHuge, null);
  assert.equal(preflightDownloads, 0, 'PluginBlob.fileSize must reject oversized media before download');
  assert.equal(createdUrls.length, 1, 'rejected media must never receive an object URL');
});

test('blob resolver coalesces duplicate in-flight reads and keeps its cache within 32 MiB', async () => {
  const { plugin, revokedUrls } = makeHarness();
  const gate = deferred();
  let downloads = 0;
  const shared = {
    guid: 'SHARED',
    async getBlob() {
      return {
        contentType: 'image/png', size: 4096,
        async download() { downloads++; await gate.promise; return new Uint8Array(4096); },
      };
    },
  };
  const first = plugin._resolveBlobUrl(shared);
  const second = plugin._resolveBlobUrl(shared);
  gate.resolve();
  const resolved = await Promise.all([first, second]);
  assert.equal(downloads, 1);
  assert.ok(resolved.some(Boolean));

  for (let index = 0; index < 9; index++) {
    const bytes = 4 * 1024 * 1024;
    await plugin._resolveBlobUrl({
      guid: 'CACHE_' + index,
      async getBlob() {
        return { contentType: 'image/webp', size: bytes, async download() { return new Uint8Array(bytes); } };
      },
    });
  }
  assert.ok(plugin._navigatorMediaBytes <= 32 * 1024 * 1024);
  assert.ok(revokedUrls.length >= 1, 'byte-bound eviction must revoke the oldest object URL');
});

test('an old uncancellable blob completion cannot delete a newer pending read for the same GUID', async () => {
  const { plugin } = makeHarness();
  const oldStarted = deferred();
  const newStarted = deferred();
  const oldGate = deferred();
  const newGate = deferred();
  let call = 0;
  const candidate = {
    guid: 'SAME_GUID',
    async getBlob() {
      call++;
      if (call === 1) {
        return { contentType: 'image/png', fileSize: 10, async download() { oldStarted.resolve(); await oldGate.promise; return new Uint8Array(10); } };
      }
      return { contentType: 'image/png', fileSize: 10, async download() { newStarted.resolve(); await newGate.promise; return new Uint8Array(10); } };
    },
  };
  const old = plugin._resolveBlobUrl(candidate);
  await oldStarted.promise;
  plugin._previewBlobEpoch++;
  plugin._previewBlobPending.clear();
  const newer = plugin._resolveBlobUrl(candidate);
  await newStarted.promise;

  oldGate.resolve();
  assert.equal(await old, null);
  assert.equal(plugin._previewBlobPending.get('SAME_GUID'), newer,
    'the old finally block must not erase the replacement promise');
  newGate.resolve();
  assert.match(String(await newer), /^blob:v427-/);
});

test('superseded media stays stale and local blob downloads remain one-at-a-time across selections', async () => {
  const { plugin, document } = makeHarness();
  const firstGate = deferred();
  const secondGate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const starts = [];
  const firstHost = document.createElement('div');
  const secondHost = document.createElement('div');
  const nav = {
    generation: 3,
    contextGeneration: 0,
    mediaToken: 0,
    mediaQueue: Promise.resolve(),
    selectedGuid: 'A',
    selectedIndex: 0,
    results: [{ guid: 'A', text: 'A', rguid: 'PAGE' }],
    galleryExpanded: false,
  };
  plugin._navigator = nav;
  plugin._navigatorMediaCandidates = async (_nav, result) => [{ guid: 'IMAGE_' + result.guid }];
  plugin._resolveBlobUrl = async (candidate) => {
    starts.push(candidate.guid);
    if (candidate.guid === 'IMAGE_A') {
      firstStarted.resolve();
      await firstGate.promise;
    } else {
      secondStarted.resolve();
      await secondGate.promise;
    }
    return 'blob:' + candidate.guid;
  };
  const pendingFirst = plugin._navigatorLoadMedia(nav, nav.results[0], firstHost);
  await firstStarted.promise;

  nav.contextGeneration = 1;
  nav.selectedGuid = 'B';
  nav.results = [{ guid: 'B', text: 'B', rguid: 'PAGE' }];
  const pendingSecond = plugin._navigatorLoadMedia(nav, nav.results[0], secondHost);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(starts, ['IMAGE_A'], 'the new selection must wait for the non-cancellable prior SDK download');

  firstGate.resolve();
  await secondStarted.promise;
  secondGate.resolve();
  await Promise.all([pendingFirst, pendingSecond]);

  assert.equal(firstHost.children.length, 0, 'late media cannot mutate the superseded preview');
  assert.equal(secondHost.children.length, 1);
  assert.deepEqual(starts, ['IMAGE_A', 'IMAGE_B']);
});

test('closing during a blob download prevents a late object URL from escaping revocation', async () => {
  const { plugin, createdUrls } = makeHarness();
  const started = deferred();
  const gate = deferred();
  const pending = plugin._resolveBlobUrl({
    guid: 'LATE_CLOSE',
    async getBlob() {
      return {
        contentType: 'image/png', size: 4096,
        async download() { started.resolve(); await gate.promise; return new Uint8Array(4096); },
      };
    },
  });
  await started.promise;
  plugin._navigator = {
    generation: 9, searchGeneration: 0, contextGeneration: 0, mediaToken: 0,
    placement: 'focus', searchTimer: 0, origin: null,
  };
  plugin._closeReferenceNavigator({ restoreFocus: false });
  gate.resolve();

  assert.equal(await pending, null);
  assert.equal(createdUrls.length, 0, 'a close epoch must fence URL creation after the download settles');
});

test('100k record-title navigation keeps first paint bounded and never hydrates record bodies', async () => {
  const { plugin } = makeHarness();
  const total = 100000;
  plugin._recordNameIndex = new Map();
  for (let index = 0; index < total; index++) {
    const match = index % 1000 === 0 ? ' navigator needle' : '';
    plugin._recordNameIndex.set('REC_' + index, 'Record ' + index + match);
  }
  let bodyReads = 0;
  let recordCalls = 0;
  plugin.data.getRecord = (guid) => {
    recordCalls++;
    return {
      guid,
      getName: () => plugin._recordNameIndex.get(guid),
      async getLineItems() { bodyReads++; return []; },
    };
  };
  plugin.data.searchByQuery = async () => ({ records: [], lines: [] });
  const link = {
    kind: 'record', query: 'navigator needle', token: 0, r5Session: 17,
    results: [], resultsQuery: null, sel: 0, userSelected: false,
  };
  plugin._link = link;
  let firstPaint = null;
  let renderCalls = 0;
  const started = performance.now();
  plugin._renderLink = () => {
    renderCalls++;
    if (firstPaint == null && link.results.length) firstPaint = performance.now() - started;
  };

  const pending = plugin._runRecordSearch('navigator needle');
  await pending;
  if (link.recordScanDone) await link.recordScanDone;

  assert.ok(firstPaint != null && firstPaint < 80, `100k title first paint was ${firstPaint}ms`);
  assert.ok(link.resultPool.length > 8, 'complete metadata index must support progressive results beyond the initial eight');
  assert.equal(link.results.length, 8);
  assert.equal(bodyReads, 0);
  assert.equal(recordCalls, 0, 'a complete metadata title index must avoid per-document SDK lookups');
});

test('250k line scan yields a bounded first paint and makes zero body-hydration calls', async () => {
  const universe = {};
  const total = 250000;
  for (let index = 0; index < total; index++) {
    const guid = 'LINE_' + index;
    universe[guid] = {
      guid,
      rguid: 'OWNER_' + (index % 500),
      type: 'ulist',
      is_deleted: false,
      is_trashed: false,
      text_segments: ['text', 'Line ' + index + (index % 5000 === 0 ? ' scale needle' : '')],
    };
  }
  const { plugin } = makeHarness({ universe });
  let bodyReads = 0;
  let recordCalls = 0;
  plugin.data.getRecord = (guid) => {
    recordCalls++;
    return {
      guid,
      getName: () => 'Owner',
      async getLineItems() { bodyReads++; return []; },
    };
  };
  plugin.data.searchByQuery = async () => ({ records: [], lines: [] });
  plugin._lineAliasByLine = new Map();
  const link = {
    kind: 'line', lineGuid: 'HOST', query: 'scale needle', token: 0, r5Session: 17,
    results: [], resultsQuery: null, sel: 0, userSelected: false, textCache: new Map(),
  };
  plugin._link = link;
  let firstPaint = null;
  let renderCalls = 0;
  const started = performance.now();
  plugin._renderLink = () => {
    renderCalls++;
    if (firstPaint == null && link.results.length) firstPaint = performance.now() - started;
  };

  await plugin._runLinkSearch('scale needle');
  assert.ok(firstPaint != null && firstPaint < 120, `250k-line first paint was ${firstPaint}ms`);
  assert.ok(link.results.length <= 8, 'inline DOM/result window must stay bounded');
  if (link.scanDone) await link.scanDone;
  assert.equal(link.resultPool.length, 50, 'all matching loaded lines must survive beyond the old 48-row ranking reservoir');
  assert.equal(link.results.length, 8, 'settling the complete pool must preserve the bounded visible window');
  plugin._revealMoreLinkResults(link);
  assert.equal(link.results.length, 16, 'revealing more lines must slice the cached pool without rescanning');
  assert.ok(performance.now() - started < 4000, 'sparse 250k scan must settle without monopolising the UI');
  assert.equal(link.textCache.size, 50, 'only matching rows belong in the normalized-text cache');
  assert.equal(link.scanCandidates.size, 50);
  assert.equal(link.scanCandidatesCapped, false);
  assert.ok(renderCalls <= 80, `progressive scan rebuilt results ${renderCalls} times`);
  assert.equal(bodyReads, 0, 'root ranking must never hydrate record bodies');
  assert.equal(recordCalls, 0, 'loaded-line ranking must not resolve an SDK record per line');
});

test('250k broad line scan caps every retained pool and throttles progressive paints', async () => {
  const universe = {};
  const total = 250000;
  for (let index = 0; index < total; index++) {
    const guid = 'BROAD_LINE_' + index;
    universe[guid] = {
      guid, rguid: 'BROAD_OWNER_' + (index % 500), type: 'ulist',
      is_deleted: false, is_trashed: false,
      text_segments: ['text', 'broad scale line ' + index],
    };
  }
  const { plugin } = makeHarness({ universe });
  let bodyReads = 0;
  let recordCalls = 0;
  plugin.data.getRecord = () => { recordCalls++; return { async getLineItems() { bodyReads++; return []; } }; };
  plugin.data.searchByQuery = async () => ({ records: [], lines: [] });
  plugin._lineAliasByLine = new Map();
  const link = {
    kind: 'line', lineGuid: 'HOST', query: 'broad', token: 0, r5Session: 17,
    results: [], resultsQuery: null, sel: 0, userSelected: false, textCache: new Map(),
  };
  plugin._link = link;
  let firstPaint = null;
  let renderCalls = 0;
  const started = performance.now();
  plugin._renderLink = () => {
    renderCalls++;
    if (firstPaint == null && link.results.length) firstPaint = performance.now() - started;
  };

  await plugin._runLinkSearch('broad');
  assert.ok(firstPaint != null && firstPaint < 120, `250k broad first paint was ${firstPaint}ms`);
  if (link.scanDone) await link.scanDone;
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 5000, `250k broad scan settled in ${elapsed}ms`);
  assert.equal(link.resultPool.length, plugin._BLOCK_RESULT_POOL_CAP);
  assert.ok(link.textCache.size <= plugin._BLOCK_RESULT_POOL_CAP);
  assert.ok(link.scanCandidates.size <= plugin._BLOCK_RESULT_POOL_CAP);
  assert.equal(link.resultPoolCapped, true);
  assert.equal(link.scanCandidatesCapped, true);
  assert.ok(renderCalls <= 80, `broad scan rebuilt results ${renderCalls} times`);
  assert.equal(bodyReads, 0);
  assert.equal(recordCalls, 0);
});

test('a capped candidate set full-rescans a prefix extension so dropped late hits remain discoverable', async () => {
  const universe = {};
  for (let index = 0; index < 65; index++) {
    const guid = 'PREFIX_LINE_' + index;
    universe[guid] = {
      guid, rguid: 'PREFIX_OWNER', type: 'ulist', is_deleted: false, is_trashed: false,
      text_segments: ['text', index === 64 ? 'ab target' : 'a filler ' + index],
    };
  }
  const { plugin } = makeHarness({ universe });
  plugin._BLOCK_RESULT_POOL_CAP = 64;
  plugin.data.searchByQuery = async () => ({ records: [], lines: [] });
  plugin._lineAliasByLine = new Map();
  const link = {
    kind: 'line', lineGuid: 'HOST', query: 'a', token: 0, r5Session: 17,
    results: [], resultsQuery: null, sel: 0, userSelected: false, textCache: new Map(),
  };
  plugin._link = link;
  plugin._renderLink = () => {};

  await plugin._runLinkSearch('a');
  await link.scanDone;
  assert.equal(link.scanCandidatesCapped, true);
  assert.equal(link.scanCandidates.has('PREFIX_LINE_64'), false);

  await plugin._runLinkSearch('ab');
  await link.scanDone;
  assert.ok(link.resultPool.some((row) => row.guid === 'PREFIX_LINE_64'));
});

test('cached prefix narrowing preserves a late exact text hit when aliases filled the capped pool first', async () => {
  const universe = {
    TARGET: {
      guid: 'TARGET', rguid: 'OWNER', type: 'ulist', is_deleted: false, is_trashed: false,
      text_segments: ['text', 'ab'],
    },
  };
  const { plugin } = makeHarness({ universe });
  plugin._BLOCK_RESULT_POOL_CAP = 64;
  plugin.data.searchByQuery = async () => ({ records: [], lines: [] });
  plugin._lineAliasByLine = new Map();
  for (let index = 0; index < 64; index++) {
    const guid = 'ALIAS_LINE_' + index;
    plugin._lineAliasByLine.set(guid, {
      lineGuid: guid,
      recordGuid: 'ALIAS_OWNER',
      currentText: 'Alias source ' + index,
      status: 'active',
      aliases: [plugin._lineAliasMakeItem('ab alias ' + index)],
    });
  }
  const link = {
    kind: 'line', lineGuid: 'HOST', query: 'a', token: 0, r5Session: 17,
    results: [], resultsQuery: null, sel: 0, userSelected: false, textCache: new Map(),
  };
  plugin._link = link;
  plugin._renderLink = () => {};

  await plugin._runLinkSearch('a');
  await link.scanDone;
  assert.equal(link.scanCandidatesCapped, false);
  assert.equal(link.scanCandidates.has('TARGET'), true);
  assert.ok(link.resultPool.some((row) => row.guid === 'TARGET'));

  await plugin._runLinkSearch('ab');
  await link.scanDone;
  assert.ok(link.resultPool.some((row) => row.guid === 'TARGET'),
    'the deferred text reservoir must survive an alias-filled complete pool');
  assert.equal(link.resultPool[0].guid, 'TARGET');
});

test('native enrichment invalidates the cached narrowed ordering before settled publication', async () => {
  const universe = {
    LOCAL: {
      guid: 'LOCAL', rguid: 'LOCAL_OWNER', type: 'ulist', is_deleted: false, is_trashed: false,
      text_segments: ['text', 'ab local'],
    },
  };
  const { plugin } = makeHarness({ universe });
  const nativeExact = {
    guid: 'NATIVE_EXACT', type: 'text', segments: segText('ab'),
    getRecord() { return { guid: 'NATIVE_OWNER', getName: () => 'Native owner' }; },
  };
  plugin.data.searchByQuery = async (query) => ({
    records: [],
    lines: query === 'ab' ? [nativeExact] : [],
  });
  plugin._lineAliasByLine = new Map();
  const link = {
    kind: 'line', lineGuid: 'HOST', query: 'a', token: 0, r5Session: 17,
    results: [], resultsQuery: null, sel: 0, userSelected: false, textCache: new Map(),
  };
  plugin._link = link;
  plugin._renderLink = () => {};

  await plugin._runLinkSearch('a');
  await link.scanDone;
  await plugin._runLinkSearch('ab');
  await link.scanDone;

  assert.equal(link.resultPool[0].guid, 'NATIVE_EXACT');
  assert.ok(link.resultPool.some((row) => row.guid === 'LOCAL'));
});

test('a late exact match survives a capped settled line pool', async () => {
  const universe = {};
  for (let index = 0; index < 65; index++) {
    const guid = index === 64 ? 'LATE_EXACT' : 'EARLY_' + index;
    universe[guid] = {
      guid, rguid: 'OWNER', type: 'ulist', is_deleted: false, is_trashed: false,
      text_segments: ['text', index === 64 ? 'needle' : 'notes around needle item ' + index],
    };
  }
  const { plugin } = makeHarness({ universe });
  plugin._BLOCK_RESULT_POOL_CAP = 64;
  plugin.data.searchByQuery = async () => ({ records: [], lines: [] });
  plugin._lineAliasByLine = new Map();
  const link = {
    kind: 'line', lineGuid: 'HOST', query: 'needle', token: 0, r5Session: 17,
    results: [], resultsQuery: null, sel: 0, userSelected: false, textCache: new Map(),
  };
  plugin._link = link;
  plugin._renderLink = () => {};

  await plugin._runLinkSearch('needle');
  await link.scanDone;

  assert.equal(link.resultPoolCapped, true);
  assert.ok(link.resultPool.some((row) => row.guid === 'LATE_EXACT'));
  assert.equal(link.resultPool[0].guid, 'LATE_EXACT');
});
