'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

function makePlugin() {
  const storage = new Map();
  const context = {
    AppPlugin: class {}, console, Promise, Date, Math, Map, Set, WeakMap, WeakSet,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false }), 0), cancelIdleCallback: clearTimeout,
    performance, CSS: { escape: String },
    navigator: { platform: 'MacIntel', clipboard: {} },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    document: {
      querySelectorAll: () => [], querySelector: () => null,
      documentElement: { clientHeight: 900 }, body: { append() {}, appendChild() {} }, head: { appendChild() {} },
      createElement: () => ({ style: {}, dataset: {}, append() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } }),
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    },
    window: {
      CSS: { escape: String }, g_universe: { itemsByGuid: {}, workspace: { guid: 'WS_A6' }, listviews: [] },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    },
    Element: class {}, MutationObserver: class { observe() {} disconnect() {} },
  };
  context.globalThis = context; Object.assign(context, context.window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  const plugin = new context.PluginUnderTest();
  plugin.workspaceGuid = 'WS_A6'; plugin._unloaded = false; plugin._aliasInit();
  plugin.data = { getRecord: () => null, getAllCollections: async () => [] };
  return { plugin, storage };
}

function edge(id, targetGuid, title) {
  return { id, kind: 'ref', title, authored: true, target: { kind: 'record', guid: targetGuid }, source: { recordGuid: 'SRC_' + id, lineGuid: 'LINE_' + id } };
}

function makeBroker(edges, resolveMap, options = {}) {
  let revision = 7;
  let calls = 0;
  const pageSize = options.pageSize || 3;
  const status = options.status || 'complete';
  const broker = {
    generation: 'BROKER_A6',
    get revision() { return revision; },
    snapshot: () => ({ status, generation: 'BROKER_A6', revision }),
    resolveTarget: (guid) => resolveMap[guid] || null,
    edges(params) {
      calls++;
      const start = params.after ? Number(params.after) : 0;
      const items = edges.slice(start, start + pageSize);
      const cursor = start + pageSize < edges.length ? String(start + pageSize) : null;
      const queryRevision = revision;
      if (options.bumpDuringFirstPage && calls === 1) revision++;
      return { items, cursor, error: null, complete: cursor == null, knownTotal: edges.length, capReason: null, queryRevision };
    },
  };
  return broker;
}

test('A6 frequent-alias scan uses broker refs, threshold 3, and emits one best suggestion per target', async () => {
  const { plugin } = makePlugin();
  const edges = [
    edge('F1', 'TARGET_A', 'Frequently Used'), edge('F2', 'TARGET_A', ' frequently\u00a0used '),
    edge('F3', 'TARGET_A', 'Frequently Used'), edge('F4', 'TARGET_A', 'Frequently Used'),
    edge('S1', 'TARGET_A', 'Second Choice'), edge('S2', 'TARGET_A', 'Second Choice'), edge('S3', 'TARGET_A', 'Second Choice'),
    edge('T1', 'TARGET_A', 'Too Few'), edge('T2', 'TARGET_A', 'Too Few'),
    edge('B1', 'TARGET_B', 'Other Shortcut'), edge('B2', 'TARGET_B', 'Other Shortcut'), edge('B3', 'TARGET_B', 'Other Shortcut'),
    edge('C1', 'TARGET_A', 'Canonical A'),
    edge('E1', 'TARGET_A', 'Existing Alias'), edge('E2', 'TARGET_A', 'Existing Alias'), edge('E3', 'TARGET_A', 'Existing Alias'),
  ];
  plugin._aliasReplaceRecordSet('TARGET_A', [plugin._aliasMakeItem('Existing Alias', 'registry')]);
  plugin._referenceSurfaceBroker = makeBroker(edges, {
    TARGET_A: { guid: 'TARGET_A', kind: 'record', name: 'Canonical A' },
    TARGET_B: { guid: 'TARGET_B', kind: 'record', name: 'Canonical B' },
  }, { status: 'degraded' });

  assert.equal(await plugin._aliasRunFrequentScan(plugin._aliasGeneration), true);
  assert.equal(plugin._aliasFrequentSuggestions.size, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(plugin._aliasFrequentSuggestions.get('TARGET_A'))), {
    kind: 'record', targetGuid: 'TARGET_A', recordGuid: 'TARGET_A', lineGuid: null,
    query: 'Frequently Used', normalized: 'frequently used', realTitle: 'Canonical A', count: 4,
  });
  assert.equal(plugin._aliasFrequentSuggestions.get('TARGET_B').query, 'Other Shortcut');
  assert.equal(plugin._aliasFrequentSuggestions.has('Too Few'), false);
});

test('L3 frequent-alias scan learns one best line suggestion after three distinct authored edges', async () => {
  const { plugin } = makePlugin();
  plugin._lineAliasInit();
  const edges = [
    edge('L1', 'LINE_TARGET', 'Old finding'), edge('L2', 'LINE_TARGET', ' old\u00a0finding '),
    edge('L3', 'LINE_TARGET', 'Old finding'), edge('L4', 'LINE_TARGET', 'Second line name'),
    edge('L5', 'LINE_TARGET', 'Second line name'), edge('L6', 'LINE_TARGET', 'Second line name'),
  ];
  plugin._referenceSurfaceBroker = makeBroker(edges, {
    LINE_TARGET: { guid: 'LINE_TARGET', kind: 'line', recordGuid: 'OWNER_A', name: 'Current finding' },
  });

  assert.equal(await plugin._aliasRunFrequentScan(plugin._aliasGeneration), true);
  assert.equal(plugin._aliasFrequentSuggestions.size, 0);
  assert.equal(plugin._lineAliasFrequentSuggestions.size, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(plugin._lineAliasFrequentSuggestions.get('LINE_TARGET'))), {
    kind: 'line', targetGuid: 'LINE_TARGET', recordGuid: 'OWNER_A', lineGuid: 'LINE_TARGET',
    query: 'Old finding', normalized: 'old finding', realTitle: 'Current finding', count: 3,
  });
});

test('L3 line promotion dismissal is line-scoped and separate from record promotion state', () => {
  const { plugin, storage } = makePlugin();
  plugin._lineAliasInit();
  plugin._lineAliasDismissPromotion('LINE_A', 'Short name');
  assert.equal(plugin._lineAliasShouldOfferPromotion('LINE_A', 'Short name'), false);
  assert.equal(plugin._lineAliasShouldOfferPromotion('LINE_B', 'Short name'), true);
  assert.equal(plugin._aliasShouldOfferPromotion('LINE_A', 'Short name'), true);
  assert.ok(storage.has(plugin._LINE_ALIAS_PROMOTION_DISMISS_KEY));
  assert.equal(storage.has(plugin._ALIAS_PROMOTION_DISMISS_KEY), false);
});

test('A6 frequent-alias scan discards a result when the broker revision changes mid-scan', async () => {
  const { plugin } = makePlugin();
  const sentinel = Object.freeze({ recordGuid: 'OLD', query: 'Keep me', count: 3 });
  plugin._aliasFrequentSuggestions.set('OLD', sentinel);
  plugin._referenceSurfaceBroker = makeBroker([
    edge('R1', 'TARGET', 'Candidate'), edge('R2', 'TARGET', 'Candidate'), edge('R3', 'TARGET', 'Candidate'),
  ], { TARGET: { guid: 'TARGET', kind: 'record', name: 'Canonical' } }, { bumpDuringFirstPage: true });

  assert.equal(await plugin._aliasRunFrequentScan(plugin._aliasGeneration), false);
  assert.equal(plugin._aliasFrequentSuggestions.get('OLD'), sentinel, 'stale scans must not replace the last stable suggestions');
  assert.equal(plugin._aliasFrequentSuggestions.has('TARGET'), false);
});

test('A6 idle scan is canceled by alias disposal before it can run', async () => {
  const { plugin } = makePlugin();
  let calls = 0;
  plugin._aliasRunFrequentScan = async () => { calls++; return true; };
  plugin._aliasScheduleFrequentScan(25);
  plugin._aliasDispose();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(calls, 0);
});
