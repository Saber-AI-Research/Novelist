import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { singleFilePlugin } from '../vite-single-file';

export default defineConfig({
  // Plugin frames are sandboxed into opaque origins and loaded through the
  // asset protocol: ship one self-contained entry with a strict CSP.
  plugins: [svelte(), singleFilePlugin()],
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
