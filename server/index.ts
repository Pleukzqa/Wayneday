// Production server: the API plus the built frontend from dist/.
import { join } from 'node:path'
import express from 'express'
import { createApi } from './api.ts'

const root = join(import.meta.dirname, '..')
const app = express()
app.use('/api', createApi(process.env.DATA_DIR ?? join(root, 'data')))
app.use(express.static(join(root, 'dist')))
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(root, 'dist', 'index.html')))

const port = Number(process.env.PORT ?? 8787)
app.listen(port, () => console.log(`Wayneday running on http://localhost:${port}`))
