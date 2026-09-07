const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
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

function hostState() {
  return { guid: 'HOST', rguid: 'PAGE', text_segments: ['text', 'ab', 'ref', { guid: 'X' }, 'text', 'cd'] };
}

function instanceWithHost(lvExtra = {}) {
  const { Plugin, context } = loadPlugin();
  const plugin = new Plugin();
  plugin._isUnloading = false;
  plugin._enabled = true;
  const state = hostState();
  const lv = {
    hasFocus: () => false,
    getItems: () => [{ state }],
    selection: {},
    ...lvExtra
  };
  if (!context.window.g_universe.listviews) context.window.g_universe.listviews = [];
  context.window.g_universe.listviews = [lv];
  return { plugin, context, state, lv };
}

test('_caretInfo() with no opts and no _caret returns null (opt-in lock)', () => {
  const { plugin } = instanceWithHost();
  assert.equal(plugin._caretInfo(), null);
  assert.equal(plugin._caretInfo(undefined), null);
  assert.equal(plugin._caretInfo({}), null);
});

test('_flatCaretOffset: index 4 is 4; index 0 / missing linespan stay local', () => {
  const { plugin, state } = instanceWithHost();
  assert.equal(plugin._flatCaretOffset({
    grapheme_offset: 1,
    linespan: { segment_index: 4 }
  }, state), 4);
  assert.equal(plugin._flatCaretOffset({
    grapheme_offset: 1,
    linespan: { segment_index: 0 }
  }, state), 1);
  assert.equal(plugin._flatCaretOffset({ grapheme_offset: 2 }, state), 2);
});

test('_caretInfo({fallback:true}) Tier A uses focused listview _caret.pos', () => {
  const state = hostState();
  const { plugin } = instanceWithHost({
    hasFocus: () => true,
    getItems: () => [{ state }],
    selection: {
      _caret: {
        pos: {
          list_item: { state },
          grapheme_offset: 1,
          linespan: { segment_index: 0 }
        }
      }
    }
  });
  const info = plugin._caretInfo({ fallback: true });
  assert.ok(info);
  assert.equal(info.lineGuid, 'HOST');
  assert.equal(info.offset, 1);
});

test('_caretInfo({fallback:true}) Tier B collapsed g_range uses flat offset', () => {
  const { plugin, context, state } = instanceWithHost();
  const P = {
    list_item: { state },
    grapheme_offset: 1,
    linespan: { segment_index: 4 }
  };
  context.window.g_range = { first_pos: P, last_pos: P };
  const info = plugin._caretInfo({ fallback: true });
  assert.ok(info);
  assert.equal(info.lineGuid, 'HOST');
  assert.equal(info.offset, 4);
});

test('_caretInfo({fallback:true}) Tier B non-collapsed and no DOM caret is null', () => {
  const { plugin, context, state } = instanceWithHost();
  const linespan = { segment_index: 4 };
  context.window.g_range = {
    first_pos: { list_item: { state }, linespan, grapheme_offset: 1 },
    last_pos: { list_item: { state }, linespan, grapheme_offset: 2 }
  };
  assert.equal(plugin._caretInfo({ fallback: true }), null);
});

test('_caretInfo({fallback:true}) Tier B collapsed g_range without linespan uses grapheme_offset', () => {
  const { plugin, context, state } = instanceWithHost();
  const P = { list_item: { state }, grapheme_offset: 2 };
  context.window.g_range = { first_pos: P, last_pos: P };
  const info = plugin._caretInfo({ fallback: true });
  assert.ok(info);
  assert.equal(info.lineGuid, 'HOST');
  assert.equal(info.offset, 2);
});

test('_caretInfo({fallback:true}) Tier C uses listitem-with-caret DOM line', () => {
  const { plugin, context } = instanceWithHost();
  context.document.querySelector = (sel) => {
    if (String(sel).includes('listitem-with-caret')) return { getAttribute: () => 'HOST' };
    return null;
  };
  const info = plugin._caretInfo({ fallback: true });
  assert.ok(info);
  assert.equal(info.lineGuid, 'HOST');
  assert.equal(info.offset, null);
});

function pasteEvent(overrides = {}) {
  const flags = { prevented: false, stopped: false };
  const e = {
    clipboardData: { getData: () => 'thymer-ref://TGT' },
    target: null,
    preventDefault() { flags.prevented = true; },
    stopImmediatePropagation() { flags.stopped = true; },
    ...overrides
  };
  return { e, flags };
}

function setupPasteWrite(plugin) {
  let captured = null;
  plugin.data = { getRecord: (g) => g === 'TGT' ? {} : null };
  plugin._toast = () => {};
  plugin._resolveLineItemByGuid = async () => ({
    setSegments: async (segs) => { captured = segs; return true; }
  });
  return () => captured;
}

async function flushInsert() {
  await Promise.resolve();
  await Promise.resolve();
}

test('Tier A paste: focused _caret.pos offset 1 inserts ref in "ab"', async () => {
  const state = hostState();
  const { plugin } = instanceWithHost({
    hasFocus: () => true,
    getItems: () => [{ state }],
    selection: {
      _caret: {
        pos: {
          list_item: { state },
          grapheme_offset: 1,
          linespan: { segment_index: 0 }
        }
      }
    }
  });
  const getCaptured = setupPasteWrite(plugin);
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.ok(flags.prevented);
  const segs = getCaptured();
  assert.ok(segs);
  const abIdx = segs.findIndex((s) => s.type === 'text' && s.text === 'a');
  assert.ok(abIdx >= 0);
  assert.equal(segs[abIdx + 1].type, 'ref');
  assert.equal(segs[abIdx + 1].text.guid, 'TGT');
  assert.equal(segs[abIdx + 2].type, 'text');
  assert.equal(segs[abIdx + 2].text, 'b');
});

test('Tier B paste: collapsed g_range segment_index 4 inserts at flat offset 4', async () => {
  const { plugin, context, state } = instanceWithHost();
  const P = {
    list_item: { state },
    grapheme_offset: 1,
    linespan: { segment_index: 4 }
  };
  context.window.g_range = { first_pos: P, last_pos: P };
  const getCaptured = setupPasteWrite(plugin);
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.ok(flags.prevented);
  const segs = getCaptured();
  assert.ok(segs);
  const refIdx = segs.findIndex((s) => s.type === 'ref' && s.text.guid === 'TGT');
  assert.ok(refIdx >= 0);
  assert.equal(segs[refIdx - 1].text, 'c');
  assert.equal(segs[refIdx + 1].text, 'd');
});

test('non-collapsed g_range with no DOM caret does not intercept paste', async () => {
  const { plugin, context, state } = instanceWithHost();
  const linespan = { segment_index: 4 };
  context.window.g_range = {
    first_pos: { list_item: { state }, linespan, grapheme_offset: 1 },
    last_pos: { list_item: { state }, linespan, grapheme_offset: 2 }
  };
  const getCaptured = setupPasteWrite(plugin);
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.equal(flags.prevented, false);
  assert.equal(getCaptured(), null);
});

test('non-collapsed g_range with DOM line still does not intercept paste', async () => {
  const { plugin, context, state } = instanceWithHost();
  const linespan = { segment_index: 4 };
  context.window.g_range = {
    first_pos: { list_item: { state }, linespan, grapheme_offset: 1 },
    last_pos: { list_item: { state }, linespan, grapheme_offset: 2 }
  };
  context.document.querySelector = (sel) => {
    if (String(sel).includes('.listitem[data-guid="HOST"]')) return { getAttribute: () => 'HOST' };
    return null;
  };
  const getCaptured = setupPasteWrite(plugin);
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.equal(flags.prevented, false);
  assert.equal(getCaptured(), null);
});

test('Tier B paste: collapsed g_range grapheme_offset 2 without linespan splits at offset 2', async () => {
  const { plugin, context, state } = instanceWithHost();
  const P = { list_item: { state }, grapheme_offset: 2 };
  context.window.g_range = { first_pos: P, last_pos: P };
  const getCaptured = setupPasteWrite(plugin);
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.ok(flags.prevented);
  const segs = getCaptured();
  assert.ok(segs);
  const refIdx = segs.findIndex((s) => s.type === 'ref' && s.text.guid === 'TGT');
  assert.ok(refIdx >= 0);
  assert.equal(segs[refIdx - 1].type, 'text');
  assert.equal(segs[refIdx - 1].text, 'ab');
  assert.notEqual(refIdx, segs.length - 1);
});

test('Tier C paste: listitem-with-caret appends chip at end', async () => {
  const { plugin, context } = instanceWithHost();
  context.document.querySelector = (sel) => {
    if (String(sel).includes('listitem-with-caret')) return { getAttribute: () => 'HOST' };
    return null;
  };
  const getCaptured = setupPasteWrite(plugin);
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.ok(flags.prevented);
  const segs = getCaptured();
  assert.ok(segs);
  const last = segs[segs.length - 1];
  assert.equal(last.type, 'ref');
  assert.equal(last.text.guid, 'TGT');
});

test('nothing resolvable does not intercept paste', async () => {
  const { plugin } = instanceWithHost();
  const getCaptured = setupPasteWrite(plugin);
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.equal(flags.prevented, false);
  assert.equal(getCaptured(), null);
});

test('paste into refalias-pop INPUT is untouched', async () => {
  const state = hostState();
  const { plugin } = instanceWithHost({
    hasFocus: () => true,
    getItems: () => [{ state }],
    selection: {
      _caret: {
        pos: {
          list_item: { state },
          grapheme_offset: 1,
          linespan: { segment_index: 0 }
        }
      }
    }
  });
  const getCaptured = setupPasteWrite(plugin);
  const pop = {};
  const { e, flags } = pasteEvent({
    target: { tagName: 'INPUT', closest: () => pop }
  });
  plugin._handlePaste(e);
  await flushInsert();
  assert.equal(flags.prevented, false);
  assert.equal(getCaptured(), null);
});

test('self-ref paste toasts and does not write', async () => {
  const state = hostState();
  const { plugin } = instanceWithHost({
    hasFocus: () => true,
    getItems: () => [{ state }],
    selection: {
      _caret: {
        pos: {
          list_item: { state },
          grapheme_offset: 1,
          linespan: { segment_index: 0 }
        }
      }
    }
  });
  let toastMsg = null;
  plugin.data = { getRecord: () => null };
  plugin._toast = (msg) => { toastMsg = msg; };
  let wrote = false;
  plugin._resolveLineItemByGuid = async () => ({
    setSegments: async () => { wrote = true; return true; }
  });
  const { e, flags } = pasteEvent({
    clipboardData: { getData: () => 'thymer-ref://HOST' }
  });
  plugin._handlePaste(e);
  await flushInsert();
  assert.ok(flags.prevented);
  assert.equal(toastMsg, 'That reference points at this line');
  assert.equal(wrote, false);
});

test('_pasteRef with Tier C only appends chip at EOL', async () => {
  const { plugin, context } = instanceWithHost();
  context.document.querySelector = (sel) => {
    if (String(sel).includes('listitem-with-caret')) return { getAttribute: () => 'HOST' };
    return null;
  };
  context.navigator.clipboard = {
    readText: async () => 'thymer-ref://TGT'
  };
  const getCaptured = setupPasteWrite(plugin);
  await plugin._pasteRef();
  const segs = getCaptured();
  assert.ok(segs);
  const last = segs[segs.length - 1];
  assert.equal(last.type, 'ref');
  assert.equal(last.text.guid, 'TGT');
});

test('transclusion copy pastes as embed once, then chip', async () => {
  const state = hostState();
  const { plugin, context } = instanceWithHost({
    hasFocus: () => true,
    getItems: () => [{ state }],
    selection: {
      _caret: {
        pos: {
          list_item: { state },
          grapheme_offset: 1,
          linespan: { segment_index: 0 }
        }
      }
    }
  });
  const stash = { guid: 'TGT', asTransclusion: true };
  context.window.__refxCopiedRef = stash;
  const getCaptured = setupPasteWrite(plugin);
  let bridgeCalls = 0;
  let bridgeCall = null;
  plugin._bridgeCreateEmbed = (host, tgt, opts) => {
    bridgeCalls++;
    bridgeCall = [host, tgt, opts];
    return Promise.resolve(true);
  };
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.ok(flags.prevented);
  assert.equal(bridgeCalls, 1);
  assert.equal(bridgeCall[0], 'HOST');
  assert.equal(bridgeCall[1], 'TGT');
  assert.equal(bridgeCall[2].forceTransclusion, true);
  assert.ok(stash.consumedAt);
  assert.equal(getCaptured(), null);

  const { e: e2, flags: flags2 } = pasteEvent();
  plugin._handlePaste(e2);
  await flushInsert();
  assert.ok(flags2.prevented);
  assert.equal(bridgeCalls, 1);
  const segs = getCaptured();
  assert.ok(segs);
  assert.ok(segs.some((s) => s.type === 'ref' && s.text.guid === 'TGT'));
});

test('transclusion stash for different guid pastes as chip', async () => {
  const state = hostState();
  const { plugin, context } = instanceWithHost({
    hasFocus: () => true,
    getItems: () => [{ state }],
    selection: {
      _caret: {
        pos: {
          list_item: { state },
          grapheme_offset: 1,
          linespan: { segment_index: 0 }
        }
      }
    }
  });
  context.window.__refxCopiedRef = { guid: 'OTHER', asTransclusion: true };
  const getCaptured = setupPasteWrite(plugin);
  let bridgeCalled = false;
  plugin._bridgeCreateEmbed = () => { bridgeCalled = true; return Promise.resolve(); };
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.ok(flags.prevented);
  assert.equal(bridgeCalled, false);
  const segs = getCaptured();
  assert.ok(segs);
  assert.ok(segs.some((s) => s.type === 'ref' && s.text.guid === 'TGT'));
});

test('transclusion paste does not set consumedAt when embed rejects', async () => {
  const state = hostState();
  const { plugin, context } = instanceWithHost({
    hasFocus: () => true,
    getItems: () => [{ state }],
    selection: {
      _caret: {
        pos: {
          list_item: { state },
          grapheme_offset: 1,
          linespan: { segment_index: 0 }
        }
      }
    }
  });
  const stash = { guid: 'TGT', asTransclusion: true };
  context.window.__refxCopiedRef = stash;
  plugin._bridgeCreateEmbed = () => Promise.reject(new Error('embed failed'));
  const { e, flags } = pasteEvent();
  plugin._handlePaste(e);
  await flushInsert();
  assert.ok(flags.prevented);
  assert.equal(stash.consumedAt, undefined);
});

const HOST_SLUG = 'Watch_Agents_of_S.H.I.E.L.D._S2';
const HOST_LIVE = 'Watch Agents of S.H.I.E.L.D. S2';

test('_isHostLineRefSlug detects host slug vs live spaced text', () => {
  const { Plugin } = loadPlugin();
  const plugin = new Plugin();
  assert.equal(plugin._isHostLineRefSlug(HOST_SLUG, HOST_LIVE), true);
  assert.equal(plugin._isHostLineRefSlug(HOST_LIVE, HOST_LIVE), false);
  assert.equal(plugin._isHostLineRefSlug('MCU', HOST_LIVE), false);
  assert.equal(plugin._isHostLineRefSlug('S2', HOST_LIVE), false);
  assert.equal(plugin._isHostLineRefSlug('', HOST_LIVE), false);
  assert.equal(plugin._isHostLineRefSlug(HOST_SLUG, ''), false);
  assert.equal(plugin._isHostLineRefSlug('Wrong_Slug', HOST_LIVE), false);
  assert.equal(plugin._isHostLineRefSlug('single_word', 'single_word'), false);
});

test('_healLineRefTitleScan rewrites slug line-ref titles to live text', async () => {
  const { Plugin, context } = loadPlugin();
  const plugin = new Plugin();
  plugin._enabled = true;
  const HOST = 'HOSTLINE';
  const TGT = 'TARGET';
  const hostState = {
    guid: HOST,
    text_segments: ['text', 'see ', 'ref', { guid: TGT, title: HOST_SLUG }]
  };
  const targetState = {
    guid: TGT,
    text_segments: ['text', HOST_LIVE]
  };
  context.window.g_universe.itemsByGuid = { [HOST]: hostState, [TGT]: targetState };
  context.window.g_universe.listviews = [{
    getItems: () => [{ state: hostState }, { state: targetState }]
  }];
  const editorRoot = {
    querySelectorAll: (sel) => (sel === '.listitem[data-guid]' ? [{ dataset: { guid: HOST } }] : [])
  };
  let written = null;
  plugin._repairPoisonedAutoTitlesForLine = async () => false;
  plugin._referenceTargetKind = () => 'line';
  plugin._resolveLineItemByGuid = async () => ({
    setSegments: async (segs) => { written = segs; return true; }
  });
  await plugin._healLineRefTitleScan(editorRoot);
  assert.ok(written);
  const refSeg = written.find((s) => s.type === 'ref');
  assert.ok(refSeg);
  assert.equal(refSeg.text.title, HOST_LIVE);
});

test('_healHostLineRefSlugChipTitles rewrites chip title node to live text', () => {
  const { Plugin } = loadPlugin();
  const plugin = new Plugin();
  const titleEl = { textContent: HOST_SLUG };
  const chip = {
    isConnected: true,
    querySelector: (sel) => (sel === '.lineitem-ref-title' ? titleEl : null),
    textContent: HOST_SLUG
  };
  plugin._referenceTargetKind = () => 'line';
  plugin._lineTextByGuid = () => HOST_LIVE;
  plugin._healHostLineRefSlugChipTitles([{ el: chip, guid: 'TARGET' }]);
  assert.equal(titleEl.textContent, HOST_LIVE);
});

test('_insertRefAtCaret stores live text when candidate title is host slug', async () => {
  const state = hostState();
  const { plugin, context } = instanceWithHost({
    hasFocus: () => true,
    getItems: () => [{ state }],
    selection: {
      _caret: {
        pos: {
          list_item: { state },
          grapheme_offset: 1,
          linespan: { segment_index: 0 }
        }
      }
    }
  });
  context.window.__refxCopiedRef = { guid: 'TGT', text: HOST_SLUG };
  plugin.ui = { addToaster: () => ({ show: () => {} }) };
  plugin.data = { getRecord: () => null };
  plugin._lineTextByGuid = () => HOST_LIVE;
  let captured = null;
  plugin._resolveLineItemByGuid = async () => ({
    setSegments: async (segs) => { captured = segs; return true; }
  });
  plugin._setAutoTitleManaged = async () => {};
  let calls = 0;
  plugin._lineTextByGuid = () => (++calls === 1 ? '' : HOST_LIVE);
  await plugin._insertRefAtCaret('TGT', { lineGuid: 'HOST', offset: 1 });
  assert.ok(captured);
  const refSeg = captured.find((s) => s.type === 'ref' && s.text.guid === 'TGT');
  assert.ok(refSeg);
  assert.equal(refSeg.text.title, HOST_LIVE);
});
