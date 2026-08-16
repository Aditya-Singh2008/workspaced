/**
 * A PDF built in memory, for the dev self-test. **Dev builds only.**
 *
 * Phase 02 solved the same problem for tiling with `dev/stubTiles.ts`: the
 * verification steps need something to open, and requiring a directory of
 * sample files means the checks only run on the machine that has them. So the
 * fixture is written by hand, byte by byte — it is a real PDF that pdf.js
 * parses through its normal path, not a mock.
 *
 * Three pages, chosen to cover what the checks need:
 *
 *   - **page 1** native vector text on white — text renders, selects and copies
 *     in logical order, and inverts legibly;
 *   - **page 2** an embedded RGB image with vector text over part of it and
 *     more text beside it — a page whose pixels are not all glyphs, so a
 *     thumbnail of it is distinguishable from a thumbnail of page 1 and the
 *     "every page has content" check cannot pass by accident.
 *   - **page 3 (phase 05b)** the same image with **invisible** text over it —
 *     text rendering mode 3, which is how every OCR tool in existence embeds
 *     the words it found over the picture of them. It exists because phase 05b's
 *     first task is to confirm that an OCR'd scan behaves *identically* to
 *     native text, and because that is exactly the case a plausible-looking
 *     optimization would break: a text layer that skipped glyphs nobody can see
 *     would pass every check on pages 1 and 2 and make every scanned document
 *     in the world unselectable. Its two lines are one sentence broken across a
 *     line wrap, so a quote spanning them must resolve to two rectangles.
 *
 * A PDF is a byte-offset format: the cross-reference table records where each
 * object starts, so this has to be assembled as bytes and measured, not
 * concatenated as a string and encoded at the end. That is the only reason this
 * file is longer than the document it produces.
 */

const PAGE_WIDTH = 240;
const PAGE_HEIGHT = 320;

/** The image is painted here, in page points, through a `cm` transform. */
export const FIXTURE_IMAGE_BOX = { x: 20, y: 40, width: 200, height: 120 } as const;

export const FIXTURE_PAGE_ONE_TEXT = "Workspace self test page one";
export const FIXTURE_PAGE_TWO_TEXT = "Caption beside the figure";

/**
 * Page 3's invisible text, one sentence over two lines.
 *
 * Split where a scan's OCR would split it, because the point of the page is the
 * line wrap: an annotation covering the end of the first line and the start of
 * the second is the case that separates "several contiguous rectangles" from
 * "one malformed box".
 */
export const FIXTURE_OCR_LINES = [
  "Scanned page rendered as an image",
  "with invisible text over it",
] as const;

/** The 1-based page number of the OCR-style page. */
export const FIXTURE_OCR_PAGE = 3;

/** What `page.getViewport({ scale: 1 })` will report. */
export const FIXTURE_PAGE_SIZE = { width: PAGE_WIDTH, height: PAGE_HEIGHT } as const;

export const FIXTURE_PAGE_COUNT = 3;

/**
 * A small, deliberately colourful and noisy RGB image.
 *
 * Noisy rather than a flat fill or a smooth gradient, so that a thumbnail of
 * this page has real variance in it and cannot look "rendered" by accident.
 */
function figurePixels(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      // A deterministic pseudo-noise, so the fixture is byte-identical on every
      // run and a failing check is reproducible.
      const noise = ((x * 7919 + y * 104729) % 61) - 30;
      bytes[index] = clampByte(40 + (x / width) * 200 + noise);
      bytes[index + 1] = clampByte(200 - (y / height) * 170 + noise);
      bytes[index + 2] = clampByte(60 + ((x + y) / (width + height)) * 190 - noise);
    }
  }
  return bytes;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Assembles the PDF and returns its bytes. */
export function buildFixturePdf(): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;

  const push = (chunk: Uint8Array | string): number => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    const offset = length;
    length += bytes.byteLength;
    return offset;
  };

  const imageWidth = 64;
  const imageHeight = 40;
  const imageData = figurePixels(imageWidth, imageHeight);

  // Object 4: page 1's content. Plain vector text, nothing else.
  const contentOne = [
    "BT",
    "/F1 14 Tf",
    `1 0 0 1 24 ${PAGE_HEIGHT - 48} Tm`,
    `(${FIXTURE_PAGE_ONE_TEXT}) Tj`,
    "ET",
    "BT",
    "/F1 11 Tf",
    `1 0 0 1 24 ${PAGE_HEIGHT - 76} Tm`,
    "(A second line of ordinary body text.) Tj",
    "ET",
  ].join("\n");

  // Object 6: page 2's content. The image is placed by a `cm` transform rather
  // than at the origin, so the page exercises a non-trivial graphics state; the
  // first text run sits *inside* the image's box and the second sits below it.
  const contentTwo = [
    "q",
    `${FIXTURE_IMAGE_BOX.width} 0 0 ${FIXTURE_IMAGE_BOX.height} ${FIXTURE_IMAGE_BOX.x} ${FIXTURE_IMAGE_BOX.y} cm`,
    "/Im1 Do",
    "Q",
    "BT",
    "/F1 13 Tf",
    "1 1 1 rg",
    `1 0 0 1 34 ${FIXTURE_IMAGE_BOX.y + 60} Tm`,
    "(Text over the figure) Tj",
    "ET",
    "BT",
    "/F1 11 Tf",
    "0 0 0 rg",
    `1 0 0 1 24 ${FIXTURE_IMAGE_BOX.y - 30} Tm`,
    `(${FIXTURE_PAGE_TWO_TEXT}) Tj`,
    "ET",
  ].join("\n");

  // Object 10: page 3's content. The same figure, with the text drawn in
  // rendering mode 3 — marked, positioned, measurable, and painting nothing.
  // `getTextContent()` reports these items exactly like any others, which is
  // the property being fixed in place here.
  const contentThree = [
    "q",
    `${FIXTURE_IMAGE_BOX.width} 0 0 ${FIXTURE_IMAGE_BOX.height} ${FIXTURE_IMAGE_BOX.x} ${FIXTURE_IMAGE_BOX.y} cm`,
    "/Im1 Do",
    "Q",
    "BT",
    "/F1 11 Tf",
    "3 Tr",
    `1 0 0 1 24 ${FIXTURE_IMAGE_BOX.y + 110} Tm`,
    `(${FIXTURE_OCR_LINES[0]}) Tj`,
    `1 0 0 1 24 ${FIXTURE_IMAGE_BOX.y + 92} Tm`,
    `(${FIXTURE_OCR_LINES[1]}) Tj`,
    "ET",
  ].join("\n");

  const objects: (Uint8Array | string)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R 9 0 R] /Count 3 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    stream(`<< /Length ${encoder.encode(contentOne).byteLength} >>`, encoder.encode(contentOne)),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 7 0 R >> /XObject << /Im1 8 0 R >> >> /Contents 6 0 R >>",
    stream(`<< /Length ${encoder.encode(contentTwo).byteLength} >>`, encoder.encode(contentTwo)),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(
      `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imageData.byteLength} >>`,
      imageData,
    ),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 7 0 R >> /XObject << /Im1 8 0 R >> >> /Contents 10 0 R >>",
    stream(
      `<< /Length ${encoder.encode(contentThree).byteLength} >>`,
      encoder.encode(contentThree),
    ),
  ];

  push("%PDF-1.4\n");
  // A binary comment line, which is what tells anything sniffing the file that
  // it is not text. Real producers all emit one.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(push(`${index + 1} 0 obj\n`));
    push(body);
    push("\nendobj\n");
  });

  const xrefOffset = length;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

/** A dictionary followed by its stream data, as one object body. */
function stream(dictionary: string, data: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(`${dictionary}\nstream\n`);
  const tail = encoder.encode("\nendstream");
  const out = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(data, head.byteLength);
  out.set(tail, head.byteLength + data.byteLength);
  return out;
}
