# Alias Surface v1

Status: frozen for the A0-A7 Aliases roadmap. This contract is additive to
Reference Surface v1. The broker `apiVersion` remains `1`.

## Scope and ownership

Reference Extravaganza (RefX) owns global record aliases. They are distinct
from a reference segment's display title:

- A **global record alias** is searchable and shared by every reference to a
  record.
- A **display alias** is the optional `title` on one `ref` segment. It changes
  only how that occurrence reads and never enters the global alias index unless
  the user explicitly promotes it.

Consumers discover aliases only through the Reference Surface broker or the
documented `window.__refx.aliases` bridge. No consumer reads RefX storage.

## AliasSetV1

```ts
type AliasSourceV1 = "property" | "registry";

type AliasV1 = {
  text: string;                 // NFC, trimmed/collapsed, case preserved
  normalized: string;           // canonical exact-match key
  source: AliasSourceV1;
  addedAt: string | null;        // ISO 8601 when known
  addedBy: string | null;        // stable client/writer id when known
};

type AliasSetV1 = {
  recordGuid: string;
  aliases: AliasV1[];
};
```

`get(recordGuid)` returns `null` when the record has no non-empty aliases. An
empty set is never published. Alias arrays are deterministic: property aliases
first, then registry aliases, each ordered by case-insensitive text and then by
case-preserving text.

Property values have no author/timestamp metadata in the Thymer SDK, so adopted
property aliases use `addedAt: null` and `addedBy: null`. Registry aliases keep
the stored metadata.

## Normalization and matching

The canonical exact-match normalization is:

1. convert to Unicode NFC;
2. trim leading and trailing whitespace;
3. collapse every internal whitespace run to one ASCII space;
4. lowercase with JavaScript `toLowerCase()`.

The case-preserving `text` field is the value after steps 1-3. Empty results are
discarded. Deduplication uses `normalized`; the first property spelling wins,
otherwise the first registry spelling wins.

Picker and `resolve()` matching also apply RefX's existing `_searchKey`,
`_searchPlan`, and `_searchScore` path to alias `text`. This preserves the
identifier behavior where `EMP 26` matches `EMP26-002-BHP`: punctuation and
letter/number boundaries become spaced tokens and a separator-free `compact`
key is scored. This search key does not replace `normalized` and does not merge
different stored aliases merely because their compact forms match.

`exact: true` means the query's canonical exact-match key equals
`alias.normalized`. Identifier-equivalent and fuzzy matches are ranked but have
`exact: false`.

## Reference Surface broker extension

When aliases are ready, the existing `window.__thymerReferenceSurfaceV1` broker
adds:

```ts
supportsAliases: true;

aliases: {
  get(recordGuid: string): AliasSetV1 | null;
  resolve(text: string): Array<{
    recordGuid: string;
    alias: AliasV1;
    exact: boolean;
  }>;
  all(): IterableIterator<AliasSetV1>;
  subscribe(cb: (change: AliasChangeV1) => void): () => void;
};
```

`AliasChangeV1` is `{ revision, changedRecordGuids, reason }`, where
`changedRecordGuids` is a deduplicated array and `reason` is one of `hydrate`,
`record.updated`, `write`, `migration`, or `rebuild`.

All four read/subscribe operations are synchronous and in-memory. `resolve()`
is a matching operation only: it returns every ranked match and never chooses a
record for the caller. Exact matches sort before non-exact matches; within a
tier the existing RefX search score sorts descending, then record GUID sorts
ascending for determinism. Ambiguity remains visible.

`resolveTarget(guid)` gains the additive field `aliases: string[]` when the
target has aliases. Existing fields and behavior are unchanged.

Before hydration completes, the broker may omit `supportsAliases`/`aliases` or
publish an empty in-memory surface and a non-ready status. Consumers must check
`supportsAliases === true` and the method they call at use time.

## Native `Aliases` property

RefX adopts a collection field only when all of these are true:

- its label is exactly `Aliases` (case-sensitive);
- its type is `text`;
- it is multi-value (`many: true`).

Collection configuration comes from awaited `data.getAllCollections()` and
`collection.getConfiguration().fields`. Record reads use
`record.prop("Aliases").values()` with defensive value-shape normalization;
`prop.get()` is not part of this contract. Writes address the property by label,
not a generated field id.

When a record has an adopted property, property values are authoritative. If a
registry entry also exists, non-duplicate registry aliases are merged into the
property through the per-record write queue. Only after a verified property
re-read contains the merged aliases is the registry entry deleted. Repeating
the migration is safe and produces the same result.

## Synced Alias Registry

The fallback is one native record named `RefX Alias Registry`, created through
the same Settings/Examples collection pattern as synced Reference Views. Its
body contains one `ulist` line per record. Line text is one compact JSON object:

```json
{"kind":"refx-alias-entry","schemaVersion":1,"recordGuid":"01ABC","aliases":[{"text":"EMP 26","normalized":"emp 26","addedAt":"2026-07-13T12:00:00.000Z","addedBy":"client-1"}],"updatedAt":"2026-07-13T12:00:00.000Z","writerId":"client-1"}
```

Required invariants:

- `kind` is `refx-alias-entry` and `schemaVersion` is `1`.
- `recordGuid` is a non-empty string.
- aliases are normalized on read; stored `normalized` values are verified and
  repaired in memory rather than trusted.
- malformed lines are ignored and reported by alias health checks.
- duplicate lines for a record resolve by newest valid `updatedAt`, then line
  GUID ascending as a deterministic tie-break; compaction removes superseded
  lines only after the winning state is durable.
- writes use the real SDK signature
  `createLineItem(null, null, "ulist", [{type:"text", text}], null)` and reads
  join text segments from `lineItem.segments`.

Registry and property mutations share a chained promise queue per record. Every
add/rename is read-merge-write followed by a verification read; concurrent
adds must merge rather than last-write-wins. Own-write event echoes are
coalesced and must not trigger rebuild storms.

The registry accepts at most 2,000 distinct record entries. At the cap, updates
and removals of existing entries remain allowed, but creating a new record entry
is refused with `capReason: "alias-registry-record-cap"`; the UI must say that
the registry is full and recommend provisioning the native property. The cap is
never silent.

## Collision policy

The same `normalized` alias may belong to two or more records. This is legal:

- `aliases.resolve()` returns every target;
- the picker renders every target with its real title;
- no write path auto-picks or rewrites a collision;
- A6 health reports one `alias-collision` defect per normalized alias, listing
  the affected record GUIDs.

## Compatibility and lifecycle

The extension is additive and keeps Reference Surface `apiVersion: 1`. RefX
installs one alias singleton per plugin instance, disposes stale listeners,
timers, subscriptions, and globals during hot reload, and generation-guards all
asynchronous hydration. Host event handlers remain payload-first; record
enrichment happens on a debounced pass, never through `data.getRecord()` inside
the host event callback.
