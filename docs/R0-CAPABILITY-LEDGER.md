# R0 Capability Ledger

Maps every scanner, bridge, index, and persistence mechanism found in the three reference repos to its R-phase disposition.

Columns: Keep = no change; Adapt = wire into broker; Retire = remove when broker ready; Defer = unchanged until its phase.

---

## RefX (thymer-reference-extravaganza) — scanners and indexes

| Component | Location | Disposition | Phase | Reason |
|---|---|---|---|---|
| `_lineRefGuids` Map | plugin.js:9433 | Keep as seed | R1 | DOM-observed fast seed; NOT workspace-wide; never marks snapshot complete |
| `_recordNameIndex` Map | plugin.js:268 | Keep, share via `window.__refx.recordName` | R1 | Background-built across all collections; already exported to consumers |
| `_countCache` (localStorage `refx_countcache_v2_*`) | plugin.js:9477 | Keep | R1 | Disk-seeded instant paint; authoritative refine via `loadCountInfo` already in place |
| `extractRefGuidsFromSegments` | plugin.js:22057 | Adapt | R1 | Currently skips `linkobj`; must add GUID-bearing linkobj extraction (gap refxA-gap-1) |
| Pair-encoded registry scanner (`_registryInboundCountMap`) | plugin.js:19184 | Keep as pre-count | R1 | Correctly handles ref+linkobj with all three guid storage shapes; used as lower-bound seed only |
| `_referenceTargetKind` | plugin.js:19974 | Keep | R0 | Five O(1) checks; shared with broker's `resolveTarget` |
| `ensurePropRefIndex` / `loadPropertyReferenceRecordCount` | plugin.js:20882 | Adapt | R1 | O(N) scan at build time; result must feed broker property edges; scan eliminated per-query once broker ready |
| `loadLinePropReferenceRecordCount` | plugin.js:21223 | Adapt | R1 | Same: feeds annotation edges for line-GUID properties |
| `_queryPropertyRefRecords` | plugin.js:13562 | Adapt | R1 | Currently called per-query; replace with broker lookup once index ready |
| `_attachAttributesClaims` / `_detachAttributesClaims` | plugin.js:1208–1218 | Keep, extend | R1 | Current adapter satisfies test contract; R1 must wire `_attributesClaimEdges()` into real claim edge data path |
| `_attributesClaimEdges()` | plugin.js:1213 | Adapt | R1 | Currently returns edges; nothing consumes them downstream yet |
| `getCountInfoForGuid` / `loadCountInfo` | plugin.js:20384 | Keep | R0 | Already generation-guarded, optimistic-delta, disk-seeded |
| `injectCounterCss` | plugin.js:10595 | Keep | R0 | Stable managed `<style>` node; hot-reload handoff in place |
| `_ensureCardObserver` | plugin.js:4956 | Keep | R0 | Pre-paint synchronous node reinsertion; flash-free invariant |
| Hot-reload singleton guards (`window.__refxKeyHandlers` etc.) | plugin.js:1012–1097 | Keep | R0 | Already correct; R1 adds broker singleton to the same pattern |
| `window.__refx` surface | plugin.js:1123–1132 | Keep, extend | R1 | Add `subscribe` and `claimEdges` to existing `{version, createEmbed, openRefMenu, jumpToLine, recordName}` |
| Workbench shelf (synced record) | plugin.js:1139 | Keep | Defer R6 | No change until R6 saved views |
| Delete guard (`slice(0,5)`) | plugin.js:2424 | Keep | R0 | Not a result-completeness issue |
| Inline-ref warm pass `slice(0,30)` | plugin.js:14148 | Keep + PAGE_SIZE cap | R2 | Warm pass now capped to PAGE_SIZE (30) rows to avoid transient DOM spike; full warm count shown in title (updating…) |
| Picker results `slice(0,32)` | plugin.js:3212 | Keep + truthfulness affordance | R2 | Retained at 32-field display cap; _cappedAt32 now requires >32 probe (false-positive at exactly 32 fixed); message uses actual rendered count |
| Ranked results `slice(0,48)` / display `slice(0,8)` | plugin.js:6421 | Keep + truthfulness affordance | R2 | Retained at 8-result display cap; pre-slice count now stored in link.resultsPreSliceCount; "showing top 8" hint fires only when preSliceCount > 8 |

---

## Backreferences (thymer-backreferences) — pipelines and persistence

| Component | Location | Disposition | Phase | Reason |
|---|---|---|---|---|
| `searchByQuery('@linkto=')` — linked results | plugin.js main search | Adapt | R1 | Replace with broker `edges()` call; retain as fallback when broker `unavailable`/`degraded` |
| `getBackReferenceRecords()` — property results | plugin.js:5168 | Adapt | R1 | Replace with broker property edges; retain as fallback |
| Unlinked `searchByQuery` | plugin.js runUnlinkedReferenceSearch | Keep, separate budget | R2 | Not a reference edge; stays as separately budgeted text-occurrence index per roadmap |
| Line-ref scan (Annotates) | plugin.js:84–87 | Adapt | R1 | Replace with broker annotation edges for `Source Line` properties |
| `renderPersistedLinked` / `captureLinkedGroupsToStore` / `buildLinkedGroupsFromStore` | plugin.js:4283, 4332 | Adapt | R1 | Keep provisional-first-paint pattern; wire authoritative source to broker snapshot instead of bare `searchByQuery` |
| `_linkedStore` (`localStorage tlr_linkedcache_v1_*`) | plugin.js:4233 | Keep | R1 | Per-client seed; max 60 records × 25 lines; 7-day TTL; stale-zero cleanup gap (backA-gap-2) must be fixed in R1 |
| Stale-zero not cleaned from localStorage | plugin.js:4308 | Fix | R1 | When broker returns authoritative zero, explicitly remove the record from `_linkedStore` |
| `_ensureChoiceLabelMap` sync bug | plugin.js:11558 | Fix | R3 | Call `_warmChoiceLabelMapsAsync` from post-render tick; see backA-B0.2 |
| `_warmChoiceLabelMapsAsync` (dead code) | plugin.js:11596 | Fix | R3 | Wire one call site from post-render tick to enable async warm-up |
| `liveNewKeys` Set | plugin.js:979 | Keep | R1 | Live-activity new-ref badge; compatible with broker delta |
| `_detectSeriesParent` | plugin.js:11953 | Keep | R3 | Synchronous in-memory scan; no broker dependency; add tests in R3 |
| `_lineScanMaxLines = 150` / `_lineScanPerLineMaxResults = 50` | plugin.js:84, 87 | Keep, document | R2 | Hard caps; must be exposed in broker page `capReason` when hit; expose in config in R2 |
| `_choiceLabelMapByCollection` invalidation on workspace event | plugin.js:846 | Keep | R3 | Also invalidates on broker generation change |
| `getLineRefPropertyNames()` / `lineRefProperties` config | plugin.js:11526 | Keep | R1 | Configurable; default `"Source Line"`; broker annotation edge detection reads same names |
| `liveBaselineSnapshot` / `liveCurrentSnapshot` diff | plugin.js:4972 | Keep | R1 | New-ref detection during live session; compatible with broker delta |
| `propertyGroups` pipeline / `getPropertyBacklinkCandidateRecords` | plugin.js:5168 | Adapt | R1 | Replace with broker property edges |
| `_defaultMaxResults = 200` | plugin.js:71 | Keep | R1 | Cap exposed in broker page; no silent truncation |
| `_focusLineSearchMaxResults = 250` | plugin.js:83 | Expose in config | R2 | Currently hard-coded; needs config path in R2 |
| `__thymerBackrefs.getPropertyBackrefs` cross-plugin export | plugin.js | Keep | R1 | No change; will be re-backed by broker in R1 |
| Test suite (95 tests, refactor-smoke.js) | test/ | Extend | R1 | Add: choice labels, Annotates, Series, persisted-linked, liveNewKeys, line-ref scan, chip filters, bridge actions |
| README / changelog doc drift (v0.13→v0.17 gap) | README.md | Fix | R3 | Document v0.14–v0.17 features per roadmap R3 closure requirement |

---

## Reference Graph (thymer-reference-graph) — builder and analytics

| Component | Location | Disposition | Phase | Reason |
|---|---|---|---|---|
| `_buildGraph` O(N) scan via `g_universe.itemsByGuid` | plugin.js:242–286 | Retire, fallback-only | R1 | Replace with broker edge lookup; retain as fallback when broker `unavailable` |
| `_buildAnalytics` O(N) scan via `g_universe.itemsByGuid` | plugin.js:506–561 | Retire, fallback-only | R1 | Same; double scan eliminated after broker ready |
| `_getCollMap` `getAllCollections()→getAllRecords()` | plugin.js:216–228 | Retire, fallback-only | R1 | Replace with `resolveTarget()` broker call; keep for analytics-tab orphan check until broker exposes collection membership |
| `_attributesClaimEdges()` defined but never called in graph | plugin.js:83 | Fix | R1 | Wire into `_buildGraph`; replace g_universe scan for claim-family edges |
| `propInboundCount` ReferenceError | plugin.js:676 | Fix | R0 | Bug: `propInboundCount` is used but never declared; crashes analytics tab entirely (graphA-gap-1) |
| `window.__refgraph.version = "0.2.1"` drift | plugin.js:72 | Fix | R0 | Must be `"0.3.0"` to match manifest and header (graphA-gap-2) |
| `_analyticsCache` (5-min TTL) | plugin.js:32–34 | Keep | R1 | Cache invalidated by broker revision; no change to TTL mechanics needed |
| `_collMap` session-level cache | plugin.js:209 | Keep | R1 | Invalidated on hot-reload and Rescan; mid-session gaps acceptable until broker exposes membership |
| Generation token `window.__refgraphGen` | plugin.js:47 | Keep | R0 | Already correct hot-reload pattern |
| `_killStale()` hot-reload cleanup | plugin.js:56, 103–127 | Keep | R0 | Removes prior rAF, handlers, DOM nodes, bridge |
| Node/edge eviction (tier-aware, hop-2 first) | plugin.js:461–472 | Keep | R0 | Correct; hop-2 preference documented |
| Hop-2 cap at 12 hop-1 nodes | plugin.js:408 | Keep | R1 | By insertion order, not degree — acceptable for now; document as known gap |
| MAX_REGISTRY = 120000 / MAX_EDGES = 90 | plugin.js:239, 240 | Keep | R0 | Hard caps; toast on registry overflow |
| `window.__refgraph` bridge (`open`, `openAnalytics`) | plugin.js:71–76 | Keep, fix version | R0 | Fix version string; no new methods needed until R9 |
| `window.__refx` not consumed at all | plugin.js | Keep (intentional) | R1 | Graph must start consuming `window.__refx.recordName` for cold name lookup in R1 |

---

## Claims bridge consumers

| Component | Repo | Disposition | Phase | Reason |
|---|---|---|---|---|
| `_attachAttributesClaims` broker adapter | refx/plugin.js:1208 | Keep, extend | R1 | Satisfies test contract; R1 wires edges into real data paths |
| `_attachAttributesClaims` adapter (copy) | backrefs/plugin.js | Keep | R1 | Same pattern; R1 routes broker edges to linked results |
| `_attachAttributesClaims` adapter (copy) | refgraph/plugin.js | Keep, fix | R1 | Fix: wire `_attributesClaimEdges()` into `_buildGraph` |
| `attributes-claims-contract.test.cjs` | all three repos | Keep | R0 | Identical md5 across all three — confirmed; this test guards the ABI |
| `thymer:claims-v1-ready` event listener | all three | Keep | R0 | Re-attach on late broker registration |

---

## Datacore discovery

| Component | Location | Disposition | Phase | Reason |
|---|---|---|---|---|
| `deps.searchByQuery` for `@linkto=` / `@date=` / phrase | engine.src.js:4097 | Keep (seam A) | R1 | R1 adapter may intercept at this seam without changing query language |
| `_factLineFromItem` segment walker | engine.src.js:2011 | Keep | R1 | Emits `lineRef` facts with `native-record-ref`/`linkobj` kinds; broker may pre-supply but segment walker is the fallback |
| `window.__thymerClaimsV1` claim broker consumption | engine.src.js:2136 | Keep | R0 | Correctly wired; feeds `edge`, `claimRef`, `incoming/outgoing` fact families |
| `deps.inEdges` / `deps.fillLinks` | engine.src.js:2480–2482 | Implement | R1 | Named seam for pre-indexed in-edge map; currently not provided by plugin layer; R1 broker adapter must populate |
| `_referencesView` memo (`rev + name + guid` key) | plugin.src.js:5059 | Keep | R1 | Any store revision invalidates memo; broker revision bumps must stay in sync |
| `pdcEncodeExactReferenceTarget` round-trip encoding | engine.src.js:32–47 | Keep intact | R1 | Any `deps.searchByQuery` interceptor must preserve this encoding for `this.title` queries |
| `dateLines` workspace-wide `@date=` search | engine.src.js:4281 | Keep (or broker intercept) | R1 | Broker intercepting at `deps.searchByQuery` must handle `@date = "YYYY-MM-DD"` syntax specifically |

---

## Allowed APIs — verified signatures and runtime notes

| API | types.d.ts line | Runtime notes / drift |
|---|---|---|
| `this.events.on(name, cb, opts?)` | 861–917 | Returns handler ID string; `record.moved`/`lineitem.moved`/`blob.updated`/`user.updated`/`panel.*`/`reload` are UNSCOPED — filter options ignored |
| `this.events.off(handlerId)` | 924 | |
| `data.getAllCollections()` | 379 | Returns `Promise<PluginCollectionAPI[]>`; runtime-drift: must ALWAYS await; sync access returns a Promise (truthy), not an array |
| `data.getRecord(guid)` | 372 | Sync; null for cold/deleted |
| `data.getAllRecords()` | 354 | Sync; collection-scoped to owning plugin collection |
| `data.searchByQuery(query, maxResults?)` | 443 | Default 100; NO cursor; single-call hard cap |
| `data.createNewRecord()` | 364 | **NOT supported on Global Plugins** — explicitly documented; use `PluginCollectionAPI.createRecord()` |
| `PluginRecord.getBackReferences()` | 3279 | Returns `Promise<PluginBackReference[]>`; no cap param; `{record, kind, lineItemGuid, propertyId}` |
| `PluginRecord.getBackReferenceRecords()` | 3267 | Returns `Promise<PluginRecord[]>`; no cap |
| `PluginRecord.getLineItems(expandRefs?)` | 3419 | Pass `false` to skip transclusion expansion |
| `PluginRecord.getProperties(viewName)` | 3428 | Sync; null = all active |
| `PluginRecord.getAllProperties()` | 3435 | Sync; includes hidden |
| `PluginRecord.getCollection()` | **ABSENT** | runtime-drift: does NOT exist on `PluginRecord`; only on `PluginEvent`; use `getAllCollections()→getAllRecords()` inversion |
| `PluginProperty.values()` | 3224 | Returns `any[]`; raw shapes vary — normalize (see ref-surface-v1.md property normalization table) |
| `PluginProperty.linkedRecords()` | 3174 | Silently skips unresolvable GUIDs; unreliable for MCP-written array relations (land as JSON-blob string in `values()`) |
| `PluginLineItem.guid` | 2277 | PROPERTY — runtime-drift: `getGuid()` does NOT exist |
| `PluginLineItem.record` | 2281 | Direct PROPERTY — `getRecord()` method also exists at 2327 |
| `PluginLineItem.getRecord()` | 2327 | Returns `PluginRecord` |
| `PluginLineItem.segments` | 2292 | Direct property |
| `PluginLineItem.setSegments(segs)` | 2302 | Returns `Promise<boolean>` |
| `PluginLineItem.getChildren()` | 2336 | Returns `Promise<PluginLineItem[]>` |
| `PluginLineItem.getParent()` | 2344 | Returns `Promise<PluginLineItem\|PluginRecord>` |
| `PluginLineItem.getTreeContext()` | 2362 | Ancestors immediate-parent → root order |
| `PluginLineItem.delete()` | 2535 | LEAF-ONLY; backend rejects if has children; no batch delete API |
| `PluginLineItem.move(newParent, afterItem)` | 2557 | Returns `Promise<PluginLineItem\|null>` |
| `PluginPanel.navigateTo({itemGuid, highlight:true})` | 2736 | Returns `Promise<boolean>` when `itemGuid` given; `void` otherwise |
| `PluginPanel.getNavigation()` | 2694 | Returns `any` — runtime-drift: `state.highlightLines[0]` is an implementation detail, not typed |
| `ui.createPanel(opts?)` | 4440 | Returns `Promise<PluginPanel\|null>` |
| `ui.registerCustomPanelType(id, fn)` | 4430 | |
| `ui.addCommandPaletteCommand({label,icon,onSelected})` | 4377 | |
| `PluginCollectionAPI.createRecord(name?)` | 1496 | Valid path for Global Plugin record creation |
| Caret/current-line getter | **ABSENT** | runtime-drift: no `getCaretLine`/`getCaret`/`getSelection`/`currentLine`/`getActiveLineItem` anywhere in types.d.ts |

---

## Anti-patterns — static guard patterns

| Anti-pattern | Guard | Notes |
|---|---|---|
| Invented SDK API | `grep -En "\.getGuid\(\)\|\.getRecordGuid\(\)\|prop\.get\(\|data\.createNewRecord\(" plugin.js` | Any hit is a hard bug |
| `getAllCollections()` without await | `grep -n "getAllCollections()\s*\." plugin.js` | Sync chain after getAllCollections = always returns Promise |
| `prop.get()` for relation | `grep -n "prop\.get(" plugin.js` | Method does not exist |
| Body-wide scan in event handler | `grep -n "getAllRecords\b" plugin.js` — verify each is outside event handler scope | |
| `getRecord()` per edge in bulk loop | `grep -n "\.getRecord(" plugin.js` in for-of / map bodies | |
| Full result claim when capped | `grep -n "complete.*:.*true" plugin.js` — verify `capReason` set and `status !== "partial"` | |
| `window.prompt/confirm/alert` | `grep -n "window\.prompt\|window\.confirm\|window\.alert\b" plugin.js` | |
| Layout read in pre-paint observer | `grep -n "getBoundingClientRect\|offsetWidth\|offsetHeight" plugin.js` — verify not inside MutationObserver callback before DOM mutation is done | |
| Debounce before geometry-affecting decorator restore | `grep -n "setTimeout\|requestAnimationFrame" plugin.js` — verify none wrap badge reinsertion paths | |
| Second claim identity | `grep -n "claimKey.*=\|claimGuid.*=" plugin.js` — must pass through from broker, never mint | |
| Numeric-offset cursor resume | `grep -n "offset.*page\|page.*offset\|skip.*\d\|after.*\d" plugin.js` in pagination paths | Cursor must be opaque, never a numeric offset |
