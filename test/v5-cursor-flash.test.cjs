const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'plugin.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadPlugin() {
  const styles = new Map();
  const context = {
    AppPlugin: class {},
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => { throw new Error('same-microtask target restoration entered rAF'); },
    cancelAnimationFrame() {},
    performance: { now: () => Date.now() },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CSS: { escape: value => String(value) },
    navigator: { platform: 'MacIntel' },
    document: {
      getElementById: id => styles.get(id) || null,
      createElement: tag => ({ tagName: tag.toUpperCase(), id: '', textContent: '', isConnected: false }),
      head: { appendChild(node) { node.isConnected = true; styles.set(node.id, node); return node; } },
    },
    window: { CSS: { escape: value => String(value) }, g_universe: { itemsByGuid: {}, workspace: {} } },
  };
  context.globalThis = context;
  vm.runInNewContext(source + '\nthis.__RefxPlugin = Plugin;', context, { filename: sourcePath });
  return { Plugin: context.__RefxPlugin, context, styles };
}

function declarations(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing runtime rule for ${selector}`);
  return Object.fromEntries(match[1].split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
}

function declarationsAfter(css, marker) {
  const start = css.indexOf(marker);
  assert.notEqual(start, -1, `missing runtime rule containing ${marker}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  assert.ok(open > start && close > open, `incomplete runtime rule containing ${marker}`);
  return Object.fromEntries(css.slice(open + 1, close).split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
}

function inFlowWidth(rule) {
  if (rule.position === 'absolute' || rule.position === 'fixed') return 0;
  const px = value => /^-?\d+(?:\.\d+)?px(?:\s*!important)?$/.test(value || '') ? Number.parseFloat(value) : 0;
  return px(rule.width) + px(rule['padding-inline-start']) + px(rule['padding-inline-end'])
    + px(rule['padding-left']) + px(rule['padding-right'])
    + px(rule['margin-inline-start']) + px(rule['margin-inline-end'])
    + px(rule['margin-left']) + px(rule['margin-right']);
}

function measureWrappedTargetFixture(children, targetRule) {
  const usableWidth = 184;
  const textBoxes = [];
  let row = 0;
  let x = 0;
  let inlineBadgeAnchor = null;
  for (const child of children) {
    if (child.kind === 'badge') {
      inlineBadgeAnchor = { row, left: x, right: x + 24 };
      continue;
    }
    if (x && x + child.width > usableWidth) { row++; x = 0; }
    textBoxes.push({ id: child.id, row, left: x, right: x + child.width });
    x += child.width;
  }
  const lastRow = row;
  const badgeBox = inlineBadgeAnchor;
  const following = textBoxes.find(box => box.id === 'following-word');
  const obscuredFollowingPx = following && badgeBox.row === following.row
    ? Math.max(0, Math.min(badgeBox.right, following.right) - Math.max(badgeBox.left, following.left))
    : 0;
  return { visualRows: lastRow + 1, inlineBadgeAnchor, badgeBox, following, obscuredFollowingPx };
}

function trackedElement(metrics, options = {}) {
  const classes = new Set(options.classes || []);
  const attributes = new Map(Object.entries(options.attributes || {}));
  const data = { ...(options.dataset || {}) };
  const styleValues = { ...(options.style || {}) };
  const node = {
    nodeType: 1,
    isConnected: options.isConnected !== false,
    parentNode: null,
    parentElement: null,
    children: [],
    textContent: options.textContent || '',
    classList: {
      contains: name => classes.has(name),
      add(...names) { metrics.attributeWrites++; for (const name of names) classes.add(name); },
      remove(...names) { metrics.attributeWrites++; for (const name of names) classes.delete(name); },
      toggle(name, force) {
        metrics.attributeWrites++;
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    },
    getAttribute(name) {
      if (name === 'class') return [...classes].join(' ');
      return attributes.has(name) ? attributes.get(name) : null;
    },
    hasAttribute: name => attributes.has(name),
    setAttribute(name, value) {
      metrics.attributeWrites++;
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      metrics.attributeWrites++;
      attributes.delete(name);
    },
    style: {
      getPropertyValue: name => styleValues[name] || '',
      removeProperty(name) { metrics.attributeWrites++; delete styleValues[name]; },
    },
    appendChild(child) {
      if (child.parentNode) {
        const oldIndex = child.parentNode.children.indexOf(child);
        if (oldIndex >= 0) child.parentNode.children.splice(oldIndex, 1);
        metrics.childRemoves++;
      }
      child.parentNode = node;
      child.parentElement = node;
      child.isConnected = node.isConnected;
      node.children.push(child);
      metrics.childAdds++;
      return child;
    },
    append(...children) { for (const child of children) node.appendChild(child); },
    insertBefore(child, before) {
      node.appendChild(child);
      if (before) {
        const from = node.children.indexOf(child);
        const to = node.children.indexOf(before);
        if (from >= 0 && to >= 0) node.children.splice(to, 0, node.children.splice(from, 1)[0]);
      }
      return child;
    },
    remove() {
      if (!node.parentNode) return;
      const index = node.parentNode.children.indexOf(node);
      if (index >= 0) node.parentNode.children.splice(index, 1);
      node.parentNode = null;
      node.parentElement = null;
      node.isConnected = false;
      metrics.childRemoves++;
    },
    contains(other) {
      for (let cur = other; cur; cur = cur.parentElement) if (cur === node) return true;
      return false;
    },
    closest(selector) {
      const alternatives = selector.split(',').map(value => value.trim());
      for (let cur = node; cur; cur = cur.parentElement) {
        for (const alternative of alternatives) {
          const classMatch = alternative.match(/^\.([\w-]+)/);
          const needsGuid = alternative.includes('[data-guid]');
          if ((!classMatch || cur.classList.contains(classMatch[1]))
              && (!needsGuid || cur.hasAttribute('data-guid'))) return cur;
        }
      }
      return null;
    },
    querySelector(selector) {
      if (selector === '.lineitem-lineref') return null;
      return node.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const direct = selector.startsWith(':scope > ');
      const classMatch = selector.match(/\.([\w-]+)(?:\)|$)/);
      if (!classMatch) return [];
      const candidates = direct ? node.children : node.children.flatMap(function walk(child) {
        return [child, ...child.children.flatMap(walk)];
      });
      return candidates.filter(child => child.classList.contains(classMatch[1]));
    },
  };
  Object.defineProperty(node, 'dataset', {
    value: new Proxy(data, {
      set(target, key, value) { metrics.attributeWrites++; target[key] = String(value); return true; },
      deleteProperty(target, key) { metrics.attributeWrites++; delete target[key]; return true; },
    }),
  });
  Object.defineProperty(node, 'title', {
    get: () => attributes.get('title') || '',
    set(value) { metrics.attributeWrites++; attributes.set('title', String(value)); },
  });
  Object.defineProperty(node, 'lastElementChild', { get: () => node.children[node.children.length - 1] || null });
  Object.defineProperty(node, 'nextElementSibling', {
    get() {
      if (!node.parentNode) return null;
      const index = node.parentNode.children.indexOf(node);
      return index >= 0 ? node.parentNode.children[index + 1] || null : null;
    },
  });
  metrics.createdNodes++;
  return node;
}

test('V7 wrapped target fixture measures the old 24px obstruction and restores a last-row overlay for 20 segment renders', () => {
  const { Plugin, context, styles } = loadPlugin();
  const p = new Plugin();
  p._opacity = 0.72;
  p.injectCounterCss();
  const counterStyle = styles.get('trc-reference-counter-style');
  assert.ok(counterStyle, 'counter runtime stylesheet is installed');

  const rules = {
    nativeRefSlot: declarationsAfter(counterStyle.textContent, 'body.trc-zerolayout .line-div .lineitem-ref,'),
    nativeTargetHost: declarationsAfter(counterStyle.textContent, 'body.trc-zerolayout .line-div,\n      body.trc-zerolayout .line-check-div {'),
    nativeTargetEndSlot: declarationsAfter(counterStyle.textContent, 'body.trc-zerolayout .line-div::after,\n      body.trc-zerolayout .line-check-div::after {'),
    chainMarker: declarations(counterStyle.textContent, 'body.trc-zerolayout .lineitem-ref.refx-has-chain::after'),
    refCountWrap: declarations(counterStyle.textContent, '.trc-refcount-badge-wrap'),
    targetBadgeWrap: declarationsAfter(counterStyle.textContent, '\n      .trc-target-badge-wrap {'),
    checkOverlay: declarations(counterStyle.textContent, '.refx-chip-task.refx-check-overlay'),
    popoverActions: declarations(counterStyle.textContent, '.trc-ref-popover-actions'),
    siblingActions: declarations(counterStyle.textContent, '.refx-ref-sibling-actions'),
  };
  p._taskRefGuids = new Set(['1V5TASKTARGETABCDEFGHIJKLM']);
  p._flushTaskRefStyle();
  const taskStyle = styles.get(p._taskRefStyleId);
  assert.ok(taskStyle, 'task slot runtime stylesheet is installed for the mounted task target');
  rules.nativeTaskSlot = declarationsAfter(taskStyle.textContent, 'body.trc-zerolayout .line-div .lineitem-ref');
  const evidence = Object.fromEntries(Object.entries(rules).map(([name, rule]) => [name, {
    rest: inFlowWidth(rule), hover: inFlowWidth(rule), midTyping: inFlowWidth(rule),
  }]));
  assert.deepEqual(evidence, {
    nativeRefSlot: { rest: 36, hover: 36, midTyping: 36 },
    nativeTargetHost: { rest: 0, hover: 0, midTyping: 0 },
    nativeTargetEndSlot: { rest: 24, hover: 24, midTyping: 24 },
    chainMarker: { rest: 0, hover: 0, midTyping: 0 },
    refCountWrap: { rest: 0, hover: 0, midTyping: 0 },
    targetBadgeWrap: { rest: 0, hover: 0, midTyping: 0 },
    checkOverlay: { rest: 0, hover: 0, midTyping: 0 },
    popoverActions: { rest: 0, hover: 0, midTyping: 0 },
    siblingActions: { rest: 0, hover: 0, midTyping: 0 },
    nativeTaskSlot: { rest: 20, hover: 20, midTyping: 20 },
  }, 'native-selector reservations are constant while every optional RefX contributor is zero-width or out of flow');
  assert.equal(rules.popoverActions.position, 'absolute');
  assert.equal(rules.siblingActions.position, 'absolute');
  assert.equal(rules.popoverActions['pointer-events'], 'none');
  assert.equal(rules.siblingActions['pointer-events'], 'none');
  assert.equal(rules.popoverActions.top, '0');
  assert.equal(rules.siblingActions.top, '0');
  assert.equal(rules.popoverActions['overflow-x'], 'auto');
  assert.equal(rules.siblingActions['overflow-x'], 'auto');
  assert.equal(rules.targetBadgeWrap.position, 'absolute');
  assert.equal(rules.targetBadgeWrap.width, '0');
  assert.equal(rules.targetBadgeWrap['min-width'], '0');
  assert.equal(rules.nativeTargetHost.position, 'relative');
  assert.equal(rules.nativeTargetEndSlot.display, 'inline-block');
  assert.equal(rules.nativeTargetEndSlot.width, '24px');
  assert.equal(rules.nativeTaskSlot['padding-inline-start'], '20px!important');
  assert.doesNotMatch(taskStyle.textContent, /refx-ovl-host/, 'task reservation survives a line-div swap without a plugin-owned marker');
  assert.match(counterStyle.textContent,
    /\.trc-ref-popover-action \{[\s\S]*?pointer-events: auto;/,
    'only real buttons re-enable pointer input inside click-through action overlays');
  assert.match(rules.popoverActions.background, /sidebar-bg-hover/,
    'popover fade follows the actual hover-row token in light and dark themes');
  assert.match(rules.siblingActions.background, /color-mix\(in srgb, var\(--cards-bg, transparent\) 70%, transparent\)/,
    'sibling fade matches its color-mix list background in light and dark themes');
  assert.match(counterStyle.textContent,
    /\.flowythymer-thread-target \.trc-target-badge,[\s\S]*?\.flowythymer-thread-target \.refx-check-overlay::before,[\s\S]*?transition: none !important;/,
    'positively classified active-line badges and checkbox overlays suppress transition replay');

  const firstCounterCss = counterStyle.textContent;
  p.injectCounterCss();
  assert.equal(styles.get('trc-reference-counter-style'), counterStyle, 'counter CSS updates one adopted node via textContent');
  assert.equal(counterStyle.textContent, firstCounterCss);

  p._injectStyle();
  const appearanceStyle = styles.get(p._STYLE_ID);
  assert.ok(appearanceStyle, 'appearance runtime stylesheet is installed');
  assert.match(appearanceStyle.textContent,
    /body\.refx-links-distinct \.refx-pageref-chip,[\s\S]*?transition: none !important;/,
    'replacement reference chips are positively classified into the transition-suppressed paint path');
  p._injectStyle();
  assert.equal(styles.get(p._STYLE_ID), appearanceStyle, 'appearance CSS also updates one adopted node via textContent');

  const targetWrap = { id: 'cached-target-wrap', kind: 'badge', isConnected: true, parentNode: null };
  const host = {
    children: [],
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    appendChild(node) {
      const prior = this.children.indexOf(node);
      if (prior >= 0) this.children.splice(prior, 1);
      node.parentNode = this;
      node.isConnected = true;
      this.children.push(node);
      return node;
    },
  };
  const prefix = { id: 'prefix', kind: 'text', width: 136 };
  const followingWord = { id: 'following-word', kind: 'text', width: 24 };
  const continuation = { id: 'continuation', kind: 'text', width: 80 };
  host.children.push(prefix, targetWrap, followingWord, continuation);
  targetWrap.parentNode = host;
  const line = { textContent: 'wrapped target line with more text after the target badge' };
  p._editorLineEl = () => line;
  p.resolveTargetBadgeHost = value => value === line ? host : null;
  const entry = { node: targetWrap, lineGuid: '1V5REFXCOMBINEDABCDEFGHIJK' };

  const parentGeometry = measureWrappedTargetFixture(host.children, { ...rules.targetBadgeWrap, position: 'static' });
  assert.equal(parentGeometry.visualRows, 2, 'fixture reproduces a two-row wrapped target line');
  assert.equal(parentGeometry.inlineBadgeAnchor.row, 0, 'the stale segment badge lands on the first-row wrap boundary');
  assert.equal(parentGeometry.obscuredFollowingPx, 24,
    'measured parent behavior: the inline badge paint consumes the following 24px word slot');
  assert.equal(p._reinsertDecorator(entry, 'targetBadge', new Map()), true,
    'the connected stale badge is re-homed before the fixed geometry is measured');
  const fixedGeometry = measureWrappedTargetFixture(host.children, rules.targetBadgeWrap);
  assert.equal(fixedGeometry.badgeBox.row, 1, 'the fixed overlay anchors to the last visual row');
  assert.equal(fixedGeometry.obscuredFollowingPx, 0,
    'measured fixed behavior: no following-word pixels are covered or displaced');

  for (let i = 0; i < 20; i++) {
    const char = String.fromCharCode(97 + (i % 26));
    line.textContent += char;
    const lateSegment = { id: `late-${i}`, kind: 'text', width: 8 };
    host.appendChild(lateSegment); // Thymer's segment renderer landed content after the still-connected badge
    assert.notEqual(host.lastElementChild, targetWrap);
    assert.equal(p._reinsertDecorator(entry, 'targetBadge', new Map()), true,
      `keystroke ${i + 1}: connected target badge is re-homed synchronously`);
    assert.equal(host.lastElementChild, targetWrap,
      `keystroke ${i + 1}: badge finishes at the true DOM end after segment rendering`);
    assert.equal(entry.node, targetWrap, `keystroke ${i + 1}: decorator identity is retained`);
    assert.equal(targetWrap.parentNode, host);
    assert.equal(measureWrappedTargetFixture(host.children, rules.targetBadgeWrap).obscuredFollowingPx, 0,
      `keystroke ${i + 1}: re-home leaves wrapped following text unobscured`);
  }

  const brokenHost = { lastElementChild: null, appendChild() { throw new Error('fixture append failed'); } };
  p.resolveTargetBadgeHost = () => brokenHost;
  assert.equal(p._reinsertDecorator({ node: { isConnected: false }, lineGuid: entry.lineGuid }, 'targetBadge', new Map()), false);
  assert.match(context.window.__REFX_LAST_ERROR, /decorator reinsert targetBadge.*fixture append failed/,
    'target reinsert failures reach the plugin error global');
});

test('W2b 20-keystroke decorated-line burst performs zero unchanged attribute writes and reuses cached nodes', () => {
  const { Plugin } = loadPlugin();
  const p = new Plugin();
  const metrics = { attributeWrites: 0, childAdds: 0, childRemoves: 0, createdNodes: 0 };
  const targetGuid = '1W2BTARGETGUIDABCDEFGHIJKL';
  const lineGuid = '1W2BLINEGUIDABCDEFGHIJKLMN';
  const info = { count: 3, capped: false };
  const line = trackedElement(metrics, { classes: ['listitem'], attributes: { 'data-guid': lineGuid } });
  const host = trackedElement(metrics, { classes: ['line-div', 'refx-ovl-host'] });
  const chip = trackedElement(metrics, {
    classes: ['lineitem-ref', 'refx-pageref-chip', 'refx-has-chain', 'trc-ref-anchor'],
    attributes: { 'data-guid': targetGuid },
    dataset: { guid: targetGuid, refxChainDepth: '2', refxChainGuid: targetGuid },
  });
  const countLabel = trackedElement(metrics, { classes: ['trc-refcount-badge'], textContent: '3' });
  const countOverlay = trackedElement(metrics, {
    classes: ['trc-refcount-badge-wrap', 'refx-count-overlay', 'trc-size-small'],
    attributes: { title: '3 references to Target — click to view' },
    dataset: { guid: targetGuid },
  });
  countOverlay.appendChild(countLabel);
  const checkOverlay = trackedElement(metrics, {
    classes: ['refx-chip-task', 'refx-check-overlay'],
    attributes: { 'aria-checked': 'false', title: 'Task — click to mark done' },
    dataset: { guid: targetGuid, refxOrd: '0' },
  });
  const targetLabel = trackedElement(metrics, { classes: ['trc-target-badge'], textContent: '3' });
  const targetWrap = trackedElement(metrics, {
    classes: ['trc-target-badge-wrap', 'trc-size-small'],
    attributes: { title: '3 references to this line — click to expand' },
    dataset: { guid: lineGuid },
  });
  targetWrap.appendChild(targetLabel);
  line.appendChild(host);
  host.append(chip, countOverlay, checkOverlay, targetWrap);

  p._overlayMode = true;
  p._fontScaleClass = 'trc-size-small';
  p._hoverOnly = false;
  p._liveChipBadges = new Map();
  p._liveOverlayBadges = new Map([[p._decoKey(lineGuid, targetGuid, 0), {
    node: countOverlay, lineGuid, targetGuid, ordinal: 0,
  }]]);
  p._liveCheckOverlays = new Map([[p._decoKey(lineGuid, targetGuid, 0), {
    node: checkOverlay, lineGuid, targetGuid, ordinal: 0,
  }]]);
  p._liveTargetBadges = new Map([[lineGuid, { node: targetWrap, lineGuid }]]);
  p._referenceTargetKind = () => 'record';
  p._refChainCacheGet = () => [{ depth: 2 }];
  p._lineHasMeaningfulContent = () => true;
  p.resolveTargetBadgeHost = value => value === line ? host : null;
  p._editorLineEl = value => value === lineGuid ? line : null;
  p._chipOrdinal = () => 0;
  p._scheduleOverlayReposition = () => {};
  p.getOrLoadRecordName = () => 'Target';

  metrics.attributeWrites = 0;
  metrics.childAdds = 0;
  metrics.childRemoves = 0;
  metrics.createdNodes = 0;
  for (let i = 0; i < 20; i++) {
    line.textContent += String.fromCharCode(97 + i);
    p._tagReferenceChip(chip, targetGuid);
    p.upsertBadge(chip, targetGuid, info);
    p._syncOverlayBadge(line, chip, targetGuid, info, 0);
    p._syncCheckOverlay(line, chip, targetGuid, false, 0);
    assert.equal(p.upsertTargetBadge(line, lineGuid, info), targetWrap);
    p._paintChipTaskGlyph(checkOverlay, false);
    assert.equal(p._reinsertDecorator({ node: targetWrap, lineGuid }, 'targetBadge', new Map()), true);
  }

  assert.equal(metrics.attributeWrites, 0, 'unchanged chip, chain, badge, checkbox, host, title, and ARIA state write nothing');
  assert.equal(metrics.childRemoves, 0, 'the count overlay is not mistaken for a legacy sibling and reaped');
  assert.equal(metrics.childAdds, 0, 'unchanged decorators are not re-appended');
  assert.equal(metrics.createdNodes, 0, 'unchanged decorators are never recreated');
  assert.equal(p._liveOverlayBadges.get(p._decoKey(lineGuid, targetGuid, 0)).node, countOverlay);
  assert.equal(p._liveCheckOverlays.get(p._decoKey(lineGuid, targetGuid, 0)).node, checkOverlay);
  assert.equal(p._liveTargetBadges.get(lineGuid).node, targetWrap);

  let absentFrames = 0;
  metrics.attributeWrites = 0;
  metrics.childAdds = 0;
  metrics.childRemoves = 0;
  for (let i = 0; i < 20; i++) {
    countOverlay.remove(); // Thymer-owned line-host replacement detaches the cached decorator.
    p._reinsertLineOverlay(p._liveOverlayBadges.get(p._decoKey(lineGuid, targetGuid, 0)));
    if (!countOverlay.isConnected) absentFrames++;
  }
  assert.equal(absentFrames, 0, 'cached count overlay is present at every simulated paint boundary');
  assert.equal(metrics.createdNodes, 0, 'Thymer-owned detach/restore cycles reuse the cached node');
  assert.equal(metrics.attributeWrites, 0, 'cached restoration does not rewrite unchanged attributes');
  assert.equal(metrics.childRemoves, 20, 'fixture records one Thymer-owned detach per keystroke');
  assert.equal(metrics.childAdds, 20, 'plugin restores the same cached node once per Thymer detach');
});
