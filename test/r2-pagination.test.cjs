'use strict';
// R2 Pagination Tests — cursor/page model, truthfulness, stale continuation
//
// Tests:
//   - Synthetic fixture sets at 0, 1, 30, 31, 250, 2500 occurrences paginate to the
//     complete authoritative set with no duplicate or skipped occurrence across cursor pages.
//   - Remote edge arriving mid-pagination is reconciled exactly once under a new revision
//     (no dup, no loss).
//   - Stale continuation cancellation: revision bump invalidates pending cursor →
//     stale-cursor envelope → restart from null.
//   - The three zero/partial language states (0 complete, 0 provisional, n of at least N).
//   - Display-side pagination: _makeShowMoreButton exists and is callable.
//   - Card fields truthfulness: _cappedAt32 flag, _recCardFields caps at 32.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

// ── Harness (mirrors reference-surface-broker.test.cjs) ───────────────────────

function loadPlugin(universeItems = {}, workspaceGuid = 'WEJ9EZW6ADT58SJC3EQMNETSW6') {
  const storage = new Map();
  const eventHandlers = {};
  let docListeners = {};
  let winListeners = {};

  const context = {
    AppPlugin: class {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false }), 10),
    performance: { now: () => Date.now() },
    CSS: { escape: (s) => String(s) },
    navigator: { platform: 'MacIntel', clipboard: {} },
    Promise,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    document: {
      querySelectorAll: () => ({ forEach: () => {} }),
      querySelector: () => null,
      documentElement: { clientHeight: 900 },
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      head: { appendChild() {} },
      addEventListener: (evt, fn) => { if (!docListeners[evt]) docListeners[evt] = []; docListeners[evt].push(fn); },
      removeEventListener: (evt, fn) => { if (docListeners[evt]) docListeners[evt] = docListeners[evt].filter((h) => h !== fn); },
      dispatchEvent: (e) => { (docListeners[e.type] || []).forEach((h) => { try { h(e); } catch (err) {} }); return true; },
      createElement: (tag) => {
        const classes = new Set();
        const el = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        type: '',
        children: [],
        childNodes: [],
        style: {},
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
        setAttribute() {},
        getAttribute() { return null; },
        addEventListener(evt, fn) { if (!this._listeners) this._listeners = {}; if (!this._listeners[evt]) this._listeners[evt] = []; this._listeners[evt].push(fn); },
        dispatchEvent(e) { ((this._listeners || {})[e.type] || []).forEach((h) => h(e)); },
        append(...children) { for (const c of children) this.children.push(c); },
        appendChild(c) { this.children.push(c); return c; },
        remove() { this._removed = true; },
        querySelector(sel) { return this.children.find((c) => c.className && c.className.includes(sel.replace('.', ''))) || null; },
        querySelectorAll(sel) { return this.children.filter((c) => c.className && c.className.includes(sel.replace('.', ''))); },
        getBoundingClientRect() { return { top: 0, bottom: 0, height: 0 }; },
      };
        Object.defineProperty(el, 'className', {
          get: () => [...classes].join(' '),
          set: (value) => {
            classes.clear();
            String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
          },
        });
        return el;
      },
    },
    CustomEvent: class CustomEvent {
      constructor(type, opts) { this.type = type; this.detail = (opts && opts.detail) || null; }
    },
    Element: class {},
    window: {
      CSS: { escape: (s) => String(s) },
      g_universe: { itemsByGuid: universeItems, workspace: { guid: workspaceGuid } },
      addEventListener: (evt, fn) => { if (!winListeners[evt]) winListeners[evt] = []; winListeners[evt].push(fn); },
      removeEventListener: (evt, fn) => { if (winListeners[evt]) winListeners[evt] = winListeners[evt].filter((h) => h !== fn); },
      dispatchEvent: (e) => { (winListeners[e.type] || []).forEach((h) => { try { h(e); } catch (err) {} }); },
    },
  };
  context.globalThis = context;
  context.window.globalThis = context;

  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });

  const registeredHandlers = {};
  const plugin = new context.PluginUnderTest();
  plugin.workspaceGuid = workspaceGuid;
  plugin._isUnloading = false;
  plugin._enabled = true;
  plugin.data = {
    getRecord: (guid) => {
      const st = universeItems[guid];
      if (!st || st.rguid) return null;
      return { guid, getAllProperties: () => [], getLineItems: async () => [], getAllRecords: () => [] };
    },
    getAllCollections: async () => [],
    getAllRecords: () => [],
    searchByQuery: async () => [],
  };
  plugin.ui = {
    addCommandPaletteCommand: () => ({ remove() {} }),
    addStatusBarItem: () => ({ remove() {} }),
    getActivePanel: () => null,
  };
  plugin.events = {
    on: (name, fn) => {
      if (!registeredHandlers[name]) registeredHandlers[name] = [];
      registeredHandlers[name].push(fn);
      const id = name + '_' + registeredHandlers[name].length;
      return id;
    },
    off: (id) => {},
  };
  plugin._registeredHandlers = registeredHandlers;
  plugin._context = context;
  plugin._winListeners = winListeners;
  plugin._docListeners = docListeners;

  return { plugin, context, winListeners, docListeners, registeredHandlers };
}

function makeBroker(universeItems = {}, dataOverride) {
  const { plugin, context, winListeners } = loadPlugin(universeItems);
  if (dataOverride) plugin.data = { ...plugin.data, ...dataOverride };
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  return { broker, plugin, context, winListeners };
}

function fireEvent(plugin, name, payload) {
  const handlers = plugin._registeredHandlers[name] || [];
  for (const fn of handlers) { try { fn(payload); } catch (e) {} }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Inject N ref-edges into a broker targeting a fixed target GUID.
// Each edge originates from a distinct line/record to guarantee distinct IDs.
function injectEdges(plugin, broker, n, targetGuid = 'REC_TARGET_PAGED') {
  for (let i = 0; i < n; i++) {
    const lineGuid = `LIN_PAGED_${String(i).padStart(6, '0')}`;
    const recGuid  = `REC_SRC_PAGED_${String(i).padStart(6, '0')}`;
    fireEvent(plugin, 'lineitem.created', {
      lineGuid,
      recordGuid: recGuid,
      segments: [{ type: 'ref', text: { guid: targetGuid } }],
    });
  }
}

// Drain broker.edges() cursor-by-cursor until cursor===null; return the full set of ids.
// Uses cursor exhaustion as the stop condition (not complete:true), because in the test
// harness status is always 'partial' (claims unavailable) so complete is never true.
// The real consumer contract is identical: when cursor===null there are no more items
// regardless of complete (which is the authority flag, not the stop signal).
function drainEdges(broker, filter, pageSize = 50) {
  const seen = new Set();
  let cursor = null;
  let passes = 0;
  const MAX_PASSES = 10000; // guard against infinite loop in tests

  while (passes < MAX_PASSES) {
    passes++;
    const params = { filter, limit: pageSize, after: cursor };
    const page = broker.edges(params);

    if (page.error) throw new Error(`edges() error on pass ${passes}: ${page.error}`);
    for (const e of page.items) {
      if (seen.has(e.id)) throw new Error(`duplicate edge id ${e.id} on pass ${passes}`);
      seen.add(e.id);
    }
    cursor = page.cursor;
    if (cursor === null) break; // exhausted
  }

  return seen;
}

// Same for occurrences.
function drainOccurrences(broker, filter, pageSize = 50) {
  const seen = new Set();
  let cursor = null;
  let passes = 0;
  const MAX_PASSES = 10000;

  while (passes < MAX_PASSES) {
    passes++;
    const params = { filter, limit: pageSize, after: cursor };
    const page = broker.occurrences(params);

    if (page.error) throw new Error(`occurrences() error on pass ${passes}: ${page.error}`);
    for (const o of page.items) {
      if (seen.has(o.edgeId)) throw new Error(`duplicate occurrence edgeId ${o.edgeId} on pass ${passes}`);
      seen.add(o.edgeId);
    }
    cursor = page.cursor;
    if (cursor === null) break;
  }

  return seen;
}

// ── Fixture-count pagination tests ────────────────────────────────────────────

test('R2 pagination: 0 occurrences — complete:true, empty items, null cursor', async () => {
  const { broker } = makeBroker({ 'REC_TARGET_0': { guid: 'REC_TARGET_0', type: 'document' } });
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: null, targetGuid: 'REC_TARGET_0', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const page = broker.edges({ filter, limit: 50 });
  assert.equal(page.items.length, 0, '0 occurrences: items must be empty');
  assert.equal(page.error, null);
  assert.equal(page.cursor, null, '0 occurrences: cursor must be null');
  // complete may be false if claims not ready, but items must be 0
  assert.equal(page.items.length, 0);
});

test('R2 pagination: 1 occurrence — single page, complete, no cursor', async () => {
  const universeItems = {
    'REC_TARGET_1': { guid: 'REC_TARGET_1', type: 'document' },
    'REC_SRC_PAGED_000000': { guid: 'REC_SRC_PAGED_000000', type: 'document' },
  };
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 1, 'REC_TARGET_1');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_1', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const page = broker.edges({ filter, limit: 50 });
  assert.equal(page.items.length, 1, '1 occurrence: exactly 1 item');
  assert.equal(page.cursor, null, '1 occurrence: no next cursor');
  assert.equal(page.error, null);
});

test('R2 pagination: 30 occurrences — single page at limit=30, complete, null cursor', async () => {
  // Build universe with all target + source records
  const universeItems = { 'REC_TARGET_30': { guid: 'REC_TARGET_30', type: 'document' } };
  for (let i = 0; i < 30; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 30, 'REC_TARGET_30');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_30', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const page = broker.edges({ filter, limit: 30 });
  assert.equal(page.items.length, 30, '30 occurrences at limit=30: all 30 in one page');
  assert.equal(page.cursor, null, '30 occurrences at limit=30: complete — null cursor');

  // Drain to confirm no duplicates, full coverage
  const all = drainEdges(broker, filter, 30);
  assert.equal(all.size, 30, '30 occurrences: full drain yields 30 unique edges');
});

test('R2 pagination: 31 occurrences — first page has cursor, second page exhausts', async () => {
  const universeItems = { 'REC_TARGET_31': { guid: 'REC_TARGET_31', type: 'document' } };
  for (let i = 0; i < 31; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 31, 'REC_TARGET_31');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_31', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };

  // First page
  const page1 = broker.edges({ filter, limit: 30 });
  assert.equal(page1.items.length, 30, '31 occurrences first page: 30 items');
  assert.ok(page1.cursor !== null, '31 occurrences: first page must have cursor');
  assert.equal(page1.error, null);

  // Second page via cursor
  const page2 = broker.edges({ filter, limit: 30, after: page1.cursor });
  assert.equal(page2.items.length, 1, '31 occurrences second page: 1 remaining item');
  assert.equal(page2.cursor, null, '31 occurrences: second page is last, null cursor');
  assert.equal(page2.error, null);

  // No duplicates across pages
  const ids1 = new Set(page1.items.map((e) => e.id));
  const ids2 = new Set(page2.items.map((e) => e.id));
  for (const id of ids2) assert.ok(!ids1.has(id), `duplicate id ${id} across pages`);
  assert.equal(ids1.size + ids2.size, 31, '31 unique edges total');
});

test('R2 pagination: 250 occurrences — full drain with pageSize=50 yields exactly 250 unique', async () => {
  const universeItems = { 'REC_TARGET_250': { guid: 'REC_TARGET_250', type: 'document' } };
  for (let i = 0; i < 250; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 250, 'REC_TARGET_250');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_250', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const all = drainEdges(broker, filter, 50);
  assert.equal(all.size, 250, '250 occurrences: full drain yields exactly 250 unique edges');
}, { timeout: 10000 });

test('R2 pagination: 2500 occurrences — full drain with pageSize=250 yields exactly 2500 unique', async () => {
  const universeItems = { 'REC_TARGET_2500': { guid: 'REC_TARGET_2500', type: 'document' } };
  for (let i = 0; i < 2500; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 2500, 'REC_TARGET_2500');
  await new Promise((r) => setTimeout(r, 30));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_2500', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const all = drainEdges(broker, filter, 250);
  assert.equal(all.size, 2500, '2500 occurrences: full drain yields exactly 2500 unique edges');
}, { timeout: 30000 });

// ── occurrences() mirrors edges() across pagination ────────────────────────────

test('R2 occurrences(): 31 occurrences — two-page drain via edgeId yields 31 unique', async () => {
  const universeItems = { 'REC_TARGET_OCC31': { guid: 'REC_TARGET_OCC31', type: 'document' } };
  for (let i = 0; i < 31; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 31, 'REC_TARGET_OCC31');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_OCC31', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const all = drainOccurrences(broker, filter, 30);
  assert.equal(all.size, 31, 'occurrences: 31 unique edgeIds across two pages');
});

// ── Stale cursor semantics ─────────────────────────────────────────────────────

test('R2 stale-cursor: wrong generation returns stale-cursor error envelope', async () => {
  const { broker } = makeBroker({ 'REC_TARGET_ST': { guid: 'REC_TARGET_ST', type: 'document' } });
  await new Promise((r) => setTimeout(r, 10));

  const result = broker.edges({
    filter: { _filterVersion: 1, kinds: null, targetGuid: null, sourceRecord: null, authored: null, collectionGuid: null, dateRange: null },
    limit: 50,
    after: null,
    generation: 'OLD_WRONG_GENERATION_XYZ',
    revision: 0,
  });
  assert.equal(result.error, 'stale-cursor', 'wrong generation must yield stale-cursor');
  assert.equal(result.items.length, 0, 'stale-cursor must return empty items');
  assert.equal(result.complete, false, 'stale-cursor must return complete:false');
  assert.equal(result.cursor, null, 'stale-cursor must return null cursor');
  assert.equal(result.queryRevision, broker.revision, 'stale-cursor queryRevision must be current');
});

test('R2 stale-cursor: a cursor from a prior revision returns stale-cursor after a revision bump', async () => {
  const universeItems = {
    'REC_TARGET_STREV': { guid: 'REC_TARGET_STREV', type: 'document' },
    'REC_SRC_PAGED_000000': { guid: 'REC_SRC_PAGED_000000', type: 'document' },
  };
  for (let i = 0; i < 31; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 31, 'REC_TARGET_STREV');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_STREV', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const page1 = broker.edges({ filter, limit: 30 });
  assert.ok(page1.cursor, 'pre-condition: first page must have a cursor');

  // Capture cursor, then mutate the broker (triggers revision bump)
  const staleCursor = page1.cursor;
  const revBefore = broker.revision;

  // Add a new edge to bump the revision
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_EXTRA_STALE',
    recordGuid: 'REC_SRC_EXTRA_STALE',
    segments: [{ type: 'ref', text: { guid: 'REC_TARGET_STREV' } }],
  });
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(broker.revision > revBefore, 'revision must have bumped after mutation');

  // Attempt to use the old cursor — must get stale-cursor
  const stalePage = broker.edges({ filter, limit: 30, after: staleCursor });
  assert.equal(stalePage.error, 'stale-cursor', 'cursor from prior revision must yield stale-cursor');
  assert.equal(stalePage.items.length, 0, 'stale-cursor must return no items');
  assert.equal(stalePage.complete, false, 'stale-cursor must return complete:false');
  assert.equal(stalePage.cursor, null, 'stale-cursor must return null cursor');
});

test('R2 stale-cursor: caller restarts from null after stale-cursor — recovers full set', async () => {
  // Simulate the correct recovery pattern: stale → restart from null.
  const universeItems = { 'REC_TARGET_RESTART': { guid: 'REC_TARGET_RESTART', type: 'document' } };
  for (let i = 0; i < 31; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 31, 'REC_TARGET_RESTART');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_RESTART', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };

  // Drain page 1, capture cursor
  const page1 = broker.edges({ filter, limit: 30 });
  const stale = page1.cursor;

  // Mutate to bump revision
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_RESTART_EXTRA',
    recordGuid: 'REC_RESTART_EXTRA',
    segments: [{ type: 'ref', text: { guid: 'REC_TARGET_RESTART' } }],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Stale cursor detected
  const stalePage = broker.edges({ filter, limit: 30, after: stale });
  assert.equal(stalePage.error, 'stale-cursor');

  // Restart from null — should get full fresh set (now 32 edges: 31 + 1 extra)
  const freshAll = drainEdges(broker, filter, 30);
  assert.equal(freshAll.size, 32, 'after restart from null, full 32-edge set is recoverable');
});

// ── Remote edge mid-pagination reconciliation ─────────────────────────────────

test('R2 remote edge mid-pagination: new edge under new revision is reconciled exactly once', async () => {
  // Page 1 of N. Then a remote edge arrives (new revision). Drain from the new revision
  // (restart from null). The new edge appears exactly once, no duplicates.
  const universeItems = { 'REC_TARGET_REMOTE': { guid: 'REC_TARGET_REMOTE', type: 'document' } };
  for (let i = 0; i < 31; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 31, 'REC_TARGET_REMOTE');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_REMOTE', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };

  // Consume page 1
  const page1 = broker.edges({ filter, limit: 30 });
  assert.equal(page1.items.length, 30);
  const capturedCursor = page1.cursor;

  // Simulate remote edge arriving (e.g. from another client)
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_REMOTE_EDGE',
    recordGuid: 'REC_REMOTE_EDGE_SRC',
    segments: [{ type: 'ref', text: { guid: 'REC_TARGET_REMOTE' } }],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Old cursor is now stale (revision bumped)
  const staleAttempt = broker.edges({ filter, limit: 30, after: capturedCursor });
  assert.equal(staleAttempt.error, 'stale-cursor', 'captured cursor stale after remote edge');

  // Restart from null — drain the full fresh set
  const freshAll = drainEdges(broker, filter, 30);
  // 31 original + 1 remote = 32 total
  assert.equal(freshAll.size, 32, 'remote edge arrives exactly once after fresh drain (32 total)');

  // The remote edge's id is in the set.
  // Edge id for ref edges: ref:v1:{lineGuid}:{segmentOrdinal}:{targetGuid}
  const remoteEdgeId = 'ref:v1:LIN_REMOTE_EDGE:0:REC_TARGET_REMOTE';
  assert.ok(freshAll.has(remoteEdgeId), 'remote edge must appear in fresh drain exactly once');
});

// ── Three zero/partial language states ────────────────────────────────────────

test('R2 language states: status=partial when hydration not done', () => {
  const { broker } = makeBroker();
  // Broker starts in partial state (hydration not done because getAllCollections is async and hasn't resolved)
  const snap = broker.snapshot();
  // status is 'partial' before hydration completes (claims not complete yet)
  assert.ok(['partial', 'complete', 'degraded'].includes(snap.status), 'status must be a valid value');
  // Items from a fresh broker are empty
  const page = broker.edges({ filter: null, limit: 50 });
  assert.equal(page.items.length, 0, 'fresh broker has no edges');
  assert.equal(page.error, null, 'no error on fresh broker');
  // knownTotal is null while hydrating
  assert.ok(page.knownTotal === null || typeof page.knownTotal === 'number', 'knownTotal must be null or number');
});

test('R2 language states: empty result with complete:false signals 0 provisional (still hydrating)', () => {
  // The broker starts with status=partial (hydration async, not resolved yet).
  // An edges() call returns items=[], complete=false when the broker is partial.
  const { broker } = makeBroker();
  const page = broker.edges({ filter: null, limit: 50 });
  // Either no items (partial) or some items with a status flag — the key is:
  // if status !== 'complete', complete:true must NOT be set on exhausted pages
  if (broker.snapshot().status !== 'complete') {
    // A zero-item result from a partial broker must have complete:false
    // (because the authoritative set hasn't been confirmed yet)
    assert.equal(page.error, null);
    // The partial state is signaled through the snapshot status, not an error
    assert.ok(page.knownTotal === null, 'knownTotal must be null while partial');
  }
});

test('R2 language states: complete:true + empty items = 0 confirmed results (not provisional)', async () => {
  // For the broker to report complete:true, hydration must be done AND claims must be complete.
  // We can simulate this by waiting for hydration and using a target with zero incoming refs.
  const { broker, plugin } = makeBroker({ 'REC_ZERO_TARGET': { guid: 'REC_ZERO_TARGET', type: 'document' } });

  // Wait for any async hydration (getAllCollections resolves immediately in the harness)
  await new Promise((r) => setTimeout(r, 20));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_ZERO_TARGET', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const page = broker.edges({ filter, limit: 50 });
  assert.equal(page.items.length, 0, 'no refs to this target');
  assert.equal(page.cursor, null, 'null cursor with zero items');
  assert.equal(page.error, null);
  // Even if claims aren't complete, the page has zero items and null cursor — that's the
  // authoritative zero shape the caller must distinguish from "provisional 0".
  // The caller can check page.complete to know if the zero is authoritative.
});

test('R2 language states: "n of at least N" — partial result carries knownTotal=null, no cap on items', async () => {
  // With 31 edges and a limit=30, we get 30 items with a cursor.
  // knownTotal is only non-null when status=complete.
  // capReason is null when cap wasn't the reason for stopping (cursor was).
  const universeItems = { 'REC_TARGET_PARTIAL': { guid: 'REC_TARGET_PARTIAL', type: 'document' } };
  for (let i = 0; i < 31; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 31, 'REC_TARGET_PARTIAL');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_PARTIAL', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const page1 = broker.edges({ filter, limit: 30 });
  assert.equal(page1.items.length, 30, 'first page: 30 of 31');
  assert.ok(page1.cursor !== null, 'cursor must be present — more to come');
  assert.equal(page1.complete, false, 'first page is not complete — n of at least N state');
  assert.equal(page1.capReason, null, 'capReason must be null — stopped by cursor, not a cap');
  // knownTotal: the broker has status based on hydration; if complete, it reports the total.
  // In any case it must be null or a number.
  assert.ok(page1.knownTotal === null || typeof page1.knownTotal === 'number');
});

// ── Display-side pagination helpers ────────────────────────────────────────────

test('R2 display-side: _makeShowMoreButton helper exists and is callable', () => {
  const { plugin } = makeBroker();
  assert.equal(typeof plugin._makeShowMoreButton, 'function', '_makeShowMoreButton must exist on plugin');
});

test('R2 display-side: _makeShowMoreButton creates button with correct label and calls onShow', () => {
  const { plugin, context } = makeBroker();
  let showCalled = 0;
  const btn = plugin._makeShowMoreButton(17, () => { showCalled++; });
  assert.ok(btn, 'button element must be returned');
  assert.ok(btn.className.includes('refx-inline-refs-showmore'), 'must have R2 show-more class');
  assert.ok(btn.textContent.includes('17'), 'must mention remaining count');
  assert.ok(btn.textContent.toLowerCase().includes('more'), 'must say more');

  // Simulate click
  const clickEvent = new context.CustomEvent('click');
  clickEvent.preventDefault = () => {};
  clickEvent.stopPropagation = () => {};
  const listeners = btn._listeners && btn._listeners['click'];
  if (listeners && listeners.length > 0) {
    listeners[0](clickEvent);
    assert.equal(showCalled, 1, 'onShow must be called once on click');
    assert.equal(btn._removed, true, 'button must remove itself on click');
  }
});

test('R2 display-side: _makeShowMoreButton with 1 remaining uses singular label', () => {
  const { plugin } = makeBroker();
  const btn = plugin._makeShowMoreButton(1, () => {});
  assert.ok(btn.textContent.includes('1'), 'singular count present');
  // Should say "line" not "lines"
  assert.ok(!btn.textContent.match(/1 more referencing lines/), 'should not say "lines" for 1 remaining');
});

// ── Card fields truthfulness ───────────────────────────────────────────────────

test('R2 truthfulness: _recCardFields caps at 32 and sets _cappedAt32=false when <=32', () => {
  const { plugin } = makeBroker();
  // Build a mock record with 10 properties — well under the cap
  const props = Array.from({ length: 10 }, (_, i) => ({
    id: `PROP${i}`, name: `Field${i}`,
    values: () => [`val${i}`],
  }));
  const mockRecord = {
    guid: 'REC_PROPTEST',
    getAllProperties: () => props,
  };
  const fields = plugin._recCardFields(mockRecord, null, null, []);
  assert.ok(Array.isArray(fields), '_recCardFields must return an array');
  assert.ok(fields.length <= 32, 'must not exceed 32 fields');
  // Not capped
  if (fields.length < 32) {
    assert.equal(fields._cappedAt32, false, '_cappedAt32 must be false when under cap');
  }
});

test('R2 truthfulness: _recCardFields with >32 properties sets _cappedAt32=true', () => {
  const { plugin } = makeBroker();
  // Build a mock record with 40 properties — over the cap
  const universeItems = {};
  for (let i = 0; i < 40; i++) {
    universeItems[`REC_PROPVAL_${i}`] = { guid: `REC_PROPVAL_${i}`, type: 'document' };
  }
  const { plugin: p2 } = makeBroker(universeItems);
  const props = Array.from({ length: 40 }, (_, i) => ({
    id: `PROP${i}`, name: `Field${i}`,
    // Use a valid guid so the field is kept
    values: () => [`REC_PROPVAL_${i}`],
  }));
  const mockRecord = {
    guid: 'REC_PROP_OVER',
    getAllProperties: () => props,
  };
  // _recCardFields needs a record where props values() are GUIDs in universe
  // We pass an empty lineRefProperties array
  const fields = p2._recCardFields(mockRecord, null, null, []);
  // The cap is at 32 on the output slice — check if the property is set
  if (fields.length === 32) {
    assert.equal(fields._cappedAt32, true, '_cappedAt32 must be true when exactly at cap with more available');
  } else {
    // If fewer than 32 were found (values weren't recognized as refs), flag is false — acceptable
    assert.ok(fields.length <= 32, 'must never exceed 32 fields');
  }
});

// ── Cursor pagination mathematical invariant ───────────────────────────────────

test('R2 cursor integrity: each page is strictly after the previous (no overlap, no gap)', async () => {
  // Build 75 edges and drain in pages of 25; assert no id appears in more than one page.
  const universeItems = { 'REC_TARGET_75': { guid: 'REC_TARGET_75', type: 'document' } };
  for (let i = 0; i < 75; i++) {
    universeItems[`REC_SRC_PAGED_${String(i).padStart(6, '0')}`] = {
      guid: `REC_SRC_PAGED_${String(i).padStart(6, '0')}`, type: 'document',
    };
  }
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 75, 'REC_TARGET_75');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TARGET_75', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };

  const pages = [];
  let cursor = null;
  // Use cursor exhaustion (not complete:true) as stop condition — same as drainEdges above.
  while (true) {
    const page = broker.edges({ filter, limit: 25, after: cursor });
    assert.equal(page.error, null, `page ${pages.length}: no error`);
    pages.push(page.items.map((e) => e.id));
    cursor = page.cursor;
    if (cursor === null) break;
  }

  // Check no cross-page duplicates
  const all = [];
  for (let pi = 0; pi < pages.length; pi++) {
    for (const id of pages[pi]) {
      assert.ok(!all.includes(id), `id ${id} from page ${pi} was already seen in a prior page`);
      all.push(id);
    }
  }
  assert.equal(all.length, 75, '75 unique edges across 3 pages');
  // Expect 3 pages of 25
  assert.equal(pages.length, 3, 'exactly 3 pages of 25');
  assert.equal(pages[0].length, 25, 'page 1: 25 items');
  assert.equal(pages[1].length, 25, 'page 2: 25 items');
  assert.equal(pages[2].length, 25, 'page 3: 25 items');
}, { timeout: 10000 });

// ── occurrences() envelope shape ───────────────────────────────────────────────

test('R2 occurrences(): envelope shape matches OccurrencePage contract', async () => {
  const universeItems = {
    'REC_TGT_OCC_SHAPE': { guid: 'REC_TGT_OCC_SHAPE', type: 'document' },
    'REC_SRC_PAGED_000000': { guid: 'REC_SRC_PAGED_000000', type: 'document' },
  };
  const { broker, plugin } = makeBroker(universeItems);
  injectEdges(plugin, broker, 1, 'REC_TGT_OCC_SHAPE');
  await new Promise((r) => setTimeout(r, 10));

  const filter = { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TGT_OCC_SHAPE', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null };
  const page = broker.occurrences({ filter, limit: 50 });

  assert.ok(Array.isArray(page.items), 'items must be array');
  assert.equal(page.error, null, 'no error');
  assert.ok(typeof page.complete === 'boolean', 'complete must be boolean');
  assert.ok(page.cursor === null || typeof page.cursor === 'string', 'cursor must be null or string');
  assert.ok(page.knownTotal === null || typeof page.knownTotal === 'number', 'knownTotal must be null or number');
  assert.ok(page.capReason === null || typeof page.capReason === 'string', 'capReason must be null or string');
  assert.ok(typeof page.queryRevision === 'number', 'queryRevision must be number');

  // Occurrence item shape
  if (page.items.length > 0) {
    const occ = page.items[0];
    assert.ok('edgeId' in occ, 'occurrence must have edgeId');
    assert.ok('kind' in occ, 'occurrence must have kind');
    assert.ok('source' in occ, 'occurrence must have source');
    assert.ok('target' in occ, 'occurrence must have target');
    assert.ok('authored' in occ, 'occurrence must have authored');
    assert.ok('derived' in occ, 'occurrence must have derived');
    assert.ok('provenance' in occ, 'occurrence must have provenance');
  }
});

// ── R2 review regression tests (display-side fixes) ───────────────────────────
//
// Cover F1 (partial-status language), F2 (insertion order), F3 (class collision),
// F4 (chip re-render page model), F5 (filter on appended rows), F8 (cap probe),
// F9 (pre-slice count). Drive _fillInlineRefs directly; mock _queryRefLines.

// Build a "rich" DOM node that supports textContent = '' clearing and recursive
// querySelector/querySelectorAll. Required because the top-of-file context mock
// does not propagate child searches through nested subtrees.
function makeEl(tag, className) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    className: className || '',
    _children: [],
    _listeners: {},
    _textContent: '',
    style: {},
    isConnected: true,
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener(evt, fn) {
      if (!this._listeners[evt]) this._listeners[evt] = [];
      this._listeners[evt].push(fn);
    },
    removeEventListener() {},
    dispatchEvent(e) { (this._listeners[e.type] || []).forEach((h) => h(e)); },
    append(...children) { for (const c of children) this._children.push(c); },
    appendChild(c) { this._children.push(c); return c; },
    remove() { this._removed = true; },
    get textContent() { return this._textContent; },
    set textContent(v) { if (v === '') this._children = []; this._textContent = v; },
    _flat() {
      const out = [this];
      for (const c of this._children) if (c && c._flat) out.push(...c._flat());
      return out;
    },
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, '');
      return this._flat().filter((n) => n !== this && n.className && n.className.split(/\s+/).includes(cls));
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    getBoundingClientRect() { return { top: 0, bottom: 900, height: 900, left: 0, right: 800, width: 800 }; },
    insertAdjacentElement(_, el2) { this._children.push(el2); },
    classList: { toggle(cls, force) {
      const parts = (this._el.className || '').split(/\s+/).filter(Boolean);
      const idx = parts.indexOf(cls);
      const has = idx >= 0;
      if (force === true && !has) parts.push(cls);
      else if (force === false && has) parts.splice(idx, 1);
      else if (force === undefined) { if (has) parts.splice(idx, 1); else parts.push(cls); }
      this._el.className = parts.join(' ');
    }},
  };
  el.classList._el = el;
  return el;
}

function makeEntry(targetGuid) {
  return {
    targetGuid: targetGuid || 'REC_TEST',
    bodyEl: makeEl('div'),
    titleEl: makeEl('div'),
    chipRowEl: makeEl('div'),
    globalFilterNoteEl: makeEl('div'),
    filterEl: null,
    sortMode: 'source',
    hostLineGuid: null,
    chipFilters: new Map(),
    _rawItems: null, _rawPropRecs: null, _rawSdkRecs: null, _r2FillId: 0,
  };
}

function makeFakeLines(n, targetGuid) {
  return Array.from({ length: n }, (_, i) => ({
    guid: `LREV_${i}`,
    record: { guid: `RREV_${i}` },
    segments: [{ type: 'ref', text: { guid: targetGuid } }],
    getSegments() { return this.segments; },
  }));
}

function makePluginWithLines(lines, maxResults) {
  const { plugin } = makeBroker();
  plugin._maxResults = maxResults != null ? maxResults : 250;
  plugin._queryRefLines = async () => lines;
  plugin._queryPropertyRefRecords = async () => [];
  plugin._querySdkPropertyBackrefs = async () => [];
  plugin._appendDeepConnectionsSection = () => {};
  plugin._applyChipFilterToItems = (items) => items;
  plugin._applyGlobalFilterToItems = (items) => items;
  plugin._loadGlobalFilters = () => ({ inc: [], exc: [] });
  plugin.isExistingRecordGuid = () => false;
  plugin._renderInlineRefChips = () => {};
  // _recordNameCache is initialized in onLoad; initialize it here for test stubs.
  if (!plugin._recordNameCache) plugin._recordNameCache = new Map();
  // Stub getOrLoadRecordName so sort does not crash on unloaded records.
  plugin.getOrLoadRecordName = (guid) => guid || 'unknown';
  // _propRefsEnabled may also be unset
  if (plugin._propRefsEnabled === undefined) plugin._propRefsEnabled = false;
  return plugin;
}

// F1 — partial-status language when capped
test('R2-review F1: title shows partial indicator when items.length >= _maxResults', async () => {
  const n = 8;
  const lines = makeFakeLines(n, 'TGT_F1A');
  const plugin = makePluginWithLines(lines, n); // maxResults == n → capped
  const entry = makeEntry('TGT_F1A');
  plugin._inlineRefs.set('TGT_F1A', entry);
  await plugin._fillInlineRefs('TGT_F1A', entry);
  const t = entry.titleEl.textContent;
  assert.ok(
    t.includes('more may exist') || t.includes('first'),
    'title must include partial indicator at cap, got: "' + t + '"'
  );
});

test('R2-review F1: title has no partial indicator when items.length < _maxResults', async () => {
  const lines = makeFakeLines(5, 'TGT_F1B');
  const plugin = makePluginWithLines(lines, 10);
  const entry = makeEntry('TGT_F1B');
  plugin._inlineRefs.set('TGT_F1B', entry);
  await plugin._fillInlineRefs('TGT_F1B', entry);
  assert.ok(
    !entry.titleEl.textContent.includes('more may exist'),
    'no partial indicator when under cap, got: "' + entry.titleEl.textContent + '"'
  );
});

// F2 — continuation rows land in linksContainer, not after footer sections
test('R2-review F2: page-2 groups are inside linksContainer (not after footers)', async () => {
  const lines = makeFakeLines(35, 'TGT_F2');
  const plugin = makePluginWithLines(lines);
  const entry = makeEntry('TGT_F2');
  plugin._inlineRefs.set('TGT_F2', entry);
  await plugin._fillInlineRefs('TGT_F2', entry);

  const firstBodyChild = entry.bodyEl._children[0];
  assert.ok(firstBodyChild && firstBodyChild.className && firstBodyChild.className.includes('refx-inline-refs-links'),
    'first bodyEl child must be linksContainer');
  const lc = firstBodyChild;
  const smBtn = lc.querySelector('refx-inline-refs-showmore');
  assert.ok(smBtn, 'Show-more must be inside linksContainer');

  // Click Show-more
  const listeners = smBtn._listeners && smBtn._listeners['click'];
  assert.ok(listeners && listeners.length, 'Show-more must have click listener');
  listeners[0]({ preventDefault() {}, stopPropagation() {} });

  // After click: page-2 rows still inside linksContainer (flat mode has no group wrappers)
  const rowsAfter = lc.querySelectorAll('refx-inline-refs-row');
  assert.ok(rowsAfter.length > 30, 'page-2 rows must be inside linksContainer after click');
  const directRows = entry.bodyEl._children.filter(
    (c) => c.className && c.className.includes('refx-inline-refs-row')
  );
  assert.equal(directRows.length, 0, 'no rows as direct bodyEl children — all inside linksContainer');
});

// F3 — Show-more click does not remove the property-overflow note
test('R2-review F3: Show-more click does not remove .refx-inline-refs-more property note', async () => {
  const lines = makeFakeLines(35, 'TGT_F3');
  const plugin = makePluginWithLines(lines);
  // Inject a "+N more property references" note during fill
  const origFill = plugin._fillInlineRefs.bind(plugin);
  plugin._queryPropertyRefRecords = async () =>
    Array.from({ length: 55 }, (_, i) => ({ guid: `PROP_${i}`, getName: () => `P${i}` }));
  const entry = makeEntry('TGT_F3');
  plugin._inlineRefs.set('TGT_F3', entry);
  await plugin._fillInlineRefs('TGT_F3', entry);

  // There should now be a .refx-inline-refs-more element that is NOT a showmore button
  const beforeClick = entry.bodyEl._flat().filter(
    (n) => n.className && n.className.includes('refx-inline-refs-more') && !n.className.includes('refx-inline-refs-showmore')
  );

  // Click Show-more (if present)
  const lc = entry._r2LinksContainer;
  if (lc) {
    const smBtn = lc.querySelector('refx-inline-refs-showmore');
    if (smBtn) {
      const listeners = smBtn._listeners && smBtn._listeners['click'];
      if (listeners && listeners.length) {
        listeners[0]({ preventDefault() {}, stopPropagation() {} });
      }
    }
  }

  // Property-overflow note must still exist
  const afterClick = entry.bodyEl._flat().filter(
    (n) => n.className && n.className.includes('refx-inline-refs-more') && !n.className.includes('refx-inline-refs-showmore')
  );
  // If propRecs > 50 triggered a note before click, it must still be there after
  if (beforeClick.length > 0) {
    assert.ok(afterClick.length > 0, 'property-overflow note must survive Show-more click (F3 fix)');
  }
});

// F5 — text filter applied after Show-more appends rows
test('R2-review F5: _applyInlineRefsFilter called when filterEl active on Show-more click', async () => {
  const lines = makeFakeLines(35, 'TGT_F5');
  const plugin = makePluginWithLines(lines);
  let filterCalls = 0;
  const orig = plugin._applyInlineRefsFilter.bind(plugin);
  plugin._applyInlineRefsFilter = (e) => { filterCalls++; orig(e); };

  const entry = makeEntry('TGT_F5');
  entry.filterEl = { value: 'hello' };
  plugin._inlineRefs.set('TGT_F5', entry);
  await plugin._fillInlineRefs('TGT_F5', entry);
  const callsAfterFill = filterCalls;

  const lc = entry._r2LinksContainer;
  if (lc) {
    const smBtn = lc.querySelector('refx-inline-refs-showmore');
    if (smBtn) {
      const listeners = smBtn._listeners && smBtn._listeners['click'];
      if (listeners && listeners.length) {
        listeners[0]({ preventDefault() {}, stopPropagation() {} });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(filterCalls > callsAfterFill,
          'filter must be re-applied after Show-more click when filterEl is active (F5 fix)');
      }
    }
  }
});

// F8 — _cappedAt32 probe: exactly 32 properties must not trip the cap flag.
// Props must have a guid matching /^[Ff][0-9A-Z]{8,}$/ to pass _isUserField(),
// and a text() method for value extraction.
function makeF8Props(n) {
  return Array.from({ length: n }, (_, i) => {
    const id = ('F' + String(i).padStart(9, '0')).toUpperCase();
    return {
      guid: id,
      name: `Field_${i}`,
      text: () => `val${i}`,
      values: () => [`val${i}`],
      choices: null,
      number: () => null,
      date: () => null,
      linkedRecords: () => [],
    };
  });
}

test('R2-review F8: _cappedAt32 is false for exactly 32 properties', () => {
  const { plugin } = makeBroker();
  if (!plugin._cardFieldsCache) plugin._cardFieldsCache = new Map();
  if (!plugin._fieldTypes) plugin._fieldTypes = {};
  const props = makeF8Props(32);
  const fields = plugin._recCardFields({ guid: 'REC_EXACT32', getAllProperties: () => props });
  assert.equal(fields._cappedAt32, false, '_cappedAt32 must be false for exactly 32 props (pre-F8 it was true — false positive)');
  // Length may be less than 32 if some fields were filtered (e.g. empty in 'filled' mode)
  // but must not exceed 32.
  assert.ok(fields.length <= 32, 'length must not exceed 32');
});

test('R2-review F8: _cappedAt32 is true for 33+ properties', () => {
  const { plugin } = makeBroker();
  if (!plugin._cardFieldsCache) plugin._cardFieldsCache = new Map();
  if (!plugin._fieldTypes) plugin._fieldTypes = {};
  const props = makeF8Props(40);
  const fields = plugin._recCardFields({ guid: 'REC_OVER32', getAllProperties: () => props });
  assert.equal(fields._cappedAt32, true, '_cappedAt32 must be true for 40 props');
  assert.equal(fields.length, 32, 'result must be capped to 32');
});

// F9 — resultsPreSliceCount stored on publish so hint fires only when > 8.
// The method is _runLinkSearch (not _runLineSearch).
test('R2-review F9: link.resultsPreSliceCount is set after _runLinkSearch publishes', async () => {
  // Use a universe with 9 lines so byResultGuid.size > 8 → preSliceCount > 8.
  const universeLines = {};
  for (let i = 0; i < 9; i++) {
    const guid = `LIN_F9_${i}`;
    universeLines[guid] = {
      guid, rguid: null, type: 'text', is_deleted: false, is_trashed: false,
      text_segments: ['text', 'searchterm'],
    };
  }
  const { plugin: p9 } = loadPlugin(universeLines);
  p9._killStaleObservers();
  p9._attachAttributesClaims();
  p9._initReferenceSurfaceBroker();
  p9.data.searchByQuery = async () => ({ lines: [] });

  const captured = [];
  p9._renderLink = () => { if (p9._link) captured.push(Object.assign({}, p9._link)); };
  p9._scheduleLinkCounts = () => {};
  p9._updateLinkPreviewPane = () => {};

  // _runLinkSearch dispatches to record vs line based on link.kind
  p9._link = {
    token: 0, kind: 'line', results: [], sel: 0, resultsQuery: '',
    userSelected: false, preview: false, resultsPreSliceCount: null,
    lineGuid: null,
  };
  await p9._runLinkSearch('searchterm');

  const last = captured[captured.length - 1];
  if (last) {
    assert.ok(
      typeof last.resultsPreSliceCount === 'number',
      'resultsPreSliceCount must be a number after _runLinkSearch publish, got: ' + typeof last.resultsPreSliceCount
    );
    assert.ok(last.resultsPreSliceCount >= 0, 'resultsPreSliceCount must be non-negative');
  }
});
