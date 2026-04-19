import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Iframe is served via tauri asset:// protocol from the plugin dir; assets
  // must resolve relatively to the plugin's index.html, not to the protocol root.
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
