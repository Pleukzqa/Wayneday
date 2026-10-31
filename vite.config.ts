import { execSync } from 'node:child_process'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import express from 'express'
import { defineConfig, type Plugin } from 'vite'
import { createApi } from './server/api.ts'
import { storeFromEnv } from './server/store.ts'

// Serve the API from the dev server so `npm run dev` is a single process.
const api = (): Plugin => ({
  name: 'wayneday-api',
  configureServer(server) {
    const app = express()
    app.use('/api', createApi({ store: storeFromEnv(process.env.DATA_DIR ?? join(import.meta.dirname, 'data')), googleClientId: process.env.GOOGLE_CLIENT_ID }))
    server.middlewares.use(app)
  },
})

// Which commit this build is, shown in the footer so a deploy can be checked. Render sets RENDER_GIT_COMMIT.
function commit() {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}
const define = { __BUILD__: JSON.stringify({ commit: commit().slice(0, 7), date: new Date().toISOString() }) }

// https://vite.dev/config/
export default defineConfig(({ mode }) =>
  mode === 'demo'
    ? {
        define,
        // Phone demo: no server, the API runs in the browser (see src/demo/).
        plugins: [react()],
        base: './',
        resolve: { alias: [{ find: /^\.{1,2}\/api\.ts$/, replacement: join(import.meta.dirname, 'src/demo/demoApi.ts') }] },
        build: { outDir: 'dist-demo', chunkSizeWarningLimit: 1000 },
      }
    : {
        define,
        plugins: [react(), api()],
        // exceljs is lazy-loaded on export only.
        build: { chunkSizeWarningLimit: 1000 },
      },
)
