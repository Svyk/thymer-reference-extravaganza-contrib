const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

const LINE = '11YY1S2KA0DXXH61DT84TWFJTY';

function classListSet(initial = []) {
  const set = new Set(initial);
  return {
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

function matchSelector(node, selector) {
  const parts = String(selector || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts.some((p) => matchSelector(node, p));
  let rest = String(selector || '').trim();
  if (rest.startsWith(':scope > ')) rest = rest.slice(':scope > '.length);
  let tag = null;
  const mTag = /^([a-zA-Z][\w-]*)/.exec(rest);
  if (mTag && !rest.startsWith('.')) {
    tag = mTag[1].toUpperCase();
    rest = rest.slice(mTag[1].length);
  }
  if (tag && node.tagName !== tag) return false;
  const classes = [];
  rest = rest.replace(/\.([a-zA-Z0-9_-]+)/g, (_, c) => { classes.push(c); return ''; });
  const named = new Set(
    `${node.className || ''}`.split(/\s+/).filter(Boolean)
  );
  for (const c of classes) {
    if (!node.classList.contains(c) && !named.has(c)) return false;
  }
  const attrRe = /\[([^\]]+)\]/g;
  let attrMatch;
  while ((attrMatch = attrRe.exec(rest))) {
    const raw = attrMatch[1];
    const eq = raw.indexOf('=');
    const name = (eq === -1 ? raw : raw.slice(0, eq)).trim();
    const got = node.getAttribute(name);
    if (eq === -1) {
      if (!got) return false;
    } else if (got !== raw.slice(eq + 1).replace(/['"]/g, '').trim()) return false;
  }
  return true;
}

function el(tag, opts = {}) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: opts.className || '',
    classList: classListSet(String(opts.className || '').split(/\s+/).filter(Boolean)),
    children: [],
    childNodes: [],
    parentElement: null,
    parentNode: null,
    isConnected: true,
    offsetParent: {},
    dataset: Object.assign({}, opts.dataset || {}),
    style: {},
    attributes: Object.assign({}, opts.attrs || {}),
    _text: opts.text || '',
    get textContent() {
      if (node.children.length) return node.children.map((c) => c.textContent).join('');
      return node._text;
    },
    set textContent(v) { node._text = String(v); node.children = []; node.childNodes = []; },
    get lastElementChild() { return node.children[node.children.length - 1] || null; },
    getAttribute(name) {
      if (name === 'class') return node.className;
      if (name.startsWith('data-') && node.dataset[dataKey(name)]) return node.dataset[dataKey(name)];
      return node.attributes[name] || '';
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
      if (name === 'class') {
        node.className = String(value);
        node.classList = classListSet(String(value).split(/\s+/).filter(Boolean));
      }
      if (name.startsWith('data-')) node.dataset[dataKey(name)] = String(value);
    },
    appendChild(child) {
      if (child.parentNode?.children) {
        child.parentNode.children = child.parentNode.children.filter((c) => c !== child);
        child.parentNode.childNodes = child.parentNode.childNodes.filter((c) => c !== child);
      }
      child.parentElement = node;
      child.parentNode = node;
      node.children.push(child);
      node.childNodes.push(child);
      return child;
    },
    append(...nodes) { for (const n of nodes) node.appendChild(n); },
    remove() {
      const p = node.parentNode;
      if (!p) return;
      p.children = p.children.filter((c) => c !== node);
      p.childNodes = p.childNodes.filter((c) => c !== node);
      node.parentNode = null;
      node.parentElement = null;
    },
    contains(other) {
      if (other === node) return true;
      return node.children.some((c) => c.contains?.(other));
    },
    matches(selector) { return matchSelector(node, selector); },
    closest(selector) {
      let cur = node;
      while (cur) {
        if (matchSelector(cur, selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const scopeOnly = String(sel).startsWith(':scope > ');
      const inner = scopeOnly ? String(sel).slice(':scope > '.length) : sel;
      const walk = (n) => {
        for (const c of n.children) {
          if (matchSelector(c, inner) && (!scopeOnly || n === node)) out.push(c);
          if (!scopeOnly) walk(c);
        }
      };
      walk(node);
      return out;
    }
  };
  if (opts['data-guid']) {
    node.dataset.guid = opts['data-guid'];
    node.attributes['data-guid'] = opts['data-guid'];
  }
  return node;
}

function dataKey(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function loadPlugin() {
  const styles = new Map();
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
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      getElementById: (id) => styles.get(id) || null,
      createElement: (tag) => el(tag),
      querySelectorAll: () => [],
      querySelector: () => null,
      documentElement: { clientHeight: 900 },
      body: { classList: classListSet() },
      head: {
        appendChild(node) {
          node.isConnected = true;
          if (node.id) styles.set(node.id, node);
          return node;
        }
      }
    },
    Element: class {},
    window: {
      CSS: { escape: (s) => String(s) },
      g_universe: { itemsByGuid: {}, workspace: {} }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', context, { filename: 'plugin.js' });
  return { Plugin: context.PluginUnderTest, context, styles };
}

function counterPlugin() {
  const { Plugin, context, styles } = loadPlugin();
  const plugin = new Plugin();
  plugin._isUnloading = false;
  plugin._unloaded = false;
  plugin._enabled = true;
  plugin._targetLineBadges = true;
  plugin._minCount = 1;
  plugin._showZero = false;
  plugin._targetBadgeMaxLines = 300;
  plugin._excludeCollections = new Set();
  plugin._countCache = new Map();
  plugin._lineRefGuids = new Map();
  plugin._liveTargetBadges = new Map();
  plugin._fontScaleClass = 'trc-size-medium';
  plugin._hoverOnly = false;
  plugin._opacity = 0.55;
  plugin._runBackgroundWork = () => Promise.resolve(null);
  plugin._scheduleTargetBadgeAuthoritativeRefine = () => {};
  plugin._schedulePrefetch = () => {};
  plugin.removeOrphanTargetBadges = () => {};
  return { plugin, context, styles };
}

function sourceLine(pillText) {
  const line = el('div', { className: 'listitem listitem-ulist', 'data-guid': LINE });
  const host = el('div', { className: 'line-div' });
  const text = el('span', { className: 'lineitem-text', text: 'Watch Agents of S.H.I.E.L.D. S2' });
  const pill = el('line-button', { className: 'lineitem-backlink-pill', text: pillText });
  host.append(text, pill);
  line.append(host);
  return { line, host, pill, editor: el('div', { className: 'page-content' }) };
}

function panelState() {
  return { panelId: 'p1', scanSeq: 1, ignoreMutationsUntil: 0 };
}

test('hide-editing-counts must not hide the Roam-style target-line count on the focused line', () => {
  const { plugin, styles } = counterPlugin();
  plugin.injectCounterCss();
  const css = styles.get('trc-reference-counter-style').textContent;
  assert.match(css, /body\.refx-hide-native-pill line-button\.lineitem-backlink-pill/,
    'native pill hide remains the replacement contract');
  assert.doesNotMatch(css,
    /body\.refx-hide-editing-counts \.flowythymer-thread-target \.trc-target-badge-wrap/,
    'focused/caret line must keep a visible clickable 1, like Roam');
  assert.doesNotMatch(css,
    /body\.refx-hide-editing-counts \.listitem-with-caret \.trc-target-badge-wrap/,
    'caret line must not hide the replacement count');
  assert.match(css, /body\.trc-zerolayout \.listitem \{\s*position: relative;/,
    'full-width row is the containing block (native backlink-pill slot)');
  assert.match(css, /\.trc-target-badge-wrap \{[\s\S]*?inset-inline-end: 0;/,
    'count is pinned to the far inline end of the row, like Roam');
});

test('native backlink pill 1 paints a clickable target-line badge immediately', async () => {
  const { plugin, context } = counterPlugin();
  context.window.g_universe.itemsByGuid[LINE] = {
    guid: LINE, type: 'task', rguid: 'PAGE',
    text_segments: ['text', 'Watch Agents of S.H.I.E.L.D. S2']
  };
  const { line, host, editor } = sourceLine('1');
  editor.append(line);
  const origQS = editor.querySelectorAll.bind(editor);
  editor.querySelectorAll = (sel) => {
    if (sel === '.listitem[data-guid]') return [line];
    return origQS(sel);
  };
  const state = panelState();
  plugin._panelStates = new Map([['p1', state]]);

  await plugin.scanTargetLineBadges(editor, state, 1);

  const wrap = line.querySelector(':scope > .trc-target-badge-wrap');
  assert.ok(wrap, 'replacement wrap must exist after hiding the native pill');
  assert.equal(wrap.parentNode, line, 'count sits on the full-width listitem (native backlink-pill slot), not the shrink-wrapped line-div');
  assert.equal(wrap.dataset.guid, LINE);
  const label = wrap.querySelector(':scope > .trc-target-badge');
  assert.equal(label && label.textContent, '1');
  assert.equal(plugin._liveTargetBadges.get(LINE)?.node, wrap);
});

test('icon-only native pill still seeds a count of at least 1', () => {
  const { plugin, context } = counterPlugin();
  context.window.g_universe.itemsByGuid[LINE] = { guid: LINE, type: 'task', rguid: 'PAGE' };
  const { line } = sourceLine('');
  assert.equal(plugin._nativePillCount(line), 1);
});

test('authoritative cached zero does not remove a badge while the native pill still says 1', async () => {
  const { plugin, context } = counterPlugin();
  context.window.g_universe.itemsByGuid[LINE] = {
    guid: LINE, type: 'task', rguid: 'PAGE',
    text_segments: ['text', 'Watch Agents of S.H.I.E.L.D. S2']
  };
  plugin._countCache.set(LINE, { count: 0, capped: false, updatedAt: Date.now() });
  const { line, host, editor } = sourceLine('1');
  editor.append(line);
  const origQS = editor.querySelectorAll.bind(editor);
  editor.querySelectorAll = (sel) => {
    if (sel === '.listitem[data-guid]') return [line];
    return origQS(sel);
  };
  const state = panelState();
  plugin._panelStates = new Map([['p1', state]]);

  await plugin.scanTargetLineBadges(editor, state, 1);

  const wrap = line.querySelector(':scope > .trc-target-badge-wrap');
  assert.ok(wrap, 'native pill 1 is a floor; a stale zero cache must not blank the Roam 1');
  assert.equal(wrap.querySelector(':scope > .trc-target-badge').textContent, '1');
});

test('clicking the target-line badge toggles inline linked references', () => {
  const { plugin } = counterPlugin();
  const { line, host } = sourceLine('1');
  const wrap = el('span', { className: 'trc-target-badge-wrap', dataset: { guid: LINE } });
  const label = el('span', { className: 'trc-target-badge', text: '1' });
  wrap.append(label);
  host.append(wrap);
  let toggled = null;
  plugin._toggleInlineRefs = async (state, node) => { toggled = node; };
  plugin._clickAction = 'inline';
  plugin._hasEmbedOpen = () => false;
  const ev = { altKey: false, shiftKey: false, preventDefault() {}, stopImmediatePropagation() {} };
  plugin._routeBadgeClick(ev, panelState(), wrap);
  assert.equal(toggled, wrap);
  assert.equal(wrap.closest('.listitem[data-guid]'), line);
});
