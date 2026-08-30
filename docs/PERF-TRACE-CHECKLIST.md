# RefX Performance Trace Checklist

Chrome DevTools steps for verifying live performance after deploy.
Run these on the **desktop app** (or the web tab after a hard reload) against a real
workspace with a busy record — one with 200+ inbound refs is ideal for stress-testing
the sorted-list cache.

---

## 0. Pre-flight: confirm the deployed version

Open the browser console on the Thymer tab and run:

```js
window.__REFX_VERSION          // must print "4.1.0"
window.__refgraph?.version     // must print "0.8.0" (if graph plugin is installed)
```

If either is wrong the plugin wasn't picked up; reload the tab and try again.

---

## 1. Inline-refs panel open latency (BENCH-2 / BENCH-6 analog)

**What we measure**: time from the user clicking the inline-refs icon to the panel
showing populated results. The hot path is `broker.edges({ targetGuid })` → sorted-list
cache hit after first call.

### Steps

1. Open DevTools → **Performance** tab → click the record button.
2. In Thymer, navigate to the busiest record (most inbound refs). Use the command palette
   to filter by title if needed.
3. Click the inline-refs icon to open the panel.
4. Wait for results to populate, then stop the recording.

### What to look at

- In the flame chart, find the `_fillInlineRefs` or `_openInlineRefsPanel` JS frame.
- The first open: `broker.edges()` hits a cache miss — expect **<30 ms** total (sort + filter
  once over ≤10 k edges, including microtask debounce).
- Subsequent opens of the same panel at the same revision: `_sortedCache.get()` returns
  immediately — should be **<2 ms** per call.
- Look for a `_aliasScheduleFrequentScan` call; it must NOT block the main thread (it
  schedules a 250 ms deferred, not inline).

### Console one-liner (no DevTools recording needed)

```js
// Measure a cold + warm broker.edges() call pair in the console.
// Requires the plugin to be loaded and a target guid.
const targetGuid = '...';    // paste any real record guid
const broker = window.__REFX_BROKER;   // exposed by the plugin
const t0 = performance.now();
const p1 = broker.edges({ filter: { targetGuid }, limit: 50 });
const t1 = performance.now();
const p2 = broker.edges({ filter: { targetGuid }, limit: 50, after: p1.cursor });
const t2 = performance.now();
console.log('cold (cache miss):', (t1 - t0).toFixed(1), 'ms');
console.log('warm (cache hit): ', (t2 - t1).toFixed(1), 'ms');
// Expected: cold <30 ms, warm <2 ms.
```

---

## 2. Typing-with-panel-open mutation counts

**What we measure**: how many times the MutationObserver callback fires while typing in a
record that has the inline-refs panel open. The guard `if (!relevant && !aliasRelevant &&
!queryRelevant) return;` should reject most mutations immediately.

### Steps

1. Open DevTools → **Console**, paste the snippet below, press Enter.
2. Open the inline-refs panel on a busy record.
3. Type 20 characters normally in the record body.
4. Read the printed counts.

```js
// Intercept RefX's MutationObserver to count fired vs rejected callbacks.
let fired = 0, rejected = 0;
const origMO = window.MutationObserver;
window.MutationObserver = class extends origMO {
  constructor(cb) {
    super((muts, obs) => {
      fired++;
      cb(muts, obs);
    });
  }
};
console.log('MO patch active — type in a record body with the refs panel open.');
// After typing, check:
// console.log('MO callbacks fired:', fired);
```

**Good numbers**: fired callbacks ≤ 2–3 per keystroke (one for the text node, one for any
badge update). If fired > 10 per keystroke investigate the observer selector — it may be
reacting to unrelated nodes (e.g., a cursor class churn).

### Selector to check

In the plugin source search for `new MutationObserver`. The observer should only watch
`{ childList: true, subtree: true, characterData: true }` on the record's `.listview-items`
container, NOT on `document.body`.

---

## 3. Reference Graph open timing (BENCH-G2 analog)

**What we measure**: time from opening the graph overlay to the D3 force simulation
starting with all nodes placed. Hot path is `_brokerEdgesAll()` → the sorted-list-cached
`broker.edges()`.

### Steps

1. Open DevTools → **Performance** tab → record.
2. Open the Reference Graph panel (command palette → "Reference Graph").
3. Wait for the canvas to appear with nodes, then stop.

### What to look at

- Find the `_buildGraph` JS frame in the flame chart.
- `_brokerEdgesAll` is a tight pagination loop; each `broker.edges()` call is a cache hit
  after the first page. Total time for 90 edges (MAX_EDGES): **<5 ms**.
- `ensureSource` / `ensureTarget` calls are the scoped-hydration phase — they fire only
  once per guid (cached internally). Each is async but sequential; 200 guids at ~0.1 ms
  each = **~20 ms** worst case.
- The D3 `forceSimulation` setup itself takes **<5 ms**; the tick loop runs async.

### Console tell

```js
// Time the graph build synchronously via the bridge.
const bridge = window.__refgraph;
if (!bridge) { console.error('graph plugin not loaded'); }
else {
  const t0 = performance.now();
  // Trigger a graph rebuild for the currently active record.
  bridge.rebuild?.();
  console.log('rebuild triggered; check DevTools flame chart for _buildGraph duration');
}
```

---

## 4. R9 Reference-Health scan timing

**What we measure**: the full-workspace R9 health scan at 10 k+ edges. The scan is
broker-based, cancelable, and runs in 64-edge cooperative slices.

### Steps

1. Open the Reference Graph panel on any record.
2. Click the "Scan" (health scan) button.
3. In DevTools → **Performance** → check the recorded timeline for task slice duration.

### What to look for

- Each slice is `<=64 edges` with a `Date.now() - sliceStartedAt < 8` yield guard.
- No single task should exceed **16 ms** (one frame budget).
- Total scan time for 10 k edges: **<400 ms** (benchmark verified).
- The cancel button must interrupt the scan within one slice (<8 ms after click).

### Console tell for cancellation

```js
// After triggering a scan, immediately cancel it.
const bridge = window.__refgraph;
bridge?.r9?.cancel?.();
// The scan should stop within 8 ms; check console for "R9 scan cancelled" message.
```

---

## 5. Cold-start hydration (must NOT walk line bodies at startup)

**What we measure**: that startup hydration seeds record identities but does not call
`getLineItems` on every record.

### Steps

1. Open DevTools → **Sources** tab → add a breakpoint on `getLineItems` (search in
   plugin source, or use `debug(thymerInstance.getLineItems)`).
2. Reload the tab.
3. Wait for the plugin to finish loading (console shows `[RefX] hydration complete`).
4. If the breakpoint never fires during hydration → pass. If it fires → investigate
   which path triggered it.

### Console verification

```js
// Patch getLineItems before reload to catch any startup call.
const orig = window.__thymerSDK?.getLineItems;  // adjust to actual handle
if (orig) {
  let callCount = 0;
  window.__thymerSDK.getLineItems = function(...a) {
    callCount++;
    console.trace('getLineItems call #' + callCount);
    return orig.apply(this, a);
  };
  console.log('getLineItems patched — reload and watch for stack traces during hydration');
}
```

Expected: zero calls to `getLineItems` during the hydration phase (before the first user
interaction). Demand-driven line hydration means `getLineItems` fires only from
`ensureTarget` / `ensureSource`, never from `startHydration`.

---

## 6. Alias cold-scan gate (demand-driven, not startup tax)

Confirm that `_aliasScheduleFrequentScan(250)` is NOT called at plugin load unless a
managed record is already active.

```js
// Patch the scheduler before the plugin initialises (run in console before page loads,
// or inject via DevTools Snippets).
const origSet = window.setTimeout;
window.setTimeout = function(fn, delay, ...rest) {
  if (delay === 250 && fn.toString().includes('_aliasFrequentScan')) {
    console.trace('alias 250ms scan scheduled — should NOT happen at cold start');
  }
  return origSet.call(this, fn, delay, ...rest);
};
```

If the trace fires before any user action, check that the alias-manage guard is in place:

```
if (self._aliasManageRecordGuid || self._lineAliasManageLineGuid) {
  self._aliasScheduleFrequentScan(250);
}
```

---

## Reference: benchmark thresholds (from bench-10k.test.cjs)

| Bench | Description | Node threshold | Typical measured |
|-------|-------------|---------------|-----------------|
| BENCH-1 | Hydrate 10k edges into broker | <400 ms | ~180 ms |
| BENCH-2 | 200 paginated edge pages, same revision | <4000 ms | ~10 ms (99× from 996 ms) |
| BENCH-3 | Inline-refs warm registry scan (50k lines) | <200 ms | ~21 ms |
| BENCH-5 | R7 facet snapshot on 10k inbound edges | <400 ms | ~15 ms |
| BENCH-6 | 10k individual `broker.edges()` calls | <2000 ms | ~8 ms (49× from 392 ms) |
| BENCH-7 | Binary-search cursor seek, 10k edges × 100 | <200 ms | ~12 ms |
| BENCH-G1 | Graph `_buildGraph`, 200 hop-1 neighbors | <300 ms | ~30 ms |
| BENCH-G2 | `_brokerEdgesAll` pagination, 10k inbound | <100 ms | ~3 ms |
| BENCH-G3 | R9 full scan, 10k edges | <400 ms | ~120 ms |

Run locally at any time:

```bash
# RefX:
node --test test/bench-10k.test.cjs

# Reference Graph:
node --test test/bench-10k.test.cjs
```
