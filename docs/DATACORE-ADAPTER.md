# Datacore Adapter — Reference Surface v1 Integration

**Revision:** R1 (v3.81.0)
**Contract ref:** `docs/reference-surface-v1.md`

## Purpose

Datacore is a query/view engine that needs to know which records _link to_ a given target (the "in-edges" concept from Roam's `q:` pull). The Reference Surface v1 broker provides this via `broker.inEdges(targetGuid)` — a pure-index O(1) lookup backed by the `byTarget` Map that the broker maintains.

This document describes the seam: what Datacore calls, what the broker returns, and what guarantees hold across hydration states.

---

## API seam

### `broker.inEdges(targetGuid)`

```js
const broker = window.__thymerReferenceSurfaceV1;
if (!broker) return []; // not yet ready

const edges = broker.inEdges(targetGuid);
```

**Return type:** `Edge[]` (same shape as items returned by `broker.edges()`)

**Guarantees:**
- Always returns a plain JS Array (never null/undefined).
- Returns an empty array if `targetGuid` is unknown or if the broker is not yet fully hydrated (status `unavailable` or `partial`).
- Edges are NOT sorted — callers should sort if order matters. Use `broker.snapshot().status` to know if results are complete.
- Each edge has `edge.target.guid === targetGuid` (for `ref` kind) or `edge.target.guid === null` (for `external-link`, never appears here).
- Thread-safe for synchronous reads (the broker's index is only mutated on the event loop).

**Edge shape:** see `docs/reference-surface-v1.md §3 Edge Shape`.

### `broker.snapshot()`

Use this to understand hydration completeness before trusting `inEdges` results:

```js
const snap = broker.snapshot();
if (snap.status === 'complete') {
  // All edges indexed. inEdges results are authoritative.
} else if (snap.status === 'partial') {
  // Hydration in progress. inEdges results cover already-indexed records.
  // Subscribe to be notified when revision bumps.
} else if (snap.status === 'unavailable') {
  // Broker not yet hydrated. Return empty / show loading state.
}
```

### `broker.subscribe(listener)`

React to incremental revision bumps (new edges from events, or hydration progress):

```js
const unsub = broker.subscribe((snap) => {
  // snap.revision bumped → re-query inEdges for your targets
  const edges = broker.inEdges(myTargetGuid);
  renderBacklinks(edges);
});
// Later:
unsub(); // idempotent
```

The listener receives the current snapshot synchronously on first call (replay), then on every subsequent revision increment.

---

## Datacore-side wiring pattern

In Datacore's `deps.inEdges` / `fillLinks` path:

```js
function fillLinks(targetGuid) {
  const broker = window.__thymerReferenceSurfaceV1;
  if (!broker) return [];
  return broker.inEdges(targetGuid);
}
```

For reactive re-rendering (when Datacore needs to re-run a query when references change):

```js
// In Datacore's plugin onLoad / init:
const broker = window.__thymerReferenceSurfaceV1;
if (broker) {
  _brokerUnsub = broker.subscribe(() => {
    datacore._invalidateLinksCache();
  });
}

// Also listen for the broker becoming available after Datacore loads:
document.addEventListener('thymer:reference-surface-v1-ready', () => {
  if (_brokerUnsub) _brokerUnsub();
  const broker = window.__thymerReferenceSurfaceV1;
  if (broker) {
    _brokerUnsub = broker.subscribe(() => {
      datacore._invalidateLinksCache();
    });
  }
});
```

---

## Edge families surfaced by inEdges

`inEdges(guid)` returns edges of all families where `target.guid === guid`:

| Family | Description | authored | derived |
|---|---|---|---|
| `ref` | Explicit `((guid))` or `[[page]]` line segment | `true` | `false` |
| `ref` (linkobj-resolved) | GUID-bearing linkobj that positively resolved | `true` | `false` |
| `property` | Property field whose value is this record/line | `false` | `true` |
| `annotation` | `lineRefProperties`-configured property pointing to this line | `false` | `true` |
| `claim` | Attributes claim (authored or derived) pointing to this record | `true` or `false` | varies |

`external-link` edges (`target.guid === null`) never appear in `inEdges` results — they carry no backlink target.

---

## Hydration timing

The broker is initialized synchronously from `_initReferenceSurfaceBroker()` (called in plugin `onLoad`), but full index hydration runs asynchronously via chunked `getAllCollections()` → `getAllRecords()` → `getLineItems()`. Hydration yields every ~8ms to avoid blocking the UI.

Expected states:

| Time | Status | inEdges results |
|---|---|---|
| Immediately after `thymer:reference-surface-v1-ready` event | `partial` or `complete` | May be partial (0 edges if workspace is large) |
| During hydration | `partial` | Grows revision on each chunk |
| After hydration | `complete` | Fully authoritative |

For Datacore views that show "N backlinks" badges: render with the partial count and update on each `subscribe` callback — the transition from partial→complete is seamless with incremental revision bumps.

---

## Generation / invalidation

The `broker.generation` string changes only when `_killStaleObservers()` is called (plugin hot-reload). A new generation means the entire index is fresh — all prior `inEdges` results from the old generation are stale and must be discarded. The `subscribe` listener already handles this: the old broker's subscribers are notified with a final revision bump (if any), and the new broker dispatches `thymer:reference-surface-v1-ready` with the new generation.

Datacore does not need to track generation explicitly; subscribing to the new broker instance (via the `thymer:reference-surface-v1-ready` document event) is sufficient.

---

## Anti-patterns

**Do not call `getRecord()` per edge in a Datacore render pass.** All necessary provenance (source record guid, collection guid, workspace guid, authored/derived) is carried inside the edge object. No extra SDK calls needed.

**Do not full-scan `edgeById`.** Only use `broker.inEdges(targetGuid)` for target lookups. It is backed by `byTarget: Map<targetGuid, Set<edgeId>>` — O(1) per target, O(k) for k matching edges.

**Do not hold references to edge objects across revision bumps.** Edges are replaced (not mutated) on update; holding a stale edge object after a `lineitem.updated` event may show outdated `updatedAt` or `sourceHash`.


---

## Canonical edge-kind names (R7 / Datacore alignment)

All three consumers (Reference Extravaganza, Backreferences, Reference Graph) and Datacore share this canonical edge-kind vocabulary:

| `kind` value | Meaning |
|---|---|
| `ref` | Internal reference chip (`type:"ref"` segment) |
| `external-link` | External URL linkobj (no GUID) |
| `property` | Record relation property edge |
| `annotation` | Line-GUID stored in a record property |
| `claim` | Attributes Engine authored/derived claim |

Use these exact strings in Datacore queries, filters, and display logic. Do not introduce aliases or abbreviations.

---

## FilterExpressionV1 (R7 — additive v1.1, `apiVersion` stays 1)

The broker now accepts a `filterExpr` parameter on `edges()` and `occurrences()` alongside the existing flat `filter` (unchanged, zero breakage). Check capability with `broker.supportsFilterExpr === true` before using `filterExpr`.

### Shape

```js
// Leaf node: any valid FilterV1 object
{ _filterVersion: 1, kinds: ['claim', 'ref'], targetGuid: null, ... }

// AND node: all operands must match
{ op: 'AND', operands: [ FilterV1 | FilterExpressionV1, ... ] }

// OR node: at least one operand must match
{ op: 'OR', operands: [ FilterV1 | FilterExpressionV1, ... ] }
```

### Deterministic serialization

`_normalizeFilterExprV1(expr)` produces a canonical JSON string with sorted operands (for determinism) and sorted keys. Two expressions are equal when their canonical strings are byte-identical. Cursors bind to the canonical expression string — a `filterExpr` change invalidates cursors from prior expressions.

### Usage in Datacore

```js
const broker = window.__thymerReferenceSurfaceV1;
if (broker && broker.supportsFilterExpr) {
  // Find all authored claims pointing at recordGuid OR all refs from collection colGuid.
  const expr = {
    op: 'OR',
    operands: [
      { _filterVersion: 1, kinds: ['claim'], authored: true, targetGuid: recordGuid, sourceRecord: null, collectionGuid: null, dateRange: null },
      { _filterVersion: 1, kinds: ['ref'], targetGuid: recordGuid, sourceRecord: null, collectionGuid: colGuid, authored: null, dateRange: null },
    ],
  };
  const page = broker.edges({ filterExpr: expr, limit: 50 });
  // page.items: edges matching either predicate
}
```

When `filterExpr` is present and `filter` is also provided, `filterExpr` is used for row evaluation while `filter.targetGuid` / `filter.sourceRecord` still drive O(1) index lookups. Pass a compatible `filter` when you want the index benefit for one dimension even under a complex `filterExpr`.

---

## Record aliases (A3)

RefX owns the alias data and exposes the same synchronous read surface through both the Reference Surface broker and the plugin bridge:

```js
const aliases = window.__refx?.aliases;

// Exact and fuzzy resolution. Ambiguity is preserved: one row per record/alias.
const hits = aliases?.resolve('EMP26') || [];
// [{ recordGuid, alias: {text, normalized, source, ...}, exact, score }, ...]

// One record's frozen AliasSetV1, or null.
const set = aliases?.get(recordGuid);

// Verified, serialized RefX-owned write. Never write the property/registry directly.
const result = await aliases?.add(recordGuid, 'EMP 26');
```

The broker equivalent is `window.__thymerReferenceSurfaceV1.aliases`; check `supportsAliases === true` before using it. Broker reads are synchronous and introduce no SDK awaits. The bridge additionally exposes `add`, `remove`, and `rename`, all routed through RefX's per-record write queue and verification path.

Datacore should keep the returned `recordGuid` as identity and use the alias only as presentation text. `resolve()` intentionally returns every collision; do not silently pick the first record. For reactive views, subscribe through `aliases.subscribe(callback)` and reread affected GUIDs from the callback envelope.

### Datacore and Omni contract (A6)

- The native schema label is exactly `Aliases`. When provisioned, it is a multi-value text property, so a Datacore property predicate such as **Aliases contains X** can query the collection-owned values directly.
- Some collections cannot adopt that schema. RefX then keeps the same alias vocabulary in its synced fallback registry. A property-only Datacore query does not see those fallback values; use `aliases.resolve(text)` when the query must cover the complete RefX vocabulary.
- Omni/search integrations should merge canonical-title hits with `aliases.resolve(text)` hits and keep `recordGuid` as identity. Every collision remains a separate result row; never select the first hit implicitly.
- Reads (`get`, `all`, `resolve`) are synchronous and suitable for query evaluation. Writes must go through the RefX bridge (`add`, `remove`, `rename`) so serialization, verification, property/registry fallback, and broker revision publication remain intact.
- Reference Graph consumes the same `aliases.all()` vocabulary for collision and title-shadowing diagnostics, so query/search and health surfaces agree on what an alias means.
