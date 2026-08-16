/**
 * The inspector: the side panel that shows metadata, the histogram, or the
 * light adjustments.
 *
 * Three panels and one slot, rather than three toggles and a stack of panels.
 * The brief lists metadata, histogram, pixel inspector and adjustments as
 * separate features, and giving each its own toggle would mean four shortcuts
 * for four things that all mean "tell me more about this image" — the exact
 * shape AGENTS.md describes cutting from the shell's own keybind set, where
 * "cycle layout, master count, master width" folded into one rotation. So one
 * key cycles the inspector and the panel says which of the three it is showing.
 *
 * **The colour picker belongs to the light panel and nowhere else.** It started
 * pinned above all three, on the theory that "what colour is this pixel" is
 * asked *while* looking at anything — but it is not. Information and levels are
 * read; they do not follow the pointer, and a readout flickering above them
 * distracts from what is being read. Sampling a colour is part of judging
 * exposure and contrast, which is the light panel's job. So the readout lives
 * there, the {@link Loupe} that aims it is only shown there, and the other two
 * panels are still.
 *
 * The information panel is exhaustive rather than curated: formatted sections
 * first, then every tag in every directory, then the raw XMP packet. See
 * `metadata/index.ts` — a panel that silently omits a tag gives no way to tell
 * "the file does not have it" from "this viewer does not show it".
 *
 * Plain DOM rather than React, matching the PDF plugin. A viewer plugin owns its
 * container element and nothing else; mounting a React root inside it would tie
 * the plugin's rendering to the shell's, which is what the contract is arranged
 * to avoid.
 */

import type { ImageMetadata } from "../metadata";
import type { InspectorPanel } from "../state";
import {
  ADJUSTMENT_RANGES,
  DEFAULT_ADJUSTMENTS,
  describeAdjustments,
  isNeutral,
  type Adjustments,
} from "./adjust";
import { drawHistogram, type Histogram, type SampledPixel } from "./pixels";

export interface InspectorCallbacks {
  onAdjustmentsChange(adjustments: Adjustments): void;
  onSensitiveToggle(visible: boolean): void;
}

export class Inspector {
  readonly host: HTMLElement;
  #callbacks: InspectorCallbacks;

  #panel: InspectorPanel = "none";
  #metadata: ImageMetadata | null = null;
  #histogram: Histogram | null = null;
  #adjustments: Adjustments = DEFAULT_ADJUSTMENTS;
  #sample: SampledPixel | null = null;
  #showSensitive = false;

  /** Rebuilt on a panel change; updated in place on a sample or a slider. */
  #sampleLine: HTMLElement | null = null;
  #histogramCanvas: HTMLCanvasElement | null = null;

  constructor(host: HTMLElement, callbacks: InspectorCallbacks) {
    this.host = host;
    this.#callbacks = callbacks;
  }

  get panel(): InspectorPanel {
    return this.#panel;
  }

  get showSensitive(): boolean {
    return this.#showSensitive;
  }

  setPanel(panel: InspectorPanel): void {
    this.#panel = panel;
    this.host.hidden = panel === "none";
    this.render();
  }

  /**
   * Reveals or re-hides the sensitive fields.
   *
   * The same switch the metadata panel's own button flips, exposed so the
   * keybind and the context menu run the one implementation rather than each
   * having their own idea of what "show location data" does.
   */
  toggleSensitive(): boolean {
    this.#showSensitive = !this.#showSensitive;
    this.#callbacks.onSensitiveToggle(this.#showSensitive);
    this.render();
    return this.#showSensitive;
  }

  setMetadata(metadata: ImageMetadata | null): void {
    this.#metadata = metadata;
    this.#showSensitive = false;
    if (this.#panel === "metadata") this.render();
  }

  setHistogram(histogram: Histogram | null): void {
    this.#histogram = histogram;
    if (this.#panel === "histogram") this.render();
  }

  setAdjustments(adjustments: Adjustments): void {
    this.#adjustments = adjustments;
    if (this.#panel === "adjust") this.render();
  }

  /**
   * Updates the pixel readout without rebuilding the panel.
   *
   * This is called on every pointer move. Re-rendering the whole panel at that
   * rate would rebuild the metadata list — and destroy the histogram canvas and
   * redraw it — a hundred times a second, which is the difference between a
   * readout that tracks the cursor and one that stutters.
   */
  setSample(sample: SampledPixel | null): void {
    this.#sample = sample;
    if (!this.#sampleLine) return;
    this.#sampleLine.replaceChildren(...this.#sampleContent());
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(): void {
    if (this.#panel === "none") {
      this.host.replaceChildren();
      this.#sampleLine = null;
      this.#histogramCanvas = null;
      return;
    }

    const body = document.createElement("div");
    body.className = "image-panel-body";

    switch (this.#panel) {
      case "metadata":
        body.replaceChildren(...this.#metadataContent());
        break;
      case "histogram":
        body.replaceChildren(...this.#histogramContent());
        break;
      case "adjust":
        body.replaceChildren(...this.#adjustContent());
        break;
      default:
        break;
    }

    // The picker rides above the light panel only. `#sampleLine` is nulled for
    // the others so `setSample` — which runs on every pointer move — has nothing
    // to write to and does no work.
    if (this.#panel === "adjust") {
      const sample = document.createElement("div");
      sample.className = "image-sample";
      this.#sampleLine = sample;
      sample.replaceChildren(...this.#sampleContent());
      this.host.replaceChildren(sample, body);
    } else {
      this.#sampleLine = null;
      this.host.replaceChildren(body);
    }
  }

  /** Whether the picker and its loupe are live, which is the light panel only. */
  get samplingActive(): boolean {
    return this.#panel === "adjust";
  }

  #sampleContent(): Node[] {
    if (!this.#sample) {
      const hint = document.createElement("span");
      hint.className = "text-muted";
      hint.textContent = "move over the image to sample a pixel";
      return [hint];
    }

    const { source, displayed, hex, displayedHex, adjusted } = this.#sample;

    const swatch = document.createElement("span");
    swatch.className = "image-swatch";
    swatch.style.backgroundColor = displayedHex;

    const position = document.createElement("span");
    position.className = "text-muted";
    position.textContent = `${this.#sample.x}, ${this.#sample.y}`;

    const values = document.createElement("span");
    values.textContent = `${hex}  rgb ${source.r} ${source.g} ${source.b}${
      source.a < 255 ? ` a ${source.a}` : ""
    }`;

    const nodes: Node[] = [swatch, position, values];

    if (adjusted) {
      // Both numbers, because they answer different questions — see
      // `pixels.ts`. The arrow reads as "in the file → on screen".
      const preview = document.createElement("span");
      preview.className = "text-muted";
      preview.textContent = `→ ${displayedHex} rgb ${displayed.r} ${displayed.g} ${displayed.b}`;
      nodes.push(preview);
    }

    return nodes;
  }

  #metadataContent(): Node[] {
    const metadata = this.#metadata;
    if (!metadata) {
      return [message("no metadata could be read from this file.")];
    }

    const nodes: Node[] = [];

    for (const section of metadata.sections) {
      if (section.fields.length === 0) continue;

      const heading = document.createElement("h3");
      heading.className = "image-panel-heading";
      heading.textContent = section.title;
      nodes.push(heading);

      const list = document.createElement("dl");
      list.className = "image-fields";

      for (const field of section.fields) {
        // A document rather than a value — the raw XMP packet. It gets the full
        // panel width and keeps its line breaks; squeezed into the value column
        // it would be an unreadable ribbon.
        if (field.preformatted) {
          const block = document.createElement("pre");
          block.className = "image-field-raw";
          block.textContent = field.value;
          list.append(block);
          continue;
        }

        const term = document.createElement("dt");
        term.textContent = field.label;
        // The full tag listing has names longer than the column, and truncating
        // them silently would make two private tags indistinguishable.
        term.title = field.label;

        const value = document.createElement("dd");
        if (field.sensitive && !this.#showSensitive) {
          // The row stays, the value does not. Hiding the row would hide *that
          // the photo is geotagged*, which is the thing worth knowing — see
          // `metadata/index.ts`.
          value.className = "image-field-hidden";
          value.textContent = "hidden";
        } else {
          value.textContent = field.value;
        }

        list.append(term, value);
      }

      nodes.push(list);
    }

    if (metadata.hasSensitive) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "image-panel-action";
      toggle.textContent = this.#showSensitive
        ? "hide location data"
        : "show location data";
      toggle.addEventListener("click", () => this.toggleSensitive());
      nodes.push(toggle);
    }

    return nodes.length ? nodes : [message("this file carries no metadata.")];
  }

  #histogramContent(): Node[] {
    const histogram = this.#histogram;
    if (!histogram) {
      return [message("the histogram is not available for this image.")];
    }

    const canvas = document.createElement("canvas");
    canvas.className = "image-histogram";
    // A fixed backing size: the plot has 256 columns and no amount of extra
    // pixels adds information, while re-measuring the panel to size it would
    // couple this to the layout.
    canvas.width = 256;
    canvas.height = 128;
    this.#histogramCanvas = canvas;
    drawHistogram(canvas, histogram);

    const stats = document.createElement("dl");
    stats.className = "image-fields";
    const rows: readonly [string, string][] = [
      ["shadow clip", `${(histogram.shadowClip * 100).toFixed(2)}%`],
      ["highlight clip", `${(histogram.highlightClip * 100).toFixed(2)}%`],
      ["sampled", `${histogram.sampled.toLocaleString()} px`],
    ];
    for (const [label, value] of rows) {
      const term = document.createElement("dt");
      term.textContent = label;
      const cell = document.createElement("dd");
      cell.textContent = value;
      stats.append(term, cell);
    }

    const scale = message("vertical scale is logarithmic; luma is the white curve.");
    return [canvas, stats, scale];
  }

  #adjustContent(): Node[] {
    const nodes: Node[] = [];

    const fields: readonly (keyof Adjustments)[] = ["exposure", "brightness", "contrast"];
    for (const key of fields) {
      const range = ADJUSTMENT_RANGES[key];
      const row = document.createElement("label");
      row.className = "image-slider";

      const name = document.createElement("span");
      name.textContent = key;

      const value = document.createElement("span");
      value.className = "image-slider-value";
      const current = this.#adjustments[key];
      value.textContent = `${current > 0 ? "+" : ""}${current}${range.unit}`;

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(range.min);
      input.max = String(range.max);
      input.step = String(range.step);
      input.value = String(current);
      // `input`, not `change`: these are preview controls and the whole point is
      // seeing the image move while the slider does.
      input.addEventListener("input", () => {
        const next = { ...this.#adjustments, [key]: Number(input.value) };
        this.#adjustments = next;
        value.textContent = `${next[key] > 0 ? "+" : ""}${next[key]}${range.unit}`;
        this.#callbacks.onAdjustmentsChange(next);
      });

      row.append(name, value, input);
      nodes.push(row);
    }

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "image-panel-action";
    reset.textContent = "reset";
    reset.disabled = isNeutral(this.#adjustments);
    reset.addEventListener("click", () => {
      this.#adjustments = DEFAULT_ADJUSTMENTS;
      this.#callbacks.onAdjustmentsChange(DEFAULT_ADJUSTMENTS);
      this.render();
    });
    nodes.push(reset);

    nodes.push(message(describeAdjustments(this.#adjustments)));
    nodes.push(
      message(
        "these adjust the preview only — the file on disk is never modified. " +
          "Export writes what you see.",
      ),
    );

    return nodes;
  }

  destroy(): void {
    if (this.#histogramCanvas) {
      this.#histogramCanvas.width = 0;
      this.#histogramCanvas.height = 0;
      this.#histogramCanvas = null;
    }
    this.#sampleLine = null;
    this.host.replaceChildren();
  }
}

function message(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "image-panel-note";
  element.textContent = text;
  return element;
}
