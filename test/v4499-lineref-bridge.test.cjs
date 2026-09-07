// v4.49.9 — the blinking LINE reference (`((` refs, including refs to a TODO).
//
// v4.49.8 removed the native-paint flash for page refs by giving every
// unclassified `.lineitem-ref[data-guid]` the page-ref appearance from static
// CSS. That made LINE refs worse: a rebuilt line-ref chip fell back to page blue
// instead of Thymer's native teal — a much larger visible jump. Measured on
// Thymer Desktop with a second class writer, on one line carrying both kinds:
// the page chip held 913/913 correct frames, the line-ref chip painted page blue
// for 779 of 913.
//
// Thymer renders both kinds with byte-identical DOM (verified live: same
// classes, same children, only `data-guid` differs), so no native selector tells
// them apart. A guid's kind is immutable, so the fix is a guid-keyed BRIDGE
// stylesheet built from positive classifications.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

function loadPlugin() {
  const styles = new Map();
  const storage = new Map();
  const context = {
    AppPlugin: class {},
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => { throw new Error('line-kind flush must not enter rAF'); },
    cancelAnimationFrame: clearTimeout,
    performance: { now: () => Date.now() },
    CSS: { escape: (s) => String(s) },
    navigator: { platform: 'MacIntel', clipboard: {} },
    localStorage: {
      getItem: (k) => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      documentElement: { clientHeight: 900 },
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      getElementById: (id) => styles.get(id) || null,
      createElement: () => ({ id: '', textContent: '', remove() { styles.delete(this.id); } }),
      head: { appendChild(node) { styles.set(node.id, node); return node; } }
    },
    Element: class {},
    window: { CSS: { escape: (s) => String(s) }, g_universe: { itemsByGuid: {}, workspace: {} } }
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  return { Plugin: context.PluginUnderTest, context, styles };
}

function instance() {
  const { Plugin, context, styles } = loadPlugin();
  const plugin = new Plugin();
  plugin._isUnloading = false;
  plugin._enabled = true;
  const sheet = () => (styles.get('refx-linekind-style') || {}).textContent || '';
  return { plugin, context, styles, sheet };
}

function classListSet(initial = []) {
  const set = new Set(initial);
  return {
    set,
    add: (...n) => n.forEach((x) => set.add(x)),
    remove: (...n) => n.forEach((x) => set.delete(x)),
    contains: (n) => set.has(n),
    toggle(n, force) {
      if (force === undefined) force = !set.has(n);
      if (force) set.add(n); else set.delete(n);
      return force;
    }
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const decls = (block) => block.split(';').map((d) => d.replace(/\s+/g, ' ').trim()).filter(Boolean).sort();

// A single-selector rule in the static appearance block.
const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
function staticRule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?<![,\\w-])\\n' + esc + ' \\{([^}]*)\\}').exec(css);
  return m ? m[1] : null;
}

const PREFIXES = [
  ['body.refx-links-distinct', 'body.refx-links-distinct .refx-lineref-chip'],
  ['body.refx-links-roam', 'body.refx-links-roam .refx-lineref-chip'],
  ['body.refx-links-roam.refx-line-underline-none', 'body.refx-links-roam.refx-line-underline-none .refx-lineref-chip'],
  ['body.refx-links-roam.refx-line-underline-dotted', 'body.refx-links-roam.refx-line-underline-dotted .refx-lineref-chip']
];

// A CSS specificity calculator good enough for the selectors in this file:
// :where() is free, :is()/:not() take the max of their arguments, classes and
// attribute selectors and pseudo-classes each weigh 1, element names weigh 1 in
// the last column. Returned as [id, class, type] and compared lexicographically.
function specificity(sel) {
  let a = 0, b = 0, c = 0, i = 0;
  const args = (from) => {
    let depth = 0, start = from, out = [], cur = '';
    for (let j = from; j < sel.length; j++) {
      const ch = sel[j];
      if (ch === '(') depth++;
      if (ch === ')') { depth--; if (depth === 0) { out.push(cur); return { parts: out, end: j }; } }
      if (ch === ',' && depth === 1) { out.push(cur); cur = ''; continue; }
      if (!(depth === 1 && j === start)) cur += ch;
    }
    return { parts: out, end: sel.length };
  };
  while (i < sel.length) {
    const rest = sel.slice(i);
    let m;
    if ((m = /^:(where|is|not|has)\(/.exec(rest))) {
      const { parts, end } = args(i + m[0].length - 1);
      if (m[1] !== 'where') {
        let best = [0, 0, 0];
        for (const part of parts) {
          const s = specificity(part.trim());
          if (s[0] > best[0] || (s[0] === best[0] && (s[1] > best[1] || (s[1] === best[1] && s[2] > best[2])))) best = s;
        }
        a += best[0]; b += best[1]; c += best[2];
      }
      i = end + 1; continue;
    }
    if ((m = /^#[\w-]+/.exec(rest))) { a++; i += m[0].length; continue; }
    if ((m = /^\[[^\]]*\]/.exec(rest))) { b++; i += m[0].length; continue; }
    if ((m = /^\.[\w-]+/.exec(rest))) { b++; i += m[0].length; continue; }
    if ((m = /^::[\w-]+/.exec(rest))) { c++; i += m[0].length; continue; }
    if ((m = /^:[\w-]+/.exec(rest))) { b++; i += m[0].length; continue; }
    if ((m = /^[a-zA-Z][\w-]*/.exec(rest))) { c++; i += m[0].length; continue; }
    i++;
  }
  return [a, b, c];
}
const cmp = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
const GUID = '1AAAAAAAAAAAAAAAAAAAAAAAAA';
// Indent Rainbow v1.x, read off the live stylesheet on Thymer Desktop.
const INDENT_RAINBOW = 'body.thymer-ir-path-refs .listitem[data-thymer-ir-path] :is(.lineitem-ref, [class*="hashtag"])';
const PAGE_DEFAULT = 'body.refx-links-distinct :where(.lineitem-ref[data-guid]:not(.refx-lineref-chip))';

function bridgeBlocks(plugin, guids) {
  const out = new Map();
  const text = plugin._lineRefBridgeCss(guids);
  for (const [prefix] of PREFIXES) {
    const sel = plugin._lineRefBridgeSelector(prefix, guids);
    const i = text.indexOf(sel + ' {');
    if (i < 0) continue;
    out.set(prefix, text.slice(i + sel.length + 2, text.indexOf('}', i)));
  }
  return out;
}

test('the bridge declarations mirror the classified line-ref rules exactly', () => {
  const { plugin } = instance();
  const blocks = bridgeBlocks(plugin, ['1AAAAAAAAAAAAAAAAAAAAAAAAA']);
  for (const [prefix, classSelector] of PREFIXES) {
    const fromSource = staticRule(classSelector);
    assert.ok(fromSource, `static rule present: ${classSelector}`);
    assert.ok(blocks.has(prefix), `bridge emits a block for ${prefix}`);
    assert.deepEqual(decls(blocks.get(prefix)), decls(fromSource),
      `bridge declarations drifted from ${classSelector}`);
  }
});

test('every bridge selector stops matching the moment our class lands', () => {
  // This is what keeps the bridge from overriding the classified rules or the
  // user's underline-style knob: it is a pre-classification bridge, not a
  // second styling system.
  const { plugin } = instance();
  for (const [prefix] of PREFIXES) {
    const sel = plugin._lineRefBridgeSelector(prefix, ['1AAAAAAAAAAAAAAAAAAAAAAAAA']);
    assert.match(sel, /:where\(:not\(\.refx-pageref-chip,\.refx-lineref-chip\)\)$/, sel);
    assert.match(sel, /\.lineitem-ref/, sel);
  }
});

test('specificity sanity: :where() is free, :is()/:not() take the max argument', () => {
  assert.deepEqual(specificity('body.refx-links-distinct .refx-lineref-chip'), [0, 2, 1]);
  assert.deepEqual(specificity('body.refx-links-distinct :where(.a.b.c)'), [0, 1, 1]);
  assert.deepEqual(specificity('div:is(.a, #x)'), [1, 0, 1]);
  assert.deepEqual(specificity(INDENT_RAINBOW), [0, 4, 1]);
});

test('THE FLICKER INVARIANT: a bridge rule weighs exactly what its classified rule weighs', () => {
  // This is what stops a chip changing appearance as Thymer rebuilds it. If the
  // bridge outranks the classified rule (v4.49.9 did, [0,5,1] vs [0,2,1]) then a
  // third-party rule that beats the classified rule but loses to the bridge makes
  // the chip flip on every rebuild — exactly what Indent Rainbow's path colouring
  // did to line refs while leaving page refs untouched.
  const { plugin } = instance();
  for (const [prefix, classSelector] of PREFIXES) {
    assert.deepEqual(
      specificity(plugin._lineRefBridgeSelector(prefix, [GUID])),
      specificity(classSelector),
      `bridge weight must equal ${classSelector}`
    );
  }
});

test('any third-party override beats every chip state or none of them', () => {
  // Stated against the real rule that produced the bug report. The point is not
  // that RefX should win; it is that the outcome must not depend on whether our
  // class happens to be on the node this frame.
  const { plugin } = instance();
  const ir = specificity(INDENT_RAINBOW);
  const states = [
    ['classified line ref', specificity('body.refx-links-distinct .refx-lineref-chip')],
    ['classified page ref', specificity('body.refx-links-distinct .refx-pageref-chip')],
    ['unclassified default', specificity(PAGE_DEFAULT)],
    ['line-kind bridge', specificity(plugin._lineRefBridgeSelector('body.refx-links-distinct', [GUID]))]
  ];
  const verdicts = states.map(([name, s]) => [name, cmp(ir, s) > 0]);
  assert.equal(new Set(verdicts.map((v) => v[1])).size, 1,
    'third-party rule must not win in some states and lose in others: ' + JSON.stringify(verdicts));
});

test('the bridge still outranks the unclassified default, so sheet order cannot matter', () => {
  const { plugin } = instance();
  assert.ok(cmp(specificity(plugin._lineRefBridgeSelector('body.refx-links-distinct', [GUID])),
                specificity(PAGE_DEFAULT)) > 0);
  assert.match(source, new RegExp(PAGE_DEFAULT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the default selector this specificity claim was measured against still exists');
});

test('the unclassified default weighs less than the classified rule it stands behind', () => {
  for (const preset of ['distinct', 'roam']) {
    const dflt = `body.refx-links-${preset} :where(.lineitem-ref[data-guid]:not(.refx-lineref-chip))`;
    assert.ok(cmp(specificity(dflt), specificity(`body.refx-links-${preset} .refx-pageref-chip`)) < 0, preset);
    assert.match(source, new RegExp(dflt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), preset);
  }
});

test('a line verdict writes the guid into one managed sheet before the next paint', async () => {
  const { plugin, context, sheet } = instance();
  const owner = '1OWNERREC000000000000000000';
  const lineGuid = '1LINEBRIDGE0000000000000000';
  plugin.data = { getRecord: (g) => g === owner ? { guid: g } : null };
  context.window.g_universe.itemsByGuid[lineGuid] = { guid: lineGuid, rguid: owner, type: 'text' };

  const classes = classListSet(['lineitem-ref']);
  assert.equal(plugin._tagReferenceChip({ classList: classes }, lineGuid), 'line');
  assert.equal(classes.contains('refx-lineref-chip'), true);
  await flush();
  assert.match(sheet(), new RegExp(`\\[data-guid="${lineGuid}"\\]`));
});

test('a page ref never enters the bridge, and a record verdict evicts a stale entry', async () => {
  const { plugin, context, sheet } = instance();
  const owner = '1OWNERREC000000000000000000';
  const lineGuid = '1LINEEVICT00000000000000000';
  plugin.data = { getRecord: (g) => g === owner ? { guid: g } : null };
  context.window.g_universe.itemsByGuid[lineGuid] = { guid: lineGuid, rguid: owner, type: 'text' };
  plugin._tagReferenceChip({ classList: classListSet(['lineitem-ref']) }, lineGuid);
  await flush();
  assert.match(sheet(), new RegExp(lineGuid));

  // The page ref itself is styled by the static default, not the bridge.
  plugin._tagReferenceChip({ classList: classListSet(['lineitem-ref']) }, owner);
  await flush();
  assert.doesNotMatch(sheet(), new RegExp(owner));

  // A later record verdict for the same guid removes it.
  plugin._noteReferenceKindForCss(lineGuid, 'record');
  await flush();
  assert.doesNotMatch(sheet(), new RegExp(lineGuid));
});

test('re-tagging a known line ref performs no sheet write', async () => {
  const { plugin, context, styles } = instance();
  const owner = '1OWNERREC000000000000000000';
  const lineGuid = '1LINEQUIET00000000000000000';
  plugin.data = { getRecord: (g) => g === owner ? { guid: g } : null };
  context.window.g_universe.itemsByGuid[lineGuid] = { guid: lineGuid, rguid: owner, type: 'text' };
  plugin._tagReferenceChip({ classList: classListSet(['lineitem-ref']) }, lineGuid);
  await flush();

  const node = styles.get('refx-linekind-style');
  let writes = 0;
  let text = node.textContent;
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: (v) => { writes++; text = v; }
  });
  for (let i = 0; i < 25; i++) plugin._tagReferenceChip({ classList: classListSet(['lineitem-ref', 'refx-lineref-chip']) }, lineGuid);
  await flush();
  assert.equal(writes, 0);
});

test('the bridge is bounded and evicts oldest first', async () => {
  const { plugin, sheet } = instance();
  const guid = (i) => '1BOUND' + String(i).padStart(20, '0');
  for (let i = 0; i < plugin._LINE_KIND_CAP + 25; i++) plugin._noteReferenceKindForCss(guid(i), 'line');
  await flush();
  assert.equal(plugin._lineKindGuids.size, plugin._LINE_KIND_CAP);
  assert.doesNotMatch(sheet(), new RegExp(guid(0)));
  assert.match(sheet(), new RegExp(guid(plugin._LINE_KIND_CAP + 24)));
});

test('a guid that could break out of the selector is rejected', async () => {
  const { plugin, sheet } = instance();
  for (const bad of ['"]{color:red}[x="', 'a b', 'short', '<script>', 'x'.repeat(80)]) {
    plugin._noteReferenceKindForCss(bad, 'line');
  }
  await flush();
  assert.equal(plugin._lineKindGuids.size, 0);
  assert.equal(sheet(), '');
});

test('the sheet is one adopted node, removed only by the real teardown', async () => {
  const { plugin, styles } = instance();
  plugin._noteReferenceKindForCss('1TEARDOWNGUID00000000000000', 'line');
  await flush();
  plugin._noteReferenceKindForCss('1TEARDOWNGUID00000000000002', 'line');
  await flush();
  assert.equal(styles.size, 1, 'never a second style node');
  // Removal is wired into the same teardown that drops the main stylesheet, so a
  // hot reload adopts the node instead of repainting a frame with no rules.
  assert.match(source, /document\.getElementById\(this\._LINE_KIND_STYLE_ID\)\?\.remove\(\)/);
  assert.doesNotMatch(source, /_LINE_KIND_STYLE_ID\)\?\.remove\(\)[\s\S]{0,200}createElement/);
});
