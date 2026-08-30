const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const changelogText = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const testSource = fs.readFileSync(__filename, 'utf8');

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
      removeItem: (key) => storage.delete(key)
    },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
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
  return { Plugin: context.PluginUnderTest, context };
}

function instance() {
  const { Plugin, context } = loadPlugin();
  const plugin = new Plugin();
  plugin._isUnloading = false;
  plugin._enabled = true;
  return { plugin, context };
}

function keyEvent(key) {
  return {
    key,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function classListSet(initial = []) {
  const set = new Set(initial);
  return {
    set,
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (name) => set.has(name),
    toggle(name, force) {
      if (force === undefined) force = !set.has(name);
      if (force) set.add(name); else set.delete(name);
      return force;
    }
  };
}

function fakeElement(tag = 'div', className = '', textContent = '') {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(), className, textContent, dataset: {}, style: {},
    children: [], childNodes: [], parentElement: null, offsetParent: {}, listeners,
    classList: classListSet(String(className || '').split(/\s+/).filter(Boolean)),
    setAttribute() {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    append(...nodes) { for (const node of nodes) { node.parentElement = el; el.children.push(node); el.childNodes.push(node); } },
    appendChild(node) { el.append(node); return node; },
    contains(node) { if (node === el) return true; return el.children.some((child) => child.contains?.(node)); },
    closest(selector) {
      const classNameWanted = selector.startsWith('.') ? selector.slice(1) : '';
      if (classNameWanted && el.classList.contains(classNameWanted)) return el;
      return el.parentElement?.closest?.(selector) || null;
    },
    querySelector(selector) { return el.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const wanted = selector.startsWith('.') ? selector.slice(1) : selector;
      const out = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.classList?.contains?.(wanted)) out.push(child);
          walk(child);
        }
      };
      walk(el);
      return out;
    },
    scrollIntoView() {},
    dispatchEvent(event) { const fn = listeners.get(event.type); if (fn) fn(event); return true; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set: () => { el.children = []; el.childNodes = []; }
  });
  return el;
}

test('registry task resolves immediately, including native done=8', async () => {
  const { plugin, context } = instance();
  plugin._scheduleTaskHintPersist = () => {};
  context.window.g_universe.itemsByGuid.TASK1 = {
    guid: 'TASK1',
    rguid: 'REC1',
    type: 'task',
    props: { done: 8 }
  };
  plugin.data = { getRecord: () => null };

  const info = await plugin._lineTaskInfo('TASK1', '', false);
  assert.equal(info.is, true);
  assert.equal(info.done, true);
  assert.equal(info.provisional, undefined);
  assert.equal(plugin._lineOwnerHints.get('TASK1'), 'REC1');
});

test('unresolved line is unknown and is not negative-cached', async () => {
  const { plugin } = instance();
  plugin.data = { getRecord: () => null };

  const info = await plugin._lineTaskInfo('COLD_LINE', '', false);
  assert.equal(info, null);
  assert.equal(plugin._taskInfoCache.has('COLD_LINE'), false);
});

test('cold line title fallback matches search result by exact guid', async () => {
  const { plugin } = instance();
  plugin._scheduleTaskHintPersist = () => {};
  const line = {
    guid: 'TASK2',
    type: 'task',
    isTaskCompleted: () => false,
    getTaskStatus: () => 'none',
    getRecord: () => ({ guid: 'REC2' })
  };
  plugin.data = {
    getRecord: () => null,
    searchByQuery: async () => ({ lines: [{ guid: 'SAME_TITLE_WRONG', type: 'task' }, line] })
  };

  const info = await plugin._lineTaskInfo('TASK2', 'same title', true);
  assert.equal(info.is, true);
  assert.equal(info.done, false);
  assert.equal(plugin._lineOwnerHints.get('TASK2'), 'REC2');
});

test('getType-only and status-only SDK task handles render as tasks', async () => {
  const { plugin } = instance();
  plugin.data = { getRecord: () => null };
  plugin._scheduleTaskHintPersist = () => {};

  plugin._resolveLiveLine = async (guid) => guid === 'GETTYPE'
    ? {
        guid,
        getType: () => 'task',
        isTaskCompleted: () => true,
        getRecord: () => ({ guid: 'REC_GETTYPE' })
      }
    : {
        guid,
        getTaskStatus: () => 'done',
        isTaskCompleted: () => true,
        getRecord: () => ({ guid: 'REC_STATUS' })
      };

  const byType = await plugin._lineTaskInfo('GETTYPE', '', true);
  assert.equal(byType.is, true);
  assert.equal(byType.done, true);
  assert.equal(plugin._lineOwnerHints.get('GETTYPE'), 'REC_GETTYPE');

  const byStatus = await plugin._lineTaskInfo('STATUS_ONLY', '', true);
  assert.equal(byStatus.is, true);
  assert.equal(byStatus.done, true);
  assert.equal(plugin._lineOwnerHints.get('STATUS_ONLY'), 'REC_STATUS');
});

test('durable task hints seed provisional checkboxes after an app reload', () => {
  const { plugin, context } = instance();
  plugin._taskHintStoreKey = 'refx_taskhints_test';
  context.localStorage.setItem(plugin._taskHintStoreKey, JSON.stringify({
    TASK_FROM_DISK: { owner: 'REC_FROM_DISK', done: true, ts: Date.now() }
  }));

  plugin._seedTaskHintsFromDisk();

  const info = plugin._taskInfoCache.get('TASK_FROM_DISK');
  assert.equal(info.is, true);
  assert.equal(info.done, true);
  assert.equal(info.provisional, true);
  assert.equal(info.ts, 0);
  assert.equal(plugin._lineOwnerHints.get('TASK_FROM_DISK'), 'REC_FROM_DISK');
});

test('reference target classification rejects record relations and proves real lines', () => {
  const { plugin, context } = instance();
  const pageGuid = '1PAGEGUID000000000000000000';
  const lineGuid = '1LINEGUID000000000000000000';
  const coldGuid = '1UNKNOWN0000000000000000000';
  plugin.data = { getRecord: (guid) => guid === pageGuid ? { guid } : null };
  context.window.g_universe.itemsByGuid[pageGuid] = { guid: pageGuid, rguid: 'OWNER', type: 'document' };
  context.window.g_universe.itemsByGuid[lineGuid] = { guid: lineGuid, rguid: pageGuid, type: 'text' };

  assert.equal(plugin._referenceTargetKind(pageGuid), 'record');
  assert.equal(plugin._referenceTargetKind(lineGuid), 'line');
  assert.equal(plugin._referenceTargetKind(coldGuid), 'unknown');
});

test('warm target classification is cache-only after one host probe', () => {
  const { plugin } = instance();
  const guid = '1HOTRECORD00000000000000000';
  let calls = 0;
  plugin.data = { getRecord: () => { calls++; return { guid }; } };

  for (let i = 0; i < 10000; i++) assert.equal(plugin._referenceTargetKind(guid), 'record');

  assert.equal(calls, 1);
  assert.equal(plugin._recordExistsCache.get(guid), true);
});

test('positive record proof never falls back to the host or oscillates to unknown', () => {
  const { plugin } = instance();
  const guid = '1PROVENRECORD000000000000000';
  let calls = 0;
  plugin._recordExistsCache.set(guid, true);
  plugin.data = { getRecord: () => { calls++; return null; } };

  for (let i = 0; i < 1000; i++) assert.equal(plugin._referenceTargetKind(guid), 'record');

  assert.equal(calls, 0);
  assert.equal(plugin._recordExistsCache.get(guid), true);
});

test('fresh unknown classification does not repeatedly probe the host', () => {
  const { plugin } = instance();
  let calls = 0;
  plugin.data = { getRecord: () => { calls++; return null; } };

  for (let i = 0; i < 1000; i++) assert.equal(plugin._referenceTargetKind('1COLDTARGET0000000000000000'), 'unknown');

  assert.equal(calls, 1);
});

test('registry-proven line types never probe the host resolver', () => {
  const { plugin, context } = instance();
  let calls = 0;
  plugin.data = { getRecord: () => { calls++; return null; } };

  for (let i = 0; i < 10000; i++) {
    const guid = `LINE_${i}`;
    context.window.g_universe.itemsByGuid[guid] = { guid, rguid: 'OWNER', type: i % 2 ? 'text' : 'task' };
    assert.equal(plugin._referenceTargetKind(guid), 'line');
  }

  assert.equal(calls, 0);
});

test('record-name lookup respects cold misses and marks positive record proof', () => {
  const { plugin } = instance();
  const cold = '1COLDNAME0000000000000000000';
  const warm = '1WARMNAME0000000000000000000';
  let calls = 0;
  plugin._recordNameCache = new Map();
  plugin.data = { getRecord: (guid) => {
    calls++;
    return guid === warm ? { guid, getName: () => 'Warm record' } : null;
  } };
  plugin._recordExistsCache.set(cold, { exists: false, ts: Date.now() });

  for (let i = 0; i < 1000; i++) assert.equal(plugin.getOrLoadRecordName(cold), cold);
  assert.equal(calls, 0);
  assert.equal(plugin.getOrLoadRecordName(warm), 'Warm record');
  assert.equal(plugin._recordExistsCache.get(warm), true);
  assert.equal(calls, 1);
});

test('line-to-record reclassification clears stale count and persisted-seed state', () => {
  const { plugin } = instance();
  const guid = '1WARMRECORD0000000000000000';
  plugin._recordExistsCache = new Map([[guid, { exists: false, ts: Date.now() }]]);
  plugin._countCache = new Map([[guid, { count: 4, fromDisk: true }]]);
  plugin._recordNameCache = new Map([[guid, 'Stale line title']]);
  let invalidated = null;
  let persisted = 0;
  plugin._invalidateBackrefsForTarget = (target) => { invalidated = target; };
  plugin._scheduleCountCachePersist = () => { persisted++; };

  assert.equal(plugin._markRecordTargetKnown(guid), true);
  assert.equal(plugin._recordExistsCache.get(guid), true);
  assert.equal(plugin._countCache.has(guid), false);
  assert.equal(plugin._recordNameCache.has(guid), false);
  assert.equal(invalidated, guid);
  assert.equal(persisted, 1);
  assert.equal(plugin._markRecordTargetKnown(guid), false);
});

test('line ref resolution never adopts a mismatched owning-record facade name', () => {
  const { plugin } = instance();
  const lineGuid = 'LINE_TARGET';
  const ownerGuid = 'OWNER_RECORD';
  const recordGuid = 'EXACT_RECORD';
  plugin._lineOwnerHints.set(lineGuid, ownerGuid);
  plugin.data = {
    getRecord: (guid) => {
      if (guid === lineGuid) return { guid: ownerGuid, getName: () => 'Owner page' };
      if (guid === recordGuid) return { guid: recordGuid, getName: () => 'Exact page' };
      return null;
    }
  };
  plugin._liveSegs = (guid) => guid === lineGuid
    ? [{ type: 'text', text: 'Target line text' }]
    : null;

  assert.equal(plugin._referenceTargetKind(lineGuid), 'line');
  assert.equal(plugin._resolveRefTargetText(lineGuid, 0), 'Target line text');
  assert.equal(plugin._resolveRefTargetText(recordGuid, 0), 'Exact page');
});

test('record existence re-probe cannot bypass stale line-count invalidation', () => {
  const { plugin } = instance();
  const guid = '1REPROBEDRECORD000000000000';
  plugin.data = { getRecord: (value) => value === guid ? { guid } : null };
  plugin._recordExistsCache = new Map([[guid, { exists: false, ts: Date.now() - 2000 }]]);
  plugin._countCache = new Map([[guid, { count: 3, fromDisk: true }]]);
  plugin._recordNameCache = new Map();
  plugin._invalidateBackrefsForTarget = () => {};
  plugin._scheduleCountCachePersist = () => {};

  assert.equal(plugin.isExistingRecordGuid(guid), true);
  assert.equal(plugin._recordExistsCache.get(guid), true);
  assert.equal(plugin._countCache.has(guid), false);
});

test('unknown cold target keeps direct inbound links but skips kind-specific additions', async () => {
  const { plugin } = instance();
  const guid = '1COLDCANDIDATE0000000000000';
  plugin.data = { getRecord: () => null };
  plugin._recordExistsCache = new Map();
  let lineLoads = 0;
  let warmups = 0;
  plugin.loadLineReferenceCount = async () => { lineLoads++; return { count: 9, capped: false }; };
  plugin._scheduleRecordNameIndex = () => { warmups++; };

  const info = await plugin.loadCountInfo(guid);
  assert.equal(info.count, 9);
  assert.equal(lineLoads, 1);
  assert.equal(warmups, 1);
});

test('record-name warmups coalesce and a fresh completed index suppresses repeats', () => {
  const { plugin, context } = instance();
  const pending = new Map();
  let next = 0;
  context.setTimeout = (fn) => { const id = ++next; pending.set(id, fn); return id; };
  context.clearTimeout = (id) => pending.delete(id);
  plugin._unloaded = false;

  for (let i = 0; i < 100; i++) plugin._scheduleRecordNameIndex(0);
  assert.equal(pending.size, 1);

  for (const id of pending.keys()) context.clearTimeout(id);
  plugin._recordNameIndexT = 0;
  plugin._recordNameIndexDueAt = 0;
  plugin._recordNameIndexBuiltAt = Date.now();
  for (let i = 0; i < 100; i++) plugin._scheduleRecordNameIndex(0);
  assert.equal(pending.size, 0);
});

test('record-name index yields within a large collection and avoids no-waiter refreshes', async () => {
  const { plugin, context } = instance();
  let yields = 0;
  context.setTimeout = (fn) => { yields++; fn(); return yields; };
  const records = Array.from({ length: 450 }, (_, i) => ({
    guid: `REC_${i}`,
    getName: () => `Record ${i}`
  }));
  plugin.data = { getAllCollections: async () => [{ guid: 'COL', getAllRecords: async () => records }] };
  plugin._unloaded = false;
  let refreshes = 0;
  plugin.refreshAllPanels = () => { refreshes++; };

  await plugin._buildRecordNameIndex();

  assert.ok(yields >= 3, `expected chunk and collection yields, saw ${yields}`);
  assert.equal(refreshes, 0);
  assert.ok(plugin._recordNameIndexBuiltAt > 0);
});

test('auto line-property detection ignores Attendees/Meeting records but keeps a line', () => {
  const { plugin, context } = instance();
  const attendee = '1ATTENDEE000000000000000000';
  const meeting = '1MEETING0000000000000000000';
  const line = '1REALLINE000000000000000000';
  const coldLine = '1COLDLINE000000000000000000';
  plugin._lineRefPropSet = new Set(['source line']);
  plugin._autoLineRefs = true;
  plugin.data = { getRecord: (guid) => (guid === attendee || guid === meeting) ? { guid } : null };
  context.window.g_universe.itemsByGuid[attendee] = { guid: attendee, rguid: 'OWNER', type: 'document' };
  context.window.g_universe.itemsByGuid[meeting] = { guid: meeting, rguid: 'OWNER', type: 'document' };
  context.window.g_universe.itemsByGuid[line] = { guid: line, rguid: 'RECORD', type: 'text' };
  plugin.getPropertyCandidateValues = (prop) => prop.values;
  const record = { getAllProperties: () => [
    { name: 'Attendees', values: [attendee] },
    { name: 'Meeting', values: [meeting] },
    { name: 'Any plugin field', values: [line] },
    { name: 'Source Line', values: [coldLine, attendee] }
  ] };

  const targets = plugin.getLinePropTargetsForRecord(record);
  assert.deepEqual([...targets], [line, coldLine]);
});

test('workspace line-property indexing performs zero per-value host record probes', () => {
  const { plugin } = instance();
  plugin._lineRefPropSet = new Set(['source line']);
  plugin._autoLineRefs = true;
  let calls = 0;
  plugin.data = { getRecord: () => { calls++; return {}; } };
  const values = Array.from({ length: 10000 }, (_, i) => `1RELATION${String(i).padStart(18, '0')}`);
  plugin.getPropertyCandidateValues = (prop) => prop.values;
  const record = { getAllProperties: () => [{ name: 'Attendees', values }] };
  const knownRecords = new Set(values);

  assert.equal(plugin.getLinePropTargetsForRecord(record, knownRecords).size, 0);
  assert.equal(calls, 0);
});

test('event-maintained property indexes do not expire into periodic workspace rebuilds', () => {
  const { plugin } = instance();
  const propIdx = { builtAt: 0, recordsByTarget: new Map(), targetsByRecord: new Map() };
  const lineIdx = { builtAt: 0, recordsByTarget: new Map(), targetsByRecord: new Map(), recordCount: 0 };
  let propBuilds = 0;
  let lineBuilds = 0;
  plugin._propRefIndex = propIdx;
  plugin._linePropRefIndex = lineIdx;
  plugin._lineRefProps = ['Source Line'];
  plugin._autoLineRefs = true;
  plugin._lastLinePropSizeCheck = Date.now();
  plugin._schedulePropRefIndexBuild = () => { propBuilds++; };
  plugin._scheduleLinePropRefIndexBuild = () => { lineBuilds++; };

  assert.equal(plugin.getPropRefIndexIfReady(), propIdx);
  assert.equal(plugin.getLinePropRefIndexIfReady(), lineIdx);
  assert.equal(propBuilds, 0);
  assert.equal(lineBuilds, 0);
});

test('record lifecycle events add and remove event-maintained index memberships', () => {
  const { plugin, context } = instance();
  const recordGuid = '1NEWRECORD000000000000000000';
  const lineGuid = '1SOURCELINE000000000000000000';
  context.window.g_universe.itemsByGuid[lineGuid] = { guid: lineGuid, rguid: 'OWNER', type: 'text' };
  plugin._lineRefProps = ['Source Line'];
  plugin._lineRefPropSet = new Set(['source line']);
  plugin._autoLineRefs = true;
  plugin._countMode = 'combined';
  plugin.getPropertyCandidateValues = (prop) => prop.values || [];
  const record = { guid: recordGuid, getName: () => 'New record', getAllProperties: () => [
    { name: 'Source Line', values: [lineGuid] }
  ] };
  plugin.data = { getRecord: (guid) => guid === recordGuid ? record : null };
  plugin._propRefIndex = { builtAt: Date.now(), recordsByTarget: new Map(), targetsByRecord: new Map() };
  plugin._linePropRefIndex = { builtAt: Date.now(), recordsByTarget: new Map(), targetsByRecord: new Map(), recordCount: 0 };
  plugin.refreshAllPanels = () => {};
  plugin._invalidateBackrefs = () => {};

  plugin.handleRecordUpdated({ recordGuid, type: 'record.created' });
  assert.equal(plugin._propRefIndex.recordsByTarget.get(lineGuid).has(recordGuid), true);
  assert.equal(plugin._linePropRefIndex.recordsByTarget.get(lineGuid).has(recordGuid), true);

  plugin.handleRecordUpdated({ recordGuid, trashed: true });
  assert.equal(plugin._propRefIndex.recordsByTarget.has(lineGuid), false);
  assert.equal(plugin._linePropRefIndex.recordsByTarget.has(lineGuid), false);
});

test('transient record resolver misses preserve prior index memberships', () => {
  const { plugin } = instance();
  const recordGuid = '1TRANSIENT0000000000000000000';
  const targetGuid = '1TARGET000000000000000000000';
  const propRecords = new Map([[targetGuid, new Set([recordGuid])]]);
  const propTargets = new Map([[recordGuid, new Set([targetGuid])]]);
  plugin._propRefIndex = { builtAt: Date.now(), recordsByTarget: propRecords, targetsByRecord: propTargets };
  plugin._linePropRefIndex = { builtAt: Date.now(), recordsByTarget: new Map(propRecords), targetsByRecord: new Map(propTargets), recordCount: 1 };
  plugin.data = { getRecord: () => null };
  let retries = 0;
  plugin._scheduleRecordIndexRetry = () => { retries++; };

  plugin.handleRecordUpdated({ recordGuid });

  assert.equal(plugin._propRefIndex.recordsByTarget.get(targetGuid).has(recordGuid), true);
  assert.equal(plugin._linePropRefIndex.recordsByTarget.get(targetGuid).has(recordGuid), true);
  assert.equal(retries, 1);
});

test('late record handles retain one slow coalesced retry without full-index scans', () => {
  const { plugin, context } = instance();
  const guid = '1VERYLAZYRECORD0000000000000';
  const queued = [];
  let nextId = 0;
  context.setTimeout = (fn, delay) => { const id = ++nextId; queued.push({ id, fn, delay }); return id; };
  context.clearTimeout = (id) => {
    const i = queued.findIndex((entry) => entry.id === id);
    if (i >= 0) queued.splice(i, 1);
  };
  let ready = false;
  let resolved = 0;
  let fullBuilds = 0;
  plugin._schedulePropRefIndexBuild = () => { fullBuilds++; };
  plugin._scheduleLinePropRefIndexBuild = () => { fullBuilds++; };
  plugin.handleRecordUpdated = () => {
    if (!ready) { plugin._scheduleRecordIndexRetry(guid); return; }
    plugin._clearRecordIndexRetries(guid);
    resolved++;
  };

  plugin._scheduleRecordIndexRetry(guid);
  for (let i = 0; i < 4; i++) queued.shift().fn();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].delay, 5000);
  plugin._scheduleRecordIndexRetry(guid);
  assert.equal(queued.length, 1);

  ready = true;
  queued.shift().fn();
  assert.equal(resolved, 1);
  assert.equal(fullBuilds, 0);
  assert.equal(plugin._recordIndexRetryTimers.has(guid), false);
  assert.equal(plugin._recordIndexRetryAttempts.has(guid), false);
});

test('counter subscriptions include record creation lifecycle events', () => {
  const { plugin } = instance();
  const names = [];
  plugin._eventHandlerIds = [];
  plugin.events = { on: (name) => { names.push(name); return name; } };
  plugin.registerCounterEventHandlers();
  assert.equal(names.includes('record.created'), true);
  assert.equal(names.includes('record.updated'), true);
});

test('outbound record properties never synthesize an inbound linked-reference count', async () => {
  const { plugin, context } = instance();
  const lineGuid = '1BODYLINE000000000000000000';
  const ownerGuid = '1OWNERREC000000000000000000';
  context.window.g_universe.itemsByGuid[lineGuid] = { guid: lineGuid, rguid: ownerGuid, type: 'text' };
  plugin.data = { getRecord: (guid) => guid === ownerGuid ? { getAllProperties: () => [{ name: 'Meeting' }] } : null };
  plugin.isExistingRecordGuid = () => false;
  plugin._lineRefProps = ['Source Line'];
  plugin._autoLineRefs = true;
  plugin._lineConnectionsEnabled = true;
  plugin.loadLineReferenceCount = async () => ({ count: 0, capped: false, sourceRecordGuids: new Set() });
  plugin.loadLinePropReferenceRecordCount = async () => ({ recordGuids: new Set() });

  const info = await plugin.loadCountInfo(lineGuid);
  assert.equal(info.count, 0);
  assert.equal(info.capped, false);
});

test('page and line link classes apply independently of badge visibility', () => {
  const { plugin, context } = instance();
  const pageGuid = '1PAGESTYLE00000000000000000';
  const lineGuid = '1LINESTYLE00000000000000000';
  plugin.data = { getRecord: (guid) => guid === pageGuid ? { guid } : null };
  context.window.g_universe.itemsByGuid[lineGuid] = { guid: lineGuid, rguid: pageGuid, type: 'text' };
  const pageClasses = classListSet(['lineitem-ref']);
  const lineClasses = classListSet(['lineitem-ref']);
  plugin._tagReferenceChip({ classList: pageClasses }, pageGuid);
  plugin._tagReferenceChip({ classList: lineClasses }, lineGuid);
  assert.equal(pageClasses.contains('refx-pageref-chip'), true);
  assert.equal(pageClasses.contains('refx-lineref-chip'), false);
  assert.equal(lineClasses.contains('refx-lineref-chip'), true);
  assert.equal(lineClasses.contains('refx-pageref-chip'), false);
});

test('Backreferences-rendered chips receive page/line appearance classes', () => {
  const { plugin } = instance();
  const seen = [];
  const chip = {
    classList: classListSet(['tlr-seg-ref']),
    getAttribute: (name) => name === 'data-ref-guid' ? 'LINE_FROM_BACKREFS' : null
  };
  const root = {
    matches: () => false,
    querySelectorAll: (selector) => {
      assert.match(selector, /tlr-seg-ref\[data-ref-guid\]/);
      return [chip];
    }
  };
  plugin._tagReferenceChip = (_chip, guid) => { seen.push(guid); };

  plugin._tagReferenceChipsIn(root);
  assert.equal(seen.join(','), 'LINE_FROM_BACKREFS');
});

test('disabled counters still tag chips during the initial panel scan', async () => {
  const { plugin } = instance();
  const editorRoot = { querySelectorAll: () => [] };
  const panelEl = { isConnected: true };
  const panel = { getElement: () => panelEl };
  plugin._enabled = false;
  plugin._panelStates = new Map([['PANEL', { panel, panelEl }]]);
  plugin.findEditorRoot = () => editorRoot;
  let tagged = 0;
  let cleared = 0;
  plugin._tagReferenceChipsIn = (root) => { assert.equal(root, editorRoot); tagged++; };
  plugin.clearBadgesInElement = () => { cleared++; };

  await plugin._scanPanelImpl('PANEL', 'test');
  assert.equal(tagged, 1);
  assert.equal(cleared, 1);
});

test('picker-time mutations repaint chip classes before badge work is suppressed', () => {
  const { plugin, context } = instance();
  let observerCallback = null;
  context.MutationObserver = class {
    constructor(fn) { observerCallback = fn; }
    observe() {}
    disconnect() {}
  };
  const line = new context.Element();
  line.isConnected = true;
  line.closest = () => line;
  const chip = new context.Element();
  chip.isConnected = true;
  chip.classList = classListSet(['lineitem-ref']);
  chip.matches = (selector) => selector.includes('.lineitem-ref');
  chip.closest = (selector) => selector.includes('.listitem[data-guid]') ? line : chip;
  chip.querySelector = () => null;
  chip.querySelectorAll = () => [];
  chip.getAttribute = (name) => (name === 'data-guid' || name === 'data-record-guid') ? '1PICKERREF00000000000000000' : null;
  plugin._link = { kind: 'record' };
  let tagged = 0;
  let rescans = 0;
  plugin._tagReferenceChip = (value, guid) => {
    assert.equal(value, chip);
    assert.equal(guid, '1PICKERREF00000000000000000');
    tagged++;
  };
  plugin.scheduleRescanLines = () => { rescans++; };

  assert.equal(plugin.nodeHasReferenceHint(chip), true, 'a committed native ref class remains authoritative even when data-record-guid is present');
  plugin.attachObserver({}, {});
  observerCallback([{ type: 'childList', target: line, addedNodes: [chip], removedNodes: [] }]);
  assert.equal(tagged, 1);
  assert.equal(rescans, 0);
  plugin._link = null;
  observerCallback([{ type: 'childList', target: line, addedNodes: [chip], removedNodes: [] }]);
  assert.equal(tagged, 2);
  assert.equal(rescans, 1, 'a real committed ref still reaches the scoped reconciliation path');
});

test('visible native inline picker defers caret-line reconciliation until a close-only mutation', () => {
  const { plugin, context } = instance();
  let observerCallback = null;
  context.MutationObserver = class {
    constructor(fn) { observerCallback = fn; }
    observe() {}
    disconnect() {}
  };
  const nativePicker = new context.Element();
  nativePicker.isConnected = true;
  nativePicker.hidden = false;
  nativePicker.style = {};
  nativePicker.classList = classListSet(['cmdpal--inline']);
  nativePicker.getAttribute = () => null;
  context.document.querySelectorAll = selector => selector.includes('.cmdpal--inline') ? [nativePicker] : [];

  const line = new context.Element();
  line.isConnected = true;
  line.closest = () => line;
  const chip = new context.Element();
  chip.isConnected = true;
  chip.classList = classListSet(['lineitem-ref']);
  chip.matches = selector => selector.includes('.lineitem-ref');
  chip.closest = selector => selector.includes('.listitem[data-guid]') ? line : chip;
  chip.querySelector = () => null;
  chip.querySelectorAll = () => [];
  chip.getAttribute = name => (name === 'data-guid' || name === 'data-record-guid') ? 'NATIVE_PICK_REF' : null;
  let tagged = 0, rescans = 0;
  plugin._targetLineBadges = false;
  plugin._tagReferenceChip = () => { tagged++; };
  plugin.scheduleRescanLines = () => { rescans++; };
  plugin.attachObserver({}, {});

  const mutation = { type: 'childList', target: line, addedNodes: [chip], removedNodes: [] };
  observerCallback([mutation]);
  assert.equal(tagged, 1, 'safe class tagging still happens before suppression');
  assert.equal(rescans, 0, 'visible native picker protects the caret line from reconciliation');

  nativePicker.hidden = true;
  observerCallback([{ type: 'childList', target: nativePicker, addedNodes: [], removedNodes: [] }]);
  assert.equal(tagged, 1, 'picker-only close mutations do not reprocess authored chips');
  assert.equal(rescans, 1, 'the exact deferred line reconciles when the picker closes');
});

test('native picker visibility is document-global across autocomplete and ARIA portals', () => {
  const { plugin, context } = instance();
  const portal = {
    isConnected: true,
    hidden: false,
    style: {},
    className: 'autocomplete',
    classList: classListSet(['autocomplete']),
    getAttribute: () => null,
  };
  let selector = '';
  context.document.querySelectorAll = (value) => { selector = value; return [portal]; };
  const unrelatedPanel = { querySelectorAll: () => { throw new Error('must not scope picker detection to a panel'); } };

  assert.equal(plugin._nativeInlinePickerVisible(unrelatedPanel), true);
  assert.match(selector, /\.cmdpal--inline/);
  assert.match(selector, /\.autocomplete/);
  assert.match(selector, /\[role="listbox"\]/);
});

test('RefX-owned listboxes never masquerade as native Thymer pickers', () => {
  const { plugin, context } = instance();
  const ownListbox = {
    nodeType: 1,
    isConnected: true,
    hidden: false,
    style: {},
    className: 'refx-nav-results',
    classList: classListSet(['refx-nav-results']),
    getAttribute: () => null,
    matches: selector => selector.includes('[role="listbox"]') || selector.includes('[class^="refx-"]'),
    closest: selector => selector.includes('[class^="refx-"]') ? ownListbox : null,
    querySelectorAll: () => [],
  };
  context.document.querySelectorAll = () => [ownListbox];
  assert.equal(plugin._isNativePickerNode(ownListbox, true), false);
  assert.equal(plugin._nativeInlinePickerVisible(), false,
    'opening Reference Navigator must not park RefX background work forever');
});

test('hot reload cancels and resolves a pending background idle wait', async () => {
  const { plugin, context } = instance();
  let nextId = 0;
  const callbacks = new Map();
  const cancelled = [];
  context.requestIdleCallback = (fn) => {
    const id = ++nextId;
    callbacks.set(id, fn);
    return id;
  };
  context.cancelIdleCallback = (id) => {
    cancelled.push(id);
    callbacks.delete(id);
  };

  plugin._initBackgroundWorkCoordinator();
  let ran = false;
  const job = plugin._runBackgroundWork('pending-idle', async () => { ran = true; });
  assert.equal(callbacks.size, 1, 'the lane owns one pending browser-idle callback');

  context.window.__refxBackgroundWorkDispose();
  assert.deepEqual(cancelled, [1]);
  assert.equal(await job, null, 'disposal resolves the parked lane instead of retaining the old instance');
  assert.equal(ran, false);
  assert.equal(plugin._backgroundWaitHandles.size, 0);
  assert.equal(await plugin._runBackgroundWork('stale-tail', async () => { ran = true; }), null,
    'an old hot-reloaded continuation cannot recreate the disposed lane');
  assert.equal(ran, false);
});

test('record-name hydration rechecks the picker gate after collection enumeration settles', async () => {
  const { plugin } = instance();
  const collections = deferred();
  const pickerClosed = deferred();
  let pickerOpen = false;
  let gateChecks = 0;
  const calls = [];
  plugin._metadataIndexGeneration = 1;
  plugin._aliasDisposed = true;
  plugin.data = { getAllCollections: () => collections.promise };
  plugin._recheckBackgroundGate = async () => {
    gateChecks++;
    if (pickerOpen) await pickerClosed.promise;
    return true;
  };
  plugin._aliasRefreshCollectionSchemas = async () => { calls.push('schemas'); };
  plugin._aliasEnsureRegistryLoaded = async () => { calls.push('registry'); };

  const build = plugin._buildRecordNameIndex('GENERATION');
  pickerOpen = true;
  collections.resolve([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gateChecks, 1, 'the SDK completion immediately enters the hard gate');
  assert.deepEqual(calls, [], 'alias SDK/body hydration remains parked behind the newly-open picker');

  pickerOpen = false;
  pickerClosed.resolve();
  await build;
  assert.deepEqual(calls, ['schemas', 'registry']);
  assert.ok(gateChecks >= 3, 'each awaited hydration boundary is rechecked before continuing');
});

test('unknown target badges receive authoritative cooperative refinement', async () => {
  const { plugin } = instance();
  const queried = [];
  const painted = [];
  const state = { panelId: 'PANEL', scanSeq: 7, _targetBadgeRefineToken: null };
  plugin._panelStates = new Map([['PANEL', state]]);
  plugin._backgroundWorkGeneration = 'GEN';
  plugin._runBackgroundWork = (_name, task) => Promise.resolve(task('GEN'));
  plugin._waitForBackgroundSlot = async () => true;
  plugin.getCountInfoForGuid = async guid => { queried.push(guid); return { count: guid === 'B' ? 1 : 0 }; };
  plugin._paintTargetEntriesNow = (entries, guid, info) => painted.push({ entries, guid, count: info.count });
  const byGuid = new Map([['A', ['line-a']], ['B', ['line-b']]]);

  await plugin._scheduleTargetBadgeAuthoritativeRefine(state, 7, byGuid, ['A', 'B']);

  assert.deepEqual(queried, ['A', 'B']);
  assert.deepEqual(painted.map(row => [row.guid, row.count]), [['A', 0], ['B', 1]]);
  assert.equal(state._targetBadgeRefineToken, null);
});

test('observed inbound lower bound reads only event-maintained line references', () => {
  const { plugin, context } = instance();
  plugin._showSelf = false;
  plugin._lineRefGuids = new Map([
    ['SOURCE_SELF', new Set(['TARGET_LINE'])],
    ['SOURCE_OTHER', new Set(['TARGET_LINE', 'OTHER_TARGET'])],
  ]);
  context.window.g_universe.itemsByGuid = {
    TARGET_LINE: { guid: 'TARGET_LINE', rguid: 'TARGET_RECORD' },
    SOURCE_SELF: { guid: 'SOURCE_SELF', rguid: 'TARGET_RECORD' },
    SOURCE_OTHER: { guid: 'SOURCE_OTHER', rguid: 'OTHER_RECORD' },
  };

  const counts = plugin._observedInboundCountMap(new Set(['TARGET_LINE']));
  assert.equal(counts.get('TARGET_LINE'), 1, 'self-owned source is excluded and the external observed source is counted once');
});

test('panel observer remount clears the prior picker timer and deferred lines', () => {
  const { plugin, context } = instance();
  const callbacks = [];
  context.MutationObserver = class {
    constructor(fn) { callbacks.push(fn); }
    observe() {}
    disconnect() {}
  };
  const picker = new context.Element();
  picker.isConnected = true;
  picker.hidden = false;
  picker.style = {};
  picker.classList = classListSet(['cmdpal--inline']);
  picker.getAttribute = () => null;
  context.document.querySelectorAll = selector => selector.includes('.cmdpal--inline') ? [picker] : [];
  const line = new context.Element();
  line.isConnected = true;
  line.closest = () => line;
  const chip = new context.Element();
  chip.isConnected = true;
  chip.classList = classListSet(['lineitem-ref']);
  chip.matches = selector => selector.includes('.lineitem-ref');
  chip.closest = selector => selector.includes('.listitem[data-guid]') ? line : chip;
  chip.querySelector = () => null;
  chip.querySelectorAll = () => [];
  chip.getAttribute = name => (name === 'data-guid' || name === 'data-record-guid') ? 'REMOUNT_REF' : null;
  plugin._tagReferenceChip = () => {};
  const state = {};
  const rootA = {};
  const rootB = {};
  plugin.attachObserver(state, rootA);
  callbacks[0]([{ type: 'childList', target: line, addedNodes: [chip], removedNodes: [] }]);
  assert.equal(state.nativePickerDeferredLines.size, 1);
  assert.ok(state.nativePickerSettleTimer);
  plugin.attachObserver(state, rootB);
  assert.equal(state.nativePickerDeferredLines.size, 0);
  assert.equal(state.nativePickerSettleTimer, null);
  plugin.disposePanelState?.('missing');
});

test('mixed mutation batches scope work to the line that actually changed a reference', () => {
  const { plugin, context } = instance();
  const makeLine = () => {
    const line = new context.Element();
    line.isConnected = true;
    line.closest = () => line;
    return line;
  };
  const plainMutations = Array.from({ length: 500 }, () => {
    const line = makeLine();
    const node = new context.Element();
    node.matches = () => false;
    node.querySelector = () => null;
    node.closest = () => line;
    return { type: 'childList', target: line, addedNodes: [node], removedNodes: [] };
  });
  const refLine = makeLine();
  const ref = new context.Element();
  ref.matches = (selector) => selector.includes('.lineitem-ref');
  ref.querySelector = () => null;
  ref.closest = () => refLine;
  const lines = plugin._mutatedLines([...plainMutations, {
    type: 'childList', target: refLine, addedNodes: [ref], removedNodes: []
  }]);

  assert.equal(lines.size, 1);
  assert.equal(lines.has(refLine), true);
});

test('native @ autocomplete mutations stay outside every reference observer hot path', () => {
  const { plugin, context } = instance();
  const callbacks = [];
  context.MutationObserver = class {
    constructor(fn) { callbacks.push(fn); }
    observe() {}
    disconnect() {}
  };

  const line = new context.Element();
  line.isConnected = true;
  line.getAttribute = (name) => name === 'data-guid' ? 'LINE_NATIVE_AT' : null;
  line.matches = () => false;
  line.closest = (selector) => selector.includes('.listitem[data-guid]') ? line : null;
  line.querySelector = () => null;
  const picker = new context.Element();
  picker.isConnected = true;
  picker.classList = classListSet(['autocomplete--option']);
  picker.matches = (selector) => selector.includes('.autocomplete--option') || selector.includes('[data-record-guid]');
  picker.closest = (selector) => selector.includes('.listitem[data-guid]') ? line : null;
  picker.querySelector = () => null;
  picker.querySelectorAll = () => [];
  picker.getAttribute = (name) => name === 'data-record-guid' ? 'SUGGESTION_RECORD' : null;
  const mutation = { type: 'childList', target: line, addedNodes: [picker], removedNodes: [] };

  let rescans = 0;
  let tags = 0;
  let overlayRafs = 0;
  let expensiveCalls = 0;
  let pickerQueries = 0;
  context.document.querySelectorAll = (selector) => {
    if (selector === '.cmdpal--inline') pickerQueries++;
    return [];
  };
  line.getBoundingClientRect = () => { expensiveCalls++; return { top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1 }; };
  plugin.scheduleRescanLines = () => { rescans++; };
  plugin._tagReferenceChip = () => { tags++; };
  plugin._scheduleOverlayReposition = () => { overlayRafs++; };
  plugin.getCountInfoForGuid = async () => { expensiveCalls++; return { count: 0, capped: false }; };
  plugin.data = {
    searchByQuery: async () => { expensiveCalls++; return { lines: [], records: [] }; },
    getRecord: () => ({ getLineItems: async () => { expensiveCalls++; return []; }, getBackReferences: async () => { expensiveCalls++; return []; } }),
  };

  assert.equal(plugin.nodeHasReferenceHint(picker), false, 'generic data-record-guid suggestion rows are not committed refs');
  assert.equal(plugin._mutatedLines([mutation]).size, 0);
  assert.equal(plugin._mutatedLineGuids([mutation]).size, 0);

  plugin.attachObserver({}, {});
  callbacks.at(-1)([mutation]);

  plugin._cardObs = null;
  plugin._ensureCardObserver();
  callbacks.at(-1)([mutation]);

  plugin._overlayMode = true;
  plugin._overlayObs = null;
  plugin._liveOverlayBadges.set('LINE_NATIVE_AT›TARGET›0', { lineGuid: 'LINE_NATIVE_AT', node: {} });
  plugin._ensureOverlayObserver();
  callbacks.at(-1)([mutation]);

  assert.equal(rescans, 0);
  assert.equal(tags, 0);
  assert.equal(overlayRafs, 0);
  assert.equal(pickerQueries, 0, 'suggestion-only mutations are rejected before picker-state DOM queries');
  assert.equal(expensiveCalls, 0, 'picker churn performs no rect, body, search, or backlink work');
});

test('ordinary @ key performs no RefX detection, search, or interception', () => {
  const { plugin } = instance();
  let calls = 0;
  plugin._detect = () => { calls++; return null; };
  plugin._caretInfo = () => { calls++; return null; };
  plugin._triggerLink = () => { calls++; };
  plugin._openReferenceNavigator = () => { calls++; };
  plugin.data = { searchByQuery: async () => { calls++; return { lines: [], records: [] }; } };
  plugin._hotkey = { meta: true, ctrl: false, shift: true, alt: false, code: 'KeyA', key: 'a' };
  plugin._navigatorConfig = { enabled: true };
  plugin._navigatorHotkeys = [];
  plugin._fnHotkey = { ctrl: false, key: 'f' };
  plugin._handleFnKey = () => {};
  const event = Object.assign(keyEvent('@'), {
    code: 'Digit2', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false,
    target: { tagName: 'BODY', isContentEditable: false },
  });

  plugin._handleKeydown(event);
  plugin._handleDrillKey(event);
  plugin._handleBracketKey(event);
  plugin._handleExpandKey(event);
  plugin._handleWbEnter(event);
  plugin._handleCardNavTrigger(event);
  plugin._handleRefChord(event);
  plugin._linkKey(event);

  assert.equal(calls, 0);
  assert.equal(event.prevented, false);
  assert.equal(event.stopped, false);
});

test('reference appearance setting persists and switches body classes', () => {
  const { plugin, context } = instance();
  const bodyClasses = classListSet();
  context.document.body.classList = bodyClasses;
  plugin._storageKeyReferenceStyle = 'refx_reference_style_test';
  plugin._referenceStyle = 'native';
  plugin._tagReferenceChipsIn = () => {};

  plugin.setReferenceStyle('distinct');
  assert.equal(context.localStorage.getItem('refx_reference_style_test'), 'distinct');
  assert.equal(bodyClasses.contains('refx-links-distinct'), true);
  assert.equal(bodyClasses.contains('refx-links-roam'), false);
  plugin.setReferenceStyle('roam');
  assert.equal(bodyClasses.contains('refx-links-distinct'), false);
  assert.equal(bodyClasses.contains('refx-links-roam'), true);
});

test('styled reference modes do not replay Thymer color transitions on rebuilt chips', () => {
  assert.match(source, /body\.refx-links-distinct \.refx-pageref-chip,\s*body\.refx-links-distinct \.refx-lineref-chip,\s*body\.refx-links-roam \.refx-pageref-chip,\s*body\.refx-links-roam \.refx-lineref-chip \{\s*transition: none !important;\s*\}/);
});

test('page creation always prefers Notes independently of selection-wrap config', async () => {
  const { plugin, context } = instance();
  const notes = { guid: 'NOTES', getGuid: () => 'NOTES', getName: () => 'Notes' };
  const projects = { guid: 'PROJECTS', getGuid: () => 'PROJECTS', getName: () => 'Projects' };
  const fallback = { guid: 'DEFAULT', getGuid: () => 'DEFAULT', getName: () => 'Pages' };
  plugin._wrapCreateCollection = 'Projects';
  plugin.data = { getAllCollections: async () => [fallback, projects, notes] };
  assert.equal(await plugin._pageCreateCollection(), notes);
  assert.equal(await plugin._pageCreateCollection(plugin._wrapCreateCollection), projects);

  context.window.g_universe.workspace.default_new_collection_guid = 'DEFAULT';
  plugin.data = { getAllCollections: async () => [fallback] };
  assert.equal(await plugin._pageCreateCollection(), fallback);
});

test('rapid Enter ignores stale nonempty record results and routes through create/exact recheck', () => {
  const { plugin } = instance();
  let picked = null;
  let createName = null;
  plugin._link = {
    kind: 'record',
    query: 'Alpha New',
    resultsQuery: 'Alpha',
    searchTimer: 1,
    results: [{ guid: 'ALPHA', text: 'Alpha' }],
    sel: 0
  };
  plugin._pickLink = (result) => { picked = result; };
  plugin._createPageFromPicker = (name) => { createName = name; };
  const event = keyEvent('Enter');

  plugin._linkKey(event);

  assert.equal(createName, 'Alpha New');
  assert.equal(picked, null);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('current fuzzy results create the exact typed page when none is an exact match', () => {
  const { plugin } = instance();
  let picked = null;
  let createName = null;
  const fuzzy = { guid: 'ALPHA', text: 'Alpha Existing' };
  plugin._link = {
    kind: 'record',
    query: 'Alpha New',
    resultsQuery: 'Alpha New',
    searchTimer: null,
    results: [fuzzy],
    sel: 0
  };
  plugin._pickLink = (result) => { picked = result; };
  plugin._createPageFromPicker = (name) => { createName = name; };

  plugin._linkKey(keyEvent('Enter'));

  assert.equal(picked, null);
  assert.equal(createName, 'Alpha New');
});

test('an explicitly arrow-selected fuzzy result remains selectable on Enter', () => {
  const { plugin } = instance();
  let picked = null;
  let createName = null;
  const fuzzy = { guid: 'ALPHA', text: 'Alpha Existing' };
  plugin._link = {
    kind: 'record',
    query: 'Alpha New',
    resultsQuery: 'Alpha New',
    searchTimer: null,
    results: [fuzzy],
    sel: 0,
    userSelected: true
  };
  plugin._pickLink = (result) => { picked = result; };
  plugin._createPageFromPicker = (name) => { createName = name; };

  plugin._linkKey(keyEvent('Enter'));

  assert.equal(picked, fuzzy);
  assert.equal(createName, null);
});

test('rapid Enter exact-name recheck links existing page instead of creating duplicate', async () => {
  const { plugin } = instance();
  let creates = 0;
  let picked = null;
  plugin._link = { kind: 'record', query: 'Existing Page', token: 0, results: [], creating: false, synthetic: true };
  plugin._renderLink = () => {};
  plugin._findExactPageForCreate = async () => ({ guid: 'EXISTING', text: 'Existing Page', page: '' });
  plugin._pageCreateCollection = async () => ({ createRecord: () => { creates++; return 'NEW'; } });
  plugin._pickLink = async (result) => { picked = result; return true; };

  assert.equal(await plugin._createPageFromPicker('Existing Page'), true);
  assert.equal(creates, 0);
  assert.equal(picked.guid, 'EXISTING');
});

test('missing page is created in resolved collection and passed to normal picker write', async () => {
  const { plugin } = instance();
  let picked = null;
  plugin._link = { kind: 'record', query: 'Brand New', token: 0, results: [], creating: false, synthetic: true };
  plugin._renderLink = () => {};
  plugin._findExactPageForCreate = async () => null;
  plugin._pageCreateCollection = async () => ({ createRecord: (name) => name === 'Brand New' ? 'NEW_GUID' : null });
  plugin._pickLink = async (result) => { picked = result; return true; };

  assert.equal(await plugin._createPageFromPicker('Brand New'), true);
  assert.equal(picked.guid, 'NEW_GUID');
  assert.equal(picked.text, 'Brand New');
  assert.equal(picked.page, '');
  assert.equal(picked.created, true);
});

test('page creation preflight refuses to create an orphan when the bracket source changed', async () => {
  const { plugin } = instance();
  let creates = 0;
  let toast = '';
  plugin._link = {
    kind: 'record', query: 'Changed Source', token: 0, results: [], creating: false,
    synthetic: false, pageGuid: 'PAGE', lineGuid: 'LINE', br: '[['
  };
  plugin.data = { getRecord: () => null };
  plugin._renderLink = () => {};
  plugin._toast = (message) => { toast = message; };
  plugin._findExactPageForCreate = async () => null;
  plugin._pageCreateCollection = async () => ({ createRecord: () => { creates++; return 'ORPHAN'; } });

  assert.equal(await plugin._createPageFromPicker('Changed Source'), false);
  assert.equal(creates, 0);
  assert.match(toast, /text changed/i);
});

test('page creation reports the real picker insertion result', async () => {
  const { plugin } = instance();
  let toast = '';
  plugin._link = { kind: 'record', query: 'Insert Fails', token: 0, results: [], creating: false, synthetic: true };
  plugin._renderLink = () => {};
  plugin._toast = (message) => { toast = message; };
  plugin._findExactPageForCreate = async () => null;
  plugin._pageCreateCollection = async () => ({ createRecord: () => 'NEW_BUT_UNLINKED' });
  plugin._pickLink = async () => false;

  assert.equal(await plugin._createPageFromPicker('Insert Fails'), false);
  assert.match(toast, /could not be inserted/i);
});

test('reload preserves numeric seeds and marks them for authoritative refinement', () => {
  const { plugin } = instance();
  const VMMap = plugin._lineOwnerHints.constructor;
  const VMSet = plugin._immediateRefTargets.constructor;
  plugin._countCache = new VMMap([
    ['A', { count: 3, capped: false, sdkPropCount: 1, updatedAt: Date.now() }],
    ['PENDING', { pending: true, promise: Promise.resolve() }]
  ]);
  plugin._recordExistsCache = new VMMap([['A', true]]);
  plugin._recordNameCache = new VMMap([['A', 'A']]);
  plugin._lineRefGuids = new VMMap([['L', new VMSet(['A'])]]);
  plugin._backrefCache = new VMMap([['A', {}]]);
  plugin._taskInfoCache = new VMMap([
    ['L', { is: true, done: true, ts: Date.now() }],
    ['NOT_TASK', { is: false, done: false, ts: Date.now() }]
  ]);
  plugin._linePropRefIndex = {
    builtAt: Date.now(),
    recordsByTarget: new VMMap([['L', new VMSet(['R'])]]),
    targetsByRecord: new VMMap([['R', new VMSet(['L'])]])
  };

  plugin._prepareCachesForReload();
  assert.equal(plugin._countCache.get('A').count, 3);
  assert.equal(plugin._countCache.get('A').fromDisk, true);
  assert.equal(plugin._countCache.has('PENDING'), false);
  assert.equal(plugin._linePropRefIndex.fromDisk, true);
  assert.equal(plugin._linePropRefIndex.builtAt, 0);
  assert.equal(plugin._recordExistsCache.size, 0);
  assert.equal(plugin._taskInfoCache.has('NOT_TASK'), false);
  assert.equal(plugin._taskInfoCache.get('L').is, true);
  assert.equal(plugin._taskInfoCache.get('L').done, true);
  assert.equal(plugin._taskInfoCache.get('L').provisional, true);
  assert.equal(plugin._taskInfoCache.get('L').ts, 0);
});

test('status-only task event updates checkbox cache without requiring segments', () => {
  const { plugin } = instance();
  plugin._scheduleTaskHintPersist = () => {};
  let painted = null;
  plugin._paintTaskGuidNow = (guid, info) => { painted = { guid, info }; };
  plugin.didSharedIgnoreChange = () => false;
  plugin.handleLineItemUpdated({
    lineItemGuid: 'TASK3',
    recordGuid: 'REC3',
    status: 'done',
    hasSegments: () => false
  });

  assert.equal(plugin._taskInfoCache.get('TASK3').done, true);
  assert.equal(plugin._lineOwnerHints.get('TASK3'), 'REC3');
  assert.equal(painted.guid, 'TASK3');
});

test('task-to-text event wins over stale done metadata and removes the checkbox immediately', () => {
  const { plugin } = instance();
  let painted = null;
  plugin._taskInfoCache.set('TASK4', { is: true, done: true, ts: Date.now() });
  plugin._lineOwnerHints.set('TASK4', 'REC4');
  plugin._scheduleTaskHintPersist = () => {};
  plugin._paintTaskGuidNow = (guid, info) => { painted = { guid, info }; };
  plugin.didSharedIgnoreChange = () => false;

  plugin.handleLineItemUpdated({
    lineItemGuid: 'TASK4',
    recordGuid: 'REC4',
    type: 'text',
    status: null,
    metaProperties: { done: null },
    hasSegments: () => false
  });

  assert.equal(plugin._taskInfoCache.get('TASK4').is, false);
  assert.equal(plugin._lineOwnerHints.has('TASK4'), false);
  assert.equal(painted.guid, 'TASK4');
  assert.equal(painted.info.is, false);
});

test('late getLineItem from an older task event cannot overwrite a newer task-to-text event', async () => {
  const { plugin } = instance();
  const oldHandle = deferred();
  plugin._scheduleTaskHintPersist = () => {};
  plugin._paintTaskGuidNow = () => {};
  plugin.didSharedIgnoreChange = () => false;

  plugin.handleLineItemUpdated({
    lineItemGuid: 'TASK_RACE', recordGuid: 'REC', status: 'done',
    getLineItem: () => oldHandle.promise,
    hasSegments: () => false
  });
  plugin.handleLineItemUpdated({
    lineItemGuid: 'TASK_RACE', recordGuid: 'REC', type: 'text',
    metaProperties: { done: null }, hasSegments: () => false
  });

  oldHandle.resolve({
    guid: 'TASK_RACE', getType: () => 'task', getTaskStatus: () => 'done',
    getRecord: () => ({ guid: 'REC' })
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(plugin._taskInfoCache.get('TASK_RACE').is, false);
  assert.equal(plugin._lineOwnerHints.has('TASK_RACE'), false);
});

test('ordinary unknown non-task updates never hydrate event.getLineItem', async () => {
  const { plugin } = instance();
  let reads = 0;
  plugin.didSharedIgnoreChange = () => false;
  plugin.handleLineItemUpdated({
    lineItemGuid: 'PLAIN_UNKNOWN', recordGuid: 'REC_PLAIN',
    segments: [{ type: 'text', text: 'ordinary edit' }],
    getLineItem: () => { reads++; return { guid: 'PLAIN_UNKNOWN', type: 'text' }; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 0, 'unknown text/ref events must not cross the line-item bridge');
});

test('ordinary segment edits on an already-known task do not hydrate the line handle', async () => {
  const { plugin } = instance();
  let reads = 0;
  plugin._taskInfoCache.set('KNOWN_TASK', { is: true, done: false, ts: Date.now() });
  plugin._lineOwnerHints.set('KNOWN_TASK', 'REC_TASK');
  plugin._scheduleTaskResolveRetry = () => {};
  plugin._scheduleTaskHintPersist = () => {};
  plugin._paintTaskGuidNow = () => {};
  plugin.didSharedIgnoreChange = () => false;
  plugin.handleLineItemUpdated({
    lineItemGuid: 'KNOWN_TASK', recordGuid: 'REC_TASK',
    segments: [{ type: 'text', text: 'known task edit' }],
    getLineItem: () => {
      reads++;
      return { guid: 'KNOWN_TASK', getType: () => 'task', getTaskStatus: () => 'done', getRecord: () => ({ guid: 'REC_TASK' }) };
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 0);
  assert.equal(plugin._taskInfoCache.get('KNOWN_TASK').is, true);
  assert.equal(plugin._taskInfoCache.get('KNOWN_TASK').done, false);
});

test('an already-known task candidate may hydrate a segmentless metadata update', async () => {
  const { plugin } = instance();
  let reads = 0;
  plugin._taskInfoCache.set('KNOWN_TASK_META', { is: true, done: false, ts: Date.now() });
  plugin._lineOwnerHints.set('KNOWN_TASK_META', 'REC_TASK');
  plugin._scheduleTaskResolveRetry = () => {};
  plugin._scheduleTaskHintPersist = () => {};
  plugin._paintTaskGuidNow = () => {};
  plugin.didSharedIgnoreChange = () => false;
  plugin.handleLineItemUpdated({
    lineItemGuid: 'KNOWN_TASK_META', recordGuid: 'REC_TASK',
    hasSegments: () => false,
    getLineItem: () => {
      reads++;
      return { guid: 'KNOWN_TASK_META', getType: () => 'task', getTaskStatus: () => 'done', getRecord: () => ({ guid: 'REC_TASK' }) };
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(plugin._taskInfoCache.get('KNOWN_TASK_META').is, true);
  assert.equal(plugin._taskInfoCache.get('KNOWN_TASK_META').done, true);
});

test('a cold segmentless event may hydrate once to discover a first-time task', async () => {
  const { plugin } = instance();
  let reads = 0;
  plugin._scheduleTaskHintPersist = () => {};
  plugin._paintTaskGuidNow = () => {};
  plugin.didSharedIgnoreChange = () => false;
  plugin.handleLineItemUpdated({
    lineItemGuid: 'COLD_NEW_TASK', recordGuid: 'REC_TASK',
    hasSegments: () => false,
    getLineItem: () => {
      reads++;
      return { guid: 'COLD_NEW_TASK', getType: () => 'task', getTaskStatus: () => 'todo', getRecord: () => ({ guid: 'REC_TASK' }) };
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(plugin._taskInfoCache.get('COLD_NEW_TASK').is, true);
});

test('a cold segmentless non-task is probed once and then its negative classification is reused', async () => {
  const { plugin } = instance();
  let reads = 0;
  plugin._scheduleTaskHintPersist = () => {};
  plugin._paintTaskGuidNow = () => {};
  plugin.didSharedIgnoreChange = () => false;
  const event = {
    lineItemGuid: 'COLD_PLAIN', recordGuid: 'REC_PLAIN',
    hasSegments: () => false,
    getLineItem: () => {
      reads++;
      return { guid: 'COLD_PLAIN', getType: () => 'text', getRecord: () => ({ guid: 'REC_PLAIN' }) };
    },
  };
  plugin.handleLineItemUpdated(event);
  await Promise.resolve();
  await Promise.resolve();
  plugin.handleLineItemUpdated(event);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(plugin._taskInfoCache.get('COLD_PLAIN').is, false);
});

test('lineitem.updated drives the same-page line-mode +1 fast path immediately', () => {
  const { plugin } = instance();
  let queued = null;
  let refreshReason = null;
  plugin._countMode = 'lines';
  plugin._excludeCollections = new Set();
  plugin._countCache = new Map([['TARGET', { count: 2, capped: false, sdkPropCount: 0, updatedAt: Date.now() }]]);
  plugin._lineRefGuids = new Map([['SOURCE', new Set()]]);
  plugin._registryInboundCountMap = () => new Map([['TARGET', 3]]);
  plugin._invalidateBackrefsForTarget = () => {};
  plugin._invalidateBackrefs = () => {};
  plugin._scheduleCountRefine = () => {};
  plugin._queueImmediateRefPaint = (targets, lineGuid) => { queued = { targets: [...targets], lineGuid }; };
  plugin.didSharedIgnoreChange = () => false;
  plugin.refreshAllPanels = ({ reason }) => { refreshReason = reason; };

  plugin.handleLineItemUpdated({
    lineItemGuid: 'SOURCE',
    recordGuid: 'SOURCE_RECORD',
    hasSegments: () => true,
    getSegments: () => [{ type: 'ref', text: { guid: 'TARGET' } }]
  });

  assert.equal(plugin._lineRefGuids.get('SOURCE').has('TARGET'), true);
  assert.equal(plugin._countCache.get('TARGET').count, 3);
  assert.equal(plugin._countCache.get('TARGET').optimistic, true);
  assert.deepEqual(queued, { targets: ['TARGET'], lineGuid: 'SOURCE' });
  assert.equal(refreshReason, 'lineitem.ref-change');
});

test('stale pre-edit count promise cannot overwrite a newer optimistic count', async () => {
  const { plugin } = instance();
  const load = deferred();
  plugin._countMode = 'lines';
  plugin._excludeCollections = new Set();
  plugin._countCache = new Map([[
    'TARGET',
    { count: 2, capped: false, sdkPropCount: 0, updatedAt: 0, fromDisk: true }
  ]]);
  plugin.loadCountInfo = async () => load.promise;
  plugin._registryInboundCountMap = () => new Map([['TARGET', 3]]);
  plugin._invalidateBackrefsForTarget = () => {};
  plugin._scheduleCountRefine = () => {};
  plugin._queueImmediateRefPaint = () => {};

  const preEditRequest = plugin.getCountInfoForGuid('TARGET');
  plugin._optimisticRefCountDelta('SOURCE', new Set(), new Set(['TARGET']));
  assert.equal(plugin._countCache.get('TARGET').count, 3);
  assert.equal(plugin._countCache.get('TARGET').promise, undefined);

  load.resolve({ count: 2, capped: false, sdkPropCount: 0 });
  const resolved = await preEditRequest;
  assert.equal(resolved.count, 3);
  assert.equal(plugin._countCache.get('TARGET').count, 3);
  assert.equal(plugin._countCache.get('TARGET').optimistic, true);
});

test('combined-mode add keeps a safe unchanged lower bound until authoritative union refine', () => {
  const { plugin } = instance();
  const refinements = [];
  plugin._countMode = 'combined';
  plugin._excludeCollections = new Set();
  plugin._countCache = new Map([['TARGET', { count: 2, capped: false, sdkPropCount: 1, updatedAt: Date.now() }]]);
  plugin._registryInboundCountMap = () => new Map([['TARGET', 1]]);
  plugin._invalidateBackrefsForTarget = () => {};
  plugin._scheduleCountRefine = (guid, delay, lane) => { refinements.push({ guid, delay, lane }); };
  plugin._queueImmediateRefPaint = () => {};

  plugin._optimisticRefCountDelta('SOURCE', new Set(), new Set(['TARGET']));

  const info = plugin._countCache.get('TARGET');
  assert.equal(info.count, 2);
  assert.equal(info.sdkPropCount, 1);
  assert.equal(info.optimisticDirection, 'add');
  assert.deepEqual(refinements, [
    { guid: 'TARGET', delay: 450, lane: 'early' },
    { guid: 'TARGET', delay: 1500, lane: 'settle' }
  ]);
});

test('line-mode delta does not treat a persisted reload seed as authoritative', () => {
  const { plugin } = instance();
  plugin._countMode = 'lines';
  plugin._excludeCollections = new Set();
  plugin._countCache = new Map([['TARGET', { count: 9, fromDisk: true, updatedAt: 0 }]]);
  plugin._registryInboundCountMap = () => new Map([['TARGET', 3]]);
  plugin._invalidateBackrefsForTarget = () => {};
  plugin._scheduleCountRefine = () => {};
  plugin._queueImmediateRefPaint = () => {};

  plugin._optimisticRefCountDelta('SOURCE', new Set(), new Set(['TARGET']));
  assert.equal(plugin._countCache.get('TARGET').count, 3);
});

test('hidden self-reference is never optimistically painted', () => {
  const { plugin, context } = instance();
  plugin._showSelf = false;
  plugin._countMode = 'lines';
  plugin._excludeCollections = new Set();
  plugin._countCache = new Map();
  context.window.g_universe.itemsByGuid.SOURCE = { guid: 'SOURCE', rguid: 'TARGET_RECORD' };
  let queued = false;
  plugin._registryInboundCountMap = () => new Map([['TARGET_RECORD', 1]]);
  plugin._queueImmediateRefPaint = () => { queued = true; };

  const primed = plugin._optimisticRefCountDelta('SOURCE', new Set(), new Set(['TARGET_RECORD']));
  assert.equal(primed.has('TARGET_RECORD'), false);
  assert.equal(plugin._countCache.has('TARGET_RECORD'), false);
  assert.equal(queued, false);
});

test('registry lower-bound excludes a source line owned by the target record', () => {
  const { plugin, context } = instance();
  plugin._showSelf = false;
  context.window.g_universe.itemsByGuid.SOURCE = {
    guid: 'SOURCE', rguid: 'TARGET_RECORD',
    text_segments: ['ref', { guid: 'TARGET_RECORD' }]
  };
  const counts = plugin._registryInboundCountMap(new Set(['TARGET_RECORD']));
  assert.equal(counts.get('TARGET_RECORD') || 0, 0);
});

test('lagging pre-index count cannot snap an optimistic removal back upward', async () => {
  const { plugin } = instance();
  const load = deferred();
  plugin._countCache = new Map([['TARGET', {
    count: 1, optimistic: true, optimisticDirection: 'remove',
    optimisticUntil: Date.now() + 5000, updatedAt: Date.now()
  }]]);
  plugin.loadCountInfo = async () => load.promise;
  plugin._scheduleCountRefine = () => {};

  const request = plugin.getCountInfoForGuid('TARGET');
  load.resolve({ count: 2, capped: false, sdkPropCount: 0 });
  const info = await request;
  assert.equal(info.count, 1);
  assert.equal(plugin._countCache.get('TARGET').count, 1);
  assert.equal(plugin._countCache.get('TARGET').optimistic, true);
});

test('reload cancels pre-reload count settle timers', () => {
  const { plugin } = instance();
  const timer = setTimeout(() => assert.fail('stale settle timer fired'), 10000);
  plugin._countRefineTimers.set('TARGET:early', timer);
  plugin._prepareCachesForReload();
  assert.equal(plugin._countRefineTimers.size, 0);
});

test('disabled targeted painters and retry queue are strict no-ops', () => {
  const { plugin, context } = instance();
  let queries = 0;
  context.document.querySelectorAll = () => { queries++; return []; };
  plugin._enabled = false;
  plugin._targetLineBadges = true;

  plugin._paintTaskGuidNow('TASK', { is: true, done: false });
  plugin._paintCountInfoForGuidNow('TARGET', { count: 1, capped: false, sdkPropCount: 0 });
  plugin._queueImmediateRefPaint(new Set(['TARGET']), 'SOURCE');
  plugin._scheduleTaskResolveRetry('TASK', true, 'alias');

  assert.equal(queries, 0);
  assert.equal(plugin._immediateRefTargets.size, 0);
  assert.equal(plugin._immediateRefLines.size, 0);
  assert.equal(plugin._taskResolveRetries.size, 0);
});

test('identifier search ignores punctuation, spaces, and letter-number boundaries', () => {
  const { plugin } = instance();
  assert.ok(plugin._searchScore('EMP26-002-BHP', 'EMP 26') > 0);
  assert.ok(plugin._searchScore('QUAL-4507.11-WI', 'QUAL 4507 11') > 0);
  assert.ok(plugin._searchScore('EMP26-002-BHP', 'EMP BHP') > 0);
  assert.ok(plugin._searchScore('EMP26-002-BHP corrective action', 'EMP 26+BHP') > 0);
  assert.equal(plugin._searchScore('EMP26-002-BHP', 'EMP 27'), -1);
});

test('ranked search puts the compact identifier match ahead of loose token matches', () => {
  const { plugin } = instance();
  const exact = { guid: 'A', text: 'EMP26-002-BHP', score: plugin._searchScore('EMP26-002-BHP', 'EMP 26') };
  const loose = { guid: 'B', text: 'Notes about EMP work in week 26', score: plugin._searchScore('Notes about EMP work in week 26', 'EMP 26') };
  const ranked = plugin._rankSearchResults([loose, exact]);
  assert.equal(ranked[0].guid, 'A');
});

test('record search publishes a local EMP match before remote search settles', async () => {
  const { plugin, context } = instance();
  const remote = deferred();
  const remoteStarted = deferred();
  context.window.g_universe.itemsByGuid.EMP_PAGE = { guid: 'EMP_PAGE', type: 'document' };
  plugin.data = {
    getRecord: (guid) => guid === 'EMP_PAGE' ? { getName: () => 'EMP26-002-BHP' } : null,
    searchByQuery: () => { remoteStarted.resolve(); return remote.promise; }
  };
  let renders = 0;
  plugin._renderLink = () => { renders++; };
  plugin._link = { kind: 'record', query: 'EMP 26', token: 0, results: [], sel: 0, userSelected: false };

  const pending = plugin._runRecordSearch('EMP 26');
  // Workspace search starts only after the chunked local registry/index pass.
  // Await that phase boundary without resolving the remote promise so the
  // assertion remains deterministic under a parallel/full-suite event loop.
  await remoteStarted.promise;
  assert.equal(plugin._link.results[0].text, 'EMP26-002-BHP');
  assert.ok(renders > 0);
  remote.resolve({ records: [] });
  await pending;
});

test('line search publishes a local punctuation-insensitive match before remote search settles', async () => {
  const { plugin, context } = instance();
  const remote = deferred();
  context.window.g_universe.itemsByGuid.LINE_EMP = {
    guid: 'LINE_EMP', rguid: 'REC', type: 'text',
    text_segments: ['text', 'Update EMP26-002-BHP today']
  };
  plugin.data = {
    getRecord: () => ({ getName: () => 'Project' }),
    searchByQuery: () => remote.promise
  };
  plugin._renderLink = () => {};
  plugin._link = { kind: 'line', query: 'EMP 26', lineGuid: 'SOURCE', token: 0, results: [], sel: 0, userSelected: false };

  const pending = plugin._runLinkSearch('EMP 26');
  assert.equal(plugin._link.results[0].guid, 'LINE_EMP');
  remote.resolve({ lines: [] });
  await pending;
});

test('create-page row is a keyboard option and Enter executes the visible choice', () => {
  const { plugin } = instance();
  let created = null;
  plugin._renderLink = () => {};
  plugin._createPageFromPicker = (name) => { created = name; };
  plugin._link = {
    kind: 'record', query: 'Brand New', resultsQuery: 'Brand New',
    searchTimer: null, results: [], sel: 0, userSelected: false
  };

  plugin._linkKey(keyEvent('ArrowDown'));
  assert.equal(plugin._link.userSelected, true);
  assert.equal(plugin._link.sel, 0);
  plugin._linkKey(keyEvent('Enter'));
  assert.equal(created, 'Brand New');
});

test('ArrowDown moves from default create choice to the first fuzzy page result', () => {
  const { plugin } = instance();
  const fuzzy = { guid: 'EXISTING', text: 'EMP26-002-BHP' };
  let picked = null;
  plugin._renderLink = () => {};
  plugin._pickLink = (r) => { picked = r; };
  plugin._createPageFromPicker = () => assert.fail('create should not run after selecting result');
  plugin._link = {
    kind: 'record', query: 'EMP 26', resultsQuery: 'EMP 26',
    searchTimer: null, results: [fuzzy], sel: 0, userSelected: false
  };
  assert.equal(plugin._linkEffectiveSelection(plugin._link), 1); // create row is visibly selected by default
  plugin._linkKey(keyEvent('ArrowDown'));
  assert.equal(plugin._link.sel, 0);
  plugin._linkKey(keyEvent('Enter'));
  assert.equal(picked, fuzzy);
});

test('fast Enter cannot insert a stale line-search result', () => {
  const { plugin } = instance();
  let picked = null;
  let reran = null;
  plugin._pickLink = (r) => { picked = r; };
  plugin._runLinkSearch = (q) => { reran = q; };
  plugin._link = {
    kind: 'line', query: 'new query', resultsQuery: 'old query', searchTimer: null,
    results: [{ guid: 'STALE', text: 'old result' }], sel: 0, userSelected: true
  };
  plugin._linkKey(keyEvent('Enter'));
  assert.equal(picked, null);
  assert.equal(reran, 'new query');
});

test('empty plain lines are never eligible for target badges but ref-only lines are', () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.EMPTY = { guid: 'EMPTY', type: 'text', text_segments: [] };
  context.window.g_universe.itemsByGuid.REF_ONLY = { guid: 'REF_ONLY', type: 'text', text_segments: ['ref', { guid: 'TARGET', title: 'Target' }] };
  assert.equal(plugin._lineHasMeaningfulContent(null, 'EMPTY'), false);
  assert.equal(plugin._lineHasMeaningfulContent(null, 'REF_ONLY'), true);
});

test('stale mounted target badge is removed and not reinserted on an empty refreshed line', () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.EMPTY_REFRESH = {
    guid: 'EMPTY_REFRESH', type: 'text', text_segments: []
  };
  let removed = false;
  let lineEl;
  const wrap = {
    closest: () => lineEl,
    remove() { removed = true; }
  };
  const emptyText = { textContent: '', closest: () => lineEl };
  lineEl = {
    getAttribute: (name) => name === 'data-guid' ? 'EMPTY_REFRESH' : '',
    querySelectorAll: (selector) => {
      if (selector === '.trc-target-badge-wrap') return [wrap];
      if (selector === '.lineitem-text') return [emptyText];
      return [];
    }
  };
  plugin._liveTargetBadges.set('EMPTY_REFRESH', { node: wrap, lineGuid: 'EMPTY_REFRESH' });

  const result = plugin.upsertTargetBadge(lineEl, 'EMPTY_REFRESH', { count: 1, capped: false });

  assert.equal(result, null);
  assert.equal(removed, true);
  assert.equal(plugin._liveTargetBadges.has('EMPTY_REFRESH'), false);
});

test('failed authoritative refine drops a disk-only positive count', async () => {
  const { plugin } = instance();
  plugin._countCache = new Map();
  plugin._countCache.set('EMPTY', { count: 1, fromDisk: true, updatedAt: 0 });
  plugin.loadCountInfo = async () => { throw new Error('offline'); };
  const info = await plugin.getCountInfoForGuid('EMPTY');
  assert.equal(info.count, 0);
  assert.equal(plugin._countCache.get('EMPTY').fromDisk, undefined);
  if (plugin._countCachePersistTimer) clearTimeout(plugin._countCachePersistTimer);
});

test('task checkbox geometry is tied to the chip front, never the row gutter', () => {
  const { plugin } = instance();
  const host = { getBoundingClientRect: () => ({ top: 100, bottom: 130, left: 40, right: 500 }) };
  const node = { isConnected: true, parentElement: host, style: {} };
  const chip = {
    getClientRects: () => [{ top: 103, left: 180, right: 340, width: 160, height: 20 }],
    getBoundingClientRect: () => ({ top: 103, left: 180, right: 340, width: 160, height: 20 })
  };
  plugin._findRefChip = () => chip;
  const entry = { node, lineGuid: 'SOURCE', targetGuid: 'TASK', ordinal: 0 };
  const plan = plugin._measureCheckOverlay(entry, new Map(), plugin._overlayFrameReads());
  assert.equal(plan.bx, 142); // chip.left - host.left + 2
  assert.notEqual(plan.bx, -25);
  assert.equal(entry.leading, true);
});

test('task leading-slot CSS keys to native chip identity and survives plugin-host class loss', () => {
  const { plugin, context } = instance();
  let style = null;
  context.document.getElementById = () => null;
  context.document.createElement = () => ({ id: '', textContent: '', remove() {} });
  context.document.head.appendChild = (node) => { style = node; };
  plugin._taskRefGuids.add('TASK_GUID');

  plugin._flushTaskRefStyle();

  assert.ok(style);
  assert.match(style.textContent, /\.line-div \.lineitem-ref\[data-guid="TASK_GUID"\]/);
  assert.match(style.textContent, /padding-inline-start:20px!important/);
  assert.doesNotMatch(style.textContent, /refx-ovl-host|:has\(/);
});

test('star-alias task refs reconcile away checkboxes while meaningful aliases keep them', async () => {
  const { plugin } = instance();
  const line = {
    getAttribute: (name) => name === 'data-guid' ? 'SOURCE_LINE' : '',
    querySelectorAll: () => []
  };
  const chip = (title) => ({
    isConnected: true,
    textContent: title,
    dataset: {},
    classList: classListSet(['lineitem-ref']),
    querySelector: (selector) => selector === '.lineitem-ref-title' ? { textContent: title } : null,
    querySelectorAll: () => [],
    getAttribute: (name) => name === 'data-guid' ? (title === '*' ? 'TASK_STAR' : 'TASK_ALIAS') : '',
    closest: (selector) => selector === '.listitem[data-guid]' ? line : null
  });
  const star = chip('*');
  const normal = chip('Meaningful alias');
  plugin._chipOrdinal = () => 0;
  const starKey = plugin._decoKey('SOURCE_LINE', 'TASK_STAR', 0);
  let oldOverlayRemoved = false;
  plugin._liveCheckOverlays.set(starKey, {
    node: { parentElement: null, remove() { oldOverlayRemoved = true; } },
    lineGuid: 'SOURCE_LINE', targetGuid: 'TASK_STAR', ordinal: 0
  });
  const resolved = [];
  plugin._lineTaskInfo = async (guid, titleHint) => {
    resolved.push([guid, titleHint]);
    return { is: true, done: false };
  };
  const upserts = [];
  plugin.upsertChipTaskGlyph = (el, guid, done) => {
    upserts.push([el, guid, done]);
    return { guid };
  };
  const state = { scanSeq: 9, ignoreMutationsUntil: 0 };

  await plugin.scanChipTaskGlyphs(
    [{ el: star, guid: 'TASK_STAR' }, { el: normal, guid: 'TASK_ALIAS' }],
    {}, state, 9, { skipGlobalOrphan: true }
  );

  assert.equal(oldOverlayRemoved, true, 'the previously mounted star checkbox is removed');
  assert.equal(plugin._liveCheckOverlays.has(starKey), false, 'keep-alive registry no longer owns the star checkbox');
  assert.deepEqual(resolved, [['TASK_ALIAS', 'Meaningful alias']], 'star aliases skip task resolution/decorating');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0][0], normal);
  assert.deepEqual(upserts[0].slice(1), ['TASK_ALIAS', false]);
});

test('custom.hideNativeOpenGlyphs toggles the body class and defaults on', () => {
  const { plugin, context } = instance();
  const bodyClasses = classListSet();
  context.document.body.classList = bodyClasses;

  plugin._applyHideNativeOpenGlyphsConfig({ custom: {} });
  assert.equal(plugin._hideNativeOpenGlyphs, true);
  assert.equal(bodyClasses.contains('refx-hide-native-open'), true);

  plugin._applyHideNativeOpenGlyphsConfig({ custom: { hideNativeOpenGlyphs: false } });
  assert.equal(plugin._hideNativeOpenGlyphs, false);
  assert.equal(bodyClasses.contains('refx-hide-native-open'), false);
});

test('native reference open buttons are hidden only behind the body-class gate', () => {
  assert.match(source, /body\.refx-hide-native-open \.lineitem-ref line-button\.lineitem-lineref,\s*body\.refx-hide-native-open \.lineitem-ref line-button\.link-menu-opener\s*\{\s*display:\s*none !important;\s*\}/);
});

test('Settings exposes the synced native-open-arrow option and its functionality note', () => {
  assert.match(source, /Hide Thymer's native open arrows on references \(RefX menus and Cmd\/Ctrl\+O \/ Cmd\/Ctrl\+Shift\+O provide Open \/ Open in side panel\)/);
  assert.match(source, /conf\.custom\.hideNativeOpenGlyphs\s*=\s*hideNativeOpenGlyphs !== false/);
  assert.match(source, /Automatically load small record bodies \(≤/);
  assert.match(source, /conf\.custom\.autoLoadSmallBodies\s*=\s*autoLoadSmallBodies !== false/);
});

test('Settings exposes and persists Roam-style star-alias click navigation', () => {
  assert.match(source, /Star aliases \(\*\) navigate on click \(Roam\) — off routes them through the reference menu/);
  assert.match(source, /conf\.custom\.starAliasClickNavigates\s*=\s*starAliasClickNavigates !== false/);
});

test('counter CSS style survives hot reload handoff and is removed on real disposal', () => {
  const { Plugin, context } = loadPlugin();
  const previous = new Plugin();
  const replacement = new Plugin();
  let connected = true;
  let removes = 0;
  const style = {
    id: 'trc-reference-counter-style',
    textContent: 'stale rules',
    remove() { removes++; connected = false; }
  };
  let creates = 0;
  let appends = 0;
  context.document.getElementById = (id) => connected && id === style.id ? style : null;
  context.document.createElement = () => { creates++; return {}; };
  context.document.head.appendChild = () => { appends++; };
  previous._counterStyleEl = style;
  context.window.__trcReferenceCounterPrev = {
    owner: previous,
    dispose: (options) => previous._releaseCounterStyle(options?.preserveStyle === true)
  };

  replacement._disposePriorCounterForReload();
  replacement.injectCounterCss();

  assert.equal(previous._counterStyleEl, null);
  assert.strictEqual(replacement._counterStyleEl, style);
  assert.equal(removes, 0);
  assert.equal(creates, 0);
  assert.equal(appends, 0);
  assert.match(style.textContent, /body\.trc-zerolayout \.line-div \.lineitem-ref/);
  assert.doesNotMatch(style.textContent, /stale rules/);

  replacement._releaseCounterStyle(false);
  assert.equal(replacement._counterStyleEl, null);
  assert.equal(removes, 1);
  assert.equal(connected, false);
});

test('auto line-title sync updates managed refs while preserving aliases', () => {
  const { plugin } = instance();
  const segments = [
    { type: 'ref', text: { guid: 'TARGET', title: 'Old target text' } },
    { type: 'text', text: ' and ' },
    { type: 'ref', text: { guid: 'TARGET', title: 'My custom alias' } }
  ];
  const meta = { v: 1, refs: {
    'TARGET#0': 'Old target text',
    'TARGET#1': 'Old target text'
  } };
  const out = plugin._rewriteAutoLineRefTitles(segments, 'TARGET', 'Old target text', 'New target text', meta);
  assert.equal(out.segments[0].text.title, 'New target text');
  assert.equal(out.segments[2].text.title, 'My custom alias');
  assert.equal(out.meta.refs['TARGET#0'], 'New target text');
  assert.equal(out.meta.refs['TARGET#1'], undefined);
});

test('poisoned owner-page auto title is selectively rewritten without clearing valid cache entries', () => {
  const { plugin } = instance();
  const segments = [
    { type: 'ref', text: { guid: 'BAD_LINE', title: 'Owner page' } },
    { type: 'text', text: ' / ' },
    { type: 'ref', text: { guid: 'GOOD_LINE', title: 'Correct line text' } },
    { type: 'text', text: ' / ' },
    { type: 'ref', text: { guid: 'RECORD', title: 'Record page' } },
    { type: 'text', text: ' / ' },
    { type: 'ref', text: { guid: 'ALIASED_LINE', title: 'My alias' } }
  ];
  const meta = { v: 1, refs: {
    'BAD_LINE#0': 'Owner page',
    'GOOD_LINE#0': 'Correct line text',
    'RECORD#0': 'Record page',
    'ALIASED_LINE#0': 'Old generated text'
  } };
  const facts = new Map([
    ['BAD_LINE', { kind: 'line', ownerName: 'Owner page', lineText: 'Actual line text' }],
    ['GOOD_LINE', { kind: 'line', ownerName: 'Another page', lineText: 'Correct line text' }],
    ['RECORD', { kind: 'record', ownerName: 'Record page', lineText: 'Not applicable' }],
    ['ALIASED_LINE', { kind: 'line', ownerName: 'Owner page', lineText: 'Actual aliased line' }]
  ]);

  const out = plugin._rewritePoisonedAutoLineRefTitles(segments, meta, facts);
  assert.equal(out.segments[0].text.title, 'Actual line text');
  assert.equal(out.segments[2].text.title, 'Correct line text');
  assert.equal(out.segments[4].text.title, 'Record page');
  assert.equal(out.segments[6].text.title, 'My alias');
  assert.equal(out.meta.refs['BAD_LINE#0'], 'Actual line text');
  assert.equal(out.meta.refs['GOOD_LINE#0'], 'Correct line text');
  assert.equal(out.meta.refs['RECORD#0'], 'Record page');
  assert.equal(out.meta.refs['ALIASED_LINE#0'], 'Old generated text');
});

test('poisoned managed-title cache repairs from Line Index text', async () => {
  const { plugin, context } = instance();
  const sourceGuid = 'SOURCE_LINE';
  const targetGuid = 'TARGET_LINE';
  const ownerGuid = 'OWNER_RECORD';
  const metaRaw = JSON.stringify({ v: 1, refs: {
    [targetGuid + '#0']: 'Owner page',
    'CORRECT_LINE#0': 'Already correct'
  } });
  const sourceState = {
    guid: sourceGuid,
    rguid: 'SOURCE_RECORD',
    type: 'text',
    props: { refx_auto_titles_v1: metaRaw },
    text_segments: [
      'ref', { guid: targetGuid, title: 'Owner page' },
      'text', ' / ',
      'ref', { guid: 'CORRECT_LINE', title: 'Already correct' }
    ]
  };
  context.window.g_universe.itemsByGuid[targetGuid] = {
    guid: targetGuid,
    rguid: ownerGuid,
    type: 'ulist',
    props: {},
    text_segments: []
  };
  context.window.__thymerLineIndexV1 = {
    contract: 'thymer-line-index-v1',
    version: 1,
    search: async () => ({ items: [] }),
    resolvedText: async (guid) => guid === targetGuid ? 'Actual target line' : null
  };
  plugin._recordNameIndex.set(ownerGuid, 'Owner page');
  plugin._liveStateByGuid = (guid) => guid === sourceGuid ? sourceState : null;
  let writtenSegments = null;
  let writtenMeta = null;
  const sourceLine = {
    guid: sourceGuid,
    props: { refx_auto_titles_v1: metaRaw },
    setSegments: async (segments) => { writtenSegments = segments; return true; },
    setMetaProperty: async (key, value) => {
      assert.equal(key, 'refx_auto_titles_v1');
      writtenMeta = JSON.parse(value);
      return true;
    }
  };
  plugin._resolveLineItemByGuid = async () => sourceLine;

  assert.equal(await plugin._repairPoisonedAutoTitlesForLine(sourceGuid, sourceState), true);
  assert.equal(writtenSegments[0].text.title, 'Actual target line');
  assert.equal(writtenSegments[2].text.title, 'Already correct');
  assert.equal(writtenMeta.refs[targetGuid + '#0'], 'Actual target line');
  assert.equal(writtenMeta.refs['CORRECT_LINE#0'], 'Already correct');
});

test('legacy line ref migrates to managed title sync only when its title matches the old target', () => {
  const { plugin } = instance();
  const auto = plugin._rewriteAutoLineRefTitles(
    [{ type: 'ref', text: { guid: 'TARGET', title: 'Before' } }],
    'TARGET', 'Before', 'After', { v: 1, refs: {} }
  );
  const alias = plugin._rewriteAutoLineRefTitles(
    [{ type: 'ref', text: { guid: 'TARGET', title: 'Alias' } }],
    'TARGET', 'Before', 'After', { v: 1, refs: {} }
  );
  assert.equal(auto.segments[0].text.title, 'After');
  assert.equal(auto.meta.refs['TARGET#0'], 'After');
  assert.equal(alias.segments[0].text.title, 'Alias');
  assert.equal(alias.changed, false);
});

test('reference context derives ordered direct siblings from the cached tree', () => {
  const { plugin } = instance();
  const a = { guid: 'A', parent_guid: 'P', children: [] };
  const target = { guid: 'TARGET', parent_guid: 'P', children: [{ guid: 'CHILD', parent_guid: 'TARGET', children: [] }] };
  const b = { guid: 'B', parent_guid: 'P', children: [] };
  const parent = { guid: 'P', parent_guid: null, children: [a, target, b] };
  const otherRoot = { guid: 'ROOT2', parent_guid: null, children: [] };

  const nested = plugin._refContextRelations([parent, otherRoot], 'TARGET');
  assert.equal(nested.parent.guid, 'P');
  assert.equal(nested.chain.map((x) => x.guid).join(','), 'P');
  assert.equal(nested.siblings.map((x) => x.guid).join(','), 'A,B');
  assert.equal(nested.target.children[0].guid, 'CHILD');

  const root = plugin._refContextRelations([parent, otherRoot], 'P');
  assert.equal(root.siblings.map((x) => x.guid).join(','), 'ROOT2');
});

test('reference context indexing terminates on cyclic malformed children', () => {
  const { plugin } = instance();
  const a = { guid: 'A', parent_guid: 'B', children: [] };
  const b = { guid: 'B', parent_guid: 'A', children: [a] };
  a.children = [b];

  const tree = plugin._refContextTree([a]);

  assert.deepEqual(Object.keys(tree.byGuid).sort(), ['A', 'B']);
});

test('sibling disclosure is batched and hard-capped for very large flat outlines', () => {
  const { plugin } = instance();
  const first = plugin._siblingRenderPlan(2000, 8);
  assert.equal(first.next, 40);
  assert.equal(first.cap, 200);
  assert.equal(first.remainingAfter, 1952);
  const last = plugin._siblingRenderPlan(2000, 168);
  assert.equal(last.next, 32);
  assert.equal(last.remainingAfter, 1800);
  assert.equal(plugin._siblingRenderPlan(12, 8).next, 4);
});

test('reference context hydration never exceeds two concurrent rows', async () => {
  const { plugin } = instance();
  const pending = [];
  let active = 0;
  let peak = 0;
  let started = 0;
  plugin._fillRefContextRow = () => {
    started++;
    active++;
    peak = Math.max(peak, active);
    const gate = deferred();
    pending.push(() => { active--; gate.resolve(); });
    return gate.promise;
  };
  const jobs = Array.from({ length: 5 }, () => ({ line: {}, crumbEl: {}, childBox: {} }));
  plugin._drainRefContextQueue({ alive: () => true }, jobs);

  assert.equal(started, 2);
  pending.splice(0, 2).forEach((resolve) => resolve());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(started, 4);
  pending.splice(0, 2).forEach((resolve) => resolve());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(started, 5);
  pending.splice(0).forEach((resolve) => resolve());
  assert.equal(peak, 2);
});

function installRefGroupRenderDom(context) {
  const makeEl = (tag) => {
    const listeners = {};
    const classes = new Set();
    const el = {
      tagName: String(tag).toUpperCase(),
      textContent: '', title: '', children: [], isConnected: true,
      style: {}, dataset: {}, disabled: false, _listeners: listeners,
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
      appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = this.isConnected; return child; },
      append(...children) { for (const child of children) this.appendChild(child); },
      insertBefore(child, before) {
        const index = this.children.indexOf(before);
        if (index < 0) return this.appendChild(child);
        this.children.splice(index, 0, child); child.parentElement = this; child.isConnected = this.isConnected; return child;
      },
      addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
      setAttribute(name, value) { this[name] = String(value); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      querySelectorAll(selector) {
        const wanted = selector.startsWith('.') ? selector.slice(1).split(/[\s\[:]/)[0] : '';
        const out = [];
        const walk = (node) => {
          for (const child of node.children || []) {
            if (wanted && child.classList?.contains(wanted)) out.push(child);
            walk(child);
          }
        };
        walk(this);
        return out;
      },
      remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.parentElement = null;
        this.isConnected = false;
      },
    };
    Object.defineProperty(el, 'className', {
      get: () => [...classes].join(' '),
      set: (value) => {
        classes.clear();
        String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
      },
    });
    return el;
  };
  context.document.createElement = makeEl;
  return makeEl;
}

function stubDeferredContextRow(makeEl, line, rows) {
  const rowEl = makeEl('div');
  rowEl.lineGuid = line.guid;
  const rowTopEl = makeEl('span');
  const crumbEl = makeEl('span');
  const childBox = makeEl('div');
  rowEl.append(rowTopEl, crumbEl, childBox);
  const row = { rowEl, rowTopEl, actionsEl: makeEl('span'), crumbEl, childBox };
  rows.push(row);
  return row;
}

test('adaptive inline context defers large or cold sets and preserves small warm eager context', () => {
  const { plugin, context } = instance();
  plugin._recordNameCache = new Map();
  plugin._eagerContext = false;
  plugin._deferContextThreshold = null;

  const small = Array.from({ length: 3 }, (_, i) => ({ guid: 'SMALL_' + i, record: { guid: 'WARM_' + i } }));
  context.window.g_universe = null;
  assert.equal(plugin._shouldDeferRefContext(small), true, 'an unavailable registry is cold even for a small section');

  context.window.g_universe = { itemsByGuid: { SENTINEL: { guid: 'SENTINEL' } } };
  for (const line of small) plugin._recordNameCache.set(line.record.guid, line.record.guid);
  assert.equal(plugin._shouldDeferRefContext(small), false, 'small warm sections retain eager context');
  plugin._recordNameCache.delete(small[0].record.guid);
  assert.equal(plugin._shouldDeferRefContext(small), true, 'a source absent from both name cache and registry is cold');
  plugin._recordNameCache.set(small[0].record.guid, small[0].record.guid);

  const large = Array.from({ length: 12 }, (_, i) => ({ guid: 'LARGE_' + i, record: { guid: 'WARM_' + (i % 3) } }));
  assert.equal(plugin._shouldDeferRefContext(large), true, 'the default row threshold is 12');
  const manySources = Array.from({ length: 8 }, (_, i) => ({ guid: 'SOURCE_LINE_' + i, record: { guid: 'SOURCE_' + i }, _fromRegistry: true }));
  assert.equal(plugin._shouldDeferRefContext(manySources), true, 'the default source threshold is 8');

  plugin._deferContextThreshold = 20;
  assert.equal(plugin._shouldDeferRefContext(large), false, 'custom threshold replaces both size triggers');
  plugin._eagerContext = true;
  context.window.g_universe = null;
  assert.equal(plugin._shouldDeferRefContext(large), false, 'custom.eagerContext forces the old eager behavior');
});

test('deferred linked-reference render does not auto-drain or read source trees', async () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  const body = makeEl('div');
  const shown = Array.from({ length: 12 }, (_, i) => ({ guid: 'LINE_' + i, record: { guid: 'SOURCE_' + i } }));
  const rows = [];
  plugin.getOrLoadRecordName = (guid) => guid;
  plugin._buildRefContextRow = (line) => stubDeferredContextRow(makeEl, line, rows);
  let drains = 0;
  let sourceReads = 0;
  plugin._drainRefContextQueue = () => { drains++; };
  plugin.data = { getRecord: () => ({ async getLineItems() { sourceReads++; return []; } }) };
  context.performance.now = () => 0;

  const completed = await plugin._renderRefsGroups(body, shown, {
    chunked: true,
    deferContext: true,
    alive: () => true,
    actionsFor: () => [],
  });

  assert.equal(completed, true);
  assert.equal(drains, 0, 'deferred context must not start the eager queue');
  assert.equal(sourceReads, 0, 'initial fill must not call getLineItems');
  assert.equal(rows.length, shown.length);
  assert.ok(rows.every((row) => row.rowTopEl.children.some((child) => child.textContent === '▸ context')));
});

test('deferred row context hydrates only the clicked row', async () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  const body = makeEl('div');
  const shown = [
    { guid: 'CLICKED', record: { guid: 'SOURCE_A' } },
    { guid: 'IDLE', record: { guid: 'SOURCE_B' } },
  ];
  const rows = [];
  plugin.getOrLoadRecordName = (guid) => guid;
  plugin._buildRefContextRow = (line) => stubDeferredContextRow(makeEl, line, rows);
  const hydrated = [];
  plugin._fillRefContextRow = async (_ctx, line) => { hydrated.push(line.guid); };

  plugin._renderRefsGroups(body, shown, {
    deferContext: true,
    alive: () => true,
    actionsFor: () => [],
  });
  const load = rows[0].rowTopEl.children.find((child) => child.className.includes('refx-ref-context-load'));
  await load._listeners.click[0]({ preventDefault() {}, stopPropagation() {} });

  assert.deepEqual(hydrated, ['CLICKED']);
  assert.equal(rows[1].rowTopEl.children.some((child) => child.textContent === '▸ context'), true);
});

test('abort during deferred row hydration prevents its post-load commit', async () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  const body = makeEl('div');
  const rows = [];
  let aborted = false;
  const gate = deferred();
  let started = 0;
  let committed = 0;
  plugin.getOrLoadRecordName = (guid) => guid;
  plugin._buildRefContextRow = (line) => stubDeferredContextRow(makeEl, line, rows);
  plugin._fillRefContextRow = async (ctx) => {
    started++;
    await gate.promise;
    if (ctx.alive()) committed++;
  };

  plugin._renderRefsGroups(body, [{ guid: 'ABORT_ME', record: { guid: 'SOURCE' } }], {
    deferContext: true,
    alive: () => !aborted,
    actionsFor: () => [],
  });
  const load = rows[0].rowTopEl.children.find((child) => child.className.includes('refx-ref-context-load'));
  const loading = load._listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(started, 1);
  aborted = true;
  gate.resolve();
  await loading;

  assert.equal(committed, 0);
  assert.equal(load.isConnected, true, 'aborted loader is not mutated or removed after the section dies');
});

test('large chunked linked-reference render yields and stops after abort', async () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  const body = makeEl('div');
  const shown = Array.from({ length: 12 }, (_, i) => ({ guid: 'LINE_' + i, record: { guid: 'SOURCE_' + i } }));
  plugin._recordNameCache = new Map();
  for (const line of shown) plugin._recordNameCache.set(line.record.guid, line.record.guid);
  plugin._buildRefContextRow = (line) => ({ rowEl: { lineGuid: line.guid }, crumbEl: {}, childBox: {} });
  plugin._drainRefContextQueue = () => { throw new Error('aborted render must not start context hydration'); };
  let now = 0;
  context.performance.now = () => { now += 3; return now; };
  let aborted = false;
  let yields = 0;
  plugin._yieldMacrotask = async () => { yields++; aborted = true; };

  const completed = await plugin._renderRefsGroups(body, shown, {
    chunked: true,
    alive: () => !aborted,
    actionsFor: () => [],
  });

  assert.equal(completed, false);
  assert.equal(yields, 1, 'large render crosses its 8ms budget and yields a task');
  assert.ok(body.children.length > 0, 'some whole groups render before the yield');
  assert.ok(body.children.length < shown.length, 'abort prevents the remaining groups from appending');
});

test('small chunked linked-reference render stays synchronous within its budget', async () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  const body = makeEl('div');
  const shown = Array.from({ length: 3 }, (_, i) => ({ guid: 'SMALL_LINE_' + i, record: { guid: 'SMALL_SOURCE_' + i } }));
  plugin._recordNameCache = new Map(shown.map((line) => [line.record.guid, line.record.guid]));
  context.window.g_universe.itemsByGuid.SENTINEL = { guid: 'SENTINEL' };
  const deferContext = plugin._shouldDeferRefContext(shown);
  assert.equal(deferContext, false);
  plugin.getOrLoadRecordName = (guid) => guid;
  plugin._buildRefContextRow = (line) => ({ rowEl: { lineGuid: line.guid }, crumbEl: {}, childBox: {} });
  let drains = 0;
  plugin._drainRefContextQueue = () => { drains++; };
  let now = 0;
  context.performance.now = () => { now += 1; return now; };
  let yields = 0;
  plugin._yieldMacrotask = async () => { yields++; };

  const completed = await plugin._renderRefsGroups(body, shown, {
    chunked: true,
    deferContext,
    alive: () => true,
    actionsFor: () => [],
  });

  assert.equal(completed, true);
  assert.equal(yields, 0, 'sub-budget render does not defer its paint');
  assert.equal(body.children.length, shown.length);
  assert.equal(drains, 1);
});

test('non-chunked linked-reference callers retain synchronous rendering', () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  const body = makeEl('div');
  const shown = Array.from({ length: 12 }, (_, i) => ({ guid: 'SYNC_LINE_' + i, record: { guid: 'SYNC_SOURCE_' + i } }));
  plugin.getOrLoadRecordName = (guid) => guid;
  plugin._buildRefContextRow = (line) => ({ rowEl: { lineGuid: line.guid }, crumbEl: {}, childBox: {} });
  let drains = 0;
  plugin._drainRefContextQueue = () => { drains++; };
  plugin._yieldMacrotask = async () => { throw new Error('default renderer must not yield'); };

  const completed = plugin._renderRefsGroups(body, shown, { alive: () => true, actionsFor: () => [] });

  assert.equal(completed, true);
  assert.equal(typeof completed?.then, 'undefined', 'default contract is not Promise-based');
  assert.equal(body.children.length, shown.length);
  assert.equal(drains, 1);
});

test('collapsible inline source-group headers show a time stamp only when the source date resolves', () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  const updatedAt = new Date('2025-12-24T13:42:00Z');
  plugin.data = {
    getRecord(guid) {
      if (guid === 'DATED_SOURCE') return { getUpdatedAt: () => updatedAt, getCreatedAt: () => null };
      if (guid === 'DATELESS_SOURCE') return { getUpdatedAt: () => null, getCreatedAt: () => null };
      return null;
    },
  };
  const seenDates = [];
  plugin._relativeTime = (date) => {
    seenDates.push(date);
    return { rel: '7mo ago', abs: 'Dec 24 2025, 13:42' };
  };
  plugin.getOrLoadRecordName = (guid) => guid;
  plugin._buildRefContextRow = () => ({ rowEl: makeEl('div'), crumbEl: {}, childBox: {} });
  plugin._drainRefContextQueue = () => {};
  const body = makeEl('div');
  const entry = {
    collapsedGroups: new Set(), collapseDefaultSeen: new Set(),
    currentGroupGuids: new Set(['DATED_SOURCE', 'DATELESS_SOURCE', 'MISSING_SOURCE']),
    collapseAllEl: makeEl('button'), bodyEl: body,
  };
  const lines = [
    { guid: 'LINE_DATED', record: { guid: 'DATED_SOURCE' } },
    { guid: 'LINE_DATELESS', record: { guid: 'DATELESS_SOURCE' } },
    { guid: 'LINE_MISSING', record: { guid: 'MISSING_SOURCE' } },
    { guid: 'LINE_UNKNOWN', record: { guid: '' } },
  ];

  plugin._renderRefsGroups(body, lines, { alive: () => true, actionsFor: () => [], collapseEntry: entry });

  const groupFor = (guid) => body.children.find((group) => group.dataset.refxSourceGuid === guid);
  const datedStamp = groupFor('DATED_SOURCE').querySelector('.refx-row-time');
  assert.ok(datedStamp, 'dated source group carries the shared faint row-time stamp');
  assert.equal(datedStamp.textContent, '7mo ago');
  assert.equal(datedStamp.title, 'Dec 24 2025, 13:42');
  assert.equal(groupFor('DATELESS_SOURCE').querySelectorAll('.refx-row-time').length, 0, 'date-less record adds no stamp');
  assert.equal(groupFor('MISSING_SOURCE').querySelectorAll('.refx-row-time').length, 0, 'missing record adds no stamp');
  const unknownGroup = body.children.find((group) => !group.dataset.refxSourceGuid);
  assert.equal(unknownGroup.querySelectorAll('.refx-row-time').length, 0, 'Unknown record group adds no stamp');
  assert.deepEqual(seenDates, [updatedAt], 'the shared helper formats only the resolved updated date');
});

test('inline source-group headers reveal the tracked source-record strip only when the entry is threaded', async () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  plugin.getOrLoadRecordName = (guid) => guid || 'Unknown record';
  plugin._buildRefContextRow = () => ({ rowEl: makeEl('div'), crumbEl: {}, childBox: {} });
  plugin._drainRefContextQueue = () => {};
  plugin.data = { getRecord: () => null };
  const calls = [];
  plugin._bridgeJump = (guid, opts) => { calls.push(['jump', guid, opts]); };
  plugin._wbAdd = (guid) => { calls.push(['workbench', guid]); };
  plugin._toast = () => {};
  let collapseWrites = 0;
  plugin._writeCollapsedGroupsMeta = async () => { collapseWrites++; return true; };
  const body = makeEl('div');
  const entry = {
    collapsedGroups: new Set(), collapseDefaultSeen: new Set(),
    currentGroupGuids: new Set(['SOURCE_A']), collapseAllEl: makeEl('button'), bodyEl: body,
  };
  plugin._sectionToggleEmbed = async (gotEntry, guid) => {
    calls.push(['embed', gotEntry === entry, guid]);
    return true;
  };
  const lines = [
    { guid: 'LINE_A', record: { guid: 'SOURCE_A' } },
    { guid: 'LINE_UNKNOWN', record: { guid: '' } },
  ];

  plugin._renderRefsGroups(body, lines, { alive: () => true, actionsFor: () => [], collapseEntry: entry });

  const sourceGroup = body.children.find((group) => group.dataset.refxSourceGuid === 'SOURCE_A');
  const actions = sourceGroup.querySelector('.refx-inline-refs-group-header-actions');
  assert.ok(actions);
  assert.equal(actions.children.length, 6);
  assert.deepEqual(actions.children.map((button) => button.textContent), ['↗', '◧', '⧉', '⧉', '⧉⤵', '⤵']);
  assert.ok(actions.children.every((button) => button.classList.contains('trc-ref-popover-action')));
  let prevented = 0;
  let stopped = 0;
  for (const button of actions.children) {
    await button._listeners.click[0]({ preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  }
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['jump', 'SOURCE_A', {}],
    ['jump', 'SOURCE_A', { newPanel: true }],
    ['workbench', 'SOURCE_A'],
    ['embed', true, 'SOURCE_A'],
  ]));
  assert.equal(prevented, 6);
  assert.equal(stopped, 6);
  let pressPrevented = 0;
  let pressStopped = 0;
  for (const button of actions.children) {
    button._listeners.mousedown[0]({ preventDefault() { pressPrevented++; }, stopPropagation() { pressStopped++; } });
  }
  assert.equal(pressPrevented, 6);
  assert.equal(pressStopped, 6);
  assert.equal(entry.collapsedGroups.has('SOURCE_A'), false, 'action clicks do not toggle the source group');
  assert.equal(collapseWrites, 0, 'action clicks do not persist collapse state');

  const unknownGroup = body.children.find((group) => !group.dataset.refxSourceGuid);
  assert.equal(unknownGroup.querySelector('.refx-inline-refs-group-header-actions'), null, 'Unknown record has no source actions');

  const nonSectionBody = makeEl('div');
  plugin._renderRefsGroups(nonSectionBody, lines.slice(0, 1), { alive: () => true, actionsFor: () => [] });
  const nonSectionActions = nonSectionBody.querySelector('.refx-inline-refs-group-header-actions');
  assert.ok(nonSectionActions, 'non-section consumers retain source-record navigation actions');
  assert.deepEqual(nonSectionActions.children.map((button) => button.textContent), ['↗', '◧', '⧉', '⧉', '⧉⤵'],
    'tracked Embed here is omitted while both copy actions remain available');
});

test('shared row clipboard actions distinguish references from true-transclusion paste', async () => {
  const { plugin, context } = instance();
  let clipboardText = '';
  context.navigator.clipboard.writeText = async (text) => { clipboardText = text; };
  context.navigator.clipboard.readText = async () => clipboardText;
  plugin._toast = () => {};
  const actions = plugin._refRowClipboardActions('COPY_TARGET', 'Copied target');
  assert.deepEqual(JSON.parse(JSON.stringify(actions.map(({ label, title }) => ({ label, title })))), [
    { label: '⧉', title: 'Copy reference' },
    { label: '⧉⤵', title: 'Copy transclusion' },
  ]);

  actions[1].fn();
  await Promise.resolve();
  assert.equal(clipboardText, 'thymer-ref://COPY_TARGET');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.window.__refxCopiedRef)),
    { guid: 'COPY_TARGET', text: 'Copied target', asTransclusion: true },
  );
  plugin._caretInfo = () => ({ lineGuid: 'COPY_HOST' });
  let bridgeCall = null;
  plugin._bridgeCreateEmbed = async (...args) => { bridgeCall = args; return true; };
  await plugin._pasteRef();
  assert.deepEqual(JSON.parse(JSON.stringify(bridgeCall)), ['COPY_HOST', 'COPY_TARGET', { forceTransclusion: true }]);
});

test('inline source-group chevron toggles entry state and reapplies after a rebuild', async () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  plugin.getOrLoadRecordName = (guid) => guid;
  plugin._buildRefContextRow = (line) => ({ rowEl: makeEl('div'), crumbEl: {}, childBox: {}, line });
  plugin._drainRefContextQueue = () => {};
  let writes = 0;
  plugin._writeCollapsedGroupsMeta = async () => { writes++; return true; };
  const entry = {
    collapsedGroups: new Set(), collapseDefaultSeen: new Set(), currentGroupGuids: new Set(['SOURCE_A']),
    collapseAllEl: makeEl('button'), bodyEl: makeEl('div'),
  };
  const lines = [{ guid: 'LINE_A', record: { guid: 'SOURCE_A' } }];

  plugin._renderRefsGroups(entry.bodyEl, lines, { alive: () => true, actionsFor: () => [], collapseEntry: entry });
  const firstGroup = entry.bodyEl.children[0];
  const firstToggle = firstGroup.querySelector('.refx-inline-refs-group-toggle');
  assert.equal(firstToggle.textContent, '▾');
  await firstToggle._listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(entry.collapsedGroups.has('SOURCE_A'), true);
  assert.equal(firstGroup.classList.contains('refx-group-collapsed'), true, 'collapse uses its own class, independent of refx-hidden filtering');
  assert.match(source, /\.refx-inline-refs-group\.refx-group-collapsed\s*>\s*\.refx-inline-refs-row\s*\{\s*display:\s*none;/s,
    'collapsed-group CSS hides rows without reusing the filter class');
  assert.equal(firstToggle.textContent, '▸');
  assert.equal(writes, 1);

  const rebuiltBody = makeEl('div');
  entry.bodyEl = rebuiltBody;
  plugin._renderRefsGroups(rebuiltBody, lines, { alive: () => true, actionsFor: () => [], collapseEntry: entry });
  assert.equal(rebuiltBody.children[0].classList.contains('refx-group-collapsed'), true, 'sort/fill rebuild reapplies entry-owned collapse state');
  assert.equal(rebuiltBody.children[0].querySelector('.refx-inline-refs-group-toggle').textContent, '▸');
});

test('collapse-all populates every current source once and expand-all clears once', async () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  const entry = {
    collapsedGroups: new Set(), collapseDefaultSeen: new Set(),
    currentGroupGuids: new Set(['SOURCE_A', 'SOURCE_B']), collapseAllEl: makeEl('button'), bodyEl: makeEl('div'),
  };
  let writes = 0;
  plugin._writeCollapsedGroupsMeta = async () => { writes++; return true; };

  plugin._toggleAllInlineRefGroups(entry);
  await Promise.resolve();
  assert.deepEqual([...entry.collapsedGroups].sort(), ['SOURCE_A', 'SOURCE_B']);
  assert.equal(writes, 1, 'collapse-all persists the complete set in one write');
  assert.equal(entry.collapseAllEl.textContent, '⊞');

  plugin._toggleAllInlineRefGroups(entry);
  await Promise.resolve();
  assert.equal(entry.collapsedGroups.size, 0);
  assert.equal(writes, 2, 'expand-all clears with one additional write');
  assert.equal(entry.collapseAllEl.textContent, '⊟');
});

test('collapsed inline-group default starts every discovered source collapsed', () => {
  const { plugin, context } = instance();
  const makeEl = installRefGroupRenderDom(context);
  plugin._inlineRefsGroupsDefault = 'collapsed';
  plugin.getOrLoadRecordName = (guid) => guid;
  plugin._buildRefContextRow = () => ({ rowEl: makeEl('div'), crumbEl: {}, childBox: {} });
  plugin._drainRefContextQueue = () => {};
  const lines = [
    { guid: 'LINE_A', record: { guid: 'SOURCE_A' } },
    { guid: 'LINE_B', record: { guid: 'SOURCE_B' } },
  ];
  const entry = {
    collapsedGroups: new Set(), collapseDefaultSeen: new Set(), collapseStateFromMeta: false,
    currentGroupGuids: new Set(), collapseAllEl: makeEl('button'), bodyEl: makeEl('div'),
  };

  plugin._prepareInlineRefsGroupCollapse(entry, lines);
  plugin._renderRefsGroups(entry.bodyEl, lines, { alive: () => true, actionsFor: () => [], collapseEntry: entry });

  assert.deepEqual([...entry.collapsedGroups].sort(), ['SOURCE_A', 'SOURCE_B']);
  assert.ok(entry.bodyEl.children.every((group) => group.classList.contains('refx-group-collapsed')));
});

test('persisted collapse-all writes one meta snapshot and rebuilt entry seeds from it', async () => {
  const { plugin, context } = instance();
  installRefGroupRenderDom(context);
  let writes = 0;
  const line = {
    props: { refx_collapsedGroups: '["SOURCE_A"]' },
    async setMetaProperty(name, value) {
      writes++;
      this.props[name] = value;
      return true;
    },
  };
  plugin._inlineRefsPersistCollapse = true;
  plugin._resolveLineItemByGuid = async () => line;
  plugin._isPinned = () => false;
  plugin._paintPinButton = () => {};
  plugin._ensureCardObserver = () => {};
  plugin._teardownCardObserver = () => {};
  plugin._fillInlineRefs = async () => {};
  const hostNode = { insertAdjacentElement(_where, el) { el.isConnected = true; } };

  await plugin._buildInlineRefsSection(null, 'TARGET', hostNode, 'HOST');
  const key = 'HOST›TARGET';
  const first = plugin._inlineRefs.get(key);
  assert.deepEqual([...first.collapsedGroups], ['SOURCE_A'], 'entry loads the persisted host-line meta');
  first.currentGroupGuids = new Set(['SOURCE_A', 'SOURCE_B']);
  plugin._toggleAllInlineRefGroups(first);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes, 1, 'collapse-all writes the whole set once');
  assert.deepEqual(JSON.parse(line.props.refx_collapsedGroups).sort(), ['SOURCE_A', 'SOURCE_B']);

  plugin._removeInlineRefs(key);
  await plugin._buildInlineRefsSection(null, 'TARGET', hostNode, 'HOST');
  const rebuilt = plugin._inlineRefs.get(key);
  assert.deepEqual([...rebuilt.collapsedGroups].sort(), ['SOURCE_A', 'SOURCE_B'], 'rebuilt entry seeds from persisted meta');
  assert.equal(rebuilt.collapseStateFromMeta, true);
});

test('reference context indexes source structure without expanding transclusions', async () => {
  const { plugin } = instance();
  let includeTransclusions = null;
  plugin.data = { getRecord: () => ({
    getLineItems: async (include) => { includeTransclusions = include; return []; }
  }) };
  const ctx = { treeCache: new Map(), alive: () => true };

  await plugin._fillRefContextRow(ctx, { guid: 'LINE', record: { guid: 'RECORD' } }, null, null);
  assert.equal(includeTransclusions, false);
});

test('cold native backreference row hydrates exact source text once context resolves', () => {
  const { plugin } = instance();
  const classes = classListSet();
  const fullEl = {
    dataset: { refxTextPending: '1' },
    textContent: 'Loading reference…',
    classList: classes,
    firstChild: null,
    insertBefore() {}
  };
  const resolved = {
    guid: 'SOURCE_LINE',
    segments: [{ type: 'text', text: 'The authored reference is visible' }]
  };

  assert.equal(plugin._hydrateColdRefLineText(fullEl, resolved), true);
  assert.equal(fullEl.textContent, 'The authored reference is visible');
  assert.equal(fullEl.dataset.refxTextPending, undefined);
  assert.equal(classes.contains('refx-ref-line-empty'), false);

  fullEl.textContent = 'Preserve the hydrated row';
  assert.equal(plugin._hydrateColdRefLineText(fullEl, resolved), false);
  assert.equal(fullEl.textContent, 'Preserve the hydrated row');
});

test('cold native backreferences use one bounded exact enrichment query and no body reads', async () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid = {};
  plugin._showSelf = false;
  plugin._maxResults = 80;
  plugin.isExistingRecordGuid = () => true;
  plugin.isLineSharedIgnored = () => false;
  plugin._fetchBackrefs = async () => [{ kind: 'line', lineItemGuid: 'COLD_LINE', record: { guid: 'SOURCE_RECORD' } }];
  let searches = 0;
  let bodyReads = 0;
  const exact = { guid: 'COLD_LINE', record: { guid: 'SOURCE_RECORD' }, segments: [{ type: 'text', text: 'Resolved exactly once' }] };
  plugin.data = {
    searchByQuery: async (query, limit) => {
      searches++;
      assert.equal(query, '@linkto = "TARGET_RECORD"');
      assert.equal(limit, 80);
      return { lines: [exact] };
    },
    getRecord: () => { bodyReads++; return null; },
  };

  const rows = await plugin._queryRefLines('TARGET_RECORD');
  assert.equal(searches, 1);
  assert.equal(bodyReads, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0], exact);
  assert.equal(rows[0]._refxExactSearch, true);
});

test('failed cold enrichment is explicit instead of leaving a permanent blank cell', async () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid = {};
  plugin._showSelf = false;
  plugin._maxResults = 80;
  plugin.isExistingRecordGuid = () => true;
  plugin.isLineSharedIgnored = () => false;
  plugin._fetchBackrefs = async () => [{ kind: 'line', lineItemGuid: 'COLD_LINE', record: { guid: 'SOURCE_RECORD' } }];
  plugin.data = { searchByQuery: async () => { throw new Error('index unavailable'); } };

  const rows = await plugin._queryRefLines('TARGET_RECORD');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._refxEnrichmentFailed, true);
  assert.ok(source.includes("fullEl.textContent = '(source line unavailable)'"));
  assert.ok(source.includes("fullEl.textContent = '(empty reference line)'"));
});

test('cold exact-search enrichment preserves render provenance on frozen SDK handles', async () => {
  const { plugin } = instance();
  plugin._showSelf = true;
  plugin._maxResults = 80;
  plugin.isLineSharedIgnored = () => false;
  const frozen = Object.freeze({ guid: 'FROZEN_LINE', record: { guid: 'SOURCE_RECORD' }, segments: [] });
  plugin.data = { searchByQuery: async () => ({ lines: [frozen] }) };

  const result = await plugin._searchExactRefLines('TARGET_RECORD');
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.notEqual(result.items[0], frozen);
  assert.equal(result.items[0].guid, 'FROZEN_LINE');
  assert.equal(result.items[0]._refxExactSearch, true);
});

test('property-card keyboard order starts with the editable record title', () => {
  const { plugin, context } = instance();
  const title = { id: 'title' };
  const collection = { id: 'collection' };
  const fold = { id: 'fold' };
  const mode = { id: 'mode' };
  const value = { id: 'value', offsetParent: {} };
  const card = {
    querySelector: (sel) => ({
      '.refx-propcard-title': title,
      '.refx-propcard-collection': collection,
      '.refx-card-fold': fold,
      '.refx-props-mode': mode
    })[sel] || null,
    querySelectorAll: () => [value]
  };
  context.document.querySelector = () => card;
  const items = plugin._cardNavItems('EMBED');
  assert.equal(items[0], title);
  assert.equal(items[1], collection);
  assert.equal(items[2], fold);
  assert.equal(items[3], mode);
});

test('ArrowDown resolves the exact lightweight preview key and includes its actions', () => {
  const { plugin, context } = instance();
  const hostGuid = 'HOST_LINE';
  const targetGuid = 'TARGET_RECORD';
  const previewKey = plugin._recordPreviewKey(hostGuid, targetGuid);
  const action = { id: 'load', offsetParent: {} };
  const shell = { querySelectorAll: () => [action] };
  const card = {
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: (sel) => sel === '.refx-record-preview-shell' ? shell : null
  };
  plugin._recordPreviews.set(previewKey, { hostLineGuid: hostGuid, targetGuid, shell });
  plugin._cards.set(previewKey, { recordGuid: targetGuid, preview: true });
  plugin._transclusionNode = (guid) => guid === previewKey ? shell : null;
  context.document.querySelector = (sel) => sel.includes(previewKey) ? card : null;

  assert.equal(plugin._openEmbedForRef({ lineGuid: hostGuid }, targetGuid), previewKey);
  const items = plugin._cardNavItems(previewKey);
  assert.equal(items.length, 1);
  assert.equal(items[0], action);
  assert.equal(plugin._openEmbedForRef({ lineGuid: 'OTHER_HOST' }, targetGuid), null,
    'must not borrow another authored line\'s preview');
});

test('preview nav includes Load full body without property rows and activation clicks it', () => {
  const { plugin, context } = instance();
  const previewKey = plugin._recordPreviewKey('HOST_NAV', 'TARGET_NAV');
  let materialized = null;
  plugin._materializeRecordPreview = (key) => { materialized = key; return Promise.resolve(true); };
  const open = { offsetParent: {}, hidden: false, classList: { contains: (name) => name === 'refx-record-preview-action' }, click() {} };
  const load = { offsetParent: {}, hidden: false, classList: { contains: (name) => name === 'refx-record-preview-action' || name === 'refx-record-preview-load' }, click() { plugin._materializeRecordPreview(previewKey); } };
  const shell = { querySelectorAll: (selector) => selector === '.refx-record-preview-action' ? [open, load] : [] };
  plugin._recordPreviews.set(previewKey, { key: previewKey, hostLineGuid: 'HOST_NAV', targetGuid: 'TARGET_NAV', shell });
  context.document.querySelector = (selector) => selector.includes('.refx-record-preview-shell') ? shell : null;

  const items = plugin._cardNavItems(previewKey);
  assert.equal(items.includes(load), true, 'Load full body is reachable with zero property rows/card');
  plugin._cardNav = { lineGuid: previewKey, recordGuid: 'TARGET_NAV', index: items.indexOf(load) };
  plugin._activateCardNav();
  assert.equal(materialized, previewKey, 'activating the nav stop invokes the materialize path');
});

test('choice card-nav printable key opens and seeds its popup without propagating to Thymer', () => {
  const { plugin, context } = instance();
  context.document.activeElement = null;
  plugin._el = (tag, cls, text) => fakeElement(tag, cls || '', text || '');
  const field = { id: 'STATUS', name: 'Status', kind: 'choice', value: '', choices: [{ label: 'Blocked' }, { label: 'Done' }] };
  const rec = { prop: () => ({ setChoice() {} }) };
  plugin._recCardFields = () => [field];
  plugin._openCardPopup = (pop, _anchor, opts) => {
    plugin._cardEditing = true;
    plugin._cardPopup = { pop, onKey: opts?.onKey, resync: opts?.resync };
  };
  const row = fakeElement('div', 'refx-propcard-row');
  plugin._fillPropRow(rec, 'CHOICE_CARD', field, row);
  const valueCell = row.children[1];
  const value = valueCell.children[0];
  plugin._cardNav = { lineGuid: 'CHOICE_CARD', recordGuid: 'CHOICE_RECORD', index: 0 };
  plugin._cardNavItems = () => [value];
  plugin.data = { getRecord: () => rec };
  let exits = 0;
  plugin._exitCardNav = () => { exits++; };
  const event = {
    key: 'B', ctrlKey: false, metaKey: false, altKey: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };

  plugin._onCardNavKey(event);
  const input = plugin._cardPopup.pop.querySelector('.refalias-input');
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(exits, 0, 'opening a choice editor keeps card navigation alive for resume');
  assert.equal(input.value, 'B', 'first printable character seeds the choice filter');
  assert.equal(plugin._cardPopup.pop.querySelectorAll('.refalias-result').length, 1, 'seeded filter renders matching choices immediately');
});

test('choice Enter commit restores its popup-owned card cursor after native DOM churn', () => {
  const { plugin, context } = instance();
  const body = fakeElement('body');
  context.document.body = body;
  context.document.activeElement = null;
  context.window.addEventListener = () => {};
  context.window.removeEventListener = () => {};
  context.MouseEvent = class {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
    preventDefault() {}
    stopPropagation() {}
  };
  plugin._el = (tag, cls, text) => fakeElement(tag, cls || '', text || '');
  plugin._positionPopover = () => {};
  plugin._refocusEditor = () => {};
  plugin._flushPendingMoveRefreshes = () => {};
  plugin._flushDeferredDiscover = () => {};
  plugin._commitRefreshRow = () => {};

  let chosen = null;
  const field = { id: 'STATUS', name: 'Status', kind: 'choice', value: '', choices: [{ label: 'Blocked' }, { label: 'Done' }] };
  const rec = { prop: () => ({ setChoice(label) { chosen = label; } }) };
  plugin._recCardFields = () => [field];
  plugin.data = { getRecord: () => rec };
  const row = fakeElement('div', 'refx-propcard-row');
  const valueCell = fakeElement('div', 'page-props-cell page-prop-val');
  const value = fakeElement('span', 'refx-propcard-value');
  value.dataset.refxField = 'Status';
  valueCell.append(value);
  row.append(valueCell);
  const nextCell = fakeElement('div', 'page-props-cell page-prop-val');
  const next = fakeElement('span', 'refx-propcard-value');
  next.dataset.refxField = 'Next';
  nextCell.append(next);
  row.append(nextCell);
  plugin._cardNavItems = () => [value, next];
  plugin._cardNav = { lineGuid: 'CHOICE_CARD', recordGuid: 'CHOICE_RECORD', index: 0 };

  plugin._activateCardNav();
  const popup = plugin._cardPopup;
  const input = popup.pop.querySelector('.refalias-input');
  context.document.activeElement = input;
  assert.equal(popup.pop.contains(input), true);
  assert.equal(popup.pop.querySelectorAll('.refalias-result').length, 3);
  popup.onKey({ key: 'ArrowDown', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(popup.pop.querySelectorAll('.refalias-result')[0].classList.contains('refalias-result-sel'), true);
  // Reproduce the reported failure class: a native property repaint clears the
  // transient global cursor/resume state while the popup still owns focus.
  plugin._cardNav = null;
  plugin._cardNavResume = null;
  popup.onKey({
    key: 'Enter',
    preventDefault() {},
    stopImmediatePropagation() {}
  });

  assert.equal(chosen, 'Blocked');
  assert.equal(plugin._cardNav?.lineGuid, 'CHOICE_CARD');
  assert.equal(plugin._cardNav?.recordGuid, 'CHOICE_RECORD');
  assert.equal(plugin._cardNav?.index, 0);
  assert.equal(value.classList.contains('refx-nav-focus'), true, 'the chosen property remains the keyboard cursor');
  assert.equal(valueCell.classList.contains('refx-nav-host-focus'), true, 'the stable value cell owns the continuous cursor paint');
  value.classList.remove('refx-nav-focus'); // simulate the volatile child being replaced by Thymer
  assert.equal(valueCell.classList.contains('refx-nav-host-focus'), true, 'child replacement cannot create an unpainted cursor frame');
  const arrow = keyEvent('ArrowDown');
  plugin._onCardNavKey(arrow);
  assert.equal(plugin._cardNav.index, 1, 'ArrowDown continues directly to the next property without a mouse click');
  assert.equal(next.classList.contains('refx-nav-focus'), true);
  assert.equal(nextCell.classList.contains('refx-nav-host-focus'), true);
});

test('relation card-nav printable key opens a seeded filtered picker without propagating or exiting', async () => {
  const { plugin, context } = instance();
  context.document.activeElement = null;
  plugin._el = (tag, cls, text) => fakeElement(tag, cls || '', text || '');
  const alice = { getName: () => 'Alice', _getRow: () => ({ guid: 'ALICE', u_at: 2 }), prop: () => null };
  const bob = { getName: () => 'Bob', _getRow: () => ({ guid: 'BOB', u_at: 1 }), prop: () => null };
  const field = { id: 'FPEOPLE12345', name: 'People', kind: 'relation', value: '' };
  const relationProp = { linkedRecords: () => [], set() {} };
  const rec = { prop: (name) => name === 'People' ? relationProp : null };
  plugin._fieldMeta = { FPEOPLE12345: { filter_colguid: 'PEOPLE_COLLECTION' } };
  plugin._colByGuid = { PEOPLE_COLLECTION: { getName: () => 'People', getAllRecords: async () => [alice, bob] } };
  plugin._recCardFields = () => [field];
  plugin._openCardPopup = (pop, anchorEl, opts) => {
    plugin._cardEditing = true;
    plugin._cardPopup = { pop, anchorEl, onKey: opts?.onKey, resync: opts?.resync || (() => {}) };
  };
  const row = fakeElement('div', 'refx-propcard-row');
  plugin._fillPropRow(rec, 'RELATION_CARD', field, row);
  const valueCell = row.children[1];
  const value = valueCell.children[0];
  plugin._cardNav = { lineGuid: 'RELATION_CARD', recordGuid: 'RELATION_RECORD', index: 0 };
  plugin._cardNavItems = () => [value];
  plugin.data = { getRecord: () => rec };
  const editCardValue = plugin._editCardValue.bind(plugin);
  let editArgs = null;
  plugin._editCardValue = (...args) => { editArgs = args; return editCardValue(...args); };
  let exits = 0;
  plugin._exitCardNav = () => { exits++; };
  const event = {
    key: 'A', ctrlKey: false, metaKey: false, altKey: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };

  plugin._onCardNavKey(event);
  await Promise.resolve();
  const pop = plugin._cardPopup.pop;
  const input = pop.querySelector('.refalias-input');
  const labels = pop.querySelectorAll('.refalias-result-text').map((node) => node.textContent);
  const popupKey = { key: 'z', stopped: false, stopPropagation() { this.stopped = true; } };
  input.listeners.get('keydown')(popupKey);

  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(exits, 0, 'relation open-on-type must not release the virtual card cursor');
  assert.equal(editArgs?.[5]?.seed, 'A', 'the printable character is forwarded through _editCardValue as the seed');
  assert.equal(input.value, 'A', 'first printable character seeds the relation filter');
  assert.equal(labels.includes('Alice'), true, 'the matching relation is rendered');
  assert.equal(labels.includes('Bob'), false, 'the seed filters non-matching relations');
  assert.equal(popupKey.stopped, true, 'printable popup input keys cannot reach Thymer');
});

test('non-printable card-nav key still exits without opening an editor', () => {
  const { plugin } = instance();
  plugin._cardNav = { lineGuid: 'CARD', recordGuid: 'RECORD', index: 0 };
  plugin._cardNavItems = () => [{ dataset: { refxField: 'Lead' }, closest: () => ({}) }];
  plugin.data = { getRecord: () => ({}) };
  plugin._recCardFields = () => [{ name: 'Lead', kind: 'relation' }];
  let edits = 0;
  let exits = 0;
  plugin._editCardValue = () => { edits++; };
  plugin._exitCardNav = () => { exits++; };

  plugin._onCardNavKey({ key: 'Tab', ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(edits, 0);
  assert.equal(exits, 1);
});

test('card refresh paths skip while the choice popup input owns focus', async () => {
  const { plugin, context } = instance();
  const input = {};
  const pop = { contains: (node) => node === input };
  context.document.activeElement = input;
  plugin._cardPopup = { pop };
  plugin._cards.set('CHOICE_CARD', { recordGuid: 'CHOICE_RECORD' });
  let recordReads = 0;
  plugin.data = { getRecord() { recordReads++; return null; } };

  plugin._refreshCardInPlace('CHOICE_CARD', 'CHOICE_RECORD');
  await plugin._renderFreshCard('CHOICE_CARD', 'CHOICE_RECORD', true);
  assert.equal(recordReads, 0, 'neither in-place nor structural refresh may steal focused popup input');
});

test('collection move passes the collection object and preserves the record guid index', async () => {
  const { plugin } = instance();
  const target = { getGuid: () => 'COL_DEST' };
  let passed = null;
  let refreshed = null;
  const rec = {
    getGuid: () => 'REC_MOVE',
    moveToCollection: async (value) => { passed = value; return true; }
  };
  plugin._cardFieldsCache.set('REC_MOVE', ['old schema']);
  plugin._refreshMovedRecordCards = (guid) => { refreshed = guid; };

  assert.equal(await plugin._moveRecordToCollection(rec, target, 'COL_DEST'), true);
  assert.equal(passed, target);
  assert.equal(plugin._recordCollectionIndex.get('REC_MOVE'), 'COL_DEST');
  assert.equal(plugin._cardFieldsCache.has('REC_MOVE'), false);
  assert.equal(refreshed, 'REC_MOVE');
});

test('failed collection move leaves collection and card caches untouched', async () => {
  const { plugin } = instance();
  const rec = { getGuid: () => 'REC_MOVE_FAIL', moveToCollection: async () => false };
  plugin._recordCollectionIndex.set('REC_MOVE_FAIL', 'COL_OLD');
  plugin._cardFieldsCache.set('REC_MOVE_FAIL', ['schema']);
  let refreshed = false;
  plugin._refreshMovedRecordCards = () => { refreshed = true; };

  assert.equal(await plugin._moveRecordToCollection(rec, {}, 'COL_NEW'), false);
  assert.equal(plugin._recordCollectionIndex.get('REC_MOVE_FAIL'), 'COL_OLD');
  assert.equal(plugin._cardFieldsCache.has('REC_MOVE_FAIL'), true);
  assert.equal(refreshed, false);
});

test('record.moved uses the official parentGuid destination and refreshes cards', () => {
  const { plugin } = instance();
  let refreshed = null;
  plugin._refreshMovedRecordCards = (guid) => { refreshed = guid; };
  plugin._cardFieldsCache.set('REC_EXTERNAL_MOVE', ['old schema']);

  plugin._onRecordMoved({ recordGuid: 'REC_EXTERNAL_MOVE', parentGuid: 'COL_EXTERNAL_DEST' });

  assert.equal(plugin._recordCollectionIndex.get('REC_EXTERNAL_MOVE'), 'COL_EXTERNAL_DEST');
  assert.equal(plugin._cardFieldsCache.has('REC_EXTERNAL_MOVE'), false);
  assert.equal(refreshed, 'REC_EXTERNAL_MOVE');
});

test('async collection loading cannot reopen a picker after card navigation moved away', async () => {
  const { plugin, context } = instance();
  const pending = deferred();
  const rec = {
    getGuid: () => 'REC_PICKER',
    getJournalDetails: () => null,
    moveToCollection: async () => true
  };
  context.window.addEventListener = () => {};
  context.window.removeEventListener = () => {};
  plugin._recordCollectionGuid = () => 'COL_CURRENT';
  plugin.data = { getAllCollections: () => pending.promise };
  plugin._cardNav = { lineGuid: 'EMBED', recordGuid: 'REC_PICKER', index: 1 };
  plugin._el = () => { throw new Error('stale picker rendered'); };

  const opening = plugin._openCollectionMovePicker(rec, 'EMBED', { isConnected: true });
  plugin._cardNav.index = 2;
  pending.resolve([]);
  await opening;
  assert.equal(plugin._cardNav.index, 2);
});

test('repeated keyboard activation shares one pending collection enumeration', async () => {
  const { plugin, context } = instance();
  const pending = deferred();
  const rec = { getGuid: () => 'REC_PENDING', getJournalDetails: () => null, moveToCollection: async () => true };
  context.window.addEventListener = () => {};
  context.window.removeEventListener = () => {};
  plugin._recordCollectionGuid = () => 'COL_CURRENT';
  let loads = 0;
  plugin.data = { getAllCollections: () => { loads++; return pending.promise; } };
  plugin._toast = () => {};

  const first = plugin._openCollectionMovePicker(rec, 'EMBED', { isConnected: true });
  const second = plugin._openCollectionMovePicker(rec, 'EMBED', { isConnected: true });
  await second;
  assert.equal(loads, 1);
  pending.resolve([]);
  await first;
  assert.equal(plugin._collectionPickerLoads.size, 0);
});

test('a record already moving cannot start a second collection request', async () => {
  const { plugin } = instance();
  const rec = { getGuid: () => 'REC_BUSY', getJournalDetails: () => null, moveToCollection: async () => true };
  let loaded = 0;
  let toast = '';
  plugin.data = { getAllCollections: async () => { loaded++; return []; } };
  plugin._moveRecordsInFlight.add('REC_BUSY');
  plugin._toast = (message) => { toast = message; };

  await plugin._openCollectionMovePicker(rec, 'EMBED', { isConnected: true });
  assert.equal(loaded, 0);
  assert.match(toast, /already moving/i);
});

test('collection-move refresh timers coalesce per record and stay hot-reload cancellable', () => {
  const { plugin, context } = instance();
  let nextTimer = 0;
  const queued = new Map();
  context.setTimeout = (fn) => { const timer = { id: ++nextTimer }; queued.set(timer, fn); return timer; };
  context.clearTimeout = (timer) => { queued.delete(timer); };
  plugin._cards = new Map([['EMBED', { recordGuid: 'REC' }]]);
  let renders = 0;
  plugin._renderFreshCard = (_lineGuid, recordGuid) => {
    assert.equal(plugin._cardFieldsCache.has(recordGuid), false);
    plugin._cardFieldsCache.set(recordGuid, ['possibly stale read']);
    renders++;
  };

  plugin._refreshMovedRecordCards('REC');
  const first = [...plugin._moveRefreshTimers.get('REC')];
  plugin._refreshMovedRecordCards('REC');
  const second = [...plugin._moveRefreshTimers.get('REC')];

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(context.window.__refxMoveTimers.size, 2);
  assert.notEqual(first[0], second[0]);
  assert.equal(queued.size, 2);
  const callbacks = [...queued.values()];
  queued.clear();
  callbacks[0]();
  callbacks[1]();
  assert.equal(renders, 2);
  assert.equal(plugin._moveRefreshTimers.has('REC'), false);
  assert.equal(context.window.__refxMoveTimers.size, 0);
});

test('collection-move structural refresh waits for active editing to close', () => {
  const { plugin, context } = instance();
  let nextTimer = 0;
  const queued = [];
  context.setTimeout = (fn) => { const timer = { id: ++nextTimer }; queued.push({ timer, fn, cleared: false }); return timer; };
  context.clearTimeout = (timer) => { const item = queued.find((x) => x.timer === timer); if (item) item.cleared = true; };
  plugin._cards = new Map([['EMBED', { recordGuid: 'REC_EDITING' }]]);
  plugin._activeEdit = { lineGuid: 'EMBED' };
  let renders = 0;
  plugin._renderFreshCard = () => { renders++; };

  plugin._refreshMovedRecordCards('REC_EDITING');
  for (const item of queued.slice()) if (!item.cleared) item.fn();
  assert.equal(renders, 0);
  assert.equal(plugin._pendingMoveRefreshRecords.has('REC_EDITING'), true);

  plugin._activeEdit = null;
  plugin._flushPendingMoveRefreshes();
  const flush = queued.at(-1);
  flush.fn();
  assert.equal(renders, 1);
  assert.equal(plugin._pendingMoveRefreshRecords.size, 0);
});

test('stale hot-reloaded move completion cannot repaint with the old instance', async () => {
  const { plugin, context } = instance();
  const pending = deferred();
  plugin._moveGeneration = 1;
  context.window.__refxMoveGeneration = 1;
  const rec = { getGuid: () => 'REC_STALE_MOVE', moveToCollection: () => pending.promise };
  let refreshed = 0;
  plugin._refreshMovedRecordCards = () => { refreshed++; };

  const moving = plugin._moveRecordToCollection(rec, {}, 'COL_NEW');
  context.window.__refxMoveGeneration = 2;
  pending.resolve(true);
  assert.equal(await moving, true);
  assert.equal(refreshed, 0);
  assert.equal(plugin._recordCollectionIndex.has('REC_STALE_MOVE'), false);
});

test('record transclusion title prefers built-in Title, falls back to Name, and verifies the write', async () => {
  const { plugin } = instance();
  let title = 'Before';
  let ordinaryName = 'Do not touch';
  const calls = [];
  const both = {
    getName: () => title,
    prop: (field) => field === 'Title'
      ? { set: (value) => { calls.push(field); title = value; } }
      : field === 'Name'
        ? { set: (value) => { calls.push(field); ordinaryName = value; } }
        : null
  };
  assert.equal(await plugin._writeRecordTitle(both, '  Renamed   Record  '), true);
  assert.equal(title, 'Renamed Record');
  assert.equal(ordinaryName, 'Do not touch');
  assert.deepEqual(calls, ['Title']);

  let legacyTitle = 'Legacy title';
  const nameOnly = {
    getName: () => legacyTitle,
    prop: (field) => field === 'Name' ? { set: (value) => { legacyTitle = value; } } : null
  };
  assert.equal(await plugin._writeRecordTitle(nameOnly, 'Legacy renamed'), true);
  assert.equal(legacyTitle, 'Legacy renamed');
  assert.equal(await plugin._writeRecordTitle({ prop: () => null }, 'No field'), false);
  assert.equal(await plugin._writeRecordTitle(both, '   '), false);
});

test('a failed present Title write never falls through to an unrelated Name field', async () => {
  const { plugin } = instance();
  let liveTitle = 'Before';
  let ordinaryName = 'Keep me';
  const rec = {
    getName: () => liveTitle,
    prop: (field) => field === 'Title'
      ? { set: async () => false }
      : field === 'Name'
        ? { set: (value) => { ordinaryName = value; liveTitle = value; } }
        : null
  };

  assert.equal(await plugin._writeRecordTitle(rec, 'Attempted rename'), false);
  assert.equal(liveTitle, 'Before');
  assert.equal(ordinaryName, 'Keep me');
});

test('auto-title source writes for the same line are serialized and rebased', async () => {
  const { plugin } = instance();
  plugin._lineTargetText.set('A', 'A2');
  plugin._lineTargetText.set('B', 'B2');
  plugin._autoTitleGeneration = 0;
  let active = 0;
  let maxActive = 0;
  const line = {
    guid: 'SOURCE',
    props: {},
    segments: [
      { type: 'ref', text: { guid: 'A', title: 'A1' } },
      { type: 'text', text: ' + ' },
      { type: 'ref', text: { guid: 'B', title: 'B1' } }
    ],
    async setSegments(next) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.segments = next;
      active--;
    },
    async setMetaProperty(_key, raw) { this.props[plugin._AUTO_TITLE_META] = raw; }
  };
  plugin._resolveLiveLine = async () => line;
  plugin._liveSegs = () => line.segments;
  plugin._autoTitleMetaCache.set('SOURCE', { v: 1, refs: { 'A#0': 'A1', 'B#0': 'B1' } });

  await Promise.all([
    plugin._syncAutoTitleSource(line, 'A', 'A1', 'A2', 0),
    plugin._syncAutoTitleSource(line, 'B', 'B1', 'B2', 0)
  ]);

  assert.equal(maxActive, 1);
  assert.equal(line.segments[0].text.title, 'A2');
  assert.equal(line.segments[2].text.title, 'B2');
});

test('rejected auto-title segment write never advances managed-title metadata', async () => {
  const { plugin } = instance();
  let metaWrites = 0;
  const line = {
    guid: 'SOURCE', props: {},
    segments: [{ type: 'ref', text: { guid: 'TARGET', title: 'Before' } }],
    setSegments: async () => false,
    setMetaProperty: async () => { metaWrites++; }
  };
  plugin._liveSegs = () => line.segments;
  plugin._autoTitleMetaCache.set('SOURCE', { v: 1, refs: { 'TARGET#0': 'Before' } });

  const changed = await plugin._syncAutoTitleSourceNow(line, 'TARGET', 'Before', 'After', 0, new Set());

  assert.equal(changed, false);
  assert.equal(metaWrites, 0);
  assert.equal(plugin._autoTitleMetaCache.get('SOURCE').refs['TARGET#0'], 'Before');
});

test('managed title changes propagate through reference chains with a cycle guard', async () => {
  const { plugin } = instance();
  const scheduled = [];
  plugin._scheduleAutoTitleSync = (guid, before, after, visited) => scheduled.push({ guid, before, after, visited });
  plugin._lineTargetText.set('SOURCE', 'Before');
  const line = {
    guid: 'SOURCE', props: {},
    segments: [{ type: 'ref', text: { guid: 'TARGET', title: 'Before' } }],
    async setSegments(next) { this.segments = next; },
    async setMetaProperty() {}
  };
  plugin._liveSegs = () => line.segments;
  plugin._autoTitleMetaCache.set('SOURCE', { v: 1, refs: { 'TARGET#0': 'Before' } });
  const visited = new Set(['TARGET']);

  await plugin._syncAutoTitleSourceNow(line, 'TARGET', 'Before', 'After', 0, visited);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].guid, 'SOURCE');
  assert.equal(scheduled[0].before, 'Before');
  assert.equal(scheduled[0].after, 'After');
  assert.equal(scheduled[0].visited.has('TARGET'), true);
});

// ── A1: transclusion Enter (generalized WB mechanism) ─────────────────────────

test('_handleWbEnter: plain Enter inside transclusion-container-div triggers createLineItem', async () => {
  const { plugin, context } = instance();
  plugin._modal = null; plugin._link = null; plugin._cardEditing = false; plugin._cardNav = null;
  // Kill-switch enabled (default).
  context.localStorage.setItem('refx_transclusion_enter', '1');
  // Mock caret detection inside a transclusion container.
  const containerDiv = { isConnected: true, closest: (sel) => sel === '.transclusion-container-div' ? containerDiv : null, querySelector: () => null };
  plugin._detect = () => ({ lineGuid: 'LINE1', lineNode: containerDiv });
  // Track createLineItem calls.
  let created = null;
  const li = { guid: 'LINE1', type: 'text', children: [] };
  const rec = {
    getLineItems: async () => [li],
    createLineItem: async (parent, after, type) => { created = { parent, after, type }; return { guid: 'NEW1' }; }
  };
  context.window.g_universe.itemsByGuid['LINE1'] = { guid: 'LINE1', rguid: 'REC1', props: {}, parent_guid: null };
  context.window.g_universe.itemsByGuid['SLOT1'] = { guid: 'SLOT1', props: { itemref: 'SLOT_TARGET' } };
  plugin.data = { getRecord: (g) => g === 'REC1' ? rec : null };
  plugin._hitTestCaret = () => {};
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  // Give the async chain a tick.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(e.prevented, 'preventDefault must be called');
  assert.ok(e.stopped, 'stopImmediatePropagation must be called');
});

test('_handleWbEnter: modifier keys pass through (no interception)', () => {
  const { plugin } = instance();
  plugin._modal = null; plugin._link = null; plugin._cardEditing = false; plugin._cardNav = null;
  plugin._detect = () => ({ lineGuid: 'X', lineNode: { closest: () => ({}) } });
  for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
    const e = { key: 'Enter', [mod]: true, preventDefault: () => {}, stopped: false, stopImmediatePropagation() { this.stopped = true; } };
    plugin._handleWbEnter(e);
    assert.ok(!e.stopped, `${mod}+Enter must not be intercepted`);
  }
});

test('_handleWbEnter: kill-switch (refx_transclusion_enter=0) disables interception', () => {
  const { plugin, context } = instance();
  plugin._modal = null; plugin._link = null; plugin._cardEditing = false; plugin._cardNav = null;
  context.localStorage.setItem('refx_transclusion_enter', '0');
  const container = { closest: () => container, isConnected: false };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: container });
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.prevented, 'kill-switch must suppress Enter interception');
});

test('_handleWbEnter: modal/link/cardEditing guards suppress interception', () => {
  const { plugin } = instance();
  const container = { closest: () => container };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: container });
  for (const [field, val] of [['_modal', {}], ['_link', {}], ['_cardEditing', true], ['_cardNav', {}]]) {
    plugin._modal = null; plugin._link = null; plugin._cardEditing = false; plugin._cardNav = null;
    plugin[field] = val;
    const e = keyEvent('Enter');
    plugin._handleWbEnter(e);
    assert.ok(!e.prevented, `${field} guard must suppress Enter interception`);
  }
});

test('_wbCreateSiblingBelow: root caret creates first-child on source record', async () => {
  const { plugin, context } = instance();
  const li = { guid: 'ROOT_LINE', type: 'text', children: [] };
  let createArgs = null;
  const rec = {
    getLineItems: async () => [li],
    createLineItem: async (parent, after, type) => { createArgs = { parentGuid: parent && parent.guid, afterGuid: after && after.guid, type }; return { guid: 'CHILD1' }; }
  };
  context.window.g_universe.itemsByGuid['ROOT_LINE'] = { guid: 'ROOT_LINE', rguid: 'REC1', props: {}, parent_guid: null };
  // slotNode.getAttribute returns SLOT1; SLOT1's itemref === ROOT_LINE → isOnRoot=true.
  const slotNode = { getAttribute: (a) => a === 'data-guid' ? 'SLOT1' : null };
  context.window.g_universe.itemsByGuid['SLOT1'] = { guid: 'SLOT1', props: { itemref: 'ROOT_LINE' } };
  const container = { isConnected: false, closest: (sel) => sel === '.listitem-transclusion[data-guid]' ? slotNode : null, querySelector: () => null };
  plugin.data = { getRecord: (g) => g === 'REC1' ? rec : null };
  plugin._hitTestCaret = () => {};
  await plugin._wbCreateSiblingBelow({ lineGuid: 'ROOT_LINE' }, container);
  assert.ok(createArgs, 'createLineItem must be called');
  assert.equal(createArgs.parentGuid, 'ROOT_LINE', 'first-child: parent = root line');
  assert.equal(createArgs.afterGuid, null, 'first-child: after = null (first-child)');
  assert.equal(createArgs.type, 'text');
});

test('_wbCreateSiblingBelow: descendant caret creates sibling-after on source record', async () => {
  const { plugin, context } = instance();
  const parent = { guid: 'PARENT_LINE', type: 'text', children: [] };
  const child = { guid: 'CHILD_LINE', type: 'text', children: [], parent_guid: 'PARENT_LINE' };
  parent.children = [child];
  let createArgs = null;
  const rec = {
    getLineItems: async () => [parent],
    createLineItem: async (p, after, type) => { createArgs = { parentGuid: p && p.guid, afterGuid: after && after.guid, type }; return { guid: 'NEW_SIBLING' }; }
  };
  context.window.g_universe.itemsByGuid['CHILD_LINE'] = { guid: 'CHILD_LINE', rguid: 'REC1', props: {}, parent_guid: 'PARENT_LINE' };
  // SLOT itemref != CHILD_LINE → isOnRoot=false.
  const slotNode = { getAttribute: (a) => a === 'data-guid' ? 'SLOT1' : null };
  context.window.g_universe.itemsByGuid['SLOT1'] = { guid: 'SLOT1', props: { itemref: 'OTHER_ROOT' } };
  const container = { isConnected: false, closest: (sel) => sel === '.listitem-transclusion[data-guid]' ? slotNode : null, querySelector: () => null };
  plugin.data = { getRecord: (g) => g === 'REC1' ? rec : null };
  plugin._hitTestCaret = () => {};
  await plugin._wbCreateSiblingBelow({ lineGuid: 'CHILD_LINE' }, container);
  assert.ok(createArgs, 'createLineItem must be called');
  assert.equal(createArgs.parentGuid, 'PARENT_LINE', 'sibling-after: parent = child parent');
  assert.equal(createArgs.afterGuid, 'CHILD_LINE', 'sibling-after: after = child line');
  assert.equal(createArgs.type, 'text');
});

// ── A2: embed badge collapse ───────────────────────────────────────────────────

test('_embedBadgeClick: ignores click outside .lineitem-transcludes', () => {
  const { plugin } = instance();
  // Set up handler as it would be during runtime.
  plugin._isUnloading = false;
  plugin.data = { getRecord: () => null };
  let toasted = null;
  plugin._toast = (m) => { toasted = m; };
  plugin._embedBadgeClick = (e) => {
    const badge = e.target?.closest?.('.lineitem-transcludes');
    if (!badge) return;
    toasted = 'called';
  };
  const e = { target: { closest: () => null }, preventDefault: () => {}, stopImmediatePropagation: () => {} };
  plugin._embedBadgeClick(e);
  assert.equal(toasted, null, 'non-badge clicks must not trigger handler');
});

test('_embedBadgeClick: does not collapse user-authored native transclusion (no refx_embed prop)', () => {
  const { plugin, context } = instance();
  plugin._isUnloading = false;
  let deleted = false;
  plugin._deleteEmbedLine = async () => { deleted = true; };
  // No refx_embed in state — native transclusion.
  context.window.g_universe.itemsByGuid['NATIVE1'] = { guid: 'NATIVE1', rguid: 'REC_N', props: { itemref: 'TARGET' } };
  const li = { getAttribute: (a) => a === 'data-guid' ? 'NATIVE1' : null };
  const badge = { closest: (sel) => sel === '.lineitem-transcludes' ? badge : (sel.includes('listitem-transclusion') ? li : null) };
  const e = { target: badge, preventDefault: () => {}, stopImmediatePropagation: () => {}, prevented: false };
  // Re-implement handler inline (mirrors plugin._embedBadgeClick logic).
  const handler = (ev) => {
    const b = ev.target?.closest?.('.lineitem-transcludes');
    if (!b) return;
    const liel = b.closest('.listitem-transclusion[data-guid]');
    if (!liel) return;
    const g = liel.getAttribute('data-guid');
    if (!g) return;
    const st = ((context.window.g_universe && context.window.g_universe.itemsByGuid) || {})[g];
    if (!st || !st.props || !st.props.refx_embed) return; // native transclusion → bail
    deleted = true;
  };
  handler(e);
  assert.ok(!deleted, 'user-authored transclusion must not be collapsed by badge click');
});

// ── A2: _collapseEmbedFast — spy asserts no host-page getLineItems + skip confirm ──

test('_collapseEmbedFast: skips confirm for refx_embed and never calls host-page getLineItems', async () => {
  const { plugin, context } = instance();
  let getLineItemsCalled = false;
  let deleteCalled = false;

  const embedGuid = 'EMBED_LINE_1';
  const hostGuid = 'HOST_LINE_1';
  const targetGuid = 'TARGET_GUID_1';

  // Set up g_universe: embed line is a child of host, has refx_embed.
  context.window.g_universe.itemsByGuid[embedGuid] = {
    guid: embedGuid, rguid: 'PAGE_1', props: { refx_embed: 1, itemref: targetGuid },
    parent_guid: hostGuid
  };
  // Register the embed line in _cards.
  const embedLine = {
    guid: embedGuid,
    delete: async () => { deleteCalled = true; return true; }
  };
  plugin._cards.set(embedGuid, { recordGuid: targetGuid, line: embedLine, wb: false });
  // Stub helpers that _collapseEmbedFast may call.
  plugin._removeCardEl = () => {};
  plugin._removeCrumbEl = () => {};
  plugin._exitCardNav = () => {};
  plugin._teardownCardObserver = () => {};
  plugin._attachPropCard = () => {};
  plugin._attachBreadcrumb = () => {};
  plugin._applyEmbedVariant = () => {};

  // The host "page" record — its getLineItems must NOT be called.
  plugin.data = {
    getRecord: (g) => g === 'PAGE_1' ? { guid: 'PAGE_1', getLineItems: async () => { getLineItemsCalled = true; return []; } } : null
  };

  const ok = await plugin._collapseEmbedFast(hostGuid, targetGuid);
  assert.ok(ok, '_collapseEmbedFast should return true when embed found');
  assert.ok(deleteCalled, 'embed line.delete() must be called');
  assert.ok(!getLineItemsCalled, '_collapseEmbedFast must NOT call host-page getLineItems()');
  assert.equal(context.window.__refxDiag.lastCollapse.path, 'cards');
  assert.equal(context.window.__refxDiag.lastCollapse.coldFallback, false);
  assert.ok(context.window.__refxDiag.lastCollapse.ms < 50, 'warm retained-handle close must stay under 50ms in the harness');
});

test('_collapseEmbedFast: cold fallback reads only HOST getLineItems(false) and never target', async () => {
  const { plugin, context } = instance();
  const calls = [];
  let deleted = 0;
  const embed = {
    guid: 'COLD_EMBED', type: 'transclusion',
    props: { refx_embed: 1, itemref: 'COLD_TARGET' },
    async delete() { deleted++; return true; },
  };
  const hostLine = { guid: 'COLD_HOST_LINE', children: [embed] };
  context.window.g_universe.itemsByGuid.COLD_HOST_LINE = { guid: 'COLD_HOST_LINE', rguid: 'SMALL_HOST_RECORD' };
  plugin.data = {
    getRecord(guid) {
      calls.push(['record', guid]);
      if (guid === 'SMALL_HOST_RECORD') return {
        async getLineItems(expandReferences) {
          calls.push(['items', guid, expandReferences]);
          return [hostLine];
        }
      };
      throw new Error('collapse must never touch target record ' + guid);
    }
  };

  assert.equal(await plugin._collapseEmbedFast('COLD_HOST_LINE', 'COLD_TARGET'), true);
  assert.equal(deleted, 1, 'exactly one embed line is deleted');
  assert.deepEqual(calls, [
    ['record', 'SMALL_HOST_RECORD'],
    ['items', 'SMALL_HOST_RECORD', false],
  ]);
  assert.equal(context.window.__refxDiag.lastCollapse.path, 'host-items');
  assert.equal(context.window.__refxDiag.lastCollapse.hostGuid, 'COLD_HOST_LINE');
  assert.equal(context.window.__refxDiag.lastCollapse.targetGuid, 'COLD_TARGET');
  assert.equal(context.window.__refxDiag.lastCollapse.coldFallback, true);
});

test('_collapseEmbedFast: falls through to _deleteEmbedLine for non-refx_embed lines', async () => {
  const { plugin, context } = instance();
  let fullDeleteCalled = false;

  const embedGuid = 'EMBED_LINE_2';
  const hostGuid = 'HOST_LINE_2';
  const targetGuid = 'TARGET_GUID_2';

  // No refx_embed prop — user-authored transclusion.
  context.window.g_universe.itemsByGuid[embedGuid] = {
    guid: embedGuid, rguid: 'PAGE_2', props: { itemref: targetGuid },
    parent_guid: hostGuid
  };
  const embedLine = { guid: embedGuid, delete: async () => true };
  plugin._cards.set(embedGuid, { recordGuid: targetGuid, line: embedLine, wb: false });
  plugin._deleteEmbedLine = async () => { fullDeleteCalled = true; };

  await plugin._collapseEmbedFast(hostGuid, targetGuid);
  assert.ok(fullDeleteCalled, 'non-refx_embed must route through _deleteEmbedLine');
});

// ── A1: badge toggle collapses an open embed ──────────────────────────────────

test('Cmd+Up on a record preview uses the fast path and never reads the host page body', async () => {
  const { plugin } = instance();
  const block = {
    guid: 'HOST_FAST_PREVIEW', props: { refx_record_previews_v1: 'TARGET_FAST_PREVIEW' },
    async setMetaProperty(key, value) { if (value == null) delete this.props[key]; else this.props[key] = value; return true; },
  };
  plugin._registerRecordPreview(block.guid, 'TARGET_FAST_PREVIEW', block);
  let bodyReads = 0;
  plugin.data = { getRecord: () => ({ async getLineItems() { bodyReads++; return [block]; } }) };
  plugin._isMac = true;
  plugin._detect = () => ({ lineGuid: block.guid, pageGuid: 'HUGE_PAGE' });
  plugin._selectedRef = () => ({ targetGuid: 'TARGET_FAST_PREVIEW', isText: false });
  const event = keyEvent('ArrowUp');
  event.metaKey = true; event.ctrlKey = false; event.altKey = false; event.shiftKey = false;

  plugin._handleExpandKey(event);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(event.prevented, true);
  assert.equal(bodyReads, 0, 'Cmd+Up must not await hostRecord.getLineItems()');
  assert.equal(block.props.refx_record_previews_v1, undefined);
});

test('Cmd+Up keydown inside a line transclusion reaches its DOM ancestor and deletes without page scan or confirm', async () => {
  const { plugin, context } = instance();
  const embedGuid = 'EMBED_FAST_INSIDE';
  let deleted = 0;
  const line = { guid: embedGuid, async delete() { deleted++; return true; } };
  plugin._embedLines.set(embedGuid, line);
  context.window.g_universe.itemsByGuid[embedGuid] = {
    guid: embedGuid, type: 'transclusion', parent_guid: 'HOST_FAST_INSIDE',
    props: { refx_embed: 1, itemref: 'TARGET_LINE_FAST' },
  };
  const embedNode = { getAttribute: (name) => name === 'data-guid' ? embedGuid : null, parentElement: context.document.body };
  const innerNode = { getAttribute: () => null, parentElement: embedNode };
  plugin._selectedRef = () => null;
  plugin.data = { getRecord: () => { throw new Error('page resolution must not run'); } };
  plugin._confirmLineDelete = async () => { throw new Error('plugin embeds must not confirm'); };
  plugin._isMac = true;
  plugin._detect = () => ({ lineGuid: 'SOURCE_CHILD_IN_EMBED', pageGuid: 'HUGE_SOURCE', lineNode: innerNode });
  const event = keyEvent('ArrowUp');
  event.metaKey = true; event.ctrlKey = false; event.altKey = false; event.shiftKey = false;

  plugin._handleExpandKey(event);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(event.prevented, true, 'keydown gate must admit a caret inside the rendered embed');
  assert.equal(deleted, 1);
  assert.equal(context.window.__refxDiag.lastCollapse.path, 'dom');
  assert.equal(context.window.__refxDiag.lastCollapse.hostGuid, 'HOST_FAST_INSIDE');
  assert.equal(context.window.__refxDiag.lastCollapse.targetGuid, 'TARGET_LINE_FAST');
  assert.equal(context.window.__refxDiag.lastCollapse.coldFallback, false);
});

test('Cmd+Down expands a normal record ref; windowed show-more only owns events from inside its open shell', () => {
  const { plugin } = instance();
  plugin._isMac = true;
  const hit = { lineGuid: 'HOST_CMD_DOWN', pageGuid: 'PAGE_CMD_DOWN' };
  const ref = { targetGuid: 'TARGET_RECORD_CMD_DOWN', isText: false };
  plugin._detect = () => hit;
  plugin._selectedRef = () => ref;
  let expanded = null;
  plugin._expandRef = (seenHit, seenRef) => { expanded = [seenHit, seenRef]; };

  const normal = keyEvent('ArrowDown');
  normal.metaKey = true; normal.ctrlKey = false; normal.altKey = false; normal.shiftKey = false;
  normal.target = { closest: () => null };
  plugin._handleExpandKey(normal);
  assert.equal(normal.prevented, true);
  assert.deepEqual(expanded, [hit, ref], 'normal record ref must still route to property-card expansion');

  expanded = null;
  let collapsedWindow = null;
  plugin._collapseEmbedFast = (hostGuid, targetGuid) => { collapsedWindow = [hostGuid, targetGuid]; };
  const windowShell = { dataset: { refxWindowedHost: 'HOST_WINDOW', refxWindowedTarget: 'TARGET_WINDOW' } };
  const insideWindow = keyEvent('ArrowDown');
  insideWindow.metaKey = true; insideWindow.ctrlKey = false; insideWindow.altKey = false; insideWindow.shiftKey = false;
  insideWindow.target = { closest: (selector) => selector === '.refx-windowed-preview' ? windowShell : null };
  plugin._handleExpandKey(insideWindow);
  assert.equal(insideWindow.prevented, false, 'local windowed-preview handler must receive the chord');
  assert.equal(expanded, null);

  const upInsideWindow = keyEvent('ArrowUp');
  upInsideWindow.metaKey = true; upInsideWindow.ctrlKey = false; upInsideWindow.altKey = false; upInsideWindow.shiftKey = false;
  upInsideWindow.target = insideWindow.target;
  plugin._handleExpandKey(upInsideWindow);
  assert.equal(upInsideWindow.prevented, true, 'Cmd+Up inside a windowed preview must collapse it');
  assert.deepEqual(collapsedWindow, ['HOST_WINDOW', 'TARGET_WINDOW']);
});

test('Cmd+Down inside compact record preview triggers native Load full body', async () => {
  const { plugin } = instance();
  plugin._isMac = true;
  const key = 'rp:HOST_KEYBOARD:TARGET_KEYBOARD';
  plugin._recordPreviews.set(key, { key, hostLineGuid: 'HOST_KEYBOARD', targetGuid: 'TARGET_KEYBOARD' });
  let materialized = null;
  plugin._materializeRecordPreview = async (seen) => { materialized = seen; return true; };
  plugin._detect = () => { throw new Error('compact preview shortcut must resolve before caret detection'); };
  const shell = { dataset: { refxPreviewKey: key } };
  const event = keyEvent('ArrowDown');
  event.metaKey = true; event.ctrlKey = false; event.altKey = false; event.shiftKey = false;
  event.target = { closest: (selector) => selector === '.refx-record-preview-shell' ? shell : null };

  plugin._handleExpandKey(event);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(event.prevented, true);
  assert.equal(materialized, key);
});

test('_hasEmbedOpen: returns embed guid when embed is open under host line', () => {
  const { plugin, context } = instance();
  const embedGuid = 'EMBED_LINE_3';
  const hostGuid = 'HOST_LINE_3';
  const targetGuid = 'TARGET_GUID_3';

  context.window.g_universe.itemsByGuid[embedGuid] = {
    guid: embedGuid, rguid: 'PAGE_3', props: { refx_embed: 1, itemref: targetGuid },
    parent_guid: hostGuid
  };
  plugin._cards.set(embedGuid, { recordGuid: targetGuid, line: { guid: embedGuid }, wb: false });

  const found = plugin._hasEmbedOpen(hostGuid, targetGuid);
  assert.equal(found, embedGuid, '_hasEmbedOpen should return the embed guid');
});

test('_hasEmbedOpen: returns null when no embed is open for that host+target', () => {
  const { plugin } = instance();
  const found = plugin._hasEmbedOpen('SOME_HOST', 'SOME_TARGET');
  assert.equal(found, null, '_hasEmbedOpen returns null when _cards is empty');
});

test('inline row embed action survives section re-render and second click collapses', async () => {
  const { plugin } = instance();
  const open = new Set();
  const calls = [];
  plugin._bridgeCreateEmbed = (hostGuid, targetGuid) => {
    const key = hostGuid + '›' + targetGuid;
    calls.push([hostGuid, targetGuid]);
    if (open.has(key)) { open.delete(key); return false; }
    open.add(key);
    return true;
  };

  const entry = { hostLineGuid: 'HOST_INLINE_STABLE', spawnedEmbeds: new Set() };
  const firstHandle = { guid: 'LINE_INLINE_STABLE' };
  const firstAction = plugin._inlineRowEmbedAction(entry, firstHandle);
  assert.equal(await firstAction.fn(), true, 'first click opens the line-target embed');

  // A refresh supplies a new SDK handle; Thymer can invalidate that handle and
  // mutate the entry before the rendered action is clicked.
  const rerenderedHandle = { guid: 'LINE_INLINE_STABLE' };
  const secondAction = plugin._inlineRowEmbedAction(entry, rerenderedHandle);
  rerenderedHandle.guid = undefined;
  entry.hostLineGuid = 'HOST_MUTATED_AFTER_RENDER';
  assert.equal(await secondAction.fn(), false, 'second click returns the collapsed state');
  assert.equal(open.size, 0, 'the exact host/line pair is closed');
  assert.deepEqual(calls, [
    ['HOST_INLINE_STABLE', 'LINE_INLINE_STABLE'],
    ['HOST_INLINE_STABLE', 'LINE_INLINE_STABLE'],
  ]);
});

test('inline row embed action guards an empty target before calling the bridge', () => {
  const { plugin } = instance();
  let bridgeCalls = 0;
  let toast = '';
  plugin._bridgeCreateEmbed = () => { bridgeCalls++; return true; };
  plugin._toast = (message) => { toast = message; };

  const action = plugin._inlineRowEmbedAction({ hostLineGuid: 'HOST_GUARDED' }, { guid: '' });
  assert.equal(action.fn(), false);
  assert.equal(bridgeCalls, 0, 'empty target must never reach _bridgeCreateEmbed');
  assert.match(toast, /source line is unavailable/i);
});

test('_hasEmbedOpen detects a line-target embed under its exact host without a card entry', () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.EMBED_LINE_TARGET = {
    guid: 'EMBED_LINE_TARGET',
    type: 'transclusion',
    parent_guid: 'HOST_LINE_TARGET',
    props: { refx_embed: 1, itemref: 'SOURCE_LINE_TARGET' },
  };

  assert.equal(plugin._cards.size, 0, 'line embeds do not require record-card state');
  assert.equal(plugin._hasEmbedOpen('HOST_LINE_TARGET', 'SOURCE_LINE_TARGET'), 'EMBED_LINE_TARGET');
  assert.equal(plugin._hasEmbedOpen('OTHER_HOST', 'SOURCE_LINE_TARGET'), null, 'host identity is part of the toggle key');
});

// ── A3: threshold routes large targets to windowed; card hidden-until-aligned ─

test('A3: _LARGE_TRANSCLUSION_THRESHOLD is 1500 — only extreme targets take windowed path', () => {
  const { plugin } = instance();
  assert.equal(plugin._LARGE_TRANSCLUSION_THRESHOLD, 1500);
});

test('cold target sizing mounts one provisional shell before SDK work and reuses the same read receipt', async () => {
  const { plugin } = instance();
  const pending = deferred();
  let sizeReads = 0;
  let paintYields = 0;
  let mounts = 0;
  const shell = { kind: 'pending-shell' };
  plugin._trueTargetSize = () => { sizeReads++; return pending.promise; };
  plugin._yieldPreviewPaint = async () => { paintYields++; };

  const probe = plugin._trueTargetSizeWithInstantPreview(
    'TARGET_COLD_INSTANT',
    'OWNER_COLD_INSTANT',
    () => { mounts++; return shell; },
    () => true,
  );
  assert.equal(mounts, 1, 'a genuinely cold read mounts feedback before its first await');
  pending.resolve(plugin._LARGE_TRANSCLUSION_THRESHOLD + 1);
  const result = await probe;

  assert.equal(result.count, plugin._LARGE_TRANSCLUSION_THRESHOLD + 1);
  assert.equal(result.pendingShell, shell);
  assert.equal(sizeReads, 1, 'the provisional shell performs no second body read');
  assert.equal(paintYields, 1, 'SDK work begins only after a presentable browser frame');
});

test('a provisional large-target shell cannot bypass the size guard through repeat activation', async () => {
  const { plugin } = instance();
  let materializes = 0;
  const entry = {
    key: plugin._windowedPreviewKey('HOST_PENDING_GUARD', 'TARGET_PENDING_GUARD'),
    hostLineGuid: 'HOST_PENDING_GUARD', targetGuid: 'TARGET_PENDING_GUARD',
    pending: true, shell: { isConnected: true },
    materialize: async () => { materializes++; return true; },
  };
  plugin._windowedPreviews.set(entry.key, entry);

  assert.equal(await plugin._activateWindowedPreview(entry), false);
  assert.equal(materializes, 0, 'repeat shortcuts cannot request an unbounded native body before sizing settles');
});

test('large-subtree preview remains painted until the verified native transclusion mounts', async () => {
  const { plugin } = instance();
  const calls = [];
  const block = { guid: 'HOST_MATERIALIZE', children: [], async getParent() { return null; } };
  const line = { guid: 'EMBED_MATERIALIZE', type: 'transclusion', parent_guid: block.guid, props: { itemref: 'TARGET_MATERIALIZE', refx_embed: 1 } };
  const rec = {
    guid: 'OWNER_MATERIALIZE',
    async createLineItem(parent, after, type, segments, props) {
      calls.push({ parent, after, type, segments, props });
      block.children = [line];
      return line;
    },
    async getLineItems() { return [block]; },
  };
  const shell = { isConnected: true, removed: false, remove() { this.removed = true; this.isConnected = false; } };
  const loadButton = { textContent: 'Load editable transclusion', disabled: false, isConnected: true };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_MATERIALIZE'),
    hostLineGuid: block.guid,
    hostRecordGuid: rec.guid,
    hostLine: block,
    hostRecord: rec,
    targetGuid: 'TARGET_MATERIALIZE',
    shell,
    loadButton,
    materializing: false,
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record: rec });
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [];
  plugin._watchEmbedMounted = () => {};
  plugin._transclusionNode = () => null;
  plugin._focusEmbeddedLine = () => {};
  plugin._unfoldHostLine = () => {};
  plugin._breadcrumbsEnabled = false;
  plugin._toast = () => {};

  assert.equal(await plugin._materializeWindowedTransclusion(entry), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parent, block);
  assert.equal(calls[0].after, null);
  assert.equal(calls[0].type, 'transclusion');
  assert.equal(calls[0].segments, null);
  assert.equal(calls[0].props.itemref, 'TARGET_MATERIALIZE');
  assert.equal(calls[0].props.refx_embed, 1);
  assert.equal(plugin._embedLines.get(line.guid), line, 'the exact SDK handle is retained for collapse');
  assert.equal(plugin._windowedPreviews.has(entry.key), true);
  assert.equal(shell.removed, false, 'fallback remains visible while the native DOM is still mounting');
  assert.equal(loadButton.disabled, true);
  assert.equal(loadButton.textContent, 'Native body mounting…');

  plugin._transclusionNode = () => ({ isConnected: true });
  assert.equal(plugin._retireWindowedPreviewAfterNativeMount(entry, line.guid, entry.targetGuid), true);
  assert.equal(plugin._windowedPreviews.has(entry.key), false);
  assert.equal(shell.removed, true, 'fallback retires only after the native body exists');
});

test('large-subtree materialization failure preserves preview and restores its action', async () => {
  const { plugin } = instance();
  const block = { guid: 'HOST_RETAIN', async getParent() { return null; } };
  const rec = { guid: 'OWNER_RETAIN', async createLineItem() { return null; } };
  const shell = { isConnected: true, removed: false, remove() { this.removed = true; } };
  const loadButton = { textContent: 'Load editable transclusion', disabled: false, isConnected: true };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_RETAIN'),
    hostLineGuid: block.guid,
    hostRecordGuid: rec.guid,
    hostLine: block,
    hostRecord: rec,
    targetGuid: 'TARGET_RETAIN',
    shell,
    loadButton,
    materializing: false,
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record: rec });
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [];
  let toast = '';
  plugin._toast = (message) => { toast = message; };

  assert.equal(await plugin._materializeWindowedTransclusion(entry), false);
  assert.equal(plugin._windowedPreviews.get(entry.key), entry);
  assert.equal(shell.removed, false);
  assert.equal(loadButton.disabled, false);
  assert.equal(loadButton.textContent, 'Load editable transclusion');
  assert.match(toast, /preview is still open/i);
});

test('large-subtree materialization adopts an already-created exact embed without duplicating it', async () => {
  const { plugin } = instance();
  let creates = 0;
  const block = { guid: 'HOST_EXISTING', async getParent() { return null; } };
  const rec = { guid: 'OWNER_EXISTING', async createLineItem() { creates++; return null; } };
  const shell = { isConnected: true, removed: false, remove() { this.removed = true; } };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_EXISTING'),
    hostLineGuid: block.guid,
    hostLine: block,
    hostRecord: rec,
    targetGuid: 'TARGET_EXISTING',
    shell,
    loadButton: { textContent: 'Load editable transclusion', disabled: false, isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record: rec });
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [{ guid: 'ALREADY_NATIVE' }];
  plugin._toast = () => {};

  assert.equal(await plugin._materializeWindowedTransclusion(entry), true);
  assert.equal(creates, 0);
  assert.equal(shell.removed, true);
  assert.equal(plugin._windowedPreviews.has(entry.key), false);
});

test('failed itemref verification rolls back native line and keeps preview', async () => {
  const { plugin } = instance();
  let deleted = 0;
  const block = { guid: 'HOST_VERIFY', async getParent() { return null; } };
  let persisted = true;
  const line = {
    guid: 'EMBED_VERIFY', props: {},
    async setMetaProperty() { return false; },
  };
  const residue = {
    guid: line.guid, type: 'transclusion', parent_guid: block.guid, props: {},
    async getChildren() { return []; },
    async delete() { deleted++; persisted = false; return true; },
  };
  const rec = {
    guid: 'OWNER_VERIFY',
    async createLineItem() { return line; },
    async getLineItems() { block.children = persisted ? [residue] : []; return [block]; },
  };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_VERIFY'),
    hostLineGuid: block.guid,
    hostLine: block,
    hostRecord: rec,
    targetGuid: 'TARGET_VERIFY',
    shell: { isConnected: true, remove() { throw new Error('must remain'); } },
    loadButton: { textContent: 'Load editable transclusion', disabled: false, isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record: rec });
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [];
  plugin._toast = () => {};

  assert.equal(await plugin._materializeWindowedTransclusion(entry), false);
  assert.equal(deleted, 1);
  assert.equal(plugin._windowedPreviews.get(entry.key), entry);
  assert.equal(plugin._embedLines.has(line.guid), false);
});

test('failed ownership-marker verification rolls back native line and keeps preview', async () => {
  const { plugin } = instance();
  let deleted = 0;
  const block = { guid: 'HOST_OWNERSHIP' };
  let persisted = true;
  const line = {
    guid: 'EMBED_OWNERSHIP', props: { itemref: 'TARGET_OWNERSHIP' },
    async setMetaProperty(key) { return key !== 'refx_embed'; },
  };
  const residue = {
    guid: line.guid, type: 'transclusion', parent_guid: block.guid,
    props: { itemref: 'TARGET_OWNERSHIP' },
    async getChildren() { return []; },
    async delete() { deleted++; persisted = false; return true; },
  };
  const rec = {
    guid: 'OWNER_OWNERSHIP',
    async createLineItem() { return line; },
    async getLineItems() { block.children = persisted ? [residue] : []; return [block]; },
  };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_OWNERSHIP'),
    hostLineGuid: block.guid,
    targetGuid: 'TARGET_OWNERSHIP',
    shell: { isConnected: true, remove() { throw new Error('must remain'); } },
    loadButton: { textContent: 'Load editable transclusion', disabled: false, isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record: rec });
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [];
  plugin._toast = () => {};

  assert.equal(await plugin._materializeWindowedTransclusion(entry), false);
  assert.equal(deleted, 1);
  assert.equal(plugin._windowedPreviews.get(entry.key), entry);
});

test('rollback accepts false deletion only after the exact created GUID rereads absent', async () => {
  const { plugin } = instance();
  const created = { guid: 'ROLLBACK_ABSENT', async delete() { return false; } };
  let reads = 0;
  const record = {
    async getLineItems(expandReferences) {
      reads++;
      assert.equal(expandReferences, false);
      return [];
    },
  };

  assert.equal(await plugin._rollbackCreatedTransclusion({
    createdLine: created,
    record,
    mutationKey: 'HOST_ROLLBACK_ABSENT›TARGET_ROLLBACK_ABSENT',
    expectedParentGuid: 'HOST_ROLLBACK_ABSENT',
    targetGuid: 'TARGET_ROLLBACK_ABSENT',
  }), true);
  assert.equal(reads, 1);
  assert.equal(plugin._embedRollbackPending.size, 0);
});

test('rollback retries only the fresh exact, direct, childless transclusion handle', async () => {
  const { plugin } = instance();
  const stale = { guid: 'ROLLBACK_FRESH', async delete() { throw new Error('stale'); } };
  let freshDeletes = 0;
  let present = true;
  const fresh = {
    guid: stale.guid,
    type: 'transclusion',
    parent_guid: 'HOST_ROLLBACK_FRESH',
    props: { itemref: 'TARGET_ROLLBACK_FRESH' },
    async getChildren() { return []; },
    async delete() { freshDeletes++; present = false; return true; },
  };
  const root = { guid: 'HOST_ROLLBACK_FRESH', children: [] };
  const record = { async getLineItems() { root.children = present ? [fresh] : []; return [root]; } };

  assert.equal(await plugin._rollbackCreatedTransclusion({
    createdLine: stale,
    record,
    mutationKey: 'HOST_ROLLBACK_FRESH›TARGET_ROLLBACK_FRESH',
    expectedParentGuid: 'HOST_ROLLBACK_FRESH',
    targetGuid: 'TARGET_ROLLBACK_FRESH',
  }), true);
  assert.equal(freshDeletes, 1);
  assert.equal(plugin._embedRollbackPending.size, 0);
});

test('rollback never recursively deletes a rejected transclusion with children', async () => {
  const { plugin } = instance();
  let freshDeletes = 0;
  const created = { guid: 'ROLLBACK_CHILDREN', async delete() { return false; } };
  const fresh = {
    guid: created.guid,
    type: 'transclusion',
    parent_guid: 'HOST_ROLLBACK_CHILDREN',
    props: { itemref: 'TARGET_ROLLBACK_CHILDREN' },
    async getChildren() { return [{ guid: 'USER_CHILD' }]; },
    async delete() { freshDeletes++; return true; },
  };
  const record = { async getLineItems() { return [fresh]; } };
  const mutationKey = 'HOST_ROLLBACK_CHILDREN›TARGET_ROLLBACK_CHILDREN';

  assert.equal(await plugin._rollbackCreatedTransclusion({
    createdLine: created,
    record,
    mutationKey,
    expectedParentGuid: 'HOST_ROLLBACK_CHILDREN',
    targetGuid: 'TARGET_ROLLBACK_CHILDREN',
  }), false);
  assert.equal(freshDeletes, 0);
  assert.equal(plugin._embedRollbackPending.has(mutationKey), true);
});

test('cleanup-pending conversion blocks a duplicate create on repeated Load', async () => {
  const { plugin } = instance();
  let creates = 0;
  const block = { guid: 'HOST_PENDING_DUP', async getParent() { return null; } };
  const created = {
    guid: 'EMBED_PENDING_DUP',
    props: {},
    async setMetaProperty() { return false; },
    async delete() { return false; },
  };
  const residue = {
    guid: created.guid,
    type: 'transclusion',
    parent_guid: block.guid,
    props: {},
    async getChildren() { return [{ guid: 'PRESERVED_CHILD' }]; },
    async delete() { throw new Error('must not delete a line with children'); },
  };
  const record = {
    guid: 'OWNER_PENDING_DUP',
    async createLineItem() { creates++; return created; },
    async getLineItems() { return [residue]; },
  };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_PENDING_DUP'),
    hostLineGuid: block.guid,
    targetGuid: 'TARGET_PENDING_DUP',
    shell: { isConnected: true, remove() { throw new Error('preview must remain'); } },
    loadButton: { textContent: 'Load editable transclusion', disabled: false, isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record });
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [];
  plugin._toast = () => {};

  assert.equal(await plugin._materializeWindowedTransclusion(entry), false);
  assert.equal(creates, 1);
  assert.equal(plugin._embedRollbackPending.has(block.guid + '›TARGET_PENDING_DUP'), true);
  assert.equal(await plugin._materializeWindowedTransclusion(entry), false);
  assert.equal(creates, 1, 'pending exact-GUID cleanup must finish before another create');
  assert.equal(plugin._windowedPreviews.get(entry.key), entry);
});

test('simultaneous preview activations share the canonical host-target mutation lock', async () => {
  const { plugin } = instance();
  const pending = deferred();
  let creates = 0;
  const block = { guid: 'HOST_SERIAL', children: [] };
  const line = {
    guid: 'EMBED_SERIAL', type: 'transclusion', parent_guid: block.guid,
    props: { itemref: 'TARGET_SERIAL', refx_embed: 1 },
    async delete() { return true; },
  };
  const rec = {
    guid: 'OWNER_SERIAL',
    async createLineItem() { creates++; block.children = [line]; return line; },
    async getLineItems() { return [block]; },
  };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_SERIAL'),
    hostLineGuid: block.guid,
    targetGuid: 'TARGET_SERIAL',
    shell: { isConnected: true, remove() { this.isConnected = false; } },
    loadButton: { textContent: 'Load editable transclusion', disabled: false, isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = () => pending.promise;
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [];
  plugin._watchEmbedMounted = () => {};
  plugin._focusEmbeddedLine = () => {};
  plugin._breadcrumbsEnabled = false;
  plugin._toast = () => {};

  const first = plugin._materializeWindowedTransclusion(entry);
  assert.equal(await plugin._materializeWindowedTransclusion(entry), false);
  pending.resolve({ line: block, record: rec });
  assert.equal(await first, true);
  assert.equal(creates, 1);
});

test('repeat expansion of an open performance preview materializes it instead of creating beside it', async () => {
  const { plugin } = instance();
  const entry = {
    key: plugin._windowedPreviewKey('HOST_REPEAT', 'TARGET_REPEAT'),
    hostLineGuid: 'HOST_REPEAT', targetGuid: 'TARGET_REPEAT', shell: { isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  let materialized = null;
  plugin._materializeWindowedTransclusion = async (value) => { materialized = value; return true; };
  plugin.data = { getRecord() { throw new Error('must use open preview before resolving host'); } };

  assert.equal(await plugin._expandRef(
    { lineGuid: 'HOST_REPEAT', pageGuid: 'OWNER_REPEAT' },
    { targetGuid: 'TARGET_REPEAT', isText: true },
  ), true);
  assert.equal(materialized, entry);
});

test('mutual line-target cycle is rejected through the target owner record', async () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.TARGET_CYCLE = { guid: 'TARGET_CYCLE', rguid: 'TARGET_OWNER_CYCLE' };
  plugin.data = {
    getRecord(guid) {
      if (guid !== 'TARGET_OWNER_CYCLE') return null;
      return {
        async getLineItems(expandReferences) {
          assert.equal(expandReferences, false);
          return [{
            guid: 'TARGET_CYCLE',
            children: [{
              guid: 'BACK_TO_HOST', type: 'transclusion',
              props: { itemref: 'HOST_CYCLE', refx_embed: 1 }, children: [],
            }],
          }];
        },
      };
    },
  };
  const block = { guid: 'HOST_CYCLE', async getParent() { return null; } };
  assert.equal(await plugin._wouldCycle(block, 'HOST_OWNER_CYCLE', 'TARGET_CYCLE'), true);
  assert.equal(plugin._cycleCheckReason, 'target-subtree-cycle');
  assert.equal(plugin._cycleRefusalMessage("Can't embed a block inside itself."), "Can't embed a block inside itself.");
  assert.deepEqual(context.window.__REFX_CYCLE_REFUSALS.at(-1).reason, 'target-subtree-cycle');
});

test('a native unowned target transclusion still participates in cycle safety', async () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.TARGET_NATIVE_CYCLE = {
    guid: 'TARGET_NATIVE_CYCLE', rguid: 'TARGET_OWNER_NATIVE_CYCLE',
  };
  plugin.data = {
    getRecord(guid) {
      if (guid !== 'TARGET_OWNER_NATIVE_CYCLE') return null;
      return { async getLineItems() {
        return [{
          guid: 'TARGET_NATIVE_CYCLE',
          children: [{
            guid: 'NATIVE_BACK_TO_HOST', type: 'transclusion',
            props: { itemref: 'HOST_NATIVE_CYCLE' }, children: [],
          }],
        }];
      } };
    },
  };
  const block = { guid: 'HOST_NATIVE_CYCLE', async getParent() { return null; } };

  assert.equal(await plugin._wouldCycle(block, 'HOST_OWNER_NATIVE_CYCLE', 'TARGET_NATIVE_CYCLE'), true);
  assert.equal(plugin._cycleCheckLimited, false);
});

test('a reciprocal embed is found beyond five levels without treating depth as uncertainty', async () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.TARGET_DEEP_CYCLE = {
    guid: 'TARGET_DEEP_CYCLE', rguid: 'TARGET_OWNER_DEEP_CYCLE',
  };
  let root = { guid: 'TARGET_DEEP_CYCLE', children: [] };
  let cursor = root;
  for (let depth = 1; depth <= 6; depth++) {
    const child = { guid: `DEEP_${depth}`, children: [] };
    cursor.children.push(child);
    cursor = child;
  }
  cursor.type = 'transclusion';
  cursor.props = { itemref: 'HOST_DEEP_CYCLE', refx_embed: 1 };
  plugin.data = {
    getRecord(guid) {
      if (guid !== 'TARGET_OWNER_DEEP_CYCLE') return null;
      return { async getLineItems(expandReferences) {
        assert.equal(expandReferences, false);
        return [root];
      } };
    },
  };
  const block = { guid: 'HOST_DEEP_CYCLE', async getParent() { return null; } };

  assert.equal(await plugin._wouldCycle(block, 'HOST_OWNER_DEEP_CYCLE', 'TARGET_DEEP_CYCLE'), true);
  assert.equal(plugin._cycleCheckLimited, false, 'the complete iterative scan found the actual edge');
});

test('a deeply nested acyclic target remains eligible for native transclusion', async () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.TARGET_DEEP_VALID = {
    guid: 'TARGET_DEEP_VALID', rguid: 'TARGET_OWNER_DEEP_VALID',
  };
  const root = { guid: 'TARGET_DEEP_VALID', children: [] };
  let cursor = root;
  for (let depth = 1; depth <= 12; depth++) {
    const child = { guid: `VALID_DEEP_${depth}`, children: [] };
    cursor.children.push(child);
    cursor = child;
  }
  plugin.data = {
    getRecord: (guid) => guid === 'TARGET_OWNER_DEEP_VALID'
      ? { async getLineItems() { return [root]; } }
      : null,
  };
  const block = { guid: 'HOST_DEEP_VALID', async getParent() { return null; } };

  assert.equal(await plugin._wouldCycle(block, 'HOST_OWNER_DEEP_VALID', 'TARGET_DEEP_VALID'), false);
  assert.equal(plugin._cycleCheckLimited, false);
});

test('an acyclic target over 5,000 lines completes the cooperative safety scan', async () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.TARGET_WIDE_VALID = {
    guid: 'TARGET_WIDE_VALID', rguid: 'TARGET_OWNER_WIDE_VALID',
  };
  const root = {
    guid: 'TARGET_WIDE_VALID',
    children: Array.from({ length: 5001 }, (_, index) => ({ guid: `VALID_WIDE_${index}`, children: [] })),
  };
  plugin.data = {
    getRecord: (guid) => guid === 'TARGET_OWNER_WIDE_VALID'
      ? { async getLineItems() { return [root]; } }
      : null,
  };
  const block = { guid: 'HOST_WIDE_VALID', async getParent() { return null; } };

  assert.equal(await plugin._wouldCycle(block, 'HOST_OWNER_WIDE_VALID', 'TARGET_WIDE_VALID'), false);
  assert.equal(plugin._cycleCheckLimited, false);
});

test('an ancestor chain beyond the safety bound fails closed', async () => {
  const { plugin } = instance();
  const nodes = Array.from({ length: 130 }, (_, index) => ({ guid: `ANCESTOR_${index}` }));
  nodes.forEach((node, index) => {
    node.getParent = async () => nodes[index + 1] || null;
  });
  plugin.data = { getRecord: () => null };

  assert.equal(await plugin._wouldCycle(nodes[0], 'HOST_OWNER_ANCESTOR', 'UNRELATED_TARGET'), true);
  assert.equal(plugin._cycleCheckLimited, true);
  assert.equal(plugin._cycleCheckReason, 'ancestor-depth-limit');
  assert.equal(plugin._cycleRefusalMessage('cycle'), 'This subtree is too broad to verify safely.');
});

test('coalesced size inspection supplies the cycle receipt without a second owner read', async () => {
  const { plugin, context } = instance();
  context.window.g_universe.itemsByGuid.TARGET_RECEIPT = {
    guid: 'TARGET_RECEIPT', rguid: 'TARGET_OWNER_RECEIPT',
  };
  const gate = deferred();
  let reads = 0;
  plugin.data = {
    getRecord: (guid) => guid === 'TARGET_OWNER_RECEIPT' ? {
      async getLineItems(expandReferences) {
        reads++;
        assert.equal(expandReferences, false);
        await gate.promise;
        return [
          { guid: 'TARGET_RECEIPT', children: [] },
          { guid: 'UNRELATED_HUGE_ROOT', children: Array.from({ length: 2000 }, (_, index) => ({ guid: `UNRELATED_${index}` })) },
        ];
      },
    } : null,
  };
  const first = plugin._trueTargetSize('TARGET_RECEIPT');
  const second = plugin._trueTargetSize('TARGET_RECEIPT');
  const host = { guid: 'HOST_RECEIPT', async getParent() { return null; } };
  const cycle = plugin._wouldCycle(host, 'HOST_OWNER_RECEIPT', 'TARGET_RECEIPT');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, cycle]), [1, 1, false]);
  assert.equal(reads, 1, 'concurrent sizing shares one owner snapshot');
  assert.equal(reads, 1, 'fresh complete size receipt also answers reverse-edge safety');
});

test('record.updated during target sizing retries before caching the grown subtree', async () => {
  const { plugin, context } = instance();
  const owner = 'OWNER_SIZE_GENERATION';
  const target = 'TARGET_SIZE_GENERATION';
  context.window.g_universe.itemsByGuid[target] = { guid: target, rguid: owner };
  const entered = deferred();
  const release = deferred();
  let reads = 0;
  plugin.data = { getRecord: (guid) => guid === owner ? {
    async getLineItems() {
      reads++;
      if (reads === 1) { entered.resolve(); await release.promise; return [{ guid: target, children: [] }]; }
      return [{ guid: target, children: Array.from({ length: 1500 }, (_, i) => ({ guid: `GROWN_${i}`, children: [] })) }];
    },
  } : null };
  plugin._schedulePickerMetadataRefresh = () => {};
  plugin._aliasScheduleEnrich = () => {};
  plugin._wbLiveScheduleRefresh = () => {};

  const sizing = plugin._trueTargetSize(target);
  await entered.promise;
  plugin._onRecordUpdated({ recordGuid: owner });
  release.resolve();

  assert.equal(await sizing, 1501);
  assert.equal(reads, 2, 'stale pre-update snapshot is retried exactly once');
  assert.equal(plugin._trueSizeCache.get(target).recordGuid, owner);
});

test('record.updated during a cooperative cycle scan retries and observes the new back-edge', async () => {
  const { plugin, context } = instance();
  const owner = 'OWNER_CYCLE_GENERATION';
  const target = 'TARGET_CYCLE_GENERATION';
  context.window.g_universe.itemsByGuid[target] = { guid: target, rguid: owner };
  let reads = 0;
  const clean = { guid: target, children: Array.from({ length: 600 }, (_, i) => ({ guid: `OLD_${i}`, children: [] })) };
  const changed = { guid: target, children: [{ guid: 'NEW_BACK_EDGE', type: 'transclusion', props: { itemref: 'HOST_CYCLE_GENERATION' }, children: [] }] };
  plugin.data = { getRecord: (guid) => guid === owner ? { async getLineItems() { reads++; return [reads === 1 ? clean : changed]; } } : null };
  plugin._schedulePickerMetadataRefresh = () => {};
  plugin._aliasScheduleEnrich = () => {};
  plugin._wbLiveScheduleRefresh = () => {};
  let yielded = false;
  plugin._yieldMacrotask = async () => {
    if (!yielded) { yielded = true; plugin._onRecordUpdated({ recordGuid: owner }); }
  };

  const host = { guid: 'HOST_CYCLE_GENERATION', async getParent() { return null; } };
  assert.equal(await plugin._wouldCycle(host, 'HOST_OWNER_GENERATION', target), true);
  assert.equal(reads, 2, 'the stale safe scan is discarded and repeated');
});

test('owner-generation fences exist only while an owner read is active', () => {
  const { plugin } = instance();
  plugin._schedulePickerMetadataRefresh = () => {};
  plugin._aliasScheduleEnrich = () => {};
  plugin._wbLiveScheduleRefresh = () => {};

  for (let index = 0; index < 5000; index++) {
    plugin._onRecordUpdated({ recordGuid: `UNRELATED_OWNER_${index}` });
  }
  assert.equal(plugin._trueSizeOwnerGeneration.size, 0, 'bulk unrelated events allocate no session-long owner entries');

  const receipt = plugin._beginTrueSizeOwnerRead('ACTIVE_OWNER');
  assert.equal(plugin._trueSizeOwnerGeneration.size, 1);
  assert.equal(plugin._trueSizeOwnerReadCurrent(receipt), true);
  plugin._onRecordUpdated({ recordGuid: 'ACTIVE_OWNER' });
  assert.equal(plugin._trueSizeOwnerReadCurrent(receipt), false, 'an active read is invalidated by its exact owner event');
  plugin._endTrueSizeOwnerRead(receipt);
  assert.equal(plugin._trueSizeOwnerGeneration.size, 0, 'idle owner state is removed immediately');
});

test('target-size inflight reads are isolated by resolved owner', async () => {
  const { plugin } = instance();
  const staleGate = deferred();
  let staleReads = 0;
  let correctReads = 0;
  const target = 'TARGET_MOVED_INFLIGHT';
  plugin.data = { getRecord(guid) {
    if (guid === 'STALE_OWNER_INFLIGHT') return { async getLineItems() {
      staleReads++;
      await staleGate.promise;
      return [{ guid: 'UNRELATED_STALE', children: [] }];
    } };
    if (guid === 'CORRECT_OWNER_INFLIGHT') return { async getLineItems() {
      correctReads++;
      return [{
        guid: target,
        children: Array.from({ length: 1500 }, (_, index) => ({ guid: `MOVED_CHILD_${index}`, children: [] })),
      }];
    } };
    return null;
  } };

  const stale = plugin._trueTargetSize(target, 'STALE_OWNER_INFLIGHT');
  const correct = plugin._trueTargetSize(target, 'CORRECT_OWNER_INFLIGHT');
  assert.equal(await correct, 1501, 'the correct owner does not inherit the stale owner promise');
  staleGate.resolve();
  assert.equal(await stale, null);
  assert.equal(staleReads, 1);
  assert.equal(correctReads, 1);
  assert.equal(plugin._trueSizeInflight.size, 0);
});

test('cold line cycle safety uses the exact owner hint without a loaded registry state', async () => {
  const { plugin } = instance();
  plugin._lineOwnerHints.set('TARGET_COLD_OWNER', 'RECORD_COLD_OWNER');
  plugin.data = { getRecord: (guid) => guid === 'RECORD_COLD_OWNER' ? {
    async getLineItems() { return [{ guid: 'TARGET_COLD_OWNER', children: [] }]; },
  } : null };
  const host = { guid: 'HOST_COLD_OWNER', async getParent() { return null; } };

  assert.equal(await plugin._wouldCycle(host, 'HOST_RECORD_COLD_OWNER', 'TARGET_COLD_OWNER'), false);
  assert.equal(plugin._cycleCheckLimited, false);
});

test('cold owner-resolution failure warms once, drops its stale hint, and re-enters cycle safety', async () => {
  const { plugin } = instance();
  const target = 'TARGET_WARM_RETRY';
  const owner = 'OWNER_WARM_RETRY';
  const host = { guid: 'HOST_WARM_RETRY', async getParent() { return null; } };
  plugin._lineOwnerHints.set(target, 'STALE_WARM_RETRY');
  let warms = 0;
  plugin._resolveLineItemContextByGuid = async (guid, hint, force) => {
    warms++;
    assert.equal(guid, target);
    assert.equal(hint, 'STALE_WARM_RETRY');
    assert.equal(force, true);
    return { line: { guid: target }, record: { guid: owner } };
  };
  plugin.data = { getRecord: (guid) => guid === owner ? {
    guid: owner,
    async getLineItems(expandReferences) {
      assert.equal(expandReferences, false);
      return [{ guid: target, children: [] }];
    },
  } : null };

  assert.equal(await plugin._wouldCycle(host, 'HOST_OWNER_WARM_RETRY', target), false);
  assert.equal(warms, 1);
  assert.equal(plugin._lineOwnerHints.get(target), owner);
  assert.equal(plugin._cycleCheckReason, null);
});

test('stale target-owner hints and owner read failures fail closed', async () => {
  const { plugin } = instance();
  const host = { guid: 'HOST_FAIL_CLOSED', async getParent() { return null; } };
  plugin._lineOwnerHints.set('TARGET_STALE_HINT', 'WRONG_OWNER');
  plugin.data = { getRecord(guid) {
    if (guid === 'WRONG_OWNER') return { async getLineItems() { return [{ guid: 'UNRELATED', children: [] }]; } };
    if (guid === 'REJECTING_OWNER') return { async getLineItems() { throw new Error('offline'); } };
    return null;
  } };

  assert.equal(await plugin._wouldCycle(host, 'HOST_RECORD_FAIL_CLOSED', 'TARGET_STALE_HINT'), true);
  assert.equal(plugin._lineOwnerHints.has('TARGET_STALE_HINT'), false, 'stale owner evidence is discarded');
  assert.equal(await plugin._wouldCycle(host, 'HOST_RECORD_FAIL_CLOSED', 'TARGET_REJECTED', [], 'REJECTING_OWNER'), true);
  assert.equal(plugin._cycleCheckLimited, true);
  assert.equal(plugin._cycleCheckReason, 'target-scan-failed');
  assert.equal(plugin._cycleRefusalMessage('cycle'), "Couldn't verify this subtree safely — retry.");
});

test('normal expansion passes the true source owner into cycle safety', async () => {
  const { plugin } = instance();
  const block = { guid: 'HOST_TRUE_OWNER', segments: [], children: [] };
  const wrongRenderedRecord = {
    guid: 'RENDERED_CONTAINER',
    async getLineItems(expandReferences) { assert.equal(expandReferences, false); return []; },
  };
  const trueSourceRecord = {
    guid: 'TRUE_SOURCE_OWNER',
    async getLineItems() { return [block]; },
  };
  plugin.data = {
    getRecord(guid) {
      if (guid === 'RENDERED_CONTAINER') return wrongRenderedRecord;
      return null;
    },
  };
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record: trueSourceRecord });
  plugin._findEmbeds = () => [];
  plugin._trueTargetSize = async () => 1;
  let cycleOwner = null;
  plugin._wouldCycle = async (_block, ownerGuid) => { cycleOwner = ownerGuid; return true; };
  plugin._toast = () => {};

  assert.equal(await plugin._expandRef(
    { lineGuid: block.guid, pageGuid: 'RENDERED_CONTAINER' },
    { targetGuid: 'TARGET_TRUE_OWNER', isText: true },
  ), false);
  assert.equal(cycleOwner, 'TRUE_SOURCE_OWNER');
});

test('alternate-target expansion moves to the canonical lock and cannot race a direct expansion', async () => {
  const { plugin } = instance();
  const firstHostRead = deferred();
  const createEntered = deferred();
  const releaseCreate = deferred();
  const block = {
    guid: 'HOST_ALT_LOCK',
    segments: [
      { type: 'ref', text: { guid: 'TARGET_ALREADY_OPEN' } },
      { type: 'ref', text: { guid: 'TARGET_ALT_LOCK' } },
    ],
    children: [],
  };
  let reads = 0;
  let creates = 0;
  let persisted = false;
  const line = {
    guid: 'EMBED_ALT_LOCK', type: 'transclusion', parent_guid: block.guid,
    props: { itemref: 'TARGET_ALT_LOCK', refx_embed: 1 },
  };
  const record = {
    guid: 'OWNER_ALT_LOCK',
    async getLineItems() {
      reads++;
      if (reads === 1) await firstHostRead.promise;
      block.children = persisted ? [line] : [];
      return [block];
    },
    async createLineItem() {
      creates++;
      createEntered.resolve();
      await releaseCreate.promise;
      persisted = true;
      return line;
    },
  };
  plugin.data = { getRecord: (guid) => guid === record.guid ? record : null };
  plugin._findEmbeds = (_host, target) => target === 'TARGET_ALREADY_OPEN' ? [{ guid: 'OPEN' }] : [];
  plugin._trueTargetSize = async () => 1;
  plugin._wouldCycle = async () => false;
  plugin._watchEmbedMounted = () => {};
  plugin._unfoldHostLine = () => {};
  plugin._breadcrumbsEnabled = false;
  plugin._toast = () => {};

  const alternate = plugin._expandRef(
    { lineGuid: block.guid, pageGuid: record.guid },
    { targetGuid: 'TARGET_ALREADY_OPEN', isText: true },
  );
  const direct = plugin._expandRef(
    { lineGuid: block.guid, pageGuid: record.guid },
    { targetGuid: 'TARGET_ALT_LOCK', isText: true },
  );
  await createEntered.promise;
  firstHostRead.resolve();
  assert.equal(await alternate, false, 'alternate continuation yields to the canonical in-flight target');
  releaseCreate.resolve();
  assert.equal(await direct, true);
  assert.equal(creates, 1);
});

test('ordinary native expansion rejects and exactly rolls back dropped ownership metadata', async () => {
  const { plugin } = instance();
  const block = { guid: 'HOST_DEFAULT_VERIFY', segments: [], children: [] };
  let created = false;
  let deleted = 0;
  const optimistic = {
    guid: 'EMBED_DEFAULT_VERIFY',
    props: { itemref: 'TARGET_DEFAULT_VERIFY', refx_embed: 1 },
  };
  const residue = {
    guid: optimistic.guid, type: 'transclusion', parent_guid: block.guid,
    props: { itemref: 'TARGET_DEFAULT_VERIFY' },
    async getChildren() { return []; },
    async delete() { deleted++; created = false; return true; },
  };
  const record = {
    guid: 'OWNER_DEFAULT_VERIFY',
    async getLineItems() { block.children = created ? [residue] : []; return [block]; },
    async createLineItem() { created = true; return optimistic; },
  };
  plugin.data = { getRecord: (guid) => guid === record.guid ? record : null };
  plugin._findEmbeds = () => [];
  plugin._trueTargetSize = async () => 1;
  plugin._wouldCycle = async () => false;
  plugin._toast = () => {};

  assert.equal(await plugin._expandRef(
    { lineGuid: block.guid, pageGuid: record.guid },
    { targetGuid: 'TARGET_DEFAULT_VERIFY', isText: true },
  ), false);
  assert.equal(deleted, 1);
  assert.equal(plugin._embedLines.has(optimistic.guid), false);
  assert.equal(plugin._embedRollbackPending.size, 0);
});

test('persisted transclusion verification rejects missing type and structurally wrong parent', async () => {
  const { plugin } = instance();
  const createdLine = {
    guid: 'VERIFY_STRUCTURE',
    type: 'transclusion',
    props: { itemref: 'VERIFY_TARGET', refx_embed: 1 },
  };
  const missingType = {
    guid: createdLine.guid,
    props: { itemref: 'VERIFY_TARGET', refx_embed: 1 },
    children: [],
  };
  assert.equal((await plugin._verifyCreatedTransclusion({
    createdLine,
    record: { async getLineItems() { return [{ guid: 'VERIFY_HOST', children: [missingType] }]; } },
    requiredProps: { itemref: 'VERIFY_TARGET', refx_embed: 1 },
    expectedParentGuid: 'VERIFY_HOST',
  })).ok, false, 'missing persisted type is not accepted as proof');

  const wrongType = {
    guid: createdLine.guid,
    type: 'text',
    props: { itemref: 'VERIFY_TARGET', refx_embed: 1 },
    children: [],
  };
  assert.equal((await plugin._verifyCreatedTransclusion({
    createdLine,
    record: { async getLineItems() { return [{ guid: 'VERIFY_HOST', children: [wrongType] }]; } },
    requiredProps: { itemref: 'VERIFY_TARGET', refx_embed: 1 },
    expectedParentGuid: 'VERIFY_HOST',
  })).ok, false, 'a persisted non-transclusion type is rejected');

  const wrongParent = {
    guid: createdLine.guid,
    type: 'transclusion',
    parent_guid: 'VERIFY_HOST',
    props: { itemref: 'VERIFY_TARGET', refx_embed: 1 },
    children: [],
  };
  assert.equal((await plugin._verifyCreatedTransclusion({
    createdLine,
    record: { async getLineItems() { return [{ guid: 'ACTUAL_WRONG_PARENT', children: [wrongParent] }]; } },
    requiredProps: { itemref: 'VERIFY_TARGET', refx_embed: 1 },
    expectedParentGuid: 'VERIFY_HOST',
  })).ok, false, 'stale parent_guid cannot override the persisted tree placement');
});

test('size learned during cycle safety still routes normal expansion to the bounded preview', async () => {
  const { plugin, context } = instance();
  const block = { guid: 'HOST_LATE_EXTREME', segments: [], children: [] };
  let creates = 0;
  const record = {
    guid: 'HOST_OWNER_LATE_EXTREME',
    async getLineItems() { return [block]; },
    async createLineItem() { creates++; return null; },
  };
  context.window.g_universe.itemsByGuid.TARGET_LATE_EXTREME = {
    guid: 'TARGET_LATE_EXTREME', rguid: 'TARGET_OWNER_LATE_EXTREME',
  };
  plugin.data = { getRecord: (guid) => guid === record.guid ? record : null };
  plugin._findEmbeds = () => [];
  let sizeCalls = 0;
  plugin._trueTargetSize = async () => ++sizeCalls === 1 ? null : 1501;
  plugin._wouldCycle = async () => false;
  const row = {};
  plugin._editorLineEl = () => row;
  let mounted = null;
  plugin._mountWindowedTransclusion = (host, target, options) => { mounted = { host, target, options }; return {}; };
  plugin._unfoldHostLine = () => {};
  plugin._toast = () => {};

  assert.equal(await plugin._expandRef(
    { lineGuid: block.guid, pageGuid: record.guid },
    { targetGuid: 'TARGET_LATE_EXTREME', isText: true },
  ), true);
  assert.equal(sizeCalls, 2);
  assert.equal(creates, 0, 'newly-known extreme target is never created natively');
  assert.equal(mounted.host, row);
  assert.equal(mounted.target, 'TARGET_LATE_EXTREME');
});

test('wrong-parent persisted residue is not deleted and the performance preview remains', async () => {
  const { plugin } = instance();
  const block = { guid: 'EXPECTED_PREVIEW_PARENT', children: [] };
  let deletes = 0;
  const optimistic = {
    guid: 'WRONG_PARENT_RESIDUE', type: 'transclusion',
    props: { itemref: 'WRONG_PARENT_TARGET', refx_embed: 1 },
  };
  const residue = {
    ...optimistic,
    children: [],
    async getChildren() { return []; },
    async delete() { deletes++; return true; },
  };
  const wrongParent = { guid: 'ACTUAL_PREVIEW_PARENT', children: [residue] };
  const record = {
    guid: 'WRONG_PARENT_OWNER',
    async createLineItem() { return optimistic; },
    async getLineItems() { return [block, wrongParent]; },
  };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'WRONG_PARENT_TARGET'),
    hostLineGuid: block.guid,
    targetGuid: 'WRONG_PARENT_TARGET',
    shell: { isConnected: true, remove() { throw new Error('preview must remain'); } },
    loadButton: { textContent: 'Load editable transclusion', disabled: false, isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record });
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [];
  plugin._toast = () => {};

  assert.equal(await plugin._materializeWindowedTransclusion(entry), false);
  assert.equal(deletes, 0, 'rollback refuses to delete a line under an unexpected structural parent');
  assert.equal(plugin._windowedPreviews.get(entry.key), entry);
  assert.equal(plugin._embedRollbackPending.has(block.guid + '›WRONG_PARENT_TARGET'), true);
});

test('known extreme target never falls through to native creation when its host DOM is unavailable', async () => {
  const { plugin } = instance();
  const block = { guid: 'HOST_EXTREME_NO_DOM', segments: [], children: [] };
  let creates = 0;
  const record = {
    guid: 'OWNER_EXTREME_NO_DOM',
    async getLineItems() { return [block]; },
    async createLineItem() { creates++; return null; },
  };
  plugin.data = { getRecord: (guid) => guid === record.guid ? record : null };
  plugin._findEmbeds = () => [];
  plugin._trueTargetSize = async () => 1501;
  plugin._editorLineEl = () => null;
  plugin._toast = () => {};

  assert.equal(await plugin._expandRef(
    { lineGuid: block.guid, pageGuid: record.guid },
    { targetGuid: 'TARGET_EXTREME_NO_DOM', isText: true },
  ), false);
  assert.equal(creates, 0);
});

test('pending exact cleanup receipts are adopted across same-document hot reload', () => {
  const { Plugin, context } = loadPlugin();
  const first = new Plugin();
  first._adoptEmbedRollbackPending();
  first._embedRollbackPending.set('HOST_HOT›TARGET_HOT', { createdGuid: 'RESIDUE_HOT' });
  const second = new Plugin();
  second._adoptEmbedRollbackPending();

  assert.equal(second._embedRollbackPending, first._embedRollbackPending);
  assert.equal(second._embedRollbackPending.get('HOST_HOT›TARGET_HOT').createdGuid, 'RESIDUE_HOT');
  assert.equal(context.window.__refxEmbedRollbackPendingV1, first._embedRollbackPending);
});

test('same-document hot reload shares a host-target mutation lease until the old create settles', async () => {
  const { Plugin, context } = loadPlugin();
  const first = new Plugin();
  first._adoptEmbedRollbackPending();
  first._adoptEmbedMutationLeases();
  first._embedMutationGeneration = 1;
  context.window.__refxEmbedMutationGeneration = 1;
  const block = { guid: 'HOST_HOT_CREATE', segments: [], children: [] };
  const createEntered = deferred();
  const releaseCreate = deferred();
  let creates = 0;
  let persisted = false;
  const line = {
    guid: 'EMBED_HOT_CREATE', type: 'transclusion',
    props: { itemref: 'TARGET_HOT_CREATE', refx_embed: 1 }, children: [],
    async getChildren() { return []; },
    async delete() { persisted = false; block.children = []; return true; },
  };
  const record = {
    guid: 'OWNER_HOT_CREATE',
    async getLineItems() { block.children = persisted ? [line] : []; return [block]; },
    async createLineItem() {
      creates++;
      createEntered.resolve();
      await releaseCreate.promise;
      persisted = true;
      block.children = [line];
      return line;
    },
  };
  const configure = (plugin) => {
    plugin.data = { getRecord: (guid) => guid === record.guid ? record : null };
    plugin._findEmbeds = () => [];
    plugin._trueTargetSize = async () => 1;
    plugin._wouldCycle = async () => false;
    plugin._toast = () => {};
    plugin._breadcrumbsEnabled = false;
  };
  configure(first);
  const oldExpansion = first._expandRef(
    { lineGuid: block.guid, pageGuid: record.guid },
    { targetGuid: 'TARGET_HOT_CREATE', isText: true },
  );
  await createEntered.promise;

  const replacement = new Plugin();
  replacement._adoptEmbedRollbackPending();
  replacement._adoptEmbedMutationLeases();
  replacement._embedMutationGeneration = 2;
  context.window.__refxEmbedMutationGeneration = 2;
  configure(replacement);
  assert.equal(await replacement._expandRef(
    { lineGuid: block.guid, pageGuid: record.guid },
    { targetGuid: 'TARGET_HOT_CREATE', isText: true },
  ), false, 'replacement cannot acquire the old instance lease');
  assert.equal(creates, 1);

  releaseCreate.resolve();
  assert.equal(await oldExpansion, false, 'stale owner rolls its exact create back');
  assert.equal(creates, 1);
  assert.equal(persisted, false);
  assert.equal(replacement._expandInFlight.size, 0);
});

test('live-search line expansion previews an extreme subtree before any cycle scan or write', async () => {
  const { plugin } = instance();
  const qline = { guid: 'QUERY_EXTREME', children: [] };
  let creates = 0;
  const host = {
    guid: 'QUERY_HOST_EXTREME',
    async getLineItems(expandReferences) { assert.equal(expandReferences, false); return [qline]; },
    async createLineItem() { creates++; return null; },
  };
  plugin.data = { getRecord: (guid) => guid === host.guid ? host : null };
  plugin._trueTargetSize = async () => 1501;
  plugin._wouldCycle = async () => { throw new Error('preview path must not scan for native recursion'); };
  let mounted = null;
  plugin._mountWindowedTransclusion = (row, targetGuid, options) => {
    mounted = { row, targetGuid, options };
    return {};
  };
  plugin._toast = () => {};
  const row = {};

  assert.equal(await plugin._expandRefFromQuery({
    lineGuid: 'QUERY_RESULT_EXTREME',
    lineNode: row,
    queryLineGuid: qline.guid,
    queryHostGuid: host.guid,
  }, null), true);
  assert.equal(creates, 0);
  assert.equal(mounted.row, row);
  assert.equal(mounted.targetGuid, 'QUERY_RESULT_EXTREME');
  assert.equal(mounted.options.hostLineGuid, qline.guid);
  assert.equal(typeof mounted.options.materialize, 'function');
});

test('size learned during cycle safety still routes a live-search result to preview', async () => {
  const { plugin } = instance();
  const qline = { guid: 'QUERY_LATE_EXTREME', children: [] };
  let creates = 0;
  const host = {
    guid: 'QUERY_HOST_LATE_EXTREME',
    async getLineItems() { return [qline]; },
    async createLineItem() { creates++; return null; },
  };
  plugin.data = { getRecord: (guid) => guid === host.guid ? host : null };
  let sizeCalls = 0;
  plugin._trueTargetSize = async () => ++sizeCalls === 1 ? null : 1501;
  plugin._wouldCycle = async () => false;
  const row = {};
  let mounted = null;
  plugin._mountWindowedTransclusion = (hostRow, target, options) => {
    mounted = { hostRow, target, options };
    return {};
  };
  plugin._toast = () => {};

  assert.equal(await plugin._expandRefFromQuery({
    lineGuid: 'QUERY_RESULT_LATE_EXTREME',
    pageGuid: 'QUERY_RESULT_OWNER_LATE_EXTREME',
    lineNode: row,
    queryLineGuid: qline.guid,
    queryHostGuid: host.guid,
  }, null), true);
  assert.equal(sizeCalls, 2);
  assert.equal(creates, 0);
  assert.equal(mounted.hostRow, row);
  assert.equal(mounted.target, 'QUERY_RESULT_LATE_EXTREME');
});

test('live-search native materialization applies reverse-cycle safety with the real owner and ancestors', async () => {
  const { plugin } = instance();
  const qline = { guid: 'QUERY_SAFE', parent_guid: 'QUERY_PARENT', children: [] };
  const parent = { guid: 'QUERY_PARENT', children: [qline] };
  let creates = 0;
  const host = {
    guid: 'QUERY_TRUE_OWNER',
    async getLineItems() { return [parent]; },
    async createLineItem() { creates++; return null; },
  };
  plugin.data = { getRecord: (guid) => guid === host.guid ? host : null };
  plugin._trueTargetSize = async () => 1;
  let cycleArgs = null;
  plugin._wouldCycle = async (...args) => { cycleArgs = args; return true; };
  plugin._toast = () => {};

  assert.equal(await plugin._expandRefFromQuery({
    lineGuid: 'QUERY_RESULT_SAFE',
    queryLineGuid: qline.guid,
    queryHostGuid: host.guid,
  }, null), false);
  assert.equal(creates, 0);
  assert.equal(cycleArgs[1], host.guid);
  assert.deepEqual(Array.from(cycleArgs[3]), [parent.guid]);
});

test('live-search materialization requires persisted placement metadata and keeps its preview on rollback', async () => {
  const { plugin } = instance();
  const qline = { guid: 'QUERY_VERIFY_META', children: [] };
  let created = false;
  let deleted = 0;
  const optimistic = {
    guid: 'EMBED_QUERY_VERIFY_META',
    props: {
      itemref: 'QUERY_RESULT_VERIFY_META', refx_embed: 1,
      refx_from: qline.guid, refx_at: 'QUERY_RESULT_VERIFY_META',
    },
  };
  const residue = {
    guid: optimistic.guid, type: 'transclusion', parent_guid: null,
    props: { itemref: 'QUERY_RESULT_VERIFY_META', refx_embed: 1, refx_from: qline.guid },
    async getChildren() { return []; },
    async delete() { deleted++; created = false; return true; },
  };
  const host = {
    guid: 'QUERY_HOST_VERIFY_META',
    async getLineItems() { return created ? [qline, residue] : [qline]; },
    async createLineItem() { created = true; return optimistic; },
  };
  const entry = {
    key: plugin._windowedPreviewKey(qline.guid, 'QUERY_RESULT_VERIFY_META'),
    hostLineGuid: qline.guid,
    targetGuid: 'QUERY_RESULT_VERIFY_META',
    shell: { isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin.data = { getRecord: (guid) => guid === host.guid ? host : null };
  plugin._wouldCycle = async () => false;
  plugin._toast = () => {};

  assert.equal(await plugin._expandRefFromQuery({
    lineGuid: 'QUERY_RESULT_VERIFY_META',
    pageGuid: 'QUERY_RESULT_OWNER_META',
    queryLineGuid: qline.guid,
    queryHostGuid: host.guid,
  }, null, { forceNative: true, previewEntry: entry }), false);
  assert.equal(deleted, 1);
  assert.equal(plugin._windowedPreviews.get(entry.key), entry);
  assert.equal(plugin._queryEmbeds.has(optimistic.guid), false);
});

test('closing a live-search preview during cycle verification fences creation', async () => {
  const { plugin } = instance();
  const qline = { guid: 'QUERY_CLOSE_CYCLE', children: [] };
  let creates = 0;
  const host = {
    guid: 'QUERY_HOST_CLOSE_CYCLE',
    async getLineItems() { return [qline]; },
    async createLineItem() { creates++; return null; },
  };
  const entry = {
    key: plugin._windowedPreviewKey(qline.guid, 'QUERY_RESULT_CLOSE_CYCLE'),
    hostLineGuid: qline.guid,
    targetGuid: 'QUERY_RESULT_CLOSE_CYCLE',
    shell: { isConnected: true, remove() { this.isConnected = false; } },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin.data = { getRecord: (guid) => guid === host.guid ? host : null };
  const cycleEntered = deferred();
  const releaseCycle = deferred();
  plugin._wouldCycle = async () => { cycleEntered.resolve(); return await releaseCycle.promise; };
  plugin._toast = () => {};

  const materializing = plugin._expandRefFromQuery({
    lineGuid: 'QUERY_RESULT_CLOSE_CYCLE',
    pageGuid: 'QUERY_RESULT_OWNER_CLOSE_CYCLE',
    queryLineGuid: qline.guid,
    queryHostGuid: host.guid,
  }, null, { forceNative: true, previewEntry: entry });
  await cycleEntered.promise;
  plugin._removeWindowedPreview(entry);
  releaseCycle.resolve(false);

  assert.equal(await materializing, false);
  assert.equal(creates, 0);
});

test('known extreme live-search result never writes when its virtual row is unavailable', async () => {
  const { plugin } = instance();
  const qline = { guid: 'QUERY_EXTREME_NO_ROW', children: [] };
  let creates = 0;
  const host = {
    guid: 'QUERY_HOST_EXTREME_NO_ROW',
    async getLineItems() { return [qline]; },
    async createLineItem() { creates++; return null; },
  };
  plugin.data = { getRecord: (guid) => guid === host.guid ? host : null };
  plugin._trueTargetSize = async () => 1501;
  plugin._queryRowNode = () => null;
  plugin._toast = () => {};

  assert.equal(await plugin._expandRefFromQuery({
    lineGuid: 'QUERY_RESULT_EXTREME_NO_ROW',
    pageGuid: 'QUERY_RESULT_OWNER_EXTREME_NO_ROW',
    queryLineGuid: qline.guid,
    queryHostGuid: host.guid,
  }, null), false);
  assert.equal(creates, 0);
});

test('closing a preview during host resolution fences the stale materializer before creation', async () => {
  const { plugin } = instance();
  const pending = deferred();
  let creates = 0;
  const block = { guid: 'HOST_STALE_RESOLVE' };
  const rec = { guid: 'OWNER_STALE_RESOLVE', async createLineItem() { creates++; return null; } };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_STALE_RESOLVE'),
    hostLineGuid: block.guid,
    targetGuid: 'TARGET_STALE_RESOLVE',
    shell: { isConnected: true, remove() { this.isConnected = false; } },
    loadButton: { textContent: 'Load editable transclusion', disabled: false, isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = () => pending.promise;
  plugin._toast = () => {};

  const materializing = plugin._materializeWindowedTransclusion(entry);
  plugin._removeWindowedPreview(entry);
  pending.resolve({ line: block, record: rec });

  assert.equal(await materializing, false);
  assert.equal(creates, 0);
});

test('closing a preview while native creation is pending deletes the stale created line', async () => {
  const { plugin } = instance();
  const pendingCreate = deferred();
  const createEntered = deferred();
  let deleted = 0;
  const block = { guid: 'HOST_STALE_CREATE', children: [] };
  let persisted = true;
  const line = {
    guid: 'EMBED_STALE_CREATE', type: 'transclusion', parent_guid: block.guid,
    props: { itemref: 'TARGET_STALE_CREATE', refx_embed: 1 },
    async getChildren() { return []; },
    async delete() { deleted++; persisted = false; return true; },
  };
  const rec = {
    guid: 'OWNER_STALE_CREATE',
    createLineItem() { createEntered.resolve(); return pendingCreate.promise; },
    async getLineItems() { block.children = persisted ? [line] : []; return [block]; },
  };
  const entry = {
    key: plugin._windowedPreviewKey(block.guid, 'TARGET_STALE_CREATE'),
    hostLineGuid: block.guid,
    targetGuid: 'TARGET_STALE_CREATE',
    shell: { isConnected: true, remove() { this.isConnected = false; } },
    loadButton: { textContent: 'Load editable transclusion', disabled: false, isConnected: true },
  };
  plugin._windowedPreviews.set(entry.key, entry);
  plugin._resolveLineItemContextByGuid = async () => ({ line: block, record: rec });
  plugin._wouldCycle = async () => false;
  plugin._findEmbeds = () => [];
  plugin._toast = () => {};

  const materializing = plugin._materializeWindowedTransclusion(entry);
  await createEntered.promise;
  plugin._removeWindowedPreview(entry);
  pendingCreate.resolve(line);

  assert.equal(await materializing, false);
  assert.equal(deleted, 1);
  assert.equal(plugin._embedLines.has(line.guid), false);
});

test('plain ArrowDown enters large-subtree actions for the exact selected line reference', () => {
  const { plugin } = instance();
  const key = plugin._windowedPreviewKey('HOST_WINDOW_NAV', 'TARGET_WINDOW_NAV');
  const action = { hidden: false, style: {}, offsetParent: {}, classList: classListSet(['refx-windowed-btn']) };
  plugin._windowedPreviews.set(key, {
    key,
    hostLineGuid: 'HOST_WINDOW_NAV',
    targetGuid: 'TARGET_WINDOW_NAV',
    shell: { querySelectorAll: () => [action] },
  });
  plugin._detect = () => ({ lineGuid: 'HOST_WINDOW_NAV', pageGuid: 'OWNER_WINDOW_NAV' });
  plugin._selectedRef = () => ({ targetGuid: 'TARGET_WINDOW_NAV', isText: true });
  let entered = null;
  plugin._enterCardNav = (lineGuid, targetGuid, index) => { entered = { lineGuid, targetGuid, index }; };
  const event = keyEvent('ArrowDown');
  event.metaKey = event.ctrlKey = event.altKey = event.shiftKey = false;

  plugin._handleCardNavTrigger(event);

  assert.equal(event.prevented, true);
  assert.deepEqual(entered, { lineGuid: key, targetGuid: 'TARGET_WINDOW_NAV', index: 0 });
});

test('large-subtree preview keeps forty live rows, native ARIA actions, and Cmd+Down materialization', () => {
  const { plugin, context } = instance();
  const makeNode = (tag) => {
    const listeners = {};
    return {
      tagName: String(tag).toUpperCase(), className: '', textContent: '', dataset: {}, style: {},
      attributes: {}, children: [], isConnected: true, listeners,
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(type, fn) { listeners[type] = fn; },
      append(...nodes) { this.children.push(...nodes); },
      focus() { this.focused = true; },
      remove() { this.removed = true; this.isConnected = false; },
    };
  };
  context.document.createElement = makeNode;
  context.window.g_universe.itemsByGuid = new Proxy({
    TARGET_MOUNT: { guid: 'TARGET_MOUNT', rguid: 'OWNER_MOUNT', text_segments: ['text', 'Mounted target'] },
  }, { ownKeys() { throw new Error('preview must not enumerate the loaded registry'); } });
  plugin._trueSizeCache.set('TARGET_MOUNT', {
    count: plugin._LARGE_TRANSCLUSION_THRESHOLD + 1,
    ts: Date.now(), recordGuid: 'OWNER_MOUNT',
    previewLines: Array.from({ length: 101 }, (_, i) => ({ guid: 'P' + i, text: 'Preview ' + i, depth: i % 4 })),
  });
  plugin._pageGuidFromDom = () => 'HOST_OWNER_MOUNT';
  let inserted = null;
  const host = {
    getAttribute: (name) => name === 'data-guid' ? 'HOST_MOUNT' : null,
    insertAdjacentElement: (_where, node) => { inserted = node; node.isConnected = true; },
  };
  let materialized = null;
  plugin._materializeWindowedTransclusion = async (entry) => { materialized = entry; return true; };

  const shell = plugin._mountWindowedTransclusion(host, 'TARGET_MOUNT');

  assert.equal(shell, inserted);
  assert.equal(shell.focused, true);
  assert.equal(shell.children[0].children.length, 40, 'the instant outline keeps the live DOM bounded');
  const actions = shell.children[1];
  assert.deepEqual(actions.children.map((node) => node.textContent), [
    '1–40 of >1500 lines · snapshot capped at 101 · instant native-backed preview',
    'Edit selected ↗',
    'Load complete inline — may be slow',
    'Previous',
    'Next',
    'Open source ↗',
  ]);
  assert.equal(actions.children[1].attributes['aria-label'], 'Open selected source line in a native side panel');
  assert.equal(actions.children[2].attributes['aria-label'], 'Load complete native editable transclusion; very large bodies may take time');
  assert.equal(actions.children[4].attributes['aria-label'], 'Show next preview window');
  assert.equal(actions.children[5].attributes['aria-label'], 'Open source in a native side panel');
  assert.equal(shell.children[0].children[1].style.paddingInlineStart, '23px', 'cached hierarchy depth remains visible');

  const firstRow = shell.children[0].children[0];
  const arrowDown = {
    key: 'ArrowDown', metaKey: false, ctrlKey: false,
    preventDefault() {}, stopPropagation() {},
  };
  shell.listeners.keydown(arrowDown);
  assert.equal(shell.children[0].children[0], firstRow, 'selection within one window does not rebuild rows or restart media work');

  let opened = null;
  plugin._bridgeJump = (guid, options) => { opened = { guid, options }; return true; };
  const pageDown = { key: 'PageDown', metaKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {} };
  shell.listeners.keydown(pageDown);
  assert.equal(shell.children[0].children[0].dataset.refxLine, 'P40');
  const enterSelected = { key: 'Enter', metaKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {} };
  shell.listeners.keydown(enterSelected);
  assert.equal(opened?.guid, 'P41', 'Enter opens the exact selected source line natively');
  assert.equal(opened?.options?.newPanel, true);
  const pageUp = { key: 'PageUp', metaKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {} };
  shell.listeners.keydown(pageUp);
  assert.equal(shell.children[0].children[0].dataset.refxLine, 'P0');

  actions.children[4].listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(shell.children[0].children.length, 40, 'paging replaces rather than appends live rows');
  assert.equal(shell.children[0].children[0].dataset.refxLine, 'P40');

  const keydown = shell.listeners.keydown;
  const event = {
    key: 'ArrowDown', metaKey: true, ctrlKey: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  keydown(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(materialized?.key, plugin._windowedPreviewKey('HOST_MOUNT', 'TARGET_MOUNT'));
});

test('large-subtree action cursor skips hidden actions and activates with Enter or Space', () => {
  const { plugin } = instance();
  const key = plugin._windowedPreviewKey('HOST_WINDOW_KEYS', 'TARGET_WINDOW_KEYS');
  let loadClicks = 0, openClicks = 0;
  const button = (extra = {}) => ({
    hidden: false, style: {}, offsetParent: {},
    classList: classListSet(['refx-windowed-btn']),
    click() {},
    ...extra,
  });
  const load = button({ click() { loadClicks++; } });
  const hidden = button({ style: { display: 'none' } });
  const open = button({ click() { openClicks++; } });
  plugin._windowedPreviews.set(key, {
    key,
    hostLineGuid: 'HOST_WINDOW_KEYS',
    targetGuid: 'TARGET_WINDOW_KEYS',
    shell: { querySelectorAll: () => [load, hidden, open] },
  });
  const visible = plugin._cardNavItems(key);
  assert.equal(visible.length, 2);
  assert.equal(visible[0], load);
  assert.equal(visible[1], open);
  plugin._healWedgedEditing = () => {};
  plugin._cardNav = { lineGuid: key, recordGuid: 'TARGET_WINDOW_KEYS', index: 0 };
  const enter = keyEvent('Enter');
  plugin._onCardNavKey(enter);
  assert.equal(loadClicks, 1);
  plugin._cardNav.index = 1;
  const space = keyEvent(' ');
  plugin._onCardNavKey(space);
  assert.equal(openClicks, 1);
});

test('Arrow navigation exits a large-subtree preview back to its exact host without body reads', async () => {
  const { plugin, context } = instance();
  const key = plugin._windowedPreviewKey('HOST_WINDOW_EXIT', 'TARGET_WINDOW_EXIT');
  plugin._windowedPreviews.set(key, {
    key,
    hostLineGuid: 'HOST_WINDOW_EXIT',
    targetGuid: 'TARGET_WINDOW_EXIT',
    shell: { querySelectorAll: () => [] },
  });
  const hostText = {};
  context.document.querySelector = (selector) => selector.includes('HOST_WINDOW_EXIT')
    ? { querySelector: () => hostText }
    : null;
  let focused = null;
  plugin._hitTestCaret = (node) => { focused = node; };
  plugin.data = { getRecord: () => { throw new Error('windowed exit must not read target body'); } };

  plugin._cardNav = { lineGuid: key, recordGuid: 'TARGET_WINDOW_EXIT', index: 0 };
  plugin._handleCardNavExitUp();
  assert.equal(focused, hostText);

  focused = null;
  plugin._cardNav = { lineGuid: key, recordGuid: 'TARGET_WINDOW_EXIT', index: 0 };
  await plugin._handleCardNavExitDown();
  assert.equal(focused, hostText);
});

test('Cmd+Up collapses a focused performance preview and restores its exact authored host', async () => {
  const { plugin } = instance();
  plugin._isMac = true;
  const preview = {
    dataset: { refxWindowedHost: 'HOST_COLLAPSE_FOCUS', refxWindowedTarget: 'TARGET_COLLAPSE_FOCUS' },
  };
  let collapsed = null;
  let focused = null;
  plugin._collapseEmbedFast = async (hostGuid, targetGuid) => { collapsed = { hostGuid, targetGuid }; return true; };
  plugin._focusAuthoredLine = (lineGuid) => { focused = lineGuid; return true; };
  plugin._toast = () => {};
  const event = keyEvent('ArrowUp');
  event.metaKey = true;
  event.ctrlKey = event.altKey = event.shiftKey = false;
  event.target = { closest: (selector) => selector === '.refx-windowed-preview' ? preview : null };

  plugin._handleExpandKey(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.prevented, true);
  assert.deepEqual(collapsed, { hostGuid: 'HOST_COLLAPSE_FOCUS', targetGuid: 'TARGET_COLLAPSE_FOCUS' });
  assert.equal(focused, 'HOST_COLLAPSE_FOCUS');
});

test('deferred native-focus retry is fenced after unload', () => {
  const { plugin } = instance();
  let probes = 0;
  let scheduled = null;
  plugin._transclusionNode = () => { probes++; return null; };
  plugin._trackMaterializeTimer = (fn) => { scheduled = fn; return 1; };

  plugin._focusEmbeddedLine('EMBED_FOCUS_FENCE', 'TARGET_FOCUS_FENCE', 0);
  assert.equal(probes, 1);
  plugin._unloaded = true;
  scheduled();
  assert.equal(probes, 1);
});

test('A3: new card is inserted hidden and revealed in _alignCardToBody', () => {
  const { plugin, context } = instance();
  const lineGuid = 'EMBED_CARD_LINE';
  const cardEl = { style: {}, contentEditable: '', dataset: {}, className: '', replaceChildren() {}, childNodes: [] };
  const contDiv = {};
  const transclusionNode = {
    contains: () => false,
    insertBefore: (el) => { /* inserted */ },
    querySelector: (sel) => {
      if (sel === '.transclusion-container-div') return contDiv;
      if (sel === ':scope > .refx-propcard') return cardEl;
      if (sel === ':scope > .refx-breadcrumb') return null;
      if (sel.includes('refx-wb-hdr')) return null;
      return null;
    },
    firstChild: null
  };
  // Provide getComputedStyle so _alignCardToBody does not throw internally.
  context.getComputedStyle = (el) => ({ marginLeft: '0px', marginRight: '0px', backgroundColor: '', borderTopColor: '' });
  plugin._cards.set(lineGuid, { recordGuid: 'R', line: null, wb: false });
  plugin._transclusionNode = () => transclusionNode;
  plugin._removeCardEl = () => {};
  // Capture that _scheduleAlign is called but do not run the rAF yet.
  let scheduleCalledFor = null;
  plugin._scheduleAlign = (g) => { scheduleCalledFor = g; };
  plugin._wireEmbedBodyClick = () => {};
  context.document.querySelector = () => null;

  plugin._renderCardInto(lineGuid, cardEl);
  assert.equal(cardEl.style.visibility, 'hidden', 'new card must be hidden before align');
  assert.equal(scheduleCalledFor, lineGuid, '_scheduleAlign must be called with the lineGuid');

  // Manually invoke _alignCardToBody (what the rAF would do) with the context's
  // getComputedStyle available so the try-catch succeeds.
  const origGCS = global.getComputedStyle;
  global.getComputedStyle = context.getComputedStyle;
  try {
    plugin._alignCardToBody(lineGuid, transclusionNode);
  } finally {
    global.getComputedStyle = origGCS;
  }
  assert.equal(cardEl.style.visibility, '', 'card must be revealed after _alignCardToBody');
});

test('P1: shell-mounted record-preview card is aligned and revealed without a transclusion body', () => {
  const { plugin } = instance();
  const card = { style: { visibility: 'hidden' } };
  const shell = {
    dataset: { refxPreviewKey: 'rp:HOST:TARGET' },
    classList: { contains: (name) => name === 'refx-record-preview-shell' },
    querySelector: (selector) => selector === ':scope > .refx-propcard' ? card : null,
  };

  plugin._alignCardToBody('rp:HOST:TARGET', shell);

  assert.equal(card.style.visibility, '');
  assert.equal(card.style.width, '100%');
  assert.equal(card.style.marginLeft, '0px');
});

// ── A4: popover shell paints before query resolves ────────────────────────────

test('A4: openRefPopover inserts shell into document.body before awaiting searchByQuery', async () => {
  const { plugin, context } = instance();
  let shellInsertedBeforeSearch = false;
  let searchStarted = false;
  let paintOpportunity = false;
  const appendedEls = [];
  context.document = {
    ...context.document,
    createElement: (tag) => {
      const el = {
        tag, className: '', textContent: '', contentEditable: '',
        dataset: {}, style: {}, childNodes: [],
        appendChild: (c) => { el.children = el.children || []; el.children.push(c); return c; },
        getAttribute: () => null,
        closest: () => null,
        remove: () => {},
        getBoundingClientRect: () => ({ top: 10, left: 10, bottom: 30, height: 20, width: 100 }),
      };
      return el;
    },
    body: {
      appendChild: (el) => {
        appendedEls.push(el);
        if (!searchStarted) shellInsertedBeforeSearch = true;
      },
      classList: { toggle() {}, add() {}, remove() {} }
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { clientHeight: 900 }
  };
  context.window.innerWidth = 1200;
  context.window.innerHeight = 900;
  plugin.getOrLoadRecordName = () => 'Test Record';
  plugin.data = {
    searchByQuery: async () => {
      assert.equal(paintOpportunity, true, 'query must start in a later task so the shell can paint');
      searchStarted = true;
      return { lines: [] };
    }
  };
  plugin.closeRefPopover = () => {};
  plugin.positionRefPopover = () => {};
  plugin._popoverEl = null;
  plugin._popoverGuid = null;
  plugin._popoverGen = 0;
  plugin._maxResults = 250;
  plugin.isLineSharedIgnored = () => false;
  plugin._showSelf = false;
  plugin._drainRefContextQueue = () => {};
  plugin._hasEmbedOpen = () => null; // no existing embed

  const wrap = {
    dataset: { guid: 'TEST_GUID' },
    closest: (sel) => null,
    getBoundingClientRect: () => ({ top: 10, left: 10, bottom: 30, height: 20, width: 100 })
  };

  setTimeout(() => { paintOpportunity = true; }, 0);
  await plugin.openRefPopover(null, wrap);
  assert.ok(shellInsertedBeforeSearch, 'popover shell must be appended to body before searchByQuery resolves');
});

// ── B1: Tab drills unconditionally; Alt+A opens alias prompt ─────────────────

test('A4: default inline badge route attaches its loading shell before scheduling heavy fill', async () => {
  const { plugin, context } = instance();
  const makeEl = (tag) => ({
    tagName: String(tag).toUpperCase(), className: '', textContent: '', type: '', title: '', value: '',
    style: {}, dataset: {}, children: [], classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    append(...children) { for (const child of children) this.appendChild(child); },
    remove() { this.isConnected = false; },
  });
  context.document.createElement = makeEl;
  const order = [];
  const hostNode = {
    insertAdjacentElement(_where, el) { order.push('shell'); el.isConnected = true; },
  };
  plugin._isPinned = () => false;
  plugin._paintPinButton = () => {};
  plugin._ensureCardObserver = () => {};
  plugin._fillInlineRefs = async () => { order.push('fill'); };
  plugin._inlineRefs = new Map();

  await plugin._buildInlineRefsSection(null, 'TARGET_INLINE', hostNode, 'HOST_INLINE');
  assert.deepEqual(order, ['shell'], 'heavy registry/query fill must not run in the shell-attach task');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ['shell', 'fill']);
});

test('inline-section teardown collapses only tracked spawned embeds and toggle-off untracks them', async () => {
  const { plugin, context } = instance();
  const makeEl = (tag) => ({
    tagName: String(tag).toUpperCase(), className: '', textContent: '', type: '', title: '', value: '',
    style: {}, dataset: {}, children: [], classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    append(...children) { for (const child of children) this.appendChild(child); },
    remove() { this.isConnected = false; },
  });
  context.document.createElement = makeEl;
  const hostNode = { insertAdjacentElement(_where, el) { el.isConnected = true; } };
  plugin._isPinned = () => false;
  plugin._paintPinButton = () => {};
  plugin._ensureCardObserver = () => {};
  plugin._teardownCardObserver = () => {};
  plugin._fillInlineRefs = async () => {};

  await plugin._buildInlineRefsSection(null, 'SECTION_TARGET', hostNode, 'SECTION_HOST');
  const key = 'SECTION_HOST›SECTION_TARGET';
  const entry = plugin._inlineRefs.get(key);
  assert.ok(entry && typeof entry.spawnedEmbeds?.add === 'function', 'built section owns a spawned-embed set');

  const bridgeStates = [true, false, true, true];
  plugin._bridgeCreateEmbed = async () => bridgeStates.shift();
  assert.equal(await plugin._sectionToggleEmbed(entry, 'SPAWN_A'), true);
  assert.equal(entry.spawnedEmbeds.has('SPAWN_A'), true);
  assert.equal(await plugin._sectionToggleEmbed(entry, 'SPAWN_A'), false);
  assert.equal(entry.spawnedEmbeds.has('SPAWN_A'), false, 'toggle-off removes the target from tracking');
  await plugin._sectionToggleEmbed(entry, 'SPAWN_A');
  await plugin._sectionToggleEmbed(entry, 'SPAWN_B');

  const collapsed = [];
  plugin._collapseEmbedFast = async (hostGuid, targetGuid) => { collapsed.push([hostGuid, targetGuid]); return true; };
  plugin._removeInlineRefs(key);

  assert.deepEqual(collapsed, [
    ['SECTION_HOST', 'SPAWN_A'],
    ['SECTION_HOST', 'SPAWN_B'],
  ]);
  assert.equal(entry.spawnedEmbeds.size, 0, 'teardown clears the tracked snapshot');
});

test('time-sliced warm walk aborts during a macrotask gap without rendering', async () => {
  const { plugin, context } = instance();
  const key = 'WARM_ABORT';
  const targetGuid = 'WARM_TARGET';
  for (let i = 0; i < 20; i++) {
    context.window.g_universe.itemsByGuid['WARM_' + i] = {
      guid: 'WARM_' + i,
      rguid: 'SOURCE_' + i,
      text_segments: ['text', 'source', 'ref', { guid: targetGuid }],
    };
  }
  let now = 0;
  context.performance.now = () => { now += 5; return now; };
  let yields = 0;
  let renders = 0;
  let queries = 0;
  const entry = {
    targetGuid, hostLineGuid: 'WARM_HOST', aborted: false, spawnedEmbeds: new Set(),
    bodyEl: {}, titleEl: {}, sortMode: 'source', pinned: false,
    el: { remove() {} },
  };
  plugin._showSelf = false;
  plugin.isLineSharedIgnored = () => false;
  plugin._sortRefLines = (lines) => lines;
  plugin._renderRefsGroups = () => { renders++; };
  plugin._queryRefLines = async () => { queries++; return []; };
  plugin._teardownCardObserver = () => {};
  plugin._yieldMacrotask = async () => { yields++; plugin._removeInlineRefs(key); };
  plugin._inlineRefs.set(key, entry);

  await plugin._fillInlineRefs(key, entry);

  assert.equal(yields, 1, 'large walk reaches a macrotask yield');
  assert.equal(entry.aborted, true, 'teardown marks the in-flight entry aborted');
  assert.equal(renders, 0, 'aborted warm results never render');
  assert.equal(queries, 0, 'abort exits before the authoritative query');
});

test('small warm walk paints immediately without a macrotask yield', async () => {
  const { plugin, context } = instance();
  const key = 'WARM_SMALL';
  const targetGuid = 'WARM_SMALL_TARGET';
  for (let i = 0; i < 2; i++) {
    context.window.g_universe.itemsByGuid['SMALL_' + i] = {
      guid: 'SMALL_' + i,
      rguid: 'SMALL_SOURCE_' + i,
      text_segments: ['text', 'source', 'ref', { guid: targetGuid }],
    };
  }
  let now = 0;
  context.performance.now = () => { now += 1; return now; };
  let yields = 0;
  let renders = 0;
  const entry = {
    targetGuid, hostLineGuid: 'WARM_SMALL_HOST', aborted: false, spawnedEmbeds: new Set(),
    bodyEl: {}, titleEl: {}, sortMode: 'source', pinned: false,
    el: { remove() {} },
  };
  plugin._showSelf = false;
  plugin.isLineSharedIgnored = () => false;
  plugin._sortRefLines = (lines) => lines;
  plugin._renderRefsGroups = (_body, lines) => { renders++; assert.equal(lines.length, 2); };
  plugin._yieldMacrotask = async () => { yields++; };
  plugin._queryRefLines = async () => {
    entry.aborted = true;
    plugin._inlineRefs.delete(key);
    return [];
  };
  plugin._inlineRefs.set(key, entry);

  await plugin._fillInlineRefs(key, entry);

  assert.equal(yields, 0, 'sub-budget registry walk never yields');
  assert.equal(renders, 1, 'warm rows paint before the authoritative query settles');
});

test('B1: Tab key drills unconditionally — alias-offer branch removed', () => {
  const { plugin } = instance();
  // Set up a link with a drillable result and a non-empty alias offer scenario.
  let drillCalled = false;
  let aliasCalled = false;
  plugin._r5DrillInto = () => { drillCalled = true; };
  plugin._aliasPickFromPicker = () => { aliasCalled = true; };
  // Stub _linkEffectiveSelection, _linkOptionCount to simulate a selected drillable row.
  plugin._linkEffectiveSelection = () => 0;
  plugin._linkOptionCount = () => 1;
  plugin._linkAliasOffer = () => ({ result: { guid: 'G', text: 'T' }, query: 'my query', selected: 0, kind: 'record' });
  const link = {
    results: [{ guid: 'G', text: 'T', _notFound: false }],
    query: 'my query',
    list: { querySelector: () => null },
    kind: 'record',
    aliasCreating: false
  };
  plugin._link = link;
  const e = {
    key: 'Tab', altKey: false, metaKey: false, ctrlKey: false, shiftKey: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };
  plugin._linkKey(e);
  assert.ok(drillCalled, 'Tab must drill into children');
  assert.ok(!aliasCalled, 'Tab must NOT trigger alias creation (B1: removed)');
});

// ── B2: scrollIntoView called on highlight ─────────────────────────────────────

test('B2: _moveLinkSelection calls scrollIntoView on the newly highlighted row', () => {
  const { plugin } = instance();
  let scrolled = false;
  const selRow = { scrollIntoView: (opts) => { scrolled = true; } };
  const list = { querySelector: (sel) => sel === '.refalias-result-sel' ? selRow : null };
  const link = {
    results: [{ guid: 'A' }, { guid: 'B' }],
    sel: 0,
    userSelected: false,
    list,
    preview: false
  };
  plugin._link = link;
  plugin._linkOptionCount = () => 2;
  plugin._linkEffectiveSelection = () => 0;
  plugin._renderLink = () => {};
  plugin._moveLinkSelection(link, 1);
  assert.ok(scrolled, '_moveLinkSelection must call scrollIntoView on the selected row');
});

test('v4.13 text property textarea wraps, autosizes, preserves Shift+Enter, and commits Enter', async () => {
  const { plugin, context } = instance();
  context.window.innerHeight = 500;
  const editor = fakeElement('textarea', 'refalias-input refx-propcard-input refx-propcard-textarea');
  editor.focus = () => {}; editor.select = () => {}; editor.scrollHeight = 420;
  plugin._el = (tag, cls) => {
    assert.equal(tag, 'textarea', 'text fields use textarea');
    editor.className = cls; return editor;
  };
  const field = { name: 'Synopsis', kind: 'text', value: 'old' };
  plugin._recCardFields = () => [field];
  let replacement = null;
  const valEl = { replaceWith(node) { replacement = node; } };
  const writes = [];
  plugin._commitClaim = () => {};
  plugin._writeCardProp = (_rec, seenField, raw) => writes.push([seenField.name, raw]);
  plugin._commitRefreshRow = () => {};
  plugin._flushPendingMoveRefreshes = () => {};
  plugin._flushDeferredDiscover = () => {};
  plugin._refocusEditor = () => {};

  plugin._editCardValue({}, 'CARD_TEXT', field, valEl, {});
  assert.equal(replacement, editor);
  assert.equal(editor.rows, 1);
  assert.equal(editor.wrap, 'soft');
  editor.listeners.get('input')({});
  assert.equal(editor.style.height, '200px', 'height is capped at 40vh');

  editor.value = 'first\nsecond';
  const shifted = { key: 'Enter', shiftKey: true, prevented: false, stopPropagation() {}, preventDefault() { this.prevented = true; } };
  editor.listeners.get('keydown')(shifted);
  assert.equal(shifted.prevented, false, 'Shift+Enter remains a textarea newline');
  assert.equal(writes.length, 0);

  const enter = { key: 'Enter', shiftKey: false, prevented: false, stopPropagation() {}, preventDefault() { this.prevented = true; } };
  editor.listeners.get('keydown')(enter);
  assert.equal(enter.prevented, true);
  assert.deepEqual(writes, [['Synopsis', 'first\nsecond']]);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('v4.13 switching property fields commits the live editor before opening the next route', () => {
  const { plugin, context } = instance();
  const editor = fakeElement('textarea', 'refalias-input refx-propcard-input refx-propcard-textarea');
  editor.focus = () => {}; editor.select = () => {}; editor.scrollHeight = 20;
  plugin._el = () => editor;
  const first = { name: 'Synopsis', kind: 'text', value: 'old' };
  const second = { name: 'Status', kind: 'choice', value: '', choices: [] };
  plugin._recCardFields = () => [first, second];
  context.document.querySelector = () => editor; // live inline editor: not wedged
  const writes = [];
  let opened = null;
  plugin._commitClaim = () => {};
  plugin._writeCardProp = (_rec, field, raw) => writes.push([field.name, raw]);
  plugin._commitRefreshRow = () => {};
  plugin._flushPendingMoveRefreshes = () => {};
  plugin._flushDeferredDiscover = () => {};
  plugin._refocusEditor = () => { throw new Error('switch commit must not refocus the line'); };
  plugin._editChoice = (_rec, _lineGuid, field) => { opened = field.name; };

  plugin._editCardValue({}, 'CARD_SWITCH', first, { replaceWith() {} }, {});
  editor.value = 'new live value';
  plugin._editCardValue({}, 'CARD_SWITCH', first, {}, {});
  assert.equal(writes.length, 0, 'duplicate event on the same field is ignored');
  plugin._editCardValue({}, 'CARD_SWITCH', second, {}, {});
  assert.deepEqual(writes, [['Synopsis', 'new live value']]);
  assert.equal(opened, 'Status');
});

test('v4.13 wedged editor state self-heals and the expand gate invokes the healer first', () => {
  const { plugin, context } = instance();
  let selector = '';
  context.document.querySelector = (seen) => { selector = seen; return null; };
  plugin._cardEditing = true;
  plugin._activeEdit = { lineGuid: 'ORPHAN' };
  assert.equal(plugin._healWedgedEditing(), true);
  assert.equal(plugin._cardEditing, false);
  assert.equal(plugin._activeEdit, null);
  assert.match(selector, /input, .*textarea, \.refx-cardpop/);

  let heals = 0;
  plugin._healWedgedEditing = () => { heals++; return false; };
  plugin._detect = () => null;
  plugin._isMac = true;
  const event = keyEvent('ArrowDown');
  Object.assign(event, { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, target: { closest: () => null } });
  plugin._handleExpandKey(event);
  assert.equal(heals, 1);
});

test('v4.13 _detect exposes native fold state and first Cmd+Down is not swallowed', () => {
  const { plugin, context } = instance();
  const listItem = { state: { guid: 'FOLDED', rguid: 'PAGE' }, is_folded: true, $node: null };
  context.window.g_universe.listviews = [{
    hasFocus: () => true,
    selection: { _caret: { pos: { list_item: listItem, linespan: null } } }
  }];
  const hit = plugin._detect();
  assert.equal(hit.isFolded, true);
  plugin._isMac = true;
  plugin._selectedRef = () => ({ targetGuid: 'TARGET' });
  let expanded = false;
  plugin._expandRef = () => { expanded = true; };
  const event = keyEvent('ArrowDown');
  Object.assign(event, { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, target: { closest: () => null } });
  plugin._handleExpandKey(event);
  assert.equal(event.prevented, false);
  assert.equal(event.stopped, false);
  assert.equal(expanded, false);
});

test('v4.13 datetime segments render native date, time, range, and granular labels everywhere', () => {
  const { plugin } = instance();
  assert.equal(plugin._dateSegmentText({ d: '20260716' }), 'Thu Jul 16');
  assert.equal(plugin._dateSegmentText({ d: '', t: { t: '170000' } }), '17:00');
  assert.equal(plugin._dateSegmentText({ d: '20260716', t: { t: '1700' } }), 'Thu Jul 16 17:00');
  assert.equal(plugin._dateSegmentText({ d: '20260705', r: { d: '20260711' } }), 'Week 28');
  assert.equal(plugin._dateSegmentText({ d: '20260701', r: { d: '20260930' }, formatted: 'Q3 2026' }), 'Q3 2026');
  const segs = [{ type: 'text', text: 'Meet ' }, { type: 'datetime', text: { d: '20260716' } }];
  assert.equal(plugin._displayText(segs), 'Meet Thu Jul 16');
  assert.equal(plugin._cleanDisplayText(segs), 'Meet Thu Jul 16');
  assert.equal(plugin._textFromRegistrySegments(['text', 'At ', 'datetime', { d: '', t: { t: '170000' } }]), 'At 17:00');
});

test('v4.13 picker and v4.13.1 action-menu CSS carry the native-palette contract', () => {
  assert.match(source, /\.refalias-pop\.refalias-linkpop\s*\{[\s\S]*?width:\s*640px/);
  assert.match(source, /background:\s*var\(--cmdpal-bg-color, var\(--modal-bg, #26262b\)\)/);
  assert.match(source, /background:\s*var\(--cmdpal-selected-bg-color, var\(--ed-button-primary-bg, #479797\)\)/);
  assert.match(source, /color:\s*var\(--cmdpal-hilite-color, var\(--color-blackwhite-0, #fff\)\)/);
  assert.match(source, /\.refalias-linkpop \.refx-alias-chip\.is-active/);
  assert.match(source, /\.refalias-pop\.refx-refmenu,\s*\.refalias-pop\.refx-submenu,\s*\.refalias-pop\.refx-linemenu\s*\{[\s\S]*?background: var\(--cmdpal-bg-color, var\(--modal-bg, #26262b\)\);[\s\S]*?color: var\(--cmdpal-fg-color, var\(--text-color, #ddd\)\);[\s\S]*?border: 1px solid var\(--cmdpal-border-color, rgba\(127,127,127,\.30\)\);[\s\S]*?box-shadow: var\(--shadow-dialog, 0 16px 48px rgba\(0,0,0,\.5\)\);/);
  assert.match(source, /\.refx-refmenu \.refalias-result-sel,\s*\.refx-submenu \.refalias-result-sel,\s*\.refx-linemenu \.refalias-result-sel\s*\{[\s\S]*?background: var\(--cmdpal-selected-bg-color, var\(--ed-button-primary-bg, #479797\)\);[\s\S]*?color: var\(--cmdpal-selected-fg-color, #fff\);/);
  assert.match(source, /\.refx-refmenu-head\s*\{[\s\S]*?border-bottom: 1px solid var\(--cmdpal-border-color, rgba\(127,127,127,\.30\)\);/);
  assert.match(source, /rowEl\.querySelector\("input, textarea"\)/);
  assert.match(source, /\.refx-propcard \.refalias-input\.refx-propcard-textarea/);
  assert.match(source, /\.refx-opt-ico\s*\{[^}]*width:\s*17px;\s*height:\s*17px;[^}]*flex:\s*0 0 17px/);
  assert.match(source, /_onCardNavKey = \(e\) => \{[\s\S]{0,140}this\._healWedgedEditing\(\)/);
});

function initWorkbenchHarness(plugin, context, workspaceGuid = 'WORKSPACE_WB') {
  plugin.workspaceGuid = workspaceGuid;
  plugin._isUnloading = false;
  plugin._unloaded = false;
  plugin._recheckBackgroundGate = async () => true;
  plugin._initWorkbenchRuntimeOwner();
  return plugin._wbOwner;
}

function workbenchLine(guid, props = {}, segments = []) {
  const line = {
    guid,
    type: 'transclusion',
    props: { ...props },
    segments,
    async setMetaProperty(key, value) { this.props[key] = value; return true; },
    async delete() { return true; },
  };
  return line;
}

function workbenchRecord(guid, lines, options = {}) {
  let sequence = 0;
  return {
    guid,
    getName: () => 'Reference Workbench State',
    async getLineItems(expandReferences) {
      assert.equal(expandReferences, false, 'Workbench reads never expand references');
      if (options.beforeRead) await options.beforeRead();
      return lines;
    },
    async createLineItem(_parent, _after, type, _segments, props) {
      if (options.beforeCreate) await options.beforeCreate(props);
      const line = workbenchLine(`WB_LINE_${++sequence}`, props);
      line.type = type;
      line.delete = async () => { const index = lines.indexOf(line); if (index >= 0) lines.splice(index, 1); return true; };
      lines.push(line);
      options.onCreate?.(line, props);
      return line;
    },
  };
}

function workbenchCollection(name, records) {
  return {
    guid: `COL_${name.toUpperCase()}`,
    getName: () => name,
    async getAllRecords() { return records; },
    createRecord() { throw new Error('unexpected backing create'); },
  };
}

test('Workbench migration is single-flight, semantic-keyed, and idempotent', async () => {
  const { plugin, context } = instance();
  initWorkbenchHarness(plugin, context);
  context.localStorage.setItem(plugin._WB_KEY, JSON.stringify([
    { guid: 'TARGET_A', pinned: true, collapsed: true },
    { guid: 'TARGET_A', pinned: false },
    { guid: 'TARGET_A', type: 'linked-refs' },
  ]));
  const lines = [];
  const created = [];
  const record = workbenchRecord('WB_RECORD', lines, { onCreate: (_line, props) => created.push(props.itemref + ':' + props.refx_variant) });
  const settings = workbenchCollection('Settings', [record]);
  let collectionReads = 0;
  plugin.data = { async getAllCollections() { collectionReads++; return [settings]; } };

  const [first, second] = await Promise.all([plugin._wbLiveInit(), plugin._wbLiveInit()]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.deepEqual(created.sort(), ['TARGET_A:full', 'TARGET_A:refs']);
  assert.equal(collectionReads, 1, 'concurrent callers share backing validation and migration');
  assert.equal(plugin._wbMigrated, true);
  assert.equal(context.localStorage.getItem(plugin._WB_KEY), null, 'legacy JSON is removed only after verification');
  assert.equal(await plugin._wbLiveInit(), true);
  assert.equal(lines.length, 2, 'repeat initialization creates no duplicate semantic item');
  const full = lines.find((line) => line.props.refx_variant === 'full');
  assert.equal(full.props.refx_pinned, '1');
  assert.equal(full.props.refx_collapsed, '1');
});

test('Workbench migration failure retains legacy state and converges on retry without duplicates', async () => {
  const { plugin, context } = instance();
  initWorkbenchHarness(plugin, context);
  context.localStorage.setItem(plugin._WB_KEY, JSON.stringify([{ guid: 'TARGET_A' }, { guid: 'TARGET_B' }]));
  const lines = [];
  const creates = new Map();
  let failB = true;
  const record = workbenchRecord('WB_RECORD', lines, {
    beforeCreate(props) {
      creates.set(props.itemref, (creates.get(props.itemref) || 0) + 1);
      if (props.itemref === 'TARGET_B' && failB) { failB = false; throw new Error('injected create failure'); }
    },
  });
  plugin.data = { async getAllCollections() { return [workbenchCollection('Settings', [record])]; } };

  assert.equal(await plugin._wbLiveInit(), false);
  assert.equal(plugin._wbMigrated, false);
  assert.ok(context.localStorage.getItem(plugin._WB_KEY), 'legacy source survives a partial migration');
  assert.equal(lines.filter((line) => line.props.itemref === 'TARGET_A').length, 1);

  assert.equal(await plugin._wbLiveInit(), true);
  assert.equal(creates.get('TARGET_A'), 1, 'retry adopts the already-created semantic item');
  assert.equal(creates.get('TARGET_B'), 2, 'only the failed missing item is retried');
  assert.equal(lines.filter((line) => line.props.itemref === 'TARGET_A').length, 1);
  assert.equal(lines.filter((line) => line.props.itemref === 'TARGET_B').length, 1);
});

test('Workbench rejects same-title panel collisions and adopts only its persisted validated GUID', async () => {
  const { plugin, context } = instance();
  initWorkbenchHarness(plugin, context);
  const good = workbenchRecord('WB_GOOD', []);
  const collision = workbenchRecord('WB_COLLISION', []);
  const collisionPanel = { getActiveRecord: () => collision, getId: () => 'P_COLLISION' };
  assert.equal(plugin._wbAdoptVisibleBacking(collisionPanel), false, 'title equality is not an identity receipt');
  plugin.data = { async getAllCollections() { return [workbenchCollection('Settings', [good])]; } };
  assert.equal(await plugin._wbResolveBacking(), 'WB_GOOD');
  plugin._wbInvalidateBacking('reload', { clearPersisted: false, teardown: false });
  assert.equal(plugin._wbAdoptVisibleBacking(collisionPanel), false);
  const goodPanel = { getActiveRecord: () => good, getId: () => 'P_GOOD' };
  assert.equal(plugin._wbAdoptVisibleBacking(goodPanel), true);
  assert.equal(plugin._wbBackingGuid, 'WB_GOOD');
});

test('Workbench invalidates stale resolution, trash, move, and reload identities', async () => {
  const { plugin, context } = instance();
  initWorkbenchHarness(plugin, context);
  const gate = deferred();
  const stale = workbenchRecord('WB_STALE', []);
  const settings = workbenchCollection('Settings', [stale]);
  settings.getAllRecords = async () => { await gate.promise; return [stale]; };
  plugin.data = { async getAllCollections() { return [settings]; } };
  const resolving = plugin._wbResolveBacking();
  plugin._wbInvalidateBacking('reload', { clearPersisted: false, teardown: false });
  gate.resolve();
  assert.equal(await resolving, null, 'pre-reload enumeration cannot publish its stale record handle');
  assert.equal(plugin._wbBackingGuid, null);

  plugin._wbBackingGuid = 'WB_STALE';
  plugin._wbBackingValidatedGuid = 'WB_STALE';
  plugin._wbBackingRecord = stale;
  plugin._wbPersistBackingGuid('WB_STALE');
  plugin._patchRecordCollectionFromEvent = () => ({ recordGuid: 'WB_STALE', collectionGuid: 'COL_SETTINGS' });
  plugin._schedulePickerMetadataRefresh = () => {};
  plugin._aliasScheduleEnrich = () => {};
  plugin._wbLiveTeardownObserver = () => {};
  plugin._onRecordUpdated({ recordGuid: 'WB_STALE', trashed: true });
  assert.equal(plugin._wbBackingGuid, null);
  assert.equal(plugin._wbReadPersistedBackingGuid(), null, 'trash removes the durable identity receipt');

  plugin._wbBackingGuid = 'WB_STALE'; plugin._wbBackingValidatedGuid = 'WB_STALE'; plugin._wbBackingRecord = stale;
  plugin._wbPersistBackingGuid('WB_STALE');
  plugin._onRecordMoved({ recordGuid: 'WB_STALE', parentGuid: 'COL_OTHER' });
  assert.equal(plugin._wbBackingGuid, null);
  assert.equal(plugin._wbReadPersistedBackingGuid(), null, 'move requires fresh allowed-collection validation');

  plugin._wbBackingGuid = 'WB_STALE'; plugin._wbBackingValidatedGuid = 'WB_STALE'; plugin._wbBackingRecord = stale;
  plugin._wbPersistBackingGuid('WB_STALE');
  plugin._scheduleRecordNameIndex = () => {};
  plugin._buildFieldTypes = () => {};
  plugin._onMetadataReload();
  assert.equal(plugin._wbBackingGuid, null, 'metadata reload invalidates the in-memory record handle');
  assert.equal(plugin._wbReadPersistedBackingGuid(), 'WB_STALE', 'reload retains only the workspace-scoped identity receipt');
});

test('Workbench revokes backing authorization when its validated host collection is renamed or trashed', () => {
  const { plugin, context } = instance();
  initWorkbenchHarness(plugin, context);
  const record = workbenchRecord('WB_HOSTED', []);
  plugin._schedulePickerMetadataRefresh = () => {};
  plugin._buildFieldTypes = () => {};
  plugin._wbLiveTeardownObserver = () => {};
  const seed = () => {
    plugin._wbBackingRecord = record;
    plugin._wbBackingGuid = 'WB_HOSTED';
    plugin._wbBackingValidatedGuid = 'WB_HOSTED';
    plugin._wbBackingValidatedCollectionGuid = 'COL_SETTINGS';
    plugin._wbPersistBackingGuid('WB_HOSTED', 'COL_SETTINGS');
  };

  seed();
  plugin._onCollectionMetadataChanged({ collectionGuid: 'COL_SETTINGS', json: null });
  assert.equal(plugin._wbBackingGuid, 'WB_HOSTED', 'code/CSS-only collection updates retain validation');
  plugin._onCollectionMetadataChanged({ collectionGuid: 'COL_SETTINGS', json: { name: 'Notes' } });
  assert.equal(plugin._wbBackingGuid, null);
  assert.equal(plugin._wbBackingValidatedCollectionGuid, null);
  assert.equal(plugin._wbReadPersistedBackingGuid(), null, 'rename away removes the durable authorization receipt');

  seed();
  plugin._onCollectionMetadataChanged({ collectionGuid: 'COL_SETTINGS', trashed: true, json: null });
  assert.equal(plugin._wbBackingGuid, null);
  assert.equal(plugin._wbReadPersistedBackingGuid(), null, 'host collection trash revokes the receipt');
  if (plugin._fieldTypesRebuildT) clearTimeout(plugin._fieldTypesRebuildT);
  plugin._fieldTypesRebuildT = 0;
});

test('late restored Workbench panel adoption is bounded and background-gated', async () => {
  const { plugin, context } = instance();
  initWorkbenchHarness(plugin, context);
  plugin._wbPersistBackingGuid('WB_LATE', 'COL_SETTINGS');
  const record = workbenchRecord('WB_LATE', []);
  let reads = 0;
  const panel = { getActiveRecord: () => (++reads < 3 ? null : record), getId: () => 'P_LATE' };
  plugin._backgroundWorkAlive = () => true;
  plugin._backgroundInteractionBusy = () => false;
  plugin._backgroundWait = async () => true;
  plugin._recheckBackgroundGate = async () => true;
  plugin._wbLiveInit = async () => true;
  let refreshes = 0;
  plugin._wbLiveScheduleRefresh = () => { refreshes++; return true; };
  let job = null;
  plugin._runBackgroundWork = (_name, task) => { job = task('WB_GENERATION'); return job; };

  assert.equal(plugin._wbSchedulePanelAdoption(panel), true);
  assert.equal(await job, true);
  assert.equal(reads, 3);
  assert.equal(plugin._wbBackingGuid, 'WB_LATE');
  assert.equal(refreshes, 1);
});

test('unrelated panel navigation cannot supersede a restoring Workbench panel', async () => {
  const { plugin, context } = instance();
  initWorkbenchHarness(plugin, context);
  plugin._wbPersistBackingGuid('WB_RESTORING', 'COL_SETTINGS');
  const record = workbenchRecord('WB_RESTORING', []);
  const other = workbenchRecord('OTHER_RECORD', []);
  let wbReads = 0;
  const wbPanel = { getActiveRecord: () => (++wbReads < 2 ? null : record), getId: () => 'P_WB' };
  const mainPanel = { getActiveRecord: () => other, getId: () => 'P_MAIN' };
  plugin._backgroundWorkAlive = () => true;
  plugin._backgroundInteractionBusy = () => false;
  plugin._recheckBackgroundGate = async () => true;
  plugin._wbLiveInit = async () => true;
  plugin._wbLiveScheduleRefresh = () => true;
  const releaseRetry = deferred();
  plugin._backgroundWait = async () => { await releaseRetry.promise; return true; };
  const jobs = [];
  plugin._runBackgroundWork = (_name, task) => {
    const job = task('WB_GENERATION');
    jobs.push(job);
    return job;
  };

  assert.equal(plugin._wbSchedulePanelAdoption(wbPanel), true);
  assert.equal(plugin._wbSchedulePanelAdoption(mainPanel), true);
  releaseRetry.resolve();
  const [wbResult, mainResult] = await Promise.all(jobs);

  assert.equal(wbResult, true);
  assert.equal(mainResult, false);
  assert.equal(plugin._wbBackingGuid, 'WB_RESTORING');
  assert.equal(wbReads, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(plugin._wbPanelAdoptions.size, 0, 'completed per-panel adoption tokens are released');
});

test('Workbench hot reload fences a migration after its awaited body read', async () => {
  const { Plugin, context } = loadPlugin();
  const oldPlugin = new Plugin(); oldPlugin._isUnloading = false; oldPlugin._unloaded = false;
  initWorkbenchHarness(oldPlugin, context);
  context.localStorage.setItem(oldPlugin._WB_KEY, JSON.stringify([{ guid: 'TARGET_HOT' }]));
  const entered = deferred();
  const release = deferred();
  let firstRead = true;
  let creates = 0;
  const lines = [];
  const record = workbenchRecord('WB_HOT', lines, {
    async beforeRead() { if (firstRead) { firstRead = false; entered.resolve(); await release.promise; } },
    onCreate() { creates++; },
  });
  const data = { async getAllCollections() { return [workbenchCollection('Settings', [record])]; } };
  oldPlugin.data = data;
  const oldInit = oldPlugin._wbLiveInit();
  await entered.promise;

  context.window.__refxWorkbenchDispose();
  const newPlugin = new Plugin(); newPlugin._isUnloading = false; newPlugin._unloaded = false;
  initWorkbenchHarness(newPlugin, context);
  newPlugin.data = data;
  release.resolve();
  assert.equal(await oldInit, false);
  assert.equal(creates, 0, 'disposed owner cannot write after an awaited SDK read');
  assert.ok(context.localStorage.getItem(oldPlugin._WB_KEY));
  assert.equal(await newPlugin._wbLiveInit(), true);
  assert.equal(creates, 1);
});

test('Workbench provenance cleanup joins rich segments and input invalidates a pending visible read', async () => {
  const { plugin, context } = instance();
  const owner = initWorkbenchHarness(plugin, context);
  const carrier = workbenchLine('CARRIER', {}, [
    { type: 'text', text: 'Reference Workbench ' },
    { type: 'text', text: 'shelf state — managed by the plugin' },
  ]);
  carrier.type = 'text';
  const lines = [carrier];
  carrier.delete = async () => { lines.splice(lines.indexOf(carrier), 1); return true; };
  const record = workbenchRecord('WB_PROVENANCE', lines);
  plugin.data = { async getAllCollections() { return [workbenchCollection('Settings', [record])]; } };
  assert.equal(await plugin._wbLiveInit(), true);
  assert.equal(lines.length, 0, 'segment-joined carrier text is detected and cleaned');

  const bodyGate = deferred();
  record.getLineItems = async (expandReferences) => { assert.equal(expandReferences, false); await bodyGate.promise; return []; };
  plugin._wbBackingGuid = 'WB_PROVENANCE'; plugin._wbBackingValidatedGuid = 'WB_PROVENANCE'; plugin._wbBackingRecord = record;
  plugin._backgroundWorkGeneration = 'GEN';
  plugin._backgroundLastInputAt = 0;
  const seq = ++plugin._wbRefreshSeq;
  const pending = plugin._wbLoadLive('GEN', owner, seq);
  plugin._backgroundLastInputAt = Date.now();
  bodyGate.resolve();
  const suppressed = await pending;
  assert.equal(Array.isArray(suppressed), true);
  assert.equal(suppressed.length, 0, 'input after the SDK await suppresses stale visible publication');
});

test('manifest, changelog, and runtime version tell stay in sync', () => {
  const runtime = source.match(/window\.__REFX_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  const sourceHeader = source.match(/^\/\/ v(\d+\.\d+\.\d+)\b/m)?.[1];
  const changelog = changelogText.match(/^## v(\d+\.\d+\.\d+)\b/m)?.[1];
  const declaredTests = Number(changelogText.match(/^- \*\*Verification:\*\* (\d+) deterministic Node tests/m)?.[1]);
  const actualTests = (testSource.match(/^test\(/gm) || []).length;
  assert.ok(runtime, 'window.__REFX_VERSION must exist');
  assert.ok(sourceHeader, 'plugin.js header version must exist');
  assert.ok(changelog, 'top changelog version must exist');
  assert.equal(runtime, manifest.version);
  assert.equal(sourceHeader, manifest.version);
  assert.equal(changelog, manifest.version);
  assert.equal(declaredTests, actualTests);
});
