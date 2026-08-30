# Thymer Line Aliases — Goal-Executable Roadmap (L0-L6)

## Objective

Extend the shipped A0-A7 record-alias platform to stable Thymer line GUIDs in
full, without weakening `ALIAS-SURFACE-V1`, adding a workspace scan, or making
Backreferences/Reference Graph independent alias authorities.

Target releases:

- Reference Extravaganza `4.0.0`
- Backreferences `0.29.0`
- Reference Graph `0.7.0`

## Non-negotiable semantics

1. One line may have many durable aliases.
2. `((` resolves aliases to the real line GUID and labels the current text and
   owning record. `[[` remains record-only.
3. Record and line alias namespaces remain separate.
4. Line edits and GUID-preserving moves retain aliases; deletion creates a
   health-visible tombstone rather than retargeting.
5. Explicit backlinks aggregate by line GUID. Alias unlinked mentions appear
   only in line-focused reference review.
6. No automatic ambiguity choice, promotion, suggestion write, rename
   propagation, or health repair.
7. No whole-workspace line scan. Storage and index size scale with aliased lines,
   not total lines.
8. Existing record-alias, picker, Workbench, reference-count, and Backreferences
   behavior remains green.

## Requirement traceability

| ID | Requirement | Phase |
|---|---|---|
| LC1 | Multiple durable aliases per stable line GUID | L1 |
| LC2 | Registry-only persistence with verified, serialized writes | L1 |
| LC3 | Payload-first edit/move/delete/undelete lifecycle | L1 |
| LC4 | Additive `lineAliases` broker and bridge, separate namespace | L1 |
| LC5 | `((` alias search, labels, ranking, `alias:` filter | L2 |
| LC6 | Alias selection inserts a real line-GUID ref with alias title | L2 |
| LC7 | Manage aliases from current line and line-reference menu | L3 |
| LC8 | Promote one-off line display aliases explicitly | L3 |
| LC9 | Rename preview/apply/undo over existing line refs | L3 |
| LC10 | Three-use suggestion, one best candidate per line, Add-only | L3 |
| LC11 | Line-focused title+alias unlinked mentions and facets | L4 |
| LC12 | Preview/apply/undo writes matched alias to line ref | L4 |
| LC13 | Deleted target and line-line collision health, all-GUID routes | L5 |
| LC14 | Full compatibility, perf, docs, version, push evidence | L6 |

## Status ledger

| Phase | Scope | Status |
|---|---|---|
| L0 | Baseline, frozen contract, fixtures, budgets | Complete |
| L1 | RefX data layer, lifecycle, broker/bridge | Complete |
| L2 | `((` discovery, filtering, ranking, insertion | Complete |
| L3 | Management, promotion, rename/undo, learning | Complete |
| L4 | Backreferences line-focused alias review | Complete |
| L5 | Reference Graph health | Complete |
| L6 | Conformance, docs, releases, push | Complete |

## Phase L0 — baseline and contract

- Freeze `docs/LINE-ALIAS-SURFACE-V1.md`.
- Freeze `test/fixtures/line-alias-surface-v1.json` with edit, move, delete,
  undelete, collision, Unicode, whitespace, ambiguity, and cap cases.
- Record exact baselines: RefX 485, Graph 63, Backreferences 386 plus contracts.
- Add a contract test that protects separate namespaces and the no-scan rule.

Exit: fixture/contract test green; no production change.

## Phase L1 — RefX data and contract

- Add registry-backed `LineAliasSetV1` indexes keyed by line GUID and normalized
  alias, truthful 10,000-line cap, per-line queues, verified append/re-read.
- Hydrate only the RefX Line Alias Registry; resolve saved targets opportunistically
  and in bounded chunks. Never enumerate the workspace for aliases.
- Maintain current text, owner, and status with payload-first line events.
- Add `supportsLineAliases`, `broker.lineAliases`, and
  `window.__refx.lineAliases`, plus generation-safe disposal.

Exit: persistence, convergence, lifecycle, ambiguity, cap, 10k lookup, and
anti-pattern tests green.

## Phase L2 — line picker

- Merge line-alias rows synchronously into `((` before remote line results.
- Render `Alias ↳ current text · record`; dedupe alias/text hits by line GUID.
- Add line-mode `alias:` filtering; never leak record aliases into `((`.
- Insert `{type:"ref",text:{guid:<line>,title:<alias>}}` and record bounded
  frecency. Tab on a highlighted fuzzy line offers explicit alias-create then
  insert; Enter preserves ordinary line insertion/drill behavior.

Exit: exact/prefix/fuzzy, ambiguity, filter composition, stale-session, insertion,
and synchronous-first performance tests green.

## Phase L3 — line alias UX and maintenance

- Commands: `RefX: Aliases for this line…`; line-reference menu: `Aliases…`.
- Keyboard CRUD modal labels owner/current text and active/deleted state.
- Extend display-alias promotion to line targets with separate dismissal tokens.
- Rename preview/apply/undo reuses segment-preserving hash/receipt discipline.
- Learn from three distinct authored ref edges to the same line; one best proposal
  per line, broker-generation/revision guarded, Add-only.

Exit: real command/menu paths, explicit writes, stale guards, bounded receipts,
hot-reload cancellation, and zero-layout regression tests green.

## Phase L4 — Backreferences

- When `focusLineGuid` is set, fetch line alias vocabulary from the broker and
  query current line text plus every alias through the existing UIT index.
- Render exact `via "Alias"` labels and separate title/per-alias facets.
- Keep results scoped to the focused line GUID and phrase-specific inbox/dismissal
  identities. Preview/apply/undo writes the focused line GUID and matched alias.
- Degrade visibly to current-line-text mentions when RefX line aliases are absent.

Exit: focused-line title/alias results, collisions, facets, receipts, degradation,
and zero-second-index tests green.

## Phase L5 — Reference Graph

- Add read-only `line-alias-collision` and `orphaned-line-alias` findings.
- Same alias on a record and line is not a collision; namespaces are separate.
- Collision routes expose every line GUID; tombstones expose the deleted GUID and
  last-known owner/text. No repair or document write path.

Exit: health matrix, all-GUID navigation, false-positive exclusions, and read-only
anti-pattern tests green.

## Phase L6 — release

- Run full exact-current suites and cross-repo fixture/contract checks.
- Audit current SDK signatures and the complete L-phase diff.
- Update READMEs, changelogs, version headers/manifests/runtime tells.
- Write `docs/handoffs/LINE-ALIASES-HANDOFF.md` with LC1-LC14 evidence and a
  user-executable live checklist.
- Commit as Svyatoslav Kleshchev and push all three `main` branches only after
  every repository gate passes.

Live install remains distinct from repository verification: Plugins Manager
update plus a hard reload is required before claiming live validation.
