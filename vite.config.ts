import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * GitHub Pages serves a project site from https://<user>.github.io/<repo>/, so
 * every asset URL needs that prefix. The deploy workflow sets VITE_BASE to
 * "/<repo>/"; local dev and user/organisation sites leave it unset and get "/".
 */
// This file is type-checked with the browser lib set, so Node's `process` is not
// declared. Declaring it locally reads the one build-time variable we need
// without adding @types/node — which would mean regenerating package-lock.json
// for a single string lookup.
declare const process: { env: Record<string, string | undefined> };

const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5173, open: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
});
