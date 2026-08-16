import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // pdf.js is only reached through a dynamic import (see
  // `src/viewers/pdf/index.ts`), so the dev server would not discover it until
  // the first PDF is opened — and discovering a dependency that large
  // mid-session means a re-optimize and a full page reload in the middle of
  // whatever was being tested. Naming it here gets it pre-bundled at startup
  // instead. Production builds are unaffected: Rollup still code-splits it.
  optimizeDeps: {
    include: ["pdfjs-dist"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
