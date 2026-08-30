# Thymer Aliases — Goal-Executable Roadmap (A0–A7)

Record-level aliases ("also known as") for Thymer, delivered through the existing reference platform — **not** a new plugin and **not** waiting for a native feature. Owner: **Reference Extravaganza (RefX)**, consumed by **Backreferences** and **Reference Graph** through the Reference Surface broker, exactly like every other reference capability.

This plan was authored 2026-07-12 from four inputs: (1) the Thymer Discord alias discussion (wim_thymer, Ready, ahp, Parham, phild, Adelon — see "Community requirements" below), (2) the NotebookLM "Allias" notebook survey of Obsidian / Logseq / Capacities / Roam alias implementations, (3) the `dive2Pro/roam-aliases` extension (cloned at `~/roam-aliases` — alias attribute + unlinked-alias finder + popup selection), and (4) the current state of the three reference plugins after the P0–P2 program (RefX 3.87.0, Backreferences 0.26.1, Reference Graph 0.5.0).

## Goal runner entrypoint

Start a fresh Codex goal with this exact objective:

```text
Implement /Users/svyatoslavkleshchev/thymer-reference-extravaganza/docs/ALIASES-ROADMAP.md through A7. Treat every phase status as unverified until the exact current trees, installed versions, and tests prove it. Preserve all shipped Reference Extravaganza / Backreferences / Reference Graph behavior (446/361+/59 tests must stay green). Do not create a new plugin. Complete one numbered phase at a time, run each phase's exit gates on the exact tree, write a handoff record with exact commits and test counts into docs/handoffs/, and continue until every phase is proved complete or a true external blocker is documented. Commit as author Svyatoslav Kleshchev; push only when A7 passes.
```

## Architecture decision (final — do not relitigate)

**Aliases are a RefX-owned capability inside the existing plugin, not a separate global plugin.** Rationale:

1. The platform roadmap's standing rule: *"Do not create a 'Reference Kernel' or another backlinks plugin."* Aliases touch the picker, ref chips, the broker, backreferences, unlinked mentions, health checks, and export — all RefX-platform surfaces. A separate plugin would need a bridge into every one of them.
2. RefX already ships half the machinery: per-reference display aliases (`title` on ref segments, the `Set alias for reference` command, alias-preserving live title tracking), the `[[`/`((` picker with an `alias:` filter slot explicitly reserved (removed in v3.83.1 review fix F4 *"Re-add when alias matching is implemented"*), broker `resolveTarget`, R9 stale-alias detection, and R10 alias-aware export.
3. Backreferences already owns the unlinked-mention text index (UIT) and the B2 review/apply/undo machinery — alias unlinked-mentions are a query-layer extension, not new scanning.

**Data model (hybrid, two tiers):**

- **Tier 1 — native `Aliases` property (interop surface).** A multi-value TEXT property named `Aliases` on collections the user opts in. CONSTRAINT (proven in prior projects): a Thymer plugin **cannot add stored properties to arbitrary collections** — only MCP `add_property_to_collection` can, and a Plugins-Manager reinstall wipes MCP-added props unless declared in a collection plugin's own `plugin.json`. So Tier 1 is provisioned by a **setup script** (`scripts/aliases_setup.py`, MCP-driven, idempotent, per-collection opt-in — model it on the documented `rich_tasks_setup.py` pattern) and RefX **adopts** the property wherever it exists (read + write by label). Native property = visible/editable in the record's property pane, queryable by Datacore, syncs natively — this is what the community calls "aliases as a property" (phild: *"First and foremost there should be an aliases property"*; Ready: *"native alias multi-select property that surfaces all choices in searches"*).
- **Tier 2 — plugin-owned synced Alias Registry (universal fallback).** A RefX-owned native record (same Workbench/R6 persistence pattern: `PluginCollectionAPI.createRecord()` in the Settings/Examples collection, body lines = JSON entries) storing `recordGuid → [aliases]` for records whose collection has no `Aliases` property (journal pages, un-provisioned collections). Read path merges both tiers; write path prefers the property when present, else registry. **Precedence: property wins on conflict; the registry entry for a record is migrated into the property and deleted the first time the property becomes available.**

Per-reference display aliases (the existing `title`-on-segment feature) remain a SEPARATE, already-shipped concept — a one-time display override. Record aliases are durable alternative NAMES. A2 connects them (promotion flow) without merging them.

## Community requirements (traceability — every item lands in a phase)

| # | Ask (source) | Phase |
|---|---|---|
| C1 | Aliases as a (multi-value) property, hidden-by-default but surfaceable (phild, Ready) | A1 |
| C2 | Alias matches surface in the `[[`/`((`/@ lookup, labeled, routing to the real page (everyone; Obsidian `↳` pattern) | A3 |
| C3 | Links made via an alias are REAL links — backlinks accrue to the target automatically (wim: *"links internally just point to an ID"*) | free — ref segments store the guid; verify in tests | A3 |
| C4 | Backreferences shows unlinked mentions of aliases, distinguished from title mentions, with a toggle/priority for explicit vs unlinked (phild, ahp's Lemurs/Lemuriformes case) | A4 |
| C5 | Create an alias inline from the picker: type it, arrow-down to a lookup result, Tab/Enter creates the alias on that record (phild's `@`/`[[`+Tab flow) | A2 |
| C6 | Right-click a ref chip → add/select an alias for that target (wim) | A2 |
| C7 | Aliases editable/manageable on the page itself and re-editable (ahp: *"every time, I have to manually edit it"* — must be one field, edited anytime) | A2 |
| C8 | When aliasing a link with display text not already an alias, offer to save it as a record alias (phild; Svyat's "remembers for next time") | A2 |
| C9 | Search results distinguish alias hits (`Alias (Real Title)` per Capacities, or `Alias ↳ Real Title` per Obsidian) | A3 |
| C10 | Renaming the record never breaks alias links (guid-based) | A5 |
| C11 | Rename/manage an alias later without touching every link (Parham's "can't re-type an Alias") | A2/A5 |
| C12 | Aliases usable for querying unlinked mentions later (phild) | A4 |

**Above-and-beyond (nothing else ships these — Svyat's differentiators):** alias LEARNING (A2/A6: repeated per-ref display aliases for the same target trigger a one-time "save as record alias?" suggestion; picker frecency counts alias-mediated insertions so your working vocabulary rises), alias-ambiguity HEALTH (A6: two records claiming the same alias = a detected defect with explicit resolution, never silent guessing), alias-aware EXPORT (A6), and full BROKER exposure so Datacore/Omni/any plugin can resolve aliases through one contract (A1).

## Status ledger

| Phase | Scope | Initial status |
|---|---|---|
| A0 | Audit, contracts freeze, fixtures | **Complete 2026-07-13** — `ALIAS-SURFACE-V1` frozen; fixtures MD5 `a0c49841fea9dc19e49e81019f567a68`; setup helper + README warning committed in `ef26a37`; exact-current suites 446 / 377+contracts / 59 green; handoff `docs/handoffs/A0-HANDOFF.md` |
| A1 | Data layer: property adoption + registry + broker surface | **Complete 2026-07-13** — RefX v3.88.0 commit `e08445b`; property + registry tiers, verified migration, queue/retry convergence, alias indexes, broker/bridge, payload-first events, schema self-heal, hot-reload cleanup, provisioning command; 462 full / 16 focused tests green; handoff `docs/handoffs/A1-HANDOFF.md` |
| A2 | Creation & management UX | **Complete 2026-07-13** — RefX v3.89.0 implementation commit `ddf3765`; tier-labeled keyboard CRUD modal from palette/ref menu/property card, write-before-insert picker Tab action, explicit promotion with bounded dismissal memory, and cached zero-layout active-panel decorators; 467 full / 5 focused tests green; handoff `docs/handoffs/A2-HANDOFF.md` |
| A3 | Search: picker + alias: filter + ranking | **Complete 2026-07-13** — RefX v3.90.0 implementation commit `cc79331`; synchronous separator-aware alias matching, labeled `↳` rows, alias-title GUID insertion, composable `alias:` filtering, ambiguity preservation, per-alias use and one-shot learned suggestions; 473 full / 6 focused tests green; handoff `docs/handoffs/A3-HANDOFF.md` |
| A4 | Backreferences: alias mentions + facet | **Complete 2026-07-13** — Backreferences v0.28.0 implementation commit `28490a9` (v0.27.0 was already occupied); RefX broker/bridge-only alias phrases over the existing UIT query layer, exact matched-phrase groups/inbox state, `via "Alias"` labels, title/per-alias facets with partial counts, rich-segment alias linking, and persisted explicit-first ordering; 385 full / 8 focused smoke checks plus both `.cjs` suites green; handoff `docs/handoffs/A4-HANDOFF.md` |
| A5 | Display, rename, stale-alias semantics | **Complete 2026-07-13** — RefX v3.91.0 commit `1a9dc34`; alias-aware managed-title preservation plus explicit broker-indexed preview/apply/receipt/undo; Graph v0.5.1 commit `baf14f1` accepts current aliases in R9; RefX 480 / Graph 60 green; handoff `docs/handoffs/A5-HANDOFF.md` |
| A6 | Health, learning, export, Datacore vocabulary | **Complete 2026-07-13** — RefX v3.92.0 commit `697807e`; idle generation/revision-guarded one-best alias learning, explicit manager Add, R10 alias properties, Datacore/Omni contract; Graph v0.6.0 commit `534bfad` adds collision/title-shadow health with all-GUID navigation and no auto-resolution; RefX 485 / Graph 63 green; handoff `docs/handoffs/A6-HANDOFF.md` |
| A7 | Conformance, docs, release, push | **Complete 2026-07-13** — RefX 485, Graph 63, Backreferences 386 + both contracts green; current public SDK signatures checked; all A-phase diffs swept; user docs and C1–C12 final handoff complete at `docs/handoffs/ALIASES-HANDOFF.md`; release branches successfully pushed through RefX `527f5a7`, Graph `534bfad`, and Backreferences `3400d4b` before this final ledger-only commit. |

Update a row only after its exit gates pass on the exact current tree. "Code exists" is not completion.

## Hard-won implementation rules (violating any is an automatic review failure)

These are paid-for lessons from the P0–P2 program and the plugin fleet. Codex: read them as law.

1. **SDK-faithful test mocks.** The R6 saved-views feature shipped DEAD because the test mock inverted the real signature `createLineItem(parent, after, type, segments, props)`. Every mock in alias tests must mirror the exact SDK shape; line text is read by joining `li.segments` (there is no `.text` accessor guarantee); `PluginLineItem.guid` is a property, not `getGuid()`; `PluginRecord` has no `getCollection()`; `data.getAllCollections()` returns a Promise — always await; `prop.values()` (never `prop.get()`) with defensive shape normalization (guid string / JSON-string array / `{guid}` / `{getGuid}`).
2. **Write serialization + no last-writer-wins.** Registry writes go through a per-record chained promise queue (the R6 `_r6WriteQueues` pattern). Property writes are read-merge-write with the same queue. Two clients adding different aliases concurrently must merge, not clobber.
3. **Hot-reload singletons.** Every listener/observer/interval/subscription installed for aliases is parked on a `window.__refx*` stash and disposed at the top of `onLoad` (`_killStaleObservers` already does this — extend it, don't parallel it).
4. **Flash-free rules.** Any on-page alias display is either persistent-CSS-driven or uses the pre-paint cached-node reinsertion pattern already in `_ensureCardObserver`; zero geometry shift while typing; no layout reads in MutationObserver callbacks; NEVER mutate the user's document to display metadata (overlay/decorator only — Svyat removes in-document additions on sight).
5. **Truthfulness.** Any capped/partial result says so (`capReason`, "at least N"). No silent caps. No `window.prompt/confirm/alert` (dead on desktop) — in-panel modals only (`refalias-modal` idioms exist).
6. **No document mutation from UI affordances** except the explicit, user-initiated alias/link writes themselves (segment writes preserve every non-target segment byte-identical — reuse the B2 span-rebuild discipline for any Link-this-mention action).
7. **Event handlers are payload-first** — never `data.getRecord()` inside a `record.*`/`lineitem.*` handler (remote-create returns null; per-event decode cost). Enrich on a debounced pass.
8. **Reviews must exercise the REAL mount/persistence path.** Every phase adds at least one test that drives the feature through the production entry point (onLoad → command/picker/panel), not just direct method calls. R7/R8 shipped a fully-tested feature whose mount point was never assigned; the suite stayed green. Never again.

## Phase A0 — audit + frozen contracts

Read first: this file; `docs/reference-surface-v1.md`; `docs/R0-CAPABILITY-LEDGER.md`; `docs/handoffs/R5-HANDOFF.md` + `R6-HANDOFF.md` + `R11-B7-HANDOFF.md`; the RefX alias machinery (grep `_writeAlias`, `_openAliasModal`, `refalias`, `Set alias for reference`, the v3.79-3.80 CHANGELOG entries about alias-preserving title tracking); the R5 picker (`_r5ParseFilters`, `_addBoundedSearchResult`, `_renderLink`, `_searchScore`, the removed `alias:` token — CHANGELOG v3.83.1 F4); Backreferences UIT (`_uitIndex`, `docs/UNLINKED-TEXT-INDEX.md`) and B2 machinery (`groupUnlinkedReferenceLines`, preview→apply, receipts); `~/roam-aliases/src/` (253-line index + 749-line unlink-aliases — mine it for the unlinked-alias matching edge cases, not its architecture).

Deliverables (all committed):

1. `docs/ALIAS-SURFACE-V1.md` — the frozen contract:
   - **AliasSetV1**: `{ recordGuid, aliases: [{ text, normalized, source: "property"|"registry", addedAt, addedBy }] }`. Normalization: NFC, trim, collapse internal whitespace, case-preserving storage with case-insensitive matching; the SAME identifier normalization the picker already applies to titles (grep the `EMP 26` normalization) applies to aliases.
   - **Broker extension (additive, apiVersion stays 1)**: `aliases: { get(recordGuid) → AliasSetV1|null, resolve(text) → [{recordGuid, alias, exact}] (ranked, NEVER auto-picks on ambiguity), all() → iterator, subscribe(cb) → unsub }` plus capability flag `supportsAliases: true`. Document that `resolve` is matching only — the caller decides; ambiguity is surfaced, never guessed.
   - **Property adoption rules**: property label `Aliases` (exact, case-sensitive), multi-value text; adopted when present in a collection's `getConfiguration().fields`; write via `prop` by LABEL; a registry entry migrates into a newly-available property once, idempotently, then is deleted.
   - **Registry record schema** (Workbench/R6 pattern) with schemaVersion, per-record entries, bounded size (cap ~2000 records / warn + refuse beyond, with capReason), write-queue serialization requirement.
   - **Collision policy**: the same normalized alias on 2+ records is legal but flagged (A6 health defect `alias-collision`); picker shows all targets; `resolve` returns all.
2. `test/fixtures/alias-surface-v1.json` — fixtures: single/multi alias, property-tier, registry-tier, both-tier merge + precedence, collision, unicode/diacritics, whitespace, case variants, migration case, empty.
3. `scripts/aliases_setup.py` — idempotent MCP setup script skeleton (list target collections from argv, `get_collection_schema`, `add_property_to_collection(type="text", many=true, label="Aliases")` when absent). Document in README that PM-reinstall of a *collection* plugin can wipe MCP props (global RefX is safe; the warning is for collection plugins).
4. Capability ledger addendum in this file's A0 handoff: exact current functions to keep/adapt (per-ref alias machinery = keep untouched; `_r5ParseFilters` = re-add `alias:`; UIT = extend query layer; `_recordNameIndex` = sibling `_aliasIndex`).

Exit gates: contract + fixtures committed; all existing suites still green (no code changes yet beyond the script skeleton); fixture md5 recorded.

## Phase A1 — data layer + broker surface (RefX)

1. **Alias index**: `_aliasIndex` (Map normalized-alias → Set<recordGuid>) + `_aliasByRecord` (Map recordGuid → AliasSetV1), built asynchronously alongside `_recordNameIndex` (same background build; time-sliced; generation-guarded). Sources: (a) every record's `Aliases` property via `values()` normalization; (b) the registry record. Incremental maintenance from `record.updated` events (payload-first; debounced enrich re-reads the property).
2. **Registry**: RefX-owned record (`RefX Alias Registry`) via the exact `_wbResolveBacking` + R6 persistence pattern — real `createLineItem(null, null, 'ulist', [{type:'text', text}], null)` writes, segment-join reads, per-record write queue, corrupt-entry tolerance, bounded size.
3. **Write API + migration**: `_aliasAdd(recordGuid, text)`, `_aliasRemove`, `_aliasRename(recordGuid, old, new)` — property-first, registry-fallback, queue-serialized, echo-suppressed (own writes don't re-trigger index rebuild storms). One-shot migration registry→property per record when the property appears (idempotent, logged).
4. **Broker surface**: implement the `aliases` extension per the A0 contract; `supportsAliases: true`; revision bump on alias changes (coalesced); `resolveTarget` results gain `aliases: [..]` when present (additive field).
5. **Setup script** finished + a palette command `RefX: Provision Aliases property…` that does NOT call MCP (plugins can't) but shows the copy-paste setup command + which collections currently lack the property (truthful affordance).
6. TESTS (`test/a1-alias-data.test.cjs`, vm-harness, SDK-faithful mocks): fixture-driven index build (both tiers, merge, precedence, collision); values() shape matrix; event-driven incremental update incl. remote-create (payload-first); registry round-trip through the REAL persistence path; concurrent-write merge (two interleaved `_aliasAdd`s both survive); migration idempotence; broker resolve ranking + ambiguity; subscribe/unsubscribe; hot-reload disposal.
7. Version bump (3.87.0 → 3.88.0), CHANGELOG, commit `A1: alias data layer — property adoption, synced registry, broker alias surface (v3.88.0)`.

Exit gates: all suites green (446 + new); zero regressions; broker flag live; A1 handoff written.

## Phase A2 — creation & management UX (RefX)

1. **Manage-aliases modal** (reuse `refalias-modal` idioms): opened from (a) palette `RefX: Aliases for this record…` (active record), (b) the ref-chip right-click menu (`openRefMenu` — new row "Aliases…" targeting the chip's record), (c) the property card. Shows current aliases (both tiers labeled), add input (Enter adds), per-alias remove and RENAME (C7/C11 — rename = atomic remove+add through the queue). Keyboard-complete.
2. **Picker create-alias flow (C5)**: in the `[[`/`((` picker, when the query matches no title/alias exactly, add a secondary action row under the highlighted result: `Tab⇥ add "«query»" as alias of «Result»` (distinct from the existing Enter=insert and the existing create-page row; only when a result is highlighted and the query differs from its title). Accepting: writes the alias via A1, THEN inserts a ref to that record with `title` = the typed text (so the link reads as typed). This is the "make it remember" moment.
3. **Promotion offer (C8, Svyat's learning)**: when the user sets a per-ref display alias (existing `Set alias for reference` / `_writeAlias` path) with text that is not already a record alias, show a one-line non-blocking affordance in the alias popover: `Also save as a record alias? [Add]`. Never automatic; never repeated for a dismissed (record, text) pair (small localStorage dismissal set).
4. **On-page surfacing (C7, zero-mutation)**: an optional (settings-gated, default ON) subtle alias chip-row rendered as a DECORATOR under the record title of the active panel — overlay/decorator only, never a written line; click opens the manage modal. Must obey flash-free rules (persistent CSS + cached-node reinsertion; no geometry churn while typing).
5. TESTS: modal CRUD through the real command entry points; picker Tab-flow (query→highlight→Tab→alias written + ref inserted with title); promotion offer shown once / dismissal persisted; decorator mounts via the real render path and survives a simulated line re-render without geometry change.
6. Version 3.88.0 → 3.89.0, commit `A2: alias creation UX — manage modal, picker Tab-create, promotion offers, on-page chips (v3.89.0)`.

Exit gates: keyboard-only path covers add/rename/remove/create-from-picker; no document mutation outside explicit alias/ref writes; suites green; handoff.

## Phase A3 — search integration (RefX)

1. **Picker alias matching (C2/C9)**: the type-ahead search matches `_aliasIndex` alongside `_recordNameIndex` with the SAME identifier normalization; alias hits render as `«Alias» ↳ «Real Title»` (Obsidian pattern; the inserted ref targets the real record and — user preference frozen here — keeps the ALIAS as the ref `title` so the text reads as typed, matching wim's expectation). Ranking: exact alias == exact title tier; prefix/fuzzy alias one tier below the same-quality title match; NEVER filtered out by frecency (rank-only rule from R5).
2. **Re-add the `alias:` filter** (the reserved R5 slot): `alias:foo` restricts to alias matches; composes with `in:`/`is:`/`kind:` etc.
3. **Frecency learning**: alias-mediated insertions bump the target's frecency AND a per-(alias→record) use count; repeated use of the same non-alias query that ends in the same record (≥3 times, exact-query match) triggers ONE picker-inline suggestion `Save "«query»" as alias?` (dismissable, remembered) — this is Svyat's "built into [[ so it remembers for next time".
4. **Bridge exposure**: `window.__refx.aliases = { resolve, get, add }` (thin, guarded) so Omni Search / Smart Connections / Datacore can consume without the broker ceremony; document in `docs/DATACORE-ADAPTER.md`.
5. TESTS: alias hit rendering + insertion shape (guid + title); ranking table (exact alias vs exact title vs prefix); `alias:` filter; ambiguity (two records, one alias → both rows, labeled); normalization parity (`EMP26` finds alias `EMP 26`); frecency suggestion fires at threshold + dismissal; latency guard — alias matching adds ZERO awaits to the keystroke path (index is in-memory; assert structurally).
6. Version 3.89.0 → 3.90.0, commit `A3: alias-aware picker — ↳ results, alias: filter, learned-alias suggestions (v3.90.0)`.

Exit gates: R5's identifier-speed behavior unregressed (existing picker tests green); suites green; handoff.

## Phase A4 — Backreferences: alias mentions + facet (Backreferences repo)

Work in `/Users/svyatoslavkleshchev/thymer-backreferences`. Consume ONLY the broker/bridge contracts (`supportsAliases` checked at call time; degrade gracefully when absent — panel shows "aliases require Reference Extravaganza ≥3.88").

1. **Alias unlinked mentions (C4, C12)**: extend the unlinked-mention pipeline so the phrase set for a record = title + all its aliases (from `broker.aliases.get`). The UIT index already stores normalized line text — this is a QUERY-layer change (multiple phrases per record), not a second index. Each match row is labeled with WHICH alias matched (`via "Lemuriformes"`). Group keys: reuse the B2 identity grammar with the matched normalized phrase (already part of the key — collision-free by construction).
2. **Explicit-vs-unlinked priority toggle (phild)**: a panel setting ordering sections (explicit backlinks first by default; alias-unlinked collapsible with counts).
3. **Alias facet**: the R7 facet bar gains a `via alias` dimension (title-mention vs per-alias), counts from the authoritative set with the existing ≥N partial labeling.
4. **Link-this-mention**: the existing B2 preview→apply→undo machinery works unchanged on alias matches; the created ref's `title` = the matched alias text (reads as written). Verify segment-preservation on an alias apply.
5. **Inbox**: alias-mention occurrences flow into the R3 inbox with their group keys; dismissals/ignore rules apply per phrase (already keyed that way).
6. TESTS (smoke suite): multi-phrase matching incl. ahp's case (record "Lemurs" + alias "infraorder Lemuriformes" — mention of either surfaces, labeled); overlap (alias text containing the title); toggle ordering; facet counts; alias apply preserves rich segments + sets title; broker-absent degrade; dismissal keyed per alias phrase.
7. Version 0.26.1 → 0.27.0, commit `A4: alias-aware unlinked mentions, via-alias labeling, alias facet (v0.27.0)`.

Exit gates: smoke suite green AND terminates; both .cjs suites green; handoff.

## Phase A5 — display, rename, stale-alias semantics (RefX)

1. **Chip display**: refs created via an alias keep the alias as `title` (already how ref titles work) — verify the alias-preserving live-title-tracking (v3.79-3.80 feature) treats record-alias titles as user aliases (untouched by auto-title refresh). Record RENAME (C10): guid-based refs never break — add a test proving a rename changes chip text only for non-aliased refs.
2. **Alias rename propagation (C11)**: renaming a record alias offers (modal, explicit, previewed — B2-style preview listing affected refs) to update ref segments whose `title` equals the old alias. Uses the segment-preserving rewrite discipline; receipts + undo (reuse/port the B2 receipt pattern at RefX scope, or route through the existing refs-rewrite machinery from the Notes-Management merge lesson: map `ref` segments and `setSegments`, preserving `viewId`).
3. **Stale-alias detection alignment**: R9's `stale-alias` check currently flags `edge.title !== target name`; teach it (via broker aliases) that a title matching ANY record alias is NOT stale — eliminates false positives. (Reference Graph repo change, small; keep its read-only invariant.)
4. TESTS: rename-record vs aliased-chip matrix; alias-rename preview/apply/undo/receipts; R9 false-positive elimination (fixture: aliased edge no longer flagged).
5. Versions: RefX 3.90.0 → 3.91.0; Reference Graph 0.5.0 → 0.5.1. Commits per repo.

Exit gates: all three repos' suites green; handoff.

## Phase A6 — health, learning, export, vocabulary (RefX + Reference Graph)

1. **Alias-collision health class** (Reference Graph): new R9 defect `alias-collision` (same normalized alias on 2+ records) — severity info, export-only + "open both" navigation; never auto-resolved. Also `alias-shadows-title` (an alias equal to another record's TITLE — the ambiguity phild worried about) — flagged with explanation.
2. **Learning consolidation** (RefX): a small maintenance pass (idle, generation-guarded) that finds per-ref display aliases repeated ≥3 times for the same target across the workspace (broker edges carry `title`) and queues ONE suggestion each in the manage modal ("Frequently used: «text» — add as alias?"). No writes without a click.
3. **Export (R10)**: resolved-mode export may resolve via alias display text (already the ref title); add an `aliases` line to the properties block when `includeProperties` is on. Golden fixture.
4. **Datacore vocabulary**: append the alias contract to `docs/DATACORE-ADAPTER.md` (aliases property label, broker surface, bridge) so Datacore queries (`Aliases` contains X) and Omni Search can adopt without guessing.
5. TESTS per item; version bumps (RefX 3.91.0 → 3.92.0, Graph 0.5.1 → 0.6.0); commits.

Exit gates: suites green in both repos; handoff.

## Phase A7 — conformance, docs, release

1. Full suite matrix across all three repos (all existing + all A-phase suites) — zero failures; smoke terminates.
2. Anti-pattern sweep on all A-phase diffs: no `window.prompt/confirm/alert`; no `data.createNewRecord`; no `prop.get(`; no sync `getAllCollections` chaining; no getRecord-in-event-handler; no document mutation outside explicit user writes; mocks spot-checked against `types.d.ts` signatures (fetch via `gh api repos/thymerapp/thymer-plugin-sdk/contents/types.d.ts --jq '.content' | base64 -d`).
3. Version consistency per repo (manifest = header = runtime tell = changelog); README sections: RefX "Aliases" feature docs (data model, tiers, setup script, all UX flows), Backreferences alias-mentions docs.
4. Community-requirement traceability table (C1–C12 → shipped evidence) in the final handoff `docs/handoffs/ALIASES-HANDOFF.md`, plus the live-verification checklist for Svyat (PM reinstall all three, hard-reload, then: add alias via modal; picker shows `↳`; Tab-create from picker; unlinked alias mention appears in backrefs labeled; rename record — aliased chip unchanged; collision shows in Health).
5. Update this ledger; commit; **push all three repos**.

## Do not rebuild (already shipped — extend, never duplicate)

- Per-reference display aliases: `Set alias for reference`, alias popover/modal, alias-preserving auto-title tracking, `@@` alias semantics.
- The picker (R5): normalization, ranking, scope stack, filters, session tokens, frecency store.
- UIT unlinked index + B2 preview/apply/undo/receipts + R3 inbox keys (Backreferences).
- Broker plumbing: generation/revision, subscribe, cursors, FilterExpressionV1.
- R9 detection framework; R10 exporter; R6 registry persistence pattern.

## Anti-patterns (grep-able, phase reviews must check)

| Anti-pattern | Guard |
|---|---|
| Second alias store outside the two tiers | grep for new localStorage keys holding alias text (localStorage = per-device; aliases MUST sync) |
| Auto-resolving alias ambiguity | `resolve(` callers must handle arrays; any `[0]` pick without a labeled-ambiguity branch is a bug |
| Alias matching awaits on the keystroke path | picker keystroke path must stay synchronous over in-memory indexes |
| Registry writes without the queue | every registry/property write goes through the serialization queue |
| Mock drift | every new mock's method signatures diffed against types.d.ts in review |
| In-document alias display | title-area alias chips are decorators only; zero body writes |

## Phase handoff template

```text
Phase and status:
Repos + exact commits + versions:
Contract version (ALIAS-SURFACE-V1):
Community requirements covered (C#s) + evidence:
Tests and counts (per suite, before → after):
Live evidence: offline — deferred to Svyat post-push (list what to check)
Known gaps / deferrals:
Next phase entrypoint:
```
