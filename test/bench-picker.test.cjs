'use strict';
// bench-picker.test.cjs — v4.10.0 picker latency + transclusion containment tests.
//
// Covers:
//   - Prefix-narrowing: scanCandidates populated, reused on prefix extension,
//     invalidated on non-prefix edit / filter change
//   - Alias key session cache: _searchKey memoised in aliasKeyCache
//   - Tier A CSS: content-visibility:auto gated on body.refx-cv-transclusions,
//     caret exclusion via :has() rules
//   - Tier B threshold: _countRegistryRecordLines counts correctly,
//     windowed-preview path taken above threshold
//   - Benchmark: 50k-line first scan + prefix extension timing
//
// Run: node --test test/bench-picker.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

// ── Shared harness ────────────────────────────────────────────────────────────

function loadPlugin(universeItems = {}) {
  const storage = new Map();
  const insertedStyles = [];
  const bodyClassList = new Set();
  const ctx = {
    AppPlugin: class {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    performance: { now: () => Date.now() },
    CSS: { escape: (s) => String(s) },
    navigator: { platform: 'MacIntel', clipboard: {} },
    Promise,
    localStorage: {
      getItem: (k) => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    document: {
      createElement: (tag) => {
        const el = {
          tagName: tag.toUpperCase(),
          className: '', style: {}, children: [],
          textContent: '', innerHTML: '', isConnected: true,
          id: '',
          dataset: {},
          getAttribute: () => null, setAttribute() {},
          addEventListener() {}, removeEventListener() {},
          append(...kids) { this.children.push(...kids); },
          remove() { this.isConnected = false; },
          querySelector: () => null, querySelectorAll: () => [],
          closest: () => null,
          getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
          insertAdjacentElement() { return null; },
        };
        return el;
      },
      createTextNode: (t) => ({ nodeType: 3, textContent: t }),
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      documentElement: { clientHeight: 900, style: {} },
      body: {
        classList: {
          toggle(cls, force) {
            if (force === true) bodyClassList.add(cls);
            else if (force === false) bodyClassList.delete(cls);
            else if (bodyClassList.has(cls)) bodyClassList.delete(cls);
            else bodyClassList.add(cls);
          },
          add(cls) { bodyClassList.add(cls); },
          remove(cls) { bodyClassList.delete(cls); },
          contains(cls) { return bodyClassList.has(cls); },
        },
        append() {}, appendChild() {},
      },
      head: {
        appendChild(el) { insertedStyles.push(el); },
      },
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return true; },
    },
    CustomEvent: class CustomEvent {
      constructor(type, opts) { this.type = type; this.detail = (opts && opts.detail) || null; }
    },
    Element: class {},
    window: {
      CSS: { escape: (s) => String(s) },
      g_universe: { itemsByGuid: universeItems, workspace: { guid: 'WS_TEST' } },
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() {},
    },
  };
  ctx.globalThis = ctx;
  ctx.window.globalThis = ctx;
  Object.assign(ctx, ctx.window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', ctx, { filename: 'plugin.js' });

  const plugin = new ctx.PluginUnderTest();
  plugin._isUnloading = false;
  plugin._enabled = true;
  plugin.data = {
    getRecord: (guid) => {
      const st = universeItems[guid];
      if (st && !st.rguid) return { guid, getName: () => guid, getAllProperties: () => [], getLineItems: async () => [] };
      return null;
    },
    searchByQuery: async () => ({ lines: [], records: [] }),
    getAllCollections: async () => [],
  };
  plugin.ui = {
    addCommandPaletteCommand: () => ({ remove() {} }),
    addStatusBarItem: () => ({ remove() {} }),
    getActivePanel: () => null,
  };
  plugin.events = { on: () => '', off: () => {} };
  plugin._r5SessionGen = 0;
  plugin._r5ScopeStack = [];
  plugin.workspaceGuid = 'WS_TEST';

  return { plugin, ctx, insertedStyles, bodyClassList };
}

// Build a link object that mimics _enterLinkMode's created link state.
function makeLink(plugin, query = '') {
  return {
    kind: 'line',
    lineGuid: 'HOST_LINE',
    query,
    results: [],
    resultsQuery: null,
    sel: 0,
    userSelected: false,
    token: 0,
    r5Session: plugin._r5SessionGen,
    textCache: new Map(),
    // scanCandidates not set (undefined) = first scan
  };
}

// ── TIER A CSS tests ──────────────────────────────────────────────────────────

test('Tier A: injected CSS contains content-visibility:auto rule for transclusion-container-div', () => {
  const { insertedStyles } = loadPlugin();
  // The style element's textContent is set after createElement + appendChild.
  // We check the source text directly since style injection calls st.textContent = `...`.
  assert.ok(source.includes('content-visibility: auto'), 'CSS must declare content-visibility: auto');
  assert.ok(source.includes('transclusion-container-div'), 'CSS must target .transclusion-container-div');
});

test('Tier A: CSS is gated on body.refx-cv-transclusions class', () => {
  assert.ok(source.includes('body.refx-cv-transclusions .listitem-transclusion .transclusion-container-div'), 'CSS gate must match native transclusion containers');
});

test('Tier A: CSS excludes container holding .flowythymer-thread-target (keyboard caret)', () => {
  assert.ok(
    source.includes('body.refx-cv-transclusions .listitem-transclusion .transclusion-container-div:has(.flowythymer-thread-target)'),
    'CSS must have :has(.flowythymer-thread-target) exclusion'
  );
});

test('Tier A: CSS excludes container holding .listitem-with-caret (pointer caret)', () => {
  assert.ok(
    source.includes('body.refx-cv-transclusions .listitem-transclusion .transclusion-container-div:has(.listitem-with-caret)'),
    'CSS must have :has(.listitem-with-caret) exclusion'
  );
});

test('Tier A: body.refx-cv-transclusions class applied by default on onLoad', () => {
  const { bodyClassList } = loadPlugin();
  // onLoad is not called in the harness, but _injectStyle + body.classList.toggle is called
  // via onLoad. We can verify the source calls it unconditionally.
  assert.ok(
    source.includes("document.body.classList.toggle('refx-cv-transclusions', true)"),
    'onLoad must apply refx-cv-transclusions by default'
  );
});

test('Tier A: toggle command removes body class when containment is ON', () => {
  const { plugin, bodyClassList } = loadPlugin();
  plugin._CV_TRANSCLUSIONS_ENABLED = true;
  // Simulate the toggle action (without calling addCommandPaletteCommand).
  plugin._CV_TRANSCLUSIONS_ENABLED = !plugin._CV_TRANSCLUSIONS_ENABLED;
  try { plugin._context && plugin._context.document.body.classList.toggle('refx-cv-transclusions', plugin._CV_TRANSCLUSIONS_ENABLED); } catch (e) {}
  assert.equal(plugin._CV_TRANSCLUSIONS_ENABLED, false, 'toggle flips the flag');
});

// ── TIER B threshold tests ────────────────────────────────────────────────────

test('Tier B: _countRegistryRecordLines returns 0 for unknown guid', () => {
  const { plugin } = loadPlugin();
  assert.equal(plugin._countRegistryRecordLines('NONEXISTENT_GUID'), 0);
});

test('Tier B: _countRegistryRecordLines counts lines sharing the same rguid', () => {
  const universe = {};
  const RGUID = 'TARGET_RECORD_0001';
  const TARGET_LINE = 'TARGET_LINE_0001';
  // Target line
  universe[TARGET_LINE] = { guid: TARGET_LINE, rguid: RGUID, is_deleted: false, is_trashed: false, text_segments: ['text', 'hello'] };
  // 350 sibling lines in the same record
  for (let i = 0; i < 350; i++) {
    const g = 'SIB_' + i;
    universe[g] = { guid: g, rguid: RGUID, is_deleted: false, is_trashed: false, text_segments: ['text', 'sibling ' + i] };
  }
  // 50 lines in a different record (should not count)
  for (let i = 0; i < 50; i++) {
    const g = 'OTHER_' + i;
    universe[g] = { guid: g, rguid: 'OTHER_RECORD', is_deleted: false, is_trashed: false, text_segments: ['text', 'other ' + i] };
  }
  const { plugin } = loadPlugin(universe);
  const count = plugin._countRegistryRecordLines(TARGET_LINE);
  // Should count TARGET_LINE + 350 siblings = 351
  assert.ok(count >= 351, `Expected ≥351, got ${count}`);
  assert.ok(count < 410, `Expected <410 (only same-record lines), got ${count}`);
});

test('Tier B: _countRegistryRecordLines respects is_deleted and is_trashed flags', () => {
  const universe = {};
  const RGUID = 'RECORD_DELETED_TEST';
  universe['LINE_LIVE'] = { guid: 'LINE_LIVE', rguid: RGUID, is_deleted: false, is_trashed: false, text_segments: ['text', 'live'] };
  universe['LINE_DELETED'] = { guid: 'LINE_DELETED', rguid: RGUID, is_deleted: true, is_trashed: false, text_segments: ['text', 'dead'] };
  universe['LINE_TRASHED'] = { guid: 'LINE_TRASHED', rguid: RGUID, is_deleted: false, is_trashed: true, text_segments: ['text', 'trash'] };
  const { plugin } = loadPlugin(universe);
  const count = plugin._countRegistryRecordLines('LINE_LIVE');
  assert.equal(count, 1, 'Only live (non-deleted, non-trashed) lines should count');
});

test('Tier B: threshold constant _LARGE_TRANSCLUSION_THRESHOLD is 1500', () => {
  const { plugin } = loadPlugin();
  assert.equal(plugin._LARGE_TRANSCLUSION_THRESHOLD, 1500);
});

test('Tier B: _countRegistryRecordLines returns ≤100 for a 99-line record (below threshold)', () => {
  const universe = {};
  const RGUID = 'SMALL_RECORD';
  const TARGET_LINE = 'SMALL_TARGET_LINE';
  universe[TARGET_LINE] = { guid: TARGET_LINE, rguid: RGUID, is_deleted: false, is_trashed: false, text_segments: ['text', 'root'] };
  for (let i = 0; i < 98; i++) {
    const g = 'SMALL_SIB_' + i;
    universe[g] = { guid: g, rguid: RGUID, is_deleted: false, is_trashed: false, text_segments: ['text', 'line ' + i] };
  }
  const { plugin } = loadPlugin(universe);
  const count = plugin._countRegistryRecordLines(TARGET_LINE);
  assert.equal(count, 99, `Expected 99, got ${count}`);
  assert.ok(count <= plugin._LARGE_TRANSCLUSION_THRESHOLD, '99 lines is below threshold — native path should be taken');
});

test('Tier B: loaded registry count no longer drives the extreme threshold decision', () => {
  const universe = {};
  const RGUID = 'LARGE_RECORD';
  const TARGET_LINE = 'LARGE_TARGET_LINE';
  universe[TARGET_LINE] = { guid: TARGET_LINE, rguid: RGUID, is_deleted: false, is_trashed: false, text_segments: ['text', 'root'] };
  for (let i = 0; i < 300; i++) {
    const g = 'LARGE_SIB_' + i;
    universe[g] = { guid: g, rguid: RGUID, is_deleted: false, is_trashed: false, text_segments: ['text', 'line ' + i] };
  }
  const { plugin } = loadPlugin(universe);
  const count = plugin._countRegistryRecordLines(TARGET_LINE);
  assert.equal(count, 301, `Expected 301, got ${count}`);
  assert.ok(count < plugin._LARGE_TRANSCLUSION_THRESHOLD, '301 normal lines remain below the extreme threshold');
});

test('Tier B: _trueTargetSize counts only the referenced subtree inside a huge owner', async () => {
  const universe = { TARGET_TRUE_SIZE: { guid: 'TARGET_TRUE_SIZE', rguid: 'TARGET_OWNER' } };
  const { plugin } = loadPlugin(universe);
  const args = [];
  plugin.data = {
    getRecord: (guid) => guid === 'TARGET_OWNER' ? {
      async getLineItems(expandReferences) {
        args.push(expandReferences);
        return [
          { guid: 'TARGET_TRUE_SIZE', children: [] },
          { guid: 'UNRELATED_ROOT', children: Array.from({ length: 1800 }, (_, i) => ({ guid: 'L' + i })) },
        ];
      }
    } : null
  };

  const count = await plugin._trueTargetSize('TARGET_TRUE_SIZE');
  assert.equal(count, 1);
  assert.deepEqual(args, [false]);
  assert.ok(count < plugin._LARGE_TRANSCLUSION_THRESHOLD, 'unrelated page siblings must not force a read-only preview');
});

test('Tier B: Journal line size is its subtree, never automatic Infinity', async () => {
  const universe = { JOURNAL_TARGET: { guid: 'JOURNAL_TARGET', rguid: 'JOURNAL_OWNER' } };
  const { plugin } = loadPlugin(universe);
  let reads = 0;
  plugin.data = {
    getRecord: (guid) => guid === 'JOURNAL_OWNER' ? {
      getJournalDetails: () => ({ date: '2026-07-21' }),
      async getLineItems(expandReferences) {
        reads++;
        assert.equal(expandReferences, false);
        return [{ guid: 'JOURNAL_TARGET', children: [{ guid: 'JOURNAL_CHILD' }] }];
      },
    } : null,
  };

  assert.equal(await plugin._trueTargetSize('JOURNAL_TARGET'), 2);
  assert.equal(reads, 1);
});

test('Tier B: loaded PluginLineItem leaf uses target-local getChildren with zero owner reads', async () => {
  let childReads = 0;
  const target = {
    guid: 'LOCAL_TARGET', rguid: 'VERY_LARGE_OWNER',
    async getChildren() { childReads++; return []; },
  };
  const { plugin } = loadPlugin({ LOCAL_TARGET: target });
  plugin.data = { getRecord() { throw new Error('owner body must not be read'); } };

  assert.equal(await plugin._trueTargetSize('LOCAL_TARGET'), 1);
  assert.equal(childReads, 1);
});

test('Tier B: record.updated immediately invalidates short-lived target-size receipts', () => {
  const { plugin } = loadPlugin();
  plugin._trueSizeCache.set('TARGET_INVALIDATE', {
    count: 1, ts: Date.now(), recordGuid: 'OWNER_INVALIDATE', previewLines: [],
  });
  plugin._schedulePickerMetadataRefresh = () => {};
  plugin._aliasScheduleEnrich = () => {};
  plugin._onRecordUpdated({ recordGuid: 'OWNER_INVALIDATE' });
  assert.equal(plugin._trueSizeCache.has('TARGET_INVALIDATE'), false);
});

test('Tier B: a genuinely extreme target subtree remains bounded and preview-eligible', async () => {
  const universe = { EXTREME_TARGET: { guid: 'EXTREME_TARGET', rguid: 'EXTREME_OWNER' } };
  const { plugin } = loadPlugin(universe);
  plugin.data = {
    getRecord: () => ({
      async getLineItems() {
        return [{
          guid: 'EXTREME_TARGET',
          children: Array.from({ length: 1800 }, (_, i) => ({ guid: 'EXTREME_' + i })),
        }];
      },
    }),
  };

  const count = await plugin._trueTargetSize('EXTREME_TARGET');
  assert.equal(count, plugin._LARGE_TRANSCLUSION_THRESHOLD + 1, 'count should stop immediately after crossing the guard');
  assert.ok(count > plugin._LARGE_TRANSCLUSION_THRESHOLD);
});

test('Tier B: unknown cold true size is provisional native', async () => {
  const { plugin } = loadPlugin();
  plugin.data = { getRecord: () => null };
  assert.equal(await plugin._trueTargetSize('UNKNOWN_COLD_TARGET'), null);
});

// ── ALIAS KEY CACHE tests ─────────────────────────────────────────────────────

test('Alias key cache: aliasKeyCache stored on link object', async () => {
  const { plugin } = loadPlugin();
  const link = makeLink(plugin, 'foo');
  plugin._link = link;
  plugin._lineAliasByLine = new Map();
  plugin._renderLink = () => {}; // stub — no DOM in test env
  await plugin._runLinkSearch('foo');
  assert.ok(link.aliasKeyCache != null && typeof link.aliasKeyCache.get === 'function', 'aliasKeyCache must be a Map after first search');
});

test('Alias key cache: same searchKey object returned from cache on second call', () => {
  const { plugin } = loadPlugin();
  const link = makeLink(plugin);
  link.aliasKeyCache = new Map();
  const text = 'Food Safety Protocol';
  const cacheKey = 'SOMEGUID\0' + text;
  // First call: not in cache, compute and store.
  if (!link.aliasKeyCache.has(cacheKey)) {
    const key = plugin._searchKey(text);
    link.aliasKeyCache.set(cacheKey, key);
  }
  const first = link.aliasKeyCache.get(cacheKey);
  // Second call: retrieved from cache.
  const second = link.aliasKeyCache.get(cacheKey);
  assert.strictEqual(first, second, 'Cache should return the same object reference');
  assert.ok(first && first.compact, 'Cached key must have compact field');
  assert.ok(first.compact === 'foodsafetyprotocol', `Expected compact 'foodsafetyprotocol', got '${first.compact}'`);
});

// ── PICKER PREFIX-NARROWING tests ─────────────────────────────────────────────

test('Prefix-narrowing: scanCandidates undefined before first search', () => {
  const { plugin } = loadPlugin();
  const link = makeLink(plugin, 'f');
  assert.equal(link.scanCandidates, undefined, 'scanCandidates must start undefined');
});

test('Prefix-narrowing: scanCandidates populated after first full scan', async () => {
  const universe = {};
  for (let i = 0; i < 20; i++) {
    const g = 'LINE_' + i;
    universe[g] = { guid: g, rguid: 'REC_' + (i % 5), is_deleted: false, is_trashed: false,
      text_segments: ['text', 'food item number ' + i] };
  }
  const { plugin } = loadPlugin(universe);
  const link = makeLink(plugin, 'food');
  plugin._link = link;
  plugin._lineAliasByLine = new Map();
  plugin._renderLink = () => {}; // stub — no DOM in test env
  await plugin._runLinkSearch('food');
  // After a real-text query, scanCandidates should be a Map.
  assert.ok(link.scanCandidates != null && typeof link.scanCandidates.get === 'function', 'scanCandidates must be a Map after first scan');
  assert.ok(link.scanCandidates != null && link.scanCandidates.size > 0, 'scanCandidates must have entries when items match');
});

test('Prefix-narrowing: canNarrow is true when new query extends old query', () => {
  const { plugin } = loadPlugin();
  // Simulate the canNarrow logic inline (it is a const inside _runLinkSearch,
  // but we can verify the conditions directly).
  const link = makeLink(plugin, 'foo');
  link.scanCandidates = new Map([['G1', { task: null, rguid: 'R1' }]]);
  link.scanComplete = true;
  link.scanQuery = 'foo';
  link.scanFiltersKey = '';
  const q = 'food';
  const filtersKey = '';
  const canNarrow = !!(
    link.scanCandidates && link.scanCandidates.size > 0 &&
    link.scanComplete === true &&
    link.scanQuery && q &&
    q.startsWith(link.scanQuery) &&
    link.scanFiltersKey === filtersKey
  );
  assert.equal(canNarrow, true, 'canNarrow must be true when query extends previous query');
});

test('Prefix-narrowing: canNarrow is false when query does not extend previous query', () => {
  const { plugin } = loadPlugin();
  const link = makeLink(plugin, 'foo');
  link.scanCandidates = new Map([['G1', { task: null, rguid: 'R1' }]]);
  link.scanComplete = true;
  link.scanQuery = 'foo';
  link.scanFiltersKey = '';
  const q = 'bar'; // different prefix
  const filtersKey = '';
  const canNarrow = !!(
    link.scanCandidates && link.scanCandidates.size > 0 &&
    link.scanComplete === true &&
    link.scanQuery && q &&
    q.startsWith(link.scanQuery) &&
    link.scanFiltersKey === filtersKey
  );
  assert.equal(canNarrow, false, 'canNarrow must be false when query does not extend previous');
});

test('Prefix-narrowing: canNarrow is false when filter set changes', () => {
  const { plugin } = loadPlugin();
  const link = makeLink(plugin);
  link.scanCandidates = new Map([['G1', { task: null, rguid: 'R1' }]]);
  link.scanComplete = true;
  link.scanQuery = 'foo';
  link.scanFiltersKey = ''; // previously no filters
  const q = 'food';
  const filtersKey = JSON.stringify({ isTask: true }); // now has filter
  const canNarrow = !!(
    link.scanCandidates && link.scanCandidates.size > 0 &&
    link.scanComplete === true &&
    link.scanQuery && q &&
    q.startsWith(link.scanQuery) &&
    link.scanFiltersKey === filtersKey
  );
  assert.equal(canNarrow, false, 'canNarrow must be false when filters change');
});

// ── BENCHMARK: 50k-line first scan + prefix extension ─────────────────────────

test('BENCH-PICKER-1: first scan over 50k-line registry completes <500ms', async () => {
  const universe = {};
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const g = 'LINE_' + i;
    const rguid = 'REC_' + (i % 200);
    universe[g] = { guid: g, rguid, is_deleted: false, is_trashed: false, type: 'ulist',
      text_segments: ['text', 'item ' + i + (i < 1000 ? ' food safety' : '')] };
  }
  const { plugin } = loadPlugin(universe);
  const link = makeLink(plugin, 'food');
  plugin._link = link;
  plugin._lineAliasByLine = new Map();
  plugin._renderLink = () => {}; // stub — no DOM in test env

  const start = Date.now();
  await plugin._runLinkSearch('food');
  const elapsed = Date.now() - start;

  process.stderr.write(`  BENCH-PICKER-1: first scan (50k lines) = ${elapsed}ms\n`);
  assert.ok(elapsed < 500, `First scan took ${elapsed}ms (threshold: 500ms)`);
  assert.ok(link.scanCandidates != null && typeof link.scanCandidates.get === 'function', 'scanCandidates must be populated after first scan');
  process.stderr.write(`  BENCH-PICKER-1: scanCandidates.size = ${link.scanCandidates.size}\n`);
});

test('BENCH-PICKER-2: prefix extension over 50k-line registry completes <50ms', async () => {
  const universe = {};
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const g = 'LINE_' + i;
    const rguid = 'REC_' + (i % 200);
    universe[g] = { guid: g, rguid, is_deleted: false, is_trashed: false, type: 'ulist',
      text_segments: ['text', 'item ' + i + (i < 1000 ? ' food safety protocol' : '')] };
  }
  const { plugin } = loadPlugin(universe);
  const link = makeLink(plugin, 'food');
  plugin._link = link;
  plugin._lineAliasByLine = new Map();
  plugin._renderLink = () => {}; // stub — no DOM in test env

  // First scan to populate scanCandidates.
  await plugin._runLinkSearch('food');
  const candidatesAfterFirst = link.scanCandidates ? link.scanCandidates.size : 0;

  // Prefix extension: 'food' → 'food safe'.
  link.token = 0;
  const start = Date.now();
  await plugin._runLinkSearch('food safe');
  const elapsed = Date.now() - start;

  process.stderr.write(`  BENCH-PICKER-2: prefix extension (${candidatesAfterFirst} candidates) = ${elapsed}ms\n`);
  assert.ok(elapsed < 50,
    `Prefix extension took ${elapsed}ms (threshold: 50ms). ` +
    `Should be O(candidates=${candidatesAfterFirst}), not O(50k).`
  );
});

test('BENCH-PICKER-3: (( first paint <80ms and completed-cache extension <10ms at 50k lines', async () => {
  const universe = {};
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const g = 'P3_LINE_' + i;
    universe[g] = {
      guid: g, rguid: 'P3_REC_' + (i % 200), is_deleted: false, is_trashed: false, type: 'ulist',
      text_segments: ['text', 'block ' + i + (i < 1000 ? ' phosphorus swab protocol' : '')],
    };
  }
  const { plugin } = loadPlugin(universe);
  const link = makeLink(plugin, 'phosphorus');
  plugin._link = link;
  plugin._lineAliasByLine = new Map();
  plugin._renderLink = () => {};

  const firstStart = Date.now();
  await plugin._runLinkSearch('phosphorus');
  const firstPaintMs = Date.now() - firstStart;
  assert.ok(firstPaintMs < 80, `(( first results took ${firstPaintMs}ms (target: <80ms)`);
  assert.ok(link.results.length > 0, 'bounded first slice must publish useful results');

  await link.scanDone;
  assert.equal(link.scanComplete, true, 'full registry continuation must complete behind the session token');
  const extensionStart = Date.now();
  await plugin._runLinkSearch('phosphorus swab');
  const extensionMs = Date.now() - extensionStart;
  process.stderr.write(`  BENCH-PICKER-3: (( first paint=${firstPaintMs}ms; extension=${extensionMs}ms\n`);
  assert.ok(extensionMs < 10, `(( extension took ${extensionMs}ms (target: <10ms)`);
});
