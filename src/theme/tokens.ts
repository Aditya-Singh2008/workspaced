/**
 * Programmatic access to the design tokens defined in `theme.css`.
 *
 * Components style themselves with Tailwind utilities and never need this.
 * It exists for the places where a token has to become a literal string:
 * canvas/WebGL drawing inside a viewer plugin, an `ImageData` fill, a color
 * passed to a third-party renderer.
 *
 * `theme.css` remains the single source of truth. Nothing here hardcodes a
 * value; every accessor resolves the live CSS custom property.
 */

/** Every design token, by the CSS custom property that defines it. */
export const themeTokens = {
  bg: "--color-bg",
  surface: "--color-surface",
  surfaceRaised: "--color-surface-raised",
  surfaceHover: "--color-surface-hover",

  fg: "--color-fg",
  fgDim: "--color-fg-dim",
  muted: "--color-muted",
  disabled: "--color-disabled",

  accent: "--color-accent",
  accentDim: "--color-accent-dim",
  accentFg: "--color-accent-fg",
  selection: "--color-selection",

  border: "--color-border",
  borderStrong: "--color-border-strong",
  borderAccent: "--color-border-accent",

  error: "--color-error",
  warn: "--color-warn",
  ok: "--color-ok",

  fontMono: "--font-mono",
} as const;

export type ThemeToken = keyof typeof themeTokens;

/**
 * A `var(...)` reference to a token, for inline styles and CSS-in-JS.
 * Prefer a Tailwind utility class where one exists.
 */
export function themeVar(token: ThemeToken): string {
  return `var(${themeTokens[token]})`;
}

/**
 * The token's *computed literal value* (e.g. `"#0d1117"`), for APIs that cannot
 * accept a CSS variable — `CanvasRenderingContext2D.fillStyle` being the usual
 * case.
 *
 * Resolved against the document root, so it reflects any future theme
 * switching without callers needing to know a switch happened.
 */
export function resolveThemeToken(token: ThemeToken, scope?: Element): string {
  const element = scope ?? document.documentElement;
  return getComputedStyle(element).getPropertyValue(themeTokens[token]).trim();
}
