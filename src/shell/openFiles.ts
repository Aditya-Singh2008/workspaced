/**
 * Opening files into the workspace.
 *
 * Shared by the empty state and the toolbar so "open file" behaves identically
 * wherever it is triggered, and so the dialog's busy/error handling exists
 * once. It lives in `shell/` rather than `files/` because it depends on the
 * workspace store, and `files/` must stay a leaf that viewer plugins can
 * depend on.
 *
 * ## Why the annotated-copy question is asked here
 *
 * Because this is the only place that can answer it. The rule that produced
 * `report-annotated.pdf` belongs to `annotation/store.ts` and is free of
 * file-type vocabulary — a name and an extension, nothing about PDFs — so
 * asking it here does not put file-type knowledge in the shell. What *is*
 * shell knowledge is the answer's consequence: which file a tile stands for.
 * The viewer contract is explicit that a plugin may not swap its own handle
 * (it may only rename what it displays), so a plugin could not make this
 * choice even if it wanted to. It has to happen before anything is opened,
 * which is here.
 */

import { useCallback, useState } from "react";

import { annotatedCompanionOrdinal } from "../annotation";
import {
  askAboutFile,
  directoryOf,
  listDirectoryFiles,
  openFileByPath,
  openFilesViaDialog,
  type DialogFilter,
  type FileDescriptor,
  type FileHandle,
} from "../files";
import { listViewerPlugins } from "../viewers";
import { useWorkspaceStore } from "../store";

/**
 * The dialog's file-type filters, derived from the registry.
 *
 * The shell must not contain a list of extensions — that would be exactly the
 * file-type knowledge AGENTS.md forbids it. But every registered plugin already
 * declares what it opens, so asking the registry produces the same filters with
 * none of the coupling: a plugin added in a later phase appears in this dialog
 * without anything here changing.
 *
 * "All files" leads, because a filtered dialog that hides a file the user can
 * see in their file manager is worse than one that shows everything — the
 * fallback viewer opens whatever nothing else claims.
 */
function dialogFilters(): DialogFilter[] {
  const filters: DialogFilter[] = [];
  const everything = new Set<string>();

  for (const plugin of listViewerPlugins()) {
    if (plugin.extensions.length === 0) continue;
    filters.push({ name: plugin.displayName, extensions: [...plugin.extensions] });
    for (const extension of plugin.extensions) everything.add(extension);
  }

  if (filters.length > 1) {
    filters.unshift({ name: "All supported files", extensions: [...everything] });
  }
  return filters;
}

/**
 * Swaps in the annotated copy of a file, if there is one and the user wants it.
 *
 * Answered from a single directory listing rather than by probing candidate
 * names: one call says which companions exist *and* when each was last written,
 * which is what makes "the most recent one" the thing offered when a document
 * has been annotated more than once. Everything is best-effort — an unreadable
 * directory, a file that vanished between the listing and the open — because
 * the worst acceptable outcome is opening exactly what the user picked.
 */
async function chooseAnnotatedCopy(handle: FileHandle): Promise<FileHandle> {
  const path = handle.path;
  const directory = path ? directoryOf(path) : undefined;
  if (!path || !directory || !handle.extension) return handle;

  let siblings: readonly FileDescriptor[];
  try {
    siblings = await listDirectoryFiles(directory, [handle.extension]);
  } catch {
    return handle;
  }

  const companions = siblings
    .map((descriptor) => ({
      descriptor,
      ordinal: annotatedCompanionOrdinal(descriptor.name, handle.name),
    }))
    .filter((entry): entry is { descriptor: FileDescriptor; ordinal: number } =>
      entry.ordinal !== null,
    )
    // Most recently written first; the numbering breaks a tie, since a
    // filesystem that reports no mtime still orders `-annotated-3` after
    // `-annotated`.
    .sort(
      (a, b) =>
        (b.descriptor.modifiedAt ?? 0) - (a.descriptor.modifiedAt ?? 0) ||
        b.ordinal - a.ordinal,
    );

  const best = companions[0]?.descriptor;
  if (!best) return handle;

  const others = companions.length - 1;
  const wanted = await askAboutFile({
    title: "Annotated copy found",
    message:
      `${best.name} sits beside ${handle.name} and is an annotated ` +
      `copy of it${others > 0 ? ` (the most recent of ${companions.length})` : ""}.\n\n` +
      "Open the annotated copy, or the original?",
    confirmLabel: `Open ${best.name}`,
    cancelLabel: `Open ${handle.name}`,
  });
  if (!wanted) return handle;

  try {
    return await openFileByPath(
      best.path,
      handle.source === "memory" ? "native-dialog" : handle.source,
    );
  } catch {
    return handle;
  }
}

export interface OpenFiles {
  /** Shows the native file dialog and opens everything the user picked. */
  open(): Promise<void>;
  /** True while the dialog is up or files are being registered. */
  readonly busy: boolean;
  /** The last failure, for display next to the trigger. Cleared on retry. */
  readonly problem: string | null;
}

export function useOpenFiles(): OpenFiles {
  const openFile = useWorkspaceStore((state) => state.openFile);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const open = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const handles = await openFilesViaDialog({
        multiple: true,
        filters: dialogFilters(),
      });
      for (const picked of handles) {
        // One question per file, before it is opened: a multi-file selection
        // that includes two annotated documents is two decisions, not one.
        const handle = await chooseAnnotatedCopy(picked);
        // A null result means no plugin resolved *at all*, which can only
        // happen if the fallback viewer was never installed.
        if (!openFile(handle)) setProblem(`No viewer resolved for ${handle.name}.`);
      }
    } catch (thrown) {
      setProblem(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  }, [openFile]);

  return { open, busy, problem };
}
