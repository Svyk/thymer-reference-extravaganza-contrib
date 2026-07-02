# Reference Extravaganza

Reference Extravaganza is a [Thymer](https://thymer.com) plugin for references. It does three things:

- **Reference a line of text inline:** type `[[`, search, and link any line in your workspace.
- **Alias a reference:** change what any reference chip displays (a page reference or an inline `[[` text reference), without retyping or recreating the link.
- **Inline Transclusion:** expand a selected reference in place to reveal what it points to inline, right under it — many at once, persisting across reload, and for a page reference with an editable card of its properties.

## Reference a line of text with `[[`

Thymer references a whole page out of the box; this adds references to an individual line.

1. Type `[[` anywhere in a line. A search box opens right at your cursor.
2. Keep typing to search. Results show a snippet centred on the match (matched words highlighted) with the source page beneath.
   - **Phrase search:** results match the phrase you type.
   - **Multi-term search:** use `+` to require several terms in the same line, in any order (for example `bestäm + leda`).
3. Pick a line with **↑/↓ then Enter**, or click it. A reference to that line is inserted, displaying the line's text.
4. **Esc** cancels and removes the `[[` you typed.

The box opens at the caret and the editor keeps focus, so it works mid-sentence and with several references in one paragraph.

## Alias a reference

Works on both page references and the line references you create with `[[`.

1. Select the reference you want to alias.
2. Run **Set alias for reference**, either from the Command Palette (`Cmd+P` / `Ctrl+P`) or with its keyboard shortcut, **Cmd+Shift+A** (macOS) / **Ctrl+Shift+A** (Windows/Linux).
3. A small box opens right under the reference, pre-filled with its current text (or your current alias, if you've already set one).
   - **Keep part of the text:** trim the box down to just what you want, no retyping.
   - **Type a fresh alias:** click the **×** to clear the box, then type.
   - **Clear the alias:** clear the box and press **Enter**. A page reference reverts to the page's real name; a line reference re-syncs to the target line's current text.
   - Save with **Enter**, cancel with **Esc**.

The box opens under the reference, follows your theme (light or dark), and uses Thymer's accent for the Save button.

### Changing the keyboard shortcut

The default is **Cmd+Shift+A** (macOS) / **Ctrl+Shift+A** (Windows/Linux). To rebind it, run **Set alias keyboard shortcut** from the Command Palette, press the keys you want, and click Save. It applies immediately, with no restart and no JSON. (You can also set `custom.shortcut` directly in the **Configuration** tab, e.g. `Mod+Shift+L`; `Mod` = Cmd on macOS, Ctrl elsewhere. At least one of Cmd/Ctrl/Alt is required, so the shortcut can't clash with plain typing.)

## Inline Transclusion

See what a reference points to without leaving the page you're on — and open as many as you like.

1. Select the reference (a page reference or a `[[` line reference).
2. Press **Cmd+Down** (macOS) / **Ctrl+Down** (Windows/Linux) to expand it. The referenced content appears inline, nested right under the reference: a line reference shows that line and its children; a page reference shows the page's content. It's the real thing, so you can edit it in place and your changes save to the source.
3. Press **Cmd+Up** / **Ctrl+Up** to collapse the embed for the reference under the caret (or the one the caret is inside). To clear them all, run **Collapse all embeds (this page)** from the Command Palette.

**Many at once, and they persist.** Expanding a second reference no longer collapses the first — every embed stays open. Because each embed is a real line in your document, it survives a reload; it stays until you collapse it.

**Property card on record embeds.** When you expand a *page* reference, its properties appear as a card above the body — Status, Due, numbers, relations, and so on. Click any value to edit it inline (a text/number field, a date picker, a choice picker, or a record search for relations) and the change saves straight to the record. (Line references have no properties, so they just show the line and its children.)

**Keyboard navigation of the card.** With the cursor on the record reference, press **↓** to step into the card (just like arrowing from a record's title into its properties in Thymer). **↑/↓** move a highlight through the values; **Enter** edits the highlighted value (an inline field for text/number/date, or the choice/relation picker), and the highlight returns to it once you save. **↑** from the first value, or **Esc**, returns the cursor to the reference line; **↓** past the last value drops into the embed's body. For an empty record, **↓** highlights **＋ Add content** — press **Enter** and you're typing the first line. (A Command-Palette path, **Edit embedded record (properties)**, still opens a normal Tab-through dialog if you prefer it.)

Under the hood this is a native Thymer transclusion, added when you expand. Native transclusions are body-only, so the property card is drawn by the plugin above the body and kept in sync as the embed re-renders.

## Notes & limitations

- **Property cards show up to 8 properties** (system/internal fields are always hidden). Open the record itself for the full set.
- **Cards are drawn per client**, not synced content: on a device that didn't open the embed, the card appears after discovery (typically well under a second after a change, or on focus/navigation) rather than instantly.
- **Schema changes made mid-session** (a brand-new property or collection) may take one interaction to be picked up — the plugin refreshes its schema map in the background and self-corrects.
- **Relations in the "Edit embedded record" dialog are read-only** — edit them by clicking/Enter-ing the value on the card, which opens the record picker.
- **Collapse refuses if you've nested your own lines under an embed** (move them out first) — this protects them from being deleted with the embed.
- After updating the plugin, a page reload is still the cleanest way to ensure a single fresh instance.

## Installation

1. In Thymer, open the Command Palette (`Cmd+P` / `Ctrl+P`), run **Plugins**, and click **Create Plugin** under Global Plugins.
2. In the plugin's dialog, go to the code editor (click **Edit as Code** if you see the settings view).
3. In the **Custom Code** tab, replace the contents with [`plugin.js`](plugin.js).
4. In the **Configuration** tab, replace the contents with [`plugin.json`](plugin.json).
5. Click **Save**.

Don't enable Hot Reload — it's a development feature and can leave the plugin in a state where saved data stops persisting.

## How it works

- An "alias" in Thymer is just the `title` field on a reference segment (`{type:"ref", text:{guid, title?}}`). The plugin reads and writes that field — set it to your alias, or clear it to fall back to the target's name (the page's title for a page reference, the line's current text for a line reference). Nothing else on the line is touched, and the link target never changes.
- A `[[` line reference targets a line item rather than a page; the plugin inserts it as the same `ref` segment, with the line's text as the initial title.
- It finds the reference you're on from the editor's current selection when you run the command.
- **Expanding a reference** inserts a native transclusion of the target as a child of the reference's block, tagged so the plugin can find and collapse its own embeds without touching Thymer's native ones. Because it's a real line, several coexist and they persist across reload. Collapsing is stateless — it finds the matching embed line in the document and deletes it — so it still works after a reload when no in-memory state survives.
- **Property card:** for a record embed the plugin reads the record's properties and renders an editable card above the body, kept present by a lightweight observer that only runs while at least one embed is open (and is scoped to the panel, torn down when the last embed closes).
- **Low idle cost:** with no embeds open there is no observer — the only always-on code is a few keydown listeners (the shortcut, the `[[` trigger, the expand chord), each rejecting non-matching keystrokes on its first line, so normal typing pays a couple of cheap comparisons.

## License

[MIT](LICENSE)
