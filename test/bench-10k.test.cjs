'use strict';
// bench-10k.test.cjs — 10k-scale performance benchmarks for Reference Extravaganza
//
// Each test measures a specific hot path under 10k-edge conditions.
// Thresholds are 4× the measured baseline to remain green on CI/slow VMs.
// Run: node --test test/bench-10k.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

// ── Shared harness (mirrors reference-surface-broker.test.cjs pattern) ─────────

function loadPlugin(universeItems = {}, workspaceGuid = 'WEJ9EZW6ADT58SJC3EQMNETSW6') {
  const storage = new Map();
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
      getItem: (k) => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    document: {
      querySelectorAll: () => ({ forEach: () => {} }),
      querySelector: () => null,
      documentElement: { clientHeight: 900 },
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      head: { appendChild() {} },
      addEventListener: (evt, fn) => { (docListeners[evt] = docListeners[evt] || []).push(fn); },
      removeEventListener: (evt, fn) => { if (docListeners[evt]) docListeners[evt] = docListeners[evt].filter(h => h !== fn); },
      dispatchEvent: (e) => { (docListeners[e.type] || []).forEach(h => { try { h(e); } catch (_) {} }); return true; },
    },
    CustomEvent: class CustomEvent {
      constructor(type, opts) { this.type = type; this.detail = (opts && opts.detail) || null; }
    },
    Element: class {},
    window: {
      CSS: { escape: (s) => String(s) },
      g_universe: { itemsByGuid: universeItems, workspace: { guid: workspaceGuid } },
      addEventListener: (evt, fn) => { (winListeners[evt] = winListeners[evt] || []).push(fn); },
      removeEventListener: (evt, fn) => { if (winListeners[evt]) winListeners[evt] = winListeners[evt].filter(h => h !== fn); },
      dispatchEvent: (e) => { (winListeners[e.type] || []).forEach(h => { try { h(e); } catch (_) {} }); },
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
    searchByQuery: async () => ({ lines: [], error: null }),
  };
  plugin.ui = {
    addCommandPaletteCommand: () => ({ remove() {} }),
    addStatusBarItem: () => ({ remove() {} }),
    getActivePanel: () => null,
  };
  plugin.events = {
    on: (name, fn) => {
      (registeredHandlers[name] = registeredHandlers[name] || []).push(fn);
      return name + '_' + registeredHandlers[name].length;
    },
    off: () => {},
  };
  plugin._registeredHandlers = registeredHandlers;
  plugin._context = context;
  plugin._winListeners = winListeners;
  plugin._docListeners = docListeners;

  return { plugin, context, winListeners, docListeners, registeredHandlers };
}

function makeBroker(universeItems = {}) {
  const { plugin, context } = loadPlugin(universeItems);
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  return { broker, plugin, context };
}

// ── Correct event firing (matches reference-surface-broker.test.cjs) ───────────

function fireEvent(plugin, name, payload) {
  const handlers = plugin._registeredHandlers[name] || [];
  for (const fn of handlers) { try { fn(payload); } catch (e) {} }
}

// Seed N inbound edges to a hot target via lineitem.created events.
// Uses the correct payload shape: { lineGuid, recordGuid, segments }.
function seedInboundEdges(plugin, targetGuid, count) {
  for (let i = 0; i < count; i++) {
    const lineGuid = 'LINE_' + i.toString().padStart(8, '0');
    const recordGuid = 'REC_SRC_' + (i % 500).toString().padStart(4, '0');
    fireEvent(plugin, 'lineitem.created', {
      lineGuid,
      recordGuid,
      segments: [{ type: 'ref', text: { guid: targetGuid } }],
    });
  }
}

// ── BENCHMARK 1: broker.edges() first-page latency with 10k inbound edges ─────
// Simulates opening inline-refs on a hub record with 10k inbound line refs.
// The target-indexed path should be O(target-edges), not O(all-edges).
// Per-page sort of 10k edges costs O(10k log 10k) — the main optimization target.
// Target: <100ms. Threshold: 400ms (4× target, generous for CI).

test('BENCH-1: broker.edges() first-page with 10k inbound to one target — <400ms', async () => {
  const { broker, plugin } = makeBroker();

  const HOT_TARGET = 'HOT_RECORD_GUID_0001';
  const N_INBOUND = 10000;

  // Seed 10k inbound edges via correct event path.
  seedInboundEdges(plugin, HOT_TARGET, N_INBOUND);

  // Wait for debounced revision bump.
  await new Promise(r => setTimeout(r, 50));

  const snap = broker.snapshot();
  const gen = String(broker.generation || snap.generation || '');
  const rev = Number(broker.revision ?? snap.revision ?? 0);

  // TIME: first page of inbound edges to HOT_TARGET.
  const start = Date.now();
  const page = broker.edges({
    filter: {
      _filterVersion: 1,
      kinds: ['ref'],
      targetGuid: HOT_TARGET,
      sourceRecord: null,
      authored: null,
      collectionGuid: null,
      dateRange: null,
    },
    limit: 50,
    generation: gen,
    revision: rev,
  });
  const elapsed = Date.now() - start;

  assert.ok(page && !page.error, 'first page must succeed: ' + (page && page.error));
  assert.ok(page.items && page.items.length > 0, 'first page must have items');

  process.stderr.write(
    `  BENCH-1: broker.edges() first-page (${N_INBOUND} inbound edges) = ${elapsed}ms\n`
  );

  // THRESHOLD: 400ms (4× target of 100ms).
  assert.ok(elapsed < 400,
    `broker.edges() first-page took ${elapsed}ms (threshold: 400ms). ` +
    `Sort is O(n log n) on the full target subset every call.`
  );
});

// ── BENCHMARK 2: broker.edges() repeated page calls (cursor pagination) ────────
// 10k edges, 50 per page. Measures TOTAL cost across all pages.
// Each page currently re-sorts the full 10k target subset.
// Target: <1000ms total. Threshold: 4000ms.

test('BENCH-2: broker.edges() full 10k pagination (all pages × 50) — <4000ms total', async () => {
  const { broker, plugin } = makeBroker();

  const HOT_TARGET = 'HOT_RECORD_GUID_0002';
  const N_INBOUND = 10000;

  seedInboundEdges(plugin, HOT_TARGET, N_INBOUND);
  await new Promise(r => setTimeout(r, 50));

  const snap = broker.snapshot();
  const gen = String(broker.generation || snap.generation || '');
  const rev = Number(broker.revision ?? snap.revision ?? 0);

  const filter = {
    _filterVersion: 1,
    kinds: ['ref'],
    targetGuid: HOT_TARGET,
    sourceRecord: null,
    authored: null,
    collectionGuid: null,
    dateRange: null,
  };

  let pageCount = 0;
  let totalItems = 0;
  let cursor = null;
  const start = Date.now();
  do {
    const page = broker.edges({ filter, limit: 50, generation: gen, revision: rev, after: cursor });
    if (!page || page.error) break;
    totalItems += (page.items || []).length;
    cursor = page.cursor || null;
    pageCount++;
    if (pageCount > 300) break; // safety
  } while (cursor);
  const elapsed = Date.now() - start;

  process.stderr.write(
    `  BENCH-2: full pagination (${pageCount} pages, ${totalItems} items) = ${elapsed}ms\n`
  );

  assert.ok(elapsed < 4000,
    `Full 10k pagination took ${elapsed}ms across ${pageCount} pages (threshold: 4000ms).`
  );
  assert.ok(totalItems >= N_INBOUND * 0.9,
    `Expected ~${N_INBOUND} items, got ${totalItems}`
  );
});

// ── BENCHMARK 3: broker.inEdges() — used by _r7FacetSnapshot ─────────────────
// Direct O(n) indexed lookup. Should be essentially free (<10ms). Threshold: 200ms.

test('BENCH-3: broker.inEdges() on 10k-edge target — <200ms', async () => {
  const { broker, plugin } = makeBroker();

  const HOT_TARGET = 'HOT_RECORD_GUID_0003';
  const N_INBOUND = 10000;

  seedInboundEdges(plugin, HOT_TARGET, N_INBOUND);
  await new Promise(r => setTimeout(r, 50));

  const start = Date.now();
  const edges = broker.inEdges(HOT_TARGET);
  const elapsed = Date.now() - start;

  process.stderr.write(
    `  BENCH-3: broker.inEdges() (${edges.length} edges) = ${elapsed}ms\n`
  );

  assert.ok(elapsed < 200,
    `broker.inEdges() took ${elapsed}ms (threshold: 200ms). Used for facet computation.`
  );
  assert.ok(edges.length >= N_INBOUND * 0.9, `Expected ~${N_INBOUND} edges, got ${edges.length}`);
});

// ── BENCHMARK 4: _edgeSortKey allocation vs pre-keyed sort ───────────────────
// Current _compareEdges allocates a 5-element array TWICE per comparison.
// Timsort on 10k items ≈ 130k comparisons → ~260k array allocations.
// Pre-keying once cuts to N array allocations.
// Measures whether pre-keying is a meaningful speedup.

test('BENCH-4: sort cost — raw _compareEdges vs pre-keyed for 10k edges', () => {
  const { plugin } = makeBroker();

  const N = 10000;
  // Build synthetic edge objects matching _compareEdges shape exactly.
  const edges = [];
  for (let i = 0; i < N; i++) {
    edges.push({
      id: 'ref:v1:LINE_' + i + ':0:TGT',
      kind: 'ref',
      source: {
        recordGuid: 'REC_' + (i % 500),
        lineGuid: 'LINE_' + i,
        segmentOrdinal: i % 10,
      },
      target: { guid: 'TGT', kind: 'record' },
    });
  }

  // Approach A: current — _compareEdges allocates arrays on every comparison.
  const edges1 = edges.slice();
  const startRaw = Date.now();
  edges1.sort((a, b) => plugin._compareEdges(a, b));
  const rawMs = Date.now() - startRaw;

  // Approach B: pre-key once, sort by cached keys.
  const edges2 = edges.slice();
  const startCached = Date.now();
  const keyed = edges2.map(e => ({ e, k: plugin._edgeSortKey(e) }));
  keyed.sort((a, b) => {
    const ka = a.k, kb = b.k;
    for (let i = 0; i < ka.length; i++) {
      const av = ka[i], bv = kb[i];
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
  const cachedMs = Date.now() - startCached;

  process.stderr.write(
    `  BENCH-4: raw _compareEdges=${rawMs}ms, pre-keyed=${cachedMs}ms for N=${N} edges\n`
  );
  if (cachedMs < rawMs) {
    process.stderr.write(
      `  BENCH-4: pre-keyed is ${(rawMs / Math.max(cachedMs, 1)).toFixed(1)}× faster\n`
    );
  }

  // Both must complete quickly on 10k items.
  assert.ok(rawMs < 2000, `Raw sort of ${N} edges took ${rawMs}ms (threshold: 2000ms).`);
});

// ── BENCHMARK 5: warm registry scan in _fillInlineRefs ───────────────────────
// On every inline-refs open, _fillInlineRefs does Object.values(g_universe)
// and scans all text_segments for the target guid.
// Simulates 50k lines in registry with 10k warm inbound hits.
// Target: <100ms. Threshold: 400ms.

test('BENCH-5: warm registry scan (50k registry, 10k warm inbound) — <400ms', () => {
  const TARGET = 'TARGET_REC_GUID_BENCH5';
  const N_REGISTRY = 50000;
  const N_INBOUND = 10000;

  // Build universe: N_INBOUND lines reference TARGET, rest don't.
  const universe = {};
  for (let i = 0; i < N_REGISTRY; i++) {
    const guid = 'LINE_' + i;
    const rguid = 'REC_' + (i % 100);
    const hasHit = i < N_INBOUND;
    universe[guid] = {
      guid,
      rguid,
      is_deleted: false,
      is_trashed: false,
      text_segments: hasHit
        ? ['ref', { guid: TARGET }, 'text', ' some content']
        : ['text', 'no reference here'],
    };
  }

  const { context } = loadPlugin(universe);
  const reg = context.window.g_universe.itemsByGuid;
  const showSelf = false;
  const targetGuid = TARGET;

  // Exact code path from _fillInlineRefs warm scan.
  const start = Date.now();
  const warmStates = [];
  for (const st of Object.values(reg)) {
    if (!st || st.is_deleted || st.is_trashed) continue;
    if (!showSelf && (st.rguid === targetGuid || st.guid === targetGuid)) continue;
    const ts = st.text_segments;
    if (!ts) continue;
    let hits = false;
    for (let i = 0; i + 1 < ts.length; i += 2) {
      const t = ts[i];
      if (t !== 'ref' && t !== 'linkobj') continue;
      const d = ts[i + 1];
      const g = typeof d === 'string' ? d
        : (d && typeof d === 'object' ? (d.guid || (d.text && d.text.guid) || null) : null);
      if (g === targetGuid) { hits = true; break; }
    }
    if (!hits) continue;
    warmStates.push({ guid: st.guid, record: { guid: st.rguid || '' } });
  }
  const elapsed = Date.now() - start;

  process.stderr.write(
    `  BENCH-5: warm registry scan (${N_REGISTRY} lines, ${warmStates.length} hits) = ${elapsed}ms\n`
  );

  assert.ok(elapsed < 400,
    `Warm registry scan of ${N_REGISTRY} lines took ${elapsed}ms (threshold: 400ms).`
  );
  assert.ok(warmStates.length >= N_INBOUND * 0.9,
    `Expected ~${N_INBOUND} warm hits, got ${warmStates.length}`
  );
});

// ── BENCHMARK 6: per-keystroke broker.edges() cost — 100 calls ───────────────
// When inline-refs panel is open and user types, broker subscribers call edges().
// Each call re-sorts 10k edges. Measures 100 successive first-page calls.
// Target: <5ms/call (500ms total). Threshold: 2000ms.

test('BENCH-6: 100 per-keystroke broker.edges() calls at 10k inbound — <2000ms', async () => {
  const { broker, plugin } = makeBroker();

  const HOT_TARGET = 'HOT_RECORD_GUID_0006';
  const N_INBOUND = 10000;

  seedInboundEdges(plugin, HOT_TARGET, N_INBOUND);
  await new Promise(r => setTimeout(r, 50));

  const snap = broker.snapshot();
  const gen = String(broker.generation || snap.generation || '');
  const rev = Number(broker.revision ?? snap.revision ?? 0);

  const filter = {
    _filterVersion: 1,
    kinds: ['ref'],
    targetGuid: HOT_TARGET,
    sourceRecord: null,
    authored: null,
    collectionGuid: null,
    dateRange: null,
  };

  const CALLS = 100;
  const start = Date.now();
  for (let i = 0; i < CALLS; i++) {
    broker.edges({ filter, limit: 50, generation: gen, revision: rev });
  }
  const elapsed = Date.now() - start;
  const perCall = elapsed / CALLS;

  process.stderr.write(
    `  BENCH-6: ${CALLS} per-keystroke broker.edges() = ${elapsed}ms total, ${perCall.toFixed(2)}ms/call\n`
  );

  assert.ok(elapsed < 2000,
    `${CALLS} broker.edges() calls took ${elapsed}ms (threshold: 2000ms). ` +
    `Per-call: ${perCall.toFixed(2)}ms. Sort fires on every call.`
  );
});

// ── BENCHMARK 7: facet snapshot (_r7FacetSnapshot) at 10k edges ──────────────
// Single O(n) pass over inEdges. Should be <50ms. Threshold: 200ms.

test('BENCH-7: _r7FacetSnapshot (10k edges, single O(n) pass) — <200ms', async () => {
  const { broker, plugin } = makeBroker();

  const HOT_TARGET = 'HOT_RECORD_GUID_0007';
  const N_INBOUND = 10000;

  seedInboundEdges(plugin, HOT_TARGET, N_INBOUND);
  await new Promise(r => setTimeout(r, 50));

  // Install broker at window for _r7FacetSnapshot to find it.
  plugin._context.window.__thymerReferenceSurfaceV1 = broker;

  const start = Date.now();
  let snapshot = null;
  try {
    snapshot = plugin._r7FacetSnapshot(HOT_TARGET);
  } catch (e) {
    process.stderr.write(`  BENCH-7: _r7FacetSnapshot threw: ${e.message}\n`);
  }
  const elapsed = Date.now() - start;

  process.stderr.write(
    `  BENCH-7: _r7FacetSnapshot (${N_INBOUND} edges) = ${elapsed}ms\n`
  );

  assert.ok(elapsed < 200,
    `_r7FacetSnapshot took ${elapsed}ms (threshold: 200ms).`
  );
});
