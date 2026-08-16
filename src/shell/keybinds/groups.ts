/**
 * Group ids shared by more than one shell module.
 *
 * A group id is normally owned by whichever module registers the bindings in
 * it — `shell/docking/actions.ts` owns `focus` and `layout`. `shell` is the
 * exception: the toolbar and the status bar both contribute to it, so neither
 * can own the constant without the other importing it sideways.
 */

/** Shell-wide actions: open a file, toggle the sidebar, show the shortcuts. */
export const SHELL_KEYBIND_GROUP = "shell";
