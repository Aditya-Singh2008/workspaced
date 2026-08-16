/**
 * The command palette: type to filter, Enter or click to run.
 *
 * Both paths are first-class, which is the phase brief's requirement and not
 * the usual shape of this control — most palettes are keyboard-only, with the
 * mouse tolerated. Here the rows are real buttons, the trigger is a toolbar
 * control as well as a shortcut, and clicking one behaves identically to
 * selecting it with Enter because it is literally the same call.
 *
 * ## Closing returns focus where it came from
 *
 * An overlay that steals the keyboard and then drops it on the document body
 * leaves a tiling, keyboard-driven app with nothing focused — the next
 * `PageDown` goes nowhere. So the palette records the focused element *and* the
 * focused tile when it opens, and restores both on the way out, whether it was
 * closed by Escape, by clicking away, or by running something. A command that
 * moved the focus itself (jump to a tile, reveal a subdivision) wins: the
 * restore only re-activates the recorded tile if the command did not change
 * which one is active.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatAcceleratorSpec } from "../keybinds";
import { clearSavedSession, isSessionPersistenceSuspended } from "../../persistence";
import { useLayoutStore, useWorkspaceStore } from "../../store";
import { announceStatus } from "../statusbar";
import { workspaceDockApi } from "../docking/api";
import {
  canCopyFromFocusedTile,
  canCopyRegionFromFocusedTile,
  copyFocusedTileToSystemClipboard,
  startRegionCapture,
  yankFocusedTileToScratch,
} from "../clipboard";
import { showGlobalSearch } from "../search";
import { useOpenFiles } from "../openFiles";
import {
  buildPaletteCommands,
  filterPaletteCommands,
  focusedTileLabel,
  groupPaletteCommands,
  type PaletteCommand,
} from "./commands";

/**
 * "Clear saved session", and the sentence it puts in the status bar.
 *
 * Both halves of the phase brief's fourth task are in that sentence. *No files
 * were changed* is the confirmation the brief asks for — the action deletes an
 * app record and nothing else, and the one place a user could reasonably worry
 * otherwise is the moment they press it. *This session will not be saved* is
 * the part that is easy to leave unsaid and would then look like a bug: the
 * tiles stay open, so without it the next restart forgetting them reads as the
 * app losing work rather than as the thing that was asked for.
 */
async function forgetSession(): Promise<void> {
  try {
    await clearSavedSession();
    announceStatus(
      "saved session cleared — no files were changed; this session will not be saved",
    );
  } catch (thrown) {
    announceStatus(
      `could not clear the saved session — ${
        thrown instanceof Error ? thrown.message : String(thrown)
      }`,
      "error",
    );
  }
}

export function CommandPalette() {
  const open = useLayoutStore((state) => state.commandPaletteOpen);
  const setOpen = useLayoutStore((state) => state.setCommandPaletteOpen);
  const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
  const revealSidebarPanel = useLayoutStore((state) => state.revealSidebarPanel);
  const toggleKeybindReference = useLayoutStore((state) => state.toggleKeybindReference);

  const clients = useWorkspaceStore((state) => state.clients);
  const activeClientId = useWorkspaceStore((state) => state.activeClientId);
  const setActiveClient = useWorkspaceStore((state) => state.setActiveClient);

  const { open: openFile } = useOpenFiles();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Where focus was before the palette took it. */
  const returnTo = useRef<{ element: Element | null; clientId: string | null }>({
    element: null,
    clientId: null,
  });

  // Recorded on the transition into open, not on every render, so a re-render
  // caused by typing cannot overwrite it with the palette's own input.
  useEffect(() => {
    if (!open) return;
    returnTo.current = {
      element: document.activeElement,
      clientId: useWorkspaceStore.getState().activeClientId,
    };
    setQuery("");
    setSelected(0);
    inputRef.current?.focus();
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);

    const { element, clientId } = returnTo.current;
    // Only if nothing that just ran moved the focus somewhere else.
    if (clientId && useWorkspaceStore.getState().activeClientId === clientId) {
      setActiveClient(clientId);
      workspaceDockApi()?.getPanel(clientId)?.api.setActive();
    }
    if (element instanceof HTMLElement && element.isConnected) element.focus();
  }, [setOpen, setActiveClient]);

  // Escape closes, and wins over anything a focused plugin has bound to it —
  // the same reasoning as the region-capture overlay: the most recently opened
  // thing is what Escape should close.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, close]);

  const commands = useMemo(() => {
    if (!open) return [];
    return buildPaletteCommands({
      query,
      dockApi: workspaceDockApi(),
      clients,
      activeClientId,
      actions: {
        openFile: () => void openFile(),
        showSearch: (text) => showGlobalSearch(text),
        showScratch: () => revealSidebarPanel("scratch"),
        toggleSidebar,
        toggleKeybindReference,
        copyToClipboard: () => void copyFocusedTileToSystemClipboard(),
        yankToScratch: () => void yankFocusedTileToScratch(),
        startRegionCapture,
        canCopy: canCopyFromFocusedTile,
        canCopyRegion: canCopyRegionFromFocusedTile,
        clearSavedSession: () => void forgetSession(),
        sessionRecording: () => !isSessionPersistenceSuspended(),
      },
    });
    // `open` is in the list because the contributed half of this is read from
    // live plugin objects: re-opening the palette must re-ask the focused tile
    // rather than show what it said last time.
  }, [
    open,
    query,
    clients,
    activeClientId,
    openFile,
    revealSidebarPanel,
    toggleSidebar,
    toggleKeybindReference,
  ]);

  const matches = useMemo(
    () => filterPaletteCommands(commands, query),
    [commands, query],
  );
  const runnable = matches.filter((command) => !command.disabled);
  const active = runnable[Math.min(selected, Math.max(0, runnable.length - 1))];

  // Keeps the highlighted row on screen when the arrows walk past the edge.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, query]);

  if (!open) return null;

  const run = (command: PaletteCommand) => {
    if (command.disabled) return;
    // Closed *before* running, so a command that opens something else (the
    // shortcuts modal, a file dialog) is not competing with this overlay for
    // the keyboard — and so the focus restore happens before the command moves
    // it deliberately.
    close();
    command.run();
  };

  const tile = focusedTileLabel(clients, activeClientId);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 pt-24"
      onMouseDown={(event) => {
        // Only a click on the backdrop itself; a drag that ends out here having
        // started on the input is not "clicking outside".
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="flex max-h-[60%] w-full max-w-2xl flex-col border border-border-strong bg-surface">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
          <span className="shrink-0 text-disabled">›</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="run a command, or type a number to jump"
            aria-label="command"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => Math.min(index + 1, Math.max(0, runnable.length - 1)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (active) run(active);
              }
            }}
            className="min-w-0 grow bg-transparent text-fg placeholder:text-disabled focus:outline-none"
          />
          {tile ? (
            <span className="shrink-0 truncate text-disabled" title={tile}>
              {tile}
            </span>
          ) : null}
        </div>

        <div ref={listRef} className="min-h-0 grow overflow-y-auto">
          {matches.length === 0 ? (
            <p className="px-2 py-1 text-muted">nothing matches</p>
          ) : (
            groupPaletteCommands(matches).map((section) => (
              <section key={section.group}>
                <header className="border-b border-border px-2 py-0.5 text-disabled">
                  {section.group}
                </header>
                {section.commands.map((command) => (
                  <Row
                    key={command.id}
                    command={command}
                    selected={command === active}
                    onRun={() => run(command)}
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  command,
  selected,
  onRun,
}: {
  readonly command: PaletteCommand;
  readonly selected: boolean;
  readonly onRun: () => void;
}) {
  return (
    <button
      type="button"
      data-selected={selected}
      disabled={command.disabled}
      // `onMouseDown` rather than `onClick`: the input holds focus, and a click
      // would blur it first, which on some engines re-orders the events enough
      // that the row under the pointer has already moved.
      onMouseDown={(event) => {
        event.preventDefault();
        onRun();
      }}
      className={
        selected
          ? "flex w-full items-baseline gap-2 border-l border-l-accent bg-surface-raised px-2 py-0.5 text-left text-fg"
          : "flex w-full items-baseline gap-2 border-l border-l-transparent px-2 py-0.5 text-left text-muted hover:bg-surface-hover disabled:text-disabled disabled:hover:bg-transparent"
      }
    >
      <span className="min-w-0 grow truncate">{command.label}</span>
      {command.detail ? (
        <span className="shrink-0 truncate text-disabled">{command.detail}</span>
      ) : null}
      {command.accelerator ? (
        <span className="shrink-0 border border-border px-1 text-disabled">
          {formatAcceleratorSpec(command.accelerator)}
        </span>
      ) : null}
    </button>
  );
}
