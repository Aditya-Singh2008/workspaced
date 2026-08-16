//! The macOS application menu.
//!
//! ## Why this file exists
//!
//! Tauri installs a default macOS menu whenever the builder is given none
//! (`tauri::Builder::build`, guarded by `enable_macos_default_menu`, whose
//! default is `true`). The items in it are `PredefinedMenuItem`s, and each
//! carries the standard key equivalent for its role. macOS matches a menu key
//! equivalent in `performKeyEquivalent:` — **before** the key reaches the
//! webview — so every accelerator in that menu is one this app can never see.
//!
//! Four of them are accelerators this app binds:
//!
//! | Default menu item | Key | The binding it swallows |
//! | --- | --- | --- |
//! | Window ▸ Close Window | `⌘W` | `layout.closeTile` — close the *tile* |
//! | Edit ▸ Copy | `⌘C` | `shell.copy` — the focused tile's content |
//! | Edit ▸ Undo | `⌘Z` | `annotate.undo` |
//! | Edit ▸ Redo | `⇧⌘Z` | `annotate.redo` |
//!
//! AGENTS.md ("Platform targets") records the `⌘W` half and says whichever
//! phase builds the menu must drop that item. The other three arrived later —
//! `⌘Z`/`⇧⌘Z` with phase 05a, `⌘C` with phase 06 — without the re-check that
//! note asks for. `viewers/pdf/actions.ts` argues `Mod+Z` is "unclaimed", and it
//! is: by the *shell*. It is not unclaimed by macOS.
//!
//! So this is Tauri's own `Menu::default`, with those four items removed and
//! nothing else changed. Keeping the rest matters as much as dropping those:
//! `⌘Q`, `⌘H`, `⌥⌘H` and `⌃⌘F` are conventions users expect and bindings this
//! app does not want, and an app with no menu bar at all is not a Mac app.
//!
//! ## The trade this makes, which is not free
//!
//! Dropping Copy, Undo and Redo removes those key equivalents *application
//! wide*, including over the app's own text fields — the search box, the
//! annotation callout editor. `shell.copy` deliberately declines while a text
//! field has focus (`useClipboardKeybinds.ts`), on the grounds that the platform
//! should handle `⌘C` there, and this menu is the thing that was handling it.
//!
//! Whether WKWebView performs `copy:`/`undo:` from its own key handling with no
//! menu item present is exactly the kind of question that needs a Mac, and this
//! was written on Linux. **It is unverified.** If a real run shows copy or undo
//! broken inside the app's own inputs, the fix is to put the three Edit items
//! back and move the app's three bindings off those keys — a change here plus a
//! change in `actions.ts`, not a redesign. Do not resolve that question by
//! reading this comment.
//!
//! `⌘X`, `⌘V` and `⌘A` are kept: the app binds none of them, and cut, paste and
//! select-all in a text field are worth more than three keys nothing claims.

use tauri::menu::{
  AboutMetadata, Menu, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

/// Tauri's default macOS menu, minus the four items whose key equivalents this
/// app binds.
///
/// Compiled on every platform, deliberately: it is installed only on macOS (see
/// `lib.rs`), but a `#[cfg(target_os = "macos")]` body cannot be type-checked by
/// any compiler available on the machine this was written on. Leaving it out of
/// the cfg means `cargo check` on a Linux or Windows host still reads it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
  let package = app.package_info();
  let config = app.config();

  // The same metadata Tauri's own default assembles, from the same sources.
  let about = AboutMetadata {
    name: Some(package.name.clone()),
    version: Some(package.version.to_string()),
    copyright: config.bundle.copyright.clone(),
    authors: config.bundle.publisher.clone().map(|publisher| vec![publisher]),
    ..Default::default()
  };

  // The application menu, unchanged from the default. Nothing here collides.
  let app_menu = Submenu::with_items(
    app,
    package.name.clone(),
    true,
    &[
      &PredefinedMenuItem::about(app, None, Some(about))?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::services(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::hide(app, None)?,
      &PredefinedMenuItem::hide_others(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::quit(app, None)?,
    ],
  )?;

  // No File menu. The default's File submenu holds exactly one item on macOS —
  // Close Window — so dropping that item empties it, and an empty menu titled
  // "File" is worse than no File menu.

  // Undo, Redo and Copy are the three dropped from here. See the module comment
  // for what that costs and how to undo it.
  let edit_menu = Submenu::with_items(
    app,
    "Edit",
    true,
    &[
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
    ],
  )?;

  let view_menu = Submenu::with_items(
    app,
    "View",
    true,
    &[&PredefinedMenuItem::fullscreen(app, None)?],
  )?;

  // Close Window is the fourth dropped item. `Mod+W` closes a tile, which is
  // what the user means in a tiling workspace; the window's own close button
  // and `⌘Q` are how you leave the app.
  //
  // The id is Tauri's own `WINDOW_SUBMENU_ID` so its window-list handling still
  // recognises this as the Window menu.
  let window_menu = Submenu::with_id_and_items(
    app,
    WINDOW_SUBMENU_ID,
    "Window",
    true,
    &[
      &PredefinedMenuItem::minimize(app, None)?,
      &PredefinedMenuItem::maximize(app, None)?,
    ],
  )?;

  // Empty, as in the default: macOS populates Help with its own search field.
  let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;

  Menu::with_items(
    app,
    &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
  )
}
