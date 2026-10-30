// Where sessions live: Postgres when DATABASE_URL is set (production — e.g. Supabase), otherwise one JSON
// file per session. A save names the version it replaces and fails if someone else saved first, so the
// server stays correct with more than one copy running; the caller reloads and tries again.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

export interface Store {
  readonly kind: 'postgres' | 'files'
  get(code: string): Promise<{ version: number; data: unknown } | null>
  /** Just the version, so polling can skip loading an unchanged session. */
  version(code: string): Promise<number | null>
  /** Save `data` as `version`; only succeeds if the stored version is `version - 1` (or none, for version 1). */
  put(code: string, version: number, data: object, hostEmails: string[]): Promise<boolean>
  /** Codes of the sessions this Google account hosts or co-hosts, newest first. */
  listByHost(email: string): Promise<string[]>
  ping(): Promise<void>
}

export function fileStore(dataDir: string): Store {
  const dir = join(dataDir, 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = (code: string) => join(dir, `${code}.json`)
  const read = (code: string) => (existsSync(file(code)) ? (JSON.parse(readFileSync(file(code), 'utf8')) as { version?: number; hosts?: { email: string }[] }) : null)
  return {
    kind: 'files',
    async get(code) {
      const data = read(code)
      return data ? { version: data.version ?? 0, data } : null
    },
    async version(code) {
      return read(code)?.version ?? null
    },
    async put(code, version, data) {
      // Synchronous from here on, so nothing can save in between the check and the write.
      const current = read(code)
      if (current ? (current.version ?? 0) !== version - 1 : version !== 1) return false
      const tmp = `${file(code)}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, file(code))
      return true
    },
    async listByHost(email) {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter((code) => (read(code)?.hosts ?? []).some((h) => h.email === email))
    },
    async ping() {},
  }
}

export async function postgresStore(connectionString: string): Promise<Store> {
  const pool = new pg.Pool({ connectionString, max: 5, ssl: sslFor(connectionString) })
  pool.on('error', (e) => console.error('Postgres pool error', e))
  // Prefixed so it can share a database with other apps. Text, not jsonb: jsonb rejects \u0000.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wayneday_sessions (
      code text PRIMARY KEY,
      version integer NOT NULL,
      data text NOT NULL,
      host_emails text[] NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wayneday_sessions_host_emails ON wayneday_sessions USING gin (host_emails);
    -- Supabase also serves public tables over its web API; with row level security on and no policies,
    -- that API sees nothing. The server connects as the table's owner, which isn't affected.
    ALTER TABLE wayneday_sessions ENABLE ROW LEVEL SECURITY;
  `)
  return {
    kind: 'postgres',
    async get(code) {
      const r = await pool.query<{ version: number; data: string }>('SELECT version, data FROM wayneday_sessions WHERE code = $1', [code])
      return r.rows[0] ? { version: r.rows[0].version, data: JSON.parse(r.rows[0].data) } : null
    },
    async version(code) {
      const r = await pool.query<{ version: number }>('SELECT version FROM wayneday_sessions WHERE code = $1', [code])
      return r.rows[0]?.version ?? null
    },
    async put(code, version, data, hostEmails) {
      const json = JSON.stringify(data)
      const r =
        version === 1
          ? await pool.query(
              'INSERT INTO wayneday_sessions (code, version, data, host_emails) VALUES ($1, 1, $2, $3) ON CONFLICT (code) DO NOTHING',
              [code, json, hostEmails],
            )
          : await pool.query(
              'UPDATE wayneday_sessions SET version = $2, data = $3, host_emails = $4, updated_at = now() WHERE code = $1 AND version = $5',
              [code, version, json, hostEmails, version - 1],
            )
      return (r.rowCount ?? 0) > 0
    },
    async listByHost(email) {
      const r = await pool.query<{ code: string }>(
        'SELECT code FROM wayneday_sessions WHERE $1 = ANY(host_emails) ORDER BY updated_at DESC LIMIT 100',
        [email],
      )
      return r.rows.map((x) => x.code)
    },
    async ping() {
      await pool.query('SELECT 1')
    },
  }
}

/**
 * Encrypt connections to remote databases without checking the certificate chain (what psql's
 * sslmode=require does) — Supabase's pooler certificate isn't from a public CA. An sslmode in the URL wins.
 */
function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  const url = new URL(connectionString)
  if (url.searchParams.has('sslmode') || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return undefined
  return { rejectUnauthorized: false }
}

/** Postgres if DATABASE_URL is set, otherwise JSON files under dataDir. */
export function storeFromEnv(dataDir: string): Promise<Store> {
  const url = process.env.DATABASE_URL
  return url ? postgresStore(url) : Promise.resolve(fileStore(dataDir))
}
