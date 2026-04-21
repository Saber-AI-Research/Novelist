import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    svelte(),
    tailwindcss(),
    // Remove modulepreload hints for lazy-loaded chunks (CodeMirror, mermaid,
    // katex, opencc, etc.). These are loaded on demand — preloading them wastes
    // bandwidth and increases WebKit's initial JS parse/compile pressure.
    {
      name: 'no-modulepreload-lazy',
      enforce: 'post' as const,
      transformIndexHtml(html: string) {
        return html.replace(
          /<link rel="modulepreload"[^>]*href="[^"]*(?:codemirror|lezer|mermaid|katex|cytoscape|full-|chinese)[^"]*"[^>]*>\n?/g,
          '',
        );
      },
    },
  ],
  resolve: {
    alias: {
      "$lib": resolve("./app/lib"),
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
    watch: { ignored: ["**/core/**"] },
  },
  build: {
    // All chunks >500KB are lazy-loaded (mermaid, opencc-js, cytoscape).
    // They never affect initial load time — suppress the warning.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          'codemirror-core': [
            '@codemirror/state',
            '@codemirror/view',
          ],
          'codemirror-ext': [
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/lang-markdown',
            '@codemirror/search',
            '@codemirror/autocomplete',
          ],
          'lezer': [
            '@lezer/common',
            '@lezer/lr',
            '@lezer/highlight',
            '@lezer/markdown',
          ],
        },
      },
    },
  },
}));
