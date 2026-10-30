// Production server: the API plus the built frontend from dist/.
import { join } from 'node:path'
import express from 'express'
import { createApi } from './api.ts'
import { storeFromEnv } from './store.ts'

const root = join(import.meta.dirname, '..')
const store = await storeFromEnv(process.env.DATA_DIR ?? join(root, 'data'))
// Ignore a placeholder until a real "….apps.googleusercontent.com" ID is pasted in.
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? ''
if (googleClientId && !googleClientId.endsWith('.apps.googleusercontent.com')) console.warn('GOOGLE_CLIENT_ID doesn’t look like a Google client ID; sign-in stays off.')
const app = express()
// Behind the host's proxy (Render, Cloudflare…), so rate limits see the visitor's address.
app.set('trust proxy', 1)
// Optional private list of who may host, e.g. "me@gmail.com, friend@gmail.com, @docchula.com".
const hostAllowlist = (process.env.HOST_EMAILS ?? '').split(/[\s,;]+/).filter(Boolean)
app.use('/api', createApi({ store, googleClientId: googleClientId.endsWith('.apps.googleusercontent.com') ? googleClientId : '', hostAllowlist }))
app.use(express.static(join(root, 'dist')))
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(root, 'dist', 'index.html')))

const port = Number(process.env.PORT ?? 8787)
app.listen(port, () => console.log(`Wayneday running on http://localhost:${port} (storage: ${store.kind})`))
