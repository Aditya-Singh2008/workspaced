/**
 * The metadata panel's model: EXIF, IPTC and XMP turned into labelled sections.
 *
 * Shared across every format, so it lives at the plugin root. `containers.ts`
 * knows where each format hides its metadata blocks; `ifd.ts` knows how to read
 * a TIFF directory; this file knows what the values *mean* and how to say them.
 *
 * ## GPS is treated differently on purpose
 *
 * Everything else here is descriptive. Location is not: a photo's GPS tags are
 * someone's home, their child's school, or where they were on a particular
 * afternoon, and they are in the file without most people knowing. The brief
 * asks for "a clear, unobtrusive way to hide sensitive metadata like GPS", and
 * two things implement it:
 *
 *   - Fields carry a {@link MetadataField.sensitive} flag, and the panel hides
 *     the *values* of flagged fields by default while still showing that they
 *     exist. Hiding the fact that a photo is geotagged would be a different and
 *     worse behaviour — the user cannot strip what they do not know is there.
 *   - The default is hidden (see `settings.ts`), so opening a photo does not put
 *     coordinates on screen before anyone has asked for them.
 *
 * ## Every value is formatted, and none are invented
 *
 * A tag that is absent produces no row. A tag whose value cannot be interpreted
 * produces its raw value rather than a guess — `Flash: 0x19` is honest and
 * `Flash: fired` might not be. What does get interpreted are the tags where the
 * stored number is meaningless on its own: an exposure time is `1/250`, not
 * `0.004`, and an aperture is `f/2.8`, not `2.8`.
 */

import { formatFileSize, type FileHandle } from "../../../files";
import type { DecodedImage } from "../decode";
import type { ImageFormat } from "../formats";
import { findMetadataBlocks } from "./containers";
import { EXIF_TAG, GPS_TAG, IfdReader, TIFF_TAG, type Ifd, type IfdEntry } from "./ifd";
import {
  IFD_TYPE_NAMES,
  IPTC_DATASET_NAMES,
  tagName,
  type TagSpace,
} from "./tags";

export interface MetadataField {
  readonly label: string;
  readonly value: string;
  /**
   * Withheld until the user asks. Currently GPS; anything else that identifies
   * a person or a place belongs here too.
   */
  readonly sensitive?: boolean;
  /**
   * Render with line breaks and wrapping preserved, in the full panel width.
   *
   * For the one field that is a document rather than a value: the raw XMP
   * packet, which is XML and unreadable squeezed into a definition list's
   * value column.
   */
  readonly preformatted?: boolean;
}

export interface MetadataSection {
  readonly title: string;
  readonly fields: readonly MetadataField[];
}

export interface ImageMetadata {
  readonly sections: readonly MetadataSection[];
  /** Whether any sensitive field exists, so the panel can offer the toggle. */
  readonly hasSensitive: boolean;
  /** EXIF orientation, 1–8, when present. Diagnostic — decoding already applied it. */
  readonly orientation?: number;
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

const ORIENTATION_NAMES: Readonly<Record<number, string>> = {
  1: "normal",
  2: "mirrored",
  3: "rotated 180°",
  4: "mirrored, rotated 180°",
  5: "mirrored, rotated 90° CCW",
  6: "rotated 90° CW",
  7: "mirrored, rotated 90° CW",
  8: "rotated 90° CCW",
};

const EXPOSURE_PROGRAMS: Readonly<Record<number, string>> = {
  1: "manual",
  2: "program",
  3: "aperture priority",
  4: "shutter priority",
  5: "creative",
  6: "action",
  7: "portrait",
  8: "landscape",
};

const METERING_MODES: Readonly<Record<number, string>> = {
  1: "average",
  2: "centre-weighted",
  3: "spot",
  4: "multi-spot",
  5: "pattern",
  6: "partial",
};

const RESOLUTION_UNITS: Readonly<Record<number, string>> = {
  2: "dpi",
  3: "dpcm",
};

/** `1/250 s` for fast shutters, `2.5 s` for slow ones. */
function formatExposureTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds >= 1) return `${Number(seconds.toFixed(1))} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

/** EXIF dates are `YYYY:MM:DD HH:MM:SS`, which no locale renders. */
function formatExifDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}` : value;
}

/** Degrees, minutes, seconds and a hemisphere into a signed decimal degree. */
function gpsDegrees(parts: readonly number[], ref: string | undefined): number | null {
  if (parts.length < 3) return null;
  const [degrees, minutes, seconds] = parts;
  const value = (degrees ?? 0) + (minutes ?? 0) / 60 + (seconds ?? 0) / 3600;
  if (!Number.isFinite(value)) return null;
  const negative = ref === "S" || ref === "W";
  return negative ? -value : value;
}

// ---------------------------------------------------------------------------
// IPTC
// ---------------------------------------------------------------------------

/**
 * IPTC IIM: a flat sequence of `0x1C` records, each a dataset number and a
 * length-prefixed value.
 *
 * Repeated datasets are legal and normal — keywords are one record each — so
 * values accumulate into a list rather than overwriting.
 *
 * Every dataset is kept, named ones and unnamed alike. An application that
 * wrote a field this table does not know still wrote something the user put
 * there, and dropping it would make the panel quietly lossy.
 */
function parseIptc(bytes: Uint8Array): MetadataField[] {
  const collected = new Map<string, string[]>();
  let offset = 0;

  while (offset + 5 <= bytes.length) {
    if (bytes[offset] !== 0x1c) {
      offset += 1;
      continue;
    }
    const dataset = bytes[offset + 2]!;
    let length = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
    let valueStart = offset + 5;
    // The high bit means an extended length, whose size is in the low 15 bits.
    if (length & 0x8000) {
      const sizeBytes = length & 0x7fff;
      length = 0;
      for (let index = 0; index < sizeBytes; index += 1) {
        length = (length << 8) | (bytes[valueStart + index] ?? 0);
      }
      valueStart += sizeBytes;
    }
    if (valueStart + length > bytes.length) break;

    const label = IPTC_DATASET_NAMES[dataset] ?? `dataset ${dataset}`;
    const value = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(valueStart, valueStart + length))
      .trim();
    if (value) {
      const existing = collected.get(label) ?? [];
      existing.push(value);
      collected.set(label, existing);
    }
    offset = valueStart + length;
  }

  return [...collected].map(([label, values]) => ({ label, value: values.join(", ") }));
}

// ---------------------------------------------------------------------------
// XMP
// ---------------------------------------------------------------------------

/**
 * The handful of XMP properties worth a row, read with a regular expression.
 *
 * XMP is RDF/XML and deserves a parser; what it is used for here does not. These
 * are the properties that carry a human-readable statement about the image, and
 * anything more structured than "find this tag's text" belongs to a phase that
 * has a reason to need it. Values are already-parsed XML text, so unescaping the
 * five predefined entities is the whole of the decoding.
 */
function parseXmp(xmp: string): MetadataField[] {
  const wanted: readonly [label: string, property: string][] = [
    ["title", "dc:title"],
    ["description", "dc:description"],
    ["creator", "dc:creator"],
    ["rights", "dc:rights"],
    ["subject", "dc:subject"],
    ["rating", "xmp:Rating"],
    ["label", "xmp:Label"],
    ["created with", "xmp:CreatorTool"],
    ["lens", "aux:Lens"],
  ];

  const fields: MetadataField[] = [];
  for (const [label, property] of wanted) {
    const element = new RegExp(`<${property}[^>]*>([\\s\\S]*?)</${property}>`).exec(xmp);
    const attribute = new RegExp(`${property}\\s*=\\s*"([^"]*)"`).exec(xmp);
    const raw = element?.[1] ?? attribute?.[1];
    if (!raw) continue;

    // A language alternative or a bag wraps the text in rdf:li elements.
    const items = [...raw.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) => m[1]!);
    const text = (items.length ? items.join(", ") : raw)
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();

    if (text) fields.push({ label, value: text });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function push(fields: MetadataField[], label: string, value: unknown, unit = ""): void {
  if (value === undefined || value === null || value === "") return;
  const text = typeof value === "number" ? String(Number(value.toFixed(4))) : String(value);
  if (!text.trim()) return;
  fields.push({ label, value: `${text}${unit}` });
}

function cameraFields(reader: IfdReader, root: Ifd, exif: Ifd | null): MetadataField[] {
  const fields: MetadataField[] = [];
  push(fields, "make", reader.text(root.get(TIFF_TAG.make)));
  push(fields, "model", reader.text(root.get(TIFF_TAG.model)));
  if (exif) {
    push(fields, "lens", reader.text(exif.get(EXIF_TAG.lensModel)));
    push(fields, "lens make", reader.text(exif.get(EXIF_TAG.lensMake)));
    push(fields, "body serial", reader.text(exif.get(EXIF_TAG.bodySerialNumber)));
  }
  push(fields, "software", reader.text(root.get(TIFF_TAG.software)));
  return fields;
}

function exposureFields(reader: IfdReader, exif: Ifd): MetadataField[] {
  const fields: MetadataField[] = [];

  const exposure = reader.number(exif.get(EXIF_TAG.exposureTime));
  if (exposure !== undefined) push(fields, "exposure", formatExposureTime(exposure));

  const aperture = reader.number(exif.get(EXIF_TAG.fNumber));
  if (aperture) push(fields, "aperture", `f/${Number(aperture.toFixed(1))}`);

  push(fields, "ISO", reader.number(exif.get(EXIF_TAG.isoSpeed)));

  const focal = reader.number(exif.get(EXIF_TAG.focalLength));
  if (focal) push(fields, "focal length", `${Math.round(focal)} mm`);

  const focal35 = reader.number(exif.get(EXIF_TAG.focalLength35mm));
  if (focal35) push(fields, "35mm equivalent", `${Math.round(focal35)} mm`);

  const bias = reader.number(exif.get(EXIF_TAG.exposureBias));
  if (bias !== undefined && bias !== 0) {
    push(fields, "exposure bias", `${bias > 0 ? "+" : ""}${Number(bias.toFixed(1))} EV`);
  }

  const program = reader.number(exif.get(EXIF_TAG.exposureProgram));
  if (program !== undefined) push(fields, "program", EXPOSURE_PROGRAMS[program] ?? program);

  const metering = reader.number(exif.get(EXIF_TAG.meteringMode));
  if (metering !== undefined) push(fields, "metering", METERING_MODES[metering] ?? metering);

  const flash = reader.number(exif.get(EXIF_TAG.flash));
  if (flash !== undefined) {
    // Bit 0 is the only part of this tag that is unambiguous across cameras.
    push(fields, "flash", flash & 1 ? "fired" : "did not fire");
  }

  push(fields, "taken", formatExifDate(reader.text(exif.get(EXIF_TAG.dateTimeOriginal))));
  push(fields, "digitized", formatExifDate(reader.text(exif.get(EXIF_TAG.dateTimeDigitized))));

  return fields;
}

function gpsFields(reader: IfdReader, gps: Ifd): MetadataField[] {
  const fields: MetadataField[] = [];

  const latitude = gpsDegrees(
    reader.numbers(gps.get(GPS_TAG.latitude)),
    reader.text(gps.get(GPS_TAG.latitudeRef)),
  );
  const longitude = gpsDegrees(
    reader.numbers(gps.get(GPS_TAG.longitude)),
    reader.text(gps.get(GPS_TAG.longitudeRef)),
  );

  if (latitude !== null && longitude !== null) {
    fields.push({
      label: "coordinates",
      value: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      sensitive: true,
    });
  }

  const altitude = reader.number(gps.get(GPS_TAG.altitude));
  if (altitude !== undefined) {
    const belowSeaLevel = reader.number(gps.get(GPS_TAG.altitudeRef)) === 1;
    fields.push({
      label: "altitude",
      value: `${belowSeaLevel ? "−" : ""}${Math.round(altitude)} m`,
      sensitive: true,
    });
  }

  const date = reader.text(gps.get(GPS_TAG.datestamp));
  if (date) {
    fields.push({ label: "GPS date", value: date.replace(/:/g, "-"), sensitive: true });
  }

  return fields;
}

// ---------------------------------------------------------------------------
// The complete listing
// ---------------------------------------------------------------------------

/**
 * How many values of a numeric array to print before summarising.
 *
 * A colour matrix is nine rationals and worth seeing whole; a linearization
 * table is 65536 shorts and is not. Sixteen keeps every tag anyone reads by eye
 * intact and stops the panel becoming a data dump.
 */
const MAX_LISTED_VALUES = 16;

/** Past this, a byte blob is described rather than printed. */
const MAX_INLINE_BYTES = 32;

/**
 * One tag as a printable string, for the complete listing.
 *
 * Deliberately closer to the stored value than the curated sections are: this
 * half of the panel exists so nothing is hidden, and an unformatted rational is
 * more honest than a guess at what a private tag means. The blobs — maker notes,
 * ICC profiles, linearization tables — are summarised by size, because printing
 * a 40 KB hex string is not "available to see" in any useful sense.
 */
function listedValue(reader: IfdReader, entry: IfdEntry): string {
  if (entry.type === 2) {
    return reader.text(entry) ?? "";
  }

  // UNDEFINED, and long byte runs, are binary. Say what they are.
  if ((entry.type === 7 || entry.type === 1) && entry.count > MAX_INLINE_BYTES) {
    return `<${entry.count.toLocaleString()} bytes>`;
  }

  const values = reader.numbers(entry);
  if (values.length === 0) return "";

  // An EXIF version tag is four ASCII digits stored as UNDEFINED — "0232", not
  // "48, 50, 51, 50".
  if (entry.type === 7 && entry.count <= 8 && values.every(isPrintableAscii)) {
    return String.fromCharCode(...values);
  }

  const shown = values
    .slice(0, MAX_LISTED_VALUES)
    .map((value) => (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))));

  return values.length > MAX_LISTED_VALUES
    ? `${shown.join(", ")}, … (${values.length.toLocaleString()} values)`
    : shown.join(", ");
}

function isPrintableAscii(value: number): boolean {
  return value >= 0x20 && value <= 0x7e;
}

/**
 * Every tag in one directory.
 *
 * The GPS directory is marked sensitive *in full*, not tag by tag. Everything in
 * it is location data by construction — the timestamp and the processing method
 * place someone as surely as the coordinates do — and a rule that has to be
 * maintained per tag is one that will eventually miss a new one.
 */
function listDirectory(
  reader: IfdReader,
  ifd: Ifd,
  space: TagSpace,
): MetadataField[] {
  const fields: MetadataField[] = [];
  const tags = [...ifd.keys()].sort((a, b) => a - b);

  for (const tag of tags) {
    const entry = ifd.get(tag);
    if (!entry) continue;
    const value = listedValue(reader, entry);
    if (!value) continue;
    fields.push({
      label: tagName(tag, space),
      value:
        entry.count > 1 || entry.type === 5 || entry.type === 10
          ? `${value}   [${IFD_TYPE_NAMES[entry.type] ?? entry.type}×${entry.count}]`
          : value,
      sensitive: space === "gps",
    });
  }

  return fields;
}

export interface MetadataInput {
  readonly file: FileHandle;
  readonly bytes: Uint8Array;
  readonly format: ImageFormat;
  readonly image: DecodedImage;
  /** Set when the file's name disagreed with its content. */
  readonly mismatch?: string;
}

/**
 * Everything the panel shows, for any format.
 *
 * The File and Image sections are always present — they come from the handle and
 * from the decode, so they are true even for a format that carries no metadata
 * at all, and a panel that is empty for a BMP would read as broken.
 */
export function extractMetadata(input: MetadataInput): ImageMetadata {
  const { file, bytes, format, image } = input;
  const sections: MetadataSection[] = [];

  const fileFields: MetadataField[] = [];
  push(fileFields, "name", file.name);
  push(fileFields, "format", format.label);
  push(fileFields, "size", formatFileSize(file.size));
  if (file.modifiedAt) {
    push(fileFields, "modified", new Date(file.modifiedAt).toLocaleString());
  }
  if (input.mismatch) push(fileFields, "note", input.mismatch);
  if (file.path) push(fileFields, "path", file.path);
  sections.push({ title: "file", fields: fileFields });

  const imageFields: MetadataField[] = [];
  push(imageFields, "dimensions", `${Math.round(image.width)} × ${Math.round(image.height)}`);
  const megapixels = (image.width * image.height) / 1_000_000;
  if (megapixels >= 0.1) push(imageFields, "megapixels", megapixels.toFixed(1));
  push(imageFields, "pixel format", image.pixelFormat);
  if (image.source.kind === "raster" && image.source.frames.length > 1) {
    const total = image.source.frames.reduce((sum, frame) => sum + frame.delayMs, 0);
    push(imageFields, "frames", image.source.frames.length);
    push(imageFields, "duration", `${(total / 1000).toFixed(2)} s`);
    push(
      imageFields,
      "loop",
      image.source.loopCount === 0 ? "forever" : `${image.source.loopCount}×`,
    );
  }
  sections.push({ title: "image", fields: imageFields });

  // TIFF and the RAW formats *are* a TIFF structure; everything else nests one.
  const blocks = findMetadataBlocks(bytes, format.id);
  const opened = blocks.exif
    ? IfdReader.open(blocks.exif.bytes, blocks.exif.base)
    : IfdReader.open(bytes);

  let orientation: number | undefined;
  let rawXmp: string | undefined;

  if (opened) {
    const { reader, firstIfd } = opened;
    const chain = reader.readChain(firstIfd);
    const root = chain[0];

    if (root) {
      orientation = reader.number(root.get(TIFF_TAG.orientation));

      const exifPointer = reader.number(root.get(TIFF_TAG.exifIfd));
      const exif = exifPointer ? (reader.readIfd(exifPointer)?.entries ?? null) : null;
      const gpsPointer = reader.number(root.get(TIFF_TAG.gpsIfd));
      const gps = gpsPointer ? (reader.readIfd(gpsPointer)?.entries ?? null) : null;

      const camera = cameraFields(reader, root, exif);
      if (camera.length) sections.push({ title: "camera", fields: camera });

      if (exif) {
        const exposure = exposureFields(reader, exif);
        if (exposure.length) sections.push({ title: "exposure", fields: exposure });
      }

      const technical: MetadataField[] = [];
      if (orientation !== undefined) {
        push(technical, "orientation", ORIENTATION_NAMES[orientation] ?? orientation);
      }
      const xResolution = reader.number(root.get(TIFF_TAG.xResolution));
      const unit = reader.number(root.get(TIFF_TAG.resolutionUnit));
      if (xResolution) {
        push(
          technical,
          "resolution",
          `${Math.round(xResolution)} ${RESOLUTION_UNITS[unit ?? 2] ?? "dpi"}`,
        );
      }
      if (root.has(TIFF_TAG.iccProfile)) {
        const profile = root.get(TIFF_TAG.iccProfile);
        push(technical, "colour profile", `embedded ICC, ${profile?.count ?? 0} bytes`);
      }
      push(technical, "description", reader.text(root.get(TIFF_TAG.imageDescription)));
      push(technical, "artist", reader.text(root.get(TIFF_TAG.artist)));
      push(technical, "copyright", reader.text(root.get(TIFF_TAG.copyright)));
      push(technical, "modified", formatExifDate(reader.text(root.get(TIFF_TAG.dateTime))));
      if (technical.length) sections.push({ title: "technical", fields: technical });

      if (gps) {
        const location = gpsFields(reader, gps);
        if (location.length) sections.push({ title: "location", fields: location });
      }

      // TIFF-family files keep IPTC and XMP in tags rather than in segments.
      if (!blocks.iptc) {
        const iptcBytes =
          reader.raw(root.get(TIFF_TAG.iptc)) ?? reader.raw(root.get(TIFF_TAG.photoshop));
        if (iptcBytes) {
          const fields = parseIptc(iptcBytes);
          if (fields.length) sections.push({ title: "IPTC", fields });
        }
      }
      if (!blocks.xmp) {
        const xmpBytes = reader.raw(root.get(TIFF_TAG.xmp));
        if (xmpBytes) {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(xmpBytes);
          const fields = parseXmp(text);
          if (fields.length) sections.push({ title: "XMP", fields });
          rawXmp = text;
        }
      }

      // --- the complete listing ------------------------------------------
      // Everything above is a selection, formatted for reading. What follows is
      // every tag in every directory, so nothing in the file is invisible.
      // Tags already shown above appear here too, deliberately: this section is
      // meant to be exhaustive, and a reader checking whether a tag exists
      // should not have to know which of two places to look.
      const interopPointer = exif ? reader.number(exif.get(40965)) : undefined;
      const interop = interopPointer
        ? (reader.readIfd(interopPointer)?.entries ?? null)
        : null;

      const directories: readonly [string, Ifd | null, TagSpace][] = [
        ["IFD0", root, "tiff"],
        ["Exif", exif, "tiff"],
        ["GPS", gps, "gps"],
        ["Interoperability", interop, "interop"],
      ];

      for (const [title, ifd, space] of directories) {
        if (!ifd) continue;
        const fields = listDirectory(reader, ifd, space);
        if (fields.length) sections.push({ title: `all tags — ${title}`, fields });
      }

      // Sub-IFDs, which is where DNG and most modern RAW files keep the real
      // image description, and the rest of the chain — IFD1 is conventionally
      // the embedded thumbnail.
      for (const [index, offset] of reader.numbers(root.get(TIFF_TAG.subIfds)).entries()) {
        const sub = reader.readIfd(offset);
        if (!sub) continue;
        const fields = listDirectory(reader, sub.entries, "tiff");
        if (fields.length) sections.push({ title: `all tags — SubIFD${index}`, fields });
      }

      for (let index = 1; index < chain.length; index += 1) {
        const fields = listDirectory(reader, chain[index]!, "tiff");
        if (fields.length) sections.push({ title: `all tags — IFD${index}`, fields });
      }
    }
  }

  if (blocks.iptc) {
    const fields = parseIptc(blocks.iptc);
    if (fields.length) sections.push({ title: "IPTC", fields });
  }
  if (blocks.xmp) {
    const fields = parseXmp(blocks.xmp);
    if (fields.length) sections.push({ title: "XMP", fields });
    rawXmp = blocks.xmp;
  }

  // The XMP packet verbatim. {@link parseXmp} pulls out the nine properties
  // worth a formatted row; XMP is an open schema and the other ninety are
  // whatever the application that wrote it decided to record. Showing the
  // packet is the only way to be exhaustive about a format that cannot be
  // enumerated in advance.
  if (rawXmp?.trim()) {
    sections.push({
      title: "XMP (raw)",
      fields: [{ label: "packet", value: rawXmp.trim(), preformatted: true }],
    });
  }

  if (image.notes.length) {
    sections.push({
      title: "notes",
      fields: image.notes.map((note, index) => ({ label: `${index + 1}`, value: note })),
    });
  }

  return {
    sections,
    hasSensitive: sections.some((section) => section.fields.some((field) => field.sensitive)),
    orientation,
  };
}
