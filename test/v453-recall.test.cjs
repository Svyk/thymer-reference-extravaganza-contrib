'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function loadPlugin(customAbbrev = null) {
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
  plugin.data = { getRecord: () => null };
  if (customAbbrev) {
    plugin._pickerAbbrevConfig = customAbbrev;
    plugin._searchAbbrevBuilt = null;
  }
  return { plugin, storage, context };
}

test('season 3 agents matches Shield S3 line with strict tier and s/3 spans', () => {
  const { plugin } = loadPlugin();
  const text = '33. Watch Agents of S.H.I.E.L.D. S3';
  const key = plugin._searchKey(text);
  const plan = plugin._searchPlan('season 3 agents');
  const match = plugin._searchMatchFromKey(key, plan);
  assert.ok(match.score >= 0, 'expected a recall match');
  assert.equal(match.tier, 'strict');
  const targetIdx = new Set(match.spans.map((pair) => pair[0]));
  const tokens = key.tokens;
  assert.ok(targetIdx.has(tokens.indexOf('s')));
  assert.ok(targetIdx.has(tokens.indexOf('3')));
});

test('sheild s3 typo + abbreviation matches Shield line', () => {
  const { plugin } = loadPlugin();
  const key = plugin._searchKey('33. Watch Agents of S.H.I.E.L.D. S3');
  const plan = plugin._searchPlan('sheild s3');
  const match = plugin._searchMatchFromKey(key, plan);
  assert.ok(match.score >= 0);
});

test('mcu matches Marvel Cinematic Universe watch order via initialism', () => {
  const { plugin } = loadPlugin();
  const key = plugin._searchKey('Marvel Cinematic Universe watch order');
  const plan = plugin._searchPlan('mcu');
  const match = plugin._searchMatchFromKey(key, plan);
  assert.ok(match.score >= 0);
});

test('EMP 27 does not match EMP26-002-BHP', () => {
  const { plugin } = loadPlugin();
  assert.equal(plugin._searchScore('EMP26-002-BHP', 'EMP 27'), -1);
});

test('three-token query with one bogus token yields close tier', () => {
  const { plugin } = loadPlugin();
  const key = plugin._searchKey('Alpha Beta Gamma protocol');
  const plan = plugin._searchPlan('alpha beta bogus');
  const match = plugin._searchMatchFromKey(key, plan);
  assert.ok(match.score >= 0);
  assert.equal(match.tier, 'close');
});

test('_rankSearchResults places every close row after strict rows', () => {
  const { plugin } = loadPlugin();
  const rows = [
    { guid: 'C', text: 'close', score: 900, matchTier: 'close' },
    { guid: 'S1', text: 'strict low', score: 100, matchTier: 'strict' },
    { guid: 'S2', text: 'strict high', score: 500, matchTier: 'strict' },
    { guid: 'C2', text: 'close2', score: 800, matchTier: 'close' },
  ];
  const ranked = plugin._rankSearchResults(rows);
  const firstClose = ranked.findIndex((r) => r.matchTier === 'close');
  const lastStrict = ranked.reduce((idx, r, i) => (r.matchTier !== 'close' ? i : idx), -1);
  assert.ok(firstClose > lastStrict);
});

test('numeric tokens never fuzz across years', () => {
  const { plugin } = loadPlugin();
  assert.equal(plugin._searchScore('Budget 2026 plan', '2027'), -1);
});

test('custom.picker.abbreviations merge expands ss alias', () => {
  const { plugin } = loadPlugin({ ss: ['sub season'] });
  const key = plugin._searchKey('Episode 4 sub season recap');
  const plan = plugin._searchPlan('ss 4');
  const match = plugin._searchMatchFromKey(key, plan);
  assert.ok(match.score >= 0);
});

test('_snippetHTML with spans highlights the matched target token', () => {
  const { plugin } = loadPlugin();
  const html = plugin._snippetHTML('Alpha Beta Gamma', 'alpha gamma', {
    full: true,
    spans: [[0, 0], [2, 1]],
  });
  assert.match(html, /<mark class="refx-picker-match">Alpha<\/mark>/);
  assert.match(html, /<mark class="refx-picker-match">Gamma<\/mark>/);
});

test('opts.strict returns -1 where strict ladder misses abbrev recall', () => {
  const { plugin } = loadPlugin();
  const key = plugin._searchKey('33. Watch Agents of S.H.I.E.L.D. S3');
  const plan = plugin._searchPlan('season 3 agents');
  assert.equal(plugin._searchScoreFromKey(key, plan, { strict: true }), -1);
  assert.ok(plugin._searchMatchFromKey(key, plan).score >= 0);
});
