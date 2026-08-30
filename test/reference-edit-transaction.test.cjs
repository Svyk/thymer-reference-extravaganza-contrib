'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function loadPlugin() {
  const listeners = new Map();
  const window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) || []) fn(event);
    },
    g_universe: { itemsByGuid: {}, listviews: [] }
  };
  const document = {
    body: { append() {}, classList: { add() {}, remove() {}, toggle() {} } },
    createElement: () => ({
      append() {}, appendChild() {}, addEventListener() {}, remove() {},
      classList: { add() {}, remove() {} }, style: {}, querySelector: () => null
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };
  const ctx = {
    AppPlugin: class {},
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    }
  };
  Object.assign(ctx, window);
  ctx.globalThis = ctx;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', ctx, { filename: 'plugin.js' });
  return { plugin: new ctx.PluginUnderTest(), ctx };
}

test('Reference Edit v1 publishes a frozen, metadata-only contract', () => {
  const { plugin, ctx } = loadPlugin();
  const api = plugin._initReferenceEditsBroker();
  assert.equal(api.contract, 'thymer-reference-edits-v1');
  assert.equal(api.version, 1);
  assert.equal(Object.isFrozen(api), true);
  assert.equal(ctx.window.__thymerReferenceEditsV1, api);

  const link = {
    lineGuid: 'line-1', pageGuid: 'record-1', kind: 'record', br: '[[',
    bracketStart: 4, docEnd: 6, query: '', synthetic: false
  };
  const session = plugin._referenceEditBegin(link, [{ type: 'text', text: 'abc[[' }]);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(api.getActive('line-1'), session);
  assert.equal('text' in session, false);
  assert.match(session.beforeHash, /^fnv1a32:/);
  assert.equal(api.getStatus().state, 'editing');

  const receipt = plugin._referenceEditFinish(link, {
    outcome: 'committed',
    targetGuid: 'target-1',
    afterHash: 'fnv1a32:12345678',
    triggerRemoved: true,
    residueDetected: false,
    expectedRefCount: 1,
    actualRefCount: 1,
    attempts: 1,
    reason: 'verified-picker-insert'
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(receipt.outcome, 'committed');
  assert.equal(receipt.triggerRemoved, true);
  assert.equal(receipt.residueDetected, false);
  assert.equal(api.getActive('line-1'), null);
  assert.equal(api.getRecent('line-1').length, 1);
  assert.equal('text' in receipt, false);
});

test('Reference Edit v1 emits begin and settled envelopes in order', () => {
  const { plugin } = loadPlugin();
  const api = plugin._initReferenceEditsBroker();
  const seen = [];
  const off = api.subscribe((event) => seen.push(event.type));
  const link = {
    lineGuid: 'line-2', pageGuid: 'record-2', kind: 'line', br: '((',
    bracketStart: 0, docEnd: 2, query: '', synthetic: false
  };
  plugin._referenceEditBegin(link, [{ type: 'text', text: '((' }]);
  plugin._referenceEditFinish(link, {
    outcome: 'failed', triggerRemoved: false, residueDetected: true,
    reason: 'verification-failed'
  });
  off();
  assert.deepEqual(seen, ['snapshot', 'begin', 'settled']);
  assert.equal(api.getStatus().lastOutcome, 'failed');
});

test('Reference Edit v1 dispose fails active sessions and removes only its own global', () => {
  const { plugin, ctx } = loadPlugin();
  const api = plugin._initReferenceEditsBroker();
  const link = {
    lineGuid: 'line-3', pageGuid: 'record-3', kind: 'record', br: '[[',
    bracketStart: 0, docEnd: 2, query: '', synthetic: false
  };
  plugin._referenceEditBegin(link, [{ type: 'text', text: '[[' }]);
  api._dispose();
  assert.equal(ctx.window.__thymerReferenceEditsV1, null);
  assert.equal(api.getStatus().state, 'disposed');
  const receipt = api.getRecent('line-3')[0];
  assert.equal(receipt.outcome, 'failed');
  assert.equal(receipt.reason, 'owner-disposed');
  assert.equal(receipt.residueDetected, true);
});

test('a newer picker session fences a late completion from the superseded session', () => {
  const { plugin, ctx } = loadPlugin();
  const api = plugin._initReferenceEditsBroker();
  const firstLink = {
    lineGuid: 'line-4', pageGuid: 'record-4', kind: 'record', br: '[[',
    bracketStart: 0, docEnd: 2, query: '', synthetic: false
  };
  const secondLink = { ...firstLink };

  plugin._referenceEditBegin(firstLink, [{ type: 'text', text: '[[' }]);
  const second = plugin._referenceEditBegin(secondLink, [{ type: 'text', text: '[[' }]);

  const superseded = api.getRecent('line-4')[0];
  assert.equal(superseded.outcome, 'failed');
  assert.equal(superseded.reason, 'superseded-by-new-session');
  assert.equal(api.getActive('line-4').sessionId, second.sessionId);

  const staleResult = plugin._referenceEditFinish(firstLink, {
    outcome: 'cancelled', triggerRemoved: true, residueDetected: false
  });
  assert.equal(staleResult, null);
  assert.equal(api.getActive('line-4').sessionId, second.sessionId);
  assert.equal(ctx.window.__thymerReferenceEditsV1, api);
});

test('segment digest is deterministic and changes with reference identity', () => {
  const { plugin } = loadPlugin();
  const a = plugin._referenceEditDigest([{ type: 'text', text: 'x' }, { type: 'ref', text: { guid: 'A' } }]);
  const b = plugin._referenceEditDigest([{ type: 'text', text: 'x' }, { type: 'ref', text: { guid: 'A' } }]);
  const c = plugin._referenceEditDigest([{ type: 'text', text: 'x' }, { type: 'ref', text: { guid: 'B' } }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
