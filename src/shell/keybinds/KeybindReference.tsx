/**
 * The keybind reference modal.
 *
 * It renders the registry and nothing else. A later phase adding page
 * navigation, zoom or annotation shortcuts declares a group and its bindings
 * through `registry.ts` and they appear here — this component never needs to
 * learn about them, which is the requirement phase 02 sets for it.
 *
 * Every label goes through `formatAccelerator`, so the modal shows `⇧⌘P` on
 * macOS and `Ctrl+Shift+P` on Windows and Linux without containing a platform
 * branch of its own.
 */

import { useEffect, useRef } from "react";

import { currentPlatform } from "../../platform";
import { formatAccelerator } from "./accelerator";
import { listKeybindSections, type RegisteredKeybind } from "./registry";
import { useKeybindRegistry } from "./useKeybinds";

interface KeybindReferenceProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function KeybindReference({ open, onClose }: KeybindReferenceProps) {
  // Re-render when a tile's plugin contributes or withdraws bindings while the
  // modal is open.
  useKeybindRegistry();

  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Escape is handled here rather than as a keybind: a modal dismissal is
    // not a shortcut worth listing, and it must work even while the registry
    // is empty.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  const sections = listKeybindSections();
  const platform = currentPlatform();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/80 p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="keybind reference"
        className="flex max-h-full w-full max-w-4xl flex-col border border-border-strong bg-surface"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-fg">keybinds</h2>
          <div className="flex items-center gap-4">
            <span className="text-muted">{platform}</span>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="border border-border px-2 text-muted hover:bg-surface-hover hover:text-fg"
            >
              close
            </button>
          </div>
        </header>

        <div className="min-h-0 grow overflow-y-auto p-4">
          {sections.length === 0 ? (
            <p className="text-muted">no keybinds registered</p>
          ) : (
            <div className="flex flex-col gap-6">
              {sections.map((section) => (
                <section key={section.group.id} className="flex flex-col gap-1">
                  <h3 className="border-b border-border pb-1 text-muted">
                    {section.group.title}
                  </h3>
                  {section.keybinds.map((keybind) => (
                    <KeybindRow key={keybind.id} keybind={keybind} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KeybindRow({ keybind }: { readonly keybind: RegisteredKeybind }) {
  const platform = currentPlatform();
  const available = keybind.enabled?.() ?? true;

  return (
    <div className="flex items-baseline gap-4 py-0.5">
      <span className="flex w-48 shrink-0 flex-wrap gap-2">
        {keybind.accelerators.map((accelerator, index) => (
          <kbd
            key={`${keybind.id}:${index}`}
            className={
              available
                ? "border border-border-strong px-1.5 text-fg-dim"
                : "border border-border px-1.5 text-disabled"
            }
          >
            {formatAccelerator(accelerator, platform)}
          </kbd>
        ))}
      </span>
      <span className={available ? "min-w-0 text-fg-dim" : "min-w-0 text-disabled"}>
        {keybind.label}
      </span>
    </div>
  );
}
