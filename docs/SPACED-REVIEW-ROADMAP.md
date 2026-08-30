# Spaced Review / Incremental Reading — Goal-Executable Roadmap

This is the durable plan for an optional new global Thymer plugin. No repository existed at authoring time. **Spaced Review** is the product; incremental reading is one capture workflow inside it.

## Goal runner entrypoint

```text
Implement /Users/svyatoslavkleshchev/thymer-reference-extravaganza/docs/SPACED-REVIEW-ROADMAP.md. First audit current Thymer plugins and memories to confirm no review scheduler now owns this workflow and reconcile later work. If still absent, create /Users/svyatoslavkleshchev/thymer-spaced-review as one global plugin with a .system-sync-include marker and project memory. Complete S0 through S6 sequentially. Preserve source provenance, keep scheduling deterministic and offline, never rewrite source content without explicit preview, and prove date/time-zone behavior with clock-controlled tests. Record commits, tests, live queue evidence, push and install state in every handoff.
```

## Product promise

Turn any stable Thymer line, reference, annotation or supported highlight into a review item; schedule it locally; review from a daily queue; jump back to the exact source; and optionally derive cloze or incremental-reading prompts without duplicating the source body.

It is not a generic task manager, AI flashcard service, replacement Journal, or source-content database. The source remains Thymer; review state is a small, explicit layer keyed by GUID.

## Status ledger

| Phase | Scope | Initial status |
|---|---|---|
| S0 | Ecosystem audit, scheduler/schema decision, fixtures | Not started |
| S1 | Capture, source identity and review-item persistence | Not started |
| S2 | Deterministic daily queue and grading | Not started |
| S3 | Cloze and incremental-reading workflows | Not started |
| S4 | Reference/highlight interoperability and source health | Not started |
| S5 | Analytics, import/export and optional synced preferences | Not started |
| S6 | Time-zone, scale, accessibility and release | Not started |

## Per-phase documentation checkpoint

Before every `S` phase, cite the current collection/configuration/property/event APIs, the selected scheduler's primary source/license/version, and the source-owner adapter contract used for navigation. Missing atomic/CAS/current-line APIs remain explicit limits. Every handoff includes deterministic clock vectors and static guards against unsupported Global Plugin record creation, hidden network calls, source duplication and title/text identity.

## Ownership and storage decisions

1. Review items and scheduling state must sync across Thymer clients. The product remains one Global Plugin, but it intentionally provisions one companion **Spaced Review Items** CollectionPlugin as its storage/schema surface through the documented `data.createCollection()` plus collection configuration save path. That companion is not a second global product. If creation/configuration is unavailable at runtime, require a user-approved one-time setup and stop; do not fall back to an arbitrary existing collection. LocalStorage/IndexedDB holds only cache, transient session and device presentation settings.
2. Store source GUID, prompt/answer overrides and scheduling metadata; do not copy full source content by default.
3. When the source changes, show a source-changed state using a canonical hash. Do not silently reset scheduling or overwrite custom prompts.
4. One deterministic scheduler is frozen in S0. Evaluate a current, documented FSRS implementation against a simpler SM-2 baseline; choose based on license, offline size, deterministic serialization and testability. Do not invent a hybrid formula mid-implementation.
5. All due calculations use an explicit IANA time zone and local-day boundary; store instants in UTC plus the scheduling zone/version.

## Core schema

`ReviewItemV1`:

```js
{
  schemaVersion: 1,
  id,
  source: { kind: "line" | "record" | "reference" | "highlight", guid, recordGuid, locator },
  sourceHash,
  mode: "basic" | "cloze" | "incremental",
  promptOverride: null | RichSegments,
  answerOverride: null | RichSegments,
  cloze: null | { group, ordinal, ranges, sourceHash },
  state: "active" | "suspended" | "orphaned" | "retired",
  schedule: { algorithm, algorithmVersion, dueAt, stability, difficulty, reps, lapses, lastReviewedAt },
  provenance: { createdFrom, createdAt, tags },
  revision
}
```

The exact scheduler fields may change in S0, but every migration must be explicit and old review logs remain interpretable.

`ReviewGradeEventV1` is append-only and contains an idempotency ID, item GUID, base schedule revision/fingerprint, grade, reviewed instant, client/session identity, algorithm version and derived proposed schedule. The event log is the concurrency truth; mutable schedule fields on the item are a repairable projection.

## Phase S0 — discovery and frozen semantics

### Read before implementation

- Current Journal, Task Engine, Reference Extravaganza, Backreferences, Attributes, media/highlight and PDF-related plugin capabilities.
- Reference Platform R1 and current source-navigation bridges.
- Official SDK types/examples for collections, records, properties, commands, panels, events and navigation.
- Scheduler primary documentation/source and license for any selected implementation.

### Deliverables

1. Ecosystem audit proving this is not duplicating Tasks/Journal/Templates.
2. Review item collection/property schema using stable field IDs/names and migration rules.
3. Scheduler decision record with exact equations/library version, grade mapping and clock-controlled reference vectors.
4. Source-kind capability matrix: stable identity, content extraction, jump, change event and unavailable behavior.
5. Duplicate policy: same source+mode+cloze ordinal updates/focuses the existing item unless user explicitly creates another variant.
6. Privacy/offline statement and no-network default.

Exit requires deterministic scheduler vectors across DST/leap-day/time-zone cases and fixture serialization for every source type.

## Phase S1 — capture and persistence

1. Provision the companion collection/schema idempotently through documented collection-plugin APIs. Never identify it solely by display title after creation; retain stable GUIDs/config and verify saved configuration.
2. Add commands: `Review: Add current line`, `Add current reference`, `Open source`, `Suspend item` and `Open queue`.
3. Resolve current source through supported editor APIs or RefX/Reference Surface. If no stable GUID exists, refuse with guidance instead of storing text-only identity.
4. Create/update one review item with source hash, mode, optional prompt/answer overrides and default new-item schedule.
5. Preserve overrides as rich segments where supported; sanitize/normalize only for hashing and search.
6. Build an event-maintained source status cache. Cold/unavailable source is explicit and retryable.
7. Exclude plugin-owned review records from capture suggestions and reference feedback loops.

Verification: duplicate capture, deleted/cold source, same text/different GUID, alias/reference source, task line, reload and two-client schema initialization.

## Phase S2 — daily queue and grading

1. Register one global queue panel with Due, New, Learning and Suspended counts.
2. Query review records by indexed due/status properties; do not scan every workspace body.
3. Build the day's queue deterministically with configurable new/review limits, stable tie-breaks and explicit backlog counts.
4. Review flow: prompt -> reveal -> grade buttons whose meaning and next interval preview are visible.
5. Append one `ReviewGradeEventV1` first, using an idempotency ID so repeated same-client submission is harmless; then update the item schedule projection and reread it. The public SDK has no atomic compare-and-swap, so never describe the two writes as atomic.
6. Disable/debounce duplicate same-panel submission, but retain simultaneous cross-client events. Deterministically reconcile events that share a base revision; if divergent grades cannot be ordered without changing meaning, mark the item `Review conflict` and ask the user to choose rather than silently dropping one.
7. Rebuild a missing/stale schedule projection from the append-only event log. Every queue read detects a projection/event mismatch before grading again.
8. Undo last grade by appending a compensating event. It never deletes history and must reconcile any later/conflicting event first.
9. Journal integration is opt-in and summary-only; do not add one Journal line per card.

Exit: clock-controlled grade vectors, queue ordering, day rollover, offline reload, stale revision and double-submit tests; live keyboard-only review loop passes.

## Phase S3 — cloze and incremental reading

### Cloze

- Create cloze ranges from explicit user selection or a reviewed preview.
- Store source hash and semantic range/segment anchors; never rely only on rendered character offsets.
- Multiple clozes may share one source but have stable ordinal/group identities.
- Source changes mark clozes `Needs review`; attempt non-destructive re-anchoring and show the diff before accepting.
- Do not inject cloze markup into source text by default.

### Incremental reading

- `Extract next prompt` creates a review item referencing a selected source line/subtree/highlight.
- Provide source breadcrumb, surrounding context and next/previous source navigation.
- Optional “continue later” state records a stable locator, not a copied article body.
- Creating child questions/notes uses normal Thymer lines/refs through explicit user action.
- AI prompt generation, if ever added, is a later opt-in adapter with preview and provenance; it is not required for S3.

Verification includes Unicode/rich segments, multiple clozes, overlapping selections, changed source re-anchor, missing source and no-source-mutation assertions.

## Phase S4 — reference and highlight interoperability

1. Consume Reference Surface target resolution and navigation when ready; retain a documented degraded direct SDK path.
2. A reference review item may test the alias/prompt while the answer resolves live target content; source and target identities remain distinct.
3. Support highlight sources only through a stable GUID/locator contract exposed by their owner plugin. Do not scrape highlight DOM or private storage.
4. Show orphan, moved, changed and target-deleted states; offer Retarget, Retire and Open last known context.
5. Retarget preview preserves review history but creates an explicit provenance transition and refreshes source hash.
6. Reference Graph health may report orphaned review sources through a narrow read-only adapter.

Contract tests cover plugin load order, unavailable/ready transitions, hot reload and source owner version mismatch.

## Phase S5 — analytics and portability

1. Dashboard: due/backlog, reviews/day, retention/grade distribution, lapses and source categories; define each metric exactly.
2. Keep analytics incremental from review logs; no full recomputation on panel open.
3. Export/import versioned JSON and a conservative CSV subset through user-approved files. Import previews duplicates, schema changes and time-zone mapping.
4. Add filtered bulk suspend/retire/reschedule with preview and revision checks.
5. Sync queue limits and scheduler preferences only when explicitly enabled; device UI layout remains local.
6. Never gamify with misleading streaks that ignore time zone or backfilled reviews.

## Phase S6 — release gates

- Scheduler reference-vector, migration, schema, capture, cloze, queue, grading, undo and interoperability suites.
- DST spring/fall, leap day, travel/time-zone change, manual clock change and offline catch-up tests.
- 100k review-item query/analytics benchmark with indexed reads and bounded DOM.
- No work on ordinary typing except cheap event rejection; no body-wide scan.
- Keyboard-only capture/review/retarget, screen-reader labels, focus recovery and reduced motion.
- Two-client simultaneous-grade reconciliation/conflict behavior and live source edit/delete/restore matrix.
- Manifest/header/runtime/changelog version agreement, hot-reload singleton/disposal and cold install pass.

## Anti-patterns

- No source duplication by default, text/title identity or DOM-scraped highlights.
- No hidden network/AI dependency or non-deterministic scheduler update.
- No local-only schedule presented as synced.
- No silent reset on source edit, duplicate capture or algorithm migration.
- No per-card Journal spam, full workspace body scan or review panel full rebuild per grade.
- No invented atomicity; verified revision/receipt behavior must match the UI claim.

## Handoff template

```text
Phase/status:
Repository/commit/version:
Schema/scheduler version:
Requirements proved:
Tests/reference vectors:
Live source/queue evidence:
Time-zone cases:
Scale/accessibility evidence:
Push/install state:
Next phase objective:
```
