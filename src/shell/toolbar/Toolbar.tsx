/**
 * The toolbar shell.
 *
 * Two halves, and the split is the point:
 *
 *   - **Baseline controls** — open file, sidebar toggle, search, commands.
 *     These are the ones that are unambiguously essential regardless of what is
 *     open, so they are the only ones hard-coded here. (The keybind reference
 *     trigger is the third baseline control phase 02 calls for, but it lives in
 *     the status bar: it teaches the keyboard rather than acting on the
 *     workspace, and duplicating it here is exactly the crowding phase 08
 *     exists to undo.)
 *
 *     The last two arrived in phase 06 because that brief requires them to have
 *     a mouse path: search "reachable both from a dedicated keybind/toolbar
 *     action and from within the command palette", and the palette itself
 *     "triggered by keybind and also reachable via a visible toolbar button or
 *     icon, so it is not keyboard-only". Four baseline controls is the most
 *     this bar has ever held and phase 08 is where that gets judged; what is
 *     deliberately *not* here is a clipboard button, since copy already has two
 *     shortcuts, a palette entry and the scratch panel.
 *   - **Contributed controls** — whatever the focused tile's plugin returns
 *     from `ViewerToolbarApi.getControls()`, rendered by kind. When a PDF
 *     plugin lands in phase 03 its inversion toggle appears here without this
 *     file changing, and without it containing the word "PDF".
 *
 * Keeping the toolbar visibly short is a standing constraint; phase 08 decides
 * the final essential-versus-keybind-only split once real plugins exist.
 */

import { formatAcceleratorSpec, SHELL_KEYBIND_GROUP, useKeybinds } from "../keybinds";
import {
  sortToolbarControls,
  useLayoutStore,
  useToolbarStore,
  useWorkspaceStore,
} from "../../store";
import type {
  ToolbarChoiceControl,
  ToolbarControl,
  ToolbarReadoutControl,
  ToolbarToggleControl,
} from "../../viewers";
import { useOpenFiles } from "../openFiles";
import { showGlobalSearch } from "../search";

const OPEN_KEYS = ["Mod+O"];
const SIDEBAR_KEYS = ["Mod+B"];
const SEARCH_KEYS = ["Mod+F"];
// `Mod+K` rather than `Mod+P`: the PDF plugin has print on `Mod+P` as one of
// its three deliberate `Mod`+letter exceptions, and a shell binding would take
// it from the focused tile — the one direction the two layers must not
// collide in (AGENTS.md, "the shell's spaces are off limits").
const PALETTE_KEYS = ["Mod+K"];

export function Toolbar() {
  const { open, busy, problem } = useOpenFiles();

  const sidebarVisible = useLayoutStore((state) => state.sidebarVisible);
  const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
  const commandPaletteOpen = useLayoutStore((state) => state.commandPaletteOpen);
  const toggleCommandPalette = useLayoutStore((state) => state.toggleCommandPalette);

  const activeClientId = useWorkspaceStore((state) => state.activeClientId);
  const contributed = useToolbarStore((state) =>
    activeClientId ? state.contributions[activeClientId] : undefined,
  );

  useKeybinds([
    {
      id: "shell.openFile",
      group: SHELL_KEYBIND_GROUP,
      label: "open file",
      keys: OPEN_KEYS,
      order: 10,
      run: () => void open(),
    },
    {
      id: "shell.toggleSidebar",
      group: SHELL_KEYBIND_GROUP,
      label: "toggle sidebar",
      keys: SIDEBAR_KEYS,
      order: 20,
      run: toggleSidebar,
    },
    {
      id: "shell.search",
      group: SHELL_KEYBIND_GROUP,
      label: "search across open tiles",
      keys: SEARCH_KEYS,
      order: 40,
      // Fires while the search box itself has focus, which is what makes
      // pressing it twice mean "select what I typed and start again".
      allowInTextInput: true,
      run: () => showGlobalSearch(),
    },
    {
      id: "shell.commandPalette",
      group: SHELL_KEYBIND_GROUP,
      label: "open the command palette",
      keys: PALETTE_KEYS,
      order: 50,
      allowInTextInput: true,
      run: toggleCommandPalette,
    },
  ]);

  const controls = contributed ? sortToolbarControls(contributed) : [];

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">
      <ToolbarButton
        label={busy ? "opening…" : "open"}
        title="open file"
        accelerator={OPEN_KEYS[0]}
        disabled={busy}
        onClick={() => void open()}
      />
      <ToolbarButton
        label="sidebar"
        title="toggle sidebar"
        accelerator={SIDEBAR_KEYS[0]}
        active={sidebarVisible}
        onClick={toggleSidebar}
      />
      <ToolbarButton
        label="search"
        title="search across open tiles"
        accelerator={SEARCH_KEYS[0]}
        onClick={() => showGlobalSearch()}
      />
      <ToolbarButton
        label="commands"
        title="open the command palette"
        accelerator={PALETTE_KEYS[0]}
        active={commandPaletteOpen}
        onClick={toggleCommandPalette}
      />
      {controls.length > 0 ? (
        <>
          {/* The seam between what the shell owns and what the tile contributes. */}
          <span className="mx-1 h-4 w-px shrink-0 bg-border-strong" aria-hidden />
          {controls.map((control) => (
            <ContributedControl key={control.id} control={control} />
          ))}
        </>
      ) : null}

      <span className="grow" />

      {problem ? (
        <span className="truncate text-error" title={problem}>
          {problem}
        </span>
      ) : null}
    </div>
  );
}

function tooltip(title: string, accelerator: string | undefined): string {
  // Formatted per platform, never hand-assembled — `⌘O` on macOS, `Ctrl+O`
  // elsewhere.
  return accelerator ? `${title} (${formatAcceleratorSpec(accelerator)})` : title;
}

interface ToolbarButtonProps {
  readonly label: string;
  readonly title: string;
  readonly accelerator?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

function ToolbarButton({
  label,
  title,
  accelerator,
  active,
  disabled,
  onClick,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tooltip(title, accelerator)}
      aria-pressed={active}
      className={
        active
          ? "shrink-0 border border-border-accent px-2 text-fg"
          : "shrink-0 border border-border px-2 text-muted hover:bg-surface-hover hover:text-fg disabled:text-disabled disabled:hover:bg-transparent"
      }
    >
      {label}
    </button>
  );
}

/**
 * Renders one plugin-contributed control. The switch is over *control kinds*,
 * which the contract defines — never over file types, which it does not.
 */
function ContributedControl({ control }: { readonly control: ToolbarControl }) {
  switch (control.kind) {
    case "button":
      return (
        <ToolbarButton
          label={control.label}
          title={control.title ?? control.label}
          accelerator={control.accelerator}
          disabled={control.disabled}
          onClick={() => control.run()}
        />
      );
    case "toggle":
      return <ContributedToggle control={control} />;
    case "choice":
      return <ContributedChoice control={control} />;
    case "readout":
      return <ContributedReadout control={control} />;
  }
}

/**
 * A value, not a control. Same height and spacing as its neighbours but no
 * border and no hover, so a row of `‹ 3 / 12 ›` reads as one thing.
 */
function ContributedReadout({ control }: { readonly control: ToolbarReadoutControl }) {
  return (
    <span
      title={tooltip(control.title ?? control.label, control.accelerator)}
      className="shrink-0 px-1 text-muted tabular-nums"
    >
      {control.value}
    </span>
  );
}

function ContributedToggle({ control }: { readonly control: ToolbarToggleControl }) {
  return (
    <ToolbarButton
      label={control.label}
      title={control.title ?? control.label}
      accelerator={control.accelerator}
      disabled={control.disabled}
      active={control.value}
      onClick={() => control.setValue(!control.value)}
    />
  );
}

function ContributedChoice({ control }: { readonly control: ToolbarChoiceControl }) {
  return (
    <select
      value={control.value}
      disabled={control.disabled}
      title={tooltip(control.title ?? control.label, control.accelerator)}
      aria-label={control.title ?? control.label}
      onChange={(event) => control.setValue(event.target.value)}
      className="shrink-0 border border-border bg-surface px-1 text-muted hover:text-fg disabled:text-disabled"
    >
      {control.options.map((option) => (
        <option key={option.value} value={option.value} className="bg-surface text-fg">
          {option.label}
        </option>
      ))}
    </select>
  );
}
