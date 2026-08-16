/**
 * The tile's own right-click menu.
 *
 * The brief makes this a first-class discovery path, not a nicety: everything
 * outside the five-control toolbar is "keybind-accessible **and/or** reachable
 * via a right-click context menu", and a plugin whose flip, frame-step and
 * export are hidden shortcuts with no visible route is one that only its author
 * can use.
 *
 * It does not collide with the shell's. dockview contributes a context menu on a
 * tile's *tab*, which is where the layout actions live; the content area below
 * it belongs to the plugin, and this is the plugin using it.
 *
 * Rendered into `document.body` rather than into the tile. A menu inside the
 * scroller would be clipped by its `overflow` the moment it opened near an edge,
 * and would scroll away underneath the pointer.
 */

import type { ImageMenuItem } from "../actions";

let openMenu: HTMLElement | null = null;

/** Closes whatever menu is open. Safe to call when none is. */
export function closeImageMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

/**
 * Opens a menu at a point, closing any other.
 *
 * Positioned after insertion so the real measured size can be used to keep it on
 * screen — a menu opened near the bottom of the window otherwise runs off it,
 * which is exactly where a tile's content tends to be right-clicked.
 */
export function openImageMenu(
  at: { clientX: number; clientY: number },
  items: readonly ImageMenuItem[],
): void {
  closeImageMenu();

  const menu = document.createElement("div");
  menu.className = "image-menu";
  menu.setAttribute("role", "menu");

  for (const item of items) {
    if (item.separator) {
      const separator = document.createElement("hr");
      separator.className = "image-menu-separator";
      menu.append(separator);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-menu-item";
    button.setAttribute("role", "menuitem");
    button.disabled = item.disabled === true;
    // A leading marker column, so checked and unchecked rows share a text
    // baseline instead of the label shifting when a state changes.
    button.textContent = `${item.checked ? "•" : " "} ${item.label}`;
    button.addEventListener("click", () => {
      closeImageMenu();
      item.run?.();
    });
    menu.append(button);
  }

  document.body.append(menu);
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
    closeImageMenu();
    detach();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeImageMenu();
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
