import { defineConfig } from 'vite';
import { singleFilePlugin } from '../vite-single-file';

export default defineConfig({
  // Plugin frames are sandboxed into opaque origins and loaded through the
  // asset protocol: ship one self-contained entry with a strict CSP.
  plugins: [singleFilePlugin()],
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
