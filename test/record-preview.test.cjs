const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

function instance(options = {}) {
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const documentListeners = new Map();
  class FakeCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  const context = {
    AppPlugin: class {}, console, Promise, Date, Math, Map, Set, WeakMap, WeakSet,
    CustomEvent: FakeCustomEvent,
    setTimeout: setTimer, clearTimeout: clearTimer,
    requestAnimationFrame: (fn) => setTimer(fn, 0), cancelAnimationFrame: clearTimer,
    performance: { now: () => Date.now() },
    CSS: { escape: (s) => String(s) },
    navigator: { platform: 'MacIntel', clipboard: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => fakeNode(),
      addEventListener(type, fn) { const list = documentListeners.get(type) || []; list.push(fn); documentListeners.set(type, list); },
      removeEventListener(type, fn) { documentListeners.set(type, (documentListeners.get(type) || []).filter((item) => item !== fn)); },
      dispatchEvent(event) { for (const fn of documentListeners.get(event.type) || []) fn(event); return true; },
      getElementsByClassName: () => [],
      documentElement: { clientHeight: 900 },
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      head: { appendChild() {} }
    },
    Element: class {},
    window: {
      CSS: { escape: (s) => String(s) },
      g_universe: { itemsByGuid: {}, workspace: {} }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  const plugin = new context.PluginUnderTest();
  plugin._unloaded = false;
  plugin._breadcrumbsEnabled = false;
  plugin._toast = () => {};
  plugin._unfoldHostLine = () => {};
  return { plugin, context };
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn) { const id = nextId++; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    size() { return pending.size; },
    flush() {
      let turns = 0;
      while (pending.size) {
        if (++turns > 100) throw new Error('timer retry loop did not settle');
        const jobs = [...pending.entries()];
        pending.clear();
        for (const [, fn] of jobs) fn();
      }
    }
  };
}

function hostBlock() {
  return {
    guid: 'HOST_LINE',
    props: {},
    segments: [{ type: 'ref', text: { guid: 'TARGET_RECORD' } }],
    children: [],
    async setMetaProperty(key, value) {
      if (value == null) delete this.props[key]; else this.props[key] = value;
      return true;
    }
  };
}

function fakeNode(className = '', textContent = '') {
  const listeners = new Map();
  const classes = new Set(String(className || '').split(/\s+/).filter(Boolean));
  const node = {
    className, textContent, dataset: {}, style: {}, hidden: false, isConnected: true,
    children: [], parentElement: null, offsetParent: {}, listeners,
    classList: {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, force) { if (force === undefined) force = !classes.has(name); if (force) classes.add(name); else classes.delete(name); return force; }
    },
    setAttribute() {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    append(...items) {
      for (const item of items) {
        if (item.parentElement) item.parentElement.children = item.parentElement.children.filter((child) => child !== item);
        item.parentElement = node;
        node.children.push(item);
      }
    },
    appendChild(item) { node.append(item); return item; },
    insertBefore(item, before) {
      if (item.parentElement) item.parentElement.children = item.parentElement.children.filter((child) => child !== item);
      item.parentElement = node;
      const index = before ? node.children.indexOf(before) : -1;
      if (index < 0) node.children.push(item); else node.children.splice(index, 0, item);
      return item;
    },
    remove() {
      node.isConnected = false;
      if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((item) => item !== node);
      node.parentElement = null;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const wanted = selector.startsWith('.') ? selector.slice(1) : selector;
      const out = [];
      const walk = (parent) => {
        for (const child of parent.children || []) {
          const own = new Set(String(child.className || '').split(/\s+/).filter(Boolean));
          if (own.has(wanted)) out.push(child);
          walk(child);
        }
      };
      walk(node);
      return out;
    }
  };
  Object.defineProperty(node, 'parentNode', { get: () => node.parentElement });
  Object.defineProperty(node, 'nextSibling', {
    get: () => {
      if (!node.parentElement) return null;
      const index = node.parentElement.children.indexOf(node);
      return index >= 0 ? (node.parentElement.children[index + 1] || null) : null;
    }
  });
  return node;
}

function previewShell() {
  const shell = fakeNode('refx-record-preview-shell');
  const actions = fakeNode('refx-record-preview-actions');
  const hint = fakeNode('refx-record-preview-hint', 'Lightweight record preview');
  const open = fakeNode('refx-record-preview-action', 'Open record ↗');
  const load = fakeNode('refx-record-preview-action refx-record-preview-load', 'Load full body');
  actions.append(hint, open, load);
  shell.append(actions);
  return { shell, actions, load };
}

function clickEvent() {
  return { type: 'click', preventDefault() {}, stopPropagation() {} };
}

test('image line previews paint synchronously and do no blob work until explicitly settled', async () => {
  const { plugin } = instance();
  const container = fakeNode('preview-line');
  let blobRequests = 0;
  plugin._queueInlineMediaAsset = async () => {
    blobRequests++;
    return { kind: 'image', url: 'blob:preview-image', fileName: 'diagram.png' };
  };
  const line = {
    guid: 'IMAGE_LINE', type: 'image', props: { fileName: 'diagram.png', fileSize: 2048 },
    async getBlob() { throw new Error('renderer must use the lazy queue'); },
  };

  const rendered = plugin._renderPreviewLineItem(container, line, { autoLoadImage: false });
  assert.equal(rendered.media, true);
  assert.equal(rendered.kind, 'image');
  assert.equal(blobRequests, 0, 'painting the reference chip preview downloads nothing');
  const buttons = container.querySelectorAll('.refx-preview-media-action');
  assert.equal(buttons[0].textContent, 'Show image');
  buttons[0].listeners.get('click')(clickEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blobRequests, 1);
  assert.equal(container.querySelectorAll('.refx-preview-media-image').length, 1);
});

test('v4.37.0 compact media cards expose one filename surface and no controls', () => {
  const { plugin } = instance();
  const container = fakeNode('picker-media');
  const rendered = plugin._renderPreviewLineItem(container, {
    guid: 'PICKER_IMAGE',
    type: 'image',
    props: { filename: 'pasted-quality.png', fileguid: 'FILE_PICKER' },
  }, {
    compact: true,
    controls: false,
    autoLoadImage: false,
    resolveLine: async () => null,
  });

  assert.equal(rendered.media, true);
  const card = container.querySelectorAll('.refx-preview-media-card')[0];
  assert.match(card.className, /\brefx-preview-media-card-compact\b/);
  assert.equal(container.querySelectorAll('.refx-preview-media-name')[0].textContent, 'pasted-quality.png');
  assert.equal(container.querySelectorAll('.refx-preview-media-action').length, 0);
});

test('v4.37.0 picker close retires its borrowed inline-media URL immediately', () => {
  const { plugin } = instance();
  const link = {
    pickerMediaUrls: new Set(['blob:picker-image']),
    pickerMediaRetiredUrls: new Set(),
    pickerMediaReleaseTimer: 0,
  };
  let revoked = false;
  plugin._inlineMediaUrlActive = () => false;
  plugin._dropInlineMediaCache = (predicate) => {
    revoked = predicate({ url: 'blob:picker-image' });
    return revoked ? 1 : 0;
  };

  plugin._retirePickerMedia(link, true);

  assert.equal(revoked, true);
  assert.equal(link.pickerMediaUrls.size, 0);
  assert.equal(link.pickerMediaRetiredUrls.size, 0);
});

test('v4.37.0 every drill-outline role can render bounded compact media', () => {
  assert.doesNotMatch(source, /role === ['"]target['"]\s*&&\s*this\._mediaLineInfo/);
  assert.match(source, /source \|\| itemMap\[item\?\.guid\] \|\| null/);
  assert.match(source, /options\.renderMedia \? this\._mediaLineInfo\(mediaSource\) : null/);
  assert.match(source, /const compact = role !== ['"]target['"]/);
  assert.match(source, /automaticOutlineImages\+\+ < 3/);
  assert.match(source, /\.refx-preview-outline-row \.refx-preview-media-card-compact/);
});

test('PDF line previews remain metadata-only until the keyboard/click Preview PDF action', async () => {
  const { plugin } = instance();
  const container = fakeNode('preview-line');
  let blobRequests = 0;
  plugin._queueInlineMediaAsset = async () => {
    blobRequests++;
    return { kind: 'pdf', url: 'blob:preview-pdf', fileName: 'evidence.pdf' };
  };
  const line = {
    guid: 'PDF_LINE', type: 'file', props: { filename: 'evidence.pdf' },
    async getBlob() { throw new Error('renderer must use the lazy queue'); },
  };

  plugin._renderPreviewLineItem(container, line, { autoLoadImage: false });
  assert.equal(blobRequests, 0);
  const preview = container.querySelectorAll('.refx-preview-media-action')[0];
  assert.equal(preview.textContent, 'Preview PDF');
  preview.listeners.get('click')(clickEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blobRequests, 1);
  assert.equal(container.querySelectorAll('.refx-preview-media-pdf').length, 1);
});

test('exceptional-outline media resolves its exact native line only after explicit Preview', async () => {
  const { plugin } = instance();
  const container = fakeNode('preview-line');
  let resolves = 0;
  let queued = 0;
  const nativeLine = {
    guid: 'WINDOWED_PDF', type: 'file', props: { fileName: 'large-outline.pdf' },
    async getBlob() { throw new Error('renderer must use the bounded media lane'); },
  };
  plugin._queueInlineMediaAsset = async (line) => {
    queued++;
    assert.equal(line, nativeLine);
    return { kind: 'pdf', url: 'blob:windowed-pdf', fileName: 'large-outline.pdf' };
  };
  const receiptOnly = {
    guid: 'WINDOWED_PDF', type: 'file',
    props: { fileName: 'large-outline.pdf', fileGuid: 'FILE_WINDOWED' },
  };

  plugin._renderPreviewLineItem(container, receiptOnly, {
    autoLoadImage: false,
    resolveLine: async () => { resolves++; return nativeLine; },
  });
  assert.equal(resolves, 0, 'instant shell paint performs no line or blob resolution');
  assert.equal(queued, 0);
  const preview = container.querySelectorAll('.refx-preview-media-action')[0];
  assert.equal(preview.textContent, 'Preview PDF');
  preview.listeners.get('click')(clickEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolves, 1);
  assert.equal(queued, 1);
  assert.equal(container.querySelectorAll('.refx-preview-media-pdf').length, 1);
});

test('attachment deletion fences an in-flight exceptional-outline resolver and retires its card', async () => {
  const { plugin, context } = instance();
  const container = fakeNode('preview-line');
  let releaseResolve = null;
  let queued = 0;
  const nativeLine = {
    guid: 'WINDOWED_DELETE', type: 'file', props: { fileName: 'deleted.pdf' },
    async getBlob() { return null; },
  };
  plugin._queueInlineMediaAsset = async () => { queued++; return { kind: 'pdf', url: 'blob:deleted' }; };
  plugin._renderPreviewLineItem(container, {
    guid: 'WINDOWED_DELETE', type: 'file', props: { fileName: 'deleted.pdf' },
  }, {
    autoLoadImage: false,
    resolveLine: () => new Promise((resolve) => { releaseResolve = resolve; }),
  });
  const card = container.querySelectorAll('.refx-preview-media-card')[0];
  context.document.querySelectorAll = (selector) => selector.includes('data-refx-media-line') ? [card] : [];
  const preview = container.querySelectorAll('.refx-preview-media-action')[0];
  preview.listeners.get('click')(clickEvent());
  while (!releaseResolve) await Promise.resolve();
  plugin.handleLineItemDeleted({ lineItemGuid: 'WINDOWED_DELETE' });
  releaseResolve(nativeLine);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(queued, 0, 'deleted media never reaches the blob lane');
  assert.equal(container.querySelectorAll('.refx-preview-media-pdf').length, 0);
  assert.equal(card.classList.contains('is-unavailable'), true);
  assert.equal(preview.disabled, true);
  assert.equal(preview.textContent, 'Attachment removed');
});

test('paged exceptional-outline receipts never reuse a weak media handle after deletion', async () => {
  const { plugin } = instance();
  const staleLine = {
    guid: 'WINDOWED_STALE_PAGE', type: 'image', props: { fileName: 'stale.png' },
    record: { guid: 'OWNER_STALE_PAGE' }, async getBlob() { return null; },
  };
  const descriptor = plugin._targetPreviewDescriptor(staleLine, 0);
  plugin._invalidateInlineMedia({ lineGuid: staleLine.guid, force: true });
  let authoritativeReads = 0;
  plugin.data = {
    getRecord: (guid) => guid === 'OWNER_STALE_PAGE' ? {
      async getLineItems() { authoritativeReads++; return []; },
    } : null,
  };
  const entry = { targetGuid: 'TARGET_STALE_PAGE', shell: { isConnected: true }, cancelled: false };

  assert.equal(await plugin._resolveWindowedMediaLine(entry, descriptor), null);
  assert.equal(authoritativeReads, 1, 'stale receipt is checked against native owner state instead of its old handle');
});

test('inline media resolver accepts bounded local PDF blobs, rejects oversized files, and revokes on unload', async () => {
  const { plugin, context } = instance();
  const revoked = [];
  let nextUrl = 0;
  context.URL = {
    createObjectURL: () => 'blob:inline-' + (++nextUrl),
    revokeObjectURL: (url) => revoked.push(url),
  };
  context.Blob = class FakeBlob { constructor(parts, options) { this.parts = parts; this.type = options?.type; } };
  plugin._initInlineMediaRuntime();
  let boundedDownloads = 0;
  const bounded = {
    guid: 'PDF_BOUNDED', type: 'file', props: { fileName: 'audit.pdf' },
    async getBlob() {
      return {
        fileName: 'audit.pdf', contentType: 'application/pdf', fileSize: 3,
        async download() { boundedDownloads++; return new Uint8Array([1, 2, 3]).buffer; },
      };
    },
  };
  let oversizedDownloads = 0;
  const oversized = {
    guid: 'PDF_TOO_LARGE', type: 'file', props: { fileName: 'huge.pdf' },
    async getBlob() {
      return {
        fileName: 'huge.pdf', contentType: 'application/pdf', fileSize: 26 * 1024 * 1024,
        async download() { oversizedDownloads++; return new ArrayBuffer(1); },
      };
    },
  };

  const asset = await plugin._resolveInlineMediaAsset(bounded);
  assert.equal(asset.kind, 'pdf');
  assert.equal(asset.url, 'blob:inline-1');
  assert.equal(boundedDownloads, 1);
  assert.equal(await plugin._resolveInlineMediaAsset(oversized), null);
  assert.equal(oversizedDownloads, 0, 'declared over-limit blobs are rejected before download');

  plugin._disposeInlineMediaRuntime();
  assert.deepEqual(revoked, ['blob:inline-1']);
  assert.equal(plugin._inlineMediaCache.size, 0);
});

test('page and linked-line previews render image/PDF cards without empty bullets', () => {
  const { plugin } = instance();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  plugin._smallBodyLineCap = 40;
  let scheduledImages = 0;
  plugin._scheduleInlineMedia = () => { scheduledImages++; return scheduledImages; };
  const { shell } = previewShell();
  const key = plugin._recordPreviewKey('HOST_MEDIA', 'TARGET_MEDIA');
  const entry = { key, hostLineGuid: 'HOST_MEDIA', targetGuid: 'TARGET_MEDIA', shell };
  plugin._recordPreviews.set(key, entry);
  const image = (index) => ({
    guid: 'IMAGE_' + index, type: 'image', props: { fileName: `image-${index}.png` },
    async getBlob() { throw new Error('paint must remain lazy'); },
  });
  const pdf = {
    guid: 'PDF_CONTEXT', type: 'file', props: { fileName: 'evidence.pdf' }, record: { guid: 'SOURCE' },
    async getBlob() { throw new Error('paint must remain lazy'); },
  };

  plugin._renderRecordPreviewPeek(entry, [image(1), image(2), image(3), image(4), pdf], 5, true);
  const rows = shell.querySelectorAll('.refx-record-preview-peek-line');
  assert.equal(rows.length, 5);
  assert.equal(scheduledImages, 3, 'a page surface settles at most three images automatically');
  assert.ok(rows.every((row) => row.querySelectorAll('.refx-preview-media-card').length === 1));
  assert.ok(rows.every((row) => row.querySelectorAll('.refx-record-preview-peek-bullet')[0].textContent === ''));
  assert.equal(rows[4].querySelectorAll('.refx-preview-media-action')[0].textContent, 'Preview PDF');

  const contextRow = plugin._buildRefContextRow(pdf, { actions: [] });
  assert.equal(contextRow.fullEl.querySelectorAll('.refx-preview-media-card').length, 1);
  assert.equal(contextRow.fullEl.querySelectorAll('.refx-ref-line-loading').length, 0, 'media line context is never a fake empty/loading text row');
});

test('inline media disposal fences a late unabortable download before URL creation', async () => {
  const { plugin, context } = instance();
  const made = [];
  context.URL = { createObjectURL: () => { const url = 'blob:late'; made.push(url); return url; }, revokeObjectURL() {} };
  context.Blob = class FakeBlob {};
  plugin._initInlineMediaRuntime();
  let releaseDownload = null;
  let downloadStarted = false;
  const line = {
    guid: 'LATE_IMAGE', type: 'image', props: { fileName: 'late.png' },
    async getBlob() {
      return {
        fileName: 'late.png', contentType: 'image/png', fileSize: 4,
        download() { downloadStarted = true; return new Promise((resolve) => { releaseDownload = resolve; }); },
      };
    },
  };
  const pending = plugin._resolveInlineMediaAsset(line);
  while (!downloadStarted) await Promise.resolve();
  context.window.__refxInlineMediaDispose();
  releaseDownload({ byteLength: 4 });
  assert.equal(await pending, null);
  assert.deepEqual(made, [], 'a stale hot-reloaded instance cannot create a late object URL');
});

test('inline media queue never overlaps backend asset work', async () => {
  const { plugin } = instance();
  const releases = new Map();
  const started = [];
  plugin._resolveInlineMediaAsset = (line) => {
    started.push(line.guid);
    return new Promise((resolve) => releases.set(line.guid, resolve));
  };
  const first = plugin._queueInlineMediaAsset({ guid: 'FIRST' });
  const second = plugin._queueInlineMediaAsset({ guid: 'SECOND' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started.join(','), 'FIRST');
  releases.get('FIRST')({ guid: 'FIRST' });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.join(','), 'FIRST,SECOND');
  releases.get('SECOND')({ guid: 'SECOND' });
  await second;
});

test('byte-bound media cache never evicts an object URL still mounted in a preview', async () => {
  const { plugin, context } = instance();
  const revoked = [];
  let nextUrl = 0;
  context.URL = {
    createObjectURL: () => 'blob:pinned-' + (++nextUrl),
    revokeObjectURL: (url) => revoked.push(url),
  };
  context.Blob = class FakeBlob {};
  plugin._initInlineMediaRuntime();
  const pdfLine = (guid) => ({
    guid, type: 'file', props: { fileName: guid + '.pdf' },
    async getBlob() {
      return {
        fileName: guid + '.pdf', contentType: 'application/pdf', fileSize: 25 * 1024 * 1024,
        async download() { return { byteLength: 25 * 1024 * 1024 }; },
      };
    },
  });
  const first = await plugin._resolveInlineMediaAsset(pdfLine('FIRST_PINNED'));
  assert.equal(first.url, 'blob:pinned-1');
  context.document.querySelectorAll = (selector) => selector.includes('refx-preview-media')
    ? [{ data: first.url, isConnected: true }]
    : [];
  assert.equal(await plugin._resolveInlineMediaAsset(pdfLine('SECOND_DECLINED')), null);
  assert.deepEqual(revoked, [], 'visible media remains valid when the cache has no inactive eviction candidate');
  assert.equal(nextUrl, 1, 'declined media does not allocate an untracked URL');
});

test('preview meta merges multiple record targets and removes only the selected target', async () => {
  const { plugin } = instance();
  const block = hostBlock();
  assert.equal(await plugin._writeRecordPreviewMeta(block, 'A', true), true);
  assert.equal(await plugin._writeRecordPreviewMeta(block, 'B', true), true);
  assert.deepEqual([...plugin._recordPreviewTargets(block)], ['A', 'B']);
  assert.equal(await plugin._writeRecordPreviewMeta(block, 'A', false), true);
  assert.deepEqual([...plugin._recordPreviewTargets(block)], ['B']);
});

test('record expansion persists a preview without creating or reading the target body', async () => {
  const { plugin } = instance();
  const block = hostBlock();
  let nativeCreates = 0;
  let targetBodyReads = 0;
  const sourceRecord = {
    async getLineItems() { return [block]; },
    async createLineItem() { nativeCreates++; return null; }
  };
  const targetRecord = { async getLineItems() { targetBodyReads++; return []; } };
  plugin.data = { getRecord: (guid) => guid === 'SOURCE_RECORD' ? sourceRecord : guid === 'TARGET_RECORD' ? targetRecord : null };
  let mounted = null;
  plugin._mountRecordPreview = (key) => { mounted = key; return true; };

  const ok = await plugin._expandRef(
    { pageGuid: 'SOURCE_RECORD', lineGuid: 'HOST_LINE' },
    { targetGuid: 'TARGET_RECORD', isText: false }
  );

  assert.equal(ok, true);
  assert.equal(nativeCreates, 0);
  assert.equal(targetBodyReads, 0);
  assert.equal(block.props.refx_record_previews_v1, 'TARGET_RECORD');
  assert.equal(mounted, 'rp:HOST_LINE:TARGET_RECORD');
  assert.equal(plugin._recordPreviews.has(mounted), true);
});

test('direct Cmd+Down record expansion resolves a Journal host through its open panel', async () => {
  const { plugin, context } = instance();
  const block = hostBlock();
  const journalGuid = 'S-JOURNAL-COL-USER-0-20260717';
  const journalRecord = { guid: 'REAL_JOURNAL_RECORD', async getLineItems() { return [block]; } };
  context.window.g_universe.itemsByGuid.HOST_LINE = { guid: 'HOST_LINE', rguid: journalGuid };
  plugin.ui = {
    getPanels: () => [{ getActiveRecord: () => journalRecord }],
    getActivePanel: () => ({ getActiveRecord: () => journalRecord }),
  };
  plugin.data = {
    getRecord: (guid) => guid === 'TARGET_RECORD' ? { guid: 'TARGET_RECORD' } : null,
  };
  plugin._mountRecordPreview = () => true;

  const ok = await plugin._expandRef(
    { pageGuid: journalGuid, lineGuid: 'HOST_LINE' },
    { targetGuid: 'TARGET_RECORD', isText: false }
  );

  assert.equal(ok, true);
  assert.equal(block.props.refx_record_previews_v1, 'TARGET_RECORD');
  assert.equal(plugin._recordPreviews.has('rp:HOST_LINE:TARGET_RECORD'), true);
});

test('line references retain the native transclusion path and dispatch embed-mounted after DOM mount', async () => {
  const { plugin, context } = instance();
  const block = hostBlock();
  block.segments = [{ type: 'ref', text: { guid: 'TARGET_LINE' } }];
  let nativeCreates = 0;
  const nativeNode = fakeNode('listitem listitem-transclusion');
  const container = fakeNode('transclusion-container-div');
  nativeNode.append(container);
  const mounted = [];
  context.document.addEventListener('refx:embed-mounted', (event) => mounted.push(event.detail));
  let created = false;
  const liveLine = {
    guid: 'EMBED',
    type: 'transclusion',
    parent_guid: block.guid,
    props: { itemref: 'TARGET_LINE', refx_embed: 1 },
    async setMetaProperty(key, value) { this.props[key] = value; return true; },
  };
  const sourceRecord = {
    async getLineItems() { return [block]; },
    async createLineItem(parent, after, type, segments, props) {
      nativeCreates++;
      created = true;
      liveLine.props = { ...props };
      block.children = [liveLine];
      return liveLine;
    }
  };
  plugin.data = { getRecord: (guid) => guid === 'SOURCE_RECORD' ? sourceRecord : null };
  plugin._wouldCycle = async () => false;
  plugin._transclusionNode = (lineGuid) => lineGuid === 'EMBED' ? nativeNode : null;

  const ok = await plugin._expandRef(
    { pageGuid: 'SOURCE_RECORD', lineGuid: 'HOST_LINE' },
    { targetGuid: 'TARGET_LINE', isText: true }
  );

  assert.equal(ok, true);
  assert.equal(nativeCreates, 1);
  assert.equal(plugin._recordPreviews.size, 0);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].lineGuid, 'EMBED');
  assert.equal(mounted[0].targetGuid, 'TARGET_LINE');
  assert.strictEqual(mounted[0].container, container);
});

test('Cmd/Ctrl+Up collapse removes exact preview metadata without deleting a line', async () => {
  const { plugin } = instance();
  const block = hostBlock();
  block.props.refx_record_previews_v1 = 'TARGET_RECORD';
  plugin._registerRecordPreview('HOST_LINE', 'TARGET_RECORD', block);
  plugin.data = { getRecord: () => ({ async getLineItems() { return [block]; } }) };
  plugin._selectedRef = () => ({ targetGuid: 'TARGET_RECORD', isText: false });

  await plugin._collapseAtCaret({ pageGuid: 'SOURCE_RECORD', lineGuid: 'HOST_LINE' });

  assert.equal(block.props.refx_record_previews_v1, undefined);
  assert.equal(plugin._recordPreviews.size, 0);
});

test('count-badge fast toggle detects and fully removes a synthetic-key record preview', async () => {
  const { plugin } = instance();
  const block = hostBlock();
  block.props.refx_record_previews_v1 = 'TARGET_RECORD';
  let shellRemoved = 0;
  const key = plugin._recordPreviewKey('HOST_LINE', 'TARGET_RECORD');
  plugin._registerRecordPreview('HOST_LINE', 'TARGET_RECORD', block);
  plugin._recordPreviews.get(key).shell = { remove() { shellRemoved++; } };

  assert.equal(plugin._hasEmbedOpen('HOST_LINE', 'TARGET_RECORD'), key);
  assert.equal(await plugin._collapseEmbedFast('HOST_LINE', 'TARGET_RECORD'), true);
  assert.equal(block.props.refx_record_previews_v1, undefined, 'persisted preview meta must be cleared');
  assert.equal(shellRemoved, 1, 'preview shell must be unmounted');
  assert.equal(plugin._recordPreviews.has(key), false);
  assert.equal(plugin._cards.has(key), false, 'synthetic preview card entry must be dropped');
});

test('bridge toggles a journal-hosted record preview closed without retry resurrection, then reopens it', async () => {
  const timers = fakeTimers();
  const { plugin, context } = instance({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const block = hostBlock();
  const journalGuid = 'S-JOURNAL-COL-USER-0-20260713';
  block.rguid = journalGuid;
  context.window.g_universe.itemsByGuid.HOST_LINE = block;
  let syntheticRecordReads = 0;
  plugin.data = {
    getRecord(guid) {
      if (guid === journalGuid) { syntheticRecordReads++; return null; }
      return guid === 'TARGET_RECORD' ? { guid } : null;
    }
  };

  assert.equal(await plugin._bridgeCreateEmbed('HOST_LINE', 'TARGET_RECORD'), true, 'first toggle opens');
  const key = plugin._recordPreviewKey('HOST_LINE', 'TARGET_RECORD');
  assert.equal(plugin._recordPreviews.has(key), true);
  assert.equal(block.props.refx_record_previews_v1, 'TARGET_RECORD');
  assert.equal(timers.size(), 1, 'host-arrival mount retry is pending');

  let shellRemoved = 0;
  const shell = {
    isConnected: true,
    dataset: { probe: 'survived-open' },
    remove() { shellRemoved++; this.isConnected = false; }
  };
  plugin._recordPreviews.get(key).shell = shell;

  assert.equal(await plugin._bridgeCreateEmbed('HOST_LINE', 'TARGET_RECORD'), false, 'second toggle reports collapsed state');
  assert.equal(shellRemoved, 1, 'the exact open shell is removed');
  assert.equal(shell.isConnected, false);
  assert.equal(block.props.refx_record_previews_v1, undefined, 'host-line preview meta is cleared');
  assert.equal(plugin._recordPreviews.has(key), false, 'preview registry entry is deleted');
  assert.equal(plugin._cards.has(key), false, 'preview card entry is deleted');
  assert.equal(timers.size(), 0, 'pending mount retry is explicitly cancelled');

  timers.flush();
  assert.equal(plugin._recordPreviews.has(key), false, 'flushed timers cannot remount the collapsed preview');
  assert.equal(shellRemoved, 1, 'the removed shell stays removed');

  assert.equal(await plugin._bridgeCreateEmbed('HOST_LINE', 'TARGET_RECORD'), true, 'third toggle reopens');
  assert.equal(plugin._recordPreviews.has(key), true);
  assert.equal(block.props.refx_record_previews_v1, 'TARGET_RECORD');
  assert.ok(syntheticRecordReads >= 1, 'test exercises data.getRecord(null) behavior for the synthetic journal guid');
});

test('both inline and popover badge routes collapse an open record preview', async () => {
  const { plugin } = instance();
  const block = hostBlock();
  plugin._registerRecordPreview('HOST_LINE', 'TARGET_RECORD', block);
  const host = { getAttribute: () => 'HOST_LINE' };
  const wrap = {
    dataset: { guid: 'TARGET_RECORD' },
    closest: (selector) => selector.includes('.listitem') ? host : null,
  };
  const calls = [];
  plugin._collapseEmbedFast = async (hostGuid, targetGuid) => { calls.push([hostGuid, targetGuid]); return true; };

  plugin._routeBadgeClick({ altKey: false, shiftKey: false }, null, wrap);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await plugin.openRefPopover(null, wrap);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    ['HOST_LINE', 'TARGET_RECORD'],
    ['HOST_LINE', 'TARGET_RECORD'],
  ]);
});

test('failed preview-to-native meta settlement rolls back the newly-created embed', async () => {
  const { plugin, context } = instance();
  const block = hostBlock();
  block.props.refx_record_previews_v1 = 'TARGET_RECORD';
  const key = 'rp:HOST_LINE:TARGET_RECORD';
  plugin._registerRecordPreview('HOST_LINE', 'TARGET_RECORD', block);
  const page = fakeNode('page');
  const { shell } = previewShell();
  shell.getBoundingClientRect = () => ({ height: 123 });
  page.append(shell);
  plugin._recordPreviews.get(key).shell = shell;
  let deleted = 0;
  let present = false;
  const liveLine = {
    guid: 'NEW_EMBED',
    type: 'transclusion',
    parent_guid: block.guid,
    props: { itemref: 'TARGET_RECORD', refx_embed: 1 },
    async getChildren() { return []; },
    async delete() { deleted++; present = false; block.children = []; return true; },
  };
  const sourceRecord = {
    async getLineItems() { return [block]; },
    async createLineItem() {
      const placeholder = page.querySelector('.refx-materialize-placeholder');
      assert.ok(placeholder, 'placeholder exists before createLineItem runs');
      assert.equal(placeholder.style.height, '123px');
      assert.equal(shell.classList.contains('refx-materializing'), true);
      present = true;
      block.children = [liveLine];
      return liveLine;
    }
  };
  context.window.g_universe.itemsByGuid.HOST_LINE = { rguid: 'SOURCE_RECORD' };
  plugin.data = { getRecord: (guid) => guid === 'SOURCE_RECORD' ? sourceRecord : { guid } };
  plugin._wouldCycle = async () => false;
  plugin._writeRecordPreviewMeta = async () => false;

  const ok = await plugin._materializeRecordPreview(key);

  assert.equal(ok, false);
  assert.equal(deleted, 1);
  assert.equal(plugin._recordPreviews.has(key), true);
  assert.equal(page.querySelector('.refx-materialize-placeholder'), null, 'failure releases the reserved height');
  assert.equal(shell.classList.contains('refx-materializing'), false, 'failure restores the shell opacity class');
});

test('Load full body without a preview card mounts native with a silent first attach', async () => {
  const { plugin, context } = instance();
  const block = hostBlock();
  block.props.refx_record_previews_v1 = 'TARGET_RECORD';
  const key = plugin._recordPreviewKey('HOST_LINE', 'TARGET_RECORD');
  plugin._registerRecordPreview('HOST_LINE', 'TARGET_RECORD', block);
  const { shell } = previewShell();
  const peek = fakeNode('refx-record-preview-peek');
  shell.append(peek);
  const previewEntry = plugin._recordPreviews.get(key);
  previewEntry.shell = shell;
  previewEntry.bodyPeekEl = peek;
  const liveLine = {
    guid: 'NATIVE_FULL_BODY',
    type: 'transclusion',
    parent_guid: block.guid,
    props: { itemref: 'TARGET_RECORD', refx_embed: 1 },
    async delete() { return true; },
  };
  const nativeNode = fakeNode('listitem listitem-transclusion');
  const nativeContainer = fakeNode('transclusion-container-div');
  nativeNode.append(nativeContainer);
  plugin._transclusionNode = (lineGuid) => lineGuid === liveLine.guid ? nativeNode : null;
  plugin._scheduleAlign = () => {};
  const mounted = [];
  context.document.addEventListener('refx:embed-mounted', (event) => mounted.push(event.detail));
  let createArgs = null;
  let created = false;
  const sourceRecord = {
    async getLineItems() { return [block]; },
    async createLineItem(parent, after, type, segments, props) {
      createArgs = [parent, after, type, segments, props];
      created = true;
      block.children = [liveLine];
      return liveLine;
    }
  };
  let targetBodyReads = 0;
  const targetRecord = {
    lineCount: 50000,
    async getLineItems() { targetBodyReads++; throw new Error('explicit native load must not inspect or reject by target size'); }
  };
  context.window.g_universe.itemsByGuid.HOST_LINE = { guid: 'HOST_LINE', rguid: 'SOURCE_RECORD' };
  plugin.data = { getRecord: (guid) => guid === 'SOURCE_RECORD' ? sourceRecord : guid === 'TARGET_RECORD' ? targetRecord : null };
  plugin._wouldCycle = async () => false;
  const cardCalls = [];
  plugin._attachPropCard = async (lineGuid, recordGuid, silent) => { cardCalls.push(['attach', lineGuid, recordGuid, silent]); };
  plugin._cardFieldsCache.set('TARGET_RECORD', ['warm preview fields']);

  assert.equal(await plugin._materializeRecordPreview(key), true);
  assert.equal(peek.isConnected, false, 'peek is removed before the native body is retained');
  assert.deepEqual(cardCalls, [
    ['attach', 'NATIVE_FULL_BODY', 'TARGET_RECORD', true],
  ]);
  assert.equal(plugin._cardFieldsCache.has('TARGET_RECORD'), true, 'the valid warm property cache is retained');
  assert.equal(targetBodyReads, 0, 'materialization does not repeat the warmed target-body read');
  assert.equal(createArgs[0], block);
  assert.equal(createArgs[2], 'transclusion');
  assert.equal(createArgs[4].refx_embed, 1);
  assert.equal(createArgs[4].itemref, 'TARGET_RECORD');
  const cardEntry = plugin._cards.get('NATIVE_FULL_BODY');
  assert.equal(cardEntry.line, liveLine, 'the exact createLineItem handle is retained');
  assert.equal(cardEntry.hostGuid, 'HOST_LINE');
  assert.equal(cardEntry.hostRecordGuid, 'SOURCE_RECORD');
  assert.equal(cardEntry.refxEmbed, true);
  assert.equal(mounted.length, 1, 'materialization dispatches after the native node resolves');
  assert.equal(mounted[0].lineGuid, 'NATIVE_FULL_BODY');
  assert.equal(mounted[0].targetGuid, 'TARGET_RECORD');
  assert.strictEqual(mounted[0].container, nativeContainer);
});

test('Load full body re-keys and moves the same preview card without rebuilding it', async () => {
  const { plugin, context } = instance();
  const block = hostBlock();
  block.props.refx_record_previews_v1 = 'TARGET_RECORD';
  const key = plugin._recordPreviewKey('HOST_LINE', 'TARGET_RECORD');
  plugin._registerRecordPreview('HOST_LINE', 'TARGET_RECORD', block);
  const page = fakeNode('page');
  const { shell } = previewShell();
  shell.getBoundingClientRect = () => ({ height: 156 });
  const previewCard = fakeNode(plugin._CARD_CLASS);
  previewCard.dataset.refxFor = key;
  shell.insertBefore(previewCard, shell.children[0]);
  page.append(shell);
  plugin._recordPreviews.get(key).shell = shell;
  const nativeNode = fakeNode('listitem listitem-transclusion');
  nativeNode.dataset.guid = 'NATIVE_FULL_BODY';
  page.append(nativeNode);
  const liveLine = {
    guid: 'NATIVE_FULL_BODY',
    type: 'transclusion',
    parent_guid: block.guid,
    props: { itemref: 'TARGET_RECORD', refx_embed: 1 },
    async delete() { return true; },
  };
  let created = false;
  const sourceRecord = {
    async getLineItems() { return [block]; },
    async createLineItem() {
      const placeholder = page.querySelector('.refx-materialize-placeholder');
      assert.ok(placeholder, 'exact-height reservation is inserted before native creation');
      assert.equal(placeholder.style.height, '156px');
      assert.equal(shell.classList.contains('refx-materializing'), true, 'shell begins fading before native creation');
      assert.strictEqual(previewCard.parentElement, page, 'property card is parked outside the fading shell and stays visible');
      created = true;
      block.children = [liveLine];
      return liveLine;
    }
  };
  const targetRecord = { getName: () => 'Target', getAllProperties: () => [] };
  context.window.g_universe.itemsByGuid.HOST_LINE = { guid: 'HOST_LINE', rguid: 'SOURCE_RECORD' };
  plugin.data = { getRecord: (guid) => guid === 'SOURCE_RECORD' ? sourceRecord : guid === 'TARGET_RECORD' ? targetRecord : null };
  plugin._wouldCycle = async () => false;
  plugin._transclusionNode = (lineGuid) => lineGuid === liveLine.guid ? nativeNode : null;
  plugin._scheduleAlign = () => {};
  const cardForSelector = (selector) => {
    const match = String(selector).match(/\.refx-propcard\[data-refx-for="([^"]+)"\]/);
    return match && previewCard.isConnected && previewCard.dataset.refxFor === match[1] ? previewCard : null;
  };
  context.document.querySelector = (selector) => cardForSelector(selector);
  context.document.querySelectorAll = (selector) => {
    const card = cardForSelector(selector);
    return card ? [card] : [];
  };
  let refreshes = 0;
  let freshRenders = 0;
  plugin._refreshCardInPlace = (lineGuid, recordGuid) => {
    refreshes++;
    assert.equal(lineGuid, liveLine.guid);
    assert.equal(recordGuid, 'TARGET_RECORD');
  };
  plugin._renderFreshCard = () => { freshRenders++; };
  const warmFields = [{ name: 'Status', value: 'Open' }];
  plugin._cardFieldsCache.set('TARGET_RECORD', warmFields);

  assert.equal(await plugin._materializeRecordPreview(key), true);

  const nativeCard = context.document.querySelector('.' + plugin._CARD_CLASS + '[data-refx-for="NATIVE_FULL_BODY"]');
  assert.strictEqual(nativeCard, previewCard, 'the native embed owns the exact preview card element');
  assert.strictEqual(previewCard.parentElement, nativeNode, 'the same card node is moved into the native transclusion');
  assert.equal(previewCard.classList.contains('refx-propcard-loading'), false, 'no loading state is introduced');
  assert.equal(refreshes, 1, 'the healthy re-keyed card refreshes in place once');
  assert.equal(freshRenders, 0, 'the materialization path never rebuilds an existing preview card');
  assert.strictEqual(plugin._cardFieldsCache.get('TARGET_RECORD'), warmFields, 'the warm property cache is not invalidated');
  assert.strictEqual(plugin._cards.get(liveLine.guid).cardEl, previewCard, 'the native card registry retains the same node');
  assert.equal(page.querySelector('.refx-materialize-placeholder'), null, 'successful native placement releases the reserved height');
  assert.equal(shell.classList.contains('refx-materializing'), false, 'removed shell does not retain the transition class');
  assert.equal(nativeNode.classList.contains('refx-materializing-in'), true, 'native embed receives the delayed fade-in animation');
  nativeNode.listeners.get('animationend')?.();
  assert.equal(nativeNode.classList.contains('refx-materializing-in'), false, 'animation class is removed after animationend');
});

test('materialize placement retry exhaustion releases its placeholder', () => {
  const timers = fakeTimers();
  const { plugin } = instance({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const page = fakeNode('page');
  const { shell } = previewShell();
  shell.getBoundingClientRect = () => ({ height: 88 });
  page.append(shell);
  const transition = plugin._reserveRecordPreviewMaterialize('PREVIEW_KEY', { shell });
  plugin._cards.set('EMBED_WAITING', { recordGuid: 'TARGET_WAITING' });
  plugin._transclusionNode = () => null;

  assert.equal(plugin._placeMaterializedPreviewCard('EMBED_WAITING', null, 0, transition, 'TARGET_WAITING'), false);
  assert.ok(page.querySelector('.refx-materialize-placeholder'));
  timers.flush();

  assert.equal(page.querySelector('.refx-materialize-placeholder'), null);
  assert.equal(plugin._materializeReservations.size, 0);
  assert.equal(timers.size(), 0);
});

test('empty-body probe replaces Load full body with an accessible Add body content action', async () => {
  const { plugin } = instance();
  const { shell, load } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  const key = plugin._recordPreviewKey('HOST_EMPTY', 'TARGET_EMPTY');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_EMPTY', targetGuid: 'TARGET_EMPTY', shell });
  let arg = null;
  plugin.data = { getRecord: () => ({ getAllProperties: () => [], async getLineItems(expand) { arg = expand; return [{ type: 'document' }]; } }) };

  assert.equal(await plugin._probeRecordPreviewBody(key), true);
  assert.equal(arg, false, 'body probe must use getLineItems(false)');
  assert.equal(load.hidden, true);
  assert.equal(load.style.display, 'none');
  assert.equal(shell.querySelector('.refx-record-preview-body-status').textContent, '· no body content');
  const add = shell.querySelector('.refx-record-preview-addbody');
  assert.ok(add, 'a proven-empty preview must expose the explicit body action');
  assert.equal(add.textContent, '＋ Add body content');
  assert.equal(add.type, 'button');
  assert.equal(add.tabIndex, 0);
});

test('Add body content creates one native line, materializes the editable transclusion, and focuses that line', async () => {
  const { plugin } = instance();
  const { shell, load } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  const key = plugin._recordPreviewKey('HOST_ADD', 'TARGET_ADD');
  const entry = { key, hostLineGuid: 'HOST_ADD', targetGuid: 'TARGET_ADD', shell };
  plugin._recordPreviews.set(key, entry);
  plugin._cards.set(key, { recordGuid: 'TARGET_ADD', preview: true });
  let createArgs = null;
  const target = {
    async getLineItems() { return [{ type: 'document' }]; },
    async createLineItem(...args) { createArgs = args; return { guid: 'NEW_BODY_LINE' }; }
  };
  plugin.data = { getRecord: () => target };
  let materialized = null;
  plugin._materializeRecordPreview = async (seenKey) => {
    materialized = seenKey;
    plugin._cards.set('NEW_EMBED_LINE', {
      recordGuid: 'TARGET_ADD', hostGuid: 'HOST_ADD', refxEmbed: true
    });
    return true;
  };
  let focused = null;
  plugin._focusEmbeddedLine = (...args) => { focused = args; };

  assert.equal(await plugin._probeRecordPreviewBody(key), true);
  const add = shell.querySelector('.refx-record-preview-addbody');
  await add.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });

  assert.deepEqual(createArgs, [null, null, 'text']);
  assert.equal(materialized, key);
  assert.deepEqual(focused, ['NEW_EMBED_LINE', 'NEW_BODY_LINE', 0]);
  assert.equal(shell.querySelector('.refx-record-preview-addbody'), null);
  assert.equal(load.hidden, false);
  assert.equal(load.style.display, '');
});

test('failed Add body content write preserves and re-enables the action without materializing', async () => {
  const { plugin } = instance();
  const { shell } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  const key = plugin._recordPreviewKey('HOST_FAIL_ADD', 'TARGET_FAIL_ADD');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_FAIL_ADD', targetGuid: 'TARGET_FAIL_ADD', shell });
  plugin._cards.set(key, { recordGuid: 'TARGET_FAIL_ADD', preview: true });
  plugin.data = { getRecord: () => ({
    async getLineItems() { return [{ type: 'document' }]; },
    async createLineItem() { return null; }
  }) };
  let materialized = 0;
  plugin._materializeRecordPreview = async () => { materialized++; return true; };

  await plugin._probeRecordPreviewBody(key);
  const add = shell.querySelector('.refx-record-preview-addbody');
  await add.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });

  assert.equal(materialized, 0);
  assert.equal(add.disabled, false);
  assert.equal(add.textContent, '＋ Add body content');
  assert.equal(add.isConnected, true);
});

test('Add body content is single-flight and cannot create duplicate blank lines', async () => {
  const { plugin } = instance();
  const { shell } = previewShell();
  const key = plugin._recordPreviewKey('HOST_SINGLE', 'TARGET_SINGLE');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_SINGLE', targetGuid: 'TARGET_SINGLE', shell });
  plugin._cards.set(key, { recordGuid: 'TARGET_SINGLE', preview: true });
  let release = null;
  let creates = 0;
  plugin.data = { getRecord: () => ({
    createLineItem() {
      creates++;
      return new Promise((resolve) => { release = resolve; });
    }
  }) };
  plugin._materializeRecordPreview = async () => false;

  const first = plugin._addBodyLine(key);
  await Promise.resolve();
  assert.equal(await plugin._addBodyLine(key), false, 'a concurrent activation is rejected');
  release({ guid: 'ONLY_BODY_LINE' });
  assert.equal(await first, true);
  assert.equal(creates, 1);
});

test('a later non-empty body probe removes the empty-only action and restores Load full body', async () => {
  const { plugin } = instance();
  const { shell, load } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  const key = plugin._recordPreviewKey('HOST_CHANGED', 'TARGET_CHANGED');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_CHANGED', targetGuid: 'TARGET_CHANGED', shell });
  let items = [{ type: 'document' }];
  plugin.data = { getRecord: () => ({ async getLineItems() { return items; } }) };

  await plugin._probeRecordPreviewBody(key);
  assert.ok(shell.querySelector('.refx-record-preview-addbody'));
  items = [{ guid: 'EXTERNAL_BODY', type: 'text', segments: [] }];
  await plugin._probeRecordPreviewBody(key);

  assert.equal(shell.querySelector('.refx-record-preview-addbody'), null);
  assert.equal(load.hidden, false);
  assert.equal(load.style.display, '');
});

test('small-body probe auto-materializes once when autoLoadSmallBodies is enabled', async () => {
  const { plugin } = instance();
  const { shell } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  plugin._smallBodyLineCap = 40;
  plugin._autoLoadSmallBodies = true;
  const key = plugin._recordPreviewKey('HOST_AUTO', 'TARGET_AUTO');
  const entry = { key, hostLineGuid: 'HOST_AUTO', targetGuid: 'TARGET_AUTO', shell };
  plugin._recordPreviews.set(key, entry);
  plugin.data = { getRecord: () => ({ async getLineItems() { return [{ guid: 'L1', type: 'text', segments: [] }]; } }) };
  const calls = [];
  plugin._materializeRecordPreview = async (seenKey) => { calls.push(seenKey); return true; };

  assert.equal(await plugin._probeRecordPreviewBody(key), true);
  assert.deepEqual(calls, [key]);
  assert.equal(entry.autoMaterializeAttempted, true);

  assert.equal(await plugin._probeRecordPreviewBody(key), true);
  assert.deepEqual(calls, [key], 'a failed/remounted probe cannot auto-materialize the same preview twice');
});

test('small-body probe paints a segment-rendered inline peek without native creation', async () => {
  const { plugin } = instance();
  const { shell, load } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  plugin._smallBodyLineCap = 40;
  plugin._autoLoadSmallBodies = false;
  const key = plugin._recordPreviewKey('HOST_SMALL', 'TARGET_SMALL');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_SMALL', targetGuid: 'TARGET_SMALL', shell });
  let creates = 0;
  const items = [
    { guid: 'L1', type: 'text', segments: [{ type: 'text', text: 'First line' }] },
    { guid: 'L2', type: 'text', segments: [{ type: 'text', text: 'Second line' }] },
  ];
  plugin.data = { getRecord: () => ({
    getAllProperties: () => [],
    async getLineItems(expand) { assert.equal(expand, false); return items; },
    async createLineItem(parent, after, type, segments, props) { void parent; void after; void type; void segments; void props; creates++; }
  }) };

  assert.equal(await plugin._probeRecordPreviewBody(key), true);
  const peek = shell.querySelector('.refx-record-preview-peek');
  assert.ok(peek, 'small body should render a lightweight peek');
  assert.deepEqual(peek.querySelectorAll('.refx-record-preview-peek-text').map((node) => node.textContent), ['First line', 'Second line']);
  assert.equal(load.hidden, false, 'native upgrade stays available');
  assert.equal(creates, 0, 'probe/peek must not mount a native transclusion');
});

test('long-body probe keeps a bounded truthful lightweight preview and never offers Add body content', async () => {
  const { plugin } = instance();
  const { shell, load } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  plugin._smallBodyLineCap = 40;
  plugin._previewBodyPeek = true;
  plugin._autoLoadSmallBodies = true;
  const key = plugin._recordPreviewKey('HOST_LONG', 'TARGET_LONG');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_LONG', targetGuid: 'TARGET_LONG', shell });
  const items = Array.from({ length: 73 }, (_, index) => ({
    guid: `LONG_${index + 1}`,
    type: 'text',
    segments: [{ type: 'text', text: `Long body line ${index + 1}` }]
  }));
  let reads = 0;
  let creates = 0;
  plugin.data = { getRecord: () => ({
    async getLineItems(expand) { reads++; assert.equal(expand, false); return items; },
    async createLineItem() { creates++; return null; }
  }) };

  assert.equal(await plugin._probeRecordPreviewBody(key), true);
  const peek = shell.querySelector('.refx-record-preview-peek');
  assert.ok(peek, 'long non-empty bodies retain their lightweight preview');
  assert.equal(peek.querySelectorAll('.refx-record-preview-peek-line').length, 40, 'DOM is bounded by smallBodyLineCap');
  assert.equal(peek.querySelectorAll('.refx-record-preview-peek-text')[39].textContent, 'Long body line 40');
  assert.equal(peek.querySelector('.refx-record-preview-peek-count').textContent, '40 of >40 lines · lightweight preview');
  const footerRule = source.match(/\.refx-record-preview-peek-count\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(footerRule, /position:\s*static/, 'the count footer participates in normal flow');
  assert.doesNotMatch(footerRule, /bottom\s*:/, 'the count footer cannot float over the last preview row');
  assert.doesNotMatch(footerRule, /margin:[^;]*-\d/, 'the count footer has no negative overlap margin');
  assert.equal(shell.querySelector('.refx-record-preview-addbody'), null, 'Add body content is strictly empty-only');
  assert.equal(load.hidden, false, 'explicit native upgrade remains available');
  assert.equal(reads, 1, 'the bounded preview reuses the one body probe');
  assert.equal(creates, 0, 'long-body preview does not write or mount native content');
});

test('one root with a huge descendant outline never auto-mounts as a small page', async () => {
  const { plugin } = instance();
  const { shell } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  plugin._smallBodyLineCap = 40;
  plugin._previewBodyPeek = true;
  plugin._autoLoadSmallBodies = true;
  const key = plugin._recordPreviewKey('HOST_DEEP', 'TARGET_DEEP');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_DEEP', targetGuid: 'TARGET_DEEP', shell });
  let current = { guid: 'DEEP_99', type: 'text', segments: [{ type: 'text', text: 'Depth 99' }], children: [] };
  for (let index = 98; index >= 0; index--) {
    current = { guid: 'DEEP_' + index, type: 'text', segments: [{ type: 'text', text: 'Depth ' + index }], children: [current] };
  }
  let materializations = 0;
  plugin.data = { getRecord: () => ({ async getLineItems(expand) { assert.equal(expand, false); return [current]; } }) };
  plugin._materializeRecordPreview = async () => { materializations++; return true; };

  assert.equal(await plugin._probeRecordPreviewBody(key), true);
  assert.equal(materializations, 0, 'nested structure is counted before the automatic native-mount decision');
  const peek = shell.querySelector('.refx-record-preview-peek');
  assert.equal(peek.querySelectorAll('.refx-record-preview-peek-line').length, 40);
  assert.equal(peek.querySelectorAll('.refx-record-preview-peek-line')[1].style.paddingInlineStart, '15px');
  assert.equal(peek.querySelector('.refx-record-preview-peek-count').textContent, '40 of >40 lines · lightweight preview');
});

test('body probe aborts after preview close without touching the dead shell', async () => {
  const { plugin } = instance();
  const { shell, load } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  const wait = {};
  wait.promise = new Promise((resolve) => { wait.resolve = resolve; });
  const key = plugin._recordPreviewKey('HOST_ABORT', 'TARGET_ABORT');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_ABORT', targetGuid: 'TARGET_ABORT', shell });
  plugin._cards.set(key, { recordGuid: 'TARGET_ABORT', preview: true });
  plugin.data = { getRecord: () => ({ getAllProperties: () => [], getLineItems: () => wait.promise }) };
  let peekWrites = 0;
  let materializeWrites = 0;
  const renderPeek = plugin._renderRecordPreviewPeek.bind(plugin);
  plugin._renderRecordPreviewPeek = (...args) => { peekWrites++; return renderPeek(...args); };
  plugin._materializeRecordPreview = async () => { materializeWrites++; return true; };

  const pending = plugin._probeRecordPreviewBody(key);
  plugin._removeRecordPreviewUi(key);
  wait.resolve([{ guid: 'LATE', type: 'text', segments: [{ type: 'text', text: 'too late' }] }]);
  assert.equal(await pending, false);
  assert.equal(shell.isConnected, false);
  assert.equal(peekWrites, 0, 'settled body read must not write into a closed preview');
  assert.equal(materializeWrites, 0, 'generation guard prevents auto-materializing a removed preview');
  assert.equal(load.hidden, false, 'late empty/non-empty state must not mutate detached actions');
});

test('scheduled body probe yields the mount task before invoking cold getLineItems', async () => {
  const timers = fakeTimers();
  const { plugin } = instance({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const { shell } = previewShell();
  plugin._el = (_tag, cls, text) => fakeNode(cls, text || '');
  const key = plugin._recordPreviewKey('HOST_YIELD', 'TARGET_YIELD');
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_YIELD', targetGuid: 'TARGET_YIELD', shell });
  let bodyReads = 0;
  plugin.data = { getRecord: () => ({ getAllProperties: () => [], async getLineItems(expand) { assert.equal(expand, false); bodyReads++; return [{ type: 'document' }]; } }) };

  plugin._scheduleRecordPreviewProbe(key);
  assert.equal(bodyReads, 0, 'scheduling must not call the cold SDK path in the mount task');
  timers.flush();
  await Promise.resolve();
  assert.equal(bodyReads, 1);
});

test('README documents the Cmd+P line-format transclusion caveat', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /Known Thymer limitation:[\s\S]*command palette's line-format commands[\s\S]*collapses the embed \(undo restores it\)[\s\S]*Open (?:record|source) ↗[\s\S]*Jump to block/);
});
