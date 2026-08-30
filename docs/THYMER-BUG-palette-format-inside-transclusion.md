# Thymer bug report — palette line-format commands destroy transclusions when the caret is inside one

**Reported by:** Svyatoslav Kleshchev · **Date:** 2026-07-16 · **Client:** web (svyat.thymer.com), Chrome, macOS

## Summary

With the caret inside a **transclusion's body** (a native `transclusion` line item rendering another record's lines), opening the command palette (Cmd+P) works, but applying a **line-format command** (Heading 1/2/3, …) does not format the caret's line. Instead the command **retargets the transclusion HOST line** and converts *it* to the chosen type — which destroys the embed: the transclusion line loses its `transclusion` type and renders as a plain line (we observed a literal stray text line reading `transclusion`). Cmd+Z restores it.

## Steps to reproduce

1. On any page, create a transclusion line item pointing at another record (e.g. via a plugin `createLineItem(parent, null, "transclusion", null, { itemref: <recordGuid> })`, or any native transclusion).
2. Click into a line **inside** the transclusion body — caret visibly inside the embed (we verified via the line's `data-guid` belonging to the target record).
3. Press **Cmd+P** → the palette opens normally and offers "Heading 1 / Heading 2 / Heading 3".
4. Choose **Heading 3** (Enter).

## Expected

The caret's line (inside the transcluded body — a line of the *target* record) becomes an H3, exactly as it would if edited on its home page. (Inline text editing inside transclusions already writes through to the source correctly, so the palette should too.)

## Actual

The caret line is unchanged. The **transclusion host line** is converted to a heading instead — the embed collapses and the host line renders as plain text (`transclusion`). No error. Cmd+Z restores the transclusion.

## Evidence (instrumented repro, 2026-07-16)

- Caret placement verified inside the embed: active line `data-guid` = a line of the **target** record; status bar `Ln 25`; `line.closest('.transclusion-container-div') !== null`.
- After applying "Heading 3": the caret's line class list unchanged (`listitem-task` in our repro); a new visible line with literal text `transclusion` appeared at the host line's position; the embed's `.transclusion-container-div` was gone.
- No plugin interference: a window-capture keydown logger showed Cmd+P reaching the document with `defaultPrevented: false`; a full audit of our plugins' key handlers found none matching Cmd+P.
- Undo (Cmd+Z) fully restored the transclusion.

## Impact

Any user who edits inside a transclusion (a headline Thymer feature) and reaches for the palette to format a line silently destroys the embed instead. Data is recoverable via undo, but the failure is invisible at the moment it happens (the palette closes; the damage is off-screen at the host line).

## Suspected cause

The palette's line-format commands resolve their target from the panel's notion of the current line at the *page's* level (the host `transclusion` line item), rather than from the caret's actual line within the transcluded subtree. Inline typing uses the correct (inner) line, so the resolution divergence appears specific to the palette command path.
