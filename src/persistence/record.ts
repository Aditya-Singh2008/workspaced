/**
 * What a saved session is, and how one is read back safely.
 *
 * The record is the only thing this app writes that it will later read without
 * having written it in the same run — a file on disk, editable by hand, left
 * behind by an older build, possibly truncated by a crash mid-write. So the
 * types below are only half of this module; the other half is
 * {@link parseSession}, which treats every field as hostile and answers with
 * either a complete, usable record or `null`. Nothing else in `persistence/`
 * validates anything, because everything else runs after this.
 *
 * Three versions travel independently, and the split is deliberate:
 *
 *   - {@link SESSION_RECORD_VERSION} is this file's shape. A mismatch discards
 *     the whole record, because nothing in it can be trusted to mean what it
 *     says.
 *   - `ViewerPluginDescriptor.stateVersion` is one plugin's opaque tile state.
 *     A mismatch discards *that tile's* state and reopens the file with
 *     defaults — the file, the layout and every sibling tile are unaffected.
 *   - The annotation models' `OVERLAY_VERSION` / `TEXT_ANNOTATION_VERSION` do
 *     the same thing one level down, per document (`annotation/store.ts`).
 *
 * A single version for all three would mean one plugin bumping its state
 * version threw away everybody's layout, which is the failure this arrangement
 * exists to avoid.
 */

import type { SerializedDockview } from "dockview-react";

import type { AnnotationDocumentRecord } from "../annotation";
import type { PersistedFileRef } from "../files";
import type { SidebarPanelId } from "../shell/sidebar/panels";
import { SIDEBAR_PANEL_IDS } from "../shell/sidebar/panels";
import {
  clampMasterFraction,
  DEFAULT_TILING_PARAMS,
  LAYOUT_MODES,
  type LayoutMode,
  type TilingParams,
} from "../shell/docking/tiling";

/** Bumped when the shape below changes incompatibly. */
export const SESSION_RECORD_VERSION = 1;

/** One tile: which file it stood for, in which plugin, showing what. */
export interface PersistedTile {
  /** The workspace-client id, which is also the dockview panel id. */
  readonly clientId: string;
  readonly pluginId: string;
  /** The plugin's `stateVersion` when {@link state} was produced. */
  readonly stateVersion: number;
  /** A real path plus enough identity to notice the file changed. */
  readonly file: PersistedFileRef;
  /** Whatever `ViewerInstance.serialize()` returned. Opaque here, always. */
  readonly state?: unknown;
}

/** The shell's own preferences — everything except the grid itself. */
export interface PersistedShellState {
  readonly tiling: TilingParams;
  readonly gapIndex: number;
  readonly sidebarVisible: boolean;
  readonly sidebarPanel: SidebarPanelId;
  /** Which tile had focus, so a restored workspace resumes where it was left. */
  readonly activeClientId: string | null;
}

/** One plugin's viewer-wide preferences, from `ViewerPreferencesApi`. */
export interface PersistedPreferences {
  readonly version: number;
  readonly value: unknown;
}

export interface PersistedSession {
  readonly version: number;
  readonly savedAt: number;
  readonly tiles: readonly PersistedTile[];
  /**
   * dockview's own serialization, panel ids included — and those ids are the
   * client ids in {@link tiles}, which is why a restore recreates clients with
   * their recorded ids instead of minting new ones and rewriting this.
   *
   * `null` when the workspace was empty, which is different from a record with
   * no layout key at all (an older or damaged file).
   */
  readonly layout: SerializedDockview | null;
  readonly shell: PersistedShellState;
  /** Keyed by plugin id. */
  readonly preferences: Readonly<Record<string, PersistedPreferences>>;
  readonly annotations: readonly AnnotationDocumentRecord[];
}

export const EMPTY_SHELL_STATE: PersistedShellState = {
  tiling: DEFAULT_TILING_PARAMS,
  gapIndex: 0,
  sidebarVisible: false,
  sidebarPanel: "views",
  activeClientId: null,
};

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A file reference, or `null` if it is not one.
 *
 * The path is the only field worth failing over: without it there is nothing to
 * reopen, and a tile that exists to show a file it cannot name is worse than
 * one tile fewer. Everything else has a defensible default — a `size` of `-1`
 * simply makes the change check report "changed", which is the safe answer.
 */
function parseFileRef(value: unknown): PersistedFileRef | null {
  if (!isObject(value)) return null;
  const path = value.path;
  if (typeof path !== "string" || path.length === 0) return null;

  return {
    path,
    // Both separators: a record written on Windows carries `\`, and a name
    // derived with only `/` there would be the whole path.
    name: stringOr(
      value.name,
      path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1),
    ),
    size: finiteOr(value.size, -1),
    modifiedAt: typeof value.modifiedAt === "number" ? value.modifiedAt : undefined,
    mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
  };
}

function parseTile(value: unknown): PersistedTile | null {
  if (!isObject(value)) return null;
  const file = parseFileRef(value.file);
  if (!file) return null;
  if (typeof value.clientId !== "string" || value.clientId.length === 0) return null;
  if (typeof value.pluginId !== "string" || value.pluginId.length === 0) return null;

  return {
    clientId: value.clientId,
    pluginId: value.pluginId,
    // A tile with no recorded version can only be treated as "not this one",
    // which is what -1 achieves against any real `stateVersion`.
    stateVersion: finiteOr(value.stateVersion, -1),
    file,
    state: value.state,
  };
}

function parseTiling(value: unknown): TilingParams {
  if (!isObject(value)) return DEFAULT_TILING_PARAMS;
  const mode = LAYOUT_MODES.some((info) => info.id === value.mode)
    ? (value.mode as LayoutMode)
    : DEFAULT_TILING_PARAMS.mode;

  return {
    mode,
    masterCount: Math.max(
      1,
      Math.round(finiteOr(value.masterCount, DEFAULT_TILING_PARAMS.masterCount)),
    ),
    masterFraction: clampMasterFraction(
      finiteOr(value.masterFraction, DEFAULT_TILING_PARAMS.masterFraction),
    ),
  };
}

function parseShell(value: unknown): PersistedShellState {
  if (!isObject(value)) return EMPTY_SHELL_STATE;

  return {
    tiling: parseTiling(value.tiling),
    // Not clamped to `GAP_STEPS` here: `gapForIndex` already falls back for an
    // index it does not know, and duplicating the bound would mean two places
    // to change when a step is added.
    gapIndex: Math.max(0, Math.round(finiteOr(value.gapIndex, 0))),
    sidebarVisible: value.sidebarVisible === true,
    sidebarPanel: SIDEBAR_PANEL_IDS.includes(value.sidebarPanel as SidebarPanelId)
      ? (value.sidebarPanel as SidebarPanelId)
      : "views",
    activeClientId:
      typeof value.activeClientId === "string" ? value.activeClientId : null,
  };
}

/**
 * The layout, kept only if it is dockview-shaped and describes tiles this
 * record actually has.
 *
 * The second half is what stops a half-written record from producing a
 * workspace with a panel nothing can render: `fromJSON` would build the grid,
 * the panel would resolve no client, and the tile would be a permanently blank
 * rectangle. Dropping the layout instead costs the arrangement and keeps every
 * file — the tiling model re-derives a clean grid from the tile order, which is
 * exactly what it is for.
 */
function parseLayout(
  value: unknown,
  tiles: readonly PersistedTile[],
): SerializedDockview | null {
  if (!isObject(value)) return null;
  const panels = value.panels;
  if (!isObject(value.grid) || !isObject(panels)) return null;

  const known = new Set(tiles.map((tile) => tile.clientId));
  const panelIds = Object.keys(panels);
  if (panelIds.length !== known.size) return null;
  if (!panelIds.every((id) => known.has(id))) return null;

  return value as unknown as SerializedDockview;
}

function parsePreferences(value: unknown): Record<string, PersistedPreferences> {
  if (!isObject(value)) return {};
  const out: Record<string, PersistedPreferences> = {};

  for (const [pluginId, entry] of Object.entries(value)) {
    if (!isObject(entry) || typeof entry.version !== "number") continue;
    out[pluginId] = { version: entry.version, value: entry.value };
  }
  return out;
}

function parseAnnotations(value: unknown): readonly AnnotationDocumentRecord[] {
  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is AnnotationDocumentRecord => {
    if (!isObject(entry)) return false;
    return (
      typeof entry.key === "string" &&
      typeof entry.overlayVersion === "number" &&
      typeof entry.textVersion === "number" &&
      Array.isArray(entry.overlay) &&
      Array.isArray(entry.text)
    );
  });
}

/**
 * Reads a record written by {@link SESSION_RECORD_VERSION}, or `null`.
 *
 * `null` covers every reason a session cannot be used — absent, wrong version,
 * not an object, no usable tiles — because the caller's response to all of them
 * is the same: start empty. What it deliberately does *not* do is throw: a
 * damaged session file is a thing to step over on the way to a working app, not
 * an error to show someone who has not done anything wrong.
 */
export function parseSession(value: unknown): PersistedSession | null {
  if (!isObject(value)) return null;
  if (value.version !== SESSION_RECORD_VERSION) return null;

  const tiles = Array.isArray(value.tiles)
    ? value.tiles.map(parseTile).filter((tile): tile is PersistedTile => tile !== null)
    : [];

  return {
    version: SESSION_RECORD_VERSION,
    savedAt: finiteOr(value.savedAt, 0),
    tiles,
    layout: parseLayout(value.layout, tiles),
    shell: parseShell(value.shell),
    preferences: parsePreferences(value.preferences),
    annotations: parseAnnotations(value.annotations),
  };
}

/**
 * Whether a record has anything worth restoring.
 *
 * The preferences and the annotations count: someone who closed every tile
 * before quitting still set a default fit mode and still annotated a document,
 * and losing those because the *workspace* was empty would be a bug.
 */
export function isEmptySession(session: PersistedSession): boolean {
  return (
    session.tiles.length === 0 &&
    session.annotations.length === 0 &&
    Object.keys(session.preferences).length === 0
  );
}

/**
 * The state to hand a plugin, or `undefined` when the version has moved on.
 *
 * The contract's promise to a plugin is that `initialState` has already been
 * version-checked, so it can trust the *shape* while still tolerating partial
 * values. This one function is that promise.
 */
export function usableTileState(
  tile: PersistedTile,
  stateVersion: number | undefined,
): unknown {
  if (stateVersion === undefined) return undefined;
  return tile.stateVersion === stateVersion ? tile.state : undefined;
}

/**
 * Whether a value survives the round trip through the store's JSON.
 *
 * A plugin's `serialize()` is required to return plain JSON, and the shell must
 * not have to trust it: a `Map`, a DOM node or a cycle in one tile's state
 * would otherwise throw inside the write and lose the *whole* record, layout
 * and every other tile included. Checked per tile, so a plugin that gets this
 * wrong costs only its own state.
 */
export function isJsonSafe(value: unknown): boolean {
  if (value === undefined) return true;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
