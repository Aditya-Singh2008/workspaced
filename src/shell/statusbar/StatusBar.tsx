/**
 * The bottom bar.
 *
 * Three jobs, and none of them is file-type aware:
 *
 *   - say what is focused, since a tiled workspace can show several files at
 *     once and the tab label alone does not carry the path;
 *   - hold the shortcuts trigger, which is the app's discovery path for every
 *     keyboard action (the reference modal lists the whole registry, so an
 *     action added by a later phase becomes discoverable without touching this
 *     component);
 *   - carry the shell's transient announcements, added in phase 06 for the
 *     clipboard. The brief asks for "a brief status-bar message […] not a modal
 *     or animated toast", which is also the only feedback shape that fits an
 *     app with no shadows and no animation. It replaces the path while it is
 *     showing rather than sitting beside it: the path is the thing you can
 *     always get back by looking again, and two lines competing for the same
 *     corner is how a status bar becomes unreadable.
 *
 * The trigger lives here rather than in the toolbar so the toolbar stays down
 * to the controls that act on the workspace. A status bar is where a
 * keyboard-first app conventionally puts "how do I drive this".
 */

import { formatAcceleratorSpec, SHELL_KEYBIND_GROUP, useKeybinds } from "../keybinds";
import { DOCK_ACTIONS } from "../docking/actions";
import { workspaceDockApi } from "../docking/api";
import {
  arrangementIndex,
  arrangementsFor,
  layoutModeInfo,
} from "../docking/tiling";
import { useLayoutStore, useWorkspaceStore } from "../../store";
import { useStatusMessageStore } from "./messages";

const REFERENCE_KEYS = ["Mod+/", "F1"];
const ROTATE_KEY = "Mod+Enter";

/**
 * The layout indicator, in dwm's notation.
 *
 * A tiling layout is driven almost entirely from the keyboard, which means the
 * user has to be able to see what state they put it in — which shape is
 * active, how many tiles the master area holds, whether monocle is hiding the
 * rest. dwm puts exactly this in the corner of its bar and it is the reason
 * its layouts are learnable at all. Clicking it steps the rotation, so the
 * feature is reachable without knowing the shortcut, and the shortcut is in
 * the tooltip so it stops being needed.
 *
 * The `3/8` is what makes a rotation of that length usable: without it a
 * long press-and-see cycle is disorienting, because there is no way to tell
 * how far round you are or how far there is left to go.
 *
 * Monocle wins the display when it is on, because it is what is on screen; the
 * underlying arrangement is still there when it is switched off.
 */
function LayoutIndicator() {
  const tiling = useLayoutStore((state) => state.tiling);
  const tileCount = useLayoutStore((state) => state.tileCount);
  const monocle = useLayoutStore((state) => state.monocle);

  const info = layoutModeInfo(tiling.mode);
  const symbol = monocle ? "[M]" : info.symbol;
  const label = monocle ? "monocle" : info.label;

  const arrangements = arrangementsFor(tileCount);
  const index = arrangementIndex(tiling, tileCount);
  // Hidden under monocle (the rotation is not what is on screen) and when
  // there is only one arrangement to be in.
  const position =
    !monocle && index >= 0 && arrangements.length > 1
      ? `${index + 1}/${arrangements.length}`
      : null;

  return (
    <button
      type="button"
      onClick={() => {
        // The action itself, not a re-implementation of it: the button and the
        // keybind then cannot drift, and the click picks up the dragged-width
        // sync the action does on the way through.
        const api = workspaceDockApi();
        const action = DOCK_ACTIONS.find((entry) => entry.id === "layout.nextArrangement");
        if (api && action) action.run({ api, panel: api.activePanel });
      }}
      title={`${label} — ${monocle ? "one tile fills the workspace" : info.description}\nnext arrangement: ${formatAcceleratorSpec(ROTATE_KEY)}`}
      className="shrink-0 border border-border px-2 text-muted hover:bg-surface-hover hover:text-fg"
    >
      <span className={monocle ? "text-fg" : undefined}>{symbol}</span>
      {position ? <span className="ml-1">{position}</span> : null}
    </button>
  );
}

export function StatusBar() {
  const clients = useWorkspaceStore((state) => state.clients);
  const activeClientId = useWorkspaceStore((state) => state.activeClientId);
  const keybindReferenceOpen = useLayoutStore((state) => state.keybindReferenceOpen);
  const toggleKeybindReference = useLayoutStore((state) => state.toggleKeybindReference);

  useKeybinds([
    {
      id: "shell.keybindReference",
      group: SHELL_KEYBIND_GROUP,
      label: "show keyboard shortcuts",
      keys: REFERENCE_KEYS,
      order: 30,
      run: toggleKeybindReference,
    },
  ]);

  const message = useStatusMessageStore((state) => state.message);

  const active = clients.find((client) => client.id === activeClientId);
  // The path, normally — it is the most informative thing about the focused
  // tile and there is room for it here. But a viewer that has navigated within
  // its tile (`ViewerHost.setDisplayName`) is no longer showing that path, and
  // a stale path is worse than a bare name.
  const location = active
    ? (active.displayName ?? active.path ?? active.name)
    : "no files open";

  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-border bg-surface px-2 py-0.5">
      {message ? (
        <span
          className={
            message.tone === "error"
              ? "min-w-0 truncate text-error"
              : message.tone === "warn"
                ? "min-w-0 truncate text-warn"
                : "min-w-0 truncate text-fg-dim"
          }
          // Announced to assistive technology too: the whole point is that
          // something happened that leaves no other trace on screen.
          role="status"
          title={message.text}
        >
          {message.text}
        </span>
      ) : (
        <span className="min-w-0 truncate text-muted" title={location}>
          {location}
        </span>
      )}

      <span className="grow" />

      {clients.length > 0 ? (
        <span className="shrink-0 text-muted">
          {clients.length} {clients.length === 1 ? "tile" : "tiles"}
        </span>
      ) : null}

      {clients.length > 0 ? <LayoutIndicator /> : null}

      <button
        type="button"
        onClick={toggleKeybindReference}
        aria-pressed={keybindReferenceOpen}
        title="show keyboard shortcuts"
        className={
          keybindReferenceOpen
            ? "shrink-0 border border-border-accent px-2 text-fg"
            : "shrink-0 border border-border px-2 text-muted hover:bg-surface-hover hover:text-fg"
        }
      >
        {/*
          The accelerator is part of the label, not a tooltip: the button's
          whole purpose is teaching the keyboard, so hiding its own shortcut
          behind a hover would be the wrong trade.
        */}
        shortcuts {formatAcceleratorSpec(REFERENCE_KEYS[0]!)}
      </button>
    </footer>
  );
}
