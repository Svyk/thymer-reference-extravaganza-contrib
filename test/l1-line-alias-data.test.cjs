'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function node() {
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append() {}, appendChild(value) { return value; }, remove() {}, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
}

function loadPlugin() {
  const storage = new Map();
  const document = {
    hidden: false, body: node(), head: node(), documentElement: { clientHeight: 900 },
    createElement: node, createTextNode: (text) => ({ textContent: text }),
    querySelector: () => null, querySelectorAll: () => [], getElementsByClassName: () => [], getElementById: () => null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, contains: () => true,
  };
  const window = {
    CSS: { escape: String }, innerWidth: 1440, innerHeight: 900,
    g_universe: { itemsByGuid: {}, listviews: [], workspace: { guid: 'WS_LINE_ALIAS' } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  const context = {
    AppPlugin: class {}, console, Promise, Date, Math, Map, Set, WeakMap, WeakSet,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false }), 0), cancelIdleCallback: clearTimeout,
    document, window, CSS: window.CSS, Element: class {}, DateTime: undefined,
    navigator: { platform: 'MacIntel', userAgent: 'Mac', clipboard: { writeText: async () => {}, readText: async () => '' } },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail || null; } },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'), btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  };
  context.globalThis = context;
  Object.assign(context, window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  return { Plugin: context.PluginUnderTest, context };
}

function makeRegistry() {
  let sequence = 0;
  const calls = [];
  const registry = {
    guid: 'REC_LINE_ALIAS_REGISTRY', lines: [],
    getName: () => 'RefX Line Alias Registry',
    getLineItems: async () => [...registry.lines],
    createLineItem: async (parent, after, type, segments, props) => {
      calls.push({ parent, after, type, segments, props });
      const line = {
        guid: 'REG_LINE_' + (++sequence), type, segments,
        delete: async () => { registry.lines = registry.lines.filter((candidate) => candidate !== line); },
      };
      registry.lines.unshift(line);
      return line;
    },
  };
  return { registry, calls };
}

function harness() {
  const loaded = loadPlugin();
  const { registry, calls } = makeRegistry();
  const plugin = new loaded.Plugin();
  plugin._unloaded = false;
  plugin.workspaceGuid = 'WS_LINE_ALIAS';
  plugin.data = { getRecord: () => null, searchByQuery: async () => ({ lines: [], records: [] }) };
  plugin._lineAliasResolveRegistryRecord = async () => registry;
  plugin._r6ClientId = () => 'client-test';
  plugin._aliasInit();
  return { ...loaded, plugin, registry, calls };
}

test('L1 registry stores multiple normalized aliases with the exact SDK signature and survives reread', async () => {
  const h = harness();
  const first = await h.plugin._lineAliasAdd('LINE_A', '  Start   here ', { recordGuid: 'REC_A', currentText: 'Canonical text', status: 'active' });
  const second = await h.plugin._lineAliasAdd('LINE_A', 'Second name');
  const duplicate = await h.plugin._lineAliasAdd('LINE_A', 'START HERE');
  assert.equal(first.ok && second.ok && duplicate.ok, true);
  assert.deepEqual([...h.plugin._lineAliasGet('LINE_A').aliases].map((alias) => alias.text), ['Second name', 'Start here']);
  assert.equal(h.plugin._lineAliasGet('LINE_A').recordGuid, 'REC_A');
  assert.equal(h.plugin._lineAliasGet('LINE_A').currentText, 'Canonical text');
  assert.ok(h.calls.length >= 2);
  assert.deepEqual(h.calls.at(-1).parent, null);
  assert.deepEqual(h.calls.at(-1).after, null);
  assert.equal(h.calls.at(-1).type, 'ulist');
  assert.equal(h.calls.at(-1).props, null);
  const payload = JSON.parse(h.calls.at(-1).segments[0].text);
  assert.equal(payload.kind, 'refx-line-alias-entry');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.lineGuid, 'LINE_A');
  await h.plugin._lineAliasEnsureRegistryLoaded(true, true);
  assert.equal(h.plugin._lineAliasGet('LINE_A').aliases.length, 2);
  h.plugin._aliasDispose();
});

test('L1 collisions preserve every line while deleted targets require includeDeleted', () => {
  const h = harness();
  h.plugin._lineAliasReplaceSet('LINE_A', { recordGuid: 'REC_A', currentText: 'A', status: 'active', aliases: ['Shared'] });
  h.plugin._lineAliasReplaceSet('LINE_B', { recordGuid: 'REC_B', currentText: 'B', status: 'deleted', aliases: ['shared'] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.plugin._lineAliasResolve('shared').map((row) => row.lineGuid))), ['LINE_A']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.plugin._lineAliasResolve('shared', { includeDeleted: true }).map((row) => row.lineGuid))), ['LINE_A', 'LINE_B']);
  h.plugin._aliasReplaceRecordSet('REC_RECORD', h.plugin._aliasCoerceItems(['Shared'], 'registry'));
  assert.equal(h.plugin._aliasResolve('Shared').length, 1);
  assert.equal(h.plugin._lineAliasResolve('Shared').length, 1);
  h.plugin._aliasDispose();
});

test('L1 payload-first lifecycle retains identity across edit/move/delete/undelete', async () => {
  const h = harness();
  h.plugin._lineAliasReplaceSet('LINE_A', { recordGuid: 'REC_A', currentText: 'Before', status: 'active', aliases: ['Anchor'] });
  h.plugin._lineAliasScheduleMetadataPersist = () => {};
  assert.equal(h.plugin._lineAliasHandleEvent('lineitem.updated', { lineItemGuid: 'LINE_A', recordGuid: 'REC_A', segments: [{ type: 'text', text: 'After' }] }), true);
  assert.equal(h.plugin._lineAliasGet('LINE_A').currentText, 'After');
  h.plugin._lineAliasHandleEvent('lineitem.moved', { lineItemGuid: 'LINE_A', targetRecordGuid: 'REC_B' });
  assert.equal(h.plugin._lineAliasGet('LINE_A').recordGuid, 'REC_B');
  h.plugin._lineAliasHandleEvent('lineitem.deleted', { lineItemGuid: 'LINE_A' });
  assert.equal(h.plugin._lineAliasGet('LINE_A').status, 'deleted');
  h.plugin._lineAliasHandleEvent('lineitem.undeleted', { lineItemGuid: 'LINE_A', recordGuid: 'REC_B' });
  assert.equal(h.plugin._lineAliasGet('LINE_A').status, 'active');
  assert.equal(h.plugin._lineAliasGet('LINE_A').aliases[0].text, 'Anchor');
  const eventSlice = source.slice(source.indexOf('_lineAliasHandleEvent(eventName'), source.indexOf('// ───────────────────────────────────────────── A5'));
  assert.doesNotMatch(eventSlice, /data\.getRecord\s*\(/);
  h.plugin._aliasDispose();
});

test('L1 cap refuses a new line while existing lines remain editable', async () => {
  const h = harness();
  h.plugin._LINE_ALIAS_REGISTRY_CAP = 2;
  await h.plugin._lineAliasAdd('LINE_A', 'One', { currentText: 'A', status: 'active' });
  await h.plugin._lineAliasAdd('LINE_B', 'Two', { currentText: 'B', status: 'active' });
  const refused = await h.plugin._lineAliasAdd('LINE_C', 'Three', { currentText: 'C', status: 'active' });
  assert.equal(refused.ok, false);
  assert.equal(refused.capReason, 'aliased-line-cap');
  const existing = await h.plugin._lineAliasAdd('LINE_A', 'One more');
  assert.equal(existing.ok, true);
  assert.equal(h.plugin._lineAliasGet('LINE_A').aliases.length, 2);
  h.plugin._aliasDispose();
});

test('L1 10k in-memory get and exact resolution stay bounded', () => {
  const h = harness();
  for (let index = 0; index < 10000; index++) {
    h.plugin._lineAliasReplaceSet('LINE_' + index, { recordGuid: 'REC_' + (index % 100), currentText: 'Text ' + index, status: 'active', aliases: ['Alias ' + index] });
  }
  const started = performance.now();
  for (let index = 0; index < 1000; index++) assert.equal(h.plugin._lineAliasGet('LINE_9999').lineGuid, 'LINE_9999');
  const getElapsed = performance.now() - started;
  const resolveStarted = performance.now();
  const resolved = h.plugin._lineAliasResolve('Alias 9999');
  const resolveElapsed = performance.now() - resolveStarted;
  assert.equal(resolved[0].lineGuid, 'LINE_9999');
  assert.ok(getElapsed < 100, '1000 gets took ' + getElapsed.toFixed(1) + 'ms');
  assert.ok(resolveElapsed < 250, '10k resolve took ' + resolveElapsed.toFixed(1) + 'ms');
  h.plugin._aliasDispose();
});

test('L1 broker and bridge are additive, generation-safe, and line-scoped', () => {
  const h = harness();
  h.plugin._lineAliasReplaceSet('LINE_A', { recordGuid: 'REC_A', currentText: 'A', status: 'active', aliases: ['Anchor'] });
  h.context.window.g_universe.itemsByGuid.LINE_A = { guid: 'LINE_A', rguid: 'REC_A', type: 'text', text_segments: [{ type: 'text', text: 'A' }] };
  const events = new Map();
  h.plugin.events = { on(name, handler) { events.set(name, handler); return name; }, off() {} };
  h.plugin.data.getAllCollections = async () => [];
  h.plugin._attributesClaimEdges = () => ({ status: 'complete', authored: [], derived: [] });
  const broker = h.plugin._initReferenceSurfaceBroker();
  assert.equal(broker.apiVersion, 1);
  assert.equal(broker.supportsAliases, true);
  assert.equal(broker.supportsLineAliases, true);
  assert.equal(broker.aliases, h.plugin._aliasBrokerApi);
  assert.equal(broker.lineAliases, h.plugin._lineAliasBrokerApi);
  assert.equal(broker.resolveTarget('LINE_A').lineAliases[0], 'Anchor');
  assert.ok(events.has('lineitem.undeleted'));
  h.context.window.__refxPriorBrokerDispose();
  h.plugin._aliasDispose();
  assert.equal(h.plugin._lineAliasDisposed, true);
});
