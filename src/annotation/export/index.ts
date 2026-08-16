/**
 * Per-plugin export bridges.
 *
 * One module per file type that can carry annotations out to disk, each turning
 * the shared, file-type-agnostic model into that format's own idea of an
 * annotation. Only `pdf.ts` exists so far; an image plugin opting into
 * annotation would add `image.ts` beside it and change nothing in `overlay/`.
 *
 * **This barrel exports types only, deliberately.** `pdf.ts` pulls in pdf-lib,
 * which is a megabyte no session that never saves an annotation should have to
 * parse — and a value re-export here would drag it in through anything that
 * touched `annotation/`. Call sites import the bridge directly, and the PDF
 * plugin does so with a dynamic `import()` inside its save path, the same way it
 * defers pdf.js itself.
 */

export type { PageSpace, PdfAnnotationExportOptions } from "./pdf";
