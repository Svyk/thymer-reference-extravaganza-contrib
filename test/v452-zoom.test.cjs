'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function loadPlugin() {
  const storage = new Map();
  const context = {
    AppPlugin: class {},
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    performance: { now: () => Date.now() },
    CSS: { escape: (s) => String(s) },
    navigator: { platform: 'MacIntel', clipboard: {} },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    document: {
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, append() {}, setAttribute() {}, appendChild() {} }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { clientHeight: 900 },
      body: { classList: { add() {}, remove() {}, contains: () => false } },
      head: { appendChild() {} },
    },
    Element: class {},
    window: { CSS: { escape: (s) => String(s) }, g_universe: { itemsByGuid: {}, workspace: {} } },
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  const plugin = new context.PluginUnderTest();
  plugin._unloaded = false;
  plugin._lineConnectionsEnabled = true;
  plugin._lineRefProps = ['Source Line'];
  plugin._autoLineRefs = true;
  plugin._referenceTargetKind = () => 'line';
  plugin.isExistingRecordGuid = (g) => g === 'REC1';
  plugin.data = { getRecord: () => null };
  return { plugin, storage, context };
}

function installFakeDom(context) {
  const makeEl = (tag) => {
    const listeners = {};
    const classes = new Set();
    const el = {
      tagName: String(tag).toUpperCase(),
      textContent: '', title: '', children: [], isConnected: true,
      style: {}, dataset: {}, disabled: false, _listeners: listeners,
      parentElement: null,
      previousElementSibling: null,
      scrollTop: 0,
      clientHeight: 300,
      offsetTop: 0,
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force) {
          if (force === undefined) force = !classes.has(name);
          if (force) classes.add(name); else classes.delete(name);
          return force;
        },
      },
      appendChild(child) {
        child.parentElement = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
        return child;
      },
      append(...children) { for (const child of children) this.appendChild(child); },
      insertBefore(child, before) {
        const index = this.children.indexOf(before);
        if (index < 0) return this.appendChild(child);
        this.children.splice(index, 0, child);
        child.parentElement = this;
        child.isConnected = this.isConnected;
        if (index > 0) {
          const prev = this.children[index - 1];
          prev.nextElementSibling = child;
          child.previousElementSibling = prev;
        }
        if (before) {
          child.nextElementSibling = before;
          before.previousElementSibling = child;
        }
        return child;
      },
      addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
      removeEventListener(type, fn) {
        const list = listeners[type];
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      setAttribute(name, value) { this[name] = String(value); },
      getAttribute(name) { return this[name] ?? null; },
      dispatchEvent(ev) {
        ev.target = ev.target || this;
        let node = this;
        while (node) {
          const list = node._listeners?.[ev.type] || [];
          for (const fn of list.slice()) fn(ev);
          if (ev.cancelBubble) break;
          node = node.parentElement;
        }
        return true;
      },
      closest(selector) {
        let node = this;
        const wanted = selector.startsWith('.') ? selector.slice(1).split(/[\s\[:]/)[0] : '';
        while (node) {
          if (wanted && node.classList?.contains(wanted)) return node;
          node = node.parentElement;
        }
        return null;
      },
      querySelector(selector) {
        const scoped = selector.startsWith(':scope > ');
        const rest = scoped ? selector.slice(9) : selector;
        const attrMatch = rest.match(/^\[data-guid="([^"]+)"\]$/);
        const roots = scoped ? this.children : walkAll(this);
        for (const node of roots) {
          if (attrMatch && node.dataset?.guid === attrMatch[1]) return node;
          const hit = matchSelector(node, rest);
          if (hit) return hit;
        }
        return null;
      },
      querySelectorAll(selector) {
        const wanted = selector.startsWith('.') ? selector.slice(1).split(/[\s\[:]/)[0] : '';
        const out = [];
        const walk = (node) => {
          for (const child of node.children || []) {
            if (wanted && child.classList?.contains(wanted)) out.push(child);
            walk(child);
          }
        };
        walk(this);
        return out;
      },
      remove() {
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        }
        this.parentElement = null;
        this.isConnected = false;
      },
    };
    Object.defineProperty(el, 'className', {
      get: () => [...classes].join(' '),
      set: (value) => {
        classes.clear();
        String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
      },
    });
    return el;
  };

  function walkAll(node, out = []) {
    for (const child of node.children || []) {
      out.push(child);
      walkAll(child, out);
    }
    return out;
  }

  function matchSelector(node, selector) {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1).split(/[\s.#\[]/)[0];
      return node.classList?.contains(cls) ? node : null;
    }
    return null;
  }

  context.document.createElement = makeEl;
  return makeEl;
}

function fixtureTree() {
  return [{
    guid: 'A',
    parent_guid: 'PAGE',
    segments: [{ type: 'text', text: 'a' }],
    children: [{
      guid: 'B',
      parent_guid: 'A',
      segments: [{ type: 'text', text: 'b' }],
      children: [{
        guid: 'REF',
        parent_guid: 'B',
        segments: [{ type: 'text', text: 'ref line' }],
        children: [],
      }],
    }],
  }];
}

function setupRowPlugin() {
  const { plugin, context } = loadPlugin();
  const makeEl = installFakeDom(context);
  plugin._el = (tag, cls, text) => {
    const el = makeEl(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  plugin._cleanDisplayText = (segs) => (segs || []).map((s) => s.text || '').join('');
  plugin._navigatorContextText = (line) => plugin._cleanDisplayText(line.segments || []);
  plugin._mediaLineInfo = () => null;
  plugin._isTaskLikeLine = () => false;
  plugin._renderPreviewLineItem = (el, line) => { el.textContent = plugin._cleanDisplayText(line.segments || []); };
  plugin._mkRefRowAction = (label, title, fn) => {
    const btn = makeEl('button');
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    return btn;
  };
  plugin._refRowClipboardActions = () => [];
  plugin._isLineRefTarget = (g) => g !== 'REC1';
  plugin._isPureSelfRef = () => false;
  plugin._hydrateColdRefLineText = () => {};
  plugin._relativeTime = (d) => d ? { rel: '2d', absShort: 'Sep 7', abs: 'Sep 7, 2026' } : null;
  plugin._lineCreatedAt = (line) => line?.createdAt || null;
  plugin.getOrLoadRecordName = (g) => (g === 'PAGE' ? 'page' : g);
  plugin._recordNameIndex = new Map([['PAGE', 'page']]);
  plugin._bridgeJump = () => Promise.resolve(true);
  plugin._bridgeCreateEmbed = () => Promise.resolve(true);
  plugin._pageGuidFromDom = () => 'PAGE';
  plugin._resolveRefTargetText = () => 'target text';
  plugin.data = { getRecord: () => null };
  return { plugin, makeEl, context };
}

function crumbTexts(crumbEl) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.classList?.contains('trc-ref-popover-crumb-rec') || child.classList?.contains('trc-ref-popover-crumb-parent')) {
        if (child.textContent) out.push(child.textContent);
      }
      if (child.classList?.contains('trc-ref-crumb-anc')) walk(child);
    }
  };
  walk(crumbEl);
  return out;
}

test('WO-5 _zoomRefRow renders zoom header, target highlight, and scroll', async () => {
  const { plugin } = setupRowPlugin();

  const tree = plugin._refContextTree(fixtureTree());
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'ref line' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [], onCrumbJump: () => {} });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false, targetGuid: 'REF' };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);

  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'B' });
  assert.deepEqual(crumbTexts(row.crumbEl), ['page', 'a', 'b']);
  assert.ok([...crumbTexts(row.crumbEl)].pop() === 'b');
  assert.ok(row.childBox.classList.contains('refx-zoom-body'));
  assert.ok(row.childBox.querySelector('.refx-zoom-target'));
  assert.ok(row.rowEl.querySelector('.trc-ref-popover-fulltext').classList.contains('refx-hidden'));
});

test('WO-5 page zoom renders all roots', async () => {
  const { plugin } = setupRowPlugin();

  const items = [
    { guid: 'R1', parent_guid: 'PAGE', segments: [{ type: 'text', text: 'one' }], children: [] },
    { guid: 'R2', parent_guid: 'PAGE', segments: [{ type: 'text', text: 'two' }], children: [] },
  ];
  const tree = plugin._refContextTree(items);
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'x' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [] });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: null });
  assert.equal(row.childBox.querySelectorAll('.refx-wb-tree-text').length, 2);
  assert.ok(row.crumbEl.querySelector('.trc-ref-popover-crumb-rec.trc-ref-crumb-root'));
});

test('WO-5 back and reset zoom actions restore reference view', async () => {
  const { plugin } = setupRowPlugin();

  const tree = plugin._refContextTree(fixtureTree());
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'ref line' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [] });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false, targetGuid: 'REF' };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'A' });
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'B' });
  assert.equal(row.rowEl.__refxZoom.stack.length, 1);
  await plugin._zoomRefRow(row.rowEl, ctx, row.rowEl.__refxZoom.stack.pop(), { push: false });
  assert.equal(row.rowEl.__refxZoom.view.rootGuid, 'A');
  await plugin._renderRefRowReferenceView(ctx, line, row.rowEl);
  assert.equal(row.rowEl.__refxZoom.view, null);
  assert.ok(!row.childBox.classList.contains('refx-zoom-body'));
  assert.ok(!row.rowEl.querySelector('.trc-ref-popover-fulltext').classList.contains('refx-hidden'));
  assert.deepEqual(crumbTexts(row.crumbEl), ['page', 'a', 'b']);
});

test('WO-5 crumb and dot clicks zoom; modifier keys jump', async () => {
  const { plugin } = setupRowPlugin();

  const jumps = [];
  const bridge = [];
  plugin._bridgeJump = (g, opts) => { bridge.push({ g, opts }); return Promise.resolve(true); };
  plugin.ctxOnJump = (g) => jumps.push(g);

  const tree = plugin._refContextTree(fixtureTree());
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'ref line' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [], onCrumbJump: (g) => jumps.push('crumb:' + g) });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump: (g) => plugin.ctxOnJump(g), canEdit: false };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);

  const ancWrap = row.crumbEl.children.find((c) => c.classList?.contains('trc-ref-crumb-anc'));
  const anc = ancWrap?.children?.find((c) => c.classList?.contains('trc-ref-popover-crumb-parent'));
  assert.ok(anc, 'ancestor crumb renders');

  anc.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {}, shiftKey: true, metaKey: false, ctrlKey: false, target: anc });
  assert.equal(bridge.at(-1)?.g, anc.dataset.guid);
  assert.equal(bridge.at(-1)?.opts?.newPanel, true);

  anc.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {}, shiftKey: false, metaKey: true, ctrlKey: false, target: anc });
  assert.equal(jumps.at(-1), anc.dataset.guid);

  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: anc.dataset.guid });
  assert.equal(row.rowEl.__refxZoom.view.rootGuid, anc.dataset.guid);

  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'B' });
  const dot = row.childBox.querySelector('.refx-wb-tree-dot');
  assert.ok(dot, 'leaf line exposes zoom dot');
  const lineEl = dot.parentElement;
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: lineEl.dataset.guid });
  assert.equal(row.rowEl.__refxZoom.view.rootGuid, lineEl.dataset.guid);
});

test('WO-5 _buildRefChildTree defaults unchanged and sync-only', () => {
  const start = source.indexOf('_buildRefChildTree(target, ctx, opts = {}) {');
  const end = source.indexOf('\n  _beginTreeLineEdit(ctx, lineEl, txtEl, c)', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(block, /setTimeout|setInterval|MutationObserver|getLineItems/);
  assert.match(block, /maxDepth = opts\.maxDepth == null \? 5 : opts\.maxDepth/);
  assert.match(block, /maxNodes = opts\.maxNodes == null \? 200 : opts\.maxNodes/);
});

test('WO-5 home row first for line targets, absent for records, never deferred', async () => {
  const { plugin, makeEl } = setupRowPlugin();

  const tree = plugin._refContextTree([{
    guid: 'TGT', parent_guid: 'PAGE', segments: [{ type: 'text', text: 'target' }], children: [],
  }]);
  plugin.data = {
    getRecord: (g) => g === 'PAGE' ? { getLineItems: async () => tree.roots } : null,
  };
  plugin._lineOwnerHints = new Map([['TGT', 'PAGE']]);

  const container = makeEl('div');
  const ctx = {
    alive: () => true,
    onJump() {},
    treeCache: new Map(),
    canEdit: false,
    targetGuid: 'TGT',
  };
  const ok = await plugin._appendRefHomeRow(container, 'TGT', ctx);
  assert.ok(ok);
  assert.ok(container.querySelector('.refx-row-home'));
  assert.equal(container.querySelector('.refx-ref-context-load'), null);

  const recContainer = makeEl('div');
  const recOk = await plugin._appendRefHomeRow(recContainer, 'REC1', ctx);
  assert.equal(recOk, false);
  assert.equal(recContainer.querySelector('.refx-row-home'), null);

  const withRefs = makeEl('div');
  await plugin._appendRefHomeRow(withRefs, 'TGT', ctx);
  plugin._appendRefHomeSep(withRefs);
  assert.ok(withRefs.querySelector('.refx-home-sep'));
});

test('WO-5 stamp removed from actions; twisty title uses Created', async () => {
  const { plugin } = setupRowPlugin();

  const createdAt = new Date('2026-09-01T12:00:00Z');
  const line = {
    guid: 'L1',
    record: { guid: 'PAGE' },
    segments: [{ type: 'text', text: 'hello' }],
    createdAt,
  };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [] });
  assert.equal(row.actionsEl.querySelector('.trc-ref-timestamp'), null);

  const tree = plugin._refContextTree([{ guid: 'L1', parent_guid: 'PAGE', segments: line.segments, children: [] }]);
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);
  const fold = row.crumbEl.querySelector('.refx-ref-rowfold');
  assert.ok(fold);
  assert.match(fold.title, /^Created /);
});

test('WO-7 widget hint when zoom root carries #nautilus', async () => {
  const { plugin } = setupRowPlugin();

  const tree = plugin._refContextTree([{
    guid: 'WIDGET',
    parent_guid: 'PAGE',
    segments: [{ type: 'hashtag', text: 'nautilus' }, { type: 'text', text: ' chart' }],
    children: [],
  }]);
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'ref' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [] });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false, hostLineGuid: 'HOST1' };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'WIDGET' });
  assert.ok(row.rowEl.querySelector(':scope > .refx-zoom-hint'));
  assert.equal(row.childBox.querySelector('.refx-zoom-hint'), null);
  const hint = row.rowEl.querySelector(':scope > .refx-zoom-hint');
  const hintBtn = hint?.children?.find((c) => c.tagName === 'BUTTON');
  assert.ok(hintBtn);
  assert.equal(hintBtn.textContent, '⤓');
  assert.equal(hintBtn.title, 'Open live below');
});

test('WO-7 widget hint absent for plain text zoom root', async () => {
  const { plugin } = setupRowPlugin();

  const tree = plugin._refContextTree(fixtureTree());
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'ref line' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [] });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false, hostLineGuid: 'HOST1' };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'B' });
  assert.equal(row.childBox.querySelector('.refx-zoom-hint'), null);
});

test('WO-7 live action calls _bridgeCreateEmbed with host line', async () => {
  const { plugin } = setupRowPlugin();
  const embeds = [];
  plugin._bridgeCreateEmbed = (host, target) => { embeds.push({ host, target }); return Promise.resolve(true); };

  const tree = plugin._refContextTree([{
    guid: 'WIDGET',
    parent_guid: 'PAGE',
    segments: [{ type: 'hashtag', text: '#TimeBlock' }],
    children: [],
  }]);
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'ref' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [] });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false, hostLineGuid: 'HOST1' };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'WIDGET' });

  const liveBtn = row.actionsEl.__refxZoomLive || row.actionsEl.children.find((c) => c.classList?.contains('refx-zoom-live'));
  assert.ok(liveBtn, 'live zoom action renders');
  assert.equal(liveBtn.textContent, '⤓');
  liveBtn.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(embeds, [{ host: 'HOST1', target: 'WIDGET' }]);
});

test('WO-7 popover live action calls _bridgeJump in side panel', async () => {
  const { plugin } = setupRowPlugin();
  const jumps = [];
  plugin._bridgeJump = (g, opts) => { jumps.push({ g, opts }); return Promise.resolve(true); };

  const tree = plugin._refContextTree([{
    guid: 'WIDGET',
    parent_guid: 'PAGE',
    segments: [{ type: 'hashtag', text: 'nautilus' }],
    children: [],
  }]);
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'ref' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [] });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'WIDGET' });

  const liveBtn = row.actionsEl.__refxZoomLive;
  assert.ok(liveBtn);
  assert.equal(liveBtn.textContent, '◧');
  liveBtn.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
  assert.equal(jumps.at(-1)?.g, 'WIDGET');
  assert.equal(jumps.at(-1)?.opts?.newPanel, true);
});

test('WO-8 plain zoom exposes open-live action with host', async () => {
  const { plugin } = setupRowPlugin();

  const tree = plugin._refContextTree(fixtureTree());
  const line = { guid: 'REF', record: { guid: 'PAGE' }, segments: [{ type: 'text', text: 'ref line' }] };
  const row = plugin._buildRefContextRow(line, { showRecordCrumb: true, tag: 'div', actions: [] });
  const ctx = { alive: () => true, treeCache: new Map([['PAGE', Promise.resolve(tree)]]), onJump() {}, canEdit: false, hostLineGuid: 'HOST1' };
  await plugin._fillRefContextRow(ctx, line, row.crumbEl, row.childBox);
  await plugin._zoomRefRow(row.rowEl, ctx, { sourceGuid: 'PAGE', rootGuid: 'B' });

  const liveBtn = row.actionsEl.__refxZoomLive;
  assert.ok(liveBtn);
  assert.equal(liveBtn.textContent, '⤓');
  assert.equal(liveBtn.title, 'Open live below');
});

test('WO-8 _buildRefHomeLine returns empty segments when unresolved', () => {
  const { plugin } = setupRowPlugin();
  plugin._resolveRefTargetText = () => '';

  const home = plugin._buildRefHomeLine('TGT');
  assert.equal(home.segments.length, 0);

  const row = plugin._buildRefContextRow(home, { showRecordCrumb: true, tag: 'div', actions: [] });
  assert.equal(row.fullEl.dataset.refxTextPending, '1');
});

test('WO-8 _zoomRefRow passes maxNodes 1500', () => {
  const start = source.indexOf('async _zoomRefRow(row, ctx, view, { push = true } = {}) {');
  const end = source.indexOf('async _renderRefRowReferenceView(ctx, line, row) {', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /maxNodes:\s*1500/);
  assert.match(block, /maxDepth:\s*12/);
});

test('WO-7 media child renders preview card in zoom tree', () => {
  const { plugin } = setupRowPlugin();
  let sawCompact = false;
  plugin._mediaLineInfo = (line) => (line?.guid === 'IMG1' ? { kind: 'image', label: 'photo.png' } : null);
  plugin._renderPreviewLineItem = (el, line, opts) => {
    if (opts?.compact) sawCompact = true;
    if (plugin._mediaLineInfo(line)) {
      el.classList.add('refx-preview-media-line', 'is-image');
      el.textContent = line.guid;
    } else {
      el.textContent = plugin._cleanDisplayText(line.segments || []);
    }
  };

  const target = {
    guid: 'ROOT',
    children: [{ guid: 'IMG1', segments: [], children: [] }],
  };
  const ctx = { alive: () => true, onJump() {}, canEdit: false };
  const box = plugin._buildRefChildTree(target, ctx);
  assert.ok(sawCompact);
  assert.ok(box.querySelector('.refx-preview-media-line'));
});
