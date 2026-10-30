import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import express from 'express'
import { defineConfig, type Plugin } from 'vite'
import { createApi } from './server/api.ts'

// Serve the API from the dev server so `npm run dev` is a single process.
const api = (): Plugin => ({
  name: 'wayneday-api',
  configureServer(server) {
    const app = express()
    app.use('/api', createApi(process.env.DATA_DIR ?? join(import.meta.dirname, 'data')))
    server.middlewares.use(app)
  },
})

// https://vite.dev/config/
export default defineConfig(({ mode }) =>
  mode === 'demo'
    ? {
        // Phone demo: no server, the API runs in the browser (see src/demo/).
        plugins: [react()],
        base: './',
        resolve: { alias: [{ find: /^\.{1,2}\/api\.ts$/, replacement: join(import.meta.dirname, 'src/demo/demoApi.ts') }] },
        build: { outDir: 'dist-demo', chunkSizeWarningLimit: 1000 },
      }
    : {
        plugins: [react(), api()],
        // exceljs is lazy-loaded on export only.
        build: { chunkSizeWarningLimit: 1000 },
      },
)
