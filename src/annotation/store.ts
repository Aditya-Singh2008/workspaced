/**
 * Where a document's annotations live, and where a save goes.
 *
 * Both halves are here rather than in the PDF plugin because neither is
 * PDF-specific, and because phase 05b's text-anchored model and any later
 * plugin's bridge have to share them (AGENTS.md: "one `store.ts`"). The plugin
 * supplies the two things that *are* file-type-specific — how to tell whether a
 * file carries the marker, and how to write bytes — as callbacks.
 *
 * ## Annotations belong to the file, not to the tile
 *
 * Keyed by path, so closing a tile and reopening the same document keeps its
 * marks, and two tiles showing one file show the same annotations rather than
 * two divergent sets. In-memory files (the self-test's fixtures) fall back to
 * the handle id, which is unique per session and never persisted.
 *
 * Nothing here writes to disk. Phase 07 owns session persistence and reads
 * these documents through the seam at the bottom of this file — the same shape
 * as the plugins' `serialize`/`restore` pairs, and for the same reason: this
 * module knows what an annotation is, and the persistence layer knows where
 * bytes go, and neither needs to learn the other's job.
 *
 * ## The annotated flag, and why the policy is here and the probing is not
 *
 * AGENTS.md's rule, in full: if the currently open file already carries the
 * marker, write back to it; otherwise write `<name>-annotated.<ext>` alongside
 * the original, mark it, and treat that as the file from then on. A target that
 * already exists and carries the marker is that same companion and is
 * overwritten; a target that exists and does *not* carry the marker is an
 * unrelated file with a coincidentally similar name and gets a numeric suffix,
 * because clobbering a stranger's file is data loss and clutter is not.
 *
 * That rule is a decision procedure over three yes/no questions, which is
 * exactly the kind of thing that is worth having in one testable function and
 * nowhere else. {@link resolveAnnotatedTarget} is that function; it does no I/O
 * and asks its caller. `annotation/selftest.ts` drives it against a fake
 * filesystem, including the planted-collision case the phase brief calls out.
 *
 * The one place the rule now stops and asks is the case where it used to decide
 * silently: a companion that exists and *is* ours. Overwriting it is right when
 * the user is continuing last week's markup and wrong when they are starting a
 * second, separate pass over the same document, and nothing in the filesystem
 * distinguishes those. So a caller may supply `confirmReplace`; declining walks
 * on to the next free `-annotated-N`. Callers that do not supply it get phase
 * 05a's behaviour unchanged, which is what keeps the export path and the
 * self-test's fake filesystem free of a prompt neither can answer.
 *
 * The mirror image — "there is already an annotated copy, do you want *that*
 * one rather than the one you picked?" — is asked at open time by
 * `shell/openFiles.ts`, over {@link annotatedCompanionOrdinal}.
 */

import { OVERLAY_VERSION, OverlayDocument, type OverlayItem } from "./overlay";
import {
  TEXT_ANNOTATION_VERSION,
  TextAnnotationDocument,
  type TextAnnotationItem,
} from "./text";

// ---------------------------------------------------------------------------
// Document identity and storage
// ---------------------------------------------------------------------------

/** The minimum a store needs to identify a file. Satisfied by `FileHandle`. */
export interface AnnotatedFileIdentity {
  readonly id: string;
  readonly path?: string;
}

/** The prefix a key gets when there is no path to key it on. */
const HANDLE_KEY_PREFIX = "handle:";

/** Stable across tiles and across a close-and-reopen. */
export function annotationDocumentKey(file: AnnotatedFileIdentity): string {
  return file.path ?? `${HANDLE_KEY_PREFIX}${file.id}`;
}

/**
 * Whether a key survives the session it was made in.
 *
 * A handle id is minted per session, so a document keyed on one can never be
 * matched to a file again — it is annotations on bytes that had no path. Phase
 * 07 uses this to leave them out of the record, for the same reason it leaves
 * an in-memory file out of the tile list: what is written down has to be
 * something a later run can find. Without it, every dev self-test run would
 * add a permanent, unmatched document to the session file.
 */
export function isRestorableDocumentKey(key: string): boolean {
  return !key.startsWith(HANDLE_KEY_PREFIX);
}

const overlays = new Map<string, OverlayDocument>();
const texts = new Map<string, TextAnnotationDocument>();

/**
 * Fires whenever any document in the store gains, loses or changes a mark.
 *
 * One channel for both models and every key, because its only consumer is the
 * persistence layer asking "is what is on disk still true" — a question that is
 * about the store as a whole. Per-document subscriptions already exist for
 * everything that needs to know *which* mark changed.
 */
const storeListeners = new Set<() => void>();

export function subscribeToAnnotationStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function notifyStore(): void {
  for (const listener of storeListeners) {
    try {
      listener();
    } catch (thrown) {
      console.error("[annotation] store listener threw", thrown);
    }
  }
}

/** The overlay annotations for a document, created empty on first ask. */
export function overlayDocumentFor(key: string): OverlayDocument {
  const existing = overlays.get(key);
  if (existing) return existing;
  const created = new OverlayDocument();
  overlays.set(key, created);
  // Never unsubscribed: a document outlives every tile that shows it, and the
  // store is the thing that owns it. Dropping the subscription would mean marks
  // that stop being saved the moment the tile they were drawn in closes.
  created.subscribe(notifyStore);
  return created;
}

/**
 * The text-anchored annotations for a document, created empty on first ask.
 *
 * A second map rather than a second store: the two models answer different
 * questions and share nothing but the key, and merging them into one object
 * would give every consumer of one a reason to reach into the other. What they
 * *do* share is this file — the key, the save target, and the marker policy —
 * which is the part AGENTS.md says must not be duplicated.
 */
export function textDocumentFor(key: string): TextAnnotationDocument {
  const existing = texts.get(key);
  if (existing) return existing;
  const created = new TextAnnotationDocument();
  texts.set(key, created);
  // Not `"place"`: a placement is derived from the document as it is right now
  // and is never persisted, so a re-resolution — which happens on every render
  // pass that moves a line of text — has changed nothing that is written down.
  created.subscribe((reason) => {
    if (reason !== "place") notifyStore();
  });
  return created;
}

/** Whether anything has been drawn on this document. */
export function hasOverlayDocument(key: string): boolean {
  return (overlays.get(key)?.items.length ?? 0) > 0;
}

/** Whether anything on this document is anchored to its text. */
export function hasTextDocument(key: string): boolean {
  return (texts.get(key)?.items.length ?? 0) > 0;
}

/** Drops everything. Test teardown only — a closing tile must *not* call this. */
export function clearAnnotationStore(): void {
  overlays.clear();
  texts.clear();
  targets.clear();
}

// ---------------------------------------------------------------------------
// Save targets
// ---------------------------------------------------------------------------

/**
 * Where a document's annotated copy has been written this session.
 *
 * This is what "repoint the open tile at the new file" comes down to in
 * practice: the second save has to land on the companion rather than making a
 * second one, and the original must never be written again. The alternative —
 * having the plugin hand the shell a different `FileHandle` — was not taken,
 * because the contract is explicit that the shell owns which file a client
 * stands for and that a plugin may only say what it is *displaying*
 * (`ViewerHost.setDisplayName`, which the plugin does call, so the tab and the
 * sidebar both show the companion's name).
 */
const targets = new Map<string, string>();

export function getAnnotatedTarget(key: string): string | undefined {
  return targets.get(key);
}

export function setAnnotatedTarget(key: string, path: string): void {
  targets.set(key, path);
  notifyStore();
}

// ---------------------------------------------------------------------------
// The phase 07 seam
// ---------------------------------------------------------------------------

/**
 * One document's marks, in the form the session record holds them.
 *
 * Both item models are already plain JSON — that is why a pasted image is
 * base64 on the item rather than a `Blob` (`overlay/model.ts`) — so this is a
 * container, not a conversion. The two version numbers travel with it for the
 * same reason `stateVersion` travels with a tile's state: a document written by
 * an older item schema is discarded rather than half-read.
 */
export interface AnnotationDocumentRecord {
  readonly key: string;
  readonly overlayVersion: number;
  readonly textVersion: number;
  readonly overlay: readonly OverlayItem[];
  readonly text: readonly TextAnnotationItem[];
  /** The most recent edit in this document, for size-budgeting on the way out. */
  readonly updatedAt: number;
  /** Where this document's annotated copy has been written, if anywhere. */
  readonly target?: string;
}

/**
 * Every document that has something in it and can be found again.
 *
 * Empty ones are skipped rather than recorded: a tile mounting on a file asks
 * for its documents and gets two empty ones, so recording those would fill the
 * session with a row per file ever opened, saying nothing. Documents on files
 * with no path are skipped for the stronger reason in
 * {@link isRestorableDocumentKey}.
 */
export function serializeAnnotationDocuments(): readonly AnnotationDocumentRecord[] {
  const keys = new Set([...overlays.keys(), ...texts.keys()]);
  const records: AnnotationDocumentRecord[] = [];

  for (const key of keys) {
    if (!isRestorableDocumentKey(key)) continue;
    const overlay = overlays.get(key)?.items ?? [];
    const text = texts.get(key)?.items ?? [];
    if (overlay.length === 0 && text.length === 0) continue;

    records.push({
      key,
      overlayVersion: OVERLAY_VERSION,
      textVersion: TEXT_ANNOTATION_VERSION,
      overlay,
      text,
      updatedAt: Math.max(
        0,
        ...overlay.map((item) => item.updatedAt),
        ...text.map((item) => item.updatedAt),
      ),
      target: targets.get(key),
    });
  }

  return records;
}

/**
 * Puts restored documents back, replacing whatever is in the store.
 *
 * Version-checked per document and per model, so a session written before an
 * item schema changed loses the model that changed and keeps the other. Runs
 * before any tile mounts, which is what makes `replaceAll` safe here: nothing
 * is subscribed yet, and no plugin has read `items` to draw from.
 */
export function restoreAnnotationDocuments(
  records: readonly AnnotationDocumentRecord[],
): void {
  for (const record of records) {
    if (record.overlayVersion === OVERLAY_VERSION && record.overlay.length > 0) {
      overlayDocumentFor(record.key).replaceAll(record.overlay);
    }
    if (record.textVersion === TEXT_ANNOTATION_VERSION && record.text.length > 0) {
      textDocumentFor(record.key).replaceAll(record.text);
    }
    // The save target is restored whatever the item versions say: it is a path,
    // it does not age, and losing it would send the next save to a *second*
    // `-annotated` copy of a document that already has one.
    if (record.target) targets.set(record.key, record.target);
  }
}

// ---------------------------------------------------------------------------
// The path policy
// ---------------------------------------------------------------------------

/** Splits a path into directory, stem and extension, for both separators. */
export function splitPath(path: string): {
  directory: string;
  stem: string;
  extension: string;
} {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = cut >= 0 ? path.slice(0, cut + 1) : "";
  const name = cut >= 0 ? path.slice(cut + 1) : path;
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension: `.bashrc` has no stem
  // otherwise, and the companion would be called `-annotated.bashrc`.
  return dot > 0
    ? { directory, stem: name.slice(0, dot), extension: name.slice(dot) }
    : { directory, stem: name, extension: "" };
}

/** The file name part of a path. */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

export const ANNOTATED_SUFFIX = "-annotated";

/** `report.pdf` -> `report-annotated.pdf`, `report-annotated-2.pdf`, … */
export function companionPath(sourcePath: string, attempt: number): string {
  const { directory, stem, extension } = splitPath(sourcePath);
  const ordinal = attempt <= 0 ? "" : `-${attempt + 1}`;
  return `${directory}${stem}${ANNOTATED_SUFFIX}${ordinal}${extension}`;
}

/**
 * {@link companionPath} read backwards: which attempt produced this name, or
 * `null` if this file is not a companion of that source at all.
 *
 * The question "is there already an annotated copy of what I am about to open"
 * is asked over a *directory listing* rather than by probing candidate paths, so
 * it needs the name test rather than the name generator — one listing answers
 * it completely, including the gaps a deleted `-annotated-2` leaves behind.
 *
 * Names or paths, but paths are only compared within one directory: two files
 * with the same name in different folders are not each other's companion, and
 * this must never say they are.
 */
export function annotatedCompanionOrdinal(
  candidate: string,
  source: string,
): number | null {
  const them = splitPath(candidate);
  const us = splitPath(source);
  if (them.directory !== us.directory) return null;
  if (them.extension.toLowerCase() !== us.extension.toLowerCase()) return null;

  const prefix = us.stem + ANNOTATED_SUFFIX;
  if (!them.stem.startsWith(prefix)) return null;

  const tail = them.stem.slice(prefix.length);
  if (tail === "") return 0;
  // `-2` upwards only, and no leading zeros: `companionPath` never writes `-0`
  // or `-1`, so a file called `report-annotated-1.pdf` is someone else's and
  // saying otherwise would offer to overwrite it.
  const numbered = /^-([2-9]\d*)$/.exec(tail);
  return numbered ? Number(numbered[1]) - 1 : null;
}

export interface AnnotatedTargetProbe {
  /** Whether anything exists at this path. */
  exists(path: string): Promise<boolean>;
  /**
   * Whether the file at this path carries the workspace annotated marker. Only
   * called for paths that exist. A file that cannot be read or parsed is not
   * ours — answer `false` and it will be left alone.
   */
  carriesMarker(path: string): Promise<boolean>;
  /**
   * Whether to overwrite the companion at `path`, which exists and is ours.
   *
   * Omit it and the answer is yes, which is the rule as phase 05a wrote it: a
   * second save lands on the same companion. Supply it and the user gets the
   * say, because "replace what I annotated last week" and "keep that and start
   * a new one" are both reasonable and only they know which they meant. Asked
   * at most once per save — see {@link resolveAnnotatedTarget}.
   */
  confirmReplace?(path: string): Promise<boolean>;
}

export interface AnnotatedTarget {
  readonly path: string;
  /**
   * Whether this is the file the tile currently has open — i.e. the "overwrite
   * in place" case rather than "write a companion". The caller uses it to decide
   * whether it has to repoint anything.
   */
  readonly inPlace: boolean;
}

/**
 * How many `-annotated-N` candidates to try before giving up.
 *
 * A bound rather than an unbounded loop: every iteration is a filesystem probe,
 * and a directory that somehow answers "exists, not ours" fifty times over is a
 * situation to report, not to keep grinding at.
 */
const MAX_COLLISION_ATTEMPTS = 50;

/**
 * Decides where this document's annotated bytes should be written.
 *
 * `sourceCarriesMarker` is about the file *currently open in the tile*, which
 * the caller already has the bytes of — so answering it costs nothing, while
 * making this function fetch them would put I/O in the one place the policy is
 * decided.
 */
export async function resolveAnnotatedTarget(
  source: { readonly path: string; readonly carriesMarker: boolean },
  probe: AnnotatedTargetProbe,
): Promise<AnnotatedTarget> {
  // Already ours: annotate a file twice and it stays one file. This is the
  // clause that stops `report-annotated-annotated.pdf` from existing.
  if (source.carriesMarker) return { path: source.path, inPlace: true };

  // Set once the user has said "keep that one, give me a new file". After that
  // every companion is stepped over in silence: they answered the question, and
  // asking again for `-annotated-2` and `-annotated-3` would be asking them to
  // answer it once per file that happens to be in the folder.
  let declined = false;

  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = companionPath(source.path, attempt);
    if (!(await probe.exists(candidate))) return { path: candidate, inPlace: false };
    // Ours from a previous session: the same companion, so overwrite it —
    // unless the caller offers the user the choice and they take the other one.
    if (await probe.carriesMarker(candidate)) {
      // Nobody to ask: the phase 05a rule stands, and the companion is reused.
      if (!probe.confirmReplace) return { path: candidate, inPlace: false };
      if (declined) continue;
      if (await probe.confirmReplace(candidate)) {
        return { path: candidate, inPlace: false };
      }
      declined = true;
      continue;
    }
    // Someone else's file that happens to be named like ours. Step over it.
  }

  throw new Error(
    `could not find a free name for the annotated copy of ${basename(source.path)} ` +
      `after ${MAX_COLLISION_ATTEMPTS} attempts`,
  );
}
