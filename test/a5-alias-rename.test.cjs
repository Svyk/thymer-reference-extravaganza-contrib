'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function makeHarness() {
  const storage = new Map();
  const records = new Map();
  const document = { querySelector: () => null, createElement: () => ({}), body: { append() {} } };
  const window = {
    CSS: { escape: String },
    g_universe: { workspace: { guid: 'WS_A5' }, itemsByGuid: {} },
    __thymerReferenceSurfaceV1: null,
  };
  const context = {
    AppPlugin: class {}, console, Promise, Date, Math, Map, Set, WeakMap, WeakSet,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    document, window, CSS: window.CSS,
    MutationObserver: class { observe() {} disconnect() {} }, DateTime: undefined,
    navigator: { platform: 'MacIntel', clipboard: {} },
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
  plugin.workspaceGuid = 'WS_A5';
  plugin._unloaded = false;
  plugin._aliasInit();
  plugin.data = { getRecord: (guid) => records.get(guid) || null };
  return { plugin, records, storage, window };
}

function aliasItem(plugin, text) {
  return plugin._aliasMakeItem(text, 'registry', { addedAt: '2026-07-13T00:00:00.000Z', addedBy: 'test' });
}

function edge(lineGuid, sourceRecordGuid, targetGuid, title, ordinal = 0) {
  return {
    id: 'ref:v1:' + lineGuid + ':' + ordinal + ':' + targetGuid,
    kind: 'ref', title,
    source: { lineGuid, recordGuid: sourceRecordGuid, segmentOrdinal: ordinal },
    target: { kind: 'record', guid: targetGuid },
  };
}

test('A5 record rename updates managed titles but preserves a current record-alias title', () => {
  const { plugin } = makeHarness();
  plugin._aliasReplaceRecordSet('TARGET', [aliasItem(plugin, 'Old target text')]);
  const segments = [
    { type: 'ref', text: { guid: 'TARGET', title: 'Old target text' } },
    { type: 'text', text: ' + ' },
    { type: 'ref', text: { guid: 'TARGET', title: 'Canonical before' } },
  ];
  const meta = { v: 1, refs: { 'TARGET#0': 'Old target text', 'TARGET#1': 'Canonical before' } };

  const out = plugin._rewriteAutoLineRefTitles(segments, 'TARGET', 'Canonical before', 'Canonical after', meta);

  assert.equal(out.segments[0].text.guid, 'TARGET', 'guid identity must never change');
  assert.equal(out.segments[0].text.title, 'Old target text', 'record alias remains the chip title');
  assert.equal(out.meta.refs['TARGET#0'], undefined, 'alias drops managed-title provenance');
  assert.equal(out.segments[2].text.title, 'Canonical after', 'non-alias managed title follows rename');
  assert.equal(out.meta.refs['TARGET#1'], 'Canonical after');
});

test('A5 alias rewrite preserves rich segments and the complete ref payload including viewId', () => {
  const { plugin } = makeHarness();
  const before = [
    { type: 'text', text: 'prefix ', marks: ['bold'] },
    { type: 'ref', text: { guid: 'TARGET', title: 'Old Alias', viewId: 'VIEW_1', custom: { keep: true } }, extra: 'segment-field' },
    { type: 'datetime', text: { timestamp: 123, formatted: 'Today' } },
    { type: 'ref', text: { guid: 'OTHER', title: 'Old Alias', viewId: 'VIEW_2' } },
  ];

  const out = plugin._aliasRewriteRefTitles(before, 'TARGET', 'old alias', 'New Alias');

  assert.equal(out.changed, 1);
  assert.equal(out.segments[1].text.title, 'New Alias');
  assert.equal(out.segments[1].text.viewId, 'VIEW_1');
  assert.deepEqual(JSON.parse(JSON.stringify(out.segments[1].text.custom)), { keep: true });
  assert.equal(out.segments[1].extra, 'segment-field');
  assert.deepEqual(JSON.parse(JSON.stringify(out.segments[0])), JSON.parse(JSON.stringify(before[0])));
  assert.deepEqual(JSON.parse(JSON.stringify(out.segments[2])), JSON.parse(JSON.stringify(before[2])));
  assert.equal(out.segments[3].text.title, 'Old Alias', 'other targets are untouched');
  assert.equal(before[1].text.title, 'Old Alias', 'pure rewrite does not mutate the input');
});

test('A5 preview applies a deduped segment-preserving rename, stores a receipt, and undo restores it', async () => {
  const { plugin, records, storage } = makeHarness();
  const targetGuid = 'TARGET';
  const sourceRecordGuid = 'SOURCE_RECORD';
  const line = {
    guid: 'LINE_1',
    segments: [
      { type: 'ref', text: { guid: targetGuid, title: 'Old Alias', viewId: 'VIEW_A' } },
      { type: 'text', text: ' and ' },
      { type: 'ref', text: { guid: targetGuid, title: 'Old Alias', viewId: 'VIEW_B' } },
    ],
    async setSegments(next) { this.segments = next; return true; },
  };
  records.set(sourceRecordGuid, { guid: sourceRecordGuid, getName: () => 'Source page', getLineItems: async () => [line] });
  plugin._recordNameIndex.set(sourceRecordGuid, 'Source page');
  plugin._referenceSurfaceBroker = {
    snapshot: () => ({ status: 'complete' }),
    inEdges: () => [
      edge(line.guid, sourceRecordGuid, targetGuid, 'Old Alias', 0),
      edge(line.guid, sourceRecordGuid, targetGuid, 'Old Alias', 2),
    ],
  };
  plugin._resolveLiveLine = async (guid) => guid === line.guid ? line : null;

  const preview = await plugin._aliasBuildRenamePropagationPreview(targetGuid, 'Old Alias', 'New Alias');
  assert.equal(preview.entries.length, 1, 'two refs on one line produce one guarded write');
  assert.equal(preview.entries[0].refCount, 2);
  assert.equal(preview.partial, false);

  const applied = await plugin._aliasApplyRenamePropagationPreview(preview);
  assert.equal(applied.applied, 1);
  assert.equal(applied.receipt.applied[0].verified, true);
  assert.deepEqual(JSON.parse(JSON.stringify(line.segments.filter((segment) => segment.type === 'ref').map((segment) => [segment.text.title, segment.text.viewId]))), [
    ['New Alias', 'VIEW_A'], ['New Alias', 'VIEW_B'],
  ]);
  assert.equal(JSON.parse(storage.get(plugin._aliasRenameReceiptKey())).length, 1, 'receipt is durable per workspace');

  const undone = await plugin._aliasUndoRenamePropagation(applied.receipt.id);
  assert.equal(undone.restored, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(line.segments.filter((segment) => segment.type === 'ref').map((segment) => segment.text.title))), ['Old Alias', 'Old Alias']);
  assert.equal(JSON.parse(storage.get(plugin._aliasRenameReceiptKey())).length, 0, 'fully restored receipt is removed');

  const idempotent = await plugin._aliasUndoRenamePropagation(applied.receipt.id);
  assert.equal(idempotent.ok, false, 'second undo cannot replay a consumed receipt');
});

test('L3 line alias rename propagation preserves the line GUID and supports hash-gated undo', async () => {
  const { plugin, records } = makeHarness();
  const targetLineGuid = 'TARGET_LINE_GUID';
  const source = {
    guid: 'SOURCE_LINE_GUID',
    segments: [
      { type: 'text', text: 'See ', marks: ['italic'] },
      { type: 'ref', text: { guid: targetLineGuid, title: 'Old claim', viewId: 'VIEW_LINE' } },
      { type: 'datetime', text: { timestamp: 123 } },
    ],
    async setSegments(next) { this.segments = next; return true; },
  };
  records.set('SOURCE_RECORD', { guid: 'SOURCE_RECORD', getName: () => 'Source record', getLineItems: async () => [source] });
  plugin._referenceSurfaceBroker = {
    snapshot: () => ({ status: 'complete' }),
    inEdges: () => [{
      id: 'ref:v1:SOURCE_LINE_GUID:1:TARGET_LINE_GUID', kind: 'ref', title: 'Old claim',
      source: { lineGuid: source.guid, recordGuid: 'SOURCE_RECORD', segmentOrdinal: 1 },
      target: { kind: 'line', guid: targetLineGuid },
    }],
  };
  plugin._resolveLiveLine = async (guid) => guid === source.guid ? source : null;

  const preview = await plugin._aliasBuildRenamePropagationPreview(targetLineGuid, 'Old claim', 'New claim');
  assert.equal(preview.entries.length, 1);
  const applied = await plugin._aliasApplyRenamePropagationPreview(preview);
  assert.equal(applied.applied, 1);
  assert.equal(source.segments[1].text.guid, targetLineGuid);
  assert.equal(source.segments[1].text.title, 'New claim');
  assert.equal(source.segments[1].text.viewId, 'VIEW_LINE');
  assert.deepEqual(JSON.parse(JSON.stringify(source.segments[0])), { type: 'text', text: 'See ', marks: ['italic'] });
  assert.deepEqual(JSON.parse(JSON.stringify(source.segments[2])), { type: 'datetime', text: { timestamp: 123 } });

  const undone = await plugin._aliasUndoRenamePropagation(applied.receipt.id);
  assert.equal(undone.restored, 1);
  assert.equal(source.segments[1].text.guid, targetLineGuid);
  assert.equal(source.segments[1].text.title, 'Old claim');
});

test('A5 apply refuses a source changed after preview and emits no write receipt', async () => {
  const { plugin, records } = makeHarness();
  const line = {
    guid: 'LINE_STALE',
    segments: [{ type: 'ref', text: { guid: 'TARGET', title: 'Old Alias', viewId: 'V' } }],
    writes: 0,
    async setSegments(next) { this.writes++; this.segments = next; return true; },
  };
  records.set('SOURCE', { guid: 'SOURCE', getName: () => 'Source', getLineItems: async () => [line] });
  plugin._referenceSurfaceBroker = {
    snapshot: () => ({ status: 'complete' }),
    inEdges: () => [edge(line.guid, 'SOURCE', 'TARGET', 'Old Alias')],
  };
  plugin._resolveLiveLine = async () => line;
  const preview = await plugin._aliasBuildRenamePropagationPreview('TARGET', 'Old Alias', 'New Alias');
  line.segments.push({ type: 'text', text: 'remote edit' });

  const result = await plugin._aliasApplyRenamePropagationPreview(preview);

  assert.equal(result.applied, 0);
  assert.equal(result.receipt.skipped.some((item) => item.reason === 'source-changed'), true);
  assert.equal(line.writes, 0);
  assert.equal(plugin._aliasReadRenameReceipts().length, 0);
});

test('A5 undo refuses stale reversal and keeps the remaining receipt for retry', async () => {
  const { plugin, records } = makeHarness();
  const line = {
    guid: 'LINE_UNDO_STALE',
    segments: [{ type: 'ref', text: { guid: 'TARGET', title: 'Old Alias', viewId: 'V' } }],
    async setSegments(next) { this.segments = next; return true; },
  };
  records.set('SOURCE', { guid: 'SOURCE', getName: () => 'Source', getLineItems: async () => [line] });
  plugin._referenceSurfaceBroker = {
    snapshot: () => ({ status: 'complete' }),
    inEdges: () => [edge(line.guid, 'SOURCE', 'TARGET', 'Old Alias')],
  };
  plugin._resolveLiveLine = async () => line;
  const preview = await plugin._aliasBuildRenamePropagationPreview('TARGET', 'Old Alias', 'New Alias');
  const applied = await plugin._aliasApplyRenamePropagationPreview(preview);
  line.segments.push({ type: 'text', text: 'post-apply edit' });

  const result = await plugin._aliasUndoRenamePropagation(applied.receipt.id);

  assert.equal(result.restored, 0);
  assert.equal(result.skipped[0].reason, 'source-changed');
  assert.equal(result.receipt.applied.length, 1);
  assert.equal(plugin._aliasReadRenameReceipts()[0].id, applied.receipt.id);
});

test('A5 alias rename receipt store remains bounded to the newest 20 operations', () => {
  const { plugin } = makeHarness();
  for (let i = 0; i < 25; i++) plugin._aliasStoreRenameReceipt({ v: 1, id: 'R' + i, op: 'propagate-alias-rename', applied: [] });
  const receipts = plugin._aliasReadRenameReceipts();
  assert.equal(receipts.length, 20);
  assert.equal(receipts[0].id, 'R5');
  assert.equal(receipts[19].id, 'R24');
});
