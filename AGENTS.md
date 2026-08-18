# AGENTS.md

Root instructions for any coding agent working in this repository. Read this file before touching any code. It defines the architecture, the tech stack, the non-negotiable constraints, and the order in which the `/prompts` phase briefs should be executed.

## What this project is

A standalone desktop digital workspace for viewing, arranging, and lightly editing local files: PDFs, a comprehensive image viewer, and a comprehensive video player, each built as an equally first-class plugin rather than PDF being the "real" viewer with the others bolted on. It replaces an earlier single-file HTML/JS PDF viewer (`index.html`, vendored `pdf.js`) that proved the concept but became unmaintainable once freeform tiling was added by hand. This rebuild keeps every feature that worked and every design decision that was validated, but puts them on an architecture that can hold multiple file types, each with real depth, without collapsing.

## Why we rebuilt instead of patched

The original implementation hand-rolled a binary split tree for tiling, manual drag math for resizing and rearranging panes, and imperative DOM synchronization, all in one growing vanilla JS file. This produced race conditions between resize events and re-renders, and made every new feature (annotation, clipboard, search) harder to add without breaking the last one. None of that was specific to PDFs. Generalizing to more file types on the same foundation would have compounded the problem, not fixed it.

## Core architectural principle

Three layers, strictly separated:

1. **Shell** - file-type agnostic. Tiling/docking, toolbar, command palette, global search UI, clipboard UI, keybind reference, session persistence, window chrome. The shell only ever talks to viewers through the Viewer Plugin contract below. It must never import or reference a specific file type's logic directly.

2. **Viewer Plugin contract** - the interface every file-type module implements. This is the seam that makes the app extensible. Defined precisely in `prompts/01-scaffold-and-core-architecture.md`.

3. **Viewer Plugins** - one module per file type, each satisfying the contract independently. PDF first (full feature parity with the original), then a comprehensive image viewer covering the format range and feature depth of top-tier image viewing applications, then a comprehensive video player covering the format range and feature depth of top-tier media players. Image and video are independent of each other, sharing nothing beyond the contract, so they can be built in parallel.

If a feature only makes sense for one file type (PDF's dark-mode invert switch, a video player's frame-accurate transport controls), it lives inside that plugin. If a feature is useful across file types (copy, search, annotate, tile, persist), it lives in the shell and each plugin opts in by implementing the relevant part of the contract.

## Tech stack (decided, do not re-litigate without strong reason)

- **Shell runtime**: Tauri 2.x. Rust backend for real filesystem access, native window management, native file dialogs. OS webview for rendering, no bundled Chromium.
- **Frontend**: React + TypeScript.
- **Docking/tiling**: **dockview** (`dockview-react` 7.x, which pulls in `dockview` and `dockview-core`), chosen in phase 02 and confirmed to cover every required interaction natively: horizontal and vertical splits, drag-to-dock on any edge with a live drop-zone overlay, drag-to-stack as tabs, resizable sashes with a minimum panel size, group maximization (used for monocle), and `toJSON`/`fromJSON` layout serialization. Themed entirely through `--dv-*` custom properties bound to our tokens in `src/theme/theme.css`, so it ships no second palette. Two non-default options are load-bearing: `dndStrategy: "pointer"` (pointer events rather than HTML5 drag-and-drop, which is the unreliable path under webkit2gtk) and `defaultRenderer: "always"` (a tile tabbed behind another stays mounted, so decoders and canvases are not thrown away on every tab switch). Do not add a second docking library or hand-roll any part of this.
- **State management**: Zustand for client list, layout state, preferences, clipboard history. PDF/image/video decode state stays outside the reactive store, referenced by ID, since it is not serializable and should not trigger re-renders.
- **PDF rendering**: `pdf.js` (`pdfjs-dist`) as an npm dependency, not vendored. **Pinned to 5.5.207 — exactly, with no caret — and both bounds are load-bearing.** The exactness is part of the pin, not pedantry: this said "pinned" for a long time while `package.json` declared `^5.5.207`, which permits 5.6.83 and therefore permits the advisory below. `npm install` resolving through the lockfile hid it. Do not put the caret back. It is the newest 5.x release outside GHSA-hq66-cqwq-w95j (arbitrary JavaScript execution on opening a malicious PDF, `>=5.6.83 <6.2.108`), which is not a theoretical advisory in an app whose job is opening files the user did not write. Going *forward* to the first patched 6.x is what the audit suggests and is wrong here: 6.x requires Iterator Helpers, which webkit2gtk only ships from 2.48, so it would silently drop Ubuntu 24.04 LTS for no feature this plugin uses. Re-check when a 6.x lands that the Linux floor below can run. The reasoning lives in `src/viewers/pdf/pdfjs.ts` as well, next to the import.
- **PDF annotation authoring and export**: `pdf-lib`. Produces real PDF annotation objects (Highlight, FreeText, Ink, Text/Popup, Stamp, etc.) via its low-level object API where high-level helpers are insufficient, rather than flattening marks into page content. See "Annotation model and export" below for the reasoning and the one deliberate exception (pasted images as Stamp annotations).
- **Styling**: Tailwind CSS with a shared theme file encoding the established visual language (see below). No component hand-styles the palette or corner radius independently.
- **Persistence**: Tauri's filesystem and store plugins. Real file paths and handles, not the browser's File System Access API placeholder-prompt fallback.
- **OCR**: lazy-loaded, optional. Reference implementation: `tesseract.js`. Never bundled into the core app; loaded on demand through the plugin hook (`src/viewers/pdf/ocr.ts`), and the extraction action says plainly that it is unavailable when no hook is registered.
- **Video playback engine**: **decided, specified, and not built.** The decision is `libmpv` (the mpv media player core), driven from Rust in `src-tauri/video/`, rendered through a native surface positioned over its tile, not the webview's `<video>` element, to replace a native-`<video>` implementation that could not meet load-time or smoothness requirements. `prompts/04b-video-viewer-plugin.md` holds the embedding architecture and `prompts/04b-refactor-migration.md` was to hold the migration — **that file does not exist**, which is the first thing to fix if you are the one picking this up.

  **What is actually in the repository is the superseded native-`<video>` engine.** There is no `src-tauri/video/`, no libmpv dependency in `src-tauri/Cargo.toml`, and no mpv code anywhere; `src/viewers/video/` drives an `HTMLVideoElement` fed by `src-tauri/src/media.rs`, a loopback HTTP range server. Read any paragraph below that speaks of the video engine in the present tense — the module map, "Video codec coverage", the Wayland note, the libmpv build prerequisites — as describing the *target*, not the code. This section said otherwise until a macOS compliance review went looking for the NSView embedding path and found nothing to review.

  Two decisions inside the target are already made and should not be re-litigated when it is built: **raw FFI** (`libmpv2-sys`-generated bindings against `client.h`, hand-written safe wrappers on top) rather than the `tauri-plugin-libmpv` crate — Phase 4b's evaluation found it keys one mpv instance per *window* rather than per tile, embeds only through `--wid` with no sub-rect concept, and hard-errors on Wayland in its own source — and no native-`<video>` fallback once it lands.

## Established visual language (carries forward unchanged)

Near-black background (`#0d1117` to `#0F111A` range), off-white foreground text (never pure white), muted gray-blue for secondary/inactive text (`#818D92` range), a single functional accent color used only for focus/active/selection states (`#2979FF` range), sparing use of secondary colors for functional signaling only (errors, warnings, status).

**Subtle is not the same as invisible.** `--color-border` sits at roughly 1.2:1 against the background, which is correct for dividing content *inside* a panel and unusable for dividing the panels themselves — a 1px line at that contrast cannot be seen on a real display. Structural edges use `--color-tile-border` (~1.9:1) instead. Phase 02 shipped this wrong twice before measuring it, so `shell/docking/selftest.ts` now asserts the contrast ratio rather than merely asserting that a border exists. When adding a border, ask which of the two jobs it is doing.

**And a declared border is not the same as a drawn one.** The third failure was neither of the above: the border was correct and something painted over it. dockview draws `--dv-separator-border` as a `::before` on every split-view child *but the first*, pinned to that child's leading edge at `z-index: 5`, so it covered each tile's own left and top border — and since the master is the first child at every level of the grid, the master was the one tile still showing all four edges. The focused tile's accent ring was broken the same way, on the same two sides. The token is now `transparent` and each tile owns all four of its edges, which is dwm's model: 1px at the workspace boundary, 2px between neighbours where two borders abut. Two self-test checks guard it — "no separator paints over a tile's border" and "the focused tile draws a complete accent ring" — and the contrast check now samples every tile rather than only the first, which is how a bug that spared the master slipped past a passing suite. **One thing in the app is allowed a palette of its own, and only one.** An annotation's colour is not chrome — it is content the user is adding to their document, and it will be read tomorrow in Acrobat with none of this app's CSS. `annotation/overlay/tools.ts` therefore holds a real six-colour ink palette, the same exception `pdf.css` already makes for paper white ("that is not chrome, it is the document"). Every control *around* it — the palette strip, the selection handles, the sidebar list — uses the tokens like everything else. Monospace typography throughout. Zero border-radius. Thin 1px borders, accent-colored only on focused/active elements. No shadows, no gradients, no skeuomorphism. Flat hover states (subtle background shift, not animation). This is encoded once in the Tailwind theme and every component consumes it from there.

## Platform targets

This is a native cross-platform desktop app, not a browser-deployed web app. Tauri builds separate binaries for Windows, macOS, and Linux from the same codebase; there is no plan for a browser-hosted build and no plan for mobile.

**Everything below was developed and verified on Linux.** Where a note says a thing is checked, it is checked there unless it says otherwise; what has never been run on macOS or Windows is listed under "Open items and unverified decisions" near the end of this file, and that list is the one to read before claiming any of this is settled. Keep the following in mind while implementing:

- **Linux** renders through webkit2gtk, which trails Chromium and Safari on some CSS/JS features and varies by distro. Canvas-heavy rendering (PDF and image display are the core of this app) is the most likely place for inconsistencies to surface. Test on at least one Linux distro during Phase 3 and Phase 4, not only at the end.
  - **The floor is webkit2gtk 2.44** (Safari 17.4, Chromium 119, Ubuntu 24.04 LTS), and it is a floor the app *holds up* rather than one the dependencies respect. `pdfjs-dist@5.5.207` calls eleven built-ins newer than Safari 17.0 with no guard at all — `Promise.try`, `Uint8Array.prototype.toBase64`/`toHex` and `Uint8Array.fromBase64` (Safari 18.2), `URL.parse` (18.0), `Promise.withResolvers`, `AbortSignal.any`, `ArrayBuffer.prototype.transferToFixedLength` and `ReadableStream.prototype[Symbol.asyncIterator]` (17.4), `Map.prototype.getOrInsertComputed` (newer still, and the first thing `PDFPageProxy.render` touches), and `Set.prototype.intersection` (17.0, exactly at the floor). `src/viewers/pdf/compat.ts` polyfills all of them, on the main thread *and* inside the decoder worker, which is a separate global scope and needs its own copy.
    **This bullet claimed the floor was "set by `Promise.withResolvers`". That claim was arrived at by reading the dependency, and reading the dependency was wrong three times running** — each time naming the newest API someone had noticed rather than the newest one present, and each time costing a bug report from a Mac. **Derive the list instead**: pull every method name pdf.js calls out of its sources, drop the ones that exist on a built-in in Node 20, and ask a modern webkit2gtk which of the survivors it recognises. What one engine has and the other lacks *is* the recent frontier, and it takes two minutes. `compat.ts` sets out both steps and the traps in reading the result — three of its hits are false. Then prove it by deleting that whole surface from a webkit2gtk page and from the worker blob and running the suite. Do all of it whenever the pdf.js pin moves.
    **And that derivation has one blind spot, which cost a fourth bug report: it only sees built-ins something calls *by name*.** `ReadableStream.prototype[Symbol.asyncIterator]` is in the list above and no regex over `.method(` could have found it — pdf.js reaches it by writing `for await (const value of readableStream)`, where the syntax is the call. So also grep for the syntax that makes the engine call a protocol on your behalf: `for await` and `yield*`, spread and destructuring of non-arrays, `instanceof`. Of those, only `for await` over a stream lands anywhere near the frontier — everything else pdf.js iterates is its own arrays and maps, whose protocols are as old as the engine.
  - **Prefer a CSS `filter` on an element over `CanvasRenderingContext2D.filter`.** webkit2gtk *accepts* the canvas property, returns it verbatim when read back, and ignores it when drawing — so a feature probe that sets it and checks it says "supported" while every affected draw comes out untouched. The element-level filter has no such problem, is composited on the GPU, and leaves the canvas pixels alone. More generally: probe a capability by *using* it and measuring the result, never by asking whether the API exists.
  - **A `::selection` rule that sets only a background lets webkit2gtk choose the foreground**, and it chooses the GTK theme's selected-text colour — overriding `color: transparent` on the text underneath. Chromium and Firefox leave transparent text transparent, so this is invisible on two of the three engines. **Not on the third: WKWebView is WebKit too.** The rule in `pdf.css` is unconditional and is protecting macOS as well as Linux — do not narrow it on the reasoning that only webkit2gtk is affected. It surfaced in phase 05b as the PDF text layer becoming *visible* the moment it was selected: a second, offset copy of the words over the canvas's own, and on a scanned page the OCR text painted over the picture of itself. Any selection styling over invisible text has to name `color` **and** `-webkit-text-fill-color`; `src/viewers/pdf/pdf.css` does, and pdf.js's own stylesheet does not — do not "simplify" it back to theirs.
  - **webkit2gtk has no PDF renderer at all**, which WebView2 and WKWebView both do. Anything that hands a PDF to the webview and expects it to appear — a frame, an `<embed>`, a print preview — does nothing here. `src/viewers/pdf/print.ts` is the one place that matters so far, and it rasterises through pdf.js on Linux instead.

- **A window that is not being composited stops delivering animation frames, and that stops more than animation.** When the window is minimised, fully occluded, or the screen is asleep, `document.visibilityState` goes `hidden` and `requestAnimationFrame` never fires. pdf.js schedules its own render continuations on `requestAnimationFrame`, so **a page render started in that state never completes** — it does not fail, it never settles, and an unguarded `await` on it hangs whatever is waiting. This is not a bug to fix; it is correct (there is nothing to draw). It is written down because of what it costs when you do not know it:
  - Never `await` a render, a frame, or anything downstream of either without a timeout. Both self-test hangs found in phase 03 were exactly this — `afterPaint()` in `shell/docking/selftest.ts` awaiting a bare double-rAF, and the PDF suite awaiting `thumbnail()`. A hang reports *nothing*, which is strictly worse than a failure.
  - A verification run against a hidden window cannot check rendering, and must say so rather than fail. `SelfTestCheck.skipped` (see `src/dev/selftest.ts`) exists for this: skipped checks do not fail the report, are printed with their reason, and are counted separately. `src/viewers/pdf/selftest.ts` probes the environment first and skips the render-dependent checks when the probe says frames are not being delivered — so **a green PDF report with skips is not the same as a green one without, and the difference is stated in the output.**
  - If you are verifying by hand or over SSH: bring the window to the front and keep the screen awake, or the render coverage is silently absent.
- **Windows** renders through WebView2 (Chromium-based), **macOS** through WKWebView (Safari-based). Both are solid; double-check any newer Clipboard API or filesystem-adjacent web API usage (Phase 6) against WKWebView specifically. The filesystem-adjacent half of that is settled and stays settled: there is no File System Access API usage anywhere, all I/O goes through Tauri, and nothing in the app is newer than the floor below. The Clipboard half is not — see the `ClipboardItem` note two bullets down.

  - **The macOS floor is macOS 14.0 (Sonoma), and on macOS the OS version does not tell you the engine version.** WKWebView runs the *system* WebKit, which moves with Safari and not with the OS: a Sonoma machine can be on Safari 17.0 or on 26, and `bundle.macOS.minimumSystemVersion` cannot distinguish them. That is not a footnote — **it is how every PDF came to hang on macOS a second time**, on a machine whose Safari was older than pdf.js expected while every other platform was newer. `minimumSystemVersion` in `tauri.conf.json` is pinned to `14.0` (**Tauri's default is 10.13**, which would let the app install where the webview cannot run the viewer at all), and the *engine* floor is held by `src/viewers/pdf/compat.ts` rather than by the version pin. The rule that follows: **a feature this app depends on must either be polyfilled or feature-detected; "the minimum OS ships a new enough Safari" is not a guarantee macOS makes.**
  - **A bundle is served by a scheme handler, not by a server, and that is not a curiosity — it is a class of bug that only exists in bundles.** `tauri_protocol_url` (in `tauri/src/manager/mod.rs`) serves the frontend from `http://tauri.localhost` on Windows and from **`tauri://localhost` on macOS *and Linux***. Every request the page makes for its own assets goes to that handler, and **a request the handler does not drive does not fail — it never completes**. wry's macOS handler says so in code: on any validation path it returns without calling `didFailWithError` *or* `didFinish` (`wry/src/wkwebview/class/url_scheme_handler.rs`), leaving the load outstanding forever. In `tauri dev` the frontend is `http://localhost:1420` and a real server answers, so **none of this reproduces in development** — the first time the code meets the scheme handler is in a bundle a user installed.
    That is how every PDF came to hang forever on "loading" in the macOS bundle: `new Worker("/assets/pdf.worker.min-….mjs")` put the worker's own script request through the scheme handler, WKWebView did not answer it, the worker never evaluated and never sent `ready`, and pdf.js has an error path but no timeout. A promise that never settles, and nothing logged. (Tauri issue #9975 is the same surface from the other side: in a macOS release build a worker script fetched over the app's scheme comes back as `index.html`.) `viewers/pdf/pdfjs.ts` sets out the fix and the reasoning; the transferable part is the rule — **anything a worker, an `import()`, a `fetch` or a CORS check has to resolve must not depend on the app's own scheme**, and anything that starts asynchronously in a bundle needs a deadline, because the platform difference will surface as a hang rather than as an error.
  - **`tauri://localhost` is *not* an opaque origin on WebKit, whatever the URL Standard says.** This was written down the other way round for a while and a fix was built on it, so it is worth being exact. `tauri:` is not a special scheme, so per the URL Standard `new URL("tauri://localhost/").origin` should be the string `"null"` — and on WebKit it is `"tauri://localhost"`, because WebKit answers `URL.origin` from the document's `SecurityOrigin`, which for an ordinary custom scheme is an ordinary scheme/host tuple. Measured on webkit2gtk under a real `tauri://` scheme handler, with and without `register_uri_scheme_as_secure`. So same-origin checks against the app's own assets **pass** on macOS and Linux, and any reasoning that starts "the origin is null, so the library takes its cross-origin path" is wrong on two of the three targets. Chromium (Windows/WebView2) does follow the standard — but there the scheme is `http://tauri.localhost`, a real origin, so that branch is not reached either.
    **The reproduction that settles questions like this without a Mac**: register `tauri` on a `WebKit2.WebContext` from PyGObject, serve `dist/` from the handler, and load `tauri://localhost/index.html`. Linux gets the same scheme as macOS, so the origin, the blob-URL behaviour and the worker path are all the real ones; `tauri dev` reproduces none of them. Faking `window.__TAURI_INTERNALS__` in a classic `<script>` injected ahead of the module bundle puts the *whole built app* in there, opening a real file through the real plugin.
    One measured consequence worth keeping: **inside a blob-URL worker, relative URLs do not resolve on WebKit** — `fetch("/x")` fails with "URL is not valid" and `import("/x")` with "does not resolve to a valid URL". A worker built from inlined source cannot reach back for anything by relative path; give it absolute URLs or, better, nothing to fetch at all.
  - **A clipboard write needs user activation, and a synthetic event does not grant it.** Phase 06 found this the hard way while verifying in the real engine: driven by `dispatchEvent`, *every* `navigator.clipboard` call — `writeText` included — rejects with `NotAllowedError` on webkit2gtk, which reads exactly like "this platform has no clipboard". Injected through GTK as a genuine key press or mouse drag, the same code writes both text and `image/png`, and an independent X11 client reads them back. So: a clipboard feature cannot be verified from a scripted DOM harness, and a `NotAllowedError` there means nothing. `src/shell/clipboard/system.ts` reports it as a message rather than throwing, which is the only behaviour that is right in both situations.
  - The write survives an `await` between the gesture and the call (extraction and PNG encoding both happen first, and the region copy still lands), so the `ClipboardItem`-holding-a-promise pattern is not needed on webkit2gtk. Re-check it on WKWebView, which is the engine that pattern exists for. **Still open, and it is a re-check that cannot be done from Linux**: the same note above says a scripted DOM harness proves nothing about the clipboard, so the only way to answer it is on a Mac. `shell/clipboard/system.ts` states plainly what the code does — the caller awaits `getCopyable` and the writer awaits a PNG transcode before `navigator.clipboard.write` — so whoever runs it on macOS can tell at a glance what is being tested. Do not restructure toward the promise pattern speculatively: webkit2gtk is measured working as it stands.
- **Video codec coverage still depends on the webview, because the engine that would end that dependency is not built** (see the tech stack note above). Today playback is the `<video>` element, so what opens is whatever WebView2, WKWebView or webkit2gtk demuxes and decodes — which differs per platform in ways `src/viewers/video/codecs.ts`, `mkv/index.ts` and `webm/index.ts` document per format, and which the plugin reports as a named per-file error rather than a blank tile. Once the libmpv engine lands, coverage becomes whatever the bundled FFmpeg supports, uniformly on all three platforms, and the only remaining per-platform variation is hardware-decode backend availability (VideoToolbox on macOS, D3D11VA on Windows, VAAPI on Linux) plus native-surface embedding mechanics, both covered in `04b-video-viewer-plugin.md`.
- **Wayland does not let a client position its own top-level windows at absolute coordinates.** X11 does; Wayland's core protocol treats window placement as the compositor's job, not the client's. This constrains the *unbuilt* libmpv engine rather than anything shipping today: it breaks the sibling-window-and-position-sync technique planned for embedding the native surface on Windows. The Linux path is to render in-process instead (libmpv's render API into a `GtkGLArea` inside webkit2gtk's own widget tree), which needs no window positioning at all. Verify against real target compositors (GNOME/Mutter, KDE/KWin) rather than assuming one Wayland compositor's behavior generalizes.
- Keyboard modifier conventions differ (Ctrl on Windows/Linux, Cmd on macOS). The keybind registry (Phase 2) must abstract this from day one, and Phase 2's verification should explicitly confirm bindings display and function correctly with the platform-appropriate modifier. Bindings are declared with `Mod` and rendered only through `formatAccelerator`; nothing else may branch on the platform.
- **Some `Mod`-based accelerators collide with the macOS menu, which claims the key before the webview sees it.** `Cmd`+`M` (minimise) is why monocle is bound to `Mod`+`Shift`+`M`, and `Cmd`+`H` is why the `hjkl` aliases are gone. The rest of that trap was found by a macOS compliance review, not by a phase: Tauri installs a **default** macOS menu whenever the builder is given none, and **four** of its predefined key equivalents were accelerators this app binds — `⌘W` (Close Window vs. `layout.closeTile`), `⌘C` (Copy vs. `shell.copy`), `⌘Z` and `⇧⌘Z` (Undo/Redo vs. `annotate.undo`/`redo`). Only the first was ever written down. The other three arrived with phases 05a and 06, and `viewers/pdf/actions.ts` argues `Mod+Z` is "unclaimed" — which it is, by the *shell*, and is not by macOS.

  `src-tauri/src/menu.rs` now builds Tauri's own default menu minus those four items, installed only on macOS. **Re-check this whenever a new `Mod`+letter binding is added**, against the menu that file builds and not merely against the shell's own claims. The evidence, if you need to re-derive it: `tauri/src/app.rs` (`enable_macos_default_menu`, default `true`), `tauri/src/menu/menu.rs` (`Menu::default`), `muda/src/items/predefined.rs` (the accelerator table).

  **Two things about that menu are unverified and must not be assumed settled.** It has never been compiled for macOS or run — `cargo check` on Linux type-checks `menu.rs` (it is deliberately outside the `cfg`), which is not the same claim. And dropping Copy, Undo and Redo removes those key equivalents over the app's own text fields too, where `shell.copy` deliberately declines and the platform was expected to answer; whether WKWebView performs `copy:`/`undo:` with no menu item present needs a real run. If it does not, put the three Edit items back and move the app's three bindings, rather than leaving inputs without copy.
- File dialogs and window chrome should use Tauri's native APIs so each build feels native to its OS rather than uniformly web-styled. **Window chrome is currently the OS's own**: `decorations` is left at its default, there is no custom titlebar, no `data-tauri-drag-region` and no window-control call anywhere in `src/`, on any platform. That is the intent of this bullet, not an unfinished piece of one — but it is worth knowing that the capability set would not survive changing it. `core:default` grants the window *queries* (`is-maximized`, `inner-size`, and so on) plus `internal-toggle-maximize`, and grants none of `start-dragging`, `minimize`, `maximize`, `unmaximize`, `close` or `set-title-bar-style`. A custom titlebar therefore needs `src-tauri/capabilities/default.json` edited in the same change, or it will render correctly and do nothing.
- Mobile (iOS/Android) is explicitly out of scope. The interaction model (freeform tiling, drag-to-dock, keybind-first) is a pointer-and-keyboard paradigm and would need a separately designed touch UI, not a resized version of this one. Do not add mobile-specific code paths unless this decision is revisited.

## Non-negotiable constraints

- The shell must never contain file-type-specific logic. If you find yourself writing `if (fileType === 'pdf')` inside a shell component, the abstraction is leaking and needs fixing before proceeding.
- Every viewer plugin must degrade gracefully: a plugin that fails to load a file shows an error state inside its own tile without crashing the shell or other open tiles.
- No feature previously specified for the PDF viewer is dropped in this rebuild. Where a prior specification conflicts with the new plugin architecture, adapt the mechanism, not the requirement.
- No hand-rolled layout math. All tiling, splitting, and resizing goes through the chosen docking library. **What this does and does not forbid:** it forbids geometry — pixel positions, pointer-drag arithmetic, divider hit-testing, minimum-size enforcement. It does not forbid deciding *which tile goes where*. Phase 02's `src/shell/docking/tiling.ts` chooses the shape and order of the grid and hands the result to dockview's own `fromJSON`; dockview still computes every pixel. If you find yourself measuring or positioning anything, you have crossed the line.
- All new dependencies must be justified against this file's tech stack section before being added. Do not introduce a second state management library, a second docking library, or a second PDF renderer.
- Inversion (the single whole-document invert switch described under "Dark-mode inversion" below) is a PDF-specific feature, not a general viewer feature. The image and video plugins do not implement any form of inversion.

## Module map

```
scripts/                   Shell build/clean tooling, bash 3.2 compatible (see "Building and releasing")
src-tauri/                 Rust backend: file access, the macOS menu, store plugin
  src/menu.rs               The macOS menu only. Tauri's default minus the four items whose
                              key equivalents this app binds. Never compiled for macOS.
  src/media.rs              Loopback HTTP range server behind the current <video> engine.
                              Goes away with `video/` below.
  video/                    NOT BUILT. The libmpv engine: per-platform native surface embedding
                              (sibling window + SetWindowPos on Windows, NSView subview on macOS,
                              GtkGLArea + libmpv render API on Linux), per-tile instance lifecycle,
                              the position-sync bridge. See prompts/04b and the tech stack note.
src/
  app/                      App shell composition, routing between empty state and workspace
  shell/
    docking/                dockview integration; `tiling.ts` derives the dwm-style tall/wide/grid layouts
    toolbar/                Minimal top bar plus the plugin contribution point (see prompts/08)
    statusbar/              Bottom bar: what is focused, the layout indicator, the keyboard-shortcuts
                              trigger, and `messages.ts`, the shell's transient announcement line
    sidebar/                Sidebar shell: open files, plus the four lower panels (`panels.ts` names them)
    command-palette/        `commands.ts` derives the runnable list from the dock's actions, the
                              focused plugin's contributions and the shell's own verbs; the
                              component holds only the query and the highlighted row
    search/                 Global search UI, queries each open viewer via the plugin contract
    clipboard/              Cross-viewer clipboard system, scratch panel, history. `system.ts` is
                              the only code that touches the OS clipboard; `RegionCapture.tsx` is
                              the rubber band, drawn by the shell over any tile
    keybinds/                Keybind registry, reference modal, platform-correct accelerators,
                              and `contributions.ts`, the bridge for a plugin's own bindings
    openFiles.ts            The "open file" action, shared by the toolbar and the empty state
  viewers/
    contract.ts             The Viewer Plugin interface (single source of truth)
    registry.ts             MIME/extension -> plugin resolution, fallback viewer
    pdf/                     PDF plugin. `index.ts` is the eager descriptor; `mount.ts` and
                              everything below it load lazily, so a session that opens no PDF
                              never parses pdf.js
      annotate.ts             Annotate mode: tools, pointer gestures, image paste/drop, save
      annotateLayer.ts        One page's SVG mark layer, viewBox in page points
      annotatePalette.ts      The tool strip, attached to the tile rather than the toolbar
      textAnnotate.ts         The selection popover, the note, and resolving anchors
                                into marks the layer above draws (phase 05b)
      textGeometry.ts         Page text with each item's box; character range -> rectangles;
                                selection -> character range. Phase 06's search imports it
      dev/                    A PDF built in memory, so the self-test needs no fixture on disk
    image/                   Image plugin (see prompts/04a). Shared engine and settings live
                              directly here; format-specific code lives in its own subfolder,
                              one per filetype:
      index.ts                Plugin registration, dispatch to per-format submodules
      engine/                  Shared viewing engine: pan/zoom, fit modes, rotate/flip, color picker, histogram
      metadata/                Shared EXIF/IPTC/XMP panel logic
      settings.ts              Shared image-viewer preferences
      jpeg/ png/ bmp/ tiff/ webp/ gif/ ico/ avif/ svg/ heic/ raw/    One folder per filetype
                                (or per shared-decode-path group, e.g. raw/ covering CR2/NEF/ARW/DNG)
    video/                   Video plugin (see prompts/04b). Same convention as image/:
      index.ts                Plugin registration, dispatch to per-format submodules
      engine/                  Today: transport, tracks, subtitles, capture and presentation over
                                an HTMLVideoElement. Target: mpvBridge.ts, the IPC client talking
                                to src-tauri/video/ (init, command, property get/set/observe,
                                destroy), with the same controls built on top of it instead
      metadata/                Shared codec/container metadata panel logic
      settings.ts              Shared video-player preferences
      mp4/ webm/ mov/ mkv/ avi/ ogv/    One folder per container/codec combination
    fallback/                Generic metadata-only viewer for unsupported types
  annotation/                Two targeting models, both file-type agnostic in their data even
                              though only the PDF plugin wires into either right now:
    geometry.ts                Normalized (0..1, y down) rects and points, and the maths over
                                them. One coordinate system; the edges convert.
    model.ts                   What both models share: `AnnotationSummary` and the export types
    overlay/                   Page-relative positioned items: ink, drawn highlight, shapes,
                                pasted images, point-anchored notes (phase 05a).
                                `model.ts` the items, `document.ts` the edits/undo/z-order,
                                `tools.ts` the tool set and its per-tool style memory
    text/                      TextAnchor-targeted items: highlight/note attached to a text
                                range, quote-based so it survives reflow (phase 05b).
                                `anchor.ts` build/resolve, `model.ts` the item and its
                                resolution, `document.ts` the items and their last known
                                placements, `source.ts` the capability a plugin implements
    store.ts                   Shared persistence for both models; the annotated-flag and
                                overwrite-on-save mechanism lives here, not in the PDF plugin
    export/                    Per-plugin export bridges; only `pdf.ts` exists so far. Its
                                barrel exports types only, so pdf-lib stays out of any
                                session that never saves an annotation.
    selftest.ts                Dev-only: the edit model, the save-target rule, and the export
                                read back with pdf-lib
  files/                     FileHandle abstraction over native dialog / drag-drop / restored paths
  platform/                  Which desktop OS we are on; the only source of platform branching
  persistence/               Session/layout save-restore via Tauri store, real file handles.
    record.ts                  What a saved session is, and how one is read back safely
    storage.ts                 Where it is kept: the Tauri store, or memory outside the app
    tiles.ts                   Per-tile bookkeeping a restore needs and no store should hold
    session.ts                 Collecting the record, and the debounced writer
    restore.ts                 Putting one back, in the order that survives a missing file
  theme/                     Tailwind config and design tokens
  store/                     Zustand stores
  dev/                       Dev-only self-test harness; stripped from production builds
```

`files/` and `platform/` were added in phase 01. Viewer plugins depend on `files/`, so it cannot live under `persistence/`; `platform/` is shared because phases 03/04 need it for webkit2gtk differences and phase 06 for WKWebView clipboard behavior.

`shell/statusbar/` was added in phase 02. The keybind reference trigger lives there rather than in the toolbar: it teaches the keyboard rather than acting on the workspace, and the toolbar is under a standing instruction to stay short. Phase 08 decides whether that split survives consolidation.

`image/` and `video/` follow one convention, stated once here rather than in each of `04a`/`04b`: anything shared across every format in that plugin (the engine, the metadata panel, preferences) lives directly in the plugin's root, never inside a per-format folder. Anything specific to one format gets its own subfolder named for that format and is registered explicitly with `registry.ts`, so a misdetected file fails predictably rather than silently. Formats sharing an identical decode path (the camera RAW variants, for instance) may share one subfolder, but each is still registered on its own.

`annotation/` is filled in during phase 05; see "Annotation model and export" below for why it is two models rather than one, and for the overwrite-on-save flag.

`shell/sidebar/` was added in phase 02, because the toolbar's sidebar toggle needs a target. It lists the open files, and — since phase 03 — previews of whatever the focused tile is divided into (`SubdivisionRail.tsx`). The rail contains no file-type vocabulary: it reads `capabilities.subdivisionCount`, calls `thumbnail({ subdivision })`, and navigates with `reveal({ subdivision })`, so a video plugin exposing keyframes gets the same rail without touching it. Phase 06 adds search results and the clipboard scratch panel the same way.

Phase 06 added the last two panels, and they are a different kind: search results and the scratch panel are about the *workspace*, not the focused tile, so they are always present while the first two still appear only when the focused instance reports the capability behind them. Which panel is showing therefore moved into `store/layout.ts` — `Mod+F` opens the sidebar *on search* and the palette does the same for both, and a component that owns its own selection cannot be told to change it by a keybind that runs whether or not it is mounted. Four tabs do not fit across 256px, so the strip wraps; the alternatives, both of which it did before `flex-wrap` and `whitespace-nowrap`, were a truncated label and a label broken across two lines.

Phase 05a put the annotation list beside the rail rather than under it, and `SidebarPanels.tsx` is that decision: **the open-files list keeps its own space and the lower half is tabbed.** Stacking a third section would have taken the column to three scrolling regions in 256px, and phase 02's arrangement — what is open, always visible, above what is *in* the focused tile — is the part worth keeping. A tab appears only when the focused instance reports the capability behind it, so a tile with previews and no annotations shows exactly what phase 03 showed. Phase 05b put its marks in that same list rather than adding a second one: both models produce an `AnnotationSummary`, they are told apart by their type word (`highlight`, `note`, `ink`… are drawn; `quote` and `comment` are attached to words), and an anchored entry's label is the quote itself, because the words are the point of that model.

### How a plugin reaches the shell

The contract has five contribution points and no sixth way in. A plugin never imports a shell module, and the shell never imports a plugin — `viewers/register.ts` is the one file that names both, which is what makes the "no file-type logic in the shell" rule checkable by grep.

| The plugin offers | The shell renders it as | Scoped to |
| --- | --- | --- |
| `preferences` (on the descriptor) | values the persistence layer stores per plugin | the whole app |
| `toolbar.getControls()` | contributed controls in the top bar | the focused tile |
| `keybinds.getKeybinds()` | a section of the reference modal, and live bindings | the focused tile |
| `thumbnail({ subdivision })` | the sidebar's preview rail | the focused tile |
| `annotation.listAnnotations()` | the sidebar's annotations tab | the focused tile |
| `annotation.textAnchors` | text-anchored highlights and notes, via `annotation/text/` | the focused tile |
| `copy.locateRegion(tileRect)` | the rubber band's answer: which subdivision the box was over | the focused tile |
| `reveal(location)` | clicking a preview, a listed annotation, and phase 06's search results | any tile |

Phase 03 added the second of those, plus a `readout` toolbar control kind and the promotion of `reveal` out of `ViewerSearchApi`; phase 05a added the fourth, phase 05b the fifth, phase 06 the sixth and phase 07 the first. All were extensions made *because a plugin needed something and the contract did not have it* — which is the procedure the phase briefs mandate, in preference to a plugin-specific escape hatch:

- **`preferences` on the descriptor**, and it is the only one of the seven that is not scoped to a tile. `ViewerInstance.serialize()` answers "what does this tile remember"; the image plugin's default fit mode and the video plugin's shared volume are the other thing — one value the user set once that every tile of that type picks up, which a tile-scoped serialization would either duplicate n times or lose entirely when the last tile of that type closes. Both plugins had already written the `serialize`/`restore` pair for phase 07 to call (`viewers/*/settings.ts`), and the alternative was for `persistence/` to import those two modules by name: the shell naming two file types, and a fourth plugin's preferences meaning an edit to the persistence layer. On the descriptor, the persistence layer iterates `listViewerPlugins()`, stores an opaque value per plugin id, and learns nothing — the same deal `serialize()` makes, one level up. Version-gated separately from `stateVersion`, since a tile's state and a viewer's preferences change shape for unrelated reasons.

- **Keybinds.** A plugin calling `registerKeybinds` itself would be reaching into shell internals, and a shortcut outside the registry is also outside the reference modal — which is where "is there a shortcut for this" is supposed to be answerable. Registration is focus-scoped, so a plugin can claim `PageDown` without negotiating with every other plugin, and ids and groups are namespaced in `shell/keybinds/contributions.ts` so it cannot collide with the shell's.
- **`readout`.** A page position or a zoom percentage is a value to read, not an action; faking it with a disabled button says "unavailable", which is a different thing. Phase 04's video plugin will want it for a timecode.
- **`reveal` on `ViewerInstance`.** It was only under `ViewerSearchApi`, but a scanned PDF has pages and thumbnails and no text at all, so it reports `search: false` and the rail had no way to jump to a page. Optional and feature-detected, like `resize` and `setActive`.
- **`annotation.textAnchors`.** Four methods: how many subdivisions there are, the text of one, the rectangles a character range occupies, and an anchor for the current selection. That is everything `annotation/text/` needs from a file type, and deliberately nothing more — the model is written against this interface, so a future `txt` or `docx` plugin implements it over plain offsets and gets quote-anchored highlights, notes, the sidebar list and the export bridge with no change to the shared code. It is optional and feature-detected: a plugin whose content has no text simply omits it, which is the same "absence, not disabled" rule as everywhere else here.
- **`copy.locateRegion(tileRect)`.** Phase 06 draws a rubber band over any tile and copies what is under it. The contract already promised that normalized coordinates let the shell *draw* over a plugin without asking it for geometry; the inverse is not derivable, because where a subdivision currently sits inside a tile is a function of scroll offset, zoom, rotation and page layout, all of which belong to the plugin. The alternatives were a shell that reads a PDF's scroll position — file-type logic in the shell, which is the one thing that is forbidden outright — or a region copy that could only ever mean "all of it". So one optional method takes a box normalized to the *tile* and returns a `ViewerLocation`; the shell then passes that straight into the `region` scope of `getCopyable`, which both plugins already implemented. The PDF plugin answers with the page the box mostly covers, the image plugin by running the box back through the same inverse transform its pixel inspector uses, and the video plugin omits it — it copies the current frame whatever box is drawn, and offering the gesture there would be a lie.

- **`annotation.listAnnotations()`, and `onAnnotationsChange`/`removeAnnotation` with it.** The sidebar's annotations tab needs to name what is on the document and delete one; it must not be handed the marks themselves, because an item carries stroke geometry, colours and image bytes, and a shell component that can read those is one that will eventually branch on them. So it gets an `AnnotationSummary` — a type word, a label, a subdivision, a rect, a time — and nothing else. `ViewerAnnotationApi` lost `setOverlay`/`getOverlay` in the same change: the marks are edited inside the tile and outlive it, so they belong to `annotation/store.ts` keyed by the file, not to the shell. **There is no new navigation:** the shell builds a `ViewerLocation` from the summary's subdivision and rect and calls the `reveal` that already existed.

### The tiling model

`shell/docking/tiling.ts` is the single source of truth for what a tiled layout looks like, and it is worth understanding before touching anything layout-related.

The layout is **derived, never accumulated**. Building an arrangement by applying moves — "put this tile to the left of that one" — nests a new branch in the grid tree on every call, so after a few promotes the tree stops resembling anything the user asked for and cannot be returned to two plain columns except by dragging dividers. That was a real bug, found in phase 02 testing, and the model replaced it rather than patching it.

Borrowing dwm: a tiled arrangement is a pure function of four inputs — an ordered list of tiles, a `mode`, `masterCount` (dwm's `nmaster`), and `masterFraction` (`mfact`). Every layout action changes one input and re-derives the entire grid, so no sequence of actions can corrupt it. Deriving twice is a fixed point *in every mode*, which the self-test asserts directly. Borrowing i3: a **tile is a dockview group, not a panel**, so a hand-made tab stack stays one tile through every re-derivation.

The three modes are `tall` (`[]=`, master area on the left), `wide` (`TTT`, the same thing rotated a quarter turn) and `grid` (`HHH`, `ceil(sqrt(n))` equal bands, no master area). Adding a fourth means adding an entry to `LAYOUT_MODES` and a branch in `bandGroups`; nothing else in the shell enumerates them.

**The rotation is derived, not listed.** `arrangementsFor(n)` builds every mode-and-master-count pair, derives each one, and keeps it only if it looks different from everything already in the list — so `Mod+Enter` walks the whole space of distinct screen shapes and never shows the same picture twice. That deduplication is load-bearing and subtler than it looks: a single band of *k* slots renders *exactly* like *k* bands of one slot in the other orientation, so four tiles as one column is reachable as `tall` with `masterCount: 4` and as `wide` with `masterCount: 1`. `shapeSignature` folds those together. Deriving the list rather than writing it down means it cannot drift from what `tileGrid` actually does. Four tiles give 8 arrangements, five give 11; the status bar shows the position in the lap (`[]= 3/8`) because a cycle that long is disorienting without one.

Consequences worth knowing:

- **Master** is simply the first tile in the order. It holds regardless of how the arrangement was reached, including by freehand dragging.
- `masterCount: 2` with three tiles *is* "two stacked on the left, one on the right". Reaching a named arrangement is a keystroke, not a drag.
- The layout actions **normalize**: they replace whatever is on screen with the derived tiling. That is deliberate — it is what makes any arrangement recoverable — and it is why `retile` exists as its own binding.
- Re-tiling goes through `api.fromJSON(next, { reuseExistingPanels: true })`, which re-parents live panel objects instead of rebuilding them. **Do not drop that flag**: without it every promote would remount every viewer and throw away its decoded state.
- Freehand dragging is untouched and still fully dockview's.
- **Sizes survive a re-derivation, not just the order.** The order was always carried across; the sizes were not, so promoting a tile reset every divider in a workspace the user had sized by hand. `readSizeProfile` captures each band's and each slot's share of its axis, and `tileGrid` reuses them whenever the shape it is about to build has *the same slots* — same axis, same bands, same tiles per band. A promote therefore moves tiles between slots and leaves the slots alone. Rotating to a different shape has no slot to carry a size into, so it falls back to `masterFraction` and an even split; that is correct, not a gap. `readMasterFraction` still syncs a dragged master edge back to the store so the proportion survives a shape change too. Reading ratios out of dockview's own serialized sizes is the same move `readTiles` makes with order and stays on the right side of the "no hand-rolled layout math" rule — it asks the library what it already decided rather than measuring anything.
- **Spatial questions go to dockview, rearrangement goes to the model.** "Focus the tile to the left" and "move this tile up" both start with `api.adjacentGroupInDirection`, and directional *move* turns that answer into a swap of two positions in the tile order. So it inherits swap's property: exactly two tiles change place, in any mode, however the arrangement was reached. Asking dockview to move a panel relative to another group instead would be the accumulating-moves approach this model exists to replace.

### The keybind shape

```
Mod       + ← →      focus the previous / next tile or tab
Mod       + 1 … 9    focus a tile by number
Mod+Shift + arrows   move the tile
Mod+Enter            the next way of dividing the screen
```

Everything else is one key for one job: `Mod+Shift+Enter` previous arrangement, `Mod+Home` make master, `Mod+Shift+M` monocle, `Mod+Shift+R` retile, `Mod+Shift+G` cycle gap, `Mod+W` close. Twenty-six bindings, twenty-six accelerators, fourteen listed rows.

**Phase 06 spent four, and the shell section now lists seven rows.** `Mod+F` search, `Mod+K` command palette, `Mod+C` copy to the system clipboard, `Mod+Shift+C` yank to the scratch panel. The pair at the end is the phase brief's requirement — two destinations, two keys — and `Shift` is the modifier this app already uses for "the same action, the other way round". `Mod+K` rather than the conventional `Mod+Shift+P`, because `Mod+P` belongs to the PDF plugin and a shell binding one `Shift` away from a plugin's is a collision waiting for someone to mistype. Two things were deliberately *not* given a key: the region-copy gesture, which is a drag and would only ever be *armed* by a shortcut (it is a palette entry and lives one click away in the tile), and anything for the scratch panel's contents, which are a list you click.

**A `Mod`+letter binding is dispatched while a text field has focus, and that is a trap.** The registry's typing guard only protects *unmodified* keys, so `Mod+C` reaches the shell even while the cursor is in the search box — where it would swallow the platform's own copy. `useClipboardKeybinds` answers that with `enabled()`, which reports the binding unavailable whenever `isTextEntryTarget(document.activeElement)`, leaving the key press for the engine. Anything later that claims a conventional editing accelerator has to do the same; the alternative is a shortcut that silently breaks copy-and-paste in every input the app grows.

Only `Mod+1` is listed in the reference modal; the other eight digits are `hidden`, because nine near-identical rows would swamp the section to say one thing nine times. **`Mod`+digit is spoken for** — a later phase wanting digits for page jumps or zoom presets needs a different modifier.

**Nothing has two bindings, and that is a rule, not an accident.** The reference modal renders every accelerator a binding declares as its own chip, so an alias is not free — it is a second thing on screen for a job already covered. The `hjkl` aliases were removed for this reason (and `Mod+H` never reached the webview on macOS anyway, which claims it for hide-application). Before adding an alias, ask whether the modal is better with the extra chip.

**`Mod+Alt`+arrow is unusable on Linux and is not a preference.** GNOME binds all four `Ctrl+Alt`+arrow combinations to switch-to-workspace and takes them before the webview sees a key press, so the master-area bindings that lived there genuinely did nothing. Verify with `gsettings list-recursively org.gnome.desktop.wm.keybindings` before putting anything on a system-adjacent chord. `Mod+M` is the macOS equivalent of the same trap (minimise window), which is why monocle is `Mod+Shift+M` and make-master is `Mod+Home`.

The set has been consolidated twice; do not re-add these without a reason that was not true then:

- **directional focus** (`Mod`+arrow per direction). Four bindings to reach a tile, next to nine that reach one directly. `Mod+1 … 9` is the faster route to a named tile and cycling is the faster route to the next one, so the middle option was the one to drop. `Mod+←→` inherited the cycling that used to sit on the bracket keys.
- **cycle layout, master count, master width** as separate keys. All three only ever produced *some arrangement of the screen*, so they folded into one rotation that visits every arrangement and nothing else. The master width is now the divider itself, which is draggable and sticks.
- **promote to master** as distinct from swap. Both meant "make this the master"; they differed only in whether the rest of the stack shifted down a slot. The survivor is the one that leaves untouched tiles alone.
- **decrease gap.** A gap is set once; `layout.cycleGap` wraps, and `GAP_STEPS` is kept short so coming back round is quick.

`Mod+1 … 9` was cut in the first pass and put back immediately afterwards, so it is *not* on this list.

Actions are declared once in `shell/docking/actions.ts` and both the keybind registry and the tile context menu derive from that list, so adding one cannot forget the mouse path. Two opt-outs exist: `hidden` keeps a member of a family out of the reference modal, and `menu: false` keeps a dock-wide action out of the context menu. Both default to *listed*, so a new action is discoverable unless someone deliberately says otherwise.

### Dark-mode inversion

**One switch for the whole document, and it stays one switch.** Inversion is `filter: invert(1) hue-rotate(180deg)` applied by a single class on the pages container. The browser's compositor does the work, so flipping it costs one DOM write however many pages are live and whatever the zoom, and the canvas pixels are never touched — which is what keeps a copied region carrying the document's own colours.

`hue-rotate(180deg)` after the invert is not decoration: inverting alone also inverts hue, so a blue diagram would come out orange. Rotating a half turn puts the hues back.

Two things this deliberately is **not**, both tried and both removed:

- **Anything that inverts only part of a page.** It requires keeping a pristine copy of every page and repainting the visible canvas from it, which costs an allocation and a copy per page plus a repaint on every change — and on real documents the result was not distinguishable from inverting the whole page. Rebuild it only with evidence from documents where the difference is visible, and expect to pay that cost back.
- **Modes, tints, and per-page exceptions.** They existed to correct and tune the above. A control that offers states the user cannot tell apart is worse than a switch.

**Viewer plugins get their own layer, and it does not compete with this one.** A plugin's bindings are registered only while its tile is focused (see "How a plugin reaches the shell"), so `PageDown` can mean "next page" in a PDF and nothing at all elsewhere, and phase 04's video plugin can want the same key without a negotiation. Two rules keep that from becoming a free-for-all:

- **The shell's spaces are off limits.** `Mod`+letter, `Mod`+digit and `Mod`+arrow all belong to the shell, whether or not it currently uses every combination. The PDF plugin lives in the two spaces left over: the document keys a reader already reaches for (`PageUp`, `PageDown`) and bare letters, which are safe because the registry refuses to fire an unmodified binding while a text field has focus. `Mod+=`, `Mod+-` and `Mod+P` are the deliberate exceptions — conventional to the point that moving them would be worse than the risk, and unclaimed by the shell.
- **The same one-binding-per-job rule applies.** A plugin's section is rendered into the same modal, so an alias costs a chip there exactly as a shell alias does.
- **A plugin's section is not a manual.** The PDF plugin shipped with sixteen shortcuts and was cut to seven listed ones on feedback that there were simply too many. That is the right order of magnitude: more rows than the whole shell lists, for one file type, means the list is documenting the implementation rather than teaching the tool. `viewers/pdf/actions.ts` records what was cut and why, which is the part worth reading before adding to it. The self-test asserts the count **exactly** — an upper bound lets a phase spend the headroom silently — so growing it is a decision rather than a drift.
- **Phase 05a spent one row and stopped.** `a` (annotate) is the eighth, argued in `actions.ts` on the grounds that it is a *mode* rather than a command and that the tile had no annotation verb at all before it. The ten tools, the colours, the widths, the z-order and the save are in the palette that opens with it, and annotate mode's own four keys (undo, redo, delete, Escape) are registered `hidden` and gated by `enabled()` so they exist only while the mode is on. A binding that is not enabled does not consume the key press, which is what lets a plugin claim `Delete` and `Escape` without taking them from anyone.
- **Phase 05b spent none, and that was a decision rather than an oversight.** Text-anchored highlights and notes are made from a selection, and the popover that offers them appears on the selection — at the point the reader is already looking, naming both actions. A "highlight the selection" accelerator would be a tenth row for something already one click away, so the brief's instruction to weigh it against the cap was answered "no". The self-test asserts nine.
- **`Mod+S` is the ninth, and the exception that proves the shape of the rule.** Save was the one annotation verb reachable *only* from the palette, and it is the verb that puts the work on disk — so unlike undo, redo, delete and Escape it is listed rather than hidden, because it works with the mode off and its palette gone. It is another deliberate `Mod`+letter, on the same grounds as `Mod+P`, and `enabled()` gates it on the document having marks at all, so an unannotated PDF leaves the key untouched. The argument is written out in `viewers/pdf/actions.ts`; the self-test's count moved from eight to nine with it.

`src/viewers/pdf/actions.ts` is that plugin's `actions.ts`: one verb list, from which both its toolbar controls and its keybinds are derived, for the same reason the docking one exists. That single source is also what keeps a shortcut and its button in step — both read the same live value, so pressing `i` moves the toolbar toggle because there is only one place either of them can be reading from.

`shell/docking/layout.ts` is the thin bridge that reads the current layout out of dockview, asks `tiling.ts` for the new shape, and hands it back. Nothing else in the shell should re-derive any of this.

### Annotation model and export

Two annotation targeting strategies, not one, because a freehand highlighter stroke and a highlight tied to an exact sentence are answering different questions — "where on the page" versus "which words" — and conflating them was tried in an earlier draft of this phase and produced a highlight that couldn't survive a font substitution on export. `annotation/overlay/` answers the first question: every item (ink stroke, drawn highlight rectangle, shape, pasted image, point-anchored note) carries a page-relative position and nothing else. `annotation/text/` answers the second: every item carries a `TextAnchor` and no position at all; the position is derived at render time from wherever that text currently sits.

**A `TextAnchor` is a quote, not a coordinate.** `{ quote, prefix, suffix, pageHint, offsetHint }` — the quote plus a few dozen characters of surrounding context (the W3C Web Annotation Data Model's `TextQuoteSelector`, not invented here) is what actually identifies the annotation; `pageHint`/`offsetHint` are a fast path to skip straight to the right spot and are re-verified against the quote rather than trusted outright, so a highlight still finds its sentence if the hint drifts. This is more work than storing a bounding box, and it is the only version of this feature that survives the document being reflowed, re-OCR'd, or reopened after `pdf.js` renders it fractionally differently — a coordinate does not.

Phase 05b built that model and found three things worth not rediscovering:

- **Match the quote, don't count characters — in both directions.** Resolution falls back from an exact search to one over whitespace-collapsed text, because two extractions of the same page can disagree about whether a line break is a newline, a space or nothing at all, and a highlight that vanishes for that reason is precisely the failure a quote model exists to prevent. The same trick runs the other way when a *selection* is turned into an anchor: the DOM walk locates each text node's value in the extracted page text rather than counting its length, so a span pdf.js did not emit (or a `<br>` it did) costs one failed `indexOf` instead of an offset error that grows to the bottom of the page.
- **Slice the quote out of the extracted text, never out of `Selection.toString()`.** The browser assembles that string from the DOM and puts line breaks where the *layout* has them; the anchor has to be findable in the string the resolver will search. Slicing from that same string makes it findable by construction.
- **An anchor spanning two pages is one mark on the first page.** A PDF annotation belongs to exactly one page, so the anchor stops at the end of the page the selection started on. Making the first mark silently is better than refusing to make any.

**Rendering a text anchor resolves to rectangles from text-item geometry, not the DOM Range API.** Wrapping the anchored range in a `<mark>`-equivalent inside the text layer looks simpler until the range crosses a line wrap, at which point the DOM has to be split mid-span and reassembled on every re-render. Resolving an offset range within a page's extracted text back to one or more page-relative rectangles, using the same text-item geometry that already backs phase 03's text layer, is also exactly what search-match highlighting will need in phase 06. Phase 05b builds this resolver once, in `viewers/pdf/textGeometry.ts`, because it needs it first; phase 06 imports it rather than writing a second version. `instance.ts`'s own `#pageSegments` was moved onto it in the same change, so the offsets a search reports, the offsets an anchor records and the offsets a highlight is drawn from are one derivation rather than two that agree today.

**Once resolved, a text anchor is a highlight, and is drawn and exported as one.** `PdfAnnotator.derivedMarks()` hands the resolved rectangles to the same SVG layer the drawn marks use, and `exportAnnotatedPdf`'s `textItems` go through the same `/Highlight` builder — same `/QuadPoints`, same appearance stream, same multiply blend. There is no second rendering path and no second export path, which is the phase brief's constraint and also the only way "the file looks like the tile did" stays one question. What stays different is upstream: a derived mark is not in the overlay document, so it cannot be selected, moved, resized or undone, and its rectangles are recomputed rather than stored.

**An OCR'd scan is not a special case, and keeping it that way takes one deliberate omission.** Text rendering mode 3 — invisible glyphs positioned over a picture of them — is how every OCR tool embeds what it found, and pdf.js reports those items through `getTextContent()` like any others. Nothing in the text layer or in `textGeometry.ts` looks at the rendering mode, and nothing may start to: skipping glyphs nobody can see looks like an optimization and would make every scanned document unselectable. Page 3 of `viewers/pdf/dev/fixture.ts` is exactly that page, so the self-test holds this in place rather than trusting it.

**Every annotation exports as a real PDF annotation object, not a flattened mark, wherever pdf-lib's API allows it.** This is the line between this app's output and an "annotation" that is actually a raster stamp burned into the page: a Highlight, Underline, StrikeOut, Squiggly, FreeText, Ink, Square, Circle, Line, or Text/Popup annotation dictionary stays a real, standards-compliant PDF object — selectable as an object, editable, and removable in any other compliant reader, the same bar the free tier of the market leaders already hold themselves to. **Verify pdf-lib's current high-level support for each of these subtypes before writing to it**; where it is missing, construct the annotation dictionary directly through pdf-lib's low-level `context`/`PDFDict` API rather than falling back to flattening — flattening is the fallback of last resort for a subtype pdf-lib genuinely cannot represent, not a default. A pasted image is the one type that is legitimately a `Stamp` annotation with an image appearance stream rather than page content, for the same reason.

Phase 05a did that verification and built `annotation/export/pdf.ts` on the answer, which was: **pdf-lib 1.17.1 has no annotation API at all** — no constructor, no helper, for any subtype — so every dictionary is assembled with `context.obj`/`context.register` and attached with `PDFPageLeaf.addAnnot`. Nothing is flattened, and the page's own content stream is never touched (the self-test asserts exactly that: the original text still in the content stream, the callout's text not in it). Two things learned in the building that are worth not rediscovering:

- **Write an appearance stream for every annotation.** A dictionary with no `/AP` asks the *reader* to draw the mark, and readers disagree — pdf.js draws almost none of them. Without `/AP` the export looks right in whatever produced it and empty everywhere else.
- **A `/BBox` of zero area clips an appearance to nothing.** Both `/Rect` and the form's `/BBox` come from the item's bounds, so an item whose bounds had gone stale exported as a *correct annotation object that renders as nothing* — right subtype, right page, invisible. The export re-derives bounds from the item's own geometry rather than trusting the field. Found by rendering an export through poppler, which is also the cheapest way to check this class of bug: `pdftoppm -png` and look.

**The annotated flag lives inside the file, not in its name.** A rename or a move breaks a filename convention; it does not break a custom entry in the PDF's own Info dictionary or XMP metadata, whichever pdf-lib actually supports cleanly (verify before committing to one). On save: if the *currently open* file already carries the marker, write back to that same path — this is what keeps annotating a file twice from producing `report-annotated-annotated.pdf`. If it does not, the target is `<name>-annotated.pdf` alongside the original, the marker is written into it, and the open tile is repointed at the new file, so every later save in that session lands on the annotated copy and the original is never written to again. A target path that already exists and already carries the marker is treated as that same companion file; one that exists and does not carry the marker is an unrelated file with a coincidentally similar name, and gets a numeric suffix instead of being overwritten — clobbering a stranger's file is a data-loss bug, "clutter" is not.

**The two places that rule stops and asks.** Both are cases where the filesystem genuinely does not say what the user meant, and guessing either way is wrong half the time. *On save*, a companion that exists and is ours: overwriting it is right when this is a continuation of last week's markup and wrong when it is a second, separate pass, so `resolveAnnotatedTarget` takes an optional `confirmReplace` and declining walks on to the next free `-annotated-N`. *On open*, the mirror image: a file whose annotated copy is sitting next to it is very often not the file the user wanted, so `shell/openFiles.ts` offers the copy — the most recently written one, when a document has been annotated more than once — before anything is mounted. That side belongs to the shell because the contract reserves "which file a tile stands for" to it, and it is answered from one directory listing over `annotatedCompanionOrdinal`, the name rule read backwards. Both prompts are the OS's own two-button dialog, the same conversation as the open and save pickers; callers that supply no `confirmReplace` — the export path, the self-test's fake filesystem — get phase 05a's silent behaviour unchanged.

Phase 05a settled the "whichever pdf-lib supports cleanly" on the **Info dictionary** (`/WorkspaceAnnotated`): `context.trailerInfo.Info` is public, round-trips through `save()`, and poppler reads the key back as custom metadata; XMP would mean hand-assembling an RDF packet and a metadata stream with no library help. The rule itself lives in `annotation/store.ts` as one I/O-free function over three yes/no questions, driven by the self-test against a fake filesystem — including the branch that must *not* overwrite a stranger's similarly-named file, which only ever runs on a machine that has one.

**"Repoint the open tile" is a save target, not a file swap.** The contract is explicit that the shell owns which file a client stands for, and that a plugin may only say what it is *displaying* (`ViewerHost.setDisplayName`). So the companion's path is remembered in `annotation/store.ts` under the document's key and the tile is *renamed* to the companion; every later save lands there, the original is never written again, and the tab, the sidebar and the status bar all say which file is being annotated. Handing the shell a different `FileHandle` would have put handle retention, plugin re-resolution and session restore under plugin control to achieve the same two observable effects. The tile deliberately does **not** reload from the companion: the live marks are still the live marks, and reopening the file would draw them twice — once from the model and once from the annotations now in the file.

### Clipboard, search and the command palette

Phase 06's three systems are one phase because they are one shape: shell UI that queries every open plugin through the contract and has to behave when a plugin does not answer. Four decisions in them are worth not rediscovering.

**Copy is selection first, then the whole file, and the status bar says which.** "Selection" is not a concept every plugin has — the image plugin says so outright, and `window.getSelection()` is empty over a canvas and over the video engine's native surface — so a `Mod+C` that reported "nothing selected" would be useless on two of the three plugins. Falling through to `{ kind: "all" }` gives each one its own honest answer to "copy this": the text for a PDF, the picture for an image, the current frame for a video. The shell deliberately does *not* fall back to "the current subdivision", which would read better for a long document: the contract has no way to ask which subdivision a tile is showing, and inventing one for a fallback is not the same as inventing one because a feature needs it.

**The scratch panel and the history are different things.** History fills itself, is capped at 25, and is never curated; scratch takes nothing without a deliberate yank and drops nothing on its own. That is why they have separate keys rather than one action doing both — collecting six quotes from four documents is a different job from "what did I copy a minute ago", and an automatic scratch panel is full of things nobody chose. Neither survives a restart, the history because the brief says so and the scratch panel because its entries can hold image blobs and phase 07 should not be writing megabytes of PNG into the session store. `shell/clipboard/store.ts` owns every object URL it mints and revokes it on removal, on eviction and on clear; a panel someone parks twenty screen regions in is exactly where a leaked blob is expensive.

**Search asks the plugin when it can and matches itself when it cannot.** `ViewerSearchApi` splits in half on purpose: `find` is optional and exists for hit rectangles the shell cannot derive (the PDF plugin interpolates a box across the matched glyphs), while `extractText` is required and the shell matches over its segments. The video plugin has subtitles — text with timestamps and no geometry — and gets a working search without implementing `find`. A plugin with no text at all is *counted*, not listed and not errored: "3 in 1 tile · 2 without text" is a true sentence about a workspace holding a PDF, an image and a video, and it is the phase brief's third verification rendered as one line rather than as an absence someone has to interpret.

**The palette is derived, not listed.** Its entries come from the dock's action list, the focused plugin's contributed keybinds and toolbar controls, and the shell's own verbs — so "trigger annotation mode on the focused tile if supported" needed no code that knows what annotation mode is, and an action added by a later phase appears in the palette for free. Contributed keybinds win over toolbar controls of the same label, because every plugin here derives both surfaces from one verb list and the binding is the half that carries an accelerator and an `enabled()`. Hidden bindings are left out: `hidden` is an author saying "registered but not listed", and the palette is a list.

### Session persistence

Phase 07's job is one sentence — the workspace survives a restart — and four decisions in it are worth not rediscovering.

**The order of a restore is the design.** Preferences and annotations first (a tile asks for both at mount, so restoring them afterwards means an image that opens at the wrong fit mode and then corrects itself); then the shell's own state; then **every client, with its recorded id and no file**; then the grid; then the files, in parallel. Steps one to four cannot fail on account of a file, because they never touch one — which is what makes a moved file cost exactly one tile. Reusing the recorded client ids rather than minting new ones is what lets dockview's own serialization be handed back verbatim: the panel ids in it *are* the client ids, so there is no id-rewriting pass to get wrong. `restoreClients` advances the counter past whatever the record used, so a file opened afterwards cannot collide.

**A tile can now exist before its file does, and that is a third state, not an error state.** `WorkspaceClient.fileHandleId` is empty while a restore is in flight and `problem` carries the failure when one arrives; `ViewerSurface` renders "reopening…", the contract's error panel, or a mounted viewer. The panel offers *retry* and *locate…* — the second is the native picker, which is simultaneously the answer to "the file moved" and to a platform that wants access to a path re-confirmed, since on macOS and inside a sandbox the picker **is** the grant. Both are per tile, per the brief: a modal for one tile's problem would block the four that opened perfectly.

**The write is debounced; the collection is what that buys.** A save request is a boolean and a timer — nothing is serialized, dockview is not asked for its layout, and no plugin is asked for its state until the timer fires. That is what makes it safe for `onDidLayoutChange` to request a save on every frame of a sash drag, which it does. Two numbers, because one is not enough: 400 ms of quiet collapses a drag, and a 2 s ceiling stops a *continuous* stream of changes from deferring the write indefinitely. Measured in the real engine: sixty full re-tiles in 856 ms produced **no writes during the churn and one after it**. The dock hands over `toJSON` as a *function* (`provideSessionLayout`) rather than pushing a snapshot, which is the same reasoning one level down.

**"Clear saved session" stops recording, and saying so is half the feature.** Deleting the record and then immediately rewriting it from the very tiles the user was trying to stop reopening would answer a different question, so the rest of the run is not recorded and the next launch starts empty — the brief's third verification. The status line says both halves ("no files were changed; this session will not be saved") because the first is the confirmation the brief asks for and the second is what would otherwise look like a bug three tiles later. It is a command-palette entry with no accelerator: rare, deliberate housekeeping is exactly what the palette is for, and phase 06's rule about not spending a chip on a job another path already covers applies to it too. **Phase 07 added no keybinds.**

Three things are deliberately *not* in the record, and each has a reason that is not "we ran out of time": the clipboard history and scratch panel (phase 06's decision, and the scratch panel can hold image blobs); a file with no path on disk, which includes every in-memory fixture — and, for the same reason, annotations keyed on a handle id rather than a path (`isRestorableDocumentKey`), without which every dev self-test run would leave a permanent unmatched document in the session file; and the grid itself whenever any open tile could not be recorded, since a layout naming a panel the restore will not create is one the record cannot honour.

**A pasted image is base64 on its annotation item**, so annotations are the one part of the record that can be large. `MAX_ANNOTATION_BYTES` keeps the most recently edited documents and drops the rest with a warning, rather than either refusing to persist annotations (they are the user's work, and the brief requires an in-progress one to survive a restart) or letting the file grow without limit.

**The app does not listen for its own window closing, and that is a decision.** Tauri calls `api.prevent_close()` as soon as *any* JS listener exists for the close-requested event (`tauri/src/manager/window.rs`), so a handler that flushed on quit would also become the only thing able to close the window — and closing it needs `core:window:allow-destroy`, which the default capability set withholds on purpose. A renderer wedged mid-decode would then be a window whose close button does nothing. What that buys is the last few hundred milliseconds of *view* state on a quit that lands inside the debounce's quiet period; annotations reach the disk through the export path, not through this record. `pagehide`, `beforeunload` and `visibilitychange` cover the rest.

The record lives in `session.json` in the OS's app-data directory, written through the Tauri store plugin (`store:default` already grants every command it uses). Outside the Tauri shell — the dev browser, a bundled self-test — the backend is memory and says so once in the dev log; there is deliberately no `localStorage` fallback, because a persistence path that only works where it is untested is worse than one that visibly does nothing.

## Execution order

Work through `/prompts` in this sequence. Each phase assumes the previous one is complete and merged. Do not skip ahead; the docking library and plugin contract are load-bearing for everything after them.

1. `01-scaffold-and-core-architecture.md` - project scaffold, Viewer Plugin contract, file-type registry, Tailwind theme.
2. `02-tiling-shell.md` - docking integration, freeform split/stack/resize, minimal toolbar shell, keybind reference shell.
3. `03-pdf-viewer-plugin.md` - PDF rendering and virtualization, dark-mode inversion, text layer/copy, thumbnails, zoom, print.
4a. `04a-image-viewer-plugin.md` - comprehensive image viewer plugin, full format coverage, no inversion.
4b. `04b-video-viewer-plugin.md` - comprehensive video player plugin on a libmpv playback engine (revised; see the file's rationale for why the native `<video>` element was replaced), full format coverage, no inversion. Independent of 4a; may be worked in parallel. **Built against the prior native-`<video>` version of this brief and not yet migrated** — the feature set is there, the engine underneath it is the superseded one. The brief says to run `04b-refactor-migration.md` in exactly this situation and **that file was never written**, so writing it is the first step of the migration, not a preliminary to it.
5a. `05a-pdf-annotation.md` - PDF annotation authoring: overlay model (highlight/ink/shapes/pasted images/point notes), native PDF annotation object export via pdf-lib, the annotated-flag overwrite-on-save mechanism.
5b. `05b-pdf-text-annotation.md` - text-anchored highlights and notes for PDF text, native and OCR-embedded alike; builds on phase 03's text layer and phase 5a's export pipeline. The `TextAnchor` model is designed to carry over to future text-based plugins (txt, docx).
6. `06-clipboard-search-command-palette.md` - cross-viewer clipboard, global search adapter, command palette actions. Reuses `viewers/pdf/textGeometry.ts` from phase 05b for match-highlighting rectangles rather than re-deriving them. Added `ViewerCopyApi.locateRegion` to the contract, the status bar's announcement line, and the sidebar's last two panels; see "Clipboard, search and the command palette" above.
7. `07-persistence-and-native-io.md` - session/layout persistence with real file handles across plugin types. Added `ViewerPluginDescriptor.preferences` to the contract (the one contribution point that is not scoped to a tile), the client's third state — a tile whose file has not arrived, or cannot — and the command palette's "clear saved session"; see "Session persistence" above. No native menu was built, so the `Cmd`+`W` warning under "Platform targets" is still outstanding.
8. `08-visual-language-and-consolidation.md` - Tailwind theme finalization, toolbar consolidation, no-scroll verification.

## Building and releasing

Tauri produces a separate native binary per OS. **Cross-compilation is not supported**: each platform's bundle must be built on that platform, or on a CI runner for it. Running `npm run bundle:windows` on Linux will not produce a Windows installer. There is no browser build and no mobile build (see "Platform targets").

The build and clean tooling lives in `scripts/` as POSIX shell scripts, written for bash 3.2 so they run on a stock macOS as well as Linux. Each is usable directly or through the npm alias; `scripts/lib.sh` holds the shared helpers and is not run on its own.

| Command | Script | What it does |
| --- | --- | --- |
| `npm install` | | Install frontend dependencies. Rust crates are fetched on first build. |
| `npm start` | | Run the app in development with hot reload (`tauri dev`). |
| `npm run typecheck` | | TypeScript only, no output. |
| `npm run build` | | Frontend bundle only, into `dist/`. Invoked automatically before a native build. |
| `npm run bundle` | | Native bundle for whatever OS you are on, using that OS's default formats. |
| `npm run bundle:linux` | `scripts/build-linux.sh` | `.deb`, `.rpm`, `.AppImage`. Linux hosts only. |
| `npm run bundle:macos` | `scripts/build-macos.sh` | `.app` and `.dmg`. macOS hosts only. |
| `npm run clean` | `scripts/clean.sh` | Remove `dist/`, `src-tauri/target/`, `src-tauri/gen/` and the Vite cache. Keeps `node_modules`. |
| `npm run clean:all` | `scripts/clean.sh --all` | The above plus `node_modules`. Use before archiving or sharing the project. |
| `npm run clean:dry` | `scripts/clean.sh --dry` | List what would be removed, and how much space it frees. Deletes nothing. |

Both build scripts accept `--bundles <formats>` to narrow the output and `--debug` for an unoptimized build with devtools enabled; `build-macos.sh` additionally accepts `--universal` for a single binary that runs native on both Intel and Apple silicon. Each checks its prerequisites first and refuses to run on the wrong host rather than failing halfway through a Rust build. Pass `--help` to any of them.

Bundles land in `src-tauri/target/release/bundle/<format>/`.

**Windows bundling is not scripted yet.** `npm run bundle` works on a Windows host and produces the NSIS and MSI installers; a `scripts/build-windows.ps1` matching the other two is still to be written. The shell scripts above will not run under stock PowerShell or `cmd`.

### Per-platform prerequisites

- **Linux** — webkit2gtk 4.1 development headers plus GTK 3, librsvg and (for AppImage) patchelf. Fedora: `webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel patchelf`. Debian/Ubuntu: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`. Building `.rpm` additionally needs `rpm-build` (`rpm` on Debian/Ubuntu). **Phase 4b would add `libmpv-dev` (`mpv-libs-devel` on Fedora)** — not yet a prerequisite, because the libmpv integration is not built; `scripts/build-linux.sh` checks for webkit2gtk-4.1 and nothing else, which is currently correct. Add the check in the same change that adds the dependency.
  - AppImage packaging needs `NO_STRIP=true` and `APPIMAGE_EXTRACT_AND_RUN=1` on any current distro: linuxdeploy ships its own outdated binutils, whose `strip` cannot read the `.relr.dyn` sections modern toolchains emit, and it self-mounts through FUSE, which containers and CI runners usually lack. `scripts/build-linux.sh` sets both automatically. Invoking `npm run bundle` directly does not, and will fail on the AppImage step with nothing more useful than `failed to run linuxdeploy`.
- **Windows** — Microsoft C++ Build Tools and the WebView2 runtime (preinstalled on Windows 11; the bootstrapper is bundled by the NSIS installer for Windows 10). **Phase 4b's libmpv wrapper library was said to be fetched by its own setup step** rather than manually installed — unverified, and unverifiable until the engine is built, since the claim was about `tauri-plugin-libmpv`, which Phase 4b then decided against in favour of raw FFI. Establish the actual mechanism when the engine is built and document it here then.
- **macOS** — Xcode Command Line Tools, which `scripts/build-macos.sh` checks for. Builds run on macOS 14.0 or newer per the floor above.
  - **Signing and notarization are documented here and implemented nowhere.** Distribution outside your own machine needs an Apple Developer ID; unsigned `.app` bundles are blocked by Gatekeeper. `build-macos.sh` says so at the end of a run and does nothing about it: there is no `codesign`, no `notarytool`, no `APPLE_SIGNING_IDENTITY`/`APPLE_ID`/`APPLE_TEAM_ID` handling, and no `bundle.macOS` signing configuration. `npm run bundle:macos` produces an unsigned bundle that runs on the machine that built it. Wiring this up is a task, not a footnote.
  - There is no `bundle.macOS` Info.plist configuration either, which matters as soon as a restored session reopens a file under `~/Documents`, `~/Desktop` or `~/Downloads`: macOS gates those behind TCC. The per-tile "locate…" in `persistence/restore.ts` is the right recovery when access is refused and is implemented; whether a prompt appears at all, and whether it reads sensibly without `NSDocumentsFolderUsageDescription` and friends, has never been observed.
  - **Phase 4b would add `libmpv`** (`brew install mpv` provides the shared library) — for the engine that is not built. Whether the build links dynamically against the Homebrew copy or bundles a vendored one **is still undecided**, and nothing in `src-tauri` implements either; decide it as part of building the engine, not before.

### Keeping this section current

This section is expected to drift as phases land, so treat updating it as part of the work, not as cleanup afterwards. Whenever a phase adds a build step, a generated directory, a native system dependency, or a new bundle format:

1. Update the command table and the prerequisites list above.
2. Add any new generated path to the `targets` list in `scripts/clean.sh` **and** to `.gitignore`, so it is both removable and untracked.
3. Re-run `npm run clean:dry` and confirm it accounts for everything the phase generates.

**Phase 07 generates a file outside the project, and `clean.sh` must not learn to remove it.** The session record is `session.json` in the OS's app-data directory (`~/.local/share/com.workspace.app/` on Linux, `~/Library/Application Support/com.workspace.app/` on macOS, `%APPDATA%\com.workspace.app\` on Windows) — user data belonging to an installed app, not build output belonging to this checkout, and a clean script that deleted a user's saved workspace would be doing something nobody asked it to. "Clear saved session" in the command palette is the in-app way to remove it, and deleting the file by hand is the other. `npm run clean:dry` is unchanged by this phase.

A phase is not complete until a fresh clone plus `npm install` plus `npm run bundle` succeeds on at least one platform, and `npm run clean:all` leaves nothing behind but source.

## Open items and unverified decisions

Everything this project knows it has not settled, in one list, because the alternative
is what it was before: a dozen "verify before shipping" clauses scattered across this
file and the phase briefs, each invisible unless you happened to read that paragraph.
**Add to this list rather than leaving a note where you were working.** A line leaves
this list when it is done or when it is decided — not when someone reads the code and
concludes it looks right.

Three of these were open deliberately, pending exactly the kind of review that produced
the rest of the list: the libmpv linking mechanism, the Windows wrapper-library fetch,
and the NSView path's status.

**Needs a Mac. Cannot be closed by reading code, and must not be.**

1. **The macOS menu has never been compiled or run.** `src-tauri/src/menu.rs` is
   type-checked by `cargo check` on Linux and nothing more. Confirm it builds, that the
   four freed accelerators reach the webview, and — the part most likely to be wrong —
   that copy and undo still work inside the app's own text fields with those Edit items
   removed. See "Platform targets".
2. **The `ClipboardItem`-holding-a-promise question on WKWebView.** `Mod+C` awaits
   `getCopyable` and a PNG transcode before `navigator.clipboard.write`. Measured fine
   on webkit2gtk, never tried on WebKit proper. See `shell/clipboard/system.ts`.
3. **The late audio on resume is mitigated, not measured.** A macOS build reported
   sound arriving a beat after the picture on every resume from pause, alongside a
   speed control that did nothing. The speed half is understood and covered by
   self-tests (`defaultPlaybackRate` is written with every rate, and a rate the engine
   drops is put back). The audio half has two changes behind it and neither has been
   heard on a Mac: pitch correction is now switched off at exactly 1×, so WKWebView
   keeps no spectral time-pitch unit in the audio path to prime, and `Transport`
   re-primes the pipeline with a sub-frame seek before a resume **on macOS only**.
   Confirm on a Mac. If the gap is gone without the seek, delete `#primeForResume` —
   it is a workaround and it says so.
4. **The macOS PDF hang is diagnosed and fixed; what is left is confirming the mode
   on a Mac.** It took two rounds and both are worth keeping, because the first was a
   wrong diagnosis that survived review by being plausible.
   *Round one* blamed the custom scheme: pdf.js resolving its worker URL against an
   origin the URL Standard calls `"null"`. That reading is wrong on WebKit (see
   "Platform targets"), so the branch never ran. The work was not wasted —
   `viewers/pdf/pdfjs.ts` now takes URLs out of the question entirely (worker from
   inlined source, measured before use, handed to pdf.js as `getDocument({ worker })`,
   every await deadlined) — but it did not fix the reported bug.
   *Round two* is the real cause, and it is a version gap, not a scheme problem:
   **pdf.js 5.5.207 uses built-ins that WebKit only shipped in Safari 18.2, and
   WKWebView runs whatever Safari the machine is on.** `MessageHandler` dispatches
   every request that expects an answer through `Promise.try`, so the document request
   itself threw inside the worker's message listener, nothing replied, and the load
   never settled. Fixing that alone then exposed `Uint8Array.prototype.toHex`, which
   builds the fingerprint pair every open waits for. `viewers/pdf/compat.ts` polyfills
   eight built-ins in both realms, and it was finished by *measurement* rather than by
   reading — see the floor bullet under "Platform targets". Verified on webkit2gtk with
   the entire post-17.0 surface deleted from the page and from the worker: 29/29, and
   two real font-embedding PDFs render **pixel-identically** to the same files on the
   unmodified engine. With the shim defeated, the tile names the cause in about a
   second instead of timing out.
   *Round three* was the lesson that mattered. Two rounds of "polyfill the thing that
   broke" is a pattern, not a fix, so the worker is no longer trusted to have the
   globals it was sent: `compat.ts` **posts what it found from inside the worker
   realm**, before pdf.js evaluates, and `pdfjs.ts` declines any worker that reports a
   gap or reports nothing at all — falling back to the main thread, whose globals this
   app patched itself and can vouch for. The main-thread path re-asserts and re-checks
   them too, after a megabyte of third-party module has been evaluated in that realm.
   So a built-in nobody has noticed yet costs a slower decode, not a broken viewer.
   Measured with the shim deliberately withheld from the worker: 28/29 (only the check
   that *asserts* worker mode fails), and a real PDF renders pixel-identically.
   What is left: open a PDF in a macOS **bundle** (not `tauri dev`) and read the mode.
   No dev build is needed for that any more — **every PDF load failure now carries
   `pdfEnvironment()` in its detail**, naming the version, the thread, and the
   built-ins each realm was missing, because the self-test panel is stripped from
   release builds and two round trips were spent on screenshots that could not say
   which engine they came from. `main-thread` means PDFs work and the platform is being
   carried, which is the next thing to look at.
4b. **Pages that render blank on macOS — the same engine gap, one layer down.** The
   document opened, the text and annotation layers were correct, and every page canvas
   stayed white. The cause was `Map.prototype.getOrInsertComputed`, which
   `PDFPageProxy.render` calls on its first line: every render threw immediately, and
   the strip's generic "page N could not be rendered" hides itself after a few seconds,
   so what the user saw was blank paper. It was found by *deriving* the built-in
   frontier rather than reading pdf.js again — see the floor bullet under "Platform
   targets", and do it that way.
   Two changes came out of chasing it that are worth keeping either way.
   `viewers/pdf/page.ts` was changed to report rather than guess — and to correct one
   thing the app was doing wrong regardless. **The wrong thing:** the app
   created the 2D context itself, before pdf.js could, so `getContext` returned that
   one and pdf.js's own `{ alpha: false, willReadFrequently: !enableHWA }` was silently
   discarded — leaving every page on an accelerated backing store, which is exactly
   what the self-test's "Where pdf.js is allowed to draw" check says renders nothing on
   WebKit when the window is not composited. It now asks for what pdf.js asks for.
   **The reporting:** a render is deadlined at 30s and says *where* it stopped — pdf.js
   drives continuations through `requestAnimationFrame`, so "never began drawing" (no
   operator list) and "stopped drawing after N continuations" (frames not firing) are
   different sentences, and each carries whether frames fired at all. Separately, a
   render that *succeeds* and leaves the canvas empty is caught by sampling the canvas
   into a 32-pixel square; two of those with nothing drawn anywhere says so. Both
   messages, and the reason on every per-page failure, now reach the status strip
   rather than only the console — see the note in `instance.ts`.
   Confirm on a Mac: if pages are still blank the strip now names which of the three it
   is.
4c. **Text unselectable on macOS — the same engine gap, one layer further on — and a
   render collision found beside it.** Reported together: pages rendered, but nothing
   could be selected, and the strip carried *two* messages. They were unrelated causes
   that a slow engine surfaces at the same moment, and both are fixed and covered.
   **The selection half was the engine gap again**, in the one place the derivation
   above could not see: `PDFPageProxy.getTextContent` collects the decoder's answer with
   `for await (const value of readableStream)`, and
   `ReadableStream.prototype[Symbol.asyncIterator]` is Safari 17.4. Below that the loop
   throws `TypeError: undefined is not a function` naming nothing, from a path only text
   takes — so every page rendered and no page had words. `compat.ts` now supplies it
   (`values` and the symbol, one implementation), and the blind spot is written up in
   the floor bullet.
   **The render half was ours, not the engine's.** `PdfPageView.render` claimed its slot
   before the first `await` — which stopped a *concurrent* second render — but the slot
   could be taken away while the call was suspended in `getPage`, and a suspended render
   holds no task to cancel. It woke up and drew anyway, while the freed slot let the
   zoom that cancelled it start a second render of the same canvas; pdf.js refuses that
   outright with "Cannot use the same canvas during multiple render() operations". macOS
   is where it surfaced because a cold decoder makes that window wide enough for the
   opening fit-to-width to land inside it. Cancellation is now a counter that goes up
   rather than a task to stop, and a suspended render compares it after every `await`;
   the text layer got the same treatment, where two overlapping settle passes were
   reading one page's text twice and laying out two `TextLayer`s into one container.
   Both halves are verified on webkit2gtk with the shim defeated, and the render race
   has a self-test check of its own — 30/30, and 29/30 with the fix reverted, failing
   with exactly the reported sentence.
5. **Printing through WKWebView's PDF renderer.** `print.ts` hands a blob URL to a
   hidden frame and calls `print()`, falling back to rasterising only if that *throws*.
   A frame that loads, accepts `print()` and produces a blank sheet reports success.
   Confirm real output, and if it is blank, make the failure detectable.
6. **HEIC and TIFF native decode.** Both plugins try the platform decoder first and fall
   back; macOS is the platform expected to succeed at both. Confirm it does, so the
   fallback path is not silently carrying macOS as well.
7. **Keybinds exercised on a second platform.** `prompts/02-tiling-shell.md` requires
   two of three before Phase 2 is done; only Linux has ever run them. The self-tests
   force all three platforms in *logic*, which is not the same claim.
8. **TCC on a restored session.** Reopening a recorded path under `~/Documents`,
   `~/Desktop` or `~/Downloads`. See the macOS prerequisites.
9. **`minimumSystemVersion: "14.0"` is a judgement, not a measurement.** It guarantees
   the Safari 17.4 floor by OS version alone and excludes fully-updated Ventura.
   Revisit with the pdf.js pin.

**Decisions still to make**

10. **libmpv linking on macOS** — dynamic against Homebrew's copy, or a vendored static
    build. Undecided; nothing implements either. Decide it while building the engine.
11. **The Windows libmpv wrapper-library fetch mechanism** — the claim that it is fetched
    by its own setup step predates the decision to use raw FFI instead.
12. **`vo=gpu-next`** — `prompts/04b` says to confirm it is still mpv's recommended value
    at implementation time.

**Work that is specified and not built**

13. **The whole libmpv video engine**, including the NSView subview embedding path on
    macOS. Not "written and unverified" — absent. The shipped engine is the superseded
    native-`<video>` one. See the tech stack note.
14. **`prompts/04b-refactor-migration.md`** does not exist, though this file and
    `prompts/04b-video-viewer-plugin.md` both route the reader to it.
15. **macOS signing and notarization.** Documented as a requirement, implemented
    nowhere. See the macOS prerequisites.
16. **`scripts/build-windows.ps1`.**
17. **The GtkGLArea path against real compositors** (GNOME/Mutter, KDE/KWin) — Linux,
    listed here so the video engine's open items sit together.

**Known and deliberately left**

18. **Companion-file name matching is case-sensitive** (`annotatedCompanionOrdinal`),
    so on macOS's case-insensitive default a differently-cased `-annotated` copy is not
    recognised as one. The cost is a missed "open the annotated copy?" offer or a skip
    to `-annotated-2`; it is **not** a clobbering risk, because the guard against
    overwriting a stranger's file is a filesystem probe rather than this comparison.
    Fixing it properly means a platform-aware comparison inside a pure, self-tested
    function, which is a worse trade than the symptom.

## Migration notes from the original implementation

The original freeform tiling tree (`layoutTree`, `computeTreeLayout`, pointer-driven divider and rearrange handlers) should not be ported. It is the exact thing being replaced by the docking library. Reference it only to confirm feature parity (what interactions existed), not for implementation.

The original toolbar and keybind set (open, print, save, sidebar toggle, page nav, zoom, invert mode, keybind reference; master/swap/gap/fit-page/reset-zoom as keybind-only) should be ported as a specification, not as markup, since it will be rebuilt as React components against the new theme.

The image and video plugins have no prior implementation to port; the original app never supported these file types. Build them fresh against the Phase 1 contract and the feature specifications in `04a` and `04b`, using established top-tier viewers and media players in each category as the functional reference point, not the original PDF-only codebase.

Phase 4b was first built against a native-`<video>`-element engine, per the original brief. That implementation did not meet load-time or playback-smoothness requirements and the decision is to replace it wholesale with a libmpv-based native engine (see the revised `04b-video-viewer-plugin.md`). **That replacement has not happened**: what is in the repository is still the native-`<video>` engine, and `04b-refactor-migration.md`, which the revised brief routes migrators to, does not exist. Once the engine lands the native-`<video>` code path is not retained as a fallback.
