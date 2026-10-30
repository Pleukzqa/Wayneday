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
export default defineConfig({
  plugins: [react(), api()],
  // exceljs is lazy-loaded on export only.
  build: { chunkSizeWarningLimit: 1000 },
})
