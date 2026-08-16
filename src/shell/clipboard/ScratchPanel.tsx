/**
 * The scratch panel, and the session's clipboard history under it.
 *
 * One sidebar tab holds both because they answer the same question from two
 * directions — "what have I picked up?" — and because a 256px column cannot
 * afford two tabs that are each usually empty. The header of each section says
 * which is which, and only the scratch section has a yank keybinding pointing
 * at it, which is the difference that matters (see `store.ts`).
 *
 * Clicking any row puts that entry back on the system clipboard. That is the
 * cross-tile paste path the brief's first verification describes: copy in one
 * tile, click the row, paste into the other tile's search box. It is also why
 * the rows are buttons rather than draggable chips — a drag would be a second
 * mechanism for the thing the clipboard already does.
 */

import { copyEntryToSystemClipboard } from "./actions";
import { useClipboardStore, type ClipEntry } from "./store";
import { ellipsize } from "./system";

export function ScratchPanel() {
  const scratch = useClipboardStore((state) => state.scratch);
  const history = useClipboardStore((state) => state.history);
  const clearScratch = useClipboardStore((state) => state.clearScratch);
  const clearHistory = useClipboardStore((state) => state.clearHistory);

  return (
    <div className="min-h-0 grow overflow-y-auto">
      <Section
        title="scratch"
        hint="yank with the scratch shortcut"
        entries={scratch}
        onClear={clearScratch}
      />
      <Section
        title="recent copies"
        hint="this session only"
        entries={history}
        onClear={clearHistory}
      />
    </div>
  );
}

function Section({
  title,
  hint,
  entries,
  onClear,
}: {
  readonly title: string;
  readonly hint: string;
  readonly entries: readonly ClipEntry[];
  readonly onClear: () => void;
}) {
  return (
    <section>
      <header className="flex items-baseline gap-2 border-b border-border px-2 py-0.5">
        <span className="text-fg-dim">{title}</span>
        <span className="grow" />
        {entries.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 text-muted hover:text-error"
          >
            clear
          </button>
        ) : null}
      </header>

      {entries.length === 0 ? (
        <p className="px-2 py-1 text-disabled">{hint}</p>
      ) : (
        entries.map((entry) => <EntryRow key={entry.id} entry={entry} />)
      )}
    </section>
  );
}

function EntryRow({ entry }: { readonly entry: ClipEntry }) {
  const removeEntry = useClipboardStore((state) => state.removeEntry);

  return (
    <div className="flex items-start gap-1 border-l border-l-transparent pl-1 pr-1 text-muted hover:bg-surface-hover">
      <button
        type="button"
        onClick={() => void copyEntryToSystemClipboard(entry)}
        title={`from ${entry.source} — click to put back on the clipboard`}
        className="flex min-w-0 grow items-start gap-2 py-1 text-left"
      >
        {entry.kind === "image" ? (
          <>
            {/*
              A real preview rather than a word: an entry that says "image" and
              nothing else is unusable the moment there are two of them. Capped
              small, since the panel is a list and not a gallery.
            */}
            <img
              src={entry.url}
              alt=""
              className="h-8 w-8 shrink-0 border border-border object-contain"
            />
            <span className="min-w-0 grow truncate text-fg-dim">
              {entry.width}×{entry.height}
            </span>
          </>
        ) : (
          <span className="min-w-0 grow break-words text-fg-dim">
            {ellipsize(entry.text, 120)}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => removeEntry(entry.id)}
        aria-label="remove this entry"
        className="shrink-0 px-1 text-muted hover:text-error"
      >
        ×
      </button>
    </div>
  );
}
