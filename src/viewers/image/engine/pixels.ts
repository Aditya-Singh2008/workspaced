/**
 * Reading pixels: the colour picker and the histogram.
 *
 * Both answer questions about the image the user is *looking at*, which is why
 * they share a module and why both take the adjustment LUT. An image previewed
 * two stops brighter has a different histogram and different pixel values, and a
 * panel that reported the file's untouched numbers while the screen showed
 * something else would be describing an image nobody can see.
 *
 * The picker reports both, because the two answer different questions: "what
 * colour is this pixel in the file" is what you need to sample a brand colour,
 * and "what colour is it on screen" is what you need when adjustments are on.
 * Showing only one would make the other unavailable; showing both costs a line.
 */

import { adjustmentLut, isNeutral, type Adjustments } from "./adjust";

export interface SampledPixel {
  /** Image coordinates, in natural pixels. */
  readonly x: number;
  readonly y: number;
  /** The value stored in the file. */
  readonly source: { r: number; g: number; b: number; a: number };
  /** The value on screen, after the adjustment preview. Equal when neutral. */
  readonly displayed: { r: number; g: number; b: number; a: number };
  readonly hex: string;
  readonly displayedHex: string;
  /** Whether the two differ, so the panel knows to show the second line. */
  readonly adjusted: boolean;
}

function hex(channel: number): string {
  return channel.toString(16).padStart(2, "0");
}

export function toHex(colour: { r: number; g: number; b: number }): string {
  return `#${hex(colour.r)}${hex(colour.g)}${hex(colour.b)}`.toUpperCase();
}

/**
 * The colour of one pixel.
 *
 * `getImageData` on a one-pixel rectangle rather than on the whole image: at
 * pointer-move rates, pulling a 24-megapixel buffer out of the GPU for one pixel
 * would make the pointer stutter, and it is the same answer.
 */
export function samplePixel(
  canvas: HTMLCanvasElement,
  point: { x: number; y: number },
  adjustments: Adjustments,
): SampledPixel | null {
  if (point.x < 0 || point.y < 0 || point.x >= canvas.width || point.y >= canvas.height) {
    return null;
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(point.x, point.y, 1, 1).data;
  } catch {
    // A tainted canvas. Cannot happen for these sources, but a picker that
    // throws would take the pointer handler with it.
    return null;
  }

  const source = { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
  const neutral = isNeutral(adjustments);
  const lut = neutral ? null : adjustmentLut(adjustments);
  const displayed = lut
    ? { r: lut[source.r]!, g: lut[source.g]!, b: lut[source.b]!, a: source.a }
    : source;

  return {
    x: point.x,
    y: point.y,
    source,
    displayed,
    hex: toHex(source),
    displayedHex: toHex(displayed),
    adjusted: !neutral,
  };
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

export interface Histogram {
  readonly red: Uint32Array;
  readonly green: Uint32Array;
  readonly blue: Uint32Array;
  readonly luma: Uint32Array;
  /** The largest count in any channel, for scaling the plot. */
  readonly peak: number;
  /** How many pixels were counted, which is not the image's pixel count. */
  readonly sampled: number;
  /** Fraction of pixels at 0 and at 255 — clipping, which is what this is for. */
  readonly shadowClip: number;
  readonly highlightClip: number;
}

/**
 * Longest edge the histogram is computed from.
 *
 * A histogram is a *shape*, and the shape of a 24-megapixel photo is
 * indistinguishable from the shape of a 250,000-pixel sample of it — while
 * costing a hundred times as much to compute, on the main thread, every time an
 * adjustment slider moves. Sampling on a grid rather than from a region keeps
 * the estimate unbiased.
 */
const HISTOGRAM_SAMPLE_EDGE = 512;

export function computeHistogram(
  canvas: HTMLCanvasElement,
  adjustments: Adjustments,
): Histogram | null {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !canvas.width || !canvas.height) return null;

  // The stride is chosen so the sampled grid is at most the sample edge on its
  // longest side, and is never below 1.
  const stride = Math.max(
    1,
    Math.ceil(Math.max(canvas.width, canvas.height) / HISTOGRAM_SAMPLE_EDGE),
  );

  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;
  }

  const red = new Uint32Array(256);
  const green = new Uint32Array(256);
  const blue = new Uint32Array(256);
  const luma = new Uint32Array(256);
  const lut = isNeutral(adjustments) ? null : adjustmentLut(adjustments);

  let sampled = 0;
  let shadows = 0;
  let highlights = 0;

  for (let y = 0; y < canvas.height; y += stride) {
    for (let x = 0; x < canvas.width; x += stride) {
      const at = (y * canvas.width + x) * 4;
      let r = data[at]!;
      let g = data[at + 1]!;
      let b = data[at + 2]!;
      if (lut) {
        r = lut[r]!;
        g = lut[g]!;
        b = lut[b]!;
      }

      red[r] += 1;
      green[g] += 1;
      blue[b] += 1;
      // Rec. 709 luma, which is what "brightness" means for an sRGB image and
      // what every other histogram in a photo application shows.
      const value = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      luma[value] += 1;
      sampled += 1;

      if (r === 0 && g === 0 && b === 0) shadows += 1;
      if (r === 255 && g === 255 && b === 255) highlights += 1;
    }
  }

  let peak = 0;
  for (let value = 0; value < 256; value += 1) {
    peak = Math.max(peak, red[value]!, green[value]!, blue[value]!);
  }

  return {
    red,
    green,
    blue,
    luma,
    peak,
    sampled,
    shadowClip: sampled ? shadows / sampled : 0,
    highlightClip: sampled ? highlights / sampled : 0,
  };
}

/**
 * Draws a histogram into a canvas.
 *
 * Additive compositing for the three channels, so where they overlap the plot
 * goes white — which is the conventional rendering and the one that makes a
 * colour cast visible at a glance rather than requiring three separate plots.
 * The luma curve is drawn over it as a line in the foreground colour.
 */
export function drawHistogram(canvas: HTMLCanvasElement, histogram: Histogram): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (!histogram.peak) return;

  // A logarithmic vertical scale. Photographic histograms are dominated by one
  // or two enormous bins — a sky, a studio background — and on a linear scale
  // every other bin is a flat line at the bottom, which is exactly the part
  // being looked at.
  const scale = (count: number): number =>
    (Math.log1p(count) / Math.log1p(histogram.peak)) * height;

  context.globalCompositeOperation = "lighter";
  const channels: readonly [Uint32Array, string][] = [
    [histogram.red, "rgb(220, 60, 60)"],
    [histogram.green, "rgb(60, 200, 90)"],
    [histogram.blue, "rgb(70, 110, 240)"],
  ];

  for (const [bins, colour] of channels) {
    context.fillStyle = colour;
    for (let value = 0; value < 256; value += 1) {
      const barHeight = scale(bins[value]!);
      if (barHeight <= 0) continue;
      const x = (value / 256) * width;
      context.fillRect(x, height - barHeight, Math.max(1, width / 256), barHeight);
    }
  }

  context.globalCompositeOperation = "source-over";
  context.strokeStyle = "rgba(230, 237, 243, 0.75)";
  context.lineWidth = 1;
  context.beginPath();
  for (let value = 0; value < 256; value += 1) {
    const x = (value / 256) * width;
    const y = height - scale(histogram.luma[value]!);
    if (value === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}
