/**
 * Non-destructive light adjustment: brightness, contrast and exposure.
 *
 * These are **view aids, not editing tools**, and the phase brief says so
 * explicitly ("do not let this grow into a paint or retouch feature set"). The
 * shape of this module is what keeps that true: there is one flat record of
 * three numbers, one function that turns it into a CSS filter, and one function
 * that turns it into a lookup table. There is nowhere for a brush, a mask or a
 * per-region exception to attach, which is the same argument AGENTS.md makes for
 * the PDF plugin's single inversion switch.
 *
 * ## Two implementations of one formula, and why that is not duplication
 *
 * The display path applies a CSS `filter` to the image element. The histogram
 * and the export path apply {@link adjustmentLut} to pixel values. They must
 * agree exactly, or the histogram describes an image nobody is looking at and
 * an export does not match the preview it came from — so the LUT below is
 * derived from the *specified* behaviour of the CSS functions rather than from
 * anything approximating them:
 *
 *   - `brightness(k)` is a linear transfer with slope `k`: `v' = v · k`.
 *   - `contrast(k)` is a linear transfer with slope `k` and intercept
 *     `0.5 − 0.5k`: `v' = v · k + (0.5 − 0.5k)`.
 *   - Both operate on sRGB-encoded values in 0…1, which is why the LUT is
 *     indexed by the byte straight out of `getImageData` with no linearization.
 *   - Filters apply left to right, so the LUT composes them in the same order
 *     the filter string lists them.
 *
 * ## Why not `CanvasRenderingContext2D.filter`
 *
 * Because it does not work on the platform this app has to run on. AGENTS.md is
 * explicit: webkit2gtk accepts the canvas `filter` property, returns it verbatim
 * when read back, and ignores it when drawing. An export that set `ctx.filter`
 * would come out unadjusted on Linux and adjusted everywhere else, and a feature
 * probe that set the property and read it back would report success on both. The
 * LUT is not a fallback for that bug — it is the only correct way to do it.
 */

/**
 * The three sliders.
 *
 * `brightness` and `contrast` are percentages either side of neutral, so `0` is
 * "no change" for all three and a default record is all zeros — which is what
 * makes {@link isNeutral} a cheap check and keeps serialized state small.
 * `exposure` is in stops, because that is the unit the number means to anyone
 * who would reach for it.
 */
export interface Adjustments {
  /** −100 … +100, as a percentage either side of neutral. */
  readonly brightness: number;
  /** −100 … +100. */
  readonly contrast: number;
  /** −3 … +3 stops. Each stop doubles or halves the light. */
  readonly exposure: number;
}

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  exposure: 0,
};

export const ADJUSTMENT_RANGES: Readonly<
  Record<keyof Adjustments, { min: number; max: number; step: number; unit: string }>
> = {
  brightness: { min: -100, max: 100, step: 1, unit: "%" },
  contrast: { min: -100, max: 100, step: 1, unit: "%" },
  exposure: { min: -3, max: 3, step: 0.1, unit: " EV" },
};

export function isNeutral(adjustments: Adjustments): boolean {
  return (
    adjustments.brightness === 0 && adjustments.contrast === 0 && adjustments.exposure === 0
  );
}

/** Brightness and exposure collapse into one multiplier; see the module note. */
function brightnessSlope(adjustments: Adjustments): number {
  return (1 + adjustments.brightness / 100) * 2 ** adjustments.exposure;
}

function contrastSlope(adjustments: Adjustments): number {
  return 1 + adjustments.contrast / 100;
}

/**
 * The CSS `filter` value for the display element.
 *
 * Empty string when neutral, so the common case sets no filter at all rather
 * than an identity one — an element with a filter is promoted to its own
 * compositing layer, which for a large image at high zoom is a real cost to pay
 * for doing nothing.
 */
export function adjustmentFilter(adjustments: Adjustments): string {
  if (isNeutral(adjustments)) return "";
  const parts: string[] = [];
  const brightness = brightnessSlope(adjustments);
  if (brightness !== 1) parts.push(`brightness(${brightness.toFixed(4)})`);
  const contrast = contrastSlope(adjustments);
  if (contrast !== 1) parts.push(`contrast(${contrast.toFixed(4)})`);
  return parts.join(" ");
}

/**
 * A 256-entry table mapping a source channel byte to its adjusted value.
 *
 * One table for all three channels: every function here is per-channel and
 * identical across them, which is exactly why they can be a lookup rather than
 * arithmetic per pixel. A 24-megapixel export is 72 million channel values, and
 * a table turns three multiplies and two clamps each into an array index.
 */
export function adjustmentLut(adjustments: Adjustments): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const brightness = brightnessSlope(adjustments);
  const contrast = contrastSlope(adjustments);
  const intercept = 0.5 - 0.5 * contrast;

  for (let value = 0; value < 256; value += 1) {
    const normalized = value / 255;
    const lit = normalized * brightness;
    lut[value] = Math.round((lit * contrast + intercept) * 255);
  }
  return lut;
}

/**
 * Applies a LUT to RGBA pixel data in place.
 *
 * Alpha is untouched: these are light adjustments, and multiplying alpha by a
 * brightness slope would make a transparent image fade rather than brighten.
 */
export function applyLut(data: Uint8ClampedArray, lut: Uint8ClampedArray): void {
  for (let index = 0; index < data.length; index += 4) {
    data[index] = lut[data[index]!]!;
    data[index + 1] = lut[data[index + 1]!]!;
    data[index + 2] = lut[data[index + 2]!]!;
  }
}

/** Clamps each field into range. Used on restore and on every setter. */
export function clampAdjustments(adjustments: Adjustments): Adjustments {
  const clamp = (value: number, key: keyof Adjustments): number => {
    const range = ADJUSTMENT_RANGES[key];
    if (!Number.isFinite(value)) return 0;
    return Math.min(range.max, Math.max(range.min, value));
  };
  return {
    brightness: clamp(adjustments.brightness, "brightness"),
    contrast: clamp(adjustments.contrast, "contrast"),
    exposure: clamp(adjustments.exposure, "exposure"),
  };
}

/** Coerces anything at all into a usable record. Never throws. */
export function parseAdjustments(value: unknown): Adjustments {
  if (!value || typeof value !== "object") return DEFAULT_ADJUSTMENTS;
  const candidate = value as Partial<Adjustments>;
  return clampAdjustments({
    brightness: typeof candidate.brightness === "number" ? candidate.brightness : 0,
    contrast: typeof candidate.contrast === "number" ? candidate.contrast : 0,
    exposure: typeof candidate.exposure === "number" ? candidate.exposure : 0,
  });
}

/** Short readout for the panel and the status line. */
export function describeAdjustments(adjustments: Adjustments): string {
  if (isNeutral(adjustments)) return "neutral";
  const parts: string[] = [];
  if (adjustments.exposure !== 0) parts.push(`${signed(adjustments.exposure, 1)} EV`);
  if (adjustments.brightness !== 0) parts.push(`bri ${signed(adjustments.brightness, 0)}`);
  if (adjustments.contrast !== 0) parts.push(`con ${signed(adjustments.contrast, 0)}`);
  return parts.join("  ");
}

function signed(value: number, digits: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}
