'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alias-surface-v1.json'), 'utf8'));

function domNode(tag = 'div') {
  return {
    tagName: tag.toUpperCase(), className: '', style: {}, dataset: {}, children: [],
    textContent: '', innerHTML: '', isConnected: true, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append(...kids) { this.children.push(...kids); }, appendChild(kid) { this.children.push(kid); return kid; },
    remove() { this.isConnected = false; }, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
}

function loadPluginClass() {
  const storage = new Map();
  const winListeners = new Map();
  const docListeners = new Map();
  const add = (map, name, fn) => { if (!map.has(name)) map.set(name, []); map.get(name).push(fn); };
  const remove = (map, name, fn) => { if (map.has(name)) map.set(name, map.get(name).filter((x) => x !== fn)); };
  const document = {
    hidden: false,
    createElement: (tag) => domNode(tag), createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    querySelector: () => null, querySelectorAll: () => [], getElementsByClassName: () => [], getElementById: () => null,
    body: domNode('body'), head: domNode('head'), documentElement: { clientHeight: 900 },
    addEventListener: (name, fn) => add(docListeners, name, fn), removeEventListener: (name, fn) => remove(docListeners, name, fn),
    dispatchEvent: (event) => { for (const fn of docListeners.get(event.type) || []) fn(event); return true; },
    contains: () => true,
  };
  const window = {
    CSS: { escape: String }, innerWidth: 1440, innerHeight: 900,
    g_universe: { itemsByGuid: {}, listviews: [], workspace: { guid: 'WS_TEST' } },
    addEventListener: (name, fn) => add(winListeners, name, fn), removeEventListener: (name, fn) => remove(winListeners, name, fn),
    dispatchEvent: (event) => { for (const fn of winListeners.get(event.type) || []) fn(event); return true; },
  };
  const context = {
    AppPlugin: class {}, console, Promise, Date, Math, Map, Set, WeakMap, WeakSet,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false }), 0), cancelIdleCallback: clearTimeout,
    performance, CSS: window.CSS, document, window, Element: class {}, DateTime: undefined,
    navigator: { platform: 'MacIntel', userAgent: 'Mac', clipboard: { writeText: async () => {}, readText: async () => '' } },
    localStorage: { getItem: (k) => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail || null; } },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  context.globalThis = context;
  Object.assign(context, window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  return { Plugin: context.PluginUnderTest, context, storage, winListeners, docListeners };
}

function makeStore() {
  const records = new Map();
  let seq = 0;
  const sdkCalls = [];
  const newGuid = (prefix) => prefix + String(++seq).padStart(4, '0');

  function makeRecord(guid, name, aliasState = null, setDelay = 0) {
    const state = aliasState || null;
    const rec = {
      guid, getGuid: () => guid, getName: () => name,
      lines: [],
      getLineItems: async () => [...rec.lines],
      createLineItem: async (parent, after, type, segments, props) => {
        sdkCalls.push({ op: 'createLineItem', parent, after, type, segments, props, recordGuid: guid });
        const line = {
          guid: newGuid('LINE_'), type, segments: Array.isArray(segments) ? segments : [], props: props || {},
          delete: async () => { rec.lines = rec.lines.filter((x) => x !== line); },
        };
        rec.lines.unshift(line);
        return line;
      },
      prop: (label) => {
        if (label !== 'Aliases' || !state) return null;
        return {
          name: 'Aliases', guid: 'F_ALIASES_' + guid,
          values: () => [...state.values],
          set: async (next) => {
            sdkCalls.push({ op: 'prop.set', recordGuid: guid, label, value: Array.isArray(next) ? [...next] : next });
            if (setDelay) await new Promise((resolve) => setTimeout(resolve, setDelay));
            state.values = Array.isArray(next) ? [...next] : [next];
          },
        };
      },
      getAllProperties: () => state ? [rec.prop('Aliases')] : [],
      _aliasState: state,
    };
    records.set(guid, rec);
    return rec;
  }

  function makeCollection(guid, name, aliasesField) {
    const owned = [];
    const col = {
      guid, getGuid: () => guid, getName: () => name,
      getConfiguration: () => ({ fields: aliasesField ? [{ id: 'F_' + guid, label: 'Aliases', type: aliasesField.type || 'text', many: aliasesField.many === true }] : [] }),
      getAllRecords: async () => [...owned],
      createRecord: (title) => {
        const rec = makeRecord(newGuid('REC_'), title, null);
        owned.push(rec);
        return rec.guid;
      },
      _add: (rec) => { if (!owned.includes(rec)) owned.push(rec); return rec; },
      _records: owned,
    };
    return col;
  }

  const notes = makeCollection('COL_NOTES', 'Notes', { type: 'text', many: true });
  const projects = makeCollection('COL_PROJECTS', 'Projects', null);
  const settings = makeCollection('COL_SETTINGS', 'Settings', null);
  const incompatible = makeCollection('COL_BAD', 'Bad Aliases', { type: 'record', many: true });
  return { records, sdkCalls, makeRecord, notes, projects, settings, incompatible, collections: [notes, projects, settings, incompatible] };
}

function makeHarness(options = {}) {
  const loaded = loadPluginClass();
  const store = options.store || makeStore();
  const handlers = new Map();
  const commands = [];
  let allCollectionsCalls = 0;
  const plugin = new loaded.Plugin();
  plugin._unloaded = false;
  plugin.workspaceGuid = 'WS_TEST';
  plugin.data = {
    getRecord: (guid) => store.records.get(guid) || null,
    getAllCollections: async () => { allCollectionsCalls++; return store.collections; },
    getAllRecords: () => [...store.records.values()],
    searchByQuery: async () => ({ records: [], lines: [] }),
    getAllGlobalPlugins: async () => [],
  };
  plugin.events = {
    on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return name + ':' + handlers.get(name).length; },
    off: () => {},
  };
  plugin.ui = {
    addCommandPaletteCommand: (cmd) => { commands.push(cmd); return { remove() {} }; },
    addStatusBarItem: () => ({ remove() {} }), getPanels: () => [], getActivePanel: () => null,
  };
  plugin.getConfiguration = () => ({ custom: {} });
  plugin.refreshAllPanels = () => {};
  if (options.initAlias !== false) plugin._aliasInit();
  return { ...loaded, plugin, store, handlers, commands, getAllCollectionsCalls: () => allCollectionsCalls };
}

function attachRecord(store, collection, guid, name, aliases = null, setDelay = 0) {
  const state = aliases == null ? null : { values: [...aliases] };
  const rec = store.makeRecord(guid, name, state, setDelay);
  collection._add(rec);
  return rec;
}

test('A1 fixture covers every frozen edge-case class', () => {
  const ids = new Set(fixtures.cases.map((x) => x.id));
  for (const required of ['single-property-alias', 'multiple-property-aliases', 'registry-tier', 'both-tiers-property-precedence', 'collision-first-record', 'unicode-nfc-diacritics', 'whitespace-and-case-variants', 'identifier-normalization-parity', 'migration-idempotence', 'empty-values']) {
    assert.ok(ids.has(required), 'missing fixture ' + required);
  }
});

test('normalization is NFC, whitespace-collapsed, case-insensitive, and first-spelling preserving', () => {
  const { plugin } = makeHarness();
  const items = plugin._aliasCoerceItems(['  Cafe\u0301   Society ', 'CAFÉ SOCIETY', '', '  '], 'property');
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [{ text: 'Café Society', normalized: 'café society', source: 'property', addedAt: null, addedBy: null }]);
});

test('record-name hydration builds property alias indexes in the same time-sliced walk', async () => {
  const h = makeHarness();
  attachRecord(h.store, h.store.notes, 'REC_PROP', 'Real Title', [' EMP 26 ', 'Secondary']);
  await h.plugin._buildRecordNameIndex();
  const set = h.plugin._aliasBrokerApi.get('REC_PROP');
  assert.equal(set.aliases.length, 2);
  assert.equal(set.aliases[0].source, 'property');
  assert.equal(set.aliases[0].addedAt, null);
  const hit = h.plugin._aliasBrokerApi.resolve('EMP26');
  assert.equal(hit[0].recordGuid, 'REC_PROP');
  assert.equal(hit[0].exact, false);
  assert.equal(h.plugin._aliasBridgeApi.status().hydrated, true);
});

test('registry fallback uses the exact SDK createLineItem signature and survives reread', async () => {
  const h = makeHarness();
  attachRecord(h.store, h.store.projects, 'REC_REG', 'Registry Target', null);
  await h.plugin._buildRecordNameIndex();
  const result = await h.plugin._aliasBridgeApi.add('REC_REG', 'Fallback name');
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'registry');
  assert.equal(h.plugin._aliasBrokerApi.get('REC_REG').aliases[0].source, 'registry');
  const call = h.store.sdkCalls.find((x) => x.op === 'createLineItem');
  assert.equal(call.parent, null);
  assert.equal(call.after, null);
  assert.equal(call.type, 'ulist');
  assert.equal(call.props, null);
  assert.equal(call.segments[0].type, 'text');
  const parsed = JSON.parse(call.segments[0].text);
  assert.equal(parsed.kind, 'refx-alias-entry');
  assert.equal(parsed.schemaVersion, 1);
  await h.plugin._aliasEnsureRegistryLoaded(true, true);
  assert.equal(h.plugin._aliasBrokerApi.get('REC_REG').aliases[0].text, 'Fallback name');
});

test('native property write is label-addressed, multi-value, and does not create a registry', async () => {
  const h = makeHarness();
  const rec = attachRecord(h.store, h.store.notes, 'REC_NATIVE', 'Native Target', []);
  await h.plugin._buildRecordNameIndex();
  const result = await h.plugin._aliasBridgeApi.add(rec.guid, 'Native alias');
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'property');
  assert.deepEqual(rec._aliasState.values, ['Native alias']);
  assert.equal(h.store.settings._records.some((r) => r.getName() === 'RefX Alias Registry'), false);
  assert.ok(h.store.sdkCalls.some((x) => x.op === 'prop.set' && x.label === 'Aliases' && Array.isArray(x.value)));
});

test('registry aliases migrate once into a newly available property and registry lines are deleted after verification', async () => {
  const h = makeHarness();
  const rec = attachRecord(h.store, h.store.projects, 'REC_MOVE', 'Moved Target', null);
  await h.plugin._buildRecordNameIndex();
  assert.equal((await h.plugin._aliasAdd(rec.guid, 'Registry first')).tier, 'registry');
  rec._aliasState = { values: ['Native first'] };
  rec.prop = (label) => label === 'Aliases' ? {
    name: 'Aliases', guid: 'F_ALIASES_MOVE', values: () => [...rec._aliasState.values],
    set: async (next) => { rec._aliasState.values = [...next]; },
  } : null;
  rec.getAllProperties = () => [rec.prop('Aliases')];
  h.plugin._recordCollectionIndex.set(rec.guid, h.store.notes.guid);
  const migrated = await h.plugin._aliasMigrateRecord(rec.guid);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.tier, 'property');
  assert.deepEqual([...rec._aliasState.values].sort(), ['Native first', 'Registry first']);
  const registry = h.store.settings._records.find((r) => r.getName() === 'RefX Alias Registry');
  const remaining = (await registry.getLineItems()).filter((line) => JSON.parse(line.segments[0].text).recordGuid === rec.guid);
  assert.equal(remaining.length, 0);
  assert.equal(h.plugin._aliasRegistryEntries.has(rec.guid), false);
  const again = await h.plugin._aliasMigrateRecord(rec.guid);
  assert.equal(again.ok, true);
  assert.deepEqual([...rec._aliasState.values].sort(), ['Native first', 'Registry first']);
});

test('focus-time schema refresh adopts a newly provisioned property without a full name-index rebuild', async () => {
  const h = makeHarness();
  const rec = attachRecord(h.store, h.store.projects, 'REC_PROVISIONED', 'Provisioned Target', null);
  await h.plugin._buildRecordNameIndex();
  await h.plugin._aliasAdd(rec.guid, 'Move me');
  rec._aliasState = { values: [] };
  rec.prop = (label) => label === 'Aliases' ? {
    name: 'Aliases', guid: 'F_PROVISIONED', values: () => [...rec._aliasState.values],
    set: async (next) => { rec._aliasState.values = [...next]; },
  } : null;
  rec.getAllProperties = () => [rec.prop('Aliases')];
  h.store.projects.getConfiguration = () => ({ fields: [{ id: 'F_PROVISIONED', label: 'Aliases', type: 'text', many: true }] });
  h.plugin._aliasScheduleSchemaRefresh(0);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.deepEqual(rec._aliasState.values, ['Move me']);
  assert.equal(h.plugin._aliasBrokerApi.get(rec.guid).aliases[0].source, 'property');
});

test('two client property adds converge without lost updates', async () => {
  const base = makeHarness();
  const rec = attachRecord(base.store, base.store.notes, 'REC_CONCURRENT_PROP', 'Concurrent', [], 12);
  await base.plugin._buildRecordNameIndex();
  const peer = new base.Plugin();
  peer._unloaded = false; peer.data = base.plugin.data; peer.events = base.plugin.events; peer.ui = base.plugin.ui; peer.getConfiguration = base.plugin.getConfiguration; peer.refreshAllPanels = () => {}; peer._aliasInit();
  await peer._aliasRefreshCollectionSchemas(base.store.collections);
  peer._recordCollectionIndex.set(rec.guid, base.store.notes.guid);
  await Promise.all([base.plugin._aliasAdd(rec.guid, 'Alpha'), peer._aliasAdd(rec.guid, 'Beta')]);
  assert.deepEqual([...rec._aliasState.values].sort(), ['Alpha', 'Beta']);
});

test('two client registry adds converge without lost updates', async () => {
  const base = makeHarness();
  const rec = attachRecord(base.store, base.store.projects, 'REC_CONCURRENT_REG', 'Concurrent Registry', null);
  await base.plugin._buildRecordNameIndex();
  // Pre-create the shared registry so the test isolates write convergence.
  await base.plugin._aliasResolveRegistryRecord(true);
  const peer = new base.Plugin();
  peer._unloaded = false; peer.data = base.plugin.data; peer.events = base.plugin.events; peer.ui = base.plugin.ui; peer.getConfiguration = base.plugin.getConfiguration; peer.refreshAllPanels = () => {}; peer._aliasInit();
  await peer._aliasRefreshCollectionSchemas(base.store.collections);
  peer._recordCollectionIndex.set(rec.guid, base.store.projects.guid);
  await Promise.all([base.plugin._aliasAdd(rec.guid, 'Alpha'), peer._aliasAdd(rec.guid, 'Beta')]);
  await base.plugin._aliasEnsureRegistryLoaded(true, true);
  assert.deepEqual(Array.from(base.plugin._aliasBrokerApi.get(rec.guid).aliases, (a) => a.text).sort(), ['Alpha', 'Beta']);
});

test('collisions are legal and resolve returns every deterministic target', async () => {
  const h = makeHarness();
  attachRecord(h.store, h.store.notes, 'REC_COLL_A', 'A', ['Shared Alias']);
  attachRecord(h.store, h.store.notes, 'REC_COLL_B', 'B', ['shared alias']);
  await h.plugin._buildRecordNameIndex();
  const rows = h.plugin._aliasBrokerApi.resolve('SHARED ALIAS');
  assert.deepEqual(Array.from(rows, (r) => r.recordGuid), ['REC_COLL_A', 'REC_COLL_B']);
  assert.ok(rows.every((r) => r.exact));
});

test('broker exposes additive alias contract, bumps revision, and resolveTarget gains aliases', async () => {
  const h = makeHarness();
  const rec = attachRecord(h.store, h.store.notes, 'REC_BROKER', 'Broker Target', ['Broker Alias']);
  h.context.window.g_universe.itemsByGuid[rec.guid] = { guid: rec.guid, type: 'document' };
  await h.plugin._buildRecordNameIndex();
  h.plugin._attachAttributesClaims();
  const broker = h.plugin._initReferenceSurfaceBroker();
  assert.equal(broker.apiVersion, 1);
  assert.equal(broker.supportsAliases, true);
  assert.equal(broker.aliases.get(rec.guid).aliases[0].text, 'Broker Alias');
  assert.deepEqual(Array.from(broker.aliases.all()).map((x) => x.recordGuid), [rec.guid]);
  assert.deepEqual(Array.from(broker.resolveTarget(rec.guid).aliases), ['Broker Alias']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = broker.revision;
  h.plugin._aliasPublish([rec.guid], 'write');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(broker.revision, before + 1);
});

test('record.updated path is payload-first and enriches later without a collection rebuild', async () => {
  const h = makeHarness();
  const rec = attachRecord(h.store, h.store.notes, 'REC_EVENT', 'Event Target', ['Before']);
  await h.plugin._buildRecordNameIndex();
  const baselineCollections = h.getAllCollectionsCalls();
  h.plugin._scheduleDiscover = () => {};
  let getRecordCalls = 0;
  const original = h.plugin.data.getRecord;
  h.plugin.data.getRecord = (guid) => { getRecordCalls++; return original(guid); };
  rec._aliasState.values = ['After'];
  h.plugin._onRecordUpdated({ recordGuid: rec.guid });
  assert.equal(getRecordCalls, 0, 'event callback must not call data.getRecord');
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.ok(getRecordCalls > 0, 'debounced enrich should resolve the record later');
  assert.equal(h.getAllCollectionsCalls(), baselineCollections, 'incremental update must not rebuild collections');
  assert.equal(h.plugin._aliasBrokerApi.get(rec.guid).aliases[0].text, 'After');
});

test('registry cap refuses a new record truthfully while existing records remain writable', async () => {
  const h = makeHarness();
  const a = attachRecord(h.store, h.store.projects, 'REC_CAP_A', 'Cap A', null);
  const b = attachRecord(h.store, h.store.projects, 'REC_CAP_B', 'Cap B', null);
  h.plugin._ALIAS_REGISTRY_CAP = 1;
  await h.plugin._buildRecordNameIndex();
  assert.equal((await h.plugin._aliasAdd(a.guid, 'One')).ok, true);
  const blocked = await h.plugin._aliasAdd(b.guid, 'Two');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.capReason, 'alias-registry-record-cap');
  assert.equal((await h.plugin._aliasAdd(a.guid, 'Still allowed')).ok, true);
});

test('10k alias index lookups stay synchronous and bounded', () => {
  const { plugin } = makeHarness();
  for (let i = 0; i < 10000; i++) {
    const text = 'Alias ' + i;
    plugin._aliasReplaceRecordSet('REC_' + i, [plugin._aliasMakeItem(text, 'registry', { addedAt: null, addedBy: null })]);
  }
  const start = performance.now();
  for (let i = 0; i < 10000; i++) assert.equal(plugin._aliasBrokerApi.get('REC_' + i).recordGuid, 'REC_' + i);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 250, '10k Map-backed gets took ' + elapsed.toFixed(1) + 'ms');
  const resolveStart = performance.now();
  assert.equal(plugin._aliasBrokerApi.resolve('Alias 9999')[0].recordGuid, 'REC_9999');
  const resolveElapsed = performance.now() - resolveStart;
  assert.ok(resolveElapsed < 250, 'exact resolve across 10k aliases took ' + resolveElapsed.toFixed(1) + 'ms');
});

test('production onLoad mounts the provisioning command and both alias bridges', async () => {
  const h = makeHarness({ initAlias: false });
  // Keep the real onLoad/broker/bridge sequence; stub only unrelated UI systems.
  for (const name of ['_beginAutoTitleGeneration', '_injectStyle', '_ensureThemeObserver', '_counterInit', '_rehydrate', '_wbLiveInit', '_r6MigrateExistingPins', '_scheduleRecordNameIndex', '_r4RegisterCommands', '_r10Init', '_wbSyncStatusIcon']) h.plugin[name] = () => {};
  h.plugin._buildFieldTypes = async () => {};
  h.plugin.onLoad();
  assert.ok(h.commands.some((c) => c.label === 'RefX: Provision Aliases property…'));
  assert.equal(typeof h.context.window.__refx.aliases.add, 'function');
  assert.equal(h.context.window.__refx.referenceSurface.supportsAliases, true);
  assert.equal(h.context.window.__refx.referenceSurface.aliases, h.plugin._aliasBrokerApi);
  assert.equal(h.store.settings._records.some((r) => r.getName() === 'RefX Alias Registry'), false, 'onLoad must not create storage before a write');
  h.plugin.onUnload();
});

test('source anti-pattern sweep: values not get, awaited collections, no prompt family, no alias event getRecord', () => {
  assert.ok(source.includes("rec.prop && rec.prop(this._ALIAS_PROPERTY_LABEL)"));
  assert.ok(source.includes('prop.values()'));
  assert.ok(source.includes('await this.data.getAllCollections()'));
  assert.equal(/window\.(?:prompt|confirm|alert)\s*\(/.test(source), false);
  const handler = source.slice(source.indexOf('_onRecordUpdated(ev)'), source.indexOf('_onRecordMoved(ev)'));
  assert.equal(handler.includes('data.getRecord'), false);
});
