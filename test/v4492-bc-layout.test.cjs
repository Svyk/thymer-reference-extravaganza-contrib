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

test('v4.49.3 settings default collapsed uses refx_ctx_start_collapsed_v1', () => {
  assert.match(source, /loadBoolSetting\('refx_ctx_start_collapsed_v1', true\)/);
  assert.match(source, /mkCheckRow\('Block context starts collapsed', this\.loadBoolSetting\('refx_ctx_start_collapsed_v1', true\)/);
  assert.doesNotMatch(source, /refx_ctx_collapsed_v1/);
});

test('v4.49.3 strip chrome CSS guards collapsed border and hides group count', () => {
  assert.match(source, /\.refx-inline-refs-context:has\(> \.refx-inline-refs-context-label-row\.refx-ctxstrip-collapsed\)/);
  assert.match(source, /\.trc-ref-popover-context:has\(> \.trc-ref-popover-context-label-row\.refx-ctxstrip-collapsed\)/);
  assert.match(source, /\.refx-inline-refs-context-rows \.refx-inline-refs-group-count,\s*\n\s*\.refx-inline-refs-context-rows \.refx-inline-refs-group-header-actions/);
});

test('v4.49.3 sibling builder uses viewport autoLoadImage and resolveLine', () => {
  const start = source.indexOf('_buildRefSiblingList(siblings, ctx, excludeGuid');
  const end = source.indexOf('async _fillRefContextRow(ctx, line, crumbEl, childBox)');
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /autoLoadImage:\s*"viewport"/);
  assert.match(block, /resolveLine:\s*\(\)\s*=>\s*this\._resolveMediaLineByGuid/);
  assert.doesNotMatch(block, /setTimeout|setInterval|MutationObserver|getLineItems/);
});

test('v4.49.3 ancestor media rows render compact preview cards', () => {
  assert.match(source, /refx-ref-outline-label refx-ref-outline-media/);
  assert.match(source, /_renderPreviewLineItem\(aEl, anc, \{[\s\S]*?autoLoadImage:\s*"viewport"/);
});

test('v4.49.3 child/sibling builders avoid timers and extra tree reads', () => {
  const start = source.indexOf('_buildRefSiblingList(siblings, ctx, siblingSelfGuid)');
  const end = source.indexOf('_buildRefChildTree(target, ctx)');
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /setTimeout|setInterval|MutationObserver|getLineItems/);
});
