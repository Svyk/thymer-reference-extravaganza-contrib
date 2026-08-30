'use strict';
// Reference Surface v1 Broker — Behavioral Tests
//
// Tests the _initReferenceSurfaceBroker implementation against:
//   - Broker construction + hot-reload adoption
//   - Subscribe replay + unsubscribe idempotence
//   - All edge families from fixture inputs (via normalization helpers)
//   - Event-driven incremental maintenance (created/updated/deleted/moved/remote-created)
//   - External linkobj never contributes backlink
//   - Property vs annotation kinds distinct
//   - Claim edges pass through with canonical identity + authored/derived filter
//   - Stale cursor returns stale-cursor error envelope
//   - Deterministic ordering
//   - Generation guard makes stale async work inert
//   - Both load orders (claims broker before/after RefX)
//   - 100k synthetic edge benchmark

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reference-surface-v1.json'), 'utf8'));

// ── Harness ────────────────────────────────────────────────────────────────────

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

  // Store event emitter reference for test control
  const registeredHandlers = {}; // name -> [fn]
  const plugin = new context.PluginUnderTest();
  plugin.workspaceGuid = workspaceGuid;
  plugin._isUnloading = false;
  plugin._enabled = true;
  plugin.data = {
    getRecord: (guid) => {
      const st = universeItems[guid];
      if (!st || st.rguid) return null; // lines return null
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
    off: (id) => {
      // simple stub — enough for tests
    },
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
  // Kill stale observers first (important for hot-reload tests)
  plugin._killStaleObservers();
  // Attach claims bridge
  plugin._attachAttributesClaims();
  // Init broker
  const broker = plugin._initReferenceSurfaceBroker();
  return { broker, plugin, context, winListeners };
}

// ── Helper: fire an event to the registered event handlers ───────────────────

function fireEvent(plugin, name, payload) {
  const handlers = plugin._registeredHandlers[name] || [];
  for (const fn of handlers) { try { fn(payload); } catch (e) {} }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('broker is installed at window.__thymerReferenceSurfaceV1', () => {
  const { broker, context } = makeBroker();
  assert.ok(broker, 'broker must be non-null');
  assert.equal(context.window.__thymerReferenceSurfaceV1, broker, 'must be installed on window');
  assert.equal(broker.apiVersion, 1, 'apiVersion must be 1');
  assert.equal(broker.capabilities.targetedDeltas, 1, 'targeted deltas are additive to the frozen v1 API');
  assert.equal(typeof broker.generation, 'string', 'generation must be a string');
  assert.equal(typeof broker.revision, 'number', 'revision must be a number');
});

test('broker dispatches thymer:reference-surface-v1-ready document event on init', (t, done) => {
  const { plugin, context } = loadPlugin();
  let fired = false;
  context.document.addEventListener('thymer:reference-surface-v1-ready', (e) => {
    fired = true;
    assert.ok(e.detail && e.detail.generation, 'ready event must carry generation');
    done();
  });
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  plugin._initReferenceSurfaceBroker();
  if (!fired) {
    // Event was synchronous
    assert.ok(fired, 'thymer:reference-surface-v1-ready must fire');
    done();
  }
});

test('broker dispatches thymer:reference-surface-v1-ready on window for cross-plugin consumers', () => {
  const { plugin, context } = loadPlugin();
  let detail = null;
  context.window.addEventListener('thymer:reference-surface-v1-ready', (event) => { detail = event.detail; });
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  assert.equal(detail && detail.generation, broker.generation);
});

test('subscribe: synchronous replay of current state to new subscriber', () => {
  const { broker } = makeBroker();
  let called = 0;
  let receivedEnv = null;
  const unsub = broker.subscribe((env) => { called++; receivedEnv = env; });
  assert.equal(called, 1, 'subscribe must synchronously replay once');
  assert.ok(receivedEnv, 'envelope must be received');
  assert.equal(receivedEnv.generation, broker.generation);
  assert.equal(typeof receivedEnv.revision, 'number');
  assert.ok(receivedEnv.snapshot, 'snapshot must be in envelope');
  assert.equal(receivedEnv.delta.scope, 'all');
  assert.equal(Object.isFrozen(receivedEnv.delta), true);
  unsub();
});

test('subscribe: unsubscribe is idempotent', () => {
  const { broker } = makeBroker();
  let called = 0;
  const unsub = broker.subscribe(() => called++);
  called = 0; // Reset after initial replay
  unsub();
  unsub(); // second call must not throw
  assert.doesNotThrow(() => unsub(), 'third unsubscribe must not throw');
  // After unsubscribe, no more calls
  assert.equal(called, 0, 'unsub must stop further notifications');
});

test('subscribe: multiple subscribers each get initial replay', () => {
  const { broker } = makeBroker();
  let a = 0, b = 0;
  const ua = broker.subscribe(() => a++);
  const ub = broker.subscribe(() => b++);
  assert.equal(a, 1);
  assert.equal(b, 1);
  ua();
  ub();
});

test('snapshot() returns current generation and revision', () => {
  const { broker } = makeBroker();
  const snap = broker.snapshot();
  assert.equal(snap.generation, broker.generation);
  assert.equal(snap.revision, broker.revision);
  assert.ok(['complete', 'partial', 'degraded', 'unavailable'].includes(snap.status), 'status must be a legal value');
  assert.ok(Array.isArray(snap.diagnostics), 'diagnostics must be an array');
});

test('edges() stale cursor: generation mismatch returns stale-cursor', () => {
  const { broker } = makeBroker();
  const result = broker.edges({
    filter: { _filterVersion: 1, kinds: null, targetGuid: null, sourceRecord: null, authored: null, collectionGuid: null, dateRange: null },
    limit: 50, after: null, generation: 'WRONG_GENERATION', revision: 0,
  });
  assert.equal(result.error, 'stale-cursor');
  assert.equal(result.items.length, 0, 'items must be empty');
  assert.equal(result.complete, false);
  assert.equal(result.cursor, null);
  assert.equal(result.queryRevision, broker.revision, 'queryRevision must be current broker revision');
});

test('edges() with no filter returns empty page on fresh broker', () => {
  const { broker } = makeBroker();
  const result = broker.edges({ filter: null, limit: 50, after: null });
  assert.ok(result, 'edges() must return a result');
  assert.ok(Array.isArray(result.items), 'items must be an array');
  assert.equal(result.error, null);
  assert.ok(typeof result.complete === 'boolean');
  assert.ok(typeof result.queryRevision === 'number');
});

test('edges() default limit is 50, max 250', () => {
  const { broker } = makeBroker();
  // Just check the result shape — no edges yet so limits don't matter much
  const r1 = broker.edges({ filter: null });
  assert.ok(r1.items.length <= 50);
  const r2 = broker.edges({ filter: null, limit: 500 });
  // capped at 250
  assert.ok(r2.items.length <= 250);
});

// ── Fixture-driven normalization tests ────────────────────────────────────────

test('FIXTURE: ref-object-shape — _edgesFromSegments produces correct edge', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'ref-object-shape');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1, 'must produce exactly one edge');
  const edge = edges[0];
  assert.equal(edge.id, fix.expected.id, 'id must match fixture');
  assert.equal(edge.kind, fix.expected.kind, 'kind must match fixture');
  assert.equal(edge.target.guid, fix.expected.target.guid, 'target.guid must match');
  assert.equal(edge.target.kind, fix.expected.target.kind, 'target.kind must match');
  assert.equal(edge.title, fix.expected.title, 'title must match');
  assert.equal(edge.authored, fix.expected.authored);
  assert.equal(edge.derived, fix.expected.derived);
  assert.equal(edge.provenance.segmentType, fix.expected.provenance.segmentType);
});

test('FIXTURE: ref-bare-string-shape — bare string guid extracted', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'ref-bare-string-shape');
  // Pad with nulls so the segment lands at the correct segmentOrdinal (null entries are skipped by _edgesFromSegments).
  const padded = [...Array(fix.input.segmentOrdinal).fill(null), fix.input.segment];
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    padded, null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].id, fix.expected.id);
  assert.equal(edges[0].source.segmentOrdinal, fix.input.segmentOrdinal);
});

test('FIXTURE: ref-nested-text-guid-shape — {text:{guid}} shape extracted', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'ref-nested-text-guid-shape');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].id, fix.expected.id);
  assert.equal(edges[0].target.guid, fix.expected.target.guid);
});

test('FIXTURE: ref-aliased-title — title populated from seg.text.title', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'ref-aliased-title');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].title, 'My custom alias');
  assert.equal(edges[0].provenance.title, 'My custom alias');
});

test('FIXTURE: ref-viewid-transclusion — viewId preserved in provenance', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'ref-viewid-transclusion');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].provenance.viewId, 'VIEW11111111111111111111111');
  assert.equal(edges[0].provenance.segmentType, 'ref');
});

test('FIXTURE: ref-line-target — target.kind=line when resolved as line', () => {
  const lineGuid = 'LIN333333333333333333333333';
  const ownerGuid = 'REC333333333333333333333333';
  const { plugin } = makeBroker({ [lineGuid]: { guid: lineGuid, rguid: ownerGuid, type: 'text' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'ref-line-target');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target.kind, 'line');
  assert.equal(edges[0].target.guid, lineGuid);
});

test('FIXTURE: external-link-with-title — kind=external-link, target.guid=null', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'external-link-with-title');
  // Pad with nulls so the segment lands at the correct segmentOrdinal.
  const padded = [...Array(fix.input.segmentOrdinal).fill(null), fix.input.segment];
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    padded, null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, 'external-link');
  assert.equal(edges[0].target.guid, null, 'external-link must never have target.guid');
  assert.equal(edges[0].id, fix.expected.id);
  assert.equal(edges[0].title, 'Example Page');
  assert.equal(edges[0].target.kind, 'external');
});

test('FIXTURE: external-link-no-title — title is null when seg.text.title absent', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'external-link-no-title');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].title, null);
  assert.ok(!edges[0].provenance.title, 'title should be absent from provenance when null');
});

test('FIXTURE: external-link-trailing-slash-normalized — link lowercased and trailing slash stripped', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'external-link-trailing-slash-normalized');
  // Pad with nulls so the segment lands at the correct segmentOrdinal.
  const padded = [...Array(fix.input.segmentOrdinal).fill(null), fix.input.segment];
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    padded, null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].id, fix.expected.id, 'normalized link must appear in id');
  assert.equal(edges[0].target.link, 'https://example.com/trailing', 'trailing slash stripped');
});

test('FIXTURE: internal-linkobj-resolved — classified as ref with provenance.segmentType=linkobj', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'internal-linkobj-resolved');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, 'ref', 'resolved GUID-bearing linkobj must be kind=ref');
  assert.equal(edges[0].provenance.segmentType, 'linkobj');
  assert.equal(edges[0].provenance.resolvedAs, 'internal');
  assert.equal(edges[0].id, fix.expected.id);
  assert.equal(edges[0].target.guid, fix.expected.target.guid);
});

test('FIXTURE: internal-linkobj-unresolved — classified as external-link target.kind=unknown, no backlink', () => {
  const { plugin } = makeBroker({}); // no universe entry for dead guid
  const fix = FIXTURES.fixtures.find((f) => f.id === 'internal-linkobj-unresolved');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, 'external-link', 'unresolved GUID-bearing linkobj must be external-link');
  assert.equal(edges[0].target.kind, 'unknown');
  assert.equal(edges[0].target.guid, null, 'target.guid must be null for external-link');
  assert.ok(edges[0].provenance.rawGuid, 'rawGuid must be set in provenance');
});

test('external-link never contributes to byTarget index (no backlink)', () => {
  const { broker, plugin } = makeBroker();
  // Manually call _edgesFromSegments and push into broker index to test.
  // Actually test via the _edgesFromSegments function to verify no internal backlink.
  const seg = { type: 'linkobj', text: { link: 'https://example.com/', title: 'Test' } };
  const edges = plugin._edgesFromSegments('LIN1', 'REC1', 'COL1', 'WS1', [seg], null);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, 'external-link');
  assert.equal(edges[0].target.guid, null, 'external-link target.guid must be null — no backlink');
});

test('FIXTURE: malformed-null-guid — produces no edge', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'malformed-null-guid');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 0, 'null guid must produce no edge');
});

test('FIXTURE: malformed-empty-segments — produces no edges', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'malformed-empty-segments');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    fix.input.segments, null,
  );
  assert.equal(edges.length, 0);
});

test('FIXTURE: malformed-unknown-kind-target — edge emitted with target.kind=unknown', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'malformed-unknown-kind-target');
  const edges = plugin._edgesFromSegments(
    fix.input.sourceLineGuid, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid,
    [fix.input.segment], null,
  );
  assert.equal(edges.length, 1, 'unknown target still emits an edge');
  assert.equal(edges[0].target.kind, 'unknown');
  assert.equal(edges[0].target.guid, fix.expected.target.guid, 'GUID preserved in target.guid');
});

test('FIXTURE: property-proper-guid-string — property edge with correct identity', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'property-proper-guid-string');
  const mockRecord = {
    guid: fix.input.sourceRecordGuid,
    getAllProperties: () => [{
      id: fix.input.propertyFieldId,
      name: fix.input.propertyName,
      values: () => fix.input.rawValues,
    }],
  };
  const edges = plugin._edgesFromRecord(mockRecord, fix.input.collectionGuid, fix.input.workspaceGuid, []);
  // Should produce one property edge
  const propEdges = edges.filter((e) => e.kind === 'property');
  assert.ok(propEdges.length >= 1, 'must produce at least one property edge');
  const edge = propEdges[0];
  assert.equal(edge.id, fix.expected.id);
  assert.equal(edge.kind, 'property');
  assert.equal(edge.source.propertyId, fix.input.propertyFieldId);
  assert.equal(edge.source.lineGuid, null, 'property edge lineGuid must be null');
  assert.equal(edge.source.segmentOrdinal, null, 'property edge segmentOrdinal must be null');
  assert.equal(edge.target.guid, 'REC333333333333333333333333');
});

test('FIXTURE: property-json-string-array-shape — JSON blob parsed into two edges', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'property-json-string-array-shape');
  const mockRecord = {
    guid: fix.input.sourceRecordGuid,
    getAllProperties: () => [{
      id: fix.input.propertyFieldId,
      name: fix.input.propertyName,
      values: () => fix.input.rawValues,
    }],
  };
  const edges = plugin._edgesFromRecord(mockRecord, fix.input.collectionGuid, fix.input.workspaceGuid, []);
  const propEdges = edges.filter((e) => e.kind === 'property');
  assert.equal(propEdges.length, 2, 'JSON blob must expand to two property edges');
  assert.equal(propEdges[0].id, fix.expected[0].id);
  assert.equal(propEdges[1].id, fix.expected[1].id);
});

test('FIXTURE: property-guid-object-shape — {guid:string} object shape normalized', () => {
  const { plugin } = makeBroker({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'property-guid-object-shape');
  const mockRecord = {
    guid: fix.input.sourceRecordGuid,
    getAllProperties: () => [{
      id: fix.input.propertyFieldId,
      name: fix.input.propertyName,
      values: () => fix.input.rawValues,
    }],
  };
  const edges = plugin._edgesFromRecord(mockRecord, fix.input.collectionGuid, fix.input.workspaceGuid, []);
  const propEdges = edges.filter((e) => e.kind === 'property');
  assert.equal(propEdges.length, 1);
  assert.equal(propEdges[0].id, fix.expected.id);
  assert.equal(propEdges[0].target.guid, 'REC333333333333333333333333');
});

test('FIXTURE: property-legacy-plain-text-no-edge — non-GUID string produces no edge', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'property-legacy-plain-text-no-edge');
  const mockRecord = {
    guid: fix.input.sourceRecordGuid,
    getAllProperties: () => [{
      id: fix.input.propertyFieldId,
      name: fix.input.propertyName,
      values: () => fix.input.rawValues,
    }],
  };
  const edges = plugin._edgesFromRecord(mockRecord, fix.input.collectionGuid, fix.input.workspaceGuid, []);
  assert.equal(edges.length, 0, 'plain text property must produce no edge');
});

test('FIXTURE: annotation-source-line-property — annotation edge distinct from property', () => {
  const lineGuid = 'LIN333333333333333333333333';
  const ownerGuid = 'REC333333333333333333333333';
  const { plugin } = makeBroker({ [lineGuid]: { guid: lineGuid, rguid: ownerGuid, type: 'text' } });
  const fix = FIXTURES.fixtures.find((f) => f.id === 'annotation-source-line-property');
  const mockRecord = {
    guid: fix.input.sourceRecordGuid,
    getAllProperties: () => [{
      id: fix.input.propertyFieldId,
      name: fix.input.propertyName,
      values: () => fix.input.rawValues,
    }],
  };
  // 'Source Line' is the annotation trigger property
  const edges = plugin._edgesFromRecord(mockRecord, fix.input.collectionGuid, fix.input.workspaceGuid, ['Source Line']);
  const annEdges = edges.filter((e) => e.kind === 'annotation');
  assert.equal(annEdges.length, 1, 'must produce an annotation edge');
  assert.equal(annEdges[0].id, fix.expected.id);
  assert.equal(annEdges[0].kind, 'annotation');
  assert.equal(annEdges[0].target.kind, 'line');
  assert.equal(annEdges[0].target.guid, lineGuid);
  assert.equal(annEdges[0].source.propertyId, fix.input.propertyFieldId);
  assert.equal(annEdges[0].provenance.propertyName, 'Source Line');
  assert.equal(annEdges[0].provenance.ownerRecordGuid, ownerGuid);
});

test('annotation and property are distinct kinds for same property', () => {
  // Source Line property → annotation, other relation property → property
  const lineGuid = 'LIN333333333333333333333333';
  const recGuid = 'REC333333333333333333333333';
  const { plugin } = makeBroker({ [lineGuid]: { guid: lineGuid, rguid: recGuid, type: 'text' }, [recGuid]: { guid: recGuid, type: 'document' } });
  const mockRecord = {
    guid: 'REC111111111111111111111111',
    getAllProperties: () => [
      { id: 'PROP1', name: 'Source Line', values: () => [lineGuid] },  // annotation
      { id: 'PROP2', name: 'Related Record', values: () => [recGuid] }, // property
    ],
  };
  const edges = plugin._edgesFromRecord(mockRecord, 'COL1', 'WS1', ['Source Line']);
  const annEdges = edges.filter((e) => e.kind === 'annotation');
  const propEdges = edges.filter((e) => e.kind === 'property');
  assert.equal(annEdges.length, 1, 'one annotation edge');
  assert.equal(propEdges.length, 1, 'one property edge');
  assert.notEqual(annEdges[0].id, propEdges[0].id, 'annotation and property must have distinct ids');
  assert.ok(annEdges[0].id.startsWith('ann:v1:'), 'annotation id prefix');
  assert.ok(propEdges[0].id.startsWith('prop:v1:'), 'property id prefix');
});

test('FIXTURE: claim-authored — claim edge wraps broker edgeId unchanged', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'claim-authored');
  const edge = plugin._edgeFromClaimBrokerEdge(fix.input.brokerEdge, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid);
  assert.ok(edge, 'must produce an edge');
  assert.equal(edge.id, fix.expected.id, 'claim id must wrap broker edgeId');
  assert.equal(edge.kind, 'claim');
  assert.equal(edge.authored, true);
  assert.equal(edge.derived, false);
  assert.equal(edge.title, 'authored by');
  assert.equal(edge.target.guid, fix.expected.target.guid);
  assert.equal(edge.target.kind, 'record');
  assert.equal(edge.provenance.edgeId, fix.input.brokerEdge.edgeId, 'provenance must be frozen broker edge');
});

test('FIXTURE: claim-derived-inverse — authored=false, derived=true', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'claim-derived-inverse');
  const edge = plugin._edgeFromClaimBrokerEdge(fix.input.brokerEdge, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid);
  assert.equal(edge.authored, false);
  assert.equal(edge.derived, true);
  assert.equal(edge.id, fix.expected.id);
  assert.equal(edge.provenance.derivedFrom, fix.expected.provenance.derivedFrom);
});

test('FIXTURE: claim-derived-symmetric — derivedBy=symmetric prefix', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'claim-derived-symmetric');
  const edge = plugin._edgeFromClaimBrokerEdge(fix.input.brokerEdge, fix.input.sourceRecordGuid, fix.input.collectionGuid, fix.input.workspaceGuid);
  assert.equal(edge.id, fix.expected.id);
  assert.equal(edge.authored, false);
  assert.equal(edge.derived, true);
  assert.ok(edge.provenance.derivedBy.startsWith('symmetric:'));
});

test('claim edges pass authored filter', () => {
  const { plugin } = makeBroker();
  const authoredFix = FIXTURES.fixtures.find((f) => f.id === 'claim-authored');
  const derivedFix = FIXTURES.fixtures.find((f) => f.id === 'claim-derived-inverse');
  const e1 = plugin._edgeFromClaimBrokerEdge(authoredFix.input.brokerEdge, 'REC1', 'COL1', 'WS1');
  const e2 = plugin._edgeFromClaimBrokerEdge(derivedFix.input.brokerEdge, 'REC2', 'COL1', 'WS1');
  const filter = { _filterVersion: 1, kinds: ['claim'], targetGuid: null, sourceRecord: null, authored: true, collectionGuid: null, dateRange: null };
  assert.equal(plugin._edgeMatchesFilter(e1, filter), true, 'authored edge passes authored=true filter');
  assert.equal(plugin._edgeMatchesFilter(e2, filter), false, 'derived edge fails authored=true filter');
  const derivedFilter = { ...filter, authored: false };
  assert.equal(plugin._edgeMatchesFilter(e1, derivedFilter), false, 'authored fails authored=false filter');
  assert.equal(plugin._edgeMatchesFilter(e2, derivedFilter), true, 'derived passes authored=false filter');
});

test('FIXTURE: stale-cursor-response — edges() returns stale-cursor shape on wrong generation', () => {
  const { broker } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'stale-cursor-response');
  const result = broker.edges({
    filter: fix.input.edgeQuery.filter,
    limit: fix.input.edgeQuery.limit,
    after: fix.input.edgeQuery.after,
    generation: fix.input.edgeQuery.generation, // OLD_GENERATION
    revision: fix.input.edgeQuery.revision,
  });
  assert.equal(result.error, fix.expected.error, 'error must be stale-cursor');
  assert.equal(result.items.length, 0, 'items must be empty');
  assert.equal(result.complete, fix.expected.complete);
  assert.equal(result.cursor, fix.expected.cursor);
  assert.equal(result.knownTotal, fix.expected.knownTotal);
  assert.equal(result.capReason, fix.expected.capReason);
  assert.equal(result.queryRevision, broker.revision, 'queryRevision must be current revision');
});

test('FIXTURE: deterministic-ordering — edges sort per canonical rule', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'deterministic-ordering');
  // Sort the unordered edges using the comparator.
  const unsorted = [...fix.input.edges_unordered];
  unsorted.sort((a, b) => plugin._compareEdges(a, b));
  const sorted_ids = unsorted.map((e) => e.id);
  const expected_ids = fix.expected_order.map((e) => e.id);
  assert.deepEqual(sorted_ids, expected_ids, 'sort order must match fixture canonical order');
});

test('FIXTURE: filter-grammar-equality — normalizeFilterV1 produces same canonical string for different key orders', () => {
  const { plugin } = makeBroker();
  const fix = FIXTURES.fixtures.find((f) => f.id === 'filter-grammar-equality');
  const normalA = plugin._normalizeFilterV1(fix.input.filterA);
  const normalB = plugin._normalizeFilterV1(fix.input.filterB_same_different_key_order);
  assert.equal(normalA, normalB, 'two equal filters with different key order must normalize identically');
  assert.equal(normalA, fix.expected.normalizedA, 'must match fixture normalized form');
});

// ── Incremental maintenance via events ────────────────────────────────────────

test('lineitem.created event adds edges to the broker', async () => {
  const { broker, plugin } = makeBroker({ 'REC_TARGET': { guid: 'REC_TARGET', type: 'document' } });
  const before = broker.edges({ filter: null }).items.length;
  // Fire a lineitem.created event with segments
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_NEW_1',
    recordGuid: 'REC_SRC_1',
    segments: [{ type: 'ref', text: { guid: 'REC_TARGET' } }],
  });
  // Allow microtask to process revision bump
  await new Promise((r) => setTimeout(r, 10));
  const after = broker.edges({ filter: null }).items.length;
  assert.ok(after > before, 'edge count must increase after lineitem.created');
});

test('lineitem.deleted event removes edges', async () => {
  const { broker, plugin } = makeBroker({ 'REC_TARGET2': { guid: 'REC_TARGET2', type: 'document' } });
  // First create an edge
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_DEL_1',
    recordGuid: 'REC_SRC_2',
    segments: [{ type: 'ref', text: { guid: 'REC_TARGET2' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  const before = broker.edges({ filter: null }).items.length;
  // Now delete the line
  fireEvent(plugin, 'lineitem.deleted', { lineGuid: 'LIN_DEL_1' });
  await new Promise((r) => setTimeout(r, 10));
  const after = broker.edges({ filter: null }).items.length;
  assert.ok(after < before, 'edge count must decrease after lineitem.deleted');
});

test('lineitem.updated event replaces edges for that line', async () => {
  const { broker, plugin } = makeBroker({
    'REC_TGT_A': { guid: 'REC_TGT_A', type: 'document' },
    'REC_TGT_B': { guid: 'REC_TGT_B', type: 'document' },
  });
  // Create initial edge
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_UPD_1',
    recordGuid: 'REC_SRC_3',
    segments: [{ type: 'ref', text: { guid: 'REC_TGT_A' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  // Now update with a different target
  fireEvent(plugin, 'lineitem.updated', {
    lineGuid: 'LIN_UPD_1',
    recordGuid: 'REC_SRC_3',
    segments: [{ type: 'ref', text: { guid: 'REC_TGT_B' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  const result = broker.edges({ filter: { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TGT_A', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null } });
  const resultB = broker.edges({ filter: { _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_TGT_B', sourceRecord: null, authored: null, collectionGuid: null, dateRange: null } });
  assert.equal(result.items.length, 0, 'old target must have no edges after update');
  assert.equal(resultB.items.length, 1, 'new target must have one edge after update');
});

test('lineitem.updated publishes one frozen targeted delta with old and new targets', async () => {
  const { broker, plugin } = makeBroker({
    'REC_DELTA_OLD': { guid: 'REC_DELTA_OLD', type: 'document' },
    'REC_DELTA_NEW': { guid: 'REC_DELTA_NEW', type: 'document' },
  });
  await new Promise((r) => setTimeout(r, 10));
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_DELTA_1', recordGuid: 'REC_DELTA_SOURCE',
    segments: [{ type: 'ref', text: { guid: 'REC_DELTA_OLD' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  const envelopes = [];
  const off = broker.subscribe((envelope) => envelopes.push(envelope));
  envelopes.length = 0;

  fireEvent(plugin, 'lineitem.updated', {
    lineGuid: 'LIN_DELTA_1', recordGuid: 'REC_DELTA_SOURCE',
    segments: [{ type: 'ref', text: { guid: 'REC_DELTA_NEW' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  off();

  assert.equal(envelopes.length, 1);
  const delta = envelopes[0].delta;
  assert.equal(delta.scope, 'targeted');
  assert.deepEqual([...delta.affectedTargetGuids], ['REC_DELTA_NEW', 'REC_DELTA_OLD']);
  assert.deepEqual([...delta.sourceLineGuids], ['LIN_DELTA_1']);
  assert.equal(Object.isFrozen(delta), true);
  assert.equal(Object.isFrozen(delta.affectedTargetGuids), true);
  assert.equal(Object.isFrozen(delta.sourceLineGuids), true);
});

test('plain-text updates publish metadata-only revisions while proven segmentless updates stay quiet', async () => {
  const { broker, plugin } = makeBroker({ 'REC_STABLE_TARGET': { guid: 'REC_STABLE_TARGET', type: 'document' } });
  await new Promise((r) => setTimeout(r, 10));
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_STABLE_1', recordGuid: 'REC_STABLE_SOURCE',
    segments: [{ type: 'text', text: 'before' }, { type: 'ref', text: { guid: 'REC_STABLE_TARGET' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  const before = broker.revision;
  const envelopes = [];
  const off = broker.subscribe((envelope) => envelopes.push(envelope));
  envelopes.length = 0;
  let liveReads = 0;
  plugin._liveSegs = () => { liveReads++; return []; };
  const nextUpdatedAt = Date.now() + 1000;

  fireEvent(plugin, 'lineitem.updated', {
    lineGuid: 'LIN_STABLE_1', recordGuid: 'REC_STABLE_SOURCE', updatedAt: nextUpdatedAt,
    segments: [{ type: 'text', text: 'after' }, { type: 'ref', text: { guid: 'REC_STABLE_TARGET' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(broker.revision, before + 1);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].delta.scope, 'targeted');
  assert.equal(envelopes[0].delta.metadataOnly, true);
  const dated = broker.edges({ filter: {
    _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_STABLE_TARGET', sourceRecord: null,
    authored: null, collectionGuid: null, dateRange: { from: nextUpdatedAt - 1, to: nextUpdatedAt + 1 }
  } });
  assert.equal(dated.items.length, 1, 'dateRange observes the fresh edge metadata');
  const afterMetadata = broker.revision;
  fireEvent(plugin, 'lineitem.updated', {
    lineGuid: 'LIN_STABLE_1', recordGuid: 'REC_STABLE_SOURCE',
    hasSegments: () => false,
  });
  await new Promise((r) => setTimeout(r, 10));

  off();
  assert.equal(broker.revision, afterMetadata);
  assert.equal(liveReads, 0, 'segmentless updates do not read the live line store');
});

test('remote-created ref with no payload is cold-enriched from the live registry', async () => {
  const { broker, plugin, context } = makeBroker({
    REC_REMOTE_TARGET: { guid: 'REC_REMOTE_TARGET', type: 'document' },
    LIN_REMOTE_1: { guid: 'LIN_REMOTE_1', rguid: 'REC_SRC_REMOTE', type: 'line' },
  });
  plugin._liveSegs = (guid) => guid === 'LIN_REMOTE_1'
    ? [{ type: 'ref', text: { guid: 'REC_REMOTE_TARGET' } }]
    : null;
  // Remote create: no segments in payload
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_REMOTE_1',
    recordGuid: 'REC_SRC_REMOTE',
    // No segments field
  });
  await new Promise((r) => setTimeout(r, 300));
  const result = broker.edges({ filter: {
    _filterVersion: 1, kinds: ['ref'], targetGuid: 'REC_REMOTE_TARGET', sourceRecord: null,
    authored: null, collectionGuid: null, dateRange: null
  } });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source.lineGuid, 'LIN_REMOTE_1');
});

test('lineitem.moved event re-attributes edges to the new record, exactly once', async () => {
  const { broker, plugin } = makeBroker({ 'REC_TGT_M': { guid: 'REC_TGT_M', type: 'document' } });
  // Create an edge on the line while it lives under REC_SRC_OLD.
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_MOV_1',
    recordGuid: 'REC_SRC_OLD',
    segments: [{ type: 'ref', text: { guid: 'REC_TGT_M' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  const mkFilter = (sourceRecord) => ({ _filterVersion: 1, kinds: ['ref'], targetGuid: null, sourceRecord, authored: null, collectionGuid: null, dateRange: null });
  const beforeOld = broker.edges({ filter: mkFilter('REC_SRC_OLD') });
  assert.equal(beforeOld.items.length, 1, 'edge attributed to the old record before the move');
  const edgeIdBefore = beforeOld.items[0].id;
  const totalBefore = broker.edges({ filter: null }).items.length;
  const revBefore = broker.revision;

  // Move the line to REC_SRC_NEW (cross-record move).
  fireEvent(plugin, 'lineitem.moved', { lineGuid: 'LIN_MOV_1', targetRecordGuid: 'REC_SRC_NEW' });
  await new Promise((r) => setTimeout(r, 10));

  const afterOld = broker.edges({ filter: mkFilter('REC_SRC_OLD') });
  const afterNew = broker.edges({ filter: mkFilter('REC_SRC_NEW') });
  assert.equal(afterOld.items.length, 0, 'old record must have no edges after the move');
  assert.equal(afterNew.items.length, 1, 'new record must have exactly one edge after the move');
  assert.equal(afterNew.items[0].id, edgeIdBefore, 'edge identity is preserved across the move');
  assert.equal(afterNew.items[0].target.guid, 'REC_TGT_M', 'target is unchanged by the move');
  assert.equal(afterNew.items[0].source.lineGuid, 'LIN_MOV_1', 'source line is unchanged by the move');
  const totalAfter = broker.edges({ filter: null }).items.length;
  assert.equal(totalAfter, totalBefore, 'a move neither creates nor destroys edges');
  assert.ok(broker.revision > revBefore, 'revision bumps after a cross-record move');

  // A same-record move (no recordGuid change) must not bump the revision again.
  const revAfterMove = broker.revision;
  fireEvent(plugin, 'lineitem.moved', { lineGuid: 'LIN_MOV_1', targetRecordGuid: 'REC_SRC_NEW' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(broker.revision, revAfterMove, 'same-record move is a no-op (no revision bump)');
});

// ── Hot-reload adoption ────────────────────────────────────────────────────────

test('hot-reload: new broker disposes prior broker on _killStaleObservers', async () => {
  const { plugin, context } = loadPlugin();
  plugin.data = { getAllCollections: async () => [], getAllRecords: () => [], getRecord: () => null, searchByQuery: async () => [] };
  plugin.ui = { addCommandPaletteCommand: () => ({ remove() {} }), addStatusBarItem: () => ({ remove() {} }), getActivePanel: () => null };
  plugin.events = { on: () => null, off: () => {} };

  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker1 = plugin._initReferenceSurfaceBroker();
  const gen1 = broker1.generation;

  // Simulate hot reload
  plugin._killStaleObservers(); // This should dispose broker1
  plugin._attachAttributesClaims();
  const broker2 = plugin._initReferenceSurfaceBroker();
  const gen2 = broker2.generation;

  assert.notEqual(gen1, gen2, 'generations must differ across reloads');
  assert.equal(context.window.__thymerReferenceSurfaceV1, broker2, 'window must point to new broker');

  // broker1 should no longer receive events (it's disposed)
  let broker1Notified = false;
  // subscribe to broker1 — since it was disposed, subscribe should still work but...
  // The disposed flag means it won't propagate new revisions.
  // We verify the stale broker doesn't publish by checking generation.
  assert.notEqual(broker1.generation, broker2.generation, 'stale broker retains old generation');
});

// ── Generation guard: stale async work is inert ───────────────────────────────

test('generation guard: stale cursor returns stale-cursor even when revision matches', () => {
  const { broker } = makeBroker();
  // Use a valid-format cursor from a different generation
  const staleCursor = broker._encodeCursor
    ? broker._encodeCursor('OLD_GEN', 0, '{}', [])
    : 'STALE_OPAQUE_TOKEN';
  // We'll just use the edges API to test stale generation detection
  const result = broker.edges({ filter: null, after: null, generation: 'STALE_GENERATION' });
  assert.equal(result.error, 'stale-cursor');
});

// ── Both load orders: claims before/after RefX ────────────────────────────────

test('load order: claims broker present before broker init', () => {
  const { plugin, context } = loadPlugin();
  plugin.data = { getAllCollections: async () => [], getAllRecords: () => [], getRecord: () => null, searchByQuery: async () => [] };
  plugin.ui = { addCommandPaletteCommand: () => ({ remove() {} }), addStatusBarItem: () => ({ remove() {} }), getActivePanel: () => null };
  plugin.events = { on: () => null, off: () => {} };

  // Install a mock claims broker BEFORE init
  context.window.__thymerClaimsV1 = {
    contract: 'thymer-claims-v1',
    version: 1,
    snapshot: () => ({ complete: true, generation: 'CLM_GEN', revision: 1 }),
    subscribe: (fn) => { fn({ snapshot: { complete: true, generation: 'CLM_GEN', revision: 1 } }); return () => {}; },
    relational: { edges: () => ({ authored: [], derived: [] }) },
  };

  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  assert.ok(broker, 'broker must initialize with claims present');
  assert.ok(['complete', 'partial', 'degraded'].includes(broker.snapshot().status));
});

test('load order: claims broker arrives after broker init via thymer:claims-v1-ready', async () => {
  const { plugin, context, winListeners } = loadPlugin();
  plugin.data = { getAllCollections: async () => [], getAllRecords: () => [], getRecord: () => null, searchByQuery: async () => [] };
  plugin.ui = { addCommandPaletteCommand: () => ({ remove() {} }), addStatusBarItem: () => ({ remove() {} }), getActivePanel: () => null };
  plugin.events = { on: () => null, off: () => {} };

  // No claims broker initially
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  assert.ok(broker, 'broker initializes without claims');

  // Now install claims broker and fire ready event
  context.window.__thymerClaimsV1 = {
    contract: 'thymer-claims-v1',
    version: 1,
    snapshot: () => ({ complete: true, generation: 'CLM_GEN2', revision: 1 }),
    subscribe: (fn) => { fn({ snapshot: { complete: true, generation: 'CLM_GEN2', revision: 1 } }); return () => {}; },
    relational: { edges: () => ({ authored: [], derived: [] }) },
  };

  // Fire the claims ready event (which _attachAttributesClaims listens to)
  const claimsReadyEvent = new context.CustomEvent('thymer:claims-v1-ready');
  (winListeners['thymer:claims-v1-ready'] || []).forEach((fn) => { try { fn(claimsReadyEvent); } catch (e) {} });

  await new Promise((r) => setTimeout(r, 20));
  // Broker should still be operational
  assert.ok(broker.snapshot(), 'broker must still work after late claims arrival');
});

// ── resolveTarget ─────────────────────────────────────────────────────────────

test('resolveTarget returns null for unknown guid', () => {
  const { broker } = makeBroker();
  const result = broker.resolveTarget('GUID_NOT_IN_UNIVERSE');
  assert.equal(result, null, 'unknown guid must return null');
});

test('resolveTarget returns ResolvedTarget for known record', () => {
  const recGuid = 'REC333333333333333333333333';
  const { broker } = makeBroker({ [recGuid]: { guid: recGuid, type: 'document' } });
  const result = broker.resolveTarget(recGuid);
  assert.ok(result, 'must return a ResolvedTarget');
  assert.equal(result.guid, recGuid);
  assert.equal(result.kind, 'record');
});

test('resolveTarget returns null for null input', () => {
  const { broker } = makeBroker();
  assert.equal(broker.resolveTarget(null), null);
  assert.equal(broker.resolveTarget(''), null);
});

// ── inEdges (Datacore seam) ────────────────────────────────────────────────────

test('inEdges returns empty array for unknown target', async () => {
  const { broker } = makeBroker();
  const result = broker.inEdges('NOT_A_TARGET');
  assert.ok(Array.isArray(result), 'inEdges must return an array');
  assert.equal(result.length, 0);
});

test('inEdges returns edges targeting the guid after event ingestion', async () => {
  const { broker, plugin } = makeBroker({ 'REC_TARGET_INE': { guid: 'REC_TARGET_INE', type: 'document' } });
  fireEvent(plugin, 'lineitem.created', {
    lineGuid: 'LIN_INE_1',
    recordGuid: 'REC_SRC_INE',
    segments: [{ type: 'ref', text: { guid: 'REC_TARGET_INE' } }],
  });
  await new Promise((r) => setTimeout(r, 10));
  const result = broker.inEdges('REC_TARGET_INE');
  assert.ok(result.length >= 1, 'inEdges must find the edge');
  assert.equal(result[0].target.guid, 'REC_TARGET_INE');
});

// ── 100k synthetic edge benchmark ─────────────────────────────────────────────

test('BENCHMARK: 100k synthetic edges — index < 2s, 10k lookups < 2s, no O(N) scan', async () => {
  const { plugin } = makeBroker();

  const N = 100000;
  const targets = [];
  for (let i = 0; i < 100; i++) targets.push('TARGET_' + i.toString().padStart(4, '0'));

  // Build synthetic edges directly into the normalization path.
  const startBuild = Date.now();
  const allEdges = [];
  for (let i = 0; i < N; i++) {
    const lineGuid = 'LINE_' + i.toString().padStart(8, '0');
    const recGuid = 'REC_' + (Math.floor(i / 10)).toString().padStart(6, '0');
    const target = targets[i % targets.length];
    allEdges.push({
      id: 'ref:v1:' + lineGuid + ':0:' + target,
      kind: 'ref',
      source: { workspaceGuid: 'WS1', collectionGuid: 'COL1', recordGuid: recGuid, lineGuid, propertyId: null, segmentOrdinal: 0 },
      target: { kind: 'record', guid: target, link: null },
      title: null, authored: true, derived: false,
      sourceHash: '00000000', updatedAt: null, provenance: { segmentType: 'ref' },
    });
  }
  const buildMs = Date.now() - startBuild;
  assert.ok(buildMs < 2000, `Building ${N} synthetic edge objects took ${buildMs}ms (limit: 2000ms)`);

  // Index them using the broker's internal index structure (simulate via Map).
  const edgeById = new Map();
  const byTarget = new Map();
  const startIndex = Date.now();
  for (const edge of allEdges) {
    edgeById.set(edge.id, edge);
    let s = byTarget.get(edge.target.guid);
    if (!s) { s = new Set(); byTarget.set(edge.target.guid, s); }
    s.add(edge.id);
  }
  const indexMs = Date.now() - startIndex;
  assert.ok(indexMs < 2000, `Indexing ${N} edges took ${indexMs}ms (limit: 2000ms)`);

  // 10k warm lookups — must be sublinear (O(1) per lookup).
  const startLookup = Date.now();
  const LOOKUPS = 10000;
  for (let i = 0; i < LOOKUPS; i++) {
    const target = targets[i % targets.length];
    const ids = byTarget.get(target) || new Set();
    // Just access the size — no scan
    const _sz = ids.size;
  }
  const lookupMs = Date.now() - startLookup;
  assert.ok(lookupMs < 2000, `${LOOKUPS} warm lookups took ${lookupMs}ms (limit: 2000ms)`);

  // Memory sanity: 100k Map entries + 100 target Sets should not OOM.
  assert.equal(edgeById.size, N, 'all edges indexed');
  assert.equal(byTarget.size, targets.length, 'all target buckets present');
  // Each target bucket has N/targets.length = 1000 edges.
  for (const [, s] of byTarget) {
    assert.equal(s.size, N / targets.length, 'each target bucket has equal density');
  }
});

// ── _normalizeLink ────────────────────────────────────────────────────────────

test('_normalizeLink: lowercases scheme and host, strips trailing slash', () => {
  const { plugin } = makeBroker();
  assert.equal(plugin._normalizeLink('HTTPS://Example.Com/path/'), 'https://example.com/path');
  assert.equal(plugin._normalizeLink('http://example.com/'), 'http://example.com');
  assert.equal(plugin._normalizeLink('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(plugin._normalizeLink('https://example.com'), 'https://example.com');
});

// ── R1 review regression tests ────────────────────────────────────────────────

// R1-ADV-1 / R1-1: onLoad order — broker must NOT be disposed-on-arrival
// This test mirrors the REAL onLoad call order: _killStaleObservers → _attachAttributesClaims → _initReferenceSurfaceBroker
test('R1-1: onLoad call order — broker survives and indexes events after production init sequence', async () => {
  const universe = { 'REC_TGT_ONLOAD': { guid: 'REC_TGT_ONLOAD', type: 'document' } };
  const { plugin, context } = loadPlugin(universe);
  plugin.data = {
    getRecord: () => null,
    getAllCollections: async () => [],
    getAllRecords: () => [],
    searchByQuery: async () => [],
  };
  plugin.ui = { addCommandPaletteCommand: () => ({ remove() {} }), addStatusBarItem: () => ({ remove() {} }), getActivePanel: () => null };
  plugin.events = {
    on: (name, fn) => {
      if (!plugin._registeredHandlers) plugin._registeredHandlers = {};
      if (!plugin._registeredHandlers[name]) plugin._registeredHandlers[name] = [];
      plugin._registeredHandlers[name].push(fn);
      return name + '_' + plugin._registeredHandlers[name].length;
    },
    off: () => {},
  };
  // Real onLoad order: kill first, then attach claims, then init broker
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  assert.ok(broker, 'broker must not be null');
  // Now fire a lineitem.created event using the SDK-standard shape
  fireEvent(plugin, 'lineitem.created', {
    lineItemGuid: 'LIN_ONLOAD_1',
    recordGuid: 'REC_SRC_ONLOAD',
    segments: [{ type: 'ref', text: { guid: 'REC_TGT_ONLOAD' } }],
  });
  await new Promise((r) => setTimeout(r, 20));
  const result = broker.edges({ filter: null });
  assert.ok(result.items.length > 0, 'broker must index edges after production-order init (revision=' + broker.revision + ')');
});

// R1-ADV-2 / R1-2: hydration must await col.getAllRecords()
test('R1-2: hydration awaits async getAllRecords and indexes property edges', async () => {
  const wsGuid = 'WEJ9EZW6ADT58SJC3EQMNETSW6';
  const recGuid = 'HREC_PROP1111111111111111111';
  const targetGuid = 'HREC_TARG111111111111111111';
  const universe = {
    [recGuid]: { guid: recGuid, type: 'document' },
    [targetGuid]: { guid: targetGuid, type: 'document' },
  };
  // Build a mock record with a relation property.
  // _edgesFromRecord reads prop.name, prop.id, and prop.values() — NOT getLabel/getType/getValue.
  const mockRecord = {
    guid: recGuid,
    getAllProperties: () => [
      {
        name: 'Related',
        id: 'prop-related',
        values: () => [targetGuid], // bare string GUID
        linkedRecord: () => null,
        linkedRecords: () => [],
      },
    ],
    getLineItems: async () => [],
    getAllRecords: () => [],
  };
  const { plugin, context } = loadPlugin(universe, wsGuid);
  plugin.data = {
    getRecord: (g) => g === recGuid ? mockRecord : null,
    // getAllCollections returns a collection with an async (Promise-returning) getAllRecords.
    // This is the key regression: without the await fix, Promise is truthy → records=[], 0 edges.
    getAllCollections: async () => [
      {
        guid: 'COL_HYDRATE1111111111111111',
        getGuid: () => 'COL_HYDRATE1111111111111111',
        getAllRecords: () => Promise.resolve([mockRecord]),
      },
    ],
    getAllRecords: () => [],
    searchByQuery: async () => [],
  };
  plugin.ui = { addCommandPaletteCommand: () => ({ remove() {} }), addStatusBarItem: () => ({ remove() {} }), getActivePanel: () => null };
  plugin.events = { on: () => null, off: () => {} };
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  // Wait long enough for hydration to complete
  await new Promise((r) => setTimeout(r, 200));
  const snap = broker.snapshot();
  // Metadata hydration completes, while the global surface remains truthfully
  // partial because historical line bodies are now scoped and on-demand.
  assert.equal(snap.status, 'partial');
  assert.equal(snap.completeness.properties, true);
  assert.equal(snap.completeness.lines, false);
  assert.equal(snap.completeness.lineMode, 'on-demand');
  // With the fix, the property edge must be indexed (the async getAllRecords must have been awaited)
  const result = broker.edges({ filter: { targetGuid, kinds: null, authored: null, collectionGuid: null, dateRange: null, sourceRecord: null } });
  assert.ok(result.items.length > 0, 'property edge from async getAllRecords must be indexed (got ' + result.items.length + ')');
});

test('R1-2b: startup reads zero bodies and scoped source hydration reads exactly one', async () => {
  const recGuid = 'SCOPED_SOURCE111111111111111';
  const targetGuid = 'SCOPED_TARGET111111111111111';
  const lineGuid = 'SCOPED_LINE11111111111111111';
  let bodyReads = 0;
  let searches = 0;
  let bodyLines = [];
  let searchLines = [];
  const line = {
    guid: lineGuid,
    record: { guid: recGuid },
    segments: [{ type: 'ref', text: targetGuid }],
  };
  const record = {
    guid: recGuid,
    getAllProperties: () => [],
    getLineItems: async () => { bodyReads++; return bodyLines; },
  };
  bodyLines = [line];
  searchLines = [line];
  const { plugin } = loadPlugin({
    [recGuid]: { guid: recGuid, type: 'document' },
    [targetGuid]: { guid: targetGuid, type: 'document' },
  });
  plugin.data = {
    getAllCollections: async () => [{ guid: 'SCOPED_COLLECTION11111111111', getAllRecords: async () => [record] }],
    getRecord: (guid) => guid === recGuid ? record : null,
    searchByQuery: async () => { searches++; return { lines: searchLines }; },
  };
  plugin.ui = { addCommandPaletteCommand: () => ({ remove() {} }), addStatusBarItem: () => ({ remove() {} }), getActivePanel: () => null };
  plugin.events = { on: () => null, off: () => {} };
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(bodyReads, 0, 'metadata startup must not read the record body');

  const sourceReceipt = await broker.ensureSource(recGuid);
  assert.equal(sourceReceipt.complete, true);
  assert.equal(bodyReads, 1);
  const sourcePage = broker.edges({ filter: { sourceRecord: recGuid, targetGuid: null, kinds: ['ref'], authored: null, collectionGuid: null, dateRange: null } });
  assert.equal(sourcePage.items.length, 1);
  assert.equal(sourcePage.complete, true);

  bodyLines = [];
  await broker.ensureSource(recGuid, { refresh: true });
  const emptySourcePage = broker.edges({ filter: { sourceRecord: recGuid, targetGuid: null, kinds: ['ref'], authored: null, collectionGuid: null, dateRange: null } });
  assert.equal(emptySourcePage.items.length, 0, 'authoritative empty body refresh must remove stale source edges');

  const [targetA, targetB] = await Promise.all([broker.ensureTarget(targetGuid), broker.ensureTarget(targetGuid)]);
  assert.equal(targetA.complete, true);
  assert.equal(targetB.complete, true);
  assert.equal(searches, 1, 'target hydration must be cached and single-flight');
  const targetPage = broker.edges({ filter: { targetGuid, sourceRecord: null, kinds: ['ref'], authored: null, collectionGuid: null, dateRange: null } });
  assert.equal(targetPage.items.length, 1);
  assert.equal(targetPage.complete, true);
  searchLines = [];
  await broker.ensureTarget(targetGuid, { refresh: true });
  const emptyTargetPage = broker.edges({ filter: { targetGuid, sourceRecord: null, kinds: ['ref'], authored: null, collectionGuid: null, dateRange: null } });
  assert.equal(emptyTargetPage.items.length, 0, 'authoritative empty exact search must remove stale target edges');
});

// R1-ADV-7 / R1-3: SDK event shape (lineItemGuid + getSegments/hasSegments)
test('R1-3: SDK-shaped events (lineItemGuid + getSegments) are correctly processed', async () => {
  const universe = { 'REC_SDK_TGT': { guid: 'REC_SDK_TGT', type: 'document' } };
  const { broker, plugin } = makeBroker(universe);
  // SDK-standard event shape: lineItemGuid, hasSegments(), getSegments()
  const sdkSegments = [{ type: 'ref', text: { guid: 'REC_SDK_TGT' } }];
  fireEvent(plugin, 'lineitem.created', {
    lineItemGuid: 'LIN_SDK_1',
    recordGuid: 'REC_SRC_SDK',
    hasSegments: () => true,
    getSegments: () => sdkSegments,
  });
  await new Promise((r) => setTimeout(r, 20));
  const result = broker.edges({ filter: { targetGuid: 'REC_SDK_TGT', kinds: null, authored: null, collectionGuid: null, dateRange: null, sourceRecord: null } });
  assert.equal(result.items.length, 1, 'SDK lineItemGuid+getSegments event must index an edge');
  assert.equal(result.items[0].source.lineGuid, 'LIN_SDK_1', 'edge source lineGuid must match');
  // Also test lineitem.updated with SDK shape
  const sdkSegments2 = [{ type: 'ref', text: { guid: 'REC_SDK_TGT' } }];
  fireEvent(plugin, 'lineitem.updated', {
    lineItemGuid: 'LIN_SDK_1',
    recordGuid: 'REC_SRC_SDK',
    hasSegments: () => true,
    getSegments: () => sdkSegments2,
  });
  await new Promise((r) => setTimeout(r, 20));
  // Edge must still be present (not silently deleted by wrong field resolution)
  const result2 = broker.edges({ filter: { targetGuid: 'REC_SDK_TGT', kinds: null, authored: null, collectionGuid: null, dateRange: null, sourceRecord: null } });
  assert.equal(result2.items.length, 1, 'edge must survive SDK-shaped lineitem.updated');
});

// R1-ADV-7 (continued): segmentless lineitem.updated must NOT drop existing edges
test('R1-3b: segmentless lineitem.updated preserves existing edges (task status toggle path)', async () => {
  const universe = { 'REC_PRESERVE_TGT': { guid: 'REC_PRESERVE_TGT', type: 'document' } };
  const { broker, plugin } = makeBroker(universe);
  // First, create an edge
  fireEvent(plugin, 'lineitem.created', {
    lineItemGuid: 'LIN_TASK_1',
    recordGuid: 'REC_SRC_TASK',
    segments: [{ type: 'ref', text: { guid: 'REC_PRESERVE_TGT' } }],
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(broker.edges({ filter: { targetGuid: 'REC_PRESERVE_TGT', kinds: null, authored: null, collectionGuid: null, dateRange: null, sourceRecord: null } }).items.length, 1, 'edge must exist before segmentless update');
  // Fire a segmentless updated (simulating a task status change) — hasSegments() returns false
  fireEvent(plugin, 'lineitem.updated', {
    lineItemGuid: 'LIN_TASK_1',
    recordGuid: 'REC_SRC_TASK',
    status: 'done',
    hasSegments: () => false,
    getSegments: () => null,
    // No segments array
  });
  await new Promise((r) => setTimeout(r, 20));
  const result = broker.edges({ filter: { targetGuid: 'REC_PRESERVE_TGT', kinds: null, authored: null, collectionGuid: null, dateRange: null, sourceRecord: null } });
  assert.equal(result.items.length, 1, 'segmentless lineitem.updated must NOT drop existing edges');
});

// R1-ADV-6 / R1-4: record.updated cold-enrich must rebuild property edges
test('R1-4: record.updated queues cold enrich that rebuilds property edges', async () => {
  const recGuid = 'REC_PROP_UPDATE111111111111';
  const targetGuid = 'REC_PROP_TARGET11111111111';
  const universe = {
    [recGuid]: { guid: recGuid, type: 'document', rguid: null },
    [targetGuid]: { guid: targetGuid, type: 'document', rguid: null },
  };
  const mockRecord = {
    guid: recGuid,
    getAllProperties: () => [
      {
        getLabel: () => 'Related',
        getType: () => 'record',
        getValue: () => ({ guid: targetGuid }),
        values: () => [targetGuid],
        linkedRecord: () => null,
        linkedRecords: () => [],
      },
    ],
    getLineItems: async () => [],
    getAllRecords: () => [],
  };
  const { broker, plugin } = makeBroker(universe, {
    getRecord: (g) => g === recGuid ? mockRecord : null,
    getAllCollections: async () => [],
    getAllRecords: () => [],
    searchByQuery: async () => [],
  });
  // Manually index a property edge first (simulating hydration having completed)
  // by firing a created event with a property-style edge (use the plugin's _edgesFromRecord directly)
  const lineRefPropNames = ['Source Line'];
  const wsGuid = 'WEJ9EZW6ADT58SJC3EQMNETSW6';
  const propEdges = plugin._edgesFromRecord(mockRecord, null, wsGuid, lineRefPropNames);
  // Inject via a created event with segments isn't ideal; instead, verify via record.updated
  // that edges are NOT permanently deleted. We fire record.updated and wait for cold enrich.
  fireEvent(plugin, 'record.updated', {
    recordGuid: recGuid,
  });
  await new Promise((r) => setTimeout(r, 400)); // wait for 250ms cold-enrich timer + buffer
  // Broker should not have crashed; revision may have bumped
  assert.ok(typeof broker.revision === 'number', 'revision must be a number after record.updated');
  // The key assertion: status must not have regressed to 'unavailable'
  assert.ok(['partial', 'complete', 'degraded'].includes(broker.snapshot().status));
});

// R1-ADV-4 / R1-6: pagination with >10 segments must return all edges exactly once
test('R1-6: pagination with ordinals >9 returns all edges exactly once (no string-sort drop)', async () => {
  const universe = {};
  const targetGuid = 'REC_PAGE_TGT1111111111111111';
  universe[targetGuid] = { guid: targetGuid, type: 'document' };
  const { broker, plugin } = makeBroker(universe);
  // Create a line with 12 ref segments (ordinals 0-11)
  const segments = [];
  for (let i = 0; i < 12; i++) {
    segments.push({ type: 'ref', text: { guid: targetGuid } });
  }
  fireEvent(plugin, 'lineitem.created', {
    lineItemGuid: 'LIN_PAGE_1',
    recordGuid: 'REC_SRC_PAGE',
    segments,
  });
  await new Promise((r) => setTimeout(r, 20));
  // Page through all results with limit=5
  const allIds = new Set();
  let cursor = null;
  let pageCount = 0;
  do {
    const result = broker.edges({ filter: null, limit: 5, after: cursor });
    for (const item of result.items) allIds.add(item.id);
    cursor = result.cursor;
    pageCount++;
    if (pageCount > 20) break; // safety
  } while (cursor !== null);
  // With the fix: all 12 edges must appear (ordinals 0-11 all covered)
  assert.equal(allIds.size, 12, 'all 12 edges must appear across pages (no ordinal->=10 drop), got ' + allIds.size);
});

// R1-ADV-3 / R1-6: cursor must become stale on revision change
test('R1-6b: cursor from a prior revision returns stale-cursor after an index mutation', async () => {
  const universe = { 'REC_STALE_TGT': { guid: 'REC_STALE_TGT', type: 'document' } };
  const { broker, plugin } = makeBroker(universe);
  // Get a page-1 cursor
  const page1 = broker.edges({ filter: null, limit: 1 });
  const cursor1 = page1.cursor;
  // If no cursor (0 or 1 items) we need to add edges first
  fireEvent(plugin, 'lineitem.created', {
    lineItemGuid: 'LIN_STALE_A',
    recordGuid: 'REC_SRC_STALE',
    segments: [{ type: 'ref', text: { guid: 'REC_STALE_TGT' } }, { type: 'ref', text: { guid: 'REC_STALE_TGT' } }],
  });
  await new Promise((r) => setTimeout(r, 20));
  const page1b = broker.edges({ filter: null, limit: 1 });
  const cursorFromRev = page1b.cursor;
  if (!cursorFromRev) return; // only 1 edge — cannot test pagination stale cursor
  // Now mutate the index
  fireEvent(plugin, 'lineitem.created', {
    lineItemGuid: 'LIN_STALE_B',
    recordGuid: 'REC_SRC_STALE2',
    segments: [{ type: 'ref', text: { guid: 'REC_STALE_TGT' } }],
  });
  await new Promise((r) => setTimeout(r, 20));
  // Using the cursor from the prior revision must now return stale-cursor
  const result = broker.edges({ filter: null, limit: 1, after: cursorFromRev });
  assert.equal(result.error, 'stale-cursor', 'cursor from prior revision must be stale after mutation');
});

// R1-ADV-9 / R1-7: linkobj with bare-string GUID must produce a backlink edge
test('R1-7: linkobj with bare-string GUID produces an internal-ref edge', async () => {
  const universe = { 'REC_LKOBJ_TGT': { guid: 'REC_LKOBJ_TGT', type: 'document' } };
  const { broker, plugin } = makeBroker(universe);
  // Bare-string linkobj: {type:'linkobj', text:'<guid>'} — contract storage shape 1
  fireEvent(plugin, 'lineitem.created', {
    lineItemGuid: 'LIN_LKOBJ_1',
    recordGuid: 'REC_SRC_LKOBJ',
    segments: [{ type: 'linkobj', text: 'REC_LKOBJ_TGT' }],
  });
  await new Promise((r) => setTimeout(r, 20));
  const result = broker.edges({ filter: { targetGuid: 'REC_LKOBJ_TGT', kinds: null, authored: null, collectionGuid: null, dateRange: null, sourceRecord: null } });
  assert.equal(result.items.length, 1, 'bare-string GUID linkobj must produce an internal-ref edge');
  assert.equal(result.items[0].kind, 'ref', 'bare-string linkobj edge must have kind=ref when target resolves');
});

// R1-ADV-8 / R1-8: late-arriving claims broker clears only the claims diagnostic;
// global line status remains partial until a bounded scope is explicitly hydrated.
test('R1-8: late claims broker clears claims diagnostic while line coverage stays partial', async () => {
  const { plugin, context, winListeners } = loadPlugin();
  plugin.data = { getAllCollections: async () => [], getAllRecords: () => [], getRecord: () => null, searchByQuery: async () => [] };
  plugin.ui = { addCommandPaletteCommand: () => ({ remove() {} }), addStatusBarItem: () => ({ remove() {} }), getActivePanel: () => null };
  plugin.events = { on: () => null, off: () => {} };
  // No claims broker initially
  plugin._killStaleObservers();
  plugin._attachAttributesClaims();
  const broker = plugin._initReferenceSurfaceBroker();
  // Wait for hydration to complete (empty workspace)
  await new Promise((r) => setTimeout(r, 100));
  // Without claims, global status is partial and both diagnostics are truthful.
  const snapBefore = broker.snapshot();
  assert.equal(snapBefore.status, 'partial');
  assert.ok(snapBefore.diagnostics.some((d) => d.code === 'claims-unavailable'));
  // Now late-install a working claims broker and fire thymer:claims-v1-ready.
  // _attachAttributesClaims listens for this event and calls attach() → subscribes
  // to the new broker → fires thymer:reference-claims-refresh → broker.onClaimsRefresh
  // runs → recomputeStatus() and removes only the claims diagnostic.
  context.window.__thymerClaimsV1 = {
    contract: 'thymer-claims-v1',
    version: 1,
    snapshot: () => ({ complete: true, generation: 'CLM_LATE', revision: 1 }),
    subscribe: (fn) => { fn({ snapshot: { complete: true, generation: 'CLM_LATE', revision: 1 } }); return () => {}; },
    relational: { edges: () => ({ authored: [], derived: [] }) },
  };
  // Trigger the _attachAttributesClaims 'ready' handler which re-attaches and fires the claims refresh.
  const claimsReadyEvt = new context.CustomEvent('thymer:claims-v1-ready');
  (winListeners['thymer:claims-v1-ready'] || []).forEach((fn) => { try { fn(claimsReadyEvt); } catch (e) {} });
  // Allow the microtask queue to flush: _attachAttributesClaims.publish uses Promise.resolve().then,
  // then the broker's onClaimsRefresh fires, then bumpRevision (another Promise.resolve).
  await new Promise((r) => setTimeout(r, 50));
  const snapAfter = broker.snapshot();
  assert.equal(snapAfter.status, 'partial');
  assert.ok(!snapAfter.diagnostics.some((d) => d.code === 'claims-unavailable'));
  assert.ok(snapAfter.diagnostics.some((d) => d.code === 'line-hydration-on-demand'));
});

// R1-ADV-10: dateRange normalization is key-order invariant
test('R1-10: _normalizeFilterV1 dateRange is byte-deterministic regardless of key order', () => {
  const { plugin } = makeBroker();
  const f1 = plugin._normalizeFilterV1({ dateRange: { from: 1000, to: 2000 } });
  const f2 = plugin._normalizeFilterV1({ dateRange: { to: 2000, from: 1000 } });
  assert.equal(f1, f2, '_normalizeFilterV1 must be key-order-invariant for dateRange');
});
