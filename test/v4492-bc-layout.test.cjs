'use strict';

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
      removeItem: (key) => storage.delete(key),
    },
    document: {
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, append() {}, setAttribute() {}, appendChild() {} }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { clientHeight: 900 },
      body: { classList: { add() {}, remove() {}, contains: () => false } },
      head: { appendChild() {} },
    },
    Element: class {},
    window: { CSS: { escape: (s) => String(s) }, g_universe: { itemsByGuid: {}, workspace: {} } },
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  const plugin = new context.PluginUnderTest();
  plugin._unloaded = false;
  plugin._lineConnectionsEnabled = true;
  plugin._lineRefProps = ['Source Line'];
  plugin._autoLineRefs = true;
  plugin._referenceTargetKind = () => 'line';
  plugin.isExistingRecordGuid = () => false;
  return { plugin, storage };
}

test('v4.49.3 line badge counts @linkto only and exposes sdkPropCount', async () => {
  const { plugin } = loadPlugin();
  plugin.loadLineReferenceCount = async () => ({
    count: 1,
    capped: false,
    sourceRecordGuids: new Set(['INLINE_REC']),
  });
  plugin.loadLinePropReferenceRecordCount = async () => ({
    recordGuids: new Set(['INLINE_REC', 'PROP_ONLY_REC']),
  });
  const info = await plugin.loadCountInfo('LINE_TARGET');
  assert.equal(info.count, 1);
  assert.equal(info.capped, false);
  assert.equal(info.sdkPropCount, 1);
  assert.match(plugin.formatBadgeTooltip(info, null, 'view'), /\(1 via properties\)/);
});

test('v4.49.3 remark-only line falls back to property count', async () => {
  const { plugin } = loadPlugin();
  plugin.loadLineReferenceCount = async () => ({
    count: 0,
    capped: false,
    sourceRecordGuids: new Set(),
  });
  plugin.loadLinePropReferenceRecordCount = async () => ({
    recordGuids: new Set(['PROP_ONLY_REC']),
  });
  const info = await plugin.loadCountInfo('LINE_TARGET');
  assert.equal(info.count, 1);
  assert.equal(info.capped, false);
  assert.equal(info.sdkPropCount, 1);
});

test('v4.49.3 line-target headline uses inline count and property suffix only', () => {
  const start = source.indexOf('if (isLineTgt) {');
  const end = source.indexOf('} else {', start);
  assert.ok(start > 0 && end > start, 'line-target headline branch exists');
  const block = source.slice(start, end);
  assert.match(block, /total = items\.length > 0 \? items\.length : \(propRecs\.length \+ sdkSection\.length\)/);
  assert.match(block, /parts\.push\(`\$\{propRecs\.length\} properties`\)/);
  assert.doesNotMatch(block, /inline/);
});

test('v4.49.3 child builder avoids timers and extra tree reads', () => {
  const start = source.indexOf('_buildRefChildTree(target, ctx, opts = {}) {');
  const end = source.indexOf('\n  _beginTreeLineEdit(ctx, lineEl, txtEl, c)', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(block, /setTimeout|setInterval|MutationObserver|getLineItems/);
});
