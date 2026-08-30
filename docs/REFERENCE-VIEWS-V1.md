# ReferenceViewV1 — Saved Reference View Schema

Introduced in R6 (v3.85.0). Documents the schema for saved Reference Views and their revision model.

---

## ReferenceViewV1

```typescript
interface ReferenceViewV1 {
  schemaVersion: 1;
  viewGuid: string | null;       // Thymer record GUID; null until first persist
  name: string;                  // Human-readable view name (= record name)

  // What to show
  targets: string[];             // One or more Thymer GUIDs (record or line)
  edgeKinds: EdgeKind[];         // Subset of: "ref" | "property" | "annotation" | "claim"
  filterExpression: FilterExpressionV1 | null; // nested AND/OR filter tree, or null

  // Display options
  sort: SortMode;                // "relevance" | "date" | "alpha" | "kind"
  contextDepth: number;          // 1 = immediate line only; 2+ = include parent/children
  descendantMentions: boolean;   // Include mentions in descendants of targets
  displayMode: DisplayMode;      // "list" | "grouped" | "compact"
  pageSize: number;              // Results per page (default: 30)

  // Optional sync with inbox (Backreferences) read/change state
  inboxStateSync: boolean;       // default: false
}

type EdgeKind = "ref" | "property" | "annotation" | "claim";
type SortMode = "relevance" | "date" | "alpha" | "kind";
type DisplayMode = "list" | "grouped" | "compact";
```

### FilterExpressionV1

Nested AND/OR filter tree. Must be deterministically serialized (key order sorted alphabetically) before hashing so that identical configs produce identical hashes regardless of the order properties were set.

```typescript
type FilterExpressionV1 =
  | { op: "and"; children: FilterExpressionV1[] }
  | { op: "or";  children: FilterExpressionV1[] }
  | { op: "not"; child: FilterExpressionV1 }
  | { field: FilterFieldV1; predicate: string; value?: string | string[] };

type FilterFieldV1 =
  | "kind"          // edge kind (ref/property/annotation/claim)
  | "collection"    // source collection name
  | "taskState"     // "todo" | "done" | "cancelled"
  | "dateRange"     // value: "today" | "thisWeek" | "thisMonth" | ISO date
  | "sourceRecord"  // source record GUID
  | "hasChildren"   // predicate: "true" | "false"
  | "depth";        // predicate: "eq" | "gt" | "lt"; value: "1" | "2" | ...
```

---

## ReferenceViewRevisionV1

Each saved change to a view appends one revision entry as a JSON line item in the view's record body.

```typescript
interface ReferenceViewRevisionV1 {
  revisionId: string;           // configHash + "_" + timestamp36 (or "merge_" prefix)
  parentRevisionIds: string[];  // [] = initial revision; [A] = linear update from A;
                                // [A, B] = merge of conflicting heads A and B
  configHash: string;           // djb2 of stable-JSON-serialized fullConfig (8 hex chars)
  fullConfig: ReferenceViewV1;  // complete config at this revision
  authorClientId: string;       // per-device client ID (localStorage refx_r6_client_id)
  savedAt: string;              // ISO 8601 timestamp
}
```

### Head derivation

**Current head(s)** = revisions in the record's body whose `revisionId` is NOT cited as a `parentRevisionId` by any other revision in the same record.

- **One head**: the single current version of the view. No conflict.
- **Two heads from the same parent**: two clients both saved from `parentRevisionId = R_A` → they both cite `R_A` as parent, neither cites the other → two heads → explicit conflict.
- **Merge revision**: cites both conflicting heads as parents → both are now non-heads → single head again.

### Compaction

The revision log is bounded to **50 entries** per view record. When a new revision is appended:
1. The new entry is prepended as the first line item.
2. Older non-head revisions beyond the cap are deleted.
3. **Head revisions are NEVER deleted** regardless of the cap.

---

## Persistence model

Saved views are stored as Thymer records in the **Settings** or **Examples** collection (the same home the Workbench State record uses). This is the only supported persistence path.

| Aspect | Mechanism |
|---|---|
| Record creation | `PluginCollectionAPI.createRecord(viewName)` |
| Record name | `= view name` (searched by name on load; GUIDs cached per session) |
| Body line items | One JSON text line per revision (newest first by convention) |
| Synced state | Lives in Thymer records — syncs across devices via Thymer natively |
| Per-device prefs | localStorage keys `refx_r6_dev_prefs_*` and `refx_r6_client_id` |
| Migration flag | localStorage `refx_r6_pin_mig_v1=done` (per client, set once) |

### Why the Workbench collection home?

The Workbench already proved this pattern: `Settings` / `Examples` is a low-noise collection (not shown in the normal workspace view) that Thymer syncs natively. Using the same collection for saved views requires no new collection provisioning in the common case, and keeps the plugin's footprint small.

If neither `Settings` nor `Examples` exists, the collection resolution returns `null` and the API degrades gracefully (all calls return empty results or `null`). No record is created until a collection is available.

---

## `window.__refx.referenceViews` API

```typescript
interface ReferenceViewsApi {
  list(): Promise<ReferenceViewV1[]>;
  get(viewGuid: string): Promise<ReferenceViewV1 | null>;
  save(config: Partial<ReferenceViewV1>, parentRevisionId?: string): Promise<{viewGuid: string, revisionId: string} | null>;
  heads(viewGuid: string): Promise<ReferenceViewRevisionV1[]>;
  resolveConflict(
    viewGuid: string,
    opts:
      | { chosenRevisionId: string }
      | { mergedConfig: Partial<ReferenceViewV1>; parentRevisionIds: string[] }
  ): Promise<ReferenceViewRevisionV1 | null>;
  subscribe(cb: (event: {type: 'saved'|'resolved', viewGuid: string, revisionId: string}) => void): () => void;
  _dispose(): void; // internal — called by _killStaleObservers on hot-reload
}
```

The API object is installed at `window.__refx.referenceViews` and mirrored on `window.__refxSavedViews` for hot-reload disposal. On hot-reload, `_killStaleObservers` calls `window.__refxSavedViews._dispose()` before the new instance installs a fresh API. Calls on a disposed API return `null` / `[]` harmlessly.

---

## Pin migration (R6 M1)

Legacy inline-section pins (`refx_pin` line meta) stored raw target guids. After R6, each pin target corresponds to a saved view rather than being an ad-hoc config.

**Migration is idempotent**: run once per client.

| Step | Detail |
|---|---|
| Detect legacy pins | Read `_pins` in-memory map (populated by `_rehydrate`) |
| Derive view name | `Pin View:<guid[:12]>` — deterministic, stable across re-runs |
| Find or skip | Search the collection for a record with that exact name; if found, skip |
| Create view | `referenceViews.save(config)` with `targets: [targetGuid]` |
| Mark done | `localStorage.setItem('refx_r6_pin_mig_v1', 'done')` |

Re-running migration (e.g., on a new client): existing `Pin View:*` records are found by name → no new records created.

---

## Per-device presentation preferences (local only)

These fields are intentionally NOT synced and stay in localStorage:

| localStorage key | Description |
|---|---|
| `refx_r6_client_id` | Stable per-device client ID (`cl_<timestamp36>_<random>`) used as `authorClientId` in revisions |
| `refx_r6_dev_prefs_<viewGuid>` | Reserved for future: column widths, panel position, last-visited page cursor |
| `refx_r6_pin_mig_v1` | Pin migration completion flag (`"done"`) |
