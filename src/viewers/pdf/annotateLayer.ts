/**
 * One page's annotation layer: the SVG that draws the marks and the handles.
 *
 * ## Why SVG, and why its viewBox is in page points
 *
 * The layer's `viewBox` is the page's own box in PDF points and the element
 * stretches to fill the page element, exactly as the canvas does. So the browser
 * applies the zoom: a mark is written once in point coordinates and stays
 * pinned to the paper through every scale change, with no re-render and no
 * repositioning pass. The alternative — absolutely positioned HTML recomputed on
 * every zoom — is the same work the page virtualizer already avoids for the
 * canvas, for the same reason.
 *
 * Points rather than the model's normalized `0..1` because points are what the
 * *export* uses. Stroke widths, font sizes and the note icon are then one number
 * on screen and in the file, so "it looked like this in the tile" is checkable
 * rather than hopeful.
 *
 * ## Hit-testing is the DOM's job
 *
 * Every drawn element carries `data-annot-id`, so a click resolves to a mark
 * through `event.target.closest(...)` with correct z-order and no geometry.
 * Thin strokes get a second, transparent, much wider path underneath so that
 * clicking *near* a hairline selects it — a 1-point line is a third of a pixel
 * at fit-width and would otherwise be unselectable.
 */

import {
  TEXT_BASELINE_RATIO,
  TEXT_LINE_HEIGHT,
  TEXT_PADDING_RATIO,
  type NormalizedPoint,
  type NormalizedRect,
  type OverlayItem,
} from "../../annotation";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Selection handle size, in CSS pixels. Constant on screen at any zoom. */
const HANDLE_PX = 7;

/** How wide a transparent hit path is drawn, in CSS pixels. */
const HIT_PX = 10;

/** Handles a rectangular item offers, clockwise from the top-left. */
export const RECT_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type RectHandle = (typeof RECT_HANDLES)[number];
/** A line or arrow offers its two ends instead. */
export type EndpointHandle = "from" | "to";
export type AnnotationHandle = RectHandle | EndpointHandle;

export class PdfAnnotationLayer {
  readonly root: SVGSVGElement;

  /** The page's unscaled box, in points. Corrected when the page corrects its own. */
  #size: { width: number; height: number };
  #items: readonly OverlayItem[] = [];
  #selected: string | null = null;
  /** Points per CSS pixel, so handles can be drawn a constant size on screen. */
  #scale = 1;

  constructor(host: HTMLElement, size: { width: number; height: number }) {
    this.#size = size;

    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("class", "pdf-annot-layer");
    // `none`, matching how the canvas is stretched to the page box: the box is
    // rounded to whole pixels, so `meet` would letterbox the layer by a fraction
    // of a pixel and put every mark slightly out of step with the page.
    root.setAttribute("preserveAspectRatio", "none");
    this.#applyViewBox(root);
    host.append(root);
    this.root = root;
  }

  setSize(size: { width: number; height: number }): void {
    if (size.width === this.#size.width && size.height === this.#size.height) return;
    this.#size = size;
    this.#applyViewBox(this.root);
    this.render();
  }

  setScale(scale: number): void {
    if (Math.abs(scale - this.#scale) < 0.0005) return;
    this.#scale = scale;
    // Only the chrome is scale-dependent; the marks are in page space and the
    // browser has already rescaled them.
    if (this.#selected) this.render();
  }

  setItems(items: readonly OverlayItem[]): void {
    this.#items = items;
    this.render();
  }

  setSelection(id: string | null): void {
    if (id === this.#selected) return;
    this.#selected = id;
    this.render();
  }

  /** Whether the layer takes pointer events, i.e. whether annotate mode is on. */
  setInteractive(interactive: boolean): void {
    this.root.classList.toggle("is-interactive", interactive);
  }

  get size(): { width: number; height: number } {
    return this.#size;
  }

  /** A client-space point as normalized page coordinates. */
  toNormalized(clientX: number, clientY: number): NormalizedPoint {
    const box = this.root.getBoundingClientRect();
    return {
      x: box.width > 0 ? (clientX - box.left) / box.width : 0,
      y: box.height > 0 ? (clientY - box.top) / box.height : 0,
    };
  }

  destroy(): void {
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(): void {
    const fragment = document.createDocumentFragment();
    for (const item of this.#items) fragment.append(this.#drawItem(item));

    const selected = this.#items.find((item) => item.id === this.#selected);
    if (selected) fragment.append(this.#drawSelection(selected));

    this.root.replaceChildren(fragment);
  }

  #applyViewBox(root: SVGSVGElement): void {
    root.setAttribute("viewBox", `0 0 ${this.#size.width} ${this.#size.height}`);
  }

  /** A length in page points that measures `pixels` on screen at this zoom. */
  #pointsPerPixel(pixels: number): number {
    return pixels / Math.max(this.#scale, 0.05);
  }

  #px(fraction: number): number {
    return fraction * Math.min(this.#size.width, this.#size.height);
  }

  #x(fraction: number): number {
    return fraction * this.#size.width;
  }

  #y(fraction: number): number {
    return fraction * this.#size.height;
  }

  #rect(rect: NormalizedRect): { x: number; y: number; width: number; height: number } {
    return {
      x: this.#x(rect.x),
      y: this.#y(rect.y),
      width: this.#x(rect.width),
      height: this.#y(rect.height),
    };
  }

  #drawItem(item: OverlayItem): SVGGElement {
    const group = element("g");
    group.dataset.annotId = item.id;
    group.setAttribute("class", `pdf-annot pdf-annot-${item.kind}`);
    group.setAttribute("opacity", String(item.opacity));

    switch (item.kind) {
      case "ink":
        this.#drawInk(group, item);
        break;
      case "highlight":
        this.#drawHighlight(group, item);
        break;
      case "shape":
        this.#drawShape(group, item);
        break;
      case "text":
        this.#drawText(group, item);
        break;
      case "note":
        this.#drawNote(group, item);
        break;
      case "image":
        this.#drawImage(group, item);
        break;
    }
    return group;
  }

  #drawInk(group: SVGGElement, item: Extract<OverlayItem, { kind: "ink" }>): void {
    const width = this.#px(item.strokeWidth);
    for (const stroke of item.strokes) {
      const path = this.#pathData(stroke);
      // The transparent hit path first, so the visible stroke paints over it.
      group.append(
        attributes(element("path"), {
          d: path,
          class: "pdf-annot-hit",
          "stroke-width": Math.max(width, this.#pointsPerPixel(HIT_PX)),
        }),
      );
      group.append(
        attributes(element("path"), {
          d: path,
          fill: "none",
          stroke: item.color,
          "stroke-width": width,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      );
    }
  }

  #pathData(points: readonly NormalizedPoint[]): string {
    if (points.length === 0) return "";
    const parts = points.map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${this.#x(point.x).toFixed(2)} ${this.#y(point.y).toFixed(2)}`,
    );
    // A tap: a zero-length line with round caps is a dot, where a lone move
    // command draws nothing at all. Same trick the export uses.
    if (points.length === 1) parts.push(parts[0]!.replace("M", "L"));
    return parts.join(" ");
  }

  #drawHighlight(
    group: SVGGElement,
    item: Extract<OverlayItem, { kind: "highlight" }>,
  ): void {
    for (const box of item.rects) {
      group.append(attributes(element("rect"), { ...this.#rect(box), fill: item.color }));
    }
  }

  #drawShape(group: SVGGElement, item: Extract<OverlayItem, { kind: "shape" }>): void {
    const width = this.#px(item.strokeWidth);
    const common = {
      fill: item.fill ?? "none",
      stroke: item.color,
      "stroke-width": width,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    };

    if (item.shape === "line" || item.shape === "arrow") {
      const from = item.from ?? { x: item.bounds.x, y: item.bounds.y };
      const to = item.to ?? {
        x: item.bounds.x + item.bounds.width,
        y: item.bounds.y + item.bounds.height,
      };
      const a = { x: this.#x(from.x), y: this.#y(from.y) };
      const b = { x: this.#x(to.x), y: this.#y(to.y) };

      group.append(
        attributes(element("line"), {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          class: "pdf-annot-hit",
          "stroke-width": Math.max(width, this.#pointsPerPixel(HIT_PX)),
        }),
      );
      group.append(
        attributes(element("line"), { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...common }),
      );

      if (item.shape === "arrow") {
        const size = Math.max(width * 4, 6);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const spread = Math.PI / 7;
        const left = {
          x: b.x - size * Math.cos(angle - spread),
          y: b.y - size * Math.sin(angle - spread),
        };
        const right = {
          x: b.x - size * Math.cos(angle + spread),
          y: b.y - size * Math.sin(angle + spread),
        };
        group.append(
          attributes(element("path"), {
            d: `M${left.x.toFixed(2)} ${left.y.toFixed(2)} L${b.x.toFixed(2)} ${b.y.toFixed(2)} L${right.x.toFixed(2)} ${right.y.toFixed(2)}`,
            ...common,
            fill: "none",
          }),
        );
      }
      return;
    }

    // Inset by half the pen width: `bounds` was padded by it, and a stroke
    // centred on the box edge would paint half of itself outside the mark.
    const box = this.#rect(item.bounds);
    const inset = width / 2;
    const x = box.x + inset;
    const y = box.y + inset;
    const boxWidth = Math.max(0, box.width - width);
    const boxHeight = Math.max(0, box.height - width);

    if (item.shape === "ellipse") {
      group.append(
        attributes(element("ellipse"), {
          cx: x + boxWidth / 2,
          cy: y + boxHeight / 2,
          rx: boxWidth / 2,
          ry: boxHeight / 2,
          ...common,
        }),
      );
    } else {
      group.append(
        attributes(element("rect"), {
          x,
          y,
          width: boxWidth,
          height: boxHeight,
          ...common,
        }),
      );
    }
  }

  #drawText(group: SVGGElement, item: Extract<OverlayItem, { kind: "text" }>): void {
    const box = this.#rect(item.bounds);
    const size = this.#px(item.fontSize);
    const padding = size * TEXT_PADDING_RATIO;

    // A transparent backing rectangle, so a callout can be clicked anywhere in
    // its box rather than only on the glyphs.
    group.append(attributes(element("rect"), { ...box, class: "pdf-annot-hit" }));

    // A nested `<svg>` is a viewport, and a viewport clips: text longer than the
    // callout is cut off at the box here exactly as the exported appearance
    // stream cuts it off, with no clip-path to define and keep in step.
    const viewport = attributes(element("svg"), {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      overflow: "hidden",
    });

    const text = attributes(element("text"), {
      x: padding,
      y: padding + size * TEXT_BASELINE_RATIO,
      fill: item.color,
      "font-size": size,
      // Helvetica, matching the standard font the export embeds, so a line ends
      // up the same width on screen and in the file.
      "font-family": "Helvetica, Arial, sans-serif",
    });

    for (const [index, line] of item.text.split("\n").entries()) {
      const span = attributes(element("tspan"), {
        x: padding,
        dy: index === 0 ? 0 : size * TEXT_LINE_HEIGHT,
      });
      // A space rather than nothing: an empty tspan collapses, and the blank
      // line the user typed disappears with it.
      span.textContent = line || " ";
      text.append(span);
    }
    viewport.append(text);
    group.append(viewport);
  }

  #drawNote(group: SVGGElement, item: Extract<OverlayItem, { kind: "note" }>): void {
    const box = this.#rect(item.bounds);
    group.append(
      attributes(element("rect"), {
        ...box,
        fill: item.color,
        stroke: "#333333",
        "stroke-width": Math.max(0.6, box.height * 0.06),
      }),
    );
    for (const fraction of [0.35, 0.5, 0.65]) {
      group.append(
        attributes(element("line"), {
          x1: box.x + box.width * 0.2,
          y1: box.y + box.height * fraction,
          x2: box.x + box.width * 0.8,
          y2: box.y + box.height * fraction,
          stroke: "#333333",
          "stroke-width": Math.max(0.5, box.height * 0.05),
        }),
      );
    }
  }

  #drawImage(group: SVGGElement, item: Extract<OverlayItem, { kind: "image" }>): void {
    const box = this.#rect(item.bounds);
    const image = element("image");
    attributes(image, { ...box, preserveAspectRatio: "none" });
    image.setAttribute("href", `data:${item.image.mimeType};base64,${item.image.base64}`);
    group.append(image);
  }

  // -------------------------------------------------------------------------
  // Selection chrome
  // -------------------------------------------------------------------------

  #drawSelection(item: OverlayItem): SVGGElement {
    const group = element("g");
    group.setAttribute("class", "pdf-annot-selection");
    const box = this.#rect(item.bounds);
    const stroke = this.#pointsPerPixel(1);

    group.append(
      attributes(element("rect"), {
        ...box,
        class: "pdf-annot-outline",
        "stroke-width": stroke,
      }),
    );

    const handle = (x: number, y: number, name: AnnotationHandle): SVGElement => {
      const size = this.#pointsPerPixel(HANDLE_PX);
      const node = attributes(element("rect"), {
        x: x - size / 2,
        y: y - size / 2,
        width: size,
        height: size,
        class: "pdf-annot-handle",
        "stroke-width": stroke,
      });
      node.dataset.handle = name;
      return node;
    };

    if (item.kind === "shape" && (item.shape === "line" || item.shape === "arrow")) {
      const from = item.from ?? { x: item.bounds.x, y: item.bounds.y };
      const to = item.to ?? {
        x: item.bounds.x + item.bounds.width,
        y: item.bounds.y + item.bounds.height,
      };
      group.append(handle(this.#x(from.x), this.#y(from.y), "from"));
      group.append(handle(this.#x(to.x), this.#y(to.y), "to"));
      return group;
    }

    // A note is an icon: it moves, it does not resize, so it gets an outline and
    // no handles rather than handles that quietly do nothing.
    if (item.kind === "note") return group;

    const positions: Record<RectHandle, { x: number; y: number }> = {
      nw: { x: box.x, y: box.y },
      n: { x: box.x + box.width / 2, y: box.y },
      ne: { x: box.x + box.width, y: box.y },
      e: { x: box.x + box.width, y: box.y + box.height / 2 },
      se: { x: box.x + box.width, y: box.y + box.height },
      s: { x: box.x + box.width / 2, y: box.y + box.height },
      sw: { x: box.x, y: box.y + box.height },
      w: { x: box.x, y: box.y + box.height / 2 },
    };
    for (const name of RECT_HANDLES) {
      const at = positions[name];
      group.append(handle(at.x, at.y, name));
    }
    return group;
  }
}

function element<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function attributes<T extends SVGElement>(
  node: T,
  values: Record<string, string | number>,
): T {
  for (const [name, value] of Object.entries(values)) {
    node.setAttribute(name, typeof value === "number" ? value.toFixed(3) : value);
  }
  return node;
}
