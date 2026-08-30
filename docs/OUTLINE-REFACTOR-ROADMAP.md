# Outline Refactor — Goal-Executable Roadmap

This plan defines a proposed global plugin for safe multi-line and subtree transformations. No repository existed at authoring time.

## Goal runner entrypoint

```text
Implement /Users/svyatoslavkleshchev/thymer-reference-extravaganza/docs/OUTLINE-REFACTOR-ROADMAP.md. Reconcile all current plugin trees and memories first so no existing refactor engine is duplicated. If still absent, create /Users/svyatoslavkleshchev/thymer-outline-refactor as one global plugin with a .system-sync-include marker and project memory. Complete O0 through O6 sequentially. Preserve rich line semantics and GUID/reference identity, default every destructive workflow to preview, verify every write, and keep a recoverable operation receipt. Integrate through versioned APIs with Reference Extravaganza, Reference Surface, and Version Ledger. Continue until release gates pass or a true external blocker is documented.
```

## Product boundary

Outline Refactor owns structural planning and mutation for selections/subtrees: move/copy with children, extract, merge, split, sibling sort and planned compensation. It does not own general page merge/tag cleanup (Notes Management), reference authoring (RefX), history storage (Version Ledger), graph diagnosis (Reference Graph) or query views (Datacore).

Better-than-Roam target: every operation has a dry-run tree diff, inbound line/property reference impact, explicit GUID policy, verified writes and an operation ledger/undo path.

## Status ledger

| Phase | Scope | Initial status |
|---|---|---|
| O0 | SDK discovery, selection model, canonical tree/operation contract | Not started |
| O1 | Non-mutating planner, preview and operation receipts | Not started |
| O2 | Verified move/copy with children and sibling sort | Not started |
| O3 | Extract subtree to record with reference/transclusion replacement | Not started |
| O4 | Merge, split and detach transformations | Not started |
| O5 | RefX/Reference Surface/Version Ledger integration and undo | Not started |
| O6 | Scale, concurrency, accessibility and release | Not started |

Reference Platform R4 may begin only after O0–O1 contracts are frozen.

## Per-phase documentation checkpoint

Before every `O` phase, cite the current SDK signatures for each tree read/write, current RefX/Notes Management patterns, and the exact Reference Surface/Version Ledger contract version. If the public SDK cannot faithfully perform a planned write, keep it preview/export-only and return to O0. Every handoff includes behavioral/fault-injection verification and static guards against DOM text scraping, recursive delete assumptions, title identity and unverified writes.

## Invariants

1. A move preserves line GUIDs and therefore inbound reference identity.
2. A copy mints new GUIDs; internal references are rewritten only under an explicit policy shown in preview.
3. Rich segments, tasks, dates, metadata, hierarchy and source order are never flattened to display text.
4. Planning is side-effect-free and uses a frozen source fingerprint/revision.
5. Apply revalidates all touched targets immediately before the first write.
6. Every SDK write is awaited and its persisted result reread where possible.
7. Partial failure produces an exact receipt and safe compensation plan; no false atomicity claim.
8. Operations never depend on title uniqueness.

## Contracts to freeze

`OutlineNodeV1` records GUID, record GUID, type, canonical segments, task/meta state, parent GUID, ordered children and fingerprint.

`OutlinePlanV1`:

```js
{
  id, schemaVersion: 1, workspaceGuid,
  operation, sourceRevision,
  selection: { roots, expandedGuids, order },
  destination,
  guidPolicy: "preserve" | "mint" | "mixed",
  referencePolicy,
  steps: [{ id, kind, targetGuid, precondition, payload, compensation }],
  impact: { inboundEdges, propertyEdges, claims, danglingRisk, cycles },
  warnings, unsupported,
  estimatedWrites
}
```

`OperationReceiptV1` appends step attempts/results, verified final fingerprints, compensation results, source plugin and Version Ledger checkpoint ID. It is immutable after finalization.

## Phase O0 — documentation and feasibility

### Read before implementation

- Official SDK types/examples for `getChildren`, `getParent`, `getTreeContext`, `createLineItem`, `move`, leaf-only `delete`, `setSegments`, task/meta/property handling, panel/selection and events.
- Current RefX Apply Children, move-original, delete guard and selected-line detection.
- Notes Management page merge behavior.
- Reference Platform R0/R4/R9 and Version Ledger V3–V4.

### Deliverables

1. An API feasibility table per operation, including what cannot be implemented faithfully with current public APIs.
2. A selection-acquisition decision. The current public SDK has no documented current-line, caret or multi-selection getter. The safe baseline is a plugin-owned tree/picker. An editor adapter is allowed only if it is narrow, isolated, live-proven against current RefX DOM fixtures and has an automatic picker fallback.
3. A split-boundary decision. Default to a user-selected segment/text boundary in the plugin preview; use a live editor caret only through the same proven adapter. Never invent an SDK method or scrape arbitrary `textContent`.
4. Selection model: explicit roots, descendant expansion, overlapping-root normalization, stable source order and maximum limits.
5. Canonical tree serializer/fingerprint and rich fixture corpus.
6. Step ordering and compensation rules for each operation.
7. Reference-impact query contract using Reference Surface; explicit degraded behavior when unavailable.
8. Concurrency model for remote edits and simultaneous operations.

### Exit gates

- No invented batch/transaction/delete-recursive API.
- Every destructive operation has proven SDK primitives or is deferred/read-only.
- Fixtures cover text/task/ref/linkobj/date/code/meta, deep trees, cycles/malformed handles and cross-record destinations.

## Phase O1 — planner and preview

1. Add commands for `Refactor current subtree` and `Refactor selected lines`. Resolve roots through the O0 picker/proven-adapter contract; the plugin-owned picker is always available when editor selection cannot be proved.
2. Normalize selection roots so selecting parent+child does not duplicate descendants.
3. Build a frozen source tree and target context with batched reads, depth/node caps and cancellation.
4. Detect illegal destinations: inside self/descendant, deleted/cold parent, collection restrictions and unsupported cross-workspace moves.
5. Query Reference Surface once for inbound direct/property/annotation/claim impact; label partial/degraded results.
6. Render a tree diff preview: kept/moved/copied/deleted/created GUIDs, destination, aliases/refs affected, step count and rollback strength.
7. Export the plan as deterministic JSON for tests/support. Preview causes zero writes.

Exit: golden plans for every operation, cancellation/stale revision tests, and explicit unsupported outcomes.

## Phase O2 — move, copy and sibling sort

### Move

- Prefer native `line.move` to preserve identity and children where verified.
- Re-read parent/order after each move batch and at completion.
- Preserve relative order for multi-root moves.
- Reject/replan if source/destination fingerprint changes.

### Copy

- Create parent before children, preserving canonical state and order.
- Build old->new GUID map.
- Reference policy options: preserve all external targets; optionally rewrite references whose target is inside the copied selection to its new GUID. Show exact rewrites in preview.
- If rich metadata cannot be written by public API, block faithful copy rather than silently dropping it.

### Sort siblings

- Stable sort with explicit key, direction, null handling and task/date semantics.
- Show before/after order; no-op if already sorted.
- Use moves, never delete/recreate, so GUIDs survive.

Verification includes mixed root selections, 1k-node bounded operation, same-parent reorder, cross-parent move, copy internal cycles, write rejection and remote edit between steps.

## Phase O3 — extract subtree

1. Destination options: new record in selected collection or existing record/line when supported.
2. Default move semantics preserve original line GUIDs by moving the subtree into the destination.
3. Replacement at the original location is explicit: line reference, record reference, native transclusion, or no replacement. Preview exact target and alias.
4. Create destination first, verify it, move content, create replacement, then verify source/destination and inbound edges.
5. Failure before movement may delete an empty newly created destination if safely verified; failure after movement uses compensation/receipt, never blind cleanup.
6. Record title derives from an explicit user value or selected source text with collision preview; never identify the created record by title after creation.
7. Preserve tasks, children and refs. Do not move plugin-owned decorator/transclusion helper lines unless the user explicitly selected a supported semantic object.

Exit: extract with each replacement mode, existing/new target, nested refs, title collision, failed replacement and undo/compensation fixtures.

## Phase O4 — merge, split and detach

### Merge

- Merge adjacent siblings only in the first release.
- Define separators and type compatibility. Task/task requires an explicit status policy; incompatible types block.
- Preserve the chosen survivor GUID. Redirect or preserve references to removed GUIDs only when a supported replacement plan exists; otherwise block destructive merge.

### Split

- Split one text-capable line at a verified boundary selected in the preview. A live caret boundary is optional and only comes from the O0 proven adapter.
- Preserve rich segments on each side; aliases/refs are indivisible atoms unless the selected boundary lies outside them.
- Original GUID retention policy is explicit (default: first half keeps it).

### Detach

- Convert selected references/transclusions to canonical rich text at bounded depth.
- Cycle/missing/depth truncation markers are explicit.
- Never detach by copying `textContent` from the DOM.

Each operation needs golden semantic fixtures, reference-impact preview, verified result and stale-plan refusal.

## Phase O5 — integrations and undo

Expose `window.__thymerOutlineRefactorV1` with version/status/generation, `plan`, `apply`, `receipt`, `canUndo`, `undo` and `subscribe`. All mutating calls require a previously returned immutable plan ID and current precondition token.

- RefX delegates multi-line copy/transclude/extract/detach from Reference Platform R4.
- Reference Graph delegates repair plans rather than writing structures itself.
- Version Ledger wraps every operation when ready; its checkpoint ID is embedded in the receipt.
- Without Version Ledger, retain a bounded local before-state receipt and truthfully label undo durability.
- Undo is a new planned operation against current state, not reverse writes replayed blindly.
- Both load orders, plugin absence, degraded Reference Surface, hot reload and duplicate apply calls have contract tests.

## Phase O6 — release gates

- Full unit/golden/property tests for serializers, planners, GUID maps, steps and compensation.
- Fault injection at every write step; every outcome is verified/recoverable.
- Remote-edit races before and during apply, deleted/cold handles, reload mid-operation and two-panel invocation.
- 10k-node planning benchmark off the typing path; 1k-node apply keeps UI responsive via bounded batches without reordering.
- Keyboard-only preview/apply/cancel, visible focus, screen-reader tree semantics and reduced motion.
- Live disposable fixtures prove move/copy/sort/extract/merge/split/detach and inbound reference preservation.
- Version and hot-reload singleton checks; install/cold reload pass.

## Anti-patterns

- No “transaction” label without defined preconditions, verification and partial-failure semantics.
- No delete-and-recreate move, title-based identity or DOM scraping.
- No unbounded recursive tree walk or per-node record lookup waterfall.
- No mutation from preview, automatic apply on dialog open or destructive default option.
- No hidden reference rewrite or metadata loss.
- No duplicate history engine inside this plugin.

## Handoff template

```text
Phase/status:
Repository/commit/version:
Operation/API contract version:
Requirements proved:
Fixtures/tests/counts:
Fault-injection outcomes:
Reference impact evidence:
Live operation GUIDs and verification:
Performance/accessibility evidence:
Push/install state:
Next phase objective:
```
