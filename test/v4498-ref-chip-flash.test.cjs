// v4.49.8 — the blinking reference chip.
//
// Measured on Thymer Desktop (CDP :9333) against 4.49.7 with a second class
// writer present (a leaked instance after a Plugins-Manager update, rule 27):
// 425 of 715 painted frames showed Thymer's NATIVE chip paint, animating
// through the host's 200ms colour ramp (rgb(16,107,163) → rgb(105,201,197)).
// With the unclassified-chip fallback rule in place, the same run painted
// 0 of 727 frames native.
//
// Two guarantees are locked in here:
//   1. Appearance does not depend on our class being present. Static CSS gives
//      every `.lineitem-ref[data-guid]` the page-reference paint unless it is
//      positively classified as a LINE ref, so no frame can paint native.
//   2. Classification is monotonic. A cold 'unknown' verdict never repaints a
//      chip that was already classified.
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
    window: { CSS: { escape: (s) => String(s) }, g_universe: { itemsByGuid: {}, workspace: {} } }
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

const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
// The rule whose selector list contains `selector`, skipping transition-only groups.
function ruleFor(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?<![\\w-])' + esc + '(\\s*,[^{]*?)?\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(css))) {
    const decls = m[2];
    if (/[a-z-]+\s*:/.test(decls.replace(/transition\s*:[^;]*;?/g, ''))) return decls;
  }
  return null;
}

test('an unclassified reference chip paints the page appearance in both styled presets', () => {
  for (const preset of ['distinct', 'roam']) {
    const decls = ruleFor(`body.refx-links-${preset} :where(.lineitem-ref[data-guid]:not(.refx-lineref-chip))`);
    assert.ok(decls, `${preset} fallback rule present`);
    assert.match(decls, /color: var\(--refx-page-link-color,/, `${preset} fallback uses the page-link colour`);
  }
});

test('the fallback shares one rule with the classified page-ref selector (no second source of truth)', () => {
  for (const preset of ['distinct', 'roam']) {
    assert.equal(
      ruleFor(`body.refx-links-${preset} .refx-pageref-chip`),
      ruleFor(`body.refx-links-${preset} :where(.lineitem-ref[data-guid]:not(.refx-lineref-chip))`),
      `${preset} page-ref declarations are declared exactly once`
    );
  }
});

test('a classified line ref opts out of the fallback', () => {
  // Every fallback selector must carry :not(.refx-lineref-chip); otherwise a
  // line ref would paint page-blue and the fallback would be the new bug.
  // v4.49.10 wraps the paint/hover ones in :where() (see the flicker invariant in
  // v4499-lineref-bridge.test.cjs); the :not() is what still has to be there.
  const fallbacks = css.match(/body\.refx-links-(?:distinct|roam)[^,{]*\.lineitem-ref\[data-guid\][^,{]*/g) || [];
  assert.ok(fallbacks.length >= 6, `found ${fallbacks.length} fallback selectors`);
  for (const sel of fallbacks) {
    assert.match(sel, /:not\(\.refx-lineref-chip\)/, `fallback selector excludes line refs: ${sel}`);
  }
});

test('the unclassified fallback never animates from the native paint', () => {
  const group = /body\.refx-links-distinct \.lineitem-ref\[data-guid\]:not\(\.refx-lineref-chip\),\s*body\.refx-links-roam \.lineitem-ref\[data-guid\]:not\(\.refx-lineref-chip\) \{\s*transition: none !important;\s*\}/;
  assert.match(css, group);
});

test('native preset is untouched: the fallback is gated on a styled body class', () => {
  // referenceStyle 'native' sets neither body class, so users who opted out of
  // RefX appearance keep Thymer's own chip paint.
  const bare = css.match(/^\s*\.lineitem-ref\[data-guid\]:not\(\.refx-lineref-chip\)/m);
  assert.equal(bare, null, 'no ungated fallback selector');
});

test('a cold "unknown" verdict does not repaint an already-classified chip', () => {
  const { plugin } = instance();
  const guid = '1COLDPAGE00000000000000000A';
  // Nothing resolves: registry empty, no record, no hints — the classifier
  // returns 'unknown', which is what a leaked instance or a cold model sees.
  plugin.data = { getRecord: () => null };
  const classes = classListSet(['lineitem-ref', 'refx-pageref-chip']);
  const kind = plugin._tagReferenceChip({ classList: classes }, guid);
  assert.equal(kind, 'unknown');
  assert.equal(classes.contains('refx-pageref-chip'), true, 'positive classification survives a cold verdict');
  assert.equal(classes.contains('refx-lineref-chip'), false);
});

test('an unknown verdict does not classify an unclassified chip either', () => {
  const { plugin } = instance();
  plugin.data = { getRecord: () => null };
  const classes = classListSet(['lineitem-ref']);
  plugin._tagReferenceChip({ classList: classes }, '1COLDNONE00000000000000000B');
  assert.equal(classes.contains('refx-pageref-chip'), false);
  assert.equal(classes.contains('refx-lineref-chip'), false);
});

test('positive evidence still moves a chip between the two real kinds', () => {
  const { plugin, context } = instance();
  const pageGuid = '1REALPAGE00000000000000000C';
  const lineGuid = '1REALLINE00000000000000000D';
  plugin.data = { getRecord: (g) => g === pageGuid ? { guid: g } : null };
  context.window.g_universe.itemsByGuid[lineGuid] = { guid: lineGuid, rguid: pageGuid, type: 'text' };

  // A chip mis-tagged as a page ref is corrected once line evidence arrives.
  const classes = classListSet(['lineitem-ref', 'refx-pageref-chip']);
  assert.equal(plugin._tagReferenceChip({ classList: classes }, lineGuid), 'line');
  assert.equal(classes.contains('refx-lineref-chip'), true);
  assert.equal(classes.contains('refx-pageref-chip'), false);

  const pageClasses = classListSet(['lineitem-ref']);
  assert.equal(plugin._tagReferenceChip({ classList: pageClasses }, pageGuid), 'record');
  assert.equal(pageClasses.contains('refx-pageref-chip'), true);
  assert.equal(pageClasses.contains('refx-lineref-chip'), false);
});

test('a keystroke burst against a cold classifier performs zero class writes', () => {
  // The regression: every re-rendered chip used to be re-toggled twice per
  // keystroke while the model was cold, stripping the paint each time.
  const { plugin } = instance();
  plugin.data = { getRecord: () => null };
  let writes = 0;
  const classes = classListSet(['lineitem-ref', 'refx-pageref-chip']);
  const chip = {
    classList: {
      contains: classes.contains,
      toggle: (n, f) => { writes++; return classes.toggle(n, f); },
      add: (...n) => { writes++; classes.add(...n); },
      remove: (...n) => { writes++; classes.remove(...n); }
    }
  };
  for (let i = 0; i < 20; i++) plugin._tagReferenceChip(chip, '1COLDBURST0000000000000000E');
  assert.equal(writes, 0);
  assert.equal(classes.contains('refx-pageref-chip'), true);
});
