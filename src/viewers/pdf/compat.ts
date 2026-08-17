/**
 * The JavaScript built-ins pdf.js 5.5.207 uses and this app's oldest supported
 * webview does not have.
 *
 * ## Why this file exists
 *
 * AGENTS.md recorded the engine floor as "`Promise.withResolvers`, i.e.
 * webkit2gtk 2.44+ / Safari 17.4+ / Chromium 119+". That was arrived at by
 * reading pdf.js for the *newest* API someone had noticed, and it was wrong:
 * `pdfjs-dist@5.5.207` also calls `Promise.try`, `Uint8Array.prototype.toHex`
 * and five others that WebKit shipped later. On macOS that is not academic —
 * WKWebView runs the *system* WebKit, which moves with Safari and not with the
 * OS version, so a Sonoma machine that has not taken a Safari update is on 17.x
 * while every other platform in the fleet is years ahead.
 *
 * The way it failed is the reason this plugin now distrusts its own worker.
 * `MessageHandler` dispatches every request that expects an answer through
 * `Promise.try`, so the first one — `GetDocRequest` — threw
 * `TypeError: Promise.try is not a function` inside the worker's `message`
 * listener. Nothing catches that: no reply is sent, and `getDocument().promise`
 * waits forever. Fixing it exposed the next one behind it, `toHex`, which
 * builds the fingerprint pair every open waits for. Both reached a user as
 * "PDFs are stuck on loading, and only on macOS".
 *
 * ## What is and is not covered
 *
 * Everything `pdfjs-dist@5.5.207` reaches for above Safari 17.0, which is the
 * webview on the oldest macOS `tauri.conf.json` admits
 * (`minimumSystemVersion: "14.0"`):
 *
 *   - **Safari 18.2** — `Promise.try`, `Uint8Array.prototype.toBase64`,
 *     `Uint8Array.prototype.toHex`, `Uint8Array.fromBase64`.
 *   - **Safari 18.0** — `URL.parse`.
 *   - **Safari 17.4** — `Promise.withResolvers`, `AbortSignal.any`,
 *     `ArrayBuffer.prototype.transferToFixedLength`.
 *
 * Every one is called unguarded, and two are on the path every document takes.
 *
 * Left alone, deliberately: `Math.sumPrecise`, which pdf.js polyfills itself;
 * `Float16Array` and `ImageDecoder`, which sit behind `FeatureTest` so pdf.js
 * takes another path without them; and `Set.prototype.intersection`,
 * `findLast`, `at`, `replaceAll`, `structuredClone` and `FinalizationRegistry`,
 * which are at or below the floor.
 *
 * **This list was arrived at twice by reading and was wrong both times**, each
 * time costing a round trip to a Mac. Reading finds candidates; it does not
 * finish the job. The way to finish is to delete the whole post-17.0 surface
 * from a webkit2gtk page *and* from the worker blob (intercept `Blob`; a worker
 * is another realm) and run `selftest.ts` plus a real font-embedding PDF until
 * both are green. Do that whenever the pdf.js pin moves.
 *
 * Polyfilling rather than raising `minimumSystemVersion` is the deliberate
 * choice: these are small functions, and the alternative refuses to install on
 * machines whose only problem is an un-updated Safari.
 *
 * ## The worker realm needs them too, and is asked rather than assumed
 *
 * A worker is a separate global scope, so installing on the main thread does
 * nothing for the thread that actually decodes. Because `pdfjs.ts` builds the
 * worker out of inlined source, {@link PDF_COMPAT_SOURCE} is put in front of it
 * — one implementation, both realms.
 *
 * And then the worker is *asked*. Running there, this function posts what it
 * found and what is still missing as the worker's first message, before pdf.js
 * evaluates; {@link installPdfCompat} is the only thing in the app that can
 * answer "is the decoder's realm actually fit to decode in". `pdfjs.ts` reads
 * that report and refuses a worker that is not, which turns every future
 * version of this bug — including one where the shim fails to arrive for a
 * reason nobody has thought of yet — into a main-thread fallback that works,
 * plus a sentence naming the built-in.
 */

/** What {@link installPdfCompat} found, from whichever realm it ran in. */
export interface PdfCompatReport {
  /** Built-ins that were absent and have been supplied. */
  readonly filled: readonly string[];
  /** Built-ins still absent afterwards. Non-empty means pdf.js will break. */
  readonly missing: readonly string[];
}

/**
 * Installs the missing built-ins on whichever global scope calls it.
 *
 * **This function is stringified** (see {@link PDF_COMPAT_SOURCE}) and run
 * inside a worker that shares none of this module's scope. It must therefore
 * stay entirely self-contained: no imports, no module-level constants, no
 * helpers defined outside its own body — a minifier renames those, and the
 * renamed name does not exist over there. Globals are fine; nothing else is.
 *
 * Idempotent.
 */
export function installPdfCompat(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const promises = Promise as unknown as Record<string, unknown>;
  const urls = URL as unknown as Record<string, unknown>;
  const bytes = Uint8Array as unknown as Record<string, unknown>;
  const bytesProto = Uint8Array.prototype as unknown as Record<string, unknown>;
  const buffers = ArrayBuffer.prototype as unknown as Record<string, unknown>;
  const signals = scope["AbortSignal"] as Record<string, unknown> | undefined;

  // One table, used twice: to fill, and then to re-check. A polyfill that did
  // not take has to be as visible as one that was never written.
  const needed: [Record<string, unknown> | undefined, string, string, unknown][] = [
    [
      promises,
      "withResolvers",
      "Promise.withResolvers",
      function () {
        let resolve!: (value: unknown) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<unknown>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      },
    ],
    [
      promises,
      "try",
      "Promise.try",
      // Rejects when `fn` throws synchronously, because an executor that throws
      // is how a `new Promise` rejects — which is the whole point of the method.
      function (fn: (...args: unknown[]) => unknown, ...args: unknown[]) {
        return new Promise((resolve) => {
          resolve(fn(...args));
        });
      },
    ],
    [
      urls,
      "parse",
      "URL.parse",
      // `unknown` rather than `string`: pdf.js passes `window.location` as the
      // base, and the constructor stringifies it as the real method does.
      function (url: unknown, base?: unknown) {
        try {
          return base === undefined || base === null
            ? new URL(url as string)
            : new URL(url as string, base as string);
        } catch {
          return null;
        }
      },
    ],
    [
      bytesProto,
      "toBase64",
      "Uint8Array.prototype.toBase64",
      function (this: Uint8Array) {
        // Chunked: `String.fromCharCode.apply` on a whole embedded font blows
        // the argument limit, and this is called with exactly that.
        let binary = "";
        for (let at = 0; at < this.length; at += 0x8000) {
          binary += String.fromCharCode.apply(null, Array.from(this.subarray(at, at + 0x8000)));
        }
        return btoa(binary);
      },
    ],
    [
      bytesProto,
      "toHex",
      "Uint8Array.prototype.toHex",
      function (this: Uint8Array) {
        let hex = "";
        for (let at = 0; at < this.length; at++) {
          hex += (this[at] as number).toString(16).padStart(2, "0");
        }
        return hex;
      },
    ],
    [
      bytes,
      "fromBase64",
      "Uint8Array.fromBase64",
      function (encoded: string) {
        const binary = atob(encoded);
        const out = new Uint8Array(binary.length);
        for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at);
        return out;
      },
    ],
    [
      buffers,
      "transferToFixedLength",
      "ArrayBuffer.prototype.transferToFixedLength",
      // A copy, not a transfer: detaching the original cannot be emulated on an
      // engine that lacks this method. Both of pdf.js's call sites trim a
      // scratch buffer they drop immediately, so the only cost is that the
      // original lives until the collector takes it.
      function (this: ArrayBuffer, length?: number) {
        return this.slice(0, length ?? this.byteLength);
      },
    ],
    [
      signals,
      "any",
      "AbortSignal.any",
      function (sources: Iterable<AbortSignal>) {
        const controller = new AbortController();
        const list = Array.from(sources);
        for (const source of list) {
          if (source.aborted) {
            controller.abort(source.reason);
            return controller.signal;
          }
        }
        for (const source of list) {
          // Listening *on* the signal being built is what unregisters the rest
          // the moment any one fires, which a naive version of this leaks.
          source.addEventListener("abort", () => controller.abort(source.reason), {
            once: true,
            signal: controller.signal,
          });
        }
        return controller.signal;
      },
    ],
  ];

  const filled: string[] = [];
  for (const entry of needed) {
    const owner = entry[0];
    if (!owner || typeof owner[entry[1]] === "function") continue;
    owner[entry[1]] = entry[3];
    filled.push(entry[2]);
  }

  const missing: string[] = [];
  for (const entry of needed) {
    const owner = entry[0];
    if (owner && typeof owner[entry[1]] !== "function") missing.push(entry[2]);
  }

  scope["__pdfCompat"] = { filled, missing };

  // In a worker, say so out loud, before pdf.js has evaluated. A worker with no
  // `document` is the only place this branch is taken; `pdfjs.ts` treats the
  // message as the worker's fitness report and declines a worker that fails it.
  const post = scope["postMessage"] as ((message: unknown) => void) | undefined;
  if (typeof post === "function" && typeof scope["document"] === "undefined") {
    post({ __pdfCompat: { filled, missing } });
  }
}

/**
 * {@link installPdfCompat} as source text, for prepending to the worker blob.
 *
 * A stringified function rather than a second copy of the code, so the two
 * realms cannot drift apart. Wrapped in parentheses because the compiled form
 * may be a declaration or an expression depending on the bundler's mood, and
 * both are callable that way.
 */
export const PDF_COMPAT_SOURCE = `(${installPdfCompat.toString()})();\n`;

/** What this thread had to fill in, and what it could not. */
export function pdfCompatHere(): PdfCompatReport {
  return (
    ((globalThis as unknown as Record<string, unknown>)["__pdfCompat"] as
      | PdfCompatReport
      | undefined) ?? { filled: [], missing: [] }
  );
}

/** A short human-readable summary of a report, for error details and the self-test. */
export function describePdfCompat(report: PdfCompatReport): string {
  if (report.missing.length > 0) return `missing ${report.missing.join(", ")}`;
  if (report.filled.length > 0) return `polyfilled ${report.filled.join(", ")}`;
  return "all present natively";
}

// Installed on import, and this module is imported above `pdfjs-dist` in
// `pdfjs.ts`: ES modules evaluate in the order they are declared, so the
// built-ins are in place before pdf.js's module body runs.
installPdfCompat();
