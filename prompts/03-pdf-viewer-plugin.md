# Phase 3: PDF Viewer Plugin

Depends on Phase 1 and Phase 2 being complete. This phase builds the first real Viewer Plugin, bringing forward the PDF-specific capabilities that earned their place in the original implementation, now built against the Phase 1 contract and mounted through the Phase 2 docking shell.

## Goal

A PDF viewer that is fast to scroll, comfortable to read and short to learn, minus the layout system (already replaced) and minus the toolbar chrome (already generalized), implemented as a self-contained plugin under `src/viewers/pdf/`.

## Reference material

The original `index.html` contains a validated implementation of tiling (superseded, do not port) and text handling. Port the algorithmic parts, not the DOM-manipulation parts.

## Tasks

**Rendering pipeline**

1. Implement PDF loading and page rendering using `pdf.js` as an npm dependency, drawing each page straight to its visible canvas.
2. Implement virtualized page rendering: only render pages near the current viewport, free resources for pages that scroll far out of view, matching the resource-bounding behavior the original had.
3. **Scrolling fast must stay responsive.** That is a property of scheduling, not of raw speed: render the pages nearest the viewport first, abandon renders for pages the reader has already scrolled past, cap how many run at once, and stop rendering ahead while the scroll is moving quickly. Defer anything expensive and invisible mid-flight — the text layer especially — until the scroll settles.

**Dark-mode inversion**

1. One toggle for the whole document, applied as a CSS filter on the page canvas so flipping it is instant at any zoom and any page count, and so the canvas pixels stay in the document's own colours.
2. Invert hue back after inverting luminance, or coloured diagrams come out in their complements.
3. Do not build partial or per-region inversion. See AGENTS.md, "Dark-mode inversion", for what was tried and why it is not here.

**Text layer and copy**

1. Render a proper text layer via `pdf.js`'s text layer rendering for pages with native text content, enabling standard browser text selection in correct logical (not visual) order.
2. Implement the plugin contract's copy method to expose selected text for the shell's clipboard system.
3. For scanned pages with no text layer, do not attempt extraction by default. Expose an explicit "extract text from this region" action that calls the optional OCR plugin hook only when the user invokes it; if no OCR hook is registered, surface a clear message through the shell rather than failing silently.

**Thumbnails**

1. Implement correct thumbnail generation for the plugin contract's thumbnail method: render each page at a small fixed scale to an offscreen canvas, cache the result, and virtualize thumbnail generation so only visible or near-visible thumbnails render eagerly. The original implementation's thumbnails were broken; verify this one actually renders correctly for both native and scanned PDFs before considering this task done.
2. Decide and document whether thumbnails follow the inversion toggle or always show natural colors, consistent with whatever is more useful (natural colors is the likely right default, since a thumbnail's job is document identification, not previewing the inversion effect).

**Manual zoom**

1. Support pinch-to-zoom and ctrl-modified scroll-to-zoom gestures, cursor-centered so the focal point stays stable during the gesture.
2. Debounce continuous zoom gestures so re-rendering stays smooth, with a full-quality re-render once the gesture settles.
3. Keep keyboard and toolbar-driven zoom as equally valid alternatives.

**Toolbar contributions and keybinds**

1. Implement this plugin's contribution to the shell's contextual toolbar (from Phase 2's extension point): page navigation, zoom control, invert toggle. Keep this list short, per the consolidation principle; anything not on this list becomes a keybind, registered with the shell's keybind reference registry from Phase 2.
2. Register PDF-specific keybinds: page up/down, zoom in/out, fit, invert, print. **Keep the listed set to roughly half a dozen.** A plugin's section in the reference modal is a reminder, not a manual — every addition has to displace something, and the shell's own key spaces (`Mod`+letter, `Mod`+digit, `Mod`+arrow) are off limits.

**Print**

Implement print via the original file, unaffected by the inversion toggle and not limited to whichever pages the virtualizer happens to have rendered, consistent with the original design's print behavior.

## Verification

1. Native-text PDF: text renders sharply, selects and copies correctly in logical order.
2. Inversion flips the whole page uniformly, reads comfortably on a dark background, and leaves coloured content in recognisable hues rather than their complements.
3. The invert toggle and the invert shortcut always agree: driving either one moves the other.
4. Thumbnails render correctly and promptly for every page of a multi-page document, including scanned pages.
5. Zoom via trackpad pinch, ctrl-scroll, keyboard, and toolbar all produce consistent results and stay cursor-centered where applicable.
6. **Scrolling quickly through a long document keeps up**: pages near the viewport appear first, and flinging through it does not queue up work for pages already passed.
7. Plugin mounts and unmounts cleanly multiple times in a row inside the Phase 2 docking shell with no memory growth (every page canvas is released on unmount).

## Constraints

This plugin must not reach into shell internals or other plugins. All communication with the shell goes through the Phase 1 contract. If the contract is missing something this plugin genuinely needs, extend the contract in a file-type-agnostic way (update `contract.ts` and note the change) rather than adding a PDF-specific escape hatch.
