/**
 * The tile's own right-click menu.
 *
 * The brief makes this a first-class discovery path rather than a nicety: the
 * toolbar is "minimal, essential-only" and everything else is "keybind- and/or
 * context-menu-accessible". A player whose A/B loop, frame capture, track
 * selection and picture-in-picture were unlisted shortcuts would be one only its
 * author could use.
 *
 * Rendered into `document.body` rather than into the tile, for the reason the
 * image plugin's menu gives: a menu inside the stage would be clipped by its
 * `overflow` the moment it opened near an edge, and a menu inside a fullscreen
 * element has to be in the fullscreen subtree to be visible at all — which
 * `document.body` is, because this plugin fullscreens the viewer root.
 *
 * Flat, with no submenus. Track lists can run to a dozen entries with two lines
 * each, and a submenu of them would be a panel rendered as a menu — so the menu
 * offers "cycle subtitles" and a way to *open* the tracks panel, and the panel
 * does the listing.
 */

import type { VideoMenuItem } from "../actions";

let openMenu: HTMLElement | null = null;

/** Closes whatever menu is open. Safe to call when none is. */
export function closeVideoMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

/**
 * Opens a menu at a point, closing any other.
 *
 * Positioned after insertion so the real measured size can be used to keep it on
 * screen — a menu opened near the bottom of the window otherwise runs off it,
 * which is where a video tile's controls are and therefore where it tends to be
 * right-clicked.
 */
export function openVideoMenu(
  at: { clientX: number; clientY: number },
  items: readonly VideoMenuItem[],
): void {
  closeVideoMenu();

  const menu = document.createElement("div");
  menu.className = "video-menu";
  menu.setAttribute("role", "menu");

  for (const item of items) {
    if (item.separator) {
      const separator = document.createElement("hr");
      separator.className = "video-menu-separator";
      menu.append(separator);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "video-menu-item";
    button.setAttribute("role", "menuitem");
    button.disabled = item.disabled === true;
    // A leading marker column, so checked and unchecked rows share a text
    // baseline instead of the label shifting when a state changes.
    button.textContent = `${item.checked ? "•" : " "} ${item.label}`;
    button.addEventListener("click", () => {
      closeVideoMenu();
      item.run?.();
    });
    menu.append(button);
  }

  // Into the fullscreen element when there is one: a node outside the
  // fullscreen subtree is not rendered at all, and a menu that silently did not
  // appear in fullscreen would look like a broken right-click.
  const host =
    document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : document.body;
  host.append(menu);
  openMenu = menu;

  const box = menu.getBoundingClientRect();
  const left = Math.max(0, Math.min(at.clientX, window.innerWidth - box.width - 4));
  const top = Math.max(0, Math.min(at.clientY, window.innerHeight - box.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  // Dismissal. `pointerdown` rather than `click` so the menu is gone before
  // whatever was clicked underneath it reacts, and capture so a handler that
  // stops propagation cannot leave the menu stranded on screen.
  const dismiss = (event: Event): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    closeVideoMenu();
    detach();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeVideoMenu();
    detach();
  };
  const detach = (): void => {
    window.removeEventListener("pointerdown", dismiss, true);
    window.removeEventListener("blur", dismiss);
    window.removeEventListener("keydown", onKey, true);
  };

  window.addEventListener("pointerdown", dismiss, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("keydown", onKey, true);
}
