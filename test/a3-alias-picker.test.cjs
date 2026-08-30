'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.className = ''; this.children = []; this.style = {}; this.dataset = {};
    this._text = ''; this._html = ''; this._listeners = {}; this.isConnected = true;
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent || '').join(''); }
  set textContent(value) { this._text = String(value == null ? '' : value); this._html = ''; this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value == null ? '' : value); this._text = ''; this.children = []; }
  append(...children) { this.children.push(...children.filter(Boolean)); }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  remove() { this.isConnected = false; }
  getBoundingClientRect() { return { left: 20, top: 20, right: 700, bottom: 360, width: 680, height: 340 }; }
}

function makeHarness() {
  const storage = new Map();
  const records = new Map();
  const document = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    body: new FakeElement('body'), head: new FakeElement('head'), documentElement: { clientHeight: 900 },
  };
  const window = {
    innerWidth: 1400, innerHeight: 900,
    CSS: { escape: String },
    g_universe: { itemsByGuid: {}, workspace: { guid: 'WS_A3' } },
    addEventListener() {}, removeEventListener() {},
  };
  const context = {
    AppPlugin: class {}, console, Promise, Date, Math, Map, Set, WeakMap, WeakSet,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    performance, CSS: window.CSS, document, window, Element: FakeElement,
    MutationObserver: class { observe() {} disconnect() {} }, DateTime: undefined,
    navigator: { platform: 'MacIntel', clipboard: {} },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };
  context.globalThis = context; Object.assign(context, window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  const plugin = new context.PluginUnderTest();
  plugin.workspaceGuid = 'WS_A3'; plugin._unloaded = false; plugin._r5SessionGen = 7;
  plugin._aliasInit();
  plugin.data = {
    getRecord: (guid) => records.get(guid) || null,
    searchByQuery: async () => ({ records: [], lines: [] }),
  };
  plugin._renderLink = () => {};
  plugin._toast = () => {}; plugin.refreshAllPanels = () => {};
  return { plugin, context, window, document, records, storage };
}

function addRecord(h, guid, name, aliases = [], collection = 'Notes') {
  const record = { guid, getGuid: () => guid, getName: () => name, getLineItems: async () => [] };
  h.records.set(guid, record); h.plugin._recordNameIndex.set(guid, name);
  h.plugin._pickerMarkRecordLive(guid, true);
  h.plugin._recordCollectionIndex.set(guid, 'COL_' + collection);
  h.plugin._collectionName = (colGuid) => colGuid === 'COL_' + collection ? collection : '';
  if (aliases.length) h.plugin._aliasReplaceRecordSet(guid, aliases.map((text) => h.plugin._aliasMakeItem(text, 'registry')));
  return record;
}

async function search(h, query) {
  h.plugin._link = {
    kind: 'record', query, token: 0, r5Session: 7, results: [], resultsQuery: '',
    resultsPreSliceCount: 0, sel: 0, userSelected: false,
  };
  await h.plugin._runRecordSearch(query);
  return h.plugin._link.results;
}

test('A3 alias hits render Alias ↳ Real Title and insert the real guid with alias title', async () => {
  const h = makeHarness();
  addRecord(h, 'REC_ALIAS', 'Environmental Monitoring Program', ['EMP 26']);
  const rows = await search(h, 'EMP26');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), {
    guid: 'REC_ALIAS', text: 'EMP 26', aliasText: 'EMP 26', realTitle: 'Environmental Monitoring Program',
    page: '', score: 1340, matchKind: 'alias', matchQuery: 'EMP26',
  });

  const list = new FakeElement('div');
  h.plugin._renderLink = Object.getPrototypeOf(h.plugin)._renderLink.bind(h.plugin);
  h.plugin._link = { kind: 'record', query: 'EMP26', resultsQuery: 'EMP26', searchTimer: null, results: rows, resultsPreSliceCount: 1, sel: 0, userSelected: true, list };
  h.plugin._buildPickerRowCrumb = () => ''; h.plugin._updateLinkPreviewPane = () => {}; h.plugin._scheduleLinkCounts = () => {};
  h.plugin._renderLink();
  const text = list.children[0].children[0];
  assert.equal(text.children[0].textContent, ' ↳ Environmental Monitoring Program');

  let written = [{ type: 'text', text: '[[EMP26' }];
  const line = { guid: 'LINE', segments: written, setSegments: (next) => { written = next; } };
  h.records.set('PAGE', { guid: 'PAGE', getLineItems: async () => [line] });
  h.plugin._link = { kind: 'record', query: 'EMP26', pageGuid: 'PAGE', lineGuid: 'LINE', br: '[[', closingPair: null, picking: false };
  h.plugin._exitLinkMode = () => {}; h.plugin._liveStateByGuid = () => null; h.plugin._liveSegs = () => written;
  h.plugin._r5RecordFrecency = () => {}; h.plugin.getCachedCountInfo = () => ({ count: 1 });
  h.plugin._queueImmediateRefPaint = () => {}; h.plugin._aliasOpenLearnedSuggestion = () => {};
  const ok = await h.plugin._pickLink(rows[0]);
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(written.find((segment) => segment.type === 'ref'))),
    { type: 'ref', text: { guid: 'REC_ALIAS', title: 'EMP 26' } });
  const uses = JSON.parse(h.storage.get('refx_alias_picker_use_v1'));
  assert.equal(uses['emp 26\u0000REC_ALIAS'].uses, 1);
});

test('Journal [[ picker commits through the open-panel record when its synthetic owner is not SDK-resolvable', async () => {
  const h = makeHarness();
  addRecord(h, 'TARGET_PAGE', 'Target Page');
  const journalGuid = 'S-JOURNAL-COL-USER-0-20260717';
  let written = [{ type: 'text', text: 'test[[Target Page' }];
  const line = {
    guid: 'JOURNAL_LINE',
    segments: written,
    setSegments(next) { written = next; return true; },
  };
  const journalRecord = { guid: 'REAL_JOURNAL_RECORD', getLineItems: async () => [line] };
  h.context.window.g_universe.itemsByGuid.JOURNAL_LINE = { guid: 'JOURNAL_LINE', rguid: journalGuid };
  h.plugin.ui = {
    getPanels: () => [{ getActiveRecord: () => journalRecord }],
    getActivePanel: () => ({ getActiveRecord: () => journalRecord }),
  };
  h.plugin._link = {
    kind: 'record', query: 'Target Page', pageGuid: journalGuid,
    lineGuid: 'JOURNAL_LINE', br: '[[', closingPair: null, picking: false,
  };
  h.plugin._exitLinkMode = () => {};
  h.plugin._liveStateByGuid = () => null;
  h.plugin._liveSegs = () => written;
  h.plugin._r5RecordFrecency = () => {};
  h.plugin.getCachedCountInfo = () => ({ count: 1 });
  h.plugin._queueImmediateRefPaint = () => {};
  h.plugin._aliasOpenLearnedSuggestion = () => {};

  const ok = await h.plugin._pickLink({ guid: 'TARGET_PAGE', text: 'Target Page' });

  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(written)), [
    { type: 'text', text: 'test' },
    { type: 'ref', text: { guid: 'TARGET_PAGE' } },
  ]);
});

test('Journal picker cancel removes its raw brackets through the open-panel line handle', async () => {
  const h = makeHarness();
  const journalGuid = 'S-JOURNAL-COL-USER-0-20260717';
  let written = [{ type: 'text', text: 'test[[Target Page' }];
  const line = {
    guid: 'JOURNAL_LINE',
    segments: written,
    setSegments(next) { written = next; return true; },
  };
  const journalRecord = { guid: 'REAL_JOURNAL_RECORD', getLineItems: async () => [line] };
  h.context.window.g_universe.itemsByGuid.JOURNAL_LINE = { guid: 'JOURNAL_LINE', rguid: journalGuid };
  h.plugin.ui = {
    getPanels: () => [{ getActiveRecord: () => journalRecord }],
    getActivePanel: () => ({ getActiveRecord: () => journalRecord }),
  };
  h.plugin._link = {
    kind: 'record', query: 'Target Page', pageGuid: journalGuid,
    lineGuid: 'JOURNAL_LINE', br: '[[', closingPair: null, synthetic: false,
  };
  h.plugin._exitLinkMode = () => {};
  h.plugin._liveStateByGuid = () => ({
    text_segments: written.flatMap((segment) => [segment.type, segment.text]),
  });

  await h.plugin._abortLink();

  assert.deepEqual(JSON.parse(JSON.stringify(written)), [{ type: 'text', text: 'test' }]);
});

test('A3 ranking promotes exact/prefix aliases above unrelated fuzzy title hits', async () => {
  const h = makeHarness();
  addRecord(h, 'A_EXACT_ALIAS', 'Canonical A', ['Exact']);
  addRecord(h, 'B_EXACT_TITLE', 'Exact');
  let rows = await search(h, 'Exact');
  const alias = rows.find((row) => row.guid === 'A_EXACT_ALIAS');
  const title = rows.find((row) => row.guid === 'B_EXACT_TITLE');
  assert.ok(alias.score > title.score);

  addRecord(h, 'C_PREFIX_ALIAS', 'Canonical C', ['Alpha Shortcut']);
  addRecord(h, 'D_PREFIX_TITLE', 'Alpha Project');
  rows = await search(h, 'Alpha');
  assert.equal(rows.find((row) => row.guid === 'D_PREFIX_TITLE').score, h.plugin._searchScore('Alpha Project', 'Alpha'));
  assert.equal(rows.find((row) => row.guid === 'C_PREFIX_ALIAS').score,
    h.plugin._aliasPickerRank(h.plugin._searchScore('Alpha Shortcut', 'Alpha'), true));
});

test('A3 alias: restricts results, composes with in:, and never exposes title-only hits', async () => {
  const h = makeHarness();
  addRecord(h, 'ALIAS_NOTES', 'Canonical Notes', ['EMP 26'], 'Notes');
  addRecord(h, 'ALIAS_PROJECTS', 'Canonical Projects', ['EMP 26'], 'Projects');
  addRecord(h, 'TITLE_ONLY', 'EMP 26', [], 'Notes');
  const rows = await search(h, 'alias:EMP26 in:Notes');
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => row.guid))), ['ALIAS_NOTES']);
  assert.equal(h.plugin._linkHasCreateOption(h.plugin._link), false);
});

test('A3 ambiguous aliases return every labeled record', async () => {
  const h = makeHarness();
  addRecord(h, 'REC_ONE', 'First Canonical', ['Shared']);
  addRecord(h, 'REC_TWO', 'Second Canonical', ['Shared']);
  const rows = await search(h, 'alias:Shared');
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => row.guid).sort())), ['REC_ONE', 'REC_TWO']);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => row.realTitle).sort())), ['First Canonical', 'Second Canonical']);
});

test('A3 learned aliases trigger once at three verified outcomes and remember dismissal', () => {
  const h = makeHarness();
  assert.equal(h.plugin._aliasRecordLearnedOutcome('REC', 'emp plan', 'Environmental Program'), null);
  assert.equal(h.plugin._aliasRecordLearnedOutcome('REC', 'emp plan', 'Environmental Program'), null);
  const suggestion = h.plugin._aliasRecordLearnedOutcome('REC', 'emp plan', 'Environmental Program');
  assert.equal(suggestion.query, 'emp plan');
  assert.equal(h.plugin._aliasRecordLearnedOutcome('REC', 'emp plan', 'Environmental Program'), null, 'one suggestion only');

  const token = h.plugin._aliasLearnToken('OTHER', 'short query');
  h.plugin._aliasLearnCache[token] = { uses: 2, offered: false, dismissed: false, updatedAt: 1 };
  h.plugin._aliasDismissLearnedSuggestion(token);
  assert.equal(h.plugin._aliasRecordLearnedOutcome('OTHER', 'short query', 'Long Canonical'), null);
  assert.equal(JSON.parse(h.storage.get('refx_alias_picker_learning_v1'))[token].dismissed, true);
});

test('A3 alias matching is cooperatively chunked and alias: does no remote search', async () => {
  const h = makeHarness();
  addRecord(h, 'REC_FAST', 'Fast Canonical', ['Fast Alias']);
  let remoteCalls = 0;
  h.plugin.data.searchByQuery = async () => { remoteCalls++; return { records: [], lines: [] }; };
  const rows = await search(h, 'alias:"Fast Alias"');
  assert.equal(rows[0].guid, 'REC_FAST'); assert.equal(remoteCalls, 0);

  const method = source.slice(source.indexOf('  async _runRecordSearch(query)'), source.indexOf('\n  _renderLink()', source.indexOf('  async _runRecordSearch(query)')));
  assert.match(method, /_navigatorChunked\(/, 'large local metadata scans must yield cooperatively');
  assert.match(method, /publish\(false\)/, 'chunked local scans must publish progressively');
  const aliasExit = method.slice(method.indexOf("if (aliasFilter ||"));
  assert.ok(aliasExit.indexOf('return;') < aliasExit.indexOf('searchByQuery'), 'alias: must return before native remote search');
});

test('v4.34.0 alias-owned cold record remains searchable while liveness is unknown', async () => {
  const h = makeHarness();
  h.plugin._aliasReplaceRecordSet('REC_COLD_ALIAS', [h.plugin._aliasMakeItem('Lorinator', 'registry')]);
  addRecord(h, 'REC_FUZZY_TITLE', 'Lorinator archive');
  // The alias owner is deliberately absent from g_universe, the name index,
  // and data.getRecord: the miss leaves it unknown rather than declaring trash.
  h.plugin._pickerLivenessReady = true;
  const rows = await search(h, 'Lorinator');
  assert.equal(h.plugin._pickerResultLiveness({ guid: 'REC_COLD_ALIAS', type: 'record' }), 'unknown');
  assert.equal(rows[0].guid, 'REC_COLD_ALIAS');
  assert.equal(rows[0].matchKind, 'alias');
  assert.equal(rows[0].aliasText, 'Lorinator');
});

test('v4.10.0 title and alias collision stays one row and carries matchedAlias', async () => {
  const h = makeHarness();
  addRecord(h, 'REC_DEDUP_ALIAS', 'Lori', ['Lori helper']);
  const rows = await search(h, 'Lori');
  assert.equal(rows.filter((row) => row.guid === 'REC_DEDUP_ALIAS').length, 1);
  assert.equal(rows[0].matchKind, 'title');
  assert.equal(rows[0].matchedAlias, 'Lori helper');
  const list = new FakeElement('div');
  h.plugin._renderLink = Object.getPrototypeOf(h.plugin)._renderLink.bind(h.plugin);
  h.plugin._link = { kind: 'record', query: 'Lori', resultsQuery: 'Lori', searchTimer: null, results: rows, resultsPreSliceCount: 1, sel: 0, userSelected: true, list };
  h.plugin._buildPickerRowCrumb = () => ''; h.plugin._updateLinkPreviewPane = () => {}; h.plugin._scheduleLinkCounts = () => {};
  h.plugin._renderLink();
  assert.equal(list.children[0].children[0].children[0].textContent, ' · alias: Lori helper');
});

function addLineAlias(h, lineGuid, currentText, aliases, recordGuid = 'REC_OWNER', owner = 'Owner Page') {
  h.plugin._recordNameIndex.set(recordGuid, owner);
  h.plugin._recordCollectionIndex.set(recordGuid, 'COL_Notes');
  h.plugin._pickerMarkLineLive(lineGuid, recordGuid, true);
  h.plugin._lineAliasReplaceSet(lineGuid, {
    recordGuid, currentText, status: 'active',
    aliases: aliases.map((text) => h.plugin._lineAliasMakeItem(text)),
  });
}

async function searchLine(h, query) {
  h.plugin._link = {
    kind: 'line', query, token: 0, r5Session: 7, lineGuid: 'SOURCE_LINE', results: [], resultsQuery: '',
    resultsPreSliceCount: 0, sel: 0, userSelected: false,
  };
  await h.plugin._runLinkSearch(query);
  return h.plugin._link.results;
}

test('L2 (( alias search renders Alias ↳ current text · owner and stays namespace-separate', async () => {
  const h = makeHarness();
  addLineAlias(h, 'LINE_ALIAS', 'Canonical line text', ['Start here'], 'REC_OWNER', 'Playbook');
  addRecord(h, 'REC_ALIAS_ONLY', 'Record target', ['Start here']);
  const rows = await searchLine(h, 'Start here');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), {
    guid: 'LINE_ALIAS', text: 'Start here', aliasText: 'Start here', realTitle: 'Canonical line text',
    page: 'Playbook', rguid: 'REC_OWNER', task: null, score: 1200,
    matchKind: 'line-alias', matchQuery: 'Start here',
  });

  const list = new FakeElement('div');
  h.plugin._renderLink = Object.getPrototypeOf(h.plugin)._renderLink.bind(h.plugin);
  h.plugin._link = { kind: 'line', query: 'Start here', resultsQuery: 'Start here', searchTimer: null, results: rows, resultsPreSliceCount: 1, sel: 0, userSelected: true, list };
  h.plugin._buildLinePickCrumb = () => ''; h.plugin._updateLinkPreviewPane = () => {}; h.plugin._scheduleLinkCounts = () => {};
  h.plugin._renderLink();
  const text = list.children[0].children[0];
  assert.equal(text.children[0].textContent, ' ↳ Canonical line text');
  assert.equal(list.children[0].children[1].textContent, 'Playbook');
});

test('L2 line alias: is synchronous, restrictive, composable, and collision-preserving', async () => {
  const h = makeHarness();
  addLineAlias(h, 'LINE_ONE', 'First current text', ['Shared route'], 'REC_ONE', 'Notes');
  addLineAlias(h, 'LINE_TWO', 'Second current text', ['Shared route'], 'REC_TWO', 'Projects');
  h.plugin._collectionName = (guid) => guid === 'COL_NOTES' ? 'Notes' : guid === 'COL_PROJECTS' ? 'Projects' : '';
  h.plugin._recordCollectionIndex.set('REC_ONE', 'COL_NOTES');
  h.plugin._recordCollectionIndex.set('REC_TWO', 'COL_PROJECTS');
  let remoteCalls = 0;
  h.plugin.data.getAllCollections = async () => [{ getName: () => 'Notes', getAllRecords: async () => [{ guid: 'REC_ONE' }] }, { getName: () => 'Projects', getAllRecords: async () => [{ guid: 'REC_TWO' }] }];
  h.plugin.data.searchByQuery = async () => { remoteCalls++; return { records: [], lines: [] }; };
  let rows = await searchLine(h, 'alias:"Shared route"');
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => row.guid).sort())), ['LINE_ONE', 'LINE_TWO']);
  assert.equal(remoteCalls, 0);
  rows = await searchLine(h, 'alias:"Shared route" in:Notes');
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => row.guid))), ['LINE_ONE']);
  assert.equal(remoteCalls, 0);
});

test('L2 picking a line alias inserts its real GUID and preserves the alias as an unmanaged display title', async () => {
  const h = makeHarness();
  addLineAlias(h, 'LINE_TARGET', 'Canonical line text', ['Shortcut'], 'REC_OWNER', 'Playbook');
  const rows = await searchLine(h, 'Shortcut');
  let written = [{ type: 'text', text: '((Shortcut' }];
  const line = { guid: 'SOURCE_LINE', segments: written, setSegments: (next) => { written = next; } };
  h.records.set('PAGE', { guid: 'PAGE', getLineItems: async () => [line] });
  h.plugin._link = { kind: 'line', query: 'Shortcut', pageGuid: 'PAGE', lineGuid: 'SOURCE_LINE', br: '((', closingPair: null, picking: false };
  h.plugin._exitLinkMode = () => {}; h.plugin._liveStateByGuid = () => null; h.plugin._liveSegs = () => written;
  h.plugin._r5RecordFrecency = () => {}; h.plugin.getCachedCountInfo = () => ({ count: 1 });
  h.plugin._queueImmediateRefPaint = () => {};
  let managedCalls = 0; h.plugin._setAutoTitleManaged = async () => { managedCalls++; };
  const ok = await h.plugin._pickLink(rows[0]);
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(written.find((segment) => segment.type === 'ref'))),
    { type: 'ref', text: { guid: 'LINE_TARGET', title: 'Shortcut' } });
  assert.equal(managedCalls, 0);
  assert.equal(h.plugin._lineTargetText.get('LINE_TARGET'), 'Canonical line text');
});

test('L2 Alt+A offers explicit line-alias creation without changing ordinary Enter insertion', () => {
  const h = makeHarness();
  const result = { guid: 'LINE_TARGET', text: 'Canonical line', realTitle: 'Canonical line', rguid: 'REC_OWNER' };
  const link = { kind: 'line', query: 'shortcut', resultsQuery: 'shortcut', searchTimer: null, results: [result], sel: 0, userSelected: true, aliasCreating: false };
  h.plugin._link = link;
  const offer = h.plugin._linkAliasOffer(link);
  assert.equal(offer.kind, 'line');
  assert.equal(offer.result.guid, 'LINE_TARGET');
  assert.equal(offer.query, 'shortcut');
});
