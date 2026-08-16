/**
 * Workspace state: which files are open, and which one is focused.
 *
 * Holds only serializable, render-relevant data. The `FileHandle` and the
 * mounted `ViewerInstance` for a client live in their own non-reactive maps
 * (`src/files/store.ts`, `src/viewers/instances.ts`) and are looked up by id —
 * decode state must not sit in a reactive store or trigger re-renders
 * (AGENTS.md, state management).
 */

import { create } from "zustand";

import { releaseFileHandle, retainFileHandle, type FileHandle } from "../files";
import { disposeViewer, resolveViewerPluginForFile, type ViewerError } from "../viewers";

/**
 * A failure that belongs to the *client* rather than to a mounted viewer.
 *
 * There is exactly one source of these: phase 07's session restore, where a
 * recorded file has moved, been deleted, or cannot be read any more. The tile
 * exists — the layout is restored before any file is reopened, precisely so a
 * missing file cannot take the arrangement with it — but there is nothing to
 * mount into it, so no plugin is ever asked and no `ViewerInstance` exists to
 * report through. `ViewerSurface` renders it with the same panel it renders a
 * plugin's own `ViewerError` with, which is the contract's error convention
 * applied to the one case that happens before a plugin is involved.
 *
 * `ViewerError` minus its `cause`, because this one is held in a store whose
 * contents have to stay serializable.
 */
export type ClientProblem = Omit<ViewerError, "cause">;

/** One open file in the workspace. Serializable in full. */
export interface WorkspaceClient {
  /** Stable id; the key for this client's viewer instance. */
  readonly id: string;
  /**
   * Key into the file handle registry.
   *
   * Empty while a restored client is waiting for its file to be reopened: the
   * tile is on screen and in the layout, and the bytes behind it are not here
   * yet. Every consumer treats that as "not ready", never as "broken".
   */
  readonly fileHandleId: string;
  /** Which plugin resolution picked. Recorded so a restore uses the same one. */
  readonly pluginId: string;
  readonly name: string;
  readonly size: number;
  readonly extension?: string;
  readonly mimeType?: string;
  readonly path?: string;
  /**
   * What the viewer says it is currently showing, when that is not `name`.
   *
   * Set through `ViewerHost.setDisplayName` and used wherever a tile is
   * labelled. Kept separate from `name` rather than overwriting it, because
   * `name` is the identity of the file this client stands for — the thing the
   * handle, the plugin resolution and a restored session are all keyed on — and
   * this is only what is on screen right now.
   */
  readonly displayName?: string;

  /** Why this client has no file. See {@link ClientProblem}. */
  readonly problem?: ClientProblem;
}

/** What a restored client is built from, before its file is reopened. */
export interface RestoredClient {
  readonly id: string;
  readonly pluginId: string;
  readonly name: string;
  readonly size: number;
  readonly extension?: string;
  readonly mimeType?: string;
  readonly path?: string;
}

/** Whether this client is still waiting for its file. */
export function isClientPending(client: WorkspaceClient): boolean {
  return client.fileHandleId === "" && !client.problem;
}

/** What a tile is labelled with: what it shows, else the file it was opened as. */
export function clientLabel(client: WorkspaceClient): string {
  return client.displayName ?? client.name;
}

interface WorkspaceState {
  readonly clients: readonly WorkspaceClient[];
  readonly activeClientId: string | null;

  /**
   * Registers an opened file and creates a client for it. Returns `null` only
   * when no plugin resolved at all, which means the fallback viewer was never
   * installed — a startup bug, not a per-file condition.
   */
  openFile(handle: FileHandle): WorkspaceClient | null;

  /**
   * Recreates a saved session's clients, file-less, in their recorded order.
   *
   * Separate from {@link openFile} because it runs in the other direction: the
   * ids come *from* the record rather than being minted, so the restored layout
   * — whose panel ids are those same client ids — can be handed to dockview
   * verbatim instead of being rewritten. The counter is advanced past whatever
   * the record used, so a file opened afterwards cannot collide with one.
   *
   * The clients exist before any file is reopened. That ordering is the phase
   * brief's requirement ("restore the layout structure before attempting to
   * reopen files"), and it is what makes a moved file cost one tile rather than
   * the arrangement.
   */
  restoreClients(restored: readonly RestoredClient[]): void;

  /**
   * Gives a pending client its file, or replaces the file of one the user has
   * relocated by hand.
   *
   * Re-resolves the plugin from the handle: "locate…" can legitimately be
   * answered with a different kind of file, and the recorded plugin id is a
   * memory of what was open, not a promise about what will be. On an ordinary
   * restore the two agree — resolution is a pure function of the MIME type and
   * the extension, both of which the record carries — except when a file that
   * had no viewer last time has one now, where the new answer is the better one.
   */
  attachClientFile(id: string, handle: FileHandle): void;

  /** Records why a client has no file, or clears it before a retry. */
  setClientProblem(id: string, problem: ClientProblem | null): void;

  closeClient(id: string): void;
  setActiveClient(id: string | null): void;
  /** Backs `ViewerHost.setDisplayName`. `null` reverts to the file's own name. */
  setClientDisplayName(id: string, displayName: string | null): void;
  closeAll(): void;
}

let clientCounter = 0;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  clients: [],
  activeClientId: null,

  openFile(handle) {
    const resolution = resolveViewerPluginForFile(handle);
    if (!resolution) return null;

    retainFileHandle(handle);
    clientCounter += 1;

    const client: WorkspaceClient = {
      id: `client:${clientCounter}`,
      fileHandleId: handle.id,
      pluginId: resolution.plugin.id,
      name: handle.name,
      size: handle.size,
      extension: handle.extension,
      mimeType: handle.mimeType,
      path: handle.path,
    };

    set((state) => ({
      clients: [...state.clients, client],
      activeClientId: client.id,
    }));
    return client;
  },

  restoreClients(restored) {
    for (const entry of restored) {
      const counter = Number.parseInt(entry.id.replace(/^client:/, ""), 10);
      if (Number.isFinite(counter)) clientCounter = Math.max(clientCounter, counter);
    }

    set({
      clients: restored.map((entry) => ({ ...entry, fileHandleId: "" })),
      activeClientId: restored[0]?.id ?? null,
    });
  },

  attachClientFile(id, handle) {
    const previous = get().clients.find((candidate) => candidate.id === id);
    if (!previous) return;

    retainFileHandle(handle);

    set((state) => ({
      clients: state.clients.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              fileHandleId: handle.id,
              pluginId: resolveViewerPluginForFile(handle)?.plugin.id ?? candidate.pluginId,
              name: handle.name,
              size: handle.size,
              extension: handle.extension,
              mimeType: handle.mimeType,
              path: handle.path,
              displayName: undefined,
              problem: undefined,
            }
          : candidate,
      ),
    }));

    // A relocate replaces a file that was already attached; the old handle has
    // no client left holding it.
    if (previous.fileHandleId) releaseFileHandle(previous.fileHandleId);
  },

  setClientProblem(id, problem) {
    set((state) => ({
      clients: state.clients.map((candidate) =>
        candidate.id === id
          ? { ...candidate, problem: problem ?? undefined }
          : candidate,
      ),
    }));
  },

  closeClient(id) {
    const client = get().clients.find((candidate) => candidate.id === id);
    if (!client) return;

    set((state) => {
      const clients = state.clients.filter((candidate) => candidate.id !== id);
      const activeClientId =
        state.activeClientId === id
          ? (clients.at(-1)?.id ?? null)
          : state.activeClientId;
      return { clients, activeClientId };
    });

    // Teardown is not render-relevant, so it happens outside the state update.
    // A client whose file never arrived has nothing to release.
    void disposeViewer(id).finally(() => {
      if (client.fileHandleId) releaseFileHandle(client.fileHandleId);
    });
  },

  setActiveClient(id) {
    set({ activeClientId: id });
  },

  setClientDisplayName(id, displayName) {
    set((state) => {
      const client = state.clients.find((candidate) => candidate.id === id);
      // Called on every folder step, and a no-op write would re-render every
      // consumer of the client list for nothing.
      if (!client || client.displayName === (displayName ?? undefined)) return state;
      return {
        clients: state.clients.map((candidate) =>
          candidate.id === id
            ? { ...candidate, displayName: displayName ?? undefined }
            : candidate,
        ),
      };
    });
  },

  closeAll() {
    const { clients } = get();
    set({ clients: [], activeClientId: null });
    for (const client of clients) {
      void disposeViewer(client.id).finally(() => {
        if (client.fileHandleId) releaseFileHandle(client.fileHandleId);
      });
    }
  },
}));
