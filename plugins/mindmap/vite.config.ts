import { defineConfig } from 'vite';

export default defineConfig({
  // Required: plugin assets are loaded via tauri's asset:// protocol from an
  // iframe whose base URL is the plugin's index.html. Absolute `/assets/...`
  // paths resolve outside the plugin scope and 403. Relative `./assets/...`
  // resolves within the plugin dir.
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
