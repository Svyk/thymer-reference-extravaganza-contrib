'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function element(tag) {
  return {
    tagName: String(tag).toUpperCase(), className: '', textContent: '', title: '',
    style: {}, dataset: {}, children: [], isConnected: true, offsetWidth: 300,
    setAttribute() {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.isConnected = false; this.removed = true; },
    click() { if (this.onclick) this.onclick({ preventDefault() {}, stopPropagation() {} }); },
  };
}

function harness() {
  const listeners = new Map(), appended = [], off = [], commands = [];
  const context = {
    AppPlugin: class {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: fn => { fn(); return 1; },
    cancelAnimationFrame() {},
    performance: { now: () => Date.now() },
    CSS: { escape: value => String(value) },
    navigator: { platform: 'MacIntel', clipboard: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      hidden: false,
      createElement: element,
      querySelectorAll: () => [],
      querySelector: () => null,
      body: {
        classList: { toggle() {}, add() {}, remove() {} },
        appendChild(node) { appended.push(node); return node; },
      },
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    Element: class {},
    window: {
      innerWidth: 1200,
      CSS: { escape: value => String(value) },
      g_universe: { itemsByGuid: {}, workspace: {} },
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    },
  };
  context.globalThis = context;
  Object.assign(context, context.window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  const plugin = new context.PluginUnderTest();
  plugin._unloaded = false; plugin._isUnloading = false;
  plugin.events = {
    on(name, fn) { plugin._eventName = name; plugin._eventFn = fn; return 'typed-event'; },
    off(id) { off.push(id); },
  };
  plugin.ui = {
    addCommandPaletteCommand(config) {
      const handle = { config, removed: false, remove() { this.removed = true; } };
      commands.push(handle); return handle;
    },
  };
  plugin._toast = message => { plugin._lastToast = message; };
  return { plugin, context, listeners, appended, off, commands };
}

function typedApi(overrides) {
  return Object.assign({
    contract: 'thymer-typed-capture-v1',
    version: 1,
    ownerId: 'attributes:test:1',
    status: () => ({ ready: true, ownerId: 'attributes:test:1', generation: 4 }),
    warm: async () => ({ ready: true, ownerId: 'attributes:test:1', generation: 4 }),
    match: query => query.toLowerCase() === 'movie'
      ? [{ guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie', score: 0, defaultMode: 'active' }] : [],
    defaultMode: () => 'active',
    setDefaultMode() {},
    apply: async () => ({ contract: 'thymer-typed-capture-receipt-v1', id: 'receipt-1' }),
    undo: async () => ({ status: 'undone' }),
    recover: () => null,
  }, overrides || {});
}

test('committed exact native hashtag offers the bridge without mutating or intercepting #', async () => {
  const { plugin, context } = harness();
  let shown = null, writes = 0;
  context.window.__attributes = { fastCapture: typedApi({ apply: async () => { writes++; } }) };
  plugin._typedTagShowOffer = model => { shown = model; };
  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LLLLLLLLLLLLLLLLLLLL',
    recordGuid: 'RRRRRRRRRRRRRRRRRRRR',
    segments: [{ type: 'text', text: 'Review ' }, { type: 'hashtag', text: '#movie' }],
  });
  assert.equal(writes, 0);
  assert.equal(shown.tagName, 'movie');
  assert.equal(shown.type.name, 'Movie');
  assert.equal(shown.lineGuid, 'LLLLLLLLLLLLLLLLLLLL');
  assert.match(shown.signature, /#movie|"type":"hashtag"/);
});

test('segmentless and ref-only events perform zero line/provider reads before hashtag proof', async () => {
  const { plugin, context } = harness();
  let lineReads = 0, segmentReads = 0, statusReads = 0, warms = 0, ready = false, offers = 0;
  context.window.__attributes = { fastCapture: typedApi({
    status: () => { statusReads++; return { ready, ownerId: 'attributes:test:1', generation: 4 }; },
    warm: async () => { warms++; ready = true; return { ready: true, ownerId: 'attributes:test:1', generation: 4 }; },
  }) };
  plugin._typedTagShowOffer = () => { offers++; };

  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LINE_SEGMENTLESS', recordGuid: 'REC_SEGMENTLESS',
    hasSegments: () => false,
    getSegments: () => { segmentReads++; return []; },
    getLineItem: () => { lineReads++; return null; },
  });
  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LINE_REF_ONLY', recordGuid: 'REC_REF_ONLY',
    segments: [{ type: 'ref', text: { guid: 'TARGET_REF_ONLY' } }],
    getLineItem: () => { lineReads++; return null; },
  });

  assert.equal(lineReads, 0);
  assert.equal(segmentReads, 0);
  assert.equal(statusReads, 0, 'provider status is untouched until a hashtag exists');
  assert.equal(warms, 0);
  assert.equal(offers, 0);

  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LINE_WITH_TAG', recordGuid: 'REC_WITH_TAG',
    segments: [{ type: 'hashtag', text: '#movie' }],
  });
  assert.equal(warms, 1, 'the provider warms only after payload hashtag proof');
  assert.ok(statusReads >= 2);
  assert.equal(offers, 1);
});

test('prefix bridge maps #mov to Movie with a truthful ambiguity label while a distant fuzzy row is rejected', async () => {
  const { plugin, context, appended } = harness();
  context.window.__attributes = { fastCapture: typedApi({
    match: query => query.toLowerCase() === 'mov' ? [
      { guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie', score: 10 },
      { guid: 'UUUUUUUUUUUUUUUUUUUU', name: 'Moving', score: 11 },
    ] : query.toLowerCase() === 'movue' || query.toLowerCase() === 'pluto'
      ? [{ guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie', score: 40 }] : [],
  }) };
  plugin._typedTagLineHost = () => ({ isConnected: true, getBoundingClientRect: () => ({ right: 400, top: 120 }) });
  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR', segments: [{ type: 'hashtag', text: '#mov' }],
  });
  assert.equal(appended.length, 1);
  assert.equal(plugin._typedTagOffer.type.name, 'Movie');
  assert.equal(plugin._typedTagOffer.matchKind, 'prefix');
  assert.match(plugin._typedTagOffer.accept.textContent, /^Type #mov as Movie · best of 2/);
  plugin._typedTagCloseOffer(false);
  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR', segments: [{ type: 'hashtag', text: '#movue' }],
  });
  assert.equal(plugin._typedTagOffer.type.name, 'Movie');
  assert.equal(plugin._typedTagOffer.matchKind, 'fuzzy');
  assert.match(plugin._typedTagOffer.accept.textContent, /^Type #movue as Movie/);
  plugin._typedTagCloseOffer(false);
  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR', segments: [{ type: 'hashtag', text: '#pluto' }],
  });
  assert.equal(plugin._typedTagOffer, null, 'a distant broker row is not presented as a fuzzy match');
});

test('already typed, nonmatching, and remote hashtag events create no offer', async () => {
  const { plugin, context } = harness();
  context.window.__attributes = { fastCapture: typedApi() };
  let offers = 0; plugin._typedTagShowOffer = () => { offers++; };
  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR',
    segments: [{ type: 'text', text: '++Movie ' }, { type: 'hashtag', text: '#movie' }],
  });
  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR',
    segments: [{ type: 'hashtag', text: '#unknown' }],
  });
  await plugin._typedTagOfferFromEvent({
    lineItemGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR',
    source: { isLocal: false }, segments: [{ type: 'hashtag', text: '#movie' }],
  });
  assert.equal(offers, 0);
});

test('accept delegates exact source and mode to Attributes, keeps the receipt, and exposes undo', async () => {
  const { plugin, context } = harness();
  let request = null, undone = null;
  const receipt = { contract: 'thymer-typed-capture-receipt-v1', id: 'receipt-1' };
  context.window.__attributes = { fastCapture: typedApi({
    apply: async value => { request = value; return receipt; },
    undo: async value => { undone = value; return { status: 'undone' }; },
  }) };
  plugin._typedTagOffer = {
    lineGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR',
    tagName: 'movie', type: { guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie' },
    mode: 'passive', node: { remove() {} }, accept: { disabled: false },
  };
  await plugin._typedTagAcceptOffer();
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    recordGuid: 'RRRRRRRRRRRRRRRRRRRR',
    lineGuid: 'LLLLLLLLLLLLLLLLLLLL',
    typeGuid: 'TTTTTTTTTTTTTTTTTTTT',
    typeName: 'Movie',
    mode: 'passive',
    sourceKind: 'native-hashtag',
    requiredHashtag: 'movie',
    expectedGeneration: 4,
    handoff: { contract: 'thymer-typed-capture-handoff-v1', requestId: request.handoff.requestId, token: {} },
  });
  assert.equal(plugin._typedTagLastReceipt, receipt);
  await plugin._typedTagUndoLast();
  assert.equal(undone, receipt);
  assert.equal(plugin._typedTagLastReceipt, null);
});

test('offer mode toggle persists per-type default; close is a zero-write decline', async () => {
  const { plugin, context, appended } = harness();
  const writes = [], api = typedApi({
    defaultMode: () => 'active',
    setDefaultMode: (guid, mode) => writes.push([guid, mode]),
  });
  context.window.__attributes = { fastCapture: api };
  plugin._typedTagLineHost = () => ({
    isConnected: true,
    getBoundingClientRect: () => ({ right: 400, top: 120 }),
  });
  plugin._typedTagShowOffer({
    lineGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR',
    tagName: 'movie', type: { guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie' },
    signature: 'sig-1',
  });
  assert.equal(appended.length, 1);
  plugin._typedTagOffer.modeButton.click();
  await Promise.resolve();
  assert.deepEqual(writes, [['TTTTTTTTTTTTTTTTTTTT', 'passive']]);
  assert.equal(plugin._typedTagOffer.mode, 'passive');
  plugin._typedTagCloseOffer(true);
  assert.equal(plugin._typedTagDismissed, 'sig-1');
  assert.equal(writes.length, 1, 'decline must not perform a document write');
});

test('mode toggle does not repaint from a provider generation that changed during persistence', async () => {
  const { plugin, context } = harness();
  let generation = 4, resolvePersist;
  const persistence = new Promise(resolve => { resolvePersist = resolve; });
  const api = typedApi({
    status: () => ({ ready: true, ownerId: 'attributes:test:1', generation }),
    setDefaultMode: () => persistence,
  });
  context.window.__attributes = { fastCapture: api };
  plugin._typedTagLineHost = () => ({ isConnected: true, getBoundingClientRect: () => ({ right: 400, top: 120 }) });
  plugin._typedTagShowOffer({
    lineGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR', tagName: 'movie',
    type: { guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie' }, matchKind: 'exact', ambiguity: { ambiguous: false, count: 1, candidates: ['Movie'] }, signature: 'sig-generation',
  });
  plugin._typedTagOffer.modeButton.click();
  generation = 5; resolvePersist('passive'); await persistence; await Promise.resolve();
  assert.equal(plugin._typedTagOffer.mode, 'active', 'the stale generation cannot update the visible mode');
});

test('provider replacement during accept reacquires the owner and recovers the exact handoff receipt', async () => {
  const { plugin, context } = harness();
  let resolveApply, handoff = null;
  const receipt = { contract: 'thymer-typed-capture-receipt-v1', id: 'receipt-replaced' };
  const first = typedApi({
    ownerId: 'attributes:first', status: () => ({ ready: true, ownerId: 'attributes:first', generation: 4 }),
    apply: request => { handoff = request.handoff; return new Promise(resolve => { resolveApply = resolve; }); },
  });
  const second = typedApi({
    ownerId: 'attributes:second', status: () => ({ ready: true, ownerId: 'attributes:second', generation: 5 }),
    recover: value => value === handoff ? receipt : null,
  });
  context.window.__attributes = { fastCapture: first };
  plugin._typedTagOffer = {
    lineGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR', tagName: 'movie',
    type: { guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie' }, mode: 'active', node: { remove() {} }, accept: { disabled: false },
  };
  const accepting = plugin._typedTagAcceptOffer();
  context.window.__attributes.fastCapture = second; resolveApply(receipt); await accepting;
  assert.equal(plugin._typedTagLastReceipt, receipt);
  assert.match(plugin._lastToast, /now typed/);
});

test('consumer unload during accept performs no late toast/store and a replacement consumer adopts the bounded receipt', async () => {
  const { plugin, context } = harness();
  let resolveApply;
  const receipt = { contract: 'thymer-typed-capture-receipt-v1', id: 'receipt-consumer-reload' };
  context.window.__attributes = { fastCapture: typedApi({ apply: () => new Promise(resolve => { resolveApply = resolve; }) }) };
  plugin._typedTagBridgeInit();
  plugin._typedTagOffer = {
    lineGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR', tagName: 'movie',
    type: { guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie' }, mode: 'active', node: { remove() {} }, accept: { disabled: false },
    lifecycle: plugin._typedTagLifecycle,
  };
  const accepting = plugin._typedTagAcceptOffer();
  plugin._typedTagBridgeDispose();
  const replacement = new context.PluginUnderTest(); replacement._unloaded = false; replacement._isUnloading = false;
  replacement.events = { on: () => 'replacement-event', off() {} };
  replacement.ui = { addCommandPaletteCommand: () => ({ remove() {} }) };
  replacement._toast = message => { replacement._lastToast = message; };
  replacement._typedTagBridgeInit();
  resolveApply(receipt); await accepting; await Promise.resolve();
  assert.equal(plugin._typedTagLastReceipt, null, 'disposed consumer cannot retain the late receipt');
  assert.equal(plugin._lastToast, undefined, 'disposed consumer cannot emit a late success toast');
  assert.equal(replacement._typedTagLastReceipt, receipt, 'replacement consumer adopts the exact bounded handoff');
  replacement._typedTagBridgeDispose();
});

test('true hot reload without prior onUnload fences the old awaited accept and replacement adopts its receipt', async () => {
  const { plugin, context } = harness();
  let resolveApply, staleCloses = 0;
  const receipt = { contract: 'thymer-typed-capture-receipt-v1', id: 'receipt-hot-reload' };
  context.window.__attributes = { fastCapture: typedApi({ apply: () => new Promise(resolve => { resolveApply = resolve; }) }) };
  plugin._typedTagBridgeInit();
  const staleLifecycle = plugin._typedTagLifecycle;
  plugin._typedTagOffer = {
    lineGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR', tagName: 'movie',
    type: { guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie' }, mode: 'active', node: { remove() {} }, accept: { disabled: false },
    lifecycle: staleLifecycle,
  };
  plugin._typedTagCloseOffer = () => { staleCloses++; };
  const accepting = plugin._typedTagAcceptOffer();

  const replacement = new context.PluginUnderTest(); replacement._unloaded = false; replacement._isUnloading = false;
  replacement.events = { on: () => 'replacement-event', off() {} };
  replacement.ui = { addCommandPaletteCommand: () => ({ remove() {} }) };
  replacement._toast = message => { replacement._lastToast = message; };
  replacement._killStaleObservers();
  replacement._typedTagBridgeInit();

  assert.equal(staleLifecycle.active, false, 'onLoad stale cleanup invalidates the unreachable owner before replacement');
  assert.notEqual(replacement._typedTagLifecycle.ownerSequence, staleLifecycle.ownerSequence);
  resolveApply(receipt); await accepting; await Promise.resolve();
  assert.equal(plugin._typedTagLastReceipt, null, 'old instance cannot store a receipt after its awaited apply resumes');
  assert.equal(plugin._lastToast, undefined, 'old instance cannot toast after its awaited apply resumes');
  assert.equal(staleCloses, 0, 'old instance cannot close UI owned by the replacement generation');
  assert.equal(replacement._typedTagLastReceipt, receipt, 'replacement adopts the exact bounded handoff receipt');
  replacement._typedTagBridgeDispose();
});

test('recoverable apply and mid-delete undo failures keep a receipt and use truthful partial-state toasts', async () => {
  const { plugin, context } = harness();
  const recovery = { contract: 'thymer-typed-capture-receipt-v1', id: 'receipt-recovery' };
  const retry = { contract: 'thymer-typed-capture-receipt-v1', id: 'receipt-retry' };
  context.window.__attributes = { fastCapture: typedApi({
    apply: async () => { throw Object.assign(new Error('partial'), { code: 'typed-capture-apply-recoverable', recoveryReceipt: recovery }); },
    undo: async () => { throw Object.assign(new Error('mid-delete'), { code: 'typed-capture-undo-recoverable', recoveryReceipt: retry }); },
  }) };
  plugin._typedTagOffer = {
    lineGuid: 'LLLLLLLLLLLLLLLLLLLL', recordGuid: 'RRRRRRRRRRRRRRRRRRRR', tagName: 'movie',
    type: { guid: 'TTTTTTTTTTTTTTTTTTTT', name: 'Movie' }, mode: 'active', node: { remove() {} }, accept: { disabled: false },
  };
  await plugin._typedTagAcceptOffer();
  assert.equal(plugin._typedTagLastReceipt, recovery);
  assert.match(plugin._lastToast, /needs recovery/);
  assert.doesNotMatch(plugin._lastToast, /nothing was applied|was not changed/);
  await plugin._typedTagUndoLast();
  assert.equal(plugin._typedTagLastReceipt, retry);
  assert.match(plugin._lastToast, /retryable typed state/);
});

test('keyboard route and hot-reload disposal own every listener, event, command, and node', () => {
  const { plugin, context, listeners, off, commands } = harness();
  context.window.__attributes = { fastCapture: typedApi() };
  plugin._typedTagBridgeInit();
  assert.equal(plugin._eventName, 'lineitem.updated');
  assert.equal(typeof listeners.get('keydown'), 'function');
  assert.equal(commands[0].config.label, 'RefX: Undo last typed capture');
  let accepted = 0, toggled = 0;
  plugin._typedTagAcceptOffer = async () => { accepted++; };
  plugin._typedTagOffer = { modeButton: { click() { toggled++; } }, node: { remove() {} } };
  const key = listeners.get('keydown');
  key({ altKey: true, key: 'Enter', preventDefault() {}, stopImmediatePropagation() {} });
  key({ altKey: true, key: 'm', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(accepted, 1);
  assert.equal(toggled, 1);
  plugin._typedTagBridgeDispose();
  assert.deepEqual(off, ['typed-event']);
  assert.equal(commands[0].removed, true);
  assert.equal(context.window.__refxTypedCaptureEvent, null);
  assert.equal(context.window.__refxTypedCaptureKey, null);
  assert.equal(context.window.__refxTypedCapturePosition, null);
});

test('RT-3 implementation has no modal prompt, no hashtag interception, and no observer', () => {
  const start = source.indexOf('  // RT-3 native hashtag bridge.');
  const end = source.indexOf('  // Native paste of a copied reference:', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(implementation, /window\.(?:prompt|confirm|alert)\s*\(/);
  assert.doesNotMatch(implementation, /MutationObserver/);
  assert.doesNotMatch(implementation, /event\.key\s*===\s*['"]#['"]/);
  assert.match(implementation, /requiredHashtag:\s*offer\.tagName/);
});

test('T0 fixture catalog covers accept, decline, collision, stale, and no-offer routes', () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'rt3-typed-capture.json'), 'utf8'));
  assert.equal(fixtures.contract, 'thymer-typed-capture-fixtures-v1');
  const ids = new Set(fixtures.cases.map(row => row.id));
  for (const id of [
    'native-hashtag-accept',
    'native-hashtag-decline',
    'native-hashtag-already-typed',
    'native-hashtag-nonmatch',
    'native-hashtag-remote',
    'keyboard-collision',
  ]) assert.equal(ids.has(id), true, 'missing fixture ' + id);
});
