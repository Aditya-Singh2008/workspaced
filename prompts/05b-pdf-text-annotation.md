# Phase 5b: PDF Text Selection and Text-Anchored Annotation

Depends on Phase 5a being complete. Also depends on Phase 3's text layer. Read AGENTS.md's "Annotation model and export" section before starting; this brief assumes it, and builds the resolver that section describes phase 06 will later reuse.

## Goal

Two things, in order. First: confirm text in a PDF is reliably selectable and copyable whether it came from the document's own vector text or from an OCR pass that embedded a text layer over a scanned image, since both must behave identically and Phase 3 may not have been tested against the OCR case specifically. Second: go beyond Phase 5a's freehand, drawn highlighting to add highlights and notes anchored to actual selected text, resilient to the document being reflowed or re-rendered, and built so the same mechanism can be reused by future text-based plugins (`txt`, `docx`) without modification.

**Do not confuse this phase's OCR concern with the existing OCR hook.** `src/viewers/pdf/ocr.ts` (from Phase 3, backed by `tesseract.js`) is live, on-demand OCR triggered by the user for a scanned page that has *no* text layer at all. This phase is about the opposite and more common case: a PDF that has *already* been through OCR (by Acrobat, a scanner's software, or any other tool) and already has an embedded, typically invisible, text layer sitting over the scanned image. That text arrives through `pdf.js`'s normal `getTextContent()` exactly like native vector text; there is no live OCR to run and no reason to touch `ocr.ts` for this phase's work.

## Tasks

**Verify and harden OCR-embedded text handling**

1. Confirm the Phase 3 text layer includes text items rendered in invisible mode (PDF text-rendering mode 3), which is how OCR text is typically embedded over a scanned page image, not just visible glyphs. If anything in the current text layer implementation filters these out (a reasonable-looking but wrong optimization, since invisible text is invisible on purpose but must still be selectable), fix it.
2. Test against a real scanned-and-OCR'd PDF, not only native-text fixtures. If Phase 3's in-memory `dev/` fixture (used so the self-test needs nothing on disk) doesn't already include an OCR-style invisible-text case, add one there.
3. Confirm selection, copy, and positioning are pixel-correct at multiple zoom levels for the OCR case, exactly as they already are for native text.

**Build the `TextAnchor` model (`annotation/text/`)**

1. Implement the `TextAnchor` type exactly as specified in AGENTS.md: `{ quote, prefix, suffix, pageHint, offsetHint }`. The quote and its surrounding context are the durable identity; the hint fields are a fast path, always re-verified against the quote rather than trusted outright.
2. Implement anchor construction from a live selection: given a text selection inside the Phase 3 text layer, capture the selected string as `quote`, walk a fixed character budget outward in that page's extracted text to build `prefix`/`suffix`, and record the page number and offset as the hint.
3. Implement anchor resolution: given a `TextAnchor`, locate the quote (hint first, falling back to a page or document search if the hint doesn't match) and resolve the matched character range to one or more page-relative rectangles for rendering, using the same text-item geometry that backs the Phase 3 text layer. Build this resolver in `viewers/pdf/textGeometry.ts`, not inline in a component, since Phase 06 will import it for search-match highlighting rather than writing a second version, per AGENTS.md.
4. A highlight spanning a line wrap must resolve to multiple contiguous rectangles, not a single malformed box. Feed these into `annotation/overlay/`'s existing rectangle rendering rather than building a second rendering path; a resolved text anchor and a drawn highlight are visually the same primitive once resolved to rectangles, they only differ in how their position was determined.

**Selection-driven interaction**

1. On a text selection inside a PDF tile, show a small contextual popover near the selection with two actions: "Highlight" and "Add note." This is a new, self-contained interaction, not a toolbar control and not a new listed keybind, so it doesn't compete with the six-row cap discussed in Phase 5a. If a fast keybind for "highlight current selection" is still wanted, weigh it explicitly against that cap first, exactly as Phase 5a was instructed to.
2. "Highlight" creates a `TextAnchor`-targeted highlight immediately, using the last-used highlight color from Phase 5a's shared color picker. There is one highlight color picker in this plugin, not two.
3. "Add note" creates the same `TextAnchor`-targeted highlight and opens a small note-entry popover; the resulting note text is stored attached to that anchor.
4. Both actions must work identically for OCR-embedded text and native text, which the first task's verification exists to guarantee.

**Annotation list panel**

1. Extend the Phase 5a sidebar "Annotations" tab to include text-anchored entries. Do not build a second list or a second tab.
2. A text-anchored entry shows the quote (truncated to a readable length) and the note text if present, not just a page number, since the point of this model is the words, not the position.
3. Clicking a text-anchored entry uses the same `reveal(location)` mechanism as everything else in this list and in the shell generally.

**Export**

1. Reuse Phase 5a's save pipeline and annotated-flag mechanism entirely. Do not build a second export path.
2. Text-anchored highlights export as PDF `Highlight` annotation objects, with `QuadPoints` geometry derived from the same rectangles produced by the resolver above. Text-anchored notes export as `Text`/`Popup` annotation objects positioned at the anchor's resolved start.

**Forward compatibility for future text-based plugins**

1. `annotation/text/`'s `TextAnchor` type and its build/resolve functions must not import anything from `viewers/pdf/`. The PDF-specific half of this (turning a page-and-text-item geometry into resolved rectangles) lives in `viewers/pdf/textGeometry.ts`, reached through a small capability the PDF plugin exposes via the same contract-extension procedure used elsewhere (something like: given a selection, produce `{quote, prefix, suffix, hint}`; given an anchor, resolve it to renderable regions). A future `txt` or `docx` plugin implements the same small capability against plain character offsets instead of page-and-glyph geometry, and gets highlighting and notes for free from the shared `annotation/text/` code with no changes to it.
2. If you find yourself writing a PDF-specific branch inside `annotation/text/` itself, the capability boundary is in the wrong place; move the PDF-specific part into `viewers/pdf/` and keep `annotation/text/` generic.

## Verification

1. Native-text PDF: select a sentence, highlight it; select a different passage, add a note to it; confirm both render correctly and export as real `Highlight`/`Text` annotation objects, openable and recognized as such in another PDF reader.
2. Scanned-and-OCR'd PDF: repeat the same test. Confirm the invisible OCR text layer is selectable, correctly positioned at multiple zoom levels, and behaves identically to the native-text case for both highlighting and note-adding.
3. Create a highlight that spans a line wrap; confirm it renders as multiple contiguous rectangles rather than one malformed box.
4. Save the file, reopen it, and confirm every previously created highlight and note still resolves to the correct text via the quote (not the hint alone), including after the save-triggered re-layout from Phase 5a's export.
5. Confirm the sidebar Annotations list correctly shows both Phase 5a's overlay entries and this phase's text-anchored entries together, each distinguishable, each jumping correctly via `reveal()`.
6. Confirm `annotation/text/` has zero imports from `viewers/pdf/` by checking the module directly, not just by inspection of a few files.
7. Confirm no new listed PDF keybind rows were added without explicit justification against the existing cap.

## Constraints

Do not implement a second highlight rendering system, a second export pipeline, or a second annotated-flag mechanism; extend Phase 5a's. Do not let the OCR concern in this phase touch or duplicate `src/viewers/pdf/ocr.ts`; they solve different problems, as described above. Do not couple `annotation/text/`'s core model to PDF geometry; the entire point of this phase's second half is that it isn't PDF's forever, even though PDF is its only consumer today.
