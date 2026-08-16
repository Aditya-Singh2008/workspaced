/**
 * Runs the full Viewer Plugin lifecycle against the dev stub and reports what
 * happened. **Dev builds only.**
 *
 * This is phase 01's verification step 2 made executable: the contract is only
 * proven implementable if something actually registers a plugin, mounts it,
 * takes a thumbnail, round-trips state and unmounts cleanly. Doing it against a
 * stub rather than a real viewer is the point — it means the contract was
 * designed for many file types rather than shaped around the first one.
 *
 * Also covers the two behaviors the shell depends on but no plugin owns:
 * fallback resolution for unmatched files, and a failing mount rendering as a
 * tile-local error.
 */

import { check, report, type SelfTestCheck, type SelfTestReport } from "../../dev/selftest";
import { createMemoryFileHandle } from "../../files";
import type { ViewerInstance } from "../contract";
import { disposeViewer, isViewerDisposed, mountViewer } from "../instances";
import { resolveViewerPlugin } from "../registry";
import { FALLBACK_PLUGIN_ID } from "../fallback";
import {
  STUB_EXTENSION,
  STUB_FAIL_MARKER,
  STUB_MIME_TYPE,
  STUB_PLUGIN_ID,
  StubViewerInstance,
} from "./stub";

/**
 * Mounts into a detached, off-screen container so the running workspace is
 * untouched. The element is still attached to the document because layout-
 * dependent plugins need a real box; it is removed in `finally`.
 */
function createScratchContainer(): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-10000px;top:0;width:400px;height:300px;pointer-events:none;";
  document.body.append(container);
  return container;
}

const SELF_TEST_TITLE = "viewer plugin contract";

export async function runContractSelfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [];
  const container = createScratchContainer();
  const clientId = "selftest";
  let instance: ViewerInstance | null = null;

  const handle = createMemoryFileHandle({
    name: `sample.${STUB_EXTENSION}`,
    bytes: new TextEncoder().encode("hello world"),
    mimeType: STUB_MIME_TYPE,
  });

  try {
    // 1. Resolution by MIME type. A memory handle is the only source that
    //    carries an authoritative MIME type, which is what makes the
    //    MIME-before-extension path testable at all.
    const byMime = resolveViewerPlugin({ mimeType: STUB_MIME_TYPE });
    checks.push(
      check(
        "resolves by MIME type",
        byMime?.plugin.id === STUB_PLUGIN_ID && byMime.matchedBy === "mime-exact",
        `${byMime?.plugin.id ?? "none"} via ${byMime?.matchedBy ?? "none"}`,
      ),
    );

    // 2. Resolution by extension, the path a native file dialog actually takes.
    const byExtension = resolveViewerPlugin({ extension: STUB_EXTENSION });
    checks.push(
      check(
        "resolves by extension when no MIME type",
        byExtension?.plugin.id === STUB_PLUGIN_ID && byExtension.matchedBy === "extension",
        `${byExtension?.plugin.id ?? "none"} via ${byExtension?.matchedBy ?? "none"}`,
      ),
    );

    // 3. A generic MIME type must not short-circuit extension matching.
    const generic = resolveViewerPlugin({
      mimeType: "application/octet-stream",
      extension: STUB_EXTENSION,
    });
    checks.push(
      check(
        "ignores uninformative MIME types",
        generic?.plugin.id === STUB_PLUGIN_ID && generic.matchedBy === "extension",
        `${generic?.plugin.id ?? "none"} via ${generic?.matchedBy ?? "none"}`,
      ),
    );

    // 4. Unmatched files fall through to the fallback viewer, not an error.
    const unmatched = resolveViewerPlugin({ extension: "definitely-not-a-real-type" });
    checks.push(
      check(
        "unmatched file falls back",
        unmatched?.plugin.id === FALLBACK_PLUGIN_ID && unmatched.matchedBy === "fallback",
        `${unmatched?.plugin.id ?? "none"} via ${unmatched?.matchedBy ?? "none"}`,
      ),
    );

    // 5. Mount.
    const mounted = await mountViewer({ clientId, container, file: handle });
    checks.push(
      check(
        "mounts",
        mounted.ok && container.childElementCount > 0,
        mounted.ok
          ? `${mounted.plugin.id}, ${container.childElementCount} child node(s)`
          : `failed: ${mounted.error.message}`,
      ),
    );
    if (!mounted.ok) return report(SELF_TEST_TITLE, checks);
    instance = mounted.instance;

    checks.push(
      check(
        "reports ready status and capabilities",
        instance.status === "ready" && instance.capabilities.thumbnail,
        `status=${instance.status} capabilities=${JSON.stringify(instance.capabilities)}`,
      ),
    );

    // 6. Thumbnail.
    const thumbnail = await instance.thumbnail({ maxWidth: 96, maxHeight: 96 });
    checks.push(
      check(
        "produces a thumbnail",
        thumbnail.kind === "bitmap" && thumbnail.width > 0,
        `kind=${thumbnail.kind}`,
      ),
    );

    // 7. State round-trip. Serialize, mutate, restore, expect the original back.
    const saved = instance.serialize();
    await instance.restore({ note: "scribbled over", views: 999 });
    await instance.restore(saved);
    const roundTripped = JSON.stringify(instance.serialize()) === JSON.stringify(saved);
    checks.push(
      check(
        "serializes and restores state",
        roundTripped,
        `${JSON.stringify(saved)} -> ${JSON.stringify(instance.serialize())}`,
      ),
    );

    // 8. Malformed state must fall back to defaults, not throw.
    let survivedGarbage = true;
    try {
      await instance.restore({ note: 42, unexpected: true });
      await instance.restore(null);
    } catch {
      survivedGarbage = false;
    }
    checks.push(
      check("tolerates malformed restore state", survivedGarbage, "restored null and a wrong-typed object"),
    );
    await instance.restore(saved);

    // 9. A failing mount renders as a tile-local error, not a thrown exception.
    const failingContainer = createScratchContainer();
    try {
      const failing = await mountViewer({
        clientId: "selftest-failure",
        container: failingContainer,
        file: createMemoryFileHandle({
          name: `broken.${STUB_EXTENSION}`,
          bytes: new TextEncoder().encode(STUB_FAIL_MARKER),
          mimeType: STUB_MIME_TYPE,
        }),
      });
      checks.push(
        check(
          "load failure surfaces as a tile-local error",
          !failing.ok &&
            failing.error.code === "corrupt" &&
            failingContainer.childElementCount === 0,
          failing.ok
            ? "unexpectedly succeeded"
            : `code=${failing.error.code}, container cleared=${failingContainer.childElementCount === 0}`,
        ),
      );
    } finally {
      await disposeViewer("selftest-failure");
      failingContainer.remove();
    }

    // 10. An unmatched file mounts the fallback viewer for real — not just
    //     resolving to it — and gets an icon rather than a failed thumbnail.
    const fallbackContainer = createScratchContainer();
    try {
      const unmatchedFile = createMemoryFileHandle({
        name: "mystery.qqq",
        bytes: new TextEncoder().encode("opaque"),
      });
      const fallbackMount = await mountViewer({
        clientId: "selftest-fallback",
        container: fallbackContainer,
        file: unmatchedFile,
      });
      const preview = fallbackMount.ok
        ? await fallbackMount.instance.thumbnail({ maxWidth: 64, maxHeight: 64 })
        : null;
      checks.push(
        check(
          "unmatched file mounts the fallback viewer",
          fallbackMount.ok &&
            fallbackMount.plugin.id === FALLBACK_PLUGIN_ID &&
            fallbackMount.instance.status === "ready" &&
            fallbackContainer.textContent?.includes("mystery.qqq") === true &&
            preview?.kind === "icon",
          fallbackMount.ok
            ? `${fallbackMount.plugin.id}, status=${fallbackMount.instance.status}, thumbnail=${preview?.kind}`
            : `failed: ${fallbackMount.error.message}`,
        ),
      );
      unmatchedFile.release();
    } finally {
      await disposeViewer("selftest-fallback");
      fallbackContainer.remove();
    }

    // 11. Unmount releases everything and empties the container.
    const openBitmapsBefore =
      instance instanceof StubViewerInstance ? instance.openBitmapCount : -1;
    await disposeViewer(clientId);
    const openBitmapsAfter =
      instance instanceof StubViewerInstance ? instance.openBitmapCount : -1;
    checks.push(
      check(
        "unmounts cleanly",
        isViewerDisposed(instance) &&
          container.childElementCount === 0 &&
          openBitmapsAfter === 0,
        `container emptied, open bitmaps ${openBitmapsBefore} -> ${openBitmapsAfter}`,
      ),
    );

    // 12. The shell guarantees dispose() runs exactly once, even if asked twice.
    await disposeViewer(clientId);
    checks.push(check("dispose is idempotent", true, "second disposeViewer() was a no-op"));

    instance = null;
  } catch (thrown) {
    checks.push(
      check(
        "self-test ran to completion",
        false,
        thrown instanceof Error ? thrown.message : String(thrown),
      ),
    );
  } finally {
    await disposeViewer(clientId);
    handle.release();
    container.remove();
  }

  return report(SELF_TEST_TITLE, checks);
}
