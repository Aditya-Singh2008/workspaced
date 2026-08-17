/**
 * The JavaScript built-ins pdf.js 5.5.207 uses and this app's oldest supported
 * webview does not have.
 *
 * ## Why this file exists
 *
 * AGENTS.md records the engine floor as "`Promise.withResolvers`, i.e.
 * webkit2gtk 2.44+ / Safari 17.4+ / Chromium 119+". That was measured by
 * reading pdf.js for the *newest* API someone had noticed, and it was wrong —
 * `pdfjs-dist@5.5.207` also calls **`Promise.try`**, which WebKit shipped in
 * Safari 18.2, and **`URL.parse`**, which it shipped in Safari 18.0. On macOS
 * that is not an academic gap: WKWebView runs the *system* WebKit, and a
 * Sonoma machine that has not taken a Safari update is on 17.x.
 *
 * The way it failed is worth writing down, because it is the failure mode this
 * plugin keeps meeting from different directions. `MessageHandler` dispatches
 * every request that expects an answer through `Promise.try(action, data)` —
 * so on Safari 17 the *first* such request, `GetDocRequest`, threw
 * `TypeError: Promise.try is not a function` inside the worker's `message`
 * listener. Nothing catches that: the reply is never sent, the main thread's
 * `workerIdPromise` never settles, and `getDocument().promise` waits forever.
 * The worker had already announced itself, so every diagnostic said the worker
 * was healthy. It reached a user as "PDFs are stuck on loading, and only on
 * macOS", and it survived a fix aimed at the custom-scheme worker load because
 * it has nothing to do with the scheme — a Mac on Safari 17 would hang in
 * `tauri dev` too.
 *
 * ## What is and is not covered
 *
 * The four below are everything `pdfjs-dist@5.5.207` reaches for above Safari
 * 17.0, which is the webview on the oldest macOS `tauri.conf.json` admits
 * (`minimumSystemVersion: "14.0"`). The scan behind that claim is worth
 * repeating whenever the pin moves, because the list is not stable between
 * pdf.js releases:
 *
 *   - `Promise.try` (Safari 18.2) and `URL.parse` (18.0) — both **unguarded**,
 *     and both on the document-open path.
 *   - `Promise.withResolvers` (17.4) and `AbortSignal.any` (17.4) — unguarded,
 *     and missing on macOS 14.0–14.3.
 *   - `Math.sumPrecise` — pdf.js ships its own polyfill for it. Left alone.
 *   - `Float16Array` and `ImageDecoder` — both behind `FeatureTest`, so pdf.js
 *     takes another path when they are absent. Left alone.
 *   - `AbortSignal.any`, `Set.prototype.intersection`, `findLast`, `at`,
 *     `replaceAll`, `structuredClone`, `FinalizationRegistry` — at or below the
 *     floor. Left alone.
 *
 * Polyfilling rather than raising `minimumSystemVersion` is the deliberate
 * choice: these are four small functions, and the alternative refuses to
 * install on machines whose only problem is an un-updated Safari.
 *
 * ## The worker realm needs them too, and gets them the same way
 *
 * A worker is a separate global scope, so installing on the main thread does
 * nothing for the thread that actually decodes. Because `pdfjs.ts` builds the
 * worker out of inlined source, {@link PDF_COMPAT_SOURCE} can simply be put in
 * front of it — one implementation, both realms, no second copy to keep in
 * step.
 */

/**
 * Installs the missing built-ins on whichever global scope calls it.
 *
 * **This function is stringified** (see {@link PDF_COMPAT_SOURCE}) and run
 * inside a worker that shares none of this module's scope. It must therefore
 * stay entirely self-contained: no imports, no module-level constants, no
 * helpers — a minifier renames those, and the renamed name does not exist over
 * there. Globals are fine; nothing else is.
 *
 * Idempotent, and it records what it had to fill on `globalThis` so
 * {@link pdfCompatFilled} can report the engine rather than guess at it.
 */
export function installPdfCompat(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const filled: string[] = [];

  const promises = Promise as unknown as Record<string, unknown>;

  if (typeof promises["withResolvers"] !== "function") {
    promises["withResolvers"] = function () {
      let resolve!: (value: unknown) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    filled.push("Promise.withResolvers");
  }

  if (typeof promises["try"] !== "function") {
    // Rejects when `fn` throws synchronously, because the executor throwing is
    // how a `new Promise` rejects — which is the entire point of the method.
    promises["try"] = function (fn: (...args: unknown[]) => unknown, ...args: unknown[]) {
      return new Promise((resolve) => {
        resolve(fn(...args));
      });
    };
    filled.push("Promise.try");
  }

  const urls = URL as unknown as Record<string, unknown>;

  if (typeof urls["parse"] !== "function") {
    // `unknown` rather than `string`: pdf.js passes `window.location` as the
    // base, and the constructor stringifies it the same way the real method
    // does.
    urls["parse"] = function (url: unknown, base?: unknown) {
      try {
        return base === undefined || base === null
          ? new URL(url as string)
          : new URL(url as string, base as string);
      } catch {
        return null;
      }
    };
    filled.push("URL.parse");
  }

  const signals = scope["AbortSignal"] as Record<string, unknown> | undefined;

  if (signals && typeof signals["any"] !== "function") {
    signals["any"] = function (sources: Iterable<AbortSignal>) {
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
        // the moment any one of them fires, which is the part a naive version
        // of this leaks.
        source.addEventListener("abort", () => controller.abort(source.reason), {
          once: true,
          signal: controller.signal,
        });
      }
      return controller.signal;
    };
    filled.push("AbortSignal.any");
  }

  const already = (scope["__pdfCompatFilled"] as string[] | undefined) ?? [];
  scope["__pdfCompatFilled"] = already.concat(filled);
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

/**
 * What had to be filled in on *this* thread, for the dev self-test's report.
 *
 * Empty is the good answer and means the webview is current. Anything in it
 * names an engine older than pdf.js expects, which is the single most useful
 * fact to have when a platform starts behaving differently from the others.
 */
export function pdfCompatFilled(): readonly string[] {
  return ((globalThis as unknown as Record<string, unknown>)["__pdfCompatFilled"] as
    | string[]
    | undefined) ?? [];
}

/**
 * Whether every built-in pdf.js needs is present now.
 *
 * Checked after installing rather than assumed: a polyfill that failed to take
 * would otherwise show up as the same silent hang it was written to prevent.
 */
export function pdfCompatMissing(): readonly string[] {
  const promises = Promise as unknown as Record<string, unknown>;
  const urls = URL as unknown as Record<string, unknown>;
  const signals = (globalThis as unknown as Record<string, unknown>)["AbortSignal"] as
    | Record<string, unknown>
    | undefined;

  const missing: string[] = [];
  if (typeof promises["withResolvers"] !== "function") missing.push("Promise.withResolvers");
  if (typeof promises["try"] !== "function") missing.push("Promise.try");
  if (typeof urls["parse"] !== "function") missing.push("URL.parse");
  if (signals && typeof signals["any"] !== "function") missing.push("AbortSignal.any");
  return missing;
}

// Installed on import, and this module is imported above `pdfjs-dist` in
// `pdfjs.ts`: ES modules evaluate in the order they are declared, so the
// built-ins are in place before pdf.js's module body runs.
installPdfCompat();
