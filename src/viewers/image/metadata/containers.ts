/**
 * Finding EXIF, XMP and IPTC inside each container that can carry them.
 *
 * Metadata is the same three payloads wherever it appears; what differs is
 * where each format hides them. Separating "where is it" from "what does it
 * mean" is what keeps `index.ts` free of format branching — it asks for the
 * three blocks and never learns which container they came out of.
 *
 * | Format      | EXIF                         | XMP                          | IPTC                        |
 * | ----------- | ---------------------------- | ---------------------------- | --------------------------- |
 * | JPEG        | APP1, `Exif\0\0`             | APP1, Adobe XMP namespace    | APP13 Photoshop IRB, 0x0404 |
 * | TIFF / RAW  | the IFD chain itself         | tag 700                      | tag 33723, or IRB tag 34377 |
 * | PNG         | `eXIf` chunk                 | `iTXt` `XML:com.adobe.xmp`   | not carried in practice     |
 * | WebP        | `EXIF` chunk                 | `XMP ` chunk                 | not carried in practice     |
 * | HEIC / AVIF | an ISOBMFF `Exif` item       | an ISOBMFF `mime` item       | rare                        |
 *
 * The ISOBMFF row is the one that is scanned rather than parsed. Reaching an
 * `Exif` item properly means walking `meta` → `iinf` → `iloc` and resolving item
 * references — a page of code to find a block that is identifiable by its own
 * eight-byte header. The scan is bounded to the file's first megabyte, which is
 * where these boxes are, and a false positive has to be `Exif\0\0` followed by a
 * valid TIFF header.
 */

import { ByteReader, hasAscii } from "../binary";

export interface MetadataBlocks {
  /** The TIFF structure EXIF lives in, and the offset its pointers are relative to. */
  readonly exif?: { bytes: Uint8Array; base: number };
  readonly xmp?: string;
  readonly iptc?: Uint8Array;
}

const XMP_NAMESPACE = "http://ns.adobe.com/xap/1.0/\0";
const PHOTOSHOP_IRB = "Photoshop 3.0\0";

/** Pulls the IPTC IIM payload out of a Photoshop image resource block. */
function iptcFromPhotoshopIrb(bytes: Uint8Array): Uint8Array | undefined {
  const reader = new ByteReader(bytes, { littleEndian: false });
  try {
    while (reader.remaining > 12) {
      if (reader.ascii(4) !== "8BIM") return undefined;
      const id = reader.u16be();
      // A Pascal-style name, padded to an even length including its length byte.
      const nameLength = reader.u8();
      reader.skip(nameLength + ((nameLength + 1) % 2 === 0 ? 0 : 1));
      const size = reader.u32be();
      if (id === 0x0404) return reader.slice(size).slice();
      reader.skip(size + (size % 2));
    }
  } catch {
    // Truncated resource list.
  }
  return undefined;
}

function fromJpeg(bytes: Uint8Array): MetadataBlocks {
  const blocks: { exif?: MetadataBlocks["exif"]; xmp?: string; iptc?: Uint8Array } = {};
  let offset = 2;

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Start of scan: everything after this is compressed data.
    if (marker === 0xda || marker === 0xd9) break;
    // Standalone markers carry no length field.
    if (marker >= 0xd0 && marker <= 0xd8) {
      offset += 2;
      continue;
    }

    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) break;
    const payload = offset + 4;
    const payloadLength = length - 2;

    if (marker === 0xe1) {
      if (hasAscii(bytes, "Exif\0\0", payload) && !blocks.exif) {
        blocks.exif = { bytes, base: payload + 6 };
      } else if (hasAscii(bytes, XMP_NAMESPACE, payload)) {
        const start = payload + XMP_NAMESPACE.length;
        blocks.xmp = new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.subarray(start, payload + payloadLength),
        );
      }
    } else if (marker === 0xed && hasAscii(bytes, PHOTOSHOP_IRB, payload)) {
      blocks.iptc = iptcFromPhotoshopIrb(
        bytes.subarray(payload + PHOTOSHOP_IRB.length, payload + payloadLength),
      );
    }

    offset = payload + payloadLength;
  }

  return blocks;
}

function fromPng(bytes: Uint8Array): MetadataBlocks {
  const blocks: { exif?: MetadataBlocks["exif"]; xmp?: string } = {};
  const reader = new ByteReader(bytes, { littleEndian: false, offset: 8 });

  try {
    while (reader.remaining >= 8) {
      const length = reader.u32();
      const type = reader.ascii(4);
      const start = reader.offset;

      if (type === "eXIf" && !blocks.exif) {
        blocks.exif = { bytes, base: start };
      } else if (type === "iTXt" || type === "tEXt") {
        const chunk = bytes.subarray(start, start + length);
        // Keyword, NUL, then (for iTXt) compression and language fields before
        // the text. XMP is always stored uncompressed, so the payload starts
        // after the fourth NUL.
        const text = new TextDecoder("utf-8", { fatal: false }).decode(chunk);
        if (text.startsWith("XML:com.adobe.xmp")) {
          const at = text.indexOf("<x:xmpmeta");
          if (at >= 0) blocks.xmp = text.slice(at);
        }
      } else if (type === "IEND") {
        break;
      }

      reader.seek(start + length + 4);
    }
  } catch {
    // Truncated chunk list.
  }

  return blocks;
}

function fromWebp(bytes: Uint8Array): MetadataBlocks {
  const blocks: { exif?: MetadataBlocks["exif"]; xmp?: string } = {};
  const reader = new ByteReader(bytes, { littleEndian: true, offset: 12 });

  try {
    while (reader.remaining >= 8) {
      const type = reader.ascii(4);
      const size = reader.u32();
      const start = reader.offset;

      if (type === "EXIF" && !blocks.exif) {
        // Some encoders prefix the payload with the JPEG-style `Exif\0\0`
        // header even though the spec says not to.
        blocks.exif = {
          bytes,
          base: hasAscii(bytes, "Exif\0\0", start) ? start + 6 : start,
        };
      } else if (type === "XMP ") {
        blocks.xmp = new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.subarray(start, start + size),
        );
      }

      reader.seek(Math.min(start + size + (size % 2), reader.size));
    }
  } catch {
    // Truncated chunk list.
  }

  return blocks;
}

/** ISOBMFF, by signature scan. See the module comment for why. */
function fromIsobmff(bytes: Uint8Array): MetadataBlocks {
  const limit = Math.min(bytes.length, 1024 * 1024);
  const blocks: { exif?: MetadataBlocks["exif"]; xmp?: string } = {};

  for (let at = 0; at + 12 < limit; at += 1) {
    if (!blocks.exif && hasAscii(bytes, "Exif\0\0", at)) {
      const base = at + 6;
      const marker = (bytes[base]! << 8) | bytes[base + 1]!;
      if (marker === 0x4949 || marker === 0x4d4d) {
        blocks.exif = { bytes, base };
      }
      continue;
    }
    if (!blocks.xmp && hasAscii(bytes, "<x:xmpmeta", at)) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(
        bytes.subarray(at, Math.min(bytes.length, at + 64 * 1024)),
      );
      const end = text.indexOf("</x:xmpmeta>");
      blocks.xmp = end >= 0 ? text.slice(0, end + 12) : text;
    }
    if (blocks.exif && blocks.xmp) break;
  }

  return blocks;
}

/**
 * The three blocks, wherever this format keeps them.
 *
 * TIFF and the RAW formats are absent from the switch on purpose: their EXIF is
 * the file's own directory chain, so `index.ts` opens them directly rather than
 * being handed a nested copy.
 */
export function findMetadataBlocks(bytes: Uint8Array, formatId: string): MetadataBlocks {
  switch (formatId) {
    case "jpeg":
      return fromJpeg(bytes);
    case "png":
      return fromPng(bytes);
    case "webp":
      return fromWebp(bytes);
    case "heic":
    case "avif":
    case "cr3":
      return fromIsobmff(bytes);
    default:
      return {};
  }
}
