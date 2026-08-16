/**
 * The bridge between a plugin's {@link ViewerKeybindApi} and the shell's
 * keybind registry.
 *
 * The toolbar's equivalent of this travels through a Zustand store, because the
 * toolbar is a *component* that has to re-render when the focused tile changes.
 * Keybinds have no component: the registry is already a global with a
 * subscription, and the reference modal already re-reads it on every change. So
 * this is a plain function the tile calls on focus and un-calls on blur.
 *
 * Two things it adds on top of a straight pass-through, and they are the reason
 * it exists rather than the plugin calling `registerKeybinds` itself:
 *
 *   - **Namespacing.** The plugin's `id` and `groupTitle` are local to the
 *     plugin. Here they become `viewer.<pluginId>.<id>` and a group id derived
 *     from the plugin, so two plugins cannot collide with each other or with
 *     the shell's own bindings.
 *   - **Focus scoping.** Only the focused tile's bindings are registered, so
 *     `PageDown` can mean "next page" in a PDF and nothing at all elsewhere.
 *     That is what lets plugins claim ordinary keys without negotiating.
 */

import type { ViewerKeybindApi } from "../../viewers";
import { registerKeybindGroup, registerKeybinds } from "./registry";

/** Group ids are namespaced too, so a plugin cannot land in a shell section. */
function groupIdFor(pluginId: string): string {
  return `viewer:${pluginId}`;
}

/**
 * Registers the focused tile's bindings and returns the function that removes
 * them again.
 *
 * The returned function is the *only* way they go away, so the caller must run
 * it on blur, on unmount, and before registering a different instance's.
 */
export function registerViewerKeybinds(
  pluginId: string,
  api: ViewerKeybindApi,
): () => void {
  const group = groupIdFor(pluginId);
  let removeCurrent: (() => void) | null = null;

  const publish = (): void => {
    removeCurrent?.();
    // Re-declared on every publish: the title is the plugin's to change (a
    // video plugin might title its section after the codec), and re-registering
    // a group is a cheap map write.
    registerKeybindGroup({
      id: group,
      title: api.groupTitle,
      // After the shell's own sections. A viewer's bindings are contextual —
      // they describe the focused tile — so they read better below the ones
      // that are always true.
      order: 500,
    });

    removeCurrent = registerKeybinds(
      api.getKeybinds().map((keybind) => ({
        id: `viewer.${pluginId}.${keybind.id}`,
        group,
        label: keybind.label,
        keys: keybind.keys,
        order: keybind.order,
        hidden: keybind.hidden,
        enabled: keybind.enabled ? () => keybind.enabled!() : undefined,
        run: () => keybind.run(),
      })),
    );
  };

  publish();
  const unsubscribe = api.onKeybindsChange?.(publish);

  return () => {
    unsubscribe?.();
    removeCurrent?.();
    removeCurrent = null;
  };
}
