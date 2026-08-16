/**
 * Opening an image: format resolution, decode dispatch, and load failures.
 *
 * Split from `index.ts` for the reason the PDF plugin splits its own: the
 * descriptor has to be registered at startup so the shell can *resolve* files,
 * and nothing here should be parsed by a session that opens no image. The
 * decoders go one level further and are behind `formats.ts`'s dynamic imports,
 * so opening a JPEG does not pull in the TIFF, GIF and RAW paths either.
 *
 * {@link loadImage} is exported alongside the mount because folder browsing
 * needs exactly the same work for a *different* file in an already-mounted tile.
 * Having one function for "turn a handle into something displayable" is what
 * keeps a sibling image going through the same format resolution, the same error
 * vocabulary and the same metadata extraction as the file that was opened.
 */

import type { FileHandle } from "../../files";
import {
  ViewerLoadError,
  type ViewerInstance,
  type ViewerMountOptions,
} from "../contract";
import type { DecodedImage } from "./decode";
import { resolveFormat, type ImageFormat } from "./formats";
import { ImageViewerInstance } from "./instance";
import { extractMetadata, type ImageMetadata } from "./metadata";

import "./image.css";

export interface LoadedImage {
  readonly file: FileHandle;
  readonly bytes: Uint8Array;
  readonly image: DecodedImage;
  readonly format: ImageFormat;
  readonly metadata: ImageMetadata;
  /** Set when the file's name disagreed with its content. */
  readonly mismatch?: string;
}

/**
 * Reads, identifies and decodes a file.
 *
 * Every failure leaves with a {@link ViewerLoadError} whose message names the
 * file and what was wrong with it. The decoders already do that for their own
 * failures; what this adds is the two that happen before any decoder is reached
 * — an unreadable file and an unrecognised one.
 */
export async function loadImage(
  file: FileHandle,
  signal?: AbortSignal,
): Promise<LoadedImage> {
  signal?.throwIfAborted();

  let bytes: Uint8Array;
  try {
    bytes = await file.read();
  } catch (thrown) {
    throw new ViewerLoadError({
      code: "not-found",
      message: `${file.name} could not be read.`,
      detail: thrown instanceof Error ? thrown.message : String(thrown),
      recoverable: true,
      cause: thrown,
    });
  }
  signal?.throwIfAborted();

  if (bytes.length === 0) {
    throw new ViewerLoadError({
      code: "corrupt",
      message: `${file.name} is empty.`,
      detail: "the file is zero bytes long",
      recoverable: false,
    });
  }

  const resolution = resolveFormat({
    bytes,
    extension: file.extension,
    mimeType: file.mimeType,
  });

  if (!resolution) {
    // The registry sent this file here on its extension, and the bytes are not
    // any format this plugin knows. Naming both halves is what makes the message
    // actionable — the usual cause is a file saved with the wrong extension.
    throw new ViewerLoadError({
      code: "unsupported",
      message: `${file.name} is not an image this viewer recognises.`,
      detail:
        `the file's contents match no supported format` +
        (file.extension ? `, and its .${file.extension} extension did not resolve one` : ""),
      recoverable: false,
    });
  }

  const { decode } = await resolution.format.load();
  signal?.throwIfAborted();

  const image = await decode({
    bytes,
    name: file.name,
    extension: file.extension,
    mimeType: file.mimeType,
    signal,
  });
  signal?.throwIfAborted();

  const metadata = extractMetadata({
    file,
    bytes,
    format: resolution.format,
    image,
    mismatch: resolution.mismatch,
  });

  return {
    file,
    bytes,
    image,
    format: resolution.format,
    metadata,
    mismatch: resolution.mismatch,
  };
}

export async function mountImage(
  container: HTMLElement,
  file: FileHandle,
  options?: ViewerMountOptions,
): Promise<ViewerInstance> {
  const loaded = await loadImage(file, options?.signal);

  if (options?.signal?.aborted) {
    // The tile closed while we were decoding. Give the bitmaps back rather than
    // handing out an instance nobody will dispose.
    loaded.image.dispose();
    options.signal.throwIfAborted();
  }

  return new ImageViewerInstance({
    container,
    loaded,
    initialState: options?.initialState,
    host: options?.host,
  });
}
