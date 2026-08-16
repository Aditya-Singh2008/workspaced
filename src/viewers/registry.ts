/**
 * File-type registry: which plugin opens which file.
 *
 * Plugins register themselves here at startup; the shell asks
 * {@link resolveViewerPlugin} for a plugin and always gets one, because an
 * unmatched file falls through to the fallback viewer rather than failing.
 */

import type { FileHandle } from "../files";
import type { ViewerPlugin } from "./contract";

/**
 * MIME types that carry no information. A file described with one of these is
 * treated as having no MIME type at all, so resolution falls through to the
 * extension — which is the whole reason extensions are part of the descriptor.
 */
const UNINFORMATIVE_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  "unknown/unknown",
  "*/*",
  "",
]);

/** Registration order, used to break equal priorities deterministically. */
const registrationOrder = new Map<string, number>();
const plugins = new Map<string, ViewerPlugin>();
let nextOrder = 0;

let fallbackPlugin: ViewerPlugin | null = null;

/** How a file was matched to a plugin. Surfaced for diagnostics and tests. */
export type ViewerMatchKind = "mime-exact" | "mime-wildcard" | "extension" | "fallback";

export interface ViewerResolution {
  readonly plugin: ViewerPlugin;
  readonly matchedBy: ViewerMatchKind;
}

export class DuplicatePluginError extends Error {
  constructor(id: string) {
    super(`a viewer plugin with id "${id}" is already registered`);
    this.name = "DuplicatePluginError";
  }
}

/**
 * Announces a plugin's supported types.
 *
 * Throws on a duplicate id: two plugins claiming the same id would make
 * persisted session state ambiguous, and that is a programming error worth
 * failing loudly at startup rather than resolving arbitrarily.
 */
export function registerViewerPlugin(plugin: ViewerPlugin): void {
  if (plugins.has(plugin.id)) throw new DuplicatePluginError(plugin.id);
  plugins.set(plugin.id, plugin);
  registrationOrder.set(plugin.id, nextOrder++);
}

export function unregisterViewerPlugin(id: string): void {
  plugins.delete(id);
  registrationOrder.delete(id);
}

export function getViewerPlugin(id: string): ViewerPlugin | undefined {
  if (fallbackPlugin?.id === id) return fallbackPlugin;
  return plugins.get(id);
}

export function listViewerPlugins(): readonly ViewerPlugin[] {
  return [...plugins.values()];
}

/**
 * Installs the plugin that handles everything unmatched. Registered separately
 * so it never competes with a real plugin during matching.
 */
export function setFallbackViewerPlugin(plugin: ViewerPlugin): void {
  fallbackPlugin = plugin;
}

export function getFallbackViewerPlugin(): ViewerPlugin | null {
  return fallbackPlugin;
}

/** Test/teardown helper. */
export function clearViewerPlugins(): void {
  plugins.clear();
  registrationOrder.clear();
  fallbackPlugin = null;
  nextOrder = 0;
}

function normalizeMime(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  // Strip parameters: "text/plain; charset=utf-8" -> "text/plain".
  const base = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return UNINFORMATIVE_MIME_TYPES.has(base) ? undefined : base;
}

/** Ranks candidates by declared priority, then by registration order. */
function best(candidates: readonly ViewerPlugin[]): ViewerPlugin | undefined {
  if (candidates.length <= 1) return candidates[0];
  return [...candidates].sort((a, b) => {
    const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
    if (byPriority !== 0) return byPriority;
    return (registrationOrder.get(a.id) ?? 0) - (registrationOrder.get(b.id) ?? 0);
  })[0];
}

function matchesWildcard(pattern: string, mimeType: string): boolean {
  if (!pattern.endsWith("/*")) return false;
  return mimeType.startsWith(pattern.slice(0, -1));
}

/**
 * Picks the plugin for a file.
 *
 * MIME type first, when the file's source supplied an informative one; exact
 * matches beat wildcards. Otherwise — which is the common case for a file
 * opened from a native dialog, since a path carries no MIME type — the
 * extension decides. Unmatched files go to the fallback viewer.
 *
 * Returns `null` only when no fallback has been installed, which the shell
 * treats as a startup bug rather than a per-file condition.
 */
export function resolveViewerPlugin(file: {
  readonly mimeType?: string;
  readonly extension?: string;
}): ViewerResolution | null {
  const mimeType = normalizeMime(file.mimeType);
  const candidates = [...plugins.values()];

  if (mimeType) {
    const exact = best(
      candidates.filter((plugin) =>
        plugin.mimeTypes.some((type) => type.toLowerCase() === mimeType),
      ),
    );
    if (exact) return { plugin: exact, matchedBy: "mime-exact" };

    const wildcard = best(
      candidates.filter((plugin) =>
        plugin.mimeTypes.some((type) => matchesWildcard(type.toLowerCase(), mimeType)),
      ),
    );
    if (wildcard) return { plugin: wildcard, matchedBy: "mime-wildcard" };
  }

  const extension = file.extension?.toLowerCase();
  if (extension) {
    const byExtension = best(
      candidates.filter((plugin) =>
        plugin.extensions.some((candidate) => candidate.toLowerCase() === extension),
      ),
    );
    if (byExtension) return { plugin: byExtension, matchedBy: "extension" };
  }

  if (fallbackPlugin) return { plugin: fallbackPlugin, matchedBy: "fallback" };
  return null;
}

/** Convenience wrapper for the common case of resolving an opened file. */
export function resolveViewerPluginForFile(file: FileHandle): ViewerResolution | null {
  return resolveViewerPlugin({ mimeType: file.mimeType, extension: file.extension });
}
