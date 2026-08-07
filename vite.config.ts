/// <reference types="vitest/config" />
// Types-only reference, so tsc knows about the `test` block below (it was TS2769 before)
// WITHOUT importing vitest at build time — vite.config.ts is loaded by `vite build` on
// Vercel, and a real `import ... from 'vitest/config'` would make the prod build depend on
// a devDependency being installed.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ is Playwright's, not vitest's — its specs import '@playwright/test'
    // and need a served build, so vitest must never collect them.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
})
