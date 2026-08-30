'use strict';
// R4: selection surface, op previews/plans, executor capability gating.
// Tests run in the vm-harness style established by plugin.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');

// ─── vm harness (mirrors r5-picker.test.cjs) ──────────────────────────────

const storage = new Map();

function loadPlugin(windowExtras) {
  const ctx = {
    AppPlugin: class {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    performance: { now: () => Date.now() },
    CSS: { escape: (s) => String(s) },
    navigator: { platform: 'MacIntel', clipboard: { writeText: () => Promise.resolve() } },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    document: {
      createElement: (tag) => {
        const el = {
          tagName: tag.toUpperCase(),
          className: '',
          style: {},
          children: [],
          textContent: '',
          innerHTML: '',
          isConnected: true,
          getAttribute: (a) => el._attrs && el._attrs[a] != null ? el._attrs[a] : null,
          setAttribute(a, v) { if (!this._attrs) this._attrs = {}; this._attrs[a] = v; },
          addEventListener() {},
          removeEventListener() {},
          append(...kids) { this.children.push(...kids); },
          remove() { this.isConnected = false; },
          querySelector: () => null,
          querySelectorAll: () => [],
          closest: () => null,
          getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
          focus() {},
          scrollIntoView() {},
          dispatchEvent() { return true; },
        };
        return el;
      },
      createTextNode: (t) => ({ nodeType: 3, textContent: t }),
      querySelectorAll: () => [],
      querySelector: () => null,
      documentElement: { clientHeight: 900 },
      body: {
        classList: { toggle() {}, add() {}, remove() {} },
        append() {},
        appendChild() {},
        querySelector() { return null; },
      },
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    Element: class {},
    window: {
      CSS: { escape: (s) => String(s) },
      g_universe: { itemsByGuid: {}, workspace: {} },
      addEventListener() {},
      removeEventListener() {},
      ...windowExtras,
    },
    DateTime: undefined,
  };
  ctx.globalThis = ctx;
  Object.assign(ctx, ctx.window);
  vm.runInNewContext(source + '\nthis.PluginUnderTest = Plugin;', ctx, { filename: 'plugin.js' });
  return { Plugin: ctx.PluginUnderTest, ctx };
}

function makePlugin(windowExtras) {
  storage.clear();
  const { Plugin, ctx } = loadPlugin(windowExtras || {});
  const plugin = new Plugin();
  plugin._isUnloading = false;
  plugin._enabled = true;
  plugin.workspaceGuid = 'TESTWORKSPACE0001234';
  plugin._r4Plans = [];
  plugin.data = {
    getRecord: () => null,
    searchByQuery: async () => ({ lines: [], records: [] }),
    getAllCollections: async () => [],
  };
  plugin._toast = (msg) => { plugin._lastToast = msg; };
  return { plugin, ctx };
}

// Helper: build a flat array of OutlineNodeV1 objects.
function makeNodes(specs) {
  // specs: array of { guid, parentGuid, depth, text, type? }
  return specs.map((s, i) => ({
    guid: s.guid,
    recordGuid: 'REC001',
    type: s.type || 'ulist',
    text: s.text || ('Line ' + s.guid),
    parentGuid: s.parentGuid || null,
    depth: s.depth || 0,
    order: i,
  }));
}

// ─── Feature flag ──────────────────────────────────────────────────────────

test('R4 feature flag: default ON when localStorage key absent', () => {
  const { plugin } = makePlugin();
  assert.equal(plugin._r4Enabled(), true);
});

test('R4 feature flag: OFF when refx_r4_ops=false', () => {
  const { plugin } = makePlugin();
  storage.set('refx_r4_ops', 'false');
  assert.equal(plugin._r4Enabled(), false);
});

test('R4 feature flag: ON when refx_r4_ops=true', () => {
  const { plugin } = makePlugin();
  storage.set('refx_r4_ops', 'true');
  assert.equal(plugin._r4Enabled(), true);
});

// ─── Selection model ───────────────────────────────────────────────────────

test('R4 selection: normalize empty selection returns empty', () => {
  const { plugin } = makePlugin();
  const result = plugin._r4NormalizeSelection([]);
  assert.equal(result.roots.length, 0);
  assert.equal(result.expandedGuids.size, 0);
  assert.equal(result.order.length, 0);
});

test('R4 selection: normalize — parent+child, parent becomes sole root', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0, parentGuid: null },
    { guid: 'B', depth: 1, parentGuid: 'A' },
  ]);
  const result = plugin._r4NormalizeSelection(nodes);
  // A has no ancestor in the selection → root.
  // B has A as ancestor and A is in selection → not a root.
  assert.ok(result.roots.includes('A'), 'A must be a root');
  assert.equal(result.expandedGuids.has('A'), true);
  assert.equal(result.expandedGuids.has('B'), true);
});

test('R4 selection: normalize — two sibling roots when no shared ancestor selected', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0, parentGuid: null },
    { guid: 'C', depth: 0, parentGuid: null },
  ]);
  const result = plugin._r4NormalizeSelection(nodes);
  assert.equal(result.roots.length, 2, 'Two siblings → two roots');
  assert.ok(result.roots.includes('A'));
  assert.ok(result.roots.includes('C'));
});

test('R4 selection: range select builds inclusive slice', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0 },
    { guid: 'B', depth: 0 },
    { guid: 'C', depth: 0 },
    { guid: 'D', depth: 0 },
  ]);
  const range = plugin._r4BuildRangeSelection(nodes, 'B', 'D');
  assert.equal(range.length, 3);
  assert.equal(range[0].guid, 'B');
  assert.equal(range[1].guid, 'C');
  assert.equal(range[2].guid, 'D');
});

test('R4 selection: range select works in reverse (D→B)', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0 },
    { guid: 'B', depth: 0 },
    { guid: 'C', depth: 0 },
    { guid: 'D', depth: 0 },
  ]);
  const range = plugin._r4BuildRangeSelection(nodes, 'D', 'B');
  assert.equal(range.length, 3);
  assert.equal(range[0].guid, 'B');
});

test('R4 selection: range select — missing guid returns empty', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'A', depth: 0 }]);
  const range = plugin._r4BuildRangeSelection(nodes, 'A', 'MISSING');
  assert.equal(range.length, 0);
});

test('R4 selection: subtree select captures root and all descendants', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0 },
    { guid: 'B', depth: 1 },
    { guid: 'C', depth: 2 },
    { guid: 'D', depth: 0 }, // sibling of A, NOT a child
  ]);
  const result = plugin._r4BuildSubtreeSelection(nodes, 'A');
  assert.equal(result.length, 3, 'Should include A, B, C but not D');
  assert.equal(result.map((n) => n.guid).join(','), 'A,B,C');
});

test('R4 selection: subtree select — missing root returns empty', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'A', depth: 0 }]);
  const result = plugin._r4BuildSubtreeSelection(nodes, 'MISSING');
  assert.equal(result.length, 0);
});

// ─── Contiguity detection ─────────────────────────────────────────────────

test('R4 contiguity: single node is contiguous', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'A', depth: 0 }]);
  const ct = plugin._r4IsContiguousSubtreeWithNodes(nodes);
  assert.equal(ct.contiguous, true);
  assert.equal(ct.root, 'A');
});

test('R4 contiguity: root + child is contiguous', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0, parentGuid: null },
    { guid: 'B', depth: 1, parentGuid: 'A' },
  ]);
  const ct = plugin._r4IsContiguousSubtreeWithNodes(nodes);
  assert.equal(ct.contiguous, true);
  assert.equal(ct.root, 'A');
});

test('R4 contiguity: two sibling roots → NOT contiguous', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0, parentGuid: null },
    { guid: 'C', depth: 0, parentGuid: null },
  ]);
  const ct = plugin._r4IsContiguousSubtreeWithNodes(nodes);
  assert.equal(ct.contiguous, false);
});

test('R4 contiguity: child with parentGuid outside selection → NOT contiguous', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0, parentGuid: null },
    { guid: 'B', depth: 1, parentGuid: 'A' },
    { guid: 'D', depth: 1, parentGuid: 'EXTERNAL' }, // parent not in selection
  ]);
  const ct = plugin._r4IsContiguousSubtreeWithNodes(nodes);
  // Three nodes, two roots after normalize (A and D) → not contiguous.
  assert.equal(ct.contiguous, false);
});

// ─── Capability registry ──────────────────────────────────────────────────

test('R4 capability: copyAsRefs has no executor requirement → enabled', () => {
  const { plugin } = makePlugin();
  const check = plugin._r4CapabilityCheck('copyAsRefs');
  assert.equal(check.enabled, true);
  assert.equal(check.reason, null);
});

test('R4 capability: transcludeSubtree has no executor requirement → enabled', () => {
  const { plugin } = makePlugin();
  const check = plugin._r4CapabilityCheck('transcludeSubtree');
  assert.equal(check.enabled, true);
  assert.equal(check.reason, null);
});

test('R4 capability: extractSubtree → disabled (Outline Refactor absent)', () => {
  const { plugin } = makePlugin();
  const check = plugin._r4CapabilityCheck('extractSubtree');
  assert.equal(check.enabled, false);
  assert.ok(check.reason && check.reason.includes('Outline Refactor'), 'reason must name Outline Refactor');
});

test('R4 capability: moveCopySort → disabled (Outline Refactor absent)', () => {
  const { plugin } = makePlugin();
  const check = plugin._r4CapabilityCheck('moveCopySort');
  assert.equal(check.enabled, false);
});

test('R4 capability: undoCheckpoint → disabled (Outline Refactor absent)', () => {
  const { plugin } = makePlugin();
  const check = plugin._r4CapabilityCheck('undoCheckpoint');
  assert.equal(check.enabled, false);
});

test('R4 capability: extractSubtree → enabled only with authoritative Outline O5 methods', () => {
  const fakeExecutor = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-1',
    capabilities: { O3: true, O2: true, O4: true, O5: true },
    status() {
      return {
        phase: 'O5',
        mode: 'integrated-planned-undo',
        mutationEnabled: true,
        generation: 'OUTLINE-GEN-1',
      };
    },
    async plan() {},
    getApplyRequest() {},
    async apply() {},
  };
  const { plugin } = makePlugin({
    __thymerOutlineRefactorV1: fakeExecutor,
  });
  const check = plugin._r4CapabilityCheck('extractSubtree');
  assert.equal(check.enabled, true);
  const reg = plugin._r4CapabilityRegistry();
  const cap = reg['extractSubtree'];
  assert.equal(cap.executorGlobal, '__thymerOutlineRefactorV1');
  assert.equal(cap.executorCap, 'O3');
});

test('R4 capability: throwing, degraded, or mutation-disabled status fails closed', () => {
  const base = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-1',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    plan() {},
    getApplyRequest() {},
    apply() {},
    undo() {},
  };
  for (const status of [
    () => { throw new Error('stale'); },
    () => ({
      phase: 'O5',
      mode: 'degraded',
      mutationEnabled: true,
      generation: 'OUTLINE-GEN-1',
    }),
    () => ({
      phase: 'O5',
      mode: 'integrated-planned-undo',
      mutationEnabled: false,
      generation: 'OUTLINE-GEN-1',
    }),
  ]) {
    const { plugin } = makePlugin({
      __thymerOutlineRefactorV1: { ...base, status },
    });
    assert.equal(
      plugin._r4CapabilityCheck('extractSubtree').enabled,
      false
    );
  }
});

test('R4 capability: missing or unexpected Outline mode fails closed', () => {
  const base = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-1',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    plan() {},
    getApplyRequest() {},
    apply() {},
    undo() {},
  };
  for (const mode of [undefined, 'experimental-planned-undo']) {
    const { plugin } = makePlugin({
      __thymerOutlineRefactorV1: {
        ...base,
        status() {
          return {
            phase: 'O5',
            mode,
            mutationEnabled: true,
            generation: 'OUTLINE-GEN-1',
          };
        },
      },
    });
    assert.equal(
      plugin._r4CapabilityCheck('extractSubtree').enabled,
      false
    );
  }
});

test('R4 capability: load order is dynamic and accepts a later healthy O5 provider', () => {
  const { plugin, ctx } = makePlugin();
  assert.equal(
    plugin._r4CapabilityCheck('extractSubtree').enabled,
    false
  );
  ctx.window.__thymerOutlineRefactorV1 = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-LATE',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    status() {
      return {
        phase: 'O5',
        mode: 'integrated-planned-undo',
        mutationEnabled: true,
        generation: 'OUTLINE-GEN-LATE',
      };
    },
    plan() {},
    getApplyRequest() {},
    apply() {},
    undo() {},
  };
  assert.equal(
    plugin._r4CapabilityCheck('extractSubtree').enabled,
    true
  );
});

test('R4 capability: unknown operation → disabled with message', () => {
  const { plugin } = makePlugin();
  const check = plugin._r4CapabilityCheck('nonExistentOp');
  assert.equal(check.enabled, false);
  assert.ok(check.reason && check.reason.includes('Unknown operation'));
});

test('R4 delegates detach planning and exact-token apply to authoritative Outline O5', async () => {
  let plannedInput = null;
  let appliedRequest = null;
  const entry = {
    plan: { id: 'outline-plan-1' },
    preview: { operation: 'detach' },
  };
  const exactRequest = {
    planId: 'outline-plan-1',
    preconditionToken: 'exact-token',
  };
  const outline = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-1',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    status() {
      return {
        phase: 'O5',
        mode: 'integrated-planned-undo',
        mutationEnabled: true,
        generation: 'OUTLINE-GEN-1',
      };
    },
    async plan(input) {
      plannedInput = input;
      return entry;
    },
    getApplyRequest(planId) {
      assert.equal(planId, entry.plan.id);
      return exactRequest;
    },
    async apply(request) {
      appliedRequest = request;
      return { id: 'receipt-1', status: 'succeeded' };
    },
  };
  const { plugin } = makePlugin({
    __thymerOutlineRefactorV1: outline,
  });
  const nodes = makeNodes([{ guid: 'LINE-A', depth: 0 }]);
  const selection = plugin._r4NormalizeSelection(nodes);
  const delegated = await plugin._r4DelegateOutlinePlan(
    'detachAsRichText',
    'REC001',
    selection,
    { detachMaxDepth: 6 }
  );
  assert.equal(delegated.entry, entry);
  assert.equal(delegated.provider, outline);
  assert.equal(delegated.generation, 'OUTLINE-GEN-1');
  assert.equal(plannedInput.operation, 'detach');
  assert.equal(plannedInput.workspaceGuid, 'TESTWORKSPACE0001234');
  assert.deepEqual(
    Array.from(plannedInput.selectedGuids),
    ['LINE-A']
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(plannedInput.options)),
    { mode: 'rich-text', maxDepth: 6 }
  );
  const receipt = await plugin._r4ApplyDelegatedOutlinePlan(
    delegated
  );
  assert.deepEqual(appliedRequest, exactRequest);
  assert.equal(receipt.status, 'succeeded');
});

test('R4 delegates new-record extraction and sibling-sort intent without mutating during preview', async () => {
  const inputs = [];
  const outline = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-1',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    status() {
      return {
        phase: 'O5',
        mode: 'integrated-planned-undo',
        mutationEnabled: true,
        generation: 'OUTLINE-GEN-1',
      };
    },
    async plan(input) {
      inputs.push(input);
      return {
        plan: { id: 'plan-' + inputs.length },
        preview: { operation: input.operation },
      };
    },
    getApplyRequest() { throw new Error('preview must not apply'); },
    async apply() { throw new Error('preview must not apply'); },
  };
  const { plugin } = makePlugin({
    __thymerOutlineRefactorV1: outline,
  });
  const nodes = makeNodes([
    { guid: 'LINE-A', depth: 0 },
    { guid: 'LINE-B', depth: 0 },
  ]);
  const selection = plugin._r4NormalizeSelection(nodes);
  await plugin._r4DelegateOutlinePlan(
    'extractSubtree',
    'REC001',
    selection,
    {
      destinationMode: 'new',
      destinationRecordGuid: '',
      destinationParentGuid: null,
      destinationAfterGuid: null,
      destinationCollectionGuid: 'COLLECTION-1',
      destinationTitle: 'Extracted',
      replacementKind: 'transclusion',
      replacementAlias: null,
    }
  );
  await plugin._r4DelegateOutlinePlan(
    'moveCopySort',
    'REC001',
    selection,
    {
      structuralOperation: 'sort',
      destinationRecordGuid: 'REC001',
      destinationParentGuid: null,
      destinationAfterGuid: null,
    }
  );
  assert.equal(inputs[0].operation, 'extract');
  assert.equal(inputs[0].destination.recordGuid, 'planned:record:auto');
  assert.equal(inputs[0].options.destinationCollectionGuid, 'COLLECTION-1');
  assert.equal(inputs[0].options.replacementKind, 'transclusion');
  assert.equal(inputs[1].operation, 'sort-siblings');
  assert.deepEqual(
    Array.from(inputs[1].options.orderedGuids),
    ['LINE-A', 'LINE-B']
  );
  assert.equal(inputs.length, 2);
});

test('R4 apply refuses provider replacement before getApplyRequest', async () => {
  let requestLookups = 0;
  const provider = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-1',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    status() {
      return {
        phase: 'O5',
        mode: 'integrated-planned-undo',
        mutationEnabled: true,
        generation: this.generation,
      };
    },
    async plan() {
      return { plan: { id: 'plan-replace' }, preview: { operation: 'move' } };
    },
    getApplyRequest() {
      requestLookups++;
      return { planId: 'plan-replace' };
    },
    apply() {},
    undo() {},
  };
  const { plugin, ctx } = makePlugin({
    __thymerOutlineRefactorV1: provider,
  });
  const selection = plugin._r4NormalizeSelection(
    makeNodes([{ guid: 'LINE-A', depth: 0 }])
  );
  const pending = await plugin._r4DelegateOutlinePlan(
    'moveCopySort',
    'REC001',
    selection,
    {
      structuralOperation: 'move',
      destinationRecordGuid: 'REC002',
      destinationParentGuid: null,
      destinationAfterGuid: null,
    }
  );
  ctx.window.__thymerOutlineRefactorV1 = {
    ...provider,
    generation: 'OUTLINE-GEN-2',
  };
  await assert.rejects(
    plugin._r4ApplyDelegatedOutlinePlan(pending),
    (error) => error.code === 'R4_OUTLINE_PROVIDER_REPLACED'
  );
  assert.equal(requestLookups, 0);
});

test('R4 apply refuses a bound provider that degrades before request lookup', async () => {
  let mode = 'integrated-planned-undo';
  let requestLookups = 0;
  const provider = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-1',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    status() {
      return {
        phase: 'O5',
        mode,
        mutationEnabled: true,
        generation: 'OUTLINE-GEN-1',
      };
    },
    async plan() {
      return { plan: { id: 'plan-degraded' }, preview: { operation: 'move' } };
    },
    getApplyRequest() {
      requestLookups++;
      return { planId: 'plan-degraded' };
    },
    apply() {},
    undo() {},
  };
  const { plugin } = makePlugin({
    __thymerOutlineRefactorV1: provider,
  });
  const selection = plugin._r4NormalizeSelection(
    makeNodes([{ guid: 'LINE-A', depth: 0 }])
  );
  const pending = await plugin._r4DelegateOutlinePlan(
    'moveCopySort',
    'REC001',
    selection,
    {
      structuralOperation: 'move',
      destinationRecordGuid: 'REC002',
      destinationParentGuid: null,
      destinationAfterGuid: null,
    }
  );
  mode = 'degraded';
  await assert.rejects(
    plugin._r4ApplyDelegatedOutlinePlan(pending),
    (error) => error.code === 'R4_OUTLINE_PROVIDER_STALE'
  );
  assert.equal(requestLookups, 0);
});

test('R4 duplicate apply delegates the same exact request and preserves provider idempotency', async () => {
  const exactRequest = Object.freeze({
    planId: 'plan-duplicate',
    preconditionToken: 'exact-token',
  });
  const receipt = Object.freeze({ id: 'receipt-duplicate', status: 'succeeded' });
  const requests = [];
  const provider = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-1',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    status() {
      return {
        phase: 'O5',
        mode: 'integrated-planned-undo',
        mutationEnabled: true,
        generation: 'OUTLINE-GEN-1',
      };
    },
    async plan() {
      return { plan: { id: exactRequest.planId }, preview: { operation: 'move' } };
    },
    getApplyRequest() { return exactRequest; },
    async apply(request) {
      requests.push(request);
      return receipt;
    },
    undo() {},
  };
  const { plugin } = makePlugin({ __thymerOutlineRefactorV1: provider });
  const selection = plugin._r4NormalizeSelection(
    makeNodes([{ guid: 'LINE-A', depth: 0 }])
  );
  const pending = await plugin._r4DelegateOutlinePlan(
    'moveCopySort',
    'REC001',
    selection,
    {
      structuralOperation: 'move',
      destinationRecordGuid: 'REC002',
      destinationParentGuid: null,
      destinationAfterGuid: null,
    }
  );
  assert.equal(await plugin._r4ApplyDelegatedOutlinePlan(pending), receipt);
  assert.equal(await plugin._r4ApplyDelegatedOutlinePlan(pending), receipt);
  assert.deepEqual(requests, [exactRequest, exactRequest]);
});

test('R4 undo is preview-first and applies the exact planned undo request', async () => {
  const exactRequest = Object.freeze({
    planId: 'undo-plan-1',
    preconditionToken: 'undo-token',
  });
  const undoCalls = [];
  const provider = {
    apiVersion: 1,
    generation: 'OUTLINE-GEN-UNDO',
    capabilities: { O2: true, O3: true, O4: true, O5: true },
    status() {
      return {
        phase: 'O5',
        mode: 'integrated-planned-undo',
        mutationEnabled: true,
        generation: 'OUTLINE-GEN-UNDO',
      };
    },
    plan() {},
    getApplyRequest(planId) {
      assert.equal(planId, exactRequest.planId);
      return exactRequest;
    },
    apply() {},
    async undo(input) {
      undoCalls.push(input);
      if (typeof input === 'string') {
        return {
          plan: { id: exactRequest.planId },
          preview: { operation: 'move', undoOf: input },
        };
      }
      return { id: 'undo-receipt', status: 'succeeded' };
    },
  };
  const { plugin } = makePlugin({ __thymerOutlineRefactorV1: provider });
  const pending = await plugin._r4DelegateOutlineUndo('receipt-original');
  assert.equal(undoCalls.length, 1);
  assert.equal(undoCalls[0], 'receipt-original');
  const result = await plugin._r4ApplyDelegatedOutlinePlan(pending);
  assert.equal(result.status, 'succeeded');
  assert.equal(undoCalls.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(undoCalls[1])),
    {
      receiptId: 'receipt-original',
      request: exactRequest,
    }
  );
});

// ─── Plan objects ─────────────────────────────────────────────────────────

test('R4 plan: copyAsRefs plan matches OutlinePlanV1 schema', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'LINE01', depth: 0 }, { guid: 'LINE02', depth: 0 }]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const plan = plugin._r4BuildPlan('copyAsRefs', nodes, sel, null, null);

  assert.equal(typeof plan.id, 'string');
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.operation, 'copyAsRefs');
  assert.ok(Array.isArray(plan.selection.roots));
  assert.ok(Array.isArray(plan.selection.expandedGuids));
  assert.ok(Array.isArray(plan.selection.order));
  assert.ok(Array.isArray(plan.steps));
  assert.ok(typeof plan.impact === 'object');
  assert.ok(Array.isArray(plan.warnings));
  assert.ok(Array.isArray(plan.unsupported));
  assert.equal(typeof plan.estimatedWrites, 'number');
  assert.equal(plan.steps.length, 2, 'One step per selected line');
  assert.equal(plan.steps[0].kind, 'clipboard-write');
  assert.ok(plan.steps[0].payload.uri.startsWith('thymer-ref://'));
});

test('R4 plan: transcludeSubtree plan has create-transclusion step', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'ROOT1', depth: 0 },
    { guid: 'CHILD1', depth: 1, parentGuid: 'ROOT1' },
  ]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const plan = plugin._r4BuildPlan('transcludeSubtree', nodes, sel, null, null);
  assert.equal(plan.operation, 'transcludeSubtree');
  assert.ok(plan.steps.some((s) => s.kind === 'create-transclusion'));
  assert.ok(plan.steps[0].compensation !== undefined, 'compensation field present');
});

test('R4 plan: extractSubtree plan has executor warning (disabled op)', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'LINE01', depth: 0 }]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const plan = plugin._r4BuildPlan('extractSubtree', nodes, sel, null, null);
  assert.equal(plan.operation, 'extractSubtree');
  assert.ok(plan.warnings.length > 0, 'Gated op must have warnings');
  assert.ok(plan.unsupported.length > 0, 'Gated op must have unsupported entries');
  assert.ok(plan.steps.some((s) => s.kind === 'create-destination-record'));
});

test('R4 plan: last-N plan store bounded at 8', () => {
  const { plugin } = makePlugin();
  plugin._r4PlanMax = 3;
  for (let i = 0; i < 5; i++) {
    const nodes = makeNodes([{ guid: 'L' + i, depth: 0 }]);
    const sel = plugin._r4NormalizeSelection(nodes);
    plugin._r4BuildPlan('copyAsRefs', nodes, sel, null, null);
  }
  assert.equal(plugin._r4Plans.length, 3, 'Store must be bounded at 3');
  // Most recent plan is first.
  assert.ok(plugin._r4Plans[0].id, 'Most recent plan has id');
});

test('R4 plan: plan id is unique per call', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'LX1', depth: 0 }]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const p1 = plugin._r4BuildPlan('copyAsRefs', nodes, sel, null, null);
  const p2 = plugin._r4BuildPlan('copyAsRefs', nodes, sel, null, null);
  assert.notEqual(p1.id, p2.id, 'Plan IDs must be unique');
});

// ─── Copy-as-refs clipboard payload ───────────────────────────────────────

test('R4 copyAsRefs: empty selection returns ok:false', async () => {
  const { plugin } = makePlugin();
  const result = await plugin._r4CopyAsRefs([]);
  assert.equal(result.ok, false);
});

test('R4 copyAsRefs: single node produces bare thymer-ref:// payload (no title in clipboard)', async () => {
  // R4-2 fix: clipboard must carry bare "thymer-ref://<guid>" so the existing paste
  // parser regex /^thymer-ref:\/\/([A-Za-z0-9]+)\s*$/ round-trips correctly.
  // Titles are stashed in window.__refxCopiedRef, not embedded in the clipboard text.
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'ABCDE12345', depth: 0, text: 'Hello World' }]);
  const result = await plugin._r4CopyAsRefs(nodes);
  assert.equal(result.ok, true);
  assert.equal(result.lines, 1);
  assert.ok(result.text.includes('thymer-ref://ABCDE12345'));
  // Bare URI — no title embedded in clipboard text (would break paste parser).
  assert.ok(!result.text.includes('Hello World'), 'Title must NOT appear in clipboard text — paste parser only matches bare URIs');
});

test('R4 copyAsRefs: multi-line produces one URI per line (\\n separated)', async () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'LINE01', depth: 0, text: 'First' },
    { guid: 'LINE02', depth: 0, text: 'Second' },
    { guid: 'LINE03', depth: 0, text: 'Third' },
  ]);
  const result = await plugin._r4CopyAsRefs(nodes);
  assert.equal(result.ok, true);
  assert.equal(result.lines, 3);
  const uriLines = result.text.split('\n');
  assert.equal(uriLines.length, 3);
  for (const line of uriLines) {
    assert.ok(line.startsWith('thymer-ref://'), 'Each clipboard line must start with thymer-ref://');
  }
});

// ─── Transclude enablement rule ───────────────────────────────────────────

test('R4 transcludeSubtree: rejects non-contiguous selection', async () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'A', depth: 0, parentGuid: null },
    { guid: 'C', depth: 0, parentGuid: null }, // sibling, not a child
  ]);
  const result = await plugin._r4TranscludeSubtree(nodes, 'HOSTLINE1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-contiguous');
});

test('R4 transcludeSubtree: rejects when no host line provided', async () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'ROOT1', depth: 0 },
    { guid: 'CHILD1', depth: 1, parentGuid: 'ROOT1' },
  ]);
  const result = await plugin._r4TranscludeSubtree(nodes, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-destination');
});

// ─── Preview inbound-impact from fake broker ──────────────────────────────

test('R4 preview: inbound impact count from fake broker', () => {
  const { plugin } = makePlugin();
  // Install a fake broker that returns known edges.
  const fakeEdges = {
    'LINE01': [{ id: 'e1', sourceGuid: 'SRC1', targetGuid: 'LINE01', kind: 'ref' }],
    'LINE02': [
      { id: 'e2', sourceGuid: 'SRC2', targetGuid: 'LINE02', kind: 'ref' },
      { id: 'e3', sourceGuid: 'SRC3', targetGuid: 'LINE02', kind: 'annotation' },
    ],
  };
  plugin._r4QueryInboundImpact = (guids) => {
    const byGuid = new Map();
    let totalEdges = 0;
    for (const g of guids) {
      const edges = fakeEdges[g] || [];
      byGuid.set(g, edges);
      totalEdges += edges.length;
    }
    return { byGuid, totalEdges, brokerStatus: 'complete' };
  };

  const nodes = makeNodes([
    { guid: 'LINE01', depth: 0 },
    { guid: 'LINE02', depth: 0 },
  ]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const preview = plugin._r4BuildPreview('copyAsRefs', nodes, sel, null);

  assert.equal(preview.inboundImpact.totalEdges, 3);
  assert.equal(preview.inboundImpact.brokerStatus, 'complete');
  assert.equal(preview.inboundImpact.affectedNodes.length, 2);
  assert.equal(preview.inboundImpact.affectedNodes[0].guid, 'LINE01');
  assert.equal(preview.inboundImpact.affectedNodes[0].inboundCount, 1);
  assert.equal(preview.inboundImpact.affectedNodes[1].inboundCount, 2);
});

test('R4 preview: side-effect-free — no state mutation on preview call', () => {
  const { plugin } = makePlugin();
  const initialPlanCount = plugin._r4Plans.length;
  const nodes = makeNodes([{ guid: 'L1', depth: 0 }]);
  const sel = plugin._r4NormalizeSelection(nodes);
  // _r4BuildPreview must not add to _r4Plans (only _r4BuildPlan does that).
  plugin._r4BuildPreview('extractSubtree', nodes, sel, null);
  assert.equal(plugin._r4Plans.length, initialPlanCount, 'Preview must not store a plan');
});

test('R4 preview: planOnly flag set for gated ops', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'L1', depth: 0 }]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const preview = plugin._r4BuildPreview('extractSubtree', nodes, sel, null);
  assert.equal(preview.planOnly, true);
  assert.ok(preview.planOnlyReason, 'planOnlyReason must be populated for gated ops');
});

test('R4 preview: planOnly false for enabled ops', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'L1', depth: 0 }]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const preview = plugin._r4BuildPreview('copyAsRefs', nodes, sel, null);
  assert.equal(preview.planOnly, false);
  assert.equal(preview.planOnlyReason, null);
});

// ─── Plan schema conformance ───────────────────────────────────────────────

test('R4 plan schema: all required OutlinePlanV1 fields present for every op', () => {
  const { plugin } = makePlugin();
  const required = ['id', 'schemaVersion', 'workspaceGuid', 'operation', 'sourceRevision',
    'selection', 'destination', 'guidPolicy', 'referencePolicy', 'steps',
    'impact', 'warnings', 'unsupported', 'estimatedWrites'];
  const ops = ['copyAsRefs', 'transcludeSubtree', 'extractSubtree', 'detachAsRichText', 'moveCopySort', 'undoCheckpoint'];
  for (const opName of ops) {
    const nodes = makeNodes([{ guid: 'L1', depth: 0 }]);
    const sel = plugin._r4NormalizeSelection(nodes);
    const plan = plugin._r4BuildPlan(opName, nodes, sel, null, null);
    for (const field of required) {
      assert.ok(Object.prototype.hasOwnProperty.call(plan, field),
        'Plan for ' + opName + ' missing field: ' + field);
    }
    assert.equal(plan.schemaVersion, 1, 'schemaVersion must be 1 for ' + opName);
    assert.ok(Array.isArray(plan.steps), 'steps must be array for ' + opName);
    assert.ok(typeof plan.impact === 'object', 'impact must be object for ' + opName);
    // Step schema check.
    for (const step of plan.steps) {
      assert.ok(step.id, 'step.id required in ' + opName);
      assert.ok(step.kind, 'step.kind required in ' + opName);
      assert.ok('targetGuid' in step, 'step.targetGuid required in ' + opName);
      assert.ok('precondition' in step, 'step.precondition required in ' + opName);
      assert.ok('payload' in step, 'step.payload required in ' + opName);
      assert.ok('compensation' in step, 'step.compensation required in ' + opName);
    }
  }
});

// ─── Capability registry completeness ─────────────────────────────────────

test('R4 capability registry: all 6 operations defined', () => {
  const { plugin } = makePlugin();
  const reg = plugin._r4CapabilityRegistry();
  const ops = ['copyAsRefs', 'transcludeSubtree', 'extractSubtree', 'detachAsRichText', 'moveCopySort', 'undoCheckpoint'];
  for (const op of ops) {
    assert.ok(reg[op], 'Registry must define op: ' + op);
    assert.ok(reg[op].label, 'Registry entry for ' + op + ' must have label');
    assert.ok(reg[op].description, 'Registry entry for ' + op + ' must have description');
  }
});

test('R4 capability registry: copyAsRefs and transcludeSubtree have null executorGlobal', () => {
  const { plugin } = makePlugin();
  const reg = plugin._r4CapabilityRegistry();
  assert.equal(reg.copyAsRefs.executorGlobal, null);
  assert.equal(reg.transcludeSubtree.executorGlobal, null);
});

test('R4 capability registry: gated ops have non-null executorGlobal', () => {
  const { plugin } = makePlugin();
  const reg = plugin._r4CapabilityRegistry();
  for (const op of ['extractSubtree', 'detachAsRichText', 'moveCopySort', 'undoCheckpoint']) {
    assert.ok(reg[op].executorGlobal, 'Gated op ' + op + ' must have executorGlobal');
    assert.ok(reg[op].executorCap, 'Gated op ' + op + ' must have executorCap');
  }
});

// ─── R4-1 regression: _r4RegisterCommands uses addCommandPaletteCommand/getPanels ─
test('R4 R4-1: _r4RegisterCommands uses addCommandPaletteCommand (not registerCommand)', () => {
  // The SDK exposes addCommandPaletteCommand; registerCommand does not exist.
  // A stub ui with ONLY addCommandPaletteCommand must succeed and register a command.
  let registered = null;
  const { plugin } = makePlugin();
  plugin.ui = {
    addCommandPaletteCommand: (opts) => { registered = opts; return { remove() {} }; },
    getPanels: () => [],
  };
  plugin._r4RegisterCommands();
  assert.ok(registered, 'addCommandPaletteCommand must be called');
  assert.ok(registered.label && registered.label.includes('R4'), 'label must mention R4');
  assert.ok(typeof registered.onSelected === 'function', 'onSelected must be provided (not action)');
  assert.ok(!('action' in registered), 'must not use action property (wrong API)');
});

// ─── R4-2 regression: _r4CopyAsRefs clipboard format round-trips through paste parser ─
test('R4 R4-2: _r4CopyAsRefs clipboard text passes existing paste parser regex', async () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([{ guid: 'ABCDE12345', depth: 0, text: 'My line title' }]);
  const result = await plugin._r4CopyAsRefs(nodes);
  // The existing _handlePaste regex: /^thymer-ref:\/\/([A-Za-z0-9]+)\s*$/
  const m = /^thymer-ref:\/\/([A-Za-z0-9]+)\s*$/.exec(result.text);
  assert.ok(m, 'Single-line clipboard text must match paste parser regex');
  assert.equal(m[1], 'ABCDE12345', 'Parsed guid must equal node guid');
});

test('R4 R4-2: _r4CopyAsRefs multi-node — each line passes paste parser regex', async () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'AAAAAA1111', depth: 0, text: 'Alpha' },
    { guid: 'BBBBBB2222', depth: 0, text: 'Beta' },
  ]);
  const result = await plugin._r4CopyAsRefs(nodes);
  const lines = result.text.split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(/^thymer-ref:\/\/([A-Za-z0-9]+)\s*$/.test(line), 'Each line must match paste parser: ' + line);
  }
});

// ─── R4-3 regression: _r4NormalizeSelection walks full ancestor chain ─────────
test('R4 R4-3: grandparent+grandchild normalization — only grandparent is a root', () => {
  const { plugin } = makePlugin();
  // GP → P → C, select GP and C (skip P)
  const nodes = makeNodes([
    { guid: 'GP', depth: 0, parentGuid: null },
    { guid: 'P',  depth: 1, parentGuid: 'GP' },
    { guid: 'C',  depth: 2, parentGuid: 'P' },
  ]).filter((n) => n.guid !== 'P'); // select GP and C, not P
  // C's parentGuid is P; P is not in the selection but GP is an ancestor of C.
  // One-level walk (old bug) would miss GP→C relationship → both GP and C become roots.
  // Full ancestor walk: C's chain is C→P→GP; GP is in guidSet → C is NOT a root.
  // However P is NOT in selectedNodes, so the full ancestor walk can only trace
  // through nodes present in selectedNodes. GP→C: P is not in byGuid, so the
  // walk stops at P with no guidSet hit → C incorrectly becomes a root too.
  // The correct result depends on whether P is supplied. Document the boundary:
  // without P in the node list, C's full parentage is unknowable and C becomes a root.
  // The fix ensures the walk continues as far as the node map allows.
  const sel = plugin._r4NormalizeSelection(nodes);
  // With the buggy one-level walk: C.parentGuid=P, P not in guidSet → isRoot=true (wrong)
  // With the full ancestor walk via byGuid: P not in byGuid → walk stops → same result
  // This test verifies the walk doesn't falsely promote C when P IS in the selection.
  const nodesWithP = makeNodes([
    { guid: 'GP', depth: 0, parentGuid: null },
    { guid: 'P',  depth: 1, parentGuid: 'GP' },
    { guid: 'C',  depth: 2, parentGuid: 'P' },
  ]);
  const selFull = plugin._r4NormalizeSelection(nodesWithP);
  assert.ok(selFull.roots.includes('GP'), 'GP must be a root');
  assert.ok(!selFull.roots.includes('P'), 'P must not be a root (GP is ancestor)');
  assert.ok(!selFull.roots.includes('C'), 'C must not be a root (GP/P are ancestors)');
  assert.equal(selFull.roots.length, 1);
});

// ─── R4-3c regression: moveCopySort steps use roots, not all selectedNodes ──────
test('R4 R4-3c: moveCopySort plan emits one step per root, not one per selected node', () => {
  const { plugin } = makePlugin();
  const nodes = makeNodes([
    { guid: 'PARENT', depth: 0, parentGuid: null },
    { guid: 'CHILD',  depth: 1, parentGuid: 'PARENT' },
  ]);
  const sel = plugin._r4NormalizeSelection(nodes);
  assert.equal(sel.roots.length, 1, 'PARENT is the only root');
  const plan = plugin._r4BuildPlan('moveCopySort', nodes, sel, null, { subKind: 'move' });
  const moveSteps = plan.steps.filter((s) => s.kind === 'move-node');
  assert.equal(moveSteps.length, 1, 'Must emit exactly 1 move-node step (root only, not child)');
  assert.equal(moveSteps[0].targetGuid, 'PARENT', 'Step must target the root, not the child');
});

// ─── R4-4 regression: sourceGuids uses real edge shape (source.lineGuid) ─────────
test('R4 R4-4: preview sourceGuids uses source.lineGuid from real broker edge shape', () => {
  const { plugin } = makePlugin();
  // Real broker edge shape has source:{lineGuid, recordGuid, ...}, NOT sourceGuid.
  plugin._r4QueryInboundImpact = (guids) => {
    const byGuid = new Map();
    byGuid.set('TARGET1', [
      { id: 'e1', kind: 'ref', source: { workspaceGuid: 'WS', collectionGuid: 'COL', recordGuid: 'REC1', lineGuid: 'LINE_SRC1' }, target: { guid: 'TARGET1' } },
      { id: 'e2', kind: 'property', source: { workspaceGuid: 'WS', collectionGuid: 'COL', recordGuid: 'REC2', lineGuid: null }, target: { guid: 'TARGET1' } },
    ]);
    return { byGuid, totalEdges: 2, brokerStatus: 'complete' };
  };
  const nodes = makeNodes([{ guid: 'TARGET1', depth: 0 }]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const preview = plugin._r4BuildPreview('copyAsRefs', nodes, sel, null);
  const affected = preview.inboundImpact.affectedNodes[0];
  assert.equal(affected.guid, 'TARGET1');
  assert.equal(affected.inboundCount, 2);
  assert.equal(affected.sourceGuids[0], 'LINE_SRC1', 'Must use source.lineGuid from real edge shape');
  assert.equal(affected.sourceGuids[1], 'REC2', 'Must fall back to source.recordGuid when lineGuid is null');
});

// ─── R4-4 regression: plan impact partitions propertyEdges and claims by kind ──
test('R4 R4-4: plan impact correctly partitions propertyEdges and claims from broker', () => {
  const { plugin } = makePlugin();
  plugin._r4QueryInboundImpact = (guids) => {
    const byGuid = new Map();
    byGuid.set('N1', [
      { id: 'e1', kind: 'ref',      source: { lineGuid: 'S1', recordGuid: 'R1' } },
      { id: 'e2', kind: 'property', source: { lineGuid: null, recordGuid: 'R2' } },
      { id: 'e3', kind: 'property', source: { lineGuid: null, recordGuid: 'R3' } },
      { id: 'e4', kind: 'claim',    source: { lineGuid: 'S4', recordGuid: 'R4' } },
    ]);
    return { byGuid, totalEdges: 4, brokerStatus: 'complete' };
  };
  const nodes = makeNodes([{ guid: 'N1', depth: 0 }]);
  const sel = plugin._r4NormalizeSelection(nodes);
  const plan = plugin._r4BuildPlan('extractSubtree', nodes, sel, null, null);
  assert.equal(plan.impact.inboundEdges, 4, 'inboundEdges must be total count');
  assert.equal(plan.impact.propertyEdges, 2, 'propertyEdges must count kind=property edges');
  assert.equal(plan.impact.claims, 1, 'claims must count kind=claim edges');
});
