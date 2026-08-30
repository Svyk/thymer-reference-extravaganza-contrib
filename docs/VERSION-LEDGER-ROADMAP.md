# Time Machine / Version Ledger — Goal-Executable Roadmap

This is the durable build plan for a proposed global Thymer plugin. No repository existed when this plan was authored. The product is named **Version Ledger** here; “Time Machine” is the user-facing history surface, not a second plugin.

## Goal runner entrypoint

```text
Implement /Users/svyatoslavkleshchev/thymer-reference-extravaganza/docs/VERSION-LEDGER-ROADMAP.md. First audit all current Thymer plugin repositories and project memories to confirm no version-history owner now exists and reconcile any work completed since 2026-07-11. If the capability is still absent, create /Users/svyatoslavkleshchev/thymer-version-ledger as one global plugin with a .system-sync-include marker and project memory. Complete V0 through V6 one phase at a time. Never capture secrets or claim a restore succeeded without rereading the exact state. Record exact commits, tests, retention/storage impact, live Thymer evidence, push and install state in every handoff; continue until all release gates pass or a true external blocker is documented.
```

## Product promise

Version Ledger records meaningful line, record-property and structural change sessions; shows rich semantic diffs; creates named checkpoints; previews inbound-reference impact; and performs selective, verified restoration. It is not a second backup system, git replacement, collaboration audit log or keylogger.

Better-than-Roam target: body and property changes in one timeline, labeled checkpoints, rich-segment-aware diffs, reference-impact previews, selective restore and receipts that Outline Refactor and RefX can consume.

## Status ledger

| Phase | Scope | Initial status |
|---|---|---|
| V0 | Discovery, privacy/storage decision, contracts and fixtures | Not started |
| V1 | Event capture, settle grouping and durable local ledger | Not started |
| V2 | Semantic timeline and rich diffs | Not started |
| V3 | Selective verified restore | Not started |
| V4 | Named checkpoints and cross-plugin operation/checkpoint API | Not started |
| V5 | Optional sync/export, retention and recovery tooling | Not started |
| V6 | Scale, security, accessibility and release | Not started |

## Per-phase documentation checkpoint

Before every `V` phase, cite the current official event/storage/record/line/property APIs and the exact local owner-plugin examples being copied. Re-run V0 discovery whenever an API or persistence assumption is not documented. Each handoff must include those sources, a verification checklist, and static guards against unsupported Global Plugin record creation, unawaited writes, hidden network calls and title-based identity.

## Architectural decisions to freeze in V0

1. **Local history by default.** Use IndexedDB for the high-volume ledger. Do not create a Thymer line for every edit; that would create feedback loops, workspace noise and unbounded sync traffic.
2. **Explicit sync only.** Named checkpoints may be synced through a plugin-owned Thymer record/companion collection after V4, with clear size/retention limits. V0 must choose and document the exact supported path: `PluginCollectionAPI.createRecord()` in a known collection, or a visibly provisioned companion from `data.createCollection()` plus verified configuration save. Never use unsupported Global Plugin `data.createNewRecord()`. Raw edit history remains local unless a later, separately approved encryption/sync design proves safe.
3. **Meaningful settled snapshots, not keystrokes.** Group event bursts by target and settle window, while preserving the first-before and final-after state. Flush on navigation, blur, structural operation, checkpoint and unload where supported.
4. **Rich canonical state.** Preserve segment types, aliases, references, tasks, dates, metadata and property value shapes. Plain rendered text is only a search/display derivative.
5. **Verified restore.** Every restore uses an optimistic fingerprint precondition: immediately before writing, the current source fingerprint must match the preview fingerprint or the restore replans/refuses, and the result is reread afterward. The SDK offers no atomic compare-and-swap, so a race remains a verified failure/recovery receipt rather than a false atomicity claim.
6. **Identity over position.** Lines are keyed by stable GUID and owning record; structural positions are paths recorded for context, not identity.

## Core data contracts

`LedgerEntryV1`:

```js
{
  id, workspaceGuid, sessionId, sequence,
  target: { kind: "line" | "record-properties" | "structure", guid, recordGuid },
  operation: "create" | "update" | "move" | "delete" | "restore" | "checkpoint",
  before: { fingerprint, state } | null,
  after: { fingerprint, state } | null,
  context: { parentGuid, previousSiblingGuid, path, collectionGuid },
  actor: "local-user" | "local-plugin" | "remote-or-unknown",
  observedAt, settledAt,
  provenance: { sourcePlugin, operationId } | null,
  schemaVersion: 1
}
```

`OperationCheckpointV1` contains an immutable ordered entry set, label, reason, source plugin/operation ID, created time, status and integrity hash. Never mutate a checkpoint after publishing it; append a superseding checkpoint/receipt.

## Phase V0 — discovery and frozen contract

### Read before implementation

- Official Thymer SDK types/examples for event payloads, records, lines, properties, create/move/delete and reload lifecycle.
- Current RefX, Backreferences, Reference Graph, Attributes, Datacore and Notes Management APIs.
- Outline Refactor roadmap and Reference Platform R4/R9.
- Current privacy, backup and local-storage conventions in installed global plugins.

### Deliverables

1. Capability audit proving no existing plugin owns durable revision history.
2. Event matrix: event name/payload, synchrony, local/remote distinguishability, ordering, missing-before-state risk and reload behavior.
3. Canonical serializers and fixture schema for text/task/ref/linkobj/date/code/property/structural states.
4. Storage budget and retention defaults with migration/version rules.
5. Threat model: sensitive text at rest, multi-workspace separation, export, deletion and plugin uninstall.
6. Failure contract: unavailable handles, missed before-state, quota exhaustion, corrupt entry, stale restore and partial structural apply.

### Exit gates

- All APIs are cited from current docs or a labeled live probe.
- PII/sensitive history is local by default and deletable per workspace/time range.
- Fixtures prove deterministic serialization independent of object key/order noise.

## Phase V1 — capture and local ledger

1. Register supported line/record/reload events with exact handler IDs; dispose them on hot reload.
2. Maintain a bounded pre-change cache only for recently observed targets. If a reliable before-state was not observed, mark it unknown rather than inventing it.
3. Coalesce bursts per target into one edit session: first known before, final settled after, monotonic sequence.
4. Split sessions on navigation, structural operation, explicit checkpoint, long idle and target change.
5. Dedupe identical fingerprints and plugin-caused feedback events by operation ID.
6. Write entries transactionally to IndexedDB, partitioned by workspace. Backpressure capture when quota/latency limits are reached; surface degraded state.
7. Add retention by age and byte budget, with pinned checkpoints exempt only within a separate checkpoint budget.
8. Provide diagnostics: capture state, last sequence, queue depth, bytes, oldest/newest entry and dropped/degraded counts.

Verification covers rapid typing, task toggles, alias changes, property updates, line moves, reload mid-burst, duplicate events, remote changes, quota failure and two workspaces.

## Phase V2 — timeline and semantic diffs

1. Register one global panel and commands: `Version history: Current line`, `Current record`, `Recent changes` and `Create checkpoint`.
2. Group entries by meaningful edit session, record and time; virtualize long histories.
3. Diff normalized segment arrays semantically: text spans, reference target/title, task state, dates, code and metadata. Do not stringify whole objects as the primary diff.
4. Diff record properties by stable field ID and normalized typed value; show display labels as decoration.
5. Show structural moves as old/new parent and sibling context.
6. Resolve names lazily in batches with generation guards; timeline remains usable when targets are deleted/cold.
7. Keyboard navigation, screen-reader labels and copyable plain-text diff summary.

Exit: golden diffs are stable, large timelines keep bounded DOM, and opening history does not scan the workspace.

## Phase V3 — selective restore

1. Allow restoring a whole settled entry, selected segment/property changes, or a line snapshot where the SDK supports faithful writes.
2. Preview current vs historical state, inbound reference impact from Reference Surface, exact writes and unsupported fields.
3. Re-read live state immediately before apply. Fingerprint mismatch forces rebase/re-preview; never overwrite silently.
4. For simple line content, use `setSegments` and verify the persisted result. Preserve line GUID.
5. For properties, write only selected fields and verify normalized values. Never erase fields absent only because they were unavailable in the historical schema.
6. Structural restore delegates to Outline Refactor. Without it, show a non-mutating plan/export instead of a partial homemade transaction.
7. Every restore first writes a restore checkpoint and then appends a restore receipt referencing the new state.
8. If a write rejects or verification differs, report partial failure precisely and retain both pre-restore state and recovery instructions.

Tests include stale current state, deleted target, schema drift, unknown before-state, partial property selection, failed verification and undoing a restore.

## Phase V4 — checkpoint and operation API

Expose a hot-reload-safe versioned broker such as `window.__thymerVersionLedgerV1`:

```js
{
  apiVersion: 1,
  status(),
  beginOperation({ sourcePlugin, operationId, label, targets }),
  captureBefore(handle, canonicalState),
  captureAfter(handle, canonicalState),
  commitOperation(handle),
  abortOperation(handle, diagnostics),
  checkpoint(query),
  subscribe(listener)
}
```

- Handles are generation-scoped, idempotent and expire safely.
- Commit verifies every declared target has an outcome; missing states are explicit.
- Outline Refactor is the first consumer; RefX bulk actions and Reference Graph repair follow.
- Consumers work without Version Ledger using their own bounded receipt, but never claim a durable checkpoint.
- Contract tests exercise both plugin load orders, reload during operation, duplicate commit/abort and unavailable/degraded state.

## Phase V5 — explicit sync, export and recovery

1. Add opt-in synced **named checkpoints only**, stored in plugin-owned Thymer records with schema/version/hash and strict byte caps.
2. Avoid capture loops by tagging/ignoring the plugin's own checkpoint records.
3. Conflict policy is append-only immutable checkpoint identity; labels may be superseded, never last-writer overwrite checkpoint content.
4. Export selected history/checkpoints as versioned JSON after user-approved file selection; import validates schema, workspace mapping and hashes before preview.
5. Provide delete-all, delete range/target, retention preview, corrupt-entry quarantine and storage compaction.
6. Document what uninstalling the plugin leaves behind and how to purge it.

## Phase V6 — release gates

- Deterministic serializer/diff/restore/contract suites plus migration fixtures for every schema version.
- 100k ledger-entry benchmark: bounded panel DOM, indexed target/time lookup and no main-thread database scans.
- Typing trace with capture enabled vs disabled; capture work is queued and does not cause visible typing regression.
- Crash/reload/quota/corruption/clock-change/two-client matrix.
- Security review confirms no network calls, no secrets in logs and workspace partitioning.
- Live line/property restore and Outline operation restore are verified in a disposable fixture record.
- Manifest/header/runtime/changelog versions agree; install and cold reload pass.

## Anti-patterns

- No per-keystroke permanent row, hidden cloud upload or full-workspace snapshot loop.
- No plaintext rendered-text-only history that loses rich segments.
- No restore by display title or array index.
- No destructive automatic pruning of named checkpoints without an explicit budget policy.
- No unsupported structural mutation disguised as successful recovery.
- No global API without version, status, generation, disposal and load-order tests.

## Handoff template

```text
Phase/status:
Repository/commit/version:
SDK evidence and unresolved limits:
Schema/storage migration:
Tests/counts:
Storage and typing benchmarks:
Live capture/diff/restore evidence:
Privacy/retention state:
Push/install state:
Next phase objective:
```
