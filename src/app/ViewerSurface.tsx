/**
 * The React side of a viewer tile: owns a container element, mounts a plugin
 * into it, and renders that plugin's failures *inside itself*.
 *
 * Phase 02 moved it under the docking library — a tile is a dockview panel
 * rendering a `ViewerSurface` (see `shell/docking/ViewerPanel.tsx`). It still
 * knows nothing about layout and nothing about what kind of file it is
 * showing; what it gained is the two pieces of shell plumbing that only the
 * component holding the instance can do:
 *
 *   - telling the plugin whether its tile is the focused one, and when its box
 *     changed;
 *   - publishing the plugin's contributed toolbar controls and keybinds, so
 *     both describe the focused tile and both disappear with it.
 *
 * Phase 07 added the third thing only this component can do: a tile can now
 * exist *before* its file does. A restored session puts every tile on screen
 * first and reopens the files afterwards, so this renders three states rather
 * than two — waiting for a file, a file that could not be reopened, and a
 * mounted viewer — and the middle one is the shell's own error, not a plugin's,
 * because no plugin was ever reached.
 */

import { useEffect, useRef, useState } from "react";

import { getFileHandle } from "../files";
import {
  clearRestoredState,
  relocateTileFile,
  reopenTileFile,
  requestSessionSave,
  restoredViewerState,
} from "../persistence";
import { RegionCapture, useClipboardStore } from "../shell/clipboard";
import { registerViewerKeybinds } from "../shell/keybinds";
import {
  mountViewer,
  disposeViewer,
  type ViewerError,
  type ViewerHost,
  type ViewerInstance,
} from "../viewers";
import {
  useToolbarStore,
  useWorkspaceStore,
  type ClientProblem,
  type WorkspaceClient,
} from "../store";

interface ViewerSurfaceProps {
  readonly client: WorkspaceClient;
  /** Whether this tile currently holds workspace focus. */
  readonly focused?: boolean;
}

export function ViewerSurface({ client, focused = false }: ViewerSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ViewerInstance | null>(null);
  const [error, setError] = useState<ViewerError | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Phase 06's rubber band. It renders *inside* the tile so it inherits the
  // tile's box exactly — the box the shell then normalizes against and hands to
  // `ViewerCopyApi.locateRegion`.
  const capturingRegion = useClipboardStore(
    (state) => state.regionCaptureClientId === client.id,
  );

  const setContributions = useToolbarStore((state) => state.setContributions);
  const clearContributions = useToolbarStore((state) => state.clearContributions);
  const setClientDisplayName = useWorkspaceStore((state) => state.setClientDisplayName);

  useEffect(() => {
    const container = containerRef.current;
    // No file yet: a restored tile whose reopen has not landed, or one whose
    // file could not be found. Both are rendered below; neither is a mount.
    if (!container || !client.fileHandleId) return;

    const abort = new AbortController();
    let live = true;
    let unsubscribeControls: (() => void) | undefined;

    const host: ViewerHost = {
      reportError: (reported) => {
        if (live) setError(reported);
      },
      clearError: () => {
        if (live) setError(null);
      },
      // The contract's promise that this is free to call on every scroll and
      // every zoom, kept: it sets a flag, and the record is written once the
      // debounce elapses (`persistence/session.ts`).
      requestPersist: () => requestSessionSave(),
      invalidate: (aspects) => {
        // Only one aspect is this layer's business. A stale thumbnail or a
        // re-extracted text layer changes nothing that is written down.
        if (!aspects || aspects.includes("state")) requestSessionSave();
      },
      // Goes to the store rather than to dockview directly: the tab is one of
      // three places a tile is labelled, and the sidebar and the status bar
      // must not be able to disagree with it.
      setDisplayName: (name) => {
        if (live) setClientDisplayName(client.id, name);
      },
    };

    setLoading(true);
    setError(null);

    void (async () => {
      const file = getFileHandle(client.fileHandleId);
      if (!file) return;

      const result = await mountViewer({
        clientId: client.id,
        container,
        file,
        pluginId: client.pluginId,
        // What this tile was doing when the session was saved. The contract
        // routes a *fresh* mount's state here rather than through `restore()`,
        // which is for applying state to an instance that is already live — so
        // a restored zoom is in effect on the first frame the plugin paints,
        // not applied as a visible correction afterwards.
        initialState: restoredViewerState(client.id),
        host,
        signal: abort.signal,
      });

      if (!live) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      // From here the live instance is the authority on this tile's state, and
      // the record is written from `serialize()` instead. Kept until now so a
      // mount that failed and was retried gets the same state twice.
      clearRestoredState(client.id);

      const instance = result.instance;
      instanceRef.current = instance;

      // Capabilities are read only after mount resolves, per the contract.
      const toolbar = instance.capabilities.toolbar ? instance.toolbar : undefined;
      if (toolbar) {
        const publish = () => setContributions(client.id, toolbar.getControls());
        publish();
        unsubscribeControls = toolbar.onControlsChange(publish);
      } else {
        // Explicitly empty rather than absent, so focusing a tile that
        // contributes nothing clears the previous tile's controls.
        setContributions(client.id, []);
      }
    })();

    return () => {
      live = false;
      abort.abort();
      unsubscribeControls?.();
      instanceRef.current = null;
      clearContributions(client.id);
      // A remount must not inherit the last instance's label — the new one has
      // not said what it is showing yet, and the file's own name is the only
      // thing that is true until it does.
      setClientDisplayName(client.id, null);
      void disposeViewer(client.id);
    };
  }, [
    client.id,
    client.fileHandleId,
    client.pluginId,
    attempt,
    setContributions,
    clearContributions,
    setClientDisplayName,
  ]);

  // Focus is a shell concept the plugin may want to react to (pausing a video,
  // dropping a text cursor). Plugins that do not care simply omit `setActive`.
  useEffect(() => {
    instanceRef.current?.setActive?.(focused);
  }, [focused, loading]);

  // Contributed keybinds are registered only while this tile is focused. That
  // scoping is the whole reason a plugin can claim a plain `PageDown` without
  // negotiating with every other plugin — see `shell/keybinds/contributions.ts`.
  useEffect(() => {
    if (!focused) return;
    const instance = instanceRef.current;
    if (!instance?.capabilities.keybinds || !instance.keybinds) return;
    return registerViewerKeybinds(instance.pluginId, instance.keybinds);
  }, [focused, loading]);

  // The tile's box changes when a divider is dragged, a sibling closes, or the
  // window resizes. Observing the container covers all three without this
  // component knowing which happened.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => instanceRef.current?.resize?.());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const waitingForFile = !client.fileHandleId && !client.problem;

  return (
    <div className="relative h-full w-full min-h-0 min-w-0 bg-bg">
      {/*
        The plugin owns everything inside this element. It stays mounted even
        while an error is displayed, so a recoverable failure can be retried
        without tearing down the tile.
      */}
      <div ref={containerRef} className="h-full w-full" />

      {(waitingForFile || (loading && client.fileHandleId)) && !error ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted">
          {waitingForFile ? "reopening…" : "loading…"}
        </div>
      ) : null}

      {/*
        The file's failure outranks the viewer's: with no file there is no
        viewer, and a stale plugin error from a previous attempt would be the
        wrong thing to read.
      */}
      {client.problem ? (
        <MissingFilePanel client={client} problem={client.problem} />
      ) : error ? (
        <ViewerErrorPanel error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}

      {capturingRegion ? <RegionCapture clientId={client.id} /> : null}
    </div>
  );
}

/**
 * A file that could not be reopened, and the two ways out.
 *
 * Deliberately the same panel as a plugin's own failure — same code chip, same
 * one-line message, same technical detail underneath — because from where the
 * user is sitting it is the same event: this tile cannot show its document.
 * What differs is the offer. A plugin error can only be retried; a file that is
 * not where it was can also be *found*, and on a platform that wants access to
 * a path re-confirmed, being found is the only thing that will work.
 */
function MissingFilePanel({
  client,
  problem,
}: {
  readonly client: WorkspaceClient;
  readonly problem: ClientProblem;
}) {
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg p-8 text-center">
      <span className="border border-error px-2 py-1 text-error">{problem.code}</span>
      <p className="max-w-prose text-fg">{problem.message}</p>
      {problem.detail ? (
        <p className="max-w-prose text-muted break-words">{problem.detail}</p>
      ) : null}
      <div className="flex items-center gap-3">
        {problem.recoverable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => reopenTileFile(client.id))}
            className="border border-border px-3 py-1 text-fg-dim hover:bg-surface-hover hover:text-fg disabled:text-disabled"
          >
            retry
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => relocateTileFile(client.id))}
          className="border border-border px-3 py-1 text-fg-dim hover:bg-surface-hover hover:text-fg disabled:text-disabled"
        >
          locate…
        </button>
      </div>
    </div>
  );
}

/**
 * A plugin failure, rendered inside the tile that produced it. A viewer can
 * never surface as a shell-level crash or a global error.
 */
function ViewerErrorPanel({
  error,
  onRetry,
}: {
  readonly error: ViewerError;
  readonly onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg p-8 text-center">
      <span className="border border-error px-2 py-1 text-error">{error.code}</span>
      <p className="max-w-prose text-fg">{error.message}</p>
      {error.detail ? (
        <p className="max-w-prose text-muted break-words">{error.detail}</p>
      ) : null}
      {error.recoverable ? (
        <button
          type="button"
          onClick={onRetry}
          className="border border-border px-3 py-1 text-fg-dim hover:bg-surface-hover hover:text-fg"
        >
          retry
        </button>
      ) : null}
    </div>
  );
}
