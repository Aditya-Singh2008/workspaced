/**
 * What the command palette can run, derived rather than listed.
 *
 * Every entry comes from something that already exists — the dock's action
 * list, the focused plugin's contributed keybinds and toolbar controls, the
 * shell's own verbs — so the palette cannot fall out of step with the rest of
 * the app, and an action added in a later phase appears here without this file
 * changing. That is the same reasoning `shell/docking/actions.ts` gives for the
 * context menu, applied one level up.
 *
 * ## The four sources, and what each one answers
 *
 * | source | the brief's requirement it satisfies |
 * | --- | --- |
 * | shell verbs | "open a file", "trigger global search" |
 * | `DOCK_ACTIONS` | "switch layout arrangement" |
 * | the focused tile's keybinds and toolbar controls | "trigger annotation mode on the focused tile if supported" |
 * | `subdivisionCount` + `reveal` | "jump to a page/position within the focused tile (delegated to that plugin)" |
 *
 * The third row is the one worth reading twice. Annotate mode is a *PDF* verb,
 * and the palette must not know that: it lists whatever the focused instance
 * contributes through `ViewerKeybindApi` and `ViewerToolbarApi`, which for a
 * PDF happens to include "annotate" and for an image happens to include
 * "rotate". A plugin that grows a new mode is in the palette the moment it is
 * in the reference modal, and a plugin that has none contributes nothing.
 *
 * Hidden bindings are left out on purpose: `hidden` is an author saying "this
 * is registered but should not be listed", and the palette is a list. They stay
 * reachable exactly where their plugin put them — the tile's own context menu.
 */

import type { DockviewApi } from "dockview-react";

import { getViewerInstance, type ViewerInstance } from "../../viewers";
import { clientLabel, type WorkspaceClient } from "../../store";
import { DOCK_ACTIONS } from "../docking/actions";
import { isDockActionAvailable } from "../docking/useDockKeybinds";

export interface PaletteCommand {
  /** Stable and namespaced; also the React key. */
  readonly id: string;
  readonly label: string;
  /** The section heading, and part of what the filter matches against. */
  readonly group: string;
  /** Accelerator *spec*, formatted for the platform by the component. */
  readonly accelerator?: string;
  /** A second line, when the label alone does not identify the target. */
  readonly detail?: string;
  /** Listed but not runnable — an action with no tile to act on. */
  readonly disabled?: boolean;
  run(): void;
}

/** The verbs the palette needs from the shell, injected rather than imported. */
export interface PaletteShellActions {
  openFile(): void;
  showSearch(text?: string): void;
  showScratch(): void;
  toggleSidebar(): void;
  toggleKeybindReference(): void;
  copyToClipboard(): void;
  yankToScratch(): void;
  startRegionCapture(): void;
  canCopy(): boolean;
  canCopyRegion(): boolean;
  clearSavedSession(): void;
  /** Whether this run is still being recorded — false once it has been cleared. */
  sessionRecording(): boolean;
}

export interface PaletteContext {
  /** What the user has typed. Only the dynamic entries look at it. */
  readonly query: string;
  readonly dockApi: DockviewApi | null;
  readonly clients: readonly WorkspaceClient[];
  readonly activeClientId: string | null;
  readonly actions: PaletteShellActions;
}

export const PALETTE_GROUPS = {
  shell: "shell",
  layout: "layout",
  focus: "focus",
  tile: "this tile",
  go: "go to",
} as const;

/**
 * Everything runnable right now, in the order the palette shows it with an
 * empty query.
 *
 * Dynamic entries lead, because they are answers to what the user has already
 * typed and burying them under a fixed list would defeat typing it.
 */
export function buildPaletteCommands(context: PaletteContext): readonly PaletteCommand[] {
  const instance = context.activeClientId
    ? getViewerInstance(context.activeClientId)
    : undefined;

  return [
    ...dynamicCommands(context, instance),
    ...shellCommands(context),
    ...tileCommands(instance),
    ...dockCommands(context),
  ];
}

/** Entries that only exist because of what is in the box. */
function dynamicCommands(
  context: PaletteContext,
  instance: ViewerInstance | undefined,
): readonly PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  const query = context.query.trim();

  // "Jump to a page/position within the focused tile", delegated: the shell
  // knows how many subdivisions there are and how to ask for one, and nothing
  // about what a subdivision is.
  const count = instance?.capabilities.subdivisionCount ?? 0;
  const wanted = /^\d+$/.test(query) ? Number.parseInt(query, 10) : null;
  if (instance?.reveal && count > 1 && wanted !== null && wanted >= 1 && wanted <= count) {
    commands.push({
      id: `go.subdivision.${wanted}`,
      group: PALETTE_GROUPS.go,
      label: `go to ${wanted} of ${count}`,
      detail: "in the focused tile",
      run: () => void instance.reveal?.({ subdivision: wanted - 1 }),
    });
  }

  if (query.length > 0) {
    commands.push({
      id: "shell.searchFor",
      group: PALETTE_GROUPS.shell,
      label: `search open tiles for “${query}”`,
      run: () => context.actions.showSearch(query),
    });
  }

  return commands;
}

function shellCommands(context: PaletteContext): readonly PaletteCommand[] {
  const { actions } = context;

  return [
    {
      id: "shell.openFile",
      group: PALETTE_GROUPS.shell,
      label: "open file",
      accelerator: "Mod+O",
      run: () => actions.openFile(),
    },
    {
      id: "shell.search",
      group: PALETTE_GROUPS.shell,
      label: "search across open tiles",
      accelerator: "Mod+F",
      run: () => actions.showSearch(),
    },
    {
      id: "shell.copy",
      group: PALETTE_GROUPS.shell,
      label: "copy to the system clipboard",
      accelerator: "Mod+C",
      disabled: !actions.canCopy(),
      run: () => actions.copyToClipboard(),
    },
    {
      id: "shell.yank",
      group: PALETTE_GROUPS.shell,
      label: "yank to the scratch panel",
      accelerator: "Mod+Shift+C",
      disabled: !actions.canCopy(),
      run: () => actions.yankToScratch(),
    },
    {
      id: "shell.copyRegion",
      group: PALETTE_GROUPS.shell,
      // No accelerator, and that is the decision rather than an omission: the
      // gesture *is* a drag, so a shortcut would only ever arm it. AGENTS.md's
      // rule about not spending a chip on a job another path already covers
      // applies to arming a mouse gesture too.
      label: "copy a region of this tile",
      detail: "drag a box over the tile",
      disabled: !actions.canCopyRegion(),
      run: () => actions.startRegionCapture(),
    },
    {
      id: "shell.scratch",
      group: PALETTE_GROUPS.shell,
      label: "show the scratch panel",
      run: () => actions.showScratch(),
    },
    {
      id: "shell.toggleSidebar",
      group: PALETTE_GROUPS.shell,
      label: "toggle sidebar",
      accelerator: "Mod+B",
      run: () => actions.toggleSidebar(),
    },
    {
      // Phase 07's one new verb, and the palette is the whole of its UI: it is
      // a rare, deliberate act of housekeeping, which is exactly what the
      // palette is for and exactly what the toolbar — under a standing
      // instruction to stay short — is not. No accelerator, for the same
      // reason: a chip in the reference modal is a cost, and nothing is worse
      // for being one keystroke further away.
      id: "shell.clearSession",
      group: PALETTE_GROUPS.shell,
      label: "clear saved session",
      detail: actions.sessionRecording()
        ? "forget the saved layout; no files are touched"
        : "already cleared — this session is not being saved",
      disabled: !actions.sessionRecording(),
      run: () => actions.clearSavedSession(),
    },
    {
      id: "shell.keybindReference",
      group: PALETTE_GROUPS.shell,
      label: "show keyboard shortcuts",
      accelerator: "Mod+/",
      run: () => actions.toggleKeybindReference(),
    },
  ];
}

/**
 * What the focused plugin says it can do — its bindings and its toolbar
 * controls, deduplicated.
 *
 * They overlap heavily by design: every plugin here derives both surfaces from
 * one verb list, so "invert" arrives twice. The keybind wins the tie because it
 * carries an accelerator worth showing and an `enabled()` worth respecting; a
 * control with no binding behind it is added afterwards on its label.
 */
function tileCommands(instance: ViewerInstance | undefined): readonly PaletteCommand[] {
  if (!instance) return [];

  const commands: PaletteCommand[] = [];
  const seen = new Set<string>();

  if (instance.capabilities.keybinds && instance.keybinds) {
    for (const keybind of instance.keybinds.getKeybinds()) {
      if (keybind.hidden) continue;
      seen.add(keybind.label.toLowerCase());
      commands.push({
        id: `tile.keybind.${keybind.id}`,
        group: PALETTE_GROUPS.tile,
        label: keybind.label,
        accelerator: keybind.keys[0],
        disabled: keybind.enabled ? !keybind.enabled() : false,
        run: () => keybind.run(),
      });
    }
  }

  if (instance.capabilities.toolbar && instance.toolbar) {
    for (const control of instance.toolbar.getControls()) {
      // A readout is a value, not an action, and a choice needs a menu the
      // palette does not have. Both belong in the toolbar, where they are.
      if (control.kind === "readout" || control.kind === "choice") continue;
      if (seen.has(control.label.toLowerCase())) continue;
      seen.add(control.label.toLowerCase());

      commands.push({
        id: `tile.control.${control.id}`,
        group: PALETTE_GROUPS.tile,
        label:
          control.kind === "toggle"
            ? `${control.label} (${control.value ? "on" : "off"})`
            : control.label,
        accelerator: control.accelerator,
        detail: control.title !== control.label ? control.title : undefined,
        disabled: control.disabled,
        run: () =>
          control.kind === "toggle" ? control.setValue(!control.value) : control.run(),
      });
    }
  }

  return commands;
}

/** Every layout and focus action, from the same list the keybinds use. */
function dockCommands(context: PaletteContext): readonly PaletteCommand[] {
  const api = context.dockApi;

  return DOCK_ACTIONS.filter((action) => !action.hidden).map((action) => ({
    id: `dock.${action.id}`,
    group: action.group === "focus" ? PALETTE_GROUPS.focus : PALETTE_GROUPS.layout,
    label: action.label,
    accelerator: action.keys[0],
    disabled: !isDockActionAvailable(action, api),
    run: () => {
      if (api) action.run({ api, panel: api.activePanel });
    },
  }));
}

/**
 * Filters and ranks.
 *
 * Substring first, then subsequence, so `nsa` still finds "next screen
 * arrangement" while an exact word keeps beating a scattered one. Deliberately
 * not a fuzzy-matching dependency: this is thirty lines against a list that is
 * never more than a few dozen entries long, and AGENTS.md asks for every new
 * dependency to be justified against the stack.
 */
export function filterPaletteCommands(
  commands: readonly PaletteCommand[],
  query: string,
): readonly PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;

  const scored: { command: PaletteCommand; score: number; index: number }[] = [];

  commands.forEach((command, index) => {
    const score = scoreCommand(command, needle);
    if (score > 0) scored.push({ command, score, index });
  });

  return scored
    // Higher score first; original order breaks ties, so the list does not
    // reshuffle itself while a query is being typed.
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

function scoreCommand(command: PaletteCommand, needle: string): number {
  const label = command.label.toLowerCase();

  // A dynamic entry is *about* the query; it must never filter itself out.
  if (command.id === "shell.searchFor" || command.group === PALETTE_GROUPS.go) return 100;

  if (label.startsWith(needle)) return 90;

  const wordStart = label.split(/\s+/).some((word) => word.startsWith(needle));
  if (wordStart) return 80;

  if (label.includes(needle)) return 70;
  if (command.group.toLowerCase().includes(needle)) return 40;
  if (isSubsequence(needle, label)) return 30;

  return 0;
}

/** Every character of `needle`, in order, somewhere in `haystack`. */
function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const character of haystack) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return at === needle.length;
}

/** The palette's sections, in the order they are rendered. */
export function groupPaletteCommands(
  commands: readonly PaletteCommand[],
): readonly { readonly group: string; readonly commands: readonly PaletteCommand[] }[] {
  const byGroup = new Map<string, PaletteCommand[]>();
  for (const command of commands) {
    const bucket = byGroup.get(command.group);
    if (bucket) bucket.push(command);
    else byGroup.set(command.group, [command]);
  }
  return [...byGroup.entries()].map(([group, entries]) => ({ group, commands: entries }));
}

/**
 * What "this tile" currently means, for the palette's header line.
 *
 * A palette full of entries that act on the focused tile has to say which tile
 * that is — the overlay covers the workspace, so it is not visible behind it.
 */
export function focusedTileLabel(
  clients: readonly WorkspaceClient[],
  activeClientId: string | null,
): string | null {
  const client = clients.find((candidate) => candidate.id === activeClientId);
  return client ? clientLabel(client) : null;
}
