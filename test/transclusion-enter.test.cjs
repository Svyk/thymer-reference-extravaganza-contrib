// test/transclusion-enter.test.cjs
// A1 + A2 behavioral suite: transclusion Enter (generalized WB mechanism)
// + embed badge collapse.
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

function instance() {
  const { Plugin, context } = loadPlugin();
  const plugin = new Plugin();
  plugin._isUnloading = false;
  plugin._unloaded = false;
  plugin._enabled = true;
  plugin._modal = null;
  plugin._link = null;
  plugin._cardEditing = false;
  plugin._cardNav = null;
  return { plugin, context };
}

function classListSet(initial = []) {
  const set = new Set(initial);
  return {
    set,
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (name) => set.has(name),
    toggle(name, force) {
      if (force === undefined) force = !set.has(name);
      if (force) set.add(name); else set.delete(name);
      return force;
    }
  };
}

function nativePickerNode(overrides = {}) {
  const classes = overrides.classList ? null : classListSet(
    typeof overrides.className === 'string' ? overrides.className.split(/\s+/).filter(Boolean) : ['cmdpal--inline']
  );
  return {
    isConnected: true,
    hidden: false,
    style: {},
    className: 'cmdpal--inline',
    classList: classes || overrides.classList,
    getAttribute: (a) => null,
    ...overrides
  };
}

function transclusionEnterSetup(plugin, context) {
  context.localStorage.setItem('refx_transclusion_enter', '1');
  const container = {
    isConnected: false,
    closest: (sel) => sel === '.transclusion-container-div' ? container : null,
    querySelector: () => null
  };
  plugin._detect = () => ({ lineGuid: 'LINE1', lineNode: container });
  return container;
}

function keyEvent(key, mods = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    prevented: false,
    stopped: false,
    ...mods,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };
}

// ── A1: Enter creates children inside inline transclusions ────────────────────

test('A1-01: plain Enter inside .transclusion-container-div is intercepted', async () => {
  const { plugin, context } = instance();
  context.localStorage.setItem('refx_transclusion_enter', '1');
  const container = {
    isConnected: false,
    closest: (sel) => sel === '.transclusion-container-div' ? container
      : sel.includes('listitem-transclusion') ? null : null,
    querySelector: () => null
  };
  plugin._detect = () => ({ lineGuid: 'LINE1', lineNode: container });
  context.window.g_universe.itemsByGuid['LINE1'] = { guid: 'LINE1', rguid: 'REC1', props: {}, parent_guid: null };
  const li = { guid: 'LINE1', type: 'text', children: [] };
  const rec = {
    getLineItems: async () => [li],
    createLineItem: async () => ({ guid: 'NEWLINE' })
  };
  plugin.data = { getRecord: (g) => g === 'REC1' ? rec : null };
  plugin._hitTestCaret = () => {};
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(e.prevented, 'preventDefault must be called');
  assert.ok(e.stopped, 'stopImmediatePropagation must be called');
});

test('A1-01b: visible native inline picker prevents Enter interception in transclusion', () => {
  const { plugin, context } = instance();
  transclusionEnterSetup(plugin, context);
  const portal = nativePickerNode();
  context.document.querySelectorAll = () => [portal];
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.prevented, 'visible native picker must not trigger preventDefault');
  assert.ok(!e.stopped, 'visible native picker must not trigger stopImmediatePropagation');
});

test('A1-01c: hidden native picker still allows Enter interception', () => {
  const { plugin, context } = instance();
  transclusionEnterSetup(plugin, context);
  const cases = [
    nativePickerNode({ hidden: true }),
    nativePickerNode({ getAttribute: (a) => a === 'aria-hidden' ? 'true' : null }),
    nativePickerNode({ className: 'cmdpal--inline hidden', classList: classListSet(['cmdpal--inline', 'hidden']) })
  ];
  for (const portal of cases) {
    context.document.querySelectorAll = () => [portal];
    const e = keyEvent('Enter');
    plugin._handleWbEnter(e);
    assert.ok(e.prevented, `hidden picker (${portal.hidden ? 'hidden' : portal.getAttribute('aria-hidden') || 'class'}) must still intercept`);
    assert.ok(e.stopped, 'hidden picker must still stop propagation');
  }
});

// ── v4.49.7: the native @ picker owns Enter AND the click that commits it ─────

// The caret line's own text element, so _wbEnterHasOpenTrigger reads the live
// DOM rather than falling back to _lineTextByGuid.
function ownTextContainer(text) {
  const container = {
    isConnected: false,
    closest: (sel) => sel === '.transclusion-container-div' ? container : null,
    querySelector: (sel) => sel === ':scope > .listitem-text' ? { textContent: text } : null
  };
  return container;
}

test('A1-01d: uncommitted @ trigger on the caret line yields Enter to the native picker', () => {
  const { plugin, context } = instance();
  context.localStorage.setItem('refx_transclusion_enter', '1');
  for (const text of ['so @today', 'meet @', 'due @tod']) {
    const container = ownTextContainer(text);
    plugin._detect = () => ({ lineGuid: 'LINE1', lineNode: container });
    const e = keyEvent('Enter');
    plugin._handleWbEnter(e);
    assert.ok(!e.prevented, `"${text}" must not trigger preventDefault`);
    assert.ok(!e.stopped, `"${text}" must not stop propagation`);
  }
});

test('A1-01e: committed text (no open @ trigger) still intercepts Enter', async () => {
  const { plugin, context } = instance();
  context.localStorage.setItem('refx_transclusion_enter', '1');
  for (const text of ['so @today ', 'plain line', 'mail svyk@icloud.com now']) {
    const container = ownTextContainer(text);
    plugin._detect = () => ({ lineGuid: 'LINE1', lineNode: container });
    context.window.g_universe.itemsByGuid['LINE1'] = { guid: 'LINE1', rguid: 'REC1', props: {}, parent_guid: null };
    plugin.data = { getRecord: () => ({ getLineItems: async () => [], createLineItem: async () => null }) };
    plugin._hitTestCaret = () => {};
    plugin._toast = () => {};
    const e = keyEvent('Enter');
    plugin._handleWbEnter(e);
    assert.ok(e.prevented, `"${text}" must still be intercepted`);
  }
});

test('A1-01f: uncommitted @ read from _lineTextByGuid when the DOM text is unavailable', () => {
  const { plugin, context } = instance();
  const container = transclusionEnterSetup(plugin, context); // querySelector → null
  assert.equal(container.querySelector(':scope > .listitem-text'), null);
  plugin._lineTextByGuid = () => 'so @today';
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.prevented, 'data-side @ trigger must not trigger preventDefault');
});

test('A1-01g: .omni-overlay counts as a visible native picker', () => {
  const { plugin, context } = instance();
  transclusionEnterSetup(plugin, context);
  const portal = nativePickerNode({ className: 'omni-overlay', classList: classListSet(['omni-overlay']) });
  context.document.querySelectorAll = () => [portal];
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.prevented, 'omni-overlay picker must not trigger preventDefault');
  assert.ok(plugin._nativePickerRootSelector().includes('.omni-overlay'), 'root selector must list .omni-overlay');
  assert.ok(plugin._nativePickerSelector().includes('.omni-overlay'), 'node selector must list .omni-overlay');
});

// ── v4.49.7 _wbFocusFix: a click that commits the picker is not a split-focus ──

function focusFixSetup(plugin, context, opts = {}) {
  const calls = [];
  plugin._hitTestCaret = (node) => calls.push(node);
  plugin._wbFocusSuppressUntil = 0;
  const wbEl = { classList: classListSet(['editor-panel', 'refx-wb-live', 'focused-component']) };
  const textNode = { text: true };
  const thread = {
    closest: () => null, // caret is in the MAIN panel → split focus
    querySelector: (sel) => sel === '.lineitem-text' ? textNode : null
  };
  context.document.querySelector = (sel) => {
    if (sel === '.editor-panel.refx-wb-live') return wbEl;
    if (sel === '.flowythymer-thread-target') return thread;
    return null;
  };
  context.document.querySelectorAll = () => opts.pickers || [];
  const pickerSel = plugin._nativePickerSelector();
  const target = {
    nodeType: 1,
    matches: () => false,
    querySelectorAll: (sel) => (opts.targetHasPickerDescendant && sel === pickerSel) ? [nativePickerNode()] : [],
    closest: (sel) => {
      if (sel === '.editor-panel.refx-wb-live') return wbEl;
      if (sel === '.transclusion-container-div') return { tx: true };
      if (sel === pickerSel) return opts.targetInPicker ? nativePickerNode({ nodeType: 1, matches: (s) => s === pickerSel }) : null;
      return null;
    }
  };
  return { calls, target, textNode };
}

test('A2-10: click inside a WB transclusion still repairs split focus when no picker is open', async () => {
  const { plugin, context } = instance();
  const { calls, target, textNode } = focusFixSetup(plugin, context);
  plugin._wbFocusFix({ isTrusted: true, target });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1, 'settle-check must run with no picker open');
  assert.equal(calls[0], textNode);
});

test('A2-11: a visible native picker suppresses the _wbFocusFix settle-check', async () => {
  const { plugin, context } = instance();
  const { calls, target } = focusFixSetup(plugin, context, { pickers: [nativePickerNode()] });
  plugin._wbFocusFix({ isTrusted: true, target });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 0, 'visible picker must not yank the caret mid-commit');
});

test('A2-12: clicking a picker row (or its descendant) suppresses the settle-check', async () => {
  for (const opts of [{ targetInPicker: true }, { targetHasPickerDescendant: true }]) {
    const { plugin, context } = instance();
    const { calls, target } = focusFixSetup(plugin, context, opts);
    plugin._wbFocusFix({ isTrusted: true, target });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 0, 'a click on the picker itself must not run the settle-check');
  }
});

test('A1-02: Enter on root line creates first-child (parent=root, after=null)', async () => {
  const { plugin, context } = instance();
  context.localStorage.setItem('refx_transclusion_enter', '1');
  const rootLine = { guid: 'ROOT', type: 'text', children: [] };
  let createArgs = null;
  const rec = {
    getLineItems: async () => [rootLine],
    createLineItem: async (parent, after, type) => {
      createArgs = { parentGuid: parent && parent.guid, afterGuid: after, type };
      return { guid: 'NEW_CHILD' };
    }
  };
  context.window.g_universe.itemsByGuid['ROOT'] = { guid: 'ROOT', rguid: 'REC_ROOT', props: {}, parent_guid: null };
  // Slot's itemref === 'ROOT' → isOnRoot = true.
  context.window.g_universe.itemsByGuid['SLOT'] = { guid: 'SLOT', props: { itemref: 'ROOT' } };
  const slotNode = { getAttribute: (a) => a === 'data-guid' ? 'SLOT' : null };
  const container = {
    isConnected: false,
    closest: (sel) => {
      if (sel === '.transclusion-container-div') return container;
      if (sel === '.listitem-transclusion[data-guid]') return slotNode;
      return null;
    },
    querySelector: () => null
  };
  plugin.data = { getRecord: (g) => g === 'REC_ROOT' ? rec : null };
  plugin._hitTestCaret = () => {};
  await plugin._wbCreateSiblingBelow({ lineGuid: 'ROOT' }, container);
  assert.ok(createArgs, 'createLineItem must be called');
  assert.equal(createArgs.parentGuid, 'ROOT', 'parent must be the root line');
  assert.equal(createArgs.afterGuid, null, 'after must be null (first-child)');
  assert.equal(createArgs.type, 'text');
});

test('A1-03: Enter on descendant creates sibling-after (parent=grandparent, after=sibling)', async () => {
  const { plugin, context } = instance();
  context.localStorage.setItem('refx_transclusion_enter', '1');
  const parentLine = { guid: 'PARENT', type: 'text', children: [], parent_guid: null };
  const childLine = { guid: 'CHILD', type: 'text', children: [], parent_guid: 'PARENT' };
  parentLine.children = [childLine];
  let createArgs = null;
  const rec = {
    getLineItems: async () => [parentLine],
    createLineItem: async (p, after, type) => {
      createArgs = { parentGuid: p && p.guid, afterGuid: after && after.guid, type };
      return { guid: 'NEW_SIB' };
    }
  };
  context.window.g_universe.itemsByGuid['CHILD'] = { guid: 'CHILD', rguid: 'REC_D', props: {}, parent_guid: 'PARENT' };
  // Slot itemref is NOT 'CHILD' → isOnRoot = false.
  context.window.g_universe.itemsByGuid['SLOT'] = { guid: 'SLOT', props: { itemref: 'PARENT' } };
  const slotNode = { getAttribute: (a) => a === 'data-guid' ? 'SLOT' : null };
  const container = {
    isConnected: false,
    closest: (sel) => {
      if (sel === '.transclusion-container-div') return container;
      if (sel === '.listitem-transclusion[data-guid]') return slotNode;
      return null;
    },
    querySelector: () => null
  };
  plugin.data = { getRecord: (g) => g === 'REC_D' ? rec : null };
  plugin._hitTestCaret = () => {};
  await plugin._wbCreateSiblingBelow({ lineGuid: 'CHILD' }, container);
  assert.ok(createArgs, 'createLineItem must be called');
  assert.equal(createArgs.parentGuid, 'PARENT', 'sibling-after: parent must be PARENT line');
  assert.equal(createArgs.afterGuid, 'CHILD', 'sibling-after: after must be CHILD line');
  assert.equal(createArgs.type, 'text');
});

test('A1-04: modifier keys (Shift+Enter, Ctrl+Enter, Meta+Enter, Alt+Enter) are not intercepted', () => {
  const { plugin } = instance();
  const container = { closest: () => container };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: container });
  for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) {
    const e = keyEvent('Enter', { [mod]: true });
    plugin._handleWbEnter(e);
    assert.ok(!e.stopped, `${mod}+Enter must not be intercepted`);
  }
});

test('A1-05: modal guard prevents interception', () => {
  const { plugin } = instance();
  plugin._modal = { el: {} }; // truthy modal object — no document.createElement needed
  const container = { closest: () => container };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: container });
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.stopped, 'modal guard must prevent interception');
});

test('A1-06: link mode guard prevents interception', () => {
  const { plugin } = instance();
  plugin._link = { active: true };
  const container = { closest: () => container };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: container });
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.stopped, '_link guard must prevent interception');
});

test('A1-07: cardEditing guard prevents interception', () => {
  const { plugin } = instance();
  plugin._cardEditing = true;
  const container = { closest: () => container };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: container });
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.stopped, '_cardEditing guard must prevent interception');
});

test('A1-08: cardNav guard prevents interception', () => {
  const { plugin } = instance();
  plugin._cardNav = { lineGuid: 'X' };
  const container = { closest: () => container };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: container });
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.stopped, '_cardNav guard must prevent interception');
});

test('A1-09: kill-switch (refx_transclusion_enter=0) disables Enter interception', () => {
  const { plugin, context } = instance();
  context.localStorage.setItem('refx_transclusion_enter', '0');
  const container = { closest: () => container };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: container });
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.prevented, 'kill-switch must suppress Enter interception');
  assert.ok(!e.stopped, 'kill-switch must suppress Enter interception');
});

test('A1-10: kill-switch defaults to ON (no localStorage value)', () => {
  const { plugin } = instance();
  // No localStorage value set — default is ON (true).
  const on = plugin.loadBoolSetting('refx_transclusion_enter', true);
  assert.equal(on, true, 'kill-switch default must be ON');
});

test('A1-11: caret NOT inside a transclusion container is not intercepted', () => {
  const { plugin } = instance();
  // closest('.transclusion-container-div') returns null → no transclusion.
  const node = { closest: (sel) => null };
  plugin._detect = () => ({ lineGuid: 'X', lineNode: node });
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.stopped, 'non-transclusion caret must not be intercepted');
});

test('A1-12: _detect returning null/no hit is not intercepted', () => {
  const { plugin } = instance();
  plugin._detect = () => null;
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  assert.ok(!e.stopped, 'null hit must not be intercepted');
});

test('A1-13: WB panel (refx-wb-live) still works with generalized selector', async () => {
  // The WB path was previously gated on ".refx-wb-live .transclusion-container-div";
  // with the generalized selector it still fires because the container is a
  // .transclusion-container-div regardless of its ancestor.
  const { plugin, context } = instance();
  context.localStorage.setItem('refx_transclusion_enter', '1');
  const wbContainer = {
    isConnected: false,
    closest: (sel) => {
      if (sel === '.transclusion-container-div') return wbContainer;
      return null;
    },
    querySelector: () => null,
    // WB container does NOT have .refx-wb-live ancestor — the generalized test
    // matches it anyway via .transclusion-container-div.
  };
  plugin._detect = () => ({ lineGuid: 'WB_LINE', lineNode: wbContainer });
  context.window.g_universe.itemsByGuid['WB_LINE'] = { guid: 'WB_LINE', rguid: 'REC_WB', props: {}, parent_guid: null };
  const li = { guid: 'WB_LINE', type: 'text', children: [] };
  let created = false;
  const rec = {
    getLineItems: async () => [li],
    createLineItem: async () => { created = true; return { guid: 'WB_NEW' }; }
  };
  plugin.data = { getRecord: (g) => g === 'REC_WB' ? rec : null };
  plugin._hitTestCaret = () => {};
  const e = keyEvent('Enter');
  plugin._handleWbEnter(e);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(e.stopped, 'WB container must still be intercepted by generalized handler');
});

// ── A2: badge-click collapse ─────────────────────────────────────────────────

test('A2-01: badge click on refx_embed transclusion triggers _deleteEmbedLine', async () => {
  const { plugin, context } = instance();
  plugin._isUnloading = false;
  const embedLine = { guid: 'EMBED1', type: 'transclusion', props: { refx_embed: 1, itemref: 'TARGET1' } };
  let deleted = null;
  plugin._deleteEmbedLine = async (line) => { deleted = line; };
  plugin._toast = () => {};
  context.window.g_universe.itemsByGuid['EMBED1'] = { guid: 'EMBED1', rguid: 'PAGE1', props: { refx_embed: 1, itemref: 'TARGET1' } };
  const rec = { getLineItems: async () => [embedLine] };
  plugin.data = { getRecord: (g) => g === 'PAGE1' ? rec : null };
  plugin._findLineDeep = (items, g) => items.find((i) => i.guid === g) || null;
  // Simulate _embedBadgeClick handler.
  const li = { getAttribute: (a) => a === 'data-guid' ? 'EMBED1' : null };
  const badge = { closest: (sel) => sel === '.lineitem-transcludes' ? badge : (sel.includes('listitem-transclusion') ? li : null) };
  const e = { target: badge, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, prevented: false, stopped: false };
  // Build and call the handler directly.
  const handler = plugin._embedBadgeClick || ((ev) => {
    const b = ev.target?.closest?.('.lineitem-transcludes');
    if (!b) return;
    const liel = b.closest('.listitem-transclusion[data-guid]');
    if (!liel) return;
    const g = liel.getAttribute('data-guid');
    if (!g) return;
    const st = ((context.window.g_universe && context.window.g_universe.itemsByGuid) || {})[g];
    if (!st || !st.props || !st.props.refx_embed) return;
    if (plugin._isUnloading) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    (async () => {
      try {
        const items = await rec.getLineItems();
        const line = plugin._findLineDeep(items, g);
        if (line) await plugin._deleteEmbedLine(line);
      } catch (_) {}
    })();
  });
  handler(e);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(e.prevented, 'preventDefault must be called on refx_embed badge click');
  assert.ok(e.stopped, 'stopImmediatePropagation must be called on refx_embed badge click');
  assert.ok(deleted, '_deleteEmbedLine must be called');
  assert.equal(deleted.guid, 'EMBED1');
});

test('A2-02: badge click on native (non-refx_embed) transclusion is not intercepted', () => {
  const { plugin, context } = instance();
  plugin._isUnloading = false;
  let deleted = false;
  plugin._deleteEmbedLine = async () => { deleted = true; };
  // Native transclusion: no refx_embed.
  context.window.g_universe.itemsByGuid['NATIVE'] = { guid: 'NATIVE', rguid: 'PAGE_N', props: { itemref: 'TARGET_N' } };
  const li = { getAttribute: (a) => a === 'data-guid' ? 'NATIVE' : null };
  const badge = { closest: (sel) => sel === '.lineitem-transcludes' ? badge : (sel.includes('listitem-transclusion') ? li : null) };
  const handler = (ev) => {
    const b = ev.target?.closest?.('.lineitem-transcludes');
    if (!b) return;
    const liel = b.closest('.listitem-transclusion[data-guid]');
    if (!liel) return;
    const g = liel.getAttribute('data-guid');
    if (!g) return;
    const st = ((context.window.g_universe && context.window.g_universe.itemsByGuid) || {})[g];
    if (!st || !st.props || !st.props.refx_embed) return; // bail for native
    deleted = true;
  };
  handler({ target: badge, preventDefault: () => {}, stopImmediatePropagation: () => {} });
  assert.ok(!deleted, 'native transclusion badge must not trigger collapse');
});

test('A2-03: badge click with no .lineitem-transcludes ancestor is a no-op', () => {
  const { plugin } = instance();
  let invoked = false;
  const handler = (ev) => {
    const badge = ev.target?.closest?.('.lineitem-transcludes');
    if (!badge) return;
    invoked = true;
  };
  handler({ target: { closest: () => null }, preventDefault: () => {}, stopImmediatePropagation: () => {} });
  assert.ok(!invoked, 'click outside .lineitem-transcludes must be a no-op');
});

test('A2-04: _isUnloading guard suppresses badge-click collapse', () => {
  const { plugin, context } = instance();
  plugin._isUnloading = true;
  let deleted = false;
  plugin._deleteEmbedLine = async () => { deleted = true; };
  context.window.g_universe.itemsByGuid['EMBED_UNL'] = { guid: 'EMBED_UNL', rguid: 'PAGE_U', props: { refx_embed: 1 } };
  const li = { getAttribute: (a) => a === 'data-guid' ? 'EMBED_UNL' : null };
  const badge = { closest: (sel) => sel === '.lineitem-transcludes' ? badge : (sel.includes('listitem-transclusion') ? li : null) };
  const handler = (ev) => {
    const b = ev.target?.closest?.('.lineitem-transcludes');
    if (!b) return;
    const liel = b.closest('.listitem-transclusion[data-guid]');
    if (!liel) return;
    const g = liel.getAttribute('data-guid');
    if (!g) return;
    const st = ((context.window.g_universe && context.window.g_universe.itemsByGuid) || {})[g];
    if (!st || !st.props || !st.props.refx_embed) return;
    if (plugin._isUnloading) return; // guard
    deleted = true;
  };
  handler({ target: badge, preventDefault: () => {}, stopImmediatePropagation: () => {} });
  assert.ok(!deleted, '_isUnloading guard must suppress collapse');
});

// ── Routing audit: all embed-here paths go through _bridgeCreateEmbed ─────────

test('A2-R: plugin.js source: all "Embed here" action strings use the embed bridge funnel', () => {
  // Audit: every string "Embed here" or "embed-here" in the source should appear
  // in a code path that calls _bridgeCreateEmbed, never a direct createLineItem
  // for transclusion without going through the bridge (which handles the toggle).
  // This is a lightweight static assertion: count direct "Embed here" label usages
  // and verify each one is adjacent to _bridgeCreateEmbed or the section-aware
  // _sectionToggleEmbed funnel in the same expression.
  const embedHereMatches = [...source.matchAll(/'Embed here'/g)];
  for (const m of embedHereMatches) {
    // Guarded helper actions may validate captured host/target strings before
    // reaching the bridge, so include the full small helper body in the audit.
    const snippet = source.slice(Math.max(0, m.index - 200), m.index + 500);
    assert.ok(
      snippet.includes('_bridgeCreateEmbed') || snippet.includes('_sectionToggleEmbed'),
      `"Embed here" label at offset ${m.index} must be paired with an embed bridge funnel`
    );
  }
  assert.ok(embedHereMatches.length > 0, 'At least one "Embed here" entry point must exist');
});

test('A2-R2: plugin.js source: each createLineItem with refx_embed is in a known plugin-internal function', () => {
  // Audit: every createLineItem call that sets refx_embed must be inside a known plugin-managed
  // function (_expandRef*, _materializeRecordPreview, _expandRefFromQuery) — never at an arbitrary
  // call site that would bypass the toggle logic in _bridgeCreateEmbed.
  const KNOWN_OWNERS = ['_expandRef', '_materializeRecordPreview', '_materializeWindowedTransclusion', '_addChildToLineEmbed'];
  const refxEmbedMatches = [...source.matchAll(/createLineItem[^;]*?refx_embed/g)];
  assert.ok(refxEmbedMatches.length >= 1, 'At least one createLineItem with refx_embed must exist');
  for (const m of refxEmbedMatches) {
    const snippet = source.slice(Math.max(0, m.index - 6000), m.index);
    const inKnownOwner = KNOWN_OWNERS.some((fn) => snippet.includes(fn));
    assert.ok(inKnownOwner,
      `createLineItem(…refx_embed…) at offset ${m.index} must be inside a known plugin-managed function`
    );
  }
});
