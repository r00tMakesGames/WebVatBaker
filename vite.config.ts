import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * GitHub Pages serves a project site from https://<user>.github.io/<repo>/, so
 * every asset URL needs that prefix. The deploy workflow sets VITE_BASE to
 * "/<repo>/"; local dev and user/organisation sites leave it unset and get "/".
 */
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5173, open: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
});
