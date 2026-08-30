# Backreferences — Goal-Executable Improvement Roadmap

This is the focused execution plan for `/Users/svyatoslavkleshchev/thymer-backreferences`. It closes the Backreferences gaps identified during the 2026-07-11 current-tree audit without turning Backreferences into a second Reference Extravaganza.

The cross-plugin source of truth is `REFERENCE-PLATFORM-P0-P2-ROADMAP.md`. When the two plans overlap, implement the shared Reference Surface and pagination contracts there; this file owns Backreferences product behavior and acceptance evidence.

## Goal runner entrypoint

Start a fresh Codex goal with this exact objective:

```text
Implement /Users/svyatoslavkleshchev/thymer-reference-extravaganza/docs/BACKREFERENCES-IMPROVEMENTS-ROADMAP.md against /Users/svyatoslavkleshchev/thymer-backreferences. First reconcile the exact current tree, installed version, project memory, and /Users/svyatoslavkleshchev/thymer-reference-extravaganza/docs/REFERENCE-PLATFORM-P0-P2-ROADMAP.md; do not repeat work already shipped. Preserve page-level Backreferences ownership and use Reference Extravaganza only through versioned contracts. Complete one B phase at a time, run exact-tree and live Thymer gates, record commits/tests/install state in a handoff, and continue until B7 is proved or a true external blocker is documented.
```

## Baseline to verify

At authoring time:

- Manifest/runtime version: `0.17.0`; source commit `4eddaeb` at `origin/main`.
- The worktree had a user-owned untracked `.system-sync-include`; preserve it.
- The 95-check suite passed.
- Attributes broker support was scaffold-only: it invalidated a counter but did not render claim edges.
- README history stopped at `0.13`, below the installed implementation.

Already shipped and not new work: page/property/line/unlinked groups, filters, sort modes, alias-aware Link all, focused-line handoff from RefX, context expansion, editable rows, task toggles, Annotates, Series & same-name, persisted first paint, and RefX bridge navigation.

## Status ledger

| Phase | Scope | Initial status |
|---|---|---|
| B0 | Current-tree audit, documentation repair, regression fixtures | **Complete 2026-07-11** — choice-label async warm fix (v0.18.0), 95→117 behavioral checks, caps documented, README reconciled to v0.18. Handoff: `thymer-backreferences/docs/handoffs/B0-HANDOFF.md` |
| B1 | Direct current-line entrypoint and truthful provisional paint | **Complete 2026-07-11 (v0.22.0 + v0.23.1 review fixes)** — `Backreferences: Current line` palette command (SDK has no line context-menu hook — palette is the documented only entrypoint), caret stash adapter (passive listeners + 400 ms poll, never overwrites good stash with empty read, 3-min freshness, `__refx` bridge checked first), plugin-owned fallback line picker (no `window.prompt`, non-destructive on every edge case), panel reuse with retarget (no leak), truthful provisional paint via existing R2/R3 plumbing, stale completions guarded by `refreshSeq` (dead duplicate token removed v0.23.1); stash-vs-panel record mismatch falls back to picker (MAJ-5). 19 B1 smoke checks green in the 278-check suite. Live editor evidence deferred to user post-push. Handoffs: `thymer-backreferences/docs/handoffs/B1-HANDOFF.md`, roll-up `docs/handoffs/B1-B2-HANDOFF.md` |
| B2 | Safe unlinked-mention review, preview, apply and undo | **Complete 2026-07-11 (v0.23.0 + v0.23.1 review fixes)** — items 1-8 shipped: per-occurrence selection + Select page/all-loaded/Clear (`Preview selected (N)` bypasses the bulk cap; selection state per-panel, cleared on navigation/dispose per CRIT-1), Dismiss occurrence + page-scoped Ignore-phrase rules with review/remove surface (fingerprints = `lineGuid::normalizedPhrase` — no ordinals/ranges/hashes in identity; dismissals re-excluded on rebuild per MAJ-1), Link all replaced by Preview→Apply (pure preview with before/after segments, alias titles, skipped overlaps, `partial` labeling off UIT completeness; direct writer deleted MIN-1), segment-preserving span rebuild (rich segments byte-identical outside match spans; Unicode/emoji/punctuation/alias/overlap golden fixtures), pre-write canonical `[type, key]` hash gate (changed lines skipped + reported, extra-server-field-immune per B2-5), bounded operation receipts (`tlr_receipts_v1_<ws>`, max 20 ops, per-line before/after + skipped reasons, receipted even on throw via `finally`) with idempotent Undo that refuses stale reversal and preserves the receipt until full restoration (B2-3). 40 B2 + 14 v0.23.1 smoke checks green in the 278-check suite; harness terminates unaided. Live apply/undo evidence deferred to user post-push. Handoffs: `thymer-backreferences/docs/handoffs/B2-HANDOFF.md`, roll-up `docs/handoffs/B1-B2-HANDOFF.md` |
| B3 | Typed relationship configuration and cold-target resolution | **Complete 2026-07-12** — configurable parent/series/project/sibling roles, values() normalization, broker cold resolution, unavailable+retry rows (v0.24.0; review fixes in v0.25.1: seriesChanged render wiring, bridge gating, role-disable). Handoff: `docs/handoffs/B3-B6-HANDOFF.md` |
| B4 | Complete pagination and rich in-memory facets | **Complete 2026-07-12** — items 1-3 + 6 delivered v0.20.1 (R2); items 4-5 delivered v0.26.0 (R7): `collectChipFacets` covers 6 dimensions from `linkedAll` (kind/authored/derived/task/date/prop), facet counts show `≥N` when broker partial; `_serializeFacetExpression`/`_deserializeFacetExpression` nested AND/OR with canonical child sort; chip-filter semantic equivalence proved (smoke F6); platform `FilterExpressionV1` extension field (`_backrefChipFilters`) serialized and restored in B6 saved views (F5 fix). 36 pagination + 7 facet/filter smoke checks. Handoff: `docs/handoffs/B3-B6-HANDOFF.md` |
| B5 | Durable unread/changed Reference Inbox | **Complete 2026-07-11 (delivered by Reference Platform R3, v0.21.1)** — B5 items 1-5 all shipped: stable-occurrence-key store (`tlr_inbox_v1_<ws>`, schemaVersion 1, dismissal/ignore fields reserved for B2 actions), unread/changed counts + next/prev `x of n` + mark read/all/reset, move-with-unchanged-content ≠ changed (order-independent text-only hash), GC only off complete authoritative snapshots (30-day retention, 5k cap), client-local state with the R6/B6 sync seam documented (`docs/REFERENCE-INBOX.md`). 205 smoke checks green, harness exits unaided. Live two-device evidence deferred to user post-push. Handoff: `thymer-reference-extravaganza/docs/handoffs/R3-HANDOFF.md` |
| B6 | Saved synced Reference Views | **Complete 2026-07-12** — save/open/update via RefX referenceViews bridge, conflict pick-a-head, local-fields excluded (v0.25.0; review fixes v0.25.1: conflict-on-open guid, target-mismatch refuse+warn, focused-panel targeting, load-order lazy subscribe). Handoff: `docs/handoffs/B3-B6-HANDOFF.md` |
| B7 | Performance, accessibility, live conformance and release | **Complete (offline gates); live gates deferred to user post-push** — 361 smoke checks + 2 test/*.cjs suites green; harness terminates unaided; both load orders (broker-first / plugin-first) covered in smoke script lines 4526-4553; hot-reload singleton disposal covered (B1 `disposeCaretStashAdapter` smoke line 6067); all interactive buttons carry `aria-label` (inbox nav/badges, filter, sort, clear, refresh, picker, peek/open-to-edit); no `window.prompt/confirm/alert`; no `data.createNewRecord`; no `prop.get(` for relations (guarded in `_normalizeRelationValues`); no numeric-offset cursor resume. Live performance (no per-row `getRecord()` waterfall), two-client inbox, and Link-all apply traces deferred to user post-push per roadmap offline rule. Handoff: `thymer-reference-extravaganza/docs/handoffs/R11-B7-HANDOFF.md` |

Only change a status after its exit gates pass on the exact tree.

## Per-phase documentation checkpoint

Before each `B` phase, re-open the official SDK entries for every API it uses, the current RefX/Reference Surface contract, and the exact Backreferences functions named by B0. Record exact sources in the phase handoff. An absent current-line, selection, cursor, transaction or property API is a capability gap—not permission to invent one. Add phase-specific static guards for async-without-await, silent caps, source-string-only contracts and browser prompt APIs.

## Ownership boundary

Backreferences owns the page/line aggregate reading surface: groups, complete browsing, unlinked review, sorting, facets, inbox state and saved views. It does not own inline authoring, badges, transclusion, Workbench, graph analytics, typed-claim creation, structural transactions or version history.

Consume these contracts when available:

- `window.__thymerReferenceSurfaceV1`: normalized edges, occurrences, target resolution, completeness and revisions.
- `window.__refx`: navigation/embed/name compatibility only until superseded by a documented Reference Surface capability.
- `window.__thymerClaimsV1`: only through the shared Reference Surface after R1; do not add a second claims scan.
- Version Ledger checkpoints for bulk operations when present.

## Phase B0 — freeze truth before extension

### Read first

- Current `plugin.js`, `plugin.json`, README, changelog and all tests.
- Project memory and `git status`; do not overwrite dirty or untracked files.
- Official Thymer SDK `types.d.ts` and app-plugin examples.
- Reference Platform R0–R3 contracts.
- `/Users/svyatoslavkleshchev/Downloads/flash-free-plugins.md`.

### Implement

1. Add tests for currently untested shipped behavior: choice breadcrumbs, Annotates, configurable line-ref properties, Series, same-name grouping, persisted linked rows and authoritative-zero cleanup.
2. Fix `_ensureChoiceLabelMap`: it must never treat `data.getAllCollections()` as synchronous or cache `null` from a Promise. Fetch collections once in an async warm phase, build all choice maps from that array, then expose synchronous reads from the completed cache.
3. Make warm-up idempotent, generation-guarded and hot-reload-safe; concurrent calls share one Promise.
4. Reconcile README, changelog, manifest, runtime tell and configuration descriptions.
5. Document every cap and whether its result is complete, partial or provisional.

### Exit gates

- Existing 95 checks and all new behavioral tests pass.
- Cold, warm, rejected-Promise and reload races for choice labels pass.
- No async API is called from a synchronous helper.
- Docs describe the exact current product before B1 begins.

## Phase B1 — direct line entry and truthful first paint

### Implement

1. Register `Backreferences: Current line` in the command palette.
2. Add the same action to the appropriate line context menu if the current SDK exposes a supported hook; otherwise document why the command is the only entrypoint.
3. Resolve the active line only through a narrow RefX adapter that B0 has live-proven and contract-tested; the public SDK currently has no documented current-line getter. If that adapter is absent/degraded, open a plugin-owned line picker. Never invent an SDK method or spread DOM selectors through Backreferences. Fail non-destructively when no stable line GUID is available.
4. Open or focus one Backreferences panel scoped to that line; repeated invocation updates the existing panel instead of leaking panels or subscriptions.
5. Render disk-persisted results immediately but visibly mark the section `Checking…`/`Cached` until the matching live generation completes.
6. On authoritative zero, remove stale rows in the same reconciliation commit and show a truthful empty state.
7. Do not let a stale target/generation completion replace a newer line scope.

### Verification

- Command works from text, task, empty and ref-containing lines.
- No selection, deleted line and cold handle cases fail safely.
- Cached positive -> live zero, cached zero -> live positive and target-switch races are covered.
- Keyboard focus lands in the panel without stealing an active editor unexpectedly.

## Phase B2 — reversible unlinked-mention review

### State and identity

For unlinked matches, the stable group key uses page/record GUID, source line GUID and normalized target phrase—never absolute range, match ordinal or source hash. Reconcile multiple instances by surrounding segment/text context and sequence matching. If two matches remain indistinguishable, share dismissal/read state at the group level rather than inventing stable identities. Current range, hash and query revision are locator/version data; a hash change forces revalidation/re-anchoring before applying or honoring an instance-specific dismissal. Display text alone is never identity.

### Implement

1. Add per-occurrence selection, Select page, Select all loaded and Clear selection.
2. Add `Dismiss occurrence`, `Ignore this phrase on this page` and a review surface for removing ignore rules.
3. Keep ignore state versioned and local in B2; R6 may add explicit sync. Never hide a match globally because one page occurrence was dismissed.
4. Replace direct `Link all` with Preview -> Apply. The preview shows exact lines, match ranges, replacement aliases, skipped ambiguous overlaps and the current completeness state.
5. Preserve every nonmatching segment and metadata field. Rebuild only the selected plain-text spans into `ref` segments; never flatten a rich line.
6. Re-read each source hash immediately before write. Changed lines are skipped and reported, not patched against stale offsets.
7. Backreferences owns the verified `setSegments` writes because it owns phrase matching and span reconstruction. Write an operation receipt containing before/after segments per changed line and expose Undo until the source hash diverges. Version Ledger may add a durable checkpoint; Outline Refactor is structural and is not the executor for Link all.
8. If results are partial, label Apply as applying only the selected/loaded set.

### Verification

- Multiple matches, overlapping phrases, Unicode, punctuation, aliases and rich segment mixtures have golden fixtures.
- Preview is side-effect-free.
- Mid-preview remote edits are skipped safely.
- Partial failure reports exact applied/skipped lines; Undo is idempotent and refuses destructive stale reversal.

## Phase B3 — typed relationships and cold resolution

### Implement

1. Replace the title-equality Series heuristic with explicit configurable property roles. Initial roles: `parentProperties`, `seriesProperties`, `projectProperties`, and optional `siblingProperties`.
2. Render `Parent`, `Series`, `Project`, `Sibling` and `Same name` as distinct relationship kinds. Same-name discovery remains a separate text heuristic and never upgrades itself to a typed relation.
3. Normalize relation values through the documented property `values()` shape. Never use `prop.get()` for relation values.
4. Resolve cold annotation/relationship targets through Reference Surface `resolveTarget`; use the existing RefX compatibility bridge only in degraded mode.
5. Show unresolved GUIDs as explicit unavailable targets with retry/diagnostic state, not silently disabled truncated labels.
6. Cache by Reference Surface generation/revision and invalidate only affected targets.

### Verification

- Different titles connected by a configured Series relation group correctly.
- Same titles without a relation remain Same name only.
- One target in multiple roles is deterministically deduplicated or intentionally shown per role, as documented.
- Cold->resolved and resolved->deleted transitions update once without body scans.

## Phase B4 — complete pagination and facets

Implement Reference Platform R2 in this surface:

1. Consume cursor-based occurrence envelopes; remove query-time hard slices as claims of completeness.
2. Provide explicit first page, Next 50/Load more and `showing n of total/at least n` language.
3. Cancel continuation on target, query, filter, sort or revision changes.
4. Facet the authoritative snapshot by collection, reference kind, property, authored/derived, task state and date range without rerunning the source query.
5. Serialize nested AND/OR filter expressions deterministically.
6. Keep a bounded DOM with measured row recycling/virtualization only after functional correctness.

Exit requires 0/1/30/31/250/2,000+ fixtures with no duplicate/skipped rows and truthful completeness under filter and remote-update races.

## Phase B5 — durable Reference Inbox

Implement Reference Platform R3:

1. Track last-seen source hash, last-read hash/time and dismissal fingerprints by stable occurrence ID.
2. Add unread/changed counts, next/previous unread, `x of n`, mark read, mark all read and reset.
3. A move with unchanged content is not Changed; same occurrence with changed source hash is.
4. Garbage-collect only after a complete authoritative snapshot proves absence for the configured retention window.
5. Keep local state per client by default. Synced state is opt-in under B6 with deterministic merge rules.

## Phase B6 — synced saved Reference Views

Use the platform `ReferenceViewV1`; do not invent a Backreferences-only schema.

- Save target(s), query, nested facets, sort, context depth, display mode, descendant behavior and page size.
- Keep focus, scroll and transient expansion local.
- Migrate legacy settings idempotently.
- Prove two-client open/update/conflict/delete behavior in live Thymer.

## Phase B7 — release gates

- Full Backreferences suite plus cross-plugin fixtures.
- Both load orders with RefX and Attributes; broker unavailable/degraded/ready transitions.
- Hot reload with exactly one panel, observer, event subscription and style node.
- Keyboard-only navigation, visible focus, semantic labels and reduced-motion behavior.
- Live traces for cold panel, warm cached paint, pagination, Link-all preview/apply and remote reconciliation.
- No full workspace/body scan on filter/sort; no per-row `getRecord()` waterfall.
- Manifest/header/runtime/changelog versions agree; README matches commands/config.

## Anti-patterns

- No fourth reference query engine.
- No source-string-only contract test in place of rendered edge behavior.
- No silent caps, stale rows presented as current, or optimistic success after a rejected write.
- No `window.prompt`, `confirm` or `alert`.
- No wholesale row rebuild on every filter keystroke when keyed reuse is possible.
- No cross-repo edits without a clean-tree check and explicit phase need.

## Phase handoff

```text
Phase and status:
Backreferences commit/version:
Reference Surface contract/version:
Requirements proved:
Tests and counts:
Live records/line GUIDs used:
Cold/warm/remote evidence:
Performance trace summary:
Known gaps:
Commit/push/install state:
Next phase entrypoint:
```
