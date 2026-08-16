/**
 * The parts of the annotation system that are shared by *both* targeting models
 * and by every plugin: how an annotation is summarised for a list, and how a
 * document carrying annotations is exported.
 *
 * The models themselves live next door — `overlay/` (phase 05a) for marks
 * anchored to a position, `text/` (phase 05b) for marks anchored to a quote.
 * Anything that would have to be duplicated between those two belongs here.
 */

export type { NormalizedPoint, NormalizedRect } from "./geometry";

import type { NormalizedRect } from "./geometry";

/**
 * One annotation, as the *shell* sees it.
 *
 * Deliberately not the item itself. The sidebar's annotation list needs a
 * label, a place and a time; giving it the item would give it the geometry, the
 * stroke widths and the image bytes as well, and a shell component that can read
 * those is one that will eventually branch on them. This is the same split
 * `ThumbnailResult` makes: enough to render, nothing to reason about.
 *
 * `subdivision` and `rect` are here rather than a `ViewerLocation` so this file
 * does not have to import the viewer contract, which imports this one. The
 * shell builds the location from them and hands it to the existing
 * `reveal(location)` — there is no second navigation mechanism.
 */
export interface AnnotationSummary {
  readonly id: string;
  /** The word for what it is: `"ink"`, `"note"`, `"arrow"`. Display only. */
  readonly type: string;
  /** One short line: the note's first line, or where the mark sits. */
  readonly label: string;
  readonly subdivision: number;
  readonly rect: NormalizedRect;
  readonly createdAt: number;
}

/** Export formats a plugin may support for an annotated result. */
export type AnnotationExportFormat = "pdf" | "png" | "jpeg";

export interface AnnotationExportOptions {
  readonly format: AnnotationExportFormat;
  /** Limit the export to these subdivisions; omit for the whole file. */
  readonly subdivisions?: readonly number[];
  /** 0..1, honored by lossy formats only. */
  readonly quality?: number;
  readonly signal?: AbortSignal;
}

export interface AnnotationExportResult {
  readonly format: AnnotationExportFormat;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  /** Suggested file name, without a directory. */
  readonly suggestedName: string;
}
