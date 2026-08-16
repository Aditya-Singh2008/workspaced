/**
 * The optional, opt-in OCR hook.
 *
 * Nothing heavy is bundled and nothing here is registered by default. A host
 * that wants text extraction from scanned pages calls {@link registerPdfOcr}
 * with an async function — which is where a `tesseract.js` import gets
 * lazy-loaded — and this plugin wires it in. With no hook registered, the
 * extract action says so plainly instead of appearing to do nothing.
 *
 * AGENTS.md is explicit that OCR is "never bundled into the core app; loaded on
 * demand through the plugin hook". Keeping the surface this small is what makes
 * that enforceable: there is nothing here to import.
 */

/**
 * Extracts text from a rendered page.
 *
 * Returning `null`, or throwing, is reported to the user as "no text found"
 * rather than failing the tile.
 */
export type PdfOcr = (
  image: ImageData,
  context: { readonly pageNumber: number },
) => Promise<string | null>;

let ocr: PdfOcr | null = null;

/** Installs (or, with `null`, removes) the OCR hook. */
export function registerPdfOcr(hook: PdfOcr | null): void {
  ocr = hook;
}

export function getPdfOcr(): PdfOcr | null {
  return ocr;
}
