/**
 * Writing to the *system* clipboard — the one other applications can read.
 *
 * The scratch panel and the history next door are in-app collections; this is
 * the only file that leaves the app, and it is separate for that reason.
 *
 * ## Platform notes, which are the whole reason this is not two lines
 *
 * AGENTS.md flags this phase explicitly: *"double-check any newer Clipboard API
 * or filesystem-adjacent web API usage (Phase 6) against WKWebView
 * specifically."* Three things came out of that:
 *
 *   - **`ClipboardItem` is PNG for images, everywhere.** The spec obliges an
 *     implementation to support `text/plain`, `text/html` and `image/png`, and
 *     everything else is at the engine's discretion. So an image goes on the
 *     clipboard as PNG or not at all — which is what the phase brief asks for
 *     in as many words.
 *   - **The `ClipboardItem`-holding-a-promise pattern is still an open question
 *     here, and this file does not answer it.** AGENTS.md records that on
 *     webkit2gtk the write survives an `await` between the gesture and the call
 *     — measured, in the real engine — and instructs that it be re-checked on
 *     WKWebView, "the engine that pattern exists for". It has not been: this
 *     was written and verified on Linux, and AGENTS.md also records that a
 *     scripted DOM harness cannot test the clipboard at all, so there was no
 *     way to answer it from here.
 *
 *     Be accurate about what the code below does, because the shape matters if
 *     the answer turns out to be "WebKit needs the promise": there **are**
 *     awaits between the key press and `navigator.clipboard.write`. The caller
 *     awaits `getCopyable` (one or two round trips into a plugin — for the image
 *     plugin, a canvas render and encode; see `actions.ts`), and this function
 *     awaits {@link transcodeToPng} for anything that is not already PNG. The
 *     blob is in hand by the time `ClipboardItem` is constructed, which is the
 *     part that is definitely fine; whether the *activation* has survived that
 *     far on WKWebView is the part nobody here has checked.
 *
 *     If a real macOS run shows `NotAllowedError` on `Mod+C`, the fix is to
 *     hand `ClipboardItem` a promise and call `write` synchronously inside the
 *     gesture — which would restructure this and `actions.ts` both, and must not
 *     be done speculatively: webkit2gtk is measured working as it stands, and
 *     promise-valued `ClipboardItem` entries are not something it was tested
 *     against.
 *   - **Probe by using it, never by asking.** `navigator.clipboard.write`
 *     exists on webkit2gtk builds where the write then rejects (no portal, no
 *     compositor selection owner). So the feature test is only a fast path out;
 *     the real answer is the rejection, which is caught and reported as a
 *     message rather than thrown at a caller who cannot do anything about it.
 *
 * Text uses `writeText` rather than a `text/plain` `ClipboardItem`: it has the
 * widest support of anything in the API and no `ClipboardItem` constructor
 * involved at all.
 */

import type { CopyableContent } from "../../viewers";

export interface ClipboardWriteResult {
  readonly ok: boolean;
  /** One line, addressed to the user, for the status bar. */
  readonly message: string;
}

/** The MIME type the clipboard is specified to accept for images. */
export const CLIPBOARD_IMAGE_TYPE = "image/png";

/**
 * Puts one piece of content on the system clipboard.
 *
 * Takes a single {@link CopyableContent} rather than the whole array a plugin
 * returns, because putting two flavours of the same thing on the clipboard
 * means writing one `ClipboardItem` with two entries — which WKWebView accepts
 * and webkit2gtk silently reduces to the first. Choosing *which* flavour is the
 * caller's decision (see `actions.ts`), and it is a decision the user can see
 * the result of.
 */
export async function writeToSystemClipboard(
  content: CopyableContent,
): Promise<ClipboardWriteResult> {
  if (content.kind === "text") {
    if (!content.text) return { ok: false, message: "there was nothing to copy" };
    try {
      if (!navigator.clipboard?.writeText) {
        return { ok: false, message: "this platform has no clipboard access" };
      }
      await navigator.clipboard.writeText(content.text);
      return { ok: true, message: `copied ${describeText(content.text)}` };
    } catch (thrown) {
      console.error("[clipboard] text write failed", thrown);
      return { ok: false, message: "could not write to the clipboard" };
    }
  }

  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      return { ok: false, message: "this platform has no image clipboard support" };
    }

    // PNG or nothing. A plugin that hands back a JPEG region gets re-encoded
    // rather than refused — the clipboard is the one place the format is not
    // the user's choice.
    const blob =
      content.mimeType === CLIPBOARD_IMAGE_TYPE
        ? content.blob
        : await transcodeToPng(content.blob);
    if (!blob) return { ok: false, message: "could not encode the image as PNG" };

    await navigator.clipboard.write([new ClipboardItem({ [CLIPBOARD_IMAGE_TYPE]: blob })]);
    return {
      ok: true,
      message: `copied a ${content.width}×${content.height} image`,
    };
  } catch (thrown) {
    console.error("[clipboard] image write failed", thrown);
    return { ok: false, message: "could not write the image to the clipboard" };
  }
}

/**
 * Re-encodes anything that is not already PNG.
 *
 * Goes through `createImageBitmap` + a canvas rather than an `<img>`: no
 * decode-on-load race, no element to leave in the document, and it is the same
 * path the image plugin's own encoder takes.
 */
async function transcodeToPng(blob: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      const encoded = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, CLIPBOARD_IMAGE_TYPE),
      );
      // Releasing the backing store rather than waiting for the collector: a
      // full-resolution RGBA copy is tens of megabytes.
      canvas.width = 0;
      canvas.height = 0;
      return encoded;
    } finally {
      bitmap.close();
    }
  } catch (thrown) {
    console.error("[clipboard] PNG transcode failed", thrown);
    return null;
  }
}

/** "12 words" / "a line" — enough for the status bar to be worth reading. */
export function describeText(text: string): string {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  if (words === 0) return "empty text";
  if (words === 1) return `“${ellipsize(trimmed, 24)}”`;
  return `${words} words`;
}

/** Shortens for a one-line label without breaking mid-escape-sequence. */
export function ellipsize(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}
