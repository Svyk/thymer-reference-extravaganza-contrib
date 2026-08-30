# Line Alias Surface v1

Status: frozen for the Line Aliases roadmap. This contract is additive to
Reference Surface v1. The broker `apiVersion` remains `1`, and the existing
record-only `aliases` surface is unchanged.

## Scope and ownership

Reference Extravaganza (RefX) is the only durable line-alias authority.

- A **line alias** is a durable alternative name for one stable line GUID.
- A **display alias** is the optional `title` on one `ref` segment. It affects
  one occurrence and becomes durable only after an explicit promotion.
- Record aliases and line aliases are separate namespaces. `[[` resolves
  records; `((` resolves lines. A record and a line may share the same text
  without a collision.
- Consumers read line aliases through the Reference Surface broker or the
  documented `window.__refx.lineAliases` bridge. They never read RefX storage.

Line aliases are registry-backed because Thymer line items have no properties.
The registry contains aliased lines only; RefX never scans the workspace to
discover candidates. Line lifecycle events maintain target metadata after the
registry has loaded.

## LineAliasSetV1

```ts
type LineAliasV1 = {
  text: string;
  normalized: string;
  source: "registry";
  addedAt: string | null;
  addedBy: string | null;
};

type LineAliasSetV1 = {
  lineGuid: string;
  recordGuid: string | null;
  currentText: string;
  status: "active" | "deleted" | "unknown";
  aliases: LineAliasV1[];
};
```

Normalization, deterministic ordering, exact matching, identifier matching,
and ambiguity semantics are identical to `AliasV1`. A normalized alias may
belong to several lines; every line remains visible and no target is selected
automatically.

`currentText` and `recordGuid` are hints maintained from event payloads and
loaded line handles. Identity is always `lineGuid`. Editing or moving a line
does not change its aliases. Deleting a line changes `status` to `deleted` and
removes it from default picker resolution; the tombstone remains visible to
health tooling until the aliases are explicitly removed or the line returns.

## Reference Surface broker extension

```ts
supportsLineAliases: true;

lineAliases: {
  get(lineGuid: string): LineAliasSetV1 | null;
  resolve(text: string, options?: { includeDeleted?: boolean }): Array<{
    lineGuid: string;
    recordGuid: string | null;
    currentText: string;
    status: "active" | "deleted" | "unknown";
    alias: LineAliasV1;
    exact: boolean;
  }>;
  all(): IterableIterator<LineAliasSetV1>;
  subscribe(cb: (change: LineAliasChangeV1) => void): () => void;
};
```

All reads are synchronous and side-effect-free. `resolve()` excludes deleted
targets unless `includeDeleted:true` is explicit. Subscribers receive:

```ts
type LineAliasChangeV1 = {
  revision: number;
  changedLineGuids: readonly string[];
  reason: "hydrate" | "write" | "lineitem.updated" | "lineitem.moved" |
          "lineitem.deleted" | "lineitem.undeleted" | "rebuild";
};
```

The broker snapshot and edge revision remain independent from the line-alias
revision. Consumers bind long work to both revisions when both surfaces matter.

## Write bridge

`window.__refx.lineAliases` exposes the four read methods plus:

```ts
add(lineGuid, text, hints?): Promise<Result>;
remove(lineGuid, text): Promise<Result>;
rename(lineGuid, oldText, newText): Promise<Result>;
refresh(lineGuid, hints?): Promise<Result>;
status(): {
  generation: string;
  revision: number;
  hydrated: boolean;
  lines: number;
  activeLines: number;
  deletedLines: number;
  registryCap: number;
};
```

Writes are serialized per line, re-read the registry before mutation, append a
new verified state, and never choose among ambiguous aliases. The truthful cap
is 10,000 aliased line GUIDs. Existing entries remain editable at the cap; a
new line is refused rather than silently dropped.

## Picker and backlinks

- `((` searches current line text plus `lineAliases`; an alias row renders
  `Alias ↳ current line text · owning record` and inserts a real line-GUID ref
  with `title: Alias`.
- `alias:` in line mode restricts results to line aliases. Record-mode behavior
  remains record-only.
- Explicit references aggregate by target line GUID in the existing inline
  linked-reference/count surfaces.
- Backreferences may query title plus aliases only when a specific line is in
  focus. Alias unlinked mentions stay line-scoped, identify the matched phrase,
  and use preview/apply/undo to write the real line GUID.

## Safety and performance invariants

1. No workspace-wide line scan is introduced for line aliases.
2. Event handlers are payload-first and perform no `data.getRecord()` call.
3. Picker reads are synchronous against bounded in-memory indexes before any
   remote line search.
4. Ambiguity always remains visible; no first-hit selection or auto-repair.
5. Suggestions and promotions are read-only until the user clicks Add.
6. Rename propagation is previewed, segment-preserving, stale-source guarded,
   receipted, and hash-gated for undo.
7. Reference Graph remains strictly read-only.
8. Hot reload disposes timers, subscriptions, write queues, and globals owned
   by the prior generation.
