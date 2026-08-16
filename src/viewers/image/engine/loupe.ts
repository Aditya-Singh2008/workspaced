/**
 * The loupe: a magnified view of the pixels under the pointer.
 *
 * The colour picker answers "what colour is this pixel" and, on its own, leaves
 * the harder question open — *which* pixel. At a fitted zoom one screen pixel
 * can cover a dozen image pixels, so the readout changes as the pointer moves
 * without anything on screen showing what it is moving across. Sampling an edge,
 * a single stray pixel, or one side of a JPEG artefact is guesswork.
 *
 * So this draws the neighbourhood at high magnification with the sampled pixel
 * outlined, which turns the picker from "a number that changes" into something
 * aimable.
 *
 * ## Three details that make it correct rather than decorative
 *
 * **Nearest-neighbour, always.** `imageSmoothingEnabled = false` — a smoothed
 * magnification invents colours between the pixels, which is precisely the thing
 * a pixel inspector must not do. The grid drawn above a certain magnification is
 * for the same reason: it makes the pixel boundaries explicit instead of leaving
 * them to be inferred from where the colour changes.
 *
 * **Oriented like the screen, not like the file.** The view transform is applied
 * when drawing, so a rotated or mirrored image produces a loupe that matches
 * what the user is looking at. Drawing the raw source instead would show the
 * neighbourhood mirrored relative to the screen, and the pointer would appear to
 * move the wrong way inside it.
 *
 * **Only the neighbourhood is drawn.** Not the whole image scaled up — a
 * 24-megapixel source at 8× is a 1.5-gigapixel virtual draw on every pointer
 * move, and browsers do not all clip that cheaply.
 */

/** Side length of the loupe, in CSS pixels. */
const SIZE = 132;

/** How many image pixels fit across it. Sets the magnification. */
const PIXELS_ACROSS = 15;

/** Below this magnification a pixel grid is noise rather than information. */
const GRID_MIN_MAGNIFICATION = 6;

/** Gap between the pointer and the loupe, so it never sits under the cursor. */
const POINTER_OFFSET = 20;

export interface LoupeTransform {
  readonly rotation: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

export class Loupe {
  readonly element: HTMLCanvasElement;
  #host: HTMLElement;
  #visible = false;

  constructor(host: HTMLElement) {
    this.#host = host;

    const canvas = document.createElement("canvas");
    canvas.className = "image-loupe";
    // The backing store is sized for the device so the grid lines and the
    // centre outline stay one physical pixel rather than blurring across two.
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(SIZE * ratio);
    canvas.height = Math.round(SIZE * ratio);
    canvas.style.width = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    canvas.hidden = true;

    host.append(canvas);
    this.element = canvas;
  }

  get visible(): boolean {
    return this.#visible;
  }

  hide(): void {
    if (!this.#visible) return;
    this.#visible = false;
    this.element.hidden = true;
  }

  /**
   * Redraws around an image point and moves the loupe next to the pointer.
   *
   * `client` positions it, `point` is what it magnifies; either being absent
   * hides it, which is what happens when the pointer leaves the image.
   */
  show(options: {
    source: HTMLCanvasElement;
    point: { x: number; y: number };
    client: { clientX: number; clientY: number };
    transform: LoupeTransform;
  }): void {
    const { source, point, client, transform } = options;
    const canvas = this.element;
    const context = canvas.getContext("2d");
    if (!context || !source.width || !source.height) {
      this.hide();
      return;
    }

    const ratio = canvas.width / SIZE;
    const magnification = SIZE / PIXELS_ACROSS;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;

    context.save();
    context.scale(ratio, ratio);
    context.translate(SIZE / 2, SIZE / 2);
    // The same transform the display element carries, so the loupe agrees with
    // the screen rather than with the file.
    context.rotate((transform.rotation * Math.PI) / 180);
    context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
    context.scale(magnification, magnification);

    // A generous radius: a quarter turn puts the corners of the loupe further
    // from its centre than its edges are, so the region has to cover the
    // diagonal rather than the half-width.
    const radius = Math.ceil((PIXELS_ACROSS * Math.SQRT2) / 2) + 1;
    const sx = point.x - radius;
    const sy = point.y - radius;
    const span = radius * 2 + 1;

    // Destination coordinates are in source-pixel units here, because the
    // magnification is already in the transform. Offsetting by the sampled
    // pixel's *centre* is what puts that pixel under the crosshair rather than
    // half a pixel off it.
    context.drawImage(
      source,
      sx,
      sy,
      span,
      span,
      sx - (point.x + 0.5),
      sy - (point.y + 0.5),
      span,
      span,
    );
    context.restore();

    if (magnification >= GRID_MIN_MAGNIFICATION) {
      this.#drawGrid(context, ratio, magnification);
    }
    this.#drawCentre(context, ratio, magnification);

    canvas.hidden = false;
    this.#visible = true;
    this.#position(client);
  }

  /**
   * The pixel grid, aligned to the sampled pixel.
   *
   * Offset by half a magnified pixel because the sampled pixel is *centred* in
   * the loupe: without the offset the grid would run through the middle of every
   * pixel instead of between them, which looks like a rendering bug.
   */
  #drawGrid(context: CanvasRenderingContext2D, ratio: number, magnification: number): void {
    context.save();
    context.scale(ratio, ratio);
    context.strokeStyle = "rgba(0, 0, 0, 0.22)";
    context.lineWidth = 1 / ratio;

    const half = magnification / 2;
    context.beginPath();
    for (let offset = SIZE / 2 + half; offset < SIZE; offset += magnification) {
      context.moveTo(Math.round(offset), 0);
      context.lineTo(Math.round(offset), SIZE);
      context.moveTo(0, Math.round(offset));
      context.lineTo(SIZE, Math.round(offset));
    }
    for (let offset = SIZE / 2 - half; offset > 0; offset -= magnification) {
      context.moveTo(Math.round(offset), 0);
      context.lineTo(Math.round(offset), SIZE);
      context.moveTo(0, Math.round(offset));
      context.lineTo(SIZE, Math.round(offset));
    }
    context.stroke();
    context.restore();
  }

  /**
   * The outline around the sampled pixel.
   *
   * Drawn twice, dark then light, so it is visible against both a black and a
   * white pixel — a single-colour crosshair disappears exactly when the pixel
   * under it is the colour of the crosshair, which is not a rare case.
   */
  #drawCentre(context: CanvasRenderingContext2D, ratio: number, magnification: number): void {
    context.save();
    context.scale(ratio, ratio);

    const left = SIZE / 2 - magnification / 2;
    const top = SIZE / 2 - magnification / 2;

    context.lineWidth = 3 / ratio;
    context.strokeStyle = "rgba(0, 0, 0, 0.75)";
    context.strokeRect(left, top, magnification, magnification);

    context.lineWidth = 1 / ratio;
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    context.strokeRect(left, top, magnification, magnification);

    context.restore();
  }

  /**
   * Places the loupe beside the pointer, staying inside the tile.
   *
   * Below-right normally, flipping to the other side of the pointer near an
   * edge rather than sliding along it — sliding would let the loupe drift under
   * the cursor, which is the one place it must never be.
   */
  #position(client: { clientX: number; clientY: number }): void {
    const hostBox = this.#host.getBoundingClientRect();
    const x = client.clientX - hostBox.left;
    const y = client.clientY - hostBox.top;

    let left = x + POINTER_OFFSET;
    let top = y + POINTER_OFFSET;
    if (left + SIZE > hostBox.width) left = x - POINTER_OFFSET - SIZE;
    if (top + SIZE > hostBox.height) top = y - POINTER_OFFSET - SIZE;

    this.element.style.left = `${Math.max(0, Math.min(left, hostBox.width - SIZE))}px`;
    this.element.style.top = `${Math.max(0, Math.min(top, hostBox.height - SIZE))}px`;
  }

  destroy(): void {
    this.element.width = 0;
    this.element.height = 0;
    this.element.remove();
  }
}
