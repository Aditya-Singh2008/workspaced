# Icon sources

`src-tauri/icons/` is generated, and **it is generated from two different
sources, not one**. Running `npx tauri icon <anything>` regenerates the whole
directory from a single input, which silently reverts half of what is committed
there. Read this before doing that.

| Shipped icon | Generated from | Why |
| --- | --- | --- |
| `icon.icns` (macOS) | `logo-1024-macos-inset.png` | macOS insets its app icons; see below |
| `icon.ico`, `Square*Logo.png`, `StoreLogo.png` (Windows) | `logo-1024-full-bleed.png` | Windows draws the tile edge-to-edge |
| `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png` (Linux) | `logo-1024-full-bleed.png` | hicolor entries are full-bleed |

## Why macOS gets its own source

macOS does not draw a container behind an app icon — the artwork *is* the
container, and every icon on the system is fitted to one grid so that a row of
them in the Dock reads as a row. Apple's grid for a rounded-square app puts an
**824×824 body on a 1024×1024 canvas**, i.e. a 100px transparent margin on every
side. A full-bleed 1024 icon is not "the same icon, slightly bigger": it is
about 24% larger in area than everything beside it, and it is the one that looks
wrong. Windows and Linux both composite the icon into their own frame and want
the full canvas, so they keep it.

`logo-1024-macos-inset.png` is the same artwork, cropped to its opaque bounds
and scaled onto that grid. Nothing else about it is altered.

## Regenerating

```sh
# Windows + Linux + the shared PNGs
npx tauri icon src-tauri/icons-src/logo-1024-full-bleed.png

# macOS only — into a scratch directory, then take the one file
npx tauri icon src-tauri/icons-src/logo-1024-macos-inset.png -o /tmp/macos-icons
cp /tmp/macos-icons/icon.icns src-tauri/icons/
```

Then **delete `src-tauri/icons/ios/` and `src-tauri/icons/android/`**, which the
command creates unasked. Mobile is out of scope (AGENTS.md, "Platform targets"),
and those directories are not wanted in the tree.

## Two known imperfections in the current artwork

Both are cosmetic, both are recorded so they are not rediscovered as bugs.

1. **The original export is 440×440.** Everything here is upscaled from it
   (Lanczos), so the 1024 and 512 slots carry no detail the 440 did not have —
   the edges of the W are marginally soft at Dock size. Every size at 256 and
   below is a downscale and is unaffected. Replacing the sources with a ≥1024
   export and re-running the two commands above fixes it with no other change.
2. **The corner radius is 17.0% of the side; Apple's squircle is 22.5%**, and
   Apple's is a continuous curve rather than a circular arc. So the icon sits on
   the right grid but its corners are visibly tighter than its neighbours'. This
   was left alone deliberately — correcting it means altering the artwork's
   silhouette, which is a design decision and not a packaging one.
