/**
 * What a PDF tile can be asked to do, and how those actions reach the user.
 *
 * The same shape as `shell/docking/actions.ts` and for the same reason: an
 * action declared in one place cannot end up with a keybind and no visible
 * path, or a button and no shortcut. {@link PdfActions} is the verb list the
 * instance implements; {@link pdfToolbarControls} and {@link pdfKeybinds}
 * derive the two surfaces from it.
 *
 * ## Eight listed shortcuts, and what used to be here
 *
 * The first version of this file had sixteen. That is more rows than the
 * *whole shell* lists, for one file type, and it made the reference modal read
 * as a manual rather than a reminder. The cuts, and why each one was the one to
 * go:
 *
 *   - **first / last page** (`Home`, `End`). Two bindings to reach the two
 *     places a scrollbar already reaches in one gesture.
 *   - **fit page, fit width, reset zoom** — three keys for "make it fit". They
 *     are one key now. Fit-*width* is the survivor because it is the default
 *     view and what a reader wants back; the others are reachable by zooming.
 *   - **cycle the inversion tint.** A per-document reading preference on a
 *     top-level key, discovered by accident if at all.
 *   - **per-page inversion override, and two region-overlay toggles.**
 *     Inversion is one switch for the whole document, so there is nothing for a
 *     per-page exception to disagree with and nothing to inspect.
 *   - **copy this page's text.** Selecting and pressing `Mod+C` is the copy
 *     path everyone already knows; a whole-page variant on its own key was a
 *     second way to do a job the first way does well enough.
 *
 * What is left is page navigation, zoom, fit, invert and print — the things
 * someone reading a PDF actually reaches for. OCR stays registered but
 * `hidden`, because the phase brief requires an explicit extraction action and
 * because with no OCR hook installed (the default) a listed row would advertise
 * something that always declines.
 *
 * ## The one row phase 05a added, weighed against those
 *
 * `a` — annotate — is the eighth, and the phase brief requires the addition to
 * be argued rather than assumed. The argument: it is a *mode*, entered and left
 * repeatedly through a review pass, and a mode toggle is the case a keyboard
 * shortcut is for. It displaces nothing, because before this phase the tile had
 * no annotation verb at all. And it is the *only* row the phase adds — the ten
 * tools, the colours, the widths, the z-order and the save all live in the
 * palette that opens with it (`annotatePalette.ts`), because a row per tool
 * would be exactly the manual this list was cut down to stop being.
 *
 * The four bindings that come with annotate mode — undo, redo, delete the
 * selection, and Escape — are registered `hidden` and only while the mode is
 * on. Each has a visible button in the palette, so nothing is discoverable only
 * by guessing, and none of them costs a row in a reference modal that is meant
 * to be read at a glance. The self-test asserts the listed count exactly, so the
 * next addition is a decision rather than a drift.
 *
 * ## The ninth row: `Mod+S`
 *
 * Written down here because the count above says it has to be. Save is the one
 * annotation verb whose cost is not "click a different button" — it is the verb
 * that puts the work on disk, and every application that has one binds it to
 * `Mod+S`. A user who has drawn on a page and pressed `Mod+S` has *said* they
 * expect this; leaving it unbound means the marks live only in this session and
 * the palette's `save` chip is the sole way out.
 *
 * It is listed rather than hidden — the opposite call from annotate mode's four
 * — because those four are only reachable while a palette showing the same four
 * buttons is on screen, and this one is not: `Mod+S` works with the mode off,
 * on a document whose marks were drawn ten minutes ago. A shortcut that works
 * when its palette is gone has to be listed somewhere, and the reference modal
 * is that somewhere.
 *
 * `enabled()` gates it on there being marks at all, so on the overwhelming
 * majority of PDFs — the ones nobody has drawn on — `Mod+S` is not consumed and
 * stays available to whatever the shell does with it later.
 *
 * ## Phase 05b added none, and that was the decision
 *
 * Text-anchored highlights and notes are made from a *selection*, and the
 * popover that offers them appears on the selection itself (`textAnnotate.ts`) —
 * at the point the user is already looking, naming both actions. A
 * "highlight the selection" accelerator would be a tenth listed row for
 * something already one click away and already discoverable, and the brief asks
 * for exactly this comparison to be made against the cap rather than assumed.
 * The count in the self-test stays at nine, which is what makes the next
 * addition a decision someone has to write down here.
 *
 * ## The keys, and what they avoid
 *
 * The shell owns every `Mod`+letter, `Mod`+digit and `Mod`+arrow it wants
 * (AGENTS.md: "`Mod`+digit is spoken for"). So these live in two spaces the
 * shell has left alone: the document keys a reader already reaches for
 * (`PageUp`, `PageDown`) and bare letters, which are safe because the registry
 * refuses to fire an unmodified binding while a text field has focus — a PDF's
 * text layer is selectable but not editable, so selection and shortcuts
 * coexist. `Mod+=`, `Mod+-` and `Mod+P` are the deliberate exceptions:
 * conventional enough that moving them would be worse, and unclaimed.
 */

import type { ToolbarControl, ViewerKeybind } from "../contract";

/** The verbs. Implemented by the instance, consumed by the two surfaces below. */
export interface PdfActions {
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly zoomPercent: number;
  readonly inverted: boolean;

  /** Whether annotate mode is on, and what it currently allows. */
  readonly annotating: boolean;
  readonly canUndoAnnotation: boolean;
  readonly canRedoAnnotation: boolean;
  readonly hasAnnotationSelection: boolean;
  /** True while a text callout or note is being typed into. */
  readonly editingAnnotation: boolean;
  /** Whether this document carries any marks — i.e. whether there is a save. */
  readonly hasAnnotations: boolean;

  nextPage(): void;
  previousPage(): void;

  zoomIn(): void;
  zoomOut(): void;
  fitWidth(): void;

  setInverted(inverted: boolean): void;
  toggleInverted(): void;

  setAnnotating(annotating: boolean): void;
  toggleAnnotating(): void;
  undoAnnotation(): void;
  redoAnnotation(): void;
  deleteAnnotation(): void;
  escapeAnnotation(): void;
  saveAnnotations(): void;

  extractTextWithOcr(): void;
  print(): void;
}

export function pdfToolbarControls(actions: PdfActions): readonly ToolbarControl[] {
  const single = actions.pageCount <= 1;
  return [
    {
      kind: "button",
      id: "page.previous",
      label: "‹",
      title: "previous page",
      accelerator: "PageUp",
      order: 10,
      disabled: single || actions.pageNumber <= 1,
      run: () => actions.previousPage(),
    },
    {
      kind: "readout",
      id: "page.position",
      label: "page",
      title: "page position",
      order: 11,
      value: `${actions.pageNumber} / ${actions.pageCount}`,
    },
    {
      kind: "button",
      id: "page.next",
      label: "›",
      title: "next page",
      accelerator: "PageDown",
      order: 12,
      disabled: single || actions.pageNumber >= actions.pageCount,
      run: () => actions.nextPage(),
    },
    {
      kind: "button",
      id: "zoom.out",
      label: "−",
      title: "zoom out",
      accelerator: "Mod+-",
      order: 20,
      run: () => actions.zoomOut(),
    },
    {
      kind: "readout",
      id: "zoom.level",
      label: "zoom",
      title: "zoom level",
      order: 21,
      value: `${actions.zoomPercent}%`,
    },
    {
      kind: "button",
      id: "zoom.in",
      label: "+",
      title: "zoom in",
      accelerator: "Mod+=",
      order: 22,
      run: () => actions.zoomIn(),
    },
    {
      // A toggle: inversion is one thing the whole document either is or is
      // not. It reports its state as well as setting it, which is what keeps it
      // in step with the `i` shortcut.
      kind: "toggle",
      id: "invert.toggle",
      label: "invert",
      title: "invert the page",
      accelerator: "i",
      order: 30,
      value: actions.inverted,
      setValue: (value) => actions.setInverted(value),
    },
    {
      // The whole of phase 05a's toolbar footprint: one toggle. Everything else
      // it adds is in the palette this opens, inside the tile being annotated.
      kind: "toggle",
      id: "annotate.toggle",
      label: "annotate",
      title: "draw, highlight and comment on this document",
      accelerator: "a",
      order: 40,
      value: actions.annotating,
      setValue: (value) => actions.setAnnotating(value),
    },
  ];
}

export function pdfKeybinds(actions: PdfActions): readonly ViewerKeybind[] {
  return [
    {
      id: "page.next",
      label: "next page",
      keys: ["PageDown"],
      order: 10,
      run: () => actions.nextPage(),
    },
    {
      id: "page.previous",
      label: "previous page",
      keys: ["PageUp"],
      order: 11,
      run: () => actions.previousPage(),
    },
    {
      id: "zoom.in",
      label: "zoom in",
      keys: ["Mod+="],
      order: 20,
      run: () => actions.zoomIn(),
    },
    {
      id: "zoom.out",
      label: "zoom out",
      keys: ["Mod+-"],
      order: 21,
      run: () => actions.zoomOut(),
    },
    {
      id: "zoom.fitWidth",
      label: "fit the page width",
      keys: ["f"],
      order: 22,
      run: () => actions.fitWidth(),
    },
    {
      id: "invert.toggle",
      label: "invert the page",
      keys: ["i"],
      order: 30,
      run: () => actions.toggleInverted(),
    },
    {
      id: "annotate.toggle",
      label: "annotate this document",
      keys: ["a"],
      order: 35,
      run: () => actions.toggleAnnotating(),
    },
    {
      // The ninth listed row, argued in the module comment above. Enabled only
      // when there is something to write, so an unannotated PDF leaves the key
      // alone entirely.
      id: "annotate.save",
      label: "save the annotated copy",
      keys: ["Mod+S"],
      order: 36,
      enabled: () => actions.hasAnnotations,
      run: () => actions.saveAnnotations(),
    },
    {
      id: "print",
      label: "print the original document",
      keys: ["Mod+P"],
      order: 40,
      run: () => actions.print(),
    },
    // ---- annotate mode only, and deliberately unlisted ---------------------
    //
    // Live only while the mode is on, through `enabled()` rather than through
    // registering and unregistering: a binding that is not enabled does not
    // consume the key press (see the registry), so `Delete` deletes a mark with
    // the palette open and is left entirely alone otherwise. Each has a button
    // in the palette; none is worth a row in a modal read at a glance.
    //
    // `Mod+Z` is a `Mod`+letter, which AGENTS.md reserves for the shell — the
    // same deliberate exception `Mod+=`, `Mod+-` and `Mod+P` already are:
    // conventional to the point that moving it would be worse than the risk,
    // and unclaimed (the shell's letters are O, B, W, M, R, G).
    {
      id: "annotate.undo",
      label: "undo the last annotation change",
      keys: ["Mod+Z"],
      order: 60,
      hidden: true,
      enabled: () => actions.annotating && !actions.editingAnnotation,
      run: () => actions.undoAnnotation(),
    },
    {
      id: "annotate.redo",
      label: "redo",
      keys: ["Mod+Shift+Z"],
      order: 61,
      hidden: true,
      enabled: () => actions.annotating && !actions.editingAnnotation,
      run: () => actions.redoAnnotation(),
    },
    {
      // Two accelerators on one binding, which the one-binding-per-job rule
      // would normally count as a second chip in the modal. It is hidden, so
      // there is no chip and no cost — and both keys mean delete to everyone.
      id: "annotate.delete",
      label: "delete the selected annotation",
      keys: ["Delete", "Backspace"],
      order: 62,
      hidden: true,
      enabled: () => actions.annotating && actions.hasAnnotationSelection,
      run: () => actions.deleteAnnotation(),
    },
    {
      id: "annotate.escape",
      label: "leave annotate mode",
      keys: ["Escape"],
      order: 63,
      hidden: true,
      enabled: () => actions.annotating,
      run: () => actions.escapeAnnotation(),
    },
    {
      // Registered but not listed. The phase brief requires an explicit
      // extraction action, and no OCR hook ships by default — so a listed row
      // would advertise a shortcut that, on every install, only ever explains
      // why it cannot run.
      id: "text.ocr",
      label: "extract text from this page (OCR)",
      keys: ["e"],
      order: 50,
      hidden: true,
      run: () => actions.extractTextWithOcr(),
    },
  ];
}
