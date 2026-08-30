'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

function loadPlugin(universe = {}, runtime = {}) {
  const ctx = {
    AppPlugin: class {},
    console,
    setTimeout: runtime.setTimeout || setTimeout,
    clearTimeout: runtime.clearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    DOMException,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    performance: { now: () => Date.now() },
    CSS: { escape: (value) => String(value) },
    navigator: { platform: 'MacIntel', clipboard: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, dataset: {}, append() {}, addEventListener() {}, setAttribute() {} }),
      createTextNode: (text) => ({ textContent: text }),
      documentElement: { clientHeight: 900 },
      body: { classList: { toggle() {}, add() {}, remove() {} }, append() {} },
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    Element: class {},
    window: {
      CSS: { escape: (value) => String(value) },
      g_universe: { itemsByGuid: universe, workspace: {} },
      addEventListener() {},
      removeEventListener() {},
    },
  };
  ctx.globalThis = ctx;
  Object.assign(ctx, ctx.window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', ctx, { filename: 'plugin.js' });
  const plugin = new ctx.PluginUnderTest();
  plugin._isUnloading = false;
  plugin._enabled = true;
  plugin._r5SessionGen = 1;
  plugin._r5ScopeStack = [];
  plugin._lineAliasByLine = new Map();
  plugin._aliasByRecord = new Map();
  plugin._renderLink = () => {};
  plugin.data = {
    getRecord: () => null,
    getAllCollections: async () => [],
    searchByQuery: async () => ({ lines: [], records: [] }),
  };
  return { plugin, ctx };
}

function makeLink() {
  return {
    kind: 'line',
    br: '((',
    query: '',
    results: [],
    resultPool: [],
    resultsQuery: null,
    resultsPreSliceCount: 0,
    resultsComplete: false,
    resultsCapReason: null,
    sel: 0,
    userSelected: false,
    token: 0,
    r5Session: 1,
    lineGuid: 'HOST_LINE',
    pageGuid: 'HOST_RECORD',
    textCache: new Map(),
    pop: { isConnected: true },
  };
}

function installLineIndex(ctx, overrides = {}) {
  ctx.window.__thymerLineIndexV1 = {
    contract: 'thymer-line-index-v1',
    version: 1,
    search: async () => ({
      items: [], complete: true, cursor: null, knownTotal: 0,
      capReason: null, queryRevision: 1,
    }),
    coOccur: () => ({
      items: [], complete: true, cursor: null, knownTotal: 0,
      capReason: null, queryRevision: 1,
    }),
    resolvedText: async () => null,
    ...overrides,
  };
}

async function runTwoPasses(plugin, link, query) {
  for (let pass = 0; pass < 2; pass++) {
    await plugin._runLinkSearch(query);
    if (link.scanDone) await link.scanDone;
  }
}

test('LI2: partial cold line-index hit resolves refs and retains native fallback', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  let nativeCalls = 0;
  let searchOptions = null;
  plugin.data.searchByQuery = async () => { nativeCalls++; return { lines: [], records: [] }; };
  installLineIndex(ctx, {
    search: async (query, options) => {
      assert.equal(query, 'celisse');
      searchOptions = options;
      return {
        items: [{ lineGuid: 'LINE_COLD', recordGuid: 'REC_COLD' }],
        complete: false, cursor: null, knownTotal: 1,
        capReason: 'line-index-building', queryRevision: 1,
      };
    },
    resolvedText: async (guid) => guid === 'LINE_COLD'
      ? 'League of Legends and calling Victoria g and Celisse'
      : null,
  });

  await plugin._runLinkSearch('celisse');
  await link.scanDone;

  assert.equal(Array.from(searchOptions.fields).join(','), 'own,resolved,context');
  assert.ok(searchOptions.signal, 'broker receives an AbortSignal');
  assert.ok(nativeCalls > 0, 'partial broker page retains native fallback');
  assert.equal(link.results.length, 1);
  assert.equal(link.results[0].guid, 'LINE_COLD');
  assert.match(link.results[0].text, /Victoria g.*Celisse/);
  assert.equal(link.resultsComplete, false);
});

test('v4.37.0: context-only media is admitted by filename and ranks below direct text', async () => {
  const universe = {
    LINE_DIRECT: {
      guid: 'LINE_DIRECT', rguid: 'REC_QUALITY', type: 'ulist',
      text_segments: ['text', 'Quality Leadership Meeting notes'],
    },
    LINE_EMPTY: {
      guid: 'LINE_EMPTY', rguid: 'REC_QUALITY', type: 'ulist',
      text_segments: [],
    },
  };
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  plugin._recordNameIndex = new Map([['REC_QUALITY', 'Quality Leadership Meeting']]);
  const mediaLine = {
    guid: 'LINE_IMAGE',
    type: 'image',
    props: {
      filename: 'pasted-2026-01-07-083951.png',
      fileguid: 'FILE_IMAGE',
      contentType: 'image/png',
    },
    segments: [],
  };
  plugin._resolveLineItemByGuid = async (lineGuid, recordGuid) => {
    assert.equal(recordGuid, 'REC_QUALITY');
    return lineGuid === 'LINE_IMAGE' ? mediaLine : null;
  };
  let searchFields = null;
  installLineIndex(ctx, {
    search: async (_query, options) => {
      searchFields = options.fields;
      return {
        items: [
          {
            lineGuid: 'LINE_DIRECT', recordGuid: 'REC_QUALITY',
            score: 2.5, fields: ['own', 'resolved', 'context'], contextOnly: false,
          },
          {
            lineGuid: 'LINE_IMAGE', recordGuid: 'REC_QUALITY',
            score: 0.4, fields: ['own', 'resolved', 'context'], contextOnly: true,
          },
        ],
        complete: true, cursor: null, knownTotal: 2, capReason: null, queryRevision: 1,
      };
    },
    resolvedText: async (guid) => guid === 'LINE_DIRECT'
      ? 'Quality Leadership Meeting notes'
      : null,
  });

  await plugin._runLinkSearch('quality leadership');
  await link.scanDone;

  assert.deepEqual(Array.from(searchFields), ['own', 'resolved', 'context']);
  const directIndex = link.results.findIndex((row) => row.guid === 'LINE_DIRECT');
  const imageIndex = link.results.findIndex((row) => row.guid === 'LINE_IMAGE');
  assert.ok(directIndex >= 0);
  assert.ok(imageIndex > directIndex);
  const image = link.results[imageIndex];
  assert.equal(image.text, 'pasted-2026-01-07-083951.png');
  assert.equal(image.contextOnly, true);
  assert.equal(image.media.kind, 'image');
  assert.ok(link.results[0].score > image.score);
  assert.equal(link.results.some((row) => row.guid === 'LINE_EMPTY'), false);
});

test('v4.34.0: an unknown recovery facade cannot outrank its clean current twin', async () => {
  const universe = {
    LINE_HISTORICAL: {
      guid: 'LINE_HISTORICAL',
      rguid: 'REC_JOURNAL',
      type: 'ulist',
      is_deleted: false,
      is_trashed: false,
      text_segments: [
        'ref', { guid: 'LINE_LIVE', title: 'Swabbing all that stuff' },
        'text', ' <!-- roam-recovery-meta; source-kind: json_manual_block; -->',
      ],
    },
  };
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  const liveLine = {
    guid: 'LINE_LIVE',
    type: 'ulist',
    segments: [{ type: 'text', text: '- Swabbing all that stuff' }],
    getRecord: () => ({ guid: 'REC_TRANSCRIPT', getName: () => 'Notes/Transcript' }),
  };
  plugin.data.searchByQuery = async () => ({ lines: [liveLine], records: [] });
  installLineIndex(ctx, {
    search: async () => ({
      items: [
        { lineGuid: 'LINE_HISTORICAL', recordGuid: 'REC_JOURNAL' },
        { lineGuid: 'LINE_LIVE', recordGuid: 'REC_TRANSCRIPT' },
      ],
      complete: true, cursor: null, knownTotal: 2, capReason: null, queryRevision: 1,
    }),
    resolvedText: async () => 'Swabbing all that stuff',
  });

  await plugin._runLinkSearch('swabbing all that stuff');
  await link.scanDone;

  assert.equal(link.results.some((row) => row.guid === 'LINE_HISTORICAL'), false);
  assert.equal(link.results.some((row) => row.guid === 'LINE_LIVE'), true);
  assert.equal(plugin._pickerResultIsLive({
    guid: 'LINE_HISTORICAL',
    rguid: 'REC_JOURNAL',
  }), true, 'warm recovery facade is not misclassified as trash');
  assert.equal(plugin._pickerResultLiveness({
    guid: 'LINE_HISTORICAL',
    rguid: 'REC_JOURNAL',
  }), 'live');
});

test('LI2: empty complete coOccur page preserves warm and native fallback on pass two', async () => {
  const universe = {
    WARM_TEXT_ONLY: {
      guid: 'WARM_TEXT_ONLY', rguid: 'REC_OTHER', type: 'ulist',
      text_segments: ['text', 'Celisse and Victoria are ordinary text here'],
    },
  };
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  plugin._recordNameIndex = new Map([
    ['REC_CELISSE', 'Celisse'],
    ['REC_VICTORIA', 'Victoria g'],
  ]);
  let coOccurArgs = null;
  let searchCalls = 0;
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => { nativeCalls++; return { lines: [], records: [] }; };
  installLineIndex(ctx, {
    coOccur: (guidA, guidB) => {
      coOccurArgs = [guidA, guidB];
      return {
        items: [],
        complete: true, cursor: null, knownTotal: 0, capReason: null, queryRevision: 1,
      };
    },
    search: async () => { searchCalls++; throw new Error('force native fallback'); },
  });

  await plugin._runLinkSearch('celisse');
  await link.scanDone;
  await plugin._runLinkSearch('celisse + victoria');
  await link.scanDone;

  assert.deepEqual(coOccurArgs, ['REC_CELISSE', 'REC_VICTORIA']);
  assert.equal(searchCalls, 2);
  assert.ok(nativeCalls > 0);
  assert.equal(link.results.length, 1);
  assert.equal(link.results[0].guid, 'WARM_TEXT_ONLY');
  assert.equal(link.resultsComplete, false);
});

test('LI2: an unresolved co-occurrence clause falls back to text-AND search', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  plugin._recordNameIndex = new Map([['REC_CELISSE', 'Celisse']]);
  let coOccurCalls = 0;
  let searchQuery = null;
  installLineIndex(ctx, {
    coOccur: () => { coOccurCalls++; throw new Error('unresolved pair must not use coOccur'); },
    search: async (query) => {
      searchQuery = query;
      return {
        items: [{ lineGuid: 'LINE_TEXT_AND', recordGuid: 'REC_OWNER' }],
        complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
      };
    },
    resolvedText: async () => 'Celisse met Nobody here',
  });

  await plugin._runLinkSearch('celisse + nobody');
  await link.scanDone;

  assert.equal(coOccurCalls, 0);
  assert.equal(searchQuery, 'celisse + nobody');
  assert.equal(link.results.length, 1);
  assert.equal(link.results[0].guid, 'LINE_TEXT_AND');
});

test('LI2: partial broker coverage remains partial and carries capReason into RefX', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => { nativeCalls++; return { lines: [], records: [] }; };
  installLineIndex(ctx, {
    search: async () => ({
      items: [{ lineGuid: 'LINE_PARTIAL', recordGuid: 'REC_PARTIAL' }],
      complete: false, cursor: null, knownTotal: null,
      capReason: 'line-index-building', queryRevision: 2,
    }),
    resolvedText: async () => 'Celisse partial result',
  });

  await plugin._runLinkSearch('celisse');
  await link.scanDone;

  assert.ok(nativeCalls > 0, 'partial broker coverage falls back to native search');
  assert.equal(link.resultsComplete, false);
  assert.equal(link.resultsCapReason, 'line-index-building');
});

test('LI2: absent broker preserves the existing native line-search path', async () => {
  const { plugin } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  const record = { guid: 'REC_NATIVE', getName: () => 'Native page' };
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => {
    nativeCalls++;
    return {
      records: [],
      lines: [{
        guid: 'LINE_NATIVE',
        type: 'ulist',
        segments: [{ type: 'text', text: 'Celisse native line' }],
        getRecord: () => record,
      }],
    };
  };

  await plugin._runLinkSearch('celisse');

  assert.ok(nativeCalls > 0);
  assert.ok(link.results.some((row) => row.guid === 'LINE_NATIVE'));
  assert.equal(link.resultsComplete, false);
});

test('LI2: scheduling the next keystroke aborts the active broker request immediately', () => {
  const { plugin } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  let aborted = 0;
  link.lineIndexAbort = { abort() { aborted++; } };

  plugin._scheduleLinkSearch();
  clearTimeout(link.searchTimer);

  assert.equal(aborted, 1);
  assert.equal(link.lineIndexAbort, null);
});

test('LI2: restored semantic leg contributes line hits when lexical sources leave room', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  let semanticCalls = 0;
  ctx.window.__thymerSemanticV1 = {
    search: async () => {
      semanticCalls++;
      return {
        hits: [{
          kind: 'line', lineGuid: 'LINE_SEMANTIC', recordGuid: 'REC_SEMANTIC',
          name: 'Monica semantic line', score: 0.9,
        }],
      };
    },
  };
  plugin._pickerMarkLineLive('LINE_SEMANTIC', 'REC_SEMANTIC', true);

  await plugin._runLinkSearch('monica');

  assert.equal(semanticCalls, 1);
  assert.ok(link.results.some((row) => row.guid === 'LINE_SEMANTIC'));
});

test('LI2: zero-item complete search page falls through to native on both passes', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  const record = { guid: 'REC_NATIVE', getName: () => 'Native page' };
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => {
    nativeCalls++;
    return {
      records: [],
      lines: [{
        guid: 'LINE_NATIVE',
        type: 'ulist',
        segments: [{ type: 'text', text: 'Celisse native fallback' }],
        getRecord: () => record,
      }],
    };
  };
  installLineIndex(ctx);

  await runTwoPasses(plugin, link, 'celisse');

  assert.ok(nativeCalls >= 2);
  assert.ok(link.results.some((row) => row.guid === 'LINE_NATIVE'));
  assert.equal(link.resultsComplete, false);
});

test('LI2: non-conforming broker preserves native results on both passes', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  ctx.window.__thymerLineIndexV1 = {
    contract: 'thymer-line-index-v1',
    version: 2,
    search: async () => { throw new Error('must not call a v2 broker'); },
    resolvedText: async () => null,
  };
  const record = { guid: 'REC_NATIVE', getName: () => 'Native page' };
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => {
    nativeCalls++;
    return {
      records: [],
      lines: [{
        guid: 'LINE_NATIVE',
        type: 'ulist',
        segments: [{ type: 'text', text: 'Celisse native line' }],
        getRecord: () => record,
      }],
    };
  };

  await runTwoPasses(plugin, link, 'celisse');

  assert.ok(nativeCalls >= 2);
  assert.ok(link.results.some((row) => row.guid === 'LINE_NATIVE'));
});

test('LI2: hanging broker times out into native fallback on both passes', { timeout: 5000 }, async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  const record = { guid: 'REC_NATIVE', getName: () => 'Native page' };
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => {
    nativeCalls++;
    return {
      records: [],
      lines: [{
        guid: 'LINE_NATIVE',
        type: 'ulist',
        segments: [{ type: 'text', text: 'Celisse survives timeout' }],
        getRecord: () => record,
      }],
    };
  };
  installLineIndex(ctx, { search: () => new Promise(() => {}) });

  await runTwoPasses(plugin, link, 'celisse');

  assert.ok(nativeCalls >= 2);
  assert.ok(link.results.some((row) => row.guid === 'LINE_NATIVE'));
  assert.equal(link.resultsComplete, false);
  assert.equal(link.resultsCapReason, 'line-index-timeout');
});

test('LI2: is:task cold hit retries with resolved text on both passes', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  plugin._resolveLineItemByGuid = async () => ({
    guid: 'LINE_TASK',
    type: 'task',
    segments: [{ type: 'ref', guid: 'TARGET_COLD' }],
  });
  plugin._isTaskLikeLine = (line) => line?.type === 'task';
  plugin._isTaskLikeLineDone = () => false;
  let resolvedTextCalls = 0;
  installLineIndex(ctx, {
    search: async () => ({
      items: [{ lineGuid: 'LINE_TASK', recordGuid: 'REC_TASKS' }],
      complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
    }),
    resolvedText: async () => {
      resolvedTextCalls++;
      return 'Calling Celisse about the launch';
    },
  });

  await runTwoPasses(plugin, link, 'celisse is:task');

  assert.equal(resolvedTextCalls, 2);
  assert.equal(link.results.length, 1);
  assert.equal(link.results[0].guid, 'LINE_TASK');
  assert.match(link.results[0].text, /Celisse/);
  assert.equal(link.results[0].task.is, true);
});

test('LI2: unresolved collection GUIDs retain native fallback on both passes', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  const record = { guid: 'REC_NATIVE', getName: () => 'Native page' };
  plugin.data.getAllCollections = async () => [{
    getName: () => 'Ghost',
    getAllRecords: async () => [record],
  }];
  let brokerCalls = 0;
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => {
    nativeCalls++;
    return {
      records: [],
      lines: [{
        guid: 'LINE_NATIVE',
        type: 'ulist',
        segments: [{ type: 'text', text: 'Celisse in Ghost' }],
        getRecord: () => record,
      }],
    };
  };
  installLineIndex(ctx, {
    search: async () => {
      brokerCalls++;
      return { items: [], complete: true, knownTotal: 0 };
    },
  });

  await runTwoPasses(plugin, link, 'celisse in:ghost');

  assert.equal(brokerCalls, 0);
  assert.ok(nativeCalls >= 2);
  assert.ok(link.results.some((row) => row.guid === 'LINE_NATIVE'));
  assert.equal(link.resultsComplete, false);
  assert.equal(link.resultsCapReason, 'collection-filter-unresolved');
});

test('LI2: an aborted first pass cannot land after the replacement pass', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  let resolveFirst = null;
  installLineIndex(ctx, {
    search: (query) => {
      if (query === 'first') {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({
        items: [{ lineGuid: 'LINE_SECOND', recordGuid: 'REC_SECOND' }],
        complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 2,
      });
    },
    resolvedText: async (guid) => guid === 'LINE_SECOND' ? 'Second result' : 'First stale result',
  });

  const firstPass = plugin._runLinkSearch('first');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof resolveFirst, 'function');
  await plugin._runLinkSearch('second');
  resolveFirst({
    items: [{ lineGuid: 'LINE_FIRST', recordGuid: 'REC_FIRST' }],
    complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
  });
  await firstPass;

  assert.equal(link.results.map((row) => row.guid).join(','), 'LINE_SECOND');
  assert.equal(link.resultsQuery, 'second');
});

test('LI3: empty picker opens with recent and loaded recognition choices on both passes', async () => {
  const universe = {
    LINE_LOADED: {
      guid: 'LINE_LOADED', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Loaded workspace choice'],
    },
    LINE_RECENT: {
      guid: 'LINE_RECENT', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Recently referenced choice'],
    },
  };
  const { plugin } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  plugin._recordNameIndex = new Map([['REC_HOME', 'Home']]);
  plugin._r5FrecencyCache = {
    LINE_RECENT: { uses: 4, lastUsedAt: Date.now() },
  };

  await runTwoPasses(plugin, link, '');

  assert.equal(link.emptySuggestions, true);
  assert.ok(link.results.length >= 2);
  assert.equal(link.results[0].guid, 'LINE_RECENT');
  assert.ok(link.results.some((row) => row.guid === 'LINE_LOADED'));
  assert.equal(link.resultsComplete, true);
});

test('LI3: unordered token prefixes and initials never empty a correct query on either pass', async () => {
  const universe = {
    LINE_PREFIX: {
      guid: 'LINE_PREFIX', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Victoria called Celisse today'],
    },
    LINE_INITIALS: {
      guid: 'LINE_INITIALS', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Celisse Victoria Green'],
    },
  };
  const { plugin } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;

  await runTwoPasses(plugin, link, 'cel vic');
  assert.ok(link.results.some((row) => row.guid === 'LINE_PREFIX'));

  await runTwoPasses(plugin, link, 'cvg');
  assert.ok(link.results.some((row) => row.guid === 'LINE_INITIALS'));
});

test('LI3: exact page landmark offers a counted mentions step on both passes', async () => {
  const universe = {
    LINE_EXACT: {
      guid: 'LINE_EXACT', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Celisse'],
    },
    LINE_MENTION: {
      guid: 'LINE_MENTION', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Celisse discussed the launch'],
    },
  };
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  plugin._recordNameIndex = new Map([
    ['REC_CELISSE', 'Celisse'],
    ['REC_HOME', 'Home'],
  ]);
  plugin._pickerMarkRecordLive('REC_CELISSE', true);
  plugin.getCachedCountInfo = (guid) => guid === 'REC_CELISSE' ? { count: 7, capped: false } : null;
  let navigatorOptions = null;
  plugin._openReferenceNavigator = (options) => { navigatorOptions = options; return true; };
  installLineIndex(ctx, {
    search: async () => ({
      items: [{ lineGuid: 'LINE_MENTION', recordGuid: 'REC_HOME' }],
      complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
    }),
  });

  await runTwoPasses(plugin, link, 'celisse');

  const landmark = link.results.find((row) => row.matchKind === 'mentions');
  assert.ok(landmark);
  assert.equal(link.results[0].guid, 'LINE_EXACT');
  assert.equal(link.sel, 0);
  assert.equal(landmark.guid, 'REC_CELISSE');
  assert.equal(landmark.text, 'Celisse — 7 mentions →');
  link.sel = link.results.indexOf(landmark);
  link.userSelected = true;
  plugin._r5DrillInto(link);
  assert.equal(navigatorOptions.targetGuid, 'REC_CELISSE');
  assert.equal(navigatorOptions.referencesExpanded, true);
  assert.equal(navigatorOptions.origin, null);
});

test('LI2d H-B: absent broker never invokes the workspace-wide clause resolver', async () => {
  const { plugin } = loadPlugin({
    LINE_NATIVE: {
      guid: 'LINE_NATIVE', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Celisse native line'],
    },
  });
  const link = makeLink();
  plugin._link = link;
  let clauseCalls = 0;
  plugin._lineIndexClauseTarget = () => { clauseCalls++; return 'REC_CELISSE'; };

  await plugin._runLinkSearch('celisse');
  if (link.scanDone) await link.scanDone;

  assert.equal(clauseCalls, 0);
  assert.equal(link.results[0].guid, 'LINE_NATIVE');
});

test('LI2d M-A/H3: authoritative co-occurrence waits for the current registry scan', async () => {
  const universe = {};
  for (let i = 0; i < 6000; i++) {
    universe['LINE_' + i] = {
      guid: 'LINE_' + i, rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Celisse and Victoria result ' + i],
    };
  }
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  plugin._recordNameIndex = new Map([
    ['REC_CELISSE', 'Celisse'],
    ['REC_VICTORIA', 'Victoria'],
  ]);
  installLineIndex(ctx, {
    coOccur: () => ({
      items: [{ lineGuid: 'LINE_0', recordGuid: 'REC_HOME' }],
      complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
    }),
    search: async () => { throw new Error('authoritative co-occurrence must not fall through'); },
  });

  await plugin._runLinkSearch('celisse + victoria');

  assert.equal(link.scanComplete, false);
  assert.equal(link.resultsComplete, false);
  await link.scanDone;
  assert.equal(link.scanComplete, true);
  assert.equal(link.resultsComplete, true);
});

test('LI2d M-B: a legitimate filter rejection does not invalidate an authoritative page', async () => {
  const universe = {
    LINE_TASK: {
      guid: 'LINE_TASK', rguid: 'REC_HOME', type: 'task',
      props: { done: 0 }, text_segments: ['text', 'Celisse task'],
    },
    LINE_NOTE: {
      guid: 'LINE_NOTE', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Celisse note'],
    },
  };
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => { nativeCalls++; return { lines: [], records: [] }; };
  installLineIndex(ctx, {
    search: async () => ({
      items: [
        { lineGuid: 'LINE_TASK', recordGuid: 'REC_HOME' },
        { lineGuid: 'LINE_NOTE', recordGuid: 'REC_HOME' },
      ],
      complete: true, cursor: null, knownTotal: 2, capReason: null, queryRevision: 1,
    }),
  });

  await plugin._runLinkSearch('celisse is:task');
  await link.scanDone;

  assert.equal(nativeCalls, 0);
  assert.equal(link.results.map((row) => row.guid).join(','), 'LINE_TASK');
  assert.equal(link.resultsComplete, true);
});

test('LI2d M-C: a warm line with a cold ref target retries resolvedText', async () => {
  const universe = {
    LINE_WARM: {
      guid: 'LINE_WARM', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['ref', { guid: 'TARGET_COLD' }],
    },
  };
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  let resolvedTextCalls = 0;
  installLineIndex(ctx, {
    search: async () => ({
      items: [{ lineGuid: 'LINE_WARM', recordGuid: 'REC_HOME' }],
      complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
    }),
    resolvedText: async () => {
      resolvedTextCalls++;
      return 'Celisse resolved through the cold target';
    },
  });

  await plugin._runLinkSearch('celisse');
  await link.scanDone;

  assert.equal(resolvedTextCalls, 1);
  assert.equal(link.results[0].guid, 'LINE_WARM');
  assert.match(link.results[0].text, /Celisse/);
});

test('LI2d M4: an unresolved broker item prevents authoritative completion', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  let nativeCalls = 0;
  plugin.data.searchByQuery = async () => { nativeCalls++; return { lines: [], records: [] }; };
  installLineIndex(ctx, {
    search: async () => ({
      items: [
        { lineGuid: 'LINE_VALID', recordGuid: 'REC_HOME' },
        { lineGuid: 'LINE_INVALID', recordGuid: '' },
      ],
      complete: true, cursor: null, knownTotal: 2, capReason: null, queryRevision: 1,
    }),
    resolvedText: async (guid) => guid === 'LINE_VALID' ? 'Celisse valid result' : null,
  });

  await plugin._runLinkSearch('celisse');

  assert.ok(nativeCalls > 0);
  assert.equal(link.resultsComplete, false);
  assert.ok(link.results.some((row) => row.guid === 'LINE_VALID'));
});

test('LI2d H1: resolved text scoring retains native filter segments', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  const nativeSegments = [
    { type: 'ref', text: { guid: 'TARGET_COLD' } },
    { type: 'datetime', text: { d: '20240102' } },
  ];
  plugin._resolveLineItemByGuid = async () => ({
    guid: 'LINE_FILTERED', type: 'ulist', segments: nativeSegments,
  });
  const seenSegments = [];
  plugin._r5FilterRow = (row) => {
    seenSegments.push(row.segments);
    return true;
  };
  installLineIndex(ctx, {
    search: async () => ({
      items: [{ lineGuid: 'LINE_FILTERED', recordGuid: 'REC_HOME' }],
      complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
    }),
    resolvedText: async () => 'Celisse resolved text',
  });

  await plugin._runLinkSearch('celisse after:2020-01-01');

  assert.ok(seenSegments.some((segments) => segments === nativeSegments));
  assert.equal(link.results[0].guid, 'LINE_FILTERED');
});

test('LI2d M2: semantic rows survive a later settled registry publish', async () => {
  const universe = {};
  for (let i = 0; i < 6000; i++) {
    universe['OTHER_' + i] = {
      guid: 'OTHER_' + i, rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'unrelated registry line ' + i],
    };
  }
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  ctx.window.__thymerSemanticV1 = {
    search: async () => ({
      hits: [{
        kind: 'line', lineGuid: 'LINE_SEMANTIC', recordGuid: 'REC_HOME',
        name: 'Monica semantic result', score: 0.9,
      }],
    }),
  };
  plugin._pickerMarkLineLive('LINE_SEMANTIC', 'REC_HOME', true);

  await plugin._runLinkSearch('monica');
  assert.ok(link.results.some((row) => row.guid === 'LINE_SEMANTIC'));
  await link.scanDone;
  assert.ok(link.resultPool.some((row) => row.guid === 'LINE_SEMANTIC'));
  assert.ok(link.results.some((row) => row.guid === 'LINE_SEMANTIC'));
});

test('LI2d L4: a settled broker request clears its timeout', async () => {
  const timers = [];
  const cleared = [];
  const runtime = {
    setTimeout(fn, ms) {
      const token = { fn, ms };
      timers.push(token);
      return token;
    },
    clearTimeout(token) { cleared.push(token); },
  };
  const { plugin, ctx } = loadPlugin({}, runtime);
  const link = makeLink();
  plugin._link = link;
  installLineIndex(ctx, {
    search: async () => ({
      items: [{ lineGuid: 'LINE_COLD', recordGuid: 'REC_HOME' }],
      complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
    }),
    resolvedText: async () => 'Celisse result',
  });

  await plugin._runLinkSearch('celisse');

  const timeout = timers.find((timer) => timer.ms === 1500);
  assert.ok(timeout);
  assert.ok(cleared.includes(timeout));
});

test('LI2d L6: a throwing broker global preserves native search', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  Object.defineProperty(ctx.window, '__thymerLineIndexV1', {
    configurable: true,
    get() { throw new Error('cross-realm broker getter'); },
  });
  const record = { guid: 'REC_HOME', getName: () => 'Home' };
  plugin.data.searchByQuery = async () => ({
    records: [],
    lines: [{
      guid: 'LINE_NATIVE', type: 'ulist',
      segments: [{ type: 'text', text: 'Celisse native fallback' }],
      getRecord: () => record,
    }],
  });

  await plugin._runLinkSearch('celisse');

  assert.equal(link.results[0].guid, 'LINE_NATIVE');
});

test('LI2d M-D: zero-state traversal is bounded and does not reverse Object.keys', () => {
  assert.doesNotMatch(source, /const loadedGuids = Object\.keys\(byGuid\)\.reverse\(\)/);
  assert.match(source, /for \(const guid in byGuid\) \{\s+take\(\[guid\], 'loaded'\);\s+if \(ordered\.length >= limit \* 8\) break;/);
});

test('LI2d M-E/L-c: landmarks use cached counts only and suppress cached zero', async () => {
  const universe = {
    LINE_EXACT: {
      guid: 'LINE_EXACT', rguid: 'REC_HOME', type: 'ulist',
      text_segments: ['text', 'Celisse'],
    },
  };
  const { plugin, ctx } = loadPlugin(universe);
  const link = makeLink();
  plugin._link = link;
  plugin._recordNameIndex = new Map([['REC_CELISSE', 'Celisse']]);
  plugin._pickerMarkRecordLive('REC_CELISSE', true);
  plugin._countCache = new Map();
  let coldCountCalls = 0;
  plugin.getCountInfoForGuid = async () => { coldCountCalls++; return { count: 7 }; };
  plugin.getCachedCountInfo = () => null;
  installLineIndex(ctx, {
    search: async () => ({
      items: [{ lineGuid: 'LINE_EXACT', recordGuid: 'REC_HOME' }],
      complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
    }),
  });

  await plugin._runLinkSearch('celisse');
  assert.equal(coldCountCalls, 0);
  assert.ok(link.results.some((row) => row.matchKind === 'mentions'));

  plugin.getCachedCountInfo = () => ({ count: 0, capped: false });
  await plugin._runLinkSearch('celisse');
  assert.equal(coldCountCalls, 0);
  assert.equal(link.results.some((row) => row.matchKind === 'mentions'), false);
});

test('LI2d M-G: every broker cap reason has an explicit user-facing label', () => {
  const { plugin } = loadPlugin();
  const reasons = [
    'terms-filtered',
    'line-index-degraded',
    'cursor-stale',
    'line-index-guid-unknown',
    'tombstoned-filtered',
    'reference-surface-partial',
  ];
  for (const reason of reasons) {
    assert.notEqual(plugin._lineIndexPartialLabel(reason), 'more may exist', reason);
  }
});

test('LI2d L-a: clicking a mentions preview opens Navigator instead of inserting a record ref', () => {
  const { plugin } = loadPlugin();
  const link = makeLink();
  let previewHandler = null;
  const element = () => ({
    style: {}, dataset: {}, isConnected: true, textContent: '',
    classList: { add() {}, remove() {} },
    append() {}, remove() {}, setAttribute() {},
    addEventListener(type, handler) {
      if (type === 'mousedown') previewHandler = handler;
    },
  });
  const pane = element();
  link.previewEl = pane;
  plugin._link = link;
  plugin._el = () => element();
  plugin._recCardFields = () => [];
  plugin._buildPickerRowCrumb = () => '';
  plugin.data.getRecord = () => ({
    getName: () => 'Celisse',
    getLineItems: async () => [],
  });
  let navigatorCalls = 0;
  let pickCalls = 0;
  plugin._openPickerMentions = () => { navigatorCalls++; };
  plugin._pickLink = () => { pickCalls++; };

  plugin._fillLinkPreview(link, {
    guid: 'REC_CELISSE', text: 'Celisse — mentions →', matchKind: 'mentions',
  });
  assert.equal(typeof previewHandler, 'function');
  previewHandler({ preventDefault() {} });

  assert.equal(navigatorCalls, 1);
  assert.equal(pickCalls, 0);
});

test('LI2d L-b: Alt+A never aliases a mentions landmark display label', () => {
  const { plugin } = loadPlugin();
  const link = makeLink();
  link.query = 'celisse';
  link.resultsQuery = 'celisse';
  link.results = [{
    guid: 'REC_CELISSE', text: 'Celisse — 7 mentions →', matchKind: 'mentions',
  }];
  link.resultPool = link.results.slice();
  plugin._link = link;
  let promptCalls = 0;
  plugin._openAliasPromptInPicker = () => { promptCalls++; };
  plugin._toast = () => {};

  plugin._linkKey({
    key: 'a', code: 'KeyA', altKey: true, metaKey: false, ctrlKey: false,
    preventDefault() {}, stopImmediatePropagation() {},
  });

  assert.equal(promptCalls, 0);
});

test('LI2d L-d: semantic record failures stay out of Line Index diagnostics', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  ctx.window.__REFX_LINEINDEX_LAST_ERROR = 'line-index-sentinel';
  ctx.window.__thymerSemanticV1 = {
    search: async () => ({
      hits: [{
        kind: 'line', lineGuid: 'LINE_SEMANTIC', recordGuid: 'REC_HOME',
        name: 'Monica semantic result', score: 0.9,
      }],
    }),
  };
  plugin._pickerMarkLineLive('LINE_SEMANTIC', 'REC_HOME', true);
  plugin.data.getRecord = () => { throw new Error('semantic page lookup failed'); };

  await plugin._runLinkSearch('monica');

  assert.equal(ctx.window.__REFX_LINEINDEX_LAST_ERROR, 'line-index-sentinel');
  assert.match(ctx.window.__REFX_SEMANTIC_LAST_ERROR, /semantic page lookup failed/);
});

test('LI2d L-f: exact-guid and unparseable exits replace stale completeness metadata', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  installLineIndex(ctx, {
    search: async () => ({
      items: [{ lineGuid: 'LINE_COLD', recordGuid: 'REC_HOME' }],
      complete: true, cursor: null, knownTotal: 1, capReason: null, queryRevision: 1,
    }),
    resolvedText: async () => 'Celisse result',
  });
  await plugin._runLinkSearch('celisse');

  link.resultsComplete = true;
  link.resultsCapReason = 'stale-cap';
  link.resultsPreSliceCount = 9;
  await plugin._runLinkSearch('!!!');
  assert.equal(link.resultsPreSliceCount, 0);
  assert.equal(link.resultsComplete, false);
  assert.equal(link.resultsCapReason, null);

  link.resultsComplete = false;
  link.resultsCapReason = 'stale-cap';
  link.resultsPreSliceCount = 9;
  await plugin._runLinkSearch('1234567890ABCDEFGHIJ');
  assert.equal(link.resultsPreSliceCount, 1);
  assert.equal(link.resultsComplete, true);
  assert.equal(link.resultsCapReason, null);
});

test('LI2d L-h: cold broker text resolutions start concurrently', async () => {
  const { plugin, ctx } = loadPlugin();
  const link = makeLink();
  plugin._link = link;
  const pending = [];
  installLineIndex(ctx, {
    search: async () => ({
      items: [
        { lineGuid: 'LINE_A', recordGuid: 'REC_HOME' },
        { lineGuid: 'LINE_B', recordGuid: 'REC_HOME' },
      ],
      complete: true, cursor: null, knownTotal: 2, capReason: null, queryRevision: 1,
    }),
    resolvedText: (guid) => new Promise((resolve) => {
      pending.push({ guid, resolve });
    }),
  });

  const search = plugin._runLinkSearch('celisse');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  for (const item of pending) item.resolve('Celisse ' + item.guid);
  await search;

  assert.deepEqual(new Set(link.results.map((row) => row.guid)), new Set(['LINE_A', 'LINE_B']));
});
