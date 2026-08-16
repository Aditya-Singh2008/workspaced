/**
 * SVG, rendered as vector rather than rasterized.
 *
 * The phase brief asks for SVG that "stays crisp at any zoom level", and
 * verification item 2 checks it at 800%. Two decisions get there, and one of
 * them is also the security decision.
 *
 * ## Why the markup, and not a bitmap
 *
 * `createImageBitmap` on an SVG produces pixels at one chosen size, and any zoom
 * past that is an upscale — the same blur a JPEG gets, which is precisely what
 * the requirement rules out. So this returns the markup, and the engine renders
 * it as an element whose *layout size* it changes. A vector element laid out at
 * 8× re-renders its geometry at 8×; only a `transform: scale()` would stretch
 * what was already painted, which is why the engine sizes rather than
 * transforms (see `engine/view.ts`).
 *
 * ## Why an `<img>`, and not inline `<svg>`
 *
 * Inlining the markup into the tile's DOM would also re-render on resize — and
 * would execute any `<script>` in the file, resolve its external references, and
 * give it the same origin as the application. This app's entire job is opening
 * files the user did not write. An SVG loaded through an `<img>` is rendered in
 * the browser's *secure static mode*: no script, no external fetches, no
 * interaction, no access to the containing document. It stays fully vector, and
 * the sanitization below is defence in depth rather than the only line.
 *
 * The one real cost is that a font or bitmap referenced by URL will not load —
 * that is the same restriction every browser applies to SVG-as-image, so a file
 * relying on it renders here exactly as it does in a browser's image view.
 */

import {
  decodeError,
  vectorImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";

/** Default `<img>` intrinsic size, and what a viewBox-only SVG falls back to. */
const FALLBACK_WIDTH = 300;
const FALLBACK_HEIGHT = 150;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice() as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parses a CSS length into user units.
 *
 * `px`, `pt`, `pc`, `mm`, `cm` and `in` all have fixed ratios to the CSS pixel;
 * percentages do not resolve without a containing block and are treated as
 * absent, which is correct — a `width="100%"` SVG takes its size from its
 * viewBox.
 */
function parseLength(value: string | null): number | null {
  if (!value) return null;
  const match = /^\s*([+-]?[\d.]+)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/.exec(value);
  if (!match) return null;
  const number = Number.parseFloat(match[1]!);
  if (!Number.isFinite(number)) return null;
  switch (match[2]) {
    case "pt":
      return (number * 96) / 72;
    case "pc":
      return (number * 96) / 6;
    case "mm":
      return (number * 96) / 25.4;
    case "cm":
      return (number * 96) / 2.54;
    case "in":
      return number * 96;
    case "%":
    case "em":
    case "ex":
      return null;
    default:
      return number;
  }
}

/**
 * Removes the constructs that would matter if this were ever rendered inline.
 *
 * Belt and braces: the `<img>` route already refuses to run scripts or fetch
 * anything. But the markup is also what `serialize`, copy and export hand
 * around, and a future change that renders it a different way should not
 * silently become an XSS. Cheap to do, and it removes the need to remember.
 */
function sanitize(document_: Document): void {
  for (const element of [...document_.querySelectorAll("script, foreignObject")]) {
    element.remove();
  }
  for (const element of [...document_.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        (name === "href" || name === "xlink:href" || name === "src") &&
        (value.startsWith("javascript:") || value.startsWith("data:text/html"))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  let bytes = context.bytes;

  // `.svgz` is gzip, and so is a `.svg` that someone compressed without
  // renaming — which is why this tests the magic rather than the extension.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = await gunzip(bytes);
    } catch (thrown) {
      throw decodeError(context, "is a compressed SVG that could not be expanded.", {
        detail: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");

  // `DOMParser` reports XML errors as a `parsererror` element rather than by
  // throwing, so a malformed file otherwise arrives as a document containing a
  // browser error message — which would render as one.
  const failure = parsed.querySelector("parsererror");
  const root = parsed.documentElement;
  if (failure || !root || root.tagName.toLowerCase() !== "svg") {
    throw decodeError(context, "is not well-formed SVG.", {
      detail: failure?.textContent?.trim().slice(0, 200) ?? `root element is <${root?.tagName ?? "?"}>`,
    });
  }

  sanitize(parsed);

  // Natural size: the declared width and height, else the viewBox, else the
  // browser's own default for an image with neither. Resolving this here rather
  // than leaving it to the `<img>` is what stops a viewBox-only SVG — which is
  // most of them — from being treated as 300×150 and fitted to that.
  const viewBox = root
    .getAttribute("viewBox")
    ?.split(/[\s,]+/)
    .map(Number)
    .filter((value) => Number.isFinite(value));

  const declaredWidth = parseLength(root.getAttribute("width"));
  const declaredHeight = parseLength(root.getAttribute("height"));
  const boxWidth = viewBox?.length === 4 ? viewBox[2]! : null;
  const boxHeight = viewBox?.length === 4 ? viewBox[3]! : null;

  const width = declaredWidth ?? boxWidth ?? FALLBACK_WIDTH;
  const height = declaredHeight ?? boxHeight ?? FALLBACK_HEIGHT;

  if (width <= 0 || height <= 0) {
    throw decodeError(context, "declares a zero or negative size.", {
      detail: `width=${width} height=${height}`,
    });
  }

  // Re-serialized from the sanitized document rather than passing the original
  // text through: what is rendered must be what was inspected.
  const markup = new XMLSerializer().serializeToString(parsed);

  const notes: string[] = [];
  if (!declaredWidth && !declaredHeight && !boxWidth) {
    notes.push(
      "this SVG declares neither a size nor a viewBox — it is being shown at the " +
        "browser's default image size.",
    );
  }

  return vectorImage(markup, { width, height }, { notes });
}
