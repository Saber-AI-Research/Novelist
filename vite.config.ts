import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      "$lib": resolve("./src/lib"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "codemirror-core": [
            "@codemirror/state",
            "@codemirror/view",
          ],
          "codemirror-ext": [
            "@codemirror/commands",
            "@codemirror/language",
            "@codemirror/lang-markdown",
            "@codemirror/search",
            "@codemirror/autocomplete",
          ],
          "lezer": [
            "@lezer/common",
            "@lezer/lr",
            "@lezer/highlight",
            "@lezer/markdown",
          ],
        },
      },
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
}));
