/**
 * Exercises the tiling model and the layout actions. **Dev builds only.**
 *
 * Two halves. The first drives `tiling.ts` directly — it is pure, so its
 * properties can be asserted exactly rather than eyeballed: what shape three
 * tiles take, that the derivation is idempotent, that raising the master count
 * produces the arrangement the user asked for. The second builds a real,
 * off-screen dockview and runs the actions against it, because "re-deriving
 * does not corrupt the grid" is a claim about the library's behaviour, not
 * ours — as is every spatial question the directional actions ask it.
 *
 * The grid-depth checks are the direct regression test for the bug this model
 * replaced: rearranging tiles used to nest a new branch on every call, and
 * after a few presses the layout could not be returned to two plain columns.
 */

import {
  createDockview,
  Orientation,
  type CreateComponentOptions,
  type DockviewApi,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type SerializedDockview,
} from "dockview-react";

import { check, report, type SelfTestCheck, type SelfTestReport } from "../../dev/selftest";
import {
  applyTiling,
  findMasterGroup,
  focusTileAt,
  moveInDirection,
  retile,
  swapWithMaster,
  tileOrder,
  toggleMonocle,
} from "./layout";
import { workspaceDockviewTheme } from "./theme";
import {
  arrangementIndex,
  arrangementsFor,
  readMasterFraction,
  readSizeProfile,
  rotateArrangement,
  readTiles,
  reorderTiles,
  tileGrid,
  type SerializedGrid,
  type TileState,
  type TilingParams,
} from "./tiling";

const WIDTH = 1200;
const HEIGHT = 800;

const ONE_MASTER: TilingParams = { mode: "tall", masterCount: 1, masterFraction: 0.5 };

/** The same arrangement in each of the other two modes, for the shape checks. */
const WIDE: TilingParams = { ...ONE_MASTER, mode: "wide" };
const GRID: TilingParams = { ...ONE_MASTER, mode: "grid" };

/** Records construction and teardown, so a remount or a leak is observable. */
class ProbeContent implements IContentRenderer {
  readonly element: HTMLElement;
  readonly id: string;
  static created: string[] = [];
  static disposed: string[] = [];

  constructor(id: string) {
    this.id = id;
    this.element = document.createElement("div");
    this.element.textContent = id;
    ProbeContent.created.push(id);
  }

  init(_parameters: GroupPanelPartInitParameters): void {
    /* nothing to load */
  }

  dispose(): void {
    ProbeContent.disposed.push(this.id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake tiles, enough for the pure functions: they only read `id`. */
function tiles(...ids: string[]): TileState[] {
  return ids.map((id) => ({ id, views: [id], activeView: id }) as TileState);
}

/**
 * How deeply branches nest. A correct tiled layout is at most two: the root,
 * plus one column branch when a column holds more than one tile. Anything
 * deeper means the grid has been built by accumulating moves.
 */
function branchDepth(node: SerializedDockview["grid"]["root"]): number {
  if (!Array.isArray(node.data)) return 0;
  return 1 + Math.max(0, ...node.data.map(branchDepth));
}

/**
 * A compact description of a layout's shape, e.g. `(a (b c))`.
 *
 * Leaves print their *panel* ids rather than the group id, because group ids
 * are assigned by dockview and mean nothing to a reader. A tab stack prints as
 * `a+c`, so the shape also shows which tiles hold more than one panel.
 */
function shapeOf(node: SerializedDockview["grid"]["root"]): string {
  if (!Array.isArray(node.data)) return node.data.views.join("+");
  return `(${node.data.map(shapeOf).join(" ")})`;
}

/**
 * The sizes of a layout with the tiles stripped out — every divider position
 * and nothing about who sits where. Comparing this before and after a promote
 * is exactly the question "did the geometry change", separated from the
 * question "did the tiles move", which is supposed to change.
 */
function sizeShape(grid: SerializedGrid): unknown {
  const walk = (node: SerializedDockview["grid"]["root"]): unknown =>
    Array.isArray(node.data)
      ? { size: node.size, children: node.data.map(walk) }
      : { size: node.size };
  return walk(grid.root);
}

function createProbeDock(container: HTMLElement): DockviewApi {
  const api = createDockview(container, {
    createComponent: (options: CreateComponentOptions) => new ProbeContent(options.id),
    // Deterministic geometry: no ResizeObserver, we size it ourselves.
    disableAutoResizing: true,
    disableFloatingGroups: true,
    // Matches the real dock (see `DockingWorkspace`). Without it the probe
    // would not reproduce anything that depends on the overlay render layer.
    defaultRenderer: "always",
    theme: workspaceDockviewTheme(0),
  });
  api.layout(WIDTH, HEIGHT);
  return api;
}

/**
 * Every tile must show a 1px border on all four sides — the focus indicator
 * and, more basically, the thing that makes a tile look like a tile.
 *
 * Checked by measuring the rendered DOM rather than by reading the stylesheet,
 * because the failure this guards against was a border that existed in CSS and
 * was not visible on screen. Reports the real geometry so a failure says what
 * went wrong rather than just that something did.
 */
/** `rgb(r, g, b)` / `rgba(...)` as channel values. */
function parseRgb(color: string): [number, number, number] | null {
  const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Whether a computed color would actually mark the pixels underneath it.
 * `transparent` computes to `rgba(0, 0, 0, 0)`, so the alpha channel — not the
 * color — is what decides.
 */
function isPainted(color: string): boolean {
  const match = color.match(/rgba?\((?:[^,]+,){3}\s*([\d.]+)\s*\)/);
  if (match) return Number(match[1]) > 0;
  // No alpha component at all: an `rgb(...)` is opaque by definition.
  return parseRgb(color) !== null;
}

function contrastRatio(a: string, b: string): number | null {
  const first = parseRgb(a);
  const second = parseRgb(b);
  if (!first || !second) return null;
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

/**
 * A tile edge that exists in the DOM but cannot be seen is the bug this
 * guards. Twice the border was "fixed" by making it present — transparent
 * once, then `--color-border` at 1.23:1 — and both times it was still
 * invisible on screen. Geometry checks cannot catch that; contrast can.
 */
const MIN_TILE_EDGE_CONTRAST = 1.6;

function checkTileEdgeContrast(
  container: HTMLElement,
  checks: SelfTestCheck[],
  diagnostics: string[],
): void {
  // Every tile, not just the first. Sampling one was how the separator bug
  // below survived a passing self-test: the master is the first child at every
  // level of the grid and was the one tile still drawing all four edges.
  const groups = Array.from(container.querySelectorAll<HTMLElement>(".dv-groupview"));
  if (groups.length === 0) return;

  const ratios = groups.map((group) => {
    const style = getComputedStyle(group);
    return contrastRatio(style.borderLeftColor, style.backgroundColor);
  });

  const detail = groups
    .map((group, index) => {
      const style = getComputedStyle(group);
      return `${style.borderLeftColor} on ${style.backgroundColor} = ${
        ratios[index]?.toFixed(2) ?? "?"
      }:1`;
    })
    .join(" | ");
  diagnostics.push(`${detail} (min ${MIN_TILE_EDGE_CONTRAST})`);

  checks.push(
    check(
      "every tile's edge is actually visible",
      ratios.every((ratio) => ratio !== null && ratio >= MIN_TILE_EDGE_CONTRAST),
      detail,
    ),
  );
}

/**
 * Nothing may paint over a tile's border.
 *
 * dockview draws `--dv-separator-border` as a `::before` on every split view
 * child *but the first*, pinned to that child's leading edge at `z-index: 5`.
 * That sits exactly on top of the tile's own left or top border, so with the
 * token set to anything visible each non-master tile lost the two edges it
 * shares with its neighbours — and the focused tile's accent ring lost the
 * same two sides. Contrast and geometry both read correct while this was
 * happening, because the border really was there; it was covered.
 *
 * Asserted on the computed style of the pseudo-element rather than by
 * sampling pixels, which a DOM test cannot do.
 */
function checkNothingCoversTileEdges(
  container: HTMLElement,
  checks: SelfTestCheck[],
  diagnostics: string[],
): void {
  const views = Array.from(
    container.querySelectorAll<HTMLElement>(".dv-split-view-container > .dv-view-container > .dv-view"),
  );

  const painted = views
    .map((view) => getComputedStyle(view, "::before").backgroundColor)
    .filter(isPainted);

  diagnostics.push(
    `separators: ${views.length} view(s), ${painted.length} painted [${painted.join(",")}]`,
  );

  checks.push(
    check(
      "no separator paints over a tile's border",
      painted.length === 0,
      painted.length === 0
        ? `${views.length} view(s) clear`
        : `painted over: ${painted.join(", ")}`,
    ),
  );
}

function checkTileEdges(
  container: HTMLElement,
  checks: SelfTestCheck[],
  diagnostics: string[],
): void {
  const groups = Array.from(container.querySelectorAll<HTMLElement>(".dv-groupview"));

  if (groups.length === 0) {
    checks.push(check("tiles draw a visible border", false, "no .dv-groupview found"));
    return;
  }

  // The panel content is rendered into a separate overlay layer, positioned a
  // frame later against each group's content container. If those two disagree,
  // a tile's content sits inset from the tile — which reads as a missing edge
  // even though the border is drawn correctly.
  const contents = groups.map((group) => {
    const content = group.querySelector<HTMLElement>(".dv-content-container");
    const rect = content?.getBoundingClientRect();
    return rect ? { left: Math.round(rect.left), width: Math.round(rect.width) } : null;
  });

  const overlays = Array.from(
    container.querySelectorAll<HTMLElement>(".dv-render-overlay"),
  ).map((overlay) => {
    const rect = overlay.getBoundingClientRect();
    return { left: Math.round(rect.left), width: Math.round(rect.width) };
  });

  const aligned = overlays.every((overlay) =>
    contents.some(
      (content) =>
        content !== null &&
        Math.abs(content.left - overlay.left) <= 1 &&
        Math.abs(content.width - overlay.width) <= 1,
    ),
  );

  diagnostics.push(
    `content=[${contents
      .map((c) => (c ? `${c.left}+${c.width}` : "none"))
      .join(",")}] overlay=[${overlays
      .map((o) => `${o.left}+${o.width}`)
      .join(",")}] aligned=${aligned}`,
  );

  checks.push(
    check(
      "panel content is aligned with its tile",
      aligned,
      `${overlays.length} overlay(s) against ${contents.length} tile(s)`,
    ),
  );

  const measurements = groups.map((group) => {
    const style = getComputedStyle(group);
    const rect = group.getBoundingClientRect();
    const parent = group.parentElement;
    const parentRect = parent?.getBoundingClientRect();
    return {
      border: [
        style.borderLeftWidth,
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
      ].join("/"),
      color: style.borderLeftColor,
      box: style.boxSizing,
      width: Math.round(rect.width),
      left: Math.round(rect.left),
      parent: parent?.className ?? "none",
      parentWidth: parentRect ? Math.round(parentRect.width) : -1,
      parentLeft: parentRect ? Math.round(parentRect.left) : -1,
    };
  });

  const allBordered = measurements.every((m) => m.border === "1px/1px/1px/1px");
  // A group wider than the container it sits in would push its own left border
  // out of view under the parent's `overflow: hidden`.
  const allContained = measurements.every(
    (m) => m.width <= m.parentWidth && m.left >= m.parentLeft,
  );

  const geometry = measurements
    .map(
      (m) =>
        `border=${m.border} color=${m.color} box=${m.box} rect=${m.left}+${m.width} parent=${m.parentLeft}+${m.parentWidth}`,
    )
    .join(" | ");
  diagnostics.push(geometry);

  checks.push(
    check(
      "tiles draw a visible border on every side",
      allBordered && allContained,
      geometry,
    ),
  );
}

/**
 * The focused tile's accent ring, on a tile that is *not* the master.
 *
 * Focus is the one thing the tile border signals, and the separator broke it
 * asymmetrically: the focused tile kept its trailing edges and lost its
 * leading ones, so a tile in the stack showed an accent line down its right
 * side and nothing on its left or top. Checking the master would have shown
 * nothing wrong, because the master is the first child at every level and has
 * no separator in front of it.
 *
 * Asserted against the *other* tiles' border color rather than a hard-coded
 * accent, so the check follows the tokens instead of duplicating them.
 */
async function checkFocusRing(
  container: HTMLElement,
  api: DockviewApi,
  checks: SelfTestCheck[],
  diagnostics: string[],
): Promise<void> {
  // "d" is last in the tile order, so it is a stack tile with a separator on
  // both its leading edges.
  api.getPanel("d")?.api.setActive();
  await afterPaint();

  const active = container.querySelector<HTMLElement>(".dv-groupview.dv-active-group");
  const inactive = container.querySelector<HTMLElement>(
    ".dv-groupview:not(.dv-active-group)",
  );

  if (!active || !inactive) {
    checks.push(
      check(
        "the focused tile draws a complete accent ring",
        false,
        `active=${active !== null} inactive=${inactive !== null}`,
      ),
    );
    return;
  }

  const style = getComputedStyle(active);
  const sides = [
    style.borderTopColor,
    style.borderRightColor,
    style.borderBottomColor,
    style.borderLeftColor,
  ];
  const restingColor = getComputedStyle(inactive).borderLeftColor;

  const uniform = sides.every((side) => side === sides[0]);
  const distinct = sides[0] !== restingColor;

  const detail = `focused=[${sides.join(" ")}] resting=${restingColor}`;
  diagnostics.push(detail);

  checks.push(
    check("the focused tile draws a complete accent ring", uniform && distinct, detail),
  );
}

// ---------------------------------------------------------------------------
// 1. The tiling model, as pure functions
// ---------------------------------------------------------------------------

function checkTilingModel(checks: SelfTestCheck[]): void {
  // One tile fills the workspace; the root is still a branch, which dockview
  // requires.
  const single = tileGrid(tiles("a"), ONE_MASTER, { width: WIDTH, height: HEIGHT });
  checks.push(
    check(
      "one tile fills the workspace",
      shapeOf(single.root) === "(a)" && branchDepth(single.root) === 1,
      `shape=${shapeOf(single.root)} depth=${branchDepth(single.root)}`,
    ),
  );

  // Two tiles: master and stack, split by the fraction.
  const pair = tileGrid(tiles("a", "b"), { ...ONE_MASTER, masterFraction: 0.6 }, {
    width: WIDTH,
    height: HEIGHT,
  });
  const pairChildren = pair.root.data as SerializedDockview["grid"]["root"][];
  checks.push(
    check(
      "two tiles split by the master fraction",
      shapeOf(pair.root) === "(a b)" &&
        pairChildren[0]?.size === 720 &&
        pairChildren[1]?.size === 480,
      `shape=${shapeOf(pair.root)} widths=${pairChildren.map((c) => c.size).join("/")}`,
    ),
  );

  // The layout the report asked for by name: two stacked on the left, one on
  // the right, from `masterCount: 2` alone.
  const twoMaster = tileGrid(tiles("a", "b", "c"), { ...ONE_MASTER, masterCount: 2 }, {
    width: WIDTH,
    height: HEIGHT,
  });
  checks.push(
    check(
      "two stacked tiles left, one right",
      shapeOf(twoMaster.root) === "((a b) c)" && branchDepth(twoMaster.root) === 2,
      `shape=${shapeOf(twoMaster.root)} depth=${branchDepth(twoMaster.root)}`,
    ),
  );

  // And the mirror image: one master, the rest stacked beside it.
  const oneMaster = tileGrid(tiles("a", "b", "c"), ONE_MASTER, {
    width: WIDTH,
    height: HEIGHT,
  });
  checks.push(
    check(
      "one tile left, the rest stacked right",
      shapeOf(oneMaster.root) === "(a (b c))" && branchDepth(oneMaster.root) === 2,
      `shape=${shapeOf(oneMaster.root)} depth=${branchDepth(oneMaster.root)}`,
    ),
  );

  // A master area larger than the tile count must not produce an empty stack
  // column; it collapses to a single full-width column.
  const overflow = tileGrid(tiles("a", "b"), { ...ONE_MASTER, masterCount: 9 }, {
    width: WIDTH,
    height: HEIGHT,
  });
  checks.push(
    check(
      "master count is clamped to the tiles that exist",
      shapeOf(overflow.root) === "((a b))" && branchDepth(overflow.root) === 2,
      `shape=${shapeOf(overflow.root)}`,
    ),
  );

  // The property the whole design rests on: deriving twice changes nothing, so
  // no sequence of layout actions can accumulate structure.
  const once = tileGrid(tiles("a", "b", "c"), ONE_MASTER, { width: WIDTH, height: HEIGHT });
  const twice = tileGrid(readTiles(once), ONE_MASTER, { width: WIDTH, height: HEIGHT });
  checks.push(
    check(
      "deriving a layout is idempotent",
      JSON.stringify(once) === JSON.stringify(twice),
      `${shapeOf(once.root)} -> ${shapeOf(twice.root)}`,
    ),
  );

  // Reading tiles back gives visual order — master column first, top to
  // bottom, then the stack.
  checks.push(
    check(
      "tiles are read back in visual order",
      readTiles(twoMaster).map((tile) => tile.id).join(",") === "a,b,c",
      readTiles(twoMaster).map((tile) => tile.id).join(","),
    ),
  );

  // Reordering names only what moves, and survives ids that no longer exist.
  const reordered = reorderTiles(tiles("a", "b", "c"), ["c", "gone"]);
  checks.push(
    check(
      "reordering promotes named tiles and ignores stale ids",
      reordered.map((tile) => tile.id).join(",") === "c,a,b",
      reordered.map((tile) => tile.id).join(","),
    ),
  );
}

// ---------------------------------------------------------------------------
// 1b. The layout modes
// ---------------------------------------------------------------------------

/**
 * `wide` is `tall` rotated, and `grid` abandons the master idea altogether.
 *
 * The shapes alone cannot tell the first two apart — `(a (b c))` is the same
 * string either way — so the orientation is asserted explicitly. That is the
 * bit that actually differs, and getting it wrong would silently render a
 * `wide` layout as a `tall` one.
 */
function checkLayoutModes(checks: SelfTestCheck[]): void {
  const box = { width: WIDTH, height: HEIGHT };

  const tall = tileGrid(tiles("a", "b", "c"), ONE_MASTER, box);
  const wide = tileGrid(tiles("a", "b", "c"), WIDE, box);
  checks.push(
    check(
      "wide is tall rotated a quarter turn",
      shapeOf(tall.root) === shapeOf(wide.root) &&
        tall.orientation !== wide.orientation &&
        wide.orientation === Orientation.VERTICAL,
      `tall=${shapeOf(tall.root)}/${tall.orientation} wide=${shapeOf(wide.root)}/${
        wide.orientation
      }`,
    ),
  );

  // The master band takes its share of the axis it runs along: width in tall,
  // height in wide. Reading the wrong one would give a master band sized to
  // the other dimension and look like a random split.
  const wideBands = wide.root.data as SerializedDockview["grid"]["root"][];
  checks.push(
    check(
      "wide splits the height, not the width",
      wideBands[0]?.size === 400 && wideBands[1]?.size === 400,
      `bands=${wideBands.map((node) => node.size).join("/")} of height ${HEIGHT}`,
    ),
  );

  // ceil(sqrt(n)) bands, remainder to the front: 4 -> 2+2, 3 -> 2+1, 5 -> 2+2+1.
  const shapes = [2, 3, 4, 5, 6].map((count) =>
    shapeOf(tileGrid(tiles(..."abcdef".slice(0, count).split("")), GRID, box).root),
  );
  checks.push(
    check(
      "grid fills out as evenly as the tile count allows",
      shapes.join(" ") === "(a b) ((a b) c) ((a b) (c d)) ((a b) (c d) e) ((a b) (c d) (e f))",
      shapes.join(" "),
    ),
  );

  // The property the whole model rests on, in every mode rather than just the
  // default one: a mode that is not a fixed point would drift on every action.
  const drifting = [ONE_MASTER, WIDE, GRID].filter((params) => {
    const once = tileGrid(tiles("a", "b", "c", "d", "e"), params, box);
    const twice = tileGrid(readTiles(once), params, box);
    return JSON.stringify(once) !== JSON.stringify(twice);
  });
  checks.push(
    check(
      "deriving is idempotent in every mode",
      drifting.length === 0,
      drifting.length === 0
        ? "tall, wide and grid are all fixed points"
        : `drifts: ${drifting.map((params) => params.mode).join(", ")}`,
    ),
  );

  // Reading order must stay master-first in every mode, because `Mod+1 … 9`
  // and every reorder are expressed against it.
  const orders = [ONE_MASTER, WIDE, GRID].map((params) =>
    readTiles(tileGrid(tiles("a", "b", "c", "d", "e"), params, box))
      .map((tile) => tile.id)
      .join(""),
  );
  checks.push(
    check(
      "every mode reads back in the order it was given",
      orders.every((order) => order === "abcde"),
      orders.join(" "),
    ),
  );

  checkRotation(checks);

  // A dragged divider is read back as the fraction it represents, so the next
  // layout action keeps the width instead of snapping it.
  const dragged = tileGrid(tiles("a", "b"), { ...ONE_MASTER, masterFraction: 0.65 }, box);
  checks.push(
    check(
      "a dragged master edge reads back as its fraction",
      Math.abs((readMasterFraction(dragged, "tall") ?? 0) - 0.65) < 0.01 &&
        readMasterFraction(dragged, "grid") === null,
      `tall=${readMasterFraction(dragged, "tall")?.toFixed(3) ?? "null"} grid=${
        readMasterFraction(dragged, "grid") ?? "null"
      }`,
    ),
  );
}

/**
 * The rotation: every distinct way of dividing the screen, once each.
 *
 * "Once each" is the whole claim and the only one worth testing hard. The
 * rotation is generated by deriving every mode-and-master-count pair and
 * dropping the ones that look the same, and the deduplication is subtle —
 * four tiles as a single column of four is reachable as `tall` with a master
 * count of 4 *and* as `wide` with a master count of 1, and a rotation that
 * showed the user the same picture twice in a lap would read as broken.
 */
function checkRotation(checks: SelfTestCheck[]): void {
  const box = { width: WIDTH, height: HEIGHT };

  for (const count of [1, 2, 3, 4, 5]) {
    const probe = tiles(..."abcde".slice(0, count).split(""));
    const arrangements = arrangementsFor(count);

    // Every entry renders differently from every other.
    const pictures = arrangements.map((arrangement) =>
      shapeOf(tileGrid(probe, { ...arrangement, masterFraction: 0.5 }, box).root),
    );
    const orientations = arrangements.map(
      (arrangement) =>
        tileGrid(probe, { ...arrangement, masterFraction: 0.5 }, box).orientation,
    );
    const signatures = pictures.map((picture, index) => `${orientations[index]}:${picture}`);

    checks.push(
      check(
        `the rotation has no duplicate shapes (${count} tile${count === 1 ? "" : "s"})`,
        new Set(signatures).size === signatures.length,
        `${arrangements.length} entries: ${pictures.join(" ")}`,
      ),
    );

    // Stepping forward through the whole list returns to the start, and every
    // entry is reached exactly once on the way.
    let params: TilingParams = { ...arrangements[0]!, masterFraction: 0.5 };
    const visited: string[] = [];
    for (let step = 0; step < arrangements.length; step += 1) {
      visited.push(`${params.mode}:${params.masterCount}`);
      params = { ...params, ...rotateArrangement(params, count, 1) };
    }

    checks.push(
      check(
        `one lap of the rotation visits every arrangement and wraps (${count})`,
        new Set(visited).size === arrangements.length &&
          params.mode === arrangements[0]!.mode &&
          params.masterCount === arrangements[0]!.masterCount,
        `visited ${visited.join(" -> ")} then back to ${params.mode}:${params.masterCount}`,
      ),
    );

    // And backwards undoes forwards.
    const start: TilingParams = { ...arrangements[0]!, masterFraction: 0.5 };
    const forward = { ...start, ...rotateArrangement(start, count, 1) };
    const back = { ...forward, ...rotateArrangement(forward, count, -1) };
    checks.push(
      check(
        `stepping the rotation back undoes stepping forward (${count})`,
        arrangementIndex(back, count) === arrangementIndex(start, count),
        `${start.mode}:${start.masterCount} -> ${forward.mode}:${forward.masterCount} -> ${back.mode}:${back.masterCount}`,
      ),
    );
  }
}

/**
 * Sizes survive a re-derivation that keeps the same shape, and only then.
 *
 * The reported symptom was that promoting a tile reset a workspace the user
 * had sized by hand: the order was carried across and the sizes were not. So
 * the check is not "does a promote work" but "does the geometry come out the
 * far side unchanged when the slots are the same".
 */
function checkSizePreservation(checks: SelfTestCheck[]): void {
  const box = { width: WIDTH, height: HEIGHT };
  const four = tiles("a", "b", "c", "d");

  // A layout sized by hand: a wide master, and an uneven stack.
  const sized = tileGrid(four, { ...ONE_MASTER, masterFraction: 0.7 }, box);
  const stack = (sized.root.data as SerializedDockview["grid"]["root"][])[1]!;
  const slots = stack.data as SerializedDockview["grid"]["root"][];
  slots[0]!.size = 500;
  slots[1]!.size = 200;
  slots[2]!.size = 100;

  const profile = readSizeProfile(sized);

  // Re-derive with the tiles in a different order — a promote — and the slots
  // must come out exactly as they went in.
  const promoted = tileGrid(
    reorderTiles(four, ["c"]),
    { ...ONE_MASTER, masterFraction: 0.5 },
    box,
    profile,
  );
  const promotedBands = promoted.root.data as SerializedDockview["grid"]["root"][];
  const promotedSlots = promotedBands[1]!.data as SerializedDockview["grid"]["root"][];

  checks.push(
    check(
      "a promote keeps every slot the size it was",
      // Master band still 70% despite the params saying 50%, and the stack
      // still 500/200/100 despite the tiles having moved between the slots.
      promotedBands[0]!.size === 840 &&
        promotedSlots.map((slot) => slot.size).join(",") === "500,200,100" &&
        shapeOf(promoted.root) === "(c (a b d))",
      `master=${promotedBands[0]!.size} slots=${promotedSlots
        .map((slot) => slot.size)
        .join(",")} shape=${shapeOf(promoted.root)}`,
    ),
  );

  // A different shape has different slots, so there is nothing to carry
  // across and it falls back to the declared fraction and an even split.
  const rotated = tileGrid(four, { ...ONE_MASTER, masterCount: 2, masterFraction: 0.5 }, box, profile);
  const rotatedBands = rotated.root.data as SerializedDockview["grid"]["root"][];
  checks.push(
    check(
      "a different shape does not inherit the old sizes",
      rotatedBands[0]!.size === 600 && rotatedBands[1]!.size === 600,
      `bands=${rotatedBands.map((node) => node.size).join("/")} (expected an even 600/600)`,
    ),
  );

  // And the profile of a layout it does fit is a fixed point: deriving with
  // its own profile changes nothing, so repeated actions cannot drift.
  const again = tileGrid(readTiles(promoted), ONE_MASTER, box, readSizeProfile(promoted));
  checks.push(
    check(
      "re-deriving with a layout's own sizes is a fixed point",
      JSON.stringify(again) === JSON.stringify(promoted),
      `${shapeOf(again.root)} vs ${shapeOf(promoted.root)}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// 2. The layout actions, against a real dock
// ---------------------------------------------------------------------------

/**
 * Lets the overlay render layer finish its `requestAnimationFrame` placement.
 *
 * Raced against a timer, and that is not belt-and-braces. `requestAnimationFrame`
 * does not fire at all while the window is occluded or unfocused — every
 * webview throttles or suspends it — so an unguarded `await` here hangs the
 * *entire* self-test harness, silently and forever, on nothing worse than the
 * app opening behind the terminal. That is a far worse failure than a check
 * running a frame early: a hang reports nothing at all, and looks identical to
 * a test that is merely slow.
 */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(done));
    // Generous, because the timer is the *escape hatch*, not the mechanism: a
    // visible window delivers the frame in ~16ms and never reaches this, and an
    // occluded one is better off failing a geometry check than wedging the
    // harness.
    setTimeout(done, 1000);
  });
}

export async function runDockingSelfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [];
  // Measured geometry, logged whether or not the checks pass — the numbers are
  // the point when something looks wrong on screen but reads correct in CSS.
  const diagnostics: string[] = [];
  ProbeContent.created = [];
  ProbeContent.disposed = [];

  checkTilingModel(checks);
  checkLayoutModes(checks);
  checkSizePreservation(checks);

  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-10000px;top:0;width:${WIDTH}px;height:${HEIGHT}px;pointer-events:none;`;
  document.body.append(container);

  let api: DockviewApi | null = null;

  try {
    api = createProbeDock(container);

    // Build a layout the way the shell does: a panel per tile, then tile it.
    for (const id of ["a", "b", "c", "d"]) {
      const reference = api.activeGroup ?? api.groups[0];
      api.addPanel({
        id,
        component: "probe",
        title: id,
        ...(reference
          ? { position: { referenceGroup: reference, direction: "right" as const } }
          : {}),
      });
    }
    applyTiling(api, ONE_MASTER);

    checks.push(
      check(
        "opening files produces the tiled layout",
        shapeOf(api.toJSON().grid.root) === "(a (b c d))" && api.panels.length === 4,
        `shape=${shapeOf(api.toJSON().grid.root)}`,
      ),
    );

    await afterPaint();
    checkTileEdges(container, checks, diagnostics);
    checkTileEdgeContrast(container, checks, diagnostics);
    checkNothingCoversTileEdges(container, checks, diagnostics);
    await checkFocusRing(container, api, checks, diagnostics);

    // Re-tiling must not remount anything: dockview re-parents the live panels
    // rather than rebuilding them, which is what lets a viewer keep its
    // decoded state across a promote.
    const createdBefore = ProbeContent.created.length;
    ProbeContent.disposed = [];
    retile(api, ONE_MASTER);
    checks.push(
      check(
        "re-tiling reuses panels instead of remounting them",
        ProbeContent.created.length === createdBefore &&
          ProbeContent.disposed.length === 0,
        `created ${createdBefore} -> ${ProbeContent.created.length}, disposed ${ProbeContent.disposed.length}`,
      ),
    );

    // Make-master, repeatedly, in every mode. This is the direct regression
    // test for the bug the model replaced: re-deriving used to nest another
    // branch on every call, so the grid drifted further from a clean layout
    // each time and could not be recovered. Running it across the modes as
    // well, because a mode that built a deeper tree would fail the same way.
    let deepest = 0;
    for (const params of [ONE_MASTER, WIDE, GRID, ONE_MASTER]) {
      for (const id of ["d", "c", "b", "d", "a"]) {
        swapWithMaster(api, api.getPanel(id)!, params);
        deepest = Math.max(deepest, branchDepth(api.toJSON().grid.root));
      }
    }
    checks.push(
      check(
        "repeated re-deriving never nests the grid, in any mode",
        deepest <= 2 && api.panels.length === 4,
        `deepest branch nesting ${deepest}, ${api.panels.length} tiles, shape=${shapeOf(
          api.toJSON().grid.root,
        )}`,
      ),
    );

    checks.push(
      check(
        "make-master puts the tile in the master slot",
        findMasterGroup(api)?.activePanel?.id === "a",
        `master=${findMasterGroup(api)?.activePanel?.id ?? "none"} shape=${shapeOf(
          api.toJSON().grid.root,
        )}`,
      ),
    );

    // --- directional navigation ---------------------------------------------
    //
    // Normalised to a known order first, and put back afterwards, so this
    // block can hard-code its expectations without moving the ground under the
    // checks that follow it.
    const orderBeforeDirectional = tileOrder(api);
    const abcd: string[] = [];
    for (const id of ["a", "b", "c", "d"]) abcd.push(api.getPanel(id)!.group.id);
    applyTiling(api, ONE_MASTER, abcd);

    api.getPanel("a")!.api.setActive();

    // Moving a tile is a swap of two slots, so the tiles that were not named
    // do not move. Here "c" trades places with the tile above it.
    const beforeMove = shapeOf(api.toJSON().grid.root);
    moveInDirection(api, api.getPanel("c")!, "up", ONE_MASTER);
    checks.push(
      check(
        "moving a tile exchanges it with its neighbour and nothing else",
        beforeMove === "(a (b c d))" &&
          shapeOf(api.toJSON().grid.root) === "(a (c b d))" &&
          api.activePanel?.id === "c",
        `${beforeMove} -> ${shapeOf(api.toJSON().grid.root)}, focus=${
          api.activePanel?.id ?? "none"
        }`,
      ),
    );

    // At the edge there is nothing to swap with, so the layout is untouched
    // rather than the tile silently vanishing off the end of the order.
    const beforeEdge = shapeOf(api.toJSON().grid.root);
    const movedAtEdge = moveInDirection(api, api.getPanel("a")!, "left", ONE_MASTER);
    checks.push(
      check(
        "moving into the edge of the workspace does nothing",
        !movedAtEdge && shapeOf(api.toJSON().grid.root) === beforeEdge,
        `reported ${movedAtEdge}, shape ${beforeEdge} -> ${shapeOf(
          api.toJSON().grid.root,
        )}`,
      ),
    );


    // `Mod+1 … 9`: the nth tile in reading order, master first. Compared
    // against the order read back rather than a named tile, because the point
    // is that the numbering *follows* the order — hard-coding a letter would
    // pass even if both had drifted together.
    const landed = focusTileAt(api, 3);
    const focusedGroup = api.activePanel?.group.id;
    const pastTheEnd = focusTileAt(api, 99);
    checks.push(
      check(
        "focusing by number lands on the nth tile in order",
        landed && focusedGroup === tileOrder(api)[2] && !pastTheEnd,
        `tile 3 -> ${api.activePanel?.id ?? "none"} (landed=${landed}), tile 99 -> ${pastTheEnd}`,
      ),
    );

    // Switching mode rearranges without disturbing the order, so cycling away
    // and back is a round trip rather than a reshuffle.
    const orderBeforeCycle = tileOrder(api).join(",");
    retile(api, GRID);
    const gridShape = shapeOf(api.toJSON().grid.root);
    retile(api, WIDE);
    const wideShape = shapeOf(api.toJSON().grid.root);
    retile(api, ONE_MASTER);
    checks.push(
      check(
        "cycling through the modes and back restores the arrangement",
        gridShape === "((a c) (b d))" &&
          wideShape === "(a (c b d))" &&
          tileOrder(api).join(",") === orderBeforeCycle &&
          shapeOf(api.toJSON().grid.root) === beforeEdge,
        `grid=${gridShape} wide=${wideShape}, back to ${shapeOf(
          api.toJSON().grid.root,
        )} (was ${beforeEdge})`,
      ),
    );

    // --- sizes survive a promote --------------------------------------------
    //
    // The reported bug, end to end and against a real dock: a workspace sized
    // by hand had its dividers reset the moment a tile was promoted, because
    // the order was carried across a re-derivation and the sizes were not.
    //
    // Dragging is simulated the only way it can be here — a sash drag ends as
    // new sizes in the serialized grid, so this writes them and feeds them
    // back. That also exercises the part the pure checks cannot: whether
    // dockview reports the sizes back out through `toJSON` at all.
    retile(api, ONE_MASTER);
    const resized = api.toJSON();
    const bands = resized.grid.root.data;
    if (Array.isArray(bands) && bands.length === 2) {
      const total = (bands[0]!.size ?? 0) + (bands[1]!.size ?? 0);
      const master = Math.round(total * 0.7);
      bands[0]!.size = master;
      bands[1]!.size = total - master;
      // An uneven stack too, so the check covers every divider rather than
      // only the one between master and stack.
      const slots = bands[1]!.data;
      if (Array.isArray(slots) && slots.length === 3) {
        const height = slots.reduce((sum, slot) => sum + (slot.size ?? 0), 0);
        slots[0]!.size = Math.round(height * 0.6);
        slots[1]!.size = Math.round(height * 0.25);
        slots[2]!.size = height - slots[0]!.size - slots[1]!.size;
      }
      api.fromJSON(resized, { reuseExistingPanels: true });
    }

    const sizesBefore = JSON.stringify(sizeShape(api.toJSON().grid));
    const readBack = readMasterFraction(api.toJSON().grid, "tall");
    checks.push(
      check(
        "a resized master edge survives the round trip through dockview",
        readBack !== null && Math.abs(readBack - 0.7) < 0.02,
        `dragged to 0.70, read back ${readBack?.toFixed(3) ?? "null"}`,
      ),
    );

    // Now promote a stack tile. The tiles move between slots; the slots must
    // not move at all.
    const shapeBeforePromote = shapeOf(api.toJSON().grid.root);
    swapWithMaster(api, api.getPanel(tileOrder(api).length > 1 ? "d" : "a")!, ONE_MASTER);
    const sizesAfter = JSON.stringify(sizeShape(api.toJSON().grid));

    checks.push(
      check(
        "promoting a tile keeps every divider where it was",
        sizesBefore === sizesAfter &&
          shapeOf(api.toJSON().grid.root) !== shapeBeforePromote,
        `sizes ${sizesBefore} -> ${sizesAfter}; ${shapeBeforePromote} -> ${shapeOf(
          api.toJSON().grid.root,
        )}`,
      ),
    );

    // Hand the order back exactly as it was found, so the checks below read
    // against the arrangement they were written for.
    applyTiling(api, ONE_MASTER, orderBeforeDirectional);

    // Swap exchanges two positions and leaves every other tile alone.
    swapWithMaster(api, api.getPanel("b")!, ONE_MASTER);
    checks.push(
      check(
        "swap exchanges with master and moves nothing else",
        // From (a (b c d)): a and b trade places, c and d do not move.
        shapeOf(api.toJSON().grid.root) === "(b (a c d))",
        `shape=${shapeOf(api.toJSON().grid.root)}`,
      ),
    );

    // Raising the master count is the one-keystroke route to the arrangement
    // that was hard to reach by dragging.
    retile(api, { ...ONE_MASTER, masterCount: 2 });
    checks.push(
      check(
        "raising the master count restacks in one step",
        shapeOf(api.toJSON().grid.root) === "((b a) (c d))",
        `shape=${shapeOf(api.toJSON().grid.root)}`,
      ),
    );

    // A tab stack is one tile and must stay one tile through a re-tile: the
    // user built it deliberately.
    api.getPanel("c")!.api.moveTo({ group: api.getPanel("a")!.group, position: "center" });
    retile(api, ONE_MASTER);
    // Re-read the group: `fromJSON` rebuilds groups even while reusing the
    // panels inside them, so a reference captured beforehand is stale.
    const stacked = api.getPanel("a")!.group;
    checks.push(
      check(
        "tab stacks survive re-tiling",
        stacked.panels.length === 2 &&
          stacked.panels.some((panel) => panel.id === "c") &&
          tileOrder(api).length === 3 &&
          api.panels.length === 4,
        `${tileOrder(api).length} tiles holding ${api.panels.length} panels, stack holds ${
          stacked.panels.length
        }, shape=${shapeOf(api.toJSON().grid.root)}`,
      ),
    );

    // Monocle, and that leaving it restores the arrangement rather than
    // rebuilding one.
    const before = shapeOf(api.toJSON().grid.root);
    api.getPanel("d")!.api.setActive();
    toggleMonocle(api);
    const maximized = api.hasMaximizedGroup();
    toggleMonocle(api);
    checks.push(
      check(
        "toggles monocle and restores the layout",
        maximized &&
          !api.hasMaximizedGroup() &&
          shapeOf(api.toJSON().grid.root) === before,
        `maximized=${maximized}, ${before} -> ${shapeOf(api.toJSON().grid.root)}`,
      ),
    );

    // Serialization, which phase 07's session restore is built on.
    const serialized = api.toJSON();
    api.clear();
    const cleared = api.panels.length;
    api.fromJSON(serialized);
    checks.push(
      check(
        "serializes and restores the layout",
        cleared === 0 && api.panels.length === 4,
        `cleared to ${cleared}, restored ${api.panels.length} panel(s)`,
      ),
    );

    // Closing tiles in an arbitrary order tears each one down — the leak check
    // phase 02 asks for.
    ProbeContent.disposed = [];
    api.getPanel("b")!.api.close();
    api.getPanel("a")!.api.close();
    checks.push(
      check(
        "closing tiles disposes them",
        api.panels.length === 2 &&
          ProbeContent.disposed.includes("a") &&
          ProbeContent.disposed.includes("b"),
        `${api.panels.length} left, disposed=[${ProbeContent.disposed.join(",")}]`,
      ),
    );

    // Disposing the dock must not leave anything mounted.
    ProbeContent.disposed = [];
    api.dispose();
    api = null;
    checks.push(
      check(
        "disposing the dock disposes every panel",
        ProbeContent.disposed.length === 2,
        `disposed=[${ProbeContent.disposed.join(",")}]`,
      ),
    );
  } catch (thrown) {
    checks.push(
      check(
        "self-test ran to completion",
        false,
        thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown),
      ),
    );
  } finally {
    api?.dispose();
    container.remove();
  }

  for (const line of diagnostics) {
    void import("../../dev/log").then(({ devLog }) => devLog(`tile geometry: ${line}`));
  }

  return report("tiling and layout actions", checks);
}
