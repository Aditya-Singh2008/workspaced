/**
 * The tiling model: dwm's master/stack layout, expressed as a dockview grid.
 *
 * ## Why this exists
 *
 * Building a layout by accumulating moves — "put this tile left of that one" —
 * is how the arrangement degrades. Each move nests another branch in the grid
 * tree, so after a few promotes the tree no longer resembles anything the user
 * asked for and there is no way back to a plain two-column layout except by
 * dragging dividers around. That is the bug this module removes.
 *
 * So the layout is not accumulated, it is **derived**. dwm's insight is that a
 * tiled arrangement is a pure function of four things:
 *
 *   1. an ordered list of tiles,
 *   2. which shape they are arranged into (`mode`, dwm's layout),
 *   3. how many of them are in the master area (`masterCount`, dwm's `nmaster`),
 *   4. how much of the axis the master area gets (`masterFraction`, `mfact`).
 *
 * Every layout action is then a change to one of those four inputs followed
 * by re-deriving the whole grid. Promote is "move this tile to the front".
 * Swap is "exchange these two positions". Neither can corrupt the tree,
 * because neither edits the tree — they rebuild it. Two stacked tiles on the
 * left and one on the right is `masterCount: 2` with three tiles, reachable in
 * one keystroke from any arrangement whatsoever, including a mangled one.
 *
 * i3 contributes the other half: a *tile* here is a dockview group, not a
 * panel. A group holding three tabbed panels is one tile and stays one tile
 * through every re-derivation, the way i3 treats a tabbed container as a
 * single node. Tabs the user made by hand are never silently unstacked.
 *
 * ## What this does not do
 *
 * No geometry. The output is a `SerializedDockview` — dockview's own layout
 * format, fed back through its own `fromJSON`. dockview still owns sash
 * dragging, drop targets, hit-testing, minimum sizes and every pixel. This
 * module decides *shape and order*; the library does the rest. That is the
 * line AGENTS.md's "no hand-rolled layout math" draws, and it is not crossed
 * by choosing which tile goes where.
 *
 * Everything here is pure and total, which is what makes it testable without
 * a DOM (see `selftest.ts`).
 */

import { Orientation, type SerializedDockview } from "dockview-react";

/** One node of dockview's serialized grid: a branch of children, or a leaf. */
type GridNode = SerializedDockview["grid"]["root"];

/**
 * A leaf's payload — the serialized state of one dockview group. Extracted
 * from the node type rather than imported, because dockview does not export
 * the name. Arrays have no `id`, so this picks the group state unambiguously.
 */
export type TileState = Extract<GridNode["data"], { id: string }>;

export type SerializedGrid = SerializedDockview["grid"];

/**
 * The shape a set of tiles is arranged into.
 *
 * dwm calls these layouts and cycles them with one key, which is the cheapest
 * possible way to reach a very different arrangement: the tile order is
 * untouched, so switching shape and switching back is a no-op. `tall` and
 * `wide` are the same layout along the two axes (dwm's `tile` and `bstack`);
 * `grid` abandons the master idea entirely and gives every tile equal room,
 * which is what you want when comparing rather than working on one thing.
 */
export type LayoutMode = "tall" | "wide" | "grid";

export interface LayoutModeInfo {
  readonly id: LayoutMode;
  readonly label: string;
  /**
   * dwm's status-bar glyph for the layout, kept verbatim. It is three
   * monospace cells wide in every mode, so the indicator never reflows as it
   * changes, and it is the notation this app's audience already reads.
   */
  readonly symbol: string;
  /** One line, shown in the layout indicator's tooltip. */
  readonly description: string;
}

export const LAYOUT_MODES: readonly LayoutModeInfo[] = [
  {
    id: "tall",
    label: "tall",
    symbol: "[]=",
    description: "master area on the left, the stack beside it",
  },
  {
    id: "wide",
    label: "wide",
    symbol: "TTT",
    description: "master area on top, the stack beneath it",
  },
  {
    id: "grid",
    label: "grid",
    symbol: "HHH",
    description: "every tile the same size; master count and width do not apply",
  },
];

export function layoutModeInfo(mode: LayoutMode): LayoutModeInfo {
  return LAYOUT_MODES.find((info) => info.id === mode) ?? LAYOUT_MODES[0]!;
}

/** Whether the master area means anything in this mode. */
export function hasMasterArea(mode: LayoutMode): boolean {
  return mode !== "grid";
}

export interface TilingParams {
  /** Which shape the tiles are arranged into. */
  readonly mode: LayoutMode;
  /** Tiles in the master area. At least 1. dwm's `nmaster`. */
  readonly masterCount: number;
  /** Share of the axis the master area takes, `0..1`. dwm's `mfact`. */
  readonly masterFraction: number;
}

/** Below this a tile is too narrow to be worth showing. */
export const MIN_MASTER_FRACTION = 0.2;
export const MAX_MASTER_FRACTION = 0.8;

export const DEFAULT_TILING_PARAMS: TilingParams = {
  mode: "tall",
  masterCount: 1,
  masterFraction: 0.5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampMasterFraction(fraction: number): number {
  return clamp(fraction, MIN_MASTER_FRACTION, MAX_MASTER_FRACTION);
}

/**
 * The tiles of a layout, in visual order: master area first, then the stack,
 * each column top to bottom.
 *
 * dockview serializes a branch's children in layout order, so a depth-first
 * walk *is* the visual order — for the grids this module produces and for any
 * freeform arrangement the user dragged into place. That is what lets a
 * hand-made layout be normalized without the tiles jumping around: they keep
 * the order they already appeared in.
 */
export function readTiles(grid: SerializedGrid): readonly TileState[] {
  const tiles: TileState[] = [];

  const walk = (node: GridNode): void => {
    if (Array.isArray(node.data)) {
      for (const child of node.data) walk(child);
    } else {
      tiles.push(node.data);
    }
  };

  walk(grid.root);
  return tiles;
}

/**
 * Reorders `tiles` so the ids in `order` come first, in that order.
 *
 * Ids that no longer exist are ignored and tiles missing from `order` keep
 * their relative position at the end, so a caller can say "this one goes to
 * the front" without having to name every other tile.
 */
export function reorderTiles(
  tiles: readonly TileState[],
  order: readonly string[],
): readonly TileState[] {
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const promoted: TileState[] = [];

  for (const id of order) {
    const tile = byId.get(id);
    if (tile) {
      promoted.push(tile);
      byId.delete(id);
    }
  }

  return [...promoted, ...tiles.filter((tile) => byId.has(tile.id))];
}

function leaf(tile: TileState, size: number): GridNode {
  return { type: "leaf", data: tile, size };
}

/**
 * Splits `total` into `count` parts by the given fractions, or evenly when
 * there are none. The last part absorbs the rounding so the parts always add
 * back up to `total` — dockview re-proportions anyway, but a grid whose
 * children do not sum to their parent is a confusing thing to read in a
 * serialized layout.
 */
function distribute(
  total: number,
  count: number,
  fractions?: readonly number[],
): number[] {
  const parts: number[] = [];
  let used = 0;

  for (let index = 0; index < count - 1; index += 1) {
    const size = Math.round(total * (fractions?.[index] ?? 1 / count));
    parts.push(size);
    used += size;
  }

  parts.push(total - used);
  return parts;
}

/**
 * One band of the layout — a column in `tall` and `grid`, a row in `wide`.
 *
 * A single tile becomes a leaf; several become a branch splitting the cross
 * axis, evenly unless `slots` says otherwise. Written against "along" and
 * "across" rather than width and height so the same function serves every
 * mode: dockview alternates orientation with each level of nesting, so a
 * band's children are always laid out across whatever axis its parent runs
 * along.
 */
function band(
  tiles: readonly TileState[],
  along: number,
  across: number,
  slots?: readonly number[],
): GridNode {
  if (tiles.length === 1) return leaf(tiles[0]!, along);

  const extents = distribute(across, tiles.length, slots);
  return {
    type: "branch",
    size: along,
    data: tiles.map((tile, index) => leaf(tile, extents[index]!)),
  };
}

/**
 * `grid` mode: bands of near-equal size, as square as the tile count allows.
 *
 * `ceil(sqrt(n))` bands is dwm's gapless-grid rule and it degrades sensibly —
 * two tiles side by side, four in a square, five as 2/2/1. The remainder goes
 * to the leading bands so any unevenness is at the end.
 */
function gridGroups(tiles: readonly TileState[]): TileState[][] {
  const bandCount = Math.ceil(Math.sqrt(tiles.length));
  const base = Math.floor(tiles.length / bandCount);
  const remainder = tiles.length % bandCount;

  const groups: TileState[][] = [];
  let index = 0;

  for (let position = 0; position < bandCount; position += 1) {
    const count = base + (position < remainder ? 1 : 0);
    groups.push(tiles.slice(index, index + count));
    index += count;
  }

  return groups;
}

/** How a mode divides its tiles into bands. The only thing modes disagree on. */
function bandGroups(
  tiles: readonly TileState[],
  params: TilingParams,
): TileState[][] {
  if (params.mode === "grid") return gridGroups(tiles);

  const masterCount = clamp(Math.round(params.masterCount), 1, tiles.length);
  const master = tiles.slice(0, masterCount);
  const stack = tiles.slice(masterCount);

  // Everything fits in the master area: one full-extent band, no stack.
  return stack.length === 0 ? [master] : [master, stack];
}

/**
 * The axis a mode's top-level bands are laid out along. `wide` is `tall`
 * rotated a quarter turn, and this is the only place that difference lives.
 */
function rootOrientation(mode: LayoutMode): Orientation {
  return mode === "wide" ? Orientation.VERTICAL : Orientation.HORIZONTAL;
}

/**
 * The sizes a layout is currently showing, as fractions rather than pixels.
 *
 * The tile *order* was always preserved across a re-derivation; the sizes were
 * not, so making a tile master snapped every divider back to an even split and
 * threw away a carefully sized workspace. This is the missing half: the shape
 * says which slots exist, and this says how big each one is.
 *
 * Fractions rather than pixels because the window may have resized in between,
 * and because a fraction is the only form in which a size means the same thing
 * after the grid has been rebuilt.
 */
export interface SizeProfile {
  readonly orientation: Orientation;
  /** Each band's share of the root axis, and each slot's share within it. */
  readonly bands: readonly {
    readonly fraction: number;
    readonly slots: readonly number[];
  }[];
}

export function readSizeProfile(grid: SerializedGrid): SizeProfile | null {
  const children = grid.root.data;
  if (!Array.isArray(children) || children.length === 0) return null;

  const total = children.reduce((sum, node) => sum + (node.size ?? 0), 0);
  if (total <= 0) return null;

  return {
    orientation: grid.orientation,
    bands: children.map((node) => {
      const slots = Array.isArray(node.data) ? node.data : null;
      const slotTotal = slots?.reduce((sum, slot) => sum + (slot.size ?? 0), 0) ?? 0;
      return {
        fraction: (node.size ?? 0) / total,
        // A leaf band is one slot filling itself, so the shapes below can
        // compare slot counts without special-casing leaves.
        slots:
          slots && slotTotal > 0
            ? slots.map((slot) => (slot.size ?? 0) / slotTotal)
            : [1],
      };
    }),
  };
}

/**
 * Whether a profile describes the shape about to be derived.
 *
 * Sizes are kept only when the arrangement is *the same shape* — same axis,
 * same bands, same number of tiles in each. Rotating to a different shape, or
 * opening and closing tiles, has no slot to carry a size across, so those fall
 * back to an even split and to `masterFraction`. That is the right behaviour
 * and not a limitation: the sizes belonged to slots that no longer exist.
 */
function profileFits(
  profile: SizeProfile | undefined | null,
  orientation: Orientation,
  bandSizes: readonly number[],
): profile is SizeProfile {
  return (
    !!profile &&
    profile.orientation === orientation &&
    profile.bands.length === bandSizes.length &&
    bandSizes.every((count, index) => profile.bands[index]!.slots.length === count)
  );
}

/**
 * Derives the whole grid from the tile order and the two parameters.
 *
 * A node's `size` is its extent along its parent branch's axis: widths for the
 * root's children (the root is horizontal, so master area then stack area),
 * heights within each column. dockview re-proportions everything to the real
 * container on the next layout pass, so these are ratios expressed in pixels
 * rather than measurements anyone has to get exactly right.
 */
export function tileGrid(
  tiles: readonly TileState[],
  params: TilingParams,
  box: { readonly width: number; readonly height: number },
  profile?: SizeProfile | null,
): SerializedGrid {
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));

  const orientation = rootOrientation(params.mode);
  const horizontal = orientation === Orientation.HORIZONTAL;
  // The extent bands are measured along, and the extent they span across.
  const along = horizontal ? width : height;
  const across = horizontal ? height : width;

  // The root must always be a branch — dockview rejects a leaf root.
  const grid = (children: GridNode[]): SerializedGrid => ({
    root: { type: "branch", data: children, size: across },
    width,
    height,
    orientation,
  });

  if (tiles.length === 0) return grid([]);

  const groups = bandGroups(tiles, params);
  const keepSizes = profileFits(
    profile,
    orientation,
    groups.map((group) => group.length),
  );

  // Same shape as what is on screen: carry every slot's size across, which is
  // what stops a promote from resetting a workspace the user sized by hand.
  // Otherwise fall back to the master fraction and an even stack.
  const bandFractions = keepSizes
    ? profile.bands.map((entry) => entry.fraction)
    : defaultBandFractions(groups.length, params);

  const extents = distribute(along, groups.length, bandFractions);

  return grid(
    groups.map((group, index) =>
      band(
        group,
        extents[index]!,
        across,
        keepSizes ? profile.bands[index]!.slots : undefined,
      ),
    ),
  );
}

/** Master and stack take their declared shares; every other shape is even. */
function defaultBandFractions(
  bandCount: number,
  params: TilingParams,
): readonly number[] | undefined {
  if (bandCount !== 2 || !hasMasterArea(params.mode)) return undefined;
  const master = clampMasterFraction(params.masterFraction);
  return [master, 1 - master];
}

/**
 * The master fraction the *live* grid is actually showing, or `null` if the
 * question does not apply — a grid layout, a single band, or a shape this
 * module did not derive.
 *
 * This is what makes a dragged divider stick. dockview owns sash geometry, so
 * after the user drags the master edge the store's `masterFraction` is stale,
 * and the next promote would snap the width back to whatever was last set by
 * keyboard. Reading the ratio back before re-deriving keeps the arrangement
 * the user built.
 *
 * Reading a ratio out of dockview's own serialized sizes is the same move
 * `readTiles` makes with order, and stays on the right side of AGENTS.md's
 * "no hand-rolled layout math": nothing here measures a pixel or positions
 * anything, it asks the library what it already decided.
 */
export function readMasterFraction(
  grid: SerializedGrid,
  mode: LayoutMode,
): number | null {
  if (!hasMasterArea(mode)) return null;
  if (grid.orientation !== rootOrientation(mode)) return null;

  const children = grid.root.data;
  if (!Array.isArray(children) || children.length !== 2) return null;

  const master = children[0]!.size ?? 0;
  const stack = children[1]!.size ?? 0;
  const total = master + stack;
  if (total <= 0) return null;

  return clampMasterFraction(master / total);
}

/**
 * Rebuilds a layout's grid, keeping everything else — the panel states, which
 * group is active, each group's tab order — exactly as it was.
 *
 * Reusing `current.panels` verbatim rather than reconstructing it is what
 * makes re-tiling lossless: titles, renderers and per-panel params are carried
 * across untouched, and dockview can reuse the live panel objects instead of
 * remounting the viewers inside them.
 */
export function tileLayout(
  current: SerializedDockview,
  params: TilingParams,
  order?: readonly string[],
): SerializedDockview {
  const tiles = readTiles(current.grid);
  const ordered = order ? reorderTiles(tiles, order) : tiles;

  return {
    ...current,
    grid: tileGrid(
      ordered,
      params,
      { width: current.grid.width, height: current.grid.height },
      // The sizes currently on screen. Reused when the new shape has the same
      // slots as the old one, which is what makes a promote move tiles between
      // slots instead of resetting the slots themselves.
      readSizeProfile(current.grid),
    ),
  };
}

// ---------------------------------------------------------------------------
// The rotation
// ---------------------------------------------------------------------------

/** A mode and a master count: one entry in the rotation. */
export interface Arrangement {
  readonly mode: LayoutMode;
  readonly masterCount: number;
}

/**
 * How a shape divides the screen, ignoring which tile is where and how big
 * each slot is. Two arrangements with the same signature look identical, so
 * only one of them belongs in the rotation.
 *
 * The canonicalisation matters more than it looks: a single band of `k` slots
 * renders *exactly* like `k` bands of one slot in the other orientation. Four
 * tiles stacked as rows can be reached as `tall` with a master count of 4 or
 * as `wide` with a master count of 1, and without folding those together the
 * rotation would visit the same picture twice and feel broken.
 */
function shapeSignature(grid: SerializedGrid): string {
  const bands = Array.isArray(grid.root.data) ? grid.root.data : [];
  let orientation = grid.orientation;
  let slots = bands.map((node) => (Array.isArray(node.data) ? node.data.length : 1));

  if (slots.length === 1 && slots[0]! > 1) {
    orientation =
      orientation === Orientation.HORIZONTAL
        ? Orientation.VERTICAL
        : Orientation.HORIZONTAL;
    slots = Array.from({ length: slots[0]! }, () => 1);
  }

  return `${orientation}:${slots.join(",")}`;
}

/** Probe tiles, enough for `tileGrid`: only the count affects the shape. */
function probeTiles(count: number): TileState[] {
  return Array.from(
    { length: count },
    (_, index) => ({ id: `${index}`, views: [`${index}`], activeView: `${index}` }) as TileState,
  );
}

/**
 * Every distinct way this model can divide the screen between `tileCount`
 * tiles, in the order the rotation visits them.
 *
 * Derived rather than listed: each candidate is actually built and kept only
 * if it looks different from everything already in the list. That way the
 * rotation cannot drift out of step with what `tileGrid` does — adding a mode
 * or changing how `grid` splits automatically changes the rotation to match,
 * and a mode that turns out to duplicate another simply never appears.
 *
 * Ordered `tall` widest-master first, then `wide`, then `grid`, so a lap walks
 * the vertical splits, then the horizontal ones, rather than jumping axis
 * every press.
 */
export function arrangementsFor(tileCount: number): readonly Arrangement[] {
  const count = Math.max(1, tileCount);
  const box = { width: 1000, height: 1000 };
  const tiles = probeTiles(count);

  const candidates: Arrangement[] = [];
  for (const mode of ["tall", "wide"] as const) {
    for (let masterCount = 1; masterCount <= count; masterCount += 1) {
      candidates.push({ mode, masterCount });
    }
  }
  candidates.push({ mode: "grid", masterCount: 1 });

  const seen = new Set<string>();
  const distinct: Arrangement[] = [];

  for (const candidate of candidates) {
    const signature = shapeSignature(
      tileGrid(tiles, { ...candidate, masterFraction: 0.5 }, box),
    );
    if (seen.has(signature)) continue;
    seen.add(signature);
    distinct.push(candidate);
  }

  return distinct;
}

/**
 * Where the current parameters sit in the rotation, or `-1`.
 *
 * Matched by signature rather than by comparing mode and master count,
 * because the two are not one-to-one: a master count past the tile count is
 * clamped, and several pairs land on the same picture. Matching on what is
 * actually on screen is what makes the next press step to the next *visibly*
 * different shape.
 */
export function arrangementIndex(
  params: TilingParams,
  tileCount: number,
): number {
  const count = Math.max(1, tileCount);
  const box = { width: 1000, height: 1000 };
  const tiles = probeTiles(count);
  const current = shapeSignature(tileGrid(tiles, params, box));

  return arrangementsFor(count).findIndex(
    (candidate) =>
      shapeSignature(tileGrid(tiles, { ...candidate, masterFraction: 0.5 }, box)) ===
      current,
  );
}

/** The next (or previous) distinct shape, wrapping at both ends. */
export function rotateArrangement(
  params: TilingParams,
  tileCount: number,
  delta: number,
): Arrangement {
  const arrangements = arrangementsFor(tileCount);
  const index = arrangementIndex(params, tileCount);
  // An unrecognised shape — a freehand drag, say — rotates into the first
  // entry rather than nowhere.
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index;
  const next = (((from + delta) % arrangements.length) + arrangements.length) %
    arrangements.length;
  return arrangements[next]!;
}
