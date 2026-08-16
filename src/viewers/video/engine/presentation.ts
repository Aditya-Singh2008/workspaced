/**
 * Fullscreen and picture-in-picture: the two ways the picture leaves the tile.
 *
 * Both are single calls with three different spellings and four different
 * failure modes across the target webviews, which is the whole reason they are
 * a module rather than two lines in the instance.
 *
 * ## Probed by trying, never by asking
 *
 * AGENTS.md is unambiguous: *"probe a capability by using it and measuring the
 * result, never by asking whether the API exists."* Both APIs here are exactly
 * the trap that rule was written for.
 *
 * `document.pictureInPictureEnabled` is `true` on builds of WebKitGTK where
 * `requestPictureInPicture` rejects for every video, and `false` on Safari,
 * which has had the feature since before the standard API existed and spells it
 * `webkitSetPresentationMode`. A menu item enabled or disabled from that
 * property would be wrong on both. So the item is always offered, the call is
 * made, and the *rejection* — which is a real, observed result — becomes the
 * message.
 *
 * Fullscreen has the same shape with a different cause: `requestFullscreen`
 * exists everywhere and rejects when it was not called from a user gesture, when
 * the document is not permitted it, or when another element already holds it.
 * Only the attempt distinguishes those from success.
 *
 * ## Fullscreen takes the tile, not the `<video>`
 *
 * Fullscreening the media element hands the screen to the engine's own control
 * bar — the one `view.ts` explains cannot be used — and drops the caption
 * overlay, the scrubber and the A/B loop markers, all of which are siblings of
 * the video rather than children of it. Fullscreening the *viewer root* keeps
 * the whole player intact and full-screen, with our controls, which is what a
 * review tool needs and what every desktop player does.
 */

/** What happened, in a form the caller can put straight on the status line. */
export interface PresentationResult {
  readonly ok: boolean;
  /** Empty when there is nothing worth saying — a user-cancelled request. */
  readonly message: string;
}

/**
 * Safari's presentation-mode API, which predates the standard one and is the
 * only picture-in-picture that exists on WKWebView.
 *
 * Declared rather than reached for with `any`, so the two members used here are
 * named and typed and the fallback below is a check for a shape.
 */
interface WebkitPresentationVideo {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

// ---------------------------------------------------------------------------
// Picture-in-picture
// ---------------------------------------------------------------------------

export function inPictureInPicture(video: HTMLVideoElement): boolean {
  if (document.pictureInPictureElement === video) return true;
  const webkit = video as unknown as WebkitPresentationVideo;
  return webkit.webkitPresentationMode === "picture-in-picture";
}

/**
 * Enters or leaves picture-in-picture.
 *
 * One function for both directions because it is one user-facing thing — the
 * key and the menu item both mean "put this in the corner, or take it back" —
 * and because the state has to be read to decide anyway.
 */
export async function togglePictureInPicture(
  video: HTMLVideoElement,
): Promise<PresentationResult> {
  if (inPictureInPicture(video)) {
    try {
      const webkit = video as unknown as WebkitPresentationVideo;
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        webkit.webkitSetPresentationMode?.("inline");
      }
      return { ok: true, message: "" };
    } catch (thrown) {
      return { ok: false, message: reason(thrown, "could not leave picture-in-picture") };
    }
  }

  // A video with no video track has nothing to put in a floating window, and
  // both engines reject it with a message about the element rather than about
  // the file. Saying which is which here is more useful than passing that on.
  if (video.videoWidth === 0) {
    return { ok: false, message: "there is no picture to detach from this file" };
  }

  if (typeof video.requestPictureInPicture === "function") {
    try {
      await video.requestPictureInPicture();
      return { ok: true, message: "playing in picture-in-picture" };
    } catch (thrown) {
      // Falls through to the WebKit spelling rather than reporting: a build can
      // have the standard method present and non-functional while the prefixed
      // one works, and the attempt above is what established that.
      const fallback = tryWebkitPictureInPicture(video);
      if (fallback) return fallback;
      return { ok: false, message: reason(thrown, "picture-in-picture was refused") };
    }
  }

  return (
    tryWebkitPictureInPicture(video) ?? {
      ok: false,
      message: "this platform does not offer picture-in-picture",
    }
  );
}

/** The prefixed path. `null` when this engine does not have it at all. */
function tryWebkitPictureInPicture(video: HTMLVideoElement): PresentationResult | null {
  const webkit = video as unknown as WebkitPresentationVideo;
  if (typeof webkit.webkitSetPresentationMode !== "function") return null;
  // This one *is* worth asking, because unlike the standard property it is
  // specified as a question about a specific mode on a specific element and
  // Safari answers it correctly. The call is still made and still checked.
  if (webkit.webkitSupportsPresentationMode?.("picture-in-picture") === false) {
    return { ok: false, message: "this video cannot be detached" };
  }
  try {
    webkit.webkitSetPresentationMode("picture-in-picture");
  } catch (thrown) {
    return { ok: false, message: reason(thrown, "picture-in-picture was refused") };
  }
  // Set synchronously by Safari, so this reads the outcome rather than assuming
  // it — the measurement the module comment insists on.
  return webkit.webkitPresentationMode === "picture-in-picture"
    ? { ok: true, message: "playing in picture-in-picture" }
    : { ok: false, message: "picture-in-picture did not take effect" };
}

// ---------------------------------------------------------------------------
// Fullscreen
// ---------------------------------------------------------------------------

export function isFullscreen(element: HTMLElement): boolean {
  return document.fullscreenElement === element;
}

export async function toggleFullscreen(element: HTMLElement): Promise<PresentationResult> {
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
      return { ok: true, message: "" };
    } catch (thrown) {
      return { ok: false, message: reason(thrown, "could not leave fullscreen") };
    }
  }

  if (typeof element.requestFullscreen !== "function") {
    return { ok: false, message: "this platform does not offer fullscreen" };
  }

  try {
    // `navigationUI: "hide"` is a hint the specification permits ignoring, and
    // every engine here does something sensible with or without it.
    await element.requestFullscreen({ navigationUI: "hide" });
    return { ok: true, message: "" };
  } catch (thrown) {
    return { ok: false, message: reason(thrown, "fullscreen was refused") };
  }
}

/**
 * Watches for fullscreen ending by any route.
 *
 * Escape, the window manager, and another element taking over all leave
 * fullscreen without going back through {@link toggleFullscreen}, and a player
 * that kept a "leave fullscreen" item ticked afterwards would be lying about its
 * own state. Returns an unsubscribe.
 */
export function watchFullscreen(listener: () => void): () => void {
  const abort = new AbortController();
  document.addEventListener("fullscreenchange", listener, { signal: abort.signal });
  // Safari fires only the prefixed event. Both are wired; a build that sends
  // both calls the listener twice, which is harmless because the listener reads
  // the current state rather than toggling.
  document.addEventListener("webkitfullscreenchange", listener, { signal: abort.signal });
  return () => abort.abort();
}

/** Watches for picture-in-picture ending from the floating window's own button. */
export function watchPictureInPicture(
  video: HTMLVideoElement,
  listener: () => void,
): () => void {
  const abort = new AbortController();
  for (const event of [
    "enterpictureinpicture",
    "leavepictureinpicture",
    "webkitpresentationmodechanged",
  ]) {
    video.addEventListener(event, listener, { signal: abort.signal });
  }
  return () => abort.abort();
}

function reason(thrown: unknown, fallback: string): string {
  if (thrown instanceof Error && thrown.message) return `${fallback}: ${thrown.message}`;
  return fallback;
}
