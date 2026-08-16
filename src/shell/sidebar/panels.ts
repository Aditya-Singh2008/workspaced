/**
 * The sidebar's lower-half panels, named once.
 *
 * Which one is showing became shell state in phase 06 rather than the tab
 * strip's own `useState`, because two of the four are now reachable from
 * outside the sidebar: `Mod+F` opens the sidebar *on search*, and the command
 * palette does the same for both search and the scratch panel. A component
 * that owns its selection cannot be told to change it by a keybind that runs
 * whether or not it is mounted.
 *
 * Kept in its own module, free of imports, so the layout store can name the
 * type without importing a component tree.
 */

/**
 * `views` and `notes` describe the focused tile and appear only when that
 * tile's plugin reports the capability behind them. `search` and `scratch`
 * describe the *workspace*, so they are there with a fallback viewer focused,
 * and with nothing focused at all.
 */
export type SidebarPanelId = "views" | "notes" | "search" | "scratch";

/**
 * The ids as a value, for validating one that arrived from outside the app —
 * phase 07's restored session is the only such source. In tab-strip order.
 */
export const SIDEBAR_PANEL_IDS: readonly SidebarPanelId[] = [
  "views",
  "notes",
  "search",
  "scratch",
];
