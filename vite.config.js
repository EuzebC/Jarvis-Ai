import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI is built into ui/dist and served by the Jarvis service, so the desktop app,
// a browser and (later) the phone app all load the same thing from the same origin.
export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:7777' } },
});
