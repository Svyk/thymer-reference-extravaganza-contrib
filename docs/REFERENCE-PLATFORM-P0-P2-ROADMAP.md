# Thymer Reference Platform — Goal-Executable P0–P2 Roadmap

This is the durable implementation plan for the existing reference trio:

- Reference Extravaganza: `/Users/svyatoslavkleshchev/thymer-reference-extravaganza`
- Backreferences: `/Users/svyatoslavkleshchev/thymer-backreferences`
- Reference Graph: `/Users/svyatoslavkleshchev/thymer-reference-graph`

It also assigns shared structural work to the proposed Outline Refactor and Version Ledger plugins instead of duplicating mutation and undo engines inside Reference Extravaganza.

## Goal runner entrypoint

Start a fresh Codex goal with this exact objective:

```text
Implement /Users/svyatoslavkleshchev/thymer-reference-extravaganza/docs/REFERENCE-PLATFORM-P0-P2-ROADMAP.md through P2. Treat every phase status as unverified until the exact current trees, installed versions, tests, and live Thymer behavior prove it. Preserve already-shipped Reference Extravaganza behavior and performance. Do not create a fourth reference/backlink plugin. Keep the three existing reference consumers and the thymer-claims-v1 broker compatible. Complete one numbered phase at a time, write a handoff record with exact commits/tests/live evidence, and continue until every Definition of Done item is proved or a true external blocker is documented.
```

Before editing, read this file completely, then read each referenced repository's project memory and current `git status`. Never overwrite a dirty worktree. As of the plan's creation, another Codex task was actively editing Attributes and Datacore; those repositories are dependencies, not edit targets for this roadmap.

## Source sessions already reconciled

This plan is the durable synthesis of the two sessions the user supplied; a fresh goal does not need to replay them unless it is investigating provenance or a later contradiction:

- `019f4dba-3e1f-7d11-9756-dea976d142ad` — local rollout at `/Users/svyatoslavkleshchev/.codex/sessions/2026/07/10/rollout-2026-07-10T13-31-19-019f4dba-3e1f-7d11-9756-dea976d142ad.jsonl`. This was the ecosystem/reference assessment that proposed P0–P2, the Backreferences closure list, and the three genuinely distinct new global plugins.
- `019f4a39-35e7-7700-8b75-44143dc223d5` — local rollout at `/Users/svyatoslavkleshchev/.codex/sessions/2026/07/09/rollout-2026-07-09T21-11-31-019f4a39-35e7-7700-8b75-44143dc223d5.jsonl`. This later/current work was modifying Attributes and Datacore; do not treat its dirty tree as an edit target or duplicate its relational/journal-reference work.

The 2026-07-11 re-audit compared both rollouts with exact current repositories and a live Thymer install. The baseline, Do Not Rebuild list, and phase statuses below are the result of that reconciliation—not a copy of an older proposal.

## Status ledger

| Phase | Scope | Initial status |
|---|---|---|
| R0 | Documentation discovery, current-tree audit, contracts, fixtures | **Complete 2026-07-11** — contracts frozen (`reference-surface-v1.md`), capability ledger, 31 shared fixtures in all 3 consumers, fixture agreement suites (19/13/1 tests), refgraph preflight fixes shipped (v0.3.1: propInboundCount crash + version tell). Handoff: `docs/handoffs/R0-HANDOFF.md` |
| R1 | Shared Reference Surface v1 | **Complete 2026-07-11** — `window.__thymerReferenceSurfaceV1` broker shipped in RefX v3.81.1 (all edge families: ref/property/annotation/claim, event-maintained incl. moved/remote, opaque cursors, zero-scan post-complete, 100k bench 96ms); Backreferences v0.19.1 + Reference Graph v0.4.1 consume with scanner fallback + both load orders tested; 63/88/19 + 128 + 17/13 tests green, fixture md5 identical in all 3. Handoff: `docs/handoffs/R1-HANDOFF.md` |
| R2 | Complete paginated results and truthful partial state | **Complete 2026-07-11** — RefX v3.82.1 cursor/page model (display-side chunking of complete in-memory sets, Show-more with exact remaining, `_r2FillId` stale-continuation guard, warm pass capped truthfully, `_cappedAt32`/top-8 affordances); Backreferences v0.20.1 UIT unlinked text-occurrence index (chunked, event-maintained, checkpointed, budgets frozen in `thymer-backreferences/docs/UNLINKED-TEXT-INDEX.md` — amends R0 ledger) + truthful count labels/capReason; 0/1/30/31/250/2500 fixtures reach complete sets, no dup/skip across cursors, remote-edge-mid-pagination reconciled once, in both repos (30-test r2-pagination suite + 36 UIT/B4 smoke checks; 88/30/63/19/1 + 164/1/1 green). Live warm-load trace deferred to user post-push. Handoff: `docs/handoffs/R2-HANDOFF.md` |
| R3 | Durable Reference Inbox read/change state | **Complete 2026-07-11** — Backreferences v0.21.1: stable `sourceGuid\|kind\|targetKey` occurrence keys (no ordinals/content; move/reorder-safe), versioned per-client store `tlr_inbox_v1_<ws>` (debounced 1.5 s, corrupt/schema-mismatch recovery, newer-schema read-only), unread/changed badges + next/prev `x of n` + per-group/all mark-read + reset, order-independent text-only `sourceHash` (move ≠ changed), provisional linked/UIT-incomplete results excluded from counts, GC gated on complete authoritative snapshots (30-day retention, 5k cap, currentSet-safe); smoke 205 checks green + terminates unaided (R2 hang debt closed; R2-ADV1-9 + UIT-doc debts closed). Closure deltas: Current-line cmd → B1; dismiss/ignore/select/undo actions → B2 (store fields reserved in v1 schema); per-edge claim keys unwired (claims merge under `__claims__\|ref\|<target>`). Live evidence deferred to user post-push. Handoff: `docs/handoffs/R3-HANDOFF.md` |
| R4 | Multi-line and subtree reference operations | **UI/contract complete 2026-07-11 (v3.84.0 + v3.84.1 review fixes); mutations blocked on external Outline Refactor O2–O5 (documented blocker)** — plugin-owned selection panel (checkbox/shift-range/subtree select, keyboard nav; SDK has no editor multi-selection getter per R0 ledger), 6-op capability registry with action-time executor detection (`window.__thymerOutlineRefactor` / `__thymerVersionLedger` contracts frozen in the handoff), side-effect-free `PreviewV1` per op (broker `inEdges` O(1) only — zero body scans) + `OutlinePlanV1` plans (bounded store of 8), the two executor-free ops live (copy-as-refs — bare `thymer-ref://` URIs, paste-parser round-trip proved; transclude-subtree via existing `_bridgeCreateEmbed`, contiguity-gated), gated ops (extract/detach/move-copy-sort/undo-checkpoint) render disabled with reason and build plan-only — 0 mutations verified on the full diff. 47-check r4 suite; 298 TAP + 1 contract script all green. Completion of the mutation half lands when Outline Refactor O2–O5 (and Version Ledger V4 for checkpoints) exist — external repos not built. Handoff: `docs/handoffs/R4-HANDOFF.md` |
| R5 | Hierarchical and scoped reference picker | **Complete 2026-07-11** — RefX v3.83.1: Tab/Enter drill into record/line children + Backspace/crumb back with query restore (scoped keys never leak to the document), strict-pattern exact-GUID lookup (non-selectable not-found row, no fabrication), structured filters `in:`/`is:task`/`status:`/`kind:`/`before:`/`after:` (`alias:` removed as unimplemented), frecency rank-only (bounded boost, 500-entry LRU), one cancelable session token (`_r5SessionGen`) dropping stale local+remote results; identifier normalization (`EMP 26`) preserved via unchanged `_searchScore` path on the free-text remainder; zero body scans on filter paths (colMap = membership only, lazy; drill children session-cached); create suppressed in scope. 51-test r5 suite new; 88/51/30/63/19/1 all green. Item 5 (collection/view ref targets) not delivered — no SDK-proved path, nothing faked. Live evidence deferred to user post-push. Handoff: `docs/handoffs/R5-HANDOFF.md` |
| R6 | Synced saved Reference Views | **Complete 2026-07-12** — ReferenceViewV1 records (Workbench native-record pattern), append-only revision DAG w/ derived heads + explicit merge, per-view write serialization, no-LWW reads, pin migration guard (v3.85.0 + review fixes v3.85.1 incl. real-SDK persistence fix). Deferred: live refx_pin meta write-back (warm-workspace pass). Handoff: `docs/handoffs/R6-HANDOFF.md` |
| R7 | Rich facets and typed claim-edge rendering | **Complete 2026-07-12** — `_r7FacetSnapshot(targetGuid)` counts 6 facet dimensions from `broker.inEdges()` (O(k) snapshot, zero re-query); `_r7ApplyFacetFilter` filters loaded rows client-side; `_renderR7FacetBar` renders chip bar with counts equal to full broker snapshot; `_renderClaimRow` renders typed claim edges with predicate name, authored/derived badge, provenance fields, navigable via `_bridgeJump`; same-title discovery and claim renderer are mutually exclusive paths. FilterExpressionV1 (additive v1.1): nested AND/OR over FilterV1 leaves as `filterExpr` param on `broker.edges()`/`broker.occurrences()`; `_normalizeFilterExprV1` deterministic canonical JSON; `_matchFilterExprV1` recursive evaluator; cursor key includes `\|expr:` suffix when `filterExpr` present; flat `filter` untouched; `supportsFilterExpr: true` capability flag; `apiVersion` stays 1. v3.86.0 (51-test r7-r8 suite; 401 total green). Handoff: `docs/handoffs/R7-R8-HANDOFF.md` |
| R8 | One-row native edit-on-demand | **Complete 2026-07-12** — `_r8EditLive(entry, row, line, opts)` replaces chosen row with native transclusion via `_bridgeCreateEmbed`; `entry._r8ActiveEditor` tracks current editor (one active per view, opening a second closes the first); `_r8SettleRerender(entry, row, line, gen, {savedFacets, savedFilter, scrollAnchor})` rerenders from current data after close, generation-guarded against stale calls; `_r8AssertSingleEditor(container)` structural assertion (returns count of `.refx-r8-live` elements). v3.86.0. Handoff: `docs/handoffs/R7-R8-HANDOFF.md` |
| R9 | Reference Health and repairs | **Complete 2026-07-12** — Reference Graph v0.5.0: 8-class detection (dangling-target, stale-alias, invalid-annotation, cycle, duplicate-title, orphaned-owner, misclassified-segment, broken-claim), broker-based zero-body-scan, risk grouping + matrix routing, gated repair plans (requires `__thymerOutlineRefactor`), export-only diagnostics. 28 new tests in `test/r9-health.test.cjs`; 59 total green. Handoff: `docs/handoffs/R9-HANDOFF.md` |
| R10 | Resolved Markdown export | **Complete 2026-07-12** — RefX v3.87.0: `_r10ExportMarkdown` bounded walk (5000 nodes / 512 KB), GUID-keyed visited set (records + lines), explicit cycle markers (`<!-- cycle: name (guid) — not re-expanded -->`), explicit truncation markers (`<!-- truncated: ... -->`), segment fidelity (headings/tasks/lists/code/external-links/ref-links/datetimes/properties), preserve-refs or resolve-to-display-text with inline expansion at depth 0–3, deterministic byte-identical output, palette command + modal (options/preview/Copy/Save-to-file), localStorage options persistence. 44 new tests in test/r10-export.test.cjs; all 446 tests across 10 suites green. Handoff: `docs/handoffs/R10-HANDOFF.md` |
| R11 | Final conformance, performance, docs, and release | **Complete (offline gates); live gates deferred to user post-push** — all 10 suites green (446 REFX + 2 BACK + 4 GRAPH suites, 361 BACK smoke checks); fixture md5 `bb132de841e05e375312a07a68c3b89a` identical in all 3 repos; node --check passes all 3 plugin.js; no `window.prompt/confirm/alert` / `data.createNewRecord` / `prop.get(` / numeric-offset cursor anti-patterns in any repo; load-order (both orders) + hot-reload coverage cited in REFX `reference-surface-broker.test.cjs` + GRAPH `broker-consumption.test.cjs` + BACK `scripts/refactor-smoke.js:4526`; accessibility: all visible icon-only buttons carry `title` or `aria-label`; README changelogs updated (all 3 repos); version tells consistent (REFX 3.87.0, BACK 0.26.1, GRAPH 0.5.0); R9 handoff written; R11/B7 final handoff written. Live performance, two-client checks, and typing-regression measurement deferred per roadmap offline rule. Handoff: `docs/handoffs/R11-B7-HANDOFF.md` |

Update this ledger only after the phase's exit gates pass on the exact current tree. “Code exists” is not completion.

## Per-phase documentation checkpoint

At the start of every `R` phase, re-open the current official SDK entries and examples for every API that phase will call, plus the exact owner-plugin source named in the phase. Add those file/URL/line references to the phase handoff before editing. If a required method is absent, has a different signature, or is only a private DOM pattern, return to R0 and amend the capability ledger; do not improvise an API. Every phase's verification must include a grep/static guard for its known anti-patterns as well as behavioral tests.

## P0–P2 priority map

The `R` numbers are execution phases; the requested `P` labels are priority tiers:

| Priority | Required outcome | Execution phases |
|---|---|---|
| P0 — foundation and correctness | One shared Reference Surface, complete/truthful result continuation, durable unread/change state, and safe multi-line/subtree operations | R0–R4 |
| P1 — power-user product layer | Hierarchical picker, synced saved views, rich typed facets, one-row native editing, and Reference Health | R5–R9 |
| P2 — portability | Resolved Markdown export with bounded expansion, cycle handling, and explicit truncation | R10 |
| Release closure | Cross-repo conformance, live performance, accessibility, versioning, install and handoff evidence | R11 |

Do not skip P0 to begin a P1/P2 surface that depends on completeness or mutation safety. Independent UI prototypes are allowed only behind fixtures and feature flags; they do not change phase status.

## Baseline to verify, not assume

The baseline when this roadmap was authored on 2026-07-11 was:

- Reference Extravaganza `3.80.0`, commit `25caccf`.
- Backreferences `0.17.0`, commit `4eddaeb`.
- Reference Graph `0.3.0`, commit `0d4daee`.
- Attributes Engine `0.33.2` installed, with later uncommitted reconciliation work in another task.
- Datacore `0.91.2` installed, with a later uncommitted journal-reference fix in another task.
- Live Chrome reported Reference Extravaganza `window.__REFX_VERSION === "3.80.0"`; on the inspected reference-heavy record it rendered five native reference chips and five overlay badges with one managed counter stylesheet.

Preflight every future run:

```bash
for repo in \
  /Users/svyatoslavkleshchev/thymer-reference-extravaganza \
  /Users/svyatoslavkleshchev/thymer-backreferences \
  /Users/svyatoslavkleshchev/thymer-reference-graph \
  /Users/svyatoslavkleshchev/thymer-attributes \
  /Users/svyatoslavkleshchev/plexus-datacore; do
  git -C "$repo" status --short --branch
  git -C "$repo" log -3 --oneline --decorate
done
```

Read every manifest version and live version tell. Fix version drift before feature work. The authoring audit found Reference Graph's manifest/header at `0.3.0` while `window.__refgraph.version` still said `0.2.1`.

## Product direction

Build one reference platform with three existing surfaces:

| Owner | Responsibility |
|---|---|
| Reference Extravaganza | Reference creation, aliases, transclusions, Workbench, chip/line decorators, shared edge broker, reference operations |
| Backreferences | Page/line reference inbox, complete result browsing, filters, unread/change state, saved reference views |
| Reference Graph | Graph analytics, Reference Health, repair planning and impact visualization |
| Attributes Engine | Canonical typed claims and authored/derived relational edges through `thymer-claims-v1` |
| Datacore | Query language and saved query consumers of the same edge semantics |
| Outline Refactor | Structural multi-line mutation planning, preconditioned verified application, compensation and undo |
| Version Ledger | Durable before/after checkpoints and selective restore |

Do not create a “Reference Kernel” or another backlinks plugin. Reference Extravaganza owns the versioned Reference Surface broker; the other plugins consume it through a narrow, read-only contract.

## Definition of Done

The roadmap is complete only when all of these are proved:

- One versioned Reference Surface emits the same normalized edges to RefX, Backreferences, Reference Graph, and Datacore adapters.
- Direct record refs, direct line refs, `linkobj`, record properties, line-GUID annotation properties, and Attributes claim edges have explicit, tested semantics.
- Reference-edge consumers never rescan record bodies or collections when the broker is ready. Complete unlinked plain-text search may maintain the one separately budgeted Backreferences text index defined in R2; it never scans bodies per query.
- Every capped result explicitly says it is partial and offers continuation until the authoritative set is exhausted.
- Unread/changed state survives reload and identifies occurrences by stable source identity plus content hash.
- Structural operations preview reference impact, apply through preconditioned verified steps, and produce compensation/undo/checkpoint receipts without claiming SDK-level atomicity.
- Saved Reference Views sync target, query, facets, sort, context depth, display mode, and descendant-mention behavior.
- Exactly one selected result can become a native editable transclusion without mounting a page of editors.
- Reference Health finds and safely repairs the supported defect classes.
- Markdown export resolves references and transclusions at bounded depth without cycles or silent truncation.
- Existing RefX badge behavior remains instant and geometry-neutral, with no measurable adjacent-panel typing regression.
- All repo suites, contract suites, performance gates, version checks, install checks, and two-client live checks pass.

## Phase R0 — documentation discovery and frozen contracts

### Read before implementation

Authoritative SDK sources:

- `https://github.com/thymerapp/thymer-plugin-sdk/blob/main/types.d.ts`
- `https://github.com/thymerapp/thymer-plugin-sdk/tree/main/examples/app-plugins`
- The live SDK overview returned by Thymer's `get_plugin_sdk_documentation` tool.

Current implementation sources:

- RefX bridge and broker adapter: `plugin.js` around `_attachAttributesClaims`, `_attributesClaimEdges`, and `window.__refx`.
- RefX reference extraction: `extractRefGuidsFromSegments` and every `ref`/`linkobj` parser.
- RefX count truth and flash-free paths: `_ensureCardObserver`, `attachObserver`, `getCountInfoForGuid`, `_referenceTargetKind`, `injectCounterCss`.
- Backreferences result pipeline: `renderPersistedLinked`, `liveNewKeys`, unlinked matching, property groups, `_ensureChoiceLabelMap`, `_detectSeriesParent`.
- Reference Graph node/edge builder, analytics cache, and `window.__refgraph`.
- Attributes `window.__thymerClaimsV1` or its exact current equivalent; do not infer its ABI from tests alone.
- Datacore's reference provider and fact registry.
- `/Users/svyatoslavkleshchev/Downloads/flash-free-plugins.md`.

### Allowed APIs

Use only contracts verified in current docs and, where the runtime has drifted, a live probe:

- `this.events.on(name, callback, options?) -> handlerId` and `this.events.off(handlerId)` for record, line, panel and reload changes.
- `PluginEvent` GUID fields and changed payloads in synchronous event handlers. Queue async enrichment; do not assume event continuations preserve order.
- `data.getAllCollections(): Promise`, `data.getRecord(guid)`, and bounded `searchByQuery(query, maxResults)`.
- `data.createCollection(): Promise<PluginCollectionAPI|null>` only after the phase proves creation is intended and user-visible; configure the returned collection through the documented plugin configuration save API.
- `PluginCollectionAPI.createRecord(recordName?)` for synced state inside a known collection. `data.createNewRecord()` is not a valid Global Plugin storage path and must not be used.
- `PluginRecord.getBackReferences()`, `getBackReferenceRecords()`, `getLineItems(false)`, `getProperties`, `getAllProperties`, and `createLineItem`.
- `PluginLineItem.segments`, `setSegments`, `getChildren`, `getParent`, `getTreeContext`, `move`, and leaf-only `delete`.
- `PluginPanel.navigateTo({itemGuid, highlight:true})`, awaiting and checking its boolean result.
- `ui.registerCustomPanelType`, `ui.createPanel`, command palette, status bar, sidebar and toaster surfaces.
- IndexedDB/localStorage only for explicitly per-client state; Thymer records/line metadata for state that must sync.

### Anti-patterns

- No invented SDK APIs or undocumented constructor overrides.
- No `getAllCollections()` without `await`.
- No `prop.get()` for relation values; normalize `values()` shapes.
- No body-wide scan in an event handler.
- No `getRecord()` per edge/value in a bulk loop.
- No full result claim when a search cap was reached.
- No browser `window.prompt`, `confirm`, or `alert` for desktop-facing plugin flows.
- No layout read inside the pre-paint decorator MutationObserver.
- No debounce/rAF before restoring a decorator whose absence changes geometry.

### Deliverables

1. A checked-in `reference-surface-v1.md` contract or equivalent module documentation.
2. Shared JSON fixtures covering every edge kind and malformed/cold cases.
3. A capability ledger mapping each old scanner/bridge to keep, adapt, or retire.
4. Behavioral contract tests. String-presence tests are insufficient.

### R0 exit gates

- Exact APIs and runtime differences are cited.
- Every edge kind has a stable identity, completeness rule, and invalidation rule.
- All three consumers agree on the same fixtures before production wiring.
- No current shipped feature is mistakenly listed as new work.

## Canonical Reference Surface v1 contract

Freeze this shape in R0 before wiring it:

```js
{
  apiVersion: 1,
  generation: "load-generation",
  revision: 42,
  status: "complete" | "partial" | "degraded" | "unavailable",
  subscribe(listener) => unsubscribe,
  snapshot() => { generation, revision, status, diagnostics },
  edges({ filter, limit = 50, after = null, generation, revision }) => {
    items: ReferenceEdge[],
    error: null | "stale-cursor" | "unavailable",
    complete: boolean,
    cursor: string | null,
    knownTotal: number | null,
    capReason: null | string,
    queryRevision: number
  },
  occurrences({ filter, limit = 50, after = null, generation, revision }) => {
    items: ReferenceOccurrence[],
    error: null | "stale-cursor" | "unavailable",
    complete: boolean,
    cursor: string | null,
    knownTotal: number | null,
    capReason: null | string,
    queryRevision: number
  },
  resolveTarget(guid) => { guid, kind, recordGuid, name, collectionGuid } | null
}
```

`filter` has a versioned, serializable grammar frozen in R0. `limit` is bounded. `after` is an opaque cursor bound to the broker generation, query revision, normalized filter, sort and last stable ordering key. A request with a mismatched/expired cursor returns an explicit stale-cursor result and no items; it never resumes by numeric offset against a changed snapshot. `complete` means this page ends an authoritative result set, not merely that a local cap was exhausted.

`ReferenceEdge` minimum fields:

```js
{
  id,                       // deterministic, versioned identity
  kind,                     // ref | external-link | property | annotation | claim
  source: {
    workspaceGuid,
    collectionGuid,
    recordGuid,
    lineGuid: null | string,
    propertyId: null | string,
    segmentOrdinal: null | number
  },
  target: {                // exactly one of guid/link is populated
    kind,                  // record | line | collection | external | unknown
    guid: null | string,
    link: null | string
  },
  title: null | string,     // authored alias/title; semantics depend on edge kind
  authored: boolean,
  derived: boolean,
  sourceHash,
  updatedAt: null | number,
  provenance: null | object
}
```

Identity rules:

- A snapshot-unique internal `ref` edge ID includes source line GUID, segment ordinal, segment kind and target GUID. Absolute ordinal is not a durable inbox identity.
- The documented SDK `linkobj` shape is an external titled link `{link,title}`. Its edge identity uses the normalized external link, its target GUID is null, and it never contributes an internal backlink. Any live-proven legacy GUID-bearing variant gets a separate fixture/capability rule and is internal only after positive target proof.
- A snapshot-unique property edge ID includes source record GUID, property field ID, normalized value ordinal and target GUID. Absolute value ordinal is not a durable inbox identity.
- A claim edge preserves the canonical Attributes claim ID; the Reference Surface wraps it but never creates a second claim identity.
- An annotation to a line carries both target line GUID and owning record GUID when known.
- Unknown target kind remains `unknown` until positively resolved; it is never guessed from GUID shape alone.
- Edge ordering is deterministic and independent of async completion order.

## Phase R1 — shared Reference Surface v1

### Implement

1. Add a versioned, hot-reload-safe broker owned by RefX, exposed under a stable global such as `window.__thymerReferenceSurfaceV1` plus a ready event.
2. Treat existing RefX indexes as fast seeds only; the authoring audit proved some are capped or observed-DOM-derived. Never mark their snapshot complete by inheritance.
3. Establish one authoritative hydration path for **reference edges** in the broker. Prefer documented complete backreference APIs for target-local data; for edge families with no complete API, run one cancelable, chunked enumeration of collections/records/lines/properties off the typing path, persist a versioned progress seed, buffer event deltas during hydration, then reconcile them before publishing `complete`. This is the sole recurring source for reference-edge truth; R2's separately budgeted unlinked-text index is not a second reference-edge scanner.
4. Normalize internal `ref` segments and documented external `linkobj` segments separately. External links remain outbound/external and never become false backlinks. Live-proven legacy variants require fixtures and positive target proof.
5. Normalize record relation properties and line-GUID annotation properties with explicit field IDs and source identities.
6. Adapt `thymer-claims-v1` authored/derived edges into the contract. Current `_attributesClaimEdges()` accessors are adapters only; wire their output into real edge data paths.
7. Maintain edges incrementally from line/record events. Use event payload GUIDs and deltas first; enrich cold handles on a coalesced retry.
8. On reload, reconcile one generation and publish one revision. Consumers discard stale generation work.
9. Make Backreferences and Reference Graph consume broker fixtures and real live snapshots. Their fallback scanners remain only for broker unavailable/degraded mode.
10. Add a Datacore adapter without changing its query language in this phase.

### Verification

- A created, updated, moved, deleted and remotely-created reference changes exactly the expected edge(s).
- An external `linkobj` occurrence appears once in outbound/export/health data, never as an internal backlink or plain-text mention.
- A record property edge and a line annotation edge retain different kinds.
- A typed claim edge renders in each consumer and can be filtered by authored/derived state.
- Both plugin load orders work.
- After authoritative hydration reaches `complete`, broker-ready queries make zero collection scans and zero record-body scans.
- 100,000 synthetic edges update with bounded memory and sublinear target lookup.
- RefX, Backreferences and Reference Graph have behavioral integration tests, not source-string assertions.

## Phase R2 — complete results and truthful pagination

### Implement

1. In R0, prove the authoritative source for each result family. Linked/property/annotation/claim occurrences come from the Reference Surface; plain-text unlinked mentions are not reference edges and need their own completeness contract.
2. Prefer a documented SDK cursor when one exists. If unlinked search has only a hard `maxResults`, build exactly one Backreferences-owned, chunked and event-maintained normalized text-occurrence index; do not rerun a workspace body scan for every query. This separate provider has its own `partial/complete` generation, disk/memory budget, cancel/resume checkpoint, input-aware scheduling, and measured time-slice limit frozen in R0. Persisted index pages may seed paint but are provisional until the current generation reconciles.
3. If the public SDK cannot enumerate the source and a safe maintained index is impossible, keep the result explicitly partial and block R2 completion. Never fabricate a cursor over one capped result set.
4. Replace hard `30`-row slices in RefX inline refs, unlinked mentions and related views with a shared cursor/page model.
5. Backreferences renders an immediate first page, then “Next 50”/infinite continuation without re-querying prior pages.
6. Every result envelope carries `complete`, `cursor`, `knownTotal`, `capReason` and `queryRevision`.
7. Preserve filter, sort, expansion and scroll state across page loads.
8. Virtualize or recycle rows after measurement; never mount hundreds of transclusions.
9. Distinguish “0 complete results,” “0 provisional results,” and “showing 50 of at least N.”
10. Cancel stale continuations when target, filter, sort, broker revision or panel generation changes.

### Verification

- Fixtures at 0, 1, 30, 31, 250 and >2,000 occurrences reach the complete authoritative set.
- No duplicate or skipped occurrence across cursors.
- Filters over already-loaded pages do not falsely claim completeness.
- A remote edge arriving during pagination is reconciled once under a new revision.
- First-page paint stays within the current RefX/Backreferences warm-load budget.

## Phase R3 — durable Reference Inbox state

Backreferences owns this surface.

### Implement

1. Separate snapshot edge identity from durable inbox identity. Define an `occurrenceGroupKey` from stable source GUID, edge kind/property field, and semantic target key—never raw segment/value ordinal or mutable content. Within a group, reconcile instances by stable SDK segment ID if one is ever documented, otherwise by neighbor/context fingerprints and sequence matching. Exact indistinguishable duplicates share the group's read state conservatively; reordering them never manufactures unread/changed items. Store `sourceHash` as version state, never as part of either key.
2. Persist per-client state first in a versioned store: last seen hash, last read hash/time, dismissed-unlinked fingerprint and ignored phrase/page rules.
3. Show unread and changed counts, next/previous unread, `x of n`, mark read, mark all read and reset state.
4. “Changed” means the same stable occurrence key has a different source hash from `lastReadHash`. A move with unchanged content is not changed.
5. Mark persisted cold results visibly provisional until the broker reconciles them; authoritative zero removes stale positives immediately.
6. Add optional synced state in R6 through the saved-view state record. Never silently merge device states without deterministic rules.
7. Bound retention and garbage-collect state for edges absent from complete snapshots for a configured period.

### Backreferences-specific closure in R3

- Add a visible `Backreferences: Current line` command and context-menu action.
- Add dismiss false positive, ignore phrase on page, select occurrences, preview Link all, apply, and undo.
- Preserve rich segments when linking; never flatten a line to plain text.
- Fix the async choice-label cache: warm from the already-awaited collection array rather than calling async `getAllCollections()` from a synchronous helper and caching `null`.
- Add focused tests for choice labels, Annotates, Series, same-name groups, persisted truth and unlinked undo.
- Update README/changelog/config docs to the actual manifest version.

## Phase R4 — multi-line and subtree reference operations

This phase consumes Outline Refactor's planner and executors. Do not build a second transaction engine in RefX. RefX may implement selection UI and plan previews after O1, but R4 cannot pass until each exposed mutation is backed by its matching O2–O5 executor and receipt. Version Ledger V4 is optional checkpoint durability, not the mutation executor.

### Implement

1. Provide a plugin-owned tree/picker selection surface as the documented baseline. Use modifier-based editor selection only if O0 proves a public API or a narrow, isolated RefX adapter with live DOM fixtures; the SDK currently has no documented current-line or multi-selection getter.
2. Copy selected lines as refs.
3. Transclude selected subtree.
4. Extract selected subtree to a new record and leave one reference at the original location.
5. Detach selected refs/transclusions as rich text at configurable depth.
6. Preview target collection, moved/copied lines, inbound reference impact and exact undo plan.
7. Apply copy/move/sort through Outline O2, extract through O3, merge/split/detach through O4, and the versioned broker/undo through O5. Hide or disable any action whose executor capability is absent. Checkpoint through Version Ledger V4 when available.

### Verification

- Mixed text/task/ref/datetime subtrees preserve type, segments, metadata, order and children.
- GUID-preserving moves keep every inbound edge valid.
- Copy operations mint new GUIDs and rewrite only internal copied-subtree links when explicitly selected.
- Failure at any write step leaves a recoverable operation receipt and does not claim success.

## Phase R5 — hierarchical, scoped picker

### Implement

1. Keep the existing fast normalized picker as the first-level search.
2. Add Tab/Enter drill into record or line children and Delete/Backspace navigation to the parent scope without losing the query.
3. Add exact GUID lookup and structured filters: `in:collection`, `is:task`, `status:`, `kind:record|line`, `alias:`, `before:`, `after:`.
4. Add recency and frecency as optional ranking signals, never as completeness filters.
5. Include collection/view targets only where the SDK can create a valid ref.
6. Use one cancelable search session token; stale local or remote results cannot be inserted.

### Verification

- Keyboard-only path covers query, drill, back, create, alias and insert.
- Identifier normalization remains as fast as the current `EMP 26` behavior.
- Scoped filters do not scan bodies after the Reference Surface is ready.

## Phase R6 — synced saved Reference Views

### Implement

1. Define a `ReferenceViewV1` record containing target(s), edge kinds, nested filter expression, sort, context depth, descendant mentions, display mode, pagination size and optional inbox-state sync.
2. Persist views in a plugin-owned state record, following the Workbench's native-record pattern. R0 must name the known collection and use its `PluginCollectionAPI.createRecord()`; if a dedicated companion collection is truly needed, provision it visibly through `data.createCollection()` plus verified configuration save. Never call unsupported Global Plugin `data.createNewRecord()`. Do not store synced state in localStorage.
3. RefX pins and Workbench linked-ref items point to a view GUID, not a target-only ad hoc config.
4. Backreferences can save the current view, open a saved view and update it explicitly.
5. Make configuration history append-only: each `ReferenceViewRevisionV1` has an immutable revision ID, parent revision ID(s), config hash, full serialized config, author/client and timestamp. The current head is derived, not overwritten through a pretend compare-and-swap.
6. Two revisions with the same parent create multiple heads and an explicit conflict. Consumers keep showing the last unambiguous head or a user-selected head; merge UI appends a new revision referencing both parents. No last-writer-wins guess.
7. Keep per-device presentation-only preferences local.

### Verification

- Two clients open the same target/filter/sort/context view.
- Updating a saved view refreshes consumers once.
- Concurrent edits from the same parent retain both heads; an explicit merge revision resolves them without losing either configuration.
- Deleting a view never deletes referenced content.
- Legacy target-only pins migrate idempotently.

## Phase R7 — rich facets and real claim-edge rendering

### Implement

1. Facet without re-querying the source: collection, source property, edge kind, authored/derived, task state, Journal/date range, direct/property/annotation/claim.
2. Support nested AND/OR filter expressions with stable serialization.
3. Render Attributes claims as first-class typed relationship rows with provenance, qualifiers and confidence/evidence where present.
4. Make Parent/Series/Sibling relationship definitions configurable and visually distinct; keep same-title discovery separate from typed relation discovery.
5. Datacore and saved programs consume the same edge-kind names and IDs.

### Verification

- Facet counts equal the full broker snapshot, not just loaded rows.
- A claim edge is visible and navigable in all three consumers.
- Derived edges are labeled and can be excluded without losing authored edges.
- No Attributes collection/body scanner is introduced.

## Phase R8 — one-row native edit on demand

### Implement

1. Keep list rows lightweight.
2. An explicit “Edit live” action replaces only the chosen row with a real native transclusion.
3. Preserve row location, filter state and scroll anchor when opening/closing.
4. Enforce one active editor per view by default; allow a small measured cap only if live traces justify it.
5. Remote updates invalidate the lightweight row after the native editor settles.

### Verification

- Full structural editing works: children, indentation, refs, dates, task metadata.
- Closing returns to the same occurrence and scroll position.
- Fifty visible rows still mount only zero or one transclusion editors.

## Phase R9 — Reference Health and repair planning

Reference Graph owns diagnosis and visualization. Repair execution stays with the plugin that owns the data representation; Outline handles only structural plans, while Version Ledger provides checkpoints/receipts rather than domain writes.

### Detect

- Dangling record/line targets.
- Stale explicit aliases.
- Invalid or ambiguous line-GUID properties.
- Reference/transclusion cycles.
- Duplicate titles that make text-only lookup ambiguous.
- Orphaned lines/records where the owning target is unavailable.
- Malformed or semantically misclassified `ref`/`linkobj` segments; an external `linkobj` is not defective merely because it has no GUID.
- Claims whose provenance target no longer resolves.

### Defect-to-executor matrix

| Defect | Planner/executor | Guard |
|---|---|---|
| Dangling internal `ref`, stale alias, safely normalizable ref segment | Reference Extravaganza | Preserve rich segments; positive target proof; preview every source occurrence |
| External `linkobj` | Reference Extravaganza for diagnostics/export only by default | Never convert an external URL to an internal backlink; automatic repair requires a live-proven reversible rule |
| Internal reference/transclusion cycle | RefX for a chosen edge detach/retarget; Outline only when the cycle is structural | Require an explicit user-selected break edge and show downstream impact |
| Invalid/ambiguous line-GUID relation property | The plugin/collection that owns that property, through a documented property writer | RefX/Graph may propose; they do not mutate foreign schema semantics |
| Broken Attributes claim/provenance | Attributes Engine | Preserve canonical claim ID and authored/derived provenance |
| Structural cycle, orphan placement, subtree move | Outline Refactor | Immutable plan, preconditions, verified receipt |
| Duplicate titles/page merge | Notes Management or export-only diagnostic | Never auto-merge by title equality |
| Missing faithful public writer or ambiguous intent | Export-only diagnostic | No Repair button that can silently lose semantics |

Destructive bulk repairs should request a Version Ledger V4 checkpoint when available, but checkpoint availability never changes which plugin owns the write.

### Implement

1. Read broker diagnostics and run bounded targeted verification; do not rescan the workspace on every graph open.
2. Group defects by repairability and risk.
3. Preview every repair with affected edges and inbound-reference impact.
4. Route each repair to the executor matrix and require a Version Ledger checkpoint for destructive bulk repair when that plugin is installed.
5. Offer export-only diagnostics when an automatic repair cannot preserve semantics.

### Verification

- Seeded defect fixtures are all found with no false positives in clean fixtures.
- Repair is idempotent and reversible where promised.
- A stale generation cannot apply a repair plan.

## Phase R10 — resolved Markdown export

### Implement

1. Export line, subtree, record, saved reference view or transclusion.
2. Options: preserve refs, resolve to display text, expand at depth N, include properties, include source breadcrumbs and include task state.
3. Walk by GUID with a visited set and total node/byte budget.
4. Preserve rich semantics: headings, tasks, lists, code, links, aliases and datetimes.
5. Emit explicit truncation/cycle markers; never silently omit content.
6. Copy to clipboard and save through a user-approved file workflow. No hidden network export.

### Verification

- Golden fixtures cover nested refs, aliases, cycles, missing targets, tasks and dates.
- Same input/options produce byte-identical output.
- Depth and byte caps are explicit in the result.

## Phase R11 — final conformance and release

### Required suites

- Every existing repo suite.
- Cross-repo Reference Surface fixtures and real behavioral integrations.
- Load-order matrix: each consumer before/after RefX and Attributes.
- Hot-reload singleton/disposal matrix.
- Cold, warm, remote update and authoritative-zero reconciliation.
- Browser and desktop UI matrix.
- Accessibility: keyboard-only, focus visibility, screen-reader labels, reduced motion.
- Exact manifest/header/runtime/changelog version checks.

### Performance gates

Record machine/browser/workspace sizes with every benchmark.

- Plain typing on a line with no refs: no reference query, no full-page scan and negligible observer work.
- Typing on a line with refs: no geometry shift, no absent painted badge frame, no body-wide query.
- 10,000 warm edge lookups: zero host record lookups.
- 100,000-edge target lookup: indexed, not linear.
- First page of Backreferences: immediate from truthful seed or broker snapshot; authoritative reconciliation does not block paint.
- Pagination: bounded DOM row count.
- Graph health scan: cancelable and off the typing path.

Use Chrome traces and the actual logged-in app. If live access is unavailable, label the result offline; do not claim measured runtime performance.

## Flash-free invariants to preserve

The generic flash-free guide is correct, but RefX already exceeds it in several ways. Preserve:

- Geometry immunity: stable native-selector padding reserves the badge slot; injected badge presence does not change text geometry.
- Same-microtask cached-node reinsertion before paint.
- Layout reads deferred and batched outside the observer callback.
- Dirty-line scoping and per-callback chip caches.
- Truthful immediate seeds followed by generation-guarded authoritative reconciliation.
- Strict record/line/unknown classification and incremental indexes.
- No recurring full-workspace scan.

Adopt generic advice only when it adds value:

- Keep one managed stylesheet node and update its `textContent` in place.
- Filter mutation batches before expensive work.
- Observe `characterData` only where native count/text changes are intentionally mirrored.
- Small restore work may be synchronous; large page-load decoration must be scheduled only when persistent CSS already prevents an unstyled frame.

## Do not rebuild

Already shipped and outside this roadmap unless a regression is proved:

- `[[`/`((` creation, identifier-aware search, aliases and missing-page creation.
- Replace With family, copy/paste refs, Apply Children and delete guard.
- Inline transclusion and editable property cards.
- Workbench and pinned mentions.
- Task-reference checkboxes.
- Page-vs-line appearance settings.
- Inbound count badges, target-line badges, parent/reference/sibling/children contexts.
- Unlinked mentions, deep connections, `Annotates`, line-GUID property auto-detection and Block View.
- Reference Graph's existing graph/analytics surfaces.
- Attributes claim identity and Datacore's relational fact registry.

## Cross-roadmap execution order

Recommended order:

1. R0.
2. R1.
3. R2 and R3.
4. Outline Refactor O0–O1 and Version Ledger V0–V1; RefX may build R4 selection/preview UI against frozen fixtures.
5. Outline O2–O5 and Version Ledger V2–V4; expose each R4 mutation only after its matching executor capability exists.
6. Complete R4.
7. R5 and R6.
8. R7 and R8.
9. R9.
10. R10.
11. R11.

Spaced Review may begin after R1 and consume the stable Reference Surface independently.

## Phase handoff template

Append one handoff file or section per completed phase:

```text
Phase:
Status:
Date:
Repositories and exact commits:
Current manifest/runtime versions:
Requirements proved:
Tests and counts:
Benchmarks and environment:
Live Chrome/Desktop evidence:
Fallback/degraded behavior:
Known gaps intentionally deferred:
Install/push state:
Next phase entrypoint:
```

Never mark a phase complete merely because its focused tests pass. Audit every numbered requirement against current source and live behavior.
