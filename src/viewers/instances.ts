/**
 * Live viewer instances, and the shell-side mounting that produces them.
 *
 * Instances hold canvases, decoders and workers: they are not serializable and
 * mutating them must not re-render React. So they live in this plain map keyed
 * by workspace-client id, and the Zustand store holds only the id. (Same reason
 * `FileHandle` objects live in `src/files/store.ts`.)
 *
 * This module is also where the contract's two hard guarantees are enforced, so
 * no individual plugin has to be trusted for them:
 *
 *   - `dispose()` is called **exactly once** per instance.
 *   - A plugin that throws *anything* produces a `ViewerError` rendered inside
 *     its own tile, never a shell-level crash.
 */

import type { FileHandle } from "../files";
import {
  toViewerError,
  type ViewerError,
  type ViewerHost,
  type ViewerInstance,
  type ViewerPlugin,
} from "./contract";
import { getViewerPlugin, resolveViewerPluginForFile } from "./registry";

const instances = new Map<string, ViewerInstance>();
const disposed = new WeakSet<ViewerInstance>();

/**
 * Change notification for this map.
 *
 * The map is deliberately outside the reactive store — mutating an instance
 * must not re-render React (see the module comment). But *whether an instance
 * exists yet* is render-relevant to anything drawing from it: a tile mounts
 * asynchronously, so a component that reads `getViewerInstance` during the
 * render triggered by `openFile` finds nothing and would never look again. The
 * sidebar's subdivision rail is the first such component.
 *
 * So the membership of the map is observable while the instances themselves
 * stay out of the store. Same shape as the keybind registry: a version counter
 * plus a subscription, consumed through `useSyncExternalStore`.
 */
const instanceListeners = new Set<() => void>();
let instancesVersion = 0;

function notifyInstances(): void {
  instancesVersion += 1;
  for (const listener of instanceListeners) {
    try {
      listener();
    } catch (thrown) {
      console.error("[viewers] instance listener threw", thrown);
    }
  }
}

/** Subscribes to mounts and disposals. Returns the unsubscribe function. */
export function subscribeToViewerInstances(listener: () => void): () => void {
  instanceListeners.add(listener);
  return () => instanceListeners.delete(listener);
}

/** Snapshot for `useSyncExternalStore`. */
export function viewerInstancesVersion(): number {
  return instancesVersion;
}

/**
 * Mirrors mounts and disposals to the terminal, with the live instance count.
 * **Dev builds only** — stripped from production along with this branch.
 *
 * "No plugin instance leaks" is a standing requirement that cannot be checked
 * by looking at the window: a tile that closes without disposing looks exactly
 * like one that closed correctly. Printing the count on every mount and
 * dispose makes a leak visible while tiles are being opened, dragged and
 * closed by hand, which is the only way phases 03+ will catch a viewer that
 * holds on to a decoder or a canvas.
 */
function traceInstances(event: string, detail: string): void {
  if (!import.meta.env.DEV) return;
  void import("../dev/log").then(({ devLog }) =>
    devLog(`viewers: ${event} ${detail} (live=${instances.size})`),
  );
}

export type MountViewerResult =
  | { readonly ok: true; readonly instance: ViewerInstance; readonly plugin: ViewerPlugin }
  | { readonly ok: false; readonly error: ViewerError; readonly plugin: ViewerPlugin | null };

export interface MountViewerArgs {
  /** Workspace-client id; the key this instance is filed under. */
  readonly clientId: string;
  readonly container: HTMLElement;
  readonly file: FileHandle;
  /**
   * Force a specific plugin — used when restoring a session that recorded which
   * plugin was in use. Falls back to normal resolution if the id is unknown.
   */
  readonly pluginId?: string;
  readonly initialState?: unknown;
  readonly host?: ViewerHost;
  readonly signal?: AbortSignal;
}

/**
 * Resolves a plugin for the file, mounts it, and files the instance under
 * `clientId`.
 *
 * Never throws. A load failure comes back as `{ ok: false, error }` for the
 * tile to render.
 */
export async function mountViewer(args: MountViewerArgs): Promise<MountViewerResult> {
  // A recorded plugin id wins, so a restored session reopens the file in the
  // viewer it was last using. An id that no longer exists falls back to normal
  // resolution rather than failing the tile.
  const plugin =
    (args.pluginId ? getViewerPlugin(args.pluginId) : undefined) ??
    resolveViewerPluginForFile(args.file)?.plugin ??
    null;

  if (!plugin) {
    return {
      ok: false,
      plugin: null,
      error: {
        code: "unsupported",
        message: "No viewer is available for this file.",
        detail:
          "No plugin matched and no fallback viewer is registered. This is a startup bug.",
      },
    };
  }

  // A previous instance under this id would otherwise leak.
  await disposeViewer(args.clientId);

  try {
    const instance = await plugin.mount(args.container, args.file, {
      initialState: args.initialState,
      host: args.host,
      signal: args.signal,
    });

    if (args.signal?.aborted) {
      // The tile closed while we were loading. Tear down rather than file it.
      await disposeInstance(instance);
      return {
        ok: false,
        plugin,
        error: { code: "internal", message: "Loading was cancelled.", recoverable: true },
      };
    }

    instances.set(args.clientId, instance);
    notifyInstances();
    traceInstances("mounted", `${plugin.id} as ${args.clientId}`);
    return { ok: true, instance, plugin };
  } catch (thrown) {
    const error = toViewerError(thrown);
    console.error(`[viewers] "${plugin.id}" failed to mount ${args.file.name}`, thrown);
    // The plugin may have appended DOM before failing.
    args.container.replaceChildren();
    return { ok: false, plugin, error };
  }
}

export function getViewerInstance(clientId: string): ViewerInstance | undefined {
  return instances.get(clientId);
}

export function listViewerInstances(): ReadonlyMap<string, ViewerInstance> {
  return instances;
}

/** Disposes the instance filed under `clientId`, if any. Safe to call twice. */
export async function disposeViewer(clientId: string): Promise<void> {
  const instance = instances.get(clientId);
  if (!instance) return;
  instances.delete(clientId);
  notifyInstances();
  await disposeInstance(instance);
  traceInstances("disposed", `${instance.pluginId} as ${clientId}`);
}

export async function disposeAllViewers(): Promise<void> {
  const all = [...instances.values()];
  instances.clear();
  notifyInstances();
  await Promise.all(all.map(disposeInstance));
}

/**
 * The exactly-once guarantee. A plugin throwing from `dispose()` is logged and
 * swallowed: a tile that fails to clean up must still close.
 */
async function disposeInstance(instance: ViewerInstance): Promise<void> {
  if (disposed.has(instance)) return;
  disposed.add(instance);
  try {
    await instance.dispose();
  } catch (thrown) {
    console.error(`[viewers] "${instance.pluginId}" threw from dispose()`, thrown);
  }
}

/** Whether `dispose()` has already run for this instance. Used by the self-test. */
export function isViewerDisposed(instance: ViewerInstance): boolean {
  return disposed.has(instance);
}
