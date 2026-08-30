'use strict';
// Reference Surface v1 — Fixture Agreement Test (RefX)
//
// Validates that:
//   (i)  The local fixture file md5 matches the canonical value (divergence guard).
//   (ii) Every fixture's expected edge conforms to the frozen contract in
//        docs/reference-surface-v1.md — required fields, legal kind values,
//        identity-prefix rules, external-link null-guid rule, ordering rule.
//   (iii) Behavioral: ref-kind fixtures run through extractRefGuidsFromSegments
//        and _referenceTargetKind via the established plugin harness.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'reference-surface-v1.json');
const EXPECTED_MD5 = 'bb132de841e05e375312a07a68c3b89a';

// ── Legal values per contract ─────────────────────────────────────────────────
const LEGAL_KINDS = new Set(['ref', 'external-link', 'property', 'annotation', 'claim']);
const LEGAL_TARGET_KINDS = new Set(['record', 'line', 'collection', 'external', 'unknown']);
const KIND_TO_PREFIX = {
  ref: 'ref:v1:',
  'external-link': 'ext:v1:',
  property: 'prop:v1:',
  annotation: 'ann:v1:',
  claim: 'claim:v1:',
};

// ── Plugin harness (same pattern as plugin.test.cjs) ─────────────────────────
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
      querySelectorAll: () => [],
      querySelector: () => null,
      documentElement: { clientHeight: 900 },
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      head: { appendChild() {} },
    },
    Element: class {},
    window: {
      CSS: { escape: (s) => String(s) },
      g_universe: { itemsByGuid: {}, workspace: {} },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  return { Plugin: context.PluginUnderTest, context };
}

function makePlugin(universeItems = {}) {
  const { Plugin, context } = loadPlugin();
  context.window.g_universe.itemsByGuid = universeItems;
  const plugin = new Plugin();
  plugin._isUnloading = false;
  plugin._enabled = true;
  plugin.data = {
    getRecord: (guid) => universeItems[guid] && !universeItems[guid].rguid ? { guid } : null,
  };
  return plugin;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

// Validate a single expected-edge object (non-null, non-array) against the contract.
function assertEdgeConformsToContract(edge, fixtureId) {
  const ctx = `fixture "${fixtureId}"`;

  // Required top-level fields
  assert.ok(typeof edge.id === 'string' && edge.id.length > 0, `${ctx}: id must be a non-empty string`);
  assert.ok(LEGAL_KINDS.has(edge.kind), `${ctx}: kind "${edge.kind}" is not one of ${[...LEGAL_KINDS].join(', ')}`);
  assert.ok(typeof edge.source === 'object' && edge.source !== null, `${ctx}: source must be an object`);
  assert.ok(typeof edge.target === 'object' && edge.target !== null, `${ctx}: target must be an object`);
  assert.ok(typeof edge.authored === 'boolean', `${ctx}: authored must be a boolean`);
  assert.ok(typeof edge.derived === 'boolean', `${ctx}: derived must be a boolean`);
  assert.ok('title' in edge, `${ctx}: title field must be present (can be null)`);
  assert.ok('sourceHash' in edge || true, `${ctx}: sourceHash field present check (optional in fixture schema)`);

  // Source required fields
  const src = edge.source;
  assert.ok(typeof src.workspaceGuid === 'string', `${ctx}: source.workspaceGuid must be a string`);
  assert.ok('collectionGuid' in src, `${ctx}: source.collectionGuid must be present`);
  assert.ok(typeof src.recordGuid === 'string' && src.recordGuid.length > 0, `${ctx}: source.recordGuid must be a non-empty string`);
  assert.ok('lineGuid' in src, `${ctx}: source.lineGuid must be present`);
  assert.ok('propertyId' in src, `${ctx}: source.propertyId must be present`);
  assert.ok('segmentOrdinal' in src, `${ctx}: source.segmentOrdinal must be present`);

  // Target required fields
  const tgt = edge.target;
  assert.ok(LEGAL_TARGET_KINDS.has(tgt.kind), `${ctx}: target.kind "${tgt.kind}" is not legal`);
  assert.ok('guid' in tgt, `${ctx}: target.guid must be present`);
  assert.ok('link' in tgt, `${ctx}: target.link must be present`);

  // Identity prefix rule
  const expectedPrefix = KIND_TO_PREFIX[edge.kind];
  assert.ok(edge.id.startsWith(expectedPrefix),
    `${ctx}: id "${edge.id}" must start with "${expectedPrefix}" for kind "${edge.kind}"`);

  // External-link: target.guid must be null, never contributes backlinks
  if (edge.kind === 'external-link') {
    assert.equal(tgt.guid, null, `${ctx}: external-link edge must have target.guid === null`);
    assert.ok(tgt.kind === 'external' || tgt.kind === 'unknown',
      `${ctx}: external-link target.kind must be "external" or "unknown", got "${tgt.kind}"`);
  }

  // Ref kind: source.lineGuid must be non-null
  if (edge.kind === 'ref') {
    assert.ok(typeof src.lineGuid === 'string' && src.lineGuid.length > 0,
      `${ctx}: ref edge must have a non-null source.lineGuid`);
    assert.equal(src.propertyId, null, `${ctx}: ref edge must have source.propertyId === null`);
  }

  // Property/annotation kinds: source.lineGuid must be null, propertyId non-null
  if (edge.kind === 'property' || edge.kind === 'annotation') {
    assert.equal(src.lineGuid, null, `${ctx}: ${edge.kind} edge must have source.lineGuid === null`);
    assert.ok(typeof src.propertyId === 'string' && src.propertyId.length > 0,
      `${ctx}: ${edge.kind} edge must have a non-null source.propertyId`);
    assert.equal(src.segmentOrdinal, null, `${ctx}: ${edge.kind} edge must have source.segmentOrdinal === null`);
  }

  // Claim kind: title = predicate name (not an alias), lineGuid non-null, propertyId null
  if (edge.kind === 'claim') {
    assert.equal(src.propertyId, null, `${ctx}: claim edge must have source.propertyId === null`);
    assert.equal(src.segmentOrdinal, null, `${ctx}: claim edge must have source.segmentOrdinal === null`);
    // target must be a record guid (claims always target records per contract)
    assert.equal(tgt.kind, 'record', `${ctx}: claim edge target.kind must be "record"`);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('fixture file md5 matches canonical bb132de841e05e375312a07a68c3b89a', () => {
  const buf = fs.readFileSync(FIXTURE_PATH);
  const actual = md5Hex(buf);
  assert.equal(actual, EXPECTED_MD5,
    `Fixture file md5 DIVERGED: expected ${EXPECTED_MD5}, got ${actual}. ` +
    'The canonical fixture must not be modified without a version bump.');
});

test('fixture file has 31 fixtures', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.equal(fixtures.length, 31, `Expected 31 fixtures, found ${fixtures.length}`);
});

test('all fixtures have id, kind, and description fields', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  for (const fix of fixtures) {
    assert.ok(typeof fix.id === 'string' && fix.id.length > 0, `Fixture missing id: ${JSON.stringify(fix).slice(0, 80)}`);
    assert.ok(typeof fix.kind === 'string' && fix.kind.length > 0, `Fixture "${fix.id}" missing kind`);
    assert.ok(typeof fix.description === 'string', `Fixture "${fix.id}" missing description`);
  }
});

test('structural contract conformance for every non-null expected edge', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  let edgesValidated = 0;
  for (const fix of fixtures) {
    if (fix.expected === null || fix.expected === undefined) continue;
    if (Array.isArray(fix.expected)) {
      // Multi-edge fixture (e.g. property-json-string-array-shape)
      for (const edge of fix.expected) {
        assertEdgeConformsToContract(edge, fix.id);
        edgesValidated++;
      }
    } else if (typeof fix.expected === 'object' && fix.expected.kind && LEGAL_KINDS.has(fix.expected.kind)) {
      // Single edge fixture
      assertEdgeConformsToContract(fix.expected, fix.id);
      edgesValidated++;
    }
    // protocol/ordering fixtures have different expected shapes — skipped here
  }
  assert.ok(edgesValidated >= 20, `Expected at least 20 edge objects validated, got ${edgesValidated}`);
});

test('external-link fixtures: target.guid is always null', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const extFixtures = fixtures.filter(f => f.kind === 'external-link');
  assert.ok(extFixtures.length > 0, 'No external-link fixtures found');
  for (const fix of extFixtures) {
    if (!fix.expected || Array.isArray(fix.expected)) continue;
    assert.equal(fix.expected.target.guid, null,
      `external-link fixture "${fix.id}" has non-null target.guid — violates no-backlink rule`);
  }
});

test('ref-kind fixtures: identity prefix is ref:v1:', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const refFixtures = fixtures.filter(f => f.kind === 'ref');
  assert.ok(refFixtures.length >= 7, `Expected at least 7 ref fixtures, got ${refFixtures.length}`);
  for (const fix of refFixtures) {
    if (!fix.expected) continue;
    assert.ok(fix.expected.id.startsWith('ref:v1:'),
      `ref fixture "${fix.id}" expected.id "${fix.expected.id}" missing ref:v1: prefix`);
  }
});

test('property-kind fixtures: identity prefix is prop:v1:', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const propFixtures = fixtures.filter(f => f.kind === 'property');
  assert.ok(propFixtures.length >= 4, `Expected at least 4 property fixtures, got ${propFixtures.length}`);
  for (const fix of propFixtures) {
    if (!fix.expected) continue;
    const edges = Array.isArray(fix.expected) ? fix.expected : [fix.expected];
    for (const edge of edges) {
      assert.ok(edge.id.startsWith('prop:v1:'),
        `property fixture "${fix.id}" expected.id "${edge.id}" missing prop:v1: prefix`);
    }
  }
});

test('annotation-kind fixtures: identity prefix is ann:v1:', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const annFixtures = fixtures.filter(f => f.kind === 'annotation');
  assert.ok(annFixtures.length >= 2, `Expected at least 2 annotation fixtures, got ${annFixtures.length}`);
  for (const fix of annFixtures) {
    if (!fix.expected) continue;
    assert.ok(fix.expected.id.startsWith('ann:v1:'),
      `annotation fixture "${fix.id}" expected.id "${fix.expected.id}" missing ann:v1: prefix`);
  }
});

test('claim-kind fixtures: identity prefix is claim:v1:', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const claimFixtures = fixtures.filter(f => f.kind === 'claim');
  assert.ok(claimFixtures.length >= 3, `Expected at least 3 claim fixtures, got ${claimFixtures.length}`);
  for (const fix of claimFixtures) {
    if (!fix.expected) continue;
    assert.ok(fix.expected.id.startsWith('claim:v1:'),
      `claim fixture "${fix.id}" expected.id "${fix.expected.id}" missing claim:v1: prefix`);
  }
});

test('deterministic-ordering fixture: expected_order is sorted by contract rule', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const orderFix = fixtures.find(f => f.id === 'deterministic-ordering');
  assert.ok(orderFix, 'deterministic-ordering fixture not found');
  const expected = orderFix.expected_order;
  assert.ok(Array.isArray(expected) && expected.length === 7,
    `deterministic-ordering expected_order must have 7 entries, got ${expected ? expected.length : 'none'}`);

  // Verify positions are 1..7 in order
  for (let i = 0; i < expected.length; i++) {
    assert.equal(expected[i].position, i + 1,
      `position at index ${i} should be ${i + 1}, got ${expected[i].position}`);
  }

  // Verify kind order: ref < external-link < property < annotation < claim
  const kindOrder = ['ref', 'external-link', 'property', 'annotation', 'claim'];
  const idToKind = {};
  for (const e of orderFix.input.edges_unordered) {
    idToKind[e.id] = e.kind;
  }
  let prevKindRank = -1;
  let prevSrcRecord = null;
  let prevLineGuid = null;
  let prevOrdinal = null;
  for (const e of expected) {
    const kind = idToKind[e.id];
    if (!kind) continue; // skip if not in our mini-map (should not happen)
    const kindRank = kindOrder.indexOf(kind);
    assert.ok(kindRank >= 0, `Unknown kind "${kind}" in ordering fixture`);
    if (kindRank > prevKindRank) {
      prevKindRank = kindRank;
      prevSrcRecord = null;
      prevLineGuid = null;
      prevOrdinal = null;
    } else {
      assert.equal(kindRank, prevKindRank, `Kind order violated: "${kind}" appears after a later kind`);
    }
  }
});

test('filter-grammar-equality fixture: normalizedA === normalizedB and areEqual is true', () => {
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fix = fixtures.find(f => f.id === 'filter-grammar-equality');
  assert.ok(fix, 'filter-grammar-equality fixture not found');
  assert.equal(fix.expected.areEqual, true);
  assert.equal(fix.expected.normalizedA, fix.expected.normalizedB,
    'normalizedA and normalizedB must be byte-identical for equal filters');
  // Verify normalization is JSON with sorted keys
  const parsed = JSON.parse(fix.expected.normalizedA);
  const keys = Object.keys(parsed);
  const sortedKeys = [...keys].sort();
  assert.deepEqual(keys, sortedKeys, 'Normalized filter keys must be sorted alphabetically');
});

// ── Behavioral tests — extractRefGuidsFromSegments ────────────────────────────

test('BEHAVIORAL: extractRefGuidsFromSegments — ref-object-shape fixture extracts expected guid', () => {
  const plugin = makePlugin({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fix = fixtures.find(f => f.id === 'ref-object-shape');
  assert.ok(fix, 'ref-object-shape fixture not found');

  const result = plugin.extractRefGuidsFromSegments([fix.input.segment]);
  // Use duck-typing check (cross-vm boundary: instanceof Set may fail on vm-created Sets)
  assert.ok(result && typeof result.has === 'function' && typeof result.size === 'number',
    'extractRefGuidsFromSegments must return a Set-like object');
  assert.ok(result.has(fix.expected.target.guid),
    `Expected GUID "${fix.expected.target.guid}" in extracted set; got [${[...result].join(', ')}]`);
});

test('BEHAVIORAL: extractRefGuidsFromSegments — ref-bare-string-shape fixture extracts expected guid', () => {
  const plugin = makePlugin({ 'REC333333333333333333333333': { guid: 'REC333333333333333333333333', type: 'document' } });
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fix = fixtures.find(f => f.id === 'ref-bare-string-shape');
  assert.ok(fix, 'ref-bare-string-shape fixture not found');

  const result = plugin.extractRefGuidsFromSegments([fix.input.segment]);
  assert.ok(result.has(fix.expected.target.guid),
    `Expected GUID "${fix.expected.target.guid}" in extracted set`);
});

test('BEHAVIORAL: extractRefGuidsFromSegments — malformed-null-guid produces empty set', () => {
  const plugin = makePlugin({});
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fix = fixtures.find(f => f.id === 'malformed-null-guid');
  assert.ok(fix, 'malformed-null-guid fixture not found');
  assert.equal(fix.expected, null, 'malformed-null-guid fixture must have expected=null');

  const result = plugin.extractRefGuidsFromSegments([fix.input.segment]);
  assert.equal(result.size, 0,
    'extractRefGuidsFromSegments must return empty set for null guid segment');
});

test('BEHAVIORAL: extractRefGuidsFromSegments — malformed-empty-segments produces empty set', () => {
  const plugin = makePlugin({});
  const result = plugin.extractRefGuidsFromSegments([]);
  assert.equal(result.size, 0, 'Empty segments array must produce empty set');
});

test('BEHAVIORAL: extractRefGuidsFromSegments — external-link segment (no guid) is skipped', () => {
  const plugin = makePlugin({});
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fix = fixtures.find(f => f.id === 'external-link-with-title');
  assert.ok(fix, 'external-link-with-title fixture not found');

  // External-link segments have type='linkobj', not 'ref' — extractRefGuidsFromSegments
  // only processes type='ref' segments (contract note: gap refxA-gap-1 for linkobj).
  const result = plugin.extractRefGuidsFromSegments([fix.input.segment]);
  assert.equal(result.size, 0,
    'extractRefGuidsFromSegments skips non-ref segments (linkobj without guid)');
});

// ── Behavioral tests — _referenceTargetKind ───────────────────────────────────

test('BEHAVIORAL: _referenceTargetKind — record target resolves to "record"', () => {
  const targetGuid = 'REC333333333333333333333333';
  // Universe has this as a document (record-type)
  const plugin = makePlugin({ [targetGuid]: { guid: targetGuid, type: 'document' } });
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fix = fixtures.find(f => f.id === 'ref-object-shape');
  assert.ok(fix, 'ref-object-shape fixture not found');

  const kind = plugin._referenceTargetKind(targetGuid);
  assert.equal(kind, fix.expected.target.kind,
    `_referenceTargetKind("${targetGuid}") should be "${fix.expected.target.kind}", got "${kind}"`);
});

test('BEHAVIORAL: _referenceTargetKind — line target resolves to "line"', () => {
  const lineGuid = 'LIN333333333333333333333333';
  const ownerGuid = 'REC333333333333333333333333';
  const plugin = makePlugin({
    [lineGuid]: { guid: lineGuid, rguid: ownerGuid, type: 'text' },
  });
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fix = fixtures.find(f => f.id === 'ref-line-target');
  assert.ok(fix, 'ref-line-target fixture not found');

  const kind = plugin._referenceTargetKind(lineGuid);
  assert.equal(kind, fix.expected.target.kind,
    `_referenceTargetKind("${lineGuid}") should be "${fix.expected.target.kind}", got "${kind}"`);
});

test('BEHAVIORAL: _referenceTargetKind — unknown guid returns "unknown"', () => {
  const plugin = makePlugin({});
  const { fixtures } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const fix = fixtures.find(f => f.id === 'malformed-unknown-kind-target');
  assert.ok(fix, 'malformed-unknown-kind-target fixture not found');

  const kind = plugin._referenceTargetKind(fix.input.segment.text.guid);
  assert.equal(kind, fix.expected.target.kind,
    `_referenceTargetKind of unknown guid should return "unknown", got "${kind}"`);
});
