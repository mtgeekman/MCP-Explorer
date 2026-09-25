// Builds the renderer only (D33). Main, the utility process and the preload
// are built by tsc. `base: './'` because the packaged app loads the page from
// a file, where absolute asset paths would point at the filesystem root.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../../dist/renderer', import.meta.url)),
    emptyOutDir: true,
    // Every asset as a file: the page's CSP allows fonts and images from
    // 'self' only, and an inlined data: font would be blocked.
    assetsInlineLimit: 0,
  },
  server: { port: 5199, strictPort: true },
});
