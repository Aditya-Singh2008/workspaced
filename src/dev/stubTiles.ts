/**
 * Opens tiles backed by the dev stub plugin. **Dev builds only.**
 *
 * Phase 02's verification starts with "open several instances of the stub
 * plugin, split them in every direction, stack two as tabs…". Without this
 * that would mean keeping a directory of `.selftest` files around; with it the
 * tiling shell can be exercised from a cold start, on any machine, in two
 * clicks.
 *
 * The handles are in-memory, so nothing touches disk and closing a tile
 * releases everything.
 */

import { createMemoryFileHandle } from "../files";
import { STUB_EXTENSION, STUB_MIME_TYPE } from "../viewers/dev/stub";
import { useWorkspaceStore } from "../store";

let counter = 0;

/** Opens one stub tile and returns the workspace client id, if it resolved. */
export function openStubTile(): string | null {
  counter += 1;
  const handle = createMemoryFileHandle({
    name: `stub-${counter}.${STUB_EXTENSION}`,
    bytes: new TextEncoder().encode(`stub tile ${counter}`),
    mimeType: STUB_MIME_TYPE,
  });
  return useWorkspaceStore.getState().openFile(handle)?.id ?? null;
}

export function openStubTiles(count: number): void {
  for (let index = 0; index < count; index += 1) openStubTile();
}

/**
 * Opens the PDF plugin's self-test fixture as a real tile.
 *
 * Same argument as the stub tiles, for the PDF viewer instead of the tiling
 * shell: most of what needs checking there ("does inversion read well", "does
 * zoom stay cursor-centred", "does fast scrolling keep up") can only be judged
 * by looking, and this makes looking possible without a sample PDF on the
 * machine. It is a two-page document; a long one is still needed to judge
 * scrolling.
 */
export async function openFixturePdfTile(): Promise<string | null> {
  const { buildFixturePdf } = await import("../viewers/pdf/dev/fixture");
  counter += 1;
  const handle = createMemoryFileHandle({
    name: `fixture-${counter}.pdf`,
    bytes: buildFixturePdf(),
    mimeType: "application/pdf",
  });
  return useWorkspaceStore.getState().openFile(handle)?.id ?? null;
}

/**
 * Opens one tile per built-in image fixture.
 *
 * Same argument again, for phase 04a. Most of what needs checking in an image
 * viewer can only be judged by looking — whether zoom stays cursor-centred,
 * whether an SVG is still crisp at 800%, whether an animation plays at the right
 * rate, whether the checkerboard reads as transparency — and this makes looking
 * possible with no sample files on the machine.
 *
 * Four tiles, chosen to cover the four things that behave differently: a still
 * raster, a vector, an animation, and a format decoded by this app rather than
 * by the platform. Folder browsing and the slideshow cannot be exercised this
 * way — an in-memory handle has no directory — and need real files on disk.
 */
export async function openFixtureImageTiles(): Promise<void> {
  const fixtures = await import("../viewers/image/dev/fixtures");

  const png = await fixtures.encodedPattern("image/png", 256);
  const files: readonly (readonly [string, Uint8Array | null, string])[] = [
    ["pattern.png", png, "image/png"],
    ["pattern.svg", fixtures.buildSvg(256), "image/svg+xml"],
    ["animated.gif", fixtures.buildAnimatedGif(256), "image/gif"],
    ["pattern.tif", fixtures.buildTiff(256), "image/tiff"],
  ];

  for (const [name, bytes, mimeType] of files) {
    if (!bytes) continue;
    counter += 1;
    const handle = createMemoryFileHandle({
      name: `${counter}-${name}`,
      bytes,
      mimeType,
    });
    useWorkspaceStore.getState().openFile(handle);
  }
}

/**
 * Opens a tile on a video the platform encoded a moment ago.
 *
 * The same argument once more, for phase 04b — and it is *most* true here. Every
 * other plugin's fixtures can be built byte by byte; a playable film cannot, and
 * nobody keeps one in a repository. `MediaRecorder` produces a real, short,
 * genuinely decodable WebM, which is enough to judge the things only looking can
 * judge: whether the scrubber tracks the pointer, whether the transport keys
 * feel right, whether captions land where they should.
 *
 * Returns `null` when the platform has no recorder — WKWebView has none — in
 * which case checking playback needs a real file on disk. The handmade container
 * fixtures are deliberately not offered here: they parse and do not play, so
 * opening one would produce a tile showing the codec error, which is a thing to
 * test in the self-test rather than to look at.
 */
export async function openFixtureVideoTile(): Promise<string | null> {
  const { recordVideo } = await import("../viewers/video/dev/fixtures");
  const recording = await recordVideo();
  if (!recording.ok) {
    console.warn(`[dev] no video fixture: ${recording.reason}`);
    return null;
  }
  const recorded = recording.video;

  counter += 1;
  // The recorder's own container, not the one that was asked for — webkit2gtk
  // returns MP4. A handle labelled `video/webm` holding MP4 bytes is refused by
  // the engine that produced them.
  const handle = createMemoryFileHandle({
    name: `fixture-${counter}.${recorded.extension}`,
    bytes: recorded.bytes,
    mimeType: recorded.mimeType,
  });
  return useWorkspaceStore.getState().openFile(handle)?.id ?? null;
}
