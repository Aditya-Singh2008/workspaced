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
 * **Do not extend this list by reading pdf.js.** Three attempts to do that
 * missed `Promise.try`, then `Uint8Array.prototype.toHex`, then
 * `Map.prototype.getOrInsertComputed` — each one a separate bug report from a
 * Mac, because each time the list named the newest API someone happened to
 * notice rather than the newest one present. **Derive it**, with the two steps
 * below; they take a couple of minutes and they are exhaustive.
 *
 * 1. **Extract every method name pdf.js calls** — `/\.([A-Za-z][\w$]*)\s*\(/g`
 *    over `pdf.mjs` and `pdf.worker.mjs` — and drop the ones that are functions
 *    on any built-in in **Node 20**, which is the old-engine baseline.
 * 2. **Ask a modern WebKit which of the survivors it recognises**, by testing
 *    the same names against the same built-ins from a webkit2gtk page. Anything
 *    WebKit has and Node 20 does not was added in the last couple of years —
 *    which is precisely the window where a macOS system WebKit can be behind,
 *    since WKWebView tracks Safari and not the OS version.
 *
 * What that produced, for `pdfjs-dist@5.5.207` against Safari 17.0 (the webview
 * on the oldest macOS `tauri.conf.json` admits, `minimumSystemVersion: "14.0"`):
 *
 *   - `Promise.try`, `Uint8Array.prototype.toBase64`,
 *     `Uint8Array.prototype.toHex`, `Uint8Array.fromBase64` (Safari 18.2).
 *   - `URL.parse` (18.0).
 *   - `Promise.withResolvers`, `AbortSignal.any`,
 *     `ArrayBuffer.prototype.transferToFixedLength`,
 *     `ReadableStream.prototype[Symbol.asyncIterator]` (17.4).
 *   - `Map.prototype.getOrInsertComputed`, newer still, and on the path every
 *     *render* takes — `PDFPageProxy.render` opens with it.
 *   - `Set.prototype.intersection` (17.0). Exactly at the floor, so covered
 *     here rather than trusted.
 *
 * Every one is called unguarded. Two are on the path every document takes, one
 * is on the path every page takes, and one — the stream iterator, which the
 * section below is about — is on the path every *text layer* takes.
 *
 * The step-2 sweep also reports `Iterator.prototype.take`,
 * `Iterator.prototype.toArray` and `Math.sumPrecise`. None of them are real:
 * the first two are name collisions with pdf.js's own `take()` and `toArray()`,
 * and pdf.js ships its own `Math.sumPrecise`. Check the call sites before
 * adding anything. `Float16Array` and `ImageDecoder` are likewise left alone —
 * both sit behind `FeatureTest`, so pdf.js takes another path without them.
 *
 * ## The derivation has one blind spot: built-ins nothing calls by name
 *
 * `ReadableStream.prototype[Symbol.asyncIterator]` (Safari 17.4) is on this list
 * and no regex over `.method(` could ever have found it, because pdf.js never
 * writes its name. `PDFPageProxy.getTextContent` collects the decoder's answer
 * with `for await (const value of readableStream)`, and that syntax *is* the
 * call: the engine looks up `@@asyncIterator` on the stream and invokes what it
 * finds. On an engine that has no such method it finds `undefined` and throws
 * `TypeError: undefined is not a function`, from inside a `for` loop, naming
 * nothing. It reached a user as "the PDF renders but no text can be selected,
 * and only on macOS" — the same shape as every entry above, one layer further
 * on, because text is the *only* thing that path carries.
 *
 * So step 1 of the derivation misses anything the language calls on a program's
 * behalf. There are not many such protocols, and the way to cover them is to
 * grep for the syntax rather than for a name: `for await` and `yield*` (both
 * `@@asyncIterator`/`@@iterator`), spread and destructuring of anything that is
 * not an array (`@@iterator`), `instanceof` (`@@hasInstance`). Of those,
 * `for await` over a **`ReadableStream`** is the only one that lands on a
 * built-in recent enough to be missing here — the iterables pdf.js spreads are
 * its own arrays and maps, whose protocols are as old as the engine. Both of
 * its `for await` loops are over streams: the text one, and
 * `decompressSignature`'s over a `DecompressionStream`.
 *
 * Then **prove the result** rather than trusting it: delete the whole derived
 * surface from a webkit2gtk page *and* from the worker blob (intercept `Blob`;
 * a worker is another realm) and run `selftest.ts` plus a real font-embedding
 * PDF until both are green. Do all of this whenever the pdf.js pin moves.
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
  // `string | symbol` throughout because one of the entries below is keyed by
  // `Symbol.asyncIterator` rather than by a name.
  type Slots = Record<string | symbol, unknown>;
  const scope = globalThis as unknown as Slots;
  const promises = Promise as unknown as Slots;
  const urls = URL as unknown as Slots;
  const bytes = Uint8Array as unknown as Slots;
  const bytesProto = Uint8Array.prototype as unknown as Slots;
  const buffers = ArrayBuffer.prototype as unknown as Slots;
  const maps = Map.prototype as unknown as Slots;
  const weakMaps = WeakMap.prototype as unknown as Slots;
  const sets = Set.prototype as unknown as Slots;
  const signals = scope["AbortSignal"] as Slots | undefined;
  const streams = (scope["ReadableStream"] as { prototype?: Slots } | undefined)?.prototype;

  // `ReadableStream.prototype.values`, which `for await` reaches through
  // `@@asyncIterator`. Written once and installed under both names below,
  // because the specified `@@asyncIterator` *is* `values` — an engine with one
  // and not the other does not exist, and two implementations of it could drift.
  //
  // Defined inside this function like everything else here: the worker gets
  // this file as text (see `PDF_COMPAT_SOURCE`), so a helper in module scope
  // would be a name that does not exist over there.
  function values(this: ReadableStream, options?: { preventCancel?: boolean }) {
    // Acquired now rather than on the first `next()`, as the specification has
    // it: taking the lock is what makes a second concurrent iteration of the
    // same stream throw instead of silently splitting the chunks between them.
    const reader = this.getReader();
    const preventCancel = Boolean(options?.preventCancel);
    return {
      async next() {
        try {
          const step = await reader.read();
          // The lock has to go back on the last chunk, not just on `return()`:
          // a loop that runs to completion never calls `return()`, and a stream
          // left locked cannot be read or cancelled by anyone afterwards.
          if (step.done) reader.releaseLock();
          return step;
        } catch (thrown) {
          reader.releaseLock();
          throw thrown;
        }
      },
      // `break`, `throw`, and every early exit out of a `for await` land here.
      async return(value?: unknown) {
        if (preventCancel) {
          reader.releaseLock();
        } else {
          // Ordered as the specification orders it: start the cancel while the
          // lock is still held, release, then wait. Releasing first would let
          // the cancel reject on a reader that no longer owns the stream.
          const cancelled = reader.cancel(value);
          reader.releaseLock();
          await cancelled;
        }
        return { value, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  // One table, used twice: to fill, and then to re-check. A polyfill that did
  // not take has to be as visible as one that was never written.
  const needed: [Slots | undefined, string | symbol, string, unknown][] = [
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
      maps,
      "getOrInsertComputed",
      "Map.prototype.getOrInsertComputed",
      function (this: Map<unknown, unknown>, key: unknown, compute: (key: unknown) => unknown) {
        if (this.has(key)) return this.get(key);
        const value = compute(key);
        this.set(key, value);
        return value;
      },
    ],
    [
      weakMaps,
      "getOrInsertComputed",
      "WeakMap.prototype.getOrInsertComputed",
      function (this: WeakMap<object, unknown>, key: object, compute: (key: object) => unknown) {
        if (this.has(key)) return this.get(key);
        const value = compute(key);
        this.set(key, value);
        return value;
      },
    ],
    [
      sets,
      "intersection",
      "Set.prototype.intersection",
      // The specified version walks whichever collection is smaller; for the
      // one call site in pdf.js the result is the same either way.
      function (this: Set<unknown>, other: { has(value: unknown): boolean }) {
        const shared = new Set<unknown>();
        for (const value of this) if (other.has(value)) shared.add(value);
        return shared;
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
    [streams, "values", "ReadableStream.prototype.values", values],
    [streams, Symbol.asyncIterator, "ReadableStream.prototype[Symbol.asyncIterator]", values],
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
