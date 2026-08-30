# Reference Surface v1 — Frozen Contract

Version: 1  
Owner: Reference Extravaganza (RefX)  
Global: `window.__thymerReferenceSurfaceV1`  
Ready event: `thymer:reference-surface-v1-ready` (dispatched once after global is set and initial snapshot ready)

Do not change field names, edge kinds, filter grammar version, cursor semantics, or status values without a version bump and a migration notice.

---

## Broker interface

```js
{
  apiVersion: 1,
  capabilities: { targetedDeltas: 1 }, // additive feature detection
  generation: string,        // load-generation token; changes on hot reload / full rebuild
  revision: number,          // monotonic within a generation; advances per delta

  subscribe(listener: (envelope: Envelope) => void): () => void,
  // Synchronously replays current envelope to new subscriber.
  // Returns idempotent unsubscribe fn.

  snapshot(): { generation, revision, status, diagnostics },

  edges(params: EdgeQuery): EdgePage,
  occurrences(params: OccurrenceQuery): OccurrencePage,

  resolveTarget(guid: string): ResolvedTarget | null
}
```

### Envelope

```js
{
  generation: string,
  revision: number,
  snapshot: Snapshot,
  delta: {
    scope: "targeted" | "all",
    metadataOnly: boolean,
    affectedTargetGuids: readonly string[],
    sourceLineGuids: readonly string[]
  }
}
// Frozen. Delivered once per revision to all subscribers.
```

Consumers that feature-detect `capabilities.targetedDeltas === 1` may invalidate
only the listed targets. `metadataOnly` means reference membership is unchanged;
`updatedAt` or other edge metadata changed, so date/cursor consumers should
refresh while backlink membership views may skip repainting. Older consumers
may continue treating every envelope as generation-wide.

### Snapshot

```js
{
  generation: string,
  revision: number,
  status: "complete" | "partial" | "degraded" | "unavailable",
  complete: boolean,
  diagnostics: DiagnosticEntry[]
}
```

### Status semantics

| Value | Meaning |
|---|---|
| `complete` | Authoritative hydration finished; all edge families resolved; no known gaps |
| `partial` | Hydration in progress or one edge family capped; results are a subset of truth |
| `degraded` | Broker present but claims broker or one index missing; results exclude that family |
| `unavailable` | Broker not initialized or fatal error; no edges served |

A consumer that renders any result MUST check `status` and show an indicator when not `complete`.

### EdgeQuery / OccurrenceQuery

```js
{
  filter:   FilterV1,                     // versioned, serializable — see Filter grammar
  limit:    number,                       // default 50; max 250; must be positive
  after:    string | null,                // opaque cursor; null = first page
  generation: string,                     // must match broker generation
  revision:   number                      // must match queryRevision from prior page
}
```

### EdgePage / OccurrencePage

```js
{
  items:         ReferenceEdge[] | ReferenceOccurrence[],
  error:         null | "stale-cursor" | "unavailable",
  complete:      boolean,      // true = this page ends the authoritative set
  cursor:        string | null,  // opaque; null when complete
  knownTotal:    number | null,  // null when unknown; set when complete or count-indexed
  capReason:     null | string,  // populated when partial due to a cap
  queryRevision: number          // revision at which this page was computed
}
```

**Cursor semantics** — an opaque string binding generation + queryRevision + normalized filter + sort + last stable ordering key. Stale cursor: any mismatch with the current generation or queryRevision returns `{items:[], error:"stale-cursor", complete:false, cursor:null}`. No numeric-offset resume against a changed snapshot. A `stale-cursor` result signals the caller to restart pagination from `after:null`.

**`complete: true`** means the authoritative set is exhausted, not merely that a local cap was reached. When `status` is `partial` at the snapshot level, page-level `complete` MAY be true for individual filter scopes that are known fully indexed, but `capReason` MUST be populated if the page cap was reached before the authoritative set.

---

## ReferenceEdge

```js
{
  id:            string,           // deterministic — see Identity rules
  kind:          EdgeKind,         // "ref" | "external-link" | "property" | "annotation" | "claim"
  source: {
    workspaceGuid:   string,
    collectionGuid:  string | null,
    recordGuid:      string,
    lineGuid:        string | null,
    propertyId:      string | null,   // property field ID for kind="property"
    segmentOrdinal:  number | null    // left-to-right position in SDK segments array; null for property/claim
  },
  target: {
    kind:   "record" | "line" | "collection" | "external" | "unknown",
    guid:   string | null,   // populated when kind is record/line/collection
    link:   string | null    // populated when kind is external (external-link only)
  },
  title:      string | null,    // authored alias/title — see per-kind notes below
  authored:   boolean,          // true for directly stored claims/refs
  derived:    boolean,          // true for inverse/symmetric expansions (claims only)
  sourceHash: string,           // hash of the source line/property text at snapshot time
  updatedAt:  number | null,    // epoch ms; null when unavailable from SDK
  provenance: object | null     // kind-specific; see provenance fields below
}
```

### ResolvedTarget

```js
{
  guid:           string,
  kind:           "record" | "line" | "collection" | "unknown",
  recordGuid:     string | null,   // owning record when kind="line"
  name:           string | null,
  collectionGuid: string | null
}
```

---

## Edge kinds

### `ref` — internal reference chip

A segment of type `"ref"` in a line's `segments` array.

**SDK source**: `PluginLineItem.segments` (types.d.ts:2592) — `{type:"ref", text:{guid:string, viewId?:string, title?:string}}`.

**Runtime segment shapes in `g_universe.text_segments` (pair-encoded)** — three live-proven forms (refx/plugin.js:14127-14128, engine.src.js:2019):

| Shape | Interpretation |
|---|---|
| `data` is a bare string | `data` is the target GUID directly |
| `data` is `{guid:string}` | `data.guid` is the target GUID |
| `data` is `{text:{guid:string}}` | `data.text.guid` is the target GUID |

`viewId` and `title` fields are stored alongside `guid` and are preserved as `provenance.viewId` / `title` field on the edge.

**Identity**: `"ref:v1:" + sourceLineGuid + ":" + segmentOrdinal + ":" + targetGuid`  
`segmentOrdinal` is the left-to-right index in the **unpacked** `segments` array (not the pair index; pair index = `segmentOrdinal * 2`).

**Completeness**: `_lineRefGuids` in RefX (refx/plugin.js:9433) is built only for observed DOM spans — it is NOT a workspace-wide index and does NOT establish `complete`. Authoritative source is `searchByQuery('@linkto="<guid>"', maxResults)`. Capped at `_maxResults` (default 250, refx/plugin.js:9571); when capped, edge page carries `capReason: "searchByQuery cap"` and `complete: false`.

**Invalidation**: `lineitem.updated`, `lineitem.created`, `lineitem.deleted`, `lineitem.moved` events on the source line (SDK types.d.ts:862). Event payload `hasSegments()` indicates whether segments changed.

**`title`**: `seg.text.title` if present; else null. Represents the authored alias.

**`target.kind`**: resolved via `_referenceTargetKind` (refx/plugin.js:19974) — five sequential O(1) checks: `_recordExistsCache`, `_recordNameIndex`, `_targetKindCache`, `window.g_universe.itemsByGuid`, `_lineOwnerHints`. Remains `"unknown"` until positively resolved; never guessed from GUID shape.

**`extractRefGuidsFromSegments`** (refx/plugin.js:22057) accepts only `type==="ref"` and NOT `"linkobj"`. Gap: outbound `linkobj` guids are missed by this specific extractor. The pair-encoded scanner (refx/plugin.js:14120) and `_registryInboundCountMap` (refx/plugin.js:19184) correctly handle both.

---

### `external-link` — documented SDK linkobj (external URL)

A segment of type `"linkobj"` where the stored data does NOT contain a `guid` field.

**SDK source**: types.d.ts:2588 — `{type:"linkobj", text:{link:string, title:string}}`.

**Identity**: `"ext:v1:" + sourceLineGuid + ":" + segmentOrdinal + ":" + normalizedLink`  
`normalizedLink` = the `link` field, URL-normalized (scheme lowercased, trailing slash stripped).

**Target**: `{kind:"external", guid:null, link:normalizedLink}`. External links are NEVER an internal backlink. They appear in outbound/export/health data only.

**`title`**: `seg.text.title` when present; else null.

**No backlink contribution**: an external-link edge never increments inbound reference counts for any record or line GUID.

**Completeness**: complete per-source-line; no workspace enumeration needed.

**Invalidation**: same line events as `ref`.

---

### Internal linkobj (GUID-bearing) — live-proven variant

A segment of type `"linkobj"` where the stored data contains a `guid` field. This is NOT in SDK types.d.ts. It is confirmed live in `g_universe.text_segments` pair-encoded storage and in Datacore's `_factLineFromItem` (engine.src.js:2019, kind `'linkobj'`).

**Storage shapes** (same three as `ref` above; refx/plugin.js:19184, engine.src.js:2019):

| Shape | How detected |
|---|---|
| `data` is a bare string (guid-shaped) | `data` itself is the target GUID |
| `data` is `{guid:string}` | `data.guid` |
| `data` is `{text:{guid:string}}` | `data.text.guid` |

**Classification**: after positive target proof (guid resolves to a known record, line, or collection), this edge is classified as kind `"ref"` with `provenance.segmentType:"linkobj"`. It contributes internal backlinks.

**If target does not resolve**: classified as kind `"external-link"` with `target.kind:"unknown"`, `target.guid:null`, and `provenance.rawLinkobj:data`. It does NOT contribute a backlink.

**Identity**: `"ref:v1:" + sourceLineGuid + ":" + segmentOrdinal + ":" + resolvedGuid` (same as `ref` after positive proof).

**Note**: `extractRefGuidsFromSegments` (refx/plugin.js:22057) currently skips `linkobj` entirely. This is gap refxA-gap-1. The R1 broker must include GUID-bearing linkobjs from the pair-encoded scanner.

---

### `property` — record relation property

A record property whose value contains a reference to another record GUID.

**SDK source**: `PluginRecord.getAllProperties()` (types.d.ts:3435) → `PluginProperty.values()` (types.d.ts:3224, returns `any[]`).

**Raw `values()` shapes** — must normalize defensively (GUARDRAILS 2026-06-08; backrefs/plugin.js:11206):

| Shape | Interpretation |
|---|---|
| `string` that is a GUID | target GUID |
| `string` starting with `[` | JSON-parse as array of GUIDs |
| `{guid:string}` object | `v.guid` |
| `{getGuid:function}` object | `v.getGuid()` |

`linkedRecords()` (types.d.ts:3174) is unreliable for unresolved targets; use `values()` for raw access, then `resolveTarget(guid)` for kind/name.

**Identity**: `"prop:v1:" + sourceRecordGuid + ":" + propertyFieldId + ":" + valueOrdinal + ":" + targetGuid`  
`propertyFieldId` = `prop.id` or `prop.name` (stable across renames via ID). `valueOrdinal` is position in normalized `values()` after expansion. Not durable for inbox identity (R3 rule: use `propertyFieldId + targetGuid` as occurrenceGroupKey, not ordinal).

**Completeness**: RefX `ensurePropRefIndex` (refx/plugin.js:20882) scans `data.getAllRecords()` synchronously — this is an O(N_records) scan at index build time, not per query. Index TTL = `_cacheTtlMs`. Marked partial during build; complete after first successful build.

**Invalidation**: `record.updated` events with changed `properties` payload; also triggered when `_attributesClaimsRefreshCount` increments.

**`title`**: null (property edges have no authored alias).

**`source.propertyId`**: set; `source.lineGuid`: null; `source.segmentOrdinal`: null.

**Cap**: property search is skipped when `items.length >= _maxResults` in the combined section (refx/plugin.js:14172). When skipped, `capReason: "combined-cap-reached"`.

---

### `annotation` — line-GUID stored in a record property

A record holds a property value that is a line GUID, pointing to a specific line in another record. The default configured property name is `"Source Line"` (backrefs/plugin.js:11536); configurable via `custom.lineRefProperties`.

**SDK source**: `PluginRecord.getAllProperties()` → `PluginProperty.values()` for properties named in `lineRefProperties`.

**Detection** (backrefs/plugin.js:11737): walks configured property names → `prop.values()` → normalizes string GUIDs → resolves via `window.g_universe.itemsByGuid[lineGuid]` first, then SDK cold fallback.

**Identity**: `"ann:v1:" + sourceRecordGuid + ":" + propertyFieldId + ":" + targetLineGuid`  
Target line GUID is stable. No ordinal component — a record/property/line triple is unique.

**Completeness**: same scan as `property`; no additional scan required.

**`target`**: `{kind:"line", guid:targetLineGuid}`. `provenance.ownerRecordGuid` set when the owning record resolves; null for cold lines.

**`title`**: null.

**`source.propertyId`**: set; `source.lineGuid`: null; `source.segmentOrdinal`: null.

**Invalidation**: `record.updated` with changed properties on the source record.

---

### `claim` — Attributes Engine authored/derived edge

A typed relational claim from the `thymer-claims-v1` broker.

**Source**: `window.__thymerClaimsV1` (claimsA audit; attributes/plugin.js:3174). Consumed via `broker.subscribe` and `broker.relational.edges()` (claimsA:3208).

**Authored edge shape** (claimsA:3208-3225):
```js
{
  edgeId: "edge:<claimGuid>:<ordinal>",
  source, predicate, target,
  kind: "authored",
  claimGuid, ordinal, sourcePart,
  derivedFrom: null, derivedBy: null
}
```

**Derived edge shape** (claimsA):
```js
{
  edgeId: "<parentEdgeId>:inverse" | "<parentEdgeId>:symmetric",
  source, predicate, target,
  kind: "derived",
  claimGuid, ordinal, sourcePart,
  derivedFrom: "<parentEdgeId>",
  derivedBy: "inverse:<keyGuid>" | "symmetric:<keyGuid>"
}
```

**Identity**: `"claim:v1:" + broker.edgeId` — the broker's `edgeId` is the canonical identity. The Reference Surface WRAPS it and NEVER creates a second claim identity (roadmap anti-pattern; ATTRIBUTES-RELATIONAL-ROADMAP.md:453).

**Completeness**: `broker.snapshot().complete` propagates directly. When `broker.status` is `"hydrating"`, edge pages for claim-kind carry `complete:false`.

**Invalidation**: broker `subscribe` callback fires on each new `{generation, revision, snapshot}` envelope. The Reference Surface re-publishes a new broker revision on each callback.

**`authored`/`derived`**: maps directly from the broker edge `kind` field.

**`title`**: `predicate.name` from the claim edge; NOT an alias.

**`source.lineGuid`**: `source` field of broker edge (this is a line GUID in Attributes). `source.propertyId`: null. `source.segmentOrdinal`: null.

**`target`**: `{kind:"record", guid:target}` — claim targets are record GUIDs in the broker.

**`provenance`**: frozen broker edge object preserved as-is.

**Anti-pattern**: the Reference Surface must not call `broker.snapshot()` per-edge; one `subscribe` callback covers all delta.

---

## Filter grammar v1

Version: 1 (serializable; breaking changes bump to FilterV2).

```js
{
  _filterVersion: 1,
  kinds:        string[] | null,   // subset of EdgeKind; null = all
  targetGuid:   string | null,     // exact target GUID; null = any
  sourceRecord: string | null,     // exact source record GUID; null = any
  authored:     boolean | null,    // null = both; true = authored only; false = derived only
  collectionGuid: string | null,   // source collection; null = any
  dateRange:    { from: number, to: number } | null   // epoch ms; null = any
}
```

Two filters are equal when their JSON-serialized forms (keys sorted, nulls explicit) are byte-identical. The cursor encodes the normalized filter; a filter change invalidates all cursors for prior filters.

---

## Edge ordering rule (deterministic)

Within a single page, edges are ordered:

1. By `kind` (ref < external-link < property < annotation < claim).
2. Within kind: by `source.recordGuid` ascending (lexicographic).
3. Within source record: by `source.lineGuid` ascending (null last).
4. Within source line: by `source.segmentOrdinal` ascending (null last).
5. Within same (record, line, ordinal): by `id` ascending (tiebreak).

This order is stable across async completion order. Cursor encodes the last stable key tuple.

---

## Allowed APIs (types.d.ts line references)

| API | types.d.ts line | Notes |
|---|---|---|
| `this.events.on(name, cb, opts?)` | 861–917 | Returns handler ID string |
| `this.events.off(handlerId)` | 924 | |
| `data.getAllCollections()` | 379 | Returns `Promise<PluginCollectionAPI[]>` — ALWAYS await |
| `data.getRecord(guid)` | 372 | Sync; returns null for cold/unknown |
| `data.getAllRecords()` | 354 | Sync; collection-scoped |
| `data.searchByQuery(query, maxResults?)` | 443 | Default maxResults=100; NO cursor/pagination |
| `PluginRecord.getBackReferences()` | 3279 | Returns `Promise<PluginBackReference[]>`; no cap documented |
| `PluginRecord.getBackReferenceRecords()` | 3267 | Returns `Promise<PluginRecord[]>`; no cap documented |
| `PluginRecord.getLineItems(expandReferences?)` | 3419 | Pass `false` to skip transclusion expansion |
| `PluginRecord.getProperties(viewName)` | 3428 | Sync; active props only |
| `PluginRecord.getAllProperties()` | 3435 | Sync; includes hidden |
| `PluginRecord.prop(name)` | 3452 | By name or guid |
| `PluginProperty.values()` | 3224 | Raw `any[]`; normalize defensively |
| `PluginProperty.linkedRecords()` | 3174 | Silently skips unresolvable GUIDs |
| `PluginLineItem.guid` | 2277 | Property (NOT `getGuid()`) |
| `PluginLineItem.getRecord()` | 2327 | Method returning `PluginRecord` |
| `PluginLineItem.segments` | 2292 | Property |
| `PluginLineItem.setSegments(segs)` | 2302 | Returns `Promise<boolean>` |
| `PluginLineItem.getChildren()` | 2336 | Returns `Promise<PluginLineItem[]>` |
| `PluginLineItem.getTreeContext()` | 2362 | Ancestors root→parent order |
| `PluginLineItem.delete()` | 2535 | Leaf-only; backend rejects if has children |
| `PluginLineItem.move(newParent, afterItem)` | 2557 | Returns `Promise<PluginLineItem|null>` |
| `PluginPanel.navigateTo({itemGuid, highlight:true})` | 2736 | Returns `Promise<boolean>` when itemGuid given |
| `ui.createPanel(opts?)` | 4440 | Returns `Promise<PluginPanel|null>` |
| `ui.registerCustomPanelType(id, fn)` | 4430 | |
| `PluginCollectionAPI.createRecord(name?)` | 1496 | Valid Global Plugin path |
| `data.createCollection()` | 407 | Returns `Promise<PluginCollectionAPI|null>` |

**`data.createNewRecord()`** (types.d.ts:364): explicitly unsupported on Global Plugins. Do not use.

**`getAllCollections()` without `await`**: anti-pattern. Returns a Promise; sync access returns `null` and caches it permanently (backrefs B0.2 bug; backrefs/plugin.js:11558).

**`prop.get()`**: does not exist. Use typed accessors (`.text()`, `.number()`, etc.) or `.values()`.

**`PluginRecord.getCollection()`**: does not exist on `PluginRecord` (types.d.ts confirmed). Only `PluginEvent.getCollection()` exists. Build a guid→collectionName map via `getAllCollections()` → `getAllRecords()` inversion.

**Caret/selection**: no `getCaretLine`, `getCaret`, `getSelection`, `currentLine` getter exists in SDK (types.d.ts exhaustive grep). Plugin tree/picker selection surface is the baseline for R4.

**`searchByQuery` pagination**: none. No cursor or continuation token. Hard cap via `maxResults`. For exhaustive enumeration use `getAllCollections() → getAllRecords()`.

---

## Anti-patterns with grep patterns

| Anti-pattern | Static guard pattern |
|---|---|
| Invented SDK API | `grep -n "\.getGuid()\|\.getRecordGuid()\|\.get(\|data\.createNewRecord\|prop\.get(" plugin.js` |
| `getAllCollections()` without await | `grep -n "getAllCollections()\s*\." plugin.js` (sync chained access) |
| `prop.get()` for relation values | `grep -n "prop\.get(" plugin.js` |
| Body-wide scan in event handler | `grep -n "getAllRecords\|getAllCollections" plugin.js` — cross-reference with event handler body locations |
| `getRecord()` per edge in bulk loop | `grep -n "getRecord(" plugin.js` inside any `.map(` or `for.*of` loop |
| Full result claim when capped | `grep -n "complete.*true\|complete:true" plugin.js` — verify `capReason` also set when cap reached |
| `window.prompt`/`confirm`/`alert` | `grep -n "window\.prompt\|window\.confirm\|window\.alert\|\.alert(\|\.confirm(\|\.prompt(" plugin.js` |
| Layout read in pre-paint observer | `grep -n "getBoundingClientRect\|offsetWidth\|offsetHeight\|scrollTop\|clientWidth" plugin.js` — cross-reference with MutationObserver callback bodies |
| Debounce before geometry-affecting decorator restore | Any `setTimeout` or `requestAnimationFrame` wrapping badge reinsertion when `!isConnected` |
| Second claim identity | `grep -n "claimKey\|claimGuid" plugin.js` — the broker's claimGuid must flow through unchanged |

---

## Flash-free invariants (preserved from current RefX)

These are shipping behaviors, NOT new work. The R1 broker must not break them.

1. Pre-paint cached-node reinsertion (refx/plugin.js:4978–4999): `_ensureCardObserver` reinserts badge/card/crumb nodes synchronously in MutationObserver callback before any paint frame.
2. Zero-flow-width badge geometry (refx/plugin.js:10603–10625): `padding-right:36px` reserved on `.lineitem-ref`; badge wrapper is `width:0; overflow:visible`.
3. Persistent managed `<style>` node (refx/plugin.js:10596–10601): `injectCounterCss` creates once by `id="trc-reference-counter-style"`, updates `textContent` in place.
4. Hot-reload handoff (CHANGELOG v3.80.1): prior instance releases style-node without removal; new instance adopts.
5. Overlay mode during typing (refx/plugin.js:9493): badge on stable `.line-div`, not the chip Thymer replaces per keystroke.
6. Transition suppression (CHANGELOG v3.80.2): `transition:none !important` on `refx-pageref-chip`/`refx-lineref-chip` in Distinct/Roam modes.
7. Generation-guarded async truth (refx/plugin.js:20413–20414): stale in-flight `loadCountInfo` results are inert.
8. Disk-seeded count cache (refx/plugin.js:20399–20405): instant paint from seed; authoritative `searchByQuery` refines asynchronously.

---

## Provenance fields by kind

| Kind | `provenance` fields |
|---|---|
| `ref` | `{segmentType:"ref", viewId?:string, title?:string}` |
| `external-link` | `{segmentType:"linkobj", link:string, title?:string}` |
| Internal linkobj classified as `ref` | `{segmentType:"linkobj", resolvedAs:"internal"}` |
| Internal linkobj target unresolved | `{segmentType:"linkobj", rawGuid:string}` |
| `property` | `{propertyName:string, propertyType?:string}` |
| `annotation` | `{propertyName:string, ownerRecordGuid?:string}` |
| `claim` | broker Edge object (frozen, verbatim) |

---

## Known gaps from current tree (reference for R1 implementers)

| ID | Location | Description |
|---|---|---|
| refxA-gap-1 | refx/plugin.js:22057 | `extractRefGuidsFromSegments` skips `linkobj` entirely; pair-encoded scanner at 14120 correctly handles both |
| refxA-gap-2 | refx/plugin.js:9433 | `_lineRefGuids` is not workspace-wide; cold lines absent until DOM-observed |
| refxA-gap-3 | refx/plugin.js:14172 | Combined count undercounts when line search hits cap; property section silently skipped |
| backA-B0.2 | backrefs/plugin.js:11558 | `_ensureChoiceLabelMap` calls `getAllCollections()` synchronously; caches null; `_warmChoiceLabelMapsAsync` at 11596 is never called |
| backA-gap-2 | backrefs/plugin.js:4308 | Stale persisted linked snapshot after authoritative-zero not cleaned from localStorage |
| graphA-gap-1 | refgraph/plugin.js:676 | `propInboundCount` undefined — `ReferenceError` on analytics tab render |
| graphA-gap-2 | refgraph/plugin.js:72 | `window.__refgraph.version = "0.2.1"` while manifest/header = `"0.3.0"` |
| graphA-gap-3 | refgraph/plugin.js | `_attributesClaimEdges()` defined but never called in graph-building; `_buildGraph` ignores broker |
| dataA-gap-1 | datacore/engine.src.js | `deps.inEdges`/`deps.fillLinks` wired but not implemented by plugin layer |


---

## Filter grammar v1.1 — FilterExpressionV1 (additive, R7)

Broker capability flag: `broker.supportsFilterExpr === true`. `apiVersion` stays 1.

This section is additive. The flat `FilterV1` grammar above is unchanged and remains the canonical form for simple queries. `FilterExpressionV1` is a superset accepted via a `filterExpr` param on `edges()`/`occurrences()` when nested logic is needed.

### FilterExpressionV1 shape

```js
// AND node — all operands must match
{ op: 'AND', operands: Array<FilterExpressionV1 | FilterV1> }

// OR node — at least one operand must match
{ op: 'OR', operands: Array<FilterExpressionV1 | FilterV1> }

// Leaf — any valid FilterV1 object (has _filterVersion field or is treated as leaf)
FilterV1
```

### Canonical serialization

`_normalizeFilterExprV1(expr)` produces a deterministic JSON string:
- Sorted operands (lexicographic on each operand's canonical string)
- Sorted keys within each node
- Leaves normalized by `_normalizeFilterV1`

Two `FilterExpressionV1` values are equal when their canonical strings are byte-identical.

### Cursor binding

Cursors bind to the normalized expression string alongside the flat filter. A `filterExpr` change produces a different cursor key, so stale cursors from a prior expression correctly return `{error:"stale-cursor"}`.

### Evaluation

`_matchFilterExprV1(edge, expr)`:
- `null` → always true
- Leaf node → delegates to `_edgeMatchesFilter(edge, filter)` (unchanged FilterV1 logic)
- `AND` node → all operands must return true
- `OR` node → at least one operand must return true
- Unknown `op` → true (permissive default for forward compatibility)

### Index optimization

When `filterExpr` is present alongside a flat `filter`, the flat `filter.targetGuid` / `filter.sourceRecord` fields still drive O(1) index lookups. `filterExpr` is applied to the indexed candidate set. This allows consumers to get index performance for the primary dimension while using nested logic for secondary dimensions.

### Breaking change boundary

`FilterExpressionV1` is additive in v1. No existing `FilterV1` consumer breaks. A consumer that does not provide `filterExpr` receives identical behavior. `apiVersion` will bump to 2 only if the flat `FilterV1` grammar itself changes in a breaking way.
