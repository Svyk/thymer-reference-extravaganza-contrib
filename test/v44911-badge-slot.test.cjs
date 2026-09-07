const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

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

function loadPlugin() {
  const storage = new Map();
  const styles = new Map();
  const bodyStyle = new Map();
  const context = {
    MutationObserver: class { observe() {} disconnect() {} },
    AppPlugin: class {},
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    requestIdleCallback: (fn) => setTimeout(fn, 0),
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
      getElementById: (id) => styles.get(id) || null,
      createElement: (tag) => ({ tagName: tag.toUpperCase(), id: '', textContent: '', isConnected: false }),
      documentElement: { clientHeight: 900 },
      body: {
        classList: classListSet(),
        style: {
          setProperty: (name, value) => bodyStyle.set(name, String(value)),
          getPropertyValue: (name) => bodyStyle.get(name) || '',
          removeProperty: (name) => bodyStyle.delete(name)
        }
      },
      head: {
        appendChild(node) {
          node.isConnected = true;
          if (node.id) styles.set(node.id, node);
          return node;
        }
      },
      addEventListener() {}
    },
    Element: class {},
    window: {
      CSS: { escape: (s) => String(s) },
      g_universe: { itemsByGuid: {}, workspace: {} },
      addEventListener() {}
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  return { Plugin: context.PluginUnderTest, context, storage, styles, bodyStyle };
}

function counterPlugin(cfg = {}) {
  const { Plugin, context, storage, styles, bodyStyle } = loadPlugin();
  const plugin = new Plugin();
  plugin.workspaceGuid = 'WS';
  plugin.ui = { addCommandPaletteCommand: () => ({}) };
  plugin.events = { on: () => 'id' };
  plugin.getConfiguration = () => cfg;
  plugin._scheduleOverlayReposition = () => {};
  plugin._liveOverlayBadges = new Map();
  plugin._breadcrumbsEnabled = true;
  return { plugin, context, storage, styles, bodyStyle };
}

test('_counterInit with empty localStorage defaults _badgeSlot to 0 and sets body CSS var', () => {
  const { plugin, bodyStyle } = counterPlugin();
  plugin._counterInit({});
  assert.equal(plugin._badgeSlot, 0);
  assert.equal(bodyStyle.get('--refx-badge-slot'), '0px');
});

test('injectCounterCss uses var(--refx-badge-slot) and not hardcoded 36px padding-right', () => {
  const { plugin, styles } = counterPlugin();
  plugin._counterInit({});
  const styleEl = styles.get('trc-reference-counter-style');
  assert.ok(styleEl, 'counter stylesheet injected');
  assert.match(styleEl.textContent, /padding-right:\s*var\(--refx-badge-slot,\s*0px\)/);
  assert.doesNotMatch(styleEl.textContent, /padding-right:\s*36px/);
});

test('setBadgeSlot(36) persists and applies 36px', () => {
  const { plugin, storage, bodyStyle } = counterPlugin();
  plugin._counterInit({});
  plugin.setBadgeSlot(36);
  assert.equal(plugin._badgeSlot, 36);
  assert.equal(bodyStyle.get('--refx-badge-slot'), '36px');
  assert.equal(storage.get('refx_badge_slot_v1'), '36');
});

test('setBadgeSlot(0) writes 0px', () => {
  const { plugin, storage, bodyStyle } = counterPlugin();
  plugin._counterInit({});
  plugin.setBadgeSlot(36);
  plugin.setBadgeSlot(0);
  assert.equal(plugin._badgeSlot, 0);
  assert.equal(bodyStyle.get('--refx-badge-slot'), '0px');
  assert.equal(storage.get('refx_badge_slot_v1'), '0');
});

test('coerceBadgeSlot rounds to nearest allowed value', () => {
  const { plugin } = counterPlugin();
  assert.equal(plugin.coerceBadgeSlot('7', 0), 10);
  assert.equal(plugin.coerceBadgeSlot('99', 0), 36);
  assert.equal(plugin.coerceBadgeSlot('NaN', 0), 0);
  assert.equal(plugin.coerceBadgeSlot('nope', 0), 0);
});

test('stored overlay gap 14 survives Tight slot 10 on init', () => {
  const { plugin, storage } = counterPlugin();
  storage.set('refx_overlay_gap_v1', '14');
  storage.set('refx_badge_slot_v1', '10');
  plugin._counterInit({});
  assert.equal(plugin._badgeSlot, 10);
  assert.equal(plugin._overlayGap, 14);
});

test('setBadgeSlot does not rewrite overlay gap', () => {
  const { plugin } = counterPlugin();
  plugin._counterInit({});
  plugin.setOverlayGap(14);
  plugin.setBadgeSlot(10);
  assert.equal(plugin._overlayGap, 14);
  plugin.setBadgeSlot(0);
  assert.equal(plugin._overlayGap, 14);
});

test('custom.counter.badgeSlot seeds when storage empty; stored value wins over config', () => {
  const { plugin: seeded, bodyStyle: seededBody } = counterPlugin({
    custom: { counter: { badgeSlot: 36 } }
  });
  seeded._counterInit({ custom: { counter: { badgeSlot: 36 } } });
  assert.equal(seeded._badgeSlot, 36);
  assert.equal(seededBody.get('--refx-badge-slot'), '36px');

  const { plugin: stored, storage, bodyStyle: storedBody } = counterPlugin({
    custom: { counter: { badgeSlot: 36 } }
  });
  storage.set('refx_badge_slot_v1', '0');
  stored._counterInit({ custom: { counter: { badgeSlot: 36 } } });
  assert.equal(stored._badgeSlot, 0);
  assert.equal(storedBody.get('--refx-badge-slot'), '0px');
});
